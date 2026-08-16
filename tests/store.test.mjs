// Mocked tests for the Google Play import provider. No network, no credentials
// and no paid DataForSEO calls: global fetch is stubbed. Run with `npm test`
// (the store modules are compiled to .tmp-test first — see package.json).
import test from "node:test";
import assert from "node:assert/strict";

process.env.DATAFORSEO_LOGIN ??= "test-login";
process.env.DATAFORSEO_PASSWORD ??= "test-password";
process.env.AUTH_SECRET ??= "test-secret-for-ticket-signing";

const { GooglePlayMetadataProvider } = await import("../.tmp-test/store/googleplay.js");
const { resolveStoreProvider, providerByName } = await import("../.tmp-test/store/index.js");
const { issueTicket, readTicket } = await import("../.tmp-test/store/ticket.js");
const { StoreProviderError } = await import("../.tmp-test/store/types.js");

const provider = new GooglePlayMetadataProvider();
const PLAY = "https://play.google.com/store/apps/details?id=com.example.app";

/** Replace global fetch with a scripted queue of responses. */
function mockFetch(responses) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), method: init?.method ?? "GET" });
    const next = responses.shift();
    if (!next) throw new Error("unexpected extra fetch call");
    if (typeof next === "function") return next();
    return {
      ok: next.status === undefined || (next.status >= 200 && next.status < 300),
      status: next.status ?? 200,
      json: async () => {
        if (next.invalidJson) throw new SyntaxError("Unexpected token");
        return next.body;
      },
    };
  };
  return calls;
}

const taskPosted = (id = "07141248-1535-0066-0000-c9e0a4d0dd8a") => ({
  body: { status_code: 20000, tasks: [{ id, status_code: 20100 }] },
});

const taskResult = (item) => ({
  body: { status_code: 20000, tasks: [{ status_code: 20000, result: [{ items: [item] }] }] },
});

const FULL_ITEM = {
  title: "Example App",
  description: "Tracks your workouts and plans your week.",
  main_category: "Health & Fitness",
  developer: "Example Labs",
  rating: { value: 4.6, votes_count: 12345, rating_max: 5 },
  installs: "1,000,000+",
  version: "3.2.1",
  icon: "https://play-lh.googleusercontent.com/icon.png",
  images: ["https://play-lh.googleusercontent.com/s1.png", "https://x/s2.png"],
};

// ---------------------------------------------------------------- URL / SSRF

test("accepts a valid Google Play URL", () => {
  assert.equal(resolveStoreProvider(PLAY).provider.provider, "google-play");
});

test("accepts extra query params and extracts the package id", () => {
  const { url } = resolveStoreProvider(`${PLAY}&hl=en&gl=US`);
  assert.equal(provider.extractAppId(url), "com.example.app");
});

for (const [label, bad] of [
  ["localhost", "http://localhost/store/apps/details?id=com.example.app"],
  ["127.0.0.1", "http://127.0.0.1/store/apps/details?id=com.example.app"],
  ["IPv6 localhost", "http://[::1]/store/apps/details?id=com.example.app"],
  ["arbitrary domain", "https://example.com/store/apps/details?id=com.example.app"],
  ["look-alike host", "https://play.google.com.evil.example/store/apps/details?id=com.example.app"],
  ["credentials in URL", "https://user:pass@play.google.com/store/apps/details?id=com.example.app"],
  ["file scheme", "file:///etc/passwd"],
  ["non-https play URL", "http://play.google.com/store/apps/details?id=com.example.app"],
  ["unexpected path", "https://play.google.com/store/search?id=com.example.app"],
  ["malformed package id", "https://play.google.com/store/apps/details?id=not-a-package"],
  ["missing package id", "https://play.google.com/store/apps/details"],
  ["not a URL at all", "just some text"],
]) {
  test(`rejects ${label}`, () => {
    assert.throws(() => resolveStoreProvider(bad), (e) => e instanceof StoreProviderError);
  });
}

test("rejects an over-long URL", () => {
  assert.throws(() => resolveStoreProvider(`${PLAY}&x=${"a".repeat(3000)}`), StoreProviderError);
});

// ------------------------------------------------------------------- submit

test("submit posts exactly one paid task, to the fixed DataForSEO host", async () => {
  const calls = mockFetch([taskPosted()]);
  const task = await provider.submitLookup(new URL(PLAY));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "POST");
  assert.ok(calls[0].url.startsWith("https://api.dataforseo.com/v3/app_data/google/app_info/"));
  assert.equal(task.appId, "com.example.app");
  assert.equal(task.taskId, "07141248-1535-0066-0000-c9e0a4d0dd8a");
});

