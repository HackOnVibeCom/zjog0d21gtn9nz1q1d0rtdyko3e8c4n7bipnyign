import { prisma } from "../prisma";
import {
  Actionability,
  normalizeActionability,
  normalizePageType,
  PageType,
} from "./actionability";
import {
  ContextMatch,
  normalizeContextMatch,
  normalizeMatchScore,
  OpportunityQuality,
} from "./quality";
import { QueryInput } from "./queries";
import { ScoredWebCandidate } from "./webscore";

const OPPORTUNITY_QUALITIES: OpportunityQuality[] = [
  "strong_opportunity",
  "weak_match",
  "research_only",
  "unknown",
];

/** Rows written before acquisition quality existed read back as unknown. */
export function normalizeOpportunityQuality(value: unknown): OpportunityQuality {
  return typeof value === "string" && (OPPORTUNITY_QUALITIES as string[]).includes(value)
    ? (value as OpportunityQuality)
    : "unknown";
}

/**
 * Storage + presentation for web-discovered audience locations.
 *
 * These reuse the existing CommunityCandidate model (platform "web"), so no
 * schema change is needed. The mapping is deliberately conservative:
 *
 *   RETRIEVED  name (result title), url, description (search snippet),
 *              policyEvidence (JSON: the query, Google position, domain)
 *   AI         audienceFit, relevanceReason, suggestedApproach, generatedContent
 *   UNKNOWN    memberCount and rules stay NULL — a search result cannot tell us
 *              how big a community is or what its posting rules are, and
 *              promotionPolicy therefore stays "unknown".
 */

export const WEB_PLATFORM = "web";

export type WebEvidence = {
  sourceQuery: string;
  position: number;
  domain: string;
  /** Always false for web discovery: we never fetched or read the page. */
  rulesRead: false;
  /** AI INFERENCE over the retrieved title/URL/snippet — not provider data. */
  pageType: PageType;
  actionability: Actionability;
  /** Acquisition quality. AI evidence, server-decided verdict. */
  audienceMatch?: number;
  problemMatch?: number;
  contextMatch?: ContextMatch;
  opportunityQuality?: OpportunityQuality;
  rejectionReason?: string;
  /**
   * Market & audience intelligence. AI INFERENCE over the retrieved evidence,
   * written for growth decisions — what this source says about the audience,
   * the need visible in it, and how that should inform acquisition strategy.
   * Rows written before these existed simply read as unavailable.
   */
  audienceSignal?: string;
  painPoint?: string;
  growthAction?: string;
};

/** The project context both query generation and scoring run on. */
export async function projectDiscoveryInput(projectId: string): Promise<QueryInput & {
  destinationUrl: string;
}> {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    include: { analysis: true },
  });
  if (!project) throw new Error("Project not found");

  let summary: string | undefined;
  let mainProblem: string | undefined;
  if (project.analysis?.raw) {
    try {
      const raw = JSON.parse(project.analysis.raw) as Record<string, unknown>;
      if (typeof raw.summary === "string") summary = raw.summary;
      if (typeof raw.mainProblem === "string") mainProblem = raw.mainProblem;
    } catch {
      // The stored analysis is best-effort context, never required.
    }
  }

  return {
    name: project.name,
    summary: summary ?? project.description ?? undefined,
    audience: project.analysis?.audience ?? project.targetAudience ?? undefined,
    mainProblem,
    valueProp: project.analysis?.valueProp ?? undefined,
    category: project.analysis?.primaryCategory ?? undefined,
    destinationUrl: project.storeUrl || project.websiteUrl || "",
  };
}

/**
 * Store scored candidates. Scoring runs in small batches so each request stays
 * inside a serverless invocation, so only the first batch of a run replaces the
 * previous results; later batches add to them.
 */
