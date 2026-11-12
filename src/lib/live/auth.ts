/**
 * Request signing for venue trading APIs. Server-only. Keys come from environment variables
 * (.env.local, git-ignored) and never leave the server.
 *
 * Both venues sign `timestamp_ms + METHOD + path` (path without query string):
 * - Kalshi: RSA-PSS/SHA-256 (salt = digest length) or Ed25519, base64. docs.kalshi.com quick start.
 * - Polymarket US: Ed25519 over the same message; secret is base64, first 32 bytes are the seed.
 *   docs.polymarket.us/api-reference/authentication.
 */
import { constants, createPrivateKey, sign, type KeyObject } from "node:crypto";
import { readFileSync } from "node:fs";

export const signingMessage = (ts: string, method: string, path: string) => `${ts}${method.toUpperCase()}${path.split("?")[0]}`;

/** Ed25519 private key from a 32-byte seed (PKCS#8 DER wrapper). */
export function ed25519FromSeed(seed: Uint8Array): KeyObject {
  if (seed.length !== 32) throw new Error("Ed25519 seed must be 32 bytes");
  const der = Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), Buffer.from(seed)]);
  return createPrivateKey({ key: der, format: "der", type: "pkcs8" });
}

export function signKalshi(key: KeyObject, ts: string, method: string, path: string): string {
  const msg = Buffer.from(signingMessage(ts, method, path));
  const sig =
    key.asymmetricKeyType === "ed25519"
      ? sign(null, msg, key)
      : sign("sha256", msg, { key, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: constants.RSA_PSS_SALTLEN_DIGEST });
  return sig.toString("base64");
}

export function signPolymarketUs(key: KeyObject, ts: string, method: string, path: string): string {
  return sign(null, Buffer.from(signingMessage(ts, method, path)), key).toString("base64");
}

export interface KalshiCreds {
  keyId: string;
  key: KeyObject;
}
export interface PmusCreds {
  keyId: string;
  key: KeyObject;
}

/** KALSHI_API_KEY_ID + KALSHI_PRIVATE_KEY (PEM, `\n` escapes allowed) or KALSHI_PRIVATE_KEY_PATH. */
export function kalshiCredsFromEnv(env: Record<string, string | undefined> = process.env): KalshiCreds | null {
  const keyId = env.KALSHI_API_KEY_ID;
  const pem = env.KALSHI_PRIVATE_KEY?.replace(/\\n/g, "\n") ?? (env.KALSHI_PRIVATE_KEY_PATH ? readFileSync(env.KALSHI_PRIVATE_KEY_PATH, "utf8") : undefined);
  if (!keyId || !pem) return null;
  return { keyId, key: createPrivateKey(pem) };
}

/** PMUS_KEY_ID + PMUS_SECRET_KEY (base64 from polymarket.us/developer; 64 or 32 bytes). */
export function pmusCredsFromEnv(env: Record<string, string | undefined> = process.env): PmusCreds | null {
  const keyId = env.PMUS_KEY_ID;
  const secret = env.PMUS_SECRET_KEY;
  if (!keyId || !secret) return null;
  const raw = Buffer.from(secret, "base64");
  if (raw.length !== 64 && raw.length !== 32) throw new Error("PMUS_SECRET_KEY must decode to 32 or 64 bytes");
  return { keyId, key: ed25519FromSeed(raw.subarray(0, 32)) };
}
