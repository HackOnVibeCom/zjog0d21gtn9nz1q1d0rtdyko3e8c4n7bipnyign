import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { DemoServiceAccountAuthProvider, demoModeConfigured } from "@/lib/googleAds/auth";
import { executeAppCampaign } from "@/lib/googleAds/execution";
import { planGrowth } from "@/lib/demo/autopilot";
import { toProof } from "@/lib/demo/proof";
import { DEMO_APP_ID, DEMO_MAX_DAILY_BUDGET_MICROS } from "@/lib/demo/workspace";
import {
  checkExecutionAllowed,
  claimIsOurs,
  clientHash,
  DEMO_COOKIE,
  existingExecution,
  getSession,
  readSessionId,
  releaseClaim,
} from "@/lib/demo/session";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * POST /api/demo/execute — the judge sandbox execution.
 *
 * Creates ONE real PAUSED Google Ads App Campaign in the isolated test
 * advertiser, through the same engine a paying customer's OAuth would use. The
 * only difference is which credential is presented.
 *
 * Nothing that matters is taken from the browser. The advertising account, the
 * manager, the credential and the campaign status are all resolved server-side;
 * a request body can influence only the goal, the market and a budget that is
 * clamped before it is used.
 */

export async function POST(req: NextRequest) {
  const sessionId = readSessionId(req.cookies.get(DEMO_COOKIE)?.value);
  const session = await getSession(sessionId);
  if (!session) {
    return NextResponse.json({ error: "Start the demo first", code: "no_session" }, { status: 401 });
  }
  if (!demoModeConfigured()) {
    return NextResponse.json(
      { error: "The Google Ads sandbox is not configured on this deployment.", code: "not_configured" },
      { status: 503 }
    );
  }

  // Idempotent by design: a second click returns the campaign this session
  // already created rather than creating another one.
  const already = await existingExecution(session.id);
  if (already) {
    return NextResponse.json({ reused: true, proof: toProof(already) });
  }

  const hash = clientHash(
    req.headers.get("x-nf-client-connection-ip") ?? req.headers.get("x-forwarded-for"),
    req.headers.get("user-agent")
  );
  const verdict = await checkExecutionAllowed(session.id, hash);
  if (!verdict.allowed) {
    // Thresholds are not disclosed — knowing them only helps someone work
    // around them.
    return NextResponse.json(
      {
        error:
          verdict.reason === "global_cap"
            ? "The demo has reached today's execution limit. Please try again later."
            : "Demo execution limit reached — any existing proof is still available.",
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
      demoSessionId: session.id,
      result: "pending",
      dailyBudgetMicros: plan.dailyBudgetMicros,
      appId: DEMO_APP_ID,
    },
  });

  // Two clicks can pass the check above before either writes its row. The row
  // is the claim; whoever wrote the first one keeps it, and the other stops
  // here without calling Google.
  if (!(await claimIsOurs(session.id, started.id))) {
    await releaseClaim(started.id);
    return NextResponse.json(
      { error: "An execution for this session is already running.", code: "already_running" },
      { status: 409 }
    );
  }

  try {
    const { proof, events } = await executeAppCampaign(
      new DemoServiceAccountAuthProvider(),
      {
        campaignName: `AI Growth Kit demo · ${plan.marketLabel} installs`,
        appId: DEMO_APP_ID,
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
    await prisma.demoSession.update({
      where: { id: session.id },
      data: { executionId: saved.id },
    });

    return NextResponse.json({ reused: false, plan, proof: toProof(saved) });
  } catch (e) {
    const code = (e as { code?: string }).code ?? "execution_failed";
    await prisma.googleAdsExecution.update({
      where: { id: started.id },
      data: { result: "failed", errorCode: String(code).slice(0, 60), completedAt: new Date() },
    });
    // Never echo a provider body: Google's errors quote the request.
    return NextResponse.json(
      { error: "The Google Ads test execution could not be completed.", code },
      { status: 502 }
    );
  }
}
