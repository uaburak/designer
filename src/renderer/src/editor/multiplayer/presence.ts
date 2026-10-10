/**
 * Presence in a shared file (docs/multiplayer.md §6), Figma's multiplayer: everyone's cursor with their name, their
 * selections in their colour, avatars in the header; clicking an avatar follows that person (observation mode: their
 * page and view, until you touch the canvas), "Spotlight me" makes everyone follow you.
 *
 * Out: this editor's cursor (page coordinates), page, selection and view, sent through the store at most every 100 ms and
 * only when something changed. In: the store's `multiplayer` events carry the peers and their presence; cursors are
 * eased towards their last position every animation frame and handed to the engine, which draws them (setPresence).
 */
import { useSyncExternalStore } from "react";
import { getStoreClient } from "@/store";
import { peerColor } from "@shared/multiplayer/colors";
import type { PeerInfo, Role } from "@shared/multiplayer/protocol";
import type { FileShareState, PresenceData } from "@shared/multiplayer/types";
import type { EditorController } from "../controller";

/** What the engine offers for presence (docs/engine.md "Presence"); absent on an engine built before it */
interface PresenceEngine {
  setPresence?(peers: { id: number; name: string; color: string; cursor: { x: number; y: number } | null; selection: string[]; chat?: string | null }[]): void;
  setLocalChat?(text: string | null, at: { x: number; y: number } | null): void;
  screenToWorld?(x: number, y: number): { x: number; y: number };
  centerOn?(x: number, y: number, zoom: number): void;
  viewCenter?(): { x: number; y: number; zoom: number };
}

export interface Peer {
  id: number;
  userId: string;
  name: string;
  role: Role;
  color: string;
  presence: PresenceData | null;
}

export interface PresenceState {
  shared: boolean;
  role: Role | null;
  connection: FileShareState["connection"];
  peers: Peer[];
  /** The peer this editor follows (observation mode), or null */
  following: number | null;
  /** This editor asked everyone to follow it */
  spotlighting: boolean;
  /** This copy was replaced by a fresh one (it fell behind the room's history) */
  replacedBy: string | null;
  /** "Ask to edit" requests waiting (editors): a badge on Share */
  requests: number;
  /** Someone started spotlighting: followed in a few seconds unless "Not now" (R13 §1) */
  spotlightOffer: number | null;
}

const SEND_EVERY_MS = 100;
/** A spotlight is followed after this long unless declined (Figma: "a few seconds"; unverified) */
const SPOTLIGHT_WAIT_MS = 3000;
/** Share of the way a drawn cursor moves towards its target each frame (≈ 60 fps): smooth at 10 updates a second */
const EASE = 0.3;

const EMPTY: PresenceState = { shared: false, role: null, connection: "offline", peers: [], following: null, spotlighting: false, replacedBy: null, requests: 0, spotlightOffer: null };

export class Presence {
  state: PresenceState = EMPTY;
  private listeners = new Set<() => void>();
  private offs: (() => void)[] = [];
  private cursor: { x: number; y: number } | null = null;
  private lastSent = "";
  private sendTimer: ReturnType<typeof setTimeout> | null = null;
  private lastSendAt = 0;
  private drawn = new Map<number, { x: number; y: number }>();
  private raf = 0;
  private lastEngineKey = "";
  /** A spotlight this editor stopped following stays declined until it ends */
  private declined = new Set<number>();
  private stopped = false;
  private offerTimer: ReturnType<typeof setTimeout> | null = null;
  /** Cursor chat: the text (null = closed) and the canvas point the local bubble follows (CSS px in the canvas) */
  private chat: string | null = null;

  constructor(
    private ed: EditorController,
    private fileKey: string,
  ) {}

  private get engine(): PresenceEngine {
    return this.ed.engine as unknown as PresenceEngine;
  }

