/**
 * The MCP tools (src/shared/agents/tools.ts) on the open file: reads through the engine's reads, writes as
 * NODE_CHANGES through the engine (one transaction per call; the turn recorder, turns.ts, makes a chat turn's calls
 * one undo step). Runs in the editor view that holds the file — main forwards each call here.
 */
import type { Guid, Message, NodeChange } from "@/engine/codec";
import { keyAfter, keyBetween } from "@shared/schema/fractionalIndex";
import { TOOL_BY_NAME, textResult, type ToolResult } from "@shared/agents/tools";
import type { EditorController } from "../controller";
import { cssOf } from "../model/exports";
import { applyStyle, newNodeGuid } from "../variables";
import { autoLayoutFields, colorHex, CREATABLE_TYPES, defaults, describeNode, describePaints, fieldsOf, IDENTITY, nodeTypeOf, normId, notTaken, parseColor, parseEffects, parsePaints, readProps, solid, typeName, type Rejection, type Spec } from "./nodeSpec";
import { fromTool, sameValue, toTool } from "@shared/agents/docSchema";
import { propForField } from "@shared/agents/layerProps";
import { MODEL } from "@shared/schema/model";
import { CommandId } from "@/engine/abi";
import { COMMAND_BY_ID, COMMANDS, comboText, isEnabled } from "../commands";
import { ENGINE_COMMAND_DOCS } from "./engineCommands.generated";
import { base64, encodePng } from "./png";
import { responsiveVariant } from "./responsive";
import { base64Bytes, isImageArg, MAX_IMAGE_BYTES, sniffImage, type ImageArg } from "@shared/agents/images";
import { mediaPaint } from "../model/paints";
import type { ImportedImage } from "../images";
import { landInBox, type Box } from "./imagePlaceholder";

export interface ToolEnv {
  ed: EditorController;
  /** Runs `fn` as one write (a transaction of the agent's turn); returns what fn returns */
  write<T>(label: string, fn: () => T): T;
}

const MAX_NODES = 600;

type Tree = { node: NodeChange; children: Tree[] };

export class ToolError extends Error {}

/** The refs a call is about: `nodeId` / `nodeIds`, else the selection. */
function targets(env: ToolEnv, args: Spec, fallbackToPage = false): Guid[] {
  const ids = Array.isArray(args.nodeIds) ? (args.nodeIds as unknown[]).map(normId).filter(Boolean) : args.nodeId ? [normId(args.nodeId)] : [];
  if (ids.length) {
    const missing = ids.filter((id) => !env.ed.engine.readNode(id, { fields: ["name"] }));
    if (missing.length) throw new ToolError(`No layer ${missing.join(", ")} in this file. Use get_metadata to find ids.`);
    return ids;
  }
  const sel = env.ed.selection;
  if (sel.length) return [...sel];
  if (fallbackToPage) return [];
  throw new ToolError("Nothing is selected: pass a nodeId (get_metadata lists the page's layers).");
}

const read = (env: ToolEnv, id: Guid, fields?: string[]) => env.ed.engine.readNode(id, { childIds: true, ...(fields ? { fields } : {}) });

function must(env: ToolEnv, id: Guid): NodeChange {
  const n = read(env, normId(id));
  if (!n) throw new ToolError(`No layer ${id} in this file.`);
  return env.ed.withRealType(n);
}

const parentOf = (env: ToolEnv, n: NodeChange) => (n.parentIndex?.guid ? read(env, n.parentIndex.guid) : null);

/** The page a layer is on. */
export function pageOf(env: ToolEnv, id: Guid): Guid | null {
  let n = read(env, id, ["parentIndex", "type"]);
  for (let i = 0; n && i < 400; i++) {
    if (n.type === "CANVAS") return n.guid;
    n = n.parentIndex?.guid ? read(env, n.parentIndex.guid, ["parentIndex", "type"]) : null;
  }
  return null;
}

const currentPage = (env: ToolEnv) => env.ed.store.page;

/** `refs` with their descendants to `depth`, as trees (one read). */
function trees(env: ToolEnv, refs: readonly Guid[], depth: number, fields?: string[]): { roots: Tree[]; count: number; truncated: boolean } {
  const all = env.ed.engine.readNodes(refs, { subtree: true, childIds: true, ...(fields ? { fields: [...fields, "parentIndex"] } : {}) }).map(env.ed.withRealType);
  const byId = new Map(all.map((n) => [n.guid, n]));
  let count = 0;
  let truncated = false;
  const build = (id: Guid, level: number): Tree | null => {
    const node = byId.get(id);
    if (!node) return null;
    if (++count > MAX_NODES) {
      truncated = true;
      return null;
    }
    const kids = level < depth ? ((node.childIds ?? []) as Guid[]).map((c) => build(c, level + 1)).filter((t): t is Tree => !!t) : [];
    if (level >= depth && (node.childIds?.length ?? 0) > 0) truncated = true;
    return { node, children: kids };
  };
  const roots = refs.map((r) => build(r, 0)).filter((t): t is Tree => !!t);
  return { roots, count: Math.min(count, MAX_NODES), truncated };
}

const xmlEsc = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

function toXml(t: Tree, indent = ""): string {
  const n = t.node;
  const tag = typeName(n.type).toLowerCase().replace(/_/g, "-");
  const tr = n.transform ?? IDENTITY;
  const attrs = [`id="${n.guid}"`, `name="${xmlEsc(n.name ?? "")}"`];
  if (n.type !== "CANVAS") attrs.push(`x="${Math.round(tr.m02)}"`, `y="${Math.round(tr.m12)}"`, `width="${Math.round(n.size?.x ?? 0)}"`, `height="${Math.round(n.size?.y ?? 0)}"`);
  if (n.visible === false) attrs.push(`hidden="true"`);
  if (!t.children.length) return `${indent}<${tag} ${attrs.join(" ")} />`;
  return `${indent}<${tag} ${attrs.join(" ")}>\n${t.children.map((c) => toXml(c, indent + "  ")).join("\n")}\n${indent}</${tag}>`;
}

// ---- Reads ------------------------------------------------------------------------------------------------------------

function brief(env: ToolEnv, n: NodeChange) {
  const t = n.transform ?? IDENTITY;
  return { id: n.guid, name: n.name ?? "", type: typeName(env.ed.withRealType(n).type), x: Math.round(t.m02), y: Math.round(t.m12), width: Math.round(n.size?.x ?? 0), height: Math.round(n.size?.y ?? 0) };
}

function getSelection(env: ToolEnv): ToolResult {
  const page = currentPage(env);
  const pageNode = page ? read(env, page, ["name"]) : null;
  const sel = env.ed.selection.map((id) => read(env, id)).filter((n): n is NodeChange => !!n);
  return textResult({
    file: env.ed.ui.get().fileName,
    page: { id: page, name: pageNode?.name ?? "" },
    pages: env.ed.engine.pages().map((p) => ({ id: p.guid ?? (p as { id?: string }).id, name: p.name })),
    selection: sel.map((n) => brief(env, n)),
  });
}

function getMetadata(env: ToolEnv, args: Spec): ToolResult {
  let refs = targets(env, args, true);
  const depth = typeof args.depth === "number" ? Math.max(0, Math.min(20, args.depth)) : 6;
  const pages = env.ed.engine.pages().map((p) => `<page-ref id="${p.guid}" name="${xmlEsc(p.name ?? "")}"${p.guid === currentPage(env) ? ' current="true"' : ""} />`).join("\n");
  const listPages = !refs.length;
  if (!refs.length) {
    // No selection: the current page with its top-level layers (and the file's pages).
    const page = currentPage(env);
    refs = page ? [page] : [];
  }
  const { roots, truncated } = trees(env, refs, depth, ["name", "type", "size", "transform", "visible"]);
  return textResult((listPages ? `<pages>\n${pages}\n</pages>\n` : "") + roots.map((t) => toXml(t)).join("\n") + (truncated ? `\n<!-- deeper layers left out: call get_metadata on a child id -->` : ""));
}

function variableNames(env: ToolEnv): Map<string, string> {
  const map = new Map<string, string>();
  try {
    for (const v of env.ed.engine.variables(undefined, { includeRemote: true })) map.set(v.id, v.name);
  } catch {
    /* an engine without variables */
  }
  return map;
}

function styleNames(env: ToolEnv): Map<string, string> {
  const map = new Map<string, string>();
  try {
    for (const s of env.ed.engine.styles(undefined, { includeRemote: true })) map.set(s.id, s.name);
  } catch {
    /* none */
  }
  return map;
}

const styleRef = (v: unknown): string | null => {
  if (!v || typeof v !== "object") return null;
  const g = (v as { guid?: unknown }).guid;
  if (typeof g === "string") return g;
  if (g && typeof g === "object") return `${(g as { sessionID: number }).sessionID}:${(g as { localID: number }).localID}`;
  return null;
};

