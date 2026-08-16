import { CommunityDiscoveryProvider, DiscoveryQuery, RawCommunity } from "./types";

/**
 * WEB AUDIENCE DISCOVERY — the first real (non-demo) discovery provider.
 *
 * It answers "where does this audience already gather on the public web?" using
 * the official DataForSEO Google Organic SERP API. It is a *search* provider:
 * it never fetches, crawls or scrapes the discovered pages, and it never posts.
 * URLs are returned as data for the customer's browser to open.
 *
 * Everything it returns is genuinely present in the search response. Community
 * size, activity, rules and posting permission are NOT knowable from a search
 * result and are therefore never invented here.
 */

const SERP_POST = "https://api.dataforseo.com/v3/serp/google/organic/task_post";
const SERP_GET = "https://api.dataforseo.com/v3/serp/google/organic/task_get/advanced";
const SERP_TIMEOUT_MS = 8_500; // must return well inside a serverless invocation
const DEPTH = 10; // one page of results — the minimum billable depth

export const MAX_RESULTS_PER_QUERY = 6;
export const MAX_PER_DOMAIN = 2;
export const MAX_SEARCH_TASKS = 8;

// DataForSEO status codes (docs.dataforseo.com/v3/appendix/errors).
const OK = 20000;
const TASK_CREATED = 20100;
const AUTH_FAILED = 40100;
const PAYMENT_REQUIRED = 40200;
const INSUFFICIENT_FUNDS = 40210;
const NOT_FOUND = 40400;
const TASK_HANDED = 40601;
const TASK_IN_QUEUE = 40602;
/** "Not finished yet" rather than "failed". */
const IN_PROGRESS = new Set<number>([TASK_CREATED, NOT_FOUND, TASK_HANDED, TASK_IN_QUEUE]);
// A submitted search, resumable across requests.
const TASK_ID = /^[a-zA-Z0-9-]{8,64}$/;

export type SearchTask = { query: string; taskId: string };

const MAX_TITLE = 200;
const MAX_SNIPPET = 500;
const MAX_URL = 2048;

export class SearchProviderError extends Error {
  code: "not_configured" | "auth_failed" | "timeout" | "provider_error";
  constructor(code: SearchProviderError["code"], message: string) {
    super(message);
    this.name = "SearchProviderError";
    this.code = code;
  }
}

/** One organic search result, normalized. Every field is RETRIEVED. */
export type WebResult = {
  title: string;
  url: string;
  domain: string;
  snippet?: string;
  position: number;
  sourceQuery: string;
};

// Pages that are never an audience *location*: stores, commerce, auth, and the
// app's own listing. YouTube is excluded on purpose — it gets its own provider.
const BLOCKED_DOMAINS = [
  "play.google.com",
  "apps.apple.com",
  "itunes.apple.com",
  "microsoft.com",
  "amazon.",
  "ebay.",
  "aliexpress.",
  "walmart.",
  "etsy.",
  "temu.",
  "youtube.com",
  "youtu.be",
  "accounts.google.com",
  "login.",
  "signin.",
  "doubleclick.net",
  "googleadservices.com",
];

// URL shapes that indicate a transactional or gated page rather than a discussion.
const BLOCKED_PATHS =
  /\/(login|log-in|signin|sign-in|signup|sign-up|register|cart|checkout|basket|billing|pricing|buy-now|dp|product|products|item|shop|store)(\/|$)/i;

// Signals that a page is an actual discussion/community location. Used to rank
// candidates before the AI sees them — not to discard everything else.
const COMMUNITY_SIGNALS =
  /(forum|community|communities|discussion|discuss|thread|threads|board|boards|\/r\/|reddit\.com|stackexchange|stackoverflow|quora|answers|q-and-a|support\.|groups?\/|subreddit|talk|chat)/i;

const str = (v: unknown, max: number): string | undefined =>
  typeof v === "string" && v.trim() !== "" ? v.trim().slice(0, max) : undefined;

/** Only http(s) URLs are ever accepted — never javascript:, data: or file:. */
export function safeUrl(value: unknown): URL | null {
  const raw = str(value, MAX_URL);
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return url.protocol === "https:" || url.protocol === "http:" ? url : null;
  } catch {
    return null;
  }
}

export function isBlockedDomain(domain: string): boolean {
  const d = domain.toLowerCase();
  return BLOCKED_DOMAINS.some((b) => (b.endsWith(".") ? d.startsWith(b) : d === b || d.endsWith(`.${b}`)));
}

/** Drop results that cannot plausibly be a place where an audience gathers. */
export function isUsefulResult(r: WebResult): boolean {
  if (!r.title || !r.url) return false;
  const url = safeUrl(r.url);
  if (!url) return false;
  if (isBlockedDomain(r.domain)) return false;
  if (BLOCKED_PATHS.test(url.pathname)) return false;
  // A bare homepage with no path is rarely a specific discussion.
  return true;
}

export function looksLikeCommunity(r: WebResult): boolean {
  return COMMUNITY_SIGNALS.test(`${r.domain}${r.url} ${r.title}`);
}

