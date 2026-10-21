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
import { t } from "@/i18n";
import { getStoreClient } from "@/store";
import { currentTheme } from "@/ds/theme";
import { peerColor } from "@shared/multiplayer/colors";
import type { PeerInfo, Role } from "@shared/multiplayer/protocol";
import type { FileShareState, PresenceData } from "@shared/multiplayer/types";
import type { RoomPolicy } from "@shared/org/identity";
import type { EditorController } from "../controller";
import { AudioCall, type AudioState } from "./audio";
import { presenceSink } from "./presenceSink";
import { dedupePeers } from "./facepile";

/** What the engine offers for presence (docs/engine.md "Presence"); absent on an engine built before it */
interface PresenceEngine {
  setPresence?(peers: { id: number; name: string; color: string; cursor: { x: number; y: number } | null; selection: string[]; chat?: string | null; chatOpacity?: number }[]): void;
  setLocalChat?(text: string | null, at: { x: number; y: number } | null, opacity?: number): void;
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
  /** Not signed in (a link visitor without a name): listed last */
  anonymous: boolean;
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
  /** Why it was replaced (docs/multiplayer.md §18.3) */
  replacedWhy: "too-old" | "read-only" | "too-large" | null;
  /** "Ask to edit" requests waiting (editors): a badge on Share */
  requests: number;
  /** Someone started spotlighting: followed in a few seconds unless "Not now" (R13 §1) */
  spotlightOffer: number | null;
  /** The offer replaces the presenter this editor followed ("Switching to <name>", SPOTLIGHT_SWITCH_MS) */
  spotlightSwitch: boolean;
  /** When the offer is followed (Date.now ms): the bell's progress bar */
  spotlightAt: number | null;
  /** This editor spotlights: since when (the presenter's "Waiting for followers" bar), and who follows it now */
  spotlightSince: number | null;
  followers: number;
  /** This editor's session in the room (0 when not live) */
  me: number;
  /** Someone asked this editor to spotlight (Multiplayer tools › More options › Ask to spotlight) */
  askedBy: number | null;
  /** The link's password changed: entered again before the file carries on */
  locked: boolean;
  /** The file's audio conversation as this editor takes part in it */
  audio: AudioState;
  /** The org's room switches (Admin › Cursor chat, Audio — docs/multiplayer.md §15.9), live; null: everything allowed */
  policy: RoomPolicy | null;
  /** Governance+ (docs/governance.md §9 14e): the server refuses this file — an org gate, the network restriction or an
   *  unavailable encryption key; the link waits (FileBlocked.tsx shows why and what to do) */
  blocked: FileShareState["blocked"] | null;
}

const sameBlocked = (a: PresenceState["blocked"], b: PresenceState["blocked"]) => a === b || JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

const SEND_EVERY_MS = 100;
/** A spotlight is followed after this long unless declined (Figma's `pending_auto_follow`, atlas 19 §4.8) … */
export const SPOTLIGHT_WAIT_MS = 4000;
/** … and this long when it replaces the presenter followed ("switching to <new presenter>") */
export const SPOTLIGHT_SWITCH_MS = 2000;
/** The presenter's "Waiting for followers" bar runs this long (Figma's 4 000 ms) */
export const SPOTLIGHT_WAITING_MS = 4000;
/** Others' cursors not moved for this long aren't drawn (Figma: `> 6e4`), unless followed */
export const CURSOR_IDLE_MS = 60_000;
/** Cursor chat (atlas 19 §4.3): 50 characters a line, two lines (Enter starts the second); a bubble starts fading 5 s
 *  after its last change and is gone at 8 s — the sender's and the others' alike */
export const CHAT_LINE_MAX = 50;
export const CHAT_FADE_MS = 5000;
export const CHAT_GONE_MS = 8000;

/** A chat's text as it travels: at most two lines of CHAT_LINE_MAX */
export function chatText(text: string): string {
  return text
    .split("\n")
    .slice(-2)
    .map((l) => l.slice(0, CHAT_LINE_MAX))
    .join("\n");
}

/** A chat bubble's opacity `ms` after its last change: 1, fading from CHAT_FADE_MS, 0 (gone) at CHAT_GONE_MS */
export function chatOpacity(ms: number): number {
  if (ms <= CHAT_FADE_MS) return 1;
  if (ms >= CHAT_GONE_MS) return 0;
  return 1 - (ms - CHAT_FADE_MS) / (CHAT_GONE_MS - CHAT_FADE_MS);
}
/** Share of the way a drawn cursor moves towards its target each frame (≈ 60 fps): smooth at 10 updates a second */
const EASE = 0.3;

