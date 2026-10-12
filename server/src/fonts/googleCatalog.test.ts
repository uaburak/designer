// GET /google-fonts/catalog (the web app's Google Fonts catalog): Google's catalog reduced as main does, a 502 when
// Google can't be reached, kept at the edge (the Workers Cache API, faked here).
import { afterEach, describe, expect, it } from "vitest";
import type { Deps } from "../api";
import { googleCatalogRoute } from "./googleCatalog";

const CATALOG = `)]}'
{"familyMetadataList": [
  {"family": "Outfit", "category": "Sans Serif", "popularity": 120, "axes": [{"tag": "wght", "min": 100, "max": 900, "defaultValue": 400}], "fonts": {"400": {}, "700": {}}},
  {"family": "Abril Fatface", "category": "Display", "popularity": 300, "axes": [], "fonts": {"400": {}}}
]}`;

function deps(answer: () => Response | Promise<Response>): { deps: Deps; calls: string[] } {
  const calls: string[] = [];
  const fetch = (async (url: string) => {
    calls.push(String(url));
    return answer();
  }) as unknown as typeof globalThis.fetch;
  return { deps: { fetch, now: () => 0 } as unknown as Deps, calls };
}

const req = () => new Request("https://wecra.app/google-fonts/catalog?x=1");

afterEach(() => {
  delete (globalThis as { caches?: unknown }).caches;
});

describe("GET /google-fonts/catalog", () => {
  it("reduces Google's catalog as main does, public for a day", async () => {
    const { deps: d, calls } = deps(() => new Response(CATALOG));
    const res = await googleCatalogRoute(req(), d);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("public, max-age=86400");
    const body = (await res.json()) as { families: { family: string; styles: { id: string; style: string }[] }[] };
    expect(body.families.map((f) => f.family)).toEqual(["Abril Fatface", "Outfit"]);
    expect(body.families[1].styles.map((s) => [s.style, s.id])).toEqual([["Regular", "g:v:Outfit"], ["Bold", "g:v:Outfit"]]);
    expect(calls).toEqual(["https://fonts.google.com/metadata/fonts"]);
  });

  it("Google failing is a 502", async () => {
    expect((await googleCatalogRoute(req(), deps(() => new Response("nope", { status: 503 })).deps)).status).toBe(502);
    expect((await googleCatalogRoute(req(), deps(() => new Response("<html>")).deps)).status).toBe(502);
    const offline = deps(() => Promise.reject(new Error("offline")));
    const res = await googleCatalogRoute(req(), offline.deps);
    expect(res.status).toBe(502);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("is kept at the edge: a second ask doesn't go to Google", async () => {
    const store = new Map<string, Response>();
    (globalThis as { caches?: unknown }).caches = {
      default: {
        match: async (r: Request) => store.get(r.url)?.clone(),
        put: async (r: Request, res: Response) => void store.set(r.url, res),
      },
    };
    const { deps: d, calls } = deps(() => new Response(CATALOG));
    await googleCatalogRoute(req(), d);
    const again = await googleCatalogRoute(new Request("https://wecra.app/google-fonts/catalog"), d);
    expect(again.status).toBe(200);
    expect(((await again.json()) as { families: unknown[] }).families).toHaveLength(2);
    expect(calls).toHaveLength(1);
    expect([...store.keys()]).toEqual(["https://wecra.app/google-fonts/catalog"]);
  });
});
