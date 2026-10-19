/**
 * The editor's playback clock (docs/motion.md §3.7, §6.2): requestAnimationFrame-driven, t advances by wall time × 1;
 * at the duration ONCE stops, LOOP wraps, Ping-pong reverses; pausing keeps the playhead. The engine evaluates at the
 * time it is given (`onTime`), once per frame. The frame source and the clock are injectable (tests). While audio
 * plays, the AudioContext's clock is the master (`master`, round 8e): the frames still come from rAF, their time from it.
 */
import type { Micros, PlaybackName } from "@shared/motion/types";

export interface ClockOptions {
  durationUs: Micros;
  playback: PlaybackName;
  /** Called with the new playhead on every frame (and once with the end when ONCE stops) */
  onTime: (timeUs: Micros) => void;
  /** ONCE reached its end: the clock stopped itself */
  onEnd?: () => void;
  raf?: (cb: (nowMs: number) => void) => number;
  caf?: (handle: number) => void;
  now?: () => number;
  /** A master clock in ms (the AudioContext's while audio plays), or null: rAF's time then */
  master?: () => number | null;
}

export class Clock {
  private handle = 0;
  private lastMs = 0;
  private timeUs = 0;
  private direction = 1;
  private running = false;
  private readonly raf: (cb: (nowMs: number) => void) => number;
  private readonly caf: (handle: number) => void;
  private readonly now: () => number;
  private readonly master?: () => number | null;
  /** The last time came from the master clock (a switch starts the frame interval afresh) */
  private onMaster = false;
  durationUs: Micros;
  playback: PlaybackName;
  private readonly onTime: (timeUs: Micros) => void;
  private readonly onEnd?: () => void;

  constructor(o: ClockOptions) {
    this.durationUs = Math.max(1, o.durationUs);
    this.playback = o.playback;
    this.onTime = o.onTime;
    this.onEnd = o.onEnd;
    this.raf = o.raf ?? ((cb) => requestAnimationFrame(cb));
    this.caf = o.caf ?? ((h) => cancelAnimationFrame(h));
    this.now = o.now ?? (() => performance.now());
    this.master = o.master;
  }

  get playing(): boolean {
    return this.running;
  }
  get time(): Micros {
    return this.timeUs;
  }

  /** Starts from `fromUs` (a ONCE clock at its end starts over). */
  play(fromUs: Micros): void {
    this.timeUs = Math.max(0, fromUs);
    if (this.playback === "ONCE" && this.timeUs >= this.durationUs) this.timeUs = 0;
    this.direction = 1;
    this.lastMs = this.nowMs();
    if (this.running) return;
    this.running = true;
    this.schedule();
  }

  pause(): void {
    if (!this.running) return;
    this.running = false;
    this.caf(this.handle);
    this.handle = 0;
  }

  /** The playhead moved by hand (a scrub, a typed time): the clock continues from there. */
  seek(timeUs: Micros): void {
    this.timeUs = Math.max(0, timeUs);
    this.lastMs = this.nowMs();
  }

  /** The timeline's duration or playback changed under the clock. */
  configure(durationUs: Micros, playback: PlaybackName): void {
    this.durationUs = Math.max(1, durationUs);
    this.playback = playback;
  }

  /** One frame at `nowMs` (what the frame source calls): the new playhead, or the end of a ONCE run. */
  tick(frameMs: number): void {
    if (!this.running) return;
    const m = this.master?.() ?? null;
    const nowMs = m ?? frameMs;
    if ((m !== null) !== this.onMaster) {
      // The master clock started or stopped: this frame starts the interval afresh.
      this.onMaster = m !== null;
      this.lastMs = nowMs;
    }
    const dtUs = Math.max(0, nowMs - this.lastMs) * 1000;
    this.lastMs = nowMs;
    let t = this.timeUs + this.direction * dtUs;
    const d = this.durationUs;
    switch (this.playback) {
      case "ONCE":
        if (t >= d) {
          this.timeUs = d;
          this.running = false;
          this.handle = 0;
          this.onTime(this.timeUs);
          this.onEnd?.();
          return;
        }
        break;
      case "LOOP":
        t = ((t % d) + d) % d;
        break;
      case "PING_PONG":
        while (t > d || t < 0) {
          if (t > d) {
            t = 2 * d - t;
            this.direction = -1;
          } else {
            t = -t;
            this.direction = 1;
          }
        }
        break;
    }
    this.timeUs = Math.round(t);
    this.onTime(this.timeUs);
    this.schedule();
  }

  private nowMs(): number {
    const m = this.master?.() ?? null;
    this.onMaster = m !== null;
    return m ?? this.now();
  }

  private schedule(): void {
    this.handle = this.raf((nowMs) => this.tick(nowMs));
  }
}
