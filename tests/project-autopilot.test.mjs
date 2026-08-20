// STEP 3 IN THE SIGNED-IN PRODUCT — the judge journey runs on the customer's
// own app, so the Google Ads execution moves next to the analysis that produced
// it. These tests pin the order of the two blocks, and pin the safety
// guarantees that must survive being reachable from an authenticated page.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

process.env.DATABASE_URL ??= "postgresql://test:test@127.0.0.1:5432/test";
process.env.GOOGLE_ADS_CLIENT_ID ??= "client-id.apps.googleusercontent.com";
process.env.GOOGLE_ADS_CLIENT_SECRET ??= "test-client-secret";
process.env.GOOGLE_ADS_DEVELOPER_TOKEN ??= "test-developer-token";
process.env.GOOGLE_ADS_TOKEN_ENCRYPTION_KEY ??= "an-encryption-key-long-enough-for-derivation";

const { packageIdForProject, PROJECT_LIMITS, PENDING_GRACE_MS, campaignMayExist } = await import(
  "../.tmp-test/googleAds/projectRun.js"
);
const { findCampaignByReference, referenceMarker, executeAppCampaign, readBackCampaign } =
  await import("../.tmp-test/googleAds/execution.js");

/** Records calls and answers them from a queue. No network is touched. */
function mockFetch(responses) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : null });
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

const stubAuth = {
  mode: "demo_service_account",
  accessToken: async () => "stub-token",
  loginCustomerId: () => "9998887777",
  targetCustomerId: async () => "1234567890",
};

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const PAGE = "app/projects/[id]/page.tsx";
const ROUTE = "app/api/projects/[id]/google-ads/route.ts";
const VERIFY = "app/api/projects/[id]/google-ads/verify/route.ts";
const BLOCK = "components/app/ProjectAutopilot.tsx";
const LIB = "lib/googleAds/projectRun.ts";

// ------------------------------------------------------------- step 3 layout

test("the Google Ads demo lives inside Step 3, not as a new numbered step", () => {
  const page = read(PAGE);
  const step3 = page.indexOf("Step 3 · Discover");
  const block = page.indexOf("<ProjectAutopilot");
  assert.ok(step3 >= 0, "Step 3 still exists");
  assert.ok(block > step3, "the block sits inside step 3, after its heading");
  // Step 3 is the final workspace stage now; nothing may add another one.
  for (const later of ["Step 4 · ", "Step 5 · "]) {
    assert.ok(!page.includes(later), `no ${later.trim()} step may be introduced`);
  }
});

test("the Google Ads demo comes before the audience block", () => {
  const page = read(PAGE);
  const block = page.indexOf("<ProjectAutopilot");
  const audience = page.indexOf("Where your audience already gathers");
  assert.ok(block >= 0 && audience > block, "Google Ads first, audience discovery second");
});

test("steps 1 and 2 are untouched", () => {
  const page = read(PAGE);
  for (const label of ["Step 1 · Understand", "Step 2 · Promote"]) {
    assert.ok(page.includes(label), `${label} must still be present`);
  }
});

test("the audience block keeps its heading, CTA and empty state", () => {
  const page = read(PAGE);
  assert.match(page, /Where your audience already gathers/);
  assert.match(page, /"Find my audience"/);
  assert.match(page, /onClick=\{findAudience\}/, "the existing discovery workflow still runs");
  assert.match(page, /No searches run yet/, "nothing implies a search already ran");
  assert.match(page, /Preview with demo data/);
  assert.match(page, /Reddit provider: \{providerMsg\}/, "provider status stays disclosed");
});

test("demo discovery results stay explicitly labelled", () => {
  const page = read(PAGE);
  assert.match(page, /Demo \/ test data — fictional, not retrieved from anywhere/);
});

// ------------------------------------------------- the app being promoted

