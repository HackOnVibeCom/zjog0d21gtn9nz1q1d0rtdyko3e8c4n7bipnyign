import { googleAdsEnv, type GoogleAdsEnv } from "./config";
import { accessTokenFor } from "./connection";
import { demoServiceAccountToken, demoServiceAccountConfigured } from "./serviceAccount";

/**
 * WHO is acting on Google Ads, separated from WHAT is being done.
 *
 * Campaign execution must not care whether the credential came from a
 * customer's own OAuth consent or from the isolated demo service account —
 * otherwise the two paths drift and only one of them stays correct. The
 * execution engine takes a provider; the provider decides how a short-lived
 * access token is obtained.
 *
 * Server-only. A provider never returns a refresh token, a private key or any
 * other durable credential.
 */

export type AuthMode = "customer_oauth" | "demo_service_account";

export interface GoogleAdsAuthProvider {
  readonly mode: AuthMode;
  /** A short-lived access token. Minted per execution, never persisted. */
  accessToken(): Promise<string>;
  /** The manager to authorise through, when the account sits under one. */
  loginCustomerId(): string | undefined;
  /** The advertiser account this provider is allowed to act on. */
  targetCustomerId(): Promise<string>;
}

export class AuthUnavailableError extends Error {
  code: "not_configured" | "not_connected" | "no_account_selected";
  constructor(code: AuthUnavailableError["code"], message: string) {
    super(message);
    this.name = "AuthUnavailableError";
    this.code = code;
  }
}

/**
 * A real customer acting on their own advertising account, through the OAuth
 * consent they gave. This is the path that will carry paying customers.
 */
export class UserOAuthAuthProvider implements GoogleAdsAuthProvider {
  readonly mode = "customer_oauth" as const;

  constructor(
    private readonly userId: string,
    private readonly selectedCustomerId: string | null,
    private readonly env: GoogleAdsEnv
  ) {}

  async accessToken(): Promise<string> {
    const token = await accessTokenFor(this.userId);
    if (!token) {
      throw new AuthUnavailableError("not_connected", "Google Ads is not connected");
    }
    return token;
  }

  loginCustomerId(): string | undefined {
    return this.env.loginCustomerId;
  }

  async targetCustomerId(): Promise<string> {
    if (!this.selectedCustomerId) {
      throw new AuthUnavailableError(
        "no_account_selected",
        "Choose a Google Ads advertiser account first"
      );
    }
    return this.selectedCustomerId;
  }
}

/**
 * The judge sandbox. A dedicated service account with access to nothing except
 * the isolated Google Ads TEST hierarchy — no customer account, no personal
 * Google data, and no production advertising.
 *
 * The target account is resolved from server configuration only; the browser
 * cannot name, send or override it.
 */
export class DemoServiceAccountAuthProvider implements GoogleAdsAuthProvider {
  readonly mode = "demo_service_account" as const;

  async accessToken(): Promise<string> {
    return demoServiceAccountToken();
  }

  loginCustomerId(): string | undefined {
    return process.env.GOOGLE_ADS_DEMO_MANAGER_CUSTOMER_ID?.replace(/\D/g, "") || undefined;
  }

  async targetCustomerId(): Promise<string> {
    const id = process.env.GOOGLE_ADS_DEMO_CUSTOMER_ID?.replace(/\D/g, "") ?? "";
    if (!id) {
      throw new AuthUnavailableError(
        "not_configured",
        "The demo advertising account is not configured"
      );
    }
    return id;
  }
}

/** Is the judge sandbox fully configured on this deployment? */
export function demoModeConfigured(): boolean {
  return (
    googleAdsEnv() !== null &&
    demoServiceAccountConfigured() &&
    Boolean(process.env.GOOGLE_ADS_DEMO_CUSTOMER_ID?.replace(/\D/g, ""))
  );
}