function getDesignContext(env: ToolEnv, args: Spec): ToolResult {
  const refs = targets(env, args);
  const depth = typeof args.depth === "number" ? Math.max(0, Math.min(20, args.depth)) : 8;
  const { roots, count, truncated } = trees(env, refs, depth);
  const vars = variableNames(env);
  const styles = styleNames(env);
  const parents = new Map<Guid, NodeChange | null>();
  const describe = (t: Tree, parent: NodeChange | null): Record<string, unknown> => {
    parents.set(t.node.guid, parent);
    const d = describeNode(t.node, parent);
    // Variables and styles it uses, by name.
    try {
      const bound = env.ed.engine.boundVariables(t.node.guid).filter((b) => b.variable);
      if (bound.length) d.boundVariables = Object.fromEntries(bound.map((b) => [b.target, { id: b.variable, name: vars.get(b.variable!) ?? b.variable }]));
    } catch {
      /* none */
    }
    const used: Record<string, string> = {};
    for (const [slot, field] of [["fill", "styleIdForFill"], ["stroke", "styleIdForStrokeFill"], ["text", "styleIdForText"], ["effect", "styleIdForEffect"]] as const) {
      const id = styleRef((t.node as unknown as Record<string, unknown>)[field]);
      if (id && styles.has(id)) used[slot] = styles.get(id)!;
    }
    if (Object.keys(used).length) d.styles = used;
    if (t.node.type === "INSTANCE") {
      const info = env.ed.engine.componentInfo(t.node.guid) as { mainName?: string; main?: { name?: string } } | null;
      const main = info?.main?.name ?? info?.mainName;
      if (main) d.component = main;
    }
    if (t.children.length) d.children = t.children.map((c) => describe(c, t.node));
    else if ((t.node.childIds?.length ?? 0) > 0) d.childCount = t.node.childIds!.length;
    return d;
  };
  const out = roots.map((t) => {
    const parentNode = t.node.parentIndex?.guid ? read(env, t.node.parentIndex.guid) : null;
    const d = describe(t, parentNode);
    return { ...d, css: cssOf(t.node as never) };
  });
  return textResult({ nodes: out, layers: count, ...(truncated ? { note: "Deeper or further layers were left out: call get_design_context on a child id." } : {}) });
}

async function getScreenshot(env: ToolEnv, args: Spec): Promise<ToolResult> {
  const refs = targets(env, args, true);
  const maxSize = typeof args.maxSize === "number" ? Math.max(32, Math.min(2048, args.maxSize)) : 1024;
  let w = 0;
  let h = 0;
  if (refs.length) {
    const n = must(env, refs[0]);
    w = n.size?.x ?? 0;
    h = n.size?.y ?? 0;
  }
  const scale = w && h ? Math.min(2, maxSize / Math.max(w, h)) : 1;
  const settings = { imageType: "PNG" as const, constraint: { type: "CONTENT_SCALE" as const, value: scale } };
  const deadline = Date.now() + 5000;
  let out = env.ed.engine.exportNodes(refs.slice(0, 1), settings as never);
  while (out.status === "busy" && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 60));
    out = env.ed.engine.exportNodes(refs.slice(0, 1), settings as never);
  }
  if (out.status === "busy") out = env.ed.engine.exportNodes(refs.slice(0, 1), settings as never, { allowPending: true });
  if (out.status !== "ok" || !("pixels" in out)) return textResult(`Couldn't draw the screenshot${out.status === "error" ? `: ${out.message}` : ""}.`, true);
  let p = out.pixels;
  // The page's canvas (no layer) can be large: shrunk by sampling.
  if (Math.max(p.width, p.height) > maxSize) p = shrink(p, maxSize / Math.max(p.width, p.height));
  const png = await encodePng(p.width, p.height, p.pixels as Uint8Array);
  return { content: [{ type: "image", data: base64(png), mimeType: "image/png" }, { type: "text", text: `${p.width} × ${p.height} px${refs[0] ? ` of ${refs[0]}` : " of the current page"}` }] };
}

function shrink(p: { width: number; height: number; pixels: Uint8Array | Uint8ClampedArray }, k: number) {
  const width = Math.max(1, Math.round(p.width * k));
  const height = Math.max(1, Math.round(p.height * k));
  const out = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const sx = Math.min(p.width - 1, Math.floor(x / k));
      const sy = Math.min(p.height - 1, Math.floor(y / k));
      out.set(p.pixels.subarray((sy * p.width + sx) * 4, (sy * p.width + sx) * 4 + 4), (y * width + x) * 4);
    }
  return { width, height, pixels: out };
}

function getVariableDefs(env: ToolEnv, args: Spec): ToolResult {
  const e = env.ed.engine;
  const valueText = (v: unknown): unknown => {
    if (!v || typeof v !== "object") return v;
    const o = v as Record<string, unknown>;
    if ("r" in o && "g" in o && "b" in o) return colorText(o as never);
    if ("value" in o) return valueText(o.value);
    return v;
  };
  if (args.all === true) {
    const collections = e.variableCollections({ includeRemote: true }).map((c) => ({
      id: c.id,
      name: c.name,
      modes: c.modes.map((m) => ({ id: m.modeId, name: m.name })),
      variables: c.variableIds.map((id) => e.variable(id)).filter((v): v is NonNullable<typeof v> => !!v).map((v) => ({ id: v.id, name: v.name, type: v.resolvedType, values: Object.fromEntries(c.modes.map((m) => [m.name, valueText(v.resolvedValuesByMode[m.modeId] ?? v.valuesByMode[m.modeId])])) })),
    }));
    const styles = e.styles(undefined, { includeRemote: true }).map((s) => ({ id: s.id, name: s.name, type: s.styleType }));
    return textResult({ collections, styles });
  }
  const refs = targets(env, args);
  const all = e.readNodes(refs, { subtree: true, fields: ["name"] }).slice(0, 2000);
  const used: Record<string, unknown> = {};
  const names = variableNames(env);
  for (const n of all) {
    let bound: ReturnType<typeof e.boundVariables> = [];
    try {
      bound = e.boundVariables(n.guid);
    } catch {
      bound = [];
    }
    for (const b of bound) {
      if (!b.variable) continue;
      const name = names.get(b.variable) ?? b.variable;
      used[name] = { id: b.variable, value: valueText(b.resolved) };
    }
  }
  return textResult(Object.keys(used).length ? used : "No variables are used here. Call with all: true for the file's variables and styles.");
}

const colorText = (c: { r: number; g: number; b: number; a?: number }) => {
  const b = (x: number) => Math.round(x * 255).toString(16).padStart(2, "0");
  return `#${b(c.r)}${b(c.g)}${b(c.b)}${c.a !== undefined && c.a < 1 ? b(c.a) : ""}`.toUpperCase();
};

// ---- Writes -----------------------------------------------------------------------------------------------------------

/** The position key after the parent's top child (layers are made on top). */
function topKey(env: ToolEnv, parent: Guid): string {
  const p = read(env, parent);
  const last = p?.childIds?.[p.childIds.length - 1];
  const pos = last ? read(env, last, ["parentIndex"])?.parentIndex?.position : undefined;
  return pos ? keyAfter(pos) : keyBetween("", null);
}

/** Where a new top-level frame goes: right of everything on the page (100 apart, as Figma places new frames). */
function freeSpot(env: ToolEnv, page: Guid): { x: number; y: number } {
  const p = read(env, page);
  let right = -Infinity;
  let top = 0;
  for (const id of (p?.childIds ?? []) as Guid[]) {
    const n = read(env, id, ["size", "transform"]);
    if (!n) continue;
    const r = (n.transform?.m02 ?? 0) + (n.size?.x ?? 0);
    if (r > right) {
      right = r;
      top = n.transform?.m12 ?? 0;
    }
  }
  return right === -Infinity ? { x: 0, y: 0 } : { x: Math.round(right + 100), y: Math.round(top) };
}

// ---- Per-node results ---------------------------------------------------------------------------------------------------

interface NodeResult {
  nodeId: Guid;
  name?: string;
  applied: string[];
  rejected: Rejection[];
  notApplied: { property: string; requested: unknown; actual: unknown; reason: string }[];
  values: Record<string, unknown>;
}

