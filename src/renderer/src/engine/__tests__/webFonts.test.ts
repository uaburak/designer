// The web app's fonts (docs/desktop.md §14.1, §14.3): the Google catalog from the server, Google files from the
// google/fonts repository kept in Cache Storage, the signed-in person's shared fonts (list and files, SHA-1 checked,
// kept, evicted when no longer listed), the list following the session. The network and Cache Storage are fakes.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createWebFontSource, WEB_FONT_CACHE, type WebFontsDeps } from "../webFonts";
import type { FontFaceInfo, FontScope } from "../fonts";

const SERVER = "https://wecra.app";
const REPO = "https://raw.githubusercontent.com/google/fonts/main";
const ttf = (seed: string) => new Uint8Array([0, 1, 0, 0, 0, 4, 0, 0, 0, 0, 0, 0, ...new TextEncoder().encode(seed)]);
const sha1 = (b: Uint8Array) => createHash("sha1").update(b).digest("hex");

const CATALOG = {
  families: [
    { family: "Outfit", category: "Sans Serif", popularity: 120, axes: [{ tag: "wght", min: 100, max: 900, default: 400 }], styles: [{ style: "Regular", weight: 400, italic: false, id: "g:v:Outfit" }, { style: "Bold", weight: 700, italic: false, id: "g:v:Outfit" }] },
    { family: "Inter", category: "Sans Serif", popularity: 1, axes: [], styles: [{ style: "Regular", weight: 400, italic: false, id: "g:400:Inter" }] },
  ],
};
const OUTFIT_PB = `name: "Outfit"
fonts {
  name: "Outfit"
  style: "normal"
  weight: 400
  filename: "Outfit[wght].ttf"
}
`;
const OUTFIT = ttf("outfit");
const ACME = ttf("acme");
const BRAND = ttf("brand");
const face = (id: string, family: string, bytes: Uint8Array, teamId: string | null) => ({ id, family, style: "Regular", weight: 400, italic: false, orgId: "acme", teamId, sha1: sha1(bytes), format: "ttf", size: bytes.length, fileName: `${family}.ttf` });

/** Cache Storage with one cache, by URL */
function fakeCaches() {
  const store = new Map<string, Response>();
  const cache = {
    match: async (k: string | Request) => store.get(typeof k === "string" ? k : k.url)?.clone(),
    put: async (k: string | Request, r: Response) => void store.set(typeof k === "string" ? k : k.url, r),
    keys: async () => [...store.keys()].map((u) => new Request(u)),
    delete: async (k: string | Request) => store.delete(typeof k === "string" ? k : k.url),
  };
  const opened: string[] = [];
  const caches = { open: async (name: string) => (opened.push(name), cache) } as unknown as CacheStorage;
  return { caches, store, opened };
}

interface World {
  deps: WebFontsDeps;
  calls: { url: string; auth: string | null }[];
  routes: Map<string, () => Response>;
  signIn(userId?: string): void;
  signOut(): void;
  store: Map<string, Response>;
  opened: string[];
  timers: (() => void)[];
}

function world(): World {
  const routes = new Map<string, () => Response>([
    [`${SERVER}/google-fonts/catalog`, () => Response.json(CATALOG)],
    [`${REPO}/ofl/outfit/METADATA.pb`, () => new Response(OUTFIT_PB)],
    [`${REPO}/ofl/outfit/Outfit%5Bwght%5D.ttf`, () => new Response(OUTFIT)],
    [`${SERVER}/me/fonts`, () => Response.json({ version: "v1", faces: [face("o1", "Acme Sans", ACME, null), face("t1", "Brand Serif", BRAND, "brand"), { id: "bad", family: "x" }] })],
    [`${SERVER}/fonts/${sha1(ACME)}`, () => new Response(ACME)],
    [`${SERVER}/fonts/${sha1(BRAND)}`, () => new Response(ttf("tampered"))],
  ]);
  const calls: World["calls"] = [];
  let session: { server: string; token: string; userId: string } | null = null;
  const sessionListeners = new Set<() => void>();
  const { caches, store, opened } = fakeCaches();
  const timers: (() => void)[] = [];
  const deps: WebFontsDeps = {
    fetch: async (url, init) => {
      calls.push({ url, auth: (init?.headers as Record<string, string> | undefined)?.authorization ?? null });
      const r = routes.get(url);
      return r ? r() : new Response("not found", { status: 404 });
    },
    caches,
    server: () => SERVER,
    session: () => session,
    onSessionChange: (cb) => (sessionListeners.add(cb), () => void sessionListeners.delete(cb)),
    setTimer: (fn) => void timers.push(fn),
  };
  return {
    deps, calls, routes, store, opened, timers,
    signIn(userId = "u1") {
      session = { server: SERVER, token: `tok-${userId}`, userId };
      for (const l of sessionListeners) l();
    },
    signOut() {
      session = null;
      for (const l of sessionListeners) l();
    },
  };
}

const ORG_FILE: FontScope = { orgId: "acme", teamId: null, orgName: "Acme" };
const TEAM_FILE: FontScope = { orgId: "acme", teamId: "brand", orgName: "Acme" };
const families = (faces: FontFaceInfo[]) => [...new Set(faces.map((f) => `${f.family}:${f.source}`))].sort();
const settle = () => new Promise((r) => setTimeout(r, 0));

