/**
 * The Brands library (docs/social.md §4.1, §3.4, round 18b): one generated file, "Brands", holding every brand of the
 * Brands panel as Figma's own library pieces — a **Brand** variable collection with a mode per brand (COLOR
 * `Color/Primary` … `Color/On primary`, a brand's other colours as `Color/‹name›`, STRING `Font/Heading` and
 * `Font/Body`), the text styles **Heading**, **Body** and **CTA** with their family bound to the font variables, and on
 * the page "Logos" a **Logo** component set with a `Brand` variant per brand holding its first logo. Applying a brand
 * to a post is then the post frame's mode for the collection and the logo instance's variant (templates.ts
 * `applyBrand`) — no values copied.
 *
 * `writeBrandLibrary` is the update itself (idempotent, everything by name; a removed brand's mode and logo go), run
 * inside a Writer; `updateBrandLibrary` reads the logos first (async: the store's pictures into the file's images) and
 * writes them as one undo step "Update brands library". Creating the file and opening it is the Brands panel's (and
 * the manager's `make_brand_library`, 18c) through `createBrandsLibrary`; publishing stays the owner's click.
 */
import type { Guid, NodeChange } from "@/engine/codec";
import { contrastRatio } from "@/ds";
import { foldName } from "@shared/studio/library";
import type { Brand } from "@shared/studio/types";
import { readSocial, withSocial, type BrandLibraryMarker, type PluginDataEntry } from "@shared/social/types";
import type { EditorController } from "../../controller";
import type { ImportedImage } from "../../images";
import { mediaPaint } from "../../model/paints";
import { createNodes } from "../../agents/mcpTools";
import { parseColor } from "../../agents/nodeSpec";
import { getStoreClient } from "@/store";
import { openFile } from "../../../files/desktop";
import { brandsRepo } from "../../studio/forms";
import type { Writer } from "../actions";

/** The collection, the logos' page and set, and their variant property [names ours, as the contract gives them]. */
export const BRAND_COLLECTION = "Brand";
export const LOGO_PAGE = "Logos";
export const LOGO_SET = "Logo";
export const BRAND_PROPERTY = "Brand";
export const FONT_HEADING = "Font/Heading";
export const FONT_BODY = "Font/Body";

/** The named colour variables, in the order a brand's unnamed colours fill them. */
export const COLOR_SLOTS = ["Primary", "Secondary", "Accent", "Background", "Text"] as const;
export const ON_PRIMARY = "On primary";

/** What a slot takes when the brand has no colour for it [ours]. */
const COLOR_FALLBACK: Record<(typeof COLOR_SLOTS)[number], string | null> = { Primary: "#1E1E1E", Secondary: null, Accent: null, Background: "#FFFFFF", Text: "#1E1E1E" };
const WHITE = "#FFFFFF";
const NEAR_BLACK = "#1E1E1E";

/** The text styles, for 1080-wide posts [sizes ours]: size, line height (%), weight's style name, font variable. */
export const TEXT_STYLES = [
  { name: "Heading", fontSize: 64, lineHeight: 110, style: "Bold", font: FONT_HEADING },
  { name: "Body", fontSize: 32, lineHeight: 135, style: "Regular", font: FONT_BODY },
  { name: "CTA", fontSize: 36, lineHeight: 120, style: "Semi Bold", font: FONT_HEADING },
] as const;

/** A logo's long side in the Logo set, and the gap between variants (Figma's combine leaves 20 around them). */
const LOGO_SIDE = 400;
const SET_PAD = 20;
const VARIANT_GAP = 40;

/**
 * "#1BA37A" for each colour variable (by its name under Color/) of one brand: the named slots matched by name (case and
 * accents folded, as BrandsRepository.find folds), the others filled by the remaining colours in list order, a brand's
 * colours left over after that as their own names; a slot still empty takes its fallback (Secondary and Accent: Primary).
 */
