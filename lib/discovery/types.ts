// AUDIENCE DISCOVERY (earned) — distinct from owned distribution (lib/publishers).
// A discovery provider finds EXTERNAL communities where an app's audience already
// gathers. It never posts; publishing stays permission-gated in the app layer.

export type PromotionPolicy =
  | "allowed"
  | "restricted"
  | "requires_permission"
  | "prohibited"
  | "unknown";

export type SuggestedApproach =
  | "direct_post"
  | "educational_post"
  | "moderator_request"
  | "community_partnership"
  | "do_not_post";

/**
 * Provenance for a candidate found through public web search. Every field here
 * is RETRIEVED/OBSERVED — it is what the search provider actually returned —
 * except sourceQuery, which is the AI-generated query we ran.
 */
export interface SearchEvidence {
  sourceQuery: string;
  position: number; // Google organic rank
  domain: string;
  snippet?: string; // the search result's own description
}

/** Raw community as retrieved from a platform (real data only). */
export interface RawCommunity {
  platform: string;
  name: string;
  url: string;
  description?: string;
  memberCount?: number; // REAL, from the platform
  rules?: string[]; // REAL community rules
  /** Set by search-based providers; absent for platform-API providers. */
  evidence?: SearchEvidence;
}

/** A community after AI relevance + policy analysis over the real data. */
export interface ScoredCommunity extends RawCommunity {
  audienceFit: number; // AI 0-100
  relevanceReason: string; // AI
  promotionPolicy: PromotionPolicy; // AI, derived from the REAL rules
  policyEvidence?: string; // which rule drove it
  suggestedApproach: SuggestedApproach; // AI
}

export interface DiscoveryQuery {
  queries: string[];
  limitPerQuery?: number;
}

export interface CommunityDiscoveryProvider {
  readonly platform: string;
  discover(query: DiscoveryQuery): Promise<RawCommunity[]>;
}