export async function persistWebCandidates(
  projectId: string,
  scored: ScoredWebCandidate[],
  replace = true
) {
  if (replace) {
    await prisma.communityCandidate.deleteMany({
      where: { projectId, platform: WEB_PLATFORM },
    });
  }

  const rows = [];
  for (const c of scored) {
    const evidence: WebEvidence = {
      sourceQuery: c.sourceQuery,
      position: c.position,
      domain: c.domain,
      rulesRead: false,
      pageType: c.pageType,
      actionability: c.actionability,
      audienceMatch: c.audienceMatch,
      problemMatch: c.problemMatch,
      contextMatch: c.contextMatch,
      opportunityQuality: c.opportunityQuality,
      rejectionReason: c.rejectionReason || undefined,
      audienceSignal: c.audienceSignal || undefined,
      painPoint: c.painPoint || undefined,
      growthAction: c.growthAction || undefined,
    };
    rows.push(
      await prisma.communityCandidate.create({
        data: {
          projectId,
          platform: WEB_PLATFORM,
          name: c.title,
          url: c.url,
          description: c.snippet ?? null,
          memberCount: null, // UNKNOWN — never guessed from a search result
          rules: null, // UNKNOWN — the page was not fetched or read
          audienceFit: c.audienceFit,
          relevanceReason: c.relevanceReason,
          promotionPolicy: "unknown", // honest: posting rules were not read
          policyEvidence: JSON.stringify(evidence),
          suggestedApproach: c.suggestedApproach,
          generatedContent: null, // only prepared on explicit user request
          trackingLinkId: null,
        },
      })
    );
  }
  return rows;
}

export type CandidateRow = {
  id: string;
  platform: string;
  name: string;
  url: string;
  description: string | null;
  memberCount: number | null;
  audienceFit: number;
  relevanceReason: string | null;
  promotionPolicy: string;
  policyEvidence: string | null;
  suggestedApproach: string;
  generatedContent: string | null;
  trackingLinkId: string | null;
};

/**
 * Shape a stored candidate for the UI, with provenance already separated so
 * the client never has to parse or guess where a value came from.
 */
export function toClientCandidate(row: CandidateRow) {
  let evidence: WebEvidence | null = null;
  if (row.platform === WEB_PLATFORM && row.policyEvidence) {
    try {
      const parsed = JSON.parse(row.policyEvidence) as Partial<WebEvidence>;
      if (typeof parsed?.sourceQuery === "string") {
        evidence = {
          // Rows written before these fields existed simply read as unknown.
          pageType: normalizePageType(parsed.pageType),
          actionability: normalizeActionability(parsed.actionability),
          audienceMatch: normalizeMatchScore(parsed.audienceMatch),
          problemMatch: normalizeMatchScore(parsed.problemMatch),
          contextMatch: normalizeContextMatch(parsed.contextMatch),
          opportunityQuality: normalizeOpportunityQuality(parsed.opportunityQuality),
          rejectionReason:
            typeof parsed.rejectionReason === "string" ? parsed.rejectionReason : "",
          audienceSignal:
            typeof parsed.audienceSignal === "string" ? parsed.audienceSignal : undefined,
          painPoint: typeof parsed.painPoint === "string" ? parsed.painPoint : undefined,
          growthAction:
            typeof parsed.growthAction === "string" ? parsed.growthAction : undefined,
          sourceQuery: parsed.sourceQuery,
          position: Number(parsed.position) || 0,
          domain: String(parsed.domain ?? ""),
          rulesRead: false,
        };
      }
    } catch {
      evidence = null;
    }
  }

  return {
    id: row.id,
    platform: row.platform,
    name: row.name,
    url: row.url,
    // RETRIEVED for web (the search snippet), platform description otherwise.
    description: row.description,
    memberCount: row.memberCount,
    audienceFit: row.audienceFit,
    relevanceReason: row.relevanceReason ?? "",
    promotionPolicy: row.promotionPolicy,
    // Legacy persistence: these columns still exist on stored rows, and the
    // engagement classification is internal. Neither reaches the customer.
    suggestedApproach: row.suggestedApproach,
    evidence,
    isDemo: false as const,
  };
}

/** The stored actionability of a candidate, defaulting to unknown. */
export function storedActionability(row: {
  platform: string;
  policyEvidence: string | null;
}): Actionability {
  if (row.platform !== WEB_PLATFORM || !row.policyEvidence) return "unknown";
  try {
    const parsed = JSON.parse(row.policyEvidence) as Partial<WebEvidence>;
    return normalizeActionability(parsed?.actionability);
  } catch {
    return "unknown";
  }
}

/** The stored acquisition verdict of a candidate, defaulting to unknown. */
export function storedOpportunityQuality(row: {
  platform: string;
  policyEvidence: string | null;
}): OpportunityQuality {
  if (row.platform !== WEB_PLATFORM || !row.policyEvidence) return "unknown";
  try {
    const parsed = JSON.parse(row.policyEvidence) as Partial<WebEvidence>;
    return normalizeOpportunityQuality(parsed?.opportunityQuality);
  } catch {
    return "unknown";
  }
}

