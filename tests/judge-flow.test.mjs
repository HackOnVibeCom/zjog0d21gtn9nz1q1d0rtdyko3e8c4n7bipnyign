// THE PUBLIC JUDGE FLOW.
//
// A stranger with no account drives real providers and one real Google Ads
// mutation from this page, so the guarantees worth pinning are: what the server
// accepts, what order it enforces, what it refuses to do twice, and what it
// refuses to send to a browser.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

process.env.DATABASE_URL ??= "postgresql://test:test@127.0.0.1:5432/test";

const { parseStoreUrl, DEMO_LIMITS, googleExecutionEnabled, toPublicRun, publicListing } =
  await import("../.tmp-test/demo/run.js");

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const RUN_ROUTE = "app/api/demo/run/route.ts";
const ADVANCE = "app/api/demo/run/advance/route.ts";
const EXECUTE = "app/api/demo/execute/route.ts";
const UI = "components/app/DemoWorkspace.tsx";
const LIB = "lib/demo/run.ts";

// ------------------------------------------------------------- the pasted URL

test("any valid Google Play link is accepted and normalised", () => {
  const plain = parseStoreUrl("https://play.google.com/store/apps/details?id=com.example.app");
  assert.equal(plain.appId, "com.example.app");
  assert.equal(plain.storeUrl, "https://play.google.com/store/apps/details?id=com.example.app");

  // Locale and tracking parameters are dropped rather than trusted.
  const localised = parseStoreUrl(
    "https://play.google.com/store/apps/details?id=com.example.app&hl=en_GB&gl=US&referrer=x"
  );
  assert.equal(localised.appId, "com.example.app");
  assert.equal(localised.storeUrl, plain.storeUrl, "the stored URL is rebuilt, not echoed");
});

test("anything that is not a Google Play app link is refused", () => {
  for (const bad of [
    "",
    "not a url",
    "http://play.google.com/store/apps/details?id=com.example.app", // not https
    "https://evil.example/store/apps/details?id=com.example.app", // wrong host
    "https://play.google.com/store/apps/details", // no package
    "https://play.google.com/store/apps/details?id=../../etc", // not a package id
    "https://play.google.com/store/search?q=safety", // wrong path
    "https://user:pass@play.google.com/store/apps/details?id=com.example.app",
  ]) {
    assert.throws(() => parseStoreUrl(bad), `${bad || "(empty)"} must be refused`);
  }
});

test("no application is hardcoded into the public flow", () => {
  for (const f of [RUN_ROUTE, ADVANCE, EXECUTE, UI]) {
    assert.ok(
      !read(f).includes("com.iwaskidnapped"),
      `${f} must not special-case any particular app`
    );
  }
  assert.ok(!read(EXECUTE).includes("DEMO_APP_ID"), "execution promotes the researched app");
  assert.match(read(EXECUTE), /const appId = run\.appId/, "the app comes from the judge's run");
});

// ------------------------------------------------------------ stage ordering

test("each stage refuses to run before the one before it produced something", () => {
  const src = read(ADVANCE);
  // Every guard names the state it requires and stops with a conflict rather
  // than inventing the missing input.
  for (const [step, guard] of [
    ["import-poll", "no_task"],
    ["analyze", "no_listing"],
    ["discover-submit", "no_queries"],
    ["discover-poll", "no_tasks"],
    ["discover-score", "no_results"],
    ["propose", "no_evidence"],
  ]) {
    const block = src.slice(src.indexOf(`step === "${step}"`));
    assert.ok(block.includes(guard), `${step} must refuse to run without its input (${guard})`);
  }
});

test("the research pipeline never mutates Google Ads", () => {
  const src = read(ADVANCE);
  for (const forbidden of ["executeAppCampaign", "campaigns:mutate", "campaignBudgets:mutate"]) {
    assert.ok(!src.includes(forbidden), `research must not reach ${forbidden}`);
  }
});

