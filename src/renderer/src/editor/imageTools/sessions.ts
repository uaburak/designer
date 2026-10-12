/**
 * The models' one live session and its backend (docs/ai.md §2.4): WebGPU when the machine has an adapter, else wasm.
 * WebGPU can also fail later than the session's creation (a shader over the adapter's 10 storage buffers a stage only
 * shows at the first run), so a failed creation or run on WebGPU drops the session, remembers that this model doesn't
 * run on WebGPU here, and does the call again on wasm. Kept free of onnxruntime so it can be tested (modelWorker.ts
 * gives it the real `open`).
 */
export type ExecutionProvider = "webgpu" | "wasm";

export interface SessionBackend<S> {
  /** Whether a WebGPU adapter exists (asked once) */
  hasGpu(): Promise<boolean>;
  open(key: string, providers: ExecutionProvider[]): Promise<S>;
  release(session: S): Promise<void>;
  /** Which backend a model runs on, and fallbacks (the worker logs them: the first thing to read when a tool is slow) */
  log?(message: string): void;
}

export class SessionCache<S> {
  private live: { key: string; session: S; gpu: boolean } | null = null;
  private gpu: Promise<boolean> | null = null;
  /** Models that failed on WebGPU in this worker: wasm from now on */
  readonly gpuFailed = new Set<string>();

  /**
   * `wasmOnly`: models that run without an error on WebGPU but answer wrong pixels there (LaMa: white and magenta
   * noise on an Apple M3, right on wasm), so they never try it.
   */
  constructor(
    private readonly backend: SessionBackend<S>,
    private readonly o: { wasmOnly?: (key: string) => boolean } = {}
  ) {}

  /** The backend the live session runs on (tests, logs) */
  get liveProvider(): ExecutionProvider | null {
    return this.live ? (this.live.gpu ? "webgpu" : "wasm") : null;
  }

  /** Runs `fn` on the model's session; a WebGPU failure is done again on wasm once. */
  async run<R>(key: string, fn: (session: S) => Promise<R>): Promise<R> {
    const live = await this.session(key);
    try {
      return await fn(live.session);
    } catch (err) {
      if (!live.gpu) throw err;
      this.backend.log?.(`${key}: WebGPU failed (${err instanceof Error ? err.message.slice(0, 160) : String(err)}), running on wasm`);
      this.gpuFailed.add(key);
      await this.drop();
      return fn((await this.session(key)).session);
    }
  }

  async drop(): Promise<void> {
    const l = this.live;
    this.live = null;
    if (l) await this.backend.release(l.session).catch(() => {});
  }

  private async session(key: string): Promise<{ key: string; session: S; gpu: boolean }> {
    if (this.live?.key === key) return this.live;
    await this.drop();
    this.gpu ??= this.backend.hasGpu().catch(() => false);
    const gpu = !this.gpuFailed.has(key) && !this.o.wasmOnly?.(key) && (await this.gpu);
    if (gpu) {
      try {
        this.live = { key, session: await this.backend.open(key, ["webgpu", "wasm"]), gpu: true };
        this.backend.log?.(`${key} on WebGPU`);
        return this.live;
      } catch {
        this.gpuFailed.add(key);
      }
    }
    this.live = { key, session: await this.backend.open(key, ["wasm"]), gpu: false };
    this.backend.log?.(`${key} on wasm`);
    return this.live;
  }
}
