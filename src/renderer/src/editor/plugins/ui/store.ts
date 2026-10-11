/**
 * What the plugin chrome draws (docs/plugins.md §3.2, §6): each run's UI window and the "Running ‹name›" toast, as a
 * small external store per editor that React reads (`usePluginUi`). Runs write it; the windows post into their
 * iframes through `frames`.
 */
import { useSyncExternalStore } from "react";

export interface PluginWindowState {
  runId: string;
  pluginId: string;
  name: string;
  title: string;
  /** The iframe's document: a `plugin:` URL (desktop) or srcdoc (browser) */
  src: { url: string } | { srcdoc: string } | null;
  visible: boolean;
  width: number;
  height: number;
  /** Top-left in the editor view (CSS px); null: the default place */
  position: { x: number; y: number } | null;
}

export interface RunningState {
  runId: string;
  name: string;
}

export interface PluginUiSnapshot {
  windows: PluginWindowState[];
  running: RunningState[];
}

/** A frame's side of messaging (the iframe component registers it once loaded). */
export interface FrameLink {
  post(message: unknown): void;
}

export class PluginUiStore {
  private snap: PluginUiSnapshot = { windows: [], running: [] };
  private readonly listeners = new Set<() => void>();
  /** runId → the iframe's link (set when it loads) */
  readonly frames = new Map<string, FrameLink>();
  /** runId → Stop (the "Running ‹name›" toast's ✕) */
  readonly stoppers = new Map<string, () => void>();
  /** runId → the message handler (the run's `__uiMessage`), the drop handler, the window's ✕ */
  readonly handlers = new Map<string, { message(data: unknown, origin: string): void; drop?(data: unknown, at: { x: number; y: number }): void; close(): void; stop(): void; loaded(): void }>();

  get = (): PluginUiSnapshot => this.snap;
  subscribe = (l: () => void): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };
  private set(next: PluginUiSnapshot) {
    this.snap = next;
    this.listeners.forEach((l) => l());
  }

  window(runId: string): PluginWindowState | undefined {
    return this.snap.windows.find((w) => w.runId === runId);
  }

  putWindow(w: PluginWindowState): void {
    const rest = this.snap.windows.filter((x) => x.runId !== w.runId);
    this.set({ ...this.snap, windows: [...rest, w] });
  }

  patchWindow(runId: string, patch: Partial<PluginWindowState>): void {
    const w = this.window(runId);
    if (w) this.putWindow({ ...w, ...patch });
  }

  removeWindow(runId: string): void {
    this.frames.delete(runId);
    if (this.window(runId)) this.set({ ...this.snap, windows: this.snap.windows.filter((x) => x.runId !== runId) });
  }

  setRunning(runId: string, name: string, on: boolean): void {
    const has = this.snap.running.some((r) => r.runId === runId);
    if (on === has) return;
    this.set({ ...this.snap, running: on ? [...this.snap.running, { runId, name }] : this.snap.running.filter((r) => r.runId !== runId) });
  }
}

export function usePluginUi(store: PluginUiStore): PluginUiSnapshot {
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}
