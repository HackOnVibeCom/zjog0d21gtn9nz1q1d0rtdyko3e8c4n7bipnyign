import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

/**
 * Authenticated encryption for the Google Ads refresh credential.
 *
 * A refresh token is long-lived permission to spend someone's advertising
 * budget, so it is never stored in plaintext. AES-256-GCM gives confidentiality
 * and integrity together: a tampered ciphertext fails to open rather than
 * decrypting to something attacker-chosen.
 *
 * Server-only. The key comes from GOOGLE_ADS_TOKEN_ENCRYPTION_KEY and is never
 * returned to a browser, never logged, and never included in an API response.
 */

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12; // 96-bit nonce, the size GCM is defined for
const KEY_BYTES = 32;

export class TokenCryptoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TokenCryptoError";
  }
}

export type SealedToken = { cipher: string; iv: string; tag: string };

/**
 * Accept either 32 raw bytes (base64/hex) or a passphrase, and derive a
 * 256-bit key. Deriving by SHA-256 keeps configuration forgiving without
 * silently accepting a key of the wrong size.
 */
function keyFrom(secret: string): Buffer {
  if (!secret) throw new TokenCryptoError("Encryption key is not configured");

  for (const encoding of ["base64", "hex"] as const) {
    try {
      const buf = Buffer.from(secret, encoding);
      if (buf.length === KEY_BYTES && buf.toString(encoding).replace(/=+$/, "") === secret.replace(/=+$/, "")) {
        return buf;
      }
    } catch {
      /* try the next encoding */
    }
  }
  if (secret.length < 16) {
    throw new TokenCryptoError("Encryption key is too short");
  }
  return createHash("sha256").update(secret, "utf8").digest();
}

/** Encrypt a secret for storage. The three parts are all needed to open it. */
export function sealToken(plaintext: string, secret: string): SealedToken {
  if (!plaintext) throw new TokenCryptoError("Nothing to encrypt");
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, keyFrom(secret), iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return {
    cipher: enc.toString("base64"),
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
  };
}

/**
 * Decrypt a stored secret. Throws on a wrong key or tampered data — it never
 * returns partial or garbage plaintext.
 */
export function openToken(sealed: SealedToken, secret: string): string {
  try {
    const decipher = createDecipheriv(ALGORITHM, keyFrom(secret), Buffer.from(sealed.iv, "base64"));
    decipher.setAuthTag(Buffer.from(sealed.tag, "base64"));
    return Buffer.concat([
      decipher.update(Buffer.from(sealed.cipher, "base64")),
      decipher.final(),
    ]).toString("utf8");
  } catch (e) {
    if (e instanceof TokenCryptoError) throw e;
    // Deliberately opaque: the reason a decryption failed is not the caller's
    // business, and the message must never carry key or ciphertext material.
    throw new TokenCryptoError("Stored Google Ads authorization could not be read");
  }
}
