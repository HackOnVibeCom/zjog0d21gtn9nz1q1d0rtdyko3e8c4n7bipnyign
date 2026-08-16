import { createSign } from "node:crypto";
import { GOOGLE_ADS_SCOPE, GOOGLE_TOKEN_URL } from "./config";

/**
 * Service-account authentication for the judge sandbox.
 *
 * Google Ads accepts a service account added directly as a user on the account
 * — no Workspace domain-wide delegation and no impersonation. So this signs a
 * JWT assertion with the service account's private key and exchanges it for a
 * short-lived access token.
 *
 * The private key lives only in server environment configuration, is never
 * logged, never returned to a browser and never written to the database. It is
 * granted access to exactly one thing: the isolated Google Ads TEST hierarchy.
 */

const TOKEN_TTL_SEC = 3600;
const TIMEOUT_MS = 10_000;

export class ServiceAccountError extends Error {
  code: "not_configured" | "invalid_key" | "denied" | "timeout" | "provider_error";
  constructor(code: ServiceAccountError["code"], message: string) {
    super(message);
    this.name = "ServiceAccountError";
    this.code = code;
  }
}

type ServiceAccountEnv = { email: string; privateKey: string };

/**
 * Netlify (and most dashboards) store multi-line values with escaped newlines,
 * so a PEM arrives as a single line containing "\n". Restore it before use.
 *
 * Done unconditionally and with split/join rather than a detection gate: an
 * earlier version only converted when it believed escapes were present, and
 * when that probe was wrong the key stayed on one line and OpenSSL rejected it
 * as unsupported — a correct credential failing for a reason that pointed
 * nowhere near the cause. A value with real newlines is unaffected by this.
 */
const ESCAPED_NEWLINE = String.fromCharCode(92) + "n";
const ESCAPED_CRLF = String.fromCharCode(92) + "r" + ESCAPED_NEWLINE;

function normalizePrivateKey(raw: string): string {
  return raw
    .split(ESCAPED_CRLF)
    .join("\n")
    .split(ESCAPED_NEWLINE)
    .join("\n")
    .split("\r\n")
    .join("\n")
    .trim();
}

function serviceAccountEnv(): ServiceAccountEnv | null {
  const email = process.env.GOOGLE_ADS_DEMO_SERVICE_ACCOUNT_EMAIL?.trim();
  const rawKey = process.env.GOOGLE_ADS_DEMO_SERVICE_ACCOUNT_PRIVATE_KEY;
  if (!email || !rawKey) return null;

  const privateKey = normalizePrivateKey(rawKey).trim();
  if (!privateKey.includes("BEGIN") || !privateKey.includes("PRIVATE KEY")) return null;
  return { email, privateKey };
}

export function demoServiceAccountConfigured(): boolean {
  return serviceAccountEnv() !== null;
}

const b64url = (input: string | Buffer) =>
  Buffer.from(input).toString("base64url");

/** Build and sign the JWT assertion Google exchanges for an access token. */
function signAssertion(sa: ServiceAccountEnv): string {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(
    JSON.stringify({
      iss: sa.email,
      scope: GOOGLE_ADS_SCOPE,
      aud: GOOGLE_TOKEN_URL,
      iat: now,
      exp: now + TOKEN_TTL_SEC,
    })
  );
  const unsigned = `${header}.${claims}`;

  try {
    const signer = createSign("RSA-SHA256");
    signer.update(unsigned);
    signer.end();
    return `${unsigned}.${signer.sign(sa.privateKey, "base64url")}`;
  } catch {
    // A malformed key must fail here, not halfway through a Google call.
    throw new ServiceAccountError("invalid_key", "The demo credential is not usable");
  }
}

/**
 * A short-lived access token for the demo service account.
 *
 * Deliberately not cached across requests: the sandbox runs rarely, and
 * holding a token in module memory on a serverless platform buys nothing while
 * widening the window in which one exists.
 */
export async function demoServiceAccountToken(): Promise<string> {
  const sa = serviceAccountEnv();
  if (!sa) {
    throw new ServiceAccountError("not_configured", "The demo credential is not configured");
  }

  let res: Response;
  try {
    res = await fetch(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion: signAssertion(sa),
      }),
    });
  } catch {
    throw new ServiceAccountError("timeout", "Google did not respond in time");
  }

  let data: { access_token?: unknown; error?: unknown };
  try {
    data = (await res.json()) as typeof data;
  } catch {
    throw new ServiceAccountError("provider_error", "Google returned an unreadable response");
  }

  if (!res.ok || typeof data.access_token !== "string") {
    // Google's error body can echo the assertion, so only a coarse reason is
    // surfaced — never the provider's text.
    throw new ServiceAccountError(
      res.status === 400 || res.status === 401 ? "denied" : "provider_error",
      "The demo credential was not accepted by Google"
    );
  }
  return data.access_token;
}
