/**
 * The document-level calls of the Plugin API (docs/plugins.md §5): creating nodes, grouping and boolean operations,
 * pages and the selection, the viewport, text ranges, images, exports, styles and variables — each over the editor's
 * engine, as the user would do it (a run writes as the person: its writes are theirs, decision 6).
 */
import type { Guid, Message, NodeChange, NodeFields, Paint } from "@/engine/codec";
import { Status } from "@/engine/abi";
import { defaults as layerDefaults } from "../../agents/nodeSpec";
import { newNodeGuid } from "../../variables";
import { svgToMessage } from "../../model/svgImport";
import { renderEngineExport } from "../../exportCore";
import { exportAllowed } from "../../exporting";
import { LATEST_TEXT_LAYOUT_VERSION, pendingUpgrades } from "../../panels/design/TypeSettings";
import { ApiError, MIXED } from "./codec";
import { mustNode, readNode, ref, refOf, type ApiContext } from "./context";
import { apiType, decorationColorFromApi, decorationColorToApi, decorationMetricFromApi, decorationMetricToApi, effectToApi, ENGINE_TYPE, fontNameFromApi, IDENTITY, letterSpacingFromApi, letterSpacingToApi, lineHeightFromApi, lineHeightToApi, paintsFromApi, paintToApi, weightOf } from "./convert";
import { positionAt, writeFields } from "./nodes";
import { sha1 } from "./sha1";

type Obj = Record<string, unknown>;
const session = (ctx: ApiContext) => ctx.ed.source.sessionID ?? 1;

export function currentPage(ctx: ApiContext): Guid {
  return ctx.ed.store.page;
}

// ---- Creating ----------------------------------------------------------------------------------------------------

const DEFAULT_NAMES: Record<string, string> = { RECTANGLE: "Rectangle", LINE: "Line", ELLIPSE: "Ellipse", POLYGON: "Polygon", STAR: "Star", VECTOR: "Vector", TEXT: "", FRAME: "Frame", COMPONENT: "Component", SECTION: "Section", SLICE: "Slice", BOOLEAN_OPERATION: "Boolean", PAGE: "Page" };

/**
 * Figma's figma.createX(): a new node on the current page, not selected, centred in the view — Figma's docs: "The
 * behavior is similar to using the R shortcut followed by a click" (developers.figma.com …/figma-createrectangle), i.e.
 * placed where the person is looking, not at the page's 0,0 far off screen (whole pixels; the exact rounding is
 * [unverified] against live Figma).
 */
export function create(ctx: ApiContext, type: string): unknown {
  if (type === "PAGE") return createPage(ctx);
  const engineType = ENGINE_TYPE[type];
  if (!engineType) throw new ApiError(`Cannot create a node of type ${type}`);
  ctx.write();
  const guid = newNodeGuid(ctx.ed);
  const page = currentPage(ctx);
  const base = layerDefaults(engineType) as NodeFields;
  const fields: Obj = { ...base };
  if (type === "TEXT") Object.assign(fields, { fontSize: 12, textData: { characters: "" }, size: { x: 0, y: 14 } });
  if (type === "FRAME" || type === "COMPONENT") Object.assign(fields, { fillPaints: (layerDefaults("FRAME") as NodeFields).fillPaints, frameMaskDisabled: false, size: { x: 100, y: 100 } });
  if (type === "SECTION") Object.assign(fields, { size: { x: 100, y: 100 } });
  if (type === "SLICE" || type === "VECTOR") delete fields.fillPaints;
  if (type === "LINE") Object.assign(fields, { size: { x: 100, y: 0 } });
  const size = (fields.size as { x: number; y: number } | undefined) ?? { x: 100, y: 100 };
  const c = ctx.ed.engine.viewCenter();
  const transform = { ...IDENTITY, m02: Math.round(c.x - size.x / 2), m12: Math.round(c.y - size.y / 2) };
  const node = { guid, type: engineType, phase: "CREATED", name: DEFAULT_NAMES[type] ?? type, transform, parentIndex: { guid: page, position: positionAt(ctx, page, -1) }, ...fields } as NodeChange;
  const message: Message = { type: "NODE_CHANGES", sessionID: session(ctx), nodeChanges: [node] };
  const status = ctx.ed.engine.applyChanges(message, "user");
  if (status !== Status.OK) throw new ApiError(`Couldn't create a ${type.toLowerCase()} (status ${status})`);
  return ref(readNode(ctx, guid));
}

function createPage(ctx: ApiContext): unknown {
  ctx.write();
  const before = new Set(ctx.ed.engine.pages().map((p) => (p as { guid: string }).guid));
  const keep = currentPage(ctx);
  const r = ctx.ed.engine.runCommand("CREATE_PAGE");
  const made = r.created[0] ?? ctx.ed.engine.pages().map((p) => (p as { guid: string }).guid).find((g) => !before.has(g));
  if (!made) throw new ApiError("Couldn't create a page");
  // Figma: a new page isn't switched to.
  if (currentPage(ctx) !== keep) ctx.ed.engine.setCurrentPage(keep);
  return refOf(ctx, made);
}

