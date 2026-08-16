import { currentUserId } from "@/auth";
import { prisma } from "./prisma";

type Denied = { error: string; status: 401 | 404 };
type Allowed = { userId: string };

/**
 * Ensures the signed-in user owns `projectId`. Returns { userId } when allowed,
 * or a { error, status } to return directly. This is the tenant-isolation gate
 * every project-scoped route uses.
 */
export async function ownedProjectOr(projectId: string): Promise<Denied | Allowed> {
  const userId = await currentUserId();
  if (!userId) return { error: "Unauthorized", status: 401 };
  const project = await prisma.project.findFirst({
    where: { id: projectId, userId },
    select: { id: true },
  });
  if (!project) return { error: "Not found", status: 404 };
  return { userId };
}

export function isDenied(r: Denied | Allowed): r is Denied {
  return "error" in r;
}
