/**
 * Templates and their slots (docs/social.md §3.3, §4.3–4.4, §6.7; round 18b): a template is a component set (or a
 * lone component) carrying `designer.social` / `template`, a `Format` variant per format; its slot layers carry
 * `designer.social` / `slot` and are wired to Figma's own mechanisms — text slots to TEXT component properties, the logo
 * to the Brands library's Logo set (its `Brand` variant), colours to the Brand collection's variables (the post's mode),
 * the picture to an IMAGE fill.
 *
 * The actions here are the one implementation behind the chrome (the gallery, the Post section, the table, Save as
 * template) and the agents' Social tools (18c): each takes a Writer and is one undo step. Those that need something
 * from outside the document first — a library template's copy, a product's picture, a brand from the store — are
 * async: they fetch, then write once. The `…Now` cores write inside a Writer that is already open.
 */
import type { Guid, NodeChange, Paint } from "@/engine/codec";
import { t } from "@/i18n";
import { keyBetween } from "@shared/schema/fractionalIndex";
import { base64Bytes, sniffImage, type ImageArg } from "@shared/agents/images";
import { formatById, PLATFORMS, resolveFormat } from "@shared/social/formats";
import { readSocial, SLOT_ROLES, withSocial, type Platform, type PluginDataEntry, type SlotRole, type SocialPostData, type SocialTemplateData, type TemplateSlotData } from "@shared/social/types";
import type { Brand } from "@shared/studio/types";
import type { LibraryAsset } from "@shared/store/types";
import type { EditorController } from "../../controller";
import type { ImportedImage } from "../../images";
import type { LibraryState } from "../../libraries";
import { ensureCopy } from "../../libraries";
import { mediaPaint } from "../../model/paints";
import { brandsRepo } from "../../studio/forms";
import { boardEnd, placePost } from "../board";
import { isSocialFile } from "../../devmode/devMode";
import { postRecord, readPost, writePost } from "../posts";
import { isAnimated, readBoard } from "../socialState";
import type { Writer } from "../actions";
import { BRAND_COLLECTION, BRAND_PROPERTY, FONT_BODY, FONT_HEADING } from "./brandLibrary";

type Row = NodeChange & { pluginData?: PluginDataEntry[]; textData?: { characters?: string }; fillPaints?: Paint[] };

/** The variant property every template has (one value per format). */
export const FORMAT_PROPERTY = "Format";
/** The text roles (TEXT component properties) and their properties' names. */
export const TEXT_ROLES: readonly SlotRole[] = ["headline", "body", "cta", "label"];
export const ROLE_NAMES: Record<SlotRole, string> = { logo: "Logo", picture: "Picture", headline: "Headline", body: "Body", cta: "CTA", label: "Label", accent: "Accent", background: "Background" };

const read = (ed: EditorController, id: Guid, fields: string[] = ["pluginData"]): Row | null => (ed.engine.destroyed ? null : (ed.engine.readNode(id, { fields } as never) as Row | null));
const kidsOf = (ed: EditorController, id: Guid): Guid[] => (ed.engine.readNode(id, { childIds: true })?.childIds ?? []) as Guid[];

/** Runs an engine command; a refusal throws (the action stops, its Writer takes back what it did). */
function run(ed: EditorController, name: string, args?: Record<string, unknown>): { created: Guid[] } {
  const r = ed.engine.runCommand(name as never, args as never);
  if (r.status !== 0) throw new Error(`${name} was refused by the engine (status ${r.status})`);
  return r;
}

// ── Markers (§3.3) ───────────────────────────────────────────────────────────────────────────────────────────────

/** A template marker with every field present; null when `raw` isn't one. */
export function normalizeTemplate(raw: unknown): SocialTemplateData | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const formats = r.formats && typeof r.formats === "object" && !Array.isArray(r.formats) ? Object.fromEntries(Object.entries(r.formats as Record<string, unknown>).filter((e): e is [string, string] => typeof e[1] === "string")) : {};
  if (!Object.keys(formats).length) return null;
  return {
    v: 1,
    name: typeof r.name === "string" ? r.name : "",
    formats,
    animated: r.animated === true,
    platforms: Array.isArray(r.platforms) ? (r.platforms.filter((p) => PLATFORMS.includes(p as Platform)) as Platform[]) : [],
    origin: r.origin === "starter" ? "starter" : "owner",
  };
}

/** A slot record with every field present; null when `raw` isn't one. */
export function normalizeSlot(raw: unknown): TemplateSlotData | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (!SLOT_ROLES.includes(r.role as SlotRole)) return null;
  return { v: 1, role: r.role as SlotRole, property: typeof r.property === "string" ? r.property : null, locked: r.locked === true, maxChars: typeof r.maxChars === "number" && r.maxChars > 0 ? r.maxChars : null };
}

export const templateIn = (entries: readonly PluginDataEntry[] | undefined): SocialTemplateData | null => normalizeTemplate(readSocial<unknown>(entries, "template"));
export const slotIn = (entries: readonly PluginDataEntry[] | undefined): TemplateSlotData | null => normalizeSlot(readSocial<unknown>(entries, "slot"));

export const readTemplate = (ed: EditorController, id: Guid): SocialTemplateData | null => templateIn(read(ed, id)?.pluginData);
export const readSlot = (ed: EditorController, id: Guid): TemplateSlotData | null => slotIn(read(ed, id)?.pluginData);

