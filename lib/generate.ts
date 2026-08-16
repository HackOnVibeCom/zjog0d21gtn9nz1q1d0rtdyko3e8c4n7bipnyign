import { chatJSON } from "./openai";

export type GenerateOpts = {
  platform: string;
  appName: string;
  valueProp: string;
  angle: string;
  trackingUrl: string;
};

const SYSTEM =
  "You write short, platform-appropriate promotional posts announcing a newly " +
  "launched mobile app. Respond ONLY with a JSON object { \"content\": string }.";

/** Generate one platform-specific promo post that ends with the tracking URL. */
export async function generatePost(opts: GenerateOpts): Promise<string> {
  const user =
    `Platform: ${opts.platform}\n` +
    `App: ${opts.appName}\n` +
    `Value proposition: ${opts.valueProp}\n` +
    `Angle to use: ${opts.angle || "(none)"}\n` +
    `Write ONE concise post (2-4 sentences) with a clear call to action, ` +
    `adapted to ${opts.platform}'s tone. Put this exact link at the very end:\n` +
    `${opts.trackingUrl}\n` +
    `Return {"content": "..."}.`;

  const raw = await chatJSON<{ content?: string }>(SYSTEM, user);
  let content = String(raw.content ?? "").trim();
  // Guarantee the tracking link is present (it is what makes the post measurable).
  if (!content.includes(opts.trackingUrl)) {
    content = `${content}\n${opts.trackingUrl}`;
  }
  return content;
}
