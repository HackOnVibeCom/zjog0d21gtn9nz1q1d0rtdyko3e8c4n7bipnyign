import { NextRequest, NextResponse } from "next/server";
import { currentUserId } from "@/auth";
import { googleAdsEnv } from "@/lib/googleAds/config";
import { saveConnection } from "@/lib/googleAds/connection";
import { exchangeCode, GoogleOAuthError } from "@/lib/googleAds/oauth";
import { readPayload } from "@/lib/signed";

export const runtime = "nodejs";

type ConnectState = { purpose?: string; nonce?: string };

/** Send the customer back to the dashboard with a result they can read. */
function back(result: string): NextResponse {
  const base = (process.env.APP_BASE_URL ?? "http://localhost:3000").replace(/\/+$/, "");
  return NextResponse.redirect(`${base}/app?googleAds=${encodeURIComponent(result)}`);
}

/**
 * GET /api/integrations/google-ads/callback
 *
 * Google returns here with a one-time code. The code is exchanged
 * server-side and the refresh token is encrypted before it is stored — it is
 * never written to a log, a response body or a cookie.
 */
export async function GET(req: NextRequest) {
  const userId = await currentUserId();
  if (!userId) return back("signin_required");

  const params = req.nextUrl.searchParams;
  if (params.get("error")) return back("denied");

  // readPayload verifies the signature, the expiry AND that the state was
  // issued to THIS signed-in user, so a callback cannot attach one person's
  // Google authorization to another person's account.
  const state = readPayload<ConnectState>(params.get("state"), userId);
  if (!state || state.purpose !== "google-ads-connect") return back("invalid_state");

  const code = params.get("code");
  if (!code) return back("invalid_request");

  const env = googleAdsEnv();
  if (!env) return back("not_configured");

  try {
    const { refreshToken } = await exchangeCode(env, code);
    await saveConnection(userId, refreshToken, env.loginCustomerId);
    return back("connected");
  } catch (e) {
    if (e instanceof GoogleOAuthError) return back(e.code);
    return back("error");
  }
}
