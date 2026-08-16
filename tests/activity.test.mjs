// ACTIVE vs HISTORY. The rule decides what the customer sees on the dashboard
// and must not drift: it is evaluated on the server clock at fetch time, with
// no background job involved.
import test from "node:test";
import assert from "node:assert/strict";

const { classifyProject, reactivatesOnActivity, INACTIVE_AFTER_MS } = await import(
  "../.tmp-test/activity.js"
);

const NOW = Date.parse("2026-08-16T12:00:00.000Z");
const agoMs = (ms) => new Date(NOW - ms).toISOString();
const hours = (h) => h * 60 * 60 * 1000;

test("the inactivity window is 48 hours", () => {
  assert.equal(INACTIVE_AFTER_MS, hours(48));
});

test("a freshly created project is active", () => {
  const p = { lastActivityAt: agoMs(0), archivedAt: null };
  assert.deepEqual(classifyProject(p, NOW), { status: "active", historyReason: null });
});

test("a project worked on yesterday is still active", () => {
  const p = { lastActivityAt: agoMs(hours(30)), archivedAt: null };
  assert.equal(classifyProject(p, NOW).status, "active");
});

test("a project untouched for more than 48 hours moves to history", () => {
  const p = { lastActivityAt: agoMs(hours(72)), archivedAt: null };
  assert.deepEqual(classifyProject(p, NOW), { status: "history", historyReason: "inactive" });
});

test("the 48-hour boundary is deterministic", () => {
  // Exactly at the threshold counts as inactive; a second under it does not.
  assert.equal(
    classifyProject({ lastActivityAt: agoMs(hours(48)), archivedAt: null }, NOW).status,
    "history"
  );
  assert.equal(
    classifyProject({ lastActivityAt: agoMs(hours(48) - 1000), archivedAt: null }, NOW).status,
    "active"
  );
});

test("a hand-archived project is history however recently it was used", () => {
  const p = { lastActivityAt: agoMs(0), archivedAt: agoMs(hours(1)) };
  assert.deepEqual(classifyProject(p, NOW), { status: "history", historyReason: "archived" });
});

test("archiving outranks inactivity in the stated reason", () => {
  const p = { lastActivityAt: agoMs(hours(100)), archivedAt: agoMs(hours(2)) };
  assert.equal(classifyProject(p, NOW).historyReason, "archived");
});

test("restoring clears the archive and counts as fresh activity", () => {
  // What PATCH { action: "restore" } writes.
  const restored = { archivedAt: null, lastActivityAt: new Date(NOW).toISOString() };
  assert.deepEqual(classifyProject(restored, NOW), { status: "active", historyReason: null });
});

test("owner activity revives a time-aged project but not a filed one", () => {
  const aged = { lastActivityAt: agoMs(hours(72)), archivedAt: null };
  const filed = { lastActivityAt: agoMs(hours(72)), archivedAt: agoMs(hours(50)) };

  assert.equal(reactivatesOnActivity(aged), true, "an aged project comes back on its own");
  assert.equal(reactivatesOnActivity(filed), false, "a deliberate filing is only undone by Restore");

  // Opening either one writes lastActivityAt; only the aged one returns.
  const touched = (p) => ({ ...p, lastActivityAt: new Date(NOW).toISOString() });
  assert.equal(classifyProject(touched(aged), NOW).status, "active");
  assert.equal(classifyProject(touched(filed), NOW).status, "history");
  assert.equal(classifyProject(touched(filed), NOW).historyReason, "archived");
});

test("a project with no timestamp is shown rather than hidden", () => {
  assert.equal(classifyProject({}, NOW).status, "active");
  assert.equal(classifyProject({ lastActivityAt: "not a date" }, NOW).status, "active");
  assert.equal(classifyProject({ lastActivityAt: null, archivedAt: null }, NOW).status, "active");
});

test("Date and ISO string inputs classify identically", () => {
  const iso = agoMs(hours(72));
  assert.deepEqual(
    classifyProject({ lastActivityAt: iso }, NOW),
    classifyProject({ lastActivityAt: new Date(iso) }, NOW)
  );
});
