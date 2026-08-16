import { createHmac, timingSafeEqual } from "node:crypto";
import { StoreProviderError } from "./types";

/**
 * A submitted store lookup is handed back to the browser as a signed ticket so
 * the client can poll for the result without the server holding state.
 *
 * Signing matters: the raw provider task id must not be pollable by anyone who
 * guesses it, and a ticket issued to one user must not be usable by another.
 * The ticket carries no secrets — only the provider, app id, task id, owner and
 * an expiry — and is verified server-side before any provider call.
 */
export type LookupTicket = {
  provider: string;
  appId: string;
  taskId: string;
  userId: string;
};

const TTL_MS = 10 * 60 * 1000;
const MAX_TICKET_LENGTH = 1024;

const b64url = (b: Buffer) => b.toString("base64url");

function secret(): string {
  const s = process.env.AUTH_SECRET;
  if (!s) throw new StoreProviderError("not_configured", "Store lookup is not configured");
  return s;
}

const sign = (payload: string) =>
  b64url(createHmac("sha256", secret()).update(payload).digest());

export function issueTicket(t: LookupTicket): string {
  const payload = b64url(
    Buffer.from(JSON.stringify({ ...t, exp: Date.now() + TTL_MS }), "utf8")
  );
  return `${payload}.${sign(payload)}`;
}

/** Verify a ticket and confirm it belongs to this user. Throws on any problem. */
export function readTicket(raw: unknown, userId: string): LookupTicket {
  const bad = () =>
    new StoreProviderError("provider_error", "The store lookup could not be resumed");

  if (typeof raw !== "string" || raw.length > MAX_TICKET_LENGTH) throw bad();
  const [payload, signature] = raw.split(".");
  if (!payload || !signature) throw bad();

  const expected = Buffer.from(sign(payload));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) throw bad();

  let data: Record<string, unknown>;
  try {
    data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    throw bad();
  }
  const exp = typeof data.exp === "number" ? data.exp : 0;
  if (Date.now() > exp) {
    throw new StoreProviderError("timeout", "The store lookup expired — please try again");
  }
  if (data.userId !== userId) throw bad();
  if (
    typeof data.provider !== "string" ||
    typeof data.appId !== "string" ||
    typeof data.taskId !== "string"
  ) {
    throw bad();
  }
  return {
    provider: data.provider,
    appId: data.appId,
    taskId: data.taskId,
    userId,
  };
}