/** Writes a layer's plugin-data entry `key` (null removes it), the others kept. Inside a Writer. */
function writeEntry(ed: EditorController, id: Guid, key: "template" | "slot", value: unknown): void {
  const n = read(ed, id);
  if (n) ed.engine.setProps([id], { pluginData: withSocial(n.pluginData, key, value) } as never);
}

// ── The index (§4.3) ─────────────────────────────────────────────────────────────────────────────────────────────

export interface TemplateEntry {
  /** The component set's (or component's) asset key — local or the library's */
  key: string;
  name: string;
  data: SocialTemplateData;
  /** null: this file's; else the library's file key */
  library: string | null;
  libraryName: string | null;
  /** The set here (local, or a library copy already imported); null until a library template is first used */
  node: Guid | null;
  /** A library template's published asset (thumbnail, versionHash) */
  asset: LibraryAsset | null;
}

/** This file's templates: its local sets and lone components carrying the marker (keys given to those without one yet). */
export function localTemplates(ed: EditorController): TemplateEntry[] {
  if (ed.engine.destroyed) return [];
  const mains = ed.engine.localAssets().filter((a) => (a.kind === "COMPONENT_SET" || (a.kind === "COMPONENT" && !a.componentSetId)) && !a.softDeleted);
  const out: TemplateEntry[] = [];
  for (const a of mains) {
    const data = readTemplate(ed, a.id);
    if (!data) continue;
    const key = a.key || ed.engine.ensureAssetKeys([a.id]).find((k) => k.id === a.id)?.key || "";
    if (key) out.push({ key, name: data.name || a.name, data, library: null, libraryName: null, node: a.id, asset: null });
  }
  return out;
}

/** The enabled libraries' templates (their manifests' `social`), with the copy here when one was imported. */
export function libraryTemplates(state: Pick<LibraryState, "enabled" | "manifests" | "names">, copies: readonly { library: string; key: string; guid: Guid }[] = []): TemplateEntry[] {
  const out: TemplateEntry[] = [];
  for (const lib of state.enabled) {
    const manifest = state.manifests.get(lib);
    for (const a of manifest?.assets ?? []) {
      const data = a.social?.template ? normalizeTemplate(a.social.template) : null;
      if (!data || a.dependencyOnly) continue;
      const copy = copies.find((c) => c.library === lib && c.key === a.key);
      out.push({ key: a.key, name: data.name || a.name, data, library: lib, libraryName: state.names.get(lib) ?? null, node: copy?.guid ?? null, asset: a });
    }
  }
  return out;
}

/** Every template this file can use: its own, then its enabled libraries'. */
export function templateIndex(ed: EditorController): TemplateEntry[] {
  const local = localTemplates(ed);
  const state = ed.libraries.get();
  const lib = state.on ? libraryTemplates(state, ed.libraries.copies()) : [];
  return [...local, ...lib.filter((l) => !local.some((x) => x.key === l.key))];
}

export interface TemplateFilter {
  platform?: Platform | null;
  formatId?: string | null;
  animated?: boolean | null;
  /** The libraries that fit the picked brand (a template fits when its file has the Brands library enabled) */
  brandLibraries?: ReadonlySet<string> | null;
}

/** The gallery's filters (§4.3): platform, format, Static / Animated, brand. */
export function filterTemplates(list: readonly TemplateEntry[], f: TemplateFilter): TemplateEntry[] {
  return list.filter((e) => {
    const formats = Object.values(e.data.formats);
    if (f.platform && !e.data.platforms.includes(f.platform) && !formats.some((id) => formatById(id)?.platform === f.platform)) return false;
    if (f.formatId && !formats.includes(f.formatId)) return false;
    if (f.animated !== null && f.animated !== undefined && e.data.animated !== f.animated) return false;
    if (f.brandLibraries && e.library && !f.brandLibraries.has(e.library)) return false;
    return true;
  });
}

/** The template whose key is `key`, from the index (null when the file can't use it). */
export const templateByKey = (ed: EditorController, key: string): TemplateEntry | null => templateIndex(ed).find((e) => e.key === key) ?? null;

/** The set here for `key`: the local one or the library copy, imported first when it isn't here yet. */
export async function ensureTemplate(ed: EditorController, key: string): Promise<{ entry: TemplateEntry; node: Guid }> {
  const entry = templateByKey(ed, key);
  if (!entry) throw new Error(`No template ${key}`);
  if (entry.node) return { entry, node: entry.node };
  const node = entry.library ? await ensureCopy(ed, entry.library, key) : null;
  if (!node) throw new Error(`The template "${entry.name}" couldn't be brought into this file`);
  return { entry: { ...entry, node }, node };
}

// ── Variants and slots ───────────────────────────────────────────────────────────────────────────────────────────

const variantValue = (name: string | undefined, property: string): string | null => {
  for (const pair of (name ?? "").split(",")) {
    const [k, v] = pair.split("=").map((s) => s.trim());
    if (k === property && v !== undefined) return v;
  }
  return null;
};

/** A template's variants (a lone component: itself, as the marker's first format) with their Format values. */
export function templateVariants(ed: EditorController, node: Guid): { id: Guid; value: string }[] {
  const n = read(ed, node, ["type", "name", "pluginData"]);
  if (!n) return [];
  if (ed.engine.componentInfo(node)?.kind !== "COMPONENT_SET") return [{ id: node, value: Object.keys(templateIn(n.pluginData)?.formats ?? {})[0] ?? "" }];
  return kidsOf(ed, node).map((id) => ({ id, value: variantValue(read(ed, id, ["name"])?.name, FORMAT_PROPERTY) ?? "" }));
}

