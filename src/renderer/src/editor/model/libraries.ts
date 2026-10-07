/**
 * Libraries, pure (docs/data.md §9, docs/schema.md §8): payloads as the engine's `encodeAssets` writes them (an
 * asset's nodes and every node it depends on; each asset root carrying its `key` and the `version` it was published
 * at), the library copies under the internal canvas, and how payloads become copies — only the engine writes them;
 * `planImport` models its import and update rules for the tests.
 *
 * GUIDs in the engine's JSON are "s:l" strings at the top level (`guid`, `parentIndex.guid`) and `{sessionID,
 * localID}` objects inside structures (both forms are read).
 */
import type { Guid, Message, NodeChange } from "@/engine/codec";

export type AssetKind = "COMPONENT" | "COMPONENT_SET" | "STYLE" | "VARIABLE_COLLECTION" | "VARIABLE";

/** A node with the fields libraries read (schema names). */
export type LNode = NodeChange & {
  type?: string;
  key?: string;
  version?: string;
  publishedVersion?: string;
  sourceLibraryKey?: string;
  publishID?: GuidLike;
  libraryMoveInfo?: { oldKey?: string; pasteFileKey?: string };
  isPublishable?: boolean;
  isSymbolPublishable?: boolean;
  isStateGroup?: boolean;
  isSoftDeleted?: boolean;
  internalOnly?: boolean;
  styleType?: string;
  variableSetID?: { guid?: GuidLike };
  variableResolvedType?: string;
  overrideKey?: GuidLike;
  description?: string;
};

export type GuidLike = string | { sessionID: number; localID: number };

export const guidText = (g: GuidLike | null | undefined): Guid => (!g ? "" : typeof g === "string" ? g : `${g.sessionID >>> 0}:${g.localID >>> 0}`);
const guidObject = (s: Guid): { sessionID: number; localID: number } => {
  const [a, b] = s.split(":").map(Number);
  return { sessionID: a >>> 0, localID: b >>> 0 };
};
const isGuidObject = (v: unknown): v is { sessionID: number; localID: number } =>
  !!v && typeof v === "object" && typeof (v as { sessionID?: unknown }).sessionID === "number" && typeof (v as { localID?: unknown }).localID === "number" && Object.keys(v as object).length === 2;

export const isAssetKey = (k: unknown): k is string => typeof k === "string" && /^[0-9a-f]{40}$/.test(k);

// ---- The document, indexed ----------------------------------------------------------------------------------------

export interface DocIndex {
  byId: Map<Guid, LNode>;
  children: Map<Guid, Guid[]>;
  /** The internal canvas (`internalOnly`), if any */
  internal: Guid | null;
  pages: { guid: Guid; name: string }[];
  blobs: string[];
}

export function indexDocument(message: Message): DocIndex {
  const byId = new Map<Guid, LNode>();
  const children = new Map<Guid, Guid[]>();
  for (const n of message.nodeChanges as LNode[]) byId.set(n.guid, n);
  const order = (a: Guid, b: Guid) => {
    const pa = byId.get(a)?.parentIndex?.position ?? "";
    const pb = byId.get(b)?.parentIndex?.position ?? "";
    return pa < pb ? -1 : pa > pb ? 1 : 0;
  };
  for (const n of byId.values()) {
    const p = n.parentIndex?.guid;
    if (!p) continue;
    const list = children.get(p);
    if (list) list.push(n.guid);
    else children.set(p, [n.guid]);
  }
  for (const list of children.values()) list.sort(order);
  const canvases = (children.get("0:0") ?? []).map((id) => byId.get(id)!).filter((n) => n.type === "CANVAS");
  return {
    byId,
    children,
    internal: canvases.find((c) => c.internalOnly)?.guid ?? null,
    pages: canvases.filter((c) => !c.internalOnly).map((c) => ({ guid: c.guid, name: c.name ?? "" })),
    blobs: message.blobs ?? [],
  };
}

/** The node and every descendant, parents first. */
export function subtreeIds(doc: DocIndex, root: Guid): Guid[] {
  const out: Guid[] = [];
  const visit = (id: Guid) => {
    out.push(id);
    for (const c of doc.children.get(id) ?? []) visit(c);
  };
  if (doc.byId.has(root)) visit(root);
  return out;
}

