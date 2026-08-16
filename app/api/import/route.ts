import { NextRequest, NextResponse } from "next/server";
import { currentUserId } from "@/auth";
import { providerByName, resolveStoreProvider } from "@/lib/store";
import { issueTicket, readTicket } from "@/lib/store/ticket";
import { StoreProviderError } from "@/lib/store/types";
import { analyzeApp } from "@/lib/analyze";

export const runtime = "nodejs";

/**
 * POST /api/import — Google Play onboarding, in three short steps so that no
 * single serverless invocation waits on a provider queue (Netlify functions
 * time out at 10s by default).
 *
 *   { url }                          → { ticket }                  (PAID: one
 *                                       provider task per explicit click)
 *   { ticket }                       → { status: "pending" } |
 *                                      { status: "ready", metadata }  (free)
 *   { analyze: { name, … } }         → { analysis }               (OpenAI only)
 *
 * Retrieved metadata comes from the provider; the analysis is AI inference. The
 * two are kept separate all the way to the review screen. No project is created
 * here. Requires a signed-in user.
 */

/**
 * Per-user throttle for the paid step. In-memory, so it is best-effort on
 * serverless — a cheap guard against an accidental burst, not a billing
 * control. Restarts clear it.
 */
const MIN_SUBMIT_GAP_MS = 3_000;
const lastSubmit = new Map<string, number>();

function throttle(userId: string): void {
  const now = Date.now();
  const previous = lastSubmit.get(userId) ?? 0;
  if (now - previous < MIN_SUBMIT_GAP_MS) {
    throw new StoreProviderError("provider_error", "Please wait a moment before trying again");
  }
  lastSubmit.set(userId, now);
  if (lastSubmit.size > 5_000) lastSubmit.clear();
}

const status = (code: string): number => {
  switch (code) {
    case "invalid_url":
    case "unsupported_url":
      return 400;
    case "not_found":
      return 404;
    case "not_configured":
      return 503;
    default:
      return 502;
  }
};

const s = (v: unknown, max: number): string | undefined =>
  typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined;

export async function POST(req: NextRequest) {
  const userId = await currentUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });

  try {
    // Step 3 — AI inference over the retrieved listing. No provider call.
    if (body.analyze && typeof body.analyze === "object") {
      const a = body.analyze as Record<string, unknown>;
      const name = s(a.name, 200);
      if (!name) return NextResponse.json({ error: "name is required" }, { status: 400 });
      const analysis = await analyzeApp({
        name,
        description: s(a.description, 6000),
        storeUrl: s(a.storeUrl, 2048),
      });
      return NextResponse.json({ analysis });
    }

    // Step 2 — free, repeatable poll of an already-submitted lookup.
    if (body.ticket !== undefined) {
      const ticket = readTicket(body.ticket, userId);
      const result = await providerByName(ticket.provider).pollLookup(ticket);
      return NextResponse.json(
        result.status === "ready"
          ? { status: "ready", metadata: result.metadata }
          : { status: "pending" }
      );
    }

    // Step 1 — validate the URL (SSRF gate) and submit ONE paid lookup.
    const url = s(body.url, 2048);
    if (!url) return NextResponse.json({ error: "url is required" }, { status: 400 });
    throttle(userId);
    const { provider, url: parsed } = resolveStoreProvider(url);
    const task = await provider.submitLookup(parsed); // fixed API host only
    return NextResponse.json({
      status: "submitted",
      ticket: issueTicket({ ...task, userId }),
    });
  } catch (e) {
    if (e instanceof StoreProviderError) {
      // Clean, non-sensitive message; never leak stack traces or credentials.
      return NextResponse.json({ error: e.message, code: e.code }, { status: status(e.code) });
    }
    return NextResponse.json(
      { error: "We couldn't import this app. Check the link or enter details manually." },
      { status: 500 }
    );
  }
}
