// DISCOVER IS RESEARCH, NOT OUTREACH.
//
// Step 3 exists to tell a customer who their audience is, what those people
// need and how that should change acquisition strategy. It must never hand
// them a place to post, a message to send or a person to contact — and the
// model must never be asked to produce one. These tests pin that boundary,
// and pin the Discord publisher as intact-but-hidden rather than deleted.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

process.env.DATABASE_URL ??= "postgresql://test:test@127.0.0.1:5432/test";

const { normalizeScoreRows } = await import("../.tmp-test/discovery/webscore.js");

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const UI = "app/projects/[id]/page.tsx";
const ROUTE = "app/api/projects/[id]/discover/route.ts";
const SCORE = "lib/discovery/webscore.ts";

// ------------------------------------------------ what the model is asked for

test("the discovery prompt asks for intelligence, never for an approach to a page", () => {
  const src = read(SCORE);
  assert.match(src, /audienceSignal/, "it asks what the source says about the audience");
  assert.match(src, /painPoint/, "it asks what need is visible");
  assert.match(src, /growthAction/, "it asks how strategy should change");
  assert.ok(!src.includes("outreachAngle"), "the engagement angle is gone");
  assert.match(
    src,
    /NEVER an instruction to post, comment, message, contact or/,
    "the prompt forbids outreach instructions outright"
  );
  assert.match(src, /never recommend posting, commenting, messaging or/i, "the system role too");
});

test("the engagement classification is derived, not requested", () => {
  const src = read(SCORE);
  const row = src.slice(src.indexOf("type ScoreRow"), src.indexOf("export function normalizeScoreRows"));
  assert.ok(!row.includes("suggestedApproach"), "the model is not asked which approach to take");
  assert.match(src, /const approach: SuggestedApproach =/, "the server decides it");
});

test("a page that is not a live discussion never becomes postable", () => {
  const results = [
    {
      title: "Best safety apps compared",
      url: "https://example.test/blog/best-safety-apps",
      domain: "example.test",
      position: 3,
      sourceQuery: "safety apps",
      snippet: "We compared the leading personal safety apps.",
    },
  ];
  const scored = normalizeScoreRows(
    { results: [{ i: 0, audienceMatch: 90, problemMatch: 90, contextMatch: "strong" }] },
    results
  );
  assert.equal(scored[0].suggestedApproach, "do_not_post");
});

test("intelligence fields survive scoring and carry no invented numbers", () => {
  const results = [
    {
      title: "Walking home at night",
      url: "https://forum.test/t/9",
      domain: "forum.test",
      position: 1,
      sourceQuery: "walking home alone",
      snippet: "The last ten minutes are the worst part of my day.",
    },
  ];
  const scored = normalizeScoreRows(
    {
      results: [
        {
          i: 0,
          audienceMatch: 88,
          problemMatch: 84,
          contextMatch: "strong",
          actionability: "actionable",
          audienceSignal: "Commuters walking home late. 40,000 active members here.",
          painPoint: "The last stretch home feels unsafe.",
          growthAction: "Test that phrase as a search ad headline.",
        },
      ],
    },
    results
  );
  assert.ok(!/40,000|members/i.test(scored[0].audienceSignal), "a size claim is stripped");
  assert.ok(scored[0].audienceSignal.includes("Commuters"), "the grounded part survives");
  assert.equal(scored[0].painPoint, "The last stretch home feels unsafe.");
  assert.equal(scored[0].growthAction, "Test that phrase as a search ad headline.");
});

test("real search provenance is still preserved", () => {
  const results = [
    {
      title: "T",
      url: "https://real.test/thread/1",
      domain: "real.test",
      position: 4,
      sourceQuery: "night safety",
      snippet: "s",
    },
  ];
  const scored = normalizeScoreRows(
    { results: [{ i: 0, audienceMatch: 70, problemMatch: 70 }] },
    results
  );
  assert.equal(scored[0].url, "https://real.test/thread/1", "the real source URL is kept");
  assert.equal(scored[0].sourceQuery, "night safety");
  assert.equal(scored[0].position, 4);
});

// ----------------------------------------------------- what the customer sees

test("no user-facing control offers posting, sending or contacting", () => {
  const ui = read(UI);
  for (const forbidden of [
    "Prepare post",
    "Copy suggested post",
    "Suggested post",
    "Publish to Discord",
    "Post to community",
    "Publish link",
    "Send message",
    "Contact users",
    "Open community",
    "Submit link",
  ]) {
    assert.ok(!ui.includes(forbidden), `the workspace must not offer "${forbidden}"`);
  }
  assert.ok(!/onClick=\{\(\)\s*=>\s*prepare\(/.test(ui), "the prepare action is gone");
  assert.ok(!ui.includes("generatedContent &&"), "no AI draft is rendered");
});

test("discovery presents itself as research and says what it will not do", () => {
  const ui = read(UI);
  assert.match(ui, /Market &amp; audience intelligence/, "the block is labelled as intelligence");
  assert.match(ui, /Audience signal · AI inference/);
  assert.match(ui, /Pain point · AI inference/);
  assert.match(ui, /Recommended growth action · AI inference/);
  assert.match(ui, /Evidence — observed search snippet/, "observed evidence stays labelled");
  assert.match(ui, /does not post,[\s\S]{0,40}comment or message anywhere/, "the limit is stated");
});

test("observed facts and AI inference stay visibly separate", () => {
  const ui = read(UI);
  assert.match(ui, /Observed via web search · query/, "retrieval is labelled as observed");
  assert.match(ui, /the page itself was not opened or read/, "the limit of the evidence is stated");
  assert.match(ui, /prov-label/, "the existing provenance treatment is reused");
});

test("the outreach action is no longer reachable through the API", () => {
  const route = read(ROUTE);
  assert.ok(!/if \(step === "prepare"\)/.test(route), "the prepare step is gone");
  assert.ok(!route.includes("prepareCandidate("), "the route calls nothing that drafts a post");
  assert.match(route, /step === "search-submit"/, "the paid search step still works");
  assert.match(route, /step === "score"/, "scoring still works");
});

// ------------------------------------------ Discord: kept, but not on display

test("the Discord publisher is preserved in the backend", () => {
  const publisher = read("lib/publishers/discord.ts");
  assert.match(publisher, /readonly platform = "discord"/, "the publisher still exists");
  assert.match(read("lib/publishers/types.ts"), /platform/, "the abstraction is intact");
  assert.match(read("lib/campaign.ts"), /DiscordPublisher/, "the launch path still resolves it");
  assert.match(read("prisma/schema.prisma"), /model Publication/, "records still exist");
});

test("Discord is not part of the customer-facing growth flow", () => {
  const ui = read(UI);
  assert.ok(!/discord/i.test(ui), "no Discord surface remains in the workspace");
  assert.ok(!ui.includes("/api/campaigns/launch"), "the workspace never calls the publish route");
});

// ------------------------------------------------------ untouched neighbours

test("Google Ads and search discovery are unaffected", () => {
  const ui = read(UI);
  assert.match(ui, /<ProjectAutopilot/, "the Google Ads block still renders");
  assert.match(ui, /"Find my audience"/, "the discovery CTA still exists");
  assert.match(ui, /No searches run yet/, "the empty state still says nothing has run");
  assert.match(ui, /Preview with demo data/, "the demo preview is still available");
  assert.match(read("lib/discovery/web.ts"), /DATAFORSEO_LOGIN/, "DataForSEO is still wired");
  assert.match(read("lib/discovery/status.ts"), /approval_pending/, "Reddit status is unchanged");
});
