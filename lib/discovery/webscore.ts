import { chatJSON } from "../openai";
import { SuggestedApproach } from "./types";
import { WebResult } from "./web";
import {
  Actionability,
  ACTIONABILITIES,
  enforceActionability,
  normalizeActionability,
  normalizePageType,
  PAGE_TYPES,
  PageType,
  urlPageTypeHint,
} from "./actionability";
import {
  ContextMatch,
  CONTEXT_MATCHES,
  gradeOpportunity,
  MIN_AUDIENCE_MATCH,
  normalizeContextMatch,
  normalizeMatchScore,
  OpportunityQuality,
  qualityRank,
} from "./quality";

/**
 * AI market & audience intelligence over REAL search evidence.
 *
 * The model sees only what the search provider actually returned (title,
 * snippet, domain, position, the query that found it). It reads that evidence
 * for what it reveals about the audience — who they are, what they need, and
 * how that should inform paid acquisition and positioning. It never proposes
 * contacting anyone, and it must not assert facts nobody retrieved, such as
 * member counts, activity levels or posting rules.
 */

export type ScoredWebCandidate = WebResult & {
  audienceFit: number; // DERIVED server-side from the three matches below
  audienceMatch: number; // AI 0-100 — are these the product's actual users?
  problemMatch: number; // AI 0-100 — is it the same real-world problem?
  contextMatch: ContextMatch; // AI — same world, or a vocabulary collision?
  opportunityQuality: OpportunityQuality; // DERIVED server-side
  rejectionReason: string; // AI, why it is not a fit (empty when it is)
  pageType: PageType; // AI (URL-derived where the URL is unambiguous)
  actionability: Actionability; // AI, then enforced server-side
  relevanceReason: string; // AI, grounded in the snippet
  /** What this source suggests about the audience. AI INFERENCE. */
  audienceSignal: string;
  /** The need or frustration visible in the evidence. AI INFERENCE. */
  painPoint: string;
  /** How this should change acquisition strategy — never an outreach action. */
  growthAction: string;
  /**
   * Internal engagement-suitability classification, derived server-side from
   * actionability. It is not shown to the customer and is not an instruction
   * to contact anyone; the recommendation gate reads it.
   */
  suggestedApproach: SuggestedApproach;
};

/**
 * Claims a search result cannot support. If the model produces one anyway we
 * strip it rather than show the customer an invented number.
 */
// A size claim: a number, optionally followed by qualifiers, next to an
// audience noun ("80,000 active members", "12k subscribers", "1M+ users").
const FABRICATED_METRIC =
  /\b\d[\d.,]*\s*(k|m|thousand|million)?\+?(\s+(active|monthly|daily|weekly|registered|online|verified|unique))*\s*(members|subscribers|users|followers|participants|readers|visitors)\b/i;
// An activity claim, which a search result also cannot support.
const FABRICATED_ACTIVITY =
  /\b(daily|monthly|weekly)\s+active\b|\bposts?\s+per\s+(day|week|month)\b|\b(highly|very|extremely)\s+active\b/i;
const FABRICATED_RULES =
  /\b(rule\s*\d|their rules|the rules (state|say|allow|prohibit)|moderators (allow|permit|prohibit)|self-promotion is (allowed|prohibited))\b/i;

export function containsUnsupportedClaim(text: string): boolean {
  return FABRICATED_METRIC.test(text) || FABRICATED_ACTIVITY.test(text) || FABRICATED_RULES.test(text);
}

/** Remove only the offending sentences, keeping the grounded reasoning. */
export function stripUnsupportedClaims(text: string): string {
  const kept = text
    .split(/(?<=[.!?])\s+/)
    .filter((sentence) => !containsUnsupportedClaim(sentence))
    .join(" ")
    .trim();
  return kept;
}

const text = (v: unknown, max: number): string =>
  typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "";

type ScoreRow = {
  i?: unknown;
  audienceMatch?: unknown;
  problemMatch?: unknown;
  contextMatch?: unknown;
  rejectionReason?: unknown;
  pageType?: unknown;
  actionability?: unknown;
  relevanceReason?: unknown;
  audienceSignal?: unknown;
  painPoint?: unknown;
  growthAction?: unknown;
};