/**
 * De-duplicate by URL, keep domain diversity, and put discussion-shaped
 * results first so the AI budget is spent on the most promising candidates.
 */
export function dedupeAndDiversify(results: WebResult[], maxPerDomain = MAX_PER_DOMAIN): WebResult[] {
  const seenUrl = new Set<string>();
  const perDomain = new Map<string, number>();
  const ordered = [...results].sort((a, b) => {
    const c = Number(looksLikeCommunity(b)) - Number(looksLikeCommunity(a));
    return c !== 0 ? c : a.position - b.position;
  });

  const out: WebResult[] = [];
  for (const r of ordered) {
    const url = safeUrl(r.url);
    if (!url) continue;
    // Ignore tracking noise so the same page isn't counted twice.
    const key = `${url.hostname}${url.pathname}`.replace(/\/+$/, "").toLowerCase();
    if (seenUrl.has(key)) continue;
    const domain = r.domain.toLowerCase();
    const used = perDomain.get(domain) ?? 0;
    if (used >= maxPerDomain) continue;
    seenUrl.add(key);
    perDomain.set(domain, used + 1);
    out.push(r);
  }
  return out;
}

/** Map a DataForSEO SERP response onto normalized organic results. */
export function normalizeSerpResponse(body: unknown, sourceQuery: string): WebResult[] {
  const root = (body ?? {}) as Record<string, unknown>;
  const task = (Array.isArray(root.tasks) ? root.tasks[0] : undefined) as
    | Record<string, unknown>
    | undefined;
  const result = Array.isArray(task?.result) ? (task!.result as unknown[])[0] : undefined;
  const items = result && typeof result === "object" && Array.isArray((result as { items?: unknown }).items)
    ? ((result as { items: unknown[] }).items)
    : [];

  const out: WebResult[] = [];
  for (const raw of items) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>;
    if (item.type !== "organic") continue; // advanced responses carry many item types

    const url = safeUrl(item.url);
    const title = str(item.title, MAX_TITLE);
    if (!url || !title) continue;

    out.push({
      title,
      url: url.toString(),
      domain: str(item.domain, 253) ?? url.hostname,
      snippet: str(item.description, MAX_SNIPPET),
      position: Number(item.rank_absolute ?? item.rank_group) || out.length + 1,
      sourceQuery,
    });
  }
  return out;
}

/**
 * Re-validate results that came back through the browser before they are used
 * to build database rows. The client is never trusted with stored content.
 */
export function sanitizeResults(input: unknown, maxTotal = 24): WebResult[] {
  const list = Array.isArray(input) ? input : [];
  const clean: WebResult[] = [];
  for (const raw of list) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const url = safeUrl(r.url);
    const title = str(r.title, MAX_TITLE);
    const sourceQuery = str(r.sourceQuery, 200);
    if (!url || !title || !sourceQuery) continue;
    const position = Number(r.position);
    const candidate: WebResult = {
      title,
      url: url.toString(),
      domain: (str(r.domain, 253) ?? url.hostname).toLowerCase(),
      snippet: str(r.snippet, MAX_SNIPPET),
      position: Number.isFinite(position) && position > 0 ? Math.floor(position) : 1,
      sourceQuery,
    };
    if (!isUsefulResult(candidate)) continue;
    clean.push(candidate);
    if (clean.length >= maxTotal) break;
  }
  return dedupeAndDiversify(clean);
}

function credentials(): Record<string, string> {
  const login = process.env.DATAFORSEO_LOGIN;
  const password = process.env.DATAFORSEO_PASSWORD;
  if (!login || !password) {
    throw new SearchProviderError("not_configured", "Web discovery is not configured");
  }
  return {
    Authorization: "Basic " + Buffer.from(`${login}:${password}`).toString("base64"),
    "Content-Type": "application/json",
  };
}

export function webDiscoveryConfigured(): boolean {
  return Boolean(process.env.DATAFORSEO_LOGIN && process.env.DATAFORSEO_PASSWORD);
}

/** HTTP + JSON with an explicit timeout; upstream detail never escapes. */
async function call(
  url: string,
  init: RequestInit
): Promise<{ ok: boolean; status: number; body: unknown }> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(SERP_TIMEOUT_MS) });
  } catch {
    throw new SearchProviderError("timeout", "The search service did not respond in time");
  }
  if (res.status === 401 || res.status === 403) {
    throw new SearchProviderError("auth_failed", "Web search is not configured correctly");
  }
  if (res.status === 402) {
    throw new SearchProviderError("not_configured", "Web search is temporarily unavailable");
  }
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { ok: res.ok, status: res.status, body };
}

/** Fatal provider states, mapped to messages that carry no upstream detail. */
function assertNotFatal(code: number | undefined): void {
  if (code === AUTH_FAILED) {
    throw new SearchProviderError("auth_failed", "Web search is not configured correctly");
  }
  if (code === PAYMENT_REQUIRED || code === INSUFFICIENT_FUNDS) {
    throw new SearchProviderError("not_configured", "Web search is temporarily unavailable");
  }
}