export function brandColors(brand: Pick<Brand, "colors">): Record<string, string> {
  const left = brand.colors.filter((c) => !!parseColor(c.hex)).map((c) => ({ name: c.name.trim(), hex: c.hex.toUpperCase() }));
  const out: Record<string, string> = {};
  for (const slot of COLOR_SLOTS) {
    const i = left.findIndex((c) => foldName(c.name) === foldName(slot));
    if (i >= 0) out[slot] = left.splice(i, 1)[0].hex;
  }
  for (const slot of COLOR_SLOTS) if (!out[slot] && left.length) out[slot] = left.shift()!.hex;
  for (const slot of COLOR_SLOTS) out[slot] ??= COLOR_FALLBACK[slot] ?? out.Primary;
  out[ON_PRIMARY] = onPrimary(out.Primary);
  left.forEach((c, i) => (out[c.name || `Color ${COLOR_SLOTS.length + i + 1}`] = c.hex));
  return out;
}

/** White or near-black, whichever contrasts more with `primary` (WCAG ratio). */
export function onPrimary(primary: string): string {
  const p = parseColor(primary);
  if (!p) return WHITE;
  const ratio = (hex: string) => contrastRatio(parseColor(hex)!, { ...p, a: 1 });
  return ratio(WHITE) >= ratio(NEAR_BLACK) ? WHITE : NEAR_BLACK;
}

/** The heading and body families of a brand (Inter when it has none). */
export const brandFonts = (brand: Pick<Brand, "fonts">): { heading: string; body: string } => {
  const fonts = brand.fonts.map((f) => f.trim()).filter(Boolean);
  return { heading: fonts[0] ?? "Inter", body: fonts[1] ?? fonts[0] ?? "Inter" };
};

// ── The marker (§3.4) ────────────────────────────────────────────────────────────────────────────────────────────

const DOCUMENT: Guid = "0:0";

/** The file's Brands library marker, or null when it isn't one. */
export function readBrandLibrary(ed: EditorController): BrandLibraryMarker | null {
  if (ed.engine.destroyed) return null;
  const n = ed.engine.readNode(DOCUMENT, { fields: ["pluginData"] }) as (NodeChange & { pluginData?: PluginDataEntry[] }) | null;
  const m = readSocial<BrandLibraryMarker>(n?.pluginData, "brandLibrary");
  return m && typeof m === "object" && m.generatedFrom && typeof m.generatedFrom === "object" ? m : null;
}

/** The brands changed since the library was generated: new or edited ones, and those it holds that are gone. */
export function changedBrands(marker: BrandLibraryMarker | null, brands: readonly Pick<Brand, "id" | "updated">[]): number {
  const from = marker?.generatedFrom ?? {};
  const now = new Set(brands.map((b) => b.id));
  return brands.filter((b) => from[b.id] !== b.updated).length + Object.keys(from).filter((id) => !now.has(id)).length;
}

/** Is this file the Brands library: its marker, or a brand's `libraryFileKey` (a new file, before its first update)? */
export function isBrandsLibrary(ed: EditorController, brands: readonly Pick<Brand, "libraryFileKey">[] | null): boolean {
  if (readBrandLibrary(ed)) return true;
  const keys = [ed.source.libraries?.fileKey, ed.source.libraries?.libraryKey].filter(Boolean);
  return !!keys.length && !!brands?.some((b) => !!b.libraryFileKey && keys.includes(b.libraryFileKey));
}

// ── The update (§4.1 step 3) ─────────────────────────────────────────────────────────────────────────────────────

/** A brand's logo for the Logo set: the picture imported into this file, or null (an empty variant). */
export type BrandLogos = ReadonlyMap<string, ImportedImage | null>;

export interface BrandLibraryReport {
  collection: Guid;
  /** brandId → its mode */
  modes: Record<string, Guid>;
  logoSet: Guid | null;
  styles: Guid[];
}

/** Runs an engine command; a refusal throws (the update stops; its Writer takes back what it did). */
function run(ed: EditorController, name: string, args?: Record<string, unknown>): { created: Guid[] } {
  const r = ed.engine.runCommand(name as never, args as never);
  if (r.status !== 0) throw new Error(`${name} was refused by the engine (status ${r.status})`);
  return r;
}

const collectionNamed = (ed: EditorController, name: string) => ed.engine.variableCollections({}).find((c) => c.name === name && !c.remote) ?? null;