/** A write's result: per node what was applied, refused and didn't take, and the values read back from the engine. */
function writeResult(kind: string, results: NodeResult[], extra: Record<string, unknown> = {}): ToolResult {
  const problems = results.flatMap((r) => [...r.rejected.map((x) => `${r.nodeId} ${x.property}: ${x.reason}`), ...r.notApplied.map((x) => `${r.nodeId} ${x.property}: asked ${JSON.stringify(x.requested)}, is ${JSON.stringify(x.actual)} — ${x.reason}`)]);
  const anyApplied = results.some((r) => r.applied.length > r.notApplied.length) || !!extra.created;
  const summary = problems.length ? `${kind}: ${problems.length} propert${problems.length === 1 ? "y was" : "ies were"} NOT applied — ${problems.slice(0, 12).join("; ")}${problems.length > 12 ? " …" : ""}` : `${kind}: everything applied.`;
  const r = textResult({ summary, ...extra, nodes: results.map((x) => ({ nodeId: x.nodeId, ...(x.name !== undefined ? { name: x.name } : {}), applied: x.applied, ...(x.rejected.length ? { rejected: x.rejected } : {}), ...(x.notApplied.length ? { notApplied: x.notApplied } : {}), values: x.values })) }, !anyApplied && problems.length > 0);
  r.touched = results.filter((x) => x.applied.length).map((x) => x.nodeId);
  return r;
}

/** Sets instance property values with the engine's command (Figma's "Set property"). */
function setComponentProps(env: ToolEnv, id: Guid, values: unknown): Rejection[] {
  if (!values || typeof values !== "object" || Array.isArray(values)) return [{ property: "componentProperties", reason: "an object {name: value}" }];
  const info = env.ed.engine.componentInfo(id);
  const props = info?.properties ?? [];
  const out: Rejection[] = [];
  for (const [k, v] of Object.entries(values as Record<string, unknown>)) {
    const def = props.find((p) => p.name === k || p.apiName === k || p.id === k);
    if (!def) {
      out.push({ property: `componentProperties.${k}`, reason: `no such property (has ${props.map((p) => p.name).join(", ") || "none"})` });
      continue;
    }
    const status = env.ed.engine.runCommand("SET_COMPONENT_PROPERTY", { ref: id, prop: def.id, value: v as never }).status;
    if (status !== 0) out.push({ property: `componentProperties.${k}`, reason: `the engine refused ${JSON.stringify(v)} (status ${status}; ${def.type}${def.variantOptions.length ? `: ${def.variantOptions.join(", ")}` : ""})` });
  }
  return out;
}

const componentPropsOf = (env: ToolEnv, id: Guid) => {
  const info = env.ed.engine.componentInfo(id);
  if (!info?.properties.length) return undefined;
  return Object.fromEntries(info.properties.map((p) => [p.name, p.value]));
};

/** Applies a spec to an existing layer, reads it back and says what didn't take. */
function applySpec(env: ToolEnv, id: Guid, spec0: Spec, opts: { creating?: boolean; skip?: string[] } = {}): NodeResult {
  const { [IMAGE_KEY]: image, ...spec } = spec0 as Spec & { [IMAGE_KEY]?: PlacedImage };
  const r = applySpecFields(env, id, spec, opts);
  if (!image) return r;
  const status = env.ed.engine.setProps([id], { fillPaints: imageFill(image) as never });
  if (status !== 0) r.rejected.push({ property: "image", reason: `the engine refused the image fill (status ${status})` });
  else {
    r.applied.push("image");
    r.values.image = { imageHash: image.img.hash, width: image.img.width, height: image.img.height, scaleMode: image.scaleMode };
  }
  return r;
}

function applySpecFields(env: ToolEnv, id: Guid, spec: Spec, opts: { creating?: boolean; skip?: string[] } = {}): NodeResult {
  const n0 = read(env, id);
  if (!n0) return { nodeId: id, applied: [], rejected: [{ property: "nodeId", reason: "no such layer" }], notApplied: [], values: {} };
  const n = env.ed.withRealType(n0);
  const parent = parentOf(env, n);
  const { fields, applied, rejected } = fieldsOf(spec, n, parent, !!opts.creating, opts.skip ?? []);
  if (Object.keys(fields).length) {
    const status = env.ed.engine.setProps([id], fields);
    if (status !== 0) return { nodeId: id, applied: [], rejected: [...rejected, ...applied.map((property) => ({ property, reason: `the engine refused the change (status ${status}${status === -6 ? ": read-only — a library copy" : ""})` }))], notApplied: [], values: {} };
  }
  if (applied.includes("componentProperties")) rejected.push(...setComponentProps(env, id, spec.componentProperties));
  const after = env.ed.withRealType(read(env, id)!);
  const parentAfter = parentOf(env, after);
  const expected = { ...n, ...fields } as NodeChange;
  const notApplied = notTaken(applied, expected, parent, after, parentAfter);
  const asked = [...applied, ...rejected.map((r) => r.property)].filter((k) => k !== "componentProperties");
  const values = readProps(after, parentAfter, asked);
  if (applied.includes("componentProperties")) values.componentProperties = componentPropsOf(env, id);
  return { nodeId: id, name: after.name, applied: applied.filter((k) => !notApplied.some((x) => x.property === k) && !rejected.some((r) => r.property.startsWith(k + "."))), rejected, notApplied, values };
}

// ---- Images (place_image, `image` in create_nodes / update_nodes) ----------------------------------------------------

/** A spec's image after import (the `image` argument is replaced by it before the write). */
interface PlacedImage {
  img: ImportedImage;
  scaleMode: "FILL" | "FIT" | "STRETCH" | "TILE";
}
const IMAGE_KEY = "__placedImage";

/** The Plugin API's scale modes → the document's (CROP is STRETCH there). */
const SCALE_MODES: Record<string, PlacedImage["scaleMode"]> = { FILL: "FILL", FIT: "FIT", CROP: "STRETCH", STRETCH: "STRETCH", TILE: "TILE" };

const imageFill = (p: PlacedImage) => [{ ...mediaPaint(p.img), imageScaleMode: p.scaleMode }];

/** The image's bytes (main has read a `path` into `data` already) imported into the file's images, as Place image does. */
async function importImageArg(env: ToolEnv, arg: ImageArg, at = "image"): Promise<PlacedImage> {
  if (!env.ed.images.store) throw new ToolError("Images can't be added to this file.");
  if (typeof arg.data !== "string") throw new ToolError(`${at}: give \`path\` (a file in your working folder) or \`data\` (base64 bytes)${typeof arg.path === "string" ? " — this path wasn't read by the app" : ""}`);
  const bytes = base64Bytes(arg.data);
  if (!bytes) throw new ToolError(`${at}.data: not base64`);
  if (bytes.length > MAX_IMAGE_BYTES) throw new ToolError(`${at}: larger than ${MAX_IMAGE_BYTES / 1024 / 1024} MB`);
  const mime = sniffImage(bytes);
  if (!mime) throw new ToolError(`${at}: not a PNG, JPEG, WebP or GIF`);
  const name = (typeof arg.name === "string" && arg.name.trim() ? arg.name.trim() : "Image").slice(0, 120);
  const file = new File([bytes as BlobPart], `${name}.${mime.split("/")[1]}`, { type: mime });
  const [img] = await env.ed.images.import([file]);
  if (!img) throw new ToolError(`${at}: the image couldn't be decoded`);
  const scale = typeof arg.scaleMode === "string" ? SCALE_MODES[arg.scaleMode.toUpperCase()] : "FILL";
  if (!scale) throw new ToolError(`${at}.scaleMode: one of FILL, FIT, CROP, TILE`);
  return { img: { ...img, name }, scaleMode: scale };
}

/** A new layer without a size takes the image's (one side given: the other keeps the aspect ratio). */
function sizeFromImage(spec: Spec, img: ImportedImage) {
  const w = typeof spec.width === "number" ? spec.width : undefined;
  const h = typeof spec.height === "number" ? spec.height : undefined;
  if (w === undefined && h === undefined) Object.assign(spec, { width: img.width, height: img.height });
  else if (w === undefined && h !== undefined) spec.width = Math.round((h * img.width) / Math.max(1, img.height));
  else if (h === undefined && w !== undefined) spec.height = Math.round((w * img.height) / Math.max(1, img.width));
}

/** Imports every `image` of a create_nodes / update_nodes call first (async), replacing it with the imported image. */
async function importSpecImages(env: ToolEnv, specs: Spec[], creating: boolean, at: string): Promise<Spec[]> {
  return Promise.all(
    specs.map(async (spec, i) => {
      if (!spec || typeof spec !== "object") return spec;
      const out: Spec = { ...spec };
      if (isImageArg(spec.image)) {
        const placed = await importImageArg(env, spec.image, `${at}[${i}].image`);
        delete out.image;
        out[IMAGE_KEY] = placed;
        if (creating) sizeFromImage(out, placed.img);
      }
      if (Array.isArray(spec.children)) out.children = await importSpecImages(env, spec.children as Spec[], creating, `${at}[${i}].children`);
      return out;
    })
  );
}

const placeholderBox = (v: unknown): Box | null => {
  const b = v as Partial<Box> | null | undefined;
  return b && [b.x, b.y, b.width, b.height].every((n) => typeof n === "number" && Number.isFinite(n)) && b.width! > 0 && b.height! > 0 ? (b as Box) : null;
};

