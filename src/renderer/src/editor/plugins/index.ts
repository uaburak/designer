/**
 * The plugin host's sandbox (docs/plugins.md §3.1): QuickJS compiled to Wasm on the editor's main thread, for plugins
 * and for Code Connect templates (docs/editor.md D-1). A stub before round 5d, which fills it; 5f's templates use it.
 */

export interface Sandbox {
  call(fn: string, ...args: unknown[]): Promise<unknown>;
  dispose(): void;
}

export function createSandbox(opts: { kind: "plugin" | "template"; code: string; api: Record<string, unknown>; memoryMb?: number; timeoutMs?: number }): Promise<Sandbox> {
  void opts;
  return Promise.reject(new Error("Plugins aren't built yet"));
}
