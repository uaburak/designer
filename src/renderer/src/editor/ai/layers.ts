/**
 * What the AI actions read of the selection (docs/ai.md §3): each selected layer's subtree as `Layer`s — top first,
 * as the Layers panel lists them — with the facts the actions' rules need (default names, hidden, locked, inside an
 * instance, an image fill, the instance's main's name), and the compact outline the prompts carry, cut into batches of
 * at most 400 layers.
 */
import type { Guid, NodeChange } from "@/engine/codec";
import { OUTLINE_MAX_DEPTH, OUTLINE_MAX_LAYERS, type OutlineNode } from "@shared/ai/prompts";
import type { EditorController } from "../controller";

export interface Layer {
  id: Guid;
  /** FRAME, GROUP, COMPONENT, COMPONENT_SET, INSTANCE, TEXT, RECTANGLE, VECTOR, ELLIPSE, SECTION … */
  type: string;
  name: string;
  hidden: boolean;
  locked: boolean;
  width: number;
  height: number;
  /** TEXT: its characters */
  text?: string;
  /** TEXT: the name follows the characters */
  autoRename?: boolean;
  /** Has a visible IMAGE fill */
  imageFill: boolean;
  /** INSTANCE: its main component's name */
  mainName?: string;
  /** Inside an instance (a derived sublayer) */
  inInstance: boolean;
  /** The top-level frame it is in (itself for a top-level layer); null when the read started below the page and found none */
  top: Guid | null;
  /** Child indices from its top-level frame ("" for the frame itself) */
  path: string;
  /** FONT: base font (family / style) — text checks */
  font?: { family: string; style: string };
  /** TEXT: the fonts of its style runs */
  runFonts?: { family: string; style: string }[];
  children: Layer[];
}

const FIELDS = ["name", "type", "visible", "locked", "size", "textData", "autoRename", "fillPaints", "symbolData", "overriddenSymbolID", "resizeToFit", "isStateGroup", "parentIndex", "fontName"];

/** Our names for the document's types. */
export function layerType(n: NodeChange): string {
  const t = String(n.type ?? "NONE");
  if (t === "FRAME") return (n as { resizeToFit?: boolean }).resizeToFit ? "GROUP" : (n as { isStateGroup?: boolean }).isStateGroup ? "COMPONENT_SET" : "FRAME";
  if (t === "ROUNDED_RECTANGLE") return "RECTANGLE";
  if (t === "SYMBOL") return "COMPONENT";
  if (t === "REGULAR_POLYGON") return "POLYGON";
  return t;
}

const guidOf = (g: unknown): string | null => {
  if (!g) return null;
  if (typeof g === "string") return g;
  const o = g as { sessionID?: number; localID?: number };
  return typeof o.sessionID === "number" && typeof o.localID === "number" ? `${o.sessionID}:${o.localID}` : null;
};

/** Where a layer sits: its top-level frame and its child-index path from it (by reading up). */
function placeOf(ed: EditorController, id: Guid): { top: Guid | null; path: string[]; inInstance: boolean } {
  const path: string[] = [];
  let inInstance = false;
  let cur: Guid = id;
  for (let i = 0; i < 200; i++) {
    const n = ed.engine.readNode(cur, { fields: ["parentIndex", "type"] });
    const parent = n?.parentIndex?.guid;
    if (!n || !parent) return { top: null, path, inInstance };
    const p = ed.engine.readNode(parent, { childIds: true, fields: ["type"] });
    if (!p) return { top: null, path, inInstance };
    if (p.type === "CANVAS") return { top: cur, path, inInstance };
    if (p.type === "INSTANCE") inInstance = true;
    // Layers panel order: top first (childIds are back to front).
    const kids = p.childIds ?? [];
    path.unshift(String(kids.length - 1 - kids.indexOf(cur)));
    cur = parent;
  }
  return { top: null, path, inInstance };
}

