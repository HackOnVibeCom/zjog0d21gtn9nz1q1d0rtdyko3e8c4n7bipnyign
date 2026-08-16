// normalizeAnalysis is the trust boundary for the analysis object that the
// Google Play review screen posts back to /api/projects. Anything the browser
// sends must come out as a well-formed AppAnalysis — never as raw client data.
import test from "node:test";
import assert from "node:assert/strict";

const { normalizeAnalysis } = await import("../.tmp-test/analyze.js");

const GOOD = {
  primaryCategory: "Fitness",
  secondaryCategories: ["Health", "Lifestyle"],
  summary: "A workout planner.",
  mainProblem: "People don't know what to train.",
  audience: "Gym beginners",
  valueProp: "A plan in 30 seconds",
  recommendedChannels: [
    { platform: "reddit", priority: "high", why: "w", format: "f", angle: "a" },
    { platform: "youtube", priority: "low", why: "w2", format: "f2", angle: "a2" },
  ],
};

test("a well-formed analysis passes through unchanged", () => {
  assert.deepEqual(normalizeAnalysis(GOOD), GOOD);
});

test("non-object input yields a safe empty analysis", () => {
  for (const bad of [null, undefined, "string", 42, []]) {
    const a = normalizeAnalysis(bad);
    assert.equal(a.primaryCategory, "unknown");
    assert.deepEqual(a.recommendedChannels, []);
    assert.deepEqual(a.secondaryCategories, []);
    assert.equal(a.audience, "");
  }
});

test("non-string scalar fields never become '[object Object]'", () => {
  const a = normalizeAnalysis({
    primaryCategory: { evil: true },
    audience: ["x"],
    valueProp: 12,
    summary: null,
    mainProblem: { toString: "nope" },
  });
  assert.equal(a.primaryCategory, "unknown");
  for (const v of [a.audience, a.valueProp, a.summary, a.mainProblem]) {
    assert.equal(v, "");
  }
});

test("unknown channel platforms are dropped", () => {
  const a = normalizeAnalysis({
    recommendedChannels: [
      { platform: "linkedin", priority: "high" },
      { platform: "reddit", priority: "high" },
      "not an object",
      null,
      { noPlatform: true },
    ],
  });
  assert.equal(a.recommendedChannels.length, 1);
  assert.equal(a.recommendedChannels[0].platform, "reddit");
});

test("an invalid priority falls back to medium", () => {
  const a = normalizeAnalysis({
    recommendedChannels: [{ platform: "discord", priority: "URGENT" }],
  });
  assert.equal(a.recommendedChannels[0].priority, "medium");
});

test("oversized client payloads are capped", () => {
  const a = normalizeAnalysis({
    primaryCategory: "c".repeat(10_000),
    audience: "a".repeat(10_000),
    secondaryCategories: Array.from({ length: 100 }, () => "s".repeat(1_000)),
    recommendedChannels: Array.from({ length: 100 }, () => ({
      platform: "tiktok",
      priority: "high",
      why: "w".repeat(10_000),
      angle: "x".repeat(10_000),
      format: "f".repeat(10_000),
    })),
  });
  assert.ok(a.primaryCategory.length <= 120);
  assert.ok(a.audience.length <= 600);
  assert.ok(a.secondaryCategories.length <= 6);
  assert.ok(a.secondaryCategories.every((c) => c.length <= 120));
  assert.ok(a.recommendedChannels.length <= 5);
  assert.ok(a.recommendedChannels.every((c) => c.why.length <= 400 && c.format.length <= 200));
});

test("extra client-supplied keys are not carried through", () => {
  const a = normalizeAnalysis({ ...GOOD, isAdmin: true, userId: "someone-else" });
  assert.deepEqual(Object.keys(a).sort(), [
    "audience",
    "mainProblem",
    "primaryCategory",
    "recommendedChannels",
    "secondaryCategories",
    "summary",
    "valueProp",
  ]);
  const channel = normalizeAnalysis({
    recommendedChannels: [{ platform: "reddit", injected: "x" }],
  }).recommendedChannels[0];
  assert.deepEqual(Object.keys(channel).sort(), ["angle", "format", "platform", "priority", "why"]);
});
