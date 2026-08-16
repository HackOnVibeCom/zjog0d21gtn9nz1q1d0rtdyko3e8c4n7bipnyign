import { clampDailyBudgetMicros } from "../googleAds/execution";
import { DEMO_MAX_DAILY_BUDGET_MICROS, MARKETS } from "./workspace";

/**
 * GROWTH AUTOPILOT — the decision layer, and the boundary it may not cross.
 *
 * The product's whole premise is that a model can choose where to spend
 * attention. Its whole safety premise is that a model can never choose how much
 * money is at stake. So the recommendation is advisory and the ceiling is
 * deterministic server code: whatever is proposed, requested or sent from a
 * browser, the amount that reaches Google is clamped here first.
 *
 * A customer's approved ceiling is the outer bound; the product maximum bounds
 * even that. Raising either requires a human, not a better argument from a model.
 */

export type Goal = "app_installs";

export type AutopilotInput = {
  goal: Goal;
  market: string;
  /** What the judge approved, in micros. Treated as a request, not a decision. */
  approvedDailyBudgetMicros: number;
};

export type AutopilotPlan = {
  goal: Goal;
  market: string;
  marketLabel: string;
  strategy: string;
  reasoning: string[];
  /** What will actually be sent to Google after the server clamp. */
  dailyBudgetMicros: number;
  approvedDailyBudgetMicros: number;
  /** True when the request had to be reduced to satisfy policy. */
  clampedByPolicy: boolean;
  channel: string;
  campaignStatus: "PAUSED";
};

export function normalizeMarket(raw: unknown): string {
  const code = typeof raw === "string" ? raw.trim().toUpperCase() : "";
  return MARKETS.some((m) => m.code === code) ? code : MARKETS[0].code;
}

/**
 * Produce the plan.
 *
 * Deliberately rule-based rather than model-generated: the sandbox must give
 * every judge the same, explainable answer, and a plan that changes wording on
 * each run would obscure the one thing worth demonstrating — that the ceiling
 * holds. The reasoning states what the product actually does, with no invented
 * performance figures.
 */
export function planGrowth(input: AutopilotInput): AutopilotPlan {
  const market = normalizeMarket(input.market);
  const marketLabel = MARKETS.find((m) => m.code === market)?.label ?? market;

  const approved = Number.isFinite(input.approvedDailyBudgetMicros)
    ? Math.max(0, Math.floor(input.approvedDailyBudgetMicros))
    : 0;
  const dailyBudgetMicros = clampDailyBudgetMicros(approved, DEMO_MAX_DAILY_BUDGET_MICROS);

  return {
    goal: "app_installs",
    market,
    marketLabel,
    strategy: "Google App Campaign optimised for installs",
    reasoning: [
      `The goal is app installs in ${marketLabel}, so the campaign is created where install intent already exists rather than where impressions are cheapest.`,
      "A Google App Campaign is multi-channel: Google places it across its app surfaces from one campaign, instead of managing each placement separately.",
      "The campaign is created PAUSED in Google's test environment — it is a real API resource, and it serves no advertising.",
      approved > dailyBudgetMicros
        ? "The requested daily budget exceeded the sandbox ceiling, so the server reduced it before the request was built."
        : "The daily budget stays inside the approved ceiling, which the server enforces before any request is built.",
    ],
    dailyBudgetMicros,
    approvedDailyBudgetMicros: approved,
    clampedByPolicy: approved > dailyBudgetMicros,
    channel: "MULTI_CHANNEL",
    campaignStatus: "PAUSED",
  };
}
