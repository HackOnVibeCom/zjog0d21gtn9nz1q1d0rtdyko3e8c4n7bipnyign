import { prisma } from "../prisma";
import { resolveStoreProvider } from "../store";
import type { StoreAppMetadata } from "../store/types";
import type { AppAnalysis } from "../analyze";

/**
 * THE PUBLIC RESEARCH RUN.
 *
 * A judge has no account, so a run is the thing that owns their work: which
 * app they pasted, what each stage actually returned, and how far the pipeline
 * got. It lives in the database rather than in the browser for two reasons —
 * a refresh has to recover the page, and every limit below has to be counted
 * rather than trusted. A disabled button is a courtesy; a row is a fact.
 */

const int = (name: string, fallback: number): number => {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : fallback;
};

/** Limits. Environment-configurable, with defaults that are safe in public. */
export const DEMO_LIMITS = {
  get researchRunsPerSession() {
    return int("DEMO_MAX_RESEARCH_RUNS_PER_SESSION", 5);
  },
  get researchCooldownSeconds() {
    return int("DEMO_RESEARCH_COOLDOWN_SECONDS", 15);
  },
  get globalResearchRunsPerHour() {
    return int("DEMO_GLOBAL_RESEARCH_RUNS_PER_HOUR", 60);
  },
  get googleExecutionsPerSession() {
    return int("DEMO_MAX_GOOGLE_EXECUTIONS_PER_SESSION", 1);
  },
  get globalGoogleExecutionsPerHour() {
    return int("DEMO_GLOBAL_GOOGLE_EXECUTIONS_PER_HOUR", 12);
  },
};

/**
 * The public Google Ads execution kill switch.
 *
 * Defaults to enabled so a correctly configured deployment works, but a single
 * environment variable can stop every public mutation without a deploy. It can
 * only ever subtract permission: nothing here can bypass the TEST-account
 * check, which lives in the execution engine.
 */
export function googleExecutionEnabled(): boolean {
  return process.env.DEMO_GOOGLE_EXECUTION_ENABLED !== "false";
}

/**
 * The only order this pipeline runs in.
 *
 * Each step names what may follow it, and the run remembers which one it is
 * waiting for. The endpoint is public, so a caller must not be able to replay a
 * paid model or search call simply by asking for the same step again — the
 * answer to "may I run this step?" is a stored fact, not the caller's word.
 */
export const NEXT_STEP: Record<string, string> = {
  "import-submit": "import-poll",
  "import-poll": "analyze",
  analyze: "discover-queries",
  "discover-queries": "discover-submit",
  "discover-submit": "discover-poll",
  "discover-poll": "discover-score",
  "discover-score": "propose",
  propose: "complete",
};

/** How long a stage may be in flight before another Start may take over. */
const STAGE_LOCK_MS = 3 * 60 * 1000;

export type RunStage = "importing" | "analyzing" | "discovering" | "proposed" | "failed";

export type StartVerdict =
  | { ok: true }
  | { ok: false; code: "busy" | "cooldown" | "session_cap" | "global_cap"; message: string };

/**
 * Validate a pasted Google Play link.
 *
 * Delegates to the same resolver the signed-in importer uses, so the public
 * demo cannot be looser than the product: https only, play.google.com only,
 * the app-details path only, and a package id that passes the same pattern.
 * No app is special-cased — whatever a judge pastes is what gets researched.
 */
export function parseStoreUrl(rawUrl: unknown): { appId: string; storeUrl: string } {
  const { provider, url } = resolveStoreProvider(String(rawUrl ?? ""));
  const appId = provider.extractAppId(url);
  // Rebuilt from the package id, so locale and tracking parameters are dropped
  // and the stored URL can never be an attacker-chosen destination.
  return { appId, storeUrl: `https://play.google.com/store/apps/details?id=${appId}` };
}

/** The run this session is currently working on, if any. */
export async function currentRun(sessionId: string) {
  return prisma.demoRun.findFirst({ where: { sessionId }, orderBy: { createdAt: "desc" } });
}