/** The variant for a post: the one made for its format, else `variant` (a Format value), else the first. */
export function pickVariant(ed: EditorController, node: Guid, data: SocialTemplateData, formatId: string | null, variant?: string): { id: Guid; value: string } | null {
  const all = templateVariants(ed, node);
  const forFormat = formatId ? Object.entries(data.formats).find(([, f]) => f === formatId)?.[0] : undefined;
  return all.find((v) => v.value === forFormat) ?? all.find((v) => v.value === variant) ?? all[0] ?? null;
}

export interface SlotRef {
  /** The layer (inside an instance: its derived id "I<instance>;<layer>") */
  nodeId: Guid;
  data: TemplateSlotData;
}

/** The slot layers of a main (the root included), not inside nested instances. */
export function slotsOf(ed: EditorController, root: Guid): SlotRef[] {
  const out: SlotRef[] = [];
  const walk = (id: Guid, depth: number) => {
    const n = read(ed, id, ["pluginData", "type"]);
    if (!n) return;
    const data = slotIn(n.pluginData);
    if (data) out.push({ nodeId: id, data });
    if (depth > 0 && n.type === "INSTANCE") return;
    for (const k of kidsOf(ed, id)) walk(k, depth + 1);
  };
  walk(root, 0);
  return out;
}

/**
 * A post's slots: an instance's are its own sublayers (derived ids — they carry their main's slot records) and, for
 * the root, its main's; a plain frame's its own tagged layers.
 */
export function postSlots(ed: EditorController, post: Guid): SlotRef[] {
  const info = ed.engine.componentInfo(post);
  if (info?.kind !== "INSTANCE" || !info.main) return slotsOf(ed, post);
  const root = readSlot(ed, info.main.ref);
  return [...(root ? [{ nodeId: post, data: root }] : []), ...kidsOf(ed, post).flatMap((k) => slotsOf(ed, k))];
}

/** The text of every text slot of a post, by role. */
export function slotTexts(ed: EditorController, post: Guid): Partial<Record<SlotRole, string>> {
  const out: Partial<Record<SlotRole, string>> = {};
  for (const s of postSlots(ed, post)) if (TEXT_ROLES.includes(s.data.role) && out[s.data.role] === undefined) out[s.data.role] = read(ed, s.nodeId, ["textData"])?.textData?.characters ?? "";
  return out;
}

// ── Inferring slots (Save as template, a plain frame's texts carried to a template) ────────────────────────────────

const CTA_NAME = /\b(cta|button|buton|shop|buy|order|sipariş|satın)\b/i;
const LABEL_NAME = /\b(label|etiket|badge|tag|rozet)\b/i;

const hasImage = (n: Row | null) => !!n?.fillPaints?.some((p) => p.type === "IMAGE" && p.visible !== false);

/** The collections named Brand here (local, or the Brands library's copy). */
const brandCollections = (ed: EditorController) => ed.engine.variableCollections({ includeRemote: true }).filter((c) => c.name === BRAND_COLLECTION);

/** A layer's fill bound to a Color/* variable of a Brand collection. */
function brandBoundFill(ed: EditorController, id: Guid): boolean {
  const vars = new Set(brandCollections(ed).flatMap((c) => c.variableIds));
  return ed.engine.boundVariables(id).some((b) => !!b.variable && b.target.startsWith("fillPaints") && vars.has(b.variable) && (ed.engine.variable(b.variable)?.name ?? "").startsWith("Color/"));
}

/** An instance of a set with a `Brand` variant property (the Brands library's Logo). */
function isLogoInstance(ed: EditorController, id: Guid): boolean {
  const info = ed.engine.componentInfo(id);
  return info?.kind === "INSTANCE" || info?.kind === "NESTED_INSTANCE" ? info.properties.some((p) => p.type === "VARIANT" && p.name === BRAND_PROPERTY) : false;
}

/**
 * The slots Save as template can infer on a frame (§4.4): its texts by size and order — a CTA or a label by its
 * layer's name, then the largest as the headline, the next as the body —, the logo instance, the first picture-filled
 * layer, brand-bound fills (the frame itself or a layer covering it: background; others: accent). The owner corrects
 * them in the dialog.
 */
export function inferSlots(ed: EditorController, root: Guid): { nodeId: Guid; role: SlotRole }[] {
  const texts: { id: Guid; size: number; y: number; name: string }[] = [];
  const out: { nodeId: Guid; role: SlotRole }[] = [];
  const rootSize = read(ed, root, ["size"])?.size;
  let picture = false;
  let logo = false;
  const walk = (id: Guid, depth: number) => {
    const n = read(ed, id, ["type", "name", "fillPaints", "fontSize", "transform", "size"] as string[]) as (Row & { fontSize?: number }) | null;
    if (!n) return;
    const type = ed.withRealType(n).type;
    if (depth > 0 && type === "INSTANCE") {
      if (!logo && isLogoInstance(ed, id)) {
        out.push({ nodeId: id, role: "logo" });
        logo = true;
      }
      return;
    }
    if (type === "TEXT") texts.push({ id, size: n.fontSize ?? 12, y: n.transform?.m12 ?? 0, name: n.name ?? "" });
    else if (depth > 0 && !picture && hasImage(n)) {
      out.push({ nodeId: id, role: "picture" });
      picture = true;
    } else if (brandBoundFill(ed, id)) {
      const covers = depth === 0 || (!!rootSize && n.size?.x === rootSize.x && n.size?.y === rootSize.y);
      out.push({ nodeId: id, role: covers ? "background" : "accent" });
    }
    for (const k of kidsOf(ed, id)) walk(k, depth + 1);
  };
  walk(root, 0);
  const rest = [...texts];
  for (const [role, re] of [["cta", CTA_NAME], ["label", LABEL_NAME]] as const) {
    const i = rest.findIndex((x) => re.test(x.name));
    if (i >= 0) out.push({ nodeId: rest.splice(i, 1)[0].id, role });
  }
  rest.sort((a, b) => b.size - a.size || a.y - b.y);
  if (rest[0]) out.push({ nodeId: rest[0].id, role: "headline" });
  if (rest[1]) out.push({ nodeId: rest[1].id, role: "body" });
  return out;
}

