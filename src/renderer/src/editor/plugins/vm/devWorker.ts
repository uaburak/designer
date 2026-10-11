/**
 * "Use developer VM" (docs/plugins.md §2 decision 2): the same host behind a dedicated Worker running the plugin's code
 * in V8 (devWorker.worker.ts). Host calls are synchronous for the worker: it posts {t: "host"} and blocks in
 * Atomics.wait while this side answers into a SharedArrayBuffer (in chunks when the answer is longer than the buffer).
 * Development plugins only, and only in a cross-origin isolated view (SharedArrayBuffer).
 */
import { VmError, type PluginVm, type VmOptions } from "./types";

const BUFFER = 1 << 20;

/** The worker as this side uses it (a real Worker, or a test's fake). */
export interface WorkerLike {
  postMessage(message: unknown): void;
  onmessage: ((e: MessageEvent) => void) | null;
  onerror: ((e: ErrorEvent) => void) | null;
  terminate(): void;
}

export const developerVmAvailable = (): boolean => typeof SharedArrayBuffer === "function" && (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated !== false;

export class DevWorkerVm implements PluginVm {
  readonly kind = "developer" as const;
  private readonly header: Int32Array;
  private readonly data: Uint8Array;
  private readonly encoder = new TextEncoder();
  private pendingAnswer: Uint8Array | null = null;
  private seq = 0;
  private readonly calls = new Map<number, { resolve: (v: string) => void; reject: (e: VmError) => void }>();
  private dead: VmError | null = null;

  constructor(
    private readonly worker: WorkerLike,
    private readonly options: VmOptions
  ) {
    const sab = new SharedArrayBuffer(8 + BUFFER);
    this.header = new Int32Array(sab, 0, 2);
    this.data = new Uint8Array(sab, 8);
    worker.onmessage = (e) => this.onMessage(e.data as Record<string, unknown>);
    worker.onerror = (e) => this.options.onError?.(new VmError(e.message));
    worker.postMessage({ t: "init", sab });
  }

  static create(options: VmOptions): DevWorkerVm {
    if (!developerVmAvailable()) throw new Error("The developer VM needs a cross-origin isolated view");
    const worker = new Worker(new URL("./devWorker.worker.ts", import.meta.url), { type: "module", name: "Plugin (developer VM)" });
    return new DevWorkerVm(worker as unknown as WorkerLike, options);
  }

  /** Writes the next chunk of the answer and wakes the worker. */
  private sendChunk(): void {
    const all = this.pendingAnswer!;
    const n = Math.min(all.length, BUFFER);
    this.data.set(all.subarray(0, n));
    this.pendingAnswer = all.length > n ? all.subarray(n) : null;
    Atomics.store(this.header, 1, n);
    Atomics.store(this.header, 0, this.pendingAnswer ? 2 : 1);
    Atomics.notify(this.header, 0);
  }

  private onMessage(m: Record<string, unknown>): void {
    switch (m.t) {
      case "host": {
        let answer: string;
        try {
          answer = this.options.host(String(m.op), String(m.args ?? "[]"));
        } catch (e) {
          answer = JSON.stringify({ err: e instanceof Error ? e.message : String(e) });
        }
        this.pendingAnswer = this.encoder.encode(answer);
        this.sendChunk();
        return;
      }
      case "more":
        if (this.pendingAnswer) this.sendChunk();
        return;
      case "done":
      case "fail": {
        const c = this.calls.get(Number(m.id));
        if (!c) return;
        this.calls.delete(Number(m.id));
        if (m.t === "done") c.resolve(String(m.result ?? ""));
        else c.reject(new VmError(String(m.message), m.stack ? String(m.stack) : undefined));
        return;
      }
      case "error":
        this.options.onError?.(new VmError(String(m.message), m.stack ? String(m.stack) : undefined));
        return;
    }
  }

  private send(message: Record<string, unknown>): Promise<string> {
    if (this.dead) return Promise.reject(this.dead);
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.calls.set(id, { resolve, reject });
      this.worker.postMessage({ ...message, id });
    });
  }

  async evaluate(code: string, filename: string): Promise<void> {
    await this.send({ t: "eval", code, filename });
  }

  call(fn: string, ...args: (string | number)[]): Promise<string> {
    return this.send({ t: "call", fn, args });
  }

  interrupt(): void {
    this.dispose();
  }

  dispose(): void {
    if (this.dead) return;
    this.dead = new VmError("The plugin was stopped");
    this.worker.terminate();
    for (const c of this.calls.values()) c.reject(this.dead);
    this.calls.clear();
  }
}
