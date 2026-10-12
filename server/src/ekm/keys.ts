/**
 * Managed envelope keys (docs/governance.md §2.10): each org's DEK is 32 random bytes, stored in `org_keys.wrapped_dek`
 * as `"v1." + base64(iv(12) | AES-256-GCM(DEK) + tag)` under the Worker secret `EKM_ROOT_KEY` (32 bytes, base64), the
 * org's id as associated data — a wrapped DEK copied to another org's row doesn't open. The DEK is imported
 * non-extractable; the root key is imported once per isolate (cached by its text).
 */
import { aesCipher, type Key, type RoomCipher } from "./cipher";

/** The Worker's secret, read where the env is (`wrangler secret put EKM_ROOT_KEY`) */
export interface EkmEnv {
  EKM_ROOT_KEY?: string;
}

/** The root key is missing or malformed, or doesn't open this org's DEK */
export class KeyUnavailable extends Error {}

const WRAP_PREFIX = "v1.";
let rootCache: { text: string; key: Promise<Key> } | null = null;

function fromB64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const toB64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));

/** The imported root key; KeyUnavailable when the secret isn't 32 bytes of base64 */
export function rootKey(secret: string | undefined): Promise<Key> {
  const text = (secret ?? "").trim();
  if (rootCache?.text === text) return rootCache.key;
  let raw: Uint8Array;
  try {
    raw = fromB64(text);
  } catch {
    return Promise.reject(new KeyUnavailable("EKM_ROOT_KEY isn't base64"));
  }
  if (raw.length !== 32) return Promise.reject(new KeyUnavailable("EKM_ROOT_KEY isn't 32 bytes"));
  const key = crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
  rootCache = { text, key };
  return key;
}

/** A new DEK for `orgId`, wrapped under the root key */
export async function newWrappedDek(secret: string | undefined, orgId: string): Promise<string> {
  const root = await rootKey(secret);
  const dek = crypto.getRandomValues(new Uint8Array(32));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: new TextEncoder().encode(orgId) }, root, dek));
  dek.fill(0);
  const out = new Uint8Array(12 + ct.length);
  out.set(iv);
  out.set(ct, 12);
  return WRAP_PREFIX + toB64(out);
}

/** The org's DEK as a key; KeyUnavailable when the root key is missing, wrong or the row is damaged */
export async function unwrapDek(secret: string | undefined, orgId: string, wrapped: string): Promise<Key> {
  const root = await rootKey(secret);
  if (!wrapped.startsWith(WRAP_PREFIX)) throw new KeyUnavailable("unknown wrapped key format");
  let raw: Uint8Array;
  try {
    const bytes = fromB64(wrapped.slice(WRAP_PREFIX.length));
    raw = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes.subarray(0, 12), additionalData: new TextEncoder().encode(orgId) }, root, bytes.subarray(12)));
  } catch {
    throw new KeyUnavailable("the root key doesn't open the org's key");
  }
  if (raw.length !== 32) throw new KeyUnavailable("the org's key isn't 32 bytes");
  const key = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
  raw.fill(0);
  return key;
}

/** The org's row cipher */
export async function orgCipher(secret: string | undefined, orgId: string, wrapped: string): Promise<RoomCipher> {
  return aesCipher(await unwrapDek(secret, orgId, wrapped));
}
