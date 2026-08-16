// PUBLIC JUDGE SANDBOX — the guarantees that make a public execution button
// safe. No Google call is made here; what is pinned down is what the server
// refuses to take from a browser, and what it refuses to do twice.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

process.env.AUTH_SECRET ??= "test-secret-for-demo-sessions";

const { readSessionId, signSessionId, clientHash, LIMITS } = await import(
  "../.tmp-test/demo/session.js"
);
const { planGrowth, normalizeMarket } = await import("../.tmp-test/demo/autopilot.js");
const { DEMO_MAX_DAILY_BUDGET_MICROS, DEMO_APP_ID, UNDERSTAND, DISCOVER } = await import(
  "../.tmp-test/demo/workspace.js"
);

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

// ------------------------------------------------------------ session cookie

test("a demo session cookie is signed and cannot be forged", () => {
  const cookie = signSessionId("session-abc");
  assert.equal(readSessionId(cookie), "session-abc");

  assert.equal(readSessionId("session-abc"), null, "an unsigned id is refused");
  assert.equal(readSessionId("session-xyz." + cookie.split(".")[1]), null, "a swapped id is refused");
  assert.equal(readSessionId(undefined), null);
  assert.equal(readSessionId("garbage"), null);
});

test("client identification is hashed, never stored raw", () => {
  const a = clientHash("203.0.113.7", "Mozilla/5.0");
  const b = clientHash("203.0.113.7", "Mozilla/5.0");
  const c = clientHash("203.0.113.8", "Mozilla/5.0");
  assert.equal(a, b, "stable for the same client");
  assert.notEqual(a, c, "different clients differ");
  assert.ok(!a.includes("203.0.113"), "the address must not survive in the hash");

  const src = read("lib/demo/session.ts");
  assert.match(src, /createHmac/, "hashing is keyed, not a bare digest");
  assert.doesNotMatch(src, /data:\s*\{[^}]*ip\b/, "no raw address is written to the database");
});

test("the demo session is not an account session", () => {
  const src = read("lib/demo/session.ts");
  assert.doesNotMatch(src, /next-auth|currentUserId|userId/, "it grants no user identity");
  const exec = read("app/api/demo/execute/route.ts");
  assert.doesNotMatch(exec, /currentUserId/, "the sandbox never resolves a signed-in user");
});

// ------------------------------------------------------------ budget ceiling

test("the approved budget is a request, never a decision", () => {
  const plan = planGrowth({
    goal: "app_installs",
    market: "US",
    approvedDailyBudgetMicros: 900_000_000,
  });
  assert.ok(
    plan.dailyBudgetMicros <= DEMO_MAX_DAILY_BUDGET_MICROS,
    "the server ceiling wins over anything requested"
  );
  assert.equal(plan.clampedByPolicy, true);
  assert.match(plan.reasoning.join(" "), /reduced it before the request was built/);
});

test("a budget inside the ceiling passes through unchanged", () => {
  const plan = planGrowth({ goal: "app_installs", market: "US", approvedDailyBudgetMicros: 3_000_000 });
  assert.equal(plan.dailyBudgetMicros, 3_000_000);
  assert.equal(plan.clampedByPolicy, false);
});

test("a hostile or absent budget never becomes zero or negative", () => {
  for (const bad of [undefined, null, NaN, -5_000_000, "10000000000"]) {
    const plan = planGrowth({ goal: "app_installs", market: "US", approvedDailyBudgetMicros: bad });
    assert.ok(plan.dailyBudgetMicros > 0);
    assert.ok(plan.dailyBudgetMicros <= DEMO_MAX_DAILY_BUDGET_MICROS);
  }
});

test("the campaign status in a plan is always PAUSED", () => {
  const plan = planGrowth({ goal: "app_installs", market: "GB", approvedDailyBudgetMicros: 5_000_000 });
  assert.equal(plan.campaignStatus, "PAUSED");
  assert.equal(plan.channel, "MULTI_CHANNEL");
});

test("an unknown market falls back rather than reaching Google", () => {
  assert.equal(normalizeMarket("ZZ"), "US");
  assert.equal(normalizeMarket(undefined), "US");
  assert.equal(normalizeMarket("gb"), "GB");
});

// ------------------------------------------------- what the browser may send

test("the sandbox refuses to take identity or status from the browser", () => {
  const src = read("app/api/demo/execute/route.ts");
  const body = src.slice(src.indexOf("await req.json()"));
  const accepted = body.slice(0, body.indexOf("const plan"));
  for (const forbidden of ["customerId", "managerCustomerId", "status", "loginCustomerId"]) {
    assert.ok(!accepted.includes(forbidden), `${forbidden} must not be read from the request body`);
  }
  assert.match(src, /market\?: unknown/);
  assert.match(src, /approvedDailyBudgetMicros\?: unknown/);
  // The account comes from the provider, which reads server configuration only.
  assert.match(src, /new DemoServiceAccountAuthProvider\(\)/);
  assert.match(src, /testAccountOnly: true/);
});

test("the sandbox uses the same execution engine as the customer path", () => {
  const src = read("app/api/demo/execute/route.ts");
  assert.match(src, /executeAppCampaign/, "no second campaign implementation");
  assert.ok(!src.includes(":mutate"), "the route builds no Google request of its own");
});

// -------------------------------------------------------------- idempotency

