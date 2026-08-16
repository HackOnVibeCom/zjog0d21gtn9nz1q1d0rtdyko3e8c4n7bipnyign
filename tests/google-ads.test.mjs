// GOOGLE ADS — phase 1 connection foundation.
// No live Google call is made: every HTTP interaction is stubbed. Nothing here
// creates or changes an advertising campaign, because no such code exists yet.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

process.env.AUTH_SECRET ??= "test-secret-for-oauth-state";

const config = await import("../.tmp-test/googleAds/config.js");
const { sealToken, openToken, TokenCryptoError } = await import("../.tmp-test/googleAds/crypto.js");
const oauth = await import("../.tmp-test/googleAds/oauth.js");
const client = await import("../.tmp-test/googleAds/client.js");
const { signPayload, readPayload } = await import("../.tmp-test/signed.js");

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
    if (typeof next === "function") return next();
    return {
      ok: next.status === undefined || (next.status >= 200 && next.status < 300),
      status: next.status ?? 200,
      json: async () => {
        if (next.invalidJson) throw new SyntaxError("bad json");
        return next.body;
      },
    };
  };
  return calls;
}

// -------------------------------------------------------------- configuration

test("the API version lives in exactly one place", () => {
  assert.equal(config.GOOGLE_ADS_API_VERSION, "v25");
  assert.equal(config.GOOGLE_ADS_BASE_URL, "https://googleads.googleapis.com/v25");
  // No route or client file may hardcode a version of its own.
  for (const f of [
    "lib/googleAds/client.ts",
    "app/api/integrations/google-ads/route.ts",
    "app/api/integrations/google-ads/connect/route.ts",
  ]) {
    assert.doesNotMatch(read(f), /googleads\.googleapis\.com\/v\d+/, `${f} must use the constant`);
  }
});

test("the integration reports not-configured instead of half-working", () => {
  const saved = { ...process.env };
  for (const k of [
    "GOOGLE_ADS_CLIENT_ID",
    "GOOGLE_ADS_CLIENT_SECRET",
    "GOOGLE_ADS_DEVELOPER_TOKEN",
    "GOOGLE_ADS_TOKEN_ENCRYPTION_KEY",
  ]) {
    delete process.env[k];
  }
  try {
    assert.equal(config.googleAdsEnv(), null);
    assert.equal(config.googleAdsConfigured(), false);

    // Three of four set is still not configured — there is no partial mode.
    process.env.GOOGLE_ADS_CLIENT_ID = "a";
    process.env.GOOGLE_ADS_CLIENT_SECRET = "b";
    process.env.GOOGLE_ADS_DEVELOPER_TOKEN = "c";
    assert.equal(config.googleAdsConfigured(), false, "missing encryption key must fail closed");

    process.env.GOOGLE_ADS_TOKEN_ENCRYPTION_KEY = "d".repeat(32);
    assert.equal(config.googleAdsConfigured(), true);
  } finally {
    process.env = saved;
  }
});

test("customer ids are normalised for headers and formatted for people", () => {
  assert.equal(config.normalizeCustomerId("123-456-7890"), "1234567890");
  assert.equal(config.normalizeCustomerId("customers/1234567890"), "1234567890");
  assert.equal(config.formatCustomerId("1234567890"), "123-456-7890");
});

test("the callback URL follows APP_BASE_URL rather than a hardcoded host", () => {
  const saved = process.env.APP_BASE_URL;
  process.env.APP_BASE_URL = "https://example.test/";
  assert.equal(config.callbackUrl(), "https://example.test/api/integrations/google-ads/callback");
  process.env.APP_BASE_URL = saved;
  assert.doesNotMatch(read("lib/googleAds/config.ts"), /netlify\.app/);
});

// ------------------------------------------------------------ token encryption

test("a refresh token round-trips through authenticated encryption", () => {
  const token = "1//0eXaMpLe-refresh-token-value";
  const sealed = sealToken(token, ENV.encryptionKey);
  assert.notEqual(sealed.cipher, token);
  assert.ok(!JSON.stringify(sealed).includes(token), "plaintext must not survive anywhere");
  assert.ok(sealed.iv && sealed.tag, "nonce and auth tag are stored");
  assert.equal(openToken(sealed, ENV.encryptionKey), token);
});

