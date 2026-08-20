// Mocked tests for WEB audience discovery. No network, no credentials and no
// paid DataForSEO searches: global fetch is stubbed throughout.
import test from "node:test";
import assert from "node:assert/strict";

process.env.AUTH_SECRET ??= "test-secret-for-search-tickets";
process.env.DATAFORSEO_LOGIN ??= "test-login";
process.env.DATAFORSEO_PASSWORD ??= "test-password";
// webflow pulls in the Prisma client at import time. Only its pure mapping
// helpers are exercised here — no query is ever issued against this dummy URL.
process.env.DATABASE_URL ??= "postgresql://test:test@127.0.0.1:5432/test";
process.env.DIRECT_URL ??= process.env.DATABASE_URL;

const web = await import("../.tmp-test/discovery/web.js");
const { normalizeQueries, MAX_QUERIES, QUERY_ANGLES, discoveryQueryPrompt } = await import(
  "../.tmp-test/discovery/queries.js"
);
const {
  computeAudienceFit,
  gradeOpportunity,
  MIN_AUDIENCE_MATCH,
  MIN_PROBLEM_MATCH,
} = await import("../.tmp-test/discovery/quality.js");
const { normalizeScoreRows, stripUnsupportedClaims, containsUnsupportedClaim } = await import(
  "../.tmp-test/discovery/webscore.js"
);
const {
  toClientCandidate,
  WEB_PLATFORM,
  storedActionability,
  storedOpportunityQuality,
} = await import("../.tmp-test/discovery/webflow.js");
const { enforceActionability, urlPageTypeHint } =
  await import("../.tmp-test/discovery/actionability.js");
const { demoCommunities } = await import("../.tmp-test/discovery/demo.js");
const { groupCandidates, isStrongOpportunity, isResearchOnly } = await import(
  "../.tmp-test/discovery/presentation.js"
);
const { signPayload, readPayload } = await import("../.tmp-test/signed.js");

const {
  WebCommunityDiscoveryProvider,
  SearchProviderError,
  normalizeSerpResponse,
  sanitizeResults,
  dedupeAndDiversify,
  isUsefulResult,
  safeUrl,
  toRawCommunity,
} = web;

const provider = new WebCommunityDiscoveryProvider();

function mockFetch(responses) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : null });
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

const serp = (items) => ({
  body: { status_code: 20000, tasks: [{ status_code: 20000, result: [{ items }] }] },
});

const TASK_ID = "07141248-1535-0066-0000-c9e0a4d0dd8a";
const posted = (n = 1) => ({
  body: {
    status_code: 20000,
    tasks: Array.from({ length: n }, (_, i) => ({
      id: `${TASK_ID.slice(0, -1)}${i}`,
      status_code: 20100,
    })),
  },
});
const task = (query = "q") => ({ query, taskId: TASK_ID });

const organic = (over = {}) => ({
  type: "organic",
  rank_group: 1,
  rank_absolute: 1,
  domain: "forum.example.org",
  title: "Personal safety discussion for students",
  description: "Students share advice about walking home alone at night.",
  url: "https://forum.example.org/threads/personal-safety-123",
  breadcrumb: "forum.example.org › threads",
  ...over,
});

// ------------------------------------------------------------ query planning

test("query generation is trimmed, de-duplicated and hard-capped", () => {
  const q = normalizeQueries({
    queries: [
      "  personal   safety forum  ",
      "personal safety forum", // duplicate after normalization
      "PERSONAL SAFETY FORUM", // duplicate, different case
      "student safety community",
      "walking home alone advice",
      "campus safety discussion",
      "night safety q and a",
      "emergency contact app forum",
      "extra query that must be cut",
      "another extra query",
    ],
  });
  assert.ok(q.length <= MAX_QUERIES);
  assert.equal(q[0], "personal safety forum");
  assert.equal(new Set(q.map((x) => x.toLowerCase())).size, q.length);
});

test("query generation rejects non-strings, empties and over-long input", () => {
  const q = normalizeQueries({ queries: [null, 42, {}, "", "ab", "x".repeat(500), "valid query"] });
  assert.deepEqual(q.filter((x) => x === "valid query").length, 1);
  assert.ok(q.every((x) => typeof x === "string" && x.length >= 3 && x.length <= 120));
});

test("query generation survives a malformed model response", () => {
  for (const bad of [null, undefined, "text", 7, [], { queries: "not an array" }]) {
    assert.deepEqual(normalizeQueries(bad), []);
  }
});

// -------------------------------------------------------- SERP normalization

test("normalizes real organic SERP fields", () => {
  const [r] = normalizeSerpResponse(serp([organic()]).body, "student safety forum");
  assert.equal(r.title, "Personal safety discussion for students");
  assert.equal(r.url, "https://forum.example.org/threads/personal-safety-123");
  assert.equal(r.domain, "forum.example.org");
  assert.equal(r.snippet, "Students share advice about walking home alone at night.");
  assert.equal(r.position, 1);
  assert.equal(r.sourceQuery, "student safety forum");
});

test("ignores non-organic SERP item types", () => {
  const items = [
    { type: "people_also_ask", title: "PAA", url: "https://x.example/a" },
    { type: "video", title: "Video", url: "https://x.example/b" },
    organic(),
  ];
  const out = normalizeSerpResponse(serp(items).body, "q");
  assert.equal(out.length, 1);
  assert.equal(out[0].domain, "forum.example.org");
});

test("tolerates missing optional fields", () => {
  const out = normalizeSerpResponse(
    serp([{ type: "organic", title: "No snippet", url: "https://forum.example.org/t/9" }]).body,
    "q"
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].snippet, undefined);
  assert.equal(out[0].domain, "forum.example.org"); // derived from the URL
  assert.ok(out[0].position >= 1);
});

test("drops items with no usable URL or title", () => {
  const items = [
    { type: "organic", title: "No url" },
    { type: "organic", url: "https://forum.example.org/t/1" },
    { type: "organic", title: "Bad scheme", url: "javascript:alert(1)" },
    { type: "organic", title: "Not a url", url: "definitely not a url" },
  ];
  assert.deepEqual(normalizeSerpResponse(serp(items).body, "q"), []);
});

test("returns nothing for an empty or malformed response body", () => {
  for (const bad of [null, {}, { tasks: [] }, { tasks: [{ result: null }] }, "text"]) {
    assert.deepEqual(normalizeSerpResponse(bad, "q"), []);
  }
});

// -------------------------------------------------------------- URL handling

test("only http(s) URLs are accepted", () => {
  assert.ok(safeUrl("https://forum.example.org/t/1"));
  assert.ok(safeUrl("http://forum.example.org/t/1"));
  for (const bad of [
    "javascript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "file:///etc/passwd",
    "ftp://example.org/x",
    "",
    null,
    123,
  ]) {
    assert.equal(safeUrl(bad), null, `${String(bad)} must be rejected`);
  }
});

// ----------------------------------------------------------------- filtering

