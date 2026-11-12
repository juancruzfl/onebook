/**
 * The user's own venue API keys, held ONLY in their browser. Browser-only (WebCrypto + IndexedDB).
 *
 * Keys are imported as NON-EXTRACTABLE CryptoKeys and stored in IndexedDB. Page scripts can ask the
 * browser to sign with them, but cannot read the secret back, and onebook's server never receives it.
 * Each request is signed here; the signature is only valid for that timestamp, method and path.
 */
import { signingMessage, type LiveVenue } from "@/lib/live/orders";

export interface VenueConnection {
  venue: LiveVenue;
  keyId: string;
  key: CryptoKey;
  connectedAt: string;
}

// ---------------------------------------------------------------- key formats (pure)

const b64ToBytes = (b64: string) => Uint8Array.from(atob(b64.replace(/\s+/g, "")), (c) => c.charCodeAt(0));
export const bytesToB64 = (b: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(b)));

function derLen(n: number): number[] {
  if (n < 0x80) return [n];
  const out: number[] = [];
  for (let x = n; x > 0; x >>= 8) out.unshift(x & 0xff);
  return [0x80 | out.length, ...out];
}
const der = (tag: number, body: Uint8Array) => Uint8Array.from([tag, ...derLen(body.length), ...body]);

/** PKCS#8 wrapper around a 32-byte Ed25519 seed. */
export function ed25519Pkcs8(seed: Uint8Array): Uint8Array {
  if (seed.length !== 32) throw new Error("Ed25519 seed must be 32 bytes");
  return Uint8Array.from([...hexBytes("302e020100300506032b657004220420"), ...seed]);
}

/** PKCS#1 RSAPrivateKey → PKCS#8 PrivateKeyInfo (WebCrypto only imports PKCS#8). */
export function rsaPkcs1ToPkcs8(pkcs1: Uint8Array): Uint8Array {
  const version = Uint8Array.from([0x02, 0x01, 0x00]);
  const algId = hexBytes("300d06092a864886f70d0101010500");
  return der(0x30, Uint8Array.from([...version, ...algId, ...der(0x04, pkcs1)]));
}

function hexBytes(hex: string): Uint8Array {
  return Uint8Array.from(hex.match(/../g)!.map((h) => parseInt(h, 16)));
}

/** Polymarket US secret: base64 of 64 bytes (seed + public key) or a bare 32-byte seed. */
export function pmusSecretToPkcs8(secretB64: string): Uint8Array {
  const raw = b64ToBytes(secretB64.trim());
  if (raw.length !== 64 && raw.length !== 32) throw new Error("This doesn't look like a Polymarket US secret key (expected 32 or 64 bytes, base64).");
  return ed25519Pkcs8(raw.subarray(0, 32));
}

/** Kalshi private key PEM: PKCS#8 ("PRIVATE KEY") or PKCS#1 ("RSA PRIVATE KEY"). */
export function kalshiPemToPkcs8(pem: string): Uint8Array {
  const m = /-----BEGIN (RSA )?PRIVATE KEY-----([\s\S]+?)-----END (RSA )?PRIVATE KEY-----/.exec(pem);
  if (!m) throw new Error("Paste the whole Kalshi private key, including the BEGIN/END lines.");
  const body = b64ToBytes(m[2]);
  return m[1] ? rsaPkcs1ToPkcs8(body) : body;
}

// ---------------------------------------------------------------- WebCrypto

const toBuf = (u: Uint8Array) => u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;

export async function importVenueKey(venue: LiveVenue, secret: string, subtle: SubtleCrypto = crypto.subtle): Promise<CryptoKey> {
  if (venue === "polymarket-us") return subtle.importKey("pkcs8", toBuf(pmusSecretToPkcs8(secret)), { name: "Ed25519" }, false, ["sign"]);
  const pkcs8 = toBuf(kalshiPemToPkcs8(secret));
  try {
    return await subtle.importKey("pkcs8", pkcs8, { name: "RSA-PSS", hash: "SHA-256" }, false, ["sign"]);
  } catch {
    return subtle.importKey("pkcs8", pkcs8, { name: "Ed25519" }, false, ["sign"]);
  }
}

/** Sign `ts + METHOD + path` with the stored key; base64 signature. */
export async function signRequest(key: CryptoKey, ts: string, method: string, path: string, subtle: SubtleCrypto = crypto.subtle) {
  const data = new TextEncoder().encode(signingMessage(ts, method, path));
  const algo = key.algorithm.name === "RSA-PSS" ? { name: "RSA-PSS", saltLength: 32 } : { name: "Ed25519" };
  return bytesToB64(await subtle.sign(algo, key, data));
}

// ---------------------------------------------------------------- IndexedDB

const DB = "onebook-keys";
const STORE = "connections";

function idb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: "venue" });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx<T>(mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return idb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const req = run(db.transaction(STORE, mode).objectStore(STORE));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      }),
  );
}

export async function saveConnection(venue: LiveVenue, keyId: string, secret: string): Promise<VenueConnection> {
  if (!keyId.trim()) throw new Error("Key ID is required.");
  const conn: VenueConnection = { venue, keyId: keyId.trim(), key: await importVenueKey(venue, secret), connectedAt: new Date().toISOString() };
  await tx("readwrite", (s) => s.put(conn));
  return conn;
}

export async function loadConnections(): Promise<Partial<Record<LiveVenue, VenueConnection>>> {
  try {
    const all = await tx<VenueConnection[]>("readonly", (s) => s.getAll());
    return Object.fromEntries(all.map((c) => [c.venue, c]));
  } catch {
    return {};
  }
}

export const removeConnection = (venue: LiveVenue) => tx("readwrite", (s) => s.delete(venue));
