// Google Fonts in main (docs/desktop.md §14.1): the catalog parsed and cached, a family's file downloaded once from
// the google/fonts repository (the download list when the repository has no folder), offline behaviour, previews.
// The network is mocked.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  familyDir, googleCatalog, googleFaceId, googleFontCached, googleFontPath, googlePreview, googleStyleName, parseCatalog, parseGoogleFaceId,
  parseMetadataPb, pickFile, setFetch, setGoogleFontsRoot,
} from "./googleFonts";

const TTF = new Uint8Array(readFileSync(fileURLToPath(new URL("../renderer/src/engine/fonts/Inter-3.19.ttf", import.meta.url))));

const CATALOG = `)]}'
{"axisRegistry": [], "familyMetadataList": [
  {"family": "Outfit", "category": "Sans Serif", "popularity": 120, "axes": [{"tag": "wght", "min": 100.0, "max": 900.0, "defaultValue": 400.0}],
   "fonts": {"100": {}, "400": {}, "600": {}, "900": {}}},
  {"family": "Abril Fatface", "category": "Display", "popularity": 300, "axes": [], "fonts": {"400": {}}},
  {"family": "Roboto Flex", "category": "Sans Serif", "popularity": 50, "axes": [{"tag": "wght", "min": 100, "max": 1000, "defaultValue": 400}],
   "fonts": {"1": {}, "400": {}, "1000": {}}},
  {"family": "Lora", "category": "Serif", "popularity": 40, "axes": [{"tag": "wght", "min": 400, "max": 700, "defaultValue": 400}],
   "fonts": {"400": {}, "400i": {}, "700": {}, "700i": {}}}
]}`;

const OUTFIT_PB = `name: "Outfit"
license: "OFL"
fonts {
  name: "Outfit"
  style: "normal"
  weight: 400
  filename: "Outfit[wght].ttf"
  post_script_name: "Outfit-Thin"
}
subsets: "latin"
axes {
  tag: "wght"
  min_value: 100.0
}
`;

const LORA_PB = `name: "Lora"
fonts {
  name: "Lora"
  style: "normal"
  weight: 400
  filename: "Lora[wght].ttf"
}
fonts {
  name: "Lora"
  style: "italic"
  weight: 400
  filename: "Lora-Italic[wght].ttf"
}
`;

const STATIC_PB = `fonts {
  style: "normal"
  weight: 400
  filename: "Abril-Regular.ttf"
}
fonts {
  style: "normal"
  weight: 700
  filename: "Abril-Bold.ttf"
}
fonts {
  style: "italic"
  weight: 400
  filename: "Abril-Italic.ttf"
}
`;

type Route = (url: string) => { status: number; body: string | Uint8Array } | undefined;
let routes: Route[] = [];
let calls: string[] = [];
let dir = "";

function serve(...r: Route[]) {
  routes = r;
  setFetch(async (url) => {
    calls.push(url);
    for (const route of routes) {
      const hit = route(url);
      if (hit) {
        const body = hit.body;
        return {
          ok: hit.status >= 200 && hit.status < 300,
          status: hit.status,
          text: async () => (typeof body === "string" ? body : new TextDecoder().decode(body)),
          arrayBuffer: async () => (typeof body === "string" ? new TextEncoder().encode(body).buffer : body.slice().buffer) as ArrayBuffer,
        };
      }
    }
    return { ok: false, status: 404, text: async () => "", arrayBuffer: async () => new ArrayBuffer(0) };
  });
}
const offline = () =>
  setFetch(async (url) => {
    calls.push(url);
    throw new TypeError("fetch failed");
  });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "gf-"));
  setGoogleFontsRoot(dir);
  calls = [];
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("Google Fonts catalog", () => {
  it("parses families with Google's style names and per-file ids", () => {
    const list = parseCatalog(CATALOG);
    expect(list.map((f) => f.family)).toEqual(["Abril Fatface", "Lora", "Outfit", "Roboto Flex"]);
    const outfit = list.find((f) => f.family === "Outfit")!;
    expect(outfit.styles.map((s) => s.style)).toEqual(["Thin", "Regular", "SemiBold", "Black"]);
    expect(outfit.category).toBe("Sans Serif");
    expect(outfit.axes[0]).toEqual({ tag: "wght", min: 100, max: 900, default: 400 });
    // A variable family's styles share their slant's file.
    expect(new Set(outfit.styles.map((s) => s.id))).toEqual(new Set(["g:v:Outfit"]));
    const lora = list.find((f) => f.family === "Lora")!;
    expect(lora.styles.map((s) => s.style)).toEqual(["Regular", "Italic", "Bold", "Bold Italic"]);
    expect(lora.styles.find((s) => s.italic)!.id).toBe("g:vi:Lora");
    // Weights outside the named instances (a 1–1000 axis) aren't styles.
    expect(list.find((f) => f.family === "Roboto Flex")!.styles.map((s) => s.style)).toEqual(["Regular"]);
    // A static family: one id per style.
    expect(list.find((f) => f.family === "Abril Fatface")!.styles[0].id).toBe("g:400:Abril Fatface");
  });

  it("names styles and ids as Google and the reader expect", () => {
    expect(googleStyleName(600, true)).toBe("SemiBold Italic");
    expect(googleStyleName(400, true)).toBe("Italic");
    expect(parseGoogleFaceId(googleFaceId("Noto Sans JP", 700, true, false))).toEqual({ family: "Noto Sans JP", variable: false, italic: true, weight: 700 });
    expect(parseGoogleFaceId("g:vi:Lora")).toEqual({ family: "Lora", variable: true, italic: true, weight: 400 });
    expect(parseGoogleFaceId("abc")).toBeNull();
    expect(familyDir("M PLUS 1p")).toBe("mplus1p");
  });

  it("is fetched once, cached on disk, and empty offline without a cache", async () => {
    offline();
    expect(await googleCatalog()).toEqual([]);
    serve((u) => (u.startsWith("https://fonts.google.com/metadata/fonts") ? { status: 200, body: CATALOG } : undefined));
    setGoogleFontsRoot(dir);
    expect((await googleCatalog()).length).toBe(4);
    expect(JSON.parse(readFileSync(join(dir, "cache", "google-fonts-v1.json"), "utf8")).families).toHaveLength(4);
    // Next launch, offline: the cached catalog.
    offline();
    setGoogleFontsRoot(dir);
    calls = [];
    expect((await googleCatalog()).length).toBe(4);
    expect(calls).toEqual([]);
  });
});

