import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { discoverForProject } from "@/lib/discovery";
import { redditStatus, statusMessage } from "@/lib/discovery/status";
import { demoCommunities } from "@/lib/discovery/demo";
import { generateDiscoveryQueries, MAX_QUERIES } from "@/lib/discovery/queries";
import {
  SearchProviderError,
  SearchTask,
  WebCommunityDiscoveryProvider,
  sanitizeResults,
  webDiscoveryConfigured,
} from "@/lib/discovery/web";
import { readPayload, signPayload } from "@/lib/signed";
import { scoreWebCandidates } from "@/lib/discovery/webscore";
import {
  persistWebCandidates,
  projectDiscoveryInput,
  toClientCandidate,
  WEB_PLATFORM,
} from "@/lib/discovery/webflow";
import { ownedProjectOr, isDenied } from "@/lib/ownership";
import { touchProject } from "@/lib/projectActivity";

export const runtime = "nodejs";

/**
 * DISCOVER — audience acquisition.
 *
 * Web discovery runs as short explicit steps so no single serverless
 * invocation has to hold a paid search plus two AI calls open:
 *
 *   { step: "queries" }              → { queries }      AI, costs no search
 *   { step: "search-submit", queries } → { ticket }     PAID, once per click
 *   { step: "search-poll", ticket }  → { results }      free, repeatable
 *   { step: "score", results }       → { communities }  AI + persist
 *
 * Legacy behaviour is untouched: { demo: true } returns clearly-labeled
 * fictional data, and a bodyless POST runs the Reddit provider.
 * Nothing here publishes anywhere.
 */

/**
 * Paid-search rate limit per user. In-memory, so it is best-effort on
 * serverless — enough to stop an accidental burst, not a billing control.
 */
/** How long a submitted (paid) search stays resumable. Results live 30 days
 *  at the provider, so this only bounds how long we honour the handle. */
const TICKET_TTL_MS = 6 * 60 * 60 * 1000;

/**
 * Results scored per request. Scoring writes several sentences per result, and
 * the model's output length is what makes the call slow — 28 results in one
 * call was measured overrunning 25s, far past a serverless invocation.
 * Batches of 6 measured up to 7.6s once audience judgement was added, which
 * leaves too little room for a cold start, so the batch is 5.
 */
const SCORE_BATCH_SIZE = 5;

const SEARCH_WINDOW_MS = 60_000;
const MAX_SEARCHES_PER_WINDOW = 14; // one full run is MAX_QUERIES searches
const searchLog = new Map<string, number[]>();

function allowSearch(userId: string, count: number): boolean {
  const now = Date.now();
  const recent = (searchLog.get(userId) ?? []).filter((t) => now - t < SEARCH_WINDOW_MS);
  if (recent.length + count > MAX_SEARCHES_PER_WINDOW) {
    searchLog.set(userId, recent);
    return false;
  }
  for (let i = 0; i < count; i++) recent.push(now);
  searchLog.set(userId, recent);
  if (searchLog.size > 5_000) searchLog.clear();
  return true;
}