/** Runs a selection command on `ids` and gives back what it made; the user's selection is put back. */
function withSelection(ctx: ApiContext, ids: readonly Guid[], run: () => void): Guid[] {
  const keep = [...ctx.ed.selection];
  const page = currentPage(ctx);
  ctx.write();
  ctx.ed.engine.setSelection([...ids]);
  run();
  const made = [...ctx.ed.engine.getSelection().refs];
  if (currentPage(ctx) !== page) ctx.ed.engine.setCurrentPage(page);
  ctx.ed.engine.setSelection(keep.filter((id) => readNode(ctx, id, false)));
  return made;
}

function nodeList(ctx: ApiContext, nodes: unknown, what: string): Guid[] {
  if (!Array.isArray(nodes) || !nodes.length) throw new ApiError(`in ${what}: First argument must be an array of at least one node`);
  return nodes.map((n) => mustNode(ctx, n).guid);
}

function placeUnder(ctx: ApiContext, id: Guid, parent: unknown, index: number): void {
  if (typeof parent !== "string") return;
  const p = mustNode(ctx, parent);
  if (readNode(ctx, id, false)?.parentIndex?.guid === p.guid && index < 0) return;
  ctx.ed.engine.moveNodes([id], p.guid, index < 0 ? (p.childIds?.length ?? 0) : index);
}

export function group(ctx: ApiContext, nodes: unknown, parent: unknown, index: number): unknown {
  const ids = nodeList(ctx, nodes, "group");
  if (typeof parent !== "string") throw new ApiError("in group: Second argument must be a parent node");
  const [g] = withSelection(ctx, ids, () => ctx.ed.engine.command("GROUP"));
  if (!g) throw new ApiError("Couldn't group these nodes");
  placeUnder(ctx, g, parent, index);
  return refOf(ctx, g);
}

export function ungroup(ctx: ApiContext, node: unknown): unknown {
  const n = mustNode(ctx, node);
  const kids = withSelection(ctx, [n.guid], () => ctx.ed.engine.command("UNGROUP"));
  return kids.map((id) => refOf(ctx, id));
}

export function flatten(ctx: ApiContext, nodes: unknown, parent: unknown, index: number): unknown {
  const ids = nodeList(ctx, nodes, "flatten");
  const [v] = withSelection(ctx, ids, () => ctx.ed.engine.command("FLATTEN"));
  if (!v) throw new ApiError("Couldn't flatten these nodes");
  placeUnder(ctx, v, parent, index);
  return refOf(ctx, v);
}

export function booleanOp(ctx: ApiContext, op: string, nodes: unknown, parent: unknown, index: number): unknown {
  const ids = nodeList(ctx, nodes, op.toLowerCase());
  const cmd = ({ UNION: "BOOLEAN_UNION", SUBTRACT: "BOOLEAN_SUBTRACT", INTERSECT: "BOOLEAN_INTERSECT", EXCLUDE: "BOOLEAN_EXCLUDE" } as const)[op as "UNION"];
  if (!cmd) throw new ApiError(`Unknown boolean operation ${op}`);
  const [b] = withSelection(ctx, ids, () => ctx.ed.engine.command(cmd));
  if (!b) throw new ApiError(`Couldn't ${op.toLowerCase()} these nodes`);
  placeUnder(ctx, b, parent, index);
  return refOf(ctx, b);
}

export function createComponentFromNode(ctx: ApiContext, node: unknown): unknown {
  const n = mustNode(ctx, node);
  if (["SYMBOL", "INSTANCE", "CANVAS", "DOCUMENT"].includes(n.type ?? "")) throw new ApiError(`Cannot create a component from a ${apiType(n as never)}`);
  const [c] = withSelection(ctx, [n.guid], () => ctx.ed.engine.runCommand("CREATE_COMPONENT", { mode: "SINGLE" }));
  if (!c) throw new ApiError("Couldn't create a component from this node");
  return refOf(ctx, c);
}

export function combineAsVariants(ctx: ApiContext, nodes: unknown, parent: unknown, index: number): unknown {
  const ids = nodeList(ctx, nodes, "combineAsVariants");
  for (const id of ids) if (readNode(ctx, id, false)?.type !== "SYMBOL") throw new ApiError("in combineAsVariants: Every node must be a component");
  const [set] = withSelection(ctx, ids, () => ctx.ed.engine.command("COMBINE_AS_VARIANTS"));
  if (!set) throw new ApiError("Couldn't combine these components");
  placeUnder(ctx, set, parent, index);
  return refOf(ctx, set);
}

