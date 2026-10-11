/**
 * The three-way merge of branching (docs/data.md §15.4): base B, ours O (the side being merged in) and theirs T (the
 * side being written) → the merged table M and the change Message that turns T into M.
 *
 *   direction "merge":  O = the branch, T = main   (written to main)
 *   direction "update": O = main, T = the branch   (written to the branch)
 *
 * Per (GUID, field) — per item for the keyed fields (diff.ts) — a change made on one side is taken; the same change on
 * both is convergent; different values conflict. Removed against changed is `delete-edit`, different parents `move`,
 * moves that make a node its own ancestor `cycle`. A conflict without a side keeps T's value (nothing written for it),
 * and its id is listed in `unresolved`: such a batch must not be written. Library copies take the newer copy whole,
 * local assets keep main's library bookkeeping, siblings landing on one position are re-keyed.
 *
 * M is an overlay on T (only the nodes the merge writes are held), so a merge holds the three tables and little more.
 * Pure: no Node or DOM.
 */
import { DEFAULTS, type Message, type NodeChange } from "../schema/document.generated";
import { keysBetween } from "../schema/fractionalIndex";
import { guidKey, type GUID } from "../schema/guid";
import { MODEL, type SchemaModel } from "../schema/model";
import { BlobPool, isTypeConversion, nodeFieldId, NodeTable, rebaseBlobIndices, withoutDerived } from "../schema/patch";
import { valuesEqual, walkValue } from "../schema/visit";
import { ASSET_BOOKKEEPING, isAbsentValue } from "../store/assetIdentity";
import { ChunkSet, displayNodeOf } from "./chunks";
import { diff, fieldEqual, keyedFields, parentOf, sortKeys, valueOf, type KeyedField } from "./diff";
import { ABSENT, type Conflict, type ConflictKind, type DiffChunk, type MergeInput, type MergeResult, type NodeDelta, type Resolutions, type Side, type TableDiff, type Value } from "./types";

/* eslint-disable @typescript-eslint/no-explicit-any -- generic field access on decoded kiwi objects */

export interface MergeOptions {
  model?: SchemaModel;
  /**
   * The library version number a library copy was taken at (rule 8: the newer copy wins): the registry's version whose
   * manifest has asset `assetKey` at `versionHash`; null when unknown. Without it, the copy that moved away from the
   * base's wins, and two different updates conflict on the copy's `version`.
   */
  libraryVersion?: (libraryKey: string, assetKey: string, versionHash: string) => number | null;
}

/** Rule 11: the merged table breaks a rule no conflict explains — a bug to fix, never written. */
export class MergeInvalidError extends Error {
  constructor(
    message: string,
    readonly guids: string[],
  ) {
    super(message);
    this.name = "MergeInvalidError";
  }
}

const NODE_DEFAULTS = DEFAULTS.NodeChange as Readonly<Record<string, unknown>>;
/** Fields a change may never clear (docs/schema.md §4.2.1) */
const UNCLEARABLE: ReadonlySet<string> = new Set(["guid", "phase", "parentIndex", "type", "guidPath", "clearedFields"]);
const NOT_DATA: ReadonlySet<string> = new Set(["guid", "phase", "clearedFields", "guidPath"]);
const EMPTY = new Uint8Array(0);

/**
 * Edit stamps (docs/schema.md §12 "Dev Mode": `editInfo` is stamped on every edited layer and its ancestors up to the
 * page): a record of edits, not one. A node whose only change is a stamp makes no chunk — a rectangle added on a page
 * lists the rectangle, not "Page 1 — Edited" (Figma lists only the added layer) — and two stamps never conflict: the
 * later edit's is kept. They still travel with the merge (Dev Mode's "Changed" on main).
 */
export const EDIT_STAMPS: ReadonlySet<string> = new Set(["editInfo"]);

/** A delta that only re-stamps a node (`EDIT_STAMPS`) */
export function stampOnly(d: NodeDelta): boolean {
  return d.phase === "updated" && d.items.every((i) => EDIT_STAMPS.has(i.field)) && d.fields.every((f) => EDIT_STAMPS.has(f.field));
}

/** The later of two `editInfo` stamps (absent counts as never) */
function laterStamp(a: any, b: any): boolean {
  const at = (v: any) => (v && v !== ABSENT ? Number(v.lastEditedAt ?? v.createdAt ?? 0) : -1);
  return at(a) > at(b);
}

// ---------------------------------------------------------------------------------------------------------------------
// M: an overlay on T
// ---------------------------------------------------------------------------------------------------------------------

/** The merged table as T plus the nodes the merge wrote (null: removed). Blob indices past T's are the overlay's own. */
export class MergedTable {
  readonly over = new Map<string, NodeChange | null>();
  private readonly extra = new BlobPool();
  private children: Map<string, Set<string>> | null = null;

  constructor(readonly base: NodeTable) {}