const searchErrorStatus = (code: SearchProviderError["code"]) =>
  code === "not_configured" ? 503 : code === "auth_failed" ? 502 : 502;

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const gate = await ownedProjectOr(id);
  if (isDenied(gate)) return NextResponse.json({ error: gate.error }, { status: gate.status });
  const body = await req.json().catch(() => ({}));

  // Deliberate growth work keeps a project in Active. "search-poll" is the
  // browser waiting on a queue, not the owner doing something, so it is
  // excluded — otherwise a long wait alone would look like activity.
  if (body?.step !== "search-poll") await touchProject(id);

  if (body?.demo) {
    const project = await prisma.project.findUnique({ where: { id } });
    return NextResponse.json({
      status: "available",
      demo: true,
      communities: demoCommunities(project?.name ?? "your app"),
    });
  }

  const step = typeof body?.step === "string" ? body.step : null;

  if (step) {
    if (!webDiscoveryConfigured()) {
      return NextResponse.json(
        {
          status: "not_configured",
          message:
            "Web discovery is not configured. Real search activates once the search provider credentials are set.",
          communities: [],
        },
        { status: 503 }
      );
    }

    try {
      if (step === "queries") {
        const input = await projectDiscoveryInput(id);
        const queries = await generateDiscoveryQueries(input);
        return NextResponse.json({ status: "available", queries });
      }

      if (step === "search-submit") {
        const queries = Array.isArray(body.queries)
          ? body.queries.filter((q: unknown): q is string => typeof q === "string").slice(0, MAX_QUERIES)
          : [];
        if (!queries.length) {
          return NextResponse.json({ error: "queries are required" }, { status: 400 });
        }
        if (!allowSearch(gate.userId, queries.length)) {
          return NextResponse.json(
            { error: "Too many searches just now — please wait a minute." },
            { status: 429 }
          );
        }
        const tasks = await new WebCommunityDiscoveryProvider().submitSearches(queries);
        // Signed so a submitted search cannot be resumed by anyone else. The
        // ticket long outlives the search itself: the provider's standard queue
        // has been observed taking six minutes, and a customer must be able to
        // come back for work they already paid for instead of searching again.
        return NextResponse.json({
          status: "submitted",
          ticket: signPayload(tasks, gate.userId, TICKET_TTL_MS),
          total: tasks.length,
          ticketTtlMs: TICKET_TTL_MS,
        });
      }

      if (step === "search-poll") {
        const tasks = readPayload<SearchTask[]>(body.ticket, gate.userId);
        if (!Array.isArray(tasks) || !tasks.length) {
          return NextResponse.json({ error: "The search could not be resumed" }, { status: 400 });
        }
        const { results, pending } = await new WebCommunityDiscoveryProvider().pollSearches(tasks);
        return NextResponse.json({
          status: pending > 0 ? "pending" : "ready",
          pending,
          total: tasks.length,
          results,
        });
      }

      if (step === "score") {
        // Results come back through the browser: re-validate before they are
        // scored or stored. Nothing client-supplied is trusted as-is.
        // One batch per request keeps the AI call short enough to return.
        const results = sanitizeResults(body.results, SCORE_BATCH_SIZE);
        const replace = body.replace !== false;
        if (!results.length) {
          return NextResponse.json({ status: "available", communities: [] });
        }
        const input = await projectDiscoveryInput(id);
        const scored = await scoreWebCandidates(input, results);
        await persistWebCandidates(id, scored, replace);
        // Return everything stored so far, so the UI always shows the full run.
        const rows = await prisma.communityCandidate.findMany({
          where: { projectId: id, platform: { in: [WEB_PLATFORM, "reddit"] } },
          orderBy: [{ platform: "asc" }, { audienceFit: "desc" }],
        });
        return NextResponse.json({
          status: "available",
          communities: rows.map(toClientCandidate),
        });
      }

      // The "prepare" step used to draft a promotional post and a tracking
      // link for an external page. Discovery is market research now, so that
      // action is no longer offered: the workspace acts on this evidence
      // through advertising and positioning, not by posting into the sources
      // it found. The helper remains in lib/discovery/webflow.ts for backend
      // compatibility and is no longer reachable from the product.

      return NextResponse.json({ error: "Unknown step" }, { status: 400 });
    } catch (e) {
      if (e instanceof SearchProviderError) {
        return NextResponse.json(
          { status: "error", error: e.message, code: e.code },
          { status: searchErrorStatus(e.code) }
        );
      }
      // Never surface upstream bodies or stack traces.
      return NextResponse.json(
        { status: "error", error: "Discovery failed. Please try again." },
        { status: 500 }
      );
    }
  }

  // Legacy Reddit path (approval_pending until credentials exist).
  const status = redditStatus();
  if (status !== "configured" && status !== "available") {
    return NextResponse.json(
      { status, message: statusMessage(status), communities: [] },
      { status: 200 }
    );
  }
  try {
    const out = await discoverForProject(id);
    return NextResponse.json(
      { status: "available", audience: out.audience, communities: out.communities.map(toClientCandidate) },
      { status: 201 }
    );
  } catch {
    return NextResponse.json(
      { status: "error", error: "Reddit discovery failed.", communities: [] },
      { status: 200 }
    );
  }
}

/** GET — previously discovered candidates (web first) plus provider status. */
export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const gate = await ownedProjectOr(id);
  if (isDenied(gate)) return NextResponse.json({ error: gate.error }, { status: gate.status });

  const rows = await prisma.communityCandidate.findMany({
    where: { projectId: id, platform: { in: [WEB_PLATFORM, "reddit"] } },
    orderBy: [{ platform: "asc" }, { audienceFit: "desc" }],
  });

  return NextResponse.json({
    status: redditStatus(),
    message: statusMessage(redditStatus()),
    webConfigured: webDiscoveryConfigured(),
    communities: rows.map(toClientCandidate),
  });
}
