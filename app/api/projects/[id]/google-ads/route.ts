import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { isDenied, ownedProjectOr } from "@/lib/ownership";
import { DemoServiceAccountAuthProvider, demoModeConfigured } from "@/lib/googleAds/auth";
import { executeAppCampaign, referenceMarker } from "@/lib/googleAds/execution";
import { toProof } from "@/lib/demo/proof";
import { DEMO_MAX_DAILY_BUDGET_MICROS } from "@/lib/demo/workspace";
import { planGrowth } from "@/lib/demo/autopilot";
import {
  campaignMayExist,
  checkProjectExecutionAllowed,
  existingProjectExecution,
  packageIdForProject,
  pendingProjectExecution,
  projectClaimIsOurs,
  releaseProjectClaim,
  resolvePendingExecution,
} from "@/lib/googleAds/projectRun";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * The project's own Google Ads test execution.
 *
 * GET  — what this project already owns, read from our records. No Google call,
 *        so opening the page costs nothing and recovery never depends on Google
 *        being reachable.
 * POST — create ONE paused App Campaign for this project's app, in the isolated
 *        TEST advertiser, through the same engine the sandbox uses.
 *
 * Nothing that matters comes from the browser. The advertising account, the
 * manager, the credential, the campaign status and the promoted package are all
 * resolved on the server; a request body can influence only the market and a
 * budget that is clamped before it is used.
 */

async function project(id: string) {
  return prisma.project.findUnique({ where: { id }, select: { id: true, name: true, storeUrl: true } });
}

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const gate = await ownedProjectOr(id);
  if (isDenied(gate)) return NextResponse.json({ error: gate.error }, { status: gate.status });

  const p = await project(id);
  const appId = packageIdForProject(p?.storeUrl);
  const execution = await existingProjectExecution(id);

  return NextResponse.json({
    configured: demoModeConfigured(),
    appId,
    appName: p?.name ?? null,
    executed: Boolean(execution),
    proof: execution ? toProof(execution) : null,
  });
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const gate = await ownedProjectOr(id);
  if (isDenied(gate)) return NextResponse.json({ error: gate.error }, { status: gate.status });

  if (!demoModeConfigured()) {
    return NextResponse.json(
      { error: "The Google Ads test sandbox is not configured on this deployment.", code: "not_configured" },
      { status: 503 }
    );
  }

  // The promoted app is this project's own app, taken from the store URL it was
  // created with — never a fixed example, and never a value from the browser.
  const p = await project(id);
  const appId = packageIdForProject(p?.storeUrl);
  if (!appId) {
    return NextResponse.json(
      {
        error:
          "This project has no Google Play link, so there is no app to promote. Add the app from its Play Store URL first.",
        code: "no_app_id",
      },
      { status: 409 }
    );
  }

  // Idempotent by design: a second click returns the campaign this project
  // already has rather than creating another one.
  const already = await existingProjectExecution(id);
  if (already) return NextResponse.json({ reused: true, appId, proof: toProof(already) });

  // A run that started and never reported back must be settled before anyone
  // is allowed to mutate again — otherwise an interruption after Google created
  // the campaign would be indistinguishable from one before, and a retry could
  // create a second campaign.
  const pending = await pendingProjectExecution(id);
  if (pending) {
    const outcome = await resolvePendingExecution(pending);
    if (outcome.state === "in_flight") {
      return NextResponse.json(
        { error: "An execution for this project is already running.", code: "already_running" },
        { status: 409 }
      );
    }
    if (outcome.state === "recovered") {
      const recovered = await existingProjectExecution(id);
      if (recovered) return NextResponse.json({ reused: true, appId, proof: toProof(recovered) });
    }
    if (outcome.state === "unresolved") {
      return NextResponse.json(
        {
          error:
            "An earlier attempt could not be confirmed with Google, so a new campaign will not be created. Please try again shortly.",
          code: "unresolved_previous_attempt",
        },
        { status: 409 }
      );
    }
    // "never_created": the row is closed, and a fresh attempt is safe.
  }

  const verdict = await checkProjectExecutionAllowed(id, gate.userId);
  if (!verdict.allowed) {
    return NextResponse.json(
      {
        error:
          verdict.reason === "project_used"
            ? "This project has already run its Google Ads test execution."
            : verdict.reason === "global_cap"
              ? "The test sandbox has reached today's execution limit. Please try again later."
              : "Too many test executions started recently. Please try again later.",
        code: verdict.reason,
      },
      { status: 429 }
    );
  }

  const body = (await req.json().catch(() => ({}))) as {
    market?: unknown;
    approvedDailyBudgetMicros?: unknown;
  };
  const plan = planGrowth({
    goal: "app_installs",
    market: typeof body.market === "string" ? body.market : "US",
    approvedDailyBudgetMicros: Number(body.approvedDailyBudgetMicros),
  });

  const started = await prisma.googleAdsExecution.create({
    data: {
      executionType: "app_campaign",
      mode: "demo_service_account",
      userId: gate.userId,
      projectId: id,
      result: "pending",
      dailyBudgetMicros: plan.dailyBudgetMicros,
      appId,
    },
  });

  if (!(await projectClaimIsOurs(id, started.id))) {
    await releaseProjectClaim(started.id);
    return NextResponse.json(
      { error: "An execution for this project is already running.", code: "already_running" },
      { status: 409 }
    );
  }

  try {
    const { proof, events } = await executeAppCampaign(
      new DemoServiceAccountAuthProvider(),
      {
        // The reference is written into the name before the mutate, so an
        // interruption afterwards can still be traced back to this row.
        campaignName: `${p?.name ?? "App"} · ${plan.marketLabel} installs · ${referenceMarker(started.id)}`,
        appId,
        requestedDailyBudgetMicros: plan.dailyBudgetMicros,
      },
      // testAccountOnly is not negotiable on this path.
      { allowedMaxDailyBudgetMicros: DEMO_MAX_DAILY_BUDGET_MICROS, testAccountOnly: true }
    );

    const saved = await prisma.googleAdsExecution.update({
      where: { id: started.id },
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
          ...events,
          {
            code: "EXECUTION_PROOF_SAVED",
            label: "Execution proof saved",
            status: "ok",
            at: new Date().toISOString(),
          },
        ]),
        completedAt: new Date(),
        lastVerifiedAt: new Date(proof.verifiedAt),
      },
    });

    return NextResponse.json({ reused: false, appId, plan, proof: toProof(saved) });
  } catch (e) {
    const code = (e as { code?: string }).code ?? "execution_failed";

    // A failure is only *definitive* when the campaign mutate was never sent.
    // Anything else — a lost answer, a failed read-back, a failed save — may
    // have left a real campaign behind, and closing the row here would hide it
    // from recovery and let the next click create a second one. Such a row
    // stays pending, with no completedAt, until Google settles the question.
    const ambiguous = campaignMayExist(e);
    await prisma.googleAdsExecution.update({
      where: { id: started.id },
      data: ambiguous
        ? { errorCode: String(code).slice(0, 60) }
        : { result: "failed", errorCode: String(code).slice(0, 60), completedAt: new Date() },
    });

    // Never echo a provider body: Google's errors quote the request.
    return NextResponse.json(
      {
        error: ambiguous
          ? "Google Ads did not return a complete confirmation. To prevent a duplicate, AI Growth Kit will check the previous attempt with Google before allowing another campaign."
          : code === "not_found"
            ? "Google could not resolve this app on Google Play, so no campaign was created."
            : "The Google Ads test execution could not be completed.",
        code: ambiguous ? "unconfirmed_outcome" : code,
      },
      { status: 502 }
    );
  }
}
