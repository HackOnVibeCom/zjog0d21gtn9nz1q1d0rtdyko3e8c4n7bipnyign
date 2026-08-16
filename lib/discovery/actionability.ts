import { WebResult } from "./web";

/**
 * ACTIONABILITY — separating "places you can engage the audience" from "pages
 * that prove the audience exists".
 *
 * A search result can be highly relevant and still be the wrong kind of page:
 * a news article about students fearing to walk home at night is excellent
 * evidence that the problem is real, but it is not somewhere to post.
 *
 * Both the page type and the actionability are AI INFERENCE over retrieved
 * title/snippet/domain/URL — the page itself is never fetched. Nothing here
 * tells us anything about posting permissions, community rules, moderation or
 * whether comments are even open, and nothing here may pretend otherwise.
 */

export const PAGE_TYPES = [
  "discussion_thread",
  "community_group",
  "forum",
  "q_and_a",
  "social_post",
  "article",
  "news",
  "research",
  "landing_page",
  "directory",
  "other",
] as const;
export type PageType = (typeof PAGE_TYPES)[number];

export const ACTIONABILITIES = ["actionable", "research_only", "unknown"] as const;
export type Actionability = (typeof ACTIONABILITIES)[number];

/** Page types that can plausibly be an audience location. */
const ENGAGEABLE = new Set<PageType>([
  "discussion_thread",
  "community_group",
  "forum",
  "q_and_a",
  "social_post",
]);

/** Page types that are evidence about the audience, not a place to reach it. */
const RESEARCH = new Set<PageType>(["article", "news", "research", "landing_page", "directory"]);

export function isResearchType(pageType: PageType): boolean {
  return RESEARCH.has(pageType);
}

export function normalizePageType(value: unknown): PageType {
  return typeof value === "string" && (PAGE_TYPES as readonly string[]).includes(value)
    ? (value as PageType)
    : "other";
}

export function normalizeActionability(value: unknown): Actionability {
  return typeof value === "string" && (ACTIONABILITIES as readonly string[]).includes(value)
    ? (value as Actionability)
    : "unknown";
}

/**
 * URL shapes that identify a page type on their own. The URL is retrieved
 * data, so reading its structure is far more reliable than a model guess —
 * but it still says nothing about whether posting there is allowed.
 */
const URL_HINTS: Array<{ test: RegExp; pageType: PageType }> = [
  { test: /(^|\.)reddit\.com\/r\/[^/]+\/comments\//i, pageType: "discussion_thread" },
  { test: /(^|\.)reddit\.com\/r\/[^/]+\/?$/i, pageType: "community_group" },
  { test: /(^|\.)facebook\.com\/groups\//i, pageType: "community_group" },
  { test: /(^|\.)facebook\.com\/.+\/posts\//i, pageType: "social_post" },
  { test: /(^|\.)(x|twitter)\.com\/[^/]+\/status\//i, pageType: "social_post" },
  { test: /(^|\.)(threads\.net|mastodon\.[^/]+|bsky\.app)\//i, pageType: "social_post" },
  { test: /(^|\.)(stackoverflow\.com|[^/]*stackexchange\.com)\/questions\//i, pageType: "q_and_a" },
  { test: /(^|\.)quora\.com\//i, pageType: "q_and_a" },
  { test: /(^|\.)(discourse|community)\.[^/]+\/t\/[^/]+\/\d+/i, pageType: "discussion_thread" },
  { test: /\/(showthread|viewtopic)\.php/i, pageType: "discussion_thread" },
  { test: /\/(threads?|discussions?|topic)\/[^/]+/i, pageType: "discussion_thread" },
  { test: /\/forums?(\/|$)/i, pageType: "forum" },
];

/** A page type the URL itself establishes, or null when it is not obvious. */
export function urlPageTypeHint(result: Pick<WebResult, "url" | "domain">): PageType | null {
  const target = `${result.domain}${result.url.replace(/^https?:\/\/[^/]*/i, "")}`;
  const full = `${result.domain}${result.url}`;
  for (const { test, pageType } of URL_HINTS) {
    if (test.test(full) || test.test(target)) return pageType;
  }
  return null;
}

/**
 * The server-side invariant. The model's answer is advisory; these rules
 * decide what the customer is actually allowed to act on.
 *
 * - a research-type page can never be actionable, and never carries a
 *   publishing approach
 * - an engageable page type is never research evidence: a question thread is a
 *   place where people talk, whatever the model calls it. It is downgraded to
 *   "unknown" rather than promoted, and audience quality then decides whether
 *   it is worth recommending
 * - an unclassified page is never promoted to actionable on the model's word
 */
export function enforceActionability(input: {
  pageType: PageType;
  actionability: Actionability;
  suggestedApproach: string;
}): { pageType: PageType; actionability: Actionability; suggestedApproach: string } {
  const { pageType } = input;
  let actionability = input.actionability;

  if (RESEARCH.has(pageType)) {
    actionability = "research_only";
  } else if (ENGAGEABLE.has(pageType)) {
    if (actionability === "research_only") actionability = "unknown";
  } else if (actionability === "actionable") {
    // "other" is not evidence of an audience location — never trust an upgrade.
    actionability = "unknown";
  }

  const suggestedApproach =
    actionability === "research_only" ? "do_not_post" : input.suggestedApproach;

  return { pageType, actionability, suggestedApproach };
}

/** Human-readable page type for the UI. */
export function pageTypeLabel(pageType: PageType): string {
  switch (pageType) {
    case "discussion_thread":
      return "Discussion thread";
    case "community_group":
      return "Community group";
    case "forum":
      return "Forum";
    case "q_and_a":
      return "Q&A";
    case "social_post":
      return "Social post";
    case "article":
      return "Article";
    case "news":
      return "News";
    case "research":
      return "Research";
    case "landing_page":
      return "Landing page";
    case "directory":
      return "Directory";
    default:
      return "Unclassified";
  }
}