/** The selected layers' trees (each ref once; a ref inside another selected ref is read with that one). */
export function readLayers(ed: EditorController, refs: readonly Guid[]): Layer[] {
  const out: Layer[] = [];
  const seen = new Set<Guid>();
  for (const ref of refs) {
    if (seen.has(ref)) continue;
    const rows = ed.engine.readNodes([ref], { subtree: true, childIds: true, fields: FIELDS });
    if (!rows.length) continue;
    const byId = new Map(rows.map((r) => [r.guid, ed.withRealType(r)]));
    const place = placeOf(ed, ref);
    const build = (n: NodeChange, inInstance: boolean, path: string[]): Layer => {
      seen.add(n.guid);
      const type = layerType(n);
      const kids = [...(n.childIds ?? [])].reverse();
      const fills = (n.fillPaints ?? []) as { type?: string; visible?: boolean }[];
      const text = type === "TEXT" ? ((n as { textData?: { characters?: string } }).textData?.characters ?? "") : undefined;
      const main = type === "INSTANCE" ? guidOf((n as { overriddenSymbolID?: unknown }).overriddenSymbolID) || guidOf((n as { symbolData?: { symbolID?: unknown } }).symbolData?.symbolID) : null;
      const fontName = (n as { fontName?: { family?: string; style?: string } }).fontName;
      const table = ((n as { textData?: { styleOverrideTable?: { fontName?: { family?: string; style?: string } }[] } }).textData?.styleOverrideTable ?? []).map((s) => s.fontName).filter((f): f is { family: string; style: string } => !!f?.family);
      const layer: Layer = {
        id: n.guid,
        type,
        name: n.name ?? "",
        hidden: (n as { visible?: boolean }).visible === false,
        locked: (n as { locked?: boolean }).locked === true,
        width: n.size?.x ?? 0,
        height: n.size?.y ?? 0,
        ...(text !== undefined ? { text, autoRename: (n as { autoRename?: boolean }).autoRename === true } : {}),
        ...(fontName?.family ? { font: { family: fontName.family, style: fontName.style ?? "Regular" } } : {}),
        ...(table.length ? { runFonts: table.map((f) => ({ family: f.family, style: f.style ?? "Regular" })) } : {}),
        imageFill: fills.some((f) => f.type === "IMAGE" && f.visible !== false),
        ...(main ? { mainName: ed.engine.readNode(main, { fields: ["name"] })?.name ?? undefined } : {}),
        inInstance,
        top: place.top,
        path: path.join("/"),
        children: [],
      };
      layer.children = kids.map((k) => byId.get(k)).filter((c): c is NodeChange => !!c).map((c, i) => build(c, inInstance || type === "INSTANCE", [...path, String(i)]));
      return layer;
    };
    const root = byId.get(ref);
    if (root) out.push(build(root, place.inInstance, place.path));
  }
  return out;
}

/** Every layer of the trees, pre-order. */
export function flatten(roots: readonly Layer[]): Layer[] {
  const out: Layer[] = [];
  const walk = (l: Layer) => {
    out.push(l);
    l.children.forEach(walk);
  };
  roots.forEach(walk);
  return out;
}

const size = (l: Layer): number => 1 + l.children.reduce((s, c) => s + size(c), 0);
const depth = (l: Layer): number => 1 + Math.max(0, ...l.children.map(depth));

/**
 * The outline of `roots` in batches of at most `cap` layers (depth ≤ 6 below each batch root): a tree too big or too
 * deep goes in as its root alone, then its children's trees. `mark` notes a layer ("rename", "repeat" …).
 */
export function outlineBatches(roots: readonly Layer[], mark: (l: Layer) => string | undefined = () => undefined, cap = OUTLINE_MAX_LAYERS): OutlineNode[][] {
  const pieces: Layer[] = [];
  const split = (l: Layer) => {
    if (size(l) <= cap && depth(l) <= OUTLINE_MAX_DEPTH) pieces.push(l);
    else {
      pieces.push({ ...l, children: [] });
      l.children.forEach(split);
    }
  };
  roots.forEach(split);
  const toNode = (l: Layer): OutlineNode => {
    const m = mark(l);
    return { id: l.id, type: l.type, name: l.name, width: l.width, height: l.height, ...(l.text !== undefined ? { text: l.text } : {}), ...(m ? { mark: m } : {}), ...(l.children.length ? { children: l.children.map(toNode) } : {}) };
  };
  const batches: OutlineNode[][] = [];
  let cur: OutlineNode[] = [];
  let n = 0;
  for (const p of pieces) {
    const s = size(p);
    if (n + s > cap && cur.length) {
      batches.push(cur);
      cur = [];
      n = 0;
    }
    cur.push(toNode(p));
    n += s;
  }
  if (cur.length) batches.push(cur);
  return batches;
}
