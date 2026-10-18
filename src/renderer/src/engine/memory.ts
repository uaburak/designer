/**
 * The file's memory, as Figma counts it (docs/research/atlas/20-rendering.md §9): the engine's WebAssembly heap in
 * use (engine_heap_used) as a percentage of the heap limit of the mode the file is open in — 2 GiB normally, 4 GiB
 * (less 64 KiB) in recovery mode. Polled every 5 s; at 90 % the engine drops its caches once (Figma's high-memory
 * optimisations) and the warning shows; at 100 %, or when the engine ran out of memory, the out-of-memory dialog.
 * The heap limit is an accounting cap inside the module's 4 GiB address space (MAXIMUM_MEMORY), as Figma's is.
 */

/** Figma's HeapMemoryMode (figma_app @7 164 773). */
export enum HeapMemoryMode {
  LEGACY = 0,
  DEFAULT = 1,
  MERGE_MODAL = 2,
  LOAD_ALL_PAGES = 3,
  RECOVERY = 4,
  MAXIMUM = 5,
}

const GiB = 1024 ** 3;

/** Each mode's heap limit in bytes (getHeapMemoryLimit, wasm @0x2c53567). */
export const HEAP_LIMITS: Readonly<Record<HeapMemoryMode, number>> = {
  [HeapMemoryMode.LEGACY]: 2 * GiB,
  [HeapMemoryMode.DEFAULT]: 2 * GiB,
  [HeapMemoryMode.MERGE_MODAL]: 3 * GiB,
  [HeapMemoryMode.LOAD_ALL_PAGES]: 3 * GiB,
  [HeapMemoryMode.RECOVERY]: 4 * GiB - 64 * 1024,
  [HeapMemoryMode.MAXIMUM]: 4 * GiB - 64 * 1024,
};

/** Figma's memory warning levels (setMemoryWarningLevel). */
export enum MemoryWarningLevel {
  SAFE = 0,
  ERROR = 1,
  OOM = 2,
}

export const MEMORY_POLL_MS = 5000;
/** The warning threshold, in percent. */
export const HIGH_MEMORY_PERCENT = 90;
/** In recovery mode under this, the card offers to leave it. */
export const EXIT_RECOVERY_PERCENT = 45;

/** The mode the page's URL asks for: `?recovery=true` (Figma's recovery-mode reload), `?wasm-4gb=1`, else DEFAULT. */
export function heapModeOf(search: string): HeapMemoryMode {
  const params = new URLSearchParams(search);
  if (params.get("recovery") === "true") return HeapMemoryMode.RECOVERY;
  if (params.get("wasm-4gb") === "1") return HeapMemoryMode.MAXIMUM;
  return HeapMemoryMode.DEFAULT;
}

/** The page's URL with recovery mode on or off (the reload the out-of-memory dialog and the card offer). */
export function recoveryUrl(href: string, on: boolean): string {
  const url = new URL(href);
  if (on) url.searchParams.set("recovery", "true");
  else url.searchParams.delete("recovery");
  return url.toString();
}

/** used / limit × 100, clamped to 0–100, rounded to two decimals (Figma's file memory percentage). */
export function memoryPercent(used: number, limit: number): number {
  if (!(limit > 0)) return 0;
  return Math.round(Math.min(100, Math.max(0, (used / limit) * 100)) * 100) / 100;
}

export interface MemoryState {
  mode: HeapMemoryMode;
  limit: number;
  used: number;
  percent: number;
  level: MemoryWarningLevel;
  /** Back under 90 % after a warning (the card's "You're good to go"). */
  recovered: boolean;
}

export interface MemorySource {
  /** The engine's heap in use, in bytes; null once the engine is gone. */
  used(): number | null;
  /** The high-memory optimisations (the engine drops its caches). */
  purge(): void;
}

/**
 * Figma's threshold machine (module 345296): under 90 % the state is 0; crossing 90 % runs the high-memory
 * optimisations once (state 1) and then warns (state 2, level ERROR) until it is under 90 % again. OOM is the
 * out-of-memory dialog: at 100 % or when the engine ran out (`outOfMemory`), and it stays.
 */
export class MemoryMonitor {
  private threshold = 0;
  private oom = false;
  private warned = false;
  private timer = 0;
  private readonly listeners = new Set<(state: MemoryState) => void>();
  state: MemoryState;

  constructor(
    private readonly source: MemorySource,
    readonly mode: HeapMemoryMode = HeapMemoryMode.DEFAULT
  ) {
    const limit = HEAP_LIMITS[mode];
    this.state = { mode, limit, used: 0, percent: 0, level: MemoryWarningLevel.SAFE, recovered: false };
  }

  /** Polls every 5 s from now on (and once at once); returns the stop. */
  start(setInterval = globalThis.setInterval, clearInterval = globalThis.clearInterval): () => void {
    this.poll();
    this.timer = setInterval(() => this.poll(), MEMORY_POLL_MS) as unknown as number;
    return () => clearInterval(this.timer);
  }

  /** Called with the state now and at each change; returns the unsubscribe. */
  subscribe(listener: (state: MemoryState) => void): () => void {
    listener(this.state);
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** The engine ran out of memory (its module aborted): the out-of-memory dialog. */
  outOfMemory(): void {
    this.oom = true;
    this.update(this.state.used);
  }

  poll(): void {
    const used = this.source.used();
    if (used === null) return;
    const percent = memoryPercent(used, this.state.limit);
    if (percent >= HIGH_MEMORY_PERCENT) {
      if (this.threshold === 0) {
        this.threshold = 1;
        this.source.purge();
      }
      this.threshold = 2;
      this.warned = true;
    } else {
      this.threshold = 0;
    }
    if (percent >= 100) this.oom = true;
    this.update(used);
  }

  private update(used: number): void {
    const percent = memoryPercent(used, this.state.limit);
    const level = this.oom ? MemoryWarningLevel.OOM : this.threshold === 2 ? MemoryWarningLevel.ERROR : MemoryWarningLevel.SAFE;
    const recovered = level === MemoryWarningLevel.SAFE && this.warned;
    const s = this.state;
    if (s.used === used && s.percent === percent && s.level === level && s.recovered === recovered) return;
    this.state = { ...s, used, percent, level, recovered };
    for (const listener of [...this.listeners]) listener(this.state);
  }
}

/**
 * True when the engine's abort was running out of memory: Emscripten's messages for a failed allocation, or a bare
 * abort (a failed `new` without exceptions) with the module's memory near its 4 GiB maximum.
 */
export function isOutOfMemory(what: unknown, memoryBytes: number): boolean {
  return /out of memory|OOM|Cannot enlarge memory|bad_alloc/i.test(String(what)) || memoryBytes > 3.5 * GiB;
}
