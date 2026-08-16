import { SocialPublisher, PublishRequest, PublishResult } from "./types";

/**
 * Publishes a real message to a Discord channel via an incoming webhook.
 * Returns the public message URL so the post is externally verifiable.
 * (This is the productionized version of the proven webhook flow.)
 */
export class DiscordPublisher implements SocialPublisher {
  readonly platform = "discord";

  constructor(private readonly webhookUrl: string) {}

  async publish(req: PublishRequest): Promise<PublishResult> {
    if (!this.webhookUrl) {
      return { status: "failed", error: "DISCORD_WEBHOOK_URL is not configured" };
    }
    try {
      // wait=true → Discord returns the created message (id, channel_id).
      const res = await fetch(`${this.webhookUrl}?wait=true`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: req.content }),
      });
      if (!res.ok) {
        return { status: "failed", error: `Discord HTTP ${res.status}: ${await res.text()}` };
      }
      const msg = (await res.json()) as { id: string; channel_id: string };

      // Build a clickable message URL (needs the guild id from the webhook meta).
      let url: string | undefined;
      try {
        const meta = (await (await fetch(this.webhookUrl)).json()) as {
          guild_id?: string;
        };
        if (meta.guild_id) {
          url = `https://discord.com/channels/${meta.guild_id}/${msg.channel_id}/${msg.id}`;
        }
      } catch {
        /* URL is best-effort; publication still succeeded */
      }

      return { status: "published", externalPostId: msg.id, externalPostUrl: url };
    } catch (e) {
      return { status: "failed", error: (e as Error).message };
    }
  }
}
