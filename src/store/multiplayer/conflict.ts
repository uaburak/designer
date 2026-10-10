/**
 * Figma's conflict rule on the client (docs/multiplayer.md §5): while a local batch is unacknowledged, a remote value
 * for a property it touched is dropped — in the server's order the local batch lands after it and wins anyway, so
 * applying it would only make the property flicker and, once the echo arrives (applied nowhere), leave this client on
 * the wrong value. A remote REMOVED always applies (a deleted node stays deleted).
 */
import { decodeMessage, encodeMessage, type Message, type NodeChange } from "../../shared/schema/codec";
import { guidKey } from "../../shared/schema/guid";
import { nodeFieldName } from "../../shared/schema/patch";

/* eslint-disable @typescript-eslint/no-explicit-any -- generic field access */

/** Properties touched per node ("s:l" → field names); `*` when the node was created or removed whole. */
export type Touched = Map<string, Set<string>>;

const META = new Set(["guid", "phase", "clearedFields"]);

export function touchedBy(message: Message, into: Touched = new Map()): Touched {
  for (const nc of message.nodeChanges ?? []) {
    if (!nc.guid) continue;
    const key = guidKey(nc.guid);
    let set = into.get(key);
    if (!set) into.set(key, (set = new Set()));
    if (nc.phase === "REMOVED" || nc.phase === "CREATED") set.add("*");
    for (const f in nc) if (!META.has(f)) set.add(f);
    for (const id of nc.clearedFields ?? []) {
      const name = nodeFieldName(id);
      if (name) set.add(name);
    }
  }
  return into;
}

/** The remote message without what `pending` overrides; null when nothing is left. Unchanged input is returned as is. */
export function withoutPending(bytes: Uint8Array, pending: Touched): Uint8Array | null {
  if (!pending.size) return bytes;
  const message = decodeMessage(bytes);
  let changed = false;
  const out: NodeChange[] = [];
  for (const nc of message.nodeChanges ?? []) {
    const mine = nc.guid ? pending.get(guidKey(nc.guid)) : undefined;
    if (!mine || nc.phase === "REMOVED") {
      out.push(nc);
      continue;
    }
    changed = true;
    // A node this client created or removed and hasn't had acknowledged: its own version stands.
    if (mine.has("*")) continue;
    const kept: any = {};
    let fields = 0;
    for (const f in nc) {
      if (META.has(f)) continue;
      if (mine.has(f)) continue;
      kept[f] = (nc as any)[f];
      fields++;
    }
    const cleared = (nc.clearedFields ?? []).filter((id) => {
      const name = nodeFieldName(id);
      return !name || !mine.has(name);
    });
    if (!fields && !cleared.length && nc.phase !== "CREATED") continue;
    out.push({ guid: nc.guid, ...(nc.phase ? { phase: nc.phase } : {}), ...kept, ...(cleared.length ? { clearedFields: cleared } : {}) });
  }
  if (!changed) return bytes;
  if (!out.length) return null;
  return encodeMessage({ ...message, nodeChanges: out });
}
