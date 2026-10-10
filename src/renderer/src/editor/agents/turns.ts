/**
 * Agents write beside the user, isolated from them (the owner: "what I do must not affect the agent and what the agent
 * does must not affect me"). Each chat turn is an engine **actor** (docs/engine.md §9.5 — the shape multiplayer
 * sessions take in Phase 6): every write tool call is one `actorBegin … actorEnd` write with the actor's own selection
 * and page, so the user's selection, page, view, text / vector edit and selected connection are never touched; the
 * turn's writes join one step in the turn's **own undo history** — not the user's: ⌘Z / ⇧⌘Z take back only the
 * user's steps, the chat's Undo / Apply only the turn's, and either skips the fields someone else wrote since (per
 * property, last writer wins). A write waits while the user drags or scrubs (the engine is busy: EngineBusy, retried
 * by the service when it is idle again).
 *
 * An outside MCP client's call (no chat turn) is an actor too — its own selection and page — whose steps go to the
 * user's history (there is no chat to undo them from: ⌘Z does).
 */
import type { Guid } from "@/engine/codec";
import { Status } from "@/engine/abi";
import type { EditorController } from "../controller";

/** The engine's label of an agent's step. */
export const agentLabel = (client: string) => `${client} edit`;

/** The engine is busy with the user's gesture or step: the write is tried again when it is idle. */
export class EngineBusy extends Error {
  constructor() {
    super("The canvas is busy (the user is dragging or editing): try again.");
  }
}

export interface TurnRecord {
  id: string;
  label: string;
  /** The turn's engine actor */
  actor: number;
  /** The page the turn works on when a call names no layer (set_current_page); null: the user's */
  page: Guid | null;
  /** Writes committed so far */
  steps: number;
  /**
   * "running"; then "applied" (its step can be undone), "undone" (it can be applied again), "stale" (everything it
   * changed was changed again since by someone else: nothing left to undo), "none" (it changed nothing)
   */
  state: "running" | "applied" | "undone" | "stale" | "none";
  /** Layers whose changes by the turn someone else (the user, another chat) changed since: those fields stay theirs */
  overwritten: Guid[];
  touched: Set<string>;
}

type Listener = (turn: TurnRecord) => void;

export class AgentTurns {
  private turns = new Map<string, TurnRecord>();
  private outside = new Map<string, number>();
  private nextActor = 1;
  private listeners = new Set<Listener>();
  private off: () => void;

  constructor(private ed: EditorController) {
    this.off = ed.engine.onDocumentChanged((_changes, ev) => {
      if (ev.kind !== "SYSTEM") this.refresh(ev.actor ?? 0);
    });
  }

  dispose() {
    this.off();
  }

  onChange(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(t: TurnRecord) {
    for (const fn of this.listeners) fn(t);
  }

  get(id: string): TurnRecord | undefined {
    return this.turns.get(id);
  }

  /** A turn's record (the one a tool call already made, when it came first). */
  start(id: string, client: string): TurnRecord {
    const had = this.turns.get(id);
    if (had) return had;
    const t: TurnRecord = { id, label: agentLabel(client), actor: this.nextActor++, page: null, steps: 0, state: "running", overwritten: [], touched: new Set() };
    this.turns.set(id, t);
    return t;
  }

  /** Nothing open in the engine (no drag, no scrub): a write can begin. Resolves at once when idle. */
  async idle(): Promise<void> {
    const e = this.ed.engine;
    while (!e.destroyed && !e.idle()) await new Promise((r) => setTimeout(r, 30));
  }

  /**
   * One write of a turn (null: an outside client's call — a step of the user's history): `fn` runs as the turn's actor
   * with `refs` as its selection (on `refs`' page, else the turn's, else the user's); rolled back if `fn` throws.
   * Throws EngineBusy while the user's gesture or step is open.
   */
  write<T>(turnId: string | null, client: string, fn: () => T, refs: readonly Guid[] = []): T {
    const t = turnId ? (this.turns.get(turnId) ?? this.start(turnId, client)) : null;
    const e = this.ed.engine;
    let actor = t?.actor;
    if (actor === undefined) {
      actor = this.outside.get(client) ?? this.nextActor++;
      this.outside.set(client, actor);
    }
    const status = e.actorBegin(actor, { label: t?.label ?? agentLabel(client), refs, page: refs.length ? null : t?.page, merge: !!t, undoTo: t ? actor : 0 });
    if (status === Status.E_BUSY) throw new EngineBusy();
    if (status !== Status.OK) throw new Error(status === Status.E_READONLY ? "The file is read-only." : `The engine refused the write (status ${status}).`);
    this.ed.actorWriting++;
    let done = false;
    try {
      const out = fn();
      done = true;
      return out;
    } finally {
      this.ed.actorWriting--;
      e.actorEnd(!done);
      if (done && t && e.actorInfo(t.actor).canUndo) t.steps++;
    }
  }

  /** The turn ended: its step is in its own history (Undo / Apply in the chat). */
  finish(id: string): TurnRecord | undefined {
    const t = this.turns.get(id);
    if (!t || t.state !== "running") return t;
    const info = this.ed.engine.actorInfo(t.actor);
    t.overwritten = info.overwritten;
    t.state = !t.steps && !info.canUndo ? "none" : this.stateOf(t);
    this.emit(t);
    return t;
  }

  private stateOf(t: TurnRecord): TurnRecord["state"] {
    const info = this.ed.engine.actorInfo(t.actor);
    if (info.canRedo && !info.canUndo) return "undone";
    if (info.canUndo) return "applied";
    return t.state === "none" ? "none" : "stale";
  }

  /** Someone wrote: the finished turns' Undo / Apply and overwritten layers follow. */
  private refresh(by: number) {
    for (const t of this.turns.values()) {
      if (t.actor === by && t.state === "running") continue;
      const info = this.ed.engine.actorInfo(t.actor);
      const overwritten = info.overwritten;
      const state = t.state === "running" || t.state === "none" ? t.state : this.stateOf(t);
      if (state === t.state && overwritten.length === t.overwritten.length) continue;
      t.overwritten = overwritten;
      t.state = state;
      if (t.state !== "running") this.emit(t);
    }
  }

  /** Chat "Undo": the turn's step — only what nobody changed since. */
  undo(id: string): boolean {
    const t = this.turns.get(id);
    if (!t || t.state !== "applied") return false;
    const ok = this.ed.engine.actorUndo(t.actor, false);
    if (!ok) this.settle(t);
    return ok;
  }

  /** Chat "Apply": the turn's step again. */
  redo(id: string): boolean {
    const t = this.turns.get(id);
    if (!t || t.state !== "undone") return false;
    const ok = this.ed.engine.actorUndo(t.actor, true);
    if (!ok) this.settle(t);
    return ok;
  }

  private settle(t: TurnRecord) {
    const state = this.stateOf(t);
    if (state !== t.state) {
      t.state = state;
      this.emit(t);
    }
  }

  /** The turn's history goes (its chat was deleted). */
  forget(id: string) {
    const t = this.turns.get(id);
    if (!t || t.state === "running") return;
    this.ed.engine.actorForget(t.actor);
    this.turns.delete(id);
  }
}
