/**
 * The tree under concurrent moves (docs/multiplayer.md §18.12): concurrent reparent cycles and orphans of a
 * concurrently deleted parent, Figma's rule (atlas 19 §3 — "Cannot move node. Doing so would create a parenting
 * cycle", "Orphaned nodes after reconnect: parent not found in scene").
 *
 * Every property converges by itself — the room orders frames, every copy applies them in that order, last writer
 * wins per property (conflict.ts). The tree is the one place where two writes to *different* properties can together
 * break it: A moves X into Y while B moves Y into X (each valid where it was made) leaves X and Y each other's parent
 * — both gone from every page — and a layer moved or drawn into a frame another person deletes at the same moment
 * is left with no parent. The room is a sequencer (it never reads a frame), so the copy whose own change comes later
 * in the room's order — the one still waiting for the room when the earlier one reaches it — repairs it: its move
 * loses (the layer goes back where the room has it) and a layer left without a parent goes to the nearest frame,
 * group or page above the deleted one that still exists. The repair is an ordinary change sent to the room (every
 * copy converges on it in the room's order, and the editor applies it as another session's: undo never brings the
 * refused move back); the other layers on a broken cycle are written again for this copy's engine only.
 *
 * Pure: the store's link (src/store/multiplayer/service.ts) gives it the tree as the room has it, this copy's own
 * changes still waiting, and the frame that arrived.
 */
import type { Message, NodeChange, ParentIndex } from "../schema/codec";
import { guidKey, parseGuid } from "../schema/guid";

/** A document's tree: every node by "s:l", its place (null: a root — the document) */
export type Structure = Map<string, ParentIndex | null>;

/** Does the Message change the tree (a node created or removed, or moved)? */
export function changesStructure(message: Message): boolean {
  for (const nc of message.nodeChanges ?? []) if (nc.phase === "REMOVED" || nc.phase === "CREATED" || nc.parentIndex) return true;
  return false;
}

/** `message` applied to the tree as the store applies it (patch.ts): REMOVED deletes, CREATED places, a move needs the node. */
export function applyStructure(s: Structure, message: Message): Structure {
  for (const nc of message.nodeChanges ?? []) {
    if (!nc.guid) continue;
    const key = guidKey(nc.guid);
    if (nc.phase === "REMOVED") s.delete(key);
    else if (nc.phase === "CREATED") s.set(key, nc.parentIndex ? { guid: nc.parentIndex.guid, position: nc.parentIndex.position ?? "" } : null);
    else if (nc.parentIndex && s.has(key)) s.set(key, { guid: nc.parentIndex.guid, position: nc.parentIndex.position ?? "" });
  }
  return s;
}

/** The tree a whole document Message holds (a snapshot's nodes are all there, CREATED or not) */
export function structureOf(message: Message): Structure {
  const s: Structure = new Map();
  for (const nc of message.nodeChanges ?? [])
    if (nc.guid && nc.phase !== "REMOVED") s.set(guidKey(nc.guid), nc.parentIndex ? { guid: nc.parentIndex.guid, position: nc.parentIndex.position ?? "" } : null);
  return s;
}

/** What this copy's own waiting changes do to the tree: nodes they move or create, nodes they remove */
export function structureTouched(messages: Iterable<Message>): { placed: Set<string>; removed: Set<string> } {
  const placed = new Set<string>();
  const removed = new Set<string>();
  for (const m of messages)
    for (const nc of m.nodeChanges ?? []) {
      if (!nc.guid) continue;
      const key = guidKey(nc.guid);
      if (nc.phase === "REMOVED") {
        removed.add(key);
        placed.delete(key);
      } else if (nc.phase === "CREATED" || nc.parentIndex) {
        placed.add(key);
        removed.delete(key);
      }
    }
  return { placed, removed };
}

/** The cycle `start` is on or leads into (its nodes, each the parent of the one before), null when it reaches a root */
export function cycleFrom(s: Structure, start: string): string[] | null {
  const path: string[] = [];
  const at = new Map<string, number>();
  let cur: string | undefined = start;
  while (cur !== undefined && s.has(cur)) {
    const seen = at.get(cur);
    if (seen !== undefined) return path.slice(seen);
    at.set(cur, path.length);
    path.push(cur);
    const p = s.get(cur);
    cur = p ? guidKey(p.guid) : undefined;
  }
  return null;
}