  start(): void {
    // A start after a stop (React runs effects twice in development) starts afresh.
    this.stopped = false;
    this.lastEngineKey = "";
    this.lastSent = "";
    const mp = getStoreClient().multiplayer;
    void mp.fileState(this.fileKey).then((s) => this.apply(s), () => {});
    this.offs.push(
      mp.watch((e) => {
        if (e.fileKey !== this.fileKey) return;
        if (e.replacedBy) this.set({ replacedBy: e.replacedBy });
        this.apply(e.state);
      }),
    );
    const engine = this.ed.engine;
    this.offs.push(engine.on("SELECTION_CHANGED", () => this.schedule()));
    this.offs.push(engine.on("CAMERA_CHANGED", () => this.schedule()));
    this.offs.push(engine.on("CURRENT_PAGE_CHANGED", () => this.schedule()));
    const canvas = this.ed.canvas;
    if (canvas) {
      const move = (e: PointerEvent) => {
        const toWorld = this.engine.screenToWorld;
        if (!toWorld) return;
        const r = canvas.getBoundingClientRect();
        this.cursor = toWorld.call(this.ed.engine, e.clientX - r.left, e.clientY - r.top);
        this.schedule();
      };
      const leave = () => {
        this.cursor = null;
        this.schedule();
      };
      // Touching the canvas ends observation mode (Figma: any pan, zoom or click of your own).
      const interrupt = () => this.state.following !== null && this.stopFollowing();
      canvas.addEventListener("pointermove", move);
      canvas.addEventListener("pointerleave", leave);
      canvas.addEventListener("pointerdown", interrupt);
      canvas.addEventListener("wheel", interrupt, { passive: true });
      this.offs.push(() => {
        canvas.removeEventListener("pointermove", move);
        canvas.removeEventListener("pointerleave", leave);
        canvas.removeEventListener("pointerdown", interrupt);
        canvas.removeEventListener("wheel", interrupt);
      });
    }
    const frame = () => {
      if (this.stopped) return;
      this.draw();
      this.raf = requestAnimationFrame(frame);
    };
    this.raf = requestAnimationFrame(frame);
  }

  stop(): void {
    this.stopped = true;
    cancelAnimationFrame(this.raf);
    if (this.sendTimer) clearTimeout(this.sendTimer);
    for (const off of this.offs.splice(0)) off();
    if (!this.ed.engine.destroyed) this.engine.setPresence?.call(this.ed.engine, []);
  }

