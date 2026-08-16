// REAL Google Ads execution engine — the path that creates a campaign.
//
// Everything here is stubbed: no Google call is made, nothing is spent, and no
// campaign is created. What is pinned down are the guarantees that make a live
// run safe — PAUSED only, a budget the model cannot raise, a test-account
// guard, and proof that comes back from Google rather than from us.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

process.env.GOOGLE_ADS_CLIENT_ID ??= "client-id.apps.googleusercontent.com";
process.env.GOOGLE_ADS_CLIENT_SECRET ??= "test-client-secret";
process.env.GOOGLE_ADS_DEVELOPER_TOKEN ??= "test-developer-token";
process.env.GOOGLE_ADS_TOKEN_ENCRYPTION_KEY ??= "an-encryption-key-long-enough-for-derivation";

const {
  executeAppCampaign,
  readBackCampaign,
  assertTestAccount,
  clampDailyBudgetMicros,
  MAX_DAILY_BUDGET_MICROS,
} = await import("../.tmp-test/googleAds/execution.js");

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

/** An auth provider that yields a token without touching Google or the DB. */
const stubAuth = (over = {}) => ({
  mode: "demo_service_account",
  accessToken: async () => "ya29.stub-access-token",
  loginCustomerId: () => "9998887777",
  targetCustomerId: async () => "1234567890",
  ...over,
});

