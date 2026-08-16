import { prisma } from "../prisma";
import { buildAudienceProfile } from "../audience";
import { generatePost } from "../generate";
import { RedditDiscoveryProvider } from "./reddit";
import { scoreCommunities } from "./score";

const SLUG_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
function randomSlug(n = 6): string {
  let s = "";
  for (let i = 0; i < n; i++) s += SLUG_ALPHABET[Math.floor(Math.random() * SLUG_ALPHABET.length)];
  return s;
}

// Only these policies may receive prepared content (never "prohibited").
const CONTENT_ELIGIBLE = new Set(["allowed", "restricted", "requires_permission"]);

/**
 * Full Reddit DISCOVER slice for a project:
 *   AudienceProfile → real subreddit discovery → real community data →
 *   AI relevance/policy scoring → community-specific content (top few, and
 *   never for prohibited communities) → per-community tracking link → persist.
 * Publishing is NOT performed here — external posting stays permission-gated.
 */
export async function discoverForProject(projectId: string) {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    include: { analysis: true },
  });
  if (!project) throw new Error("Project not found");

  const audience = await buildAudienceProfile({
    name: project.name,
    description: project.description ?? undefined,
    category: project.analysis?.primaryCategory ?? undefined,
    audience: project.analysis?.audience ?? undefined,
  });

  const queries =
    audience.searchQueries.length > 0
      ? audience.searchQueries
      : [project.analysis?.primaryCategory || project.name];

  const provider = new RedditDiscoveryProvider();
  const raw = (await provider.discover({ queries, limitPerQuery: 4 })).slice(0, 12);

  const scored = await scoreCommunities(
    { name: project.name, valueProp: project.analysis?.valueProp || project.description || project.name },
    { personas: audience.personas, problems: audience.problems },
    raw
  );

  // A dedicated "discover" campaign carries per-community tracking links.
  let campaign = await prisma.campaign.findFirst({
    where: { projectId, goal: "discover" },
  });
  if (!campaign) {
    campaign = await prisma.campaign.create({
      data: { projectId, goal: "discover", status: "active", startedAt: new Date() },
    });
  }

  const destination = project.storeUrl || project.websiteUrl || "https://example.com";
  const appUrl = process.env.APP_BASE_URL ?? "http://localhost:3000";

  // Fresh run: clear previous reddit candidates for this project.
  await prisma.communityCandidate.deleteMany({ where: { projectId, platform: "reddit" } });

  const results = [];
  let contentBudget = 3; // community-specific content only for the top few

  for (const c of scored) {
    let trackingLinkId: string | null = null;
    let content: string | null = null;

    if (CONTENT_ELIGIBLE.has(c.promotionPolicy) && contentBudget > 0) {
      const slug = randomSlug();
      const link = await prisma.trackingLink.create({
        data: {
          slug,
          campaignId: campaign.id,
          platform: `reddit:${c.name}`,
          destinationUrl: destination,
        },
      });
      trackingLinkId = link.id;
      const trackingUrl = `${appUrl}/r/${slug}`;
      try {
        content = await generatePost({
          platform: `reddit community r/${c.name}`,
          appName: project.name,
          valueProp: project.analysis?.valueProp || project.description || project.name,
          angle: c.relevanceReason,
          trackingUrl,
        });
      } catch {
        content = `${project.name}\n${trackingUrl}`;
      }
      contentBudget--;
    }

    const saved = await prisma.communityCandidate.create({
      data: {
        projectId,
        platform: "reddit",
        name: c.name,
        url: c.url,
        description: c.description ?? null,
        memberCount: c.memberCount ?? null,
        rules: c.rules ? JSON.stringify(c.rules) : null,
        audienceFit: c.audienceFit,
        relevanceReason: c.relevanceReason,
        promotionPolicy: c.promotionPolicy,
        policyEvidence: c.policyEvidence ?? null,
        suggestedApproach: c.suggestedApproach,
        generatedContent: content,
        trackingLinkId,
      },
    });
    results.push(saved);
  }

  return { audience, communities: results };
}
