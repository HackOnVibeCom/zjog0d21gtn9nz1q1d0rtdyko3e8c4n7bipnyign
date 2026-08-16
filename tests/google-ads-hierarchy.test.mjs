// ACCOUNT HIERARCHY — advertisers reachable THROUGH a manager account.
//
// customers:listAccessibleCustomers returns what the OAuth user holds
// directly, which for a manager login is usually just the manager itself. The
// client advertisers underneath it have to be walked for. No live Google call
// is made here: every response is stubbed.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const client = await import("../.tmp-test/googleAds/client.js");
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

const ENV = {
  clientId: "client-id.apps.googleusercontent.com",
  clientSecret: "super-secret-client-secret",
  developerToken: "dev-token-abc123",
  encryptionKey: "an-encryption-key-long-enough-for-derivation",
};

function mockFetch(responses) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({
      url: String(url),
      method: init?.method ?? "GET",
      headers: init?.headers ?? {},
      body: init?.body,
    });
    const next = responses.shift();
    if (!next) throw new Error("unexpected extra fetch call");
    return {
      ok: next.status === undefined || (next.status >= 200 && next.status < 300),
      status: next.status ?? 200,
      json: async () => next.body,
    };
  };
  return calls;
}

/** A customers:listAccessibleCustomers response. */
const accessible = (...ids) => ({ body: { resourceNames: ids.map((i) => `customers/${i}`) } });

/** A customer identity response. */
const identity = (id, over = {}) => ({
  body: {
    results: [
      {
        customer: {
          id,
          descriptiveName: `Account ${id}`,
          currencyCode: "USD",
          timeZone: "America/New_York",
          manager: false,
          testAccount: false,
          ...over,
        },
      },
    ],
  },
});

/** A customer_client hierarchy response for one manager. */
const hierarchy = (...children) => ({
  body: {
    results: children.map((c) => ({
      customerClient: {
        id: c.id,
        clientCustomer: `customers/${c.id}`,
        descriptiveName: c.name ?? `Child ${c.id}`,
        currencyCode: "USD",
        timeZone: "America/New_York",
        manager: c.manager ?? false,
        testAccount: c.test ?? false,
        level: c.level ?? 1,
      },
    })),
  },
});

test("a directly accessible advertiser is discovered", async () => {
  mockFetch([accessible("1111111111"), identity("1111111111")]);
  const found = await client.discoverAccounts(ENV, "t");
  assert.equal(found.length, 1);
  assert.equal(found[0].customerId, "1111111111");
  assert.equal(found[0].accessPath, "direct");
  assert.equal(found[0].parentManagerCustomerId, null);
});

test("a directly accessible manager is discovered and marked as a manager", async () => {
  mockFetch([
    accessible("9999999999"),
    identity("9999999999", { manager: true, descriptiveName: "My MCC" }),
    hierarchy({ id: "9999999999", level: 0, manager: true }),
  ]);
  const found = await client.discoverAccounts(ENV, "t");
  assert.equal(found.length, 1);
  assert.equal(found[0].manager, true);
  assert.equal(found[0].accessPath, "direct");
});

test("a manager's client advertisers are discovered through the hierarchy", async () => {
  // The bug this fixes: the manager is all listAccessibleCustomers returns.
  mockFetch([
    accessible("9999999999"),
    identity("9999999999", { manager: true, descriptiveName: "My MCC" }),
    hierarchy(
      { id: "9999999999", level: 0, manager: true }, // the manager itself
      { id: "1234567890", name: "SafeWalk Test Ads", test: true }
    ),
  ]);
  const found = await client.discoverAccounts(ENV, "t");
  const child = found.find((a) => a.customerId === "1234567890");

  assert.ok(child, "the client advertiser must be discovered");
  assert.equal(child.descriptiveName, "SafeWalk Test Ads");
  assert.equal(child.accessPath, "manager_child");
  assert.equal(child.parentManagerCustomerId, "9999999999");
  assert.equal(child.testAccount, true, "Google's own test flag is preserved");
  assert.equal(found.length, 2, "the manager itself is listed once, not twice");
});

test("the hierarchy query runs against the manager with its own login-customer-id", async () => {
  const calls = mockFetch([hierarchy({ id: "1234567890" })]);
  await client.listCustomerHierarchy(ENV, "t", "999-888-7777");

  assert.equal(
    calls[0].url,
    "https://googleads.googleapis.com/v25/customers/9998887777/googleAds:search"
  );
  assert.equal(
    calls[0].headers["login-customer-id"],
    "9998887777",
    "each manager authorises its own hierarchy step"
  );
  const query = JSON.parse(calls[0].body).query;
  assert.match(query, /FROM customer_client/);
  assert.match(query, /customer_client\.level <= 1/);
  assert.match(query, /customer_client\.client_customer/);
});

