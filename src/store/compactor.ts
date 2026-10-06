/**
 * Where compaction runs (docs/data.md §5.5): in a `worker_threads` worker off the RPC loop in the app, inline in
 * tests. The worker is the store's own bundle started with `workerData.designerStoreRole === "compactor"` (index.ts
 * dispatches on it), so the build needs no extra entry.
 */
import { Worker } from "node:worker_threads";
import { compactFiles, type CompactInput, type CompactOutput } from "./local/compact";

export interface Compactor {
  compact(input: CompactInput): Promise<CompactOutput>;
  close(): Promise<void>;
}

export const inlineCompactor: Compactor = {
  compact: (input) => compactFiles(input),
  close: async () => {},
};

export const COMPACTOR_ROLE = "compactor";

type WorkerReply = { id: number; ok: true; out: CompactOutput } | { id: number; ok: false; message: string };

/** A compactor backed by one long-lived worker running `entry` (the store bundle). Falls back inline if it dies. */
export function workerCompactor(entry: string): Compactor {
  let worker: Worker | null = null;
  let nextId = 1;
  const pending = new Map<number, { resolve: (o: CompactOutput) => void; reject: (e: Error) => void }>();
  const start = () => {
    const w = new Worker(entry, { workerData: { designerStoreRole: COMPACTOR_ROLE } });
    w.on("message", (r: WorkerReply) => {
      const p = pending.get(r.id);
      if (!p) return;
      pending.delete(r.id);
      if (r.ok) p.resolve(r.out);
      else p.reject(new Error(r.message));
    });
    w.on("error", (e) => {
      for (const p of pending.values()) p.reject(e);
      pending.clear();
      worker = null;
    });
    w.on("exit", () => {
      for (const p of pending.values()) p.reject(new Error("the compactor worker exited"));
      pending.clear();
      worker = null;
    });
    w.unref();
    return w;
  };
  return {
    compact(input) {
      try {
        worker ??= start();
      } catch {
        return compactFiles(input);
      }
      const id = nextId++;
      return new Promise<CompactOutput>((resolve, reject) => {
        pending.set(id, { resolve, reject });
        worker!.postMessage({ id, input });
      });
    },
    async close() {
      const w = worker;
      worker = null;
      if (w) await w.terminate();
    },
  };
}

/** The worker side: answers compaction requests until the parent goes away. */
export function runCompactorWorker(port: import("node:worker_threads").MessagePort): void {
  port.on("message", async (req: { id: number; input: CompactInput }) => {
    try {
      const out = await compactFiles(req.input);
      port.postMessage({ id: req.id, ok: true, out } satisfies WorkerReply, [out.snapshot.buffer as ArrayBuffer]);
    } catch (e) {
      port.postMessage({ id: req.id, ok: false, message: (e as Error).message } satisfies WorkerReply);
    }
  });
}
