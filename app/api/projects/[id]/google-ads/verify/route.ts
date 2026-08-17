import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { isDenied, ownedProjectOr } from "@/lib/ownership";
import { DemoServiceAccountAuthProvider, demoModeConfigured } from "@/lib/googleAds/auth";
import { readBackCampaign } from "@/lib/googleAds/execution";
import { demoServiceAccountToken } from "@/lib/googleAds/serviceAccount";
import { existingProjectExecution } from "@/lib/googleAds/projectRun";

export const runtime = "nodejs";

/**
 * POST — ask Google again, right now, about this project's campaign.
 *
 * Deliberately does NOT read our database for the answer: it takes the stored
 * campaign identity, queries Google afresh, and reports what Google says today.
 * A proof that only re-reads our own records proves nothing.
 */
export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const gate = await ownedProjectOr(id);
  if (isDenied(gate)) return NextResponse.json({ error: gate.error }, { status: gate.status });

  if (!demoModeConfigured()) {
    return NextResponse.json({ error: "Sandbox not configured", code: "not_configured" }, { status: 503 });
  }

  const execution = await existingProjectExecution(id);
  if (!execution?.campaignResourceName) {
    return NextResponse.json({ error: "Nothing to verify yet", code: "no_execution" }, { status: 404 });
  }

  try {
    const auth = new DemoServiceAccountAuthProvider();
    const accessToken = await demoServiceAccountToken();
    const customerId = await auth.targetCustomerId();
    const proof = await readBackCampaign(auth, accessToken, customerId, execution.campaignResourceName);

    await prisma.googleAdsExecution.update({
      where: { id: execution.id },
      data: { status: proof.status, lastVerifiedAt: new Date(proof.verifiedAt) },
    });

    // Only sanitised fields cross to the browser — no customer id, no token.
    return NextResponse.json({
      verified: true,
      verifiedAt: proof.verifiedAt,
      campaignId: proof.campaignId,
      campaignName: proof.campaignName,
      status: proof.status,
      channelType: proof.advertisingChannelType,
      channelSubType: proof.advertisingChannelSubType,
    });
  } catch (e) {
    const code = (e as { code?: string }).code ?? "verify_failed";
    return NextResponse.json(
      { verified: false, error: "Google could not confirm this campaign right now.", code },
      { status: 502 }
    );
  }
}
