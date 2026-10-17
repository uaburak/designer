/**
 * Fonts for the engine (docs/engine.md §7.1, docs/desktop.md §14), once per
 * renderer process: the engine asks for a FontName {family, style}
 * (REQUEST_FONT); this finds the face — among the installed fonts (the
 * desktop's index of the system's and the user's), Figma's own Inter (bundled)
 * and the Google Fonts catalog (downloaded by main on first use) —, hands its
 * bytes to the engine (engine_font_add_take, once per file) and binds the name
 * to it (engine_font_bind), or reports it missing (engine_font_missing: the
 * text draws with Inter, the panel says "Missing fonts"). Matching: family
 * (case-insensitive), then the style name (spaces and case ignored), then the
 * PostScript name, then the nearest weight with the same slant.
 *
 * Precedence, as Figma's: a family installed on the computer wins over the same
 * family served by Figma (its Inter, Google Fonts); Figma's Inter wins over
 * Google's (docs/research/figma/R11-fonts.md). Organization and team fonts
 * (docs/desktop.md §14.3) come only in a file of that organization or team
 * (`setScope`): installed > team > organization > Figma's Inter > Google. In the web app (no desktop) the Google
 * catalog and the shared fonts come from the page's server instead of main (webFonts.ts).
 */
import interUrl from "./fonts/Inter-3.19.ttf?url";
import type { EngineExports } from "./EngineExports";
import { webFontSource } from "./webFonts";

/** Where a face comes from: Figma's own (bundled), installed on the computer, Google Fonts, or the organization / team (shared). */
export type FontFaceSource = "bundled" | "system" | "user" | "google" | "shared";

/** One face of a font file (the desktop's FontIndex entries, the bundled Inter's, the Google catalog's styles). */
export interface FontFaceInfo {
  /** Stable id: the desktop's index id, "bundled:…", or a Google face id ("g:…") */
  id: string;
  family: string;
  /** Typographic subfamily, e.g. "Semi Bold Italic" */
  style: string;
  postscriptName?: string;
  weight: number;
  italic: boolean;
  source: FontFaceSource;
  collectionIndex: number;
  /** A variable font (its styles are named instances) */
  variable?: boolean;
  /** Google Fonts: the family's category ("Sans Serif" …) and popularity rank */
  category?: string;
  popularity?: number;
  /** Shared fonts: the organization, and the team (null: an organization font) */
  orgId?: string;
  teamId?: string | null;
}

/** The open file's organization and team (docs/desktop.md §14.3): which shared fonts it sees; null — a local file. */
export interface FontScope {
  orgId: string;
  teamId: string | null;
  /** For the picker's "Used at ‹organization›" (null until known) */
  orgName: string | null;
}

/** Where faces come from. `read` returns the whole file the face is in. */
export interface FontSource {
  /** Every face the file may use: `scope` picks the shared fonts (none without one) */
  list(scope?: FontScope | null): Promise<FontFaceInfo[]>;
  read(face: FontFaceInfo): Promise<Uint8Array>;
}

const INTER_STYLES: [string, number][] = [
  ["Thin", 100], ["Extra Light", 200], ["Light", 300], ["Regular", 400], ["Medium", 500],
  ["Semi Bold", 600], ["Bold", 700], ["Extra Bold", 800], ["Black", 900],
];

/**
 * Inter, as Figma serves it: Inter 3.19's variable font (rsms/inter v3.19 "Inter Variable/Inter.ttf", SHA-1
 * d483e2c7…, the digest Figma stores for every Inter text — not Google Fonts' Inter), nine weights upright and
 * italic, all named instances of the one file.
 */
export const BUNDLED_FACES: FontFaceInfo[] = INTER_STYLES.flatMap(([style, weight]) => [
  { id: "bundled:inter", family: "Inter", style, weight, italic: false, source: "bundled" as const, collectionIndex: 0, variable: true },
  {
    id: "bundled:inter",
    family: "Inter",
    style: style === "Regular" ? "Italic" : `${style} Italic`,
    weight,
    italic: true,
    source: "bundled" as const,
    collectionIndex: 0,
    variable: true,
  },
]);

/** The bundled files by face id (tools that load fonts themselves read them from here). */
export const BUNDLED_URLS: Record<string, string> = { "bundled:inter": interUrl };

/**
 * Families tried for characters a text's own font lacks: Figma's built-in Noto Sans set (Atlas 06 §10; free, OFL,
 * each downloaded from Google Fonts the first time a text needs it, nothing bundled). The engine tries a script's
 * own family first (text/Fonts.cpp scriptFallback: Noto Sans Thai for Thai), then the others in this order without
 * the other scripts' families. The Mac's own families after them keep text readable offline (not Figma's: whether
 * its fallback takes local fonts is an open question, §15 Q4); absent ones are skipped.
 */
