/**
 * The developer VM's worker (docs/plugins.md §2 decision 2): the plugin's code in V8, so devtools can debug it. Before
 * any of the plugin's code runs, the network and storage globals are deleted from the worker's scope and prototypes;
 * `__hostCall` is synchronous through a SharedArrayBuffer and Atomics.wait (the views are cross-origin isolated).
 *
 * Messages in: {t: "init", sab}, {t: "eval", id, code, filename}, {t: "call", id, fn, args}.
 * Messages out: {t: "host", op, args} (then Atomics.wait), {t: "more"} (the next chunk of a long answer),
 * {t: "done", id, result} | {t: "fail", id, message, stack}, {t: "error", message, stack} (an unhandled one).
 */
/** The worker's scope (typed here: the project's lib is the DOM's). */
interface WorkerScope {
  postMessage(message: unknown): void;
  addEventListener(type: "error", f: (e: ErrorEvent) => void): void;
  addEventListener(type: "unhandledrejection", f: (e: PromiseRejectionEvent) => void): void;
  onmessage: ((e: MessageEvent) => void) | null;
}
const scope = self as unknown as WorkerScope;

const post = scope.postMessage.bind(scope);
const atomicsWait = Atomics.wait.bind(Atomics);
const atomicsStore = Atomics.store.bind(Atomics);
const decoder = new TextDecoder();
let header: Int32Array | null = null;
let data: Uint8Array | null = null;

/** [0] state: 0 waiting, 1 last chunk, 2 more to come; [1] this chunk's length. */
function hostCall(op: string, args: string): string {
  if (!header || !data) throw new Error("The developer VM isn't ready");
  atomicsStore(header, 0, 0);
  post({ t: "host", op, args });
  const parts: Uint8Array[] = [];
  for (;;) {
    atomicsWait(header, 0, 0);
    const state = header[0];
    parts.push(data.slice(0, header[1]));
    if (state === 1) break;
    atomicsStore(header, 0, 0);
    post({ t: "more" });
  }
  const total = parts.reduce((n, p) => n + p.length, 0);
  const all = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    all.set(p, at);
    at += p.length;
  }
  return decoder.decode(all);
}

/** What plugin code must not reach: the network, storage, nested workers, script loading (§9). */
function lockGlobals(): void {
  const names = ["fetch", "XMLHttpRequest", "WebSocket", "EventSource", "importScripts", "Worker", "SharedWorker", "indexedDB", "caches", "WebTransport", "BroadcastChannel", "navigator"];
  for (const name of names) {
    let o: object | null = scope;
    while (o) {
      try {
        if (Object.prototype.hasOwnProperty.call(o, name)) delete (o as Record<string, unknown>)[name];
      } catch {
        // Non-configurable: shadowed below.
      }
      o = Object.getPrototypeOf(o);
    }
    try {
      Object.defineProperty(scope, name, { value: undefined, configurable: false, writable: false });
    } catch {
      // Already gone.
    }
  }
}

const g = scope as unknown as Record<string, unknown>;
const indirectEval = (code: string) => (0, eval)(code);

scope.addEventListener("error", (e) => post({ t: "error", message: e.message, stack: e.error?.stack }));
scope.addEventListener("unhandledrejection", (e) => post({ t: "error", message: String(e.reason?.message ?? e.reason), stack: e.reason?.stack }));

scope.onmessage = (e: MessageEvent) => {
  const m = e.data as { t: string; id?: number; sab?: SharedArrayBuffer; code?: string; filename?: string; fn?: string; args?: (string | number)[] };
  if (m.t === "init" && m.sab && !header) {
    header = new Int32Array(m.sab, 0, 2);
    data = new Uint8Array(m.sab, 8);
    g.__hostCall = hostCall;
    lockGlobals();
    return;
  }
  try {
    if (m.t === "eval") {
      indirectEval(`${m.code ?? ""}\n//# sourceURL=${(m.filename ?? "code.js").replace(/[^\w./:-]/g, "_")}`);
      post({ t: "done", id: m.id, result: "" });
    } else if (m.t === "call") {
      const f = g[m.fn ?? ""];
      const r = typeof f === "function" ? (f as (...a: unknown[]) => unknown)(...(m.args ?? [])) : "";
      post({ t: "done", id: m.id, result: typeof r === "string" ? r : "" });
    }
  } catch (err) {
    const x = err as { name?: string; message?: string; stack?: string };
    post({ t: "fail", id: m.id, message: x && x.message !== undefined ? (x.name && x.name !== "Error" ? `${x.name}: ${x.message}` : x.message) : String(err), stack: x?.stack });
  }
};