for (const [label, item] of [
  ["Google Play listings", organic({ domain: "play.google.com", url: "https://play.google.com/store/apps/details?id=a.b" })],
  ["App Store listings", organic({ domain: "apps.apple.com", url: "https://apps.apple.com/app/id1" })],
  ["ecommerce", organic({ domain: "amazon.com", url: "https://amazon.com/dp/B01" })],
  ["product pages", organic({ domain: "shop.example.org", url: "https://shop.example.org/product/thing" })],
  ["login pages", organic({ domain: "site.example.org", url: "https://site.example.org/login" })],
  ["checkout pages", organic({ domain: "site.example.org", url: "https://site.example.org/checkout" })],
  ["ad networks", organic({ domain: "googleadservices.com", url: "https://googleadservices.com/x" })],
  ["YouTube (its own provider comes later)", organic({ domain: "youtube.com", url: "https://youtube.com/watch?v=1" })],
]) {
  test(`filters out ${label}`, () => {
    assert.deepEqual(normalizeSerpResponse(serp([item]).body, "q").filter(isUsefulResult), []);
  });
}

test("keeps genuine discussion pages, including Reddit threads found via search", () => {
  const items = [
    organic(),
    organic({
      domain: "www.reddit.com",
      url: "https://www.reddit.com/r/college/comments/abc/walking_home/",
      title: "Walking home late — how do you stay safe?",
    }),
  ];
  const kept = normalizeSerpResponse(serp(items).body, "q").filter(isUsefulResult);
  assert.equal(kept.length, 2);
});

test("removes duplicate URLs and keeps domain diversity", () => {
  const results = [
    { title: "A", url: "https://forum.example.org/t/1", domain: "forum.example.org", position: 1, sourceQuery: "a" },
    { title: "A again", url: "https://forum.example.org/t/1/", domain: "forum.example.org", position: 4, sourceQuery: "b" },
    { title: "B", url: "https://forum.example.org/t/2", domain: "forum.example.org", position: 2, sourceQuery: "a" },
    { title: "C", url: "https://forum.example.org/t/3", domain: "forum.example.org", position: 3, sourceQuery: "a" },
    { title: "D", url: "https://other.example.net/discussion/9", domain: "other.example.net", position: 5, sourceQuery: "a" },
  ];
  const out = dedupeAndDiversify(results);
  assert.equal(out.filter((r) => r.url.includes("/t/1")).length, 1, "duplicate URL removed");
  assert.ok(out.filter((r) => r.domain === "forum.example.org").length <= 2, "domain capped");
  assert.ok(out.some((r) => r.domain === "other.example.net"), "other domains kept");
});

// ------------------------------------------------- client payload sanitizing

test("results returned through the browser are re-validated", () => {
  const clean = sanitizeResults([
    { title: "Good", url: "https://forum.example.org/t/1", domain: "forum.example.org", position: 2, sourceQuery: "q" },
    { title: "XSS", url: "javascript:alert(1)", domain: "evil", position: 1, sourceQuery: "q" },
    { title: "Store", url: "https://play.google.com/store/apps/details?id=a.b", domain: "play.google.com", position: 1, sourceQuery: "q" },
    { title: "No query", url: "https://forum.example.org/t/2", domain: "forum.example.org", position: 1 },
    "not an object",
    null,
  ]);
  assert.equal(clean.length, 1);
  assert.equal(clean[0].url, "https://forum.example.org/t/1");
});

test("sanitizing caps totals and field lengths", () => {
  const many = Array.from({ length: 200 }, (_, i) => ({
    title: "T".repeat(5000),
    url: `https://d${i}.example.org/thread/${i}`,
    domain: `d${i}.example.org`,
    position: i + 1,
    sourceQuery: "q".repeat(5000),
    snippet: "s".repeat(5000),
  }));
  const clean = sanitizeResults(many, 24);
  assert.ok(clean.length <= 24);
  assert.ok(clean.every((r) => r.title.length <= 200));
  assert.ok(clean.every((r) => r.sourceQuery.length <= 200));
  assert.ok(clean.every((r) => (r.snippet ?? "").length <= 500));
});

// ------------------------------------------------------------ provider calls

test("all queries are submitted in ONE paid call to the fixed DataForSEO host", async () => {
  const calls = mockFetch([posted(3)]);
  const tasks = await provider.submitSearches(["safety forum", "student advice", "night walking"]);
  assert.equal(calls.length, 1, "one paid submission per user action");
  assert.equal(calls[0].url, "https://api.dataforseo.com/v3/serp/google/organic/task_post");
  assert.equal(calls[0].body.length, 3);
  assert.equal(calls[0].body[0].keyword, "safety forum");
  assert.equal(calls[0].body[0].depth, 10);
  assert.equal(tasks.length, 3);
  assert.equal(tasks[0].query, "safety forum");
});

test("submission caps the number of paid searches", async () => {
  const calls = mockFetch([posted(20)]);
  await provider.submitSearches(Array.from({ length: 50 }, (_, i) => `query number ${i}`));
  assert.ok(calls[0].body.length <= web.MAX_SEARCH_TASKS);
});

test("submission drops empty queries and costs nothing when all are empty", async () => {
  const calls = mockFetch([]);
  assert.deepEqual(await provider.submitSearches(["  ", "", "a", null, 5]), []);
  assert.equal(calls.length, 0);
});

test("submission reports auth failure without leaking credentials", async () => {
  mockFetch([{ status: 401, body: {} }]);
  await assert.rejects(provider.submitSearches(["safety forum"]), (e) => {
    assert.ok(e instanceof SearchProviderError);
    assert.equal(e.code, "auth_failed");
    assert.ok(!/login|password|basic|authorization/i.test(e.message));
    return true;
  });
});

test("submission maps insufficient funds to not_configured", async () => {
  mockFetch([{ body: { status_code: 40200, tasks: [] } }]);
  await assert.rejects(provider.submitSearches(["safety forum"]), (e) => e.code === "not_configured");
});

test("submission fails cleanly on malformed provider JSON", async () => {
  mockFetch([{ invalidJson: true }]);
  await assert.rejects(provider.submitSearches(["safety forum"]), (e) => e.code === "provider_error");
});

test("submission fails cleanly on timeout without leaking the cause", async () => {
  mockFetch([
    () => {
      const err = new Error("The operation was aborted due to timeout");
      err.name = "TimeoutError";
      throw err;
    },
  ]);
  await assert.rejects(provider.submitSearches(["safety forum"]), (e) => {
    assert.equal(e.code, "timeout");
    assert.ok(!/aborted/i.test(e.message));
    return true;
  });
});

test("submission refuses to run without credentials", async () => {
  const login = process.env.DATAFORSEO_LOGIN;
  delete process.env.DATAFORSEO_LOGIN;
  mockFetch([]);
  try {
    await assert.rejects(provider.submitSearches(["safety forum"]), (e) => e.code === "not_configured");
  } finally {
    process.env.DATAFORSEO_LOGIN = login; // never leak the change into later tests
  }
});

for (const [label, code] of [
  ["task created (20100)", 20100],
  ["task handed (40601)", 40601],
  ["task in queue (40602)", 40602],
  ["not registered yet (40400)", 40400],
]) {
  test(`polling reports ${label} as pending, not a failure`, async () => {
    mockFetch([{ body: { status_code: 20000, tasks: [{ status_code: code }] } }]);
    assert.deepEqual(await provider.pollSearch(task()), { status: "pending" });
  });
}