// ---- Local assets (the library side: the engine's localAssets, in the Publish modal's shape) ------------------------------

export interface LocalAsset {
  guid: Guid;
  kind: AssetKind;
  name: string;
  description: string;
  key: string | null;
  styleType?: "FILL" | "TEXT" | "EFFECT" | "GRID";
  resolvedType?: "COLOR" | "FLOAT" | "STRING" | "BOOLEAN";
  /** A variable's collection */
  collection?: Guid;
  /** Assets panel grouping */
  containingFrame?: { pageName: string; frameName?: string };
  /** Excluded from publishing: Hide when publishing, a `_` / `.` name, a variable of a hidden collection */
  hidden: boolean;
  /** Can be switched by "Hide when publishing" (a hidden name or collection can't) */
  hiddenByFlag: boolean;
  /** Its versionHash at the last publish (the publish modal's Modified / Removed) */
  publishedVersion: string | null;
  softDeleted: boolean;
  /** Pasted from another library (Move to this file / Publish as a copy) */
  movedFrom: { oldKey: string; pasteFileKey: string } | null;
}

const STYLE_TYPES = new Set(["FILL", "TEXT", "EFFECT", "GRID"]);
/** Fields never written into a copy: the engine derives them. */
const DERIVED = new Set(["childIds", "fillGeometry", "strokeGeometry", "derivedSymbolData", "derivedTextData", "derived", "textLayout"]);

// ---- Copies (the consuming side) ----------------------------------------------------------------------------------

/** A library copy in this file: an asset root under the internal canvas with `sourceLibraryKey`. */
export interface LibraryCopy {
  guid: Guid;
  library: string;
  key: string;
  version: string;
  publishID: Guid;
  kind: AssetKind;
  name: string;
}

export function libraryCopies(doc: DocIndex): LibraryCopy[] {
  const out: LibraryCopy[] = [];
  for (const id of doc.internal ? (doc.children.get(doc.internal) ?? []) : []) {
    const n = doc.byId.get(id);
    if (!n || !n.sourceLibraryKey || !n.key) continue;
    const kind: AssetKind | null =
      n.type === "SYMBOL" ? "COMPONENT" : n.type === "FRAME" && n.isStateGroup ? "COMPONENT_SET" : n.type === "VARIABLE_SET" ? "VARIABLE_COLLECTION" : n.type === "VARIABLE" ? "VARIABLE" : n.styleType && STYLE_TYPES.has(n.styleType) ? "STYLE" : null;
    if (!kind) continue;
    out.push({ guid: n.guid, library: n.sourceLibraryKey, key: n.key, version: n.version ?? "", publishID: guidText(n.publishID), kind, name: n.name ?? "" });
  }
  return out;
}

/** The effective key of a library node (its `overrideKey`, else its GUID) as "s:l". */
const effectiveKeyOf = (n: LNode): Guid => guidText(n.overrideKey ?? n.guid);

/** Fields a copy always carries (schema.md §8.2); the payload's own place and publishing state are not kept. */
const COPY_DROPPED = new Set(["publishedVersion", "libraryMoveInfo", "isPublishable", "isSymbolPublishable", "isSoftDeleted", "ancestorPathBeforeDeletion", "parentIndex", "phase", "guid", "childIds"]);

export interface ImportPlan {
  /** CREATED / updated / REMOVED nodes, parents first (an update carries `null` for fields the new version dropped) */
  changes: NodeChange[];
  /** library asset key → the copy root's GUID here */
  roots: Map<string, Guid>;
}

export interface PayloadIn {
  key: string;
  versionHash: string;
  message: Message;
}

/**
 * The asset roots of payload Messages: nodes whose parent isn't in them and that carry an asset `key`. A payload
 * holds its asset's nodes (what this editor publishes) or, from the engine's `encodeAssets`, the asset and every
 * node it depends on (docs/engine-build.md "E6 libraries") — either way each root is one asset (its `version` the
 * versionHash it was published at), nodes shared by several payloads counted once.
 */