function mockFetch(responses) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({
      url: String(url),
      method: init?.method ?? "GET",
      headers: init?.headers ?? {},
      body: init?.body ? JSON.parse(init.body) : null,
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

const testAccountOk = { body: { results: [{ customer: { id: "1234567890", testAccount: true } }] } };
const budgetCreated = { body: { results: [{ resourceName: "customers/1234567890/campaignBudgets/55" }] } };
const campaignCreated = { body: { results: [{ resourceName: "customers/1234567890/campaigns/777" }] } };
const readBackOk = {
  body: {
    results: [
      {
        campaign: {
          id: "777",
          name: "SafeWalk installs 1",
          status: "PAUSED",
          resourceName: "customers/1234567890/campaigns/777",
          advertisingChannelType: "MULTI_CHANNEL",
          advertisingChannelSubType: "APP_CAMPAIGN",
          campaignBudget: "customers/1234567890/campaignBudgets/55",
          appCampaignSetting: { appId: "com.example.safewalk" },
        },
      },
    ],
  },
};

const REQUEST = {
  campaignName: "SafeWalk installs",
  appId: "com.example.safewalk",
  requestedDailyBudgetMicros: 5_000_000,
};

// ------------------------------------------------------------ budget ceiling

test("the server clamps the budget; a model can never raise it", () => {
  // The whole point: an AI may propose, the server disposes.
  assert.equal(clampDailyBudgetMicros(500_000_000, 5_000_000), 5_000_000, "clamped to the approval");
  assert.equal(
    clampDailyBudgetMicros(5_000_000, 999_999_999_999),
    5_000_000,
    "an absurd allowance is still capped by the hard product maximum"
  );
  assert.ok(clampDailyBudgetMicros(1e12, 1e12) <= MAX_DAILY_BUDGET_MICROS);
});

test("a nonsensical requested budget falls back to the minimum, never to zero", () => {
  for (const bad of [0, -1, NaN, undefined, null]) {
    const v = clampDailyBudgetMicros(bad, MAX_DAILY_BUDGET_MICROS);
    assert.ok(v > 0, `${String(bad)} must not produce a zero budget`);
    assert.ok(v <= MAX_DAILY_BUDGET_MICROS);
  }
});

// -------------------------------------------------------- test-account guard

test("execution refuses an account Google does not call a test account", async () => {
  mockFetch([{ body: { results: [{ customer: { id: "1234567890", testAccount: false } }] } }]);
  await assert.rejects(
    executeAppCampaign(stubAuth(), REQUEST, {
      allowedMaxDailyBudgetMicros: 5_000_000,
      testAccountOnly: true,
    }),
    (e) => /not a Google Ads test account/i.test(e.message)
  );
});

test("nothing is created when the test-account guard fails", async () => {
  const calls = mockFetch([{ body: { results: [{ customer: { testAccount: false } }] } }]);
  await assert.rejects(
    executeAppCampaign(stubAuth(), REQUEST, {
      allowedMaxDailyBudgetMicros: 5_000_000,
      testAccountOnly: true,
    })
  );
  assert.equal(calls.length, 1, "the guard runs before any mutation");
  assert.ok(!calls.some((c) => c.url.includes(":mutate")), "no mutate was attempted");
});

// ---------------------------------------------------------- the happy path

test("a successful run creates a PAUSED App Campaign and verifies it with Google", async () => {
  const calls = mockFetch([testAccountOk, budgetCreated, campaignCreated, readBackOk]);
  const { proof, events } = await executeAppCampaign(stubAuth(), REQUEST, {
    allowedMaxDailyBudgetMicros: 5_000_000,
    testAccountOnly: true,
  });

  // Proof comes from Google's read-back, not from the mutate response.
  assert.equal(proof.campaignId, "777");
  assert.equal(proof.status, "PAUSED");
  assert.equal(proof.advertisingChannelType, "MULTI_CHANNEL");
  assert.equal(proof.advertisingChannelSubType, "APP_CAMPAIGN");
  assert.equal(proof.appId, "com.example.safewalk");
  assert.equal(proof.verifiedByReadBack, true);

  const codes = events.map((e) => e.code);
  for (const expected of [
    "SAFETY_POLICY_VERIFIED",
    "TEST_ACCOUNT_VERIFIED",
    "BUDGET_POLICY_VERIFIED",
    "CAMPAIGN_BUDGET_CREATED",
    "CAMPAIGN_CREATED",
    "GOOGLE_READBACK_VERIFIED",
  ]) {
    assert.ok(codes.includes(expected), `timeline must include ${expected}`);
  }
  assert.equal(calls.length, 4);
});

test("the campaign request matches Google's App Campaign contract", async () => {
  const calls = mockFetch([testAccountOk, budgetCreated, campaignCreated, readBackOk]);
  await executeAppCampaign(stubAuth(), REQUEST, {
    allowedMaxDailyBudgetMicros: 5_000_000,
    testAccountOnly: true,
  });

  const budget = calls[1].body.operations[0].create;
  assert.equal(budget.explicitlyShared, false, "app campaigns cannot use a shared budget");
  assert.equal(budget.deliveryMethod, "STANDARD");

  const campaign = calls[2].body.operations[0].create;
  assert.equal(campaign.status, "PAUSED");
  assert.equal(campaign.advertisingChannelType, "MULTI_CHANNEL");
  assert.equal(campaign.advertisingChannelSubType, "APP_CAMPAIGN");
  assert.equal(campaign.appCampaignSetting.appStore, "GOOGLE_APP_STORE");
  assert.equal(campaign.appCampaignSetting.appId, "com.example.safewalk");
  assert.equal(
    campaign.appCampaignSetting.biddingStrategyGoalType,
    "OPTIMIZE_INSTALLS_TARGET_INSTALL_COST"
  );
  assert.ok(campaign.targetCpa?.targetCpaMicros, "app campaigns require a bidding target");
  // Required by Google since 1 April 2026, or every campaign mutate fails.
  assert.equal(
    campaign.containsEuPoliticalAdvertising,
    "DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING"
  );
});

test("ENABLED is never sent on any path", () => {
  const src = read("lib/googleAds/execution.ts");
  assert.ok(!/"ENABLED"/.test(src), "the engine must not contain an ENABLED status");
  assert.match(src, /status: "PAUSED"/);
});

test("the budget actually sent is the clamped one", async () => {
  const calls = mockFetch([testAccountOk, budgetCreated, campaignCreated, readBackOk]);
  await executeAppCampaign(
    stubAuth(),
    { ...REQUEST, requestedDailyBudgetMicros: 999_000_000 },
    { allowedMaxDailyBudgetMicros: 3_000_000, testAccountOnly: true }
  );
  assert.equal(calls[1].body.operations[0].create.amountMicros, "3000000");
});

// -------------------------------------------------------------- credentials

test("requests carry the developer token and manager header, and leak nothing", async () => {
  const calls = mockFetch([testAccountOk, budgetCreated, campaignCreated, readBackOk]);
  const { proof, events } = await executeAppCampaign(stubAuth(), REQUEST, {
    allowedMaxDailyBudgetMicros: 5_000_000,
    testAccountOnly: true,
  });

  assert.equal(calls[1].headers["developer-token"], "test-developer-token");
  assert.equal(calls[1].headers["login-customer-id"], "9998887777");
  assert.equal(calls[1].headers.Authorization, "Bearer ya29.stub-access-token");

  // Nothing a browser receives may carry credential material.
  const shown = JSON.stringify({ proof, events });
  for (const secret of [
    "ya29.stub-access-token",
    "test-developer-token",
    "test-client-secret",
    "Bearer",
    "Authorization",
  ]) {
    assert.ok(!shown.includes(secret), `${secret} must not reach the client payload`);
  }
});

test("a provider failure is classified, never echoed", async () => {
  mockFetch([
    testAccountOk,
    { status: 403, body: { error: { message: "developer-token test-developer-token invalid" } } },
  ]);
  await assert.rejects(
    executeAppCampaign(stubAuth(), REQUEST, {
      allowedMaxDailyBudgetMicros: 5_000_000,
      testAccountOnly: true,
    }),
    (e) => {
      assert.ok(!e.message.includes("test-developer-token"), "the token must never surface");
      return true;
    }
  );
});

// ---------------------------------------------------------------- read-back

test("read-back returns Google's own values", async () => {
  mockFetch([readBackOk]);
  const proof = await readBackCampaign(
    stubAuth(),
    "ya29.stub",
    "1234567890",
    "customers/1234567890/campaigns/777"
  );
  assert.equal(proof.campaignId, "777");
  assert.equal(proof.status, "PAUSED");
  assert.equal(proof.verifiedByReadBack, true);
  assert.ok(Date.parse(proof.verifiedAt) > 0);
});

test("read-back queries Google rather than trusting local state", async () => {
  const calls = mockFetch([readBackOk]);
  await readBackCampaign(stubAuth(), "t", "1234567890", "customers/1234567890/campaigns/777");
  assert.match(calls[0].url, /googleAds:search$/);
  assert.match(calls[0].body.query, /FROM campaign WHERE campaign\.resource_name/);
  assert.match(calls[0].body.query, /campaign\.status/);
});

test("a campaign Google will not return is a failure, not an assumed success", async () => {
  mockFetch([{ body: { results: [] } }]);
  await assert.rejects(
    readBackCampaign(stubAuth(), "t", "1234567890", "customers/1234567890/campaigns/999"),
    (e) => e.code === "not_found"
  );
});

test("assertTestAccount refuses when Google omits the flag", async () => {
  mockFetch([{ body: { results: [{ customer: { id: "1234567890" } }] } }]);
  await assert.rejects(assertTestAccount(stubAuth(), "t", "1234567890"), (e) => e.code === "forbidden");
});

// ------------------------------------------------------------ demo identity

test("the demo target is server configuration, never a browser input", () => {
  const auth = read("lib/googleAds/auth.ts");
  assert.match(auth, /GOOGLE_ADS_DEMO_CUSTOMER_ID/);
  assert.match(auth, /GOOGLE_ADS_DEMO_MANAGER_CUSTOMER_ID/);
  // No concrete account number may be hardcoded anywhere in the integration.
  // Comments are stripped first: a doc comment showing 1234567890 -> 123-456-7890
  // explains the formatter and is not a configured identity.
  const stripComments = (s) =>
    s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  for (const f of ["lib/googleAds/auth.ts", "lib/googleAds/execution.ts", "lib/googleAds/config.ts"]) {
    assert.doesNotMatch(
      stripComments(read(f)),
      /\b\d{10}\b/,
      `${f} must not hardcode a customer id`
    );
  }
});

test("the service account never returns a durable credential", () => {
  const src = read("lib/googleAds/serviceAccount.ts");
  assert.match(src, /demoServiceAccountToken/);
  assert.ok(!/return sa\.privateKey/.test(src), "the private key is never returned");
  assert.match(src, /GOOGLE_ADS_DEMO_SERVICE_ACCOUNT_PRIVATE_KEY/);
  assert.match(src, /replace\(\/\\\\n\/g, "\\n"\)/, "escaped newlines are normalised");
});
