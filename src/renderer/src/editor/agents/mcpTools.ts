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
import { applyStyle, bindPaint, bindVariable, newNodeGuid } from "../variables";
import { autoLayoutFields, defaults, describeNode, fieldsOf, IDENTITY, nodeTypeOf, normId, typeName, type Spec } from "./nodeSpec";
import { base64, encodePng } from "./png";
import { responsiveVariant } from "./responsive";

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
  if (!refs.length) {
    const page = currentPage(env);
    refs = page ? [page] : [];
  }
  const depth = typeof args.depth === "number" ? Math.max(0, Math.min(20, args.depth)) : 6;
  const { roots, truncated } = trees(env, refs, depth, ["name", "type", "size", "transform", "visible"]);
  return textResult(roots.map((t) => toXml(t)).join("\n") + (truncated ? `\n<!-- deeper layers left out: call get_metadata on a child id -->` : ""));
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
      const id = styleRef((t.node as Record<string, unknown>)[field]);
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

function createNodes(env: ToolEnv, args: Spec): ToolResult {
  const specs = Array.isArray(args.nodes) ? (args.nodes as Spec[]) : [];
  if (!specs.length) throw new ToolError("nodes: give at least one spec");
  const parentId = args.parentId ? normId(args.parentId) : currentPage(env);
  if (!parentId) throw new ToolError("No page to create on.");
  const parent = must(env, parentId);
  const errors: string[] = [];
  const created: Guid[] = [];
  const session = env.ed.source.sessionID ?? 1;
  env.write("Create layers", () => {
    const changes: NodeChange[] = [];
    const sizingLater: { id: Guid; spec: Spec; parent: NodeChange }[] = [];
    const make = (spec: Spec, par: NodeChange, position: string, top: boolean): void => {
      const type = nodeTypeOf(spec.type);
      if (!type) {
        errors.push(`type ${String(spec.type)}: FRAME, RECTANGLE, ELLIPSE, TEXT, LINE or GROUP`);
        return;
      }
      const guid = newNodeGuid(env.ed);
      const base = { guid, type, ...defaults(type), transform: IDENTITY } as NodeChange;
      const rest = { ...spec };
      if (top && par.type === "CANVAS" && spec.x === undefined && spec.y === undefined) Object.assign(rest, freeSpot(env, par.guid));
      if (type === "TEXT" && typeof spec.characters === "string" && spec.name === undefined) base.name = spec.characters.slice(0, 60);
      // Sizing needs the layer to exist under its parent (FILL, HUG): applied after.
      const { layoutSizingHorizontal, layoutSizingVertical, ...direct } = rest;
      const fields = fieldsOf(direct, base, par, errors);
      const node: NodeChange = { ...base, ...fields, phase: "CREATED", name: (fields.name ?? base.name ?? defaultName(type)) as string, parentIndex: { guid: par.guid, position } } as NodeChange;
      changes.push(node);
      if (top) created.push(guid);
      if (layoutSizingHorizontal !== undefined || layoutSizingVertical !== undefined) sizingLater.push({ id: guid, spec: { layoutSizingHorizontal, layoutSizingVertical }, parent: par });
      const kids = Array.isArray(spec.children) ? (spec.children as Spec[]) : [];
      let key = "";
      for (const k of kids) {
        key = keyBetween(key, null);
        make(k, node, key, false);
      }
    };
    let key = topKey(env, parent.guid);
    for (const spec of specs) {
      make(spec, parent, key, true);
      key = keyAfter(key);
    }
    const message: Message = { type: "NODE_CHANGES", sessionID: session, nodeChanges: changes };
    const status = env.ed.engine.applyChanges(message, "user");
    if (status !== 0) throw new ToolError(`The engine refused the layers (status ${status}).`);
    for (const s of sizingLater) {
      const n = read(env, s.id);
      const p = n?.parentIndex?.guid ? read(env, n.parentIndex.guid) : null;
      if (!n) continue;
      const fields = fieldsOf(s.spec, n, p, errors);
      if (Object.keys(fields).length) env.ed.engine.setProps([s.id], fields);
    }
  });
  const result: ToolResult = textResult({ created: created.map((id) => brief(env, read(env, id)!)), ...(errors.length ? { warnings: errors } : {}) });
  result.touched = created;
  return result;
}

const defaultName = (t: string) => (t === "ROUNDED_RECTANGLE" ? "Rectangle" : t.charAt(0) + t.slice(1).toLowerCase());

function updateNodes(env: ToolEnv, args: Spec): ToolResult {
  const updates = Array.isArray(args.updates) ? (args.updates as Spec[]) : [];
  if (!updates.length) throw new ToolError("updates: give at least one { nodeId, … }");
  const errors: string[] = [];
  const touched: Guid[] = [];
  env.write("Edit layers", () => {
    for (const u of updates) {
      const id = normId(u.nodeId);
      const n = read(env, id);
      if (!n) {
        errors.push(`${id}: no such layer`);
        continue;
      }
      const { nodeId: _id, ...spec } = u;
      const fields = fieldsOf(spec, env.ed.withRealType(n), parentOf(env, n), errors);
      if (!Object.keys(fields).length) continue;
      env.ed.engine.setProps([id], fields);
      touched.push(id);
    }
  });
  const result = textResult({ updated: touched, ...(errors.length ? { warnings: errors } : {}) });
  result.touched = touched;
  return result;
}

