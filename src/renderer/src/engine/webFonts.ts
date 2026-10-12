/**
 * Fonts in the web app (docs/desktop.md §14.1 and §14.3, as Figma's web app has them): Figma's Inter, the Google Fonts
 * catalog and the signed-in person's organization and team fonts — no fonts on the computer (the desktop's index of
 * installed and uploaded fonts is the desktop's). What main does for the desktop (src/main/googleFonts.ts,
 * src/main/sharedFonts.ts), done by the page, with the browser's Cache Storage where main keeps files in `userData`:
 *
 * - **Google catalog**: `GET <server>/google-fonts/catalog` (the Worker reads fonts.google.com, which a page can't, and
 *   reduces it with the same `parseCatalog`). Offline: none until it answers (tried again a minute later, then the
 *   list changes).
 * - **Google files**: straight from the google/fonts repository (raw.githubusercontent.com answers any origin): the
 *   family's METADATA.pb → `pickFile` → the TTF, both kept in Cache Storage (`wecra-fonts-v1`). Google's download list
 *   (main's fallback) can't be read from a page, so a family missing from the repository is a missing font here.
 * - **Shared fonts**: `GET <server>/me/fonts` with the session (kept in Cache Storage per account for offline use),
 *   read again when the session changes and at most every 6 hours on focus; a face's file `GET <server>/fonts/<sha1>`
 *   checked against its SHA-1, kept in Cache Storage. A successful read of the list drops the kept files no longer
 *   listed (licences, as main's eviction). Signed out: no shared fonts (their files stay until a signed-in read).
 */
import type { FontFaceInfo, FontScope, FontSource, GoogleFamilyEntry, SharedFaceEntry } from "./fonts";
import { BUNDLED_URLS, mergeFaces, sharedForScope } from "./fonts";
import { isWebApp } from "../app/webApp";
import { currentWebSession, webAccount, webServer } from "../store/webAccount";
import { familyDir, isSfnt, LICENSE_DIRS, metadataUrl, parseGoogleFaceId, parseMetadataPb, pickFile, repoFileUrl, type FamilyFiles } from "@shared/fonts/google";

/** The Cache Storage cache the page keeps font files (and the lists) in */
export const WEB_FONT_CACHE = "wecra-fonts-v1";
const TIMEOUT_MS = 30_000;
const RETRY_MS = 60_000;
/** On focus, the shared list is read again at most this often (main's FOCUS_REFRESH_MS) */
const FOCUS_REFRESH_MS = 6 * 3600 * 1000;

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

/** A shared face as `GET /me/fonts` lists it (src/shared/fonts/sharedTypes.ts SharedFontFace, the fields used here). */
interface ListedFace extends SharedFaceEntry {
  sha1: string;
  format: "ttf" | "otf";
}

export interface WebFontsDeps {
  fetch: Fetch;
  /** The browser's Cache Storage; null where there is none (the files are fetched every time) */
  caches: CacheStorage | null;
  /** The server the page talks to (its catalog, the shared fonts) */
  server(): string;
  /** The signed-in session, null signed out */
  session(): { server: string; token: string; userId: string } | null;
  /** Told when the session changes (sign-in, sign-out, another tab's) */
  onSessionChange?(cb: () => void): () => void;
  /** Milliseconds (tests) */
  now?(): number;
  /** Delayed work (tests run it at once or never) */
  setTimer?(fn: () => void, ms: number): void;
}

export interface WebFontSource extends FontSource {
  /** Told when the list changes (the catalog arrived, the shared fonts changed) */
  onChanged(cb: () => void): () => void;
  /** Reads the shared list again (an Inbox `fonts` notice, focus); resolves true when it changed */
  refreshShared(): Promise<boolean>;
}

const validFace = (f: unknown): f is ListedFace => {
  const x = f as ListedFace;
  return !!x && typeof x.id === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(x.id) && typeof x.family === "string" && typeof x.style === "string" && typeof x.sha1 === "string" && /^[0-9a-f]{40}$/.test(x.sha1) && (x.format === "ttf" || x.format === "otf") && typeof x.orgId === "string";
};
/** What the pickers see changes when the faces do (main's idsOf) */
const idsOf = (faces: readonly ListedFace[]) => faces.map((f) => `${f.id}\t${f.family}\t${f.style}`).join("\n");
const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
const magic = (b: Uint8Array) => (b.length >= 4 ? ((b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3]) >>> 0 : 0);
const ttfOrOtf = (b: Uint8Array) => [0x4f54544f, 0x00010000, 0x74727565].includes(magic(b));
const base = (s: string) => s.replace(/\/+$/, "");