test("submit surfaces auth failure without leaking credentials", async () => {
  mockFetch([{ status: 401, body: {} }]);
  await assert.rejects(provider.submitLookup(new URL(PLAY)), (e) => {
    assert.equal(e.code, "auth_failed");
    assert.ok(!/login|password|basic/i.test(e.message));
    return true;
  });
});

test("submit reports insufficient funds as not_configured", async () => {
  mockFetch([{ body: { status_code: 40200, tasks: [] } }]);
  await assert.rejects(provider.submitLookup(new URL(PLAY)), (e) => e.code === "not_configured");
});

test("submit fails cleanly on malformed JSON", async () => {
  mockFetch([{ invalidJson: true, body: null }]);
  await assert.rejects(provider.submitLookup(new URL(PLAY)), (e) => e.code === "provider_error");
});

test("submit fails cleanly when the network throws", async () => {
  mockFetch([() => { throw new Error("ECONNRESET"); }]);
  await assert.rejects(provider.submitLookup(new URL(PLAY)), (e) => {
    assert.equal(e.code, "timeout");
    assert.ok(!/ECONNRESET/.test(e.message));
    return true;
  });
});

test("submit refuses to run when credentials are absent", async () => {
  const login = process.env.DATAFORSEO_LOGIN;
  delete process.env.DATAFORSEO_LOGIN;
  mockFetch([]);
  await assert.rejects(provider.submitLookup(new URL(PLAY)), (e) => e.code === "not_configured");
  process.env.DATAFORSEO_LOGIN = login;
});

// --------------------------------------------------------------------- poll

const TASK = { appId: "com.example.app", taskId: "07141248-1535-0066-0000-c9e0a4d0dd8a" };

for (const [label, code] of [
  ["task handed (40601)", 40601],
  ["task in queue (40602)", 40602],
  ["task created (20100)", 20100],
  ["task not found yet (40400)", 40400],
]) {
  test(`poll reports ${label} as pending, not a failure`, async () => {
    mockFetch([{ body: { status_code: 20000, tasks: [{ status_code: code }] } }]);
    assert.deepEqual(await provider.pollLookup(TASK), { status: "pending" });
  });
}

test("poll treats a transient HTTP error as pending", async () => {
  mockFetch([{ status: 502, body: {} }]);
  assert.deepEqual(await provider.pollLookup(TASK), { status: "pending" });
});

test("poll treats an empty result as pending", async () => {
  mockFetch([{ body: { status_code: 20000, tasks: [{ status_code: 20000, result: null }] } }]);
  assert.deepEqual(await provider.pollLookup(TASK), { status: "pending" });
});

test("poll raises a permanent task failure", async () => {
  mockFetch([{ body: { status_code: 20000, tasks: [{ status_code: 40501 }] } }]);
  await assert.rejects(provider.pollLookup(TASK), (e) => e.code === "provider_error");
});

test("poll normalizes a complete DataForSEO item", async () => {
  mockFetch([taskResult(FULL_ITEM)]);
  const result = await provider.pollLookup(TASK);
  assert.equal(result.status, "ready");
  const m = result.metadata;
  assert.equal(m.provider, "google-play");
  assert.equal(m.appId, "com.example.app");
  assert.equal(m.name, "Example App");
  assert.equal(m.description, FULL_ITEM.description);
  assert.equal(m.category, "Health & Fitness");
  assert.equal(m.developer, "Example Labs");
  assert.equal(m.rating, 4.6);
  assert.equal(m.reviewsCount, 12345);
  assert.equal(m.installs, "1,000,000+");
  assert.equal(m.version, "3.2.1");
  assert.equal(m.iconUrl, FULL_ITEM.icon);
  assert.deepEqual(m.screenshots, FULL_ITEM.images);
  assert.ok(!Number.isNaN(Date.parse(m.retrievedAt)));
});

test("poll returns a canonical store URL, not the raw user input", async () => {
  mockFetch([taskResult(FULL_ITEM)]);
  const { metadata } = await provider.pollLookup(TASK);
  assert.equal(metadata.storeUrl, PLAY);
});

test("poll falls back to genres and installs_count", async () => {
  mockFetch([taskResult({ title: "A", genres: ["Puzzle"], installs_count: 5000 })]);
  const { metadata } = await provider.pollLookup(TASK);
  assert.equal(metadata.category, "Puzzle");
  assert.equal(metadata.installs, "5000");
});

test("poll leaves missing optional values undefined", async () => {
  mockFetch([taskResult({ title: "Minimal App" })]);
  const { metadata } = await provider.pollLookup(TASK);
  assert.equal(metadata.name, "Minimal App");
  for (const k of ["description", "category", "developer", "rating", "reviewsCount", "installs"]) {
    assert.equal(metadata[k], undefined, `${k} should be undefined`);
  }
});