async function placeImageTool(env: ToolEnv, args: Spec): Promise<ToolResult> {
  const placed = await importImageArg(env, args as ImageArg, "place_image");
  const { img } = placed;
  if (args.nodeId !== undefined) {
    const id = normId(args.nodeId);
    must(env, id);
    let status = 0;
    env.write("Place image", () => {
      status = env.ed.engine.setProps([id], { fillPaints: imageFill(placed) as never });
    });
    if (status !== 0) throw new ToolError(`The engine refused the image fill (status ${status}).`);
    const r = textResult({ summary: "place_image: the layer is filled with the image.", nodeId: id, imageHash: img.hash, imageSize: { width: img.width, height: img.height } });
    r.touched = [id];
    return r;
  }
  const spec: Spec = { type: "RECTANGLE", name: img.name, [IMAGE_KEY]: placed };
  const box = placeholderBox(args.__box);
  if (box) {
    // The chat's placeholder for this image (agents/imagePlaceholder.ts): the image lands centred on it.
    const num = (v: unknown) => (typeof v === "number" ? v : undefined);
    Object.assign(spec, landInBox(box, img, { width: num(args.width), height: num(args.height) }));
  } else {
    for (const k of ["x", "y", "width", "height"]) if (typeof args[k] === "number") spec[k] = args[k];
    sizeFromImage(spec, img);
  }
  const r = createNodes(env, { parentId: args.parentId, nodes: [spec] });
  const created = r.touched?.[0];
  r.content.unshift({ type: "text", text: JSON.stringify({ nodeId: created, imageHash: img.hash, imageSize: { width: img.width, height: img.height } }) });
  return r;
}

// ---- Writes: layers -------------------------------------------------------------------------------------------------

function createNodes(env: ToolEnv, args: Spec): ToolResult {
  const specs = Array.isArray(args.nodes) ? (args.nodes as Spec[]) : [];
  if (!specs.length) throw new ToolError("nodes: give at least one spec");
  const parentId = args.parentId ? normId(args.parentId) : currentPage(env);
  if (!parentId) throw new ToolError("No page to create on.");
  const parent = must(env, parentId);
  const results: NodeResult[] = [];
  const created: Guid[] = [];
  const session = env.ed.source.sessionID ?? 1;
  const typeErrors: Rejection[] = [];
  env.write("Create layers", () => {
    const changes: NodeChange[] = [];
    const later: { id: Guid; spec: Spec }[] = [];
    const make = (spec: Spec, par: NodeChange, position: string, top: boolean, path: string): void => {
      const type = nodeTypeOf(spec.type);
      if (!type) {
        typeErrors.push({ property: `${path}.type`, reason: `${JSON.stringify(spec.type)}: one of ${CREATABLE_TYPES.join(", ")} (components, instances, vectors: run_command)` });
        return;
      }
      const guid = newNodeGuid(env.ed);
      const base = { guid, type, ...defaults(type), transform: IDENTITY } as NodeChange;
      if (type === "TEXT" && typeof spec.characters === "string" && spec.name === undefined) base.name = spec.characters.slice(0, 60);
      const pos: Spec = {};
      if (top && par.type === "CANVAS" && spec.x === undefined && spec.y === undefined) Object.assign(pos, freeSpot(env, par.guid));
      // Made with its type's defaults and its name; every property is then applied as update_nodes applies it (checked, read back).
      const node: NodeChange = { ...base, ...(pos.x !== undefined ? { transform: { ...IDENTITY, m02: pos.x as number, m12: pos.y as number } } : {}), phase: "CREATED", name: (typeof spec.name === "string" ? spec.name : (base.name ?? defaultName(type))) as string, parentIndex: { guid: par.guid, position } } as NodeChange;
      changes.push(node);
      if (top) created.push(guid);
      const { children, type: _t, ...props } = spec;
      later.push({ id: guid, spec: props });
      const kids = Array.isArray(children) ? (children as Spec[]) : [];
      let key = "";
      kids.forEach((k, i) => {
        key = keyBetween(key, null);
        make(k, node, key, false, `${path}.children[${i}]`);
      });
    };
    let key = topKey(env, parent.guid);
    specs.forEach((spec, i) => {
      make(spec, parent, key, true, `nodes[${i}]`);
      key = keyAfter(key);
    });
    const message: Message = { type: "NODE_CHANGES", sessionID: session, nodeChanges: changes };
    const status = env.ed.engine.applyChanges(message, "user");
    if (status !== 0) throw new ToolError(`The engine refused the layers (status ${status}).`);
    // Parents before children (auto layout first), sizing after (FILL / HUG need the parent's layout).
    for (const l of later) results.push(applySpec(env, l.id, l.spec, { creating: true, skip: ["layoutSizingHorizontal", "layoutSizingVertical", "width", "height", "x", "y"] }));
    for (const l of [...later].reverse()) {
      const geo: Spec = {};
      for (const k of ["width", "height", "x", "y", "layoutSizingHorizontal", "layoutSizingVertical"]) if (l.spec[k] !== undefined) geo[k] = l.spec[k];
      if (!Object.keys(geo).length) continue;
      const r = applySpec(env, l.id, geo, { creating: true });
      const into = results.find((x) => x.nodeId === l.id)!;
      into.applied.push(...r.applied);
      into.rejected.push(...r.rejected);
      into.notApplied.push(...r.notApplied);
      Object.assign(into.values, r.values);
    }
  });
  if (typeErrors.length) results.push({ nodeId: "(not created)", applied: [], rejected: typeErrors, notApplied: [], values: {} });
  return writeResult("create_nodes", results, { created: created.map((id) => brief(env, read(env, id)!)) });
}

const defaultName = (t: string) => (t === "ROUNDED_RECTANGLE" ? "Rectangle" : t === "REGULAR_POLYGON" ? "Polygon" : t.charAt(0) + t.slice(1).toLowerCase());

function updateNodes(env: ToolEnv, args: Spec): ToolResult {
  const updates = Array.isArray(args.updates) ? (args.updates as Spec[]) : [];
  if (!updates.length) throw new ToolError("updates: give at least one { nodeId, … }");
  const results: NodeResult[] = [];
  env.write("Edit layers", () => {
    for (const u of updates) {
      const { nodeId: raw, ...spec } = u;
      // Layout first, then sizing, then size and place: each against what the step before made.
      const geo: Spec = {};
      const rest: Spec = {};
      for (const [k, v] of Object.entries(spec)) (["width", "height", "x", "y", "rotation", "layoutSizingHorizontal", "layoutSizingVertical"].includes(k) ? geo : rest)[k] = v;
      const id = normId(raw);
      const a = applySpec(env, id, rest);
      if (Object.keys(geo).length && read(env, id)) {
        const b = applySpec(env, id, geo);
        a.applied.push(...b.applied);
        a.rejected.push(...b.rejected);
        a.notApplied.push(...b.notApplied);
        Object.assign(a.values, b.values);
      }
      results.push(a);
    }
  });
  return writeResult("update_nodes", results);
}

/** set_properties: document fields straight to the engine (schema names and shapes), read back. */
function setPropertiesTool(env: ToolEnv, args: Spec): ToolResult {
  const refs = targets(env, { nodeIds: args.nodeIds, nodeId: args.nodeId });
  const props = args.properties && typeof args.properties === "object" ? (args.properties as Record<string, unknown>) : null;
  if (!props) throw new ToolError("properties: an object of document fields (schema/document.kiwi names), e.g. {stackSpacing: 8, effects: [...]}");
  const nc = MODEL.def("NodeChange");
  const errors: string[] = [];
  const fields: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(props)) {
    const f = nc.byName.get(k);
    if (!f || ["guid", "phase", "parentIndex", "type"].includes(k)) {
      errors.push(`${k}: not a settable document field${propForField(k) ? "" : ""}`);
      continue;
    }
    // Paints, effects and guides take the tools' shape (hex colours …) or the document's.
    if (k === "fillPaints" || k === "strokePaints") {
      const p = parsePaints(v, k, errors);
      if (p) fields[k] = p;
    } else if (k === "effects") {
      const e = parseEffects(v, k, errors);
      if (e) fields[k] = e;
    } else if (f.type && MODEL.defs.get(f.type)?.kind !== "ENUM" && !["bool", "string", "float", "int", "uint", "byte"].includes(f.type) && v && typeof v === "object") fields[k] = v;
    else {
      const r = fromTool(f.type!, f.isArray, v, k, errors);
      if (r !== undefined) fields[k] = r;
    }
  }
  const results: NodeResult[] = [];
  env.write("Edit layers", () => {
    for (const id of refs) {
      const before = read(env, id)!;
      const status = Object.keys(fields).length ? env.ed.engine.setProps([id], fields as never) : 0;
      const after = read(env, id)!;
      const notApplied = Object.keys(fields)
        .filter((k) => !sameValue(JSON.parse(JSON.stringify((fields as Record<string, unknown>)[k])), (after as unknown as Record<string, unknown>)[k], true) && !sameValue(toolOf(k, (fields as Record<string, unknown>)[k]), toolOf(k, (after as unknown as Record<string, unknown>)[k]), true))
        .map((k) => ({ property: k, requested: toolOf(k, (fields as Record<string, unknown>)[k]), actual: toolOf(k, (after as unknown as Record<string, unknown>)[k]), reason: status !== 0 ? `the engine refused (status ${status})` : "the engine kept another value (layout, an instance's main, or a value it normalises)" }));
      void before;
      results.push({ nodeId: id, name: after.name, applied: Object.keys(fields).filter((k) => !notApplied.some((x) => x.property === k)), rejected: errors.map((e) => ({ property: e.split(":")[0], reason: e.slice(e.indexOf(":") + 1).trim() })), notApplied, values: Object.fromEntries(Object.keys(props).map((k) => [k, toolOf(k, (after as unknown as Record<string, unknown>)[k])])) });
    }
  });
  return writeResult("set_properties", results);
}

