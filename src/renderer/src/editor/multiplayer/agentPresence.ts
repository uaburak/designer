/**
 * Agents as collaborators (docs/ai.md §2.13): every agent working on this file — an outside MCP client (Claude Code,
 * Codex, Cursor… by its clientInfo name), a chat of the Agents tab, Studio's manager and each of its workers — is in
 * the header's facepile with its own colour and an agent badge while its session or turn lasts. When it reads a layer
 * or writes, its cursor (with its name) glides to the top-left of the layers it touched and they are outlined in its
 * colour for a moment — the engine's multiplayer presence draws both (presenceSink.ts). Clicking its avatar follows it
 * (Figma's observation mode): its page, the layers it touches framed with a margin, at most every FOLLOW_EVERY_MS; any
 * pan, zoom, click or key of the owner's, or Esc, stops following.
 *
 * Ephemeral: nothing here is in the document, the journal or undo, and the owner's selection is never touched.
 */
import { useSyncExternalStore } from "react";
import type { PresencePeer } from "@/engine/Engine";
import type { ToolResult } from "@shared/agents/tools";
import { TOOL_BY_NAME } from "@shared/agents/tools";
import { PEER_COLORS } from "@shared/multiplayer/colors";

export type AgentKind = "client" | "chat" | "manager" | "worker";

