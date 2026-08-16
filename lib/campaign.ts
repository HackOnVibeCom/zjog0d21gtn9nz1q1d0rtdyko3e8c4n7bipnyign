import { prisma } from "./prisma";
import { generatePost } from "./generate";
import { DiscordPublisher } from "./publishers/discord";
import { SocialPublisher } from "./publishers/types";

const SLUG_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
function randomSlug(n = 6): string {
  let s = "";
  for (let i = 0; i < n; i++) s += SLUG_ALPHABET[Math.floor(Math.random() * SLUG_ALPHABET.length)];
  return s;
}

/** Resolve a publisher for a platform, or null if not yet supported. */
function getPublisher(platform: string): SocialPublisher | null {
  if (platform === "discord") {
    return new DiscordPublisher(process.env.DISCORD_WEBHOOK_URL ?? "");
  }
  return null; // reddit/youtube/… added later
}

/**
 * Orchestrate a full campaign launch for the chosen platforms:
 *   create tracking link → generate content → publish for real → store result.
 */
export async function launchCampaign(
  projectId: string,
  platforms: string[],
  goal = "downloads"
) {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    include: { analysis: true },
  });
  if (!project) throw new Error("Project not found");

  const destination =
    project.storeUrl || project.websiteUrl || "https://example.com";
  const appUrl = process.env.APP_BASE_URL ?? "http://localhost:3000";

  const angleByPlatform: Record<string, string> = {};
  if (project.analysis) {
    try {
      for (const c of JSON.parse(project.analysis.recommendedChannels)) {
        angleByPlatform[c.platform] = c.angle;
      }
    } catch {
      /* ignore malformed */
    }
  }

  const campaign = await prisma.campaign.create({
    data: { projectId, goal, status: "publishing", startedAt: new Date() },
  });

  for (const platform of platforms) {
    const publisher = getPublisher(platform);

    const slug = randomSlug();
    const link = await prisma.trackingLink.create({
      data: { slug, campaignId: campaign.id, platform, destinationUrl: destination },
    });
    const trackingUrl = `${appUrl}/r/${slug}`;

    let content: string;
    try {
      content = await generatePost({
        platform,
        appName: project.name,
        valueProp: project.analysis?.valueProp || project.description || project.name,
        angle: angleByPlatform[platform] ?? "",
        trackingUrl,
      });
    } catch {
      content = `${project.name} — ${project.description ?? ""}\n${trackingUrl}`;
    }

    if (!publisher) {
      await prisma.publication.create({
        data: {
          campaignId: campaign.id,
          platform,
          content: JSON.stringify({ text: content }),
          status: "requires_user_action",
          trackingLinkId: link.id,
          error: `No publisher for "${platform}" yet`,
        },
      });
      continue;
    }

    const result = await publisher.publish({ content });
    await prisma.publication.create({
      data: {
        campaignId: campaign.id,
        platform,
        content: JSON.stringify({ text: content }),
        status: result.status,
        externalPostId: result.externalPostId ?? null,
        externalPostUrl: result.externalPostUrl ?? null,
        trackingLinkId: link.id,
        error: result.error ?? null,
        publishedAt: result.status === "published" ? new Date() : null,
      },
    });
  }

  await prisma.campaign.update({
    where: { id: campaign.id },
    data: { status: "active" },
  });

  return prisma.campaign.findUnique({
    where: { id: campaign.id },
    include: { publications: true, trackingLinks: true },
  });
}