const toolOf = (field: string, v: unknown) => {
  const f = MODEL.def("NodeChange").byName.get(field);
  if (!f) return v;
  if (field === "fillPaints" || field === "strokePaints") return describePaints(v as never);
  return toTool(f.type!, f.isArray, v);
};

/** Runs an engine command on `refs` as the selection, then puts the selection back (the agent's reads default to it). */
function onSelection<T>(env: ToolEnv, refs: readonly Guid[], fn: () => T): T {
  const before = [...env.ed.selection];
  const page = currentPage(env);
  const target = refs.length ? pageOf(env, refs[0]) : null;
  if (target && target !== page) env.ed.engine.setCurrentPage(target);
  if (refs.length) env.ed.engine.setSelection(refs);
  try {
    return fn();
  } finally {
    if (target && page && target !== page) env.ed.engine.setCurrentPage(page);
    env.ed.engine.setSelection(before.filter((id) => !!read(env, id, ["name"])));
  }
}

function deleteNodes(env: ToolEnv, args: Spec): ToolResult {
  const refs = targets(env, { nodeIds: args.nodeIds });
  env.write("Delete layers", () => onSelection(env, refs, () => env.ed.engine.command("DELETE")));
  const left = refs.filter((id) => read(env, id, ["name"]));
  return textResult(left.length ? { deleted: refs.length - left.length, notDeleted: left, reason: "locked, a library copy, or inside an instance" } : { deleted: refs.length }, left.length === refs.length);
}

function duplicateNodes(env: ToolEnv, args: Spec): ToolResult {
  const refs = targets(env, { nodeIds: args.nodeIds });
  let copies: Guid[] = [];
  const problems: string[] = [];
  env.write("Duplicate", () => {
    copies = onSelection(env, refs, () => {
      env.ed.engine.command("DUPLICATE");
      return [...env.ed.engine.getSelection().refs];
    });
    if (!copies.length) throw new ToolError("The layers couldn't be duplicated.");
    if (args.parentId) {
      const parent = must(env, normId(args.parentId));
      const index = typeof args.index === "number" ? args.index : (parent.childIds?.length ?? 0);
      const moved = env.ed.engine.moveNodes(copies, parent.guid, index);
      if (moved !== copies.length) problems.push(`parentId: only ${moved} of ${copies.length} copies could go into ${parent.guid} (a layer into itself, a page into a layer, or a library copy)`);
    }
    if (typeof args.x === "number" || typeof args.y === "number") {
      const first = read(env, copies[0]);
      const dx = typeof args.x === "number" ? args.x - (first?.transform?.m02 ?? 0) : 0;
      const dy = typeof args.y === "number" ? args.y - (first?.transform?.m12 ?? 0) : 0;
      for (const id of copies) {
        const n = read(env, id, ["transform"]);
        const t = n?.transform ?? IDENTITY;
        env.ed.engine.setProps([id], { transform: { ...t, m02: t.m02 + dx, m12: t.m12 + dy } });
      }
    }
  });
  const result = textResult({ copies: copies.map((id) => ({ ...brief(env, read(env, id)!), parentId: read(env, id)?.parentIndex?.guid })), ...(problems.length ? { notApplied: problems } : {}) });
  result.touched = copies;
  return result;
}

function reparentNodes(env: ToolEnv, args: Spec): ToolResult {
  const refs = targets(env, { nodeIds: args.nodeIds });
  const parent = must(env, normId(args.parentId));
  const index = typeof args.index === "number" ? args.index : (parent.childIds?.length ?? 0);
  const into = refs.filter((id) => id === parent.guid || isAncestor(env, id, parent.guid));
  if (into.length) return textResult(`Can't move ${into.join(", ")} into ${parent.guid}: that is the layer itself or inside it.`, true);
  let moved = 0;
  env.write("Move layers", () => {
    moved = env.ed.engine.moveNodes(refs, parent.guid, index);
  });
  if (!moved) return textResult(`The engine refused to move ${refs.join(", ")} into ${parent.guid} (${typeName(parent.type)}): ${parent.type === "CANVAS" || ["FRAME", "GROUP", "SYMBOL", "SECTION", "BOOLEAN_OPERATION"].includes(parent.type ?? "") ? "a page into a layer, a library copy, or layers inside an instance" : "it can't hold layers (use a frame, group, section or component)"}.`, true);
  const result = textResult({ moved: refs.map((id) => ({ id, parentId: read(env, id)?.parentIndex?.guid })) });
  result.touched = refs;
  return result;
}

function isAncestor(env: ToolEnv, a: Guid, b: Guid): boolean {
  let n = read(env, b, ["parentIndex"]);
  for (let i = 0; n && i < 400; i++) {
    const p = n.parentIndex?.guid;
    if (!p) return false;
    if (p === a) return true;
    n = read(env, p, ["parentIndex"]);
  }
  return false;
}

function setAutoLayout(env: ToolEnv, args: Spec): ToolResult {
  const n = must(env, normId(args.nodeId));
  if (n.type !== "FRAME" && n.type !== "SYMBOL" && n.type !== "INSTANCE") throw new ToolError(`${n.guid} is a ${typeName(n.type)}: auto layout is for frames (create a frame around the layers with create_nodes and reparent_nodes).`);
  const fields = autoLayoutFields(args, n);
  env.write("Auto layout", () => env.ed.engine.setProps([n.guid], fields));
  const result = textResult({ updated: n.guid, layout: describeNode(must(env, n.guid), parentOf(env, n)) });
  result.touched = [n.guid];
  return result;
}

// ---- Variables ----------------------------------------------------------------------------------------------------------

/** A tools' field name → the engine's binding target (docs/engine-build.md "Binding targets"). */
const BIND_FIELDS: Record<string, string | string[]> = {
  characters: "TEXT_DATA", visible: "VISIBLE", opacity: "OPACITY", width: "WIDTH", height: "HEIGHT",
  minwidth: "MIN_WIDTH", maxwidth: "MAX_WIDTH", minheight: "MIN_HEIGHT", maxheight: "MAX_HEIGHT",
  itemspacing: "STACK_SPACING", counteraxisspacing: "STACK_COUNTER_SPACING",
  paddingleft: "STACK_PADDING_LEFT", paddingtop: "STACK_PADDING_TOP", paddingright: "STACK_PADDING_RIGHT", paddingbottom: "STACK_PADDING_BOTTOM",
  padding: ["STACK_PADDING_LEFT", "STACK_PADDING_TOP", "STACK_PADDING_RIGHT", "STACK_PADDING_BOTTOM"],
  cornerradius: ["RECTANGLE_TOP_LEFT_CORNER_RADIUS", "RECTANGLE_TOP_RIGHT_CORNER_RADIUS", "RECTANGLE_BOTTOM_LEFT_CORNER_RADIUS", "RECTANGLE_BOTTOM_RIGHT_CORNER_RADIUS"],
  topleftradius: "RECTANGLE_TOP_LEFT_CORNER_RADIUS", toprightradius: "RECTANGLE_TOP_RIGHT_CORNER_RADIUS", bottomleftradius: "RECTANGLE_BOTTOM_LEFT_CORNER_RADIUS", bottomrightradius: "RECTANGLE_BOTTOM_RIGHT_CORNER_RADIUS",
  strokeweight: "STROKE_WEIGHT", stroketopweight: "BORDER_TOP_WEIGHT", strokebottomweight: "BORDER_BOTTOM_WEIGHT", strokeleftweight: "BORDER_LEFT_WEIGHT", strokerightweight: "BORDER_RIGHT_WEIGHT",
  fontfamily: "FONT_FAMILY", fontstyle: "FONT_STYLE", fontsize: "FONT_SIZE", lineheight: "LINE_HEIGHT", letterspacing: "LETTER_SPACING",
  paragraphspacing: "PARAGRAPH_SPACING", paragraphindent: "PARAGRAPH_INDENT", fontvariations: "FONT_VARIATIONS", hyperlink: "HYPERLINK",
  gridrowgap: "GRID_ROW_GAP", gridcolumngap: "GRID_COLUMN_GAP",
  fill: "fillPaints[0].color", fills: "fillPaints[0].color", stroke: "strokePaints[0].color", strokes: "strokePaints[0].color",
};