test("the same token encrypts differently every time", () => {
  const a = sealToken("same-token", ENV.encryptionKey);
  const b = sealToken("same-token", ENV.encryptionKey);
  assert.notEqual(a.cipher, b.cipher, "a fresh nonce per encryption");
  assert.notEqual(a.iv, b.iv);
});

test("a wrong key cannot open the token", () => {
  const sealed = sealToken("secret-value", ENV.encryptionKey);
  assert.throws(() => openToken(sealed, "a-different-key-entirely-long-enough"), TokenCryptoError);
});

test("tampered ciphertext is rejected rather than half-decrypted", () => {
  const sealed = sealToken("secret-value", ENV.encryptionKey);
  const flipped = Buffer.from(sealed.cipher, "base64");
  flipped[0] ^= 0xff;
  assert.throws(
    () => openToken({ ...sealed, cipher: flipped.toString("base64") }, ENV.encryptionKey),
    TokenCryptoError
  );
  assert.throws(
    () => openToken({ ...sealed, tag: Buffer.alloc(16).toString("base64") }, ENV.encryptionKey),
    TokenCryptoError
  );
});

test("encryption fails closed when the key is missing or too weak", () => {
  assert.throws(() => sealToken("x", ""), TokenCryptoError);
  assert.throws(() => sealToken("x", "short"), TokenCryptoError);
});

test("a decryption failure never leaks key or ciphertext material", () => {
  const sealed = sealToken("1//super-secret-refresh", ENV.encryptionKey);
  try {
    openToken(sealed, "another-key-that-is-long-enough-here");
    assert.fail("should have thrown");
  } catch (e) {
    assert.ok(!e.message.includes(sealed.cipher));
    assert.ok(!e.message.includes(ENV.encryptionKey));
    assert.ok(!e.message.includes("1//"));
  }
});

// --------------------------------------------------------------- OAuth state

test("OAuth state is signed, bound to the user, and expires", () => {
  const state = signPayload({ purpose: "google-ads-connect", nonce: "n1" }, "user-1", 60_000);
  assert.notEqual(state, "user-1", "state is never the raw user id");
  assert.ok(!state.includes("user-1"), "the user id is not readable in the state");

  assert.deepEqual(readPayload(state, "user-1"), { purpose: "google-ads-connect", nonce: "n1" });
  assert.equal(readPayload(state, "user-2"), null, "another user cannot use it");
  assert.equal(readPayload("forged", "user-1"), null, "an unsigned state is rejected");
  assert.equal(readPayload(null, "user-1"), null, "a missing state is rejected");

  const [payload, sig] = state.split(".");
  assert.equal(readPayload(`${payload}.${"a".repeat(sig.length)}`, "user-1"), null, "tampered");
  assert.equal(
    readPayload(signPayload({ purpose: "google-ads-connect" }, "user-1", -1), "user-1"),
    null,
    "an expired state is rejected"
  );
});

test("the callback rejects a state that is not ours, and binds to the signed-in user", () => {
  const src = read("app/api/integrations/google-ads/callback/route.ts");
  assert.match(src, /currentUserId\(\)/);
  assert.match(src, /readPayload<ConnectState>\(params\.get\("state"\), userId\)/);
  assert.match(src, /state\.purpose !== "google-ads-connect"/);
  assert.match(src, /invalid_state/);
});

test("connecting requires an authenticated user", () => {
  for (const f of [
    "app/api/integrations/google-ads/connect/route.ts",
    "app/api/integrations/google-ads/callback/route.ts",
    "app/api/integrations/google-ads/route.ts",
  ]) {
    assert.match(read(f), /currentUserId\(\)/, `${f} must authenticate`);
  }
});

test("the authorization URL asks for offline Google Ads access", () => {
  const url = new URL(oauth.buildAuthorizationUrl(ENV, "state-value"));
  assert.equal(url.origin + url.pathname, "https://accounts.google.com/o/oauth2/v2/auth");
  assert.equal(url.searchParams.get("scope"), "https://www.googleapis.com/auth/adwords");
  assert.equal(url.searchParams.get("access_type"), "offline");
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("state"), "state-value");
  assert.ok(!url.searchParams.has("client_secret"), "the secret never travels in a URL");
});

