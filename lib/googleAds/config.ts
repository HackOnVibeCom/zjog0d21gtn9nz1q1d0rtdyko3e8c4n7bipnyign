/**
 * GOOGLE ADS — configuration and version.
 *
 * Everything version- and environment-shaped lives here so upgrading the API
 * later is a one-line change rather than a hunt through route handlers.
 *
 * Server-only. Nothing in this file may be imported into client components:
 * it reads secrets from the environment.
 */

/** Google Ads REST API version. Bump here, nowhere else. */
export const GOOGLE_ADS_API_VERSION = "v25";
export const GOOGLE_ADS_BASE_URL = `https://googleads.googleapis.com/${GOOGLE_ADS_API_VERSION}`;

/** OAuth endpoints (Google identity platform). */
export const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GOOGLE_REVOKE_URL = "https://oauth2.googleapis.com/revoke";

/** The single scope this integration needs. */
export const GOOGLE_ADS_SCOPE = "https://www.googleapis.com/auth/adwords";

/** Path the OAuth callback is served from, appended to APP_BASE_URL. */
export const CALLBACK_PATH = "/api/integrations/google-ads/callback";

export type GoogleAdsEnv = {
  clientId: string;
  clientSecret: string;
  developerToken: string;
  encryptionKey: string;
  /** Only needed when authorising through a manager account. */
  loginCustomerId?: string;
};

/** Why the integration cannot run, in terms the UI can act on. */
export type ConfigProblem = "not_configured";

/**
 * Read the operator's Google Ads configuration.
 *
 * Returns null when the operator has not set it up — the product then says
 * "not configured" instead of crashing. There is deliberately no fallback:
 * a half-configured integration must not appear to work.
 */
export function googleAdsEnv(): GoogleAdsEnv | null {
  const clientId = process.env.GOOGLE_ADS_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_ADS_CLIENT_SECRET;
  const developerToken = process.env.GOOGLE_ADS_DEVELOPER_TOKEN;
  const encryptionKey = process.env.GOOGLE_ADS_TOKEN_ENCRYPTION_KEY;

  if (!clientId || !clientSecret || !developerToken || !encryptionKey) return null;

  const loginCustomerId = normalizeCustomerId(process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID ?? "");
  return {
    clientId,
    clientSecret,
    developerToken,
    encryptionKey,
    loginCustomerId: loginCustomerId || undefined,
  };
}

export function googleAdsConfigured(): boolean {
  return googleAdsEnv() !== null;
}

/** Customer ids travel as ten digits with no dashes in headers and paths. */
export function normalizeCustomerId(raw: string): string {
  return String(raw ?? "").replace(/\D/g, "");
}

/** 1234567890 → 123-456-7890, the form advertisers actually recognise. */
export function formatCustomerId(raw: string): string {
  const d = normalizeCustomerId(raw);
  return d.length === 10 ? `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}` : d;
}

/**
 * The OAuth redirect URI, derived from APP_BASE_URL so the same code works on
 * localhost, on a preview and in production. It must match a URI registered in
 * the Google Cloud console exactly.
 */
export function callbackUrl(): string {
  const base = (process.env.APP_BASE_URL ?? "http://localhost:3000").replace(/\/+$/, "");
  return `${base}${CALLBACK_PATH}`;
}
