/**
 * The engine draws one set of collaborators (Engine.setPresence replaces the whole set). Two sources feed it: the people
 * in a shared file (presence.ts) and the agents working on the file (agentPresence.ts — MCP clients, the Agents tab's
 * chats, Studio's manager and its workers). Each source sets its own layer here; the engine gets them together, and only
 * when something changed.
 */
import type { PresencePeer } from "@/engine/Engine";
import type { EditorController } from "../controller";

export type PresenceLayer = "people" | "agents";

interface SinkEngine {
  destroyed: boolean;
  setPresence?(peers: readonly PresencePeer[]): void;
}

export class PresenceSink {
  private layers: Record<PresenceLayer, readonly PresencePeer[]> = { people: [], agents: [] };
  private last = "[]";

  constructor(private engine: SinkEngine) {}

  set(layer: PresenceLayer, peers: readonly PresencePeer[]): void {
    this.layers = { ...this.layers, [layer]: peers };
    if (this.engine.destroyed || !this.engine.setPresence) return;
    const all = [...this.layers.people, ...this.layers.agents];
    const key = JSON.stringify(all);
    if (key === this.last) return;
    this.last = key;
    this.engine.setPresence(all);
  }
}

const sinks = new WeakMap<EditorController, PresenceSink>();

/** The editor's presence sink (made on first use). */
export function presenceSink(ed: EditorController): PresenceSink {
  let s = sinks.get(ed);
  if (!s) sinks.set(ed, (s = new PresenceSink(ed.engine as unknown as SinkEngine)));
  return s;
}