/** "fills[1].color", "effects[0].radius", "layoutGrids[0].sectionSize", "componentProperties.Label", "FONT_SIZE" … → engine targets. */
function bindTargets(field: string): string[] | null {
  const f = field.trim();
  const m = /^(fills|strokes|fillPaints|strokePaints)\[(\d+)\](?:\.stops\[(\d+)\])?(?:\.(color|opacity))?$/.exec(f);
  if (m) return [`${m[1].startsWith("fill") ? "fillPaints" : "strokePaints"}[${m[2]}]${m[3] !== undefined ? `.stops[${m[3]}]` : ""}.${m[4] ?? "color"}`];
  const e = /^effects\[(\d+)\]\.(color|radius|spread|x|y|offsetX|offsetY)$/.exec(f);
  if (e) return [`effects[${e[1]}].${e[2] === "offsetX" ? "x" : e[2] === "offsetY" ? "y" : e[2]}`];
  if (/^layoutGrids\[\d+\]\.(numSections|offset|sectionSize|gutterSize|count|gutter)$/.test(f)) return [f.replace(/\.count$/, ".numSections").replace(/\.gutter$/, ".gutterSize")];
  if (f.startsWith("componentProperties.")) return [f];
  const mapped = BIND_FIELDS[f.toLowerCase().replace(/[_\s-]/g, "")];
  if (mapped) return Array.isArray(mapped) ? mapped : [mapped];
  if (/^[A-Z_]+$/.test(f)) return [f];
  return null;
}

const BIND_HELP = 'field: characters (STRING), visible (BOOLEAN), opacity, width, height, min/maxWidth/Height, itemSpacing, counterAxisSpacing, padding / paddingTop…, cornerRadius / topLeftRadius…, strokeWeight / strokeTopWeight…, fontFamily, fontStyle, fontSize, lineHeight, letterSpacing, paragraphSpacing, paragraphIndent, gridRowGap, gridColumnGap, "fills[i]" / "fills[i].opacity" / "fills[i].stops[j]" / "strokes[i]", "effects[i].color|radius|spread|x|y", "layoutGrids[i].numSections|sectionSize|gutterSize|offset", "componentProperties.<name>"';

function bindVariableTool(env: ToolEnv, args: Spec): ToolResult {
  const refs = targets(env, { nodeIds: args.nodeIds, nodeId: args.nodeId });
  const field = String(args.field ?? "");
  const tg = bindTargets(field);
  if (!tg) throw new ToolError(`Unknown field "${field}". ${BIND_HELP}.`);
  const variable = args.variableId === null ? null : normId(args.variableId);
  const v = variable ? env.ed.engine.variable(variable) : null;
  if (variable && !v) throw new ToolError(`No variable ${variable} (get_variable_defs with all: true lists them).`);
  const failed: string[] = [];
  env.write(v ? "Apply variable" : "Detach variable", () => {
    for (const target of tg) {
      // A paint past the list: added first (as the panel's "Apply variable" does).
      const pm = /^(fillPaints|strokePaints)\[(\d+)\]/.exec(target);
      if (v && pm) for (const id of refs) {
        const n = read(env, id)!;
        const list = ((n as unknown as Record<string, unknown>)[pm[1]] as unknown[] | undefined) ?? [];
        if (list.length <= +pm[2]) env.ed.engine.setProps([id], { [pm[1]]: [...list, ...Array.from({ length: +pm[2] + 1 - list.length }, () => solid({ r: 1, g: 1, b: 1, a: 1 }))] } as never);
      }
      const status = v ? env.ed.engine.runCommand("BIND_VARIABLE", { refs: [...refs], target, variable: v.id }).status : env.ed.engine.runCommand("DETACH_VARIABLE", { refs: [...refs], target }).status;
      if (status !== 0) failed.push(`${target} (status ${status}${status === -3 ? `: the variable's type (${v?.resolvedType}) doesn't fit this field, or the layer has no such field` : ""})`);
    }
  });
  const bound = refs.map((id) => ({ nodeId: id, bindings: env.ed.engine.boundVariables(id).filter((b) => b.variable).map((b) => ({ target: b.target, variable: b.variable, value: b.resolved })) }));
  const r = textResult({ ...(failed.length ? { summary: `NOT bound: ${failed.join("; ")}` } : { summary: v ? `bound ${field} to ${v.name}` : `detached ${field}` }), nodes: bound }, failed.length === tg.length);
  r.touched = refs;
  return r;
}

const VAR_TYPES = ["COLOR", "FLOAT", "STRING", "BOOLEAN"] as const;

/** A tools' value of a variable: a literal of its type or {alias: variableId}. */
function varValue(env: ToolEnv, type: string, v: unknown): unknown {
  if (v && typeof v === "object" && ("alias" in v || "type" in v)) {
    const o = v as { alias?: unknown; id?: unknown; type?: string };
    const id = normId(o.alias ?? o.id);
    if (!env.ed.engine.variable(id)) throw new ToolError(`alias: no variable ${id}`);
    return { type: "VARIABLE_ALIAS", id };
  }
  if (type === "COLOR") {
    const c = parseColor(v);
    if (!c) throw new ToolError(`value: a colour "#RRGGBB(AA)" (got ${JSON.stringify(v)})`);
    return c;
  }
  if (type === "FLOAT" && typeof v !== "number") throw new ToolError(`value: a number (got ${JSON.stringify(v)})`);
  if (type === "STRING" && typeof v !== "string") throw new ToolError(`value: a string (got ${JSON.stringify(v)})`);
  if (type === "BOOLEAN" && typeof v !== "boolean") throw new ToolError(`value: true or false (got ${JSON.stringify(v)})`);
  return v;
}

function collectionOf(env: ToolEnv, id: unknown) {
  const cid = normId(id);
  const c = env.ed.engine.variableCollections({ includeRemote: true }).find((x) => x.id === cid || x.name === id);
  if (!c) throw new ToolError(`No collection ${String(id)} (get_variable_defs with all: true lists them).`);
  return c;
}

function modeOf(c: { modes: { modeId: string; name: string }[]; name: string }, mode: unknown): string {
  const m = c.modes.find((x) => x.modeId === mode || x.name === mode);
  if (!m) throw new ToolError(`Collection ${c.name} has no mode ${String(mode)} (has ${c.modes.map((x) => x.name).join(", ")}).`);
  return m.modeId;
}

function run(env: ToolEnv, name: string, args: Record<string, unknown>): { created: Guid[] } {
  const r = env.ed.engine.runCommand(name as never, args as never);
  if (r.status !== 0) throw new ToolError(`${name} was refused by the engine (status ${r.status}) with ${JSON.stringify(args)}.`);
  return r;
}

const collectionView = (env: ToolEnv, id: Guid) => {
  const c = env.ed.engine.variableCollections({ includeRemote: true }).find((x) => x.id === id);
  return c ? { id: c.id, name: c.name, modes: c.modes.map((m) => ({ id: m.modeId, name: m.name })), variables: c.variableIds.length } : null;
};

function createCollectionTool(env: ToolEnv, args: Spec): ToolResult {
  const name = typeof args.name === "string" ? args.name : "Collection";
  const modes = Array.isArray(args.modes) ? args.modes.map(String) : [];
  let id = "";
  env.write("Create collection", () => {
    id = run(env, "CREATE_VARIABLE_COLLECTION", { name }).created[0];
    const c = collectionOf(env, id);
    if (modes[0]) run(env, "RENAME_VARIABLE_MODE", { collection: id, mode: c.modes[0].modeId, name: modes[0] });
    for (const m of modes.slice(1)) run(env, "ADD_VARIABLE_MODE", { collection: id, name: m });
  });
  const r = textResult({ collection: collectionView(env, id) });
  return r;
}

