import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IdleNotice } from "../../shared/ipc";
import { loadWorld, type World } from "./testWorld";
import { ACTIVE_POST_MS, IDLE_WARNING_MS, IdleTimer, type IdleDeps, type IdleState } from "./idle";

/** The idle timeout in main (docs/desktop.md §18.2) on a fake clock. */

const MIN = 60_000;
const HOUR = 60 * MIN;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  vi.setSystemTime(new Date("2026-10-11T09:00:00Z"));
});
afterEach(() => vi.useRealTimers());

/** A fake server: activity moves activeAt; the limit can change; calls are counted */
function fakeDeps(limit: number | null = HOUR) {
  const server = { activeAt: Date.now(), limit, online: true, ended: 0 };
  const calls: string[] = [];
  const notices: IdleNotice[] = [];
  let signedOut = 0;
  const deps: IdleDeps = {
    now: () => Date.now(),
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
    postActive: async () => {
      calls.push("post");
      if (!server.online) return null;
      server.activeAt = Date.now();
      return { activeAt: server.activeAt, idleLimitMs: server.limit };
    },
    fetchSession: async () => {
      calls.push("me");
      if (!server.online) return undefined;
      return { activeAt: server.activeAt, idleLimitMs: server.limit };
    },
    endSession: async () => {
      calls.push("end");
      server.ended += 1;
    },
    signOut: () => void (signedOut += 1),
    notify: (n) => void notices.push(n),
  };
  const timer = new IdleTimer(deps);
  const state = (): IdleState => ({ activeAt: server.activeAt, idleLimitMs: server.limit });
  return { server, calls, notices, timer, state, signedOut: () => signedOut };
}

/** Timers run, then the handler's own async work (crypto, not microtasks) settles */
const advance = async (ms: number) => {
  await vi.advanceTimersByTimeAsync(ms);
  for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r));
};

