/**
 * Fonts for the engine (docs/engine.md §7.1, docs/desktop.md §14), once per
 * renderer process: the engine asks for a FontName {family, style}
 * (REQUEST_FONT); this finds the face — Inter is bundled with the engine, the
 * desktop app adds the system's and the user's fonts (`designer.fonts`) —,
 * hands its bytes to the engine (engine_font_add_take, once per file) and
 * binds the name to it (engine_font_bind), or reports it missing
 * (engine_font_missing: the text draws with Inter, the panel says "Missing
 * fonts"). Matching: family (case-insensitive), then the style name (spaces
 * and case ignored), then the PostScript name, then the nearest weight with
 * the same slant.
 */
import interItalicUrl from "./fonts/InterVariable-Italic.ttf?url";
import interUrl from "./fonts/InterVariable.ttf?url";
import type { EngineExports } from "./EngineExports";

/** One face of a font file (the desktop's FontIndex entries, and the bundled Inter's). */
export interface FontFaceInfo {
  /** Stable id: the desktop's index id, or "bundled:…" */
  id: string;
  family: string;
  /** Typographic subfamily, e.g. "Semi Bold Italic" */
  style: string;
  postscriptName?: string;
  weight: number;
  italic: boolean;
  source: "bundled" | "system" | "user";
  collectionIndex: number;
}

/** Where faces come from. `read` returns the whole file the face is in. */
export interface FontSource {
  list(): Promise<FontFaceInfo[]>;
  read(face: FontFaceInfo): Promise<Uint8Array>;
}

const INTER_STYLES: [string, number][] = [
  ["Thin", 100], ["Extra Light", 200], ["Light", 300], ["Regular", 400], ["Medium", 500],
  ["Semi Bold", 600], ["Bold", 700], ["Extra Bold", 800], ["Black", 900],
];

/** Inter, as Figma lists it: nine weights, upright and italic (two variable files). */
export const BUNDLED_FACES: FontFaceInfo[] = INTER_STYLES.flatMap(([style, weight]) => [
  { id: "bundled:inter", family: "Inter", style, weight, italic: false, source: "bundled" as const, collectionIndex: 0 },
  {
    id: "bundled:inter-italic",
    family: "Inter",
    style: style === "Regular" ? "Italic" : `${style} Italic`,
    weight,
    italic: true,
    source: "bundled" as const,
    collectionIndex: 0,
  },
]);

const BUNDLED_URLS: Record<string, string> = { "bundled:inter": interUrl, "bundled:inter-italic": interItalicUrl };

/** Families tried, in order, for characters a text's own font lacks (macOS names; absent ones are skipped). */
export const FALLBACK_FAMILIES = [
  "PingFang SC", "Hiragino Sans", "Apple SD Gothic Neo", "Geeza Pro", "Arial Hebrew", "Thonburi", "Kohinoor Devanagari",
  "Noto Sans", "Arial Unicode MS", "Apple Symbols",
];

interface DesktopFonts {
  list(): Promise<{ faces: FontFaceInfo[] }>;
  read(id: string): Promise<Uint8Array | ArrayBuffer>;
}

function desktopFonts(): DesktopFonts | null {
  const d = (globalThis as { designer?: { fonts?: DesktopFonts } }).designer;
  return d?.fonts ?? null;
}

/** The bundled Inter, plus the desktop's fonts when there is a desktop. */
export const defaultFontSource: FontSource = {
  async list() {
    const desktop = desktopFonts();
    let system: FontFaceInfo[] = [];
    if (desktop) {
      try {
        system = (await desktop.list()).faces;
      } catch {
        system = [];
      }
    }
    // The bundled Inter wins over an installed one (the same everywhere, like Figma's).
    return [...BUNDLED_FACES, ...system.filter((f) => f.family.toLowerCase() !== "inter")];
  },
  async read(face) {
    const url = BUNDLED_URLS[face.id];
    if (url) return new Uint8Array(await (await fetch(url)).arrayBuffer());
    const desktop = desktopFonts();
    if (!desktop) throw new Error(`no font ${face.family} ${face.style}`);
    const bytes = await desktop.read(face.id);
    return bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  },
};

const norm = (s: string) => s.replace(/[\s_-]/g, "").toLowerCase();

/** The face for {family, style} among `faces`, or null (docs/desktop.md §14's matching). */
export function matchFace(faces: readonly FontFaceInfo[], family: string, style: string): FontFaceInfo | null {
  const fam = family.toLowerCase();
  const candidates = faces.filter((f) => f.family.toLowerCase() === fam);
  if (!candidates.length) return null;
  const s = norm(style);
  const exact = candidates.find((f) => norm(f.style) === s) ?? candidates.find((f) => f.postscriptName && norm(f.postscriptName) === s);
  if (exact) return exact;
  const { weight, italic } = styleWeight(style);
  let best: FontFaceInfo | null = null;
  let bestScore = Infinity;
  for (const f of candidates) {
    const score = Math.abs(f.weight - weight) + (f.italic === italic ? 0 : 1000);
    if (score < bestScore) {
      bestScore = score;
      best = f;
    }
  }
  return best;
}