/** Who an agent is: a stable key (its MCP session, chat or task), the name it shows and what kind it is */
export interface AgentActor {
  key: string;
  name: string;
  kind: AgentKind;
  /** A second line (a worker's task title) */
  detail?: string;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface AgentPeer extends AgentActor {
  /** The engine's id for it (well above any room session) */
  id: number;
  color: string;
  /** The page it last worked on (null: not yet) */
  page: string | null;
  pageName: string | null;
  /** The layers it last touched (on `page`) and their bounds */
  nodes: string[];
  bounds: Rect | null;
  /** When it last did something */
  lastAt: number;
}

export interface AgentPresenceState {
  agents: AgentPeer[];
  /** The agent being followed (its key), or null */
  following: string | null;
}

/** What the model needs from the editor (the engine and the canvas), so it is tested without them. */
export interface AgentPresenceHost {
  /** The owner's page */
  page(): string | null;
  setPage(page: string): void;
  pageOf(id: string): string | null;
  pageName(page: string): string | null;
  /** A layer's bounds on its page, or null (gone, or the page itself) */
  bounds(id: string): Rect | null;
  /** The view's centre (page coordinates) and zoom */
  view(): { x: number; y: number; zoom: number };
  centerOn(x: number, y: number, zoom: number): void;
  /** The visible part of the canvas (CSS px) */
  viewport(): { w: number; h: number };
  /** The agents' cursors and outlines for the engine (the owner's page only) */
  draw(peers: PresencePeer[]): void;
  /** Multiplayer cursors on (View › Multiplayer cursors) */
  cursorsOn?(): boolean;
}

/** An agent's layers stay outlined this long after it touched them */
export const FLASH_MS = 1600;
/** Its cursor goes after this long without activity (back at its next call) */
export const CURSOR_SHOWS_MS = 60_000;
/** An agent nobody ends (an outside client heard of only by its calls) leaves after this long — main's SESSION_IDLE_MS */
export const AGENT_IDLE_MS = 15 * 60_000;
/** A turn that ended stays a moment, so its last outline is seen */
export const LEAVE_AFTER_MS = 2500;
/** Following: at most one camera move this often */
export const FOLLOW_EVERY_MS = 600;
/** A camera move takes this long */
export const MOVE_MS = 450;
/** Following frames the layers with this margin (CSS px), never closer than 100% */
export const FIT_MARGIN = 64;
export const FIT_MAX_ZOOM = 1;
/** The engine's zoom range and canvas edge (engine/src/render/Camera.h: kMinZoom, kCanvasBound) */
export const MIN_ZOOM = 0.02;
export const CANVAS_BOUND = 130_000;
/** Share of the way a drawn cursor glides towards its target each frame */
const EASE = 0.18;
/** Engine ids for agents start here (room sessions are small numbers) */
const ID_BASE = 1_000_000;
/** Colours in an order that keeps the next agent's distinct from the last one's */
const AGENT_COLORS = [1, 3, 10, 7, 2, 0, 6, 11, 5, 9, 4, 8].map((i) => PEER_COLORS[i]);
const MAX_NODES = 200;

/** "123-456" (a URL's form) → "123:456" */
const norm = (id: unknown): string | null => (typeof id === "string" && /^-?\d+[:-]\d+$/.test(id.trim()) ? id.trim().replace("-", ":") : null);

/**
 * The layers a tool call touched: a write's `touched` (what it created or changed), else the layers its arguments name
 * (a read of a layer, or a write that removed them). A call naming no layer (the selection by default) touches none.
 */
export function touchedNodes(name: string, args: Record<string, unknown> | undefined, result: Pick<ToolResult, "touched" | "isError"> | null): string[] {
  if (result?.isError) return [];
  const out: string[] = [];
  const add = (v: unknown) => {
    const id = norm(v);
    if (id && !out.includes(id)) out.push(id);
  };
  const isWrite = !!TOOL_BY_NAME.get(name)?.write;
  if (isWrite && result?.touched?.length) result.touched.forEach(add);
  if (!out.length && args) {
    add(args.nodeId);
    if (Array.isArray(args.nodeIds)) args.nodeIds.forEach(add);
    if (!out.length) add(args.parentId);
  }
  return out.slice(0, MAX_NODES);
}

export function unionRects(rects: readonly (Rect | null)[]): Rect | null {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const r of rects) {
    if (!r || !Number.isFinite(r.x) || !Number.isFinite(r.y)) continue;
    x0 = Math.min(x0, r.x);
    y0 = Math.min(y0, r.y);
    x1 = Math.max(x1, r.x + Math.max(0, r.w));
    y1 = Math.max(y1, r.y + Math.max(0, r.h));
  }
  return x0 === Infinity ? null : { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** The camera framing `r` in a `viewport` (CSS px): a margin around it, never above 100% or past the canvas's edge. */
export function fitCamera(r: Rect, viewport: { w: number; h: number }, margin = FIT_MARGIN): { x: number; y: number; zoom: number } {
  const vw = Math.max(1, viewport.w - 2 * margin);
  const vh = Math.max(1, viewport.h - 2 * margin);
  const zoom = Math.max(MIN_ZOOM, Math.min(FIT_MAX_ZOOM, vw / Math.max(1, r.w), vh / Math.max(1, r.h)));
  const clamp = (v: number) => Math.max(-CANVAS_BOUND, Math.min(CANVAS_BOUND, v));
  return { x: clamp(r.x + r.w / 2), y: clamp(r.y + r.h / 2), zoom };
}

/** The camera between `a` and `b` at `t` (0…1, eased): the centre straight, the zoom geometric. */
export function lerpCamera(a: { x: number; y: number; zoom: number }, b: { x: number; y: number; zoom: number }, t: number) {
  const e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
  return { x: a.x + (b.x - a.x) * e, y: a.y + (b.y - a.y) * e, zoom: Math.exp(Math.log(a.zoom) + (Math.log(b.zoom) - Math.log(a.zoom)) * e) };
}

/**
 * Whether a key the owner pressed stops following: Esc always; any other key unless it is typed into a field (the
 * chat's composer — talking to the agent while watching it is fine), and not a bare modifier.
 */
export function keyStopsFollowing(e: { key: string; target?: EventTarget | null }): boolean {
  if (e.key === "Escape") return true;
  if (e.key === "Shift" || e.key === "Control" || e.key === "Alt" || e.key === "Meta") return false;
  const el = e.target as (HTMLElement & { isContentEditable?: boolean }) | null | undefined;
  const tag = el?.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el?.isContentEditable) return false;
  return true;
}

const sameView = (a: { x: number; y: number; zoom: number }, b: { x: number; y: number; zoom: number }) => Math.abs(a.zoom - b.zoom) <= Math.max(a.zoom, b.zoom) * 0.01 && Math.abs(a.x - b.x) * a.zoom < 2 && Math.abs(a.y - b.y) * a.zoom < 2;

type Timer = ReturnType<typeof setTimeout>;

export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): Timer;
  clearTimeout(t: Timer): void;
  frame(fn: () => void): number;
  cancelFrame(id: number): void;
}

const realClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => {
    const t = setTimeout(fn, ms);
    // Never what keeps a process (a test) alive
    (t as { unref?: () => void }).unref?.();
    return t;
  },
  clearTimeout: (t) => clearTimeout(t),
  frame: (fn) => (typeof requestAnimationFrame === "function" ? requestAnimationFrame(fn) : (setTimeout(fn, 16) as unknown as number)),
  cancelFrame: (id) => (typeof cancelAnimationFrame === "function" ? cancelAnimationFrame(id) : clearTimeout(id as unknown as Timer)),
};

const EMPTY: AgentPresenceState = { agents: [], following: null };

export class AgentPresence {
  state: AgentPresenceState = EMPTY;
  private listeners = new Set<() => void>();
  private nextId = 0;
  /** Flash ends, by agent key */
  private flashUntil = new Map<string, number>();
  /** Cursors as drawn (eased), by agent key */
  private drawn = new Map<string, { x: number; y: number }>();
  private leaving = new Map<string, Timer>();
  private idle = new Map<string, Timer>();
  private raf = 0;
  private running = false;
  // Following
  private lastMoveAt = -Infinity;
  private moveTimer: Timer | null = null;
  private anim: { from: { x: number; y: number; zoom: number }; to: { x: number; y: number; zoom: number }; start: number } | null = null;
  /** The view this model last set (a camera change that isn't it is the owner's) */
  private expected: { x: number; y: number; zoom: number } | null = null;
  private moving = false;
  private ownPage: string | null = null;

  constructor(
    private host: AgentPresenceHost,
    private clock: Clock = realClock,
  ) {}