/** Is `ancestor` above `key` in the tree (or `key` itself)? */
function under(s: Structure, key: string, ancestor: string): boolean {
  let cur: string | undefined = key;
  for (let guard = 0; cur !== undefined && guard < 100_000; guard++) {
    if (cur === ancestor) return true;
    const p = s.get(cur);
    cur = p ? guidKey(p.guid) : undefined;
  }
  return false;
}

export interface StructureRepair {
  /** Sent to the room: this copy's refused moves back where the room has them, orphans to the nearest existing parent */
  corrections: NodeChange[];
  /** For this copy only (its engine may have refused them while its own move was on its way): the room's places of the
   *  other nodes on a broken cycle, written again */
  reasserts: NodeChange[];
}

export interface RepairInput {
  /** This copy's tree as it will be (the room's, this copy's waiting changes on top, the arriving frame applied) */
  local: Structure;
  /** The room's tree (its order, last writer per property): where a refused move goes back to */
  room: Structure;
  /** Where nodes were before (removed ones included): the way up from a deleted parent */
  ancestry: Structure;
  /** Nodes this copy's waiting changes move or create */
  placed: ReadonlySet<string>;
  /** Nodes this copy's waiting changes remove */
  removed: ReadonlySet<string>;
}

/**
 * The repair of `local` (empty lists: nothing to repair). Only what this copy is answerable for — a cycle one of its
 * own waiting moves closes, a node it moved or created whose parent is gone, a node someone put into a parent it
 * removed — so two copies never repair the same thing.
 */
export function repairStructure(input: RepairInput): StructureRepair {
  const L: Structure = new Map(input.local);
  const corrected = new Map<string, ParentIndex>();
  const onCycles = new Set<string>();
  for (let round = 0; round < 8; round++) {
    let changed = false;
    // Cycles a move of ours closes: the move loses, the node goes back to its place in the room
    for (const start of input.placed) {
      if (!L.has(start)) continue;
      const cycle = cycleFrom(L, start);
      if (!cycle) continue;
      const mine = cycle.filter((k) => input.placed.has(k) && input.room.get(k));
      if (!mine.length) continue;
      for (const k of cycle) onCycles.add(k);
      for (const k of mine) {
        const back = input.room.get(k)!;
        const cur = L.get(k);
        if (cur && guidKey(cur.guid) === guidKey(back.guid) && cur.position === back.position) continue;
        L.set(k, back);
        corrected.set(k, back);
        changed = true;
      }
    }
    // Orphans this copy is answerable for: to the nearest place above the missing parent that still exists
    for (const [k, p] of L) {
      if (!p) continue;
      const pk = guidKey(p.guid);
      if (L.has(pk) || !(input.placed.has(k) || input.removed.has(pk))) continue;
      const target = rescue(L, input, k, pk);
      if (!target) continue;
      const place = { guid: parseGuid(target), position: p.position };
      L.set(k, place);
      corrected.set(k, place);
      changed = true;
    }
    if (!changed) break;
  }
  const corrections = [...corrected].map(([k, parentIndex]) => ({ guid: parseGuid(k), parentIndex }) as NodeChange);
  const reasserts: NodeChange[] = [];
  for (const k of onCycles) {
    if (corrected.has(k)) continue;
    const p = L.get(k);
    if (p) reasserts.push({ guid: parseGuid(k), parentIndex: p } as NodeChange);
  }
  return { corrections, reasserts };
}

/** The nearest node above `missing` (by where things were) that exists in `L` and isn't `key` or under it */
function rescue(L: Structure, input: RepairInput, key: string, missing: string): string | null {
  let cur = missing;
  for (let guard = 0; guard < 10_000; guard++) {
    const p = input.ancestry.has(cur) ? input.ancestry.get(cur) : input.room.get(cur);
    if (!p) return null;
    cur = guidKey(p.guid);
    if (L.has(cur) && !under(L, cur, key)) return cur;
  }
  return null;
}