  subscribe = (l: () => void): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };

  follow(id: number): void {
    this.declined.delete(id);
    this.set({ following: id, spotlightOffer: null });
    this.followNow();
  }

  /** "Not now" on a spotlight: this one isn't followed (until it ends and starts again). */
  declineSpotlight(): void {
    const id = this.state.spotlightOffer;
    if (id === null) return;
    this.declined.add(id);
    if (this.offerTimer) clearTimeout(this.offerTimer);
    this.offerTimer = null;
    this.set({ spotlightOffer: null });
  }

  stopFollowing(): void {
    const id = this.state.following;
    if (id === null) return;
    const p = this.state.peers.find((x) => x.id === id);
    if (p?.presence?.spotlight) this.declined.add(id);
    this.set({ following: null });
  }

  /** Cursor chat (R13 §1): the bubble's text while open (null closes it), sent to the others live. */
  setChat(text: string | null): void {
    this.chat = text === null ? null : text.slice(0, 52);
    this.lastSent = "";
    this.schedule();
  }

  spotlight(on: boolean): void {
    this.set({ spotlighting: on, following: on ? null : this.state.following });
    this.lastSent = "";
    this.schedule();
  }

  private set(patch: Partial<PresenceState>): void {
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l();
  }

  private apply(s: FileShareState): void {
    const peers: Peer[] = s.peers.map((p: PeerInfo) => ({ id: p.sessionID, userId: p.userId, name: p.name || "Anonymous", role: p.role, color: peerColor(p.sessionID), presence: (p.presence as PresenceData | undefined) ?? null }));
    let following = this.state.following;
    if (following !== null && !peers.some((p) => p.id === following)) following = null;
    // Someone spotlighting: follow them (unless this editor stopped following that spotlight, or is spotlighting itself).
    for (const id of this.declined) if (!peers.find((p) => p.id === id)?.presence?.spotlight) this.declined.delete(id);
    const spot = peers.find((p) => p.presence?.spotlight && !this.declined.has(p.id));
    let offer = this.state.spotlightOffer;
    if (offer !== null && !peers.some((p) => p.id === offer && p.presence?.spotlight)) offer = null;
    if (spot && !this.state.spotlighting && following === null && offer === null) {
      offer = spot.id;
      if (this.offerTimer) clearTimeout(this.offerTimer);
      this.offerTimer = setTimeout(() => {
        this.offerTimer = null;
        if (this.state.spotlightOffer === spot.id) this.follow(spot.id);
      }, SPOTLIGHT_WAIT_MS);
    }
    const wasShared = this.state.shared;
    this.set({ shared: s.shared, role: s.role, connection: s.connection, peers, following, requests: s.requests ?? 0, spotlightOffer: following !== null ? null : offer });
    if (s.shared && !wasShared) this.schedule();
    if (following !== null) this.followNow();
  }

  /** Observation mode: the followed person's page and view. */
  private followNow(): void {
    const p = this.state.peers.find((x) => x.id === this.state.following);
    const pres = p?.presence;
    if (!pres) return;
    const engine = this.ed.engine;
    if (pres.page && pres.page !== this.ed.store.page) engine.setCurrentPage(pres.page);
    if (pres.view && this.engine.centerOn) this.engine.centerOn.call(engine, pres.view.x, pres.view.y, pres.view.zoom);
  }

  private snapshot(): PresenceData {
    const view = this.engine.viewCenter?.call(this.ed.engine) ?? null;
    const round = (n: number) => Math.round(n * 100) / 100;
    return {
      cursor: this.cursor ? { x: round(this.cursor.x), y: round(this.cursor.y) } : null,
      page: this.ed.store.page,
      selection: this.ed.store.selection.refs.slice(0, 200),
      view: view ? { x: round(view.x), y: round(view.y), zoom: round(view.zoom * 1000) / 1000 } : null,
      ...(this.state.spotlighting ? { spotlight: true } : {}),
      ...(this.chat !== null ? { chat: this.chat } : {}),
    };
  }

  private schedule(): void {
    if (!this.state.shared || this.sendTimer) return;
    const wait = Math.max(0, this.lastSendAt + SEND_EVERY_MS - Date.now());
    this.sendTimer = setTimeout(() => {
      this.sendTimer = null;
      const data = this.snapshot();
      const key = JSON.stringify(data);
      if (key === this.lastSent) return;
      this.lastSent = key;
      this.lastSendAt = Date.now();
      void getStoreClient().multiplayer.presence(this.fileKey, data).catch(() => {});
    }, wait);
  }

  /** Every animation frame: cursors eased towards their targets, the current page's peers handed to the engine. */
  private draw(): void {
    const setPresence = this.engine.setPresence;
    if (!setPresence || this.ed.engine.destroyed) return;
    const page = this.ed.store.page;
    // View › Multiplayer cursors (⌥⌘\) off: others' cursors and chat hidden, their selections still shown (R13 §1).
    const cursors = this.ed.ui.get().multiplayerCursors !== false;
    const out: Parameters<NonNullable<PresenceEngine["setPresence"]>>[0] = [];
    const seen = new Set<number>();
    for (const p of this.state.peers) {
      const pres = p.presence;
      if (!pres || pres.page !== page) continue;
      seen.add(p.id);
      let cursor: { x: number; y: number } | null = null;
      if (pres.cursor) {
        const d = this.drawn.get(p.id);
        const next = d ? { x: d.x + (pres.cursor.x - d.x) * EASE, y: d.y + (pres.cursor.y - d.y) * EASE } : { ...pres.cursor };
        if (Math.abs(next.x - pres.cursor.x) < 0.05 && Math.abs(next.y - pres.cursor.y) < 0.05) Object.assign(next, pres.cursor);
        this.drawn.set(p.id, next);
        cursor = next;
      } else this.drawn.delete(p.id);
      out.push({ id: p.id, name: p.name, color: p.color, cursor: cursors ? cursor : null, selection: pres.selection, chat: cursors && cursor && typeof pres.chat === "string" ? pres.chat : null });
    }
    for (const id of [...this.drawn.keys()]) if (!seen.has(id)) this.drawn.delete(id);
    const key = JSON.stringify(out);
    if (key === this.lastEngineKey) return;
    this.lastEngineKey = key;
    setPresence.call(this.ed.engine, out);
  }
}

const registry = new WeakMap<EditorController, Presence>();

/** The editor's presence (made on first use; started by <Multiplayer />). */
export function presenceOf(ed: EditorController): Presence | null {
  const fileKey = (ed.source as unknown as { fileKey?: unknown }).fileKey;
  if (typeof fileKey !== "string") return null;
  let p = registry.get(ed);
  if (!p) registry.set(ed, (p = new Presence(ed, fileKey)));
  return p;
}

export function usePresence(ed: EditorController): PresenceState {
  const p = presenceOf(ed);
  return useSyncExternalStore(p ? p.subscribe : noopSubscribe, () => p?.state ?? EMPTY);
}

const noopSubscribe = () => () => {};
