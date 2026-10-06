/**
 * Per-property last-writer-wins with hybrid logical clocks (docs/data.md §12.5). A top-level NodeChange field is the
 * unit; a clear (`clearedFields`) is a write; a REMOVED is a tombstone with its HLC; a CREATED is a full replace.
 *
 * Push: coalesce the journal frames after `pushedSeq` to the last value and HLC per (guid, field), then, per node,
 * write a field only if the local HLC is newer than the remote `_clk[field]`, skip fields older than a remote `_del`,
 * and let a local tombstone win over every remote field older than it.
 * Pull: keep the remote fields whose HLC is newer than the local per-field clock (clocks.bin).
 */
import type { Message, NodeChange } from "../../shared/schema/document.generated";
import { guidKey } from "../../shared/schema/guid";
import { nodeFieldId, nodeFieldName } from "../../shared/schema/patch";
import type { Hlc } from "../../shared/store/types";

/* eslint-disable @typescript-eslint/no-explicit-any -- generic field access */

export interface FieldWrite {
  /** The value; undefined = cleared */
  value: unknown;
  hlc: Hlc;
}

export interface NodeOps {
  guid: string;
  /** Last REMOVED (a tombstone) not followed by a CREATED */
  removed: Hlc | null;
  /** Last CREATED: fields it did not carry are cleared as of this HLC */
  replacedAt: Hlc | null;
  fields: Map<string, FieldWrite>;
  /** Message-local blob tables the values' blob indices refer to (per frame) */
  blobsOf: Map<string, { bytes: Uint8Array }[]>;
}

/** Step 1 of push: the frames after pushedSeq, coalesced per (guid, field). */
export function coalesce(frames: { hlc: Hlc; message: Message }[]): Map<string, NodeOps> {
  const out = new Map<string, NodeOps>();
  for (const f of frames) {
    for (const nc of f.message.nodeChanges ?? []) {
      if (!nc.guid) continue;
      const key = guidKey(nc.guid);
      let ops = out.get(key);
      if (!ops) out.set(key, (ops = { guid: key, removed: null, replacedAt: null, fields: new Map(), blobsOf: new Map() }));
      if (nc.phase === "REMOVED") {
        ops.removed = f.hlc;
        ops.replacedAt = null;
        ops.fields.clear();
        continue;
      }
      if (nc.phase === "CREATED") {
        ops.removed = null;
        ops.replacedAt = f.hlc;
        ops.fields.clear();
      }
      for (const field in nc) {
        if (field === "guid" || field === "phase" || field === "clearedFields") continue;
        ops.fields.set(field, { value: (nc as any)[field], hlc: f.hlc });
        ops.blobsOf.set(field, f.message.blobs ?? []);
      }
      for (const id of nc.clearedFields ?? []) {
        const name = nodeFieldName(id);
        if (name) ops.fields.set(name, { value: undefined, hlc: f.hlc });
      }
    }
  }
  return out;
}

export interface RemoteNode {
  /** Decoded field values (fieldCodec.decodeNodeFields) */
  fields: Record<string, unknown>;
  clk: Record<string, Hlc>;
  del: Hlc | null;
}

export interface WritePlan {
  /** Fields to set (encoded by the caller) */
  set: string[];
  /** Fields to delete (deleteField()) */
  clear: string[];
  /** New `_clk` entries */
  clk: Record<string, Hlc>;
  /** New `_del` (tombstone), when the local delete wins */
  del: Hlc | null;
  /** Nothing to write */
  empty: boolean;
}

/** Step 3 of push, for one node: which fields the local writes win. */
export function planPush(local: NodeOps, remote: RemoteNode | null): WritePlan {
  const plan: WritePlan = { set: [], clear: [], clk: {}, del: null, empty: true };
  const rclk = remote?.clk ?? {};
  const rdel = remote?.del ?? null;
  if (local.removed) {
    if (!rdel || rdel < local.removed) {
      plan.del = local.removed;
      // A local tombstone wins over every field older than it.
      for (const [field, h] of Object.entries(rclk)) {
        if (h < local.removed && remote && field in remote.fields) {
          plan.clear.push(field);
          plan.clk[field] = local.removed;
        }
      }
    }
  }
  for (const [field, w] of local.fields) {
    if (rdel && rdel > w.hlc) continue; // deleted remotely after this write
    if (rclk[field] && rclk[field] >= w.hlc) continue; // the remote write is newer
    if (w.value === undefined) plan.clear.push(field);
    else plan.set.push(field);
    plan.clk[field] = w.hlc;
  }
  if (local.replacedAt && remote) {
    // A CREATED replaces the node: remote fields it does not carry and that are older go away.
    for (const [field, h] of Object.entries(rclk)) {
      if (local.fields.has(field) || !(field in remote.fields)) continue;
      if (h < local.replacedAt) {
        plan.clear.push(field);
        plan.clk[field] = local.replacedAt;
      }
    }
  }
  plan.empty = !plan.set.length && !plan.clear.length && !plan.del;
  return plan;
}

/** Pull, for one node document: the change to apply locally (or null), given the local per-field clocks. */
export function planPull(guid: string, remote: RemoteNode, local: { clk: Record<string, Hlc>; del: Hlc | null }): { change: NodeChange | null; removed: boolean; taken: Record<string, Hlc> } {
  const newestLocal = [local.del ?? "", ...Object.values(local.clk)].sort().pop() ?? "";
  if (remote.del && remote.del > newestLocal && Object.values(remote.clk).every((h) => h <= remote.del!)) {
    return { change: null, removed: true, taken: {} };
  }
  const taken: Record<string, Hlc> = {};
  const set: Record<string, unknown> = {};
  const cleared: string[] = [];
  for (const [field, h] of Object.entries(remote.clk)) {
    const mine = local.clk[field];
    if (mine && mine >= h) continue;
    if (local.del && local.del >= h) continue;
    taken[field] = h;
    if (field in remote.fields) set[field] = remote.fields[field];
    else cleared.push(field);
  }
  if (!Object.keys(taken).length) return { change: null, removed: false, taken };
  const [s, l] = guid.split(":").map(Number);
  const change: any = { guid: { sessionID: s, localID: l }, ...set };
  if (cleared.length) change.clearedFields = cleared.map((f) => nodeFieldId(f)).filter((n): n is number => n !== undefined);
  return { change, removed: false, taken };
}

/** Records (workspace, folders, file metas, prefs, libraries): field-level LWW against `_clk`. */
export function mergeRecord<T extends { _clk: Record<string, Hlc> }>(local: T, remote: T | null): { merged: T; pushFields: string[]; pullFields: string[] } {
  if (!remote) return { merged: local, pushFields: Object.keys(local._clk), pullFields: [] };
  const merged: any = { ...local, _clk: { ...local._clk } };
  const pushFields: string[] = [];
  const pullFields: string[] = [];
  const fields = new Set([...Object.keys(local._clk), ...Object.keys(remote._clk)]);
  for (const f of fields) {
    const l = local._clk[f] ?? "";
    const r = remote._clk[f] ?? "";
    if (r > l) {
      merged[f] = (remote as any)[f];
      merged._clk[f] = r;
      pullFields.push(f);
    } else if (l > r) pushFields.push(f);
  }
  return { merged, pushFields, pullFields };
}
