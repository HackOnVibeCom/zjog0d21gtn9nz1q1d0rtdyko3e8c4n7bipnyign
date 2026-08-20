import { NextRequest, NextResponse } from "next/server";
import { StoreProviderError } from "@/lib/store/types";
import { DEMO_COOKIE, getSession, readSessionId } from "@/lib/demo/session";
import {
  checkStartAllowed,
  createRun,
  currentRun,
  discardRun,
  parseStoreUrl,
  runIsOurs,
  toPublicRun,
} from "@/lib/demo/run";

export const runtime = "nodejs";

/**
 * The public research run.
 *
 * GET  — the run this session is working on, so a refresh recovers the page.
 * POST — start a new one from a pasted Google Play link.
 *
 * Starting only creates the run and takes the stage lock; the work happens in
 * /api/demo/run/advance, one real operation per request. That split is what
 * lets the page show each stage as it genuinely completes instead of hiding
 * everything behind one long spinner.
 */

export async function GET(req: NextRequest) {
  const session = await getSession(readSessionId(req.cookies.get(DEMO_COOKIE)?.value));
  if (!session) return NextResponse.json({ session: false, run: null });

  const run = await currentRun(session.id);
  return NextResponse.json({ session: true, run: run ? toPublicRun(run) : null });
}

export async function POST(req: NextRequest) {
  const session = await getSession(readSessionId(req.cookies.get(DEMO_COOKIE)?.value));
  if (!session) {
    return NextResponse.json({ error: "Start the demo first", code: "no_session" }, { status: 401 });
  }

  const body = (await req.json().catch(() => ({}))) as { storeUrl?: unknown };

  // Validated by the same resolver the signed-in importer uses, and rebuilt
  // from the package id — a judge's paste never becomes a request target.
  let parsed: { appId: string; storeUrl: string };
  try {
    parsed = parseStoreUrl(body.storeUrl);
  } catch (e) {
    const message =
      e instanceof StoreProviderError
        ? e.message
        : "Paste a Google Play app link (play.google.com/store/apps/details?id=…).";
    return NextResponse.json({ error: message, code: "invalid_url" }, { status: 400 });
  }

  const verdict = await checkStartAllowed(session.id);
  if (!verdict.ok) {
    return NextResponse.json(
      { error: verdict.message, code: verdict.code },
      { status: verdict.code === "busy" ? 409 : 429 }
    );
  }

  // The allowance check and the row that follows it are two statements, and two
  // tabs can land between them. The row itself is the claim: both requests
  // create one, both order the candidates identically, and the one that did not
  // come first removes its own row without having called any provider.
  const run = await createRun(session.id, parsed.appId, parsed.storeUrl);
  if (!(await runIsOurs(session.id, run.id))) {
    await discardRun(run.id);
    return NextResponse.json(
      { error: "A research run is already in progress.", code: "busy" },
      { status: 409 }
    );
  }

  return NextResponse.json({ run: toPublicRun(run) }, { status: 201 });
}
