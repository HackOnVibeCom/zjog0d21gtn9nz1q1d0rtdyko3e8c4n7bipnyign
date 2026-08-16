import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

/**
 * First-party tracking redirect: /r/:slug
 * Records a real click, then 302-redirects to the campaign's destination
 * (App Store / Google Play / website). This is what makes promotion
 * externally measurable — every published post carries one of these links.
 */
export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ slug: string }> }
) {
  const { slug } = await ctx.params;

  const link = await prisma.trackingLink.findUnique({ where: { slug } });
  if (!link) {
    return NextResponse.json({ error: "Unknown tracking link" }, { status: 404 });
  }

  // Record the click (fire-and-forget; never block the redirect on it).
  prisma.trackingEvent
    .create({
      data: {
        trackingLinkId: link.id,
        referrer: _req.headers.get("referer") ?? undefined,
        userAgent: _req.headers.get("user-agent") ?? undefined,
      },
    })
    .catch((e) => console.error("[tracking] failed to record click:", e));

  return NextResponse.redirect(link.destinationUrl, { status: 302 });
}