test("the promoted package is derived from the project's own store URL", () => {
  assert.equal(
    packageIdForProject("https://play.google.com/store/apps/details?id=com.example.app"),
    "com.example.app"
  );
  assert.equal(
    packageIdForProject("https://play.google.com/store/apps/details?id=com.example.app&hl=en"),
    "com.example.app"
  );
  assert.equal(packageIdForProject(null), null);
  assert.equal(packageIdForProject(""), null);
  assert.equal(packageIdForProject("not a url"), null);
  assert.equal(packageIdForProject("https://example.com/?id=com.example.app"), null);
  assert.equal(packageIdForProject("https://play.google.com/store/apps/details?id=../../etc"), null);
});

test("the browser cannot choose which app is promoted", () => {
  const route = read(ROUTE);
  const handler = route.slice(route.indexOf("export async function POST"));
  const accepted = handler.slice(handler.indexOf("await req.json()"), handler.indexOf("const plan"));
  for (const forbidden of ["appId", "customerId", "managerCustomerId", "status", "loginCustomerId"]) {
    assert.ok(!accepted.includes(forbidden), `${forbidden} must not be read from the request body`);
  }
  assert.match(handler, /packageIdForProject\(p\?\.storeUrl\)/, "the package comes from the project row");
  assert.match(route, /market\?: unknown/);
  assert.match(route, /approvedDailyBudgetMicros\?: unknown/);
});

test("a project with no store link cannot execute at all", () => {
  const route = read(ROUTE);
  const handler = route.slice(route.indexOf("export async function POST"));
  const guard = handler.indexOf("no_app_id");
  const execute = handler.indexOf("executeAppCampaign(");
  assert.ok(guard >= 0 && guard < execute, "the missing-app check runs before Google is called");
});

// --------------------------------------------------------- safety guarantees

test("execution stays inside the isolated TEST account", () => {
  const route = read(ROUTE);
  assert.match(route, /testAccountOnly: true/);
  assert.match(route, /new DemoServiceAccountAuthProvider\(\)/, "the account comes from server config");
  assert.ok(!route.includes(":mutate"), "the route builds no Google request of its own");
  assert.match(route, /executeAppCampaign/, "no second campaign implementation");
});

test("the campaign status is forced by the server, never by the page", () => {
  const engine = read("lib/googleAds/execution.ts");
  assert.match(engine, /status: "PAUSED"/);
  assert.ok(!engine.includes('"ENABLED"'), "no path can request an enabled campaign");
  const route = read(ROUTE);
  assert.ok(!/status:\s*(body|req)/.test(route), "status is never taken from the request");
  const block = read(BLOCK);
  assert.ok(!block.includes('status: "'), "the page sends no campaign status at all");
});