function editCollectionTool(env: ToolEnv, args: Spec): ToolResult {
  const c = collectionOf(env, args.collectionId);
  const action = String(args.action ?? "");
  env.write("Edit collection", () => {
    switch (action) {
      case "rename": run(env, "RENAME_VARIABLE_COLLECTION", { collection: c.id, name: String(args.name ?? "") }); break;
      case "delete": run(env, "DELETE_VARIABLE_COLLECTION", { collection: c.id }); break;
      case "add_mode": run(env, "ADD_VARIABLE_MODE", { collection: c.id, ...(args.name ? { name: String(args.name) } : {}) }); break;
      case "rename_mode": run(env, "RENAME_VARIABLE_MODE", { collection: c.id, mode: modeOf(c, args.mode), name: String(args.name ?? "") }); break;
      case "delete_mode": run(env, "DELETE_VARIABLE_MODE", { collection: c.id, mode: modeOf(c, args.mode) }); break;
      case "duplicate_mode": run(env, "DUPLICATE_VARIABLE_MODE", { collection: c.id, mode: modeOf(c, args.mode) }); break;
      case "set_default_mode": run(env, "MOVE_VARIABLE_MODE", { collection: c.id, mode: modeOf(c, args.mode), index: 0 }); break;
      case "extend": run(env, "EXTEND_VARIABLE_COLLECTION", { collection: c.id, ...(args.name ? { name: String(args.name) } : {}) }); break;
      case "duplicate": run(env, "DUPLICATE_VARIABLE_COLLECTION", { collection: c.id }); break;
      default: throw new ToolError("action: rename, delete, add_mode, rename_mode, delete_mode, duplicate_mode, set_default_mode, extend, duplicate");
    }
  });
  return textResult({ collection: collectionView(env, c.id) ?? "deleted", collections: env.ed.engine.variableCollections({}).map((x) => ({ id: x.id, name: x.name })) });
}

function createVariableTool(env: ToolEnv, args: Spec): ToolResult {
  const c = collectionOf(env, args.collectionId);
  const type = String(args.type ?? "").toUpperCase();
  if (!(VAR_TYPES as readonly string[]).includes(type)) throw new ToolError(`type: ${VAR_TYPES.join(", ")}`);
  const name = typeof args.name === "string" && args.name.trim() ? args.name.trim() : undefined;
  const values = args.values && typeof args.values === "object" ? (args.values as Record<string, unknown>) : {};
  let id = "";
  env.write("Create variable", () => {
    id = run(env, "CREATE_VARIABLE", { collection: c.id, type, ...(name ? { name } : {}) }).created[0];
    if (!id) throw new ToolError("The variable wasn't created.");
    for (const [mode, value] of Object.entries(values)) run(env, "SET_VARIABLE_VALUE", { variable: id, mode: modeOf(c, mode), value: varValue(env, type, value) as never });
    if (args.value !== undefined) for (const m of c.modes) if (!(m.name in values) && !(m.modeId in values)) run(env, "SET_VARIABLE_VALUE", { variable: id, mode: m.modeId, value: varValue(env, type, args.value) as never });
    editVariableFields(env, id, args);
  });
  return textResult({ variable: variableView(env, id) });
}

function editVariableFields(env: ToolEnv, id: Guid, args: Spec) {
  if (typeof args.description === "string") run(env, "SET_VARIABLE_DESCRIPTION", { variable: id, description: args.description });
  if (Array.isArray(args.scopes)) run(env, "SET_VARIABLE_SCOPES", { variables: [id], scopes: args.scopes.map(String) });
  if (typeof args.hiddenFromPublishing === "boolean") run(env, "SET_VARIABLE_HIDDEN", { variables: [id], hidden: args.hiddenFromPublishing });
  if (args.codeSyntax && typeof args.codeSyntax === "object") for (const [platform, value] of Object.entries(args.codeSyntax as Record<string, unknown>)) run(env, "SET_VARIABLE_CODE_SYNTAX", { variable: id, platform, value: String(value) });
}

function variableView(env: ToolEnv, id: Guid) {
  const v = env.ed.engine.variable(id);
  if (!v) return null;
  const c = env.ed.engine.variableCollections({ includeRemote: true }).find((x) => x.variableIds.includes(id));
  const show = (x: unknown): unknown => (x && typeof x === "object" && "r" in (x as object) ? colorHex(x as never) : x && typeof x === "object" && "value" in (x as object) ? show((x as { value: unknown }).value) : x);
  return { id: v.id, name: v.name, type: v.resolvedType, collection: c?.name, values: Object.fromEntries((c?.modes ?? []).map((m) => [m.name, show(v.valuesByMode[m.modeId])])) };
}

function setVariableValueTool(env: ToolEnv, args: Spec): ToolResult {
  const id = normId(args.variableId);
  const v = env.ed.engine.variable(id);
  if (!v) throw new ToolError(`No variable ${id}.`);
  const c = env.ed.engine.variableCollections({ includeRemote: true }).find((x) => x.variableIds.includes(id) || x.id === normId(args.collectionId));
  if (!c) throw new ToolError(`No collection for ${id}.`);
  const values = args.values && typeof args.values === "object" ? (args.values as Record<string, unknown>) : args.mode !== undefined ? { [String(args.mode)]: args.value } : null;
  if (!values) throw new ToolError("Give values: {modeName: value} (or mode + value).");
  env.write("Edit variable", () => {
    for (const [mode, value] of Object.entries(values)) run(env, "SET_VARIABLE_VALUE", { variable: id, mode: modeOf(c, mode), value: varValue(env, v.resolvedType, value) as never });
  });
  return textResult({ variable: variableView(env, id) });
}

function editVariableTool(env: ToolEnv, args: Spec): ToolResult {
  const id = normId(args.variableId);
  if (!env.ed.engine.variable(id)) throw new ToolError(`No variable ${id}.`);
  if (args.delete === true) {
    env.write("Delete variable", () => run(env, "DELETE_VARIABLES", { variables: [id] }));
    return textResult({ deleted: id });
  }
  env.write("Edit variable", () => {
    if (typeof args.name === "string") run(env, "RENAME_VARIABLE", { variable: id, name: args.name });
    editVariableFields(env, id, args);
  });
  return textResult({ variable: variableView(env, id) });
}

function setVariableModeTool(env: ToolEnv, args: Spec): ToolResult {
  const c = collectionOf(env, args.collectionId);
  const mode = args.mode === null || args.mode === "auto" ? "" : modeOf(c, args.mode);
  const isPage = (id: Guid) => read(env, id, ["type"])?.type === "CANVAS";
  const refs = targets(env, { nodeIds: args.nodeIds, nodeId: args.nodeId });
  env.write("Apply variable mode", () => {
    for (const id of refs) run(env, "SET_VARIABLE_MODE", isPage(id) ? { page: id, collection: c.id, mode } : { refs: [id], collection: c.id, mode });
  });
  const r = textResult({ nodes: refs.map((id) => ({ nodeId: id, modes: env.ed.engine.variableModes(id).filter((m) => m.collectionId === c.id) })) });
  r.touched = refs;
  return r;
}

// ---- Styles -----------------------------------------------------------------------------------------------------------

const STYLE_TYPE: Record<string, { kind: string; props: string[] }> = {
  create_paint_style: { kind: "FILL", props: ["fills"] },
  create_text_style: { kind: "TEXT", props: ["fontFamily", "fontStyle", "fontSize", "lineHeight", "letterSpacing", "paragraphSpacing", "paragraphIndent", "textCase", "textDecoration", "listSpacing", "leadingTrim", "hangingPunctuation", "hangingList", "fontVariations", "toggledOnOTFeatures", "toggledOffOTFeatures"] },
  create_effect_style: { kind: "EFFECT", props: ["effects"] },
  create_grid_style: { kind: "GRID", props: ["layoutGrids"] },
};

function createStyleTool(env: ToolEnv, tool: string, args: Spec): ToolResult {
  const t = STYLE_TYPE[tool];
  const name = typeof args.name === "string" && args.name.trim() ? args.name.trim() : undefined;
  const from = args.fromNodeId ? normId(args.fromNodeId) : null;
  let id = "";
  let result: NodeResult | null = null;
  env.write("Create style", () => {
    id = run(env, "CREATE_STYLE", { type: t.kind, ...(name ? { name } : {}), ...(from ? { from } : {}) }).created[0];
    if (!id) throw new ToolError("The style wasn't created.");
    const spec: Spec = {};
    for (const k of t.props) if (args[k] !== undefined) spec[k] = args[k];
    const extra = Object.keys(args).filter((k) => !t.props.includes(k) && !["name", "fromNodeId", "description", "applyTo"].includes(k));
    if (Object.keys(spec).length) result = applySpec(env, id, spec);
    if (extra.length) (result ??= { nodeId: id, applied: [], rejected: [], notApplied: [], values: {} }).rejected.push(...extra.map((k) => ({ property: k, reason: `not part of a ${t.kind.toLowerCase()} style (takes ${t.props.join(", ")})` })));
    if (typeof args.description === "string") env.ed.engine.setProps([id], { description: args.description } as never);
    if (Array.isArray(args.applyTo) && args.applyTo.length) run(env, "APPLY_STYLE", { refs: args.applyTo.map(normId), style: id });
  });
  const s = env.ed.engine.styles(undefined, { includeRemote: false }).find((x) => x.id === id);
  if (result) return writeResult(tool, [result], { style: { id, name: s?.name, type: s?.styleType } });
  return textResult({ style: { id, name: s?.name, type: s?.styleType } });
}

