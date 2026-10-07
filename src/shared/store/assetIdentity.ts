/**
 * A file's library bookkeeping on its own assets (docs/schema.md §8.1) — `key`, `publishedVersion`,
 * `libraryMoveInfo` — and the two store operations that copy a document state: Duplicate file / Duplicate version
 * and Restore version (docs/data.md §6, §9.1). Shared by the desktop store (`LocalStore`, `FileStore`) and the
 * browser dev store (`MemoryStore`), so both apply the same rules.
 *
 * - **Duplicate** (file or version): the copy is a new file, so its assets are new assets — "Duplicated assets get a
 *   new key" (schema.md §8.1): local assets lose `key` (a fresh one comes at the first publish), `publishedVersion`
 *   (the copy has published nothing) and `libraryMoveInfo` (the original claims that move). Library copies keep
 *   theirs: they are the same library's assets in the copy too.
 * - **Restore version**: a local asset's bookkeeping follows its publishes, not the document's history — its key never
 *   changes (consumers' copies name it), and what was published is what the library's manifests say — so the restore
 *   diff leaves it as it is on assets that exist on both sides (the editor reconciles `publishedVersion` and
 *   `libraryMoveInfo` of assets the restore brings back against the latest manifest). Library copies are written
 *   exactly. A field the version leaves absent and the head holds at the value absence means (docs/schema.md §3.4) is
 *   no change, so a restored document compares equal to its version.
 */
import { DEFAULTS, type Message, type NodeChange } from "../schema/document.generated";
import { guidKey } from "../schema/guid";
import { MODEL, type SchemaModel } from "../schema/model";
import { diffTables, nodeFieldName, type NodeTable } from "../schema/patch";
import { valuesEqual } from "../schema/visit";

/* eslint-disable @typescript-eslint/no-explicit-any -- generic field access on decoded kiwi objects */

/** A local asset's library bookkeeping (docs/schema.md §8.1). */
export const ASSET_BOOKKEEPING: ReadonlySet<string> = new Set(["key", "publishedVersion", "libraryMoveInfo"]);
/** The document's own: the libraries enabled in the file (schema.md §8.2), which the store's list mirrors. */
const DOCUMENT_BOOKKEEPING: ReadonlySet<string> = new Set(["librarySubscriptions"]);

/** Fields whose absence means something an empty value doesn't (docs/schema.md §3.4). */
const ABSENCE_IS_NOT_EMPTY: ReadonlySet<string> = new Set(["variableScopes"]);
const NODE_DEFAULTS = DEFAULTS.NodeChange as Readonly<Record<string, unknown>>;
const NO_BLOB = (): undefined => undefined;

/**
 * The nodes ("s:l") inside library copies: a node with `sourceLibraryKey` (a copy's root) and everything under it.
 */
export function libraryCopyNodes(nodes: ReadonlyMap<string, NodeChange>): Set<string> {
  const memo = new Map<string, boolean>();
  for (const start of nodes.keys()) {
    const chain: string[] = [];
    let at: string | null = start;
    let inCopy = false;
    while (at !== null) {
      const known = memo.get(at);
      if (known !== undefined) {
        inCopy = known;
        break;
      }
      const n = nodes.get(at);
      if (!n || chain.includes(at)) break;
      chain.push(at);
      if (n.sourceLibraryKey) {
        inCopy = true;
        break;
      }
      at = n.parentIndex?.guid ? guidKey(n.parentIndex.guid) : null;
    }
    for (const k of chain) memo.set(k, inCopy);
  }
  return new Set([...memo].filter(([, v]) => v).map(([k]) => k));
}

/**
 * Is `value` what an absent NodeChange field means (docs/schema.md §3.4: its `@default`, else the kiwi zero value —
 * false, 0, "", empty, the enum's 0 value)? A message, a struct or a blob index never is.
 */
export function isAbsentValue(name: string, value: unknown, model: SchemaModel = MODEL): boolean {
  if (value === undefined || value === null) return true;
  const fd = model.def("NodeChange").byName.get(name);
  if (!fd?.type || model.isBlobField("NodeChange", name)) return false;
  if (NODE_DEFAULTS[name] !== undefined) return valuesEqual(model, fd.type, fd.isArray, value, NODE_DEFAULTS[name], NO_BLOB, NO_BLOB);
  if (fd.isArray) return !ABSENCE_IS_NOT_EMPTY.has(name) && (Array.isArray(value) || value instanceof Uint8Array) && value.length === 0;
  switch (fd.type) {
    case "bool":
      return value === false;
    case "byte":
    case "int":
    case "uint":
    case "float":
      return value === 0;
    case "int64":
    case "uint64":
      return value === 0 || value === BigInt(0);
    case "string":
      return value === "";
  }
  const def = model.defs.get(fd.type);
  return def?.kind === "ENUM" && def.enumNames.get(0) === value;
}

