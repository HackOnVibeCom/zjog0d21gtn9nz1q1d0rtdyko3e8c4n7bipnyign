import {
  GOOGLE_ADS_BASE_URL,
  normalizeCustomerId,
  type GoogleAdsEnv,
} from "./config";

/**
 * Google Ads REST client — READ ONLY.
 *
 * Phase 1 proves the connection and nothing else: this client can list the
 * accounts an authorization can reach and read their identity. It deliberately
 * exposes no way to create or change a campaign, budget, ad group or ad.
 *
 * Server-only. The developer token and access token are request headers here
 * and never travel any further.
 */

const TIMEOUT_MS = 12_000;

export type GoogleAdsErrorCode =
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "quota"
  | "timeout"
  | "provider_error";

export class GoogleAdsApiError extends Error {
  code: GoogleAdsErrorCode;
  constructor(code: GoogleAdsErrorCode, message: string) {
    super(message);
    this.name = "GoogleAdsApiError";
    this.code = code;
  }
}

/** How the authorization reaches an account. */
export type AccessPath = "direct" | "manager_child";

/** One advertising account the authorization can reach. */
export type AdsAccount = {
  customerId: string;
  descriptiveName: string | null;
  currencyCode: string | null;
  timeZone: string | null;
  /** Google's own flag. Null when the field could not be read. */
  testAccount: boolean | null;
  manager: boolean | null;
  /** Whether the OAuth user holds the account, or reaches it via a manager. */
  accessPath: AccessPath;
  /** The manager the account was discovered under, when not held directly. */
  parentManagerCustomerId: string | null;
};

/** Traversal limits. A hierarchy is a graph, not a tree — it must be bounded. */
export const MAX_HIERARCHY_DEPTH = 5;
export const MAX_ACCOUNTS = 100;

function headers(env: GoogleAdsEnv, accessToken: string, loginCustomerId?: string) {
  const h: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    "developer-token": env.developerToken,
    "Content-Type": "application/json",
  };
  // Only sent when acting through a manager account; Google ignores it on
  // listAccessibleCustomers, so it is omitted there.
  const login = normalizeCustomerId(loginCustomerId ?? env.loginCustomerId ?? "");
  if (login) h["login-customer-id"] = login;
  return h;
}

/** Map a provider failure onto something the product can explain safely. */
function classify(status: number): GoogleAdsErrorCode {
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  if (status === 404) return "not_found";
  if (status === 429) return "quota";
  return "provider_error";
}

const MESSAGES: Record<GoogleAdsErrorCode, string> = {
  unauthorized: "Google rejected the authorization. Reconnect Google Ads.",
  forbidden:
    "Google Ads refused access. Check that the developer token is approved for this account.",
  not_found: "That Google Ads account could not be found.",
  quota: "Google Ads is rate limiting this request. Try again shortly.",
  timeout: "Google Ads did not respond in time.",
  provider_error: "Google Ads could not complete this request.",
};

async function call<T>(url: string, init: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch {
    throw new GoogleAdsApiError("timeout", MESSAGES.timeout);
  }
  if (!res.ok) {
    const code = classify(res.status);
    // Google's error payloads can quote the request, so the body is discarded
    // rather than surfaced — it may reference the developer token.
    throw new GoogleAdsApiError(code, MESSAGES[code]);
  }
  try {
    return (await res.json()) as T;
  } catch {
    throw new GoogleAdsApiError("provider_error", "Google Ads returned an unreadable response");
  }
}

/**
 * Accounts this authorization can reach.
 *
 * Returns bare resource names ("customers/1234567890"), which is all Google
 * gives here — identity is read separately per account.
 */
export async function listAccessibleCustomers(
  env: GoogleAdsEnv,
  accessToken: string
): Promise<string[]> {
  const data = await call<{ resourceNames?: unknown }>(
    `${GOOGLE_ADS_BASE_URL}/customers:listAccessibleCustomers`,
    { method: "GET", headers: headers(env, accessToken) }
  );
  const names = Array.isArray(data.resourceNames) ? data.resourceNames : [];
  return names
    .filter((n): n is string => typeof n === "string")
    .map((n) => normalizeCustomerId(n.split("/")[1] ?? ""))
    .filter(Boolean);
}

