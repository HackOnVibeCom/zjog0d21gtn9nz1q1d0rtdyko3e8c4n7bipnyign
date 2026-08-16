import { chatJSON } from "../openai";

/**
 * AI-generated search queries for WEB audience discovery.
 *
 * The customer never types keywords. We derive them from the project's own
 * UNDERSTAND output and aim them at places where the audience already talks
 * about the problem — not at pages that mention the app.
 *
 * The queries themselves are AI INFERENCE, and each one costs a paid search,
 * so the count is capped here rather than trusted from the model.
 */
export const MAX_QUERIES = 6;
const MAX_QUERY_LENGTH = 120;

export type QueryInput = {
  name: string;
  summary?: string;
  audience?: string;
  mainProblem?: string;
  valueProp?: string;
  category?: string;
};

const SYSTEM =
  "You plan customer acquisition research for a software product. You find " +
  "the PEOPLE who have the problem, not pages that share the product's " +
  "vocabulary. You write Google search queries describing the user's own " +
  "situation and words. Respond ONLY with a JSON object.";

/**
 * The angles a query may take. Searching the product category ("personal
 * safety forum") returns whoever uses those words — industrial safety
 * officers, telephony engineers — so queries describe the person and the
 * moment instead.
 */
export const QUERY_ANGLES = [
  "pain", // how the person describes the problem in their own words
  "moment", // the situation where the need appears
  "question", // what they ask other people for advice about
  "person_situation", // who they are plus what they are doing
  "current_behaviour", // what they use or do about it today
] as const;

const clip = (v: string | undefined, max: number, fallback: string) =>
  v && v.trim() ? v.trim().slice(0, max) : fallback;

/** Trim, de-duplicate and hard-cap whatever the model returns. */
export function normalizeQueries(input: unknown): string[] {
  const raw = (input && typeof input === "object" ? input : {}) as {
    queries?: unknown;
  };
  const list = Array.isArray(raw.queries) ? raw.queries : [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const q of list) {
    if (typeof q !== "string") continue;
    // Collapse whitespace; a query is a single search line.
    const clean = q.replace(/\s+/g, " ").trim().slice(0, MAX_QUERY_LENGTH);
    if (clean.length < 3) continue;
    const key = clean.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(clean);
    if (out.length >= MAX_QUERIES) break;
  }
  return out;
}

/** The query-planning prompt. Exported so its strategy can be asserted on. */
export function discoveryQueryPrompt(input: QueryInput): string {
  return (
    `App: ${clip(input.name, 200, "(unknown)")}\n` +
    `What it is: ${clip(input.summary, 600, "(unknown)")}\n` +
    `Category: ${clip(input.category, 120, "(unknown)")}\n` +
    `Target audience: ${clip(input.audience, 400, "(unknown)")}\n` +
    `Main problem it solves: ${clip(input.mainProblem, 400, "(unknown)")}\n` +
    `Value proposition: ${clip(input.valueProp, 400, "(unknown)")}\n\n` +
    `STEP 1 — work out the acquisition context for THIS product:\n` +
    `  targetUser: who personally has this problem\n` +
    `  situation: what they are doing when it bites\n` +
    `  pain: how THEY would describe it, in their own everyday words\n` +
    `  moment: the trigger — when the need actually appears\n` +
    `  outcome: what they want to happen\n` +
    `  exclude: neighbouring worlds that share this product's vocabulary but ` +
    `contain the WRONG people. Work these out from the product itself. For a ` +
    `consumer app they might be professional, industrial, enterprise or ` +
    `technical-infrastructure versions of the same words; for a B2B tool they ` +
    `might be the consumer/hobbyist versions. Be specific.\n\n` +
    `STEP 2 — write ${MAX_QUERIES} Google search queries that find PUBLIC ` +
    `DISCUSSIONS BY THOSE PEOPLE.\n` +
    `Use a different angle for each query, covering: ${QUERY_ANGLES.join(", ")}.\n\n` +
    `Rules:\n` +
    `- Describe the PERSON and their SITUATION, not the product category.\n` +
    `- Write the words a real person would use, not marketing or industry terms.\n` +
    `- A query naming only the category and a venue ("<category> forum", ` +
    `"<category> community") is FORBIDDEN — it returns whoever shares the ` +
    `vocabulary, including everyone in "exclude".\n` +
    `- Never search for the app's own name, and never look for reviews of it.\n` +
    `- Six near-identical keyword variants are useless; make each angle distinct.\n` +
    `- Plain search lines, no quotes around the whole query, no boolean syntax.\n` +
    `- English.\n\n` +
    `Return JSON {\n` +
    `  "context": { "targetUser": string, "situation": string, "pain": string, ` +
    `"moment": string, "outcome": string, "exclude": string[] },\n` +
    `  "queries": string[]\n` +
    `}.`
  );
}

export async function generateDiscoveryQueries(input: QueryInput): Promise<string[]> {
  const raw = await chatJSON<{ queries?: string[] }>(SYSTEM, discoveryQueryPrompt(input));
  return normalizeQueries(raw);
}
