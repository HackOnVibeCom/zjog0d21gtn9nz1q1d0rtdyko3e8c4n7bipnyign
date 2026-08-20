import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { providerByName, resolveStoreProvider } from "@/lib/store";
import { StoreProviderError } from "@/lib/store/types";
import { analyzeApp } from "@/lib/analyze";
import { generateDiscoveryQueries, MAX_QUERIES } from "@/lib/discovery/queries";
import {
  SearchProviderError,
  SearchTask,
  WebCommunityDiscoveryProvider,
  webDiscoveryConfigured,
} from "@/lib/discovery/web";
import { scoreWebCandidates } from "@/lib/discovery/webscore";
import { planGrowth } from "@/lib/demo/autopilot";
import { DEMO_MAX_DAILY_BUDGET_MICROS } from "@/lib/demo/workspace";
import { DEMO_COOKIE, getSession, readSessionId } from "@/lib/demo/session";
import {
  claimStage,
  failRun,
  NEXT_STEP,
  publicListing,
  releaseStage,
  toPublicRun,
} from "@/lib/demo/run";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * ONE REAL OPERATION PER REQUEST.
 *
 * The judge page shows a stage as complete only after the operation behind it
 * genuinely returned, and the only way to guarantee that is to make each stage
 * its own round trip. Nothing here is timed, simulated or optimistic: a step
 * either produces a real provider result and advances the run, or it fails and
 * the run stops.
 *
 * Steps, in order:
 *   import-submit → import-poll → analyze →
 *   discover-queries → discover-submit → discover-poll → discover-score →
 *   propose
 */

/** How many scored sources a judge sees. Enough to read, small enough to score. */
const SCORE_BATCH = 5;
const MAX_SOURCES = 10;

type Envelope = Record<string, unknown>;

const read = (raw: string | null): Envelope => {
  if (!raw) return {};
  try {
    return (JSON.parse(raw) as Envelope) ?? {};
  } catch {
    return {};
  }
};

