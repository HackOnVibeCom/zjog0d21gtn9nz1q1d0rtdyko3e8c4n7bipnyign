import { createHmac, timingSafeEqual } from "node:crypto";
import { prisma } from "../prisma";

/**
 * Isolated sessions for the public judge sandbox.
 *
 * This is deliberately NOT an Auth.js session. It grants no account, reaches no
 * customer project and carries no identity — it exists to scope one sandbox run
 * so a public button cannot become a campaign generator.
 *
 * The cookie holds a session id signed with the server secret. A forged or
 * edited cookie fails verification and simply yields a new session.
 */

export const DEMO_COOKIE = "agk_demo";
const SESSION_TTL_MS = 6 * 60 * 60 * 1000;

/**
 * How long a started-but-unfinished execution keeps blocking its session.
 *
 * The row is written before Google is called, so a lost connection or a killed
 * function can leave it pending forever. Counting those indefinitely would lock
 * a visitor out of the demo over a failure that was ours; ignoring them at once
 * would let a double click through. A short grace does both jobs.
 */
const PENDING_GRACE_MS = 3 * 60 * 1000;

/** Limits. Kept here so the policy is one readable block, not scattered. */
export const LIMITS = {
  /** Executions any one session may ever produce. */
  perSession: 1,
  /** Executions one client may start in the rolling window. */
  perClient: 3,
  perClientWindowMs: 60 * 60 * 1000,
  /** Executions the whole deployment may run per day, across everyone. */
  globalPerDay: 40,
} as const;

function secret(): string {
  const s = process.env.AUTH_SECRET;
  if (!s) throw new Error("AUTH_SECRET is not set");
  return s;
}

const sign = (value: string) =>
  createHmac("sha256", secret()).update(value).digest("base64url");

export function signSessionId(id: string): string {
  return `${id}.${sign(id)}`;
}

/** Recover a session id from a cookie, or null if it was not issued by us. */
export function readSessionId(cookieValue: string | undefined): string | null {
  if (!cookieValue) return null;
  const [id, signature] = cookieValue.split(".");
  if (!id || !signature) return null;
  const expected = Buffer.from(sign(id));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  return id;
}

/**
 * Identify a client for rate limiting without storing who they are.
 *
 * Address and user agent are salted with the server secret and hashed; the raw
 * values are never written down. It is a throttle, not a record of visitors.
 */
export function clientHash(ip: string | null, userAgent: string | null): string {
  return createHmac("sha256", secret())
    .update(`${ip ?? "unknown"}|${userAgent ?? "unknown"}`)
    .digest("base64url")
    .slice(0, 32);
}

export async function createSession(hash: string) {
  return prisma.demoSession.create({
    data: { expiresAt: new Date(Date.now() + SESSION_TTL_MS), clientHash: hash },
  });
}

export async function getSession(id: string | null) {
  if (!id) return null;
  const session = await prisma.demoSession.findUnique({ where: { id } });
  if (!session || session.expiresAt.getTime() < Date.now()) return null;
  return session;
}

export type LimitVerdict =
  | { allowed: true }
  | { allowed: false; reason: "session_used" | "client_rate" | "global_cap" };

/**
 * May this session start a Google Ads execution?
 *
 * Checked in the database rather than in memory: serverless instances do not
 * share state, and an in-memory counter would reset on every cold start —
 * which is precisely when abuse would get through.
 */
export async function checkExecutionAllowed(
  sessionId: string,
  hash: string | null
): Promise<LimitVerdict> {
  const existing = await prisma.googleAdsExecution.count({
    where: {
      demoSessionId: sessionId,
      OR: [
        { result: "succeeded" },
        { result: "pending", startedAt: { gte: new Date(Date.now() - PENDING_GRACE_MS) } },
      ],
    },
  });
  if (existing >= LIMITS.perSession) return { allowed: false, reason: "session_used" };

  if (hash) {
    const sessions = await prisma.demoSession.findMany({
      where: { clientHash: hash, createdAt: { gte: new Date(Date.now() - LIMITS.perClientWindowMs) } },
      select: { id: true },
    });
    if (sessions.length) {
      const recent = await prisma.googleAdsExecution.count({
        where: { demoSessionId: { in: sessions.map((s) => s.id) } },
      });
      if (recent >= LIMITS.perClient) return { allowed: false, reason: "client_rate" };
    }
  }

  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const today = await prisma.googleAdsExecution.count({
    where: { mode: "demo_service_account", startedAt: { gte: since } },
  });
  if (today >= LIMITS.globalPerDay) return { allowed: false, reason: "global_cap" };

  return { allowed: true };
}

/** The execution this session already produced, if any. */
export async function existingExecution(sessionId: string) {
  return prisma.googleAdsExecution.findFirst({
    where: { demoSessionId: sessionId, result: "succeeded" },
    orderBy: { startedAt: "desc" },
  });
}

/**
 * Is this row the session's one execution?
 *
 * The allowance check and the row that follows it are two statements, and two
 * clicks landing between them would both be allowed. Rather than trust the gap,
 * each request writes its row and then asks who came first; the loser deletes
 * its own row and calls no API. Both requests order the same way, so exactly one
 * of them proceeds.
 */
export async function claimIsOurs(sessionId: string, rowId: string): Promise<boolean> {
  const rows = await prisma.googleAdsExecution.findMany({
    where: { demoSessionId: sessionId, result: { in: ["succeeded", "pending"] } },
    orderBy: [{ startedAt: "asc" }, { id: "asc" }],
    select: { id: true },
    take: 2,
  });
  return rows[0]?.id === rowId;
}

/** Release a row this request is not allowed to use. */
export async function releaseClaim(rowId: string): Promise<void> {
  await prisma.googleAdsExecution.delete({ where: { id: rowId } }).catch(() => {});
}
