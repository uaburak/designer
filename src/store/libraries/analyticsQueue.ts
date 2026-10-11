/**
 * Library analytics, the client side (docs/data.md §17.5): the editor's usage events pre-aggregated per (UTC day, file,
 * library, asset, type, action), kept across a quit or crash, and sent in batches; and the `analytics` repository's
 * reads (§17.6), online only.
 *
 * - `record` keeps only §17.2's events: org copies (`FileMeta.space`) in a folder (not drafts), not branches, of org
 *   libraries (room keys), signed in. The file's local key becomes its room key; `at` its UTC day.
 * - The queue is saved (debounced 5 s) under the person who queued it; another person signing in drops it.
 * - Sent every 10 minutes, on reconnect and on quit (best effort, 2 s), in chunks of 500: 2xx and 4xx take the chunk
 *   out (4xx: the server refuses it for good), 5xx and offline keep it. Rows older than 7 days are dropped.
 *
 * No Node or DOM imports: both stores run it.
 */
import { isLocalLibraryKey, type AnalyticsAssetType, type AnalyticsRange, type LibraryAnalyticsRepository, type LibraryOverview, type LibraryActions, type AssetUsage, type ModeUsageRow, type OrgLibrariesAnalytics, type LibraryUsageEvent, type UsageAction, type WireUsageEvent } from "../../shared/libraries/orgTypes";
import { StoreError } from "../../shared/store/protocol";
import type { FileKey, FileMeta } from "../../shared/store/types";
import { callJson, callText, isOffline, seg, type LibraryServer } from "./org";

export interface AnalyticsTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface AnalyticsQueueHost {
  server: LibraryServer;
  getMeta(fileKey: FileKey): FileMeta | null;
  /** The saved queue (null: none) */
  load(): Promise<unknown>;
  save(state: AnalyticsQueueState): Promise<void>;
  now(): number;
  timers: AnalyticsTimers;
  log(level: "debug" | "info" | "warn" | "error", message: string, detail?: unknown): void;
}

export interface AnalyticsQueueState {
  v: 1;
  uid: string | null;
  rows: WireUsageEvent[];
}

export const SEND_EVERY_MS = 10 * 60 * 1000;
export const SAVE_AFTER_MS = 5000;
export const CHUNK = 500;
export const KEEP_DAYS = 7;
const TYPES: readonly AnalyticsAssetType[] = ["component", "style", "variable"];
const ACTIONS: readonly UsageAction[] = ["insert", "detach"];

export const utcDay = (t: number): string => new Date(t).toISOString().slice(0, 10);
const rowKey = (r: Omit<WireUsageEvent, "count">) => JSON.stringify([r.day, r.file, r.library, r.asset, r.type, r.action]);

/** §17.2's files: an org copy in a folder (not a draft), not a branch */
export function reportsAnalytics(meta: FileMeta | null): meta is FileMeta & { space: NonNullable<FileMeta["space"]> } {
  return !!meta?.space && !!meta.space.projectId && !meta.branch;
}

export class AnalyticsQueue {
  private rows = new Map<string, WireUsageEvent>();
  private uid: string | null = null;
  private loaded: Promise<void> | null = null;
  private saveTimer: unknown = null;
  private sendTimer: unknown = null;
  private sending: Promise<void> | null = null;
  private closed = false;

  constructor(private readonly host: AnalyticsQueueHost) {}

  /** Starts the 10-minute sends */
  start(): void {
    this.scheduleSend();
  }

  private scheduleSend(): void {
    if (this.closed) return;
    if (this.sendTimer) this.host.timers.clearTimeout(this.sendTimer);
    this.sendTimer = this.host.timers.setTimeout(() => {
      this.sendTimer = null;
      void this.flush().finally(() => this.scheduleSend());
    }, SEND_EVERY_MS);
  }

  private ensureLoaded(): Promise<void> {
    if (!this.loaded)
      this.loaded = (async () => {
        const raw = (await this.host.load().catch(() => null)) as Partial<AnalyticsQueueState> | null;
        if (raw?.v !== 1 || !Array.isArray(raw.rows)) return;
        this.uid = typeof raw.uid === "string" ? raw.uid : null;
        for (const r of raw.rows) if (isWireRow(r)) this.add(r);
      })();
    return this.loaded;
  }

  private add(r: WireUsageEvent): void {
    const k = rowKey(r);
    const had = this.rows.get(k);
    this.rows.set(k, { ...r, count: Math.min(10_000, (had?.count ?? 0) + r.count) });
  }

  /** The person changed: what someone else queued isn't sent as them */
  private async follow(): Promise<void> {
    await this.ensureLoaded();
    const uid = this.host.server.userId;
    if (uid === this.uid) return;
    if (this.rows.size) this.host.log("info", `analytics: dropped ${this.rows.size} rows queued by another account`);
    this.rows.clear();
    this.uid = uid;
    this.scheduleSave();
  }

  async record(events: LibraryUsageEvent[]): Promise<void> {
    if (!this.host.server.signedIn || !Array.isArray(events)) return;
    await this.follow();
    const oldest = utcDay(this.host.now() - KEEP_DAYS * 86_400_000);
    let added = false;
    for (const e of events) {
      if (!e || typeof e !== "object" || typeof e.fileKey !== "string" || typeof e.libraryKey !== "string" || typeof e.assetKey !== "string") continue;
      if (isLocalLibraryKey(e.libraryKey) || !TYPES.includes(e.assetType) || !ACTIONS.includes(e.action)) continue;
      const count = Math.floor(Number(e.count));
      if (!(count >= 1)) continue;
      const meta = this.host.getMeta(e.fileKey);
      if (!reportsAnalytics(meta)) continue;
      const day = utcDay(Number.isFinite(e.at) ? e.at : this.host.now());
      if (day < oldest) continue;
      this.add({ day, file: meta.space.key, library: e.libraryKey, asset: e.assetKey, type: e.assetType, action: e.action, count: Math.min(10_000, count) });
      added = true;
    }
    if (added) this.scheduleSave();
  }

