import { chatJSON } from "../openai";
import {
  RawCommunity,
  ScoredCommunity,
  PromotionPolicy,
  SuggestedApproach,
} from "./types";

const POLICIES = ["allowed", "restricted", "requires_permission", "prohibited", "unknown"];
const APPROACHES = ["direct_post", "educational_post", "moderator_request", "community_partnership", "do_not_post"];

type ScoreRow = {
  i: number;
  audienceFit: number;
  relevanceReason: string;
  promotionPolicy: string;
  policyEvidence?: string;
  suggestedApproach: string;
};

/**
 * AI ranks the REAL communities for audience fit and — from each community's
 * REAL rules — classifies whether promotion is permitted. Conservative by
 * design: fit is an AI ranking, policy is inferred from actual rules.
 */
export async function scoreCommunities(
  app: { name: string; valueProp: string },
  audience: { personas: string[]; problems: string[] },
  communities: RawCommunity[]
): Promise<ScoredCommunity[]> {
  if (!communities.length) return [];

  const list = communities.map((c, i) => ({
    i,
    name: c.name,
    members: c.memberCount ?? null,
    description: (c.description ?? "").slice(0, 200),
    rules: (c.rules ?? []).slice(0, 8),
  }));

  const user =
    `App: ${app.name}\n` +
    `Value: ${app.valueProp}\n` +
    `Audience personas: ${audience.personas.join(", ")}\n` +
    `Audience problems: ${audience.problems.join(", ")}\n\n` +
    `For EACH community, rate how well the app's audience fits (0-100), and ` +
    `from its REAL rules classify whether promotion is permitted. Be ` +
    `conservative: if rules forbid self-promotion or links, use "prohibited" ` +
    `or "requires_permission"; NEVER use "allowed" just because the topic fits. ` +
    `If rules are empty/unclear use "unknown".\n\n` +
    `Communities:\n${JSON.stringify(list)}\n\n` +
    `Return JSON { "results": [ { "i": number, "audienceFit": number, ` +
    `"relevanceReason": string, "promotionPolicy": "${POLICIES.join("|")}", ` +
    `"policyEvidence": string, "suggestedApproach": "${APPROACHES.join("|")}" } ] }`;

  const raw = await chatJSON<{ results?: ScoreRow[] }>(
    "You rank external communities for app user-acquisition and analyze their " +
      "promotion rules honestly. Respond ONLY with JSON.",
    user
  );

  const byIndex = new Map<number, ScoreRow>();
  for (const r of raw.results ?? []) byIndex.set(Number(r.i), r);

  return communities
    .map((c, i): ScoredCommunity => {
      const r = byIndex.get(i);
      const policy = POLICIES.includes(r?.promotionPolicy ?? "")
        ? (r!.promotionPolicy as PromotionPolicy)
        : "unknown";
      const approach = APPROACHES.includes(r?.suggestedApproach ?? "")
        ? (r!.suggestedApproach as SuggestedApproach)
        : "do_not_post";
      return {
        ...c,
        audienceFit: Math.max(0, Math.min(100, Number(r?.audienceFit) || 0)),
        relevanceReason: String(r?.relevanceReason ?? ""),
        promotionPolicy: policy,
        policyEvidence: r?.policyEvidence ? String(r.policyEvidence) : undefined,
        suggestedApproach: approach,
      };
    })
    .sort((a, b) => b.audienceFit - a.audienceFit);
}
