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
  /** Shown in Dev Mode's Plugins panel, not floating (an inspect plugin, docs/plugins.md §7) */
  docked?: boolean;
}

export interface RunningState {
  runId: string;
  name: string;
  /** "done": the run ended while its toast showed — a check for a moment (Figma's) */
  state: "running" | "done";
}

/** Figma's progress toast: it shows 300 ms after a run asks for it; a run that ends under it leaves a check for 1 s. */
export const RUNNING_DELAY_MS = 300;
export const RUNNING_DONE_MS = 1000;

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
  /** runId → the running toast waiting out its delay */
  private readonly pending = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly listeners = new Set<() => void>();
  /** runId → the iframe's link (set when it loads) */
  readonly frames = new Map<string, FrameLink>();
  /** runId → Stop (the "Running ‹name›" toast's Cancel) */
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

  /**
   * The "Running ‹name›" toast of a run: `on` asks for it (shown after RUNNING_DELAY_MS), off takes it down — at once
   * when the run's UI shows, as a check for RUNNING_DONE_MS when the run `ended` while it showed.
   */
  setRunning(runId: string, name: string, on: boolean, ended = false): void {
    const has = this.snap.running.find((r) => r.runId === runId);
    if (on) {
      if (has?.state === "running" || this.pending.has(runId)) return;
      this.pending.set(
        runId,
        setTimeout(() => {
          this.pending.delete(runId);
          this.set({ ...this.snap, running: [...this.snap.running.filter((r) => r.runId !== runId), { runId, name, state: "running" }] });
        }, RUNNING_DELAY_MS)
      );
      return;
    }
    clearTimeout(this.pending.get(runId));
    this.pending.delete(runId);
    if (!has || has.state === "done") return;
    const rest = this.snap.running.filter((r) => r.runId !== runId);
    if (!ended) return this.set({ ...this.snap, running: rest });
    this.set({ ...this.snap, running: [...rest, { ...has, state: "done" }] });
    setTimeout(() => this.set({ ...this.snap, running: this.snap.running.filter((r) => r.runId !== runId) }), RUNNING_DONE_MS);
  }
}

// ---- The window's size and place (docs/research/atlas/17-plugins.md §3.3) -------------------------------------------

/** The window's title bar above the iframe (PluginLayer.module.css `.titleBar`) */
export const TITLE_BAR = 40;
const POSITIONS_KEY = "designer.plugins.positions";

/** Figma's clamps: width 70 … the window less 50; height 0 … the window less 48 and the title bar. */
export function clampSize(width: number, height: number): { width: number; height: number } {
  const w = Math.round(Math.max(70, Math.min(width, window.innerWidth - 50)));
  const h = Math.round(Math.max(0, Math.min(height, window.innerHeight - 48 - TITLE_BAR)));
  return { width: w, height: h };
}

/** A place kept inside the editor's window (a saved place from a larger window comes back in). */
export function clampPosition(at: { x: number; y: number }, size: { width: number; height: number }): { x: number; y: number } {
  return { x: Math.round(Math.max(0, Math.min(at.x, window.innerWidth - size.width))), y: Math.round(Math.max(0, Math.min(at.y, window.innerHeight - size.height - TITLE_BAR))) };
}

/** Centred in the window (Figma's place for a plugin it has no place for yet). */
export const centred = (size: { width: number; height: number }): { x: number; y: number } => clampPosition({ x: (window.innerWidth - size.width) / 2, y: (window.innerHeight - size.height - TITLE_BAR) / 2 }, size);

/** The place this plugin's window was last left at (Figma's "last", per plugin id), or null. */
export function savedPosition(pluginId: string): { x: number; y: number } | null {
  try {
    const all = JSON.parse(localStorage.getItem(POSITIONS_KEY) ?? "{}") as Record<string, { x: number; y: number }>;
    const at = all[pluginId];
    return at && Number.isFinite(at.x) && Number.isFinite(at.y) ? at : null;
  } catch {
    return null;
  }
}

/** Kept on every drag and reposition (Figma's storeModalPosition). */
export function savePosition(pluginId: string, at: { x: number; y: number }): void {
  try {
    const all = JSON.parse(localStorage.getItem(POSITIONS_KEY) ?? "{}") as Record<string, { x: number; y: number }>;
    localStorage.setItem(POSITIONS_KEY, JSON.stringify({ ...all, [pluginId]: at }));
  } catch {
    // Private mode: the default place next time.
  }
}

export function usePluginUi(store: PluginUiStore): PluginUiSnapshot {
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}
