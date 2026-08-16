import { NextRequest, NextResponse } from "next/server";
import { currentUserId } from "@/auth";
import { discoverAccounts, GoogleAdsApiError } from "@/lib/googleAds/client";
import { googleAdsEnv, normalizeCustomerId } from "@/lib/googleAds/config";
import {
  accessTokenFor,
  disconnect,
  getConnectionView,
  selectCustomer,
} from "@/lib/googleAds/connection";
import { GoogleOAuthError } from "@/lib/googleAds/oauth";

export const runtime = "nodejs";

/**
 * Google Ads integration state — READ ONLY in this phase.
 *
 *   GET     status, and the accounts this authorization can reach
 *   PATCH   { customerId } choose which account to work with
 *   DELETE  forget our authorization (changes nothing inside Google Ads)
 *
 * There is deliberately no endpoint here that creates or changes a campaign,
 * budget, ad group or ad. Connection is the whole of phase 1.
 */

/** The five states the UI distinguishes, so it never says "something went wrong". */
type Status =
  | "not_configured" // the operator has not set the integration up
  | "not_connected" // configured, but this customer has not authorized
  | "connected" // authorized and accounts read successfully
  | "account_error"; // authorized, but Google would not return accounts

export async function GET() {
  const userId = await currentUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  if (!googleAdsEnv()) {
    return NextResponse.json({ status: "not_configured" satisfies Status, accounts: [] });
  }

  const connection = await getConnectionView(userId);
  if (!connection) {
    return NextResponse.json({ status: "not_connected" satisfies Status, accounts: [] });
  }

  try {
    const env = googleAdsEnv()!;
    const accessToken = await accessTokenFor(userId);
    if (!accessToken) {
      return NextResponse.json({ status: "not_connected" satisfies Status, accounts: [] });
    }
    const accounts = await discoverAccounts(env, accessToken, env.loginCustomerId);
    return NextResponse.json({
      status: "connected" satisfies Status,
      connection,
      accounts,
    });
  } catch (e) {
    // The authorization exists but Google would not answer. Say which, without
    // repeating a provider message that may quote our credentials.
    const message =
      e instanceof GoogleAdsApiError || e instanceof GoogleOAuthError
        ? e.message
        : "Google Ads could not be reached.";
    return NextResponse.json({
      status: "account_error" satisfies Status,
      connection,
      accounts: [],
      error: message,
    });
  }
}

/**
 * Choose the advertising account to work with.
 *
 * A customer id that merely looks well-formed is not enough: the account has
 * to be one this connection can actually reach, so the request is checked
 * against live discovery before anything is stored. A manager account is
 * refused outright — campaigns run in advertiser accounts, and allowing a
 * manager to be chosen here would only surface as a confusing failure later.
 */
export async function PATCH(req: NextRequest) {
  const userId = await currentUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const env = googleAdsEnv();
  if (!env) {
    return NextResponse.json({ error: "Google Ads is not configured" }, { status: 503 });
  }

  const body = (await req.json().catch(() => ({}))) as { customerId?: unknown };
  const requested = normalizeCustomerId(
    typeof body.customerId === "string" ? body.customerId : ""
  );
  if (!requested) return NextResponse.json({ error: "customerId is required" }, { status: 400 });

  let accounts;
  try {
    const accessToken = await accessTokenFor(userId);
    if (!accessToken) {
      return NextResponse.json({ error: "Google Ads is not connected" }, { status: 400 });
    }
    accounts = await discoverAccounts(env, accessToken, env.loginCustomerId);
  } catch (e) {
    const message =
      e instanceof GoogleAdsApiError || e instanceof GoogleOAuthError
        ? e.message
        : "Google Ads could not be reached.";
    return NextResponse.json({ error: message }, { status: 502 });
  }

  const match = accounts.find((a) => a.customerId === requested);
  if (!match) {
    return NextResponse.json(
      { error: "That Google Ads account is not accessible through this connection." },
      { status: 403 }
    );
  }
  if (match.manager === true) {
    return NextResponse.json(
      {
        error:
          "That is a manager account. Choose one of its advertiser accounts to run campaigns in.",
        code: "manager_not_selectable",
      },
      { status: 400 }
    );
  }

  try {
    await selectCustomer(userId, requested);
  } catch {
    return NextResponse.json({ error: "Could not select that account" }, { status: 400 });
  }
  return NextResponse.json({ connection: await getConnectionView(userId) });
}

export async function DELETE() {
  const userId = await currentUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // Only our stored authorization is removed. No Google Ads data is touched,
  // no campaign is changed, and no unrelated Google access is revoked.
  const removed = await disconnect(userId);
  return NextResponse.json({ disconnected: removed });
}