/** Why a layer can't be a slot of `role` (§3.3's wiring), or null when it can. */
export function slotWiringError(ed: EditorController, id: Guid, role: SlotRole): string | null {
  const n = read(ed, id, ["type", "fillPaints"]);
  if (!n) return t("No layer {id}", { id });
  const type = ed.withRealType(n).type;
  if (TEXT_ROLES.includes(role)) return type === "TEXT" ? null : t("{role} needs a text layer", { role: t(ROLE_NAMES[role]) });
  if (role === "logo") return isLogoInstance(ed, id) ? null : t("The logo needs an instance of the Brands library's Logo component");
  if (role === "picture") return hasImage(n) ? null : t("The picture needs an image fill");
  return brandBoundFill(ed, id) ? null : t("{role} needs a fill bound to a Color variable of the Brand collection", { role: t(ROLE_NAMES[role]) });
}

// ── Brand (mode and logo variant) ────────────────────────────────────────────────────────────────────────────────

/** Applies a brand inside a Writer: the Brand collection's mode on each post, the logo slots' Brand variant, the record. */
export function applyBrandNow(ed: EditorController, ids: readonly Guid[], brand: Pick<Brand, "id" | "name">): void {
  for (const id of ids) {
    for (const c of brandCollections(ed)) {
      const mode = c.modes.find((m) => m.name === brand.name);
      if (mode) ed.engine.runCommand("SET_VARIABLE_MODE" as never, { refs: [id], collection: c.id, mode: mode.modeId } as never);
    }
    const logos = postSlots(ed, id).filter((s) => s.data.role === "logo").map((s) => s.nodeId);
    for (const logo of logos) {
      const prop = ed.engine.componentInfo(logo)?.properties.find((p) => p.type === "VARIANT" && p.name === BRAND_PROPERTY);
      if (prop?.variantOptions?.includes(brand.name)) ed.engine.runCommand("SET_COMPONENT_PROPERTY" as never, { ref: logo, prop: prop.id, value: brand.name } as never);
    }
    // Another brand: its products, not the last one's.
    const data = readPost(ed, id);
    if (data && data.brandId !== brand.id) writePost(ed, id, { ...data, brandId: brand.id, productIds: [] });
  }
}

/**
 * Product (the Post section, the table's import): the posts' product, and its first packshot in their picture slots,
 * one undo step "Edit post" (null: no product; the picture stays).
 */
export async function setProduct(ed: EditorController, w: Writer, ids: readonly Guid[], brandId: string | null, productId: string | null): Promise<void> {
  const picture = brandId && productId ? await productPicture(ed, brandId, productId).catch(() => null) : null;
  w("Edit post", () => {
    for (const id of ids) {
      const data = readPost(ed, id);
      if (!data) continue;
      writePost(ed, id, { ...data, productIds: productId ? [productId] : [] });
      if (picture && postSlots(ed, id).some((s) => s.data.role === "picture" && !s.data.locked)) fillSlotsNow(ed, id, {}, picture);
    }
  });
}

/** A brand from the store (its name names its mode and its logo variant). */
async function brandOf(brandId: string): Promise<Brand> {
  const b = await brandsRepo().get(brandId);
  if (!b) throw new Error(`No brand ${brandId}`);
  brands.set(b.id, b);
  return b;
}

/**
 * The brands as last read, for the synchronous actions (actions.ts: the agents' tools write inside their own write,
 * which can't wait for the store): kept from the first `primeBrands` on, read again when the store says one changed.
 */
const brands = new Map<string, Brand>();
let primed = false;

export function primeBrands(): Promise<void> {
  const repo = brandsRepo();
  const load = () =>
    repo.list().then(
      (list) => {
        brands.clear();
        for (const b of list) brands.set(b.id, b);
      },
      () => {}
    );
  if (!primed) {
    primed = true;
    repo.watch(() => void load());
  }
  return load();
}

/** A brand as last read (null: not read yet, or gone). */
export const knownBrand = (brandId: string): Brand | null => brands.get(brandId) ?? null;

/** Products' packshots this editor imported already, by product id (the synchronous actions use them). */
const packshots = new WeakMap<EditorController, Map<string, ImportedImage | null>>();
const packshotsOf = (ed: EditorController) => {
  let m = packshots.get(ed);
  if (!m) packshots.set(ed, (m = new Map()));
  return m;
};
export const knownPicture = (ed: EditorController, productId: string): ImportedImage | null => packshotsOf(ed).get(productId) ?? null;

/**
 * What a synchronous apply needs, fetched first (an agent tool awaits it before its write): the template brought in
 * (a library's copy), the brand read, the product's packshot imported.
 */
export async function prepareTemplate(ed: EditorController, opts: { key?: string; brandId?: string | null; productId?: string | null }): Promise<void> {
  if (opts.key) await ensureTemplate(ed, opts.key);
  if (opts.brandId) await brandOf(opts.brandId).catch(() => null);
  if (opts.brandId && opts.productId) await productPicture(ed, opts.brandId, opts.productId).catch(() => null);
}