const NO_AUDIO: AudioState = { inCall: false, muted: false, noMic: false, speaking: [] };
const EMPTY: PresenceState = { shared: false, role: null, connection: "offline", peers: [], following: null, spotlighting: false, replacedBy: null, replacedWhy: null, requests: 0, spotlightOffer: null, spotlightSwitch: false, spotlightAt: null, spotlightSince: null, followers: 0, me: 0, askedBy: null, locked: false, audio: NO_AUDIO, policy: null, blocked: null };
/** A request to spotlight shows this long (Figma's bell stays until answered; ours goes after a while) */
const ASK_SHOWS_MS = 30_000;

export class Presence {
  state: PresenceState = EMPTY;
  private listeners = new Set<() => void>();
  private offs: (() => void)[] = [];
  private cursor: { x: number; y: number } | null = null;
  private lastSent = "";
  private sendTimer: ReturnType<typeof setTimeout> | null = null;
  private lastSendAt = 0;
  private drawn = new Map<number, { x: number; y: number }>();
  /** Each peer's last cursor position and when it moved there (idle cursors go after CURSOR_IDLE_MS) */
  private moved = new Map<number, { x: number; y: number; at: number }>();
  /** Each peer's last chat text and when it changed (bubbles fade after CHAT_FADE_MS) */
  private chats = new Map<number, { text: string; at: number }>();
  /** The presenter this editor followed because of their spotlight (a new presenter after them is a switch) */
  private followedPresenter: number | null = null;
  private raf = 0;
  private lastEngineKey = "";
  /** A spotlight this editor stopped following stays declined until it ends */
  private declined = new Set<number>();
  private stopped = false;
  private offerTimer: ReturnType<typeof setTimeout> | null = null;
  /** Cursor chat: the text (null = closed) and the canvas point the local bubble follows (CSS px in the canvas) */
  private chat: string | null = null;
  private askTimer: ReturnType<typeof setTimeout> | null = null;
  readonly audio = new AudioCall(
    (to, data) => void getStoreClient().multiplayer.signal(this.fileKey, to, data).catch(() => {}),
    () => {
      this.set({ audio: this.audio.state });
      this.lastSent = "";
      this.schedule();
      this.syncAudio();
    },
  );

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
        if (e.replacedBy) this.set({ replacedBy: e.replacedBy, replacedWhy: e.replacedWhy ?? "too-old" });
        if (e.signal) this.signalled(e.signal.from, e.signal.data);
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
    this.audio.leave();
    cancelAnimationFrame(this.raf);
    if (this.sendTimer) clearTimeout(this.sendTimer);
    for (const off of this.offs.splice(0)) off();
    presenceSink(this.ed).set("people", []);
  }

  subscribe = (l: () => void): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };

  follow(id: number): void {
    this.declined.delete(id);
    if (this.offerTimer) clearTimeout(this.offerTimer);
    this.offerTimer = null;
    const presenter = this.state.peers.find((p) => p.id === id)?.presence?.spotlight === true;
    this.followedPresenter = presenter ? id : null;
    this.set({ following: id, spotlightOffer: null, spotlightSwitch: false, spotlightAt: null });
    this.lastSent = "";
    this.schedule();
    this.followNow();
  }

  /** "Reset zoom" while following: the followed person's zoom again (Figma's `spotlight_zoom_override`) */
  resetZoom(): void {
    this.followNow();
  }

  /** Following, at another zoom than the followed person's (the bell then offers Reset zoom) */
  zoomDiffers(): boolean {
    const view = this.state.peers.find((x) => x.id === this.state.following)?.presence?.view;
    const mine = this.engine.viewCenter?.call(this.ed.engine);
    return !!view && !!mine && Math.abs(mine.zoom - view.zoom) > 1e-3;
  }

  /** "Not now" on a spotlight: this one isn't followed (until it ends and starts again). */
  declineSpotlight(): void {
    const id = this.state.spotlightOffer;
    if (id === null) return;
    this.declined.add(id);
    if (this.offerTimer) clearTimeout(this.offerTimer);
    this.offerTimer = null;
    this.set({ spotlightOffer: null, spotlightSwitch: false, spotlightAt: null });
  }

  stopFollowing(): void {
    const id = this.state.following;
    if (id === null) return;
    const p = this.state.peers.find((x) => x.id === id);
    if (p?.presence?.spotlight) this.declined.add(id);
    this.followedPresenter = null;
    this.set({ following: null });
    this.lastSent = "";
    this.schedule();
  }

  /** Cursor chat is allowed in this file (the org's Cursor chat setting, §15.6) */
  get chatAllowed(): boolean {
    return this.state.policy?.cursorChat !== false;
  }

  /** Audio is allowed in this file (the org's Audio setting, §15.6) */
  get audioAllowed(): boolean {
    return this.state.policy?.audio !== false;
  }

  /** Audio's Start / Join conversation — not when the org turned audio off */
  joinAudio(): Promise<void> {
    return this.audioAllowed ? this.audio.join() : Promise.resolve();
  }

  /** Cursor chat (R13 §1): the bubble's text while open (null closes it), sent to the others live. */
  setChat(text: string | null): void {
    if (text !== null && !this.chatAllowed) return;
    this.chat = text === null ? null : chatText(text);
    this.lastSent = "";
    this.schedule();
  }

  /** Multiplayer tools › More options › "Ask to spotlight": they get a bell with Spotlight me (live README). */
  askToSpotlight(id: number): void {
    void getStoreClient().multiplayer.signal(this.fileKey, id, { kind: "ask-spotlight" }).catch(() => {});
  }

  /** ✕ on someone's request to spotlight */
  dismissAsk(): void {
    if (this.askTimer) clearTimeout(this.askTimer);
    this.askTimer = null;
    this.set({ askedBy: null });
  }

  private signalled(from: number, data: unknown): void {
    const kind = (data as { kind?: unknown } | null)?.kind;
    if (kind === "ask-spotlight") {
      if (this.state.spotlighting) return;
      if (this.askTimer) clearTimeout(this.askTimer);
      this.askTimer = setTimeout(() => this.dismissAsk(), ASK_SHOWS_MS);
      this.set({ askedBy: from });
    } else if (kind === "rtc" && (this.audioAllowed || this.state.audio.inCall)) void this.audio.signal(from, data);
  }

  /** The people in the audio conversation (presence), to the call's connections. */
  private syncAudio(): void {
    if (!this.state.audio.inCall) return;
    this.audio.sync(
      this.state.me,
      this.state.peers.filter((p) => p.presence?.audio).map((p) => p.id),
    );
  }

  spotlight(on: boolean): void {
    if (on) this.dismissAsk();
    if (on) this.followedPresenter = null;
    this.set({ spotlighting: on, following: on ? null : this.state.following, spotlightSince: on ? Date.now() : null });
    this.lastSent = "";
    this.schedule();
  }

  private set(patch: Partial<PresenceState>): void {
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l();
  }

  private apply(s: FileShareState): void {
    const theme = currentTheme().resolved;
    const now = Date.now();
    const peers: Peer[] = dedupePeers(s.peers).map((p: PeerInfo) => ({ id: p.sessionID, userId: p.userId, name: p.name || t("Anonymous"), anonymous: !p.name, role: p.role, color: peerColor(p.sessionID, p.color, theme), presence: (p.presence as PresenceData | undefined) ?? null }));
    // When each cursor last moved and each chat last changed (idle cursors and fading bubbles: draw)
    for (const p of peers) {
      const c = p.presence?.cursor;
      const m = this.moved.get(p.id);
      if (c && (!m || m.x !== c.x || m.y !== c.y)) this.moved.set(p.id, { x: c.x, y: c.y, at: now });
      const chat = p.presence?.chat;
      if (typeof chat !== "string") this.chats.delete(p.id);
      else if (this.chats.get(p.id)?.text !== chat) this.chats.set(p.id, { text: chat, at: now });
    }
    for (const id of [...this.moved.keys()]) if (!peers.some((p) => p.id === id)) this.moved.delete(id);
    for (const id of [...this.chats.keys()]) if (!peers.some((p) => p.id === id)) this.chats.delete(id);
    let following = this.state.following;
    if (following !== null && !peers.some((p) => p.id === following)) following = null;
    // The presenter followed stopped: a presenter after them is offered as a switch (2 s), not a new spotlight (4 s).
    const switching = this.followedPresenter !== null && following === this.followedPresenter && !peers.find((p) => p.id === following)?.presence?.spotlight;
    if (switching && peers.some((p) => p.presence?.spotlight && p.id !== following && !this.declined.has(p.id))) following = null;
    // Someone spotlighting: follow them (unless this editor stopped following that spotlight, or is spotlighting itself).
    for (const id of this.declined) if (!peers.find((p) => p.id === id)?.presence?.spotlight) this.declined.delete(id);
    const spot = peers.find((p) => p.presence?.spotlight && !this.declined.has(p.id));
    let offer = this.state.spotlightOffer;
    let offerSwitch = this.state.spotlightSwitch;
    let offerAt = this.state.spotlightAt;
    if (offer !== null && !peers.some((p) => p.id === offer && p.presence?.spotlight)) offer = null;
    if (spot && !this.state.spotlighting && following === null && offer === null) {
      offer = spot.id;
      offerSwitch = switching;
      const wait = switching ? SPOTLIGHT_SWITCH_MS : SPOTLIGHT_WAIT_MS;
      offerAt = now + wait;
      if (this.offerTimer) clearTimeout(this.offerTimer);
      this.offerTimer = setTimeout(() => {
        this.offerTimer = null;
        if (this.state.spotlightOffer === spot.id) this.follow(spot.id);
      }, wait);
    }
    if (switching && following === null) this.followedPresenter = null;
    if (offer === null) {
      offerSwitch = false;
      offerAt = null;
    }
    const me = s.me ?? 0;
    const followers = me ? peers.filter((p) => p.presence?.observing === me).length : 0;
    const wasShared = this.state.shared;
    const askedBy = this.state.askedBy !== null && peers.some((p) => p.id === this.state.askedBy) ? this.state.askedBy : null;
    const policy = s.policy ?? null;
    const samePolicy = policy?.cursorChat === this.state.policy?.cursorChat && policy?.audio === this.state.policy?.audio && policy?.discovery === this.state.policy?.discovery;
    this.set({ shared: s.shared, role: s.role, connection: s.connection, peers, following, requests: s.requests ?? 0, spotlightOffer: following !== null ? null : offer, spotlightSwitch: following !== null ? false : offerSwitch, spotlightAt: following !== null ? null : offerAt, followers, me, locked: s.locked === true, blocked: sameBlocked(s.blocked ?? null, this.state.blocked) ? this.state.blocked : (s.blocked ?? null), askedBy, ...(samePolicy ? {} : { policy }) });
    // The org turned a switch off while the file is open (§15.9): an open chat closes, an ongoing call is left.
    if (policy?.cursorChat === false && this.chat !== null) this.setChat(null);
    if (policy?.audio === false && this.state.audio.inCall) this.audio.leave();
    if (s.shared && !wasShared) this.schedule();
    if (following !== null) this.followNow();
    this.syncAudio();
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
      ...(this.state.following !== null ? { observing: this.state.following } : {}),
      ...(this.chat !== null && this.chatAllowed ? { chat: this.chat } : {}),
      ...(this.state.audio.inCall ? { audio: { muted: this.state.audio.muted } } : {}),
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
    const now = Date.now();
    for (const p of this.state.peers) {
      const pres = p.presence;
      if (!pres || pres.page !== page) continue;
      seen.add(p.id);
      let cursor: { x: number; y: number } | null = null;
      // A cursor that hasn't moved for a minute isn't drawn (Figma), the followed person's always is.
      const idle = p.id !== this.state.following && now - (this.moved.get(p.id)?.at ?? now) > CURSOR_IDLE_MS;
      if (pres.cursor && !idle) {
        const d = this.drawn.get(p.id);
        const next = d ? { x: d.x + (pres.cursor.x - d.x) * EASE, y: d.y + (pres.cursor.y - d.y) * EASE } : { ...pres.cursor };
        if (Math.abs(next.x - pres.cursor.x) < 0.05 && Math.abs(next.y - pres.cursor.y) < 0.05) Object.assign(next, pres.cursor);
        this.drawn.set(p.id, next);
        cursor = next;
      } else this.drawn.delete(p.id);
      // Cursor chat off for the org: others' bubbles aren't drawn either (§15.6). A bubble fades 5 s after its last
      // change and is gone at 8 s, as Figma's remote bubbles.
      const since = now - (this.chats.get(p.id)?.at ?? now);
      const opacity = chatOpacity(since);
      const chat = cursors && cursor && this.chatAllowed && typeof pres.chat === "string" && opacity > 0 ? pres.chat : null;
      out.push({ id: p.id, name: p.name, color: p.color, cursor: cursors ? cursor : null, selection: pres.selection, chat, ...(chat !== null && opacity < 1 ? { chatOpacity: Math.round(opacity * 100) / 100 } : {}) });
    }
    for (const id of [...this.drawn.keys()]) if (!seen.has(id)) this.drawn.delete(id);
    const key = JSON.stringify(out);
    if (key === this.lastEngineKey) return;
    this.lastEngineKey = key;
    presenceSink(this.ed).set("people", out);
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
