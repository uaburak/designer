/**
 * Test harness: a store in a temporary directory (never the real userData), a hand-driven clock and timers, and
 * helpers that build change batches. `connect()` (in rpcHarness.ts) puts a client and the server on the two ends of
 * a MessageChannel, exactly as the app does across processes.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeMessage, type NodeChange } from "../../shared/schema/codec";
import type { StoreApi } from "../../shared/store/repositories";
import type { BatchKind, ChangeBatch } from "../../shared/store/types";
import type { Timers } from "../local/fileStore";
import type { Clock } from "../local/ids";
import { LocalStore, type LocalStoreOptions } from "../localStore";

export function tempDir(prefix = "designer-store-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export class ManualClock implements Clock {
  constructor(public t = Date.UTC(2026, 9, 6, 12, 0, 0)) {}
  now(): number {
    return this.t;
  }
  advance(ms: number): void {
    this.t += ms;
  }
}

/** Timers that fire only when the test says so (`advance`), in due order. */
export class ManualTimers implements Timers {
  private nextId = 1;
  private readonly pending = new Map<number, { at: number; fn: () => void }>();
  /** Awaited after each timer fires (the store's idle()) */
  idle: () => Promise<void> = () => settle();
  constructor(private readonly clock: ManualClock) {}

  setTimeout(fn: () => void, ms: number): unknown {
    const id = this.nextId++;
    this.pending.set(id, { at: this.clock.now() + ms, fn });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.pending.delete(handle as number);
  }

  get size(): number {
    return this.pending.size;
  }

  /** Moves the clock forward, firing every timer that comes due (and those they schedule), then lets work settle. */
  async advance(ms: number): Promise<void> {
    const end = this.clock.now() + ms;
    for (;;) {
      const due = [...this.pending.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      this.pending.delete(due[0]);
      if (due[1].at > this.clock.now()) this.clock.t = due[1].at;
      due[1].fn();
      await this.idle();
    }
    this.clock.t = end;
    await this.idle();
  }
}

/** Lets queued promise chains and I/O callbacks run. */
export async function settle(rounds = 20): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setImmediate(r));
}

export interface TestStore {
  dir: string;
  store: LocalStore;
  api: StoreApi;
  clock: ManualClock;
  timers: ManualTimers;
  /** Shuts the store down (lock released) */
  close(): Promise<void>;
  /** Drops the store without flushing or unlocking, as a crash would */
  crash(): void;
  /** Opens the same workspace again */
  reopen(opts?: Partial<LocalStoreOptions>): Promise<TestStore>;
  /** Removes the directory */
  dispose(): void;
  /** Waits for the store's queues and background work */
  idle(): Promise<void>;
}

export async function openTestStore(opts: Partial<LocalStoreOptions> & { dir?: string; clock?: ManualClock } = {}): Promise<TestStore> {
  const dir = opts.dir ?? tempDir();
  const clock = opts.clock ?? new ManualClock();
  const timers = new ManualTimers(clock);
  const store = await LocalStore.open({ workspaceDir: join(dir, "Workspace"), userDataDir: dir, clock, timers, gcDelayMs: null, log: () => {}, ...opts });
  timers.idle = () => store.idle();
  const t: TestStore = {
    dir,
    store,
    api: store.api(),
    clock,
    timers,
    close: () => store.shutdown(),
    crash: () => store.abandonForTests(),
    reopen: (more) => openTestStore({ ...opts, ...more, dir, clock }),
    dispose: () => rmSync(dir, { recursive: true, force: true }),
    idle: () => store.idle(),
  };
  return t;
}

export const PAGE = { sessionID: 0, localID: 1 };

export function rect(sessionID: number, localID: number, position: string, extra: Partial<NodeChange> = {}): NodeChange {
  return {
    guid: { sessionID, localID },
    phase: "CREATED",
    type: "ROUNDED_RECTANGLE",
    name: `Rectangle ${localID}`,
    parentIndex: { guid: PAGE, position },
    size: { x: 100, y: 100 },
    transform: { m00: 1, m01: 0, m02: localID * 10, m10: 0, m11: 1, m12: 0 },
    ...extra,
  };
}

export function batch(sessionID: number, batchSeq: number, nodeChanges: NodeChange[], opts: { kind?: BatchKind; label?: string; blobs?: Uint8Array[]; blobRefsAdded?: string[] } = {}): ChangeBatch {
  return {
    sessionID,
    batchSeq,
    kind: opts.kind ?? "edit",
    label: opts.label ?? "Edit",
    message: encodeMessage({ type: "NODE_CHANGES", sessionID, ackID: 0, nodeChanges, blobs: (opts.blobs ?? []).map((bytes) => ({ bytes })) }),
    blobRefsAdded: opts.blobRefsAdded,
    wallClock: Date.UTC(2026, 9, 6),
  };
}
