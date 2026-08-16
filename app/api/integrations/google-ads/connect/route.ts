import { NextResponse } from "next/server";
import { currentUserId } from "@/auth";
import { googleAdsEnv } from "@/lib/googleAds/config";
import { buildAuthorizationUrl } from "@/lib/googleAds/oauth";
import { signPayload } from "@/lib/signed";

export const runtime = "nodejs";

/** OAuth state is short-lived — it only has to survive one redirect. */
const STATE_TTL_MS = 10 * 60 * 1000;

/**
 * GET /api/integrations/google-ads/connect
 *
 * Starts the authorization. The state is an HMAC-signed payload bound to the
 * signed-in user with an expiry, so it cannot be guessed, replayed by someone
 * else, or reused after it goes stale — a raw user id as state would be all
 * three of those things.
 */
export async function GET() {
  const userId = await currentUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const env = googleAdsEnv();
  if (!env) {
    return NextResponse.json(
      { error: "Google Ads is not configured", code: "not_configured" },
      { status: 503 }
    );
  }

  const state = signPayload({ purpose: "google-ads-connect", nonce: crypto.randomUUID() }, userId, STATE_TTL_MS);
  return NextResponse.redirect(buildAuthorizationUrl(env, state));
}
