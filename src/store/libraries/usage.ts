/**
 * Instance counts per file (docs/data.md §17.4): the "Instances" snapshot of an org copy's use of org libraries, read
 * from the document itself (snapshot + journal as compaction merges them; no engine) and sent with
 * `PUT /files/:roomKey/library-usage` when the file closes or after 5 minutes idle — at most once per UTC day per file,
 * and only when its head moved since the last one.
 *
 * - Components: INSTANCE nodes whose `symbolData.symbolID` is a library copy (instance sublayers aren't nodes; nodes
 *   inside a library copy's own subtree — a component's nested instances — never count).
 * - Styles: nodes whose `styleIdFor*` names a library style copy, once per (node, style).
 * - Variables: nodes bound to a library variable copy (a field binding, a paint's or effect's colour), once per
 *   (node, variable).
 * - Modes: nodes with an explicit mode for a library collection copy, once per (node, mode).
 *
 * No Node or DOM imports: both stores run it.
 */
import { isLocalLibraryKey, type AnalyticsAssetType, type FileUsageSnapshot } from "../../shared/libraries/orgTypes";
import type { GUID, NodeChange } from "../../shared/schema/document.generated";
import { guidKey } from "../../shared/schema/guid";
import type { FileKey, FileMeta } from "../../shared/store/types";
import { reportsAnalytics, utcDay, type AnalyticsTimers } from "./analyticsQueue";
import { callJson, type LibraryServer } from "./org";

type Rows = Omit<FileUsageSnapshot, "hash">;

/** The snapshot's rows for a document's nodes (sorted; `hash` added by `usageSnapshot`) */
export function usageRows(nodes: Iterable<NodeChange>): Rows {
  const byGuid = new Map<string, NodeChange>();
  for (const n of nodes) if (n.guid) byGuid.set(guidKey(n.guid), n);
  const copyOf = (g: GUID | undefined): NodeChange | null => {
    if (!g) return null;
    const n = byGuid.get(guidKey(g));
    return n?.sourceLibraryKey && n.key && !isLocalLibraryKey(n.sourceLibraryKey) ? n : null;
  };
  // Inside a library copy (its own subtree, the copy included): never counted as a use.
  const inside = new Map<string, boolean>();
  const inCopy = (n: NodeChange): boolean => {
    const path: string[] = [];
    let cur: NodeChange | undefined = n;
    let found = false;
    for (let depth = 0; cur && depth < 4096; depth++) {
      const k = guidKey(cur.guid!);
      const known = inside.get(k);
      if (known !== undefined) {
        found = known;
        break;
      }
      path.push(k);
      if (cur.sourceLibraryKey) {
        found = true;
        break;
      }
      const parent: GUID | undefined = cur.parentIndex?.guid;
      cur = parent ? byGuid.get(guidKey(parent)) : undefined;
    }
    for (const k of path) inside.set(k, found);
    return found;
  };

  const assets = new Map<string, { library: string; asset: string; type: AnalyticsAssetType; instances: number }>();
  const modes = new Map<string, { library: string; collection: string; mode: string; instances: number }>();
  const count = (copy: NodeChange, type: AnalyticsAssetType) => {
    const k = `${copy.sourceLibraryKey}\u0000${copy.key}\u0000${type}`;
    const row = assets.get(k);
    if (row) row.instances++;
    else assets.set(k, { library: copy.sourceLibraryKey!, asset: copy.key!, type, instances: 1 });
  };

  for (const n of byGuid.values()) {
    if (!n.guid || n.sourceLibraryKey || n.phase === "REMOVED") continue;
    if (inCopy(n)) continue;
    if (n.type === "INSTANCE") {
      const c = copyOf(n.symbolData?.symbolID);
      if (c) count(c, "component");
    }
    const styles = new Set<NodeChange>();
    for (const s of [n.styleIdForFill, n.styleIdForStrokeFill, n.styleIdForText, n.styleIdForEffect, n.styleIdForGrid]) {
      const c = copyOf(s?.guid);
      if (c && c.styleType) styles.add(c);
    }
    for (const c of styles) count(c, "style");
    const variables = new Set<NodeChange>();
    const bind = (g: GUID | undefined) => {
      const c = copyOf(g);
      if (c && c.type === "VARIABLE") variables.add(c);
    };
    for (const e of n.parameterConsumptionMap?.entries ?? []) bind(e.variableData?.value?.alias?.guid);
    for (const p of [...(n.fillPaints ?? []), ...(n.strokePaints ?? [])]) bind(p.colorVar?.value?.alias?.guid);
    for (const e of n.effects ?? []) bind(e.colorVar?.value?.alias?.guid);
    for (const c of variables) count(c, "variable");
    for (const m of n.variableModeBySetMap?.entries ?? []) {
      const c = copyOf(m.variableSetExtensionID?.guid) ?? copyOf(m.variableSetID?.guid);
      if (!c || c.type !== "VARIABLE_SET" || !m.variableModeID) continue;
      const mode = guidKey(m.variableModeID);
      const k = `${c.sourceLibraryKey}\u0000${c.key}\u0000${mode}`;
      const row = modes.get(k);
      if (row) row.instances++;
      else modes.set(k, { library: c.sourceLibraryKey!, collection: c.key!, mode, instances: 1 });
    }
  }
  const order = (a: string[], b: string[]) => {
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
    return 0;
  };
  return {
    assets: [...assets.values()].sort((a, b) => order([a.library, a.asset, a.type], [b.library, b.asset, b.type])),
    modes: [...modes.values()].sort((a, b) => order([a.library, a.collection, a.mode], [b.library, b.collection, b.mode])),
  };
}

