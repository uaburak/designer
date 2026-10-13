/**
 * The `wecra-site` Worker (docs/site.md §1): get.wecra.app's static pages (the assets binding, `site/dist`) and the
 * update channel over the R2 bucket `wecra-releases`:
 *
 * - `GET|HEAD /updates/<file>`: the R2 object `updates/<file>` streamed, with Content-Length, ETag and one byte range
 *   (206 / 416) — electron-updater's feeds (`latest-mac.yml`, `latest.yml`, sent `no-cache`) and the versioned files
 *   they name (the DMG, the zips, the Setup .exe, the blockmaps; `immutable`). The app asks one range per request
 *   (electron-builder.yml `useMultipleRangeRequest: false`); a request for several ranges gets the whole file (200),
 *   which RFC 9110 allows and electron-updater answers by downloading it in full.
 * - `GET /download/mac`, `GET /download/windows`: a 302 to `/updates/<file>` of the newest release that has one, read
 *   from `releases.json` (§3); a small 404 page when there is none yet.
 * - `GET /api/releases`: `releases.json` (`{ "releases": [] }` while the bucket has none), `max-age=60`.
 *
 * wrangler.jsonc runs the Worker first only for those three prefixes; anything else reaching it goes to the assets.
 */

export interface Env {
  /** R2 `wecra-releases`: `updates/<file>` and `releases.json` */
  RELEASES: R2Bucket;
  /** The pages (`site/dist`) */
  ASSETS: Fetcher;
}

/** One file of a release (docs/site.md §3) */
export interface ReleaseFile {
  name: string;
  size: number;
}

export interface Release {
  version: string;
  date: string;
  notes: string;
  files: { mac?: ReleaseFile; windows?: ReleaseFile };
}

export type Platform = "mac" | "windows";

const IMMUTABLE = "public, max-age=31536000, immutable";
const FEED = "no-cache";
const LISTING = "public, max-age=60";

/** A file name the bucket may hold under `updates/`: no path, no dot first, nothing odd */
const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;

export function isFileName(name: string): boolean {
  return FILE_NAME.test(name) && !name.includes("..");
}

const TYPES: Record<string, string> = {
  yml: "text/yaml; charset=utf-8",
  dmg: "application/x-apple-diskimage",
  zip: "application/zip",
  exe: "application/vnd.microsoft.portable-executable",
  msi: "application/x-msi",
  blockmap: "application/octet-stream",
};

export function contentType(name: string): string {
  return TYPES[name.slice(name.lastIndexOf(".") + 1).toLowerCase()] ?? "application/octet-stream";
}

/** A byte range resolved against the file's size: the bytes start…end, both included */
export interface ByteRange {
  start: number;
  end: number;
}

/**
 * A `Range` header (RFC 9110 §14) against a file of `size` bytes: null to send the whole file (no header, another unit,
 * several ranges, a malformed one), "unsatisfiable" for a 416, else the one range.
 */
export function parseRange(header: string | null, size: number): ByteRange | "unsatisfiable" | null {
  if (!header) return null;
  const m = /^\s*bytes\s*=\s*(\d*)\s*-\s*(\d*)\s*$/i.exec(header);
  if (!m) return null;
  const [, a, b] = m;
  if (a === "" && b === "") return null;
  if (a === "") {
    // The last b bytes
    const n = Number(b);
    if (n === 0 || size === 0) return "unsatisfiable";
    return { start: Math.max(0, size - n), end: size - 1 };
  }
  const start = Number(a);
  if (start >= size) return "unsatisfiable";
  const end = b === "" ? size - 1 : Math.min(Number(b), size - 1);
  if (end < start) return null; // invalid (last < first): ignored, the whole file
  return { start, end };
}

