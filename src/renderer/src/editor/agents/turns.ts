/**
 * One undo step per agent turn. Each write tool call is its own engine transaction while the agent works (the
 * canvas, the panels and the store follow every call); when the turn ends, its steps are folded into one: undone,
 * then their changes — the NODE_CHANGES messages the engine emitted, the store's own journal format — replayed in
 * one transaction labelled with the turn. Folding is skipped (the steps stay as they are) when anything else made
 * or took back an undo step in between: the user's edits are never folded into the agent's.
 *
 * The turn's step can then be taken back from the chat ("Undo") while it is the last step, and brought back
 * ("Apply") while it is the next redo.
 */
import type { EventOf, Message } from "@/engine/codec";
import { applyEngineBytes } from "../engineCompat";
import type { EditorController } from "../controller";

/** The engine's label of an agent's step (Edit › Undo …). */
export const agentLabel = (client: string) => `${client} edit`;

interface Captured {
  bytes?: Uint8Array;
  message: Message;
}

export interface TurnRecord {
  id: string;
  label: string;
  /** Write transactions committed so far */
  steps: Captured[];
  /** Another step happened in between (the user's edit, an undo): the turn can't be folded or taken back */
  foreign: boolean;
  /** After finish(): "applied" (the last step), "undone" (the next redo), "stale" (other steps since), "none" (it changed nothing) */
  state: "running" | "applied" | "undone" | "stale" | "none";
  touched: Set<string>;
}

type Listener = (turn: TurnRecord) => void;

export class AgentTurns {
  private turns = new Map<string, TurnRecord>();
  /** Turns whose step may be the last (or next redo): tracked for Undo / Apply */
  private tracked: TurnRecord[] = [];
  private writing: TurnRecord | null = null;
  private folding = false;
  private listeners = new Set<Listener>();
  private off: () => void;

  constructor(private ed: EditorController) {
    this.off = ed.engine.onDocumentChanged((_changes, ev) => this.onChanged(ev));
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

  start(id: string, client: string): TurnRecord {
    const t: TurnRecord = { id, label: agentLabel(client), steps: [], foreign: false, state: "running", touched: new Set() };
    this.turns.set(id, t);
    return t;
  }

  private onChanged(ev: EventOf<"DOCUMENT_CHANGED">) {
    if (this.folding) return;
    if (this.writing && ev.kind === "USER") {
      this.writing.steps.push({ bytes: ev.bytes, message: ev.message });
      return;
    }
    if (ev.kind === "SYSTEM") return;
    // Anything else that makes or takes back a step: running turns can't fold, finished ones aren't on top any more.
    for (const t of this.turns.values()) if (t.state === "running") t.foreign = true;
    for (const t of this.tracked) {
      if (ev.kind === "UNDO" && t.state === "applied" && this.tracked[this.tracked.length - 1] === t) {
        t.state = "undone";
      } else if (ev.kind === "REDO" && t.state === "undone") {
        t.state = "applied";
      } else if (t.state === "applied" || t.state === "undone") {
        t.state = "stale";
      }
      this.emit(t);
    }
    this.tracked = this.tracked.filter((t) => t.state === "applied" || t.state === "undone");
  }

  /**
   * One write of a turn (null: an outside client's call — its own step): a transaction labelled for the turn;
   * rolled back if `fn` throws.
   */
  write<T>(turnId: string | null, client: string, fn: () => T): T {
    const t = turnId ? (this.turns.get(turnId) ?? this.start(turnId, client)) : null;
    const e = this.ed.engine;
    e.txnBegin(t?.label ?? agentLabel(client));
    const outer = this.writing;
    this.writing = t;
    try {
      const out = fn();
      e.txnCommit();
      return out;
    } catch (err) {
      e.txnCancel();
      throw err;
    } finally {
      this.writing = outer;
    }
  }

  /** The turn ended: its steps folded into one undo step (when nothing came between). */
  finish(id: string): TurnRecord | undefined {
    const t = this.turns.get(id);
    if (!t || t.state !== "running") return t;
    if (!t.steps.length) {
      t.state = "none";
      this.emit(t);
      return t;
    }
    if (t.steps.length > 1 && !t.foreign) this.fold(t);
    t.state = t.foreign ? "stale" : "applied";
    if (t.state === "applied") {
      for (const o of this.tracked)
        if (o.state === "applied" || o.state === "undone") {
          o.state = "stale";
          this.emit(o);
        }
      this.tracked = [t];
    }
    this.emit(t);
    return t;
  }

  private fold(t: TurnRecord) {
    const e = this.ed.engine;
    const sel = [...this.ed.selection];
    this.folding = true;
    try {
      for (let i = 0; i < t.steps.length; i++) if (!e.undo()) throw new Error("undo failed");
      e.txnBegin(t.label);
      for (const s of t.steps) {
        const status = s.bytes ? (applyEngineBytes(e, s.bytes, "user") ?? e.applyChanges(s.message, "user")) : e.applyChanges(s.message, "user");
        if (status !== 0) throw new Error(`replay failed (${status})`);
      }
      e.txnCommit();
      e.setSelection(sel.filter((id) => !!e.readNode(id, { fields: ["name"] })));
    } catch {
      // The steps stay separate: whatever was undone is redone.
      try {
        e.txnCancel();
      } catch {
        /* no open step */
      }
      while (e.redo()) {
        /* back to where the turn left the file */
      }
    } finally {
      this.folding = false;
    }
  }

  /** Chat "Undo": the turn's step, when it is the last. */
  undo(id: string): boolean {
    const t = this.turns.get(id);
    if (!t || t.state !== "applied") return false;
    return this.ed.engine.undo();
  }

  /** Chat "Apply": the turn's step again, when it is the next redo. */
  redo(id: string): boolean {
    const t = this.turns.get(id);
    if (!t || t.state !== "undone") return false;
    return this.ed.engine.redo();
  }
}
