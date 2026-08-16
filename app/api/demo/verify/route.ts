import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { DemoServiceAccountAuthProvider, demoModeConfigured } from "@/lib/googleAds/auth";
import { readBackCampaign } from "@/lib/googleAds/execution";
import { demoServiceAccountToken } from "@/lib/googleAds/serviceAccount";
import { DEMO_COOKIE, existingExecution, getSession, readSessionId } from "@/lib/demo/session";

export const runtime = "nodejs";

/**
 * POST /api/demo/verify — ask Google again, right now.
 *
 * This deliberately does NOT read our database for the answer. It takes the
 * stored campaign identity, queries Google afresh, and reports whatever Google
 * says today. If the two ever disagree, Google wins and the judge sees that —
 * a proof that only re-reads our own records proves nothing.
 */
export async function POST(req: NextRequest) {
  const session = await getSession(readSessionId(req.cookies.get(DEMO_COOKIE)?.value));
  if (!session) {
    return NextResponse.json({ error: "Start the demo first", code: "no_session" }, { status: 401 });
  }
  if (!demoModeConfigured()) {
    return NextResponse.json({ error: "Sandbox not configured", code: "not_configured" }, { status: 503 });
  }

  const execution = await existingExecution(session.id);
  if (!execution?.campaignResourceName) {
    return NextResponse.json({ error: "Nothing to verify yet", code: "no_execution" }, { status: 404 });
  }

  try {
    const auth = new DemoServiceAccountAuthProvider();
    const accessToken = await demoServiceAccountToken();
    const customerId = await auth.targetCustomerId();
    const proof = await readBackCampaign(
      auth,
      accessToken,
      customerId,
      execution.campaignResourceName
    );

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
