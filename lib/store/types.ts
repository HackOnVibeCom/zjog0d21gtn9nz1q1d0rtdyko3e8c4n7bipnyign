// Store metadata providers (Google Play now; Apple App Store can be added the
// same way). A provider turns a validated store URL into normalized metadata.
// Only fields that are genuinely RETRIEVED from the provider live here — AI
// inference (audience/problem/value) is produced separately by lib/analyze.

export type StoreAppMetadata = {
  provider: "google-play";
  appId: string;
  storeUrl: string;
  name: string;
  description?: string;
  category?: string;
  developer?: string;
  rating?: number;
  reviewsCount?: number;
  installs?: string;
  version?: string;
  iconUrl?: string;
  screenshots?: string[];
  retrievedAt: string;
};

export type StoreErrorCode =
  | "invalid_url"
  | "unsupported_url"
  | "not_found"
  | "not_configured"
  | "auth_failed"
  | "timeout"
  | "provider_error"
  | "incomplete";

export class StoreProviderError extends Error {
  code: StoreErrorCode;
  constructor(code: StoreErrorCode, message: string) {
    super(message);
    this.name = "StoreProviderError";
    this.code = code;
  }
}

/** Reference to one submitted (paid) provider lookup. */
export type StoreLookupTask = {
  provider: string;
  appId: string;
  taskId: string;
};

/**
 * Result of polling an already-submitted lookup. Polling is free and
 * idempotent — only submitLookup costs money.
 */
export type StoreLookupResult =
  | { status: "pending" }
  | { status: "ready"; metadata: StoreAppMetadata };

export interface StoreMetadataProvider {
  readonly provider: string;
  /** True if this provider handles the given (already-parsed) URL. */
  canHandle(url: URL): boolean;
  /** Package/app id extracted from a URL this provider can handle. */
  extractAppId(url: URL): string;
  /**
   * Submit ONE lookup task. This is the only paid step, so it must be called
   * at most once per explicit user action. Throws StoreProviderError.
   */
  submitLookup(url: URL): Promise<StoreLookupTask>;
  /** Free, repeatable poll of a submitted task. Throws StoreProviderError. */
  pollLookup(task: { appId: string; taskId: string }): Promise<StoreLookupResult>;
}
