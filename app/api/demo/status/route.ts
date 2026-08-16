import { NextRequest, NextResponse } from "next/server";
import { toProof } from "@/lib/demo/proof";
import { DEMO_COOKIE, existingExecution, getSession, readSessionId } from "@/lib/demo/session";

export const runtime = "nodejs";

/**
 * GET /api/demo/status — what this session already owns.
 *
 * Exists so a visitor whose connection dropped mid-execution can see their
 * campaign instead of being invited to create another one. It reads our own
 * records and calls nothing: recovery must never depend on Google being
 * reachable, and a page load must never spend a Google API call.
 *
 * Proof of existence is a separate act, and it has its own button.
 */
export async function GET(req: NextRequest) {
  const session = await getSession(readSessionId(req.cookies.get(DEMO_COOKIE)?.value));
  if (!session) return NextResponse.json({ session: false, executed: false });

  const execution = await existingExecution(session.id);
  return NextResponse.json({
    session: true,
    executed: Boolean(execution),
    proof: execution ? toProof(execution) : null,
  });
}
