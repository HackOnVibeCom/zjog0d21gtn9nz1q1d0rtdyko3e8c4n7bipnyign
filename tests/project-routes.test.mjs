// Which routes are allowed to record owner activity, and what deleting a
// project takes with it. These are read off the real source so the rules
// cannot quietly change: they are product guarantees, not implementation
// details.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

const discover = read("app/api/projects/[id]/discover/route.ts");
const analytics = read("app/api/projects/[id]/analytics/route.ts");
const project = read("app/api/projects/[id]/route.ts");
const projects = read("app/api/projects/route.ts");
const launch = read("app/api/campaigns/launch/route.ts");
const redirect = read("app/r/[slug]/route.ts");
const schema = read("prisma/schema.prisma");

// ------------------------------------------------------- activity semantics

test("deliberate owner work records activity", () => {
  assert.match(discover, /touchProject\(id\)/, "discovery counts");
  assert.match(launch, /touchProject\(/, "publishing counts");
  assert.match(project, /action === "touch"[\s\S]*lastActivityAt/, "opening the workspace counts");
});

test("the automated search poll does not count as owner activity", () => {
  // A long provider queue is the browser waiting, not the owner working.
  assert.match(discover, /body\?\.step !== "search-poll"[\s\S]{0,80}touchProject/);
});

test("analytics polling never records activity", () => {
  // This route is hit every 3 seconds while a project page is open; if it
  // touched the project, nothing would ever reach History.
  assert.doesNotMatch(analytics, /touchProject|lastActivityAt/);
});

test("a visitor clicking a tracking link never revives the owner's project", () => {
  assert.doesNotMatch(redirect, /touchProject|lastActivityAt/);
});

test("opening a project cannot clear a manual archive", () => {
  const touchBranch = project.slice(project.indexOf('action === "touch"'));
  const clause = touchBranch.slice(0, touchBranch.indexOf("\n"));
  assert.doesNotMatch(clause, /archivedAt/, "touch must not write archivedAt");
  assert.match(project, /action === "restore"[\s\S]{0,120}archivedAt: null/);
});

// ------------------------------------------------------------ ownership

test("every project mutation is ownership-gated", () => {
  for (const [label, src] of [
    ["PATCH/DELETE", project],
    ["discover", discover],
    ["launch", launch],
  ]) {
    assert.match(src, /ownedProjectOr/, `${label} must gate on ownership`);
    assert.match(src, /isDenied\(gate\)/, `${label} must return the denial`);
  }
  // The gate itself scopes by the signed-in user, so another user's id 404s.
  const ownership = read("lib/ownership.ts");
  assert.match(ownership, /findFirst\(\{\s*where: \{ id: projectId, userId \}/);
});

test("the delete route refuses before touching data", () => {
  const del = project.slice(project.indexOf("export async function DELETE"));
  const gateAt = del.indexOf("ownedProjectOr");
  const deleteAt = del.indexOf("prisma.project.delete");
  assert.ok(gateAt >= 0 && deleteAt > gateAt, "ownership is checked before deletion");
});

test("the dashboard list is scoped and classified server-side", () => {
  assert.match(projects, /where: \{ userId \}/);
  assert.match(projects, /classifyProject\(p, now\)/);
});

// --------------------------------------------------------- delete integrity

test("deleting a project cannot leave orphans", () => {
  // Every child of Project — and every grandchild — cascades, so one delete
  // clears analysis, campaigns, publications, tracking links, click events
  // and discovered communities.
  const relation = (model, parent) => {
    const block = schema.slice(schema.indexOf(`model ${model} {`));
    const body = block.slice(0, block.indexOf("\n}"));
    const line = body.split("\n").find((l) => l.includes(`@relation(fields: [${parent}]`));
    return line ?? "";
  };

  for (const [model, fk] of [
    ["Analysis", "projectId"],
    ["Campaign", "projectId"],
    ["CommunityCandidate", "projectId"],
    ["Publication", "campaignId"],
    ["TrackingLink", "campaignId"],
    ["TrackingEvent", "trackingLinkId"],
  ]) {
    assert.match(
      relation(model, fk),
      /onDelete: Cascade/,
      `${model}.${fk} must cascade or deletion leaves orphans`
    );
  }
});

test("the project activity fields exist in the schema", () => {
  assert.match(schema, /lastActivityAt DateTime\s+@default\(now\(\)\)/);
  assert.match(schema, /archivedAt\s+DateTime\?/);
});