/** The Brand collection with one mode per brand, named as the brand (a removed brand's mode deleted). */
function ensureModes(ed: EditorController, brands: readonly Brand[]): { collection: Guid; modes: Record<string, Guid> } {
  let c = collectionNamed(ed, BRAND_COLLECTION);
  if (!c) {
    run(ed, "CREATE_VARIABLE_COLLECTION", { name: BRAND_COLLECTION });
    c = collectionNamed(ed, BRAND_COLLECTION)!;
  }
  const id = c.id;
  const names = new Set(brands.map((b) => b.name));
  const modes: Record<string, Guid> = {};
  for (const b of brands) {
    const fresh = collectionNamed(ed, BRAND_COLLECTION)!;
    const have = fresh.modes.find((m) => m.name === b.name);
    if (have) {
      modes[b.id] = have.modeId;
      continue;
    }
    // A new collection's "Mode 1" (or a removed brand's mode) becomes the brand's before a mode is added.
    const free = fresh.modes.find((m) => !names.has(m.name) && !Object.values(modes).includes(m.modeId));
    if (free) {
      run(ed, "RENAME_VARIABLE_MODE", { collection: id, mode: free.modeId, name: b.name });
      modes[b.id] = free.modeId;
    } else modes[b.id] = run(ed, "ADD_VARIABLE_MODE", { collection: id, name: b.name }).created[0];
  }
  const kept = new Set(Object.values(modes));
  for (const m of collectionNamed(ed, BRAND_COLLECTION)!.modes) if (!kept.has(m.modeId) && kept.size) run(ed, "DELETE_VARIABLE_MODE", { collection: id, mode: m.modeId });
  // The first brand's mode is the default (the collection's first).
  const first = brands[0] ? modes[brands[0].id] : null;
  if (first && collectionNamed(ed, BRAND_COLLECTION)!.modes[0]?.modeId !== first) run(ed, "MOVE_VARIABLE_MODE", { collection: id, mode: first, index: 0 });
  return { collection: id, modes };
}

/** The collection's variable named `name` of `type`, created when it isn't there. */
function ensureVariable(ed: EditorController, collection: Guid, name: string, type: "COLOR" | "STRING"): Guid {
  const c = ed.engine.variableCollections({}).find((x) => x.id === collection)!;
  const have = c.variableIds.find((v) => ed.engine.variable(v)?.name === name);
  if (have) return have;
  return run(ed, "CREATE_VARIABLE", { collection, type, name }).created[0];
}

/** The local text style named `name`, created when it isn't there. */
function ensureTextStyle(ed: EditorController, name: string): Guid {
  const have = ed.engine.styles("TEXT" as never, { includeRemote: false }).find((s) => s.name === name);
  return have ? have.id : run(ed, "CREATE_STYLE", { type: "TEXT", name }).created[0];
}

/** A page by name, made (at the end) when the file has none. */
function ensurePage(ed: EditorController, name: string): Guid {
  const have = ed.engine.pages().find((p) => p.name === name);
  if (have) return have.guid;
  const before = new Set(ed.engine.pages().map((p) => p.guid));
  run(ed, "CREATE_PAGE");
  const made = ed.engine.pages().find((p) => !before.has(p.guid))!.guid;
  ed.engine.setProps([made], { name });
  return made;
}

/** A logo variant's size: the picture's aspect, LOGO_SIDE on its long side (square without one). */
function logoSize(img: ImportedImage | null | undefined): { x: number; y: number } {
  if (!img || !img.width || !img.height) return { x: LOGO_SIDE, y: LOGO_SIDE };
  const k = LOGO_SIDE / Math.max(img.width, img.height);
  return { x: Math.max(1, Math.round(img.width * k)), y: Math.max(1, Math.round(img.height * k)) };
}

const variantValue = (name: string | undefined, property: string): string | null => {
  for (const pair of (name ?? "").split(",")) {
    const [k, v] = pair.split("=").map((s) => s.trim());
    if (k === property && v !== undefined) return v;
  }
  return null;
};

