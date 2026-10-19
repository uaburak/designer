/**
 * Changes this editor didn't make — a collaborator's through the room, another window's — reach the engine as another
 * session's (docs/multiplayer.md §18.2, docs/engine.md §9.5): `"peer"` (APPLY_REMOTE | APPLY_PEER), so the user's ⌘Z
 * skips what they wrote, and never while a drag, a scrub or an agent's write is open — the engine answers BUSY then and
 * the change waits here, in order, until it is idle (before, a change arriving mid-drag was dropped: this copy stayed
 * behind the file's until it was opened again).
 *
 * Figma's conflict rule, on the editor's side of the store: a change waiting here, or one the store sent while this
 * editor's own change was still on its way to the journal, loses the properties this editor changed since — those go
 * to the room after it and win there (`DocumentSource.withoutLocal`, asked again at each attempt).
 */
import { Status } from "@/engine/abi";
import type { Engine } from "@/engine/Engine";
import type { Message } from "@/engine/codec";
import { messageToEngine } from "@/store/engineMessage";
import { decodeMessage, encodeMessage } from "@shared/schema/codec";
import { applyEngineBytes } from "../engineCompat";

/** How often a waiting change tries again while the engine is busy (an agent's write waits the same: agents/turns.ts) */
export const PEER_RETRY_MS = 30;

export interface LocalChanges {
  /** `bytes` (the store's frame at journal `seq`) without what this editor changed after it; null: nothing left. */
  withoutLocal?(bytes: Uint8Array, seq: number): Uint8Array | null;
}

interface Waiting {
  changes: Message;
  bytes?: Uint8Array;
  seq?: number;
}

export class RemoteApplier {
  private queue: Waiting[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  constructor(
    private readonly engine: Engine,
    private readonly local: LocalChanges | null,
    /** Before each change is applied (the editor notes the layer types it brings) */
    private readonly before: (changes: Message) => void = () => {},
  ) {}

  /** Changes waiting for the engine */
  get waiting(): number {
    return this.queue.length;
  }

  push(changes: Message, info?: { seq?: number; bytes?: Uint8Array }): void {
    if (this.stopped) return;
    this.queue.push({ changes, bytes: info?.bytes, seq: info?.seq });
    if (this.queue.length === 1) this.drain();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.queue = [];
  }

  private drain(): void {
    this.timer = null;
    while (this.queue.length && !this.stopped && !this.engine.destroyed) {
      if (!this.engine.idle()) return this.later();
      const status = this.apply(this.queue[0]);
      if (status === Status.E_BUSY) return this.later();
      this.queue.shift();
    }
  }

  private later(): void {
    if (!this.timer) this.timer = setTimeout(() => this.drain(), PEER_RETRY_MS);
  }

  private apply(w: Waiting): number {
    let { changes, bytes } = w;
    if (bytes && w.seq !== undefined && this.local?.withoutLocal) {
      const kept = this.local.withoutLocal(bytes, w.seq);
      if (!kept) return Status.OK;
      if (kept !== bytes) {
        bytes = kept;
        changes = messageToEngine(decodeMessage(kept));
      }
    }
    const safe = withoutCycles(this.engine, changes, bytes);
    if (safe) ({ changes, bytes } = safe);
    this.before(changes);
    const status = bytes ? applyEngineBytes(this.engine, bytes, "peer") : null;
    return status ?? this.engine.applyChanges(changes, "peer");
  }
}

/**
 * Another session's move that would put a layer inside itself in this engine — this editor's own move of one of its
 * parents was made before that move reached it, and isn't in the room yet (docs/multiplayer.md §18.12) — is applied
 * without the move: the rest of that layer's change stands (the engine would refuse the whole change), and the store
 * puts the tree right once it has both (it journals the repair, which comes here like any other change). Null: no
 * move to refuse.
 */
export function withoutCycles(engine: Pick<Engine, "readNodes">, changes: Message, bytes?: Uint8Array): { changes: Message; bytes?: Uint8Array } | null {
  if (!changes.nodeChanges.some((n) => n.parentIndex && !n.phase)) return null;
  // Parents as they will be: the engine's, with this change's own moves as they are taken
  const moved = new Map<string, string | null>();
  const parentOf = (id: string): string | null => {
    if (moved.has(id)) return moved.get(id)!;
    const n = engine.readNodes([id], { fields: ["parentIndex"] })[0] as { parentIndex?: { guid: { sessionID: number; localID: number } } } | undefined;
    const p = n?.parentIndex?.guid;
    const key = p ? `${p.sessionID}:${p.localID}` : null;
    moved.set(id, key);
    return key;
  };
  const refused = new Set<string>();
  for (const n of changes.nodeChanges) {
    if (n.phase === "REMOVED") {
      moved.set(n.guid, null);
      continue;
    }
    if (!n.parentIndex) continue;
    if (!n.phase) {
      let cur: string | null = n.parentIndex.guid;
      let cycle = false;
      for (let guard = 0; cur && guard < 10_000; guard++) {
        if (cur === n.guid) {
          cycle = true;
          break;
        }
        cur = parentOf(cur);
      }
      if (cycle) {
        refused.add(n.guid);
        continue;
      }
    }
    moved.set(n.guid, n.parentIndex.guid);
  }
  if (!refused.size) return null;
  const strip = <T extends { parentIndex?: unknown }>(n: T): T => {
    const { parentIndex: _p, ...rest } = n;
    return rest as T;
  };
  const out: Message = { ...changes, nodeChanges: changes.nodeChanges.map((n) => (refused.has(n.guid) && !n.phase ? strip(n) : n)) };
  if (!bytes) return { changes: out };
  const m = decodeMessage(bytes);
  m.nodeChanges = (m.nodeChanges ?? []).map((n) => (n.guid && !n.phase && refused.has(`${n.guid.sessionID}:${n.guid.localID}`) ? strip(n) : n));
  return { changes: out, bytes: encodeMessage(m) };
}
