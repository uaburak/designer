/**
 * Signed tokens and PKCE (docs/multiplayer.md §2), on WebCrypto only — the same code runs in the Worker and in Node's
 * tests. A token is `v1.<base64url(JSON payload)>.<base64url(HMAC-SHA256)>`; `exp` is in seconds.
 */

const enc = new TextEncoder();
const dec = new TextDecoder();

export function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromB64url(text: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(text) || text.length % 4 === 1) return null;
  const s = atob(text.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((text.length + 3) % 4));
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

/** CryptoKey, named so both Node's and Workers' typings accept it */
type Key = Awaited<ReturnType<typeof crypto.subtle.importKey>>;
const keys = new Map<string, Promise<Key>>();
function hmacKey(secret: string): Promise<Key> {
  let k = keys.get(secret);
  if (!k) keys.set(secret, (k = crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"])));
  return k;
}

export async function signToken(payload: { exp: number } & Record<string, unknown>, secret: string): Promise<string> {
  const body = `v1.${b64url(enc.encode(JSON.stringify(payload)))}`;
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", await hmacKey(secret), enc.encode(body)));
  return `${body}.${b64url(sig)}`;
}

/** The payload, or null when the token is malformed, forged or expired (`now` in seconds). */
export async function verifyToken<T extends { exp: number }>(token: string, secret: string, now: number): Promise<T | null> {
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== "v1") return null;
  const sig = fromB64url(parts[2]);
  const json = fromB64url(parts[1]);
  if (!sig || !json) return null;
  // crypto.subtle.verify compares in constant time.
  if (!(await crypto.subtle.verify("HMAC", await hmacKey(secret), sig, enc.encode(`${parts[0]}.${parts[1]}`)))) return null;
  let payload: T;
  try {
    payload = JSON.parse(dec.decode(json)) as T;
  } catch {
    return null;
  }
  if (typeof payload?.exp !== "number" || payload.exp <= now) return null;
  return payload;
}

/** PKCE's S256: base64url(SHA-256(verifier)) — also how sign-in codes are stored (hashed). */
export async function sha256b64url(text: string): Promise<string> {
  return b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(text))));
}

/** Link passwords: PBKDF2-SHA256, few iterations — the free plan gives a request 10 ms of CPU (these are file passwords
 *  for a handful of people, not account passwords). */
const PBKDF2_ITERATIONS = 4000;

async function pbkdf2(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: new Uint8Array(salt), iterations }, key, 256));
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return `pbkdf2-sha256$${PBKDF2_ITERATIONS}$${b64url(salt)}$${b64url(await pbkdf2(password, salt, PBKDF2_ITERATIONS))}`;
}

export async function checkPassword(password: string, stored: string): Promise<boolean> {
  const [kind, iter, saltText, hashText] = stored.split("$");
  const salt = fromB64url(saltText ?? "");
  const want = fromB64url(hashText ?? "");
  const iterations = Number(iter);
  if (kind !== "pbkdf2-sha256" || !salt || !want || !Number.isInteger(iterations) || iterations < 1) return false;
  const got = await pbkdf2(password, salt, iterations);
  let diff = got.length ^ want.length;
  for (let i = 0; i < Math.min(got.length, want.length); i++) diff |= got[i] ^ want[i];
  return diff === 0;
}

export function randomToken(bytes = 32): string {
  return b64url(crypto.getRandomValues(new Uint8Array(bytes)));
}