/**
 * The Logo set on the page "Logos": a `Brand` variant per brand (its value the brand's name) holding the brand's
 * logo as an IMAGE fill, laid out in a row; a removed brand's variant deleted. The current page and the selection
 * are put back after (the component commands work on the selection).
 */
function ensureLogoSet(ed: EditorController, brands: readonly Brand[], logos: BrandLogos): Guid | null {
  const back = { page: ed.store.page, selection: [...ed.engine.getSelection().refs] };
  const page = ensurePage(ed, LOGO_PAGE);
  ed.engine.setCurrentPage(page);
  try {
    const kids = (ed.engine.readNode(page, { childIds: true })?.childIds ?? []) as Guid[];
    let set = kids.find((id) => ed.engine.readNode(id, { fields: ["name"] })?.name === LOGO_SET && ed.engine.componentInfo(id)?.kind === "COMPONENT_SET") ?? null;
    if (!brands.length) {
      if (set) {
        ed.engine.setSelection([set]);
        ed.engine.command("DELETE");
      }
      return null;
    }
    const env = { ed, write: <T,>(_label: string, fn: () => T): T => fn() };
    if (!set) {
      // One frame per brand, made components together and combined (Figma's Create multiple components, Combine as variants).
      const frames = brands.map((b, i) => createNodes(env, { parentId: page, nodes: [{ type: "FRAME", name: b.name, x: i * (LOGO_SIDE + VARIANT_GAP), y: 0, width: LOGO_SIDE, height: LOGO_SIDE, fills: [] }] }).touched![0]);
      ed.engine.setSelection(frames);
      run(ed, "CREATE_COMPONENT", { mode: frames.length > 1 ? "MULTIPLE" : "SINGLE" });
      run(ed, "COMBINE_AS_VARIANTS");
      set = ed.engine.getSelection().refs[0];
      ed.engine.setProps([set], { name: LOGO_SET });
      const prop = ed.engine.componentInfo(set)?.properties.find((p) => p.type === "VARIANT");
      if (prop && prop.name !== BRAND_PROPERTY) run(ed, "EDIT_COMPONENT_PROPERTY", { ref: set, prop: prop.id, name: BRAND_PROPERTY });
    }
    const prop = () => ed.engine.componentInfo(set!)?.properties.find((p) => p.type === "VARIANT");
    const variants = () => ((ed.engine.readNode(set!, { childIds: true })?.childIds ?? []) as Guid[]).map((id) => ({ id, value: variantValue(ed.engine.readNode(id, { fields: ["name"] })?.name, BRAND_PROPERTY) }));
    const names = new Set(brands.map((b) => b.name));
    // A variant per brand: a new one from the last (Figma's Add variant), its value renamed to the brand's name.
    for (const b of brands) {
      if (variants().some((v) => v.value === b.name)) continue;
      const last = variants()[variants().length - 1];
      ed.engine.setSelection([last.id]);
      run(ed, "ADD_VARIANT");
      const made = ed.engine.getSelection().refs[0];
      const value = variantValue(ed.engine.readNode(made, { fields: ["name"] })?.name, BRAND_PROPERTY);
      const p = prop();
      if (p && value !== null) run(ed, "EDIT_COMPONENT_PROPERTY", { ref: set, prop: p.id, oldValue: value, newValue: b.name });
      else ed.engine.setProps([made], { name: `${BRAND_PROPERTY}=${b.name}` });
    }
    // A removed brand's variant goes.
    const gone = variants().filter((v) => v.value === null || !names.has(v.value)).map((v) => v.id);
    if (gone.length && gone.length < variants().length) {
      ed.engine.setSelection(gone);
      ed.engine.command("DELETE");
    }
    // Each variant: the brand's logo at its aspect, in brand order along a row; the set hugging them.
    let x = SET_PAD;
    let tallest = 0;
    for (const b of brands) {
      const v = variants().find((x) => x.value === b.name);
      if (!v) continue;
      const img = logos.get(b.id) ?? null;
      const size = logoSize(img);
      const t = ed.engine.readNode(v.id, { fields: ["transform"] })?.transform;
      ed.engine.setProps([v.id], { size, transform: { ...(t ?? { m00: 1, m01: 0, m10: 0, m11: 1 }), m02: x, m12: SET_PAD }, fillPaints: img ? [{ ...mediaPaint(img), imageScaleMode: "FILL" }] : [] } as never);
      x += size.x + VARIANT_GAP;
      tallest = Math.max(tallest, size.y);
    }
    ed.engine.setProps([set], { size: { x: x - VARIANT_GAP + SET_PAD, y: tallest + 2 * SET_PAD } });
    return set;
  } finally {
    if (back.page && back.page !== ed.store.page) ed.engine.setCurrentPage(back.page);
    ed.engine.setSelection(back.selection.filter((id) => !!ed.engine.readNode(id, { fields: ["type"] })));
  }
}