test("polling treats a transient HTTP error as pending", async () => {
  mockFetch([{ status: 502, body: {} }]);
  assert.deepEqual(await provider.pollSearch(task()), { status: "pending" });
});

test("polling returns normalized results once the task completes", async () => {
  mockFetch([serp([organic()])]);
  const out = await provider.pollSearch(task("student safety forum"));
  assert.equal(out.status, "ready");
  assert.equal(out.results.length, 1);
  assert.equal(out.results[0].sourceQuery, "student safety forum");
});

test("polling raises a permanently failed task", async () => {
  mockFetch([{ body: { status_code: 20000, tasks: [{ status_code: 40501 }] } }]);
  await assert.rejects(provider.pollSearch(task()), (e) => e.code === "provider_error");
});

test("polling refuses a task id that was not issued by us", async () => {
  mockFetch([]);
  await assert.rejects(
    provider.pollSearch({ query: "q", taskId: "../../etc/passwd" }),
    (e) => e.code === "provider_error"
  );
});

test("one still-running search does not lose the completed ones", async () => {
  mockFetch([
    serp([organic({ url: "https://forum.example.org/t/1", title: "Done" })]),
    { body: { status_code: 20000, tasks: [{ status_code: 40602 }] } },
  ]);
  const out = await provider.pollSearches([task("a"), { query: "b", taskId: `${TASK_ID.slice(0, -1)}1` }]);
  assert.equal(out.pending, 1);
  assert.equal(out.results.length, 1);
});

test("polling surfaces an account-wide auth failure", async () => {
  mockFetch([{ status: 401, body: {} }, { status: 401, body: {} }]);
  await assert.rejects(
    provider.pollSearches([task("a"), { query: "b", taskId: `${TASK_ID.slice(0, -1)}1` }]),
    (e) => e.code === "auth_failed"
  );
});

test("no credential material appears in returned results", async () => {
  mockFetch([serp([organic()])]);
  const out = await provider.pollSearch(task());
  const dumped = JSON.stringify(out);
  for (const secret of ["test-login", "test-password", "Basic ", "Authorization"]) {
    assert.ok(!dumped.includes(secret), `${secret} must not appear in results`);
  }
});

// -------------------------------------------------------------- AI provenance

test("scoring never invents member counts or rules", () => {
  const results = [
    { title: "A", url: "https://forum.example.org/t/1", domain: "forum.example.org", position: 1, sourceQuery: "safety forum", snippet: "People discuss walking home safely." },
  ];
  const scored = normalizeScoreRows(
    {
      results: [
        {
          i: 0,
          audienceMatch: 91,
          problemMatch: 85,
          contextMatch: "strong",
          relevanceReason:
            "The snippet discusses walking home safely. This community has 80,000 active members. Rule 3 allows self-promotion.",
          audienceSignal: "People walking home alone. The forum has 25k subscribers.",
          painPoint: "They feel unsafe on the last stretch home.",
          growthAction: "Use that fear-of-the-last-stretch wording in ad copy.",
          actionability: "actionable",
        },
      ],
    },
    results
  );
  assert.equal(scored[0].audienceMatch, 91);
  assert.ok(scored[0].relevanceReason.includes("walking home safely"));
  assert.ok(!/80,000|members|Rule 3/i.test(scored[0].relevanceReason));
  // The same protection now guards the intelligence fields the customer reads.
  assert.ok(!/25k|subscribers/i.test(scored[0].audienceSignal));
  assert.ok(scored[0].painPoint.includes("unsafe"));
  assert.ok(scored[0].growthAction.includes("ad copy"));
});

test("unsupported-claim detection covers counts and rule claims", () => {
  assert.ok(containsUnsupportedClaim("This community has 80,000 members."));
  assert.ok(containsUnsupportedClaim("This community has 80,000 active members."));
  assert.ok(containsUnsupportedClaim("It has 12k subscribers"));
  assert.ok(containsUnsupportedClaim("Around 1.5M+ monthly users participate"));
  assert.ok(containsUnsupportedClaim("It is a highly active board"));
  assert.ok(containsUnsupportedClaim("Roughly 40 posts per day"));
  assert.ok(containsUnsupportedClaim("The rules allow self promotion"));
  assert.ok(!containsUnsupportedClaim("The snippet mentions students walking home at night."));
  assert.equal(stripUnsupportedClaims("Good grounded sentence."), "Good grounded sentence.");
});

test("scoring clamps scores and falls back to a grounded reason", () => {
  const results = [
    { title: "A", url: "https://a.example.org/t/1", domain: "a.example.org", position: 1, sourceQuery: "q1", snippet: "x" },
    { title: "B", url: "https://b.example.org/t/2", domain: "b.example.org", position: 2, sourceQuery: "q2" },
  ];
  const scored = normalizeScoreRows(
    {
      results: [
        { i: 0, audienceMatch: 5000, problemMatch: 5000, contextMatch: "strong" },
        { i: 1, audienceMatch: -20, problemMatch: -20, suggestedApproach: "spam_everywhere" },
      ],
    },
    results
  );
  assert.equal(scored.find((s) => s.title === "A").audienceMatch, 100);
  assert.equal(scored.find((s) => s.title === "B").audienceMatch, 0);
  assert.equal(scored.find((s) => s.title === "B").audienceFit, 0);
  // Unknown approaches fall back to the conservative option.
  assert.equal(scored.find((s) => s.title === "B").suggestedApproach, "do_not_post");
  assert.ok(scored.every((s) => s.relevanceReason.length > 0));
});

test("scoring ignores out-of-range and duplicate model indices", () => {
  const results = [
    { title: "A", url: "https://a.example.org/t/1", domain: "a.example.org", position: 1, sourceQuery: "q" },
  ];
  const scored = normalizeScoreRows(
    {
      results: [
        { i: 99, audienceMatch: 100 },
        { i: 0, audienceMatch: 42 },
        { i: 0, audienceMatch: 7 },
      ],
    },
    results
  );
  assert.equal(scored.length, 1);
  assert.equal(scored[0].audienceMatch, 42, "the first row for an index wins");
});

test("scoring survives a malformed model response", () => {
  const results = [
    { title: "A", url: "https://a.example.org/t/1", domain: "a.example.org", position: 1, sourceQuery: "q" },
  ];
  for (const bad of [null, "text", {}, { results: "nope" }]) {
    const scored = normalizeScoreRows(bad, results);
    assert.equal(scored.length, 1);
    assert.equal(scored[0].audienceFit, 0);
  }
  assert.deepEqual(normalizeScoreRows({ results: [] }, []), []);
});

// --------------------------------------------------------------- provenance

test("a web candidate carries retrieved evidence and no invented facts", () => {
  const raw = toRawCommunity({
    title: "Safety thread",
    url: "https://forum.example.org/t/5",
    domain: "forum.example.org",
    snippet: "Students discuss safe routes.",
    position: 3,
    sourceQuery: "student safety forum",
  });
  assert.equal(raw.platform, "web");
  assert.equal(raw.memberCount, undefined, "member count must stay unknown");
  assert.equal(raw.rules, undefined, "rules must stay unknown");
  assert.equal(raw.evidence.sourceQuery, "student safety forum");
  assert.equal(raw.evidence.position, 3);
});