/** The Brand collection's mode and the logo's Brand variant on the posts (§1.6): one undo step "Apply brand". */
export async function applyBrand(ed: EditorController, w: Writer, ids: readonly Guid[], brandId: string): Promise<void> {
  const brand = await brandOf(brandId);
  w("Apply brand", () => applyBrandNow(ed, ids, brand));
}

// ── Pictures ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** An image argument (an agent's base64 bytes) imported into the file's images. */
export async function importPicture(ed: EditorController, arg: ImageArg): Promise<ImportedImage> {
  if (!ed.images.store) throw new Error("Images can't be added to this file.");
  const bytes = typeof arg.data === "string" ? base64Bytes(arg.data) : null;
  const mime = bytes ? sniffImage(bytes) : null;
  if (!bytes || !mime) throw new Error("picture: give `data` (a PNG, JPEG, WebP or GIF as base64)");
  const name = (arg.name ?? "Picture").slice(0, 120);
  const [img] = await ed.images.import([new File([bytes as BlobPart], `${name}.${mime.split("/")[1]}`, { type: mime })]);
  if (!img) throw new Error("picture: the image couldn't be decoded");
  return img;
}

/** A product's first packshot imported into the file's images (null when it has none). */
export async function productPicture(ed: EditorController, brandId: string, productId: string): Promise<ImportedImage | null> {
  const product = (await brandOf(brandId)).products.find((p) => p.id === productId);
  const shot = product?.images.find((i) => i.role === "packshot");
  if (!product || !shot) return null;
  const cached = packshotsOf(ed).get(productId);
  if (cached) return cached;
  const { data } = await brandsRepo().image(brandId, shot.id);
  const img = await importPicture(ed, { data, name: product.name });
  packshotsOf(ed).set(productId, img);
  return img;
}

// ── Filling slots ────────────────────────────────────────────────────────────────────────────────────────────────

export interface FillReport {
  /** Roles written */
  filled: SlotRole[];
  /** Locked slots asked for (left as they are) */
  locked: SlotRole[];
  /** Texts longer than their slot's maxChars (written anyway) */
  over: { role: SlotRole; chars: number; maxChars: number }[];
  /** Roles asked for that the post has no slot for */
  missing: SlotRole[];
}

/**
 * Fills a post's slots inside a Writer: text roles through the instance's TEXT properties (a plain frame: the text
 * itself), the picture as an IMAGE fill (scale mode FILL). A locked slot is refused; a text over maxChars is written
 * and reported.
 */
export function fillSlotsNow(ed: EditorController, id: Guid, values: Partial<Record<SlotRole, string>>, picture?: ImportedImage | null): FillReport {
  const report: FillReport = { filled: [], locked: [], over: [], missing: [] };
  const slots = postSlots(ed, id);
  const info = ed.engine.componentInfo(id);
  const asked = [...(Object.keys(values) as SlotRole[]).filter((r) => typeof values[r] === "string"), ...(picture ? (["picture"] as SlotRole[]) : [])];
  for (const role of asked) {
    const mine = slots.filter((s) => s.data.role === role);
    if (!mine.length) {
      report.missing.push(role);
      continue;
    }
    if (mine.some((s) => s.data.locked)) {
      report.locked.push(role);
      continue;
    }
    for (const s of mine) {
      if (role === "picture" && picture) {
        ed.engine.setProps([s.nodeId], { fillPaints: [{ ...mediaPaint(picture), imageScaleMode: "FILL" }] } as never);
        continue;
      }
      const text = values[role]!;
      if (s.data.maxChars !== null && [...text].length > s.data.maxChars) report.over.push({ role, chars: [...text].length, maxChars: s.data.maxChars });
      const prop = s.data.property && info?.kind === "INSTANCE" ? info.properties.find((p) => p.type === "TEXT" && (p.apiName === s.data.property || p.name === s.data.property || p.name === s.data.property!.split("#")[0])) : null;
      if (prop) run(ed, "SET_COMPONENT_PROPERTY", { ref: id, prop: prop.id, value: text });
      else ed.engine.setProps([s.nodeId], { textData: { characters: text } } as never);
    }
    report.filled.push(role);
  }
  return report;
}

/** fill_slots / the table's cells / a product picked: the post's slots, one undo step "Fill slots". */
export async function fillSlots(ed: EditorController, w: Writer, id: Guid, values: Partial<Record<SlotRole, string>>, picture?: ImageArg | ImportedImage | null): Promise<FillReport> {
  const img = picture && "hash" in picture ? (picture as ImportedImage) : picture ? await importPicture(ed, picture as ImageArg) : null;
  return w("Fill slots", () => fillSlotsNow(ed, id, values, img));
}

// ── Applying a template ──────────────────────────────────────────────────────────────────────────────────────────

/** The key between a layer's place and the next sibling's (a replacement goes where it was in the layer order). */
function keyAfterSibling(ed: EditorController, parent: Guid, id: Guid): string {
  const kids = kidsOf(ed, parent);
  const pos = (k: Guid | undefined) => (k ? (ed.engine.readNode(k, { fields: ["parentIndex"] })?.parentIndex?.position ?? null) : null);
  const i = kids.indexOf(id);
  return keyBetween(pos(kids[i]) ?? "", pos(kids[i + 1]));
}

