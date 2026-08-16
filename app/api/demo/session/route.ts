import { NextRequest, NextResponse } from "next/server";
import { demoModeConfigured } from "@/lib/googleAds/auth";
import {
  clientHash,
  createSession,
  DEMO_COOKIE,
  getSession,
  readSessionId,
  signSessionId,
} from "@/lib/demo/session";

export const runtime = "nodejs";

/**
 * POST /api/demo/session — start (or resume) an isolated judge session.
 *
 * No sign-up, no email, no password, no Google account. The session grants
 * nothing beyond the sandbox: it cannot see any customer project, any owner
 * data or any real advertising account.
 */
export async function POST(req: NextRequest) {
  const existing = await getSession(readSessionId(req.cookies.get(DEMO_COOKIE)?.value));
  if (existing) {
    return NextResponse.json({ ready: true, configured: demoModeConfigured() });
  }

  const hash = clientHash(
    req.headers.get("x-nf-client-connection-ip") ?? req.headers.get("x-forwarded-for"),
    req.headers.get("user-agent")
  );
  const session = await createSession(hash);

  const res = NextResponse.json({ ready: true, configured: demoModeConfigured() });
  res.cookies.set(DEMO_COOKIE, signSessionId(session.id), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 6 * 60 * 60,
  });
  return res;
}