export class WebCommunityDiscoveryProvider implements CommunityDiscoveryProvider {
  readonly platform = "web";

  /**
   * Submit every query as a search task in ONE request. This is the only paid
   * step, so it must happen at most once per explicit user action. Retrieval is
   * free, which is why the wait never has to happen inside this call.
   */
  async submitSearches(queries: string[]): Promise<SearchTask[]> {
    const keywords = (Array.isArray(queries) ? queries : [])
      .map((q) => String(q ?? "").replace(/\s+/g, " ").trim().slice(0, 200))
      .filter((q) => q.length >= 3)
      .slice(0, MAX_SEARCH_TASKS);
    if (!keywords.length) return [];

    const { ok, body } = await call(SERP_POST, {
      method: "POST",
      headers: credentials(),
      body: JSON.stringify(
        keywords.map((keyword) => ({
          keyword,
          location_code: 2840, // United States
          language_code: "en",
          depth: DEPTH,
          device: "desktop",
          os: "windows",
        }))
      ),
    });

    const root = (body ?? {}) as Record<string, unknown>;
    assertNotFatal(Number(root.status_code));
    if (!ok || body === null) {
      throw new SearchProviderError("provider_error", "The search service is unavailable");
    }

    const tasks = Array.isArray(root.tasks) ? (root.tasks as Record<string, unknown>[]) : [];
    const out: SearchTask[] = [];
    tasks.forEach((task, i) => {
      assertNotFatal(Number(task?.status_code));
      const taskId = typeof task?.id === "string" ? task.id : "";
      const code = Number(task?.status_code);
      // DataForSEO preserves request order, so index maps back to the keyword.
      const query = keywords[i];
      if (query && TASK_ID.test(taskId) && (!Number.isFinite(code) || code < 40000)) {
        out.push({ query, taskId });
      }
    });
    if (!out.length) {
      throw new SearchProviderError("provider_error", "The search could not be started");
    }
    return out;
  }

  /** Free, repeatable retrieval of one submitted search. */
  async pollSearch(task: SearchTask): Promise<{ status: "pending" } | { status: "ready"; results: WebResult[] }> {
    if (!TASK_ID.test(task.taskId)) {
      throw new SearchProviderError("provider_error", "The search could not be resumed");
    }
    const { ok, body } = await call(`${SERP_GET}/${encodeURIComponent(task.taskId)}`, {
      method: "GET",
      headers: credentials(),
    });
    // Transient trouble is reported as pending — retrieval costs nothing.
    if (!ok || body === null) return { status: "pending" };

    const root = body as Record<string, unknown>;
    assertNotFatal(Number(root.status_code));
    const t = (Array.isArray(root.tasks) ? root.tasks[0] : undefined) as
      | Record<string, unknown>
      | undefined;
    const code = Number(t?.status_code);
    assertNotFatal(code);
    if (Number.isFinite(code) && code !== OK) {
      if (IN_PROGRESS.has(code)) return { status: "pending" };
      if (code >= 40000) {
        throw new SearchProviderError("provider_error", "The search could not be completed");
      }
    }
    if (!Array.isArray(t?.result) || !t!.result.length) return { status: "pending" };

    return {
      status: "ready",
      results: normalizeSerpResponse(body, task.query)
        .filter(isUsefulResult)
        .slice(0, MAX_RESULTS_PER_QUERY),
    };
  }

  /**
   * Retrieve every submitted search that is done. Safe to call repeatedly: a
   * failed or still-running task simply contributes nothing this time.
   */
  async pollSearches(tasks: SearchTask[]): Promise<{ results: WebResult[]; pending: number }> {
    const settled = await Promise.all(
      tasks.map(async (task) => {
        try {
          return await this.pollSearch(task);
        } catch (e) {
          // Auth/billing problems affect every task, so surface them.
          if (e instanceof SearchProviderError && e.code !== "provider_error") throw e;
          return { status: "ready" as const, results: [] as WebResult[] };
        }
      })
    );
    const results: WebResult[] = [];
    let pending = 0;
    for (const s of settled) {
      if (s.status === "pending") pending++;
      else results.push(...s.results);
    }
    return { results: dedupeAndDiversify(results), pending };
  }

  /** Provider interface: submit, wait within a bounded budget, merge. */
  async discover(query: DiscoveryQuery): Promise<RawCommunity[]> {
    const tasks = await this.submitSearches(query.queries);
    const deadline = Date.now() + 60_000;
    let latest = await this.pollSearches(tasks);
    while (latest.pending > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 2500));
      latest = await this.pollSearches(tasks);
    }
    return latest.results.map(toRawCommunity);
  }
}

/** Present a search result through the shared discovery shape. */
export function toRawCommunity(r: WebResult): RawCommunity {
  return {
    platform: "web",
    name: r.title,
    url: r.url,
    description: r.snippet,
    // Deliberately absent: memberCount and rules are NOT knowable from a search
    // result, and must never be guessed.
    evidence: {
      sourceQuery: r.sourceQuery,
      position: r.position,
      domain: r.domain,
      snippet: r.snippet,
    },
  };
}