/** May this session start another research run right now? */
export async function checkStartAllowed(sessionId: string): Promise<StartVerdict> {
  const now = Date.now();

  // One pipeline at a time. A stale lock expires so a crashed run cannot
  // strand the session, but a live one blocks a second Start outright.
  const active = await prisma.demoRun.findFirst({
    where: {
      sessionId,
      OR: [
        // A stage is holding the lock right now.
        { activeAt: { gte: new Date(now - STAGE_LOCK_MS) } },
        // Or a run was started moments ago and has not been driven yet.
        { createdAt: { gte: new Date(now - STAGE_LOCK_MS) }, stage: { notIn: ["proposed", "failed"] } },
      ],
    },
    orderBy: { createdAt: "desc" },
  });
  if (active) {
    return { ok: false, code: "busy", message: "A research run is already in progress." };
  }

  const last = await prisma.demoRun.findFirst({
    where: { sessionId },
    orderBy: { createdAt: "desc" },
    select: { createdAt: true },
  });
  const cooldownMs = DEMO_LIMITS.researchCooldownSeconds * 1000;
  if (last && now - last.createdAt.getTime() < cooldownMs) {
    const wait = Math.ceil((cooldownMs - (now - last.createdAt.getTime())) / 1000);
    return {
      ok: false,
      code: "cooldown",
      message: `Please wait ${wait}s before starting another research run.`,
    };
  }

  const mine = await prisma.demoRun.count({ where: { sessionId } });
  if (mine >= DEMO_LIMITS.researchRunsPerSession) {
    return {
      ok: false,
      code: "session_cap",
      message: "This demo session has used all of its research runs.",
    };
  }

  const globally = await prisma.demoRun.count({
    where: { createdAt: { gte: new Date(now - 60 * 60 * 1000) } },
  });
  if (globally >= DEMO_LIMITS.globalResearchRunsPerHour) {
    return {
      ok: false,
      code: "global_cap",
      message: "The public demo is busy right now. Please try again shortly.",
    };
  }

  return { ok: true };
}

export async function createRun(sessionId: string, appId: string, storeUrl: string) {
  // Born unlocked: the run's own first advance must be able to claim it.
  return prisma.demoRun.create({
    data: { sessionId, appId, storeUrl, stage: "importing", activeAt: null },
  });
}

/**
 * Stand down a run that lost a concurrent Start.
 *
 * Deleting is safe here and only here: the row was created moments ago by the
 * losing request and has never held a provider result.
 */
export async function discardRun(runId: string) {
  await prisma.demoRun.delete({ where: { id: runId } }).catch(() => {});
}

/**
 * Is this the session's only live pipeline? Settles a Start race by row order.
 *
 * Only unfinished runs compete. A run that reached its proposal or failed is
 * done with, and letting it linger in the race would mean a judge who finished
 * researching one app could never research a second within the lock window —
 * which is the opposite of the policy the cooldown expresses.
 */
