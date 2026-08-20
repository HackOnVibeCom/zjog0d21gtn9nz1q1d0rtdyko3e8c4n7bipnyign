// CLEARLY-LABELED demo fixtures for showing the DISCOVER UX before real Reddit
// credentials are available. These are FICTIONAL and must never be presented as
// real retrieved Reddit data — the API tags them `isDemo` and the UI shows a
// prominent "DEMO / TEST DATA" banner.

export type DemoCommunity = {
  id: string;
  name: string;
  url: string;
  memberCount: number;
  audienceFit: number;
  relevanceReason: string;
  promotionPolicy: string;
  policyEvidence: string;
  suggestedApproach: string;
  generatedContent: string | null;
  isDemo: true;
};

/** Fictional communities (names deliberately non-real) illustrating the UI. */
export function demoCommunities(appName: string): DemoCommunity[] {
  return [
    {
      id: "demo-1",
      name: "ExampleAudienceHub",
      url: "https://example.com/community/example-audience-hub",
      memberCount: 128000,
      audienceFit: 92,
      relevanceReason: `Members actively discuss the exact problem ${appName} solves (illustrative).`,
      promotionPolicy: "restricted",
      policyEvidence: "Self-promo allowed only in the weekly thread (illustrative).",
      suggestedApproach: "educational_post",
      generatedContent: null,
      isDemo: true,
    },
    {
      id: "demo-2",
      name: "SampleEnthusiasts",
      url: "https://example.com/community/sample-enthusiasts",
      memberCount: 44000,
      audienceFit: 81,
      relevanceReason: "Adjacent interest group with high engagement (illustrative).",
      promotionPolicy: "requires_permission",
      policyEvidence: "Rule 4: contact mods before posting links (illustrative).",
      suggestedApproach: "moderator_request",
      generatedContent: null,
      isDemo: true,
    },
    {
      id: "demo-3",
      name: "DemoGeneralChat",
      url: "https://example.com/community/demo-general-chat",
      memberCount: 910000,
      audienceFit: 47,
      relevanceReason: "Broad, low-fit community (illustrative).",
      promotionPolicy: "prohibited",
      policyEvidence: "Rule 1: no promotion of any kind (illustrative).",
      suggestedApproach: "do_not_post",
      generatedContent: null,
      isDemo: true,
    },
  ];
}
