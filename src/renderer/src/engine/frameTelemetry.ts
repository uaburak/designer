/**
 * Frame telemetry in Figma's shape (render_worker @445 684 and @445 994; docs/research/atlas/20-rendering.md §10.1–10.2):
 * every frame's time goes into the `fps` histogram's bins, frames between continuous ones count as dropped into the
 * `dropped_frames` histogram, and a frame of 50 ms or more is a slow frame, always kept (Figma logs it and samples the
 * next one). Figma sends these to its analytics; there is no such sink here — `report()` gives the numbers (benches,
 * the console: `__designerEditor.engine.frameTelemetry.report()`), and slow frames are kept, the last 32.
 */

/** Figma's `fps` histogram bin edges, in ms (the last bin runs to ∞). */
export const FRAME_BINS_MS = [1, 9, 17, 19, 20, 23, 25, 29, 32, 48, 64, 80, 96, 112, 224, 448, 896, 1792, 3584] as const;
/** Figma's `dropped_frames` histogram bin edges, in frames. */
export const DROPPED_BINS = [0, 1, 2, 4, 8, 16, 32, 64, 128, 256] as const;
/** The editor's `unsampledFrameTimeMs` (Figma's table A): frames this long or longer are always kept. */
export const SLOW_FRAME_MS = 50;
const SLOW_KEPT = 32;
const CONTINUOUS_MS = 250;

export interface SlowFrame {
  frame: number;
  ms: number;
  /** performance.now() when it ended */
  at: number;
}

export interface FrameReport {
  frame_count: number;
  mean_frame_ms: number;
  max_frame_ms: number;
  /** `count_<a>_to_<b>_ms` (and `count_<a>_to_inf_ms`) as Figma names its bins */
  frames: Record<string, number>;
  /** `count_0_dropped`, `count_<a>_to_<b>_dropped` */
  dropped: Record<string, number>;
  slow: SlowFrame[];
}

/** The bin a value falls in: the first edge it is under (Figma's bins are [previous edge, edge)). */
function binOf(edges: readonly number[], value: number): number {
  for (let i = 0; i < edges.length; i++) if (value < edges[i]) return i;
  return edges.length;
}

function binNames(edges: readonly number[], unit: string): string[] {
  const names: string[] = [];
  let from = 0;
  for (const edge of edges) {
    names.push(`count_${from}_to_${edge}_${unit}`);
    from = edge;
  }
  names.push(`count_${from}_to_inf_${unit}`);
  return names;
}

/** Whole frames: each bin holds up to its edge, from one past the one before (`count_0_dropped`, `count_3_to_4_dropped`…). */
function droppedBinOf(value: number): number {
  for (let i = 0; i < DROPPED_BINS.length; i++) if (value <= DROPPED_BINS[i]) return i;
  return DROPPED_BINS.length;
}

function droppedNames(): string[] {
  const names = ["count_0_dropped"];
  for (let i = 1; i < DROPPED_BINS.length; i++) names.push(`count_${DROPPED_BINS[i - 1] + 1}_to_${DROPPED_BINS[i]}_dropped`);
  names.push(`count_${DROPPED_BINS[DROPPED_BINS.length - 1] + 1}_to_inf_dropped`);
  return names;
}

const FRAME_NAMES = binNames(FRAME_BINS_MS, "ms");
const DROPPED_NAMES = droppedNames();

export class FrameTelemetry {
  private readonly frames = new Array<number>(FRAME_NAMES.length).fill(0);
  private readonly dropped = new Array<number>(DROPPED_NAMES.length).fill(0);
  private count = 0;
  private total = 0;
  private max = 0;
  private slow: SlowFrame[] = [];
  /** The shortest interval between continuous frames seen: the display's refresh interval. */
  private refreshMs = Infinity;
  private lastEnd = -1;

  /**
   * A frame drew in `ms`, ending at `end`. One that follows the last within 250 ms continues it (an animation, a
   * gesture): the time between them tells the frames the display showed without a new one; after a longer gap the
   * canvas was idle.
   */
  record(ms: number, end: number): void {
    this.count++;
    this.total += ms;
    this.max = Math.max(this.max, ms);
    this.frames[binOf(FRAME_BINS_MS, ms)]++;
    const interval = end - this.lastEnd;
    if (this.lastEnd >= 0 && interval < CONTINUOUS_MS) {
      if (interval >= 4) this.refreshMs = Math.min(this.refreshMs, interval);
      if (Number.isFinite(this.refreshMs)) this.dropped[droppedBinOf(Math.max(0, Math.round(interval / this.refreshMs) - 1))]++;
    }
    this.lastEnd = end;
    if (ms >= SLOW_FRAME_MS) {
      this.slow.push({ frame: this.count, ms: Math.round(ms * 10) / 10, at: end });
      if (this.slow.length > SLOW_KEPT) this.slow.shift();
    }
  }

  report(): FrameReport {
    const named = (names: string[], counts: number[]) => Object.fromEntries(names.map((n, i) => [n, counts[i]]));
    return {
      frame_count: this.count,
      mean_frame_ms: this.count ? Math.round((this.total / this.count) * 100) / 100 : 0,
      max_frame_ms: Math.round(this.max * 100) / 100,
      frames: named(FRAME_NAMES, this.frames),
      dropped: named(DROPPED_NAMES, this.dropped),
      slow: [...this.slow],
    };
  }

  reset(): void {
    this.frames.fill(0);
    this.dropped.fill(0);
    this.count = this.total = this.max = 0;
    this.slow = [];
    this.lastEnd = -1;
  }
}
