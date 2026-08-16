import {
  StoreMetadataProvider,
  StoreAppMetadata,
  StoreLookupResult,
  StoreLookupTask,
  StoreProviderError,
} from "./types";

const PLAY_HOST = "play.google.com";
const PLAY_PATH = "/store/apps/details";
// Android package id: dot-separated segments, each starting with a letter.
const PACKAGE_ID = /^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)+$/;
// DataForSEO task ids are hex/dash strings; keep the accepted shape narrow.
const TASK_ID = /^[a-zA-Z0-9-]{8,64}$/;

const DFS_HOST = "https://api.dataforseo.com";
const APP_INFO_POST = `${DFS_HOST}/v3/app_data/google/app_info/task_post`;
const APP_INFO_GET = `${DFS_HOST}/v3/app_data/google/app_info/task_get/advanced`;

const POST_TIMEOUT_MS = 8_000;
const GET_TIMEOUT_MS = 8_000;

// DataForSEO status codes (docs.dataforseo.com/v3/appendix/errors).
const OK = 20000;
const TASK_CREATED = 20100;
const AUTH_FAILED = 40100;
const PAYMENT_REQUIRED = 40200;
const INSUFFICIENT_FUNDS = 40210;
const NOT_FOUND = 40400;
const TASK_HANDED = 40601;
const TASK_IN_QUEUE = 40602;
/** Codes that mean "not finished yet" rather than "failed". */
const IN_PROGRESS = new Set<number>([TASK_CREATED, NOT_FOUND, TASK_HANDED, TASK_IN_QUEUE]);

const MAX_TEXT = 300;
const MAX_DESCRIPTION = 6_000;

const cap = (s: string, max: number) => (s.length > max ? s.slice(0, max).trimEnd() + "…" : s);

const str = (v: unknown, max = MAX_TEXT): string | undefined =>
  typeof v === "string" && v.trim() !== "" ? cap(v.trim(), max) : undefined;
const num = (v: unknown): number | undefined => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : undefined;
};

/** fetch with an explicit timeout — a hung provider must never hang the route. */
async function fetchJson(
  url: string,
  init: RequestInit,
  timeoutMs: number
): Promise<{ ok: boolean; status: number; body: unknown }> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch {
    // Network failure or timeout — never surface the underlying message.
    throw new StoreProviderError("timeout", "The store lookup service did not respond");
  }
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null; // malformed JSON is handled by the callers
  }
  return { ok: res.ok, status: res.status, body };
}

/** Map a DataForSEO top-level/task status code onto a user-safe error. */
function assertNotFatal(code: number | undefined): void {
  if (code === undefined) return;
  if (code === AUTH_FAILED) {
    throw new StoreProviderError("auth_failed", "Store lookup is not configured correctly");
  }
  if (code === PAYMENT_REQUIRED || code === INSUFFICIENT_FUNDS) {
    throw new StoreProviderError("not_configured", "Store lookup is temporarily unavailable");
  }
}

const pick = (o: Record<string, unknown>, ...keys: string[]): unknown => {
  for (const k of keys) if (o[k] !== undefined && o[k] !== null) return o[k];
  return undefined;
};

/**
 * Google Play metadata via the official DataForSEO "Google App Info" API.
 *
 * The server only ever calls the fixed DataForSEO host — it never fetches the
 * user-supplied URL — and only after the URL is validated as a Play app URL.
 *
 * The lookup is split into submit (paid, once per user action) and poll (free,
 * repeatable) so that no single serverless invocation has to wait for the
 * provider queue. See app/api/import/route.ts.
 */
export class GooglePlayMetadataProvider implements StoreMetadataProvider {
  readonly provider = "google-play";

  canHandle(url: URL): boolean {
    return (
      url.protocol === "https:" &&
      url.hostname === PLAY_HOST &&
      url.username === "" &&
      url.password === "" &&
      url.pathname === PLAY_PATH &&
      PACKAGE_ID.test(url.searchParams.get("id") ?? "")
    );
  }

  /** Extract + conservatively validate the package id. Throws on bad input. */
  extractAppId(url: URL): string {
    const id = url.searchParams.get("id") ?? "";
    if (!this.canHandle(url) || id.length > 255) {
      throw new StoreProviderError("unsupported_url", "Not a valid Google Play app URL");
    }
    return id;
  }

  /** Canonical listing URL — never echo back the raw user-supplied string. */
  private storeUrl(appId: string): string {
    return `https://${PLAY_HOST}${PLAY_PATH}?id=${encodeURIComponent(appId)}`;
  }

  private headers(): Record<string, string> {
    const login = process.env.DATAFORSEO_LOGIN;
    const password = process.env.DATAFORSEO_PASSWORD;
    if (!login || !password) {
      throw new StoreProviderError("not_configured", "Google Play import is not configured");
    }
    return {
      Authorization: "Basic " + Buffer.from(`${login}:${password}`).toString("base64"),
      "Content-Type": "application/json",
    };
  }

