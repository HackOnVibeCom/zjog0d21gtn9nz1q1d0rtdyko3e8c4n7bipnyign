import { chatJSON } from "./openai";

export type AudienceProfile = {
  personas: string[];
  problems: string[];
  interests: string[];
  keywords: string[];
  /** Short queries used to find communities (e.g. subreddits). */
  searchQueries: string[];
  negativeKeywords: string[];
};

const SYSTEM =
  "You model the audience of a newly created app so we can find where those " +
  "people already gather online. Respond ONLY with a JSON object.";

export async function buildAudienceProfile(input: {
  name: string;
  description?: string;
  category?: string;
  audience?: string;
}): Promise<AudienceProfile> {
  const user =
    `App: ${input.name}\n` +
    `Description: ${input.description ?? "(none)"}\n` +
    `Category: ${input.category ?? "(unknown)"}\n` +
    `Known audience: ${input.audience ?? "(unknown)"}\n\n` +
    `Produce an audience model. "searchQueries" must be 4-6 SHORT phrases ` +
    `(1-3 words) suitable for searching community names (e.g. subreddits) — ` +
    `topics/interests, NOT the app name.\n\n` +
    `Return JSON:\n` +
    `{ "personas": string[], "problems": string[], "interests": string[], ` +
    `"keywords": string[], "searchQueries": string[], "negativeKeywords": string[] }`;

  const raw = await chatJSON<Partial<AudienceProfile>>(SYSTEM, user);
  const arr = (v: unknown): string[] =>
    Array.isArray(v) ? v.map(String).filter(Boolean) : [];

  return {
    personas: arr(raw.personas),
    problems: arr(raw.problems),
    interests: arr(raw.interests),
    keywords: arr(raw.keywords),
    searchQueries: arr(raw.searchQueries).slice(0, 6),
    negativeKeywords: arr(raw.negativeKeywords),
  };
}