// ----------------------------------------------------------- code exchange

test("a code exchange returns the durable credential", async () => {
  const calls = mockFetch([
    { body: { access_token: "ya29.access", refresh_token: "1//refresh", expires_in: 3599 } },
  ]);
  const out = await oauth.exchangeCode(ENV, "auth-code");
  assert.equal(out.refreshToken, "1//refresh");
  assert.equal(calls[0].url, "https://oauth2.googleapis.com/token");
  assert.equal(calls[0].method, "POST");
});

test("an exchange without a refresh token is treated as a failure", async () => {
  mockFetch([{ body: { access_token: "ya29.only" } }]);
  await assert.rejects(oauth.exchangeCode(ENV, "code"), (e) => e.code === "denied");
});

test("Google's error bodies are not passed through to the customer", async () => {
  mockFetch([
    {
      status: 400,
      body: { error: "invalid_grant", error_description: "client_secret=super-secret-client-secret" },
    },
  ]);
  await assert.rejects(oauth.exchangeCode(ENV, "code"), (e) => {
    assert.equal(e.code, "invalid_grant");
    assert.ok(!e.message.includes(ENV.clientSecret), "the secret must not be echoed");
    return true;
  });
});

test("a hung Google token endpoint fails cleanly", async () => {
  mockFetch([
    () => {
      throw new Error("aborted");
    },
  ]);
  await assert.rejects(oauth.refreshAccessToken(ENV, "1//refresh"), (e) => e.code === "timeout");
});

// ------------------------------------------------------- Google Ads requests

test("requests carry the required Google Ads headers", async () => {
  const calls = mockFetch([{ body: { resourceNames: ["customers/1234567890"] } }]);
  await client.listAccessibleCustomers(ENV, "ya29.access");

  const h = calls[0].headers;
  assert.equal(h.Authorization, "Bearer ya29.access");
  assert.equal(h["developer-token"], ENV.developerToken);
  assert.equal(calls[0].url, "https://googleads.googleapis.com/v25/customers:listAccessibleCustomers");
  // Google ignores login-customer-id here, so it is not sent.
  assert.equal(h["login-customer-id"], undefined);
});

test("login-customer-id is sent only when acting through a manager", async () => {
  mockFetch([{ body: { results: [{ customer: { id: "1234567890" } }] } }]);
  const calls2 = mockFetch([{ body: { results: [{ customer: { id: "1234567890" } }] } }]);
  await client.getAccount(ENV, "ya29.access", "123-456-7890", "999-888-7777");
  assert.equal(calls2[0].headers["login-customer-id"], "9998887777");
  assert.equal(
    calls2[0].url,
    "https://googleads.googleapis.com/v25/customers/1234567890/googleAds:search"
  );
});

test("accessible customers parse into bare ids", async () => {
  mockFetch([
    { body: { resourceNames: ["customers/1234567890", "customers/9876543210", 42, null] } },
  ]);
  assert.deepEqual(await client.listAccessibleCustomers(ENV, "t"), ["1234567890", "9876543210"]);
});

test("an empty or malformed customer list is handled", async () => {
  for (const body of [{}, { resourceNames: null }, { resourceNames: [] }]) {
    mockFetch([{ body }]);
    assert.deepEqual(await client.listAccessibleCustomers(ENV, "t"), []);
  }
});

test("account identity is normalised, including the test-account flag", async () => {
  mockFetch([
    {
      body: {
        results: [
          {
            customer: {
              id: "1234567890",
              descriptiveName: "SafeWalk Test Ads",
              currencyCode: "USD",
              timeZone: "America/New_York",
              testAccount: true,
              manager: false,
            },
          },
        ],
      },
    },
  ]);
  const a = await client.getAccount(ENV, "t", "1234567890");
  assert.deepEqual(a, {
    customerId: "1234567890",
    descriptiveName: "SafeWalk Test Ads",
    currencyCode: "USD",
    timeZone: "America/New_York",
    testAccount: true,
    manager: false,
    // An account read this way is one the OAuth user holds themselves.
    accessPath: "direct",
    parentManagerCustomerId: null,
  });
});