describe("the web app's fonts", () => {
  it("signed out: Figma's Inter and the Google catalog from the server (Figma's Inter over Google's)", async () => {
    const w = world();
    const src = createWebFontSource(w.deps);
    expect(families(await src.list(ORG_FILE))).toEqual(["Inter:bundled", "Outfit:google"]);
    expect(w.calls.map((c) => c.url)).toEqual([`${SERVER}/google-fonts/catalog`]);
    await src.list(null);
    expect(w.calls).toHaveLength(1); // the catalog once
  });

  it("a Google face's file: METADATA.pb → the slant's file, kept in Cache Storage", async () => {
    const w = world();
    const src = createWebFontSource(w.deps);
    const faces = await src.list(null);
    const bold = faces.find((f) => f.family === "Outfit" && f.style === "Bold")!;
    expect([...(await src.read(bold))]).toEqual([...OUTFIT]);
    expect(w.opened[0]).toBe(WEB_FONT_CACHE);
    expect(w.store.has(`${REPO}/ofl/outfit/Outfit%5Bwght%5D.ttf`)).toBe(true);
    // Another source (a reload) reads it from the cache, not the network.
    const again = createWebFontSource(w.deps);
    const before = w.calls.length;
    expect([...(await again.read(bold))]).toEqual([...OUTFIT]);
    expect(w.calls.slice(before).map((c) => c.url)).toEqual([]);
    // Not in the repository: missing (the download list can't be read from a page).
    await expect(src.read({ ...bold, id: "g:400:Nowhere", family: "Nowhere" })).rejects.toThrow();
  });

  it("offline: no catalog now, a minute later the list changes", async () => {
    const w = world();
    w.routes.set(`${SERVER}/google-fonts/catalog`, () => new Response("down", { status: 502 }));
    const src = createWebFontSource(w.deps);
    let told = 0;
    src.onChanged(() => told++);
    expect(families(await src.list(null))).toEqual(["Inter:bundled"]);
    w.routes.set(`${SERVER}/google-fonts/catalog`, () => Response.json(CATALOG));
    w.timers.splice(0).forEach((t) => t());
    await settle();
    expect(told).toBe(1);
    expect(families(await src.list(null))).toEqual(["Inter:bundled", "Outfit:google"]);
  });

  it("signed in: the file's organization and team fonts, with the session's token; files SHA-1 checked and kept", async () => {
    const w = world();
    w.signIn();
    const src = createWebFontSource(w.deps);
    expect(families(await src.list(null))).toEqual(["Inter:bundled", "Outfit:google"]); // a local file: none
    expect(families(await src.list(ORG_FILE))).toEqual(["Acme Sans:shared", "Inter:bundled", "Outfit:google"]);
    const team = await src.list(TEAM_FILE);
    expect(families(team)).toEqual(["Acme Sans:shared", "Brand Serif:shared", "Inter:bundled", "Outfit:google"]);
    expect(w.calls.find((c) => c.url === `${SERVER}/me/fonts`)?.auth).toBe("Bearer tok-u1");
    const acme = team.find((f) => f.family === "Acme Sans")!;
    expect(acme.id).toBe("s:o1");
    expect([...(await src.read(acme))]).toEqual([...ACME]);
    expect(w.calls.find((c) => c.url === `${SERVER}/fonts/${sha1(ACME)}`)?.auth).toBe("Bearer tok-u1");
    expect(w.store.has(`${SERVER}/fonts/${sha1(ACME)}`)).toBe(true);
    // The server's bytes aren't the listed file: refused.
    await expect(src.read(team.find((f) => f.family === "Brand Serif")!)).rejects.toThrow(/not the listed file/);
  });

  it("the list follows the session; a file no longer listed is dropped from the cache", async () => {
    const w = world();
    w.signIn();
    const src = createWebFontSource(w.deps);
    let told = 0;
    src.onChanged(() => told++);
    const faces = await src.list(ORG_FILE);
    await src.read(faces.find((f) => f.family === "Acme Sans")!);
    w.signOut();
    await settle();
    expect(told).toBe(1);
    expect(families(await src.list(ORG_FILE))).toEqual(["Inter:bundled", "Outfit:google"]);
    expect(w.store.has(`${SERVER}/fonts/${sha1(ACME)}`)).toBe(true); // signed out: files stay
    // Signed in again, Acme Sans is gone from the org: its file goes.
    w.routes.set(`${SERVER}/me/fonts`, () => Response.json({ version: "v2", faces: [face("t1", "Brand Serif", BRAND, "brand")] }));
    w.signIn();
    await settle();
    await settle();
    expect(told).toBe(2);
    expect(families(await src.list(TEAM_FILE))).toEqual(["Brand Serif:shared", "Inter:bundled", "Outfit:google"]);
    expect(w.store.has(`${SERVER}/fonts/${sha1(ACME)}`)).toBe(false);
  });

  it("offline after a sign-in: the kept list of that account", async () => {
    const w = world();
    w.signIn();
    await createWebFontSource(w.deps).list(ORG_FILE);
    w.routes.delete(`${SERVER}/me/fonts`);
    const offline = { ...w.deps, fetch: () => Promise.reject(new TypeError("offline")) };
    expect(families(await createWebFontSource(offline).list(ORG_FILE))).toContain("Acme Sans:shared");
    // Another account doesn't see it.
    w.signIn("u2");
    expect(families(await createWebFontSource(offline).list(ORG_FILE))).toEqual(["Inter:bundled"]);
  });
});