function applyStyleTool(env: ToolEnv, args: Spec): ToolResult {
  const refs = targets(env, { nodeIds: args.nodeIds });
  const slot = String(args.slot ?? "") as "fill" | "stroke" | "text" | "effect" | "grid";
  if (!["fill", "stroke", "text", "effect", "grid"].includes(slot)) throw new ToolError("slot: fill, stroke, text, effect or grid");
  const style = args.styleId === null ? null : normId(args.styleId);
  if (style && !env.ed.engine.styles(undefined, { includeRemote: true }).some((s) => s.id === style)) throw new ToolError(`No style ${style} (get_variable_defs with all: true lists them).`);
  env.write("Apply style", () => applyStyle(env.ed, refs, slot, style));
  const result = textResult({ applied: { nodes: refs, slot, style } });
  result.touched = refs;
  return result;
}

// ---- Commands, pages ----------------------------------------------------------------------------------------------------

function listCommands(env: ToolEnv, args: Spec): ToolResult {
  const q = typeof args.query === "string" ? args.query.toLowerCase() : "";
  const editor = COMMANDS.filter((c) => !q || c.id.toLowerCase().includes(q) || c.label.toLowerCase().includes(q)).map((c) => ({ id: c.id, label: c.label, ...(c.keys?.length ? { shortcut: comboText(c.keys[0]) } : {}), enabled: isEnabled(env.ed, c) }));
  const engine = Object.keys(CommandId).filter((n) => !q || n.toLowerCase().includes(q) || (ENGINE_COMMAND_DOCS[n] ?? "").toLowerCase().includes(q)).map((n) => ({ name: n, args: ENGINE_COMMAND_DOCS[n] ?? "" }));
  return textResult({ editorCommands: editor, engineCommands: engine, how: 'run_command {command: "<editor id>", nodeIds?} runs a menu / shortcut command on those layers (default: the selection); run_command {engineCommand: "<NAME>", args: {...}} runs an engine command with its arguments (refs: layer ids; created ids come back).' });
}

function runCommandTool(env: ToolEnv, args: Spec): ToolResult {
  const nodeIds = Array.isArray(args.nodeIds) ? (args.nodeIds as unknown[]).map(normId) : [];
  if (nodeIds.length) targets(env, { nodeIds });
  if (typeof args.command === "string") {
    const c = COMMAND_BY_ID.get(args.command);
    if (!c) throw new ToolError(`No editor command ${args.command} (list_commands lists them).`);
    let ran = false;
    env.write(c.label, () => onSelection(env, nodeIds, () => {
      ran = isEnabled(env.ed, c);
      if (ran) c.run(env.ed);
    }));
    if (!ran) return textResult(`"${c.label}" is not available for ${nodeIds.length ? nodeIds.join(", ") : "the current selection"} (disabled in the app's menus).`, true);
    return textResult({ ran: c.id, label: c.label, selection: env.ed.selection.map((id) => brief(env, read(env, id)!)) });
  }
  if (typeof args.engineCommand === "string") {
    const name = args.engineCommand.toUpperCase();
    if (!(name in CommandId)) throw new ToolError(`No engine command ${name} (list_commands lists them).`);
    const a = (args.args && typeof args.args === "object" ? args.args : {}) as Record<string, unknown>;
    let r = { status: 0, created: [] as Guid[] };
    env.write(name, () => onSelection(env, nodeIds, () => {
      r = env.ed.engine.runCommand(name as never, Object.keys(a).length ? (a as never) : undefined);
    }));
    if (r.status !== 0) return textResult(`${name} was refused by the engine (status ${r.status}${r.status === -3 ? ": invalid arguments or nothing it applies to" : r.status === -6 ? ": read-only" : r.status === -8 ? ": not supported" : ""}). Arguments: ${ENGINE_COMMAND_DOCS[name] ?? "see list_commands"}.`, true);
    const out = textResult({ ran: name, created: r.created, selection: env.ed.selection.map((id) => brief(env, read(env, id)!)) });
    out.touched = [...r.created, ...nodeIds];
    return out;
  }
  throw new ToolError('Give command (an editor command id) or engineCommand (an engine command name) — list_commands lists both.');
}

function setPageTool(env: ToolEnv, args: Spec): ToolResult {
  const pages = env.ed.engine.pages();
  const p = pages.find((x) => x.guid === normId(args.pageId) || x.name === args.pageId);
  if (!p) throw new ToolError(`No page ${String(args.pageId)} (has ${pages.map((x) => `${x.name} (${x.guid})`).join(", ")}).`);
  env.ed.engine.setCurrentPage(p.guid);
  return textResult({ page: { id: p.guid, name: p.name } });
}

function setSelectionTool(env: ToolEnv, args: Spec): ToolResult {
  const refs = targets(env, { nodeIds: args.nodeIds });
  const page = pageOf(env, refs[0]);
  if (page && page !== currentPage(env)) env.ed.engine.setCurrentPage(page);
  env.ed.engine.setSelection(refs.filter((id) => pageOf(env, id) === page));
  env.ed.engine.command("ZOOM_TO_SELECTION");
  return textResult({ selected: env.ed.selection });
}

function responsiveTool(env: ToolEnv, args: Spec): ToolResult {
  const source = must(env, normId(args.nodeId));
  const width = typeof args.width === "number" ? Math.max(200, Math.min(4000, args.width)) : 390;
  let made: { id: Guid; notes: string[] } | null = null;
  env.write("Responsive variant", () => {
    made = responsiveVariant(env, source, width, typeof args.name === "string" ? args.name : undefined);
  });
  const m = made as { id: Guid; notes: string[] } | null;
  if (!m) throw new ToolError("The frame couldn't be adapted.");
  const result = textResult({ created: brief(env, read(env, m.id)!), changes: m.notes, next: "Check it with get_screenshot, then refine with update_nodes / set_auto_layout." });
  result.touched = [m.id];
  return result;
}

/** One tool call: its result, or an error result (never throws). */
export async function runTool(env: ToolEnv, name: string, args: Spec): Promise<ToolResult> {
  if (!TOOL_BY_NAME.has(name)) return textResult(`Unknown tool ${name}`, true);
  if (env.ed.engine.destroyed) return textResult("The file is closing.", true);
  try {
    switch (name) {
      case "get_selection":
        return getSelection(env);
      case "get_metadata":
        return getMetadata(env, args);
      case "get_design_context":
        return getDesignContext(env, args);
      case "get_screenshot":
        return await getScreenshot(env, args);
      case "get_variable_defs":
        return getVariableDefs(env, args);
      case "create_nodes":
        return createNodes(env, Array.isArray(args.nodes) ? { ...args, nodes: await importSpecImages(env, args.nodes as Spec[], true, "nodes") } : args);
      case "update_nodes":
        return updateNodes(env, Array.isArray(args.updates) ? { ...args, updates: await importSpecImages(env, args.updates as Spec[], false, "updates") } : args);
      case "place_image":
        return await placeImageTool(env, args);
      case "delete_nodes":
        return deleteNodes(env, args);
      case "duplicate_nodes":
        return duplicateNodes(env, args);
      case "reparent_nodes":
        return reparentNodes(env, args);
      case "set_auto_layout":
        return setAutoLayout(env, args);
      case "apply_variable":
      case "bind_variable":
        return bindVariableTool(env, args);
      case "set_properties":
        return setPropertiesTool(env, args);
      case "create_variable_collection":
        return createCollectionTool(env, args);
      case "edit_variable_collection":
        return editCollectionTool(env, args);
      case "create_variable":
        return createVariableTool(env, args);
      case "set_variable_value":
        return setVariableValueTool(env, args);
      case "edit_variable":
        return editVariableTool(env, args);
      case "set_variable_mode":
        return setVariableModeTool(env, args);
      case "create_paint_style":
      case "create_text_style":
      case "create_effect_style":
      case "create_grid_style":
        return createStyleTool(env, name, args);
      case "list_commands":
        return listCommands(env, args);
      case "run_command":
        return runCommandTool(env, args);
      case "set_current_page":
        return setPageTool(env, args);
      case "apply_style":
        return applyStyleTool(env, args);
      case "create_responsive_variant":
        return responsiveTool(env, args);
      case "set_selection":
        return setSelectionTool(env, args);
    }
    return textResult(`Unknown tool ${name}`, true);
  } catch (err) {
    return textResult(err instanceof Error ? err.message : String(err), true);
  }
}

