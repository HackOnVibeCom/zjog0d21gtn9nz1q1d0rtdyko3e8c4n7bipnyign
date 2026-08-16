/**
 * The example app a judge explores in the public sandbox.
 *
 * Deterministic and clearly labelled: this is a worked example, not a customer
 * record, and no owner or customer project is ever exposed to the demo. Every
 * field carries its provenance so nothing here can be mistaken for a
 * measurement — there are no impressions, installs, conversions or costs,
 * because a Google test account serves no ads and inventing numbers would make
 * the whole demo untrustworthy.
 */

export type Provenance = "DEMO" | "AI GENERATED" | "RETRIEVED" | "UNKNOWN";

export type DemoFact = { label: string; value: string; provenance: Provenance };

/** The app id used for the sandbox campaign, from a real Google Play listing. */
export const DEMO_APP_ID = "com.iwaskidnapped.app";

export const DEMO_APP = {
  name: "IWasKidnapped",
  category: "Personal safety",
  storeUrl: `https://play.google.com/store/apps/details?id=${DEMO_APP_ID}`,
};

export const UNDERSTAND: DemoFact[] = [
  {
    label: "App name",
    value: "IWasKidnapped",
    provenance: "RETRIEVED",
  },
  {
    label: "Category",
    value: "Personal safety",
    provenance: "RETRIEVED",
  },
  {
    label: "Summary",
    value:
      "A personal-safety app that lets someone raise an alarm and share their location with people they trust when they feel unsafe.",
    provenance: "AI GENERATED",
  },
  {
    label: "Target audience",
    value:
      "People who travel or move around alone and want a fast way to alert someone they trust — students, night-shift workers, lone travellers.",
    provenance: "AI GENERATED",
  },
  {
    label: "Main problem",
    value:
      "In a frightening moment there is no quick, reliable way to tell the right people where you are.",
    provenance: "AI GENERATED",
  },
  {
    label: "Value proposition",
    value: "One action tells the people you trust where you are, before it becomes an emergency.",
    provenance: "AI GENERATED",
  },
];

export const PROMOTE = [
  {
    channel: "Google App Campaign",
    priority: "high",
    why: "Reaches people searching for personal-safety apps and shows across Google's app surfaces, which is where install intent already exists.",
    provenance: "AI GENERATED" as Provenance,
  },
  {
    channel: "Public safety discussions",
    priority: "medium",
    why: "People describe this exact fear in public threads; being useful there earns attention that advertising cannot buy.",
    provenance: "AI GENERATED" as Provenance,
  },
];

export const DISCOVER = [
  {
    title: "Anyone else nervous walking home after a late shift?",
    domain: "reddit.com",
    pageType: "Discussion thread",
    quality: "strong" as const,
    why: "People describing the exact moment this app is for, in their own words.",
    snippet:
      "I finish at 11 and the walk to the bus stop is the worst part of my day — what do you all actually do?",
    provenance: "DEMO" as Provenance,
  },
  {
    title: "Best personal safety apps compared",
    domain: "example-review-site.test",
    pageType: "Article",
    quality: "research" as const,
    why: "Useful for understanding how this market describes itself — not a place to post.",
    snippet: "We looked at what personal safety apps actually offer and where they differ.",
    provenance: "DEMO" as Provenance,
  },
  {
    title: "Panic button wiring for office phone systems",
    domain: "example-forum.test",
    pageType: "Discussion thread",
    quality: "weak" as const,
    why: "Same words, different world — these are facilities engineers, not people walking home.",
    snippet: "Looking to wire a panic button into our PBX extension setup...",
    provenance: "DEMO" as Provenance,
  },
];

/** Markets a judge may choose. Kept short and explicit. */
export const MARKETS = [
  { code: "US", label: "United States" },
  { code: "GB", label: "United Kingdom" },
  { code: "CA", label: "Canada" },
] as const;

/**
 * Budget choices offered in the sandbox, in micros of account currency.
 *
 * These are what the judge may approve. The server clamps whatever arrives to
 * its own maximum regardless, so this list is a convenience, never the control.
 */
export const BUDGET_CHOICES = [
  { micros: 3_000_000, label: "3.00 / day" },
  { micros: 5_000_000, label: "5.00 / day" },
  { micros: 10_000_000, label: "10.00 / day" },
] as const;

export const DEMO_MAX_DAILY_BUDGET_MICROS = 10_000_000;
