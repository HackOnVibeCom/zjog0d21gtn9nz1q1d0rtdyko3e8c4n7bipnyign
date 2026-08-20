/**
 * How discovery evidence is presented.
 *
 * These rules decide which section a source appears in: a strong audience
 * match, a weaker one shown honestly, or background research. They live here
 * rather than inside the page so the grouping can be tested.
 */

export type PresentableCandidate = {
  platform?: string;
  isDemo?: boolean;
  evidence?: {
    actionability?: string;
    opportunityQuality?: string;
  } | null;
};

/** Background evidence about the market rather than a direct audience match. */
export function isResearchOnly(c: PresentableCandidate): boolean {
  return c.evidence?.actionability === "research_only";
}

/** A source where the people genuinely look like this product's users. */
export function isStrongOpportunity(c: PresentableCandidate): boolean {
  return !isResearchOnly(c) && c.evidence?.opportunityQuality === "strong_opportunity";
}

/**
 * A real discussion whose audience we are not confident about — wrong crowd,
 * or simply not judged. Kept visible and labelled honestly.
 */
export function isLowConfidence(c: PresentableCandidate): boolean {
  return !isResearchOnly(c) && !isStrongOpportunity(c);
}

export function groupCandidates<T extends PresentableCandidate>(list: T[]) {
  return {
    opportunities: list.filter(isStrongOpportunity),
    lowConfidence: list.filter(isLowConfidence),
    research: list.filter(isResearchOnly),
  };
}
