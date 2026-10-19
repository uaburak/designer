/**
 * A lost WebGL context brought back, as Figma does (3187 @2 724 384; docs/research/atlas/20-rendering.md §3.6): the
 * browser is given 3 s to restore it by itself, then it is asked to (`WEBGL_lose_context.restoreContext()`), every
 * 3 s, three times at most; a context that still doesn't come back is an error the editor shows. A loss soon after a
 * restore that had to be asked for counts: after three in a row (each less than 30 s after the last restore) the
 * context is given up — "repeatedly lost after forced restoration".
 *
 * CanvasController owns one per WebGL2 canvas; the engine hears the loss and the restore (engine_gl_context_lost /
 * _restored) and rebuilds its GPU caches.
 */

export const RESTORE_POLL_MS = 3000;
export const RESTORE_ATTEMPTS = 3;
export const FORCED_RESTORE_LIMIT = 3;
export const FORCED_RESTORE_RESET_MS = 30_000;

/** Figma's two messages (English in its build). */
export const CONTEXT_NOT_RESTORED = "WebGL context was lost and could not be restored";
export const CONTEXT_REPEATEDLY_LOST = "WebGL context was repeatedly lost after forced restoration";

export interface RestorableContext {
  isLost(): boolean;
  /** WEBGL_lose_context.restoreContext() */
  restore(): void;
}

export interface Clock {
  now(): number;
  setTimeout(f: () => void, ms: number): number;
  clearTimeout(id: number): void;
}

const browserClock: Clock = {
  now: () => performance.now(),
  setTimeout: (f, ms) => window.setTimeout(f, ms),
  clearTimeout: (id) => window.clearTimeout(id),
};

export class ContextRestorer {
  private timer = 0;
  private attempts = 0;
  /** Restores in a row that had to be asked for (reset by a loss 30 s or more after the last restore). */
  private forcedInARow = 0;
  private lastRestore = -Infinity;
  private failed = false;

  constructor(
    private readonly context: RestorableContext,
    private readonly onFatal: (message: string) => void,
    private readonly clock: Clock = browserClock
  ) {}

  /** `webglcontextlost` (after its preventDefault). */
  lost(): void {
    if (this.failed) return;
    if (this.clock.now() - this.lastRestore >= FORCED_RESTORE_RESET_MS) this.forcedInARow = 0;
    if (this.forcedInARow >= FORCED_RESTORE_LIMIT) return this.fail(CONTEXT_REPEATEDLY_LOST);
    this.attempts = 0;
    this.poll();
  }

  /** `webglcontextrestored`. */
  restored(): void {
    this.clock.clearTimeout(this.timer);
    this.timer = 0;
    if (this.attempts > 0) this.forcedInARow++;
    this.attempts = 0;
    this.lastRestore = this.clock.now();
  }

  dispose(): void {
    this.clock.clearTimeout(this.timer);
    this.timer = 0;
  }

  private poll(): void {
    this.clock.clearTimeout(this.timer);
    this.timer = this.clock.setTimeout(() => {
      this.timer = 0;
      if (!this.context.isLost()) return;
      if (this.attempts >= RESTORE_ATTEMPTS) return this.fail(CONTEXT_NOT_RESTORED);
      this.attempts++;
      console.warn(`[engine] Context still lost, requesting restore (attempt ${this.attempts})`);
      this.context.restore();
      this.poll();
    }, RESTORE_POLL_MS);
  }

  private fail(message: string): void {
    this.failed = true;
    console.error(`[engine] ${message}`);
    this.onFatal(message);
  }
}

/** The WebGL2 context the engine created on `canvas`, as a RestorableContext (null on a WebGPU canvas). */
export function restorableContext(canvas: HTMLCanvasElement): RestorableContext | null {
  // getContext returns the context Emscripten made (null when the canvas holds a WebGPU one).
  const gl = canvas.getContext("webgl2");
  // The extension is taken while the context lives: a lost context hands out none.
  const lose = gl?.getExtension("WEBGL_lose_context");
  if (!gl || !lose) return null;
  return { isLost: () => gl.isContextLost(), restore: () => lose.restoreContext() };
}