test("stored web candidates are presented as real with separated provenance", () => {
  const client = toClientCandidate({
    id: "c1",
    platform: WEB_PLATFORM,
    name: "Safety thread",
    url: "https://forum.example.org/t/5",
    description: "Students discuss safe routes.",
    memberCount: null,
    audienceFit: 88,
    relevanceReason: "The snippet is about safe routes.",
    promotionPolicy: "unknown",
    policyEvidence: JSON.stringify({
      sourceQuery: "student safety forum",
      position: 3,
      domain: "forum.example.org",
      rulesRead: false,
    }),
    suggestedApproach: "educational_post",
    generatedContent: null,
    trackingLinkId: null,
  });
  assert.equal(client.isDemo, false, "real results are never marked demo");
  assert.equal(client.memberCount, null, "member count stays unknown");
  assert.equal(client.promotionPolicy, "unknown", "posting rules were not read");
  assert.equal(client.evidence.sourceQuery, "student safety forum");
  assert.equal(client.evidence.rulesRead, false);
  for (const gone of ["generatedContent", "hasTrackingLink", "canPrepare"]) {
    assert.ok(!(gone in client), `${gone} must not reach the client any more`);
  }
});

test("a corrupt evidence blob degrades to no evidence rather than throwing", () => {
  const client = toClientCandidate({
    id: "c2",
    platform: WEB_PLATFORM,
    name: "X",
    url: "https://forum.example.org/t/6",
    description: null,
    memberCount: null,
    audienceFit: 10,
    relevanceReason: null,
    promotionPolicy: "unknown",
    policyEvidence: "{not json",
    suggestedApproach: "do_not_post",
    generatedContent: null,
    trackingLinkId: null,
  });
  assert.equal(client.evidence, null);
});

// ------------------------------------------------------- resumable searches

test("a submitted search can be resumed only by its owner", () => {
  const tasks = [{ query: "safety forum", taskId: TASK_ID }];
  const ticket = signPayload(tasks, "user-1");
  assert.deepEqual(readPayload(ticket, "user-1"), tasks);
  assert.equal(readPayload(ticket, "user-2"), null, "another user must not resume it");
});

test("a tampered or malformed search ticket is rejected", () => {
  const ticket = signPayload([{ query: "q", taskId: TASK_ID }], "user-1");
  const [payload, sig] = ticket.split(".");
  const forged = Buffer.from(
    JSON.stringify({ data: [{ query: "q", taskId: TASK_ID }], userId: "user-1", exp: Date.now() + 1000 })
  ).toString("base64url");
  assert.equal(readPayload(`${forged}.${sig}`, "user-1"), null);
  assert.equal(readPayload(`${payload}.${"a".repeat(43)}`, "user-1"), null);
  assert.equal(readPayload("garbage", "user-1"), null);
  assert.equal(readPayload(null, "user-1"), null);
});

test("an expired search ticket is rejected", () => {
  const ticket = signPayload([{ query: "q", taskId: TASK_ID }], "user-1", -1);
  assert.equal(readPayload(ticket, "user-1"), null);
});

// ------------------------------------------------------ slow / resumable runs
// A real production run's tasks became ready 251-381s after submission. These
// lock in that a slow provider costs nothing extra and loses nothing.

test("a task still queued minutes later is pending, never a failure", async () => {
  const t = task("safety forum");
  // Six consecutive polls, all still queued — the shape of the real incident.
  mockFetch(Array.from({ length: 6 }, () => ({ body: { status_code: 20000, tasks: [{ status_code: 40602 }] } })));
  for (let i = 0; i < 6; i++) {
    assert.deepEqual(await provider.pollSearch(t), { status: "pending" });
  }
});

test("polling the same tasks never submits a paid search", async () => {
  const tasks = [task("a")];
  const calls = mockFetch([
    { body: { status_code: 20000, tasks: [{ status_code: 40602 }] } },
    { body: { status_code: 20000, tasks: [{ status_code: 40602 }] } },
    serp([organic()]),
  ]);
  await provider.pollSearches(tasks);
  await provider.pollSearches(tasks);
  const final = await provider.pollSearches(tasks);
  assert.equal(final.pending, 0);
  assert.equal(final.results.length, 1);
  assert.ok(
    calls.every((c) => c.url.includes("/task_get/")),
    "collecting must only ever call task_get"
  );
  assert.equal(calls.filter((c) => c.url.includes("task_post")).length, 0, "no paid submission");
});

test("a transient polling failure does not lose an otherwise valid run", async () => {
  const tasks = [task("a")];
  mockFetch([{ status: 500, body: {} }]);
  assert.deepEqual(await provider.pollSearches(tasks), { results: [], pending: 1 });
  // The same tasks still collect normally afterwards.
  mockFetch([serp([organic()])]);
  const after = await provider.pollSearches(tasks);
  assert.equal(after.pending, 0);
  assert.equal(after.results.length, 1);
});

test("a run stays resumable for the whole ticket lifetime", () => {
  const SIX_HOURS = 6 * 60 * 60 * 1000;
  const tasks = [task("a"), { query: "b", taskId: `${TASK_ID.slice(0, -1)}1` }];
  const ticket = signPayload(tasks, "user-1", SIX_HOURS);
  assert.deepEqual(readPayload(ticket, "user-1"), tasks);

  // Still valid well past the slowest observed provider run (381s).
  const almostExpired = signPayload(tasks, "user-1", 10_000);
  assert.deepEqual(readPayload(almostExpired, "user-1"), tasks);
  // And genuinely expires eventually.
  assert.equal(readPayload(signPayload(tasks, "user-1", -1), "user-1"), null);
});

test("scoring is bounded to one batch per request", () => {
  // 28 results in a single AI call was measured overrunning 25s; the server
  // caps each scoring request regardless of what the browser sends.
  const many = Array.from({ length: 40 }, (_, i) => ({
    title: `Thread ${i}`,
    url: `https://d${i}.example.org/forum/${i}`,
    domain: `d${i}.example.org`,
    position: i + 1,
    sourceQuery: "safety forum",
  }));
  assert.equal(sanitizeResults(many, 6).length, 6);
  assert.ok(sanitizeResults(many, 6).every((r) => r.url.startsWith("https://")));
});

test("a completed run yields results ready for scoring", async () => {
  mockFetch([serp([organic()]), serp([organic({ url: "https://forum.example.org/t/2", title: "Second" })])]);
  const { results, pending } = await provider.pollSearches([
    task("a"),
    { query: "b", taskId: `${TASK_ID.slice(0, -1)}1` },
  ]);
  assert.equal(pending, 0);
  assert.equal(results.length, 2);
  // Scoring accepts exactly this shape.
  const scored = normalizeScoreRows(
    { results: results.map((_, i) => ({ i, audienceFit: 60, pageType: "forum", actionability: "actionable" })) },
    results
  );
  assert.equal(scored.length, 2);
  assert.ok(scored.every((s) => s.sourceQuery && s.url.startsWith("https://")));
});

// ---------------------------------------------------- audience quality model
// Regression cases taken from the owner's real production run, where pages
// matched the product's vocabulary but contained none of its users.

const result = (over = {}) => ({
  title: "A page",
  url: "https://example.org/page",
  domain: "example.org",
  snippet: "Some text.",
  position: 1,
  sourceQuery: "safety forum",
  ...over,
});

