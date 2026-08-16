import type { ExecutionEvent } from "../googleAds/execution";

/**
 * The shape of an execution as the browser is allowed to see it.
 *
 * Shared by every route that returns one, so there is a single place where the
 * boundary is decided. What is absent matters more than what is present: no
 * customer id, no manager id, no resource names, no credential — nothing that
 * would let a visitor address the advertising account themselves.
 */

export type ExecutionRow = {
  campaignId: string | null;
  campaignName: string | null;
  status: string | null;
  channelType: string | null;
  channelSubType: string | null;
  appId: string | null;
  dailyBudgetMicros: number | null;
  events: string | null;
  completedAt: Date | null;
  lastVerifiedAt: Date | null;
};

export function toProof(row: ExecutionRow) {
  let events: ExecutionEvent[] = [];
  try {
    events = row.events ? (JSON.parse(row.events) as ExecutionEvent[]) : [];
  } catch {
    events = [];
  }
  return {
    campaignId: row.campaignId,
    campaignName: row.campaignName,
    status: row.status,
    channelType: row.channelType,
    channelSubType: row.channelSubType,
    appId: row.appId,
    dailyBudgetMicros: row.dailyBudgetMicros,
    verifiedByReadBack: true,
    completedAt: row.completedAt?.toISOString() ?? null,
    lastVerifiedAt: row.lastVerifiedAt?.toISOString() ?? null,
    events,
  };
}
