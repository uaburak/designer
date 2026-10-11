/**
 * One interface for both VMs (docs/plugins.md §2 decisions 1 and 2): QuickJS compiled to Wasm on the editor's main
 * thread (`quickjs.ts`), and the developer VM — the plugin's code in V8 inside a dedicated Worker (`devWorker.ts`).
 *
 * The VM sees one host function, `__hostCall(op, json) → json` (runtime/bridge.js); everything else is scripts the host
 * evaluates and global functions it calls with JSON (`__dispatch`, `__settle`, `__timer`, `__uiMessage` …).
 */

/** The host's answer to `__hostCall`: JSON of {ok} | {err, name?} | {async: id}. */
export type HostCall = (op: string, argsJson: string) => string;

/** An error thrown by the VM's code (its message and stack as the VM gives them). */
export class VmError extends Error {
  constructor(
    message: string,
    readonly vmStack?: string
  ) {
    super(message);
    this.name = "VmError";
  }
}

export interface VmLimits {
  /** Heap limit (QuickJS); default 256 MB */
  memoryMb?: number;
  /** Stack limit (QuickJS); default 1 MB */
  stackKb?: number;
  /** A synchronous slice longer than this is interrupted (templates); default none (plugins run until Stop) */
  sliceTimeoutMs?: number;
}

export interface PluginVm {
  readonly kind: "quickjs" | "developer";
  /** Runs a script in the VM's global scope (then its pending jobs). Throws VmError. */
  evaluate(code: string, filename: string): Promise<void>;
  /** Calls the global function `fn` with string arguments; its result as a string (or "" for none). Throws VmError. */
  call(fn: string, ...args: (string | number)[]): Promise<string>;
  /** Ends a runaway slice (Stop plugin) and refuses further calls. */
  interrupt(): void;
  dispose(): void;
}

export interface VmOptions extends VmLimits {
  host: HostCall;
  /** An unhandled rejection or an error from a job the host didn't start (reported to the developer's console) */
  onError?: (e: VmError) => void;
}
