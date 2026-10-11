/**
 * The idle session timeout in main (docs/desktop.md §18.2; the server's side is docs/multiplayer.md §15.8). Pure
 * apart from what `IdleDeps` does — account/index.ts wires it to Electron (input events, the views, notifications)
 * and to the server; idle.test.ts drives it with a fake clock.
 *
 * - Activity (user input in any view) is posted to `POST /me/sessions/active` at most once a minute: the first input
 *   after a quiet minute at once, later ones when the warning time comes.
 * - The timer fires one minute before `activeAt + idleLimitMs`: unposted input → post and reschedule; else `GET /me`
 *   (an admin's change moves the deadline) → reschedule if it moved; else the warning, then at the deadline the
 *   session is ended on the server (best effort), the app signs out and the views are told.
 */
import type { IdleNotice } from "../../shared/ipc";

/** The prompt comes this long before the deadline (Figma: "one minute before", help.figma.com 14376092335127) */
export const IDLE_WARNING_MS = 60_000;
/** Activity reaches the server at most this often */
export const ACTIVE_POST_MS = 60_000;
/** setTimeout's longest delay (a longer wait is taken in steps) */
const MAX_DELAY = 2 ** 31 - 1;

/** `{activeAt, idleLimitMs}` — the answer of `POST /me/sessions/active`, and `GET /me`'s `session` */
export interface IdleState {
  activeAt: number;
  /** null: no limit (no timer) */
  idleLimitMs: number | null;
}

export interface IdleDeps {
  now(): number;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(timer: unknown): void;
  /** `POST /me/sessions/active`; null when not answered (offline, an error) */
  postActive(): Promise<IdleState | null>;
  /** `GET /me`'s `session`: null when it has none (no idle data), undefined when not answered */
  fetchSession(): Promise<IdleState | null | undefined>;
  /** `DELETE /me/sessions/current?reason=idle` — best effort */
  endSession(): Promise<void>;
  /** The local sign-out (account/index.ts `signOut`) */
  signOut(): void;
  /** To the views: the warning to the one in front, the rest to all */
  notify(n: IdleNotice): void;
}

export class IdleTimer {
  private state: IdleState | null = null;
  private running = false;
  private timer: unknown = null;
  private lastPostAt = Number.NEGATIVE_INFINITY;
  private inputSincePost = false;
  private posting: Promise<boolean> | null = null;
  /** The deadline while the prompt is up */
  private warningAt: number | null = null;
  /** Bumped by start / stop: an answer that arrives later is dropped */
  private generation = 0;

  constructor(private readonly deps: IdleDeps) {}

  /** Signed in (at launch or after a sign-in): the session's idle data, null when it isn't known yet */
  start(state: IdleState | null): void {
    this.generation += 1;
    this.running = true;
    this.state = state;
    this.inputSincePost = false;
    this.posting = null;
    this.dropWarning();
    this.schedule();
  }

  /** Signed out: nothing more is posted or prompted */
  stop(): void {
    this.generation += 1;
    this.running = false;
    this.state = null;
    this.posting = null;
    this.warningAt = null;
    this.clear();
  }

  /** A mouse press, key, wheel or scroll in any view */
  input(): void {
    if (!this.running) return;
    this.inputSincePost = true;
    // Any input while the prompt is up counts as staying.
    if (this.warningAt !== null || this.deps.now() - this.lastPostAt >= ACTIVE_POST_MS) void this.post();
  }

  /** Stay logged in */
  async stay(): Promise<void> {
    if (!this.running) return;
    this.inputSincePost = true;
    await this.post();
  }

  /** The computer woke up: the timers paused while it slept, the clock didn't */
  resume(): void {
    if (this.running) this.schedule();
  }

  /** For tests and the debug log */
  debug() {
    return { state: this.state, warningAt: this.warningAt, inputSincePost: this.inputSincePost, lastPostAt: this.lastPostAt, running: this.running };
  }

  private post(): Promise<boolean> {
    if (this.posting) return this.posting;
    const g = this.generation;
    this.lastPostAt = this.deps.now();
    this.inputSincePost = false;
    const p = this.deps.postActive().then(
      (r) => r,
      () => null,
    );
    this.posting = p.then((r) => {
      if (g !== this.generation) return false;
      this.posting = null;
      if (!r) {
        // Not answered: the activity is still to be told.
        this.inputSincePost = true;
        return false;
      }
      this.state = r;
      this.dropWarning();
      this.schedule();
      return true;
    });
    return this.posting;
  }

  private dropWarning() {
    if (this.warningAt === null) return;
    this.warningAt = null;
    this.deps.notify({ state: "cleared" });
  }

  private clear() {
    if (this.timer !== null) this.deps.clearTimer(this.timer);
    this.timer = null;
  }

  private at(when: number, fn: () => void) {
    this.clear();
    const delay = when - this.deps.now();
    if (delay > MAX_DELAY) {
      this.timer = this.deps.setTimer(() => this.schedule(), MAX_DELAY);
      return;
    }
    this.timer = this.deps.setTimer(() => {
      this.timer = null;
      fn();
    }, Math.max(0, delay));
  }

  private schedule() {
    this.clear();
    const s = this.state;
    if (!this.running || !s || s.idleLimitMs == null) return;
    if (this.warningAt !== null) this.at(this.warningAt, () => void this.deadline());
    else this.at(s.activeAt + s.idleLimitMs - IDLE_WARNING_MS, () => void this.warningTime());
  }

  private async warningTime() {
    const g = this.generation;
    const s = this.state;
    if (!s || s.idleLimitMs == null) return;
    // 1. Used since the last post: tell the server, which moves the deadline.
    if (this.inputSincePost) {
      if (await this.post()) return;
      if (g !== this.generation) return;
      // Offline while in use: no prompt; try again in a minute.
      return this.at(this.deps.now() + ACTIVE_POST_MS, () => void this.warningTime());
    }
    // 2. The limit may have changed (an admin's change also resets activeAt on the server).
    const fresh = await this.deps.fetchSession().catch(() => undefined);
    if (g !== this.generation || this.warningAt !== null) return;
    if (this.inputSincePost) return void this.warningTime();
    if (fresh === null || (fresh && fresh.idleLimitMs == null)) {
      this.state = fresh;
      return this.schedule();
    }
    const deadline = s.activeAt + s.idleLimitMs;
    if (fresh && fresh.idleLimitMs != null && fresh.activeAt + fresh.idleLimitMs !== deadline) {
      this.state = fresh;
      if (fresh.activeAt + fresh.idleLimitMs - IDLE_WARNING_MS > this.deps.now()) return this.schedule();
    }
    // 3. The prompt, until the deadline.
    const cur = this.state!;
    const logoutAt = cur.activeAt + (cur.idleLimitMs ?? 0);
    this.warningAt = logoutAt;
    if (this.deps.now() >= logoutAt) return void this.deadline();
    this.deps.notify({ state: "warning", logoutAt });
    this.schedule();
  }

  private async deadline() {
    const g = this.generation;
    if (this.inputSincePost) {
      // Input whose post wasn't answered (offline): someone is here — no logout.
      if (await this.post()) return;
      if (g !== this.generation) return;
      this.dropWarning();
      return this.at(this.deps.now() + ACTIVE_POST_MS, () => void this.warningTime());
    }
    this.warningAt = null;
    this.clear();
    this.running = false;
    await this.deps.endSession().catch(() => {});
    if (g !== this.generation) return;
    this.deps.signOut();
    this.deps.notify({ state: "logged-out" });
  }
}
