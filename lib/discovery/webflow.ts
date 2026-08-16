import { prisma } from "../prisma";
import { generatePost } from "../generate";
import { randomSlug } from "../slug";
import {
  Actionability,
  normalizeActionability,
  normalizePageType,
  PageType,
} from "./actionability";
import {
  canPrepareCandidate,
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
    suggestedApproach: row.suggestedApproach,
    generatedContent: row.generatedContent,
    hasTrackingLink: Boolean(row.trackingLinkId),
    // The server's own verdict, so the UI cannot offer an action the server
    // will refuse. Presentation mirrors this; it never re-derives it.
    canPrepare: candidateIsRecommended(row),
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

/**
 * Is this stored candidate genuinely recommended? Reads the persisted
 * classification only — never anything the browser sent. Rows missing the
 * quality metadata (written before the gate existed) fail closed.
 */
export function candidateIsRecommended(row: {
  platform: string;
  policyEvidence: string | null;
  suggestedApproach: string;
}): boolean {
  if (row.platform !== WEB_PLATFORM || !row.policyEvidence) return false;
  let parsed: Partial<WebEvidence>;
  try {
    parsed = JSON.parse(row.policyEvidence) as Partial<WebEvidence>;
  } catch {
    return false;
  }
  return canPrepareCandidate({
    actionability: normalizeActionability(parsed.actionability),
    opportunityQuality: normalizeOpportunityQuality(parsed.opportunityQuality),
    contextMatch: normalizeContextMatch(parsed.contextMatch),
    audienceMatch: normalizeMatchScore(parsed.audienceMatch),
    problemMatch: normalizeMatchScore(parsed.problemMatch),
    suggestedApproach: row.suggestedApproach,
  });
}

/**
 * Prepare ONE chosen opportunity: create its tracking link and draft a post.
 * Nothing is published — the customer copies the draft and posts it themselves,
 * respecting each community's own rules.
 *
 * Research-only pages are refused here, not merely hidden in the UI: an
 * article is not a posting opportunity no matter what a tampered request says.
 * "unknown" is allowed, because it also covers genuine discussion pages we
 * could not classify — the UI states that posting rules are unverified.
 */
export async function prepareCandidate(projectId: string, candidateId: string) {
  const candidate = await prisma.communityCandidate.findFirst({
    where: { id: candidateId, projectId }, // tenant-scoped by the caller's gate
  });
  if (!candidate) return null;

  if (storedActionability(candidate) === "research_only") {
    // No tracking link, no generated content — refuse before anything is made.
    return { candidate, error: "research_only" as const };
  }

  // Everything else the gate rejects — a weak match, an unjudged candidate, an
  // explicit do_not_post, a context mismatch, scores under the thresholds — is
  // refused here too. The browser is never consulted: a forged candidateId
  // reaches this same check.
  if (!candidateIsRecommended(candidate)) {
    return { candidate, error: "not_recommended" as const };
  }

  const project = await prisma.project.findUnique({
    where: { id: projectId },
    include: { analysis: true },
  });
  if (!project) return null;

  let campaign = await prisma.campaign.findFirst({ where: { projectId, goal: "discover" } });
  if (!campaign) {
    campaign = await prisma.campaign.create({
      data: { projectId, goal: "discover", status: "active", startedAt: new Date() },
    });
  }

  const destination = project.storeUrl || project.websiteUrl;
  if (!destination) return { candidate, error: "no_destination" as const };

  const appUrl = (process.env.APP_BASE_URL ?? "http://localhost:3000").replace(/\/+$/, "");
  let trackingLinkId = candidate.trackingLinkId;
  let slug: string | null = null;

  if (trackingLinkId) {
    const existing = await prisma.trackingLink.findUnique({ where: { id: trackingLinkId } });
    slug = existing?.slug ?? null;
  }
  if (!slug) {
    const domain = (() => {
      try {
        return new URL(candidate.url).hostname;
      } catch {
        return "web";
      }
    })();
    const link = await prisma.trackingLink.create({
      data: {
        slug: randomSlug(),
        campaignId: campaign.id,
        platform: `web:${domain}`.slice(0, 100),
        destinationUrl: destination,
      },
    });
    trackingLinkId = link.id;
    slug = link.slug;
  }

  const trackingUrl = `${appUrl}/r/${slug}`;
  let content: string;
  try {
    content = await generatePost({
      platform: `the public discussion page "${candidate.name}"`,
      appName: project.name,
      valueProp: project.analysis?.valueProp || project.description || project.name,
      angle: candidate.relevanceReason ?? "",
      trackingUrl,
    });
  } catch {
    content = `${project.name}\n${trackingUrl}`;
  }

  const updated = await prisma.communityCandidate.update({
    where: { id: candidate.id },
    data: { generatedContent: content, trackingLinkId },
  });
  return { candidate: updated, trackingUrl };
}
