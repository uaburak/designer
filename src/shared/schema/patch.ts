/**
 * The property-patch model (docs/schema.md §4) as a generic node table, shared by the store (compaction, restore
 * diffs, library payloads, import) and the UI. Nothing here knows what a field means: the merge is driven by the
 * schema, exactly as the engine's scene/Apply.
 *
 *   REMOVED  → delete the node if present (sent for every node of a removed subtree; nobody infers descendants)
 *   CREATED  → full replace: a live GUID is deleted first, then the node is created with exactly the carried fields
 *   update   → the node must exist; every carried top-level field replaces the stored one wholesale, then every id in
 *              `clearedFields` is deleted (a clear is a write)
 *
 * Blob-index fields (`@blob`) index into their Message's `blobs`; the table keeps its own pool (deduplicated by
 * content) and re-densifies indices when it writes a Message.
 */
import { NODE_FIELDS, FIELD_FLAGS, type Message, type NodeChange, type NodeType } from "./document.generated";
import { compareGuids, guidKey, type GUID } from "./guid";
import { MODEL, type SchemaModel } from "./model";
import { bytesEqual, mapValue, toHex, valuesEqual, walkValue } from "./visit";

/* eslint-disable @typescript-eslint/no-explicit-any -- generic field access on decoded kiwi objects */

const FIELD_BY_ID = new Map(NODE_FIELDS.map((f) => [f.id, f]));
const FIELD_BY_NAME = new Map(NODE_FIELDS.map((f) => [f.name as string, f]));
/** Fields a change may never clear (docs/schema.md §4.2.1). */
const UNCLEARABLE = new Set(["guid", "phase", "parentIndex", "type", "guidPath", "clearedFields"]);
/**
 * `@derived` NodeChange fields (docs/schema.md §1.3): the engine's caches — `fillGeometry`, `strokeGeometry`,
 * `derivedTextData`, `derivedSymbolData`. Never in a change Message or the journal; a snapshot may carry them with
 * `Message.derivedDataVersion` (the engine version that computed them), as Figma's files do, so an open draws its
 * first frame from stored geometry and glyph outlines before fonts arrive. A reader ignores them when the version is
 * not its own; the table drops a node's when a change touches the node (they were computed from its old values).
 */
export const DERIVED_FIELDS: ReadonlySet<string> = new Set(NODE_FIELDS.filter((f) => f.flags & FIELD_FLAGS.DERIVED).map((f) => f.name));

/** `node` without its `@derived` fields (the same object when it has none). */
export function withoutDerived<T extends object>(node: T): T {
  let stripped: any = null;
  for (const f of DERIVED_FIELDS) {
    if (f in node) {
      stripped ??= { ...node };
      delete stripped[f];
    }
  }
  return stripped ?? node;
}

/** Does any node of the Message carry a `@derived` field? */
export function hasDerivedFields(message: Message): boolean {
  for (const n of message.nodeChanges ?? []) for (const f of DERIVED_FIELDS) if (f in n) return true;
  return false;
}

export const nodeFieldId = (name: string): number | undefined => FIELD_BY_NAME.get(name)?.id;
export const nodeFieldName = (id: number): string | undefined => FIELD_BY_ID.get(id)?.name;

// ---------------------------------------------------------------------------------------------------------------------
// Blobs
// ---------------------------------------------------------------------------------------------------------------------

