import {
  callbackUrl,
  GOOGLE_ADS_SCOPE,
  GOOGLE_AUTH_URL,
  GOOGLE_TOKEN_URL,
  type GoogleAdsEnv,
} from "./config";

/**
 * Google OAuth 2.0 for the Google Ads integration.
 *
 * The customer authorises through Google — this product never sees or asks for
 * a Google password. Offline access is requested because autonomous
 * optimisation later needs to act without the customer present.
 *
 * Server-only. No token value is ever logged or returned in an error message.
 */

const TIMEOUT_MS = 10_000;

export type OAuthErrorCode = "not_configured" | "denied" | "invalid_grant" | "provider_error" | "timeout";

export class GoogleOAuthError extends Error {
  code: OAuthErrorCode;
  constructor(code: OAuthErrorCode, message: string) {
    super(message);
    this.name = "GoogleOAuthError";
    this.code = code;
  }
}

/** Where to send the customer to authorise. */
export function buildAuthorizationUrl(env: GoogleAdsEnv, state: string): string {
  const url = new URL(GOOGLE_AUTH_URL);
  url.searchParams.set("client_id", env.clientId);
  url.searchParams.set("redirect_uri", callbackUrl());
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", GOOGLE_ADS_SCOPE);
  // A refresh token is only issued with offline access, and Google only
  // re-issues one when consent is forced — without this a returning customer
  // reconnects and we get no durable credential.
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("include_granted_scopes", "true");
  url.searchParams.set("state", state);
  return url.toString();
}

type TokenResponse = {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
  error?: unknown;
  error_description?: unknown;
};

async function postToken(body: URLSearchParams): Promise<TokenResponse> {
  let res: Response;
  try {
    res = await fetch(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new GoogleOAuthError("timeout", "Google did not respond in time");
  }

  let data: TokenResponse;
  try {
    data = (await res.json()) as TokenResponse;
  } catch {
    throw new GoogleOAuthError("provider_error", "Google returned an unreadable response");
  }

  if (!res.ok || typeof data.error === "string") {
    // Google's error bodies can echo request parameters, so only the coarse
    // reason is surfaced — never the provider's raw text.
    const code = data.error === "invalid_grant" ? "invalid_grant" : "provider_error";
    throw new GoogleOAuthError(
      code,
      code === "invalid_grant"
        ? "Google rejected this authorization. Please connect again."
        : "Google could not complete the authorization."
    );
  }
  return data;
}

/** Exchange the one-time authorization code for tokens. */
export async function exchangeCode(
  env: GoogleAdsEnv,
  code: string
): Promise<{ refreshToken: string; accessToken: string; expiresInSec: number }> {
  const data = await postToken(
    new URLSearchParams({
      code,
      client_id: env.clientId,
      client_secret: env.clientSecret,
      redirect_uri: callbackUrl(),
      grant_type: "authorization_code",
    })
  );

  const refreshToken = typeof data.refresh_token === "string" ? data.refresh_token : "";
  const accessToken = typeof data.access_token === "string" ? data.access_token : "";
  if (!refreshToken) {
    // Without a refresh token the connection cannot outlive one hour, so this
    // is a failure rather than something to paper over.
    throw new GoogleOAuthError(
      "denied",
      "Google did not return a durable authorization. Please try connecting again."
    );
  }
  return {
    refreshToken,
    accessToken,
    expiresInSec: Number(data.expires_in) || 3600,
  };
}

/**
 * Trade the stored refresh token for a short-lived access token.
 * Access tokens are used for one request and never persisted.
 */
export async function refreshAccessToken(
  env: GoogleAdsEnv,
  refreshToken: string
): Promise<{ accessToken: string; expiresInSec: number }> {
  const data = await postToken(
    new URLSearchParams({
      refresh_token: refreshToken,
      client_id: env.clientId,
      client_secret: env.clientSecret,
      grant_type: "refresh_token",
    })
  );
  const accessToken = typeof data.access_token === "string" ? data.access_token : "";
  if (!accessToken) {
    throw new GoogleOAuthError("provider_error", "Google did not return an access token");
  }
  return { accessToken, expiresInSec: Number(data.expires_in) || 3600 };
}