  get(key: string): NodeChange | undefined {
    const v = this.over.get(key);
    return v === undefined ? this.base.nodes.get(key) : (v ?? undefined);
  }

  has(key: string): boolean {
    return this.get(key) !== undefined;
  }

  set(key: string, node: NodeChange): void {
    const before = this.get(key);
    this.over.set(key, node);
    if (this.children) {
      const was = parentOf(before);
      const now = parentOf(node);
      if (was !== now || !before) {
        if (was) this.children.get(was)?.delete(key);
        if (now) this.childSet(now).add(key);
      }
    }
  }

  delete(key: string): void {
    const before = this.get(key);
    if (!before) return;
    this.over.set(key, null);
    if (this.children) this.children.get(parentOf(before))?.delete(key);
  }

  blob(index: number): Uint8Array | undefined {
    const n = this.base.blobs.size;
    return index < n ? this.base.blob(index) : this.extra.get(index - n);
  }

  addBlob(bytes: Uint8Array): number {
    return this.base.blobs.size + this.extra.add(bytes);
  }

  private childSet(parent: string): Set<string> {
    let s = this.children!.get(parent);
    if (!s) this.children!.set(parent, (s = new Set()));
    return s;
  }

  /** Children of a node in M (an index built on first use, kept current by set / delete). */
  childrenOf(key: string): Set<string> {
    if (!this.children) {
      this.children = new Map();
      for (const [k, n] of this.base.nodes) if (!this.over.has(k)) this.childSet(parentOf(n)).add(k);
      for (const [k, n] of this.over) if (n) this.childSet(parentOf(n)).add(k);
    }
    return this.children.get(key) ?? new Set();
  }

  /** Every key of M */
  *keys(): IterableIterator<string> {
    for (const k of this.base.nodes.keys()) if (!this.over.has(k)) yield k;
    for (const [k, n] of this.over) if (n) yield k;
  }