test("a repeat click returns the existing proof instead of creating another campaign", () => {
  // Compare positions inside the handler, not in the import list.
  const src = read("app/api/demo/execute/route.ts");
  const handler = src.slice(src.indexOf("export async function POST"));
  const guardAt = handler.indexOf("existingExecution(");
  const executeAt = handler.indexOf("executeAppCampaign(");
  assert.ok(guardAt >= 0, "the handler checks for an existing execution");
  assert.ok(guardAt < executeAt, "the reuse check runs before execution");
  assert.match(src, /reused: true/);
  assert.equal(LIMITS.perSession, 1, "one execution per session");
});

test("limits are enforced in the database, not in process memory", () => {
  const src = read("lib/demo/session.ts");
  assert.match(src, /prisma\.googleAdsExecution\.count/);
  assert.match(src, /globalPerDay/);
  assert.ok(!/const .*Map\(/.test(src), "no in-memory counter that a cold start would reset");
});

test("limit responses do not disclose the thresholds", () => {
  const src = read("app/api/demo/execute/route.ts");
  const block = src.slice(src.indexOf("if (!verdict.allowed)"), src.indexOf("const body ="));
  // The HTTP status is part of the protocol, not a threshold; what must not
  // leak are the counts a probe could use to map the limits.
  const withoutStatus = block.replace(/status:\s*\d+/g, "");
  assert.doesNotMatch(withoutStatus, /LIMITS\.|perSession|perClient|globalPerDay|\b\d{2,}\b/);
});

// ------------------------------------------------------------- verification

test("verify asks Google again rather than re-reading our database", () => {
  const src = read("app/api/demo/verify/route.ts");
  assert.match(src, /readBackCampaign/, "a fresh Google query");
  assert.match(src, /demoServiceAccountToken/);
  const response = src.slice(src.indexOf("return NextResponse.json({\n      verified: true"));
  for (const forbidden of ["customerId", "resourceName", "accessToken", "developerToken"]) {
    assert.ok(!response.includes(forbidden), `${forbidden} must not reach the browser`);
  }
});

// ------------------------------------------------------------- demo content

test("demo content is labelled and carries no invented metrics", () => {
  for (const fact of UNDERSTAND) {
    assert.ok(
      ["DEMO", "AI GENERATED", "RETRIEVED", "UNKNOWN"].includes(fact.provenance),
      `${fact.label} must state its provenance`
    );
  }
  const dumped = JSON.stringify({ UNDERSTAND, DISCOVER }).toLowerCase();
  for (const metric of ["impression", "install count", "conversion", "ctr", "cpi", "roas", "revenue"]) {
    assert.ok(!dumped.includes(metric), `demo content must not imply ${metric}`);
  }
});

// ------------------------------------------------------------- public claims

/** Everything a visitor can read before, during and after an execution. */
const PUBLIC_COPY = [
  "app/page.tsx",
  "app/demo/page.tsx",
  "components/app/DemoWorkspace.tsx",
  "components/app/LandingNav.tsx",
];

test("the public copy never claims the campaign serves, launches or acquires", () => {
  // A paused campaign with no ad group and no creatives advertises nothing. The
  // demo may say a real resource exists; it may never imply it is working.
  const forbidden = [
    "campaign is live",
    "campaign went live",
    "now live",
    "is serving",
    "are serving",
    "ads are running",
    "campaign launched",
    "launch your campaign",
    "acquiring users",
    "users acquired",
    "getting installs",
    "driving installs",
  ];
  for (const file of PUBLIC_COPY) {
    const copy = read(file).toLowerCase();
    for (const claim of forbidden) {
      assert.ok(!copy.includes(claim), `${file} must not claim "${claim}"`);
    }
  }
});

test("the demo states the limits of what it proves, in the visitor's words", () => {
  const copy = read("components/app/DemoWorkspace.tsx");
  assert.match(copy, /PAUSED/, "the paused status is stated");
  assert.match(copy, /test account/i, "the isolated test account is stated");
  assert.match(copy, /no ad group/i, "the missing ad group is disclosed");
  assert.match(copy, /spends nothing|cannot spend/i, "the absence of spend is stated");
  assert.match(copy, /What this is, and what it is not/, "the scope card is present");
});

test("the demo page cannot reach an account or a customer project", () => {
  const page = read("app/demo/page.tsx");
  const view = read("components/app/DemoWorkspace.tsx");
  assert.doesNotMatch(page, /currentUserId|ownedProjectOr|prisma/, "no owner data on the demo route");
  assert.doesNotMatch(view, /\/api\/projects/, "the demo view calls only demo endpoints");
  for (const call of view.match(/fetch\("([^"]+)"/g) ?? []) {
    assert.match(call, /\/api\/demo\//, `the demo view may only call demo endpoints: ${call}`);
  }
});

test("the sandbox app id is a real package id, not a placeholder", () => {
  assert.match(DEMO_APP_ID, /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/i);
  assert.ok(!/example|test\.app|dummy|fake/i.test(DEMO_APP_ID));
});

test("no real account identifier appears in sandbox source", () => {
  const stripComments = (s) =>
    s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  for (const f of [
    "lib/demo/session.ts",
    "lib/demo/autopilot.ts",
    "lib/demo/workspace.ts",
    "app/api/demo/execute/route.ts",
    "app/api/demo/verify/route.ts",
  ]) {
    assert.doesNotMatch(stripComments(read(f)), /\b\d{10}\b/, `${f} must not hardcode an account id`);
  }
});
