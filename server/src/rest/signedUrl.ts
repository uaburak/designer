/**
 * Signed blob URLs (docs/multiplayer.md §16.2 decision 10): Figma answers expiring S3 links; ours are
 * `<server>/v1/blobs/:fileKey/:sha1[.ext]?exp=<unix s>&sig=<HMAC>` (renders 30 days, image fills 14 days),
 * `<server>/v1/library-blobs/:libraryKey/:sha1.png?…` (library thumbnails), `<server>/v1/files/:key/thumbnail?…` and
 * Discovery's hourly files `<server>/v1/discovery/files/:org/:YYYY/:MM/:DD/:HH.json?…` (`file_ttl_in_seconds`).
 * They need no auth header, like S3's: the signature is the permission.
 */
import type { Deps } from "../api";
import { libraryFetch } from "../libraries/db";
import { b64url, fromB64url } from "../tokens";
import { RestError } from "./http";

export const RENDER_URL_DAYS = 30;
export const FILL_URL_DAYS = 14;

const enc = new TextEncoder();

type Key = Awaited<ReturnType<typeof crypto.subtle.importKey>>;
const keys = new Map<string, Promise<Key>>();
function key(secret: string): Promise<Key> {
  let k = keys.get(secret);
  if (!k) keys.set(secret, (k = crypto.subtle.importKey("raw", enc.encode(`rest-blob:${secret}`), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"])));
  return k;
}

function secretOf(deps: Deps): string {
  const s = deps.env.SESSION_SECRET;
  if (!s || s.length < 32) throw new RestError(500, "SESSION_SECRET is not set");
  return s;
}

/** A signed URL for `path` (starting `/v1/…`) valid `days` days */
export function signPath(deps: Deps, origin: string, path: string, days: number): Promise<string> {
  return signPathFor(deps, origin, path, days * 86_400);
}

/** A signed URL for `path` valid `seconds` seconds (Discovery's hourly files: `file_ttl_in_seconds`) */
export async function signPathFor(deps: Deps, origin: string, path: string, seconds: number): Promise<string> {
  const exp = Math.floor(deps.now() / 1000) + seconds;
  const sig = b64url(new Uint8Array(await crypto.subtle.sign("HMAC", await key(secretOf(deps)), enc.encode(`${path}:${exp}`))));
  return `${origin}${path}?exp=${exp}&sig=${sig}`;
}

/** Is `url` (its path, exp, sig) signed by us and not expired? */
export async function verifySigned(deps: Deps, url: URL): Promise<boolean> {
  const exp = Number(url.searchParams.get("exp"));
  const sig = fromB64url(url.searchParams.get("sig") ?? "");
  if (!Number.isInteger(exp) || !sig || exp <= Math.floor(deps.now() / 1000)) return false;
  return crypto.subtle.verify("HMAC", await key(secretOf(deps)), sig, enc.encode(`${url.pathname}:${exp}`));
}

export const blobPath = (fileKey: string, sha1: string, ext?: string) => `/v1/blobs/${fileKey}/${sha1}${ext ? `.${ext}` : ""}`;
export const thumbnailPath = (fileKey: string) => `/v1/files/${fileKey}/thumbnail`;
export const libraryBlobPath = (libraryKey: string, sha1: string) => `/v1/library-blobs/${libraryKey}/${sha1}.png`;

const TYPES: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", svg: "image/svg+xml", pdf: "application/pdf", json: "application/json", gif: "image/gif", webp: "image/webp" };

/** An image fill's type from its first bytes */
function sniff(b: Uint8Array): string {
  if (b[0] === 0x89 && b[1] === 0x50) return "image/png";
  if (b[0] === 0xff && b[1] === 0xd8) return "image/jpeg";
  if (b[0] === 0x47 && b[1] === 0x49) return "image/gif";
  if (b[0] === 0x52 && b[1] === 0x49 && b[8] === 0x57) return "image/webp";
  return "application/octet-stream";
}

/** GET of a signed URL: the bytes, or 403 (bad or expired signature) / 404 */
export async function signedRoute(deps: Deps, url: URL, parts: string[]): Promise<Response> {
  if (!(await verifySigned(deps, url))) throw new RestError(403, "Invalid or expired signature");
  const headers = (type: string) => ({ "content-type": type, "cache-control": "private, max-age=86400", "access-control-allow-origin": "*" });
  // Discovery's hourly files (docs/governance.md §2.11), generated now from D1
  if (parts[0] === "discovery") return (await import("../discovery/rest")).discoveryFile(deps, parts);
  if (parts[0] === "files" && parts[2] === "thumbnail") {
    const res = await deps.rooms.fetch(parts[1], `/room/thumbnail?fileKey=${parts[1]}`, { method: "GET" });
    if (!res.ok) throw new RestError(404, "No thumbnail");
    return new Response(await res.arrayBuffer(), { headers: headers("image/png") });
  }
  const m = /^([0-9a-f]{40})(?:\.([a-z]{2,4}))?$/.exec(parts[2] ?? "");
  if (parts.length !== 3 || !m) throw new RestError(404, "Not found");
  if (parts[0] === "library-blobs") {
    const res = await libraryFetch(deps, parts[1], `/blob/${m[1]}`);
    if (!res.ok) throw new RestError(404, "Not found");
    return new Response(await res.arrayBuffer(), { headers: headers("image/png") });
  }
  const res = await deps.rooms.fetch(parts[1], `/room/rest-blob/${m[1]}?fileKey=${parts[1]}`, { method: "GET" });
  if (!res.ok) throw new RestError(404, "Not found");
  const bytes = new Uint8Array(await res.arrayBuffer());
  return new Response(bytes, { headers: headers(m[2] ? (TYPES[m[2]] ?? "application/octet-stream") : sniff(bytes)) });
}