export function createWebFontSource(deps: WebFontsDeps): WebFontSource {
  const now = deps.now ?? (() => Date.now());
  const later = deps.setTimer ?? ((fn: () => void, ms: number) => void setTimeout(fn, ms));
  const listeners = new Set<() => void>();
  const changed = () => {
    for (const l of listeners) l();
  };

  async function get(url: string, headers?: Record<string, string>): Promise<Response> {
    const signal = typeof AbortSignal !== "undefined" && "timeout" in AbortSignal ? AbortSignal.timeout(TIMEOUT_MS) : undefined;
    return deps.fetch(url, { headers, signal });
  }

  let cacheOpen: Promise<Cache | null> | null = null;
  const cache = (): Promise<Cache | null> =>
    (cacheOpen ??= deps.caches ? deps.caches.open(WEB_FONT_CACHE).catch(() => null) : Promise.resolve(null));
  async function cached(key: string): Promise<Response | null> {
    const c = await cache();
    return (await c?.match(key).catch(() => undefined)) ?? null;
  }
  async function keep(key: string, body: BodyInit, type: string): Promise<void> {
    const c = await cache();
    await c?.put(key, new Response(body, { headers: { "content-type": type } })).catch(() => {});
  }

  // ---- Google catalog ----------------------------------------------------------------------

  let catalog: GoogleFamilyEntry[] | null = null;
  let catalogLoad: Promise<GoogleFamilyEntry[]> | null = null;
  let retrying = false;

  async function fetchCatalog(): Promise<GoogleFamilyEntry[]> {
    const res = await get(`${base(deps.server())}/google-fonts/catalog`);
    if (!res.ok) throw new Error(`google fonts: catalog ${res.status}`);
    const body = (await res.json()) as { families?: unknown };
    if (!Array.isArray(body?.families) || !body.families.length) throw new Error("google fonts: empty catalog");
    return body.families as GoogleFamilyEntry[];
  }

  function googleCatalog(): Promise<GoogleFamilyEntry[]> {
    if (catalog) return Promise.resolve(catalog);
    catalogLoad ??= fetchCatalog().then(
      (families) => (catalog = families),
      () => {
        // Offline (or the server failing): none now, asked again on the next list and a minute later.
        catalogLoad = null;
        if (!retrying) {
          retrying = true;
          later(() => {
            retrying = false;
            void fetchCatalog().then((families) => {
              if (catalog) return;
              catalog = families;
              changed();
            }, () => {});
          }, RETRY_MS);
        }
        return [];
      },
    );
    return catalogLoad;
  }

  // ---- Google files ------------------------------------------------------------------------

  const familyFilesMemo = new Map<string, Promise<FamilyFiles | null>>();
  const downloads = new Map<string, Promise<Uint8Array>>();

  function familyFiles(family: string): Promise<FamilyFiles | null> {
    const dir = familyDir(family);
    let p = familyFilesMemo.get(dir);
    if (!p) {
      p = (async () => {
        for (const license of LICENSE_DIRS) {
          const url = metadataUrl(license, dir);
          let text = await (await cached(url))?.text();
          if (text === undefined) {
            const res = await get(url).catch(() => null);
            if (!res?.ok) continue;
            text = await res.text();
            if (parseMetadataPb(text).length) await keep(url, text, "text/plain");
          }
          const fonts = parseMetadataPb(text);
          if (fonts.length) return { license, dir, fonts };
        }
        return null;
      })();
      familyFilesMemo.set(dir, p);
      // Not found or failed (offline): asked again next time.
      void p.then((v) => v ?? familyFilesMemo.delete(dir), () => familyFilesMemo.delete(dir));
    }
    return p;
  }

  async function readGoogle(id: string): Promise<Uint8Array> {
    const face = parseGoogleFaceId(id);
    if (!face) throw new Error(`google fonts: bad id ${id}`);
    const files = await familyFiles(face.family);
    const file = files ? pickFile(files.fonts, face.weight, face.italic) : null;
    if (!files || !file) throw new Error(`google fonts: no file for ${face.family}`);
    const url = repoFileUrl(files, file.filename);
    let p = downloads.get(url);
    if (!p) {
      p = (async () => {
        const hit = await cached(url);
        if (hit) {
          const b = new Uint8Array(await hit.arrayBuffer());
          if (isSfnt(b)) return b;
        }
        const res = await get(url);
        if (!res.ok) throw new Error(`google fonts: ${face.family} ${res.status}`);
        const bytes = new Uint8Array(await res.arrayBuffer());
        if (!isSfnt(bytes)) throw new Error(`google fonts: ${face.family}: not a font`);
        await keep(url, bytes.slice().buffer, "font/ttf");
        return bytes;
      })();
      downloads.set(url, p);
      p.catch(() => downloads.delete(url));
    }
    return p;
  }

  // ---- Shared fonts ------------------------------------------------------------------------

  let shared: ListedFace[] = [];
  /** The account the list is of ("" none yet): another account starts from its own cached list */
  let sharedFor = "";
  let sharedLoad: Promise<void> | null = null;
  let refreshing: Promise<boolean> | null = null;
  let lastRefresh = 0;
  const sharedDownloads = new Map<string, Promise<Uint8Array>>();

  const accountKey = (s: { server: string; userId: string }) => `${base(s.server)}\n${s.userId}`;
  const listKey = (s: { server: string; userId: string }) => `${base(s.server)}/me/fonts?user=${encodeURIComponent(s.userId)}`;
  const fileKey = (server: string, sha1: string) => `${base(server)}/fonts/${sha1}`;

  /** The list kept for this account (offline), read once per account. */
  function loadShared(): Promise<void> {
    const s = deps.session();
    const key = s ? accountKey(s) : "";
    if (key !== sharedFor) {
      sharedFor = key;
      shared = [];
      sharedLoad = null;
    }
    sharedLoad ??= (async () => {
      if (!s) return;
      try {
        const body = (await (await cached(listKey(s)))?.json()) as { faces?: unknown } | undefined;
        if (sharedFor === key && Array.isArray(body?.faces) && !shared.length) shared = body.faces.filter(validFace);
      } catch {
        // none kept
      }
    })();
    return sharedLoad;
  }

  /** The account the running refresh is for: a refresh asked for another one runs after it */
  let refreshingFor: string | null = null;

  function refreshShared(): Promise<boolean> {
    const s0 = deps.session();
    const key = s0 ? accountKey(s0) : "";
    if (refreshing && refreshingFor !== key) {
      const after = refreshing.then(() => {}, () => {}).then(() => refreshShared());
      return refreshing.then((a) => after.then((b) => a || b), () => after);
    }
    refreshingFor = key;
    refreshing ??= (async () => {
      // What the pickers saw: an account switch or sign-out is a change too.
      const before = idsOf(shared);
      const differs = () => idsOf(shared) !== before;
      try {
        await loadShared();
        const s = deps.session();
        if (!s) {
          shared = [];
          return differs();
        }
        let res: Response;
        try {
          res = await get(`${base(s.server)}/me/fonts`, { authorization: `Bearer ${s.token}` });
        } catch {
          return differs(); // offline: the kept list stays
        }
        if (res.status === 401) {
          // The session is gone: like signed out (the account drops it on its own request).
          shared = [];
          return differs();
        }
        if (!res.ok) return differs();
        const body = (await res.json().catch(() => null)) as { version?: unknown; faces?: unknown } | null;
        if (accountKey(s) !== sharedFor) return differs(); // another account meanwhile
        lastRefresh = now();
        const faces = Array.isArray(body?.faces) ? body.faces.filter(validFace) : [];
        shared = faces;
        await keep(listKey(s), JSON.stringify({ version: typeof body?.version === "string" ? body.version : "", faces }), "application/json");
        await evict(s.server, faces);
        return differs();
      } finally {
        refreshing = null;
        refreshingFor = null;
      }
    })();
    return refreshing;
  }

  /** Drops the kept files no listed face uses (someone who left the org stops having its fonts). */
  async function evict(server: string, faces: readonly ListedFace[]): Promise<void> {
    const c = await cache();
    if (!c) return;
    const keepUrls = new Set(faces.map((f) => fileKey(server, f.sha1)));
    const prefix = `${base(server)}/fonts/`;
    for (const req of await c.keys().catch(() => [] as readonly Request[])) {
      if (req.url.startsWith(prefix) && /^[0-9a-f]{40}$/.test(req.url.slice(prefix.length)) && !keepUrls.has(req.url)) await c.delete(req).catch(() => {});
    }
  }

  async function readShared(id: string): Promise<Uint8Array> {
    await loadShared();
    const s = deps.session();
    const face = shared.find((f) => f.id === id);
    if (!face || !s) throw new Error(`shared fonts: no face ${id}`);
    const url = fileKey(s.server, face.sha1);
    let p = sharedDownloads.get(url);
    if (!p) {
      p = (async () => {
        const hit = await cached(url);
        if (hit) return new Uint8Array(await hit.arrayBuffer());
        const res = await get(url, { authorization: `Bearer ${s.token}` });
        if (!res.ok) throw new Error(`shared fonts: ${face.family} ${face.style}: ${res.status}`);
        const bytes = new Uint8Array(await res.arrayBuffer());
        if (hex(await crypto.subtle.digest("SHA-1", bytes)) !== face.sha1 || !ttfOrOtf(bytes)) throw new Error(`shared fonts: ${face.family} ${face.style}: not the listed file`);
        await keep(url, bytes.slice().buffer, face.format === "otf" ? "font/otf" : "font/ttf");
        return bytes;
      })();
      sharedDownloads.set(url, p);
      p.catch(() => sharedDownloads.delete(url));
    }
    return p;
  }

  // The list follows the session (sign-in, sign-out, another tab's) and focus (at most every 6 hours).
  let firstRead = false;
  const afterRefresh = (p: Promise<boolean>) => void p.then((c) => c && changed(), () => {});
  deps.onSessionChange?.(() => afterRefresh(refreshShared()));
  if (typeof window !== "undefined") window.addEventListener("focus", () => deps.session() && now() - lastRefresh > FOCUS_REFRESH_MS && afterRefresh(refreshShared()));

  return {
    async list(scope?: FontScope | null): Promise<FontFaceInfo[]> {
      await loadShared();
      if (!firstRead && deps.session()) {
        // The first list reads the server's list (the kept one meanwhile, as main at launch).
        firstRead = true;
        if (shared.length) afterRefresh(refreshShared());
        else await refreshShared().catch(() => false);
      }
      const google = await googleCatalog();
      return mergeFaces([], google, sharedForScope(shared, scope));
    },
    async read(face: FontFaceInfo): Promise<Uint8Array> {
      const url = BUNDLED_URLS[face.id];
      if (url) return new Uint8Array(await (await deps.fetch(url)).arrayBuffer());
      if (face.id.startsWith("g:")) return readGoogle(face.id);
      if (face.id.startsWith("s:")) return readShared(face.id.slice(2));
      throw new Error(`no font ${face.family} ${face.style}`);
    },
    onChanged(cb: () => void): () => void {
      listeners.add(cb);
      return () => void listeners.delete(cb);
    },
    refreshShared,
  };
}

let instance: WebFontSource | null = null;

/**
 * The web app's font source (`isWebApp`: the web build, no desktop), its server the account's (`webServer`: the page's
 * own origin), the session the page's own sign-in. Null in the desktop app, the dev pages and tests (which make their
 * own with createWebFontSource): those keep Figma's Inter alone.
 */
export function webFontSource(): WebFontSource | null {
  if (instance) return instance;
  if (typeof window === "undefined" || typeof fetch !== "function" || !isWebApp()) return null;
  instance = createWebFontSource({
    fetch: (url, init) => fetch(url, init),
    caches: typeof caches !== "undefined" ? caches : null,
    server: webServer,
    session: currentWebSession,
    onSessionChange: (cb) => webAccount.onChanged(cb),
  });
  return instance;
}