function html(status: number, title: string, body: string): Response {
  const page = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title} – Wecra</title><style>:root{color-scheme:light dark}body{margin:0;min-height:100vh;display:grid;place-items:center;font:16px/1.5 Inter,system-ui,-apple-system,sans-serif;padding:0 16px}main{max-width:28rem;text-align:center}h1{font-size:1.5rem;margin:0 0 .5rem}a{color:#0d99ff}</style></head><body><main><h1>${title}</h1><p>${body}</p><p><a href="/">Back to Wecra</a></p></main></body></html>`;
  return new Response(page, { status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
}

const notFound = () => new Response("Not found", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8" } });

/** `GET|HEAD /updates/<file>` */
export async function serveUpdate(bucket: R2Bucket, name: string, request: Request): Promise<Response> {
  if (!isFileName(name)) return notFound();
  const key = `updates/${name}`;
  const head = request.method === "HEAD";
  const rangeHeader = request.headers.get("Range");

  // A range needs the size first to resolve it (and to answer 416)
  let range: ByteRange | null = null;
  let meta: R2Object | null = null;
  if (rangeHeader) {
    meta = await bucket.head(key);
    if (!meta) return notFound();
    const r = parseRange(rangeHeader, meta.size);
    if (r === "unsatisfiable") {
      return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${meta.size}`, "Accept-Ranges": "bytes", ETag: meta.httpEtag } });
    }
    range = r;
  }

  let object: R2Object | R2ObjectBody | null;
  if (head) object = meta ?? (await bucket.head(key));
  else object = await bucket.get(key, range ? { range: { offset: range.start, length: range.end - range.start + 1 } } : undefined);
  if (!object) return notFound();

  const size = object.size;
  const headers = new Headers({
    "Content-Type": object.httpMetadata?.contentType || contentType(name),
    ETag: object.httpEtag,
    "Accept-Ranges": "bytes",
    "Cache-Control": name.endsWith(".yml") ? FEED : IMMUTABLE,
    "Last-Modified": object.uploaded.toUTCString(),
  });
  if (/\.(dmg|exe|msi|zip)$/i.test(name)) headers.set("Content-Disposition", `attachment; filename="${name}"`);
  const body = head || !("body" in object) ? null : object.body;
  if (range) {
    headers.set("Content-Range", `bytes ${range.start}-${range.end}/${size}`);
    headers.set("Content-Length", String(range.end - range.start + 1));
    return new Response(body, { status: 206, headers });
  }
  headers.set("Content-Length", String(size));
  return new Response(body, { status: 200, headers });
}

/** The releases (newest first); an empty list when the bucket has none yet or the file doesn't parse */
export async function readReleases(bucket: R2Bucket): Promise<Release[]> {
  const object = await bucket.get("releases.json");
  if (!object) return [];
  try {
    const data = (await object.json()) as { releases?: unknown };
    return Array.isArray(data?.releases) ? (data.releases as Release[]) : [];
  } catch {
    return [];
  }
}

/** The newest release's file for the platform (Windows: the newest release that has one) */
export function newestFile(releases: Release[], platform: Platform): ReleaseFile | null {
  for (const r of releases) {
    const f = r?.files?.[platform];
    if (f && typeof f.name === "string" && isFileName(f.name)) return f;
  }
  return null;
}

/** `GET /download/<platform>` */
export async function download(bucket: R2Bucket, platform: Platform, url: URL): Promise<Response> {
  const file = newestFile(await readReleases(bucket), platform);
  if (!file) {
    const label = platform === "mac" ? "macOS" : "Windows";
    return html(404, `No ${label} download yet`, `There isn’t a Wecra release for ${label} yet. Check back soon.`);
  }
  return new Response(null, { status: 302, headers: { Location: new URL(`/updates/${file.name}`, url).toString(), "Cache-Control": LISTING } });
}

/** `GET /api/releases` */
export async function releasesApi(bucket: R2Bucket): Promise<Response> {
  const object = await bucket.get("releases.json");
  const headers = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": LISTING };
  if (!object) return new Response('{"releases":[]}', { headers });
  return new Response(object.body, { headers: { ...headers, ETag: object.httpEtag } });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;
    const route = path.startsWith("/updates/") || path.startsWith("/download/") || path.startsWith("/api/");
    if (route && method !== "GET" && method !== "HEAD") {
      return new Response("Method not allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
    }
    if (path.startsWith("/updates/")) return serveUpdate(env.RELEASES, path.slice("/updates/".length), request);
    if (path === "/download/mac" || path === "/download/windows") return download(env.RELEASES, path === "/download/mac" ? "mac" : "windows", url);
    if (path === "/api/releases") return releasesApi(env.RELEASES);
    if (route) return path.startsWith("/download/") ? html(404, "Page not found", "There’s no such download.") : notFound();
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
