/**
 * ACTIVE vs HISTORY — when a project is still being worked on.
 *
 * The rule is deliberate about whose activity counts. `lastActivityAt` means
 * "the OWNER did deliberate growth work here", which is not the same as "the
 * row was touched":
 *
 *   COUNTS      creating a project, opening its workspace, running discovery,
 *               collecting a paid run, preparing a post, launching a campaign
 *   NEVER       the 3-second analytics poll (it would keep every project
 *               permanently active), the discovery search-poll (automated),
 *               and visitors clicking tracking links — a stranger's click is
 *               not the owner returning to work
 *
 * No background job is involved: a project falls into History simply because
 * time passed, evaluated when the dashboard asks.
 */

export const INACTIVE_AFTER_MS = 48 * 60 * 60 * 1000;

export type ProjectStatus = "active" | "history";
export type HistoryReason = "archived" | "inactive";

export type ActivityFields = {
  lastActivityAt?: Date | string | null;
  archivedAt?: Date | string | null;
};

const time = (v: Date | string | null | undefined): number | null => {
  if (!v) return null;
  const t = v instanceof Date ? v.getTime() : Date.parse(v);
  return Number.isFinite(t) ? t : null;
};

/**
 * Where a project belongs right now.
 *
 * A hand-archived project stays in History however recently it was used —
 * filing something away is a decision, and the product does not quietly undo
 * the customer's organisation.
 */
export function classifyProject(
  project: ActivityFields,
  now: number = Date.now()
): { status: ProjectStatus; historyReason: HistoryReason | null } {
  if (time(project.archivedAt) !== null) {
    return { status: "history", historyReason: "archived" };
  }
  const last = time(project.lastActivityAt);
  // A project with no usable timestamp is treated as current rather than
  // being hidden away on a technicality.
  if (last === null) return { status: "active", historyReason: null };

  return now - last >= INACTIVE_AFTER_MS
    ? { status: "history", historyReason: "inactive" }
    : { status: "active", historyReason: null };
}

/** True when owner activity should move a project back into Active by itself. */
export function reactivatesOnActivity(project: ActivityFields): boolean {
  // Only the time-aged ones. Manual archiving is undone only by Restore.
  return time(project.archivedAt) === null;
}