  /** M as a snapshot table of its own (Compare changes' "merged" side). */
  toTable(model: SchemaModel = MODEL): NodeTable {
    const pool: { bytes: Uint8Array }[] = [];
    const map = new Map<number, number>();
    const dense = (i: number) => {
      let j = map.get(i);
      if (j === undefined) {
        j = pool.push({ bytes: this.blob(i) ?? EMPTY }) - 1;
        map.set(i, j);
      }
      return j;
    };
    const nodeChanges: NodeChange[] = [];
    for (const k of this.keys()) nodeChanges.push({ ...rebaseBlobIndices(model, this.get(k)!, dense), phase: "CREATED" });
    const t = NodeTable.fromMessage({ type: "NODE_CHANGES", sessionID: 0, ackID: 0, nodeChanges, blobs: pool }, model);
    return t;
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// References (rule 4: "a reference to it set on the other side")
// ---------------------------------------------------------------------------------------------------------------------

const REF_TARGETS: ReadonlySet<string> = new Set(["StyleId", "VariableID", "VariableSetID", "SymbolId", "SlotContentId", "SymbolData", "PrototypeAction", "ComponentPropValue"]);

function refsOf(model: SchemaModel, field: string, value: unknown, out: Set<string>): void {
  if (value === undefined || value === ABSENT) return;
  walkValue(model, "NodeChange", { [field]: value }, REF_TARGETS, (def, v) => {
    const g: GUID | undefined = def === "SymbolData" ? v.symbolID : def === "PrototypeAction" ? v.transitionNodeID : def === "ComponentPropValue" ? v.guidValue : v.guid;
    if (g && typeof g.sessionID === "number") out.add(guidKey(g));
  });
}

/** References a side's change set newly (present after, absent before). */
function newRefs(model: SchemaModel, d: NodeDelta, before: any, after: any): Set<string> {
  const fields = new Set<string>([...d.fields.map((f) => f.field), ...d.items.map((i) => i.field)]);
  const out = new Set<string>();
  for (const f of fields) {
    if (f === "parentIndex") continue;
    const now = new Set<string>();
    refsOf(model, f, after?.[f], now);
    if (!now.size) continue;
    const was = new Set<string>();
    refsOf(model, f, before?.[f], was);
    for (const r of now) if (!was.has(r)) out.add(r);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// The merge
// ---------------------------------------------------------------------------------------------------------------------

type Who = "O" | "T";

interface FieldPlan {
  field: string;
  conflict?: string;
}
interface KeyedPlan {
  field: string;
  items: { itemKey: string; conflict?: string }[];
}
type Plan =
  | { t: "takeO"; k: string }
  | { t: "fields"; k: string; sets: FieldPlan[]; keyed: KeyedPlan[] }
  | { t: "whole"; k: string; conflict: string }
  | { t: "deleteEdit"; k: string; conflict: string; removedOn: Who }
  | { t: "copy"; root: string; winner: Who | null; conflict?: string };

export interface MergeOutput {
  result: MergeResult;
  /** M (T plus what the merge writes) */
  merged: MergedTable;
}

export function merge3(input: MergeInput, opts: MergeOptions = {}): MergeResult {
  return mergeTables(input, opts).result;
}

export function mergeTables(input: MergeInput, opts: MergeOptions = {}): MergeOutput {
  const model = opts.model ?? MODEL;
  const { base: B, direction } = input;
  const O = direction === "merge" ? input.branch : input.main;
  const T = direction === "merge" ? input.main : input.branch;
  const MAIN = input.main;
  const sideO: Side = direction === "merge" ? "branch" : "main";
  const sideT: Side = direction === "merge" ? "main" : "branch";
  const resolutions: Resolutions = input.resolutions ?? {};
  const table = (w: Who) => (w === "O" ? O : T);
  const sideOf = (w: Who): Side => (w === "O" ? sideO : sideT);

  const dO = diff(B, O, { model });
  const dT = diff(B, T, { model });
  const M = new MergedTable(T);
  const keyed = keyedFields(model);

  // Nodes taken from another table get their blobs re-indexed into M.
  const imported = new Map<string, NodeChange>();
  const imp = (src: NodeTable, k: string): NodeChange | undefined => {
    const n = src.nodes.get(k);
    if (!n) return undefined;
    if (src === T) return withoutDerived(n);
    const tag = `${src === O ? "O" : src === B ? "B" : "?"}${k}`;
    let out = imported.get(tag);
    if (!out) {
      out = rebaseBlobIndices(model, withoutDerived(n), (i) => M.addBlob(src.blob(i) ?? EMPTY));
      imported.set(tag, out);
    }
    return out;
  };

  const removedOn = (k: string, w: Who) => B.nodes.has(k) && !table(w).nodes.has(k);

  // --- chunks: by display node in O (the incoming side), else in B — independent of resolutions, so stable -------
  const chunks = new ChunkSet([O, B, T], (display) => {
    const before = B.nodes.has(display);
    const after = O.nodes.has(display);
    return before && !after ? "REMOVED" : !before && after ? "CREATED" : null;
  });
  const displayOf = (k: string): string => (O.nodes.has(k) ? displayNodeOf(O, k) : B.nodes.has(k) ? displayNodeOf(B, k) : displayNodeOf(T, k));

  const conflicts: Conflict[] = [];
  const conflictById = new Map<string, Conflict>();
  const conflictChunk = new Map<string, string>();
  const addConflict = (kind: ConflictKind, guid: string, field: string | null, itemKey: string | null, id: string, values: { base: Value; main: Value; branch: Value }, removed: Side | null = null): string => {
    if (conflictById.has(id)) return id;
    const c: Conflict = { id, kind, guid, field, itemKey, base: values.base, main: values.main, branch: values.branch, removedOn: removed, chunk: -1 };
    conflicts.push(c);
    conflictById.set(id, c);
    const display = displayOf(guid);
    conflictChunk.set(id, display);
    chunks.chunk(display);
    return id;
  };
  const BRANCH = input.branch;
  const nodeValues = (k: string) => ({ base: B.nodes.get(k) ?? ABSENT, main: MAIN.nodes.get(k) ?? ABSENT, branch: BRANCH.nodes.get(k) ?? ABSENT });
  const fieldValues = (k: string, f: string) => ({ base: valueOf(B.nodes.get(k), f), main: valueOf(MAIN.nodes.get(k), f), branch: valueOf(BRANCH.nodes.get(k), f) });

  // --- delete-edit candidates (rule 4) -------------------------------------------------------------------------
  const deleteEdit = new Map<string, Who>();
  for (const k of dO.deltas.keys()) {
    if (!dT.deltas.has(k)) continue;
    const inO = O.nodes.has(k);
    const inT = T.nodes.has(k);
    if (inO !== inT && B.nodes.has(k)) deleteEdit.set(k, inO ? "T" : "O");
  }
  for (const [Y, X, dY] of [
    ["O", "T", dO],
    ["T", "O", dT],
  ] as [Who, Who, TableDiff][]) {
    const tY = table(Y);
    for (const [k, d] of dY.deltas) {
      if (d.phase === "removed") continue;
      const n: any = tY.nodes.get(k);
      const movedIn = d.phase === "created" || d.fields.some((f) => f.field === "parentIndex");
      if (movedIn) {
        const p = parentOf(n);
        if (p && removedOn(p, X) && tY.nodes.has(p) && !deleteEdit.has(p)) deleteEdit.set(p, X);
      }
      for (const r of newRefs(model, d, B.nodes.get(k), n)) if (removedOn(r, X) && tY.nodes.has(r) && !deleteEdit.has(r)) deleteEdit.set(r, X);
    }
  }

  // --- library copies (rule 8) ---------------------------------------------------------------------------------
  const rootMemo = new Map<NodeTable, Map<string, string | null>>();
  const copyRoot = (t: NodeTable, k: string): string | null => {
    let memo = rootMemo.get(t);
    if (!memo) rootMemo.set(t, (memo = new Map()));
    if (memo.has(k)) return memo.get(k)!;
    const chain: string[] = [];
    let at: string | null = k;
    let root: string | null = null;
    const seen = new Set<string>();
    while (at && !seen.has(at)) {
      seen.add(at);
      if (memo.has(at)) {
        const r = memo.get(at)!;
        if (r) root = r;
        break;
      }
      const n: any = t.nodes.get(at);
      if (!n) break;
      chain.push(at);
      if (n.sourceLibraryKey) root = at; // keep climbing: the topmost root holds the whole copy
      at = parentOf(n) || null;
    }
    for (const c of chain) if (!memo.has(c)) memo.set(c, root);
    return memo.get(k) ?? root;
  };
  const rootOfChanged = (k: string) => copyRoot(O, k) ?? copyRoot(B, k) ?? copyRoot(T, k);
  const copyChanged = new Map<string, { o: boolean; t: boolean; keys: Set<string> }>();
  for (const [d, w] of [
    [dO, "o"],
    [dT, "t"],
  ] as [TableDiff, "o" | "t"][]) {
    for (const k of d.deltas.keys()) {
      const r = rootOfChanged(k);
      if (!r) continue;
      let e = copyChanged.get(r);
      if (!e) copyChanged.set(r, (e = { o: false, t: false, keys: new Set() }));
      e[w] = true;
      e.keys.add(k);
    }
  }
  const handled = new Set<string>();
  const plans: Plan[] = [];
  for (const [root, e] of copyChanged) {
    if (!e.o || !e.t) continue;
    const ro: any = O.nodes.get(root);
    const rt: any = T.nodes.get(root);
    if (!ro || !rt) continue; // a removal: the ordinary rules apply
    if (ro.version === rt.version) continue; // the same copy: per node (rule 8: "shouldn't happen" to differ)
    const nO = ro.version ? (opts.libraryVersion?.(ro.sourceLibraryKey, ro.key ?? "", ro.version) ?? null) : null;
    const nT = rt.version ? (opts.libraryVersion?.(rt.sourceLibraryKey, rt.key ?? "", rt.version) ?? null) : null;
    const rb: any = B.nodes.get(root);
    let winner: Who | null = null;
    if (nO !== null && nT !== null && nO !== nT) winner = nO > nT ? "O" : "T";
    else if (rb && rb.version === rt.version) winner = "O";
    else if (rb && rb.version === ro.version) winner = "T";
    for (const k of e.keys) handled.add(k);
    if (winner) plans.push({ t: "copy", root, winner });
    else plans.push({ t: "copy", root, winner: null, conflict: addConflict("field", root, "version", null, `${root}|version`, fieldValues(root, "version")) });
  }

  // --- per node ------------------------------------------------------------------------------------------------
  const isCopy = (k: string) => !!(copyRoot(T, k) ?? copyRoot(O, k));
  const changedKeys = sortKeys(new Set([...dO.deltas.keys(), ...dT.deltas.keys(), ...deleteEdit.keys()]));
  for (const k of changedKeys) {
    if (handled.has(k)) continue;
    const o = dO.deltas.get(k);
    const t = dT.deltas.get(k);
    const de = deleteEdit.get(k);
    if (de) {
      const id = addConflict("delete-edit", k, null, null, `${k}|node`, nodeValues(k), sideOf(de));
      plans.push({ t: "deleteEdit", k, conflict: id, removedOn: de });
      continue;
    }
    if (!o) continue; // only T changed it: M already has it
    if (!t) {
      plans.push({ t: "takeO", k });
      continue;
    }
    const nO: any = O.nodes.get(k);
    const nT: any = T.nodes.get(k);
    if (!nO && !nT) continue; // removed on both
    if (!nO || !nT) continue; // (a delete-edit, handled above)
    if (o.phase === "created" || t.phase === "created") {
      // Rule 10: a type change that isn't a conversion (or one GUID created on both) is one change of the whole node.
      if (sameNode(model, nO, nT, O, T)) continue;
      plans.push({ t: "whole", k, conflict: addConflict("field", k, null, null, `${k}|node`, nodeValues(k)) });
      continue;
    }
    const sets: FieldPlan[] = [];
    const keyedPlans: KeyedPlan[] = [];
    const tFields = new Map(t.fields.map((f) => [f.field, f]));
    const copy = isCopy(k);
    for (const f of o.fields) {
      if (!copy && ASSET_BOOKKEEPING.has(f.field)) continue; // rule 9: main's, set below
      const tf = tFields.get(f.field);
      if (EDIT_STAMPS.has(f.field)) {
        // A stamp never conflicts: O's when it is the later edit.
        if (!tf || laterStamp(f.after, tf.after)) sets.push({ field: f.field });
        continue;
      }
      if (!tf) {
        sets.push({ field: f.field });
        continue;
      }
      if (f.field === "parentIndex") {
        const po = parentOf(nO);
        const pt = parentOf(nT);
        if (po === pt) {
          if (nO.parentIndex?.position !== nT.parentIndex?.position) sets.push({ field: f.field }); // rule 5: incoming wins
        } else sets.push({ field: f.field, conflict: addConflict("move", k, "parentIndex", null, `${k}|parentIndex`, fieldValues(k, "parentIndex")) });
        continue;
      }
      if (fieldEqual(f.field, f.after, tf.after, (i) => O.blob(i), (i) => T.blob(i), model)) continue; // convergent
      sets.push({ field: f.field, conflict: addConflict("field", k, f.field, null, `${k}|${f.field}`, fieldValues(k, f.field)) });
    }
    const tItems = new Map(t.items.map((i) => [`${i.field}\u0000${i.itemKey}`, i]));
    const byField = new Map<string, KeyedPlan>();
    for (const it of o.items) {
      if (!copy && ASSET_BOOKKEEPING.has(it.field)) continue;
      let kp = byField.get(it.field);
      if (!kp) {
        byField.set(it.field, (kp = { field: it.field, items: [] }));
        keyedPlans.push(kp);
      }
      const ti = tItems.get(`${it.field}\u0000${it.itemKey}`);
      if (!ti) {
        kp.items.push({ itemKey: it.itemKey });
        continue;
      }
      const kf = keyed.get(it.field)!;
      const bothAbsent = it.after === ABSENT && ti.after === ABSENT;
      if (bothAbsent || (it.after !== ABSENT && ti.after !== ABSENT && kf.itemEqual(it.itemKey, it.after, ti.after, (i) => O.blob(i), (i) => T.blob(i)))) continue;
      const base = it.before;
      const mainV = MAIN === O ? it.after : ti.after;
      const branchV = MAIN === O ? ti.after : it.after;
      kp.items.push({ itemKey: it.itemKey, conflict: addConflict("keyed", k, it.field, it.itemKey, `${k}|${it.field}|${it.itemKey}`, { base, main: mainV, branch: branchV }) });
    }
    if (sets.length || keyedPlans.some((p) => p.items.length)) plans.push({ t: "fields", k, sets, keyed: keyedPlans });
  }

  // --- chunks numbered; conflicts and changes placed ------------------------------------------------------------
  const movedFrom = new Map<string, string>(); // destination display → source displays
  for (const [k, d] of dO.deltas) {
    if (stampOnly(d)) continue; // a stamp alone is no change to review
    const display = displayOf(k);
    chunks.markChanged(display, sideO);
    if (d.phase === "updated" && d.fields.some((f) => f.field === "parentIndex") && B.nodes.has(k)) {
      const src = displayNodeOf(B, k);
      if (src !== display) {
        chunks.chunk(src);
        movedFrom.set(`${src}\u0000${display}`, src);
      }
    }
  }
  for (const [k, d] of dT.deltas) {
    if (stampOnly(d)) continue;
    const display = displayOf(k);
    if (chunks.has(display)) chunks.markChanged(display, sideT);
  }
  chunks.finish();
  for (const key of movedFrom.keys()) {
    const [src, dst] = key.split("\u0000");
    const s = chunks.get(src)!;
    const d = chunks.get(dst)!;
    if (!s.chunksAffectingThisChunk.includes(d.index)) s.chunksAffectingThisChunk.push(d.index);
  }
  const placeConflict = (c: Conflict) => {
    const ch = chunks.chunk(conflictChunk.get(c.id) ?? displayOf(c.guid));
    c.chunk = ch.index;
    if (!ch.conflicts.includes(c.id)) ch.conflicts.push(c.id);
  };
  for (const c of conflicts) placeConflict(c);

  const sideFor = (id: string): Side | undefined => {
    const c = conflictById.get(id);
    const pick = (v: unknown): Side | undefined => (v === "main" || v === "branch" ? v : undefined);
    return pick(resolutions[id]) ?? (c ? pick(resolutions[`chunk:${c.chunk}`]) : undefined) ?? pick(resolutions["*"]);
  };
  const takesO = (id: string | undefined) => id === undefined || sideFor(id) === sideO;

  // --- execute -------------------------------------------------------------------------------------------------
  const setFromO = (k: string) => {
    const n = imp(O, k);
    if (n) M.set(k, n);
    else M.delete(k);
  };
  for (const p of plans) {
    switch (p.t) {
      case "copy": {
        const winO = p.winner === "O" || (p.winner === null && sideFor(p.conflict!) === sideO);
        if (!winO) break;
        const inO = new Set<string>();
        for (const k of O.nodes.keys()) if (copyRoot(O, k) === p.root) inO.add(k);
        for (const k of T.nodes.keys()) if (copyRoot(T, k) === p.root && !inO.has(k)) M.delete(k);
        for (const k of inO) setFromO(k);
        break;
      }
      case "takeO":
        setFromO(p.k);
        break;
      case "whole":
        if (sideFor(p.conflict) === sideO) setFromO(p.k);
        break;
      case "fields": {
        const cur: any = { ...M.get(p.k)! };
        const src: any = imp(O, p.k)!;
        let changed = false;
        for (const s of p.sets) {
          if (s.conflict && !takesO(s.conflict)) continue;
          if (src[s.field] === undefined) delete cur[s.field];
          else cur[s.field] = src[s.field];
          changed = true;
        }
        for (const kp of p.keyed) {
          const take = kp.items.filter((i) => takesO(i.conflict));
          if (!take.length) continue;
          const kf: KeyedField = keyed.get(kp.field)!;
          kf.items(B.nodes.get(p.k)?.[kp.field as keyof NodeChange]);
          const fromT = kf.items(cur[kp.field]);
          const fromO = kf.items(src[kp.field]);
          const merged = new Map(fromT);
          for (const i of take) {
            if (fromO.has(i.itemKey)) merged.set(i.itemKey, fromO.get(i.itemKey));
            else merged.delete(i.itemKey);
          }
          const v = kf.rebuild(cur[kp.field] ?? src[kp.field] ?? null, merged, [...fromT.keys(), ...fromO.keys()]);
          if (v === ABSENT) delete cur[kp.field];
          else cur[kp.field] = v;
          changed = true;
        }
        if (changed) M.set(p.k, cur);
        break;
      }
      case "deleteEdit":
        break; // after the bookkeeping, below
    }
  }

  // Rule 9: local assets keep main's library bookkeeping.
  for (const k of changedKeys) {
    const m: any = M.get(k);
    const mn: any = MAIN.nodes.get(k);
    if (!m || !mn || isCopy(k)) continue;
    let fix: any = null;
    for (const f of ASSET_BOOKKEEPING) {
      if (sameValue(model, f, m[f], mn[f])) continue;
      fix ??= { ...m };
      if (mn[f] === undefined) delete fix[f];
      else fix[f] = mn[f];
    }
    if (fix) M.set(k, fix);
  }

  // Rule 6: delete-edit resolutions (unresolved: T's side).
  const restored = new Set<string>();
  const restore = (k: string, from: NodeTable) => {
    const n = imp(from, k);
    if (n) M.set(k, n);
    restored.add(k);
    // Removed ancestors come back (from the side that kept the node, else as they were in B).
    let p = parentOf(from.nodes.get(k));
    const seen = new Set([k]);
    while (p && !seen.has(p) && !M.has(p)) {
      seen.add(p);
      const a = from.nodes.has(p) ? imp(from, p) : imp(B, p);
      if (!a) break;
      M.set(p, a);
      restored.add(p);
      p = parentOf(a);
    }
    // A variable needs its collection.
    const vs: any = n && (n as any).type === "VARIABLE" ? (n as any).variableSetID?.guid : null;
    if (vs) {
      const c = guidKey(vs);
      if (!M.has(c)) {
        const cn = from.nodes.has(c) ? imp(from, c) : imp(B, c);
        if (cn) {
          M.set(c, cn);
          restored.add(c);
        }
      }
    }
  };
  const removeSubtree = (k: string) => {
    const stack = [k];
    const seen = new Set<string>();
    while (stack.length) {
      const x = stack.pop()!;
      if (seen.has(x)) continue;
      seen.add(x);
      for (const c of M.childrenOf(x)) stack.push(c);
      M.delete(x);
    }
  };
  for (const p of plans) {
    if (p.t !== "deleteEdit") continue;
    const side = sideFor(p.conflict) ?? sideT;
    const removedSide = sideOf(p.removedOn);
    if (side === removedSide) removeSubtree(p.k);
    else restore(p.k, table(p.removedOn === "O" ? "T" : "O"));
  }

  // Rule 5: cycles (two moves that together make a node its own ancestor).
  const cycleIds: string[] = [];
  const findCycle = (k: string): string[] | null => {
    const path: string[] = [];
    const seen = new Set<string>();
    let at: string = k;
    while (at) {
      if (seen.has(at)) {
        const i = path.indexOf(at);
        return i >= 0 ? path.slice(i) : null;
      }
      seen.add(at);
      path.push(at);
      at = parentOf(M.get(at));
    }
    return null;
  };
  const movedKeys = [...M.over.keys()].filter((k) => {
    const m = M.get(k);
    return m && parentOf(m) !== parentOf(T.nodes.get(k));
  });
  const inCycle = new Set<string>();
  for (const k of movedKeys) {
    if (inCycle.has(k)) continue;
    const cyc = findCycle(k);
    if (!cyc) continue;
    const members = cyc.filter((m) => parentOf(M.get(m)) !== parentOf(B.nodes.get(m)));
    for (const m of cyc) inCycle.add(m);
    for (const m of members.length ? members : cyc) {
      const id = addConflict("cycle", m, "parentIndex", null, `${m}|parentIndex|cycle`, fieldValues(m, "parentIndex"));
      placeConflict(conflictById.get(id)!);
      cycleIds.push(id);
    }
  }
  for (const id of cycleIds) {
    const c = conflictById.get(id)!;
    const side = sideFor(id) ?? sideT;
    const src = side === sideO ? O : T;
    const cur = M.get(c.guid);
    const pi = src.nodes.get(c.guid)?.parentIndex;
    if (cur && pi) M.set(c.guid, { ...cur, parentIndex: pi });
  }

  // Rule 7: siblings from the two sides on one position: the incoming node is re-keyed.
  let reKeyed = 0;
  const incoming = new Set<string>();
  for (const [k, n] of M.over) {
    if (!n) continue;
    const t = T.nodes.get(k);
    if (!t || parentOf(t) !== parentOf(n) || t.parentIndex?.position !== n.parentIndex?.position) incoming.add(k);
  }
  const parents = new Set<string>();
  for (const k of incoming) {
    const p = parentOf(M.get(k));
    if (p) parents.add(p);
  }
  for (const p of sortKeys(parents)) {
    const kids = [...M.childrenOf(p)].map((k) => ({ k, n: M.get(k)!, inc: incoming.has(k) }));
    kids.sort((a, b) => {
      const pa = a.n.parentIndex?.position ?? "";
      const pb = b.n.parentIndex?.position ?? "";
      if (pa !== pb) return pa < pb ? -1 : 1;
      if (a.inc !== b.inc) return a.inc ? 1 : -1;
      return sortKeys([a.k, b.k])[0] === a.k ? -1 : 1;
    });
    for (let i = 0; i < kids.length; ) {
      const pos = kids[i].n.parentIndex?.position ?? "";
      let j = i;
      while (j < kids.length && (kids[j].n.parentIndex?.position ?? "") === pos) j++;
      const group = kids.slice(i, j);
      const stay = group.filter((g) => !g.inc);
      const move = group.filter((g) => g.inc);
      if (stay.length && move.length) {
        const hi = j < kids.length ? (kids[j].n.parentIndex?.position ?? null) : null;
        const keys = keysBetween(pos, hi, move.length);
        move.forEach((g, x) => {
          M.set(g.k, { ...g.n, parentIndex: { ...g.n.parentIndex!, position: keys[x] } });
          reKeyed++;
        });
      }
      i = j;
    }
  }

  const unresolved = conflicts.filter((c) => !sideFor(c.id)).map((c) => c.id);

  // Rule 11: validity (only a fully resolved merge is checked: it is the one that may be written).
  if (!unresolved.length) validate(M, T);

  // --- the batch -----------------------------------------------------------------------------------------------
  const batch = batchOf(T, M, model);
  const stats = { created: 0, removed: 0, updated: 0, reKeyed };
  const list = chunks.finish();
  const chunkOfKey = (k: string): DiffChunk => chunks.chunk(displayOf(k));
  (batch.nodeChanges ?? []).forEach((nc, i) => {
    if (nc.phase === "CREATED") stats.created++;
    else if (nc.phase === "REMOVED") stats.removed++;
    else stats.updated++;
    const key = guidKey(nc.guid!);
    // A re-stamp of a node no chunk holds (a page whose layer was added) belongs to no chunk: it makes none.
    if (nc.phase !== "CREATED" && nc.phase !== "REMOVED" && !chunks.has(displayOf(key)) && Object.keys(nc).every((f) => NOT_DATA.has(f) || EDIT_STAMPS.has(f))) return;
    const ch = chunkOfKey(key);
    if (ch.nodeChanges[ch.nodeChanges.length - 1] !== i) ch.nodeChanges.push(i);
  });
  // A REMOVED + CREATED pair counts once.
  for (let i = 1; i < (batch.nodeChanges ?? []).length; i++) {
    const a = batch.nodeChanges![i - 1];
    const b = batch.nodeChanges![i];
    if (a.phase === "REMOVED" && b.phase === "CREATED" && guidKey(a.guid!) === guidKey(b.guid!)) stats.removed--;
  }
  return { result: { direction, batch, chunks: list, conflicts, unresolved, stats }, merged: M };
}

function sameValue(model: SchemaModel, f: string, a: unknown, b: unknown): boolean {
  if (a === undefined || b === undefined) return a === b;
  const fd = model.def("NodeChange").byName.get(f);
  return fd?.type ? valuesEqual(model, fd.type, fd.isArray, a, b, () => undefined, () => undefined) : a === b;
}

function sameNode(model: SchemaModel, a: any, b: any, ta: NodeTable, tb: NodeTable): boolean {
  for (const f of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (NOT_DATA.has(f)) continue;
    if (!fieldEqual(f, valueOf(a, f), valueOf(b, f), (i) => ta.blob(i), (i) => tb.blob(i), model)) return false;
  }
  return true;
}

/** Rule 11, the structural part: every written node's parent exists, no cycles, pages under the document. */
function validate(M: MergedTable, T: NodeTable): void {
  const bad = new Set<string>();
  for (const [k, n] of M.over) {
    if (!n) {
      if (T.nodes.has(k)) for (const c of M.childrenOf(k)) bad.add(c);
      continue;
    }
    if (k === "0:0") continue;
    const p = parentOf(n);
    const parent: any = p ? M.get(p) : undefined;
    if (!parent) {
      bad.add(k);
      continue;
    }
    if (n.type === "CANVAS" && parent.type !== "DOCUMENT") bad.add(k);
    const seen = new Set<string>([k]);
    let at = p;
    while (at) {
      if (seen.has(at)) {
        bad.add(k);
        break;
      }
      seen.add(at);
      at = parentOf(M.get(at));
    }
  }
  if (bad.size) throw new MergeInvalidError(`The merged file would break the document's rules at ${[...bad].slice(0, 5).join(", ")}`, sortKeys(bad));
}

/**
 * The change Message turning T into M, over the nodes the merge wrote: REMOVED children first, then CREATED / updated
 * parents first; per field as `diffTables`, cleaned as `restoreDiff` (a field absent on one side and at its absent
 * meaning on the other is no change; one going back to a non-zero `@default` is written as that value).
 */
export function batchOf(T: NodeTable, M: MergedTable, model: SchemaModel = MODEL): Message {
  const ncDef = model.def("NodeChange");
  const pool: { bytes: Uint8Array }[] = [];
  const dense = new Map<number, number>();
  const rebase = (n: NodeChange) =>
    rebaseBlobIndices(model, n, (i) => {
      let j = dense.get(i);
      if (j === undefined) {
        j = pool.push({ bytes: M.blob(i) ?? EMPTY }) - 1;
        dense.set(i, j);
      }
      return j;
    });
  const depthIn = (get: (k: string) => NodeChange | undefined) => {
    const memo = new Map<string, number>();
    const depth = (k: string): number => {
      const known = memo.get(k);
      if (known !== undefined) return known;
      let d = 0;
      let at = parentOf(get(k));
      const seen = new Set([k]);
      while (at && get(at) && !seen.has(at)) {
        seen.add(at);
        const m = memo.get(at);
        if (m !== undefined) {
          d += m + 1;
          break;
        }
        d++;
        at = parentOf(get(at));
      }
      memo.set(k, d);
      return d;
    };
    return depth;
  };
  const dT = depthIn((k) => T.nodes.get(k));
  const dM = depthIn((k) => M.get(k));
  const touched = sortKeys(M.over.keys());
  const removed = touched.filter((k) => T.nodes.has(k) && !M.has(k)).sort((a, b) => dT(b) - dT(a));
  const live = touched.filter((k) => M.has(k));
  const pos = (k: string) => M.get(k)?.parentIndex?.position ?? "";
  live.sort((a, b) => dM(a) - dM(b) || (pos(a) < pos(b) ? -1 : pos(a) > pos(b) ? 1 : 0));
  const out: NodeChange[] = [];
  for (const k of removed) out.push({ guid: T.nodes.get(k)!.guid, phase: "REMOVED" });
  for (const k of live) {
    const m: any = withoutDerived(M.get(k)!);
    const t: any = T.nodes.get(k);
    if (!t) {
      out.push({ ...rebase(m), phase: "CREATED" });
      continue;
    }
    if (!isTypeConversion(t.type, m.type)) {
      out.push({ guid: t.guid, phase: "REMOVED" });
      out.push({ ...rebase(m), phase: "CREATED" });
      continue;
    }
    const change: any = { guid: m.guid };
    const cleared: number[] = [];
    let changed = false;
    for (const f of new Set([...Object.keys(m), ...Object.keys(t)])) {
      if (NOT_DATA.has(f)) continue;
      const fd = ncDef.byName.get(f);
      if (!fd || !fd.type) continue;
      if (m[f] === undefined) {
        if (t[f] === undefined || UNCLEARABLE.has(f) || isAbsentValue(f, t[f], model)) continue;
        if (NODE_DEFAULTS[f] !== undefined) change[f] = JSON.parse(JSON.stringify(NODE_DEFAULTS[f]));
        else cleared.push(fd.value);
        changed = true;
        continue;
      }
      if (t[f] === undefined) {
        if (isAbsentValue(f, m[f], model)) continue;
      } else if (m[f] === t[f] || valuesEqual(model, fd.type, fd.isArray, m[f], t[f], (i) => M.blob(i), (i) => T.blob(i))) continue;
      change[f] = m[f];
      changed = true;
    }
    if (!changed) continue;
    if (cleared.length) change.clearedFields = cleared.sort((a, b) => a - b);
    out.push(rebase(change));
  }
  return { type: "NODE_CHANGES", sessionID: 0, ackID: 0, nodeChanges: out, blobs: pool };
}

/** `clearedFields` id of a field (tests and callers building changes by name). */
export const fieldId = (name: string): number => nodeFieldId(name)!;