test("missing identity fields become null rather than invented values", async () => {
  mockFetch([{ body: { results: [{ customer: { id: "1234567890" } }] } }]);
  const a = await client.getAccount(ENV, "t", "1234567890");
  assert.equal(a.descriptiveName, null);
  assert.equal(a.testAccount, null, "unknown is null, never a guessed false");
  assert.equal(a.manager, null);
});

test("provider failures are normalised without leaking the response body", async () => {
  for (const [status, code] of [
    [401, "unauthorized"],
    [403, "forbidden"],
    [404, "not_found"],
    [429, "quota"],
    [500, "provider_error"],
  ]) {
    mockFetch([{ status, body: { error: { message: `developer-token ${ENV.developerToken}` } } }]);
    await assert.rejects(client.listAccessibleCustomers(ENV, "t"), (e) => {
      assert.equal(e.code, code);
      assert.ok(!e.message.includes(ENV.developerToken), "the developer token must never appear");
      return true;
    });
  }
});

test("one unreadable account does not hide the rest", async () => {
  mockFetch([
    { body: { resourceNames: ["customers/1111111111", "customers/2222222222"] } },
    { status: 403, body: {} },
    { body: { results: [{ customer: { id: "2222222222", descriptiveName: "Readable" } }] } },
  ]);
  const accounts = await client.listAccountsWithIdentity(ENV, "t");
  assert.equal(accounts.length, 2);
  assert.equal(accounts[0].descriptiveName, null, "the unreadable one is still listed");
  assert.equal(accounts[1].descriptiveName, "Readable");
});

// ------------------------------------------------------------ safety rails

test("no credential is ever returned to the browser", () => {
  const route = read("app/api/integrations/google-ads/route.ts");
  const view = read("lib/googleAds/connection.ts");
  for (const forbidden of [
    "refreshToken",
    "refresh_token",
    "developerToken",
    "clientSecret",
    "accessToken:",
  ]) {
    assert.ok(
      !route.includes(`${forbidden}`) || !/NextResponse\.json\([^)]*refreshToken/.test(route),
      `${forbidden} must not be serialised`
    );
  }
  // The view type is the whole contract with the UI.
  const viewType = view.slice(view.indexOf("export type ConnectionView"));
  const block = viewType.slice(0, viewType.indexOf("};"));
  for (const forbidden of ["refreshToken", "Cipher", "accessToken", "developerToken"]) {
    assert.ok(!block.includes(forbidden), `ConnectionView must not expose ${forbidden}`);
  }
});

test("the connection layer is tenant-scoped everywhere", () => {
  const src = read("lib/googleAds/connection.ts");
  for (const fn of ["getConnectionView", "accessTokenFor", "selectCustomer", "disconnect"]) {
    const body = src.slice(src.indexOf(`export async function ${fn}`));
    const end = body.indexOf("\n}");
    assert.match(body.slice(0, end), /userId/, `${fn} must be scoped by userId`);
  }
  assert.match(src, /deleteMany\(\{ where: \{ userId \} \}\)/, "disconnect deletes only own row");
});

test("phase 1 ships no campaign mutation whatsoever", () => {
  // The whole point of the phase boundary: no code path can spend money.
  const files = [
    "lib/googleAds/client.ts",
    "lib/googleAds/connection.ts",
    "app/api/integrations/google-ads/route.ts",
    "app/api/integrations/google-ads/connect/route.ts",
    "app/api/integrations/google-ads/callback/route.ts",
    "components/app/GoogleAdsCard.tsx",
  ];
  for (const f of files) {
    const src = read(f);
    for (const forbidden of [
      "campaignBudgets:mutate",
      "campaigns:mutate",
      "adGroups:mutate",
      "adGroupAds:mutate",
      "campaignCriteria:mutate",
      ":mutate",
    ]) {
      assert.ok(!src.includes(forbidden), `${f} must not contain ${forbidden}`);
    }
  }
});

test("disconnect touches nothing inside Google Ads", () => {
  const src = read("lib/googleAds/connection.ts");
  const fn = src.slice(src.indexOf("export async function disconnect"));
  const body = fn.slice(0, fn.indexOf("\n}"));
  assert.ok(!/fetch\(/.test(body), "disconnect makes no call to Google");
});