/** Coerce model output into the exact scored shape, dropping invented claims. */
export function normalizeScoreRows(input: unknown, results: WebResult[]): ScoredWebCandidate[] {
  const raw = (input && typeof input === "object" ? input : {}) as { results?: unknown };
  const rows = Array.isArray(raw.results) ? (raw.results as ScoreRow[]) : [];

  const byIndex = new Map<number, ScoreRow>();
  for (const r of rows) {
    const i = Number(r?.i);
    if (Number.isInteger(i) && i >= 0 && i < results.length && !byIndex.has(i)) {
      byIndex.set(i, r);
    }
  }

  return results
    .map((result, i): ScoredWebCandidate => {
      const row = byIndex.get(i);
      const reason = stripUnsupportedClaims(text(row?.relevanceReason, 400));
      // Derived, never requested: the model is not asked how to approach a
      // page, so it cannot recommend contacting anyone. A page that is not
      // clearly a live discussion stays "do_not_post" by default.
      const approach: SuggestedApproach =
        normalizeActionability(row?.actionability) === "actionable"
          ? "educational_post"
          : "do_not_post";

      // The URL is retrieved data, so an unambiguous URL shape beats a guess.
      const enforced = enforceActionability({
        pageType: urlPageTypeHint(result) ?? normalizePageType(row?.pageType),
        actionability: normalizeActionability(row?.actionability),
        suggestedApproach: approach,
      });

      // The server decides quality and fit — the model only supplies evidence.
      const audienceMatch = normalizeMatchScore(row?.audienceMatch);
      const problemMatch = normalizeMatchScore(row?.problemMatch);
      const contextMatch = normalizeContextMatch(row?.contextMatch);
      const graded = gradeOpportunity({
        actionability: enforced.actionability,
        audienceMatch,
        problemMatch,
        contextMatch,
      });

      return {
        ...result,
        audienceFit: graded.audienceFit,
        audienceMatch,
        problemMatch,
        contextMatch,
        opportunityQuality: graded.quality,
        rejectionReason:
          graded.quality === "strong_opportunity"
            ? ""
            : stripUnsupportedClaims(text(row?.rejectionReason, 300)),
        pageType: enforced.pageType,
        actionability: enforced.actionability,
        relevanceReason:
          reason ||
          (result.snippet
            ? `Matched the search "${result.sourceQuery}"; judge relevance from the snippet.`
            : `Matched the search "${result.sourceQuery}".`),
        audienceSignal: stripUnsupportedClaims(text(row?.audienceSignal, 300)),
        painPoint: stripUnsupportedClaims(text(row?.painPoint, 300)),
        growthAction: stripUnsupportedClaims(text(row?.growthAction, 300)),
        suggestedApproach: enforced.suggestedApproach as SuggestedApproach,
      };
    })
    // Acquisition quality decides the order. Google's position is provenance,
    // not a ranking: a #1 result with the wrong people ranks below a #8 result
    // with the right ones.
    .sort((a, b) => {
      const byQuality = qualityRank(a.opportunityQuality) - qualityRank(b.opportunityQuality);
      return byQuality !== 0 ? byQuality : b.audienceFit - a.audienceFit;
    });
}