  /** Rows waiting (tests) */
  pending(): WireUsageEvent[] {
    return [...this.rows.values()].map((r) => ({ ...r }));
  }

  private scheduleSave(): void {
    if (this.saveTimer || this.closed) return;
    this.saveTimer = this.host.timers.setTimeout(() => {
      this.saveTimer = null;
      void this.save();
    }, SAVE_AFTER_MS);
  }

  private async save(): Promise<void> {
    await this.host.save({ v: 1, uid: this.uid, rows: this.pending() }).catch((e) => this.host.log("warn", "analytics: couldn't save the queue", e));
  }

  /** Sends what is queued (one send at a time) */
  flush(): Promise<void> {
    if (!this.sending)
      this.sending = this.send().finally(() => {
        this.sending = null;
      });
    return this.sending;
  }

  private async send(): Promise<void> {
    if (!this.host.server.signedIn) return;
    await this.follow();
    const oldest = utcDay(this.host.now() - KEEP_DAYS * 86_400_000);
    let changed = false;
    for (const [k, r] of this.rows)
      if (r.day < oldest) {
        this.rows.delete(k);
        changed = true;
      }
    const all = this.pending();
    for (let i = 0; i < all.length; i += CHUNK) {
      const chunk = all.slice(i, i + CHUNK);
      let status: number;
      try {
        status = (await this.host.server.request("POST", "/analytics/library-events", { events: chunk })).status;
      } catch (e) {
        if (!isOffline(e)) this.host.log("warn", "analytics: sending failed", e);
        break;
      }
      if (status >= 500 || status === 429) break;
      if (status >= 400) this.host.log("warn", `analytics: the server refused ${chunk.length} rows (${status})`);
      // Sent (or refused for good): those counts leave; what was added meanwhile stays.
      for (const r of chunk) {
        const k = rowKey(r);
        const now = this.rows.get(k);
        if (!now) continue;
        if (now.count <= r.count) this.rows.delete(k);
        else this.rows.set(k, { ...now, count: now.count - r.count });
      }
      changed = true;
    }
    if (changed) await this.save();
  }

  /** The quit: saved, then sent within `ms` at most */
  async close(ms = 2000): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.sendTimer) this.host.timers.clearTimeout(this.sendTimer);
    if (this.saveTimer) this.host.timers.clearTimeout(this.saveTimer);
    this.sendTimer = this.saveTimer = null;
    if (!this.loaded) return;
    await this.save();
    if (!this.rows.size || !this.host.server.signedIn) return;
    let timer: unknown = null;
    await Promise.race([this.flush().catch(() => {}), new Promise<void>((r) => (timer = this.host.timers.setTimeout(r, ms)))]);
    if (timer) this.host.timers.clearTimeout(timer);
  }
}

function isWireRow(r: unknown): r is WireUsageEvent {
  const x = r as WireUsageEvent;
  return !!x && typeof x.day === "string" && typeof x.file === "string" && typeof x.library === "string" && typeof x.asset === "string" && TYPES.includes(x.type) && ACTIONS.includes(x.action) && Number.isInteger(x.count) && x.count > 0;
}

const RANGES: readonly AnalyticsRange[] = [30, 60, 90, 365];

/** The `analytics` repository (§17.6's routes; `record` through the queue) */
export function analyticsRepository(queue: AnalyticsQueue, server: LibraryServer): LibraryAnalyticsRepository {
  const call = <T>(path: string) => callJson<T>(server, "GET", path);
  const typeRange = (q: { type: AnalyticsAssetType; range: AnalyticsRange }) => {
    if (!TYPES.includes(q?.type)) throw new StoreError("invalid", "bad type");
    if (!RANGES.includes(Number(q?.range) as AnalyticsRange)) throw new StoreError("invalid", "bad range");
    return `type=${q.type}&range=${Number(q.range)}`;
  };
  return {
    record: (events) => queue.record(events),
    orgOverview: (orgId, query) => {
      const p = new URLSearchParams();
      if (typeof query?.workspaceId === "string" && query.workspaceId) p.set("workspace", seg(query.workspaceId, "workspace id"));
      if (typeof query?.text === "string" && query.text.trim()) p.set("text", query.text.trim().slice(0, 256));
      const s = p.toString();
      return call<OrgLibrariesAnalytics>(`/orgs/${seg(orgId, "org id")}/libraries/analytics${s ? `?${s}` : ""}`);
    },
    overview: (key) => call<LibraryOverview>(`/libraries/${seg(key, "library key")}/analytics/overview`),
    actions: (key, query) => call<LibraryActions>(`/libraries/${seg(key, "library key")}/analytics/actions?${typeRange(query)}${query?.compareWith ? `&compare=${seg(query.compareWith, "library key")}` : ""}`),
    usage: (key, assetKey) => call<AssetUsage>(`/libraries/${seg(key, "library key")}/analytics/usage/${seg(assetKey, "asset key")}`),
    modes: async (key, collectionKey) => (await call<{ modes: ModeUsageRow[] }>(`/libraries/${seg(key, "library key")}/analytics/modes${collectionKey ? `?collection=${seg(collectionKey, "collection key")}` : ""}`)).modes ?? [],
    csv: (key, query) => callText(server, "GET", `/libraries/${seg(key, "library key")}/analytics/csv?${typeRange(query)}`),
  };
}
