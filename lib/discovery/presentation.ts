/**
 * How discovery candidates are presented.
 *
 * These rules decide which section a candidate appears in and whether it may
 * offer the prepare action. They live here rather than inside the page so they
 * can be tested: the UI must never offer an action the server would refuse,
 * and that guarantee is only worth having if it is pinned down.
 *
 * The server's verdict (canPrepare) is authoritative — nothing below re-derives
 * it from scores.
 */

export type PresentableCandidate = {
  platform?: string;
  generatedContent?: string | null;
  canPrepare?: boolean;
  isDemo?: boolean;
  evidence?: {
    actionability?: string;
    opportunityQuality?: string;
  } | null;
};

/** Research evidence is never a posting opportunity. */
export function isResearchOnly(c: PresentableCandidate): boolean {
  return c.evidence?.actionability === "research_only";
}

/** Only a candidate the server judged recommended reaches the main list. */
export function isStrongOpportunity(c: PresentableCandidate): boolean {
  return !isResearchOnly(c) && c.evidence?.opportunityQuality === "strong_opportunity";
}

/**
 * A real discussion we are not recommending — wrong crowd, or simply not
 * judged. Kept visible and honest, but never promotable.
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

/**
 * Exactly the condition the workspace uses to render "Prepare post + tracking
 * link". A draft that already exists needs no prepare action, and demo rows
 * never act on anything.
 */
export function showsPrepareAction(c: PresentableCandidate): boolean {
  return Boolean(c.canPrepare) && c.platform === "web" && !c.generatedContent && !c.isDemo;
}