const SAFETY_APP = {
  name: "SafeWalk",
  summary: "Shares your live location with trusted contacts while you walk home",
  audience: "Students and young adults who walk home alone at night",
  mainProblem: "Feeling unsafe walking alone with no quick way to alert someone",
};

const scoreCase = (r, row) => normalizeScoreRows({ results: [{ i: 0, ...row }] }, [r])[0];

test("A. an EHS workplace-safety thread is not an audience opportunity", () => {
  // Real result: "What are some good safety meeting topics?" — an Environment,
  // Health and Safety officer at a manufacturer. Same words, wrong people.
  const r = result({
    url: "https://www.reddit.com/r/ehs/comments/abc/what_are_some_good_safety_meeting_topics/",
    domain: "www.reddit.com",
    title: "What are some good safety meeting topics?",
    snippet: "I am EHS for a manufacturing company and recently started leading safety meetings...",
  });
  const scored = scoreCase(r, {
    audienceMatch: 15,
    problemMatch: 55,
    contextMatch: "mismatch",
    rejectionReason: "Participants are workplace safety officers, not consumers.",
    pageType: "discussion_thread",
    actionability: "actionable",
    suggestedApproach: "direct_post",
  });
  // Honest about what the page is...
  assert.equal(scored.pageType, "discussion_thread");
  assert.equal(scored.actionability, "actionable");
  // ...but never recommended.
  assert.equal(scored.opportunityQuality, "weak_match");
  assert.ok(scored.audienceFit <= 20, `fit ${scored.audienceFit} must stay low`);
  assert.ok(scored.rejectionReason.length > 0);
});

test("B. a FreePBX panic-button thread is not an audience opportunity", () => {
  const r = result({
    url: "https://www.reddit.com/r/freepbx/comments/xyz/recommendations_for_a_panic_button/",
    domain: "www.reddit.com",
    title: "Recommendations for a Panic Button? : r/freepbx",
    snippet: "Looking to wire a panic button into our PBX extension setup...",
  });
  const scored = scoreCase(r, {
    audienceMatch: 10,
    problemMatch: 70,
    contextMatch: "mismatch",
    rejectionReason: "Thread is about phone-system hardware, not personal safety users.",
    pageType: "discussion_thread",
    actionability: "actionable",
    suggestedApproach: "direct_post",
  });
  assert.equal(scored.opportunityQuality, "weak_match");
  assert.ok(scored.audienceFit <= 20);
});

test("C. students afraid to walk home alone IS a strong opportunity", () => {
  const r = result({
    url: "https://www.reddit.com/r/college/comments/abc/walking_home_at_night/",
    domain: "www.reddit.com",
    title: "Anyone else scared walking home from campus at night?",
    snippet: "I finish class at 10pm and the walk back to my dorm terrifies me...",
  });
  const scored = scoreCase(r, {
    audienceMatch: 90,
    problemMatch: 92,
    contextMatch: "strong",
    pageType: "discussion_thread",
    actionability: "actionable",
    suggestedApproach: "educational_post",
  });
  assert.equal(scored.opportunityQuality, "strong_opportunity");
  assert.ok(scored.audienceFit >= 80, `fit ${scored.audienceFit}`);
  assert.equal(scored.rejectionReason, "", "a strong fit carries no rejection reason");
});

test("D. a personal-safety Facebook post can be a strong opportunity", () => {
  const r = result({
    url: "https://www.facebook.com/groups/12345/posts/67890/",
    domain: "www.facebook.com",
    title: "Is it safe to walk alone here at night?",
  });
  const scored = scoreCase(r, {
    audienceMatch: 78,
    problemMatch: 80,
    contextMatch: "strong",
    actionability: "actionable",
    suggestedApproach: "educational_post",
  });
  assert.equal(scored.pageType, "community_group");
  assert.equal(scored.opportunityQuality, "strong_opportunity");
});

test("the right problem cannot rescue the wrong people", () => {
  // The explicit product rule: problemMatch 90 + audienceMatch 10 is not a 70.
  const fit = computeAudienceFit({ audienceMatch: 10, problemMatch: 90, contextMatch: "strong" });
  assert.ok(fit <= 20, `got ${fit}`);
  assert.ok(
    computeAudienceFit({ audienceMatch: 90, problemMatch: 90, contextMatch: "strong" }) >= 80
  );
});

test("the right people with an unrelated problem score mid, not high", () => {
  const fit = computeAudienceFit({ audienceMatch: 85, problemMatch: 15, contextMatch: "partial" });
  assert.ok(fit < MIN_AUDIENCE_MATCH, `got ${fit}`);
  assert.equal(
    gradeOpportunity({
      actionability: "actionable",
      audienceMatch: 85,
      problemMatch: 15,
      contextMatch: "partial",
    }).quality,
    "weak_match"
  );
});

test("a context mismatch can never become a strong opportunity", () => {
  const graded = gradeOpportunity({
    actionability: "actionable",
    audienceMatch: 95,
    problemMatch: 95,
    contextMatch: "mismatch",
  });
  assert.equal(graded.quality, "weak_match");
  assert.ok(graded.audienceFit <= 20);
});

test("the server gate overrides a model that oversells a mismatch", () => {
  const r = result({ url: "https://www.reddit.com/r/freepbx/comments/x/y/", domain: "www.reddit.com" });
  const scored = scoreCase(r, {
    audienceMatch: 95, // model insists
    problemMatch: 95,
    contextMatch: "mismatch", // but admits the world is different
    actionability: "actionable",
    suggestedApproach: "direct_post",
  });
  assert.equal(scored.opportunityQuality, "weak_match");
  assert.ok(scored.audienceFit <= 20);
});

test("scores just under and over the thresholds fall on the right side", () => {
  const base = { actionability: "actionable", contextMatch: "strong" };
  assert.equal(
    gradeOpportunity({ ...base, audienceMatch: MIN_AUDIENCE_MATCH, problemMatch: MIN_PROBLEM_MATCH })
      .quality,
    "strong_opportunity"
  );
  assert.equal(
    gradeOpportunity({ ...base, audienceMatch: MIN_AUDIENCE_MATCH - 1, problemMatch: 95 }).quality,
    "weak_match"
  );
  assert.equal(
    gradeOpportunity({ ...base, audienceMatch: 95, problemMatch: MIN_PROBLEM_MATCH - 1 }).quality,
    "weak_match"
  );
});

test("out-of-range and malformed model scores are clamped safely", () => {
  const r = result();
  const high = scoreCase(r, { audienceMatch: 5000, problemMatch: 900, contextMatch: "strong", actionability: "actionable", pageType: "forum" });
  assert.equal(high.audienceMatch, 100);
  assert.equal(high.problemMatch, 100);
  assert.ok(high.audienceFit <= 100);

  const low = scoreCase(r, { audienceMatch: -50, problemMatch: -1, contextMatch: "nonsense" });
  assert.equal(low.audienceMatch, 0);
  assert.equal(low.problemMatch, 0);
  assert.equal(low.contextMatch, "unknown");
  assert.equal(low.opportunityQuality, "weak_match");

  const missing = scoreCase(r, {});
  assert.equal(missing.audienceMatch, 0);
  assert.equal(missing.contextMatch, "unknown");
  assert.equal(missing.audienceFit, 0);
});