/**
 * The update (§4.1 step 3), inside a Writer: the Brand collection and its variables, the text styles, the Logo set
 * and the marker, from `brands` (in their order: the first brand's mode is the default). Idempotent: a second run
 * with the same brands changes nothing it made; everything is found by name.
 */
export function writeBrandLibrary(ed: EditorController, brands: readonly Brand[], logos: BrandLogos = new Map()): BrandLibraryReport {
  const { collection, modes } = ensureModes(ed, brands);
  const colors = new Map(brands.map((b) => [b.id, brandColors(b)]));
  // Every colour name any brand has; a brand without one takes its Primary.
  const colorNames = [...COLOR_SLOTS, ON_PRIMARY, ...new Set(brands.flatMap((b) => Object.keys(colors.get(b.id)!).filter((k) => !(COLOR_SLOTS as readonly string[]).includes(k) && k !== ON_PRIMARY)))];
  for (const name of colorNames) {
    const v = ensureVariable(ed, collection, `Color/${name}`, "COLOR");
    for (const b of brands) {
      const c = colors.get(b.id)!;
      const color = parseColor(c[name] ?? c.Primary);
      if (color) run(ed, "SET_VARIABLE_VALUE", { variable: v, mode: modes[b.id], value: color });
    }
  }
  const fonts = new Map(brands.map((b) => [b.id, brandFonts(b)]));
  const fontVars: Record<string, Guid> = {};
  for (const [name, pick] of [[FONT_HEADING, "heading"], [FONT_BODY, "body"]] as const) {
    fontVars[name] = ensureVariable(ed, collection, name, "STRING");
    for (const b of brands) run(ed, "SET_VARIABLE_VALUE", { variable: fontVars[name], mode: modes[b.id], value: fonts.get(b.id)![pick] });
  }
  // The text styles take the default mode's families; their family bound to the font variable where the engine binds it.
  const first = brands[0] ? fonts.get(brands[0].id)! : { heading: "Inter", body: "Inter" };
  const styleIds = TEXT_STYLES.map((s) => {
    const id = ensureTextStyle(ed, s.name);
    const family = s.font === FONT_HEADING ? first.heading : first.body;
    ed.engine.setProps([id], { fontSize: s.fontSize, lineHeight: { value: s.lineHeight, units: "PERCENT" }, fontName: { family, style: s.style, postscript: "" } } as never);
    ed.engine.runCommand("BIND_VARIABLE" as never, { refs: [id], target: "FONT_FAMILY", variable: fontVars[s.font] } as never);
    return id;
  });
  const logoSet = ensureLogoSet(ed, brands, logos);
  const n = ed.engine.readNode(DOCUMENT, { fields: ["pluginData"] }) as (NodeChange & { pluginData?: PluginDataEntry[] }) | null;
  const marker: BrandLibraryMarker = { v: 1, generatedFrom: Object.fromEntries(brands.map((b) => [b.id, b.updated])) };
  ed.engine.setProps([DOCUMENT], { pluginData: withSocial(n?.pluginData, "brandLibrary", marker) } as never);
  return { collection, modes, logoSet, styles: styleIds };
}

