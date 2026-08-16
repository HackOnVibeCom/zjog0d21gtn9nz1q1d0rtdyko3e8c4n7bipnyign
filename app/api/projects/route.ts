import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { analyzeApp, normalizeAnalysis } from "@/lib/analyze";
import { classifyProject } from "@/lib/activity";
import { currentUserId } from "@/auth";

/**
 * POST /api/projects — create a project (owned by the signed-in user) and run
 * the AI analysis. Requires authentication.
 */
export async function POST(req: NextRequest) {
  const userId = await currentUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const s = (v: unknown, max = 2000) =>
    typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null;
  const name = s(body.name, 200);
  if (!name) {
    return NextResponse.json({ error: "name is required" }, { status: 400 });
  }

  const project = await prisma.project.create({
    data: {
      name,
      description: s(body.description, 6000),
      storeUrl: s(body.storeUrl, 2048),
      websiteUrl: s(body.websiteUrl, 2048),
      targetAudience: s(body.targetAudience, 600),
      userId,
    },
  });

  // Reuse a precomputed analysis (from the Google Play import review screen) so
  // the OpenAI call isn't repeated. It arrives from the browser, so it is never
  // trusted as-is: normalizeAnalysis coerces it to the exact expected shape,
  // caps every field and drops unknown channels. If nothing usable survives, we
  // fall back to running UNDERSTAND server-side.
  const precomputed = body.analysis ? normalizeAnalysis(body.analysis) : null;
  const usable = precomputed && precomputed.recommendedChannels.length > 0 ? precomputed : null;

  try {
    const analysis =
      usable ??
      (await analyzeApp({
        name: project.name,
        description: project.description ?? undefined,
        storeUrl: project.storeUrl ?? undefined,
        websiteUrl: project.websiteUrl ?? undefined,
        targetAudience: project.targetAudience ?? undefined,
      }));

    const stored = await prisma.analysis.create({
      data: {
        projectId: project.id,
        primaryCategory: analysis.primaryCategory,
        secondaryCategories: JSON.stringify(analysis.secondaryCategories),
        audience: analysis.audience,
        valueProp: analysis.valueProp,
        recommendedChannels: JSON.stringify(analysis.recommendedChannels),
        raw: JSON.stringify(analysis),
      },
    });

    return NextResponse.json({ project, analysis, analysisId: stored.id }, { status: 201 });
  } catch {
    // The project exists; only the analysis failed. Keep the message generic —
    // upstream errors can carry internal details.
    return NextResponse.json(
      { project, error: "We couldn't analyze this app right now. Please try again." },
      { status: 502 }
    );
  }
}

/**
 * GET /api/projects — the signed-in user's projects only (tenant isolation).
 *
 * Active/History is decided here, on the server clock, so the split cannot be
 * changed by a browser with a wrong system time.
 */
export async function GET() {
  const userId = await currentUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const rows = await prisma.project.findMany({
    where: { userId },
    orderBy: { lastActivityAt: "desc" },
    include: { analysis: true },
  });

  const now = Date.now();
  const projects = rows.map((p) => ({
    ...p,
    ...classifyProject(p, now),
  }));
  return NextResponse.json({ projects });
}