export function createInstance(ctx: ApiContext, component: unknown): unknown {
  const c = mustNode(ctx, component);
  if (c.type !== "SYMBOL") throw new ApiError("createInstance: the node isn't a component");
  ctx.write();
  const page = currentPage(ctx);
  const r = ctx.ed.engine.runCommand("INSERT_INSTANCE", { main: c.guid, x: 0, y: 0, parent: page });
  const id = r.created[0] ?? ctx.ed.engine.getSelection().refs[0];
  if (r.status !== Status.OK || !id) throw new ApiError(`Couldn't create an instance (status ${r.status})`);
  return refOf(ctx, id);
}

export function cloneNode(ctx: ApiContext, node: unknown): unknown {
  const n = mustNode(ctx, node);
  const [copy] = withSelection(ctx, [n.guid], () => ctx.ed.engine.command(n.type === "CANVAS" ? "DUPLICATE_PAGE" : "DUPLICATE"));
  if (!copy) throw new ApiError("Couldn't clone this node");
  // Figma: a clone keeps its place (DUPLICATE offsets top-level copies on the canvas).
  if (n.type !== "CANVAS") writeFields(ctx, copy, { transform: n.transform ?? IDENTITY }, "clone");
  return refOf(ctx, copy);
}

export function createNodeFromSvg(ctx: ApiContext, svg: string): unknown {
  const { message } = svgToMessage(svg);
  if (!message) throw new ApiError("Failed to parse the SVG");
  message.nodeChanges[0].transform = { ...IDENTITY };
  const [made] = withSelection(ctx, [], () => ctx.ed.engine.paste(message, { inPlace: true }));
  if (!made) throw new ApiError("Failed to import the SVG");
  return refOf(ctx, made);
}

// ---- Pages, selection, viewport ------------------------------------------------------------------------------------

export function setPage(ctx: ApiContext, page: unknown): void {
  const p = mustNode(ctx, page);
  if (p.type !== "CANVAS") throw new ApiError("Expected a page");
  if (currentPage(ctx) !== p.guid) ctx.ed.engine.setCurrentPage(p.guid);
}

export function viewport(ctx: ApiContext): Obj {
  const cam = ctx.ed.engine.getCamera();
  const c = ctx.ed.engine.viewCenter();
  const canvas = ctx.ed.canvas;
  const w = (canvas?.clientWidth ?? 1280) / (cam.zoom || 1);
  const h = (canvas?.clientHeight ?? 800) / (cam.zoom || 1);
  return { center: { x: c.x, y: c.y }, zoom: cam.zoom, bounds: { x: c.x - w / 2, y: c.y - h / 2, width: w, height: h } };
}

export function setViewport(ctx: ApiContext, v: Obj): void {
  const cur = ctx.ed.engine.viewCenter();
  const center = (v.center as { x: number; y: number } | undefined) ?? cur;
  const zoom = typeof v.zoom === "number" && v.zoom > 0 ? v.zoom : cur.zoom;
  ctx.ed.engine.centerOn(center.x, center.y, zoom);
}

export function scrollAndZoomIntoView(ctx: ApiContext, nodes: unknown): void {
  const ids = Array.isArray(nodes) ? nodes.filter((x): x is string => typeof x === "string") : [];
  if (!ids.length) return;
  const keep = [...ctx.ed.selection];
  ctx.ed.engine.setSelection(ids);
  ctx.ed.engine.command("ZOOM_TO_SELECTION");
  ctx.ed.engine.setSelection(keep);
}

export function selectionColors(ctx: ApiContext): Obj | null {
  const nodes = ctx.ed.selection.length ? ctx.ed.engine.readNodes(ctx.ed.selection, { subtree: true }) : [];
  if (!nodes.length) return null;
  const seen = new Set<string>();
  const paints: Obj[] = [];
  for (const n of nodes)
    for (const p of [...(n.fillPaints ?? []), ...(n.strokePaints ?? [])]) {
      if (p.type !== "SOLID") continue;
      const api = paintToApi(p);
      const key = JSON.stringify(api);
      if (seen.has(key)) continue;
      seen.add(key);
      paints.push(api);
    }
  return { paints, styles: [] };
}

// ---- Text ranges ------------------------------------------------------------------------------------------------

export function decorationStyleFromApi(v: unknown): string {
  if (v !== "SOLID" && v !== "WAVY" && v !== "DOTTED") throw new ApiError(`textDecorationStyle: invalid enum value '${String(v)}'`);
  return v;
}

/** A text's whole value of a range field (the node's own properties of the same names, nodes.ts). */
export const textFieldOf = (name: string) => RANGE_FIELDS[name];