/** Each brand's first logo picture, imported into this file's images (null where a brand has none or it fails). */
export async function importLogos(ed: EditorController, brands: readonly Brand[]): Promise<Map<string, ImportedImage | null>> {
  const out = new Map<string, ImportedImage | null>();
  for (const b of brands) {
    const logo = b.logos.find((i) => i.role === "logo");
    if (!logo || !ed.images.store) {
      out.set(b.id, null);
      continue;
    }
    try {
      const { data, mime } = await brandsRepo().image(b.id, logo.id);
      const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
      const [img] = await ed.images.import([new File([bytes as BlobPart], `${logo.name || b.name}.${mime.split("/")[1]}`, { type: mime })]);
      out.set(b.id, img ?? null);
    } catch {
      out.set(b.id, null);
    }
  }
  return out;
}

/** Update (the banner's button, `make_brand_library`): the logos read, then the whole update as one undo step. */
export async function updateBrandLibrary(ed: EditorController, w: Writer, brands: readonly Brand[]): Promise<BrandLibraryReport> {
  const logos = await importLogos(ed, brands);
  return w("Update brands library", () => writeBrandLibrary(ed, brands, logos));
}

// ── The file (§4.1 steps 1–2) ────────────────────────────────────────────────────────────────────────────────────

/** What creating and opening the library needs from the store and the shell (tests replace them). */
export interface BrandsLibraryDeps {
  createFile(input: { name: string; folderId: string | null }): Promise<{ fileKey: string; name: string }>;
  listFolders(): Promise<{ id: string; trashedAt?: number | null; parentId?: string | null }[]>;
  saveBrand(b: { id: string; name: string; libraryFileKey: string }): Promise<unknown>;
  open(fileKey: string, title: string): Promise<void>;
}

/**
 * Create brands library (the Brands panel, no brand has a library yet) or Update brands library (one has): a new
 * file "Brands" — in the workspace's first folder [ours: a file in Drafts can't be published, data.md §9; Drafts
 * when there is no folder] — every brand pointed at it, then the file brought in front, where the banner runs the
 * update; an existing library is only opened. Returns its key.
 */
export async function createBrandsLibrary(brands: readonly Brand[], deps: BrandsLibraryDeps): Promise<string> {
  const existing = brands.find((b) => b.libraryFileKey)?.libraryFileKey ?? null;
  if (existing) {
    await deps.open(existing, "Brands");
    return existing;
  }
  const folder = (await deps.listFolders().catch(() => [])).find((f) => !f.trashedAt) ?? null;
  const meta = await deps.createFile({ name: "Brands", folderId: folder?.id ?? null });
  for (const b of brands) await deps.saveBrand({ id: b.id, name: b.name, libraryFileKey: meta.fileKey });
  await deps.open(meta.fileKey, meta.name);
  return meta.fileKey;
}

/** The store's workspace and the shell's tabs, as Create brands library uses them. */
export function storeBrandsLibraryDeps(): BrandsLibraryDeps {
  const store = getStoreClient();
  return {
    createFile: (i) => store.workspace.createFile(i),
    listFolders: () => store.workspace.listFolders(),
    saveBrand: (b) => brandsRepo().saveBrand(b),
    open: (fileKey, title) => openFile(fileKey, { title }, { workspace: store.workspace }),
  };
}

/**
 * The manager's make_brand_library (docs/social.md §7.2): in the Brands library itself, its update (one step through
 * `w`); elsewhere the library made (or the existing one opened) — its banner runs the update there. Publishing stays
 * the owner's. Returns its file and the brands it holds.
 */
export async function makeBrandLibrary(ed: EditorController, w: Writer, deps?: BrandsLibraryDeps): Promise<{ fileKey: string; brands: string[] }> {
  const brands = await brandsRepo().list();
  if (!brands.length) throw new Error("No brands yet: save a brand first (library_save_brand).");
  const names = brands.map((b) => b.name);
  if (isBrandsLibrary(ed, brands)) {
    await updateBrandLibrary(ed, w, brands);
    return { fileKey: ed.source.libraries?.fileKey ?? brands.find((b) => b.libraryFileKey)?.libraryFileKey ?? "", brands: names };
  }
  return { fileKey: await createBrandsLibrary(brands, deps ?? storeBrandsLibraryDeps()), brands: names };
}