/** Rows returned by a customer identity query. */
type SearchResponse = {
  results?: Array<{
    customer?: {
      id?: unknown;
      descriptiveName?: unknown;
      currencyCode?: unknown;
      timeZone?: unknown;
      testAccount?: unknown;
      manager?: unknown;
    };
  }>;
};

const bool = (v: unknown): boolean | null => (typeof v === "boolean" ? v : null);
const str = (v: unknown): string | null =>
  typeof v === "string" && v.trim() !== "" ? v.trim() : null;

/**
 * Read one account's identity. A read-only GAQL query — no mutation exists in
 * this module.
 */
export async function getAccount(
  env: GoogleAdsEnv,
  accessToken: string,
  customerId: string,
  loginCustomerId?: string
): Promise<AdsAccount> {
  const id = normalizeCustomerId(customerId);
  const data = await call<SearchResponse>(
    `${GOOGLE_ADS_BASE_URL}/customers/${id}/googleAds:search`,
    {
      method: "POST",
      headers: headers(env, accessToken, loginCustomerId),
      body: JSON.stringify({
        query:
          "SELECT customer.id, customer.descriptive_name, customer.currency_code, " +
          "customer.time_zone, customer.test_account, customer.manager FROM customer LIMIT 1",
      }),
    }
  );

  const c = data.results?.[0]?.customer ?? {};
  return {
    customerId: str(c.id) ?? id,
    descriptiveName: str(c.descriptiveName),
    currencyCode: str(c.currencyCode),
    timeZone: str(c.timeZone),
    testAccount: bool(c.testAccount),
    manager: bool(c.manager),
    accessPath: "direct",
    parentManagerCustomerId: null,
  };
}

/** Rows returned by the account-hierarchy query. */
type HierarchyResponse = {
  results?: Array<{
    customerClient?: {
      id?: unknown;
      clientCustomer?: unknown;
      descriptiveName?: unknown;
      currencyCode?: unknown;
      timeZone?: unknown;
      manager?: unknown;
      testAccount?: unknown;
      level?: unknown;
    };
  }>;
};

// The documented hierarchy query, plus test_account so a test advertiser is
// recognisable. Both field sets come from the official reference; the shorter
// one is a fallback purely so that a single unavailable field cannot make
// hierarchy discovery return nothing.
const HIERARCHY_FIELDS =
  "customer_client.client_customer, customer_client.level, customer_client.manager, " +
  "customer_client.descriptive_name, customer_client.currency_code, " +
  "customer_client.time_zone, customer_client.id, customer_client.test_account";
const HIERARCHY_FIELDS_MINIMAL =
  "customer_client.client_customer, customer_client.level, customer_client.manager, " +
  "customer_client.descriptive_name, customer_client.currency_code, " +
  "customer_client.time_zone, customer_client.id";

/**
 * The accounts one manager can see, one level down.
 *
 * Run against the manager itself, with login-customer-id set to THAT manager —
 * not to some single global manager id, because each step of a hierarchy is
 * authorised by the manager being stepped through.
 */
export async function listCustomerHierarchy(
  env: GoogleAdsEnv,
  accessToken: string,
  managerCustomerId: string
): Promise<AdsAccount[]> {
  const manager = normalizeCustomerId(managerCustomerId);
  const url = `${GOOGLE_ADS_BASE_URL}/customers/${manager}/googleAds:search`;

  const run = (fields: string) =>
    call<HierarchyResponse>(url, {
      method: "POST",
      headers: headers(env, accessToken, manager),
      body: JSON.stringify({
        // level <= 1 is the manager itself plus its direct clients; deeper
        // levels are reached by stepping through each child manager in turn.
        query: `SELECT ${fields} FROM customer_client WHERE customer_client.level <= 1`,
      }),
    });

  let data: HierarchyResponse;
  try {
    data = await run(HIERARCHY_FIELDS);
  } catch (e) {
    if (e instanceof GoogleAdsApiError && e.code === "provider_error") {
      data = await run(HIERARCHY_FIELDS_MINIMAL);
    } else {
      throw e;
    }
  }

  const out: AdsAccount[] = [];
  for (const row of data.results ?? []) {
    const c = row?.customerClient;
    if (!c) continue;
    const id = normalizeCustomerId(
      str(c.id) ?? String(c.clientCustomer ?? "").split("/")[1] ?? ""
    );
    // Level 0 is the manager itself; it is already known to the caller.
    if (!id || id === manager) continue;

    out.push({
      customerId: id,
      descriptiveName: str(c.descriptiveName),
      currencyCode: str(c.currencyCode),
      timeZone: str(c.timeZone),
      testAccount: bool(c.testAccount),
      manager: bool(c.manager),
      accessPath: "manager_child",
      parentManagerCustomerId: manager,
    });
  }
  return out;
}

