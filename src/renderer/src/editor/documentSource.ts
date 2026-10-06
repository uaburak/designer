/**
 * Where an editor's document comes from and where its changes go
 * (docs/editor.md §3). The editor never writes files: it loads one snapshot,
 * hands every committed change Message (engine.onDocumentChanged, one per
 * transaction) to `onChanges` in order, and asks for a `flush` before the
 * tab closes. The store integration supplies its own DocumentSource; the
 * `?editor` route and the tests use `memoryDocumentSource`.
 */
import type { Guid, Message, NodeChange } from "@/engine/codec";

export interface DocumentSource {
  /** The file's name, as the left panel's header shows it ("burakkoc"). */
  readonly fileName: string;
  /** Where the file lives, under its name ("Drafts", a project's name). */
  readonly location: string;
  /** The session new nodes are created in (allocated by storage, docs/data.md §1); default 1. */
  readonly sessionID?: number;
  /** The document to open: a snapshot Message (DOCUMENT first, parents before children). */
  load(): Promise<Message>;
  /** One committed change (a NODE_CHANGES Message carrying only the touched fields), in commit order. */
  onChanges(changes: Message): void;
  /** Resolves once every change handed to `onChanges` is stored. */
  flush(): Promise<void>;
  /** The file was renamed from the file menu; absent: the name can't be changed here. */
  rename?(name: string): void | Promise<void>;
}

/**
 * Applies a change Message to a snapshot's nodes (docs/schema.md §4.3): REMOVED
 * deletes, CREATED replaces, an update replaces each carried field wholesale
 * and deletes the `clearedFields` (by name: the interim codec carries names).
 */
export function applyMessage(nodes: Map<Guid, NodeChange>, message: Message, clearedName: (id: number) => string | undefined = () => undefined): void {
  for (const change of message.nodeChanges) {
    if (change.phase === "REMOVED") {
      nodes.delete(change.guid);
      continue;
    }
    if (change.phase === "CREATED") {
      nodes.set(change.guid, { ...change });
      continue;
    }
    const current = nodes.get(change.guid);
    if (!current) continue; // an update of a node we don't have: skipped, as the apply algorithm says
    const next: NodeChange = { ...current };
    for (const [key, value] of Object.entries(change)) {
      if (key === "guid" || key === "phase" || key === "clearedFields") continue;
      (next as unknown as Record<string, unknown>)[key] = value;
    }
    for (const id of change.clearedFields ?? []) {
      const name = clearedName(id);
      if (name) delete (next as unknown as Record<string, unknown>)[name];
    }
    nodes.set(change.guid, next);
  }
}

export interface MemoryDocumentSource extends DocumentSource {
  /** The document as it is now: the snapshot with every change applied (parents before children). */
  snapshot(): Message;
  /** Every change received, in order. */
  readonly changes: readonly Message[];
}

/** A DocumentSource held in memory: the snapshot it was given plus every change since. */
export function memoryDocumentSource(document: Message, options: { fileName?: string; location?: string; sessionID?: number } = {}): MemoryDocumentSource {
  const nodes = new Map<Guid, NodeChange>(document.nodeChanges.map((n) => [n.guid, { ...n, phase: "CREATED" as const }]));
  const changes: Message[] = [];
  let fileName = options.fileName ?? "Untitled";
  const snapshot = (): Message => ({ type: "NODE_CHANGES", sessionID: 0, nodeChanges: orderParentsFirst([...nodes.values()]) });
  return {
    get fileName() {
      return fileName;
    },
    location: options.location ?? "Drafts",
    sessionID: options.sessionID ?? 1,
    changes,
    load: async () => snapshot(),
    onChanges: (message) => {
      changes.push(message);
      applyMessage(nodes, message);
    },
    flush: async () => {},
    rename: (name) => {
      fileName = name;
    },
    snapshot,
  };
}

/** Nodes ordered parents before children (a snapshot's order; orphans last). */
export function orderParentsFirst(nodes: NodeChange[]): NodeChange[] {
  const byParent = new Map<Guid, NodeChange[]>();
  const ids = new Set(nodes.map((n) => n.guid));
  const roots: NodeChange[] = [];
  for (const n of nodes) {
    const parent = n.parentIndex?.guid;
    if (!parent || !ids.has(parent)) roots.push(n);
    else {
      const list = byParent.get(parent);
      if (list) list.push(n);
      else byParent.set(parent, [n]);
    }
  }
  const byPosition = (a: NodeChange, b: NodeChange) => {
    const pa = a.parentIndex?.position ?? "";
    const pb = b.parentIndex?.position ?? "";
    return pa < pb ? -1 : pa > pb ? 1 : a.guid < b.guid ? -1 : a.guid > b.guid ? 1 : 0;
  };
  const out: NodeChange[] = [];
  const seen = new Set<Guid>();
  const visit = (n: NodeChange) => {
    if (seen.has(n.guid)) return;
    seen.add(n.guid);
    out.push(n);
    for (const child of (byParent.get(n.guid) ?? []).sort(byPosition)) visit(child);
  };
  roots.sort((a, b) => (a.type === "DOCUMENT" ? -1 : b.type === "DOCUMENT" ? 1 : byPosition(a, b))).forEach(visit);
  return out;
}
