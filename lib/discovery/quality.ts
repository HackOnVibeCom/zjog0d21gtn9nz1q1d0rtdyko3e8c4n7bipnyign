import { Actionability } from "./actionability";

/**
 * AUDIENCE QUALITY — "are these the right PEOPLE?", not "is this the right topic?"
 *
 * Keyword similarity is a trap for acquisition. A thread about "safety
 * meetings" run by a manufacturing EHS manager, or a "panic button" question
 * on a FreePBX telephony board, matches a consumer safety app's vocabulary
 * perfectly while containing none of its potential users.
 *
 * So the model is asked three separate questions, and the server — not the
 * model — decides what counts as an opportunity.
 */

export type ContextMatch = "strong" | "partial" | "mismatch" | "unknown";

export type OpportunityQuality =
  | "strong_opportunity" // right people, right problem, somewhere they gather
  | "weak_match" // a real discussion, but not our audience
  | "research_only" // not a place to engage at all
  | "unknown";

export const CONTEXT_MATCHES: ContextMatch[] = ["strong", "partial", "mismatch", "unknown"];

/**
 * Thresholds for the main results list.
 *
 * Chosen against the three real production results that motivated this:
 * the EHS "safety meeting topics" thread and the r/freepbx "panic button"
 * thread both sit far below these once the model is asked about the actual
 * participants, while students discussing walking home alone clear them
 * comfortably. Deliberately strict: showing two good rows beats five weak
 * ones, so the bar sits above "plausibly related".
 */
export const MIN_AUDIENCE_MATCH = 65;
export const MIN_PROBLEM_MATCH = 60;

const clamp = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(0, Math.min(100, Math.round(n))) : 0;
};

export function normalizeMatchScore(value: unknown): number {
  return clamp(value);
}

export function normalizeContextMatch(value: unknown): ContextMatch {
  return typeof value === "string" && (CONTEXT_MATCHES as string[]).includes(value)
    ? (value as ContextMatch)
    : "unknown";
}

/**
 * Audience is the ceiling, never an average.
 *
 * The problem being right cannot rescue the wrong people: at audienceMatch 10
 * and problemMatch 90 this returns 10, not 70. The problem score only scales
 * an audience score that is already earned.
 */
export function computeAudienceFit(input: {
  audienceMatch: number;
  problemMatch: number;
  contextMatch: ContextMatch;
}): number {
  const audience = clamp(input.audienceMatch);
  const problem = clamp(input.problemMatch);

  let fit = Math.round(audience * (0.5 + 0.5 * (problem / 100)));

  switch (input.contextMatch) {
    case "mismatch":
      // A different world entirely — cannot present as a good fit whatever
      // the individual numbers say.
      fit = Math.min(fit, 20);
      break;
    case "partial":
      fit = Math.round(fit * 0.85);
      break;
    case "unknown":
      fit = Math.round(fit * 0.95);
      break;
    default:
      break;
  }
  return clamp(fit);
}

/**
 * The deterministic gate. Runs after the model, and the model cannot talk its
 * way past it: a candidate only reaches the main list when the people, the
 * problem and the context all hold up AND the page is somewhere one can
 * actually engage.
 */
export function gradeOpportunity(input: {
  actionability: Actionability;
  audienceMatch: number;
  problemMatch: number;
  contextMatch: ContextMatch;
}): { quality: OpportunityQuality; audienceFit: number } {
  const audienceMatch = clamp(input.audienceMatch);
  const problemMatch = clamp(input.problemMatch);
  const contextMatch = input.contextMatch;
  const audienceFit = computeAudienceFit({ audienceMatch, problemMatch, contextMatch });

  // Research pages are settled earlier and are never an engagement target.
  if (input.actionability === "research_only") {
    return { quality: "research_only", audienceFit };
  }

  const strong =
    input.actionability === "actionable" &&
    contextMatch !== "mismatch" &&
    audienceMatch >= MIN_AUDIENCE_MATCH &&
    problemMatch >= MIN_PROBLEM_MATCH;

  if (strong) return { quality: "strong_opportunity", audienceFit };

  // A real discussion with the wrong people is still a real discussion — we
  // keep it, honestly labelled, rather than pretending it is research.
  return { quality: "weak_match", audienceFit };
}

/**
 * The single source of truth for "may this candidate be turned into a post and
 * a tracking link?".
 *
 * Being a community-shaped URL is not enough — a page can be a real discussion
 * and still be the wrong crowd, or carry an explicit do_not_post. Every
 * condition below must hold, and anything missing or ambiguous (including rows
 * stored before this gate existed) fails closed.
 *
 * The server calls this before creating anything; the UI is given its result
 * so the button can never disagree with what the server will allow.
 */
export function canPrepareCandidate(input: {
  actionability: Actionability;
  opportunityQuality: OpportunityQuality;
  contextMatch: ContextMatch;
  audienceMatch: number;
  problemMatch: number;
  suggestedApproach: string;
}): boolean {
  return (
    input.opportunityQuality === "strong_opportunity" &&
    input.actionability === "actionable" &&
    input.suggestedApproach !== "do_not_post" &&
    input.contextMatch !== "mismatch" &&
    normalizeMatchScore(input.audienceMatch) >= MIN_AUDIENCE_MATCH &&
    normalizeMatchScore(input.problemMatch) >= MIN_PROBLEM_MATCH
  );
}

/** Ranking for the UI: quality first, then fit. Google position is provenance. */
export function qualityRank(quality: OpportunityQuality): number {
  switch (quality) {
    case "strong_opportunity":
      return 0;
    case "weak_match":
      return 1;
    case "unknown":
      return 2;
    default:
      return 3;
  }
}