export async function POST(req: NextRequest) {
  const session = await getSession(readSessionId(req.cookies.get(DEMO_COOKIE)?.value));
  if (!session) {
    return NextResponse.json({ error: "Start the demo first", code: "no_session" }, { status: 401 });
  }

  const body = (await req.json().catch(() => ({}))) as { runId?: unknown; step?: unknown };
  const runId = typeof body.runId === "string" ? body.runId : "";
  const step = typeof body.step === "string" ? body.step : "";

  // The lock is per run and scoped to this session, so another tab, a double
  // click or a forged run id cannot drive someone else's pipeline.
  const claim = await claimStage(runId, session.id);
  if (!claim.ok) {
    const status = claim.code === "not_found" ? 404 : 409;
    const message =
      claim.code === "busy"
        ? "This step is already running."
        : claim.code === "failed"
          ? "This run has already failed. Start a new one."
          : "Run not found.";
    return NextResponse.json({ error: message, code: claim.code }, { status });
  }

  const run = claim.run;

  // The run remembers which step it is waiting for. A replayed or out-of-order
  // step is refused here — before any model, search or store call — so a public
  // caller cannot spend a paid provider request twice on one run.
  if (run.nextStep !== step) {
    await releaseStage(run.id);
    return NextResponse.json(
      {
        error:
          run.nextStep === "complete"
            ? "This run has already finished its research."
            : "That step is not the one this run is waiting for.",
        code: "invalid_step",
        run: toPublicRun(run),
      },
      { status: 409 }
    );
  }

  // A successful step records what may follow it; a pending poll keeps waiting
  // for the same step.
  const done = async (data: Parameters<typeof prisma.demoRun.update>[0]["data"]) => {
    const saved = await prisma.demoRun.update({
      where: { id: run.id },
      data: { ...data, nextStep: NEXT_STEP[step] ?? "complete", activeAt: null },
    });
    return NextResponse.json({ run: toPublicRun(saved) });
  };
  const stop = async (stage: string, code: string, message: string, status = 502) => {
    const failed = await failRun(run.id, stage, code);
    return NextResponse.json(
      { error: message, code, run: toPublicRun(failed) },
      { status }
    );
  };

  try {
    // ---------------------------------------------------------------- import
    if (step === "import-submit") {
      const { provider, url } = resolveStoreProvider(run.storeUrl);
      const task = await provider.submitLookup(url);
      return await done({ listing: JSON.stringify({ task }) });
    }

    if (step === "import-poll") {
      const envelope = read(run.listing);
      const task = envelope.task as { provider: string; appId: string; taskId: string } | undefined;
      if (!task?.taskId) {
        return await stop("import", "no_task", "The store lookup was not started.", 409);
      }
      const result = await providerByName(task.provider).pollLookup(task);
      if (result.status === "pending") {
        await releaseStage(run.id);
        return NextResponse.json({ pending: true, run: toPublicRun(run) });
      }
      if (result.status !== "ready") {
        return await stop("import", "listing_unavailable", "Google Play did not return this app.");
      }
      // Stored as the public shape, so the task metadata is replaced rather
      // than merely hidden and no provider field survives the import.
      return await done({
        listing: JSON.stringify(publicListing(result.metadata)),
        stage: "analyzing",
      });
    }

    // --------------------------------------------------------------- analyze
    // One real call produces both the understanding and the plan, so the
    // timeline reports one event rather than inventing two.
    if (step === "analyze") {
      const listing = read(run.listing) as {
        name?: string;
        description?: string;
        storeUrl?: string;
      };
      if (!listing?.name) {
        return await stop("understand", "no_listing", "The listing has not been retrieved yet.", 409);
      }
      const analysis = await analyzeApp({
        name: listing.name,
        description: listing.description,
        storeUrl: listing.storeUrl,
      });
      return await done({ analysis: JSON.stringify(analysis), stage: "discovering" });
    }

    // -------------------------------------------------------------- discover
    if (step === "discover-queries") {
      if (!webDiscoveryConfigured()) {
        return await stop("discover", "not_configured", "Web research is not configured.", 503);
      }
      const a = read(run.analysis) as Record<string, string>;
      const listing = read(run.listing) as { name?: string; category?: string };
      const queries = await generateDiscoveryQueries({
        name: listing?.name ?? run.appId,
        summary: a.summary,
        audience: a.audience,
        mainProblem: a.mainProblem,
        valueProp: a.valueProp,
        category: a.primaryCategory,
      });
      if (!queries.length) {
        return await stop("discover", "no_queries", "No research queries could be generated.");
      }
      return await done({ discovery: JSON.stringify({ queries: queries.slice(0, MAX_QUERIES) }) });
    }

    if (step === "discover-submit") {
      const envelope = read(run.discovery);
      const queries = (envelope.queries as string[]) ?? [];
      if (!queries.length) {
        return await stop("discover", "no_queries", "No research queries to search with.", 409);
      }
      const tasks = await new WebCommunityDiscoveryProvider().submitSearches(queries);
      if (!tasks.length) {
        return await stop("discover", "no_tasks", "The search provider accepted no queries.");
      }
      return await done({ discovery: JSON.stringify({ ...envelope, tasks }) });
    }

    if (step === "discover-poll") {
      const envelope = read(run.discovery);
      const tasks = (envelope.tasks as SearchTask[]) ?? [];
      if (!tasks.length) {
        return await stop("discover", "no_tasks", "No search was submitted.", 409);
      }
      const { results, pending } = await new WebCommunityDiscoveryProvider().pollSearches(tasks);
      if (pending > 0 && results.length === 0) {
        await releaseStage(run.id);
        return NextResponse.json({ pending: true, run: toPublicRun(run) });
      }
      if (!results.length) {
        return await stop("discover", "no_results", "The public web search returned nothing.");
      }
      return await done({
        discovery: JSON.stringify({ ...envelope, results: results.slice(0, MAX_SOURCES) }),
      });
    }

    if (step === "discover-score") {
      const envelope = read(run.discovery);
      const results = (envelope.results as unknown[]) ?? [];
      if (!results.length) {
        return await stop("discover", "no_results", "There is nothing to analyse.", 409);
      }
      const a = read(run.analysis) as Record<string, string>;
      const listing = read(run.listing) as { name?: string };
      const scored = await scoreWebCandidates(
        {
          name: listing?.name ?? run.appId,
          summary: a.summary,
          category: a.primaryCategory,
          audience: a.audience,
          mainProblem: a.mainProblem,
          valueProp: a.valueProp,
        },
        results.slice(0, SCORE_BATCH) as never
      );
      if (!scored.length) {
        return await stop("discover", "scoring_failed", "The evidence could not be analysed.");
      }
      return await done({ discovery: JSON.stringify({ ...envelope, scored }) });
    }

    // --------------------------------------------------------------- propose
    if (step === "propose") {
      const scored = read(run.discovery).scored as unknown[] | undefined;
      if (!scored?.length) {
        return await stop("propose", "no_evidence", "There is no research to propose from.", 409);
      }
      const a = read(run.analysis) as Record<string, string>;
      const plan = planGrowth({
        goal: "app_installs",
        market: "US",
        approvedDailyBudgetMicros: DEMO_MAX_DAILY_BUDGET_MICROS,
      });
      const proposal = {
        appId: run.appId,
        goal: "App installs",
        environment: "Google Ads TEST",
        campaignType: "App Campaign",
        channel: plan.channel,
        statusPolicy: plan.campaignStatus,
        maxDailyBudgetMicros: DEMO_MAX_DAILY_BUDGET_MICROS,
        // Strategy the model proposed. Kept separate from the parameters the
        // execution actually sends, so the page can label each honestly.
        recommendation: {
          positioning: a.valueProp ?? "",
          audience: a.audience ?? "",
          messagingAngle: a.mainProblem ?? "",
        },
        reasoning: plan.reasoning,
      };
      return await done({ proposal: JSON.stringify(proposal), stage: "proposed" });
    }

    await releaseStage(run.id);
    return NextResponse.json({ error: "Unknown step", code: "unknown_step" }, { status: 400 });
  } catch (e) {
    const stageOf: Record<string, string> = {
      "import-submit": "import",
      "import-poll": "import",
      analyze: "understand",
      "discover-queries": "discover",
      "discover-submit": "discover",
      "discover-poll": "discover",
      "discover-score": "discover",
      propose: "propose",
    };
    const code =
      e instanceof StoreProviderError || e instanceof SearchProviderError
        ? e.code
        : "step_failed";
    // Provider bodies quote the request, so only a classification escapes.
    return await stop(
      stageOf[step] ?? "unknown",
      String(code),
      "This step could not be completed. The run has stopped here."
    );
  }
}