const RANGE_FIELDS: Record<string, { field: string; toApi: (v: unknown) => unknown; fromApi?: (v: unknown) => NodeFields }> = {
  fontName: { field: "fontName", toApi: (v) => ({ family: (v as Obj).family, style: (v as Obj).style }), fromApi: (v) => ({ fontName: fontNameFromApi(v) }) },
  fontWeight: { field: "fontName", toApi: (v) => weightOf(String((v as Obj).style ?? "Regular")) },
  fontSize: { field: "fontSize", toApi: (v) => v, fromApi: (v) => ({ fontSize: Number(v) }) },
  lineHeight: { field: "lineHeight", toApi: (v) => lineHeightToApi(v as never), fromApi: (v) => ({ lineHeight: lineHeightFromApi(v) }) },
  letterSpacing: { field: "letterSpacing", toApi: (v) => letterSpacingToApi(v as never), fromApi: (v) => ({ letterSpacing: letterSpacingFromApi(v) }) },
  textCase: { field: "textCase", toApi: (v) => v ?? "ORIGINAL", fromApi: (v) => ({ textCase: v }) as NodeFields },
  textDecoration: { field: "textDecoration", toApi: (v) => v ?? "NONE", fromApi: (v) => ({ textDecoration: v }) as NodeFields },
  // The underline's look (Figma's TextDecorationStyle / Offset / Thickness / Color / SkipInk; null = the style's default)
  textDecorationStyle: { field: "textDecorationStyle", toApi: (v) => v ?? "SOLID", fromApi: (v) => ({ textDecorationStyle: decorationStyleFromApi(v) }) as NodeFields },
  textDecorationOffset: { field: "textUnderlineOffset", toApi: (v) => decorationMetricToApi(v as never), fromApi: (v) => ({ textUnderlineOffset: decorationMetricFromApi(v, "textDecorationOffset") }) as NodeFields },
  textDecorationThickness: { field: "textDecorationThickness", toApi: (v) => decorationMetricToApi(v as never), fromApi: (v) => ({ textDecorationThickness: decorationMetricFromApi(v, "textDecorationThickness") }) as NodeFields },
  textDecorationColor: { field: "textDecorationFillPaints", toApi: (v) => decorationColorToApi(v as never), fromApi: (v) => ({ textDecorationFillPaints: decorationColorFromApi(v) }) as NodeFields },
  textDecorationSkipInk: { field: "textDecorationSkipInk", toApi: (v) => v ?? false, fromApi: (v) => ({ textDecorationSkipInk: !!v }) as NodeFields },
  // A whole text's (no per-range value in the document): read for any range, written on the node
  textWrapStyle: { field: "textWrapStyle", toApi: (v) => v ?? "AUTO" },
  fills: { field: "fillPaints", toApi: (v) => ((v as Paint[] | undefined) ?? []).map(paintToApi), fromApi: (v) => ({ fillPaints: paintsFromApi(v, "fills") }) },
  hyperlink: {
    field: "hyperlink",
    toApi: (v) => {
      const h = v as { url?: string; guid?: string } | null;
      return h?.url ? { type: "URL", value: h.url } : h?.guid ? { type: "NODE", value: h.guid } : null;
    },
    fromApi: (v) => ({ hyperlink: v ? ((v as Obj).type === "NODE" ? { guid: (v as Obj).value } : { url: String((v as Obj).value ?? "") }) : null }) as NodeFields,
  },
};

function textLength(n: NodeChange): number {
  return (n.textData?.characters ?? "").length;
}

function checkRange(n: NodeChange, start: unknown, end: unknown): { from: number; to: number } {
  if (n.type !== "TEXT" && (n.type as string) !== "TEXT_PATH") throw new ApiError("Expected a text node");
  const len = textLength(n);
  if (typeof start !== "number" || typeof end !== "number" || start < 0 || end > len || start >= end) throw new ApiError(`Expected 0 <= start < end <= ${len}, got start=${String(start)} end=${String(end)}`);
  return { from: start, to: end };
}

export function getRange(ctx: ApiContext, id: Guid, name: string, start: unknown, end: unknown): unknown {
  const n = mustNode(ctx, id);
  const range = checkRange(n, start, end);
  const f = RANGE_FIELDS[name];
  if (!f) {
    if (name === "textStyleId" || name === "fillStyleId") return "";
    if (name === "listOptions") return { type: "NONE" };
    if (name === "indentation" || name === "listSpacing" || name === "paragraphIndent" || name === "paragraphSpacing") return (n as unknown as Obj)[name] ?? 0;
    if (name.startsWith("boundVariable:")) return null;
    throw new ApiError(`getRange${name.charAt(0).toUpperCase()}${name.slice(1)} is not supported in Wecra yet`);
  }
  const s = ctx.ed.engine.textRangeStyle(id, range);
  if (!s) return MIXED;
  if (s.mixed.includes(f.field)) return MIXED;
  const v = f.field === "fillPaints" ? (s.values.fillPaints ?? n.fillPaints) : (s.values as Obj)[f.field];
  return f.toApi(v ?? (n as unknown as Obj)[f.field]);
}