  async submitLookup(url: URL): Promise<StoreLookupTask> {
    const appId = this.extractAppId(url);
    const { ok, status, body } = await fetchJson(
      APP_INFO_POST,
      {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify([{ app_id: appId, language_code: "en", location_code: 2840 }]),
      },
      POST_TIMEOUT_MS
    );

    if (status === 401 || status === 403) {
      throw new StoreProviderError("auth_failed", "Store lookup is not configured correctly");
    }
    if (status === 402) {
      throw new StoreProviderError("not_configured", "Store lookup is temporarily unavailable");
    }
    if (!ok || body === null) {
      throw new StoreProviderError("provider_error", "The store lookup service is unavailable");
    }

    const root = body as Record<string, unknown>;
    assertNotFatal(num(root.status_code));

    const task = (Array.isArray(root.tasks) ? root.tasks[0] : undefined) as
      | Record<string, unknown>
      | undefined;
    assertNotFatal(num(task?.status_code));

    const taskId = str(task?.id, 64);
    const taskCode = num(task?.status_code);
    if (!taskId || !TASK_ID.test(taskId) || (taskCode !== undefined && taskCode >= 40000)) {
      throw new StoreProviderError("provider_error", "The store could not look up this app");
    }
    return { provider: this.provider, appId, taskId };
  }

  async pollLookup(task: { appId: string; taskId: string }): Promise<StoreLookupResult> {
    if (!TASK_ID.test(task.taskId) || !PACKAGE_ID.test(task.appId)) {
      throw new StoreProviderError("provider_error", "The store lookup could not be resumed");
    }
    const { ok, status, body } = await fetchJson(
      `${APP_INFO_GET}/${encodeURIComponent(task.taskId)}`,
      { method: "GET", headers: this.headers() },
      GET_TIMEOUT_MS
    );

    if (status === 401 || status === 403) {
      throw new StoreProviderError("auth_failed", "Store lookup is not configured correctly");
    }
    // Transient upstream trouble or unparseable body: report as still pending
    // and let the caller's own deadline end the wait. Polling costs nothing.
    if (!ok || body === null) return { status: "pending" };

    const root = body as Record<string, unknown>;
    assertNotFatal(num(root.status_code));

    const t = (Array.isArray(root.tasks) ? root.tasks[0] : undefined) as
      | Record<string, unknown>
      | undefined;
    const code = num(t?.status_code);
    assertNotFatal(code);
    if (code !== undefined && code !== OK) {
      if (IN_PROGRESS.has(code)) return { status: "pending" };
      if (code >= 40000) {
        throw new StoreProviderError("provider_error", "The store could not look up this app");
      }
    }

    const result = Array.isArray(t?.result) ? (t!.result as unknown[])[0] : undefined;
    if (!result || typeof result !== "object") return { status: "pending" };
    const r = result as Record<string, unknown>;
    const items = Array.isArray(r.items) ? (r.items as unknown[]) : [];
    const item = (items.find((i) => i && typeof i === "object") ?? r) as Record<string, unknown>;

    return { status: "ready", metadata: this.normalize(task.appId, item) };
  }

  /** Map a DataForSEO app_info item onto our normalized metadata shape. */
  private normalize(appId: string, item: Record<string, unknown>): StoreAppMetadata {
    const name = str(pick(item, "title", "name"));
    if (!name) throw new StoreProviderError("incomplete", "The store returned no app details");

    // The live response echoes the package it actually resolved. Never label a
    // different app with the requested package id.
    const returnedId = str(item.app_id);
    if (returnedId && returnedId !== appId) {
      throw new StoreProviderError("incomplete", "The store returned a different app");
    }

    const rating = (item.rating ?? {}) as Record<string, unknown>;
    const genres = Array.isArray(item.genres) ? (item.genres as unknown[]) : [];
    const images = Array.isArray(pick(item, "images", "screenshots"))
      ? (pick(item, "images", "screenshots") as unknown[])
      : [];

    return {
      provider: "google-play",
      appId,
      storeUrl: this.storeUrl(appId),
      name,
      description: str(pick(item, "description", "description_short"), MAX_DESCRIPTION),
      category: str(pick(item, "main_category", "category")) ?? str(genres[0]),
      developer: str(pick(item, "developer", "publisher")),
      rating: num(pick(rating, "value")) ?? num(item.rating_value),
      reviewsCount: num(pick(rating, "votes_count")) ?? num(item.reviews_count),
      installs:
        str(pick(item, "installs", "installs_range")) ??
        (num(item.installs_count) !== undefined ? String(num(item.installs_count)) : undefined),
      version: str(pick(item, "version", "current_version")),
      iconUrl: str(pick(item, "icon", "image_url"), 2048),
      screenshots: images.length
        ? (images.map((i) => str(i, 2048)).filter(Boolean).slice(0, 8) as string[])
        : undefined,
      retrievedAt: new Date().toISOString(),
    };
  }
}