/** An instance of `main` on the page at `at` (its top-left), placed in the layer order at `position` (default: on top). */
export function insertTemplateInstance(ed: EditorController, main: Guid, page: Guid, at: { x: number; y: number }, position?: string): Guid {
  const before = [...ed.engine.getSelection().refs];
  const made = run(ed, "INSERT_INSTANCE", { main, parent: page, x: at.x, y: at.y }).created[0] ?? ed.engine.getSelection().refs[0];
  const tr = ed.engine.readNode(made, { fields: ["transform"] })?.transform;
  ed.engine.setProps([made], { transform: { ...(tr ?? { m00: 1, m01: 0, m10: 0, m11: 1 }), m02: Math.round(at.x), m12: Math.round(at.y) }, ...(position ? { parentIndex: { guid: page, position } } : {}) } as never);
  ed.engine.setSelection(before.filter((x) => !!ed.engine.readNode(x, { fields: ["type"] })));
  return made;
}

export interface ApplyOptions {
  key: string;
  variant?: string;
  brand?: Pick<Brand, "id" | "name"> | null;
  productId?: string;
  picture?: ImportedImage | null;
}

/**
 * Applies a template inside a Writer (§6.7): an instance post swaps to the template's variant for its format; a plain
 * frame is replaced by an instance at its place and in its layer order, its texts carried to the slots by role, its
 * record kept. Then the brand and the picture, when given. Returns the posts (the new instances).
 */
export function applyTemplateNow(ed: EditorController, ids: readonly Guid[], node: Guid, data: SocialTemplateData, opts: ApplyOptions): Guid[] {
  const out: Guid[] = [];
  for (const id of ids) {
    const post = readPost(ed, id);
    const variant = pickVariant(ed, node, data, post?.formatId ?? null, opts.variant);
    if (!variant) continue;
    const template = { key: opts.key, variant: variant.value };
    let target = id;
    if (ed.engine.componentInfo(id)?.kind === "INSTANCE") run(ed, "SWAP_INSTANCE", { main: variant.id, ref: id });
    else {
      const n = ed.engine.readNode(id, { fields: ["transform", "parentIndex", "name"] });
      const parent = n?.parentIndex?.guid;
      if (!n || !parent) continue;
      const texts = Object.fromEntries(inferSlots(ed, id).filter((s) => TEXT_ROLES.includes(s.role)).map((s) => [s.role, read(ed, s.nodeId, ["textData"])?.textData?.characters ?? ""]));
      target = insertTemplateInstance(ed, variant.id, parent, { x: n.transform?.m02 ?? 0, y: n.transform?.m12 ?? 0 }, keyAfterSibling(ed, parent, id));
      if (n.name) ed.engine.setProps([target], { name: n.name });
      fillSlotsNow(ed, target, texts);
      const before = [...ed.engine.getSelection().refs];
      ed.engine.setSelection([id]);
      ed.engine.command("DELETE");
      ed.engine.setSelection(before.filter((x) => x !== id));
    }
    writePost(ed, target, { ...(post ?? postRecord(data.formats[variant.value] ?? "")), template, ...(opts.productId ? { productIds: [opts.productId] } : {}) });
    if (opts.brand) applyBrandNow(ed, [target], opts.brand);
    if (opts.picture) fillSlotsNow(ed, target, {}, opts.picture);
    out.push(target);
  }
  return out;
}

/** Apply template (the Post section's Template, apply_template): the template brought in, then one undo step. */
export async function applyTemplate(ed: EditorController, w: Writer, ids: readonly Guid[], opts: { key: string; variant?: string; brandId?: string; productId?: string }): Promise<Guid[]> {
  const { entry, node } = await ensureTemplate(ed, opts.key);
  const brand = opts.brandId ? await brandOf(opts.brandId) : null;
  const picture = opts.brandId && opts.productId ? await productPicture(ed, opts.brandId, opts.productId) : null;
  return w("Apply template", () => applyTemplateNow(ed, ids, node, entry.data, { ...opts, brand, picture }));
}

/**
 * Apply template, synchronously (actions.ts, the agents' apply_template inside their write): the template must be in
 * this file (a local one, or a library copy `prepareTemplate` brought in); the brand and the packshot as last read.
 */
export function applyTemplateSync(ed: EditorController, w: Writer, ids: readonly Guid[], opts: { key: string; variant?: string; brandId?: string; productId?: string }): Guid[] {
  const entry = templateByKey(ed, opts.key);
  if (!entry) throw new Error(t("No template {key} (list_templates lists them)", { key: opts.key }));
  if (!entry.node) throw new Error(t("The template “{name}” isn't in this file yet: insert it from the Templates gallery first", { name: entry.name }));
  const brand = opts.brandId ? knownBrand(opts.brandId) : null;
  const picture = opts.productId ? knownPicture(ed, opts.productId) : null;
  return w("Apply template", () => applyTemplateNow(ed, ids, entry.node!, entry.data, { ...opts, brand, picture }));
}

/** A new post made from a template inside a Writer (newPost with a template): an instance of the variant for the format. */
export function newTemplatePostNow(ed: EditorController, page: Guid, opts: { key: string; node: Guid; data: SocialTemplateData; formatId: string | null; variant?: string; at: { x: number; y: number }; record: SocialPostData; name?: string }): Guid {
  const variant = pickVariant(ed, opts.node, opts.data, opts.formatId, opts.variant);
  if (!variant) throw new Error(`The template "${opts.data.name}" has no variants`);
  const id = insertTemplateInstance(ed, variant.id, page, opts.at);
  const formatId = opts.formatId ?? opts.data.formats[variant.value] ?? opts.record.formatId;
  if (opts.name) ed.engine.setProps([id], { name: opts.name });
  writePost(ed, id, { ...opts.record, formatId, template: { key: opts.key, variant: variant.value } });
  return id;
}

