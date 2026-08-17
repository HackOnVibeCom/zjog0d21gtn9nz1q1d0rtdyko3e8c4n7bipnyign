import { prisma } from "../prisma";
import { GooglePlayMetadataProvider } from "../store/googleplay";
import { DemoServiceAccountAuthProvider } from "./auth";
import {
  findCampaignByReference,
  readBackCampaign,
  type ExecutionStage,
} from "./execution";
import { demoServiceAccountToken } from "./serviceAccount";

/**
 * The authenticated project's own Google Ads test run.
 *
 * Same engine, same isolated TEST advertiser and same server-side ceilings as
 * the public sandbox — the only difference is who owns the run and which app it
 * promotes. Keeping this beside the demo helpers rather than inside them means
 * the public path cannot be loosened by accident while extending this one.
 */

/** Limits for signed-in runs. One campaign per project is the important one. */
export const PROJECT_LIMITS = {
  /** Campaigns a single project may ever produce on this path. */
  perProject: 1,
  /** Campaigns one account may start in the rolling window. */
  perUser: 5,
  perUserWindowMs: 60 * 60 * 1000,
  /** Test executions the whole deployment may run per day, across everyone. */
  globalPerDay: 40,
} as const;

/**
 * How long a started run is presumed to still be in flight.
 *
 * Past this, the run is not forgiven and it is not deleted — it becomes
 * *ambiguous*, and ambiguity is settled by asking Google, never by assuming.
 */
export const PENDING_GRACE_MS = 3 * 60 * 1000;

export type RunVerdict =
  | { allowed: true }
  | { allowed: false; reason: "project_used" | "user_rate" | "global_cap" };

/**
 * The Google Play package this project is about.
 *
 * Derived on the server from the store URL the project was created with, using
 * the same validator the importer uses. The browser never supplies a package
 * id, so it can never point an execution at an app that is not its own.
 */
export function packageIdForProject(storeUrl: string | null | undefined): string | null {
  if (!storeUrl) return null;
  try {
    return new GooglePlayMetadataProvider().extractAppId(new URL(storeUrl));
  } catch {
    return null;
  }
}

/** The successful run this project already owns, if any. */
export async function existingProjectExecution(projectId: string) {
  return prisma.googleAdsExecution.findFirst({
    where: { projectId, mode: "demo_service_account", result: "succeeded" },
    orderBy: { startedAt: "desc" },
  });
}

/** May this project start a Google Ads test execution? */
export async function checkProjectExecutionAllowed(
  projectId: string,
  userId: string
): Promise<RunVerdict> {
  const mine = await prisma.googleAdsExecution.count({
    where: {
      projectId,
      mode: "demo_service_account",
      OR: [
        { result: "succeeded" },
        { result: "pending", startedAt: { gte: new Date(Date.now() - PENDING_GRACE_MS) } },
      ],
    },
  });
  if (mine >= PROJECT_LIMITS.perProject) return { allowed: false, reason: "project_used" };

  const recent = await prisma.googleAdsExecution.count({
    where: {
      userId,
      mode: "demo_service_account",
      startedAt: { gte: new Date(Date.now() - PROJECT_LIMITS.perUserWindowMs) },
    },
  });
  if (recent >= PROJECT_LIMITS.perUser) return { allowed: false, reason: "user_rate" };

  const today = await prisma.googleAdsExecution.count({
    where: {
      mode: "demo_service_account",
      startedAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
    },
  });
  if (today >= PROJECT_LIMITS.globalPerDay) return { allowed: false, reason: "global_cap" };

  return { allowed: true };
}

/**
 * Is this row the project's one execution?
 *
 * The allowance check and the row that follows it are two statements, and two
 * clicks can land between them. The row itself is the claim: both requests
 * order candidates identically, and the one that did not come first stands down.
 */
export async function projectClaimIsOurs(projectId: string, rowId: string): Promise<boolean> {
  const rows = await prisma.googleAdsExecution.findMany({
    where: { projectId, mode: "demo_service_account", result: { in: ["succeeded", "pending"] } },
    orderBy: [{ startedAt: "asc" }, { id: "asc" }],
    select: { id: true },
    take: 2,
  });
  return rows[0]?.id === rowId;
}

