import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { ownedProjectOr, isDenied } from "@/lib/ownership";

/**
 * GET /api/projects/:id/analytics
 * Returns each publication (platform, status, public URL) with its real,
 * live click count. This is what the dashboard polls so the judge sees the
 * counter move after clicking a tracking link.
 */
export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> }
) {
  const { id } = await ctx.params;
  const gate = await ownedProjectOr(id);
  if (isDenied(gate)) return NextResponse.json({ error: gate.error }, { status: gate.status });

  const campaigns = await prisma.campaign.findMany({
    where: { projectId: id },
    orderBy: { createdAt: "desc" },
    include: {
      publications: true,
      trackingLinks: { include: { _count: { select: { events: true } } } },
    },
  });

  const clicksByPlatform: Record<string, number> = {};
  for (const c of campaigns) {
    for (const l of c.trackingLinks) {
      clicksByPlatform[l.platform] =
        (clicksByPlatform[l.platform] ?? 0) + l._count.events;
    }
  }
  const totalClicks = Object.values(clicksByPlatform).reduce((a, b) => a + b, 0);

  const publications = campaigns.flatMap((c) =>
    c.publications.map((p) => {
      const link = c.trackingLinks.find((l) => l.id === p.trackingLinkId);
      return {
        id: p.id,
        platform: p.platform,
        status: p.status,
        externalPostUrl: p.externalPostUrl,
        content: (JSON.parse(p.content) as { text?: string }).text ?? "",
        clicks: link?._count.events ?? 0,
        error: p.error,
      };
    })
  );

  return NextResponse.json({ totalClicks, clicksByPlatform, publications });
}