// Regression: the field shape below is the one a real DataForSEO app_info
// response used (verified live against com.spotify.music). Note `version` and
// `videos` arrive as null, screenshots live under `images`, and there is no
// `screenshots` key at all.
const LIVE_SHAPE_ITEM = {
  type: "app_info",
  rank_group: 1,
  rank_absolute: 1,
  position: "left",
  app_id: "com.example.app",
  title: "Live Shape App",
  url: "https://play.google.com/store/apps/details?id=com.example.app&hl=en&gl=US",
  icon: "https://play-lh.googleusercontent.com/icon.png",
  description: "Play millions of songs and podcasts.",
  reviews_count: 36119939,
  rating: { rating_type: "Max5", value: 4.3, votes_count: 36119939, rating_max: 5 },
  price: { current: 0, currency: "USD", is_price_range: false, displayed_price: null },
  is_free: true,
  main_category: "Music & Audio",
  installs: "1,000,000,000+",
  installs_count: 1000000000,
  developer: "Example AB",
  developer_id: "Example+AB",
  version: null,
  minimum_os_version: null,
  size: null,
  released_date: "Oct 7, 2008",
  images: Array.from({ length: 40 }, (_, i) => `https://play-lh.googleusercontent.com/s${i}.png`),
  videos: null,
  genres: ["Music & Audio"],
  tags: ["music", "audio"],
};

test("poll handles the real live response shape", async () => {
  mockFetch([taskResult(LIVE_SHAPE_ITEM)]);
  const { metadata } = await provider.pollLookup(TASK);
  assert.equal(metadata.name, "Live Shape App");
  assert.equal(metadata.category, "Music & Audio");
  assert.equal(metadata.developer, "Example AB");
  assert.equal(metadata.rating, 4.3);
  assert.equal(metadata.reviewsCount, 36119939);
  assert.equal(metadata.installs, "1,000,000,000+");
  assert.equal(metadata.description, LIVE_SHAPE_ITEM.description);
  assert.equal(metadata.iconUrl, LIVE_SHAPE_ITEM.icon);
  // A null version must not become the string "null".
  assert.equal(metadata.version, undefined);
  // Screenshots come from `images`, capped so a 40-image listing stays sane.
  assert.equal(metadata.screenshots.length, 8);
  // The canonical URL is used, not the store's own url field with its params.
  assert.equal(metadata.storeUrl, PLAY);
});

test("poll rejects a response describing a different app", async () => {
  mockFetch([taskResult({ ...LIVE_SHAPE_ITEM, app_id: "com.someone.else" })]);
  await assert.rejects(provider.pollLookup(TASK), (e) => e.code === "incomplete");
});

test("poll rejects a result with no app name as incomplete", async () => {
  mockFetch([taskResult({ description: "no title here" })]);
  await assert.rejects(provider.pollLookup(TASK), (e) => e.code === "incomplete");
});

test("poll caps an enormous description", async () => {
  mockFetch([taskResult({ title: "Big", description: "x".repeat(50_000) })]);
  const { metadata } = await provider.pollLookup(TASK);
  assert.ok(metadata.description.length <= 6_001);
});

test("poll refuses a task id that was not issued by us", async () => {
  mockFetch([]);
  await assert.rejects(
    provider.pollLookup({ appId: "com.example.app", taskId: "../../etc/passwd" }),
    (e) => e.code === "provider_error"
  );
});

// ------------------------------------------------------------------ tickets

test("a ticket round-trips for its owner", () => {
  const t = issueTicket({ provider: "google-play", ...TASK, userId: "user-1" });
  const back = readTicket(t, "user-1");
  assert.equal(back.taskId, TASK.taskId);
  assert.equal(back.appId, TASK.appId);
});

test("a ticket cannot be used by another user", () => {
  const t = issueTicket({ provider: "google-play", ...TASK, userId: "user-1" });
  assert.throws(() => readTicket(t, "user-2"), StoreProviderError);
});

test("a tampered ticket is rejected", () => {
  const t = issueTicket({ provider: "google-play", ...TASK, userId: "user-1" });
  const [payload, sig] = t.split(".");
  const forged = Buffer.from(
    JSON.stringify({ provider: "google-play", ...TASK, userId: "user-2", exp: Date.now() + 1000 })
  ).toString("base64url");
  assert.throws(() => readTicket(`${forged}.${sig}`, "user-2"), StoreProviderError);
  assert.throws(() => readTicket(`${payload}.${"a".repeat(43)}`, "user-1"), StoreProviderError);
  assert.throws(() => readTicket("garbage", "user-1"), StoreProviderError);
});

test("providerByName resolves google-play and rejects anything else", () => {
  assert.equal(providerByName("google-play").provider, "google-play");
  assert.throws(() => providerByName("evil"), StoreProviderError);
});
