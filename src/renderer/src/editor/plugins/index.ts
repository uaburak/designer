/**
 * The plugin host's sandbox (docs/plugins.md §3.1): QuickJS compiled to Wasm on the editor's main thread, for plugins
 * (host.ts runs them with the `figma` API) and for Code Connect templates (docs/editor.md D-1), which get their own API
 * through `createSandbox`: `api`'s functions become host calls (a returned promise settles in the VM), its other
 * values are copied in as JSON; `call(fn, ...args)` calls a global the code defined and resolves with its (awaited)
 * result. One runtime per sandbox; memory 256 MB unless `memoryMb`; a synchronous slice longer than `timeoutMs`
 * (default 5 s) is interrupted.
 */
import bridgeSource from "./runtime/bridge.js?raw";
import { decodeValue, encodeValue } from "./api/codec";
import { QuickJsVm } from "./vm/quickjs";
import { VmError } from "./vm/types";

export interface Sandbox {
  call(fn: string, ...args: unknown[]): Promise<unknown>;
  dispose(): void;
}

type Fn = (...args: unknown[]) => unknown;

/** The VM-side script that builds `api` as globals: functions as host calls, the rest as JSON. */
function apiScript(api: Record<string, unknown>, fns: Map<string, Fn>): string {
  const build = (v: unknown, path: string, depth: number): string => {
    if (typeof v === "function") {
      fns.set(path, v as Fn);
      return `fn(${JSON.stringify(path)})`;
    }
    if (v && typeof v === "object" && !Array.isArray(v) && !(v instanceof Uint8Array) && depth < 8) {
      const entries = Object.entries(v as Record<string, unknown>).map(([k, x]) => `${JSON.stringify(k)}: ${build(x, `${path}.${k}`, depth + 1)}`);
      return `{${entries.join(", ")}}`;
    }
    return `B.decode(${JSON.stringify(encodeValue(v))})`;
  };
  const globals = Object.entries(api).map(([k, v]) => `g[${JSON.stringify(k)}] = ${build(v, k, 0)};`);
  return `(function () {
  "use strict";
  var g = globalThis;
  var B = g.__bridge;
  delete g.__bridge;
  function fn(path) { return function () { return B.call("api", path, Array.prototype.slice.call(arguments)); }; }
  ${globals.join("\n  ")}
  g.__sandboxCall = function (id, name, json) {
    var f = g[name];
    Promise.resolve()
      .then(function () {
        if (typeof f !== "function") throw new Error(name + " is not a function");
        return f.apply(null, B.decode(json));
      })
      .then(
        function (v) { B.call("result", id, true, v); },
        function (e) { B.call("result", id, false, String(e && e.message !== undefined ? e.message : e)); }
      );
  };
})();`;
}

export async function createSandbox(opts: { kind: "plugin" | "template"; code: string; api: Record<string, unknown>; memoryMb?: number; timeoutMs?: number }): Promise<Sandbox> {
  const fns = new Map<string, Fn>();
  const results = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  let asyncSeq = 0;
  let callSeq = 0;
  // eslint-disable-next-line prefer-const -- assigned once the VM exists; host calls only come after
  let vm: QuickJsVm;
  const timers = new Map<number, ReturnType<typeof setTimeout>>();
  const host = (op: string, json: string): string => {
    const args = decodeValue(json) as unknown[];
    try {
      if (op === "api") {
        const f = fns.get(String(args[0]));
        if (!f) throw new Error(`No such function ${String(args[0])}`);
        const r = f(...((args[1] as unknown[]) ?? []));
        if (r instanceof Promise) {
          const id = ++asyncSeq;
          r.then(
            (v) => vm.call("__settle", id, encodeValue({ ok: v === undefined ? null : v })).catch(() => {}),
            (e) => vm.call("__settle", id, JSON.stringify({ err: e instanceof Error ? e.message : String(e) })).catch(() => {})
          );
          return JSON.stringify({ async: id });
        }
        return encodeValue({ ok: r === undefined ? null : r });
      }
      if (op === "result") {
        const p = results.get(Number(args[0]));
        results.delete(Number(args[0]));
        const message = String(args[2]) === "interrupted" ? "The template took too long and was stopped" : String(args[2]);
        if (p && args[1]) p.resolve(args[2]);
        else if (p) p.reject(new Error(message));
        return encodeValue({ ok: null });
      }
      if (op === "console") {
        console.log(`[${opts.kind}]`, ...((args[1] as string[]) ?? []));
        return encodeValue({ ok: null });
      }
      if (op === "timer.set") {
        const id = ++asyncSeq;
        timers.set(id, setTimeout(() => void vm.call("__timer", id).catch(() => {}), Number(args[0]) || 0));
        return encodeValue({ ok: id });
      }
      if (op === "timer.clear") {
        clearTimeout(timers.get(Number(args[0])));
        return encodeValue({ ok: null });
      }
      throw new Error(`${op} isn't available here`);
    } catch (e) {
      return JSON.stringify({ err: e instanceof Error ? e.message : String(e) });
    }
  };
  vm = await QuickJsVm.create({ host, memoryMb: opts.memoryMb ?? 256, sliceTimeoutMs: opts.timeoutMs ?? 5000 });
  try {
    await vm.evaluate(bridgeSource, "bridge.js");
    await vm.evaluate(apiScript(opts.api, fns), "api.js");
    await vm.evaluate(opts.code, opts.kind === "template" ? "template.js" : "code.js");
  } catch (e) {
    vm.dispose();
    throw e instanceof VmError ? new Error(e.message) : e;
  }
  return {
    call(fn, ...args) {
      const id = ++callSeq;
      return new Promise((resolve, reject) => {
        results.set(id, { resolve, reject });
        vm.call("__sandboxCall", id, fn, encodeValue(args)).catch((e: unknown) => {
          results.delete(id);
          reject(e instanceof VmError ? new Error(e.message) : e);
        });
      });
    },
    dispose() {
      for (const t of timers.values()) clearTimeout(t);
      for (const p of results.values()) p.reject(new Error("The sandbox was disposed"));
      results.clear();
      vm.dispose();
    },
  };
}

export { PluginRun, type RunSpec, type RunEnv } from "./host";
