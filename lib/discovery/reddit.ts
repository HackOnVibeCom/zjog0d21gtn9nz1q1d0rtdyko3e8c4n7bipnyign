import {
  CommunityDiscoveryProvider,
  DiscoveryQuery,
  RawCommunity,
} from "./types";

const UA = "AIGrowthKit/0.1 (audience discovery)";

/**
 * Reddit discovery via the OFFICIAL OAuth API (application-only /
 * client_credentials). Reddit blocks unauthenticated JSON, so real data
 * requires a registered app (REDDIT_CLIENT_ID / REDDIT_CLIENT_SECRET).
 * All returned data (member counts, descriptions, rules) is REAL.
 */
export class RedditDiscoveryProvider implements CommunityDiscoveryProvider {
  readonly platform = "reddit";
  private token?: string;

  private async getToken(): Promise<string> {
    if (this.token) return this.token;
    const id = process.env.REDDIT_CLIENT_ID;
    const secret = process.env.REDDIT_CLIENT_SECRET;
    if (!id || !secret) {
      throw new Error("REDDIT_CLIENT_ID / REDDIT_CLIENT_SECRET not configured");
    }
    const auth = Buffer.from(`${id}:${secret}`).toString("base64");
    const res = await fetch("https://www.reddit.com/api/v1/access_token", {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": UA,
      },
      body: "grant_type=client_credentials",
    });
    if (!res.ok) {
      throw new Error(`Reddit token HTTP ${res.status}: ${await res.text()}`);
    }
    this.token = (await res.json()).access_token as string;
    return this.token;
  }

  async discover(query: DiscoveryQuery): Promise<RawCommunity[]> {
    const token = await this.getToken();
    const headers = { Authorization: `Bearer ${token}`, "User-Agent": UA };
    const found = new Map<string, RawCommunity>();

    // 1) Real subreddit search per query.
    for (const q of query.queries) {
      const url =
        `https://oauth.reddit.com/subreddits/search?q=${encodeURIComponent(q)}` +
        `&limit=${query.limitPerQuery ?? 5}&include_over_18=false`;
      const res = await fetch(url, { headers });
      if (!res.ok) continue;
      const data = await res.json();
      for (const child of data.data?.children ?? []) {
        const s = child.data;
        if (!s?.display_name || found.has(s.display_name)) continue;
        found.set(s.display_name, {
          platform: "reddit",
          name: s.display_name,
          url: `https://www.reddit.com/r/${s.display_name}`,
          description: s.public_description || s.title || "",
          memberCount: typeof s.subscribers === "number" ? s.subscribers : undefined,
        });
      }
    }

    // 2) Real rules for each candidate (used for honest promotion-policy analysis).
    const out: RawCommunity[] = [];
    for (const community of found.values()) {
      try {
        const r = await fetch(
          `https://oauth.reddit.com/r/${community.name}/about/rules`,
          { headers }
        );
        if (r.ok) {
          const rd = await r.json();
          community.rules = (rd.rules ?? [])
            .map((x: { short_name?: string; description?: string }) =>
              `${x.short_name ?? ""}: ${(x.description ?? "").replace(/\s+/g, " ")}`
                .trim()
                .slice(0, 240)
            )
            .filter(Boolean);
        }
      } catch {
        /* rules are best-effort */
      }
      out.push(community);
    }
    return out;
  }
}