/** Runs an engine command on `refs` as the selection, then puts the selection back (the agent's reads default to it). */
function onSelection<T>(env: ToolEnv, refs: readonly Guid[], fn: () => T): T {
  const before = [...env.ed.selection];
  const page = currentPage(env);
  const target = pageOf(env, refs[0]);
  if (target && target !== page) env.ed.engine.setCurrentPage(target);
  env.ed.engine.setSelection(refs);
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
  return textResult(left.length ? { deleted: refs.length - left.length, notDeleted: left } : { deleted: refs.length });
}

function duplicateNodes(env: ToolEnv, args: Spec): ToolResult {
  const refs = targets(env, { nodeIds: args.nodeIds });
  let copies: Guid[] = [];
  env.write("Duplicate", () => {
    copies = onSelection(env, refs, () => {
      env.ed.engine.command("DUPLICATE");
      return [...env.ed.engine.getSelection().refs];
    });
    if (!copies.length) throw new ToolError("The layers couldn't be duplicated.");
    if (args.parentId) {
      const parent = must(env, normId(args.parentId));
      env.ed.engine.moveNodes(copies, parent.guid, parent.childIds?.length ?? 0);
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
  const result = textResult({ copies: copies.map((id) => brief(env, read(env, id)!)) });
  result.touched = copies;
  return result;
}

function reparentNodes(env: ToolEnv, args: Spec): ToolResult {
  const refs = targets(env, { nodeIds: args.nodeIds });
  const parent = must(env, normId(args.parentId));
  const index = typeof args.index === "number" ? args.index : (parent.childIds?.length ?? 0);
  let moved = 0;
  env.write("Move layers", () => {
    moved = env.ed.engine.moveNodes(refs, parent.guid, index);
  });
  if (!moved) return textResult("The layers couldn't be moved there (a layer into itself, or a page into a layer).", true);
  const result = textResult({ moved: refs });
  result.touched = refs;
  return result;
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

const NUMBER_FIELDS: Record<string, string> = {
  width: "WIDTH", height: "HEIGHT", itemspacing: "STACK_SPACING", counteraxisspacing: "STACK_COUNTER_SPACING",
  paddingleft: "STACK_PADDING_LEFT", paddingtop: "STACK_PADDING_TOP", paddingright: "STACK_PADDING_RIGHT", paddingbottom: "STACK_PADDING_BOTTOM",
  cornerradius: "CORNER_RADIUS", opacity: "OPACITY", fontsize: "FONT_SIZE", lineheight: "LINE_HEIGHT", letterspacing: "LETTER_SPACING",
  strokeweight: "STROKE_WEIGHT", characters: "TEXT_DATA", visible: "VISIBLE",
};

function applyVariable(env: ToolEnv, args: Spec): ToolResult {
  const n = must(env, normId(args.nodeId));
  const variable = normId(args.variableId);
  const v = env.ed.engine.variable(variable);
  if (!v) throw new ToolError(`No variable ${variable} (get_variable_defs with all: true lists them).`);
  const field = String(args.field ?? "").trim();
  const lower = field.toLowerCase().replace(/[_\s-]/g, "");
  env.write("Apply variable", () => {
    if (lower === "fill" || lower === "fills" || lower === "stroke" || lower === "strokes") bindPaint(env.ed, [n.guid], lower.startsWith("fill") ? "fillPaints" : "strokePaints", 0, v.id);
    else {
      const target = NUMBER_FIELDS[lower] ?? (/^[A-Z_]+$/.test(field) ? field : null);
      if (!target) throw new ToolError(`field ${field}: fill, stroke, width, height, itemSpacing, padding…, cornerRadius, opacity, fontSize`);
      bindVariable(env.ed, [n.guid], target === "CORNER_RADIUS" ? ["RECTANGLE_TOP_LEFT_CORNER_RADIUS", "RECTANGLE_TOP_RIGHT_CORNER_RADIUS", "RECTANGLE_BOTTOM_LEFT_CORNER_RADIUS", "RECTANGLE_BOTTOM_RIGHT_CORNER_RADIUS"] : [target], v.id);
    }
  });
  const result = textResult({ bound: { node: n.guid, field, variable: v.name } });
  result.touched = [n.guid];
  return result;
}

function applyStyleTool(env: ToolEnv, args: Spec): ToolResult {
  const refs = targets(env, { nodeIds: args.nodeIds });
  const slot = String(args.slot ?? "") as "fill" | "stroke" | "text" | "effect" | "grid";
  if (!["fill", "stroke", "text", "effect", "grid"].includes(slot)) throw new ToolError("slot: fill, stroke, text, effect or grid");
  const style = normId(args.styleId);
  if (!env.ed.engine.styles(undefined, { includeRemote: true }).some((s) => s.id === style)) throw new ToolError(`No style ${style} (get_variable_defs with all: true lists them).`);
  env.write("Apply style", () => applyStyle(env.ed, refs, slot, style));
  const result = textResult({ applied: { nodes: refs, slot, style } });
  result.touched = refs;
  return result;
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
        return createNodes(env, args);
      case "update_nodes":
        return updateNodes(env, args);
      case "delete_nodes":
        return deleteNodes(env, args);
      case "duplicate_nodes":
        return duplicateNodes(env, args);
      case "reparent_nodes":
        return reparentNodes(env, args);
      case "set_auto_layout":
        return setAutoLayout(env, args);
      case "apply_variable":
        return applyVariable(env, args);
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