test("a failed stage stops the run instead of falling back", () => {
  const src = read(ADVANCE);
  assert.match(src, /failRun\(/, "the route records the failure rather than continuing");
  // No prepared fixtures may stand in for a live provider.
  for (const fixture of ["demoCommunities", "DISCOVER", "UNDERSTAND", "PROMOTE"]) {
    assert.ok(!src.includes(fixture), `a live failure must not fall back to ${fixture}`);
  }
  const lib = read("lib/demo/run.ts");
  assert.match(lib, /stage: "failed"/, "the failed stage is persisted, so a refresh still shows it");
});

test("the browser cannot mark a stage complete on its own", () => {
  const ui = read(UI);
  assert.match(
    ui,
    /Stage status is derived from what the server persisted, never from a timer/,
    "the derivation is stated"
  );
  assert.match(ui, /complete\[key\]/, "completion reads persisted run state");
  assert.ok(!/setTimeout\([^)]*setRun/.test(ui), "no timer may advance the run");
});

// --------------------------------------------------------------- concurrency

test("one pipeline per session, enforced by a database lock", () => {
  const lib = read(LIB);
  assert.match(lib, /export async function claimStage/, "every step takes a lock");
  assert.match(lib, /activeAt: \{ gte: new Date\(now - STAGE_LOCK_MS\) \}/, "a live run blocks Start");
  assert.match(lib, /code: "busy"/);
  const advance = read(ADVANCE);
  const handler = advance.slice(advance.indexOf("export async function POST"));
  assert.ok(
    handler.indexOf("claimStage(") < handler.indexOf('step === "import-submit"'),
    "the lock is taken before any provider call"
  );
});

test("a run can only be driven by the session that owns it", () => {
  const lib = read(LIB);
  const fn = lib.slice(lib.indexOf("export async function claimStage"));
  assert.match(fn, /where: \{ id: runId, sessionId \}/, "the run is scoped to its session");
  const current = lib.slice(lib.indexOf("export async function currentRun"));
  assert.match(current, /where: \{ sessionId \}/, "a session only ever sees its own run");
  assert.match(read(RUN_ROUTE), /currentRun\(session\.id\)/, "the route passes its own session");
});

// -------------------------------------------------------------- rate limits

test("research limits are configurable, counted in the database and safe by default", () => {
  assert.equal(DEMO_LIMITS.researchRunsPerSession, 5);
  assert.equal(DEMO_LIMITS.researchCooldownSeconds, 15);
  assert.equal(DEMO_LIMITS.globalResearchRunsPerHour, 60);
  assert.equal(DEMO_LIMITS.googleExecutionsPerSession, 1);
  assert.equal(DEMO_LIMITS.globalGoogleExecutionsPerHour, 12);

  const lib = read(LIB);
  for (const counted of ["prisma.demoRun.count", "prisma.demoRun.findFirst"]) {
    assert.ok(lib.includes(counted), `${counted} — limits are counted, not remembered in memory`);
  }
  assert.ok(!/new Map\(|globalThis\.\w+Counter/.test(lib), "no in-memory counter a cold start resets");
});

test("the cooldown, session cap and global cap each have their own verdict", () => {
  const lib = read(LIB);
  const fn = lib.slice(lib.indexOf("export async function checkStartAllowed"));
  for (const code of ["busy", "cooldown", "session_cap", "global_cap"]) {
    assert.ok(fn.includes(`code: "${code}"`), `${code} must be its own outcome`);
  }
});

// ------------------------------------------------------- Google Ads execution

test("execution needs a second, explicit request after a proposal exists", () => {
  const exec = read(EXECUTE);
  assert.match(exec, /run\.stage !== "proposed"/, "there must be a proposal to approve");
  assert.match(exec, /code: "no_proposal"/);
  const ui = read(UI);
  assert.match(ui, /Execute TEST campaign/, "the approval is a separate button");
  assert.ok(
    ui.indexOf("Campaign proposal") < ui.indexOf("Execute TEST campaign"),
    "the proposal is shown before the button that acts on it"
  );
});

test("public execution stays TEST-only and can be switched off", () => {
  const exec = read(EXECUTE);
  assert.match(exec, /testAccountOnly: true/, "the engine is called in test-only mode");
  assert.match(exec, /new DemoServiceAccountAuthProvider\(\)/, "never a customer OAuth credential");
  assert.ok(!exec.includes("UserOAuthAuthProvider"), "production credentials are unreachable here");
  assert.match(exec, /googleExecutionEnabled\(\)/, "a kill switch guards the mutation");
  assert.equal(googleExecutionEnabled(), true, "enabled by default when unset");
  process.env.DEMO_GOOGLE_EXECUTION_ENABLED = "false";
  assert.equal(googleExecutionEnabled(), false, "one variable stops every public mutation");
  delete process.env.DEMO_GOOGLE_EXECUTION_ENABLED;

  const engine = read("lib/googleAds/execution.ts");
  assert.match(engine, /assertTestAccount/, "Google itself is asked whether the account is a test");
  assert.match(engine, /status: "PAUSED"/);
  assert.ok(!engine.includes('"ENABLED"'), "no path can request an enabled campaign");
});

test("one execution per session survives races and caps", () => {
  const exec = read(EXECUTE);
  const handler = exec.slice(exec.indexOf("export async function POST"));
  const order = ["existingExecution(", "checkExecutionAllowed(", "claimIsOurs(", "executeAppCampaign("];
  for (let i = 1; i < order.length; i++) {
    assert.ok(
      handler.indexOf(order[i - 1]) < handler.indexOf(order[i]),
      `${order[i - 1]} must run before ${order[i]}`
    );
  }
  assert.match(handler, /globalRecent >= DEMO_LIMITS\.globalGoogleExecutionsPerHour/);
  assert.match(handler, /prisma\.googleAdsExecution\.count/, "the global cap is counted in the database");
});

test("a proof is bound to the run that produced it", () => {
  assert.match(read(EXECUTE), /prisma\.demoRun\.update\(\{ where: \{ id: run\.id \}/);
  const ui = read(UI);
  assert.match(ui, /proofForThisRun/, "the page knows whether the proof is for the current app");
  assert.match(ui, /Previous TEST execution/, "an older proof is labelled, never re-presented");
});

test("verify again asks Google rather than reading our records", () => {
  const verify = read("app/api/demo/verify/route.ts");
  assert.match(verify, /readBackCampaign/, "a fresh provider query");
  const ui = read(UI);
  assert.match(ui, /Verify with Google again/);
  assert.match(ui, /verified just\s*\n?\s*now at/, "the timestamp describes the new verification");
});

// ------------------------------------------------------------------ security

test("the public run DTO carries no credential or infrastructure identity", () => {
  const dto = toPublicRun({
    id: "r1",
    appId: "com.example.app",
    storeUrl: "https://play.google.com/store/apps/details?id=com.example.app",
    stage: "proposed",
    failedAt: null,
    errorCode: null,
    listing: JSON.stringify({ listing: { name: "X" } }),
    analysis: null,
    discovery: null,
    proposal: null,
    executionId: "exec-1",
    createdAt: new Date(),
  });
  const flat = JSON.stringify(dto);
  for (const secret of [
    "customerId",
    "managerCustomerId",
    "loginCustomerId",
    "accessToken",
    "refreshToken",
    "developerToken",
    "privateKey",
    "gserviceaccount",
    "DATABASE_URL",
  ]) {
    assert.ok(!flat.includes(secret), `${secret} must never reach the browser`);
  }
  assert.equal(dto.hasExecution, true, "the browser learns only that an execution exists");
  assert.ok(!("executionId" in dto), "not which row it is");
});

test("the listing DTO is an allowlist, not a filtered provider object", () => {
  const shaped = publicListing({
    provider: "google-play",
    appId: "com.example.app",
    storeUrl: "https://play.google.com/store/apps/details?id=com.example.app",
    name: "Example",
    category: "Tools",
    developer: "Dev",
    rating: 4.5,
    reviewsCount: 1200,
    installs: "1,000,000+",
    version: "1.2.3",
    retrievedAt: new Date().toISOString(),
  });
  for (const dropped of ["rating", "reviewsCount", "installs", "version", "provider"]) {
    assert.ok(!(dropped in shaped), `${dropped} is not part of the public shape`);
  }
  assert.equal(shaped.appId, "com.example.app");
});

test("no secret is read into the browser bundle", () => {
  const ui = read(UI);
  assert.ok(!/process\.env\.(?!NEXT_PUBLIC_)/.test(ui), "the page reads no server environment");
  for (const s of ["DATAFORSEO", "OPENAI", "GOOGLE_ADS", "AUTH_SECRET"]) {
    assert.ok(!ui.includes(s), `${s} must not appear in a client component`);
  }
});

// ------------------------------------------------------------ product shape

test("the judge flow is understand, plan, discover, execute — and nothing else", () => {
  const ui = read(UI);
  assert.match(ui, /App import/);
  assert.match(ui, /Understand/);
  assert.match(ui, /Plan/);
  assert.match(ui, /Market &amp; audience intelligence/);
  assert.match(ui, /Campaign proposal/);
  for (const gone of ["Measure", "tracked clicks", "Discord", "Prepare post", "Suggested post"]) {
    assert.ok(!ui.includes(gone), `${gone} must not appear in the judge flow`);
  }
});

test("the demo needs no account", () => {
  for (const f of [RUN_ROUTE, ADVANCE, EXECUTE]) {
    const src = read(f);
    assert.ok(!src.includes("currentUserId"), `${f} must not resolve a signed-in user`);
    assert.ok(!src.includes("ownedProjectOr"), `${f} must not require a project`);
    assert.match(src, /getSession\(/, `${f} uses the anonymous demo session`);
    assert.match(src, /readSessionId\(req\.cookies\.get\(DEMO_COOKIE\)/, `${f} reads the signed cookie`);
  }
});

// ------------------------------------- regressions from the correctness pass

test("a new run is not born locked, so its own first step can claim it", () => {
  const lib = read(LIB);
  const create = lib.slice(lib.indexOf("export async function createRun"));
  assert.match(create, /activeAt: null/, "creation must not take the stage lock");
  assert.ok(
    !/activeAt: new Date\(\)/.test(create.slice(0, create.indexOf("}"))),
    "a fresh run must not block import-submit"
  );
  // The Start gate must accept a claim on a run it just created.
  const claim = lib.slice(lib.indexOf("export async function claimStage"));
  assert.match(claim, /\{ activeAt: null \}/, "an unlocked run is claimable");
});

test("the stage lock is a conditional write, not a read followed by a write", () => {
  const lib = read(LIB);
  const claim = lib.slice(lib.indexOf("export async function claimStage"));
  assert.match(claim, /updateMany\(/, "the claim is one atomic statement");
  assert.match(claim, /claimed\.count !== 1/, "losing the race is detected by the row count");
  const guardAt = claim.indexOf("updateMany(");
  const readAt = claim.indexOf("findFirst", guardAt);
  assert.ok(readAt > guardAt, "the row is re-read after the claim, never trusted before it");
});

test("two simultaneous Starts cannot leave two live pipelines", () => {
  const lib = read(LIB);
  assert.match(lib, /export async function runIsOurs/, "a Start race is settled after creation");
  assert.match(lib, /orderBy: \[\{ createdAt: "asc" \}, \{ id: "asc" \}\]/, "both order identically");
  assert.match(lib, /export async function discardRun/, "the loser stands down");
  const route = read(RUN_ROUTE);
  const handler = route.slice(route.indexOf("export async function POST"));
  assert.ok(
    handler.indexOf("createRun(") < handler.indexOf("runIsOurs("),
    "the row is the claim, so it is created before the winner is decided"
  );
  assert.match(handler, /discardRun\(/, "the losing run is removed rather than left active");
});

test("the completed listing reaches the browser as a flat allowlist", () => {
  const withExtras = toPublicRun({
    id: "r",
    appId: "com.example.app",
    storeUrl: "https://play.google.com/store/apps/details?id=com.example.app",
    stage: "analyzing",
    failedAt: null,
    errorCode: null,
    // Exactly what the advance route persists: the public shape, already flat.
    listing: JSON.stringify(
      publicListing({
        provider: "google-play",
        appId: "com.example.app",
        storeUrl: "https://play.google.com/store/apps/details?id=com.example.app",
        name: "Example",
        category: "Tools",
        rating: 4.6,
        reviewsCount: 900,
        installs: "500,000+",
        version: "9.9.9",
        retrievedAt: new Date().toISOString(),
      })
    ),
    analysis: null,
    discovery: null,
    proposal: null,
    executionId: null,
    createdAt: new Date(),
  });
  assert.equal(withExtras.listing?.name, "Example", "the UI reads run.listing.name directly");
  assert.equal(withExtras.listing?.appId, "com.example.app");
  const flat = JSON.stringify(withExtras.listing);
  for (const dropped of ["rating", "reviewsCount", "installs", "version", "provider"]) {
    assert.ok(!flat.includes(dropped), `${dropped} must not survive into the browser`);
  }
  assert.ok(!flat.includes('"listing"'), "no storage envelope reaches the browser");
});

test("import task metadata never reaches the browser", () => {
  const midImport = toPublicRun({
    id: "r",
    appId: "com.example.app",
    storeUrl: "https://play.google.com/store/apps/details?id=com.example.app",
    stage: "importing",
    failedAt: null,
    errorCode: null,
    // While the lookup is queued the column holds the provider task.
    listing: JSON.stringify({ task: { provider: "google-play", taskId: "abc123", appId: "x" } }),
    analysis: null,
    discovery: null,
    proposal: null,
    executionId: null,
    createdAt: new Date(),
  });
  assert.equal(midImport.listing, null, "a queued lookup exposes nothing");
  assert.ok(!JSON.stringify(midImport).includes("taskId"), "no provider task id leaks");

  const advance = read(ADVANCE);
  assert.match(
    advance,
    /listing: JSON\.stringify\(publicListing\(result\.metadata\)\)/,
    "the task envelope is replaced by the public shape, not merged with it"
  );
});

test("a second app cannot spend an execution the session already used", () => {
  const exec = read(EXECUTE);
  const handler = exec.slice(exec.indexOf("export async function POST"));
  assert.ok(
    handler.indexOf("currentRun(session.id)") < handler.indexOf("existingExecution("),
    "which run is asking must be known before any proof is returned"
  );
  assert.match(handler, /run\.executionId === already\.id/, "only its own run gets the proof back");
  assert.match(handler, /code: "session_execution_used"/, "another run gets a limit result");
  assert.ok(
    !/reused: true[\s\S]{0,200}session_execution_used/.test(handler),
    "a second app must never receive the first app's campaign as its result"
  );
});

test("a spent execution removes the action instead of offering a refusal", () => {
  const ui = read(UI);
  assert.match(ui, /const executionSpent = Boolean\(proof\) && !proofForThisRun/);
  assert.match(ui, /TEST execution already used in this demo session/);
  const branch = ui.slice(ui.indexOf("{executionSpent ?"));
  assert.ok(
    branch.indexOf("Execute TEST campaign") > branch.indexOf("executionSpent"),
    "the button lives in the other branch"
  );
});

test("the timeline reports one model call as one operation", () => {
  const ui = read(UI);
  const groups = ui.slice(ui.indexOf("const GROUPS = ["), ui.indexOf("] as const;", ui.indexOf("const GROUPS = [")));
  assert.match(groups, /Understand & plan/, "understanding and planning share one stage");
  assert.ok(!/title: "Plan"/.test(groups), "no separate Plan operation is claimed");
  assert.equal((groups.match(/key:/g) ?? []).length, 4, "four stages for four real operations");
  const analyze = (ui.match(/step: "analyze"/g) ?? []).length;
  assert.equal(analyze, 1, "there is exactly one analyze call");
});

// ---------------------------------------- hardening: races and step replay

test("a finished run does not defeat the next one after the cooldown", () => {
  const lib = read(LIB);
  const fn = lib.slice(lib.indexOf("export async function runIsOurs"));
  assert.match(
    fn,
    /stage: \{ notIn: \["proposed", "failed"\] \}/,
    "a proposed or failed run has left the race"
  );
  // The race still exists for genuinely unfinished runs.
  assert.match(fn, /orderBy: \[\{ createdAt: "asc" \}, \{ id: "asc" \}\]/);
  assert.match(fn, /rows\.length <= 1 \|\| rows\[0\]\.id === runId/);

  // And the Start gate agrees: only unfinished work counts as in progress.
  const gate = lib.slice(lib.indexOf("export async function checkStartAllowed"));
  assert.match(gate, /stage: \{ notIn: \["proposed", "failed"\] \}/);
  assert.ok(DEMO_LIMITS.researchCooldownSeconds <= 20, "the cooldown stays short");
});

test("the pipeline order is a stored fact, not the caller's word", async () => {
  const { NEXT_STEP } = await import("../.tmp-test/demo/run.js");
  assert.deepEqual(NEXT_STEP, {
    "import-submit": "import-poll",
    "import-poll": "analyze",
    analyze: "discover-queries",
    "discover-queries": "discover-submit",
    "discover-submit": "discover-poll",
    "discover-poll": "discover-score",
    "discover-score": "propose",
    propose: "complete",
  });
  assert.match(read("prisma/schema.prisma"), /nextStep\s+String\s+@default\("import-submit"\)/);
});

test("an out-of-order or replayed step is refused before any provider call", () => {
  const src = read(ADVANCE);
  const handler = src.slice(src.indexOf("export async function POST"));
  const gateAt = handler.indexOf("run.nextStep !== step");
  assert.ok(gateAt > 0, "the run's expected step is checked");
  assert.match(handler.slice(gateAt, gateAt + 400), /code: "invalid_step"/);

  // Nothing external may be reached before the gate.
  const before = handler.slice(0, gateAt);
  for (const provider of [
    "submitLookup",
    "pollLookup",
    "analyzeApp",
    "generateDiscoveryQueries",
    "submitSearches",
    "pollSearches",
    "scoreWebCandidates",
  ]) {
    assert.ok(!before.includes(provider), `${provider} must not run before the order check`);
  }
});

test("a successful step advances the run; a pending poll does not", () => {
  const src = read(ADVANCE);
  assert.match(
    src,
    /nextStep: NEXT_STEP\[step\] \?\? "complete"/,
    "only a completed step moves the run on"
  );
  // The two pending branches release the lock and return without done().
  for (const step of ["import-poll", "discover-poll"]) {
    const block = src.slice(src.indexOf(`step === "${step}"`), src.indexOf(`step === "${step}"`) + 900);
    assert.match(block, /pending: true/, `${step} can report a queued provider task`);
    const pendingAt = block.indexOf("pending: true");
    assert.ok(
      !block.slice(0, pendingAt).includes("nextStep:"),
      `${step} must keep waiting for itself while pending`
    );
  }
});

test("every paid step can run at most once per run", () => {
  const src = read(ADVANCE);
  // Each of these consumes a paid provider call, so each must be reachable only
  // while it is the awaited step — proven by the single shared gate above.
  for (const step of [
    "import-submit",
    "analyze",
    "discover-queries",
    "discover-submit",
    "discover-score",
    "propose",
  ]) {
    assert.equal(
      (src.match(new RegExp(`step === "${step}"`, "g")) ?? []).length,
      1,
      `${step} has exactly one call site`
    );
  }
  assert.equal(
    (src.match(/run\.nextStep !== step/g) ?? []).length,
    1,
    "one gate guards them all"
  );
});