export const FALLBACK_FAMILIES = [
  "Noto Sans", "Noto Sans Symbols", "Noto Sans Symbols 2", "Noto Sans Math",
  "Noto Sans Arabic", "Noto Sans Bengali", "Noto Sans Devanagari", "Noto Sans Georgian", "Noto Sans Gujarati", "Noto Sans HK",
  "Noto Sans JP", "Noto Sans Javanese", "Noto Sans KR", "Noto Sans Kannada", "Noto Sans Khmer", "Noto Sans Lao",
  "Noto Sans Malayalam", "Noto Sans New Tai Lue", "Noto Sans SC", "Noto Sans TC", "Noto Sans Tai Le", "Noto Sans Tai Tham",
  "Noto Sans Tai Viet", "Noto Sans Tamil", "Noto Sans Telugu", "Noto Sans Thai",
  "PingFang SC", "Hiragino Sans", "Apple SD Gothic Neo", "Geeza Pro", "Arial Hebrew", "Thonburi", "Kohinoor Devanagari",
  "Arial Unicode MS", "Apple Symbols",
];

/** A Google Fonts family as the desktop's index lists it (src/shared/ipc.ts GoogleFontFamily). */
export interface GoogleFamilyEntry {
  family: string;
  category: string;
  popularity: number;
  axes: unknown[];
  styles: { style: string; weight: number; italic: boolean; id: string }[];
}

/** A shared face as the desktop's index lists it (src/shared/fonts/sharedTypes.ts SharedFontFace, the fields used here). */
export interface SharedFaceEntry {
  id: string;
  family: string;
  style: string;
  postscriptName?: string;
  weight: number;
  italic: boolean;
  variable?: boolean;
  orgId: string;
  teamId: string | null;
}

interface DesktopFonts {
  list(): Promise<{ faces: FontFaceInfo[]; google?: GoogleFamilyEntry[]; shared?: SharedFaceEntry[] }>;
  read(id: string): Promise<Uint8Array | ArrayBuffer>;
  preview?(family: string, text: string): Promise<Uint8Array | ArrayBuffer>;
  onChanged?(cb: () => void): () => void;
}

export function desktopFonts(): DesktopFonts | null {
  const d = (globalThis as { designer?: { fonts?: DesktopFonts } }).designer;
  return d?.fonts ?? null;
}

/**
 * The shared faces a file in `scope` sees (docs/desktop.md §14.3): its organization's fonts, and its team's; a local
 * file (no scope) none. As FontFaceInfo with "s:" ids (what `fonts:read` downloads).
 */
export function sharedForScope(shared: readonly SharedFaceEntry[], scope: FontScope | null | undefined): FontFaceInfo[] {
  if (!scope) return [];
  return shared
    .filter((f) => f.orgId === scope.orgId && (f.teamId === null || (scope.teamId !== null && f.teamId === scope.teamId)))
    .map((f) => ({
      id: `s:${f.id}`,
      family: f.family,
      style: f.style,
      ...(f.postscriptName ? { postscriptName: f.postscriptName } : {}),
      weight: f.weight,
      italic: f.italic,
      source: "shared" as const,
      collectionIndex: 0,
      ...(f.variable ? { variable: true } : {}),
      orgId: f.orgId,
      teamId: f.teamId,
    }));
}

/**
 * Every face, by precedence (whole families: a family comes from one place): the installed fonts, the team's fonts,
 * the organization's, Figma's Inter, the Google families none of them has. `shared`: the file's (sharedForScope).
 */
export function mergeFaces(local: readonly FontFaceInfo[], google: readonly GoogleFamilyEntry[] = [], shared: readonly FontFaceInfo[] = []): FontFaceInfo[] {
  const have = new Set(local.map((f) => f.family.toLowerCase()));
  const out = [...local];
  // The team's fonts before the organization's (§14.3's order), each family whole.
  for (const level of [shared.filter((f) => !!f.teamId), shared.filter((f) => !f.teamId)]) {
    const added = new Set<string>();
    for (const f of level) {
      const fam = f.family.toLowerCase();
      if (have.has(fam)) continue;
      out.push(f);
      added.add(fam);
    }
    for (const fam of added) have.add(fam);
  }
  if (!have.has("inter")) out.push(...BUNDLED_FACES);
  for (const f of BUNDLED_FACES) have.add(f.family.toLowerCase());
  for (const g of google) {
    if (have.has(g.family.toLowerCase())) continue;
    const variable = g.axes.length > 0;
    for (const s of g.styles)
      out.push({ id: s.id, family: g.family, style: s.style, weight: s.weight, italic: s.italic, source: "google", collectionIndex: 0, variable, category: g.category, popularity: g.popularity });
  }
  return out;
}