/**
 * Merge a discovered account into the set.
 *
 * Direct access outranks manager access: if the OAuth user holds an account
 * themselves, that is how they reach it, whichever managers also list it.
 * Otherwise the richer metadata wins, so an account seen twice ends up with
 * whatever Google actually told us rather than the first (possibly emptier)
 * sighting.
 */
function merge(into: Map<string, AdsAccount>, found: AdsAccount): void {
  const existing = into.get(found.customerId);
  if (!existing) {
    into.set(found.customerId, found);
    return;
  }
  const keepDirect = existing.accessPath === "direct" || found.accessPath === "direct";
  into.set(found.customerId, {
    customerId: existing.customerId,
    descriptiveName: existing.descriptiveName ?? found.descriptiveName,
    currencyCode: existing.currencyCode ?? found.currencyCode,
    timeZone: existing.timeZone ?? found.timeZone,
    testAccount: existing.testAccount ?? found.testAccount,
    manager: existing.manager ?? found.manager,
    accessPath: keepDirect ? "direct" : "manager_child",
    parentManagerCustomerId: keepDirect
      ? existing.accessPath === "direct"
        ? existing.parentManagerCustomerId
        : found.parentManagerCustomerId
      : existing.parentManagerCustomerId ?? found.parentManagerCustomerId,
  });
}

/**
 * Every account this authorization can reach — including advertisers that are
 * only reachable THROUGH a manager account.
 *
 * listAccessibleCustomers alone returns what the OAuth user holds directly,
 * which for a manager login is usually just the manager itself; the client
 * advertisers underneath it are found by walking the hierarchy. Traversal is
 * breadth-first with a visited set, a depth cap and a total cap, so a manager
 * graph that references itself cannot loop.
 *
 * Best effort by design: an account we cannot read must not hide the rest.
 */
export async function discoverAccounts(
  env: GoogleAdsEnv,
  accessToken: string,
  loginCustomerId?: string
): Promise<AdsAccount[]> {
  const found = new Map<string, AdsAccount>();
  const managerQueue: Array<{ id: string; depth: number }> = [];
  const visitedManagers = new Set<string>();

  for (const id of (await listAccessibleCustomers(env, accessToken)).slice(0, MAX_ACCOUNTS)) {
    let account: AdsAccount;
    try {
      account = await getAccount(env, accessToken, id, loginCustomerId);
    } catch {
      account = {
        customerId: id,
        descriptiveName: null,
        currencyCode: null,
        timeZone: null,
        testAccount: null,
        manager: null,
        accessPath: "direct",
        parentManagerCustomerId: null,
      };
    }
    merge(found, account);
    // An account we could not read might still be a manager, so it is worth
    // one hierarchy query — that query is what surfaces its advertisers.
    if (account.manager !== false) managerQueue.push({ id, depth: 0 });
  }

  while (managerQueue.length && found.size < MAX_ACCOUNTS) {
    const { id, depth } = managerQueue.shift()!;
    if (visitedManagers.has(id) || depth >= MAX_HIERARCHY_DEPTH) continue;
    visitedManagers.add(id);

    let children: AdsAccount[];
    try {
      children = await listCustomerHierarchy(env, accessToken, id);
    } catch {
      continue; // a manager we cannot enumerate must not stop the others
    }

    for (const child of children) {
      if (found.size >= MAX_ACCOUNTS && !found.has(child.customerId)) break;
      merge(found, child);
      if (child.manager === true && !visitedManagers.has(child.customerId)) {
        managerQueue.push({ id: child.customerId, depth: depth + 1 });
      }
    }
  }

  return [...found.values()];
}

/** @deprecated Kept for call sites; discoverAccounts also walks managers. */
export const listAccountsWithIdentity = discoverAccounts;
