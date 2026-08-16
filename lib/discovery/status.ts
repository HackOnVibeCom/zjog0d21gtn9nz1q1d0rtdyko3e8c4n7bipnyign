// Provider availability, so the commercial UI degrades gracefully instead of
// erroring when a discovery provider isn't ready (e.g. Reddit approval pending).
export type ProviderStatus =
  | "configured"
  | "not_configured"
  | "approval_pending"
  | "available"
  | "temporarily_unavailable"
  | "error";

export function redditStatus(): ProviderStatus {
  if (process.env.REDDIT_CLIENT_ID && process.env.REDDIT_CLIENT_SECRET) {
    return "configured";
  }
  // No credentials yet. Reddit API access is pending registration/approval.
  return process.env.REDDIT_APPROVAL_PENDING === "false"
    ? "not_configured"
    : "approval_pending";
}

export function statusMessage(s: ProviderStatus): string {
  switch (s) {
    case "configured":
    case "available":
      return "Reddit discovery is active.";
    case "approval_pending":
      return "Reddit API access is pending approval. Real discovery activates automatically once credentials are added — no code changes needed.";
    case "not_configured":
      return "Reddit is not configured. Add REDDIT_CLIENT_ID and REDDIT_CLIENT_SECRET to enable real discovery.";
    case "temporarily_unavailable":
      return "Reddit is temporarily unavailable. Try again shortly.";
    default:
      return "Reddit discovery is unavailable.";
  }
}