test("a nested manager is traversed and a cyclic graph cannot loop", async () => {
  const calls = mockFetch([
    accessible("1000000000"),
    identity("1000000000", { manager: true }),
    hierarchy({ id: "2000000000", manager: true }),
    // The sub-manager points back at the top manager.
    hierarchy({ id: "1000000000", manager: true }, { id: "3000000000" }),
  ]);
  const found = await client.discoverAccounts(ENV, "t");

  assert.deepEqual(found.map((a) => a.customerId).sort(), [
    "1000000000",
    "2000000000",
    "3000000000",
  ]);
  // Exactly four calls: the cycle back to the top manager is not re-walked.
  assert.equal(calls.length, 4);
});

test("an account seen twice appears once, and direct access wins", async () => {
  mockFetch([
    accessible("5555555555", "9999999999"),
    identity("5555555555"),
    identity("9999999999", { manager: true }),
    // The manager also lists the account we already hold directly.
    hierarchy({ id: "5555555555" }, { id: "7777777777" }),
  ]);
  const found = await client.discoverAccounts(ENV, "t");
  const shared = found.filter((a) => a.customerId === "5555555555");

  assert.equal(shared.length, 1, "no duplicate card");
  assert.equal(shared[0].accessPath, "direct", "direct access outranks manager access");
  assert.equal(found.length, 3);
});

test("richer metadata survives a second sighting", async () => {
  mockFetch([
    accessible("4444444444"),
    // The direct read fails, so the account starts with empty identity.
    { status: 403, body: {} },
    hierarchy({ id: "8888888888", name: "Named By Manager", test: true }),
  ]);
  const found = await client.discoverAccounts(ENV, "t");
  const child = found.find((a) => a.customerId === "8888888888");
  assert.equal(child.descriptiveName, "Named By Manager");
  assert.equal(child.testAccount, true);
});

test("a manager we cannot enumerate does not hide the other accounts", async () => {
  mockFetch([
    accessible("9999999999", "1111111111"),
    identity("9999999999", { manager: true }),
    identity("1111111111"),
    { status: 403, body: {} }, // hierarchy refused
  ]);
  const found = await client.discoverAccounts(ENV, "t");
  assert.equal(found.length, 2);
  assert.ok(found.some((a) => a.customerId === "1111111111"));
});

test("traversal is bounded by depth and total accounts", () => {
  assert.equal(client.MAX_HIERARCHY_DEPTH, 5);
  assert.equal(client.MAX_ACCOUNTS, 100);
  const src = read("lib/googleAds/client.ts");
  assert.match(src, /visitedManagers\.has\(id\)/, "a visited manager is never re-walked");
  assert.match(src, /depth >= MAX_HIERARCHY_DEPTH/, "depth is capped");
  assert.match(src, /found\.size < MAX_ACCOUNTS/, "total accounts are capped");
});

test("no credential material appears in hierarchy results", async () => {
  mockFetch([hierarchy({ id: "1234567890", test: true })]);
  const rows = await client.listCustomerHierarchy(ENV, "t", "9999999999");
  const dumped = JSON.stringify(rows);
  for (const secret of [ENV.developerToken, ENV.clientSecret, ENV.encryptionKey, "Bearer"]) {
    assert.ok(!dumped.includes(secret), `${secret} must not appear in results`);
  }
});

// ----------------------------------------------------------- selection guard

test("selection is verified against live discovery before anything is stored", () => {
  const route = read("app/api/integrations/google-ads/route.ts");
  const patch = route.slice(route.indexOf("export async function PATCH"));

  const discoverAt = patch.indexOf("discoverAccounts");
  const matchAt = patch.indexOf("accounts.find");
  const storeAt = patch.indexOf("selectCustomer");
  assert.ok(discoverAt >= 0, "discovery runs");
  assert.ok(matchAt > discoverAt, "the request is matched against what was discovered");
  assert.ok(storeAt > matchAt, "nothing is stored before the match");

  assert.match(patch, /currentUserId\(\)/, "still authenticated");
  assert.match(patch, /not accessible through this connection/, "unknown ids are refused");
});

test("an accessible manager child can be selected, a manager cannot", () => {
  const patch = read("app/api/integrations/google-ads/route.ts");
  // The only rejection by kind is the manager one — a manager_child that was
  // discovered is a normal advertiser and passes.
  assert.match(patch, /match\.manager === true/);
  assert.match(patch, /manager_not_selectable/);
  assert.doesNotMatch(patch, /accessPath === "manager_child"[\s\S]{0,80}403/);
});

test("the UI offers no way to select a manager account", () => {
  const card = read("components/app/GoogleAdsCard.tsx");
  assert.match(card, /const isManager = a\.manager === true/);
  assert.match(card, /Manager account — choose an advertiser account/);
  assert.match(card, /via manager/, "a child says which manager it came through");
});

test("hierarchy discovery adds no mutation capability", () => {
  const src = read("lib/googleAds/client.ts");
  assert.ok(!src.includes(":mutate"), "no mutation endpoint");
  assert.match(src, /googleAds:search/, "read-only search only");
  for (const verb of ["campaignBudgets", "adGroupAds", "campaigns:"]) {
    assert.ok(!src.includes(verb), `${verb} must not appear`);
  }
});