export function setRange(ctx: ApiContext, id: Guid, name: string, start: unknown, end: unknown, value: unknown): void {
  const n = mustNode(ctx, id);
  const range = checkRange(n, start, end);
  const f = RANGE_FIELDS[name];
  if (!f?.fromApi) throw new ApiError(`setRange${name.charAt(0).toUpperCase()}${name.slice(1)} is not supported in Wecra yet`);
  const fields = f.fromApi(value);
  ctx.write();
  ctx.ed.engine.setStyleRange(range);
  try {
    writeFields(ctx, id, fields, name);
  } finally {
    ctx.ed.engine.setStyleRange(null);
  }
}

/** useNativeBidiSupport(): the text laid out with the bidi layout (Type settings' "Update text rendering", for bidi). */
export function useNativeBidi(ctx: ApiContext, id: Guid): void {
  const n = mustNode(ctx, id);
  if (n.type !== "TEXT") throw new ApiError("in useNativeBidiSupport: Expected a text node");
  if (!pendingUpgrades(n as never).includes("bidi")) return;
  writeFields(ctx, id, { textBidiVersion: LATEST_TEXT_LAYOUT_VERSION } as NodeFields, "useNativeBidiSupport");
}

export function insertCharacters(ctx: ApiContext, id: Guid, start: number, chars: string): void {
  const n = mustNode(ctx, id);
  const text = n.textData?.characters ?? "";
  if (start < 0 || start > text.length) throw new ApiError(`Expected 0 <= start <= ${text.length}`);
  writeFields(ctx, id, { textData: { ...n.textData, characters: text.slice(0, start) + chars + text.slice(start), ...shiftStyles(n, start, start, chars.length) } } as NodeFields, "characters");
}

export function deleteCharacters(ctx: ApiContext, id: Guid, start: number, end: number): void {
  const n = mustNode(ctx, id);
  const range = checkRange(n, start, end);
  const text = n.textData?.characters ?? "";
  writeFields(ctx, id, { textData: { ...n.textData, characters: text.slice(0, range.from) + text.slice(range.to), ...shiftStyles(n, range.from, range.to, 0) } } as NodeFields, "characters");
}

/** The per-character style ids around an edit: [from, to) replaced by `inserted` characters of the style before. */
function shiftStyles(n: NodeChange, from: number, to: number, inserted: number): Obj {
  const ids = n.textData?.characterStyleIDs;
  if (!ids?.length) return {};
  const style = ids[Math.max(0, from - 1)] ?? 0;
  const next = [...ids.slice(0, from), ...new Array(inserted).fill(style), ...ids.slice(to)];
  return { characterStyleIDs: next };
}

export function styledSegments(ctx: ApiContext, id: Guid, fields: unknown, start: number, end: number): unknown {
  const n = mustNode(ctx, id);
  const len = textLength(n);
  const to = end < 0 ? len : end;
  if (!Array.isArray(fields)) throw new ApiError("getStyledTextSegments: expected a list of fields");
  const out: Obj[] = [];
  const text = n.textData?.characters ?? "";
  const valueAt = (i: number) => Object.fromEntries((fields as string[]).map((f) => [f, RANGE_FIELDS[f] ? getRange(ctx, id, f, i, i + 1) : undefined]));
  let segStart = start;
  let cur = len ? valueAt(start) : {};
  for (let i = start + 1; i <= to; i++) {
    const v = i < to ? valueAt(i) : null;
    if (!v || JSON.stringify(v) !== JSON.stringify(cur)) {
      out.push({ characters: text.slice(segStart, i), start: segStart, end: i, ...cur });
      if (v) {
        segStart = i;
        cur = v;
      }
    }
  }
  return out;
}

export function allFontNames(ctx: ApiContext, id: Guid, start: number, end: number): unknown {
  const n = mustNode(ctx, id);
  const names = new Map<string, Obj>();
  const add = (f: { family?: string; style?: string } | undefined) => f && names.set(`${f.family}/${f.style}`, { family: f.family, style: f.style });
  add(n.fontName);
  for (const s of n.textData?.styleOverrideTable ?? []) add((s as { fontName?: { family?: string; style?: string } }).fontName);
  void start;
  void end;
  return [...names.values()];
}

// ---- Images ------------------------------------------------------------------------------------------------------

/** Images made in this view by plugins (bytes kept until the store has them). */
const madeImages = new Map<string, Uint8Array>();