export async function scoreWebCandidates(
  app: {
    name: string;
    summary?: string;
    category?: string;
    audience?: string;
    mainProblem?: string;
    valueProp?: string;
  },
  results: WebResult[]
): Promise<ScoredWebCandidate[]> {
  if (!results.length) return [];

  const evidence = results.map((r, i) => ({
    i,
    title: r.title,
    domain: r.domain,
    url: r.url.slice(0, 300), // the URL shape is a strong page-type signal
    snippet: (r.snippet ?? "").slice(0, 300),
    foundVia: r.sourceQuery,
    googlePosition: r.position,
  }));

  const user =
    `App: ${app.name}\n` +
    `What it is: ${app.summary ?? "(unknown)"}\n` +
    `Category: ${app.category ?? "(unknown)"}\n` +
    `Target audience: ${app.audience ?? "(unknown)"}\n` +
    `Main problem: ${app.mainProblem ?? "(unknown)"}\n` +
    `Value proposition: ${app.valueProp ?? "(unknown)"}\n\n` +
    `First, picture this product's actual user: who they are, whether they are ` +
    `a consumer or a professional, and in what situation they would need it. ` +
    `Then judge every result against THAT PERSON.\n\n` +
    `Below are REAL public web search results. Judge each one on THREE SEPARATE ` +
    `dimensions, plus the kind of page it is.\n\n` +
    `1. audienceMatch (0-100) — are the PEOPLE writing and reading this page ` +
    `plausibly the app's target users?\n` +
    `   Ask: who is actually talking here? A professional? A hobbyist? An ` +
    `engineer? A parent? A student? Score by WHO THEY ARE, never by which ` +
    `words appear. Shared vocabulary is not a shared audience.\n` +
    `   Examples of the trap: a consumer safety app and a thread where a ` +
    `workplace health-and-safety officer plans staff safety meetings — those ` +
    `are professionals doing their job, audienceMatch is LOW. The same app and ` +
    `a thread about wiring a panic button into phone system hardware — those ` +
    `are IT engineers, audienceMatch is LOW.\n\n` +
    `2. problemMatch (0-100) — is the discussion about the SAME real-world ` +
    `problem and use case the app solves?\n` +
    `   A high problemMatch must NOT rescue a low audienceMatch. The wrong ` +
    `people discussing a similar-sounding problem is still the wrong place.\n\n` +
    `3. contextMatch — "strong" (same world, same kind of person), "partial" ` +
    `(adjacent, some overlap), "mismatch" (the words collide but the world is ` +
    `different: professional vs consumer, industrial vs personal, ` +
    `infrastructure vs everyday use), or "unknown".\n\n` +
    `4. pageType + actionability — what KIND of page it is, and whether the ` +
    `customer could realistically engage the audience there.\n` +
    `   pageType: one of ${PAGE_TYPES.join(", ")}.\n` +
    `   actionability: one of ${ACTIONABILITIES.join(", ")}.\n` +
    `   "actionable" = a place where people are talking and one could join the ` +
    `conversation (discussion threads, community groups, forums, Q&A, social ` +
    `posts).\n` +
    `   "research_only" = worth reading to understand the audience, but not a ` +
    `place to post (articles, news, research pages, landing pages, ` +
    `directories).\n` +
    `   "unknown" = the evidence does not make it clear.\n\n` +
    `These are independent. Do NOT lower the match scores just because a page ` +
    `is research_only — an article proving the problem is real is valuable.\n\n` +
    `Be strict. Most search results share the product's words without ` +
    `containing its users; scoring those highly wastes the customer's effort. ` +
    `A page only deserves audienceMatch above ${MIN_AUDIENCE_MATCH} if you can ` +
    `name the people on it and they are plausibly this product's users.\n\n` +
    `Keep every text field to ONE short sentence — this runs inside a request ` +
    `budget, and long answers are not better answers.\n\n` +
    `When a result is NOT a fit, say why in one short "rejectionReason" — ` +
    `e.g. "participants are workplace safety officers, not consumers" or ` +
    `"thread is about phone-system hardware, not personal safety".\n\n` +
    `CRITICAL HONESTY RULES:\n` +
    `- You know ONLY the title, URL, snippet, domain and search position shown. ` +
    `Nobody opened the page.\n` +
    `- NEVER state member counts, traffic, activity levels or posting rules — ` +
    `nobody retrieved them. Saying "this community has 80,000 members" is a ` +
    `fabrication and is forbidden.\n` +
    `- You do NOT know whether posting, commenting or links are permitted ` +
    `anywhere. Never imply that you do.\n` +
    `- Ground "relevanceReason" in what the snippet actually says.\n` +
    `- For research_only pages use suggestedApproach "do_not_post".\n\n` +
    `Results:\n${JSON.stringify(evidence)}\n\n` +
    `Return JSON { "results": [ { "i": number, ` +
    `"audienceMatch": 0-100, "problemMatch": 0-100, ` +
    `"contextMatch": "${CONTEXT_MATCHES.join("|")}", ` +
    `"rejectionReason": string (empty if it IS a good fit), ` +
    `"pageType": "${PAGE_TYPES.join("|")}", ` +
    `"actionability": "${ACTIONABILITIES.join("|")}", ` +
    `"relevanceReason": string, ` +
    `"audienceSignal": string (ONE sentence: what this source suggests about ` +
    `who the audience is and what they are doing), ` +
    `"painPoint": string (ONE sentence: the need or frustration visible in the ` +
    `evidence, in the words these people actually use; empty if none is ` +
    `visible), ` +
    `"growthAction": string (ONE sentence: how this evidence should change ` +
    `acquisition strategy — an ad angle, a search-intent idea, a positioning ` +
    `or value-proposition change, a message to test, or an audience hypothesis ` +
    `to validate. NEVER an instruction to post, comment, message, contact or ` +
    `reply anywhere) } ] }`;

  const raw = await chatJSON<{ results?: ScoreRow[] }>(
    "You are a market and audience research analyst. You read public web " +
      "search evidence to work out who a product's users are, what they need " +
      "and how that should inform paid acquisition, positioning and " +
      "messaging. You never recommend posting, commenting, messaging or " +
      "contacting anyone, and you never invent facts you were not given. " +
      "Respond ONLY with JSON.",
    user
  );
  return normalizeScoreRows(raw, results);
}
