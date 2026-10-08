import type { TabAttach } from "../shared/ipc";

/**
 * The spare editor (docs/desktop.md §3.1, Figma's "preloaded tab"): one
 * hidden editor view per window with no file, made 3 s after the content in
 * front is ready, whose page, React and Wasm module are loaded by the time a
 * file opens. Opening a file then takes the spare — main tells it its tab and
 * file (`tab:attach`) — and a new spare comes 3 s later. At most one at a
 * time; off under `DESIGNER_DISABLE_SPARE=1`; dropped (and replaced) when its
 * renderer dies, up to a few times in a row; gone with the window.
 *
 * The timing lives here, with the window's parts injected, so it is tested
 * without Electron (spare.test.ts); TabManager owns the one instance.
 */

/** How long after the content is ready (and after each adoption) the spare is made. */
export const SPARE_DELAY_MS = 3000;
/** A spare whose renderer keeps dying isn't made again after this many deaths in a row (something is wrong with the page). */
export const MAX_SPARE_CRASHES = 3;

export interface SpareHost<V> {
  /** A hidden editor view with no file, in the window at the content's place. */
  create(): V;
  /** The view gone for good: out of the window, its webContents closed. */
  destroy(view: V): void;
  /** The view is a tab's now: its registry entry and `tab:attach`. */
  attach(view: V, attach: TabAttach): void;
  /** `cb` when the view's renderer died (not a clean exit); returns the way to stop listening. */
  onGone(view: V, cb: () => void): () => void;
  timers?: { setTimeout(fn: () => void, ms: number): unknown; clearTimeout(timer: unknown): void };
  /** Where `DESIGNER_DISABLE_SPARE` is read (default: process.env). */
  env?: Record<string, string | undefined>;
  log?: (message: string) => void;
}

export class SpareEditor<V> {
  readonly enabled: boolean;
  private spare: { view: V; offGone: () => void; since: number } | null = null;
  private timer: unknown = null;
  private crashes = 0;
  private destroyed = false;
  private readonly timers: NonNullable<SpareHost<V>["timers"]>;

  constructor(private readonly host: SpareHost<V>) {
    this.enabled = (host.env ?? process.env).DESIGNER_DISABLE_SPARE !== "1";
    this.timers = host.timers ?? { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (t) => clearTimeout(t as ReturnType<typeof setTimeout>) };
  }

  /** The content in front is ready (Home has painted): the first spare comes 3 s on. Later calls change nothing. */
  ready(): void {
    this.schedule();
  }

  /** The spare's view, if there is one (for debug and the window's housekeeping: bounds, theme, hiding). */
  view(): V | null {
    return this.spare?.view ?? null;
  }

  /** When the spare was made (epoch ms), or null. */
  since(): number | null {
    return this.spare?.since ?? null;
  }

  /**
   * The spare for a file that opens, told its tab and file — or null when there is none (or the spare is off), and
   * the caller makes a view of its own. A new spare comes 3 s on.
   */
  adopt(attach: TabAttach): V | null {
    const s = this.spare;
    if (!s) return null;
    this.spare = null;
    s.offGone();
    this.host.attach(s.view, attach);
    this.crashes = 0;
    this.schedule();
    return s.view;
  }

  /** The window is gone: no spare, no timer. */
  destroy(): void {
    this.destroyed = true;
    if (this.timer !== null) this.timers.clearTimeout(this.timer);
    this.timer = null;
    const s = this.spare;
    this.spare = null;
    if (s) {
      s.offGone();
      this.host.destroy(s.view);
    }
  }

  private schedule(): void {
    if (!this.enabled || this.destroyed || this.timer !== null || this.spare) return;
    this.timer = this.timers.setTimeout(() => {
      this.timer = null;
      this.make();
    }, SPARE_DELAY_MS);
  }

  private make(): void {
    if (this.destroyed || this.spare) return;
    const view = this.host.create();
    const offGone = this.host.onGone(view, () => this.gone(view));
    this.spare = { view, offGone, since: Date.now() };
  }

  /** The spare's renderer died: dropped, and another one 3 s on — unless it keeps happening. */
  private gone(view: V): void {
    const s = this.spare;
    if (!s || s.view !== view) return;
    this.spare = null;
    s.offGone();
    this.host.destroy(view);
    this.crashes++;
    if (this.crashes < MAX_SPARE_CRASHES) this.schedule();
    else (this.host.log ?? console.warn)(`[spare] the spare editor's renderer died ${this.crashes} times in a row — not made again`);
  }
}