describe("Google Fonts files", () => {
  it("reads METADATA.pb's files and picks the style's", () => {
    const fonts = parseMetadataPb(LORA_PB);
    expect(fonts).toEqual([
      { style: "normal", weight: 400, filename: "Lora[wght].ttf" },
      { style: "italic", weight: 400, filename: "Lora-Italic[wght].ttf" },
    ]);
    expect(pickFile(fonts, 700, true)!.filename).toBe("Lora-Italic[wght].ttf");
    const statics = parseMetadataPb(STATIC_PB);
    expect(pickFile(statics, 700, false)!.filename).toBe("Abril-Bold.ttf");
    expect(pickFile(statics, 600, false)!.filename).toBe("Abril-Bold.ttf");
    expect(pickFile(statics, 400, true)!.filename).toBe("Abril-Italic.ttf");
    expect(parseMetadataPb(OUTFIT_PB)).toHaveLength(1);
  });

  it("downloads a family's file from the repository once, then serves it from disk (offline too)", async () => {
    serve(
      (u) => (u === "https://raw.githubusercontent.com/google/fonts/main/ofl/outfit/METADATA.pb" ? { status: 200, body: OUTFIT_PB } : undefined),
      (u) => (u === "https://raw.githubusercontent.com/google/fonts/main/ofl/outfit/Outfit%5Bwght%5D.ttf" ? { status: 200, body: TTF } : undefined),
    );
    expect(await googleFontCached("g:v:Outfit")).toBe(false);
    const [a, b] = await Promise.all([googleFontPath("g:v:Outfit"), googleFontPath("g:v:Outfit")]);
    expect(a).toBe(b);
    expect(a).toBe(join(dir, "fonts", "google", "outfit", "Outfit[wght].ttf"));
    expect(readFileSync(a).length).toBe(TTF.length);
    expect(calls.filter((c) => c.endsWith(".ttf"))).toHaveLength(1);
    expect(await googleFontCached("g:v:Outfit")).toBe(true);
  });

  it("probes the licence folders and falls back to Google's download list", async () => {
    const list = JSON.stringify({ manifest: { fileRefs: [
      { filename: "static/Abril-Bold.ttf", url: "https://fonts.gstatic.com/s/abril/bold.ttf" },
      { filename: "static/Abril-Regular.ttf", url: "https://fonts.gstatic.com/s/abril/regular.ttf" },
    ] } });
    serve(
      (u) => (u.startsWith("https://fonts.google.com/download/list?family=Abril%20Fatface") ? { status: 200, body: `)]}'\n${list}` } : undefined),
      (u) => (u === "https://fonts.gstatic.com/s/abril/regular.ttf" ? { status: 200, body: TTF } : undefined),
    );
    const path = await googleFontPath("g:400:Abril Fatface");
    expect(path.endsWith(join("abrilfatface", "list", "Abril-Regular.ttf"))).toBe(true);
    // ofl, apache and ufl were tried first.
    expect(calls.filter((c) => c.endsWith("/abrilfatface/METADATA.pb"))).toHaveLength(3);
  });

  it("fails offline for a file never downloaded (the text shows as missing), and tries again later", async () => {
    offline();
    await expect(googleFontPath("g:v:Outfit")).rejects.toThrow();
    serve(
      (u) => (u.endsWith("/ofl/outfit/METADATA.pb") ? { status: 200, body: OUTFIT_PB } : undefined),
      (u) => (u.endsWith("Outfit%5Bwght%5D.ttf") ? { status: 200, body: TTF } : undefined),
    );
    expect(await googleFontPath("g:v:Outfit")).toContain("Outfit[wght].ttf");
  });

  it("refuses what isn't a font", async () => {
    serve(
      (u) => (u.endsWith("/ofl/outfit/METADATA.pb") ? { status: 200, body: OUTFIT_PB } : undefined),
      (u) => (u.endsWith(".ttf") ? { status: 200, body: "<html>rate limited</html>" } : undefined),
    );
    await expect(googleFontPath("g:v:Outfit")).rejects.toThrow();
  });
});

describe("Google Fonts previews", () => {
  it("subsets the family to its name through css2 and caches it", async () => {
    serve(
      (u) => (u.startsWith("https://fonts.googleapis.com/css2?family=Outfit&text=Outfit") ? { status: 200, body: "@font-face { src: url(https://fonts.gstatic.com/l/font?kit=abc&v=v15) format('truetype'); }" } : undefined),
      (u) => (u === "https://fonts.gstatic.com/l/font?kit=abc&v=v15" ? { status: 200, body: TTF } : undefined),
    );
    expect((await googlePreview("Outfit", "Outfit")).length).toBe(TTF.length);
    offline();
    expect((await googlePreview("Outfit", "Outfit")).length).toBe(TTF.length);
  });
});