function imageSize(bytes: Uint8Array): { width: number; height: number } | null {
  const u32 = (i: number) => ((bytes[i] << 24) | (bytes[i + 1] << 16) | (bytes[i + 2] << 8) | bytes[i + 3]) >>> 0;
  if (bytes[0] === 0x89 && bytes[1] === 0x50) return { width: u32(16), height: u32(20) };
  if (bytes[0] === 0x47 && bytes[1] === 0x49) return { width: bytes[6] | (bytes[7] << 8), height: bytes[8] | (bytes[9] << 8) };
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    for (let i = 2; i + 9 < bytes.length; ) {
      if (bytes[i] !== 0xff) return null;
      const marker = bytes[i + 1];
      const len = (bytes[i + 2] << 8) | bytes[i + 3];
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return { width: (bytes[i + 7] << 8) | bytes[i + 8], height: (bytes[i + 5] << 8) | bytes[i + 6] };
      i += 2 + len;
    }
  }
  return null;
}

export function createImage(ctx: ApiContext, bytes: unknown): Obj {
  if (!(bytes instanceof Uint8Array)) throw new ApiError("createImage: expected a Uint8Array");
  if (!imageSize(bytes)) throw new ApiError("Image type is unsupported");
  const hash = sha1(bytes);
  madeImages.set(hash, bytes);
  const mime = bytes[0] === 0x89 ? "image/png" : bytes[0] === 0x47 ? "image/gif" : "image/jpeg";
  void ctx.ed.images.store?.put(bytes, mime).catch(() => {});
  return { hash };
}

export function imageByHash(ctx: ApiContext, hash: string): Obj | null {
  void ctx;
  return /^[0-9a-f]{40}$/.test(hash) ? { hash } : null;
}

export async function imageBytes(ctx: ApiContext, hash: string): Promise<Uint8Array> {
  const b = madeImages.get(hash) ?? (await ctx.ed.images.bytes(hash));
  if (!b) throw new ApiError(`Image ${hash} isn't available`);
  return b;
}

export async function imageSizeOf(ctx: ApiContext, hash: string): Promise<{ width: number; height: number }> {
  const s = imageSize(await imageBytes(ctx, hash));
  if (!s) throw new ApiError("Image type is unsupported");
  return s;
}

// ---- Export ------------------------------------------------------------------------------------------------------

export async function exportNode(ctx: ApiContext, id: Guid, settings: unknown): Promise<unknown> {
  const n = mustNode(ctx, id);
  // A page exports what is on it (PageNode.exportAsync): its top-level layers together.
  const refs = n.type === "CANVAS" ? ((n.childIds ?? []) as Guid[]) : [id];
  if (!refs.length) throw new ApiError("in exportAsync: the page is empty");
  // A viewer the file's export setting restricts (docs/governance.md §2.7): plugins don't export either (ours).
  if (!exportAllowed(ctx.ed)) throw new ApiError("in exportAsync: export is not allowed in this file");
  const s = (settings ?? { format: "PNG" }) as Obj;
  const format = String(s.format ?? "PNG");
  if (format === "JSON_REST_V1") throw new ApiError("exportAsync with JSON_REST_V1 is not supported in Wecra yet");
  const imageType = format === "JPG" ? "JPEG" : format === "SVG_STRING" ? "SVG" : format;
  if (!["PNG", "JPEG", "SVG", "PDF"].includes(imageType)) throw new ApiError(`exportAsync: unknown format ${format}`);
  const constraint = s.constraint as { type?: string; value?: number } | undefined;
  const engineSettings = {
    imageType,
    suffix: "",
    constraint: { type: constraint?.type === "WIDTH" ? "WIDTH" : constraint?.type === "HEIGHT" ? "HEIGHT" : "CONTENT_SCALE", value: constraint?.value ?? 1 },
    svgOutlineText: s.svgOutlineText !== false,
    svgIDMode: s.svgIdAttribute ? "ALWAYS" : "IF_NEEDED",
    contentsOnly: s.contentsOnly !== false,
    useAbsoluteBounds: !!s.useAbsoluteBounds,
  };
  const out = await renderEngineExport(ctx.ed.engine, (hash) => ctx.ed.images.bytes(hash), refs, engineSettings as never);
  if ("error" in out) throw new ApiError(out.error);
  if (format === "SVG_STRING") return new TextDecoder().decode(out.bytes);
  return out.bytes;
}

// ---- Styles ------------------------------------------------------------------------------------------------------

const STYLE_TYPE: Record<string, string> = { PAINT: "FILL", TEXT: "TEXT", EFFECT: "EFFECT", GRID: "GRID" };
const API_STYLE_TYPE: Record<string, string> = { FILL: "PAINT", TEXT: "TEXT", EFFECT: "EFFECT", GRID: "GRID" };