/** The weight and slant a style name implies ("Semi Bold Italic" → 600, italic). */
export function styleWeight(style: string): { weight: number; italic: boolean } {
  const s = norm(style);
  const italic = s.includes("italic") || s.includes("oblique");
  const table: [string, number][] = [
    ["extralight", 200], ["ultralight", 200], ["semibold", 600], ["demibold", 600], ["extrabold", 800], ["ultrabold", 800],
    ["hairline", 100], ["thin", 100], ["light", 300], ["medium", 500], ["bold", 700], ["heavy", 900], ["black", 900],
  ];
  for (const [name, weight] of table) if (s.includes(name)) return { weight, italic };
  return { weight: 400, italic };
}

const encoder = new TextEncoder();

/** The process's font service (one engine module per renderer process). */
class FontService {
  private exports: EngineExports | null = null;
  private source: FontSource = defaultFontSource;
  private faces: Promise<FontFaceInfo[]> | null = null;
  /** File (face id + collection index) → its engine face id. */
  private loaded = new Map<string, Promise<number>>();
  private readonly listeners = new Set<() => void>();
  private pending = 0;
  private idle: (() => void)[] = [];
  /** Names already answered or on their way (the engine asks once per module; attach() asks ahead of it). */
  private readonly asked = new Set<string>();
  private readonly styles = new Map<string, string>();

  /** Called by Engine.create: the module to feed, and the fallback list (once). */
  attach(exports: EngineExports): void {
    if (this.exports === exports) return;
    this.exports = exports;
    exports.setFallbackFonts(encoder.encode(JSON.stringify(FALLBACK_FAMILIES)));
    // What every engine needs at once: the default text font and the overlays' (labels are Inter Medium).
    this.request("Inter", "Regular");
    this.request("Inter", "Medium");
  }

  /** Replaces where faces come from (tests read files from disk). */
  setSource(source: FontSource): void {
    this.source = source;
    this.refresh();
  }

  /**
   * The fonts changed (the desktop's `fonts:changed`, a new source): the index is read again and the names asked
   * for so far are answered again (a font that was missing may be there now).
   */
  refresh(): void {
    this.faces = null;
    this.loaded.clear();
    const names = [...this.asked];
    this.asked.clear();
    for (const key of names) {
      const [family, style] = key.split("\n");
      this.request(family, this.styles.get(key) ?? style);
    }
  }

  /** Every face known (bundled + desktop), for the font pickers. */
  list(): Promise<FontFaceInfo[]> {
    this.faces ??= this.source.list().catch(() => BUNDLED_FACES);
    return this.faces;
  }

  /** The families with their styles, sorted (what a font picker shows). */
  async families(): Promise<{ family: string; styles: string[] }[]> {
    const byFamily = new Map<string, FontFaceInfo[]>();
    for (const f of await this.list()) {
      const list = byFamily.get(f.family) ?? [];
      list.push(f);
      byFamily.set(f.family, list);
    }
    return [...byFamily.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([family, faces]) => ({
        family,
        styles: [...new Set(faces.sort((a, b) => Number(a.italic) - Number(b.italic) || a.weight - b.weight).map((f) => f.style))],
      }));
  }

  /** Called after a font is bound or missing: each live Engine drains its events and draws. */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Resolves when no request is in flight (tests, thumbnails). */
  settled(): Promise<void> {
    return this.pending === 0 ? Promise.resolve() : new Promise((resolve) => this.idle.push(resolve));
  }

  /** Answers the engine's REQUEST_FONT. */
  request(family: string, style: string): void {
    const x = this.exports;
    if (!x) return;
    const key = `${family}\n${norm(style)}`;
    if (this.asked.has(key)) return;
    this.asked.add(key);
    this.styles.set(key, style);
    this.pending++;
    void this.resolve(x, family, style)
      .catch(() => x.fontMissing(encoder.encode(family), encoder.encode(style)))
      .finally(() => {
        this.pending--;
        for (const l of this.listeners) l();
        if (this.pending === 0) for (const r of this.idle.splice(0)) r();
      });
  }

  private async resolve(x: EngineExports, family: string, style: string): Promise<void> {
    const face = matchFace(await this.list(), family, style);
    if (!face) {
      x.fontMissing(encoder.encode(family), encoder.encode(style));
      return;
    }
    const key = `${face.id}#${face.collectionIndex}`;
    let id = this.loaded.get(key);
    if (!id) {
      id = this.source.read(face).then((bytes) => x.fontAddTake(bytes, face.collectionIndex));
      this.loaded.set(key, id);
    }
    const faceId = await id;
    if (faceId < 0) throw new Error(`not a font: ${face.family} ${face.style}`);
    // The engine picks the variable font's named instance (or weight) from the style it was asked for.
    x.fontBind(encoder.encode(family), encoder.encode(style), faceId);
  }
}

export const fonts = new FontService();