export function payloadRoots(payloads: readonly PayloadIn[]): { nodes: Map<Guid, LNode>; children: Map<Guid, Guid[]>; roots: { node: LNode; key: string; version: string }[] } {
  const nodes = new Map<Guid, LNode>();
  for (const p of payloads) for (const n of p.message.nodeChanges as LNode[]) if (!nodes.has(n.guid)) nodes.set(n.guid, n);
  const children = new Map<Guid, Guid[]>();
  for (const n of nodes.values()) {
    const parent = n.parentIndex?.guid;
    if (parent && nodes.has(parent)) children.set(parent, [...(children.get(parent) ?? []), n.guid]);
  }
  const versions = new Map(payloads.map((p) => [p.key, p.versionHash]));
  const roots: { node: LNode; key: string; version: string }[] = [];
  const seen = new Set<string>();
  for (const n of nodes.values()) {
    if (n.parentIndex?.guid && nodes.has(n.parentIndex.guid)) continue;
    const key = isAssetKey(n.key) ? n.key : null;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    roots.push({ node: n, key, version: versions.get(key) ?? n.version ?? "" });
  }
  // A payload whose root carries no key (an old one): its first parentless node is its asset.
  for (const p of payloads) {
    if (seen.has(p.key)) continue;
    const list = p.message.nodeChanges as LNode[];
    const root = list.find((n) => !n.parentIndex?.guid || !nodes.has(n.parentIndex.guid));
    if (root) {
      seen.add(p.key);
      roots.push({ node: root, key: p.key, version: p.versionHash });
    }
  }
  return { nodes, children, roots };
}

/** The root node of one asset in a payload Message (the node carrying its key; else the first parentless one). */
export function payloadRoot(message: Message, key: string): LNode | null {
  const list = message.nodeChanges as LNode[];
  const ids = new Set(list.map((n) => n.guid));
  return list.find((n) => n.key === key && !(n.parentIndex?.guid && ids.has(n.parentIndex.guid))) ?? list.find((n) => !(n.parentIndex?.guid && ids.has(n.parentIndex.guid))) ?? null;
}

export interface PlanOptions {
  /** Replace copies already here with the payloads' versions (an update); else they are reused as they are */
  update?: boolean;
  /** Only these keys are replaced (update); other roots are added when missing */
  keys?: readonly string[];
}

/**
 * Turns payloads into copies under `internal` (docs/schema.md §8.2): new GUIDs from `newGuid` for nodes the file
 * doesn't have; a copy already here is reused as it is (an import never downgrades or silently updates it) or, in
 * an update, rewritten in place — its nodes matched by the library node's effective key, so every GUID instances
 * and overrides point at stays, and nodes the new version no longer has are removed. References inside the payloads
 * to other assets of the library (nested instances' components, styles, aliased variables, collections) point at
 * their copies here; override paths stay keys. Copy roots carry `sourceLibraryKey`, `key`, `version`, `publishID`;
 * every component inside one its own `publishID` (the engine's encoding).
 */