describe("IdleTimer", () => {
  it("posts activity at most once a minute: the first input after a quiet minute at once", async () => {
    const f = fakeDeps();
    f.timer.start(f.state());
    f.timer.input();
    await advance(0);
    expect(f.calls).toEqual(["post"]);
    for (let i = 0; i < 20; i++) {
      await advance(2000);
      f.timer.input();
    }
    await advance(0);
    expect(f.calls).toEqual(["post"]); // 40 s of input: still one post
    await advance(ACTIVE_POST_MS);
    f.timer.input();
    await advance(0);
    expect(f.calls).toEqual(["post", "post"]);
  });

  it("prompts one minute before the deadline, then logs out at it", async () => {
    const f = fakeDeps();
    const start = Date.now();
    f.timer.start(f.state());
    await advance(HOUR - IDLE_WARNING_MS - 1);
    expect(f.notices).toEqual([]);
    await advance(1);
    // Nothing unposted: GET /me first (the limit may have changed), then the prompt.
    expect(f.calls).toEqual(["me"]);
    expect(f.notices).toEqual([{ state: "warning", logoutAt: start + HOUR }]);
    await advance(IDLE_WARNING_MS - 1);
    expect(f.signedOut()).toBe(0);
    await advance(1);
    expect(f.calls).toEqual(["me", "end"]);
    expect(f.server.ended).toBe(1);
    expect(f.signedOut()).toBe(1);
    expect(f.notices.at(-1)).toEqual({ state: "logged-out" });
    // Nothing more after the logout.
    f.timer.input();
    await advance(10 * HOUR);
    expect(f.calls).toEqual(["me", "end"]);
  });

  it("input since the last post: posted at the warning time instead of a prompt", async () => {
    const f = fakeDeps();
    f.timer.start(f.state());
    f.timer.input(); // posted at once
    await advance(30_000);
    f.timer.input(); // within the minute: held back
    await advance(HOUR - IDLE_WARNING_MS - 30_000);
    expect(f.calls).toEqual(["post", "post"]);
    expect(f.notices).toEqual([]);
    // The deadline moved to the second post's time + the limit.
    await advance(HOUR - IDLE_WARNING_MS);
    expect(f.notices).toEqual([{ state: "warning", logoutAt: f.server.activeAt + HOUR }]);
  });

  it("Stay logged in posts, clears the prompt and reschedules", async () => {
    const f = fakeDeps();
    f.timer.start(f.state());
    await advance(HOUR - IDLE_WARNING_MS);
    expect(f.notices).toHaveLength(1);
    await advance(30_000);
    await f.timer.stay();
    expect(f.notices.at(-1)).toEqual({ state: "cleared" });
    expect(f.server.activeAt).toBe(Date.now());
    await advance(HOUR - IDLE_WARNING_MS - 1);
    expect(f.signedOut()).toBe(0);
    expect(f.notices).toHaveLength(2);
    await advance(1);
    expect(f.notices.at(-1)).toMatchObject({ state: "warning" });
  });

  it("any input while the prompt is up counts as staying", async () => {
    const f = fakeDeps();
    f.timer.start(f.state());
    await advance(HOUR - IDLE_WARNING_MS);
    f.timer.input();
    await advance(0);
    expect(f.calls).toEqual(["me", "post"]);
    expect(f.notices).toEqual([expect.objectContaining({ state: "warning" }), { state: "cleared" }]);
    await advance(IDLE_WARNING_MS);
    expect(f.signedOut()).toBe(0);
  });

  it("a changed limit (an admin's change, GET /me) moves the warning", async () => {
    const f = fakeDeps();
    f.timer.start(f.state());
    // The admin raises the limit to 12 h; the server resets activeAt (multiplayer.md §15.8).
    await advance(30 * MIN);
    f.server.limit = 12 * HOUR;
    f.server.activeAt = Date.now();
    const reset = Date.now();
    await advance(30 * MIN - IDLE_WARNING_MS);
    expect(f.calls).toEqual(["me"]);
    expect(f.notices).toEqual([]);
    await advance(12 * HOUR - 30 * MIN);
    expect(f.notices).toEqual([{ state: "warning", logoutAt: reset + 12 * HOUR }]);
  });

  it("a limit removed (GET /me says null): no timer", async () => {
    const f = fakeDeps();
    f.timer.start(f.state());
    f.server.limit = null;
    await advance(HOUR);
    expect(f.calls).toEqual(["me"]);
    await advance(100 * HOUR);
    expect(f.notices).toEqual([]);
    expect(f.calls).toEqual(["me"]);
  });

  it("no limit: no timer, no prompt; activity is still posted", async () => {
    const f = fakeDeps(null);
    f.timer.start(f.state());
    f.timer.input();
    await advance(1000 * HOUR);
    expect(f.notices).toEqual([]);
    expect(f.calls).toEqual(["post"]);
  });

  it("limits past setTimeout's range (21 days and more) are waited for in steps", async () => {
    const f = fakeDeps(30 * 24 * HOUR);
    const start = Date.now();
    f.timer.start(f.state());
    await advance(30 * 24 * HOUR - IDLE_WARNING_MS - 1);
    expect(f.notices).toEqual([]);
    await advance(1);
    expect(f.notices).toEqual([{ state: "warning", logoutAt: start + 30 * 24 * HOUR }]);
  });

  it("offline while in use: no prompt and no logout; the activity is posted when it can be", async () => {
    const f = fakeDeps();
    f.timer.start(f.state());
    f.server.online = false;
    await advance(10 * MIN);
    f.timer.input(); // not answered
    await advance(HOUR);
    expect(f.notices).toEqual([]);
    expect(f.signedOut()).toBe(0);
    f.server.online = true;
    await advance(ACTIVE_POST_MS);
    expect(f.calls.at(-1)).toBe("post");
    expect(f.server.activeAt).toBe(Date.now());
  });

  it("a computer that slept past the deadline logs out at once when it wakes", async () => {
    const f = fakeDeps();
    f.timer.start(f.state());
    // The clock jumps (the timers didn't run while asleep).
    vi.setSystemTime(Date.now() + 2 * HOUR);
    f.timer.resume();
    await advance(0);
    expect(f.signedOut()).toBe(1);
    expect(f.notices).toEqual([{ state: "logged-out" }]);
  });

  it("stop (signed out) drops the timer and answers still in flight", async () => {
    const f = fakeDeps();
    f.timer.start(f.state());
    f.timer.input();
    f.timer.stop();
    await advance(10 * HOUR);
    expect(f.notices).toEqual([]);
    expect(f.timer.debug().running).toBe(false);
  });
});

