import { chatJSON } from "./openai";

export type Priority = "high" | "medium" | "low";

export type ChannelRec = {
  platform: "reddit" | "youtube" | "instagram" | "tiktok" | "discord";
  priority: Priority;
  why: string;
  format: string;
  angle: string;
};

export type AppAnalysis = {
  primaryCategory: string;
  secondaryCategories: string[];
  audience: string;
  valueProp: string;
  summary: string;
  mainProblem: string;
  recommendedChannels: ChannelRec[];
};

export type AppInput = {
  name: string;
  description?: string;
  storeUrl?: string;
  websiteUrl?: string;
  targetAudience?: string;
};

const SYSTEM =
  "You are AI Growth Kit's promotion strategist. Given a newly created mobile " +
  "app, classify it and recommend the channels best suited to acquire its FIRST " +
  "users (cold start). Different apps must get different channels. Respond ONLY " +
  "with a JSON object, no prose.";

const ALLOWED = ["reddit", "youtube", "instagram", "tiktok", "discord"];

/** Keep prompt size (and therefore cost) bounded regardless of input length. */
const clip = (v: string | undefined, max: number, fallback: string) =>
  v && v.trim() ? v.trim().slice(0, max) : fallback;

function buildPrompt(input: AppInput): string {
  return (
    `App name: ${clip(input.name, 200, "(none)")}\n` +
    `Description: ${clip(input.description, 4000, "(none)")}\n` +
    `Store URL: ${clip(input.storeUrl, 300, "(none)")}\n` +
    `Website: ${clip(input.websiteUrl, 300, "(none)")}\n` +
    `Target audience: ${clip(input.targetAudience, 300, "(unknown)")}\n\n` +
    `Available channels: ${ALLOWED.join(", ")}.\n` +
    `Pick the 2-3 channels that best fit THIS app for acquiring its first ` +
    `users — do NOT recommend all of them.\n\n` +
    `Return JSON exactly:\n` +
    `{\n` +
    `  "primaryCategory": string,\n` +
    `  "secondaryCategories": string[],\n` +
    `  "summary": string (one sentence, what the product is),\n` +
    `  "mainProblem": string (the core user problem it solves),\n` +
    `  "audience": string,\n` +
    `  "valueProp": string,\n` +
    `  "recommendedChannels": [\n` +
    `    { "platform": "<one of ${ALLOWED.join("|")}>", "priority": "high|medium|low", ` +
    `"why": string, "format": string, "angle": string }\n` +
    `  ]\n` +
    `}`
  );
}

const PRIORITIES: Priority[] = ["high", "medium", "low"];
const MAX_CHANNELS = 5;
const MAX_SECONDARY = 6;

/** Accept only real strings, trimmed and length-capped. Never stringify objects. */
const text = (v: unknown, max: number): string =>
  typeof v === "string" ? v.trim().slice(0, max) : "";

/**
 * Coerce an untrusted analysis object into the exact AppAnalysis shape.
 *
 * This is applied to model output AND to a precomputed analysis posted back by
 * the browser (the Google Play review screen), so nothing arbitrary from a
 * client can reach the database or the PROMOTE UI.
 */
export function normalizeAnalysis(input: unknown): AppAnalysis {
  const raw = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;

  const channels: ChannelRec[] = (
    Array.isArray(raw.recommendedChannels) ? raw.recommendedChannels : []
  )
    .filter((c): c is Record<string, unknown> => !!c && typeof c === "object")
    .filter((c) => typeof c.platform === "string" && ALLOWED.includes(c.platform))
    .slice(0, MAX_CHANNELS)
    .map((c) => ({
      platform: c.platform as ChannelRec["platform"],
      priority: PRIORITIES.includes(c.priority as Priority) ? (c.priority as Priority) : "medium",
      why: text(c.why, 400),
      format: text(c.format, 200),
      angle: text(c.angle, 400),
    }));

  return {
    primaryCategory: text(raw.primaryCategory, 120) || "unknown",
    secondaryCategories: (Array.isArray(raw.secondaryCategories) ? raw.secondaryCategories : [])
      .map((c) => text(c, 120))
      .filter(Boolean)
      .slice(0, MAX_SECONDARY),
    audience: text(raw.audience, 600),
    valueProp: text(raw.valueProp, 600),
    summary: text(raw.summary, 600),
    mainProblem: text(raw.mainProblem, 600),
    recommendedChannels: channels,
  };
}

export async function analyzeApp(input: AppInput): Promise<AppAnalysis> {
  return normalizeAnalysis(await chatJSON<Partial<AppAnalysis>>(SYSTEM, buildPrompt(input)));
}
