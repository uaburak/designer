// Agents as collaborators (docs/ai.md §2.13): the presence model without the engine — touched layers from tool calls,
// joining and leaving, the cursor and outline handed to the engine, following (throttled, animated) and what stops it.
import { describe, expect, it, vi } from "vitest";
import type { PresencePeer } from "@/engine/Engine";
import { AGENT_IDLE_MS, AgentPresence, CANVAS_BOUND, FLASH_MS, FOLLOW_EVERY_MS, MIN_ZOOM, MOVE_MS, fitCamera, keyStopsFollowing, touchedNodes, unionRects, type AgentPresenceHost, type Clock, type Rect } from "../multiplayer/agentPresence";
import { managerName, workerName } from "../agents/managerName";

/** A clock the test moves by hand: timers and frames run when it says. */
function fakeClock() {
  let now = 1000;
  let seq = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const frames = new Map<number, () => void>();
  const clock: Clock = {
    now: () => now,
    setTimeout: (fn, ms) => {
      const id = ++seq;
      timers.set(id, { at: now + ms, fn });
      return id as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimeout: (t) => void timers.delete(t as unknown as number),
    frame: (fn) => {
      const id = ++seq;
      frames.set(id, fn);
      return id;
    },
    cancelFrame: (id) => void frames.delete(id),
  };
  return {
    clock,
    /** Time passes; due timers run, and frames every 16 ms */
    advance(ms: number) {
      const end = now + ms;
      while (now < end) {
        now = Math.min(end, now + 16);
        for (const [id, t] of [...timers])
          if (t.at <= now) {
            timers.delete(id);
            t.fn();
          }
        for (const [id, f] of [...frames]) {
          frames.delete(id);
          f();
        }
      }
    },
  };
}

function fakeHost() {
  const nodes: Record<string, { page: string; rect: Rect }> = {
    "1:2": { page: "0:1", rect: { x: 100, y: 200, w: 50, h: 40 } },
    "1:3": { page: "0:1", rect: { x: 300, y: 150, w: 100, h: 100 } },
    "2:9": { page: "0:2", rect: { x: -500, y: -500, w: 2000, h: 1500 } },
  };
  let page = "0:1";
  let view = { x: 0, y: 0, zoom: 1 };
  const drawn: PresencePeer[][] = [];
  const host: AgentPresenceHost & { moves: { x: number; y: number; zoom: number }[] } = {
    moves: [],
    page: () => page,
    setPage: (p) => void (page = p),
    pageOf: (id) => nodes[id]?.page ?? null,
    pageName: (p) => (p === "0:1" ? "Page 1" : "Page 2"),
    bounds: (id) => nodes[id]?.rect ?? null,
    view: () => view,
    centerOn: (x, y, zoom) => {
      view = { x, y, zoom };
      host.moves.push(view);
    },
    viewport: () => ({ w: 1000, h: 800 }),
    draw: (peers) => void drawn.push(peers),
  };
  return {
    host,
    drawn,
    setView: (v: typeof view) => void (view = v),
    setOwnPage: (p: string) => void (page = p),
    last: () => drawn[drawn.length - 1] ?? [],
  };
}

const claude = { key: "session:s1", name: "Claude Code", kind: "client" as const };

describe("touched layers from a tool call", () => {
  it("a write's touched layers; a read's layers by its arguments; nothing for the selection or an error", () => {
    expect(touchedNodes("create_nodes", { nodes: [] }, { touched: ["1:2", "1:3", "1:2"] })).toEqual(["1:2", "1:3"]);
    expect(touchedNodes("update_nodes", { updates: [] }, { touched: ["5:6"] })).toEqual(["5:6"]);
    expect(touchedNodes("get_design_context", { nodeId: "1-2" }, { touched: undefined })).toEqual(["1:2"]);
    expect(touchedNodes("get_screenshot", { nodeIds: ["1:2", "nope", "1:3"] }, null)).toEqual(["1:2", "1:3"]);
    // A read reporting `touched` doesn't count it (only writes do): its argument does.
    expect(touchedNodes("get_metadata", { nodeId: "1:3" }, { touched: ["9:9"] })).toEqual(["1:3"]);
    // A deletion (its layers gone): its arguments.
    expect(touchedNodes("delete_nodes", { nodeIds: ["1:2"] }, {})).toEqual(["1:2"]);
    expect(touchedNodes("create_nodes", { parentId: "1:3", nodes: [] }, {})).toEqual(["1:3"]);
    expect(touchedNodes("get_selection", {}, {})).toEqual([]);
    expect(touchedNodes("update_nodes", { nodeId: "1:2" }, { isError: true, touched: ["1:2"] })).toEqual([]);
  });

  it("bounds: the union of the layers', a fit with margin never above 100% nor past the canvas's edge", () => {
    expect(unionRects([{ x: 100, y: 200, w: 50, h: 40 }, null, { x: 300, y: 150, w: 100, h: 100 }])).toEqual({ x: 100, y: 150, w: 300, h: 100 });
    expect(unionRects([null])).toBeNull();
    // Small layers: 100%, centred.
    expect(fitCamera({ x: 0, y: 0, w: 10, h: 10 }, { w: 1000, h: 800 })).toEqual({ x: 5, y: 5, zoom: 1 });
    // Large ones: zoomed out to fit with the margin.
    const big = fitCamera({ x: 0, y: 0, w: 4000, h: 1000 }, { w: 1000, h: 800 }, 50);
    expect(big.zoom).toBeCloseTo(900 / 4000);
    // Far away: the centre stays inside the canvas.
    expect(fitCamera({ x: 1e9, y: -1e9, w: 10, h: 10 }, { w: 1000, h: 800 })).toMatchObject({ x: CANVAS_BOUND, y: -CANVAS_BOUND });
    expect(fitCamera({ x: 0, y: 0, w: 1e9, h: 1e9 }, { w: 1000, h: 800 }).zoom).toBe(MIN_ZOOM);
  });
});

describe("agents in the file", () => {
  it("join with a colour each, the cursor glides to the touched layers' top-left, the outline shows for a moment", () => {
    const { clock, advance } = fakeClock();
    const h = fakeHost();
    const p = new AgentPresence(h.host, clock);
    p.start();
    const a = p.join(claude);
    const b = p.join({ key: "chat:c1", name: "Codex", kind: "chat" });
    expect(a.color).not.toBe(b.color);
    expect(a.id).not.toBe(b.id);
    expect(p.state.agents.map((x) => x.name)).toEqual(["Claude Code", "Codex"]);
    // Joining again is the same agent.
    expect(p.join(claude).id).toBe(a.id);

    p.activity(claude, "update_nodes", {}, { touched: ["1:2", "1:3"] });
    expect(p.get(claude.key)).toMatchObject({ page: "0:1", pageName: "Page 1", nodes: ["1:2", "1:3"], bounds: { x: 100, y: 150, w: 300, h: 100 } });
    advance(16);
    const first = h.last().find((x) => x.id === a.id)!;
    expect(first).toMatchObject({ name: "Claude Code", color: a.color, cursor: { x: 100, y: 150 }, selection: ["1:2", "1:3"] });
    // The next call elsewhere: the cursor glides there (not a jump), the outline moves with it.
    p.activity(claude, "get_design_context", { nodeId: "1:3" }, {});
    advance(16);
    const gliding = h.last().find((x) => x.id === a.id)!;
    expect(gliding.cursor!.x).toBeGreaterThan(100);
    expect(gliding.cursor!.x).toBeLessThan(300);
    expect(gliding.selection).toEqual(["1:3"]);
    advance(FLASH_MS + 100);
    const after = h.last().find((x) => x.id === a.id)!;
    expect(after.cursor).toEqual({ x: 300, y: 150 });
    expect(after.selection).toEqual([]);
    // Nothing of Codex is drawn: it hasn't touched anything.
    expect(h.last().some((x) => x.id === b.id)).toBe(false);
  });

  it("on another page than the owner's: not drawn, the page known (the facepile's “on <page>”)", () => {
    const { clock, advance } = fakeClock();
    const h = fakeHost();
    const p = new AgentPresence(h.host, clock);
    p.start();
    p.activity(claude, "create_nodes", {}, { touched: ["2:9"] });
    advance(16);
    expect(p.get(claude.key)).toMatchObject({ page: "0:2", pageName: "Page 2" });
    expect(h.last()).toEqual([]);
  });

  it("leaves when its turn ends (after a moment) or its connection goes; an unheard-of client after the idle time", () => {
    const { clock, advance } = fakeClock();
    const h = fakeHost();
    const p = new AgentPresence(h.host, clock);
    p.start();
    p.join({ key: "chat:c1", name: "Codex", kind: "chat" });
    p.leave("chat:c1", 2000);
    expect(p.state.agents).toHaveLength(1);
    advance(2100);
    expect(p.state.agents).toHaveLength(0);
    // Main's connections: clients bound to this file join; the ones gone leave; chats aren't touched by it.
    p.join({ key: "manager:c2", name: "Ada", kind: "manager" });
    p.syncClients([{ key: "session:s1", name: "Claude Code" }, { key: "session:s2", name: "Cursor" }]);
    expect(p.state.agents.map((x) => x.name)).toEqual(["Ada", "Claude Code", "Cursor"]);
    p.syncClients([{ key: "session:s2", name: "Cursor" }]);
    expect(p.state.agents.map((x) => x.name)).toEqual(["Ada", "Cursor"]);
    p.activity({ key: "session:x", name: "Gemini CLI", kind: "client" }, "get_selection", {}, {});
    expect(p.state.agents).toHaveLength(3);
    advance(AGENT_IDLE_MS + 100);
    expect(p.state.agents).toHaveLength(0);
  });
});

describe("following an agent", () => {
  it("goes to its page and frames its layers, animated, at most once per interval; never past 100%", () => {
    const { clock, advance } = fakeClock();
    const h = fakeHost();
    const p = new AgentPresence(h.host, clock);
    p.start();
    p.activity(claude, "create_nodes", {}, { touched: ["2:9"] });
    p.follow(claude.key);
    expect(p.state.following).toBe(claude.key);
    // Another page: straight there.
    expect(h.host.page()).toBe("0:2");
    expect(h.host.moves).toHaveLength(1);
    expect(h.host.moves[0].x).toBe(500);
    expect(h.host.moves[0].zoom).toBeLessThan(1);
    p.cameraChanged();
    expect(p.state.following).toBe(claude.key);

    // Back on the first page, following again: its next layers there glide into view, then two quick writes move the
    // view once more, after the interval.
    h.setOwnPage("0:1");
    p.activity(claude, "update_nodes", {}, { touched: ["1:2"] });
    p.follow(claude.key);
    const start = h.host.moves.length;
    advance(MOVE_MS + 50);
    const glide = h.host.moves.slice(start);
    expect(glide.length).toBeGreaterThan(5);
    expect(glide[glide.length - 1]).toEqual({ x: 125, y: 220, zoom: 1 });
    p.activity(claude, "update_nodes", {}, { touched: ["1:3"] });
    p.activity(claude, "update_nodes", {}, { touched: ["1:2", "1:3"] });
    const before = h.host.moves.length;
    advance(16);
    expect(h.host.moves.length).toBe(before);
    advance(FOLLOW_EVERY_MS + MOVE_MS);
    expect(h.host.moves[h.host.moves.length - 1]).toEqual({ x: 250, y: 200, zoom: 1 });
    // Its own moves didn't stop following.
    p.cameraChanged();
    expect(p.state.following).toBe(claude.key);
  });

  it("stops on the owner's own camera or page change, on keys (not typing in a field), and when the agent leaves", () => {
    const { clock, advance } = fakeClock();
    const h = fakeHost();
    const p = new AgentPresence(h.host, clock);
    p.start();
    p.activity(claude, "update_nodes", {}, { touched: ["1:2"] });
    p.follow(claude.key);
    advance(MOVE_MS + 50);
    h.setView({ x: 9999, y: 0, zoom: 3 });
    p.cameraChanged();
    expect(p.state.following).toBeNull();

    p.follow(claude.key);
    advance(MOVE_MS + 50);
    h.setOwnPage("0:2");
    p.pageChanged();
    expect(p.state.following).toBeNull();

    expect(keyStopsFollowing({ key: "Escape", target: { tagName: "TEXTAREA" } as unknown as EventTarget })).toBe(true);
    expect(keyStopsFollowing({ key: "a", target: { tagName: "TEXTAREA" } as unknown as EventTarget })).toBe(false);
    expect(keyStopsFollowing({ key: "a", target: { tagName: "DIV", isContentEditable: true } as unknown as EventTarget })).toBe(false);
    expect(keyStopsFollowing({ key: "Shift", target: null })).toBe(false);
    expect(keyStopsFollowing({ key: "v", target: { tagName: "CANVAS" } as unknown as EventTarget })).toBe(true);

    p.follow(claude.key);
    expect(p.state.following).toBe(claude.key);
    p.leave(claude.key);
    expect(p.state.following).toBeNull();
  });

  it("an agent that never touched a layer: following waits for its first one", () => {
    const { clock, advance } = fakeClock();
    const h = fakeHost();
    const p = new AgentPresence(h.host, clock);
    p.start();
    p.join(claude);
    p.follow(claude.key);
    expect(h.host.moves).toHaveLength(0);
    p.activity(claude, "create_nodes", {}, { touched: ["1:3"] });
    advance(MOVE_MS + 50);
    expect(h.host.moves[h.host.moves.length - 1]).toEqual({ x: 350, y: 200, zoom: 1 });
  });

  it("stop() clears what the engine draws", () => {
    const { clock } = fakeClock();
    const h = fakeHost();
    const draw = vi.spyOn(h.host, "draw");
    const p = new AgentPresence(h.host, clock);
    p.start();
    p.stop();
    expect(draw).toHaveBeenLastCalledWith([]);
  });
});

describe("the manager's name", () => {
  it("the default name shows as “Manager”; a chosen one as typed; workers numbered after it", () => {
    expect(managerName(undefined)).toBe("Manager");
    expect(managerName({ name: "Manager" })).toBe("Manager");
    expect(managerName({ name: "  " })).toBe("Manager");
    expect(managerName({ name: "Ada" })).toBe("Ada");
    expect(workerName("Ada", 2)).toBe("Ada · 2");
  });
});