test("a research page with a perfect audience stays research_only", () => {
  const scored = scoreCase(result({ domain: "news.example.org" }), {
    audienceMatch: 100,
    problemMatch: 100,
    contextMatch: "strong",
    pageType: "news",
    actionability: "actionable",
    suggestedApproach: "direct_post",
  });
  assert.equal(scored.actionability, "research_only");
  assert.equal(scored.opportunityQuality, "research_only");
  assert.equal(scored.suggestedApproach, "do_not_post");
});

test("strong opportunities outrank weak matches regardless of Google position", () => {
  const results = [
    result({ url: "https://www.reddit.com/r/freepbx/comments/a/b/", domain: "www.reddit.com", title: "Mismatch", position: 1 }),
    result({ url: "https://www.reddit.com/r/college/comments/c/d/", domain: "www.reddit.com", title: "Real audience", position: 9 }),
  ];
  const scored = normalizeScoreRows(
    {
      results: [
        { i: 0, audienceMatch: 10, problemMatch: 90, contextMatch: "mismatch", actionability: "actionable" },
        { i: 1, audienceMatch: 88, problemMatch: 85, contextMatch: "strong", actionability: "actionable" },
      ],
    },
    results
  );
  assert.equal(scored[0].title, "Real audience");
  assert.equal(scored[0].opportunityQuality, "strong_opportunity");
  assert.equal(scored[1].opportunityQuality, "weak_match");
});

test("anti-fabrication still applies to the rejection reason", () => {
  const scored = scoreCase(result({ url: "https://site.example.org/forum/x", domain: "site.example.org" }), {
    audienceMatch: 20,
    problemMatch: 30,
    contextMatch: "mismatch",
    rejectionReason: "Wrong crowd. This forum has 50,000 active members.",
    actionability: "actionable",
  });
  assert.ok(!/50,000|members/i.test(scored.rejectionReason));
  assert.ok(scored.rejectionReason.includes("Wrong crowd"));
});

// ------------------------------------------------ prepare guard on weak match

test("a weak match cannot create a tracking link", () => {
  const row = {
    platform: WEB_PLATFORM,
    policyEvidence: JSON.stringify({
      sourceQuery: "q",
      position: 1,
      domain: "www.reddit.com",
      rulesRead: false,
      pageType: "discussion_thread",
      actionability: "actionable",
      opportunityQuality: "weak_match",
    }),
  };
  assert.equal(storedOpportunityQuality(row), "weak_match");
});

test("a strong opportunity remains preparable", () => {
  const row = {
    platform: WEB_PLATFORM,
    policyEvidence: JSON.stringify({
      sourceQuery: "q",
      position: 1,
      domain: "www.reddit.com",
      rulesRead: false,
      pageType: "discussion_thread",
      actionability: "actionable",
      opportunityQuality: "strong_opportunity",
    }),
  };
  assert.equal(storedOpportunityQuality(row), "strong_opportunity");
});

test("rows stored before the quality gate stay readable and are not blocked", () => {
  const legacy = {
    platform: WEB_PLATFORM,
    policyEvidence: JSON.stringify({ sourceQuery: "q", position: 1, domain: "d.example.org", rulesRead: false }),
  };
  assert.equal(storedOpportunityQuality(legacy), "unknown");
  assert.equal(storedOpportunityQuality({ platform: WEB_PLATFORM, policyEvidence: "{broken" }), "unknown");

  const client = toClientCandidate({
    id: "legacy",
    platform: WEB_PLATFORM,
    name: "Old row",
    url: "https://forum.example.org/t/1",
    description: null,
    memberCount: null,
    audienceFit: 40,
    relevanceReason: null,
    promotionPolicy: "unknown",
    policyEvidence: legacy.policyEvidence,
    suggestedApproach: "do_not_post",
    generatedContent: null,
    trackingLinkId: null,
  });
  assert.equal(client.evidence.opportunityQuality, "unknown");
  assert.equal(client.evidence.audienceMatch, 0);
});

test("quality metadata round-trips through storage without a schema change", () => {
  const client = toClientCandidate({
    id: "q1",
    platform: WEB_PLATFORM,
    name: "Thread",
    url: "https://www.reddit.com/r/college/comments/a/b/",
    description: "snippet",
    memberCount: null,
    audienceFit: 84,
    relevanceReason: "reason",
    promotionPolicy: "unknown",
    policyEvidence: JSON.stringify({
      sourceQuery: "q",
      position: 3,
      domain: "www.reddit.com",
      rulesRead: false,
      pageType: "discussion_thread",
      actionability: "actionable",
      audienceMatch: 88,
      problemMatch: 85,
      contextMatch: "strong",
      opportunityQuality: "strong_opportunity",
    }),
    suggestedApproach: "educational_post",
    generatedContent: null,
    trackingLinkId: null,
  });
  assert.equal(client.evidence.audienceMatch, 88);
  assert.equal(client.evidence.contextMatch, "strong");
  assert.equal(client.evidence.opportunityQuality, "strong_opportunity");
  assert.equal(client.memberCount, null, "member counts remain unknown");
  assert.equal(client.promotionPolicy, "unknown", "permission is never inferred");
});

// ------------------------------------------------------- query strategy shape

test("query generation asks for user situation, not product category", () => {
  const prompt = discoveryQueryPrompt({
    name: "SafeWalk",
    summary: SAFETY_APP.summary,
    audience: SAFETY_APP.audience,
    mainProblem: SAFETY_APP.mainProblem,
  });
  for (const required of ["targetUser", "situation", "pain", "moment", "outcome", "exclude"]) {
    assert.ok(prompt.includes(required), `prompt must ask for ${required}`);
  }
  for (const angle of QUERY_ANGLES) {
    assert.ok(prompt.includes(angle), `prompt must cover the ${angle} angle`);
  }
  assert.ok(/FORBIDDEN/.test(prompt), "category+venue queries must be forbidden");
  assert.ok(prompt.includes(SAFETY_APP.mainProblem), "the project's own problem must be used");
});

// ------------------------------------------------- recommendation gate (real)
// Regression cases from the owner's production run: a 20% do_not_post result
// still offered "Prepare post + tracking link", and a genuine Quora question
// was demoted to research evidence.

/** Build a stored row the way persistWebCandidates would. */


test("CASE A. a strong Reddit safety thread is graded a strong opportunity", () => {
  const scored = scoreCase(
    result({
      url: "https://www.reddit.com/r/personalsafety/comments/a/ysk_being_followed/",
      domain: "www.reddit.com",
      title: "YSK what to do if you think you are being followed",
    }),
    {
      audienceMatch: 85,
      problemMatch: 82,
      contextMatch: "strong",
      actionability: "actionable",
      suggestedApproach: "educational_post",
    }
  );
  assert.equal(scored.opportunityQuality, "strong_opportunity");
});

test("CASE B. a 20% community-shaped result is graded a weak match", () => {
  // The exact production contradiction: community-shaped URL, do_not_post,
  // and the button appeared anyway.
});