/**
 * Inserts a template as a post (the gallery's click and drop, §4.3): the library copy brought in, the product's
 * packshot imported, then one undo step "New post" — the instance for the format (default: the template's first),
 * bound to the brand (mode and logo variant), the picture in its slot.
 */
export async function insertTemplate(ed: EditorController, w: Writer, opts: { key: string; formatId?: string | null; variant?: string; brandId?: string | null; productId?: string | null; campaignId?: string | null; at?: { x: number; y: number } }): Promise<Guid> {
  const { entry, node } = await ensureTemplate(ed, opts.key);
  const brand = opts.brandId ? await brandOf(opts.brandId).catch(() => null) : null;
  const picture = brand && opts.productId ? await productPicture(ed, brand.id, opts.productId).catch(() => null) : null;
  return w("New post", () => {
    const page = ed.store.page;
    const variant = pickVariant(ed, node, entry.data, opts.formatId ?? null, opts.variant);
    const formatId = opts.formatId ?? (variant ? entry.data.formats[variant.value] : null) ?? Object.values(entry.data.formats)[0];
    const format = resolveFormat(formatId);
    const board = readBoard(ed, page);
    const at = opts.at ?? (isSocialFile(ed) ? boardEnd(board.posts) : !board.posts.length && board.others ? { x: board.others.x + board.others.width + 120, y: board.others.y } : placePost(board.posts, opts.campaignId ?? null));
    const record = postRecord(formatId, { brandId: brand?.id ?? null, campaignId: opts.campaignId ?? null, productIds: opts.productId ? [opts.productId] : [] });
    const id = newTemplatePostNow(ed, page, { key: opts.key, node, data: entry.data, formatId, variant: opts.variant, at, record, name: format?.name });
    if (brand) applyBrandNow(ed, [id], brand);
    if (picture) fillSlotsNow(ed, id, {}, picture);
    return id;
  });
}

// ── Save as template (§4.4) ──────────────────────────────────────────────────────────────────────────────────────

export interface SaveTemplateOptions {
  name: string;
  platforms?: Platform[];
  /** The slots (default: what inferSlots finds); `locked` and `maxChars` per slot */
  slots?: { nodeId: Guid; role: SlotRole; locked?: boolean; maxChars?: number | null }[];
  /** More catalogue formats, each a variant of its own (the post's copied and resized, its layers by their constraints) */
  formats?: string[];
  origin?: "starter" | "owner";
}

/** Why a frame can't be saved as a template (§3.3's wiring, the frame's kind), or null. */
export function saveTemplateError(ed: EditorController, id: Guid, slots: readonly { nodeId: Guid; role: SlotRole }[]): string | null {
  const n = read(ed, id, ["type", "pluginData"]);
  if (!n) return t("No layer {id}", { id });
  const kind = ed.engine.componentInfo(id)?.kind;
  if (kind === "INSTANCE") return t("Detach the instance first: a template is made from a frame");
  if (kind === "VARIANT" || kind === "COMPONENT_SET" || templateIn(n.pluginData)) return t("This is a template already");
  if (ed.withRealType(n).type !== "FRAME" && kind !== "COMPONENT") return t("A template is made from a frame");
  if (!slots.length) return t("Tag at least one slot");
  for (const s of slots) {
    const e = slotWiringError(ed, s.nodeId, s.role);
    if (e) return e;
  }
  return null;
}

/** A set's variants in a row, 40 apart inside its 20 padding (variants of different sizes would overlap), the set hugging them. */
function layoutVariants(ed: EditorController, set: Guid): void {
  let x = 20;
  let tallest = 0;
  for (const v of kidsOf(ed, set)) {
    const n = ed.engine.readNode(v, { fields: ["size", "transform"] });
    if (!n?.size) continue;
    ed.engine.setProps([v], { transform: { ...(n.transform ?? { m00: 1, m01: 0, m10: 0, m11: 1 }), m02: x, m12: 20 } } as never);
    x += n.size.x + 40;
    tallest = Math.max(tallest, n.size.y);
  }
  ed.engine.setProps([set], { size: { x: x - 40 + 20, y: tallest + 40 } });
}

/**
 * A new set's asset key, given in the same step: `ensureAssetKeys` is a SYSTEM change the engine refuses inside an open
 * step, so the key (field 319, a stable 40-hex) is written as the set's own field — undone with it, kept after.
 */
function assetKeyOf(ed: EditorController, set: Guid): string {
  const have = (ed.engine.readNode(set, { fields: ["key"] } as never) as { key?: string } | null)?.key;
  if (have) return have;
  const bytes = crypto.getRandomValues(new Uint8Array(20));
  const key = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  ed.engine.setProps([set], { key } as never);
  return (ed.engine.readNode(set, { fields: ["key"] } as never) as { key?: string } | null)?.key ?? "";
}

/** The variable named `name` of a Brand collection (local first), or null. */
function brandVariable(ed: EditorController, name: string): Guid | null {
  const cs = brandCollections(ed).sort((a, b) => Number(a.remote) - Number(b.remote));
  for (const c of cs) {
    const v = c.variableIds.find((x) => ed.engine.variable(x)?.name === name);
    if (v) return v;
  }
  return null;
}

