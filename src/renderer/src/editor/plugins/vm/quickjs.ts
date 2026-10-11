/**
 * QuickJS compiled to WebAssembly on the editor's main thread (docs/plugins.md §2 decision 1): one runtime per run,
 * its own heap (256 MB), a 1 MB stack, and an interrupt handler that ends a runaway loop when the run is stopped (or a
 * template's slice runs past its time). The VM reaches nothing but `__hostCall`.
 *
 * Packages (exact pins, package.json): `quickjs-emscripten-core` + `@jitl/quickjs-wasmfile-release-asyncify`. The
 * asyncify build is the contract's; host calls here are synchronous (an async API answers {async: id} and settles
 * later through `__settle`), so no call suspends the VM.
 */
import { newQuickJSAsyncWASMModuleFromVariant, type QuickJSAsyncContext, type QuickJSAsyncRuntime, type QuickJSAsyncWASMModule, type QuickJSHandle } from "quickjs-emscripten-core";
import variant from "@jitl/quickjs-wasmfile-release-asyncify";
import { VmError, type PluginVm, type VmOptions } from "./types";

let modulePromise: Promise<QuickJSAsyncWASMModule> | null = null;

/** The QuickJS module, loaded once per view (each run makes its own runtime from it). */
export function quickJsModule(): Promise<QuickJSAsyncWASMModule> {
  modulePromise ??= newQuickJSAsyncWASMModuleFromVariant(variant).catch((e) => {
    modulePromise = null;
    throw e;
  });
  return modulePromise;
}

export class QuickJsVm implements PluginVm {
  readonly kind = "quickjs" as const;
  private stopped = false;
  private deadline = Infinity;
  private disposed = false;

  private constructor(
    private readonly runtime: QuickJSAsyncRuntime,
    private readonly ctx: QuickJSAsyncContext,
    private readonly options: VmOptions
  ) {}

  static async create(options: VmOptions): Promise<QuickJsVm> {
    const mod = await quickJsModule();
    const runtime = mod.newRuntime();
    runtime.setMemoryLimit((options.memoryMb ?? 256) * 1024 * 1024);
    runtime.setMaxStackSize((options.stackKb ?? 1024) * 1024);
    const ctx = runtime.newContext();
    const vm = new QuickJsVm(runtime, ctx, options);
    runtime.setInterruptHandler(() => vm.stopped || Date.now() > vm.deadline);
    const hostCall = ctx.newFunction("__hostCall", (opHandle, argsHandle) => {
      const op = ctx.getString(opHandle);
      const args = argsHandle ? ctx.getString(argsHandle) : "[]";
      let answer: string;
      try {
        answer = options.host(op, args);
      } catch (e) {
        answer = JSON.stringify({ err: e instanceof Error ? e.message : String(e), ...(e instanceof Error && e.name !== "Error" ? { name: e.name } : {}) });
      }
      return ctx.newString(answer);
    });
    ctx.setProp(ctx.global, "__hostCall", hostCall);
    hostCall.dispose();
    return vm;
  }

  private check(): void {
    if (this.disposed) throw new VmError("The plugin was closed");
    if (this.stopped) throw new VmError("The plugin was stopped");
  }

  private begin(): void {
    this.deadline = this.options.sliceTimeoutMs ? Date.now() + this.options.sliceTimeoutMs : Infinity;
  }

  /** The error a failed evaluation left, as a VmError. */
  private failure(handle: QuickJSHandle): VmError {
    const v = this.ctx.dump(handle) as unknown;
    handle.dispose();
    if (v && typeof v === "object") {
      const o = v as { name?: string; message?: string; stack?: string };
      const message = o.message ?? String(v);
      if (message === "interrupted") return new VmError(this.stopped ? "The plugin was stopped" : "The plugin took too long and was stopped");
      return new VmError(o.name && o.name !== "Error" ? `${o.name}: ${message}` : message, o.stack);
    }
    return new VmError(String(v));
  }

  /** Runs the VM's pending jobs (promise reactions); an error there goes to onError. */
  private pump(): void {
    for (let i = 0; i < 1000; i++) {
      if (this.disposed) return;
      const r = this.runtime.executePendingJobs(-1);
      if (r.error) {
        const e = this.failure(r.error);
        if (this.stopped) throw e;
        this.options.onError?.(e);
        continue;
      }
      if (r.value === 0) return;
    }
  }

  async evaluate(code: string, filename: string): Promise<void> {
    this.check();
    this.begin();
    const r = this.ctx.evalCode(code, filename);
    if (r.error) {
      const e = this.failure(r.error);
      this.pump();
      throw e;
    }
    r.value.dispose();
    this.pump();
  }

  async call(fn: string, ...args: (string | number)[]): Promise<string> {
    this.check();
    this.begin();
    const f = this.ctx.getProp(this.ctx.global, fn);
    try {
      if (this.ctx.typeof(f) !== "function") return "";
      const handles = args.map((a) => (typeof a === "number" ? this.ctx.newNumber(a) : this.ctx.newString(a)));
      const r = this.ctx.callFunction(f, this.ctx.undefined, ...handles);
      handles.forEach((h) => h.dispose());
      if (r.error) {
        const e = this.failure(r.error);
        this.pump();
        throw e;
      }
      const out = this.ctx.typeof(r.value) === "string" ? this.ctx.getString(r.value) : "";
      r.value.dispose();
      this.pump();
      return out;
    } finally {
      f.dispose();
    }
  }

  interrupt(): void {
    this.stopped = true;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stopped = true;
    try {
      this.ctx.dispose();
      this.runtime.dispose();
    } catch {
      // A runtime left with live objects (a run stopped mid-call) aborts QuickJS's module: the next run loads a new one.
      modulePromise = null;
    }
  }
}
