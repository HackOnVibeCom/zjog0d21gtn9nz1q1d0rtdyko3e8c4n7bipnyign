import { NextRequest, NextResponse } from "next/server";
import { launchCampaign } from "@/lib/campaign";
import { ownedProjectOr, isDenied } from "@/lib/ownership";
import { touchProject } from "@/lib/projectActivity";

/**
 * POST /api/campaigns/launch
 * Body: { projectId, platforms?: string[], goal? }
 * Runs the real publish orchestration and returns the campaign with its
 * publications (external post URLs) and tracking links.
 */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  if (!body?.projectId) {
    return NextResponse.json({ error: "projectId is required" }, { status: 400 });
  }
  const gate = await ownedProjectOr(body.projectId);
  if (isDenied(gate)) return NextResponse.json({ error: gate.error }, { status: gate.status });
  await touchProject(body.projectId); // publishing is deliberate owner work
  const platforms =
    Array.isArray(body.platforms) && body.platforms.length
      ? body.platforms
      : ["discord"];

  try {
    const campaign = await launchCampaign(body.projectId, platforms, body.goal);
    return NextResponse.json({ campaign }, { status: 201 });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