test("CASE C. a good Q&A is not demoted to research and can be recommended", () => {
  const scored = scoreCase(
    result({
      url: "https://www.quora.com/What-are-some-suggestions-to-make-me-feel-safer-going-home-at-night",
      domain: "www.quora.com",
      title: "What are some suggestions to make me feel safer before work or when I am going home at night?",
    }),
    {
      audienceMatch: 82,
      problemMatch: 85,
      contextMatch: "strong",
      // The model wrongly called it research — the page type overrules that.
      actionability: "research_only",
      suggestedApproach: "educational_post",
    }
  );
  assert.equal(scored.pageType, "q_and_a");
  assert.notEqual(scored.actionability, "research_only", "a question thread is not research");
  assert.equal(scored.actionability, "unknown", "downgraded, never silently promoted");
  // Unknown actionability is honest but not recommendable on its own.
  assert.equal(scored.opportunityQuality, "weak_match");

  // With the actionability the evidence supports, it becomes a real opportunity.
  const confident = scoreCase(
    result({
      url: "https://www.quora.com/What-are-some-suggestions-to-make-me-feel-safer",
      domain: "www.quora.com",
      title: "What are some suggestions to make me feel safer going home at night?",
    }),
    {
      audienceMatch: 82,
      problemMatch: 85,
      contextMatch: "strong",
      actionability: "actionable",
      suggestedApproach: "educational_post",
    }
  );
  assert.equal(confident.pageType, "q_and_a");
  assert.equal(confident.opportunityQuality, "strong_opportunity");
});

test("CASE D. an off-topic Q&A stays a discussion page but is graded weak", () => {
  const scored = scoreCase(
    result({
      url: "https://www.quora.com/Why-do-I-feel-like-I-am-being-watched",
      domain: "www.quora.com",
      title: "Why do I always feel like I am being watched?",
    }),
    {
      audienceMatch: 25,
      problemMatch: 20,
      contextMatch: "mismatch",
      actionability: "actionable",
      suggestedApproach: "educational_post",
    }
  );
  assert.equal(scored.pageType, "q_and_a");
  assert.equal(scored.actionability, "actionable", "still an interaction surface");
  assert.equal(scored.opportunityQuality, "weak_match");
});






// -------------------------------------------------- presentation invariants
// Which section a source appears in is a judgement the customer reads, so the
// grouping rules are pinned down here.

const candidate = (over = {}) => ({
  platform: "web",
  evidence: { actionability: "actionable", opportunityQuality: "weak_match" },
  ...over,
});

test("only strong opportunities reach the main results section", () => {
  const list = [
    candidate({ evidence: { actionability: "actionable", opportunityQuality: "strong_opportunity" }, canPrepare: true }),
    candidate({ evidence: { actionability: "actionable", opportunityQuality: "weak_match" } }),
    candidate({ evidence: { actionability: "unknown", opportunityQuality: "unknown" } }),
    candidate({ evidence: { actionability: "research_only", opportunityQuality: "research_only" } }),
  ];
  const { opportunities, lowConfidence, research } = groupCandidates(list);
  assert.equal(opportunities.length, 1);
  assert.equal(lowConfidence.length, 2, "weak and unjudged are both held back");
  assert.equal(research.length, 1);
  assert.ok(opportunities.every(isStrongOpportunity));
  assert.ok(lowConfidence.every((c) => !isResearchOnly(c)));
});



test("demo communities never carry a prepare permission", () => {
  const demo = demoCommunities("TestApp");
  assert.ok(demo.every((d) => d.isDemo === true));
  assert.ok(demo.every((d) => !("canPrepare" in d)));
});

// ------------------------------------------------ actionability / page types

const scoreOne = (r, row) => normalizeScoreRows({ results: [{ i: 0, ...row }] }, [r])[0];

for (const [label, url, domain, expected] of [
  ["a Reddit thread", "https://www.reddit.com/r/college/comments/abc/walking_home/", "www.reddit.com", "discussion_thread"],
  ["a subreddit itself", "https://www.reddit.com/r/college", "www.reddit.com", "community_group"],
  ["a Facebook group", "https://www.facebook.com/groups/835697986772172/", "www.facebook.com", "community_group"],
  ["a Facebook post", "https://www.facebook.com/NewshubNZ/posts/the-topic", "www.facebook.com", "social_post"],
  ["a Stack Exchange question", "https://ux.stackexchange.com/questions/12/safety", "ux.stackexchange.com", "q_and_a"],
  ["a Quora page", "https://www.quora.com/How-do-you-stay-safe", "www.quora.com", "q_and_a"],
  ["a phpBB thread", "https://board.example.org/viewtopic.php?t=99", "board.example.org", "discussion_thread"],
  ["a forum section", "https://site.example.org/forum/safety", "site.example.org", "forum"],
]) {
  test(`URL shape identifies ${label}`, () => {
    assert.equal(urlPageTypeHint({ url, domain }), expected);
  });
}

test("an ordinary article URL gives no page-type hint", () => {
  assert.equal(
    urlPageTypeHint({
      url: "https://campussecuritytoday.com/articles/2022/03/22/students-fear-walking-alone.aspx",
      domain: "campussecuritytoday.com",
    }),
    null
  );
});

test("A. a Reddit thread becomes an actionable discussion", () => {
  const r = result({
    url: "https://www.reddit.com/r/college/comments/abc/walking_home/",
    domain: "www.reddit.com",
    title: "Walking on campus at night",
  });
  const scored = scoreOne(r, {
    audienceFit: 80,
    pageType: "discussion_thread",
    actionability: "actionable",
    suggestedApproach: "educational_post",
  });
  assert.equal(scored.pageType, "discussion_thread");
  assert.equal(scored.actionability, "actionable");
  assert.equal(scored.suggestedApproach, "educational_post");
});

test("B. a Facebook group is treated as a community, conservatively", () => {
  const r = result({ url: "https://www.facebook.com/groups/12345/", domain: "www.facebook.com" });
  const scored = scoreOne(r, { audienceFit: 70, pageType: "article", actionability: "unknown" });
  // The URL wins over the model's guess, and an unclaimed actionability stays unknown.
  assert.equal(scored.pageType, "community_group");
  assert.ok(["actionable", "unknown"].includes(scored.actionability));
  assert.notEqual(scored.actionability, "research_only");
});

test("C. an article is research only and never gets a publishing approach", () => {
  const r = result({
    url: "https://campussecuritytoday.com/articles/2022/03/22/students-fear.aspx",
    domain: "campussecuritytoday.com",
    title: "Students Fear Walking Alone at Night",
  });
  const scored = scoreOne(r, {
    audienceMatch: 90,
    problemMatch: 90,
    contextMatch: "strong",
    pageType: "article",
    actionability: "actionable",
    suggestedApproach: "direct_post",
  });
  assert.equal(scored.pageType, "article");
  assert.equal(scored.actionability, "research_only");
  assert.equal(scored.suggestedApproach, "do_not_post");
  // Relevance is NOT reduced just because the page cannot be posted to.
  assert.equal(scored.audienceMatch, 90);
  assert.equal(scored.problemMatch, 90);
});

test("D. a news page is research only", () => {
  const scored = scoreOne(result({ domain: "securitytoday.com" }), {
    audienceFit: 65,
    pageType: "news",
    actionability: "actionable",
    suggestedApproach: "educational_post",
  });
  assert.equal(scored.actionability, "research_only");
  assert.equal(scored.suggestedApproach, "do_not_post");
});