describe("IdleTimer against the Worker's handler (multiplayer.md §15.8)", () => {
  let w: World;
  beforeEach(async () => {
    vi.useRealTimers();
    w = await loadWorld();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    vi.setSystemTime(new Date("2026-10-11T09:00:00Z"));
    w.deps.now = () => Date.now();
  });

  function wired(token: string) {
    const notices: IdleNotice[] = [];
    let signedOut = 0;
    const session = (b: { activeAt?: number; idleLimitMs?: number | null } | null) => (b && typeof b.activeAt === "number" ? { activeAt: b.activeAt, idleLimitMs: b.idleLimitMs ?? null } : null);
    const timer = new IdleTimer({
      now: () => Date.now(),
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
      postActive: async () => {
        const r = await w.call("POST", "/me/sessions/active", { token });
        return r.status === 200 ? session(r.body) : null;
      },
      fetchSession: async () => {
        const r = await w.call("GET", "/me", { token });
        return r.status === 200 ? session(r.body.session) : undefined;
      },
      endSession: async () => void (await w.call("DELETE", "/me/sessions/current?reason=idle", { token })),
      signOut: () => void (signedOut += 1),
      notify: (n) => void notices.push(n),
    });
    return { timer, notices, signedOut: () => signedOut };
  }

  it("stay, then a logout at the deadline that the server records; the session is refused after", async () => {
    await w.settings({ idleSessionTimeoutHours: 12 });
    const me = await w.call("GET", "/me", { token: w.admin.token });
    expect(me.body.session.idleLimitMs).toBe(12 * HOUR);
    const { timer, notices, signedOut } = wired(w.admin.token);
    timer.start({ activeAt: me.body.session.activeAt, idleLimitMs: me.body.session.idleLimitMs });

    await advance(12 * HOUR - IDLE_WARNING_MS);
    expect(notices).toEqual([{ state: "warning", logoutAt: me.body.session.activeAt + 12 * HOUR }]);
    await timer.stay();
    expect(notices.at(-1)).toEqual({ state: "cleared" });
    const after = await w.call("GET", "/me", { token: w.admin.token });
    expect(after.body.session.activeAt).toBe(Date.now());

    await advance(12 * HOUR);
    expect(signedOut()).toBe(1);
    expect(notices.at(-1)).toEqual({ state: "logged-out" });
    expect((await w.call("GET", "/me", { token: w.admin.token })).status).toBe(401);
    const logged = await w.rows<{ details: string }>(`SELECT details FROM activity_log WHERE action = 'user_idle_session_timeout'`);
    expect(logged.map((r) => JSON.parse(r.details))).toEqual([{ logged_on: "client" }]);
  });

  it("a changed setting reaches the timer through GET /me", async () => {
    await w.settings({ idleSessionTimeoutHours: 12 });
    const me = await w.call("GET", "/me", { token: w.admin.token });
    const { timer, notices } = wired(w.admin.token);
    timer.start({ activeAt: me.body.session.activeAt, idleLimitMs: me.body.session.idleLimitMs });
    await advance(6 * HOUR);
    await w.settings({ idleSessionTimeoutHours: 24 });
    const reset = Date.now();
    await advance(6 * HOUR - IDLE_WARNING_MS);
    expect(notices).toEqual([]);
    await advance(18 * HOUR - 1);
    expect(notices).toEqual([]);
    await advance(1);
    expect(notices).toEqual([{ state: "warning", logoutAt: reset + 24 * HOUR }]);
  });
});