/** Release a row this request is not allowed to use. */
export async function releaseProjectClaim(rowId: string): Promise<void> {
  await prisma.googleAdsExecution.delete({ where: { id: rowId } }).catch(() => {});
}

/**
 * Could Google be holding a campaign for a run that just failed?
 *
 * Answered from how far the run actually got, never from the provider's error
 * code — a timeout reads the same whether the campaign was created or not. The
 * default is deliberately pessimistic: anything this cannot positively rule out
 * (including a failure while saving a confirmed proof, which is not an
 * ExecutionError at all) counts as "may exist", because the cost of being wrong
 * the other way is a second real campaign.
 */
export function campaignMayExist(error: unknown): boolean {
  const stage = (error as { stage?: ExecutionStage } | null)?.stage;
  return stage !== "before_campaign_mutation";
}

/** A run that started and never reported back, if there is one. */
export async function pendingProjectExecution(projectId: string) {
  return prisma.googleAdsExecution.findFirst({
    where: { projectId, mode: "demo_service_account", result: "pending" },
    orderBy: [{ startedAt: "asc" }, { id: "asc" }],
  });
}

export type PendingOutcome =
  /** Still within its grace window — someone else is probably mid-flight. */
  | { state: "in_flight" }
  /** Google had created it after all; the row now carries the real identity. */
  | { state: "recovered"; executionId: string }
  /** Google is certain no campaign exists for this run; a retry is safe. */
  | { state: "never_created" }
  /** We could not find out. Refuse rather than risk a second campaign. */
  | { state: "unresolved" };

/**
 * Settle a pending run before anyone is allowed to mutate again.
 *
 * The dangerous window is narrow but real: Google creates the campaign, the
 * process dies before the identity is written down, and the row looks exactly
 * like an attempt that never left. Guessing either way is wrong — one guess
 * strands a real campaign, the other creates a second one — so this asks
 * Google, using the reference the row put into the campaign name before the
 * mutate was ever sent.
 */
export async function resolvePendingExecution(row: {
  id: string;
  startedAt: Date;
  campaignResourceName: string | null;
}): Promise<PendingOutcome> {
  if (Date.now() - row.startedAt.getTime() < PENDING_GRACE_MS) return { state: "in_flight" };

  try {
    const auth = new DemoServiceAccountAuthProvider();
    const accessToken = await demoServiceAccountToken();
    const customerId = await auth.targetCustomerId();

    const resourceName =
      row.campaignResourceName ??
      (await findCampaignByReference(auth, accessToken, customerId, row.id));

    if (!resourceName) {
      // Google is sure it holds nothing under this reference, so the mutate
      // never landed. Close the row so the project is not blocked forever.
      await prisma.googleAdsExecution.update({
        where: { id: row.id },
        data: { result: "failed", errorCode: "interrupted_before_create", completedAt: new Date() },
      });
      return { state: "never_created" };
    }

    // The campaign exists. Adopt it: the proof still comes from a fresh read.
    const proof = await readBackCampaign(auth, accessToken, customerId, resourceName);
    await prisma.googleAdsExecution.update({
      where: { id: row.id },
      data: {
        result: "succeeded",
        campaignId: proof.campaignId,
        campaignResourceName: proof.campaignResourceName,
        campaignName: proof.campaignName,
        campaignBudgetResourceName: proof.campaignBudgetResourceName,
        status: proof.status,
        channelType: proof.advertisingChannelType,
        channelSubType: proof.advertisingChannelSubType,
        appId: proof.appId,
        events: JSON.stringify([
          {
            code: "EXECUTION_RECOVERED",
            label: "Interrupted run recovered from Google",
            detail: "The campaign already existed; it was read back rather than created again.",
            status: "ok",
            at: new Date().toISOString(),
          },
        ]),
        completedAt: new Date(),
        lastVerifiedAt: new Date(proof.verifiedAt),
      },
    });
    return { state: "recovered", executionId: row.id };
  } catch {
    // Never downgrade an unknown answer into permission to mutate.
    return { state: "unresolved" };
  }
}