/** FNV-1a over the bytes: a cheap content key (equality is always confirmed byte by byte). */
function hashBytes(b: Uint8Array): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < b.length; i++) {
    h ^= b[i];
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Content-deduplicated blob storage. Indices are stable for the pool's life. */
export class BlobPool {
  private readonly items: Uint8Array[] = [];
  private readonly byHash = new Map<string, number[]>();

  get size(): number {
    return this.items.length;
  }

  add(bytes: Uint8Array): number {
    const key = `${hashBytes(bytes)}:${bytes.length}`;
    const list = this.byHash.get(key);
    if (list) for (const i of list) if (bytesEqual(this.items[i], bytes)) return i;
    const i = this.items.push(bytes.slice()) - 1;
    if (list) list.push(i);
    else this.byHash.set(key, [i]);
    return i;
  }

  get(index: number): Uint8Array | undefined {
    return this.items[index];
  }
}

/** Collects the blobs a Message references, densely, in first-reference order. */
export class DenseBlobs {
  readonly blobs: { bytes: Uint8Array }[] = [];
  private readonly map = new Map<number, number>();
  constructor(private readonly pool: BlobPool) {}

  index(poolIndex: number): number {
    let i = this.map.get(poolIndex);
    if (i === undefined) {
      i = this.blobs.push({ bytes: this.pool.get(poolIndex) ?? new Uint8Array(0) }) - 1;
      this.map.set(poolIndex, i);
    }
    return i;
  }
}

/** Rewrites every blob-index field under a NodeChange (at any depth) through `map`. Never mutates the input. */
export function rebaseBlobIndices(model: SchemaModel, node: NodeChange, map: (index: number) => number): NodeChange {
  const owners = model.blobOwners();
  if (!owners.size) return node;
  return mapValue(model, "NodeChange", node, owners, (def, value) => {
    let copy: any = null;
    for (const key in value) {
      if (!model.isBlobField(def, key) || typeof value[key] !== "number") continue;
      const next = map(value[key]);
      if (next !== value[key]) {
        copy ??= { ...value };
        copy[key] = next;
      }
    }
    return copy ?? value;
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// The node table
// ---------------------------------------------------------------------------------------------------------------------

export interface ApplyReport {
  created: number;
  /** CREATED for a live GUID (treated as a full replace) */
  replaced: number;
  updated: number;
  removed: number;
  /** REMOVED for a GUID that was not there (ignored, as the contract says) */
  ignoredRemoves: number;
  /** Updates for absent nodes ("report and skip") */
  missing: string[];
  /** `clearedFields` ids that are unknown or may not be cleared */
  invalidClears: number;
  /** NodeChanges without a guid */
  invalid: number;
  /** Blob indices pointing outside their Message's blobs (replaced by an empty blob) */
  badBlobRefs: number;
}

export const emptyApplyReport = (): ApplyReport => ({ created: 0, replaced: 0, updated: 0, removed: 0, ignoredRemoves: 0, missing: [], invalidClears: 0, invalid: 0, badBlobRefs: 0 });

export interface ToMessageOptions {
  /**
   * Keep the `@derived` fields the table holds (and write their `derivedDataVersion`): disk snapshots, versions,
   * what the engine loads. Default false: a payload, a diff, a snapshot for another engine.
   */
  keepDerived?: boolean;
  sessionID?: number;
}

/** Type conversions that keep the GUID and travel as an update (docs/schema.md §3.2). */
export function isTypeConversion(from: NodeType | undefined, to: NodeType | undefined): boolean {
  if (from === to) return true;
  if (from === "FRAME" && to === "SYMBOL") return true;
  if (from === "INSTANCE" && to === "FRAME") return true;
  const flattenable: (NodeType | undefined)[] = ["ROUNDED_RECTANGLE", "RECTANGLE", "ELLIPSE", "LINE", "STAR", "REGULAR_POLYGON", "BOOLEAN_OPERATION", "TEXT", "VECTOR"];
  return to === "VECTOR" && flattenable.includes(from);
}

export class NodeTable {
  /** Node records by "s:l": every field of the node, without `phase` and `clearedFields`. */
  readonly nodes = new Map<string, NodeChange>();
  readonly blobs = new BlobPool();
  /**
   * The engine version of the `@derived` fields the table's nodes carry (`Message.derivedDataVersion` of the snapshot
   * they came from); 0 when none do. A change to a node drops that node's derived fields, so what stays is current.
   */
  derivedDataVersion = 0;

  constructor(readonly model: SchemaModel = MODEL) {}

  static fromMessage(message: Message, model: SchemaModel = MODEL): NodeTable {
    const t = new NodeTable(model);
    t.apply(message);
    return t;
  }

  get size(): number {
    return this.nodes.size;
  }

  get(guid: GUID | string): NodeChange | undefined {
    return this.nodes.get(typeof guid === "string" ? guid : guidKey(guid));
  }

  blob(index: number): Uint8Array | undefined {
    return this.blobs.get(index);
  }

  /** Applies one Message as a unit (docs/schema.md §4.3). Hierarchy is not validated here; ordering resolves it. */
  apply(message: Message, report: ApplyReport = emptyApplyReport()): ApplyReport {
    const msgBlobs = message.blobs ?? [];
    const remap = new Map<number, number>();
    const toPool = (i: number): number => {
      let p = remap.get(i);
      if (p === undefined) {
        const b = msgBlobs[i];
        if (!b?.bytes) report.badBlobRefs++;
        p = this.blobs.add(b?.bytes ?? new Uint8Array(0));
        remap.set(i, p);
      }
      return p;
    };
    // A Message without blobs has no blob index to rebase: its nodes are taken as they are (a blob index it still
    // carries points at nothing either way). The walk over every node's fields is most of a large snapshot's cost.
    const rebase = msgBlobs.length ? (nc: NodeChange) => rebaseBlobIndices(this.model, nc, toPool) : (nc: NodeChange) => nc;
    // A snapshot's derived fields are of its engine version; a Message without one (a change) carries none.
    if (message.derivedDataVersion) this.derivedDataVersion = message.derivedDataVersion;
    const derivedIn = (nc: NodeChange) => {
      for (const f of DERIVED_FIELDS) if (f in nc) return true;
      return false;
    };
    for (const nc of message.nodeChanges ?? []) {
      if (!nc.guid) {
        report.invalid++;
        continue;
      }
      const key = guidKey(nc.guid);
      if (nc.phase === "REMOVED") {
        if (this.nodes.delete(key)) report.removed++;
        else report.ignoredRemoves++;
        continue;
      }
      if (nc.phase === "CREATED") {
        // A change creating a node carries no derived fields (a snapshot's CREATED nodes may); a change that does
        // is of a version the table can't name, so its caches are dropped.
        const rec: any = rebase(nc);
        const clean: any = message.derivedDataVersion || !derivedIn(nc) ? { ...rec } : withoutDerived({ ...rec });
        delete clean.phase;
        delete clean.clearedFields;
        if (this.nodes.has(key)) report.replaced++;
        else report.created++;
        this.nodes.set(key, clean);
        continue;
      }
      const cur = this.nodes.get(key);
      if (!cur) {
        report.missing.push(key);
        continue;
      }
      const carried: any = rebase(nc);
      // The node's derived fields were computed from the values this change replaces: they go with it.
      const next: any = withoutDerived({ ...cur });
      for (const f in carried) {
        if (DERIVED_FIELDS.has(f)) continue;
        if (f === "guid" || f === "phase" || f === "clearedFields") continue;
        if (carried[f] === undefined) continue;
        next[f] = carried[f];
      }
      for (const id of nc.clearedFields ?? []) {
        const name = nodeFieldName(id);
        if (!name || UNCLEARABLE.has(name)) {
          report.invalidClears++;
          continue;
        }
        delete next[name];
      }
      this.nodes.set(key, next);
      report.updated++;
    }
    return report;
  }

  /**
   * Snapshot order (docs/schema.md §4.1): DOCUMENT first, then pre-order with children by position (ties by GUID).
   * Nodes not reachable from a root (orphans, cycles) follow, so they round-trip.
   */
  orderedKeys(): string[] {
    const children = new Map<string, string[]>();
    const roots: string[] = [];
    for (const [key, n] of this.nodes) {
      const p = n.parentIndex?.guid;
      const pk = p ? guidKey(p) : null;
      if (pk !== null && pk !== key && this.nodes.has(pk)) {
        let list = children.get(pk);
        if (!list) children.set(pk, (list = []));
        list.push(key);
      } else roots.push(key);
    }
    const byPosition = (a: string, b: string) => {
      const na = this.nodes.get(a)!;
      const nb = this.nodes.get(b)!;
      const pa = na.parentIndex?.position ?? "";
      const pb = nb.parentIndex?.position ?? "";
      return pa < pb ? -1 : pa > pb ? 1 : compareGuids(na.guid!, nb.guid!);
    };
    for (const list of children.values()) list.sort(byPosition);
    const byGuid = (a: string, b: string) => compareGuids(this.nodes.get(a)!.guid!, this.nodes.get(b)!.guid!);
    roots.sort((a, b) => (a === "0:0" ? -1 : b === "0:0" ? 1 : byGuid(a, b)));
    const out: string[] = [];
    const seen = new Set<string>();
    const visit = (root: string) => {
      const stack = [root];
      while (stack.length) {
        const k = stack.pop()!;
        if (seen.has(k)) continue;
        seen.add(k);
        out.push(k);
        const kids = children.get(k);
        if (kids) for (let i = kids.length - 1; i >= 0; i--) if (!seen.has(kids[i])) stack.push(kids[i]);
      }
    };
    for (const r of roots) visit(r);
    if (out.length < this.nodes.size) {
      const rest = [...this.nodes.keys()].filter((k) => !seen.has(k)).sort(byGuid);
      for (const k of rest) visit(k);
    }
    return out;
  }

  /** The table as a snapshot Message: every node CREATED, in snapshot order, with a dense blob table. */
  toMessage(opts: ToMessageOptions = {}): Message {
    const dense = new DenseBlobs(this.blobs);
    const nodeChanges: NodeChange[] = [];
    for (const n of this.snapshotNodes(opts, dense)) nodeChanges.push({ ...n, phase: "CREATED" });
    const out: Message = { type: "NODE_CHANGES", sessionID: opts.sessionID ?? 0, ackID: 0, nodeChanges, blobs: dense.blobs };
    if (opts.keepDerived && this.derivedDataVersion) out.derivedDataVersion = this.derivedDataVersion;
    return out;
  }

  /**
   * The nodes of a snapshot, in snapshot order, derived fields stripped (unless kept) and blob indices rebased onto
   * `dense` (which collects the blobs referenced) — without `phase`. `toMessage` wraps them; a converter that wants
   * another shape (the engine's) reads them straight from here instead of converting a Message twice.
   */
  *snapshotNodes(opts: ToMessageOptions = {}, dense: DenseBlobs = new DenseBlobs(this.blobs)): IterableIterator<NodeChange> {
    const rebase = this.blobs.size > 0;
    for (const key of this.orderedKeys()) {
      let n: any = this.nodes.get(key)!;
      if (!opts.keepDerived) n = withoutDerived(n);
      if (rebase) n = rebaseBlobIndices(this.model, n, (i) => dense.index(i));
      yield n as NodeChange;
    }
  }

  /** A dense blob table for `snapshotNodes` (its `blobs` are the Message's `blobs`, in first-reference order). */
  denseBlobs(): DenseBlobs {
    return new DenseBlobs(this.blobs);
  }

  clone(): NodeTable {
    const t = new NodeTable(this.model);
    t.apply(this.toMessage({ keepDerived: true }));
    t.derivedDataVersion = this.derivedDataVersion;
    return t;
  }

  /** SHA-1 hex of every image referenced (`Image.hash`, paints and thumbnails at any depth): the file's blob refs. */
  imageHashes(): Set<string> {
    const out = new Set<string>();
    const targets = new Set(["Image"]);
    for (const n of this.nodes.values()) {
      walkValue(this.model, "NodeChange", n, targets, (_def, v) => {
        if (v.hash instanceof Uint8Array && v.hash.length) out.add(toHex(v.hash));
      });
    }
    return out;
  }
}

/** Every image hash (hex) a Message references. */
export function messageImageHashes(message: Message, model: SchemaModel = MODEL): Set<string> {
  const out = new Set<string>();
  const targets = new Set(["Image"]);
  for (const n of message.nodeChanges ?? []) {
    walkValue(model, "NodeChange", n, targets, (_def, v) => {
      if (v.hash instanceof Uint8Array && v.hash.length) out.add(toHex(v.hash));
    });
  }
  return out;
}

/**
 * The change Message that turns `current` into `target` (docs/data.md §6, restore): REMOVED for nodes the target
 * lacks (children first), full CREATED for nodes `current` lacks (parents first), field-level updates with
 * `clearedFields` for the rest. A type change that is not a conversion is written as REMOVED + CREATED.
 */
export function diffTables(current: NodeTable, target: NodeTable, model: SchemaModel = MODEL): Message {
  const out: NodeChange[] = [];
  const dense = new DenseBlobs(target.blobs);
  const rebase = (n: NodeChange) => rebaseBlobIndices(model, n, (i) => dense.index(i));
  const ncDef = model.def("NodeChange");

  const currentOrder = current.orderedKeys();
  for (let i = currentOrder.length - 1; i >= 0; i--) {
    const key = currentOrder[i];
    if (!target.nodes.has(key)) out.push({ guid: current.nodes.get(key)!.guid, phase: "REMOVED" });
  }
  for (const key of target.orderedKeys()) {
    const t: any = withoutDerived(target.nodes.get(key)!);
    const c: any = current.nodes.get(key);
    if (!c) {
      out.push({ ...rebase(t), phase: "CREATED" });
      continue;
    }
    if (!isTypeConversion(c.type, t.type)) {
      out.push({ guid: t.guid, phase: "REMOVED" });
      out.push({ ...rebase(t), phase: "CREATED" });
      continue;
    }
    const change: any = { guid: t.guid };
    const cleared: number[] = [];
    let changed = false;
    for (const f of new Set([...Object.keys(t), ...Object.keys(c)])) {
      if (f === "guid" || f === "phase" || f === "clearedFields" || DERIVED_FIELDS.has(f)) continue;
      const fd = ncDef.byName.get(f);
      if (!fd || !fd.type) continue;
      if (t[f] === undefined) {
        if (c[f] !== undefined && !UNCLEARABLE.has(f)) {
          cleared.push(fd.value);
          changed = true;
        }
        continue;
      }
      if (c[f] !== undefined && valuesEqual(model, fd.type, fd.isArray, t[f], c[f], (i) => target.blob(i), (i) => current.blob(i))) continue;
      change[f] = t[f];
      changed = true;
    }
    if (!changed) continue;
    if (cleared.length) change.clearedFields = cleared.sort((a, b) => a - b);
    out.push(rebase(change));
  }
  return { type: "NODE_CHANGES", sessionID: 0, ackID: 0, nodeChanges: out, blobs: dense.blobs };
}

/** True when two tables hold the same nodes with equal fields (blob-aware). */
export function tablesEqual(a: NodeTable, b: NodeTable, model: SchemaModel = MODEL): boolean {
  if (a.size !== b.size) return false;
  for (const [key, na] of a.nodes) {
    const nb = b.nodes.get(key);
    if (!nb) return false;
    if (!valuesEqual(model, "NodeChange", false, withoutPatchFields(na), withoutPatchFields(nb), (i) => a.blob(i), (i) => b.blob(i))) return false;
  }
  return true;
}

function withoutPatchFields(n: NodeChange): NodeChange {
  const s: any = { ...n };
  delete s.phase;
  delete s.clearedFields;
  return s;
}

/** Applies messages to an empty table: the compaction merge (snapshot + frames → snapshot). */
export function mergeMessages(messages: Iterable<Message>, model: SchemaModel = MODEL): { table: NodeTable; report: ApplyReport } {
  const table = new NodeTable(model);
  const report = emptyApplyReport();
  for (const m of messages) table.apply(m, report);
  return { table, report };
}