/** Figma's Inter, plus the desktop's fonts, the Google catalog and the file's shared fonts when there is a desktop. */
export const defaultFontSource: FontSource = {
  async list(scope) {
    const desktop = desktopFonts();
    if (!desktop) {
      // The web app: Google Fonts and the signed-in person's shared fonts (webFonts.ts); else Figma's Inter alone.
      const web = webFontSource();
      if (!web) return [...BUNDLED_FACES];
      try {
        return await web.list(scope);
      } catch {
        return [...BUNDLED_FACES];
      }
    }
    try {
      const index = await desktop.list();
      return mergeFaces(index.faces, index.google ?? [], sharedForScope(index.shared ?? [], scope));
    } catch {
      return [...BUNDLED_FACES];
    }
  },
  async read(face) {
    const url = BUNDLED_URLS[face.id];
    if (url) return new Uint8Array(await (await fetch(url)).arrayBuffer());
    const desktop = desktopFonts();
    if (!desktop) {
      const web = webFontSource();
      if (!web) throw new Error(`no font ${face.family} ${face.style}`);
      return web.read(face);
    }
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

/** A family as the font pickers list it: its styles in the font's order (by weight, each upright before its italic). */
export interface FontFamily {
  family: string;
  styles: string[];
  faces: FontFaceInfo[];
  /** Where the family comes from (the picker's filters): installed on the computer, Figma's own, Google Fonts, the organization / team */
  source: "local" | "bundled" | "google" | "shared";
  /** Some face is a variable font */
  variable: boolean;
  /** Google Fonts: category and popularity rank */
  category?: string;
  popularity?: number;
}

/** Figma's family order (Atlas 06 §6.3): names starting with punctuation last, then by name (case-insensitive). */
export function compareFamilyNames(a: string, b: string): number {
  const punct = (s: string) => (/^[\p{P}\p{S}]/u.test(s) ? 1 : 0);
  return punct(a) - punct(b) || a.localeCompare(b, undefined, { sensitivity: "base" });
}

/** Groups faces into families (compareFamilyNames' order) with their styles ordered by weight, upright first. */
export function groupFamilies(faces: readonly FontFaceInfo[]): FontFamily[] {
  const byFamily = new Map<string, FontFaceInfo[]>();
  for (const f of faces) {
    const list = byFamily.get(f.family) ?? [];
    list.push(f);
    byFamily.set(f.family, list);
  }
  return [...byFamily.entries()]
    .sort((a, b) => compareFamilyNames(a[0], b[0]))
    .map(([family, list]) => {
      const sorted = [...list].sort((a, b) => a.weight - b.weight || Number(a.italic) - Number(b.italic));
      const first = sorted[0];
      const source = first.source === "google" ? "google" : first.source === "bundled" ? "bundled" : first.source === "shared" ? "shared" : "local";
      return {
        family,
        styles: [...new Set(sorted.map((f) => f.style))],
        faces: sorted,
        source,
        variable: sorted.some((f) => f.variable),
        ...(first.category !== undefined ? { category: first.category } : {}),
        ...(first.popularity !== undefined ? { popularity: first.popularity } : {}),
      } satisfies FontFamily;
    });
}

/**
 * The style to keep when the family changes to one with `styles`: the same name if it has it, else the nearest
 * weight with the same slant (Figma keeps "Bold" on Bold, "Semi Bold" → "SemiBold"), else its first.
 */
export function closestStyle(styles: readonly string[], style: string): string {
  if (!styles.length) return style;
  const s = norm(style);
  const same = styles.find((x) => norm(x) === s);
  if (same) return same;
  const want = styleWeight(style);
  let best = styles[0];
  let bestScore = Infinity;
  for (const x of styles) {
    const w = styleWeight(x);
    const score = Math.abs(w.weight - want.weight) + (w.italic === want.italic ? 0 : 1000);
    if (score < bestScore) {
      bestScore = score;
      best = x;
    }
  }
  return best;
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
  /** Told when the list of faces changes (`refresh`): the font pickers read it again. */
  private readonly listListeners = new Set<() => void>();
  private familyList: Promise<FontFamily[]> | null = null;
  private pending = 0;
  private idle: (() => void)[] = [];
  /** Names already answered or on their way (the engine asks once per module; attach() asks ahead of it). */
  private readonly asked = new Set<string>();
  private readonly styles = new Map<string, string>();
  /** Names the engine was told are missing (family + "\n" + style), for the "Missing fonts" UI. */
  private readonly missingNames = new Map<string, { family: string; style: string }>();
  private readonly missingListeners = new Set<() => void>();
  private watching = false;
  private fileScope: FontScope | null = null;

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
    // Another source: every name is answered again from it.
    this.loaded.clear();
    for (const key of this.asked) if (!this.missingNames.has(key)) this.missingNames.set(key, { family: key.split("\n")[0], style: this.styles.get(key) ?? "" });
    this.refresh();
  }

  /**
   * The fonts changed (the desktop's `fonts:changed`, a new source): the index is read again and the names asked
   * for so far are answered again (a font that was missing may be there now).
   */
  refresh(): void {
    this.faces = null;
    this.familyList = null;
    // Faces already in the engine stay (a file isn't read twice); the missing names are asked again.
    const names = [...this.missingNames.keys()];
    this.missingNames.clear();
    for (const key of names) {
      this.asked.delete(key);
      const [family, style] = key.split("\n");
      this.request(family, this.styles.get(key) ?? style);
    }
    for (const l of this.listListeners) l();
    for (const l of this.missingListeners) l();
  }

  /**
   * The open file's organization and team (docs/desktop.md §14.3): the shared fonts it sees. One file per editor
   * process — a spare editor adopted for a file sets it then. Another org or team reads the list again; the name
   * alone (known later) only tells the pickers.
   */
  setScope(scope: FontScope | null): void {
    const before = this.fileScope;
    this.fileScope = scope ? { ...scope } : null;
    if (before?.orgId === scope?.orgId && before?.teamId === scope?.teamId) {
      if (before?.orgName !== scope?.orgName) for (const l of this.listListeners) l();
      return;
    }
    this.refresh();
  }

  /** The open file's scope (null: a local file, which sees no shared fonts). */
  scope(): FontScope | null {
    return this.fileScope;
  }

  /** The names reported missing so far (fonts not installed, not served, or not downloadable now). */
  missing(): { family: string; style: string }[] {
    return [...this.missingNames.values()];
  }

  /** Called when the missing names change. */
  onMissingChange(listener: () => void): () => void {
    this.missingListeners.add(listener);
    return () => this.missingListeners.delete(listener);
  }

  private markMissing(x: EngineExports, family: string, style: string): void {
    x.fontMissing(encoder.encode(family), encoder.encode(style));
    this.missingNames.set(`${family}\n${norm(style)}`, { family, style });
    for (const l of this.missingListeners) l();
  }

  /** Called when the list of faces changed (fonts installed or removed, a new source). */
  onListChange(listener: () => void): () => void {
    this.listListeners.add(listener);
    return () => this.listListeners.delete(listener);
  }

  /** Every face known (bundled + desktop), for the font pickers. */
  list(): Promise<FontFaceInfo[]> {
    if (!this.watching && this.source === defaultFontSource) {
      // The desktop says when fonts are installed or removed (main watches the font folders); the web app when the
      // Google catalog arrives or the shared fonts change.
      this.watching = true;
      (desktopFonts() ?? webFontSource())?.onChanged?.(() => this.refresh());
    }
    this.faces ??= this.source.list(this.fileScope).catch(() => BUNDLED_FACES);
    return this.faces;
  }

  /** The families with their styles, sorted by name (what a font picker shows); computed once per list. */
  families(): Promise<FontFamily[]> {
    this.familyList ??= this.list().then(groupFamilies);
    return this.familyList;
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
      .catch(() => this.markMissing(x, family, style))
      .finally(() => {
        this.pending--;
        for (const l of this.listeners) l();
        if (this.pending === 0) for (const r of this.idle.splice(0)) r();
      });
  }

  private async resolve(x: EngineExports, family: string, style: string): Promise<void> {
    const face = matchFace(await this.list(), family, style);
    if (!face) {
      this.markMissing(x, family, style);
      return;
    }
    const key = `${face.id}#${face.collectionIndex}`;
    let id = this.loaded.get(key);
    if (!id) {
      id = this.source.read(face).then((bytes) => x.fontAddTake(bytes, face.collectionIndex));
      // A read that failed (a Google file offline) is tried again on the next ask.
      id.catch(() => this.loaded.delete(key));
      this.loaded.set(key, id);
    }
    const faceId = await id;
    if (faceId < 0) throw new Error(`not a font: ${face.family} ${face.style}`);
    // The engine picks the variable font's named instance (or weight) from the style it was asked for.
    x.fontBind(encoder.encode(family), encoder.encode(style), faceId);
  }
}

export const fonts = new FontService();
