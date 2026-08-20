import { prisma } from "../prisma";
import { buildAudienceProfile } from "../audience";
import { RedditDiscoveryProvider } from "./reddit";
import { scoreCommunities } from "./score";

/**
 * Reddit DISCOVER slice for a project — research only:
 *   AudienceProfile → real subreddit discovery → real community data →
 *   AI relevance scoring → persist.
 *
 * It drafts no promotional content and creates no outreach link. Reddit API
 * access is still pending approval, so this path does not run today; it is
 * kept so the provider architecture survives without carrying an outreach
 * workflow back with it.
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

  // Fresh run: clear previous reddit candidates for this project.
  await prisma.communityCandidate.deleteMany({ where: { projectId, platform: "reddit" } });

  const results = [];

  for (const c of scored) {
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
        // Discovery is market research: it drafts no promotional post and
        // mints no outreach link. Both columns stay for stored history.
        generatedContent: null,
        trackingLinkId: null,
      },
    });
    results.push(saved);
  }

  return { audience, communities: results };
}
