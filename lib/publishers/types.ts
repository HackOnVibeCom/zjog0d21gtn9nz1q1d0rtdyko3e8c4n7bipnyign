// A pluggable publishing provider. New platforms (Reddit, YouTube, …) implement
// this same interface so the orchestrator stays platform-agnostic.
export type PublishRequest = {
  content: string;
};

export type PublishResult = {
  status: "published" | "failed" | "requires_user_action";
  externalPostId?: string;
  externalPostUrl?: string;
  error?: string;
};

export interface SocialPublisher {
  readonly platform: string;
  publish(req: PublishRequest): Promise<PublishResult>;
}