  subscribe = (l: () => void): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };

  private set(patch: Partial<AgentPresenceState>): void {
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l();
  }

  get(key: string): AgentPeer | undefined {
    return this.state.agents.find((a) => a.key === key);
  }

  /** An agent is working on the file (a turn started, a client's session bound to it): in the facepile. */
  join(actor: AgentActor): AgentPeer {
    const t = this.leaving.get(actor.key);
    if (t) this.clock.clearTimeout(t);
    this.leaving.delete(actor.key);
    this.touchIdle(actor.key);
    const was = this.get(actor.key);
    if (was) {
      if (was.name !== actor.name || was.detail !== actor.detail || was.kind !== actor.kind) this.patch(actor.key, { name: actor.name, detail: actor.detail, kind: actor.kind });
      return this.get(actor.key)!;
    }
    const n = this.nextId++;
    const peer: AgentPeer = { ...actor, id: ID_BASE + n, color: AGENT_COLORS[n % AGENT_COLORS.length], page: null, pageName: null, nodes: [], bounds: null, lastAt: this.clock.now() };
    this.set({ agents: [...this.state.agents, peer] });
    this.wake();
    return peer;
  }

  /** The agent's session or turn ended: it goes (after `delay`, so its last outline is seen). */
  leave(key: string, delay = 0): void {
    if (!this.get(key)) return;
    const go = () => {
      this.leaving.delete(key);
      const t = this.idle.get(key);
      if (t) this.clock.clearTimeout(t);
      this.idle.delete(key);
      this.flashUntil.delete(key);
      this.drawn.delete(key);
      this.set({ agents: this.state.agents.filter((a) => a.key !== key), following: this.state.following === key ? null : this.state.following });
      if (this.state.following === null) this.endFollow();
      this.wake();
    };
    const old = this.leaving.get(key);
    if (old) this.clock.clearTimeout(old);
    if (delay <= 0) return go();
    this.leaving.set(key, this.clock.setTimeout(go, delay));
  }

  /**
   * The outside clients bound to this file, as main reports its MCP connections: new ones join, the ones gone leave
   * (the Agents tab's own sessions are its turns, joined and left by the service).
   */
  syncClients(clients: readonly { key: string; name: string }[]): void {
    for (const c of clients) this.join({ key: c.key, name: c.name, kind: "client" });
    for (const a of this.state.agents) if (a.kind === "client" && !clients.some((c) => c.key === a.key)) this.leave(a.key);
  }

  /** A tool call finished: the agent's cursor and outline go to the layers it touched (and the view, when followed). */
  activity(actor: AgentActor, tool: string, args: Record<string, unknown> | undefined, result: Pick<ToolResult, "touched" | "isError"> | null): void {
    this.join(actor);
    const ids = touchedNodes(tool, args, result);
    const now = this.clock.now();
    if (!ids.length) {
      this.patch(actor.key, { lastAt: now });
      return;
    }
    // The page of the first layer still there; the layers on it with bounds.
    let page: string | null = null;
    for (const id of ids) if ((page = this.host.pageOf(id))) break;
    if (!page) {
      this.patch(actor.key, { lastAt: now });
      return;
    }
    const nodes = ids.filter((id) => this.host.pageOf(id) === page);
    const bounds = unionRects(nodes.map((id) => this.host.bounds(id)));
    this.patch(actor.key, { page, pageName: this.host.pageName(page), nodes, bounds: bounds ?? this.get(actor.key)?.bounds ?? null, lastAt: now });
    this.flashUntil.set(actor.key, now + FLASH_MS);
    this.wake();
    if (this.state.following === actor.key) this.scheduleMove();
  }

  // ---- Following ----

  /** Observation mode on this agent: its page and its latest layers framed, then every next one. */
  follow(key: string): void {
    if (!this.get(key)) return;
    this.endFollow();
    this.set({ following: key });
    this.lastMoveAt = -Infinity;
    this.scheduleMove();
  }

  stopFollowing(): void {
    if (this.state.following === null) return;
    this.set({ following: null });
    this.endFollow();
  }

  /** The camera moved: the owner's own move (anything this model didn't set) stops following. */
  cameraChanged(): void {
    if (this.state.following === null || this.moving) return;
    const view = this.host.view();
    if (this.expected && sameView(view, this.expected)) return;
    this.stopFollowing();
  }

  /** The owner's page changed: unless it was this model, following stops. */
  pageChanged(): void {
    if (this.state.following === null || this.moving) return;
    if (this.host.page() === this.ownPage) return;
    this.stopFollowing();
  }

  private endFollow(): void {
    if (this.moveTimer) this.clock.clearTimeout(this.moveTimer);
    this.moveTimer = null;
    this.anim = null;
    this.expected = null;
    this.ownPage = null;
  }

  /** At most one move every FOLLOW_EVERY_MS: now, or once the wait is over (to wherever the agent is by then). */
  private scheduleMove(): void {
    if (this.moveTimer) return;
    const wait = this.lastMoveAt + FOLLOW_EVERY_MS - this.clock.now();
    if (wait <= 0) return this.moveNow();
    this.moveTimer = this.clock.setTimeout(() => {
      this.moveTimer = null;
      this.moveNow();
    }, wait);
  }

  private moveNow(): void {
    const a = this.state.following !== null ? this.get(this.state.following) : undefined;
    if (!a?.page || !a.bounds) return;
    this.lastMoveAt = this.clock.now();
    const target = fitCamera(a.bounds, this.host.viewport());
    this.moving = true;
    try {
      if (this.host.page() !== a.page) {
        this.ownPage = a.page;
        this.host.setPage(a.page);
        // Another page: straight there (Figma jumps with the person), no glide across pages.
        this.host.centerOn(target.x, target.y, target.zoom);
        this.expected = this.host.view();
        this.anim = null;
        return;
      }
      this.ownPage = a.page;
      this.anim = { from: this.host.view(), to: target, start: this.clock.now() };
    } finally {
      this.moving = false;
    }
    this.wake();
  }

  private stepCamera(now: number): void {
    const anim = this.anim;
    if (!anim) return;
    const t = Math.min(1, (now - anim.start) / MOVE_MS);
    const v = lerpCamera(anim.from, anim.to, t);
    this.moving = true;
    try {
      this.host.centerOn(v.x, v.y, v.zoom);
      this.expected = this.host.view();
    } finally {
      this.moving = false;
    }
    if (t >= 1) this.anim = null;
  }

  // ---- Drawing ----

  start(): void {
    this.running = true;
    this.wake();
  }

  stop(): void {
    this.running = false;
    if (this.raf) this.clock.cancelFrame(this.raf);
    this.raf = 0;
    this.endFollow();
    for (const t of [...this.leaving.values(), ...this.idle.values()]) this.clock.clearTimeout(t);
    this.leaving.clear();
    this.idle.clear();
    this.host.draw([]);
  }

  /** Draws now and keeps drawing while something moves (a cursor gliding, an outline on, the camera). */
  private wake(): void {
    if (!this.running || this.raf) return;
    this.raf = this.clock.frame(() => {
      this.raf = 0;
      if (!this.running) return;
      if (this.frame()) this.wake();
    });
  }

  /** One frame: true while something still moves. */
  frame(now = this.clock.now()): boolean {
    this.stepCamera(now);
    const page = this.host.page();
    const cursors = this.host.cursorsOn?.() !== false;
    const out: PresencePeer[] = [];
    let busy = !!this.anim;
    for (const a of this.state.agents) {
      if (!a.page || a.page !== page) {
        this.drawn.delete(a.key);
        continue;
      }
      const flashing = (this.flashUntil.get(a.key) ?? 0) > now;
      if (flashing) busy = true;
      else this.flashUntil.delete(a.key);
      let cursor: { x: number; y: number } | null = null;
      if (a.bounds && now - a.lastAt < CURSOR_SHOWS_MS) {
        const to = { x: a.bounds.x, y: a.bounds.y };
        const d = this.drawn.get(a.key);
        const next = d ? { x: d.x + (to.x - d.x) * EASE, y: d.y + (to.y - d.y) * EASE } : to;
        if (Math.abs(next.x - to.x) < 0.05 && Math.abs(next.y - to.y) < 0.05) Object.assign(next, to);
        else busy = true;
        this.drawn.set(a.key, next);
        cursor = next;
      } else this.drawn.delete(a.key);
      if (!cursor && !flashing) continue;
      out.push({ id: a.id, name: a.name, color: a.color, cursor: cursors ? cursor : null, selection: flashing ? a.nodes : [] });
    }
    this.host.draw(out);
    return busy;
  }

  private patch(key: string, patch: Partial<AgentPeer>): void {
    this.set({ agents: this.state.agents.map((a) => (a.key === key ? { ...a, ...patch } : a)) });
  }

  /** An agent heard of only by its calls goes after AGENT_IDLE_MS without one; its cursor after CURSOR_SHOWS_MS. */
  private touchIdle(key: string): void {
    const old = this.idle.get(key);
    if (old) this.clock.clearTimeout(old);
    this.idle.set(
      key,
      this.clock.setTimeout(() => {
        this.idle.delete(key);
        this.leave(key);
      }, AGENT_IDLE_MS),
    );
    this.clock.setTimeout(() => this.wake(), CURSOR_SHOWS_MS + 50);
  }
}

// ---------------------------------------------------------------------------------------------------------------------

const EMPTY_SUB = () => () => {};

/** The editor's agent presence, by whatever holds it (agentsHost.ts makes it for an EditorController). */
export function useAgentPresence(p: AgentPresence | null): AgentPresenceState {
  return useSyncExternalStore(p ? p.subscribe : EMPTY_SUB, () => p?.state ?? EMPTY);
}