/**
 * A duplicated document (Duplicate file, Duplicate version): its local assets lose `key`, `publishedVersion` and
 * `libraryMoveInfo`; library copies keep theirs. Instance-swap preferred values that named one of those assets by its
 * key (a `.fig`'s) name it by GUID instead. Returns the same Message when there was nothing to clear.
 */
export function withNewAssetIdentity(message: Message): Message {
  const nodes = new Map<string, NodeChange>();
  for (const n of message.nodeChanges ?? []) if (n.guid) nodes.set(guidKey(n.guid), n);
  const copies = libraryCopyNodes(nodes);
  const byKey = new Map<string, string>();
  for (const [k, n] of nodes) if (!copies.has(k) && n.key) byKey.set(n.key, k);
  let changed = false;
  const nodeChanges = (message.nodeChanges ?? []).map((n) => {
    if (!n.guid || copies.has(guidKey(n.guid))) return n;
    let out: any = n;
    if (n.key !== undefined || n.publishedVersion !== undefined || n.libraryMoveInfo !== undefined) {
      out = { ...n };
      delete out.key;
      delete out.publishedVersion;
      delete out.libraryMoveInfo;
    }
    const defs = renamePreferredValues(out.componentPropDefs, byKey);
    if (defs) out = { ...out, componentPropDefs: defs };
    if (out !== n) changed = true;
    return out as NodeChange;
  });
  return changed ? { ...message, nodeChanges } : message;
}

/** Component properties whose instance-swap preferred values name a key in `byKey`, re-pointed by GUID; else null. */
function renamePreferredValues(defs: any[] | undefined, byKey: ReadonlyMap<string, string>): any[] | null {
  if (!Array.isArray(defs) || !byKey.size) return null;
  let changed = false;
  const out = defs.map((d) => {
    const values: any[] | undefined = d?.preferredValues?.instanceSwapValues;
    if (!Array.isArray(values) || !values.some((v) => typeof v?.key === "string" && byKey.has(v.key))) return d;
    changed = true;
    return { ...d, preferredValues: { ...d.preferredValues, instanceSwapValues: values.map((v) => (typeof v?.key === "string" && byKey.has(v.key) ? { ...v, key: byKey.get(v.key) } : v)) } };
  });
  return changed ? out : null;
}

/**
 * Restore version's diff (docs/data.md §6): the change Message that turns the head (`current`) into the version
 * (`target`), except that
 * - local assets present on both sides keep their library bookkeeping (key, published version, move), and the
 *   document its enabled libraries (the store's list, `FileMeta.enabledLibraries`, isn't part of a version either);
 * - a field the version leaves absent and the head holds at its absent meaning is no change (and the reverse);
 * - a field that goes back to a non-zero `@default` (visible, opacity, isSymbolPublishable…) is written as that value
 *   rather than cleared: the same meaning, and an engine that keeps the field without modelling it resets it too.
 */
export function restoreDiff(current: NodeTable, target: NodeTable, model: SchemaModel = MODEL): Message {
  const diff = diffTables(current, target, model);
  const copiesNow = libraryCopyNodes(current.nodes);
  const copiesThen = libraryCopyNodes(target.nodes);
  const local = (k: string) => current.nodes.has(k) && target.nodes.has(k) && !copiesNow.has(k) && !copiesThen.has(k);
  const nodeChanges: NodeChange[] = [];
  for (const nc of diff.nodeChanges ?? []) {
    const k = guidKey(nc.guid!);
    const cur: any = current.nodes.get(k);
    if (nc.phase === "REMOVED") {
      nodeChanges.push(nc);
      continue;
    }
    if (nc.phase === "CREATED") {
      // A node re-created in place (a type change): a local asset still keeps its bookkeeping.
      if (!local(k)) {
        nodeChanges.push(nc);
        continue;
      }
      const out: any = { ...nc };
      for (const f of ASSET_BOOKKEEPING) {
        if (cur[f] === undefined) delete out[f];
        else out[f] = cur[f];
      }
      nodeChanges.push(out);
      continue;
    }
    const kept = cur?.type === "DOCUMENT" ? DOCUMENT_BOOKKEEPING : local(k) ? ASSET_BOOKKEEPING : null;
    const next: any = { guid: nc.guid };
    const cleared: number[] = [];
    for (const f of Object.keys(nc)) {
      if (f === "guid" || f === "phase" || f === "clearedFields") continue;
      if (kept?.has(f)) continue;
      if (cur?.[f] === undefined && isAbsentValue(f, (nc as any)[f], model)) continue;
      next[f] = (nc as any)[f];
    }
    for (const id of nc.clearedFields ?? []) {
      const name = nodeFieldName(id);
      if (!name || kept?.has(name)) continue;
      if (isAbsentValue(name, cur?.[name], model)) continue;
      if (NODE_DEFAULTS[name] !== undefined) next[name] = JSON.parse(JSON.stringify(NODE_DEFAULTS[name]));
      else cleared.push(id);
    }
    if (cleared.length) next.clearedFields = cleared;
    if (Object.keys(next).length > 1) nodeChanges.push(next);
  }
  return { ...diff, nodeChanges };
}
