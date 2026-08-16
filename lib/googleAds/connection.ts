import { prisma } from "../prisma";
import { googleAdsEnv, normalizeCustomerId } from "./config";
import { openToken, sealToken } from "./crypto";
import { refreshAccessToken } from "./oauth";

/**
 * Storage for a customer's Google Ads authorization.
 *
 * Every function here is tenant-scoped by userId — a connection is only ever
 * read, changed or deleted by the user it belongs to. Nothing in this module
 * returns token material to a caller that might serialise it.
 */

/** What the UI is allowed to know about a connection. Never any credential. */
export type ConnectionView = {
  connected: true;
  selectedCustomerId: string | null;
  managerCustomerId: string | null;
  connectedAt: string;
};

export async function saveConnection(
  userId: string,
  refreshToken: string,
  managerCustomerId?: string
): Promise<void> {
  const env = googleAdsEnv();
  if (!env) throw new Error("Google Ads is not configured");

  const sealed = sealToken(refreshToken, env.encryptionKey);
  const data = {
    refreshTokenCipher: sealed.cipher,
    refreshTokenIv: sealed.iv,
    refreshTokenTag: sealed.tag,
    managerCustomerId: managerCustomerId ? normalizeCustomerId(managerCustomerId) : null,
  };
  await prisma.googleAdsConnection.upsert({
    where: { userId },
    create: { userId, ...data },
    update: data,
  });
}

export async function getConnectionView(userId: string): Promise<ConnectionView | null> {
  const c = await prisma.googleAdsConnection.findUnique({ where: { userId } });
  if (!c) return null;
  return {
    connected: true,
    selectedCustomerId: c.selectedCustomerId,
    managerCustomerId: c.managerCustomerId,
    connectedAt: c.createdAt.toISOString(),
  };
}

/**
 * A short-lived access token for this user's authorization.
 *
 * The refresh token is decrypted, spent and dropped: access tokens are never
 * persisted, and the plaintext refresh token never leaves this function.
 */
export async function accessTokenFor(userId: string): Promise<string | null> {
  const env = googleAdsEnv();
  if (!env) return null;

  const c = await prisma.googleAdsConnection.findUnique({ where: { userId } });
  if (!c) return null;

  const refreshToken = openToken(
    { cipher: c.refreshTokenCipher, iv: c.refreshTokenIv, tag: c.refreshTokenTag },
    env.encryptionKey
  );
  const { accessToken } = await refreshAccessToken(env, refreshToken);
  return accessToken;
}

export async function selectCustomer(userId: string, customerId: string): Promise<void> {
  const id = normalizeCustomerId(customerId);
  if (!id) throw new Error("Invalid customer id");
  // Scoped by userId, so one user cannot point another user's connection
  // at an account.
  await prisma.googleAdsConnection.update({
    where: { userId },
    data: { selectedCustomerId: id },
  });
}

/**
 * Forget our authorization. This removes only what this product stored — it
 * changes nothing inside Google Ads and touches no campaign.
 */
export async function disconnect(userId: string): Promise<boolean> {
  const { count } = await prisma.googleAdsConnection.deleteMany({ where: { userId } });
  return count > 0;
}
