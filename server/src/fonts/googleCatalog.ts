/**
 * `GET /google-fonts/catalog` (docs/desktop.md §14.1, the web app): the Google Fonts catalog for a browser, which can't
 * read `fonts.google.com/metadata/fonts` itself (no CORS). The same reduction main makes on the desktop
 * (src/shared/fonts/google.ts parseCatalog) → `{families: GoogleFontFamily[]}`, public, kept at the edge for a day.
 */
import type { Deps } from "../api";
import { CATALOG_URL, parseCatalog } from "../../../src/shared/fonts/google";

const DAY_S = 86_400;
const JSON_TYPE = "application/json; charset=utf-8";

/** The Workers Cache API's default cache; absent in tests (and Node). */
interface EdgeCache {
  match(key: Request): Promise<Response | undefined>;
  put(key: Request, res: Response): Promise<void>;
}
const edgeCache = (): EdgeCache | null => (globalThis as { caches?: { default?: EdgeCache } }).caches?.default ?? null;

export async function googleCatalogRoute(req: Request, deps: Deps): Promise<Response> {
  const cache = edgeCache();
  // One key for every caller (the query string, headers and cookies don't change the answer).
  const key = new Request(new URL("/google-fonts/catalog", req.url).toString(), { method: "GET" });
  if (cache) {
    const hit = await cache.match(key).catch(() => undefined);
    if (hit) return hit;
  }
  let body: string;
  try {
    const res = await deps.fetch(CATALOG_URL, { headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(`catalog ${res.status}`);
    const families = parseCatalog(await res.text());
    if (!families.length) throw new Error("empty catalog");
    body = JSON.stringify({ families });
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    return new Response(JSON.stringify({ error: "Google Fonts can't be reached", detail }), { status: 502, headers: { "content-type": JSON_TYPE, "cache-control": "no-store" } });
  }
  const answer = new Response(body, { status: 200, headers: { "content-type": JSON_TYPE, "cache-control": `public, max-age=${DAY_S}` } });
  if (cache) {
    const put = cache.put(key, answer.clone()).catch(() => {});
    if (deps.waitUntil) deps.waitUntil(put);
    else await put;
  }
  return answer;
}
