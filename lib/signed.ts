import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Small signed-payload helper for work that is started in one request and
 * resumed in another, without server-side state.
 *
 * It carries no secrets — only ids the server issued — but signing means a
 * client cannot forge or borrow another user's work, and cannot point the
 * server at provider records it never created.
 */
const DEFAULT_TTL_MS = 15 * 60 * 1000;
const MAX_PAYLOAD_LENGTH = 8 * 1024;

const b64url = (b: Buffer) => b.toString("base64url");

function secret(): string {
  const s = process.env.AUTH_SECRET;
  if (!s) throw new Error("AUTH_SECRET is not set");
  return s;
}

const sign = (payload: string) => b64url(createHmac("sha256", secret()).update(payload).digest());

export function signPayload<T>(data: T, userId: string, ttlMs = DEFAULT_TTL_MS): string {
  const payload = b64url(
    Buffer.from(JSON.stringify({ data, userId, exp: Date.now() + ttlMs }), "utf8")
  );
  return `${payload}.${sign(payload)}`;
}

/** Verify signature, expiry and owner. Returns null on any problem. */
export function readPayload<T>(raw: unknown, userId: string): T | null {
  if (typeof raw !== "string" || raw.length > MAX_PAYLOAD_LENGTH) return null;
  const [payload, signature] = raw.split(".");
  if (!payload || !signature) return null;

  const expected = Buffer.from(sign(payload));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;

  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
      data?: T;
      userId?: unknown;
      exp?: unknown;
    };
    if (typeof parsed.exp !== "number" || Date.now() > parsed.exp) return null;
    if (parsed.userId !== userId) return null;
    return (parsed.data ?? null) as T | null;
  } catch {
    return null;
  }
}