export function localStyles(ctx: ApiContext, type: string): Obj[] {
  return ctx.ed.engine
    .styles(STYLE_TYPE[type] as never)
    .filter((s) => !s.remote)
    .map((s) => ({ id: s.id, type: API_STYLE_TYPE[s.styleType] ?? type }));
}

export function styleById(ctx: ApiContext, id: string): Obj | null {
  const s = ctx.ed.engine.styles().find((x) => x.id === id);
  return s ? { id: s.id, type: API_STYLE_TYPE[s.styleType] ?? "PAINT" } : null;
}

export function createStyle(ctx: ApiContext, type: string): Obj {
  ctx.write();
  const r = ctx.ed.engine.runCommand("CREATE_STYLE", { type: STYLE_TYPE[type] ?? "FILL" });
  const id = r.created[0];
  if (!id) throw new ApiError(`Couldn't create a ${type.toLowerCase()} style`);
  return { id, type };
}

export function styleGet(ctx: ApiContext, id: string, field: string): unknown {
  const s = ctx.ed.engine.styles().find((x) => x.id === id);
  if (!s) throw new ApiError(`The style ${id} does not exist`);
  switch (field) {
    case "name":
      return s.name;
    case "description":
      return s.description;
    case "type":
      return API_STYLE_TYPE[s.styleType] ?? "PAINT";
    case "key":
      return s.key;
    case "remote":
      return s.remote;
    case "documentationLinks":
      return [];
    case "paints":
      return (s.fillPaints ?? []).map(paintToApi);
    case "effects":
      return (s.effects ?? []).map(effectToApi);
    case "fontName":
      return s.text ? { family: s.text.fontName.family, style: s.text.fontName.style } : null;
    case "fontSize":
      return s.text?.fontSize ?? 12;
    default:
      return (s.text as Obj | undefined)?.[field] ?? null;
  }
}

export function styleSet(ctx: ApiContext, id: string, field: string, value: unknown): void {
  const s = ctx.ed.engine.styles().find((x) => x.id === id);
  if (!s) throw new ApiError(`The style ${id} does not exist`);
  const fields: NodeFields =
    field === "name"
      ? { name: String(value) }
      : field === "description"
        ? ({ description: String(value) } as NodeFields)
        : field === "paints"
          ? { fillPaints: paintsFromApi(value, "paints") }
          : field === "fontSize"
            ? { fontSize: Number(value) }
            : field === "fontName"
              ? { fontName: fontNameFromApi(value) }
              : (() => {
                  throw new ApiError(`Setting ${field} on a style is not supported in Wecra yet`);
                })();
  writeFields(ctx, id, fields, field);
}

// ---- Variables ---------------------------------------------------------------------------------------------------

export function localVariables(ctx: ApiContext, type: string | null): Obj[] {
  return ctx.ed.engine
    .variables()
    .filter((v) => !v.remote && (!type || v.resolvedType === type))
    .map((v) => ({ id: v.id }));
}

/** figma.variables.getSubscribedVariables: the library variables this file holds copies of (`remote`). */
export function subscribedVariables(ctx: ApiContext, type: string | null): Obj[] {
  return ctx.ed.engine
    .variables()
    .filter((v) => v.remote && (!type || v.resolvedType === type))
    .map((v) => ({ id: v.id }));
}

export function localCollections(ctx: ApiContext): Obj[] {
  return ctx.ed.engine
    .variableCollections()
    .filter((c) => !(c as unknown as Obj).remote)
    .map((c) => ({ id: c.id }));
}

export function variableGet(ctx: ApiContext, id: string, field: string): unknown {
  const v = ctx.ed.engine.variable(id);
  if (!v) throw new ApiError(`The variable ${id} does not exist`);
  switch (field) {
    case "variableCollectionId":
      return v.collectionId;
    case "valuesByMode":
      return Object.fromEntries(Object.entries(v.valuesByMode).map(([m, x]) => [m, x && typeof x === "object" && "alias" in (x as unknown as Obj) ? { type: "VARIABLE_ALIAS", id: (x as unknown as Obj).alias } : x]));
    default:
      return (v as unknown as Obj)[field] ?? null;
  }
}

export function variableSet(ctx: ApiContext, id: string, field: string, value: unknown): void {
  ctx.write();
  const run = (name: Parameters<typeof ctx.ed.engine.runCommand>[0], args: Obj) => {
    const r = ctx.ed.engine.runCommand(name, args as never);
    if (r.status !== Status.OK) throw new ApiError(`in set_${field}: the variable refused (status ${r.status})`);
  };
  if (field === "name") run("RENAME_VARIABLE", { variable: id, name: String(value) });
  else if (field === "description") run("SET_VARIABLE_DESCRIPTION", { variable: id, description: String(value) });
  else if (field === "hiddenFromPublishing") run("SET_VARIABLE_HIDDEN", { variables: [id], hidden: !!value });
  else if (field === "scopes") run("SET_VARIABLE_SCOPES", { variables: [id], scopes: value });
  else throw new ApiError(`Cannot assign to read only property '${field}' of Variable`);
}