export async function runIsOurs(sessionId: string, runId: string): Promise<boolean> {
  const rows = await prisma.demoRun.findMany({
    where: {
      sessionId,
      createdAt: { gte: new Date(Date.now() - STAGE_LOCK_MS) },
      stage: { notIn: ["proposed", "failed"] },
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { id: true },
    take: 2,
  });
  return rows.length <= 1 || rows[0].id === runId;
}

/**
 * Take the stage lock for one operation.
 *
 * Every advance goes through here, so two tabs cannot drive the same run at
 * once and a double click cannot pay for the same provider call twice.
 */
export async function claimStage(runId: string, sessionId: string) {
  const existing = await prisma.demoRun.findFirst({ where: { id: runId, sessionId } });
  if (!existing) return { ok: false as const, code: "not_found" as const };
  if (existing.stage === "failed") return { ok: false as const, code: "failed" as const };

  // The claim is the write, not the read. Postgres applies the WHERE and the
  // SET in one statement, so of two simultaneous requests exactly one sees a
  // non-zero count — a read-then-write pair would let both through.
  const stale = new Date(Date.now() - STAGE_LOCK_MS);
  const claimed = await prisma.demoRun.updateMany({
    where: {
      id: runId,
      sessionId,
      OR: [{ activeAt: null }, { activeAt: { lt: stale } }],
    },
    data: { activeAt: new Date() },
  });
  if (claimed.count !== 1) return { ok: false as const, code: "busy" as const };

  // Re-read so the caller works from the row as it stands after the claim.
  const run = await prisma.demoRun.findFirst({ where: { id: runId, sessionId } });
  if (!run) return { ok: false as const, code: "not_found" as const };
  return { ok: true as const, run };
}

export async function releaseStage(runId: string) {
  await prisma.demoRun.update({ where: { id: runId }, data: { activeAt: null } }).catch(() => {});
}

/** Record an honest failure. The pipeline stops here; nothing is faked after. */
export async function failRun(runId: string, stage: string, code: string) {
  return prisma.demoRun.update({
    where: { id: runId },
    data: { stage: "failed", failedAt: stage, errorCode: code.slice(0, 60), activeAt: null },
  });
}

const parse = <T>(raw: string | null): T | null => {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
};

export type PublicListing = {
  appId: string;
  name: string;
  category?: string;
  developer?: string;
  iconUrl?: string;
  description?: string;
  storeUrl: string;
  retrievedAt: string;
};

/**
 * What the browser is allowed to see of a retrieved listing.
 *
 * An allowlist rather than a filtered provider object: a field only reaches a
 * judge because it was named here, so a future provider change cannot leak
 * something new by accident.
 */
export function publicListing(m: StoreAppMetadata): PublicListing {
  return {
    appId: m.appId,
    name: m.name,
    category: m.category,
    developer: m.developer,
    iconUrl: m.iconUrl,
    description: m.description ? m.description.slice(0, 900) : undefined,
    storeUrl: m.storeUrl,
    retrievedAt: m.retrievedAt,
  };
}

/** A stored listing is public only once it is a finished, allowlisted shape. */
function completedListing(raw: string | null): PublicListing | null {
  const parsed = parse<Partial<PublicListing>>(raw);
  if (!parsed || typeof parsed.appId !== "string" || typeof parsed.name !== "string") return null;
  return {
    appId: parsed.appId,
    name: parsed.name,
    category: parsed.category,
    developer: parsed.developer,
    iconUrl: parsed.iconUrl,
    description: parsed.description,
    storeUrl: parsed.storeUrl ?? "",
    retrievedAt: parsed.retrievedAt ?? "",
  };
}

export type PublicRun = {
  id: string;
  appId: string;
  storeUrl: string;
  stage: RunStage;
  failedAt: string | null;
  errorCode: string | null;
  listing: PublicListing | null;
  analysis: AppAnalysis | null;
  discovery: unknown[] | null;
  proposal: unknown | null;
  hasExecution: boolean;
  createdAt: string;
};

/** The run as the browser sees it. Nothing here touches a credential. */
export function toPublicRun(run: {
  id: string;
  appId: string;
  storeUrl: string;
  stage: string;
  failedAt: string | null;
  errorCode: string | null;
  listing: string | null;
  analysis: string | null;
  discovery: string | null;
  proposal: string | null;
  executionId: string | null;
  createdAt: Date;
}): PublicRun {
  return {
    id: run.id,
    appId: run.appId,
    storeUrl: run.storeUrl,
    stage: run.stage as RunStage,
    failedAt: run.failedAt,
    errorCode: run.errorCode,
    // Only a completed, allowlisted listing crosses to the browser. While the
    // import is still queued this column holds the provider task, which has no
    // name and therefore never leaves the server.
    listing: completedListing(run.listing),
    analysis: parse<AppAnalysis>(run.analysis),
    discovery: parse<unknown[]>(run.discovery),
    proposal: parse<unknown>(run.proposal),
    hasExecution: Boolean(run.executionId),
    createdAt: run.createdAt.toISOString(),
  };
}