for (const pageType of ["research", "landing_page", "directory"]) {
  test(`E. a ${pageType} page is research only`, () => {
    const scored = scoreOne(result({ domain: "sites.lafayette.edu" }), {
      audienceFit: 75,
      pageType,
      actionability: "actionable",
      suggestedApproach: "direct_post",
    });
    assert.equal(scored.actionability, "research_only");
    assert.equal(scored.suggestedApproach, "do_not_post");
  });
}

test("F. malformed AI output falls back to safe defaults", () => {
  const r = result();
  for (const row of [{}, { pageType: "blog_post", actionability: "definitely" }, { pageType: 42 }]) {
    const scored = scoreOne(r, row);
    assert.equal(scored.pageType, "other");
    assert.equal(scored.actionability, "unknown");
    assert.equal(scored.suggestedApproach, "do_not_post");
  }
  const missing = normalizeScoreRows({ results: "nope" }, [r])[0];
  assert.equal(missing.pageType, "other");
  assert.equal(missing.actionability, "unknown");
});

test("G. the server overrides a model that calls an article actionable", () => {
  const enforced = enforceActionability({
    pageType: "article",
    actionability: "actionable",
    suggestedApproach: "direct_post",
  });
  assert.deepEqual(enforced, {
    pageType: "article",
    actionability: "research_only",
    suggestedApproach: "do_not_post",
  });
});

test("an unclassified page is never promoted to actionable", () => {
  const enforced = enforceActionability({
    pageType: "other",
    actionability: "actionable",
    suggestedApproach: "direct_post",
  });
  assert.equal(enforced.actionability, "unknown");
});

test("an engageable page type is never turned into research evidence", () => {
  // A place where people talk stays a place where people talk. The model's
  // "research_only" is honoured as a downgrade to unknown, not as a promotion.
  for (const pageType of ["discussion_thread", "community_group", "forum", "q_and_a", "social_post"]) {
    const enforced = enforceActionability({
      pageType,
      actionability: "research_only",
      suggestedApproach: "direct_post",
    });
    assert.equal(enforced.actionability, "unknown", `${pageType} must not become research`);
    assert.notEqual(enforced.actionability, "actionable", `${pageType} must not be promoted`);
  }
});

test("H. anti-fabrication stripping still applies alongside classification", () => {
  const scored = scoreOne(
    result({ url: "https://site.example.org/forum/safety", domain: "site.example.org" }),
    {
      audienceFit: 88,
      pageType: "forum",
      actionability: "actionable",
      relevanceReason: "The snippet is about safe routes. It has 40,000 active members.",
      outreachAngle: "Be helpful. Rule 2 allows links.",
      suggestedApproach: "educational_post",
    }
  );
  assert.ok(scored.relevanceReason.includes("safe routes"));
  assert.ok(!/40,000|members/i.test(scored.relevanceReason));
  assert.ok(!/Rule 2/i.test(scored.outreachAngle));
});

test("actionable opportunities are ranked above research evidence", () => {
  const results = [
    result({ url: "https://news.example.org/story", domain: "news.example.org", title: "Article" }),
    result({ url: "https://site.example.org/forum/x", domain: "site.example.org", title: "Forum" }),
  ];
  const scored = normalizeScoreRows(
    {
      results: [
        { i: 0, audienceMatch: 99, problemMatch: 99, contextMatch: "strong", pageType: "news", actionability: "research_only" },
        { i: 1, audienceMatch: 70, problemMatch: 70, contextMatch: "strong", pageType: "forum", actionability: "actionable" },
      ],
    },
    results
  );
  assert.equal(scored[0].title, "Forum", "a postable place outranks a better-matching article");
  assert.equal(scored[1].audienceMatch, 99, "the article keeps its high relevance");
});

test("stored candidates carry page type and actionability without a schema change", () => {
  const client = toClientCandidate({
    id: "c9",
    platform: WEB_PLATFORM,
    name: "Thread",
    url: "https://forum.example.org/t/5",
    description: "snippet",
    memberCount: null,
    audienceFit: 70,
    relevanceReason: "reason",
    promotionPolicy: "unknown",
    policyEvidence: JSON.stringify({
      sourceQuery: "q",
      position: 2,
      domain: "forum.example.org",
      rulesRead: false,
      pageType: "forum",
      actionability: "actionable",
    }),
    suggestedApproach: "educational_post",
    generatedContent: null,
    trackingLinkId: null,
  });
  assert.equal(client.evidence.pageType, "forum");
  assert.equal(client.evidence.actionability, "actionable");
  assert.equal(client.promotionPolicy, "unknown", "policy is never upgraded");
});

test("candidates stored before actionability existed read as unknown", () => {
  const client = toClientCandidate({
    id: "old",
    platform: WEB_PLATFORM,
    name: "Old row",
    url: "https://forum.example.org/t/1",
    description: null,
    memberCount: null,
    audienceFit: 50,
    relevanceReason: null,
    promotionPolicy: "unknown",
    policyEvidence: JSON.stringify({ sourceQuery: "q", position: 1, domain: "forum.example.org", rulesRead: false }),
    suggestedApproach: "do_not_post",
    generatedContent: null,
    trackingLinkId: null,
  });
  assert.equal(client.evidence.pageType, "other");
  assert.equal(client.evidence.actionability, "unknown");
});

// ------------------------------------------------- prepare-endpoint invariant

test("I. a research-only candidate is refused by the prepare guard", () => {
  const row = {
    platform: WEB_PLATFORM,
    policyEvidence: JSON.stringify({
      sourceQuery: "q",
      position: 1,
      domain: "news.example.org",
      rulesRead: false,
      pageType: "news",
      actionability: "research_only",
    }),
  };
  assert.equal(storedActionability(row), "research_only");
});

test("J. an actionable candidate remains preparable", () => {
  const row = {
    platform: WEB_PLATFORM,
    policyEvidence: JSON.stringify({
      sourceQuery: "q",
      position: 1,
      domain: "www.reddit.com",
      rulesRead: false,
      pageType: "discussion_thread",
      actionability: "actionable",
    }),
  };
  assert.equal(storedActionability(row), "actionable");
});

test("the prepare guard defaults to unknown, never to research_only, on bad data", () => {
  assert.equal(storedActionability({ platform: WEB_PLATFORM, policyEvidence: "{broken" }), "unknown");
  assert.equal(storedActionability({ platform: WEB_PLATFORM, policyEvidence: null }), "unknown");
  assert.equal(storedActionability({ platform: "reddit", policyEvidence: null }), "unknown");
});

test("K. demo communities never carry real classifications", () => {
  const demo = demoCommunities("TestApp");
  assert.ok(demo.every((d) => d.isDemo === true));
  assert.ok(demo.every((d) => !("actionability" in d) && !("pageType" in d)));
  assert.ok(demo.every((d) => !("evidence" in d)));
});

test("demo communities are always flagged as demo and never as real", () => {
  const demo = demoCommunities("TestApp");
  assert.ok(demo.length > 0);
  assert.ok(demo.every((d) => d.isDemo === true));
  // Demo rows carry their own ids and never pass through the real-result mapper.
  assert.ok(demo.every((d) => d.id.startsWith("demo-")));
});
