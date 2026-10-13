// A scene's guided demo (docs/site.md §2.2): a script that plays while the scene is on screen, yields the moment the
// visitor touches the scene, and starts again from its beginning after the visitor has left it alone for a while.
// No DOM here (useDemo.ts wires it to the page); the timers are injectable so the rules are tested
// (demoController.test.ts).

export interface DemoTimers {
  set(fn: () => void, ms: number): number;
  clear(id: number): void;
}

export interface DemoRun {
  /** Aborted when the visitor takes over or the scene leaves the screen. */
  readonly signal: AbortSignal;
  /** Resolves after `ms`; rejects (an AbortError) as soon as the run is aborted. */
  wait(ms: number): Promise<void>;
}

export type DemoScript = (run: DemoRun) => Promise<void>;

export type DemoState = "off" | "starting" | "playing" | "between" | "yielded";

export interface DemoOptions {
  /** Quiet time after the visitor's last touch before the demo starts again */
  idleMs?: number;
  /** Pause between two plays of the script */
  loopGapMs?: number;
  /** Delay between the scene coming on screen and the first step */
  startDelayMs?: number;
  timers?: DemoTimers;
  onState?: (state: DemoState) => void;
}

const browserTimers: DemoTimers = {
  set: (fn, ms) => window.setTimeout(fn, ms),
  clear: (id) => window.clearTimeout(id),
};

export const isAbort = (e: unknown): boolean => e instanceof Error && e.name === "AbortError";

function abortError(): Error {
  const e = new Error("The demo yielded");
  e.name = "AbortError";
  return e;
}

export class DemoController {
  private readonly idleMs: number;
  private readonly loopGapMs: number;
  private readonly startDelayMs: number;
  private readonly timers: DemoTimers;
  private readonly onState?: (state: DemoState) => void;
  private visible = false;
  private enabled = true;
  private disposed = false;
  private timer: number | null = null;
  private abort: AbortController | null = null;
  private current: DemoState = "off";

  constructor(
    private readonly script: DemoScript,
    options: DemoOptions = {},
  ) {
    this.idleMs = options.idleMs ?? 7000;
    this.loopGapMs = options.loopGapMs ?? 1600;
    this.startDelayMs = options.startDelayMs ?? 500;
    this.timers = options.timers ?? browserTimers;
    this.onState = options.onState;
  }

  get state(): DemoState {
    return this.current;
  }

  /** The scene came on screen (or went off it: everything stops, and it starts over next time). */
  setVisible(visible: boolean): void {
    if (visible === this.visible) return;
    this.visible = visible;
    if (!visible) {
      this.stop("off");
      return;
    }
    if (this.current === "off") this.schedule("starting", this.startDelayMs);
  }

  /** Off for visitors who prefer reduced motion: the scene still answers their input. */
  setEnabled(enabled: boolean): void {
    if (enabled === this.enabled) return;
    this.enabled = enabled;
    if (!enabled) this.stop("off");
    else if (this.visible) this.schedule("starting", this.startDelayMs);
  }

  /** The visitor touched the scene: the demo stops where it is and waits for them to leave it alone. */
  interact(): void {
    if (this.disposed || !this.enabled) return;
    this.cancelRun();
    this.schedule("yielded", this.idleMs);
  }

  /** The visitor is still around (the pointer moving over the scene): a yielded demo waits longer. */
  poke(): void {
    if (this.current === "yielded") this.schedule("yielded", this.idleMs);
  }

  dispose(): void {
    this.stop("off");
    this.disposed = true;
  }

  private setState(state: DemoState): void {
    if (state === this.current) return;
    this.current = state;
    this.onState?.(state);
  }

  private clearTimer(): void {
    if (this.timer !== null) this.timers.clear(this.timer);
    this.timer = null;
  }

  private cancelRun(): void {
    this.abort?.abort();
    this.abort = null;
  }

  private stop(state: DemoState): void {
    this.clearTimer();
    this.cancelRun();
    this.setState(state);
  }

  private schedule(state: DemoState, ms: number): void {
    this.clearTimer();
    this.setState(state);
    if (!this.visible || !this.enabled || this.disposed) {
      if (!this.visible || !this.enabled) this.setState("off");
      return;
    }
    this.timer = this.timers.set(() => {
      this.timer = null;
      this.play();
    }, ms);
  }

  private play(): void {
    if (!this.visible || !this.enabled || this.disposed) return;
    const abort = new AbortController();
    this.abort = abort;
    const { signal } = abort;
    const run: DemoRun = {
      signal,
      wait: (ms) =>
        new Promise<void>((resolve, reject) => {
          if (signal.aborted) return reject(abortError());
          const id = this.timers.set(() => {
            signal.removeEventListener("abort", onAbort);
            resolve();
          }, ms);
          const onAbort = () => {
            this.timers.clear(id);
            reject(abortError());
          };
          signal.addEventListener("abort", onAbort, { once: true });
        }),
    };
    this.setState("playing");
    this.script(run).then(
      () => {
        if (signal.aborted || this.abort !== abort) return;
        this.abort = null;
        this.schedule("between", this.loopGapMs);
      },
      (error: unknown) => {
        if (this.abort === abort) this.abort = null;
        if (!isAbort(error)) {
          console.warn("[demo]", error);
          if (!signal.aborted) this.stop("off");
        }
      },
    );
  }
}