/**
 * Save as template inside a Writer: the frame becomes a component (Create component) wrapped in a set (Combine as
 * variants) with a `Format` variant named after the post's format, each text slot a TEXT property (its font family
 * bound to Font/Heading or Font/Body when the file has them), every slot tagged, the template marker on the set. A
 * post keeps going as an instance of its template at the end of its campaign's row (the record moves to it).
 */
export function saveAsTemplateNow(ed: EditorController, id: Guid, opts: SaveTemplateOptions): { key: string; set: Guid; post: Guid | null } | { error: string } {
  const slots = opts.slots ?? inferSlots(ed, id);
  const error = saveTemplateError(ed, id, slots);
  if (error) return { error };
  const post = readPost(ed, id);
  const format = post ? resolveFormat(post.formatId) : null;
  const formatName = format?.name ?? "Default";
  const before = [...ed.engine.getSelection().refs];
  ed.engine.setSelection([id]);
  if (ed.engine.componentInfo(id)?.kind !== "COMPONENT") run(ed, "CREATE_COMPONENT");
  run(ed, "COMBINE_AS_VARIANTS");
  const set = ed.engine.getSelection().refs[0];
  ed.engine.setSelection(before.filter((x) => x !== id && !!ed.engine.readNode(x, { fields: ["type"] })));
  ed.engine.setProps([set], { name: opts.name });
  const variantProp = ed.engine.componentInfo(set)?.properties.find((p) => p.type === "VARIANT");
  if (variantProp) run(ed, "EDIT_COMPONENT_PROPERTY", { ref: set, prop: variantProp.id, name: FORMAT_PROPERTY, oldValue: variantProp.defaultValue, newValue: formatName });
  const heading = brandVariable(ed, FONT_HEADING);
  const body = brandVariable(ed, FONT_BODY);
  for (const s of slots) {
    const slot = opts.slots?.find((x) => x.nodeId === s.nodeId);
    let property: string | null = null;
    if (TEXT_ROLES.includes(s.role)) {
      const had = new Set(ed.engine.componentInfo(set)?.properties.map((p) => p.id));
      const chars = read(ed, s.nodeId, ["textData"])?.textData?.characters ?? "";
      run(ed, "ADD_COMPONENT_PROPERTY", { ref: set, name: ROLE_NAMES[s.role], type: "TEXT", defaultValue: chars, bind: [s.nodeId] });
      property = ed.engine.componentInfo(set)?.properties.find((p) => !had.has(p.id))?.apiName ?? null;
      const font = s.role === "headline" || s.role === "cta" ? heading : body;
      if (font) ed.engine.runCommand("BIND_VARIABLE" as never, { refs: [s.nodeId], target: "FONT_FAMILY", variable: font } as never);
    }
    const data: TemplateSlotData = { v: 1, role: s.role, property, locked: slot?.locked === true, maxChars: slot?.maxChars ?? null };
    writeEntry(ed, s.nodeId, "slot", data);
  }
  const formats: Record<string, string> = { [formatName]: post?.formatId ?? "" };
  // A variant per other format (Figma's Add variant: a copy beside it, slots and properties included), resized.
  for (const fid of opts.formats ?? []) {
    const f = formatById(fid);
    if (!f || Object.values(formats).includes(fid) || formats[f.name] !== undefined) continue;
    ed.engine.setSelection([id]);
    run(ed, "ADD_VARIANT");
    const made = ed.engine.getSelection().refs[0];
    const value = variantValue(read(ed, made, ["name"])?.name, FORMAT_PROPERTY);
    const p = ed.engine.componentInfo(set)?.properties.find((x) => x.type === "VARIANT");
    if (p && value !== null) run(ed, "EDIT_COMPONENT_PROPERTY", { ref: set, prop: p.id, oldValue: value, newValue: f.name });
    ed.engine.setProps([made], { size: { x: f.width, y: f.height } });
    formats[f.name] = fid;
  }
  ed.engine.setSelection(before.filter((x) => x !== id && !!ed.engine.readNode(x, { fields: ["type"] })));
  layoutVariants(ed, set);
  const platform = post ? formatById(post.formatId)?.platform : undefined;
  const platforms = opts.platforms ?? [...new Set([...(platform ? [platform] : []), ...Object.values(formats).map((f) => formatById(f)?.platform).filter((x): x is Platform => !!x)])];
  const marker: SocialTemplateData = { v: 1, name: opts.name, formats, animated: isAnimated(ed, id), platforms, origin: opts.origin ?? "owner" };
  writeEntry(ed, set, "template", marker);
  if (post) writePost(ed, id, null);
  const key = assetKeyOf(ed, set);
  if (!post) return { key, set, post: null };
  // The post goes on as an instance of the template, at the end of its campaign's row.
  const page = ed.store.page;
  const at = isSocialFile(ed) ? boardEnd(readBoard(ed, page).posts) : placePost(readBoard(ed, page).posts, post.campaignId);
  const instance = insertTemplateInstance(ed, id, page, at);
  writePost(ed, instance, { ...post, template: { key, variant: formatName } });
  return { key, set, post: instance };
}

/** Save as template… (the dialog, save_as_template): one undo step "Save as template"; a refusal names what is missing. */
export function saveAsTemplate(ed: EditorController, w: Writer, id: Guid, opts: SaveTemplateOptions): { key: string; set: Guid; post: Guid | null } | { error: string } {
  const slots = opts.slots ?? inferSlots(ed, id);
  const error = saveTemplateError(ed, id, slots);
  if (error) return { error };
  return w("Save as template", () => saveAsTemplateNow(ed, id, { ...opts, slots }));
}