export function planImport(doc: DocIndex, library: string, payloads: readonly PayloadIn[], internal: Guid, newGuid: () => Guid, position: (i: number) => string, opts: PlanOptions = {}): ImportPlan {
  const copies = libraryCopies(doc).filter((c) => c.library === library);
  const byKey = new Map(copies.map((c) => [c.key, c]));
  const wanted = (key: string) => !opts.keys || opts.keys.includes(key);
  const roots = new Map<string, Guid>();
  const { nodes: all, children, roots: assetRoots } = payloadRoots(payloads);
  const subtree = (id: Guid): LNode[] => {
    const out: LNode[] = [];
    const visit = (g: Guid) => {
      const n = all.get(g);
      if (!n) return;
      out.push(n);
      for (const c of children.get(g) ?? []) visit(c);
    };
    visit(id);
    return out;
  };
  // Library GUID → GUID here: every node of every payload, and the copies already here (their publishID / key).
  const map = new Map<Guid, Guid>();
  for (const c of copies) {
    for (const id of subtreeIds(doc, c.guid)) {
      const n = doc.byId.get(id)!;
      const lib = guidText(n.publishID) || (id === c.guid ? "" : guidText(n.overrideKey));
      if (lib && !map.has(lib)) map.set(lib, id);
    }
  }
  const plans: { nodes: LNode[]; existing: Map<Guid, LNode>; rootLib: Guid; key: string; version: string; keep: Set<Guid> }[] = [];
  for (const r of assetRoots) {
    const have = byKey.get(r.key);
    if (have && !(opts.update && wanted(r.key))) {
      // Already here: reused as it is.
      map.set(r.node.guid, have.guid);
      roots.set(r.key, have.guid);
      continue;
    }
    const nodes = subtree(r.node.guid);
    const existing = new Map<Guid, LNode>();
    if (have) for (const id of subtreeIds(doc, have.guid)) existing.set(id === have.guid ? "#root" : guidText(doc.byId.get(id)!.overrideKey ?? id), doc.byId.get(id)!);
    const keep = new Set<Guid>();
    for (const n of nodes) {
      const match = n === r.node ? existing.get("#root") : existing.get(effectiveKeyOf(n));
      const id = match?.guid ?? newGuid();
      keep.add(id);
      map.set(n.guid, id);
    }
    roots.set(r.key, map.get(r.node.guid)!);
    plans.push({ nodes, existing, rootLib: r.node.guid, key: r.key, version: r.version, keep });
  }
  const remap = (v: unknown, key: string): unknown => {
    if (key === "guidPath" || v === null || typeof v !== "object") return v;
    if (Array.isArray(v)) return v.map((x) => remap(x, key));
    if (isGuidObject(v)) {
      const to = map.get(guidText(v));
      return to ? guidObject(to) : v;
    }
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if ((k === "symbolID" || k === "overriddenSymbolID" || k === "guid") && typeof x === "string" && map.has(x)) out[k] = map.get(x);
      else out[k] = remap(x, k);
    }
    return out;
  };
  const changes: NodeChange[] = [];
  const removed: NodeChange[] = [];
  plans.forEach((plan, i) => {
    for (const n of plan.nodes) {
      const id = map.get(n.guid)!;
      const isRoot = n.guid === plan.rootLib;
      const fields: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(n)) if (!COPY_DROPPED.has(k) && v !== undefined) fields[k] = remap(v, k);
      fields.overrideKey = guidObject(effectiveKeyOf(n));
      if (n.type === "SYMBOL" || (n.type === "FRAME" && n.isStateGroup)) fields.publishID = guidObject(n.guid);
      if (isRoot) Object.assign(fields, { sourceLibraryKey: library, key: plan.key, version: plan.version, publishID: guidObject(plan.rootLib) });
      const parent = isRoot ? internal : (map.get(n.parentIndex?.guid ?? "") ?? internal);
      const prior = doc.byId.get(id);
      const parentIndex = isRoot && prior?.parentIndex ? prior.parentIndex : { guid: parent, position: isRoot ? position(i) : (n.parentIndex?.position ?? "!") };
      if (!prior) {
        changes.push({ ...fields, guid: id, phase: "CREATED", parentIndex } as unknown as NodeChange);
        continue;
      }
      const update: Record<string, unknown> = { ...fields, guid: id, parentIndex };
      for (const k of Object.keys(prior)) if (!(k in update) && !COPY_DROPPED.has(k) && !DERIVED.has(k) && k !== "type") update[k] = null;
      changes.push(update as unknown as NodeChange);
    }
    for (const n of plan.existing.values()) if (!plan.keep.has(n.guid)) removed.push({ guid: n.guid, phase: "REMOVED" } as NodeChange);
  });
  return { changes: [...changes, ...removed.reverse()], roots };
}

/** The (key, version) pairs of the copies from `library` (what `diff` compares), each once. */
export function copiesHave(copies: readonly LibraryCopy[], library: string): { key: string; versionHash: string }[] {
  const seen = new Set<string>();
  const out: { key: string; versionHash: string }[] = [];
  for (const c of copies) {
    if (c.library !== library || seen.has(`${c.key}@${c.version}`)) continue;
    seen.add(`${c.key}@${c.version}`);
    out.push({ key: c.key, versionHash: c.version });
  }
  return out;
}
