import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { classifyProject } from "@/lib/activity";
import { ownedProjectOr, isDenied } from "@/lib/ownership";

/** GET /api/projects/:id — project + parsed analysis (owner only). */
export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> }
) {
  const { id } = await ctx.params;
  const gate = await ownedProjectOr(id);
  if (isDenied(gate)) return NextResponse.json({ error: gate.error }, { status: gate.status });
  const project = await prisma.project.findUnique({
    where: { id },
    include: { analysis: true },
  });
  if (!project) return NextResponse.json({ error: "not found" }, { status: 404 });

  let analysis = null;
  if (project.analysis) {
    const safeParse = (s: string, fb: unknown) => {
      try {
        return JSON.parse(s);
      } catch {
        return fb;
      }
    };
    // summary and mainProblem are already stored inside the raw analysis; the
    // workspace shows them, so surface them here rather than re-deriving.
    const raw = safeParse(project.analysis.raw, {}) as Record<string, unknown>;
    const str = (v: unknown) => (typeof v === "string" ? v : "");
    analysis = {
      primaryCategory: project.analysis.primaryCategory,
      audience: project.analysis.audience,
      valueProp: project.analysis.valueProp,
      summary: str(raw.summary),
      mainProblem: str(raw.mainProblem),
      secondaryCategories: safeParse(project.analysis.secondaryCategories, []),
      recommendedChannels: safeParse(project.analysis.recommendedChannels, []),
    };
  }

  return NextResponse.json({ project, analysis });
}

/**
 * PATCH /api/projects/:id — owner-only project state.
 *
 *   { action: "archive" }  file it away by hand
 *   { action: "restore" }  bring it back and count that as fresh activity
 *   { action: "touch" }    the owner opened the workspace
 *
 * "touch" never clears archivedAt: opening a project the customer deliberately
 * filed away must not silently unfile it.
 */
export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const gate = await ownedProjectOr(id);
  if (isDenied(gate)) return NextResponse.json({ error: gate.error }, { status: gate.status });

  const body = (await req.json().catch(() => ({}))) as { action?: unknown };
  const action = typeof body.action === "string" ? body.action : "";

  const data =
    action === "archive"
      ? { archivedAt: new Date() }
      : action === "restore"
      ? { archivedAt: null, lastActivityAt: new Date() }
      : action === "touch"
      ? { lastActivityAt: new Date() }
      : null;

  if (!data) return NextResponse.json({ error: "Unknown action" }, { status: 400 });

  const project = await prisma.project.update({ where: { id }, data });
  return NextResponse.json({ project, ...classifyProject(project) });
}

/**
 * DELETE /api/projects/:id — remove the project and everything hanging off it.
 *
 * Ownership is re-checked server-side; a project id alone is never enough. The
 * schema cascades Project → Analysis, Campaigns (→ Publications, TrackingLinks
 * → TrackingEvents) and CommunityCandidates, so one delete clears the whole
 * graph without leaving orphans.
 */
export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const gate = await ownedProjectOr(id);
  if (isDenied(gate)) return NextResponse.json({ error: gate.error }, { status: gate.status });

  await prisma.project.delete({ where: { id } });
  return NextResponse.json({ deleted: true, id });
}