async function sha1Hex(text: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-1", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The snapshot with its hash: sha1 of the canonical (sorted) rows */
export async function usageSnapshot(nodes: Iterable<NodeChange>): Promise<FileUsageSnapshot> {
  const rows = usageRows(nodes);
  return { hash: await sha1Hex(JSON.stringify(rows)), ...rows };
}

export interface UsageReporterHost {
  server: LibraryServer;
  getMeta(fileKey: FileKey): FileMeta | null;
  /** The document at its head (snapshot + journal merged) and that head's seq */
  readDocument(fileKey: FileKey): Promise<{ nodes: Iterable<NodeChange>; headSeq: number }>;
  /** The last sent snapshots per file, as saved */
  load(): Promise<unknown>;
  save(state: UsageState): Promise<void>;
  now(): number;
  timers: AnalyticsTimers;
  log(level: "debug" | "info" | "warn" | "error", message: string, detail?: unknown): void;
}

export interface UsageState {
  v: 1;
  files: Record<FileKey, { day: string; headSeq: number; hash: string }>;
}

export const IDLE_MS = 5 * 60 * 1000;

/** When to snapshot: a file's close, or 5 minutes after its last change */
export class UsageReporter {
  private state: UsageState | null = null;
  private idle = new Map<FileKey, unknown>();
  private running = new Map<FileKey, Promise<void>>();
  private closed = false;

  constructor(private readonly host: UsageReporterHost) {}

  /** A change to the file: its idle timer starts again */
  touched(fileKey: FileKey): void {
    if (this.closed || !reportsAnalytics(this.host.getMeta(fileKey))) return;
    const t = this.idle.get(fileKey);
    if (t) this.host.timers.clearTimeout(t);
    this.idle.set(
      fileKey,
      this.host.timers.setTimeout(() => {
        this.idle.delete(fileKey);
        void this.run(fileKey);
      }, IDLE_MS),
    );
  }

  /** The file closed: snapshot now */
  closedFile(fileKey: FileKey): void {
    const t = this.idle.get(fileKey);
    if (t) this.host.timers.clearTimeout(t);
    this.idle.delete(fileKey);
    void this.run(fileKey);
  }

  close(): void {
    this.closed = true;
    for (const t of this.idle.values()) this.host.timers.clearTimeout(t);
    this.idle.clear();
  }

  /** Snapshot and send if due (one at a time per file); never fails */
  run(fileKey: FileKey): Promise<void> {
    const busy = this.running.get(fileKey);
    if (busy) return busy;
    const p = this.report(fileKey)
      .catch((e) => this.host.log("warn", `analytics: ${fileKey}'s usage snapshot`, e))
      .finally(() => this.running.delete(fileKey));
    this.running.set(fileKey, p);
    return p;
  }

  private async loadState(): Promise<UsageState> {
    if (this.state) return this.state;
    const raw = (await this.host.load().catch(() => null)) as Partial<UsageState> | null;
    this.state = { v: 1, files: raw?.v === 1 && raw.files && typeof raw.files === "object" ? { ...raw.files } : {} };
    return this.state;
  }

  private async report(fileKey: FileKey): Promise<void> {
    const meta = this.host.getMeta(fileKey);
    if (!reportsAnalytics(meta) || !this.host.server.signedIn) return;
    const state = await this.loadState();
    const today = utcDay(this.host.now());
    const last = state.files[fileKey];
    if (last?.day === today) return;
    const { nodes, headSeq } = await this.host.readDocument(fileKey);
    if (last && last.headSeq === headSeq) return;
    const snapshot = await usageSnapshot(nodes);
    if (!last || last.hash !== snapshot.hash) await callJson(this.host.server, "PUT", `/files/${encodeURIComponent(meta.space.key)}/library-usage`, snapshot);
    state.files[fileKey] = { day: today, headSeq, hash: snapshot.hash };
    await this.host.save(state);
  }
}
