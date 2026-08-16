import { prisma } from "./prisma";

/**
 * Record deliberate owner activity on a project.
 *
 * Call this from routes that represent the customer actively working — never
 * from analytics polling, never from the discovery search-poll, and never from
 * the public tracking redirect. See lib/activity.ts for the full rule.
 *
 * Archiving is untouched here on purpose: a hand-filed project stays filed
 * until the owner restores it explicitly.
 */
export async function touchProject(projectId: string): Promise<void> {
  try {
    await prisma.project.update({
      where: { id: projectId },
      data: { lastActivityAt: new Date() },
    });
  } catch {
    // Activity bookkeeping must never break the action the customer asked for.
  }
}