export function variableSetValue(ctx: ApiContext, id: string, mode: string, value: unknown): void {
  ctx.write();
  const v = value && typeof value === "object" && (value as Obj).type === "VARIABLE_ALIAS" ? { alias: (value as Obj).id } : value;
  const r = ctx.ed.engine.runCommand("SET_VARIABLE_VALUE", { variable: id, mode, value: v as never });
  if (r.status !== Status.OK) throw new ApiError(`setValueForMode: the value was refused (status ${r.status})`);
}

export function createVariable(ctx: ApiContext, name: string, collection: unknown, type: unknown): Obj {
  if (typeof collection !== "string") throw new ApiError("createVariable: expected a collection");
  if (!["BOOLEAN", "FLOAT", "STRING", "COLOR"].includes(String(type))) throw new ApiError(`createVariable: invalid type ${String(type)}`);
  ctx.write();
  const r = ctx.ed.engine.runCommand("CREATE_VARIABLE", { collection, type: String(type), name });
  const id = r.created[0];
  if (!id) throw new ApiError(`Couldn't create the variable (status ${r.status})`);
  return { id };
}

export function createCollection(ctx: ApiContext, name: string): Obj {
  ctx.write();
  const r = ctx.ed.engine.runCommand("CREATE_VARIABLE_COLLECTION", { name });
  const id = r.created[0];
  if (!id) throw new ApiError(`Couldn't create the collection (status ${r.status})`);
  return { id };
}

export function collectionGet(ctx: ApiContext, id: string, field: string): unknown {
  const c = ctx.ed.engine.variableCollections().find((x) => x.id === id);
  if (!c) throw new ApiError(`The collection ${id} does not exist`);
  if (field === "modes") return c.modes.map((m) => ({ modeId: m.modeId, name: m.name }));
  return (c as unknown as Obj)[field] ?? null;
}

export function collectionSet(ctx: ApiContext, id: string, field: string, value: unknown): void {
  if (field !== "name") throw new ApiError(`Cannot assign to read only property '${field}' of VariableCollection`);
  ctx.write();
  ctx.ed.engine.runCommand("RENAME_VARIABLE_COLLECTION", { collection: id, name: String(value) });
}

export function collectionMode(ctx: ApiContext, op: "add" | "rename" | "remove", id: string, a: unknown, b?: unknown): unknown {
  ctx.write();
  if (op === "add") {
    const r = ctx.ed.engine.runCommand("ADD_VARIABLE_MODE", { collection: id, name: String(a ?? "Mode") });
    return r.created[0] ?? null;
  }
  if (op === "rename") return void ctx.ed.engine.runCommand("RENAME_VARIABLE_MODE", { collection: id, mode: String(a), name: String(b) });
  return void ctx.ed.engine.runCommand("DELETE_VARIABLE_MODE", { collection: id, mode: String(a) });
}

export function bindVariable(ctx: ApiContext, id: Guid, field: string, variable: unknown): void {
  ctx.write();
  const target = field.replace(/[A-Z]/g, (c) => `_${c}`).toUpperCase();
  const r = variable
    ? ctx.ed.engine.runCommand("BIND_VARIABLE", { refs: [id], target, variable: String(variable) })
    : ctx.ed.engine.runCommand("DETACH_VARIABLE", { refs: [id], target });
  if (r.status !== Status.OK) throw new ApiError(`setBoundVariable: ${field} can't be bound here (status ${r.status})`);
}

export function setVariableMode(ctx: ApiContext, id: Guid, collection: unknown, mode: unknown): void {
  const n = mustNode(ctx, id);
  ctx.write();
  // A page's explicit mode is the page's own (the command's `page`), a layer's its `refs`.
  const target = n.type === "CANVAS" ? { page: id } : { refs: [id] };
  ctx.ed.engine.runCommand("SET_VARIABLE_MODE", { ...target, collection: String(collection), mode: mode === null ? "" : String(mode) } as never);
}

/** The file's own fonts and the bundled faces (figma.listAvailableFontsAsync). */
export function availableFonts(ctx: ApiContext): Obj[] {
  const seen = new Set<string>();
  const out: Obj[] = [];
  const add = (family: string, style: string) => {
    const k = `${family}/${style}`;
    if (seen.has(k)) return;
    seen.add(k);
    out.push({ fontName: { family, style } });
  };
  for (const f of ctx.ed.engine.documentFonts()) add(f.family, f.style);
  for (const s of ["Thin", "Light", "Regular", "Medium", "Semi Bold", "Bold", "Extra Bold", "Black", "Italic", "Bold Italic"]) add("Inter", s);
  return out;
}

export { ref };