test("the budget ceiling belongs to the server", () => {
  const route = read(ROUTE);
  assert.match(route, /allowedMaxDailyBudgetMicros: DEMO_MAX_DAILY_BUDGET_MICROS/);
  assert.match(route, /planGrowth\(/, "the plan clamps before the request is built");
});

test("a real campaign id is shown only after the server confirms one", () => {
  const block = read(BLOCK);
  const idAt = block.indexOf("proof.campaignId");
  assert.ok(idAt >= 0);
  const guard = block.indexOf("{proof && (");
  assert.ok(guard >= 0 && guard < idAt, "campaign values render only inside the proof branch");
  assert.ok(
    !/setProof\(\s*\{/.test(block),
    "the page never fabricates a proof object of its own"
  );
});

test("the first proof comes from a fresh Google read-back", () => {
  const engine = read("lib/googleAds/execution.ts");
  const create = engine.indexOf("CAMPAIGN_CREATED");
  const readback = engine.indexOf("readBackCampaign(");
  assert.ok(readback > create, "the proof is read back after creation, not taken from the mutate");
});

test("verifying asks Google again rather than re-reading our database", () => {
  const verify = read(VERIFY);
  assert.match(verify, /readBackCampaign/, "a fresh Google query");
  const response = verify.slice(verify.indexOf("verified: true"));
  for (const forbidden of ["customerId", "resourceName", "accessToken", "developerToken"]) {
    assert.ok(!response.includes(forbidden), `${forbidden} must not reach the browser`);
  }
  const block = read(BLOCK);
  assert.match(block, /\$\{base\}\/verify/, "the page calls the verify endpoint for a new answer");
});

// -------------------------------------------------------------- idempotency

test("repeating the action cannot create a second campaign", () => {
  const route = read(ROUTE);
  const handler = route.slice(route.indexOf("export async function POST"));
  const reuse = handler.indexOf("existingProjectExecution(");
  const claim = handler.indexOf("projectClaimIsOurs(");
  const execute = handler.indexOf("executeAppCampaign(");
  assert.ok(reuse >= 0 && reuse < execute, "an existing campaign is returned before creating one");
  assert.ok(claim >= 0 && claim < execute, "the race claim is settled before Google is called");
  assert.match(handler, /releaseProjectClaim\(/, "the losing request stands down");
  assert.match(route, /reused: true/);
  assert.equal(PROJECT_LIMITS.perProject, 1, "one campaign per project");
});

test("a page load reads our records, never Google", () => {
  const route = read(ROUTE);
  const get = route.slice(route.indexOf("export async function GET"), route.indexOf("export async function POST"));
  assert.ok(!get.includes("readBackCampaign"), "no provider call when the page opens");
  assert.ok(!get.includes("executeAppCampaign"), "opening the page creates nothing");
  assert.match(get, /existingProjectExecution/);
});

test("every route on this path is behind the project ownership gate", () => {
  for (const f of [ROUTE, VERIFY]) {
    const src = read(f);
    assert.match(src, /ownedProjectOr\(id\)/, `${f} must check ownership`);
    assert.match(src, /isDenied\(gate\)/, `${f} must act on a denial`);
  }
});

// ------------------------------------------------------------- honest claims

test("the block never claims the campaign serves, spends or acquires", () => {
  const copy = read(BLOCK).toLowerCase();
  for (const claim of [
    "campaign is live",
    "now live",
    "is serving",
    "are serving",
    "ads are running",
    "campaign launched",
    "acquiring users",
    "users acquired",
    "getting installs",
    "driving installs",
    "money spent",
  ]) {
    assert.ok(!copy.includes(claim), `the block must not claim "${claim}"`);
  }
  for (const metric of ["impressions", "click-through", "ctr", "conversions", "roas", "revenue"]) {
    assert.ok(!copy.includes(metric), `no fabricated ${metric}`);
  }
});

test("the block states what it is and what it is not", () => {
  const copy = read(BLOCK);
  assert.match(copy, /PAUSED/);
  assert.match(copy, /test account/i);
  assert.match(copy, /no ad group/i);
  assert.match(copy, /spends nothing/i);
  assert.match(copy, /What happens:/, "each CTA says what it will do");
  assert.match(copy, /What changed:/, "each completed action says what changed");
});

test("no secret or account identifier reaches this page", () => {
  const stripComments = (s) =>
    s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  for (const f of [BLOCK, ROUTE, VERIFY, "lib/googleAds/projectRun.ts"]) {
    const src = stripComments(read(f));
    assert.doesNotMatch(src, /\b\d{10}\b/, `${f} must not hardcode an account id`);
    for (const secret of ["developerToken", "privateKey", "refreshToken", "GOOGLE_ADS_DEMO"]) {
      assert.ok(!src.includes(secret), `${f} must not handle ${secret}`);
    }
  }
});

// ------------------------------------------- interrupted runs and recovery
//
// The dangerous window: Google creates the campaign, the process dies before
// the identity is saved, and the row is indistinguishable from an attempt that
// never left. These pin the behaviour that keeps that from becoming a second
// campaign. Database steps are asserted structurally — this suite runs without
// a database, by design.

test("an execution can be found again by the reference it wrote before mutating", async () => {
  const calls = mockFetch([
    { body: { results: [{ campaign: { resourceName: "customers/1234567890/campaigns/777" } }] } },
  ]);
  const found = await findCampaignByReference(stubAuth, "t", "1234567890", "ckrow123456");
  assert.equal(found, "customers/1234567890/campaigns/777");
  assert.match(calls[0].body.query, /campaign\.name LIKE '%ref:ckrow123456%'/);
  assert.match(calls[0].body.query, /^SELECT/, "a read query, never a mutate");
  assert.ok(!calls[0].url.includes(":mutate"));
});

test("Google saying nothing exists is a definite answer, not an error", async () => {
  mockFetch([{ body: { results: [] } }]);
  assert.equal(await findCampaignByReference(stubAuth, "t", "1234567890", "ckrow123456"), null);
});

test("a reference that is not a plain id is refused rather than escaped", async () => {
  for (const bad of ["' OR 1=1 --", "abc", "a".repeat(65), "ck row", "ck%row"]) {
    await assert.rejects(
      () => findCampaignByReference(stubAuth, "t", "1234567890", bad),
      /not usable/,
      `${bad} must not reach a query`
    );
  }
});

test("the reference travels into the campaign name before the mutate", () => {
  const handler = read(ROUTE).slice(read(ROUTE).indexOf("export async function POST"));
  const rowAt = handler.indexOf("googleAdsExecution.create");
  const execAt = handler.indexOf("executeAppCampaign(");
  assert.ok(rowAt >= 0 && rowAt < execAt, "the row, and so its reference, exists before the mutation");
  // The marker is an argument of the call, so it is looked for inside it.
  const args = handler.slice(execAt, handler.indexOf("testAccountOnly: true"));
  assert.match(
    args,
    /campaignName: .*referenceMarker\(started\.id\)/,
    "the reference is part of the request Google receives"
  );
  assert.equal(referenceMarker("abc123"), "ref:abc123");
});

test("a recent pending run blocks a second attempt instead of mutating", () => {
  const lib = read(LIB);
  const fn = lib.slice(lib.indexOf("export async function resolvePendingExecution"));
  const graceAt = fn.indexOf("PENDING_GRACE_MS");
  const askAt = fn.indexOf("findCampaignByReference");
  assert.ok(graceAt >= 0 && graceAt < askAt, "the grace window is checked before Google is asked");
  assert.match(fn, /state: "in_flight"/);
  assert.ok(PENDING_GRACE_MS > 0);

  const handler = read(ROUTE).slice(read(ROUTE).indexOf("export async function POST"));
  const resolveAt = handler.indexOf("resolvePendingExecution(");
  const execAt = handler.indexOf("executeAppCampaign(");
  assert.ok(resolveAt >= 0 && resolveAt < execAt, "pending runs are settled before any mutation");
  assert.match(handler, /outcome\.state === "in_flight"/);
});

test("a stale pending run is settled by asking Google, never by assuming", () => {
  const lib = read(LIB);
  const fn = lib.slice(lib.indexOf("export async function resolvePendingExecution"));
  assert.match(fn, /findCampaignByReference/, "the ambiguity is put to Google");
  assert.ok(
    !/googleAdsExecution\.delete/.test(fn),
    "a pending row is never deleted — deleting it would strand a real campaign"
  );
});

test("interrupted before Google created anything: the row closes and a retry is allowed", () => {
  const lib = read(LIB);
  const fn = lib.slice(lib.indexOf("export async function resolvePendingExecution"));
  const branch = fn.slice(fn.indexOf("if (!resourceName)"), fn.indexOf('state: "never_created"'));
  assert.match(branch, /result: "failed"/, "the row is closed, not left pending forever");
  assert.match(branch, /interrupted_before_create/);
  assert.ok(!branch.includes("delete"), "closing is a state change, not a deletion");
});

test("interrupted after Google created it: the campaign is adopted, not recreated", () => {
  const lib = read(LIB);
  const fn = lib.slice(lib.indexOf("export async function resolvePendingExecution"));
  const adopt = fn.slice(fn.indexOf("const proof = await readBackCampaign"));
  assert.match(adopt, /result: "succeeded"/);
  assert.match(adopt, /campaignResourceName: proof\.campaignResourceName/);
  assert.match(adopt, /EXECUTION_RECOVERED/);
  assert.ok(!adopt.includes("executeAppCampaign"), "recovery never mutates");
  assert.match(fn, /readBackCampaign/, "the adopted proof still comes from a fresh Google read");
});

test("an unresolved previous attempt refuses the mutation rather than risking a duplicate", () => {
  const lib = read(LIB);
  const fn = lib.slice(lib.indexOf("export async function resolvePendingExecution"));
  const tail = fn.slice(fn.indexOf("} catch {"));
  assert.match(tail, /state: "unresolved"/, "any failure to find out is conservative");

  const handler = read(ROUTE).slice(read(ROUTE).indexOf("export async function POST"));
  const unresolvedAt = handler.indexOf('outcome.state === "unresolved"');
  const execAt = handler.indexOf("executeAppCampaign(");
  assert.ok(unresolvedAt >= 0 && unresolvedAt < execAt, "the refusal happens before any mutation");
  assert.match(handler, /unresolved_previous_attempt/);
});

test("the allowance check and the claim agree about which rows count", () => {
  const lib = read(LIB);
  const claim = lib.slice(lib.indexOf("export async function projectClaimIsOurs"));
  const handler = read(ROUTE).slice(read(ROUTE).indexOf("export async function POST"));
  // Any stale pending row is resolved to succeeded or failed before a new row
  // is created, so it can no longer win the claim and block the project forever.
  assert.ok(
    handler.indexOf("resolvePendingExecution(") < handler.indexOf("googleAdsExecution.create"),
    "no unresolved pending row survives into the claim"
  );
  assert.match(claim, /result: \{ in: \["succeeded", "pending"\] \}/);
  assert.match(claim, /orderBy: \[\{ startedAt: "asc" \}, \{ id: "asc" \}\]/);
});

test("no path in the project run can create a second campaign", () => {
  const handler = read(ROUTE).slice(read(ROUTE).indexOf("export async function POST"));
  assert.equal(
    (handler.match(/executeAppCampaign\(/g) ?? []).length,
    1,
    "exactly one call site can mutate"
  );
  for (const guard of [
    "existingProjectExecution(",
    "pendingProjectExecution(",
    "checkProjectExecutionAllowed(",
    "projectClaimIsOurs(",
  ]) {
    assert.ok(
      handler.indexOf(guard) >= 0 && handler.indexOf(guard) < handler.indexOf("executeAppCampaign("),
      `${guard} must run before the mutation`
    );
  }
});

// ------------------------------------------------------- honest status only

test("an unconfirmed status is never displayed as a confirmed PAUSED", () => {
  const block = read(BLOCK);
  assert.ok(
    !/status\s*\?\?\s*"PAUSED"/.test(block),
    "no fallback may substitute the status the server merely requested"
  );
  assert.ok(!/tone="success">\{proof\.status/.test(block), "no unconditional success tone");
  assert.match(block, /function statusDisplay/, "one place decides how a status is shown");
  const fn = block.slice(block.indexOf("function statusDisplay"), block.indexOf("const clock"));
  assert.match(fn, /status === "PAUSED"/, "success is reserved for a confirmed PAUSED");
  assert.match(fn, /Status not confirmed/, "a missing status says so");
  assert.match(fn, /tone: "warning"/, "an unexpected status is flagged, not celebrated");
});

test("a failed status load explains itself and offers a retry", () => {
  const block = read(BLOCK);
  assert.match(block, /setLoadError\(true\)/);
  assert.match(block, /Try loading it again/, "the customer is not left with a dead button");
  assert.match(block, /onClick=\{loadStatus\}/);
});

test("failures are announced, not only successes", () => {
  const block = read(BLOCK);
  for (const marker of [
    /The execution did not complete\./,
    /connection was lost/,
    /Verification failed\./,
    /could not be loaded/,
  ]) {
    assert.match(block, marker, `an announcement is missing for ${marker}`);
  }
  const announcements = (block.match(/setAnnouncement\(/g) ?? []).length;
  assert.ok(announcements >= 6, `expected failure and success announcements, found ${announcements}`);
});

// ------------------------------------- an ambiguous failure is not a failure
//
// The narrowest and most dangerous window: Google creates the campaign and the
// run dies before we can write down what it created. These run the real engine
// against mocked Google responses — no live request is made — and check the
// behaviour rather than the wording of the code.

const testAccountOk = { body: { results: [{ customer: { id: "1234567890", testAccount: true } }] } };
const budgetCreated = { body: { results: [{ resourceName: "customers/1234567890/campaignBudgets/55" }] } };
const campaignCreated = { body: { results: [{ resourceName: "customers/1234567890/campaigns/777" }] } };
const readBackOk = {
  body: {
    results: [
      {
        campaign: {
          id: "777",
          name: "Demo · ref:ckrow123456",
          status: "PAUSED",
          resourceName: "customers/1234567890/campaigns/777",
          advertisingChannelType: "MULTI_CHANNEL",
          advertisingChannelSubType: "APP_CAMPAIGN",
          appCampaignSetting: { appId: "com.example.app" },
        },
      },
    ],
  },
};

const runRequest = {
  campaignName: "Example · United States installs · ref:ckrow123456",
  appId: "com.example.app",
  requestedDailyBudgetMicros: 3_000_000,
};
const runOptions = { allowedMaxDailyBudgetMicros: 10_000_000, testAccountOnly: true };
const mutateCalls = (calls) => calls.filter((c) => c.url.includes("campaigns:mutate"));

test("campaign created, then the read-back fails: the outcome is ambiguous", async () => {
  const calls = mockFetch([testAccountOk, budgetCreated, campaignCreated, { status: 500, body: {} }]);

  const error = await executeAppCampaign(stubAuth, runRequest, runOptions).then(
    () => null,
    (e) => e
  );

  assert.ok(error, "the run must fail");
  assert.equal(error.stage, "campaign_created", "the campaign exists, whatever failed next");
  assert.equal(campaignMayExist(error), true, "so the row must not be closed as failed");
  assert.equal(mutateCalls(calls).length, 1, "exactly one campaign creation was attempted");
  assert.ok(
    error.events.some((e) => e.code === "CAMPAIGN_CREATED"),
    "the timeline records that Google returned a campaign"
  );
});

test("the campaign mutate never answering is also ambiguous", async () => {
  const calls = mockFetch([
    testAccountOk,
    budgetCreated,
    { status: 504, body: {} }, // the campaign mutate itself
  ]);

  const error = await executeAppCampaign(stubAuth, runRequest, runOptions).then(
    () => null,
    (e) => e
  );

  assert.ok(error);
  assert.equal(error.stage, "campaign_mutation_unconfirmed", "the request may still have landed");
  assert.equal(campaignMayExist(error), true);
  assert.equal(mutateCalls(calls).length, 1);
});

test("failing before the campaign mutate is a definite failure", async () => {
  const calls = mockFetch([testAccountOk, { status: 500, body: {} }]); // budget creation fails

  const error = await executeAppCampaign(stubAuth, runRequest, runOptions).then(
    () => null,
    (e) => e
  );

  assert.ok(error);
  assert.equal(error.stage, "before_campaign_mutation");
  assert.equal(campaignMayExist(error), false, "nothing was created, so the row may be closed");
  assert.equal(mutateCalls(calls).length, 0, "no campaign creation was attempted");
});

test("a refused test account never reaches a mutation", async () => {
  const calls = mockFetch([
    { body: { results: [{ customer: { id: "1234567890", testAccount: false } }] } },
  ]);

  const error = await executeAppCampaign(stubAuth, runRequest, runOptions).then(
    () => null,
    (e) => e
  );

  assert.ok(error);
  assert.equal(error.stage, "before_campaign_mutation");
  assert.equal(campaignMayExist(error), false);
  assert.equal(calls.filter((c) => c.url.includes(":mutate")).length, 0, "nothing was mutated");
});

test("a failure while saving a confirmed proof counts as ambiguous", () => {
  // Saving happens after the engine returns, so the thrown value is an ordinary
  // error with no stage. The campaign is already real, so the pessimistic
  // default is the only safe reading.
  assert.equal(campaignMayExist(new Error("database unavailable")), true);
  assert.equal(campaignMayExist(undefined), true);
  assert.equal(campaignMayExist({ code: "timeout" }), true, "a bare provider code proves nothing");
});

test("an ambiguous failure keeps the row recoverable instead of closing it", () => {
  const handler = read(ROUTE).slice(read(ROUTE).indexOf("export async function POST"));
  const block = handler.slice(handler.lastIndexOf("} catch (e) {"));
  assert.match(block, /campaignMayExist\(e\)/, "the decision comes from how far the run got");
  // The failed/completedAt pair may only appear on the definite branch.
  assert.match(block, /ambiguous\s*\?\s*\{ errorCode:/, "an ambiguous row keeps its pending state");
  const beforeDecision = block.slice(0, block.search(/ambiguous\s*\?/));
  assert.ok(beforeDecision.length > 0, "the decision point must exist");
  assert.doesNotMatch(
    beforeDecision,
    /result: "failed"/,
    "nothing closes the row before the ambiguity is judged"
  );
  assert.match(block, /unconfirmed_outcome/);
  const ambiguousMessage = block.match(/error: ambiguous\s*\?\s*"([^"]+)"/)?.[1] ?? "";
  assert.ok(ambiguousMessage.length > 0, "the ambiguous branch must have its own message");
  assert.match(ambiguousMessage, /did not return a complete confirmation/);
  assert.doesNotMatch(
    ambiguousMessage,
    /no campaign was created/i,
    "an ambiguous failure never claims that no campaign was created"
  );
});

test("recovering an ambiguous run finds the campaign and reads it back, without mutating", async () => {
  const calls = mockFetch([
    { body: { results: [{ campaign: { resourceName: "customers/1234567890/campaigns/777" } }] } },
    readBackOk,
  ]);

  const found = await findCampaignByReference(stubAuth, "t", "1234567890", "ckrow123456");
  assert.equal(found, "customers/1234567890/campaigns/777");

  const proof = await readBackCampaign(stubAuth, "t", "1234567890", found);
  assert.equal(proof.campaignId, "777");
  assert.equal(proof.status, "PAUSED");
  assert.equal(proof.verifiedByReadBack, true);
  assert.equal(mutateCalls(calls).length, 0, "recovery creates nothing");
  assert.equal(calls.length, 2, "one search, one read-back");
});

test("Google failing to answer the reconciliation leaves it unresolved", async () => {
  mockFetch([{ status: 503, body: {} }]);
  await assert.rejects(() => findCampaignByReference(stubAuth, "t", "1234567890", "ckrow123456"));
  // resolvePendingExecution turns that rejection into "unresolved", and the
  // route refuses to mutate on it — both asserted above.
});

test("the ambiguous copy tells the judge what will happen next", () => {
  const block = read(BLOCK);
  assert.match(block, /unconfirmed_outcome/, "the page recognises the ambiguous outcome");
  assert.match(block, /ask Google whether that\s*\n?\s*attempt created a campaign/);
  assert.ok(
    !/no campaign was created/i.test(block),
    "the page never asserts nothing was created when it cannot know"
  );
});
