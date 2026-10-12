/**
 * Discovery, the writers' side (docs/governance.md §1 "Discovery API", §2.11). Every text people put into an org's
 * files becomes a row of D1 `discovery_events` in Figma's flat shape, read back by `GET /v1/discovery` (rest.ts):
 *
 * - comments and reactions (server/src/comments.ts) and dev resources (server/src/devmode/devResources.ts) through
 *   `recordFileText`, written after the answer (`waitUntil`);
 * - cursor chat: the room's `Room.drainDiscovery()` → `discoveryTake` (each message's final text, `transient`);
 * - `in_file`, `dev_mode_annotation`, `component_documentation_*`: the room's hourly `discoveryAlarm` runs the
 *   `discovery_text` job (a client or the render helper lists every text-bearing node) and diffs the answer against
 *   the room's own `discovery_text (node_id, text_type, hash)` table into insert / update / delete events, stamped at
 *   the job's time and attributed to the last writer of the window (ours, approximate);
 * - AI prompts: client-reported by main (routes.ts `POST /orgs/:org/discovery/ai-prompt`).
 *
 * Off is free: `recordDiscovery` drops everything for orgs without Governance+ or with `discovery` off. The orgs that
 * have it on are one D1 query per isolate per ORGS_TTL_MS (shared with developer logs' "is this a G+ org?"); with none
 * on, nothing else is read. Rooms record a writer or a chat only when their policy says `discovery: true`, so a file of
 * an org without Discovery never creates the room tables.
 */
import { DISCOVERY_RETENTION_MS, DEVELOPER_LOGS_RETENTION_MS, type DiscoveryEvent, type DiscoveryTextItem, type DiscoveryTextType } from "../../../src/shared/org/governance";
import type { DiscoveryCapture } from "../../../src/shared/multiplayer/room";
import type { RestJobPart } from "../../../src/shared/rest/types";
import type { D1Like } from "../db";
import type { SqlLike } from "../previews";
import { REST_TIMING, type JobAnswer } from "../rest/roomJobs";

export interface DiscoveryRecord extends DiscoveryEvent { org_id: string }

/** What the writers need: D1 (the Worker's `Deps` fits; a room passes its own binding), the clock, `waitUntil` */
export interface DiscoveryDeps {
  db: { d1: D1Like };
  now?(): number;
  waitUntil?(p: Promise<unknown>): void;
}

const HOUR_MS = 3_600_000;
/** How long an isolate trusts its list of Governance+ orgs and of those with Discovery on */
export const ORGS_TTL_MS = 60_000;
/** Text kept per event (Figma publishes no limit; ours) */
export const MAX_TEXT = 20_000;
const MAX_INSERT = 500;

// ---- the orgs (one cheap check, cached briefly) ----------------------------------------------------------------------

interface OrgsCache {
  at: number;
  value: Promise<{ gplus: Set<string>; discovery: Set<string> }> | null;
}
const orgCaches = new WeakMap<D1Like, OrgsCache>();

/** Forget the cached lists (a setting changed in this isolate; others see it within ORGS_TTL_MS) */
export function forgetGovernanceOrgs(d1: D1Like): void {
  orgCaches.delete(d1);
}

/** The Governance+ orgs, and those of them with Discovery on: one query per isolate per ORGS_TTL_MS */
export async function governanceOrgs(d1: D1Like, now = Date.now()): Promise<{ gplus: Set<string>; discovery: Set<string> }> {
  let c = orgCaches.get(d1);
  if (!c) orgCaches.set(d1, (c = { at: -Infinity, value: null }));
  if (c.value && now - c.at < ORGS_TTL_MS) return c.value;
  c.at = now;
  const entry = c;
  c.value = d1
    .prepare(`SELECT id, json_extract(settings, '$.discovery') AS d FROM orgs WHERE governance_plus = 1`)
    .all<{ id: string; d: number | null }>()
    .then(({ results }) => ({ gplus: new Set(results.map((r) => r.id)), discovery: new Set(results.filter((r) => r.d === 1).map((r) => r.id)) }))
    .catch((e) => {
      console.error("discovery: orgs not read", e);
      entry.at = -Infinity;
      return { gplus: new Set<string>(), discovery: new Set<string>() };
    });
  return c.value;
}

export async function discoveryOn(d1: D1Like, orgId: string | null, now?: number): Promise<boolean> {
  if (!orgId) return false;
  return (await governanceOrgs(d1, now)).discovery.has(orgId);
}

/** Work after the answer: the Worker's `waitUntil`, inline where there is none (tests) */
export async function afterAnswer(deps: { waitUntil?(p: Promise<unknown>): void }, work: () => Promise<unknown>): Promise<void> {
  const p = work().catch((e) => console.error("discovery / developer logs: not written", e));
  if (deps.waitUntil) deps.waitUntil(p);
  else await p;
}

// ---- writing ---------------------------------------------------------------------------------------------------------

/** Rows of orgs with Discovery on go to D1 (one statement per 500); the others are dropped. */
export async function recordDiscovery(deps: DiscoveryDeps, events: DiscoveryRecord[]): Promise<void> {
  if (!events.length) return;
  const on = (await governanceOrgs(deps.db.d1, deps.now?.())).discovery;
  const keep = events.filter((e) => on.has(e.org_id));
  for (let i = 0; i < keep.length; i += MAX_INSERT) {
    const rows = keep.slice(i, i + MAX_INSERT).map((e) => ({ ...e, text: e.text.slice(0, MAX_TEXT), hour: Math.floor(e.timestamp / 3600) }));
    await deps.db.d1
      .prepare(
        `INSERT INTO discovery_events (org_id, hour, file_key, text, timestamp, action_type, file_name, file_workspace_id, node_id, text_type, resource_id,
           parent_comment_id, user_id, user_email, user_billing_group_id, feature_entrypoint, moderation_failure_flags)
         SELECT j.value ->> 'org_id', j.value ->> 'hour', j.value ->> 'file_key', j.value ->> 'text', j.value ->> 'timestamp', j.value ->> 'action_type',
           j.value ->> 'file_name', j.value ->> 'file_workspace_id', j.value ->> 'node_id', j.value ->> 'text_type', j.value ->> 'resource_id',
           j.value ->> 'parent_comment_id', j.value ->> 'user_id', j.value ->> 'user_email', j.value ->> 'user_billing_group_id',
           j.value ->> 'feature_entrypoint', j.value ->> 'moderation_failure_flags'
         FROM json_each(?1) j`,
      )
      .bind(JSON.stringify(rows))
      .run();
  }
}

/** One text of a file, before the file's and the person's facts are filled in */
export interface FileText {
  text: string;
  action: DiscoveryEvent["action_type"];
  textType: DiscoveryTextType;
  nodeId?: string | null;
  resourceId?: string | null;
  parentCommentId?: string | null;
  featureEntrypoint?: string | null;
  userId: string;
  /** Seconds; default now */
  timestamp?: number;
}

/** The file's org, name and workspace, and each person's email and billing group there: two queries */
async function factsOf(d1: D1Like, fileKey: string, userIds: string[]) {
  const f = await d1
    .prepare(`SELECT f.key, f.name, f.org_id, t.workspace_id FROM files f LEFT JOIN teams t ON t.id = f.team_id WHERE f.key = ?1`)
    .bind(fileKey)
    .first<{ key: string; name: string; org_id: string | null; workspace_id: string | null }>();
  if (!f?.org_id) return null;
  const { results } = await d1
    .prepare(`SELECT u.id, u.email, m.billing_group_id FROM users u LEFT JOIN org_members m ON m.user_id = u.id AND m.org_id = ?2 WHERE u.id IN (SELECT value FROM json_each(?1))`)
    .bind(JSON.stringify([...new Set(userIds)]), f.org_id)
    .all<{ id: string; email: string; billing_group_id: string | null }>();
  return { file: f, users: new Map(results.map((r) => [r.id, r])) };
}

/**
 * Texts of one file, as events: nothing at all (not even the file's row) unless the file's org has Discovery on —
 * which, with no org on anywhere, is the cached list alone.
 */
export async function fileTextEvents(deps: DiscoveryDeps, fileKey: string, texts: FileText[], orgId?: string | null): Promise<DiscoveryRecord[]> {
  if (!texts.length) return [];
  const on = (await governanceOrgs(deps.db.d1, deps.now?.())).discovery;
  if (!on.size || (orgId !== undefined && (orgId === null || !on.has(orgId)))) return [];
  const facts = await factsOf(deps.db.d1, fileKey, texts.map((t) => t.userId));
  if (!facts || !on.has(facts.file.org_id!)) return [];
  const now = Math.floor((deps.now?.() ?? Date.now()) / 1000);
  return texts.map((t) => {
    const u = facts.users.get(t.userId);
    return {
      org_id: facts.file.org_id!,
      file_key: fileKey,
      text: t.text,
      timestamp: t.timestamp ?? now,
      action_type: t.action,
      file_name: facts.file.name,
      file_workspace_id: facts.file.workspace_id,
      node_id: t.nodeId ?? null,
      text_type: t.textType,
      resource_id: t.resourceId ?? null,
      parent_comment_id: t.parentCommentId ?? null,
      user_id: t.userId,
      user_email: u?.email ?? "",
      user_billing_group_id: u?.billing_group_id ?? null,
      feature_entrypoint: t.featureEntrypoint ?? null,
      moderation_failure_flags: null,
    };
  });
}

/** Comments, reactions and dev resources: the events of one change, written after the answer */
export function recordFileText(deps: DiscoveryDeps, fileKey: string, texts: FileText[], orgId?: string | null): Promise<void> {
  return afterAnswer(deps, async () => recordDiscovery(deps, await fileTextEvents(deps, fileKey, texts, orgId)));
}

// ---- the room's side -------------------------------------------------------------------------------------------------

/** What the file room gives Discovery (FileRoom builds it once; the tests' memory rooms likewise) */
export interface DiscoveryRoom {
  /** The file (the object's name); null while unknown */
  fileKey(): string | null;
  sql: SqlLike;
  now(): number;
  /** The room's own D1 binding (absent: Discovery does nothing) */
  d1: D1Like | null;
  /**
   * The room's REST jobs (rest/roomJobs.ts). `partBytes` answers the part **opened**: with key management on, FileRoom
   * reads it through the room's cipher (`RoomEkm.partBytes`), since `rest_blobs` rows are sealed once stored.
   */
  rest: { run(job: { kind: "discovery_text" }, waitMs: number, wanted: string[]): Promise<JobAnswer>; partBytes(sha1: string): Uint8Array | null | Promise<Uint8Array | null>; dropParts(parts: RestJobPart[]): void };
}

/** The job runs at most this often; a first change after a run waits at least DISCOVERY_QUIET_MS (the person is typing) */
export const DISCOVERY_EVERY_MS = HOUR_MS;
export const DISCOVERY_QUIET_MS = 10 * 60_000;
/** The last writer is persisted at most this often (or when the writer changes) */
const PERSIST_MS = 60_000;
/**
 * A job that fails (no client, no helper, an unreadable answer) is tried again after 1 h, 2 h, 4 h, 8 h, 16 h; after
 * DISCOVERY_MAX_FAILS in a row the room stops asking until someone writes again (ours: helpers aren't woken forever).
 */
export const DISCOVERY_MAX_FAILS = 5;

interface Ledger {
  loaded: boolean;
  writer: string | null;
  at: number;
  persistedAt: number;
  persistedWriter: string | null;
  lastRun: number;
  due: number | null;
  /** Failed runs in a row */
  fails: number;
}
const ledgers = new WeakMap<SqlLike, Ledger>();

function tables(sql: SqlLike): void {
  sql.exec(`CREATE TABLE IF NOT EXISTS discovery_meta (k TEXT PRIMARY KEY, v)`);
  sql.exec(`CREATE TABLE IF NOT EXISTS discovery_text (node_id TEXT NOT NULL, text_type TEXT NOT NULL, hash TEXT NOT NULL, PRIMARY KEY (node_id, text_type))`);
}

function ledgerOf(room: DiscoveryRoom): Ledger {
  let l = ledgers.get(room.sql);
  if (!l) ledgers.set(room.sql, (l = { loaded: false, writer: null, at: -1, persistedAt: -Infinity, persistedWriter: null, lastRun: -1, due: null, fails: 0 }));
  if (!l.loaded) {
    l.loaded = true;
    let rows: { k: string; v: unknown }[] | null = null;
    try {
      rows = room.sql.exec<{ k: string; v: unknown }>(`SELECT k, v FROM discovery_meta`).toArray();
    } catch {
      // no table: Discovery never ran in this room
    }
    if (rows) {
      const meta = new Map(rows.map((r) => [r.k, r.v]));
      l.writer = typeof meta.get("writer") === "string" ? (meta.get("writer") as string) : null;
      l.persistedWriter = l.writer;
      l.at = Number(meta.get("at") ?? -1);
      l.persistedAt = l.at;
      l.lastRun = Number(meta.get("last_run") ?? -1);
      const due = meta.get("due");
      l.due = due === null || due === undefined ? null : Number(due);
      l.fails = Number(meta.get("fails") ?? 0) || 0;
    }
  }
  return l;
}

function persist(room: DiscoveryRoom, l: Ledger): void {
  tables(room.sql);
  for (const [k, v] of [["writer", l.writer], ["at", l.at], ["last_run", l.lastRun], ["due", l.due], ["fails", l.fails]] as const) room.sql.exec(`INSERT OR REPLACE INTO discovery_meta (k, v) VALUES (?, ?)`, k, v);
  l.persistedAt = l.at;
  l.persistedWriter = l.writer;
}

/** Forget the room's cached ledger (after `DELETE /room` wiped its storage) */
export function forgetDiscoveryRoom(room: DiscoveryRoom): void {
  ledgers.delete(room.sql);
}

/** The last frame's time and author since the last run (null: nothing written since) */
export function lastWrite(room: DiscoveryRoom): { at: number; userId: string } | null {
  const l = ledgerOf(room);
  return l.writer && l.at > l.lastRun ? { at: l.at, userId: l.writer } : null;
}

/** When the room's alarm should ring for Discovery (null: nothing to do) */
export function discoveryDue(room: DiscoveryRoom): number | null {
  return ledgerOf(room).due;
}

/**
 * The room's one alarm is shared: whatever else sets it (RoomBox's autosave / FILE_UPDATE after `edited()`, from a
 * socket or any other path) never pushes Discovery's stored due time later. → the time to set (null: none).
 */
export function sharedAlarm(room: DiscoveryRoom, at: number | null): number | null {
  let due: number | null = null;
  try {
    due = discoveryDue(room);
  } catch (e) {
    console.error("discovery", e);
  }
  return at === null ? due : due === null ? at : Math.min(at, due);
}

/**
 * The room's drained capture (`Room.drainDiscovery()`): the last writer is kept (persisted at most once a minute, or
 * when the writer changes) and the hourly job armed; cursor chat messages are recorded at once (`transient`). Returns
 * the time the room's alarm should ring by (null: no change), for the host to set when earlier than its own.
 */
export async function discoveryTake(room: DiscoveryRoom, capture: DiscoveryCapture): Promise<number | null> {
  let due: number | null = null;
  if (capture.wrote) {
    const l = ledgerOf(room);
    const { userId, at } = capture.wrote;
    const changed = l.writer !== userId;
    l.writer = userId;
    l.at = at;
    if (l.due === null) l.due = Math.max(l.lastRun + DISCOVERY_EVERY_MS, at + DISCOVERY_QUIET_MS);
    if (changed || l.persistedWriter !== userId || at - l.persistedAt >= PERSIST_MS || l.persistedAt < 0) persist(room, l);
    due = l.due;
  }
  if (capture.chat.length && room.d1) {
    const key = room.fileKey();
    if (key) {
      const deps: DiscoveryDeps = { db: { d1: room.d1 }, now: () => room.now() };
      await recordDiscovery(
        deps,
        await fileTextEvents(
          deps,
          key,
          capture.chat.map((c) => ({ text: c.text, action: "transient" as const, textType: "cursor_chat" as const, userId: c.userId, timestamp: Math.floor(c.at / 1000) })),
        ),
      );
    }
  }
  return due;
}

const TEXT_TYPES = new Set<DiscoveryTextItem["textType"]>(["in_file", "dev_mode_annotation", "component_documentation_link", "component_documentation_description"]);

/** The job's part: `DiscoveryTextItem[]` as JSON, gzipped or not */
export async function readTextItems(bytes: Uint8Array): Promise<DiscoveryTextItem[] | null> {
  let raw = bytes;
  if (raw[0] === 0x1f && raw[1] === 0x8b) raw = new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer());
  let list: unknown;
  try {
    list = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    return null;
  }
  if (!Array.isArray(list)) return null;
  const out: DiscoveryTextItem[] = [];
  for (const x of list as Record<string, unknown>[]) {
    if (!x || typeof x.nodeId !== "string" || typeof x.text !== "string" || !TEXT_TYPES.has(x.textType as DiscoveryTextItem["textType"])) continue;
    if (x.nodeId.length > 64 || !x.text.trim()) continue;
    out.push({ nodeId: x.nodeId, textType: x.textType as DiscoveryTextItem["textType"], text: x.text.slice(0, MAX_TEXT) });
  }
  return out;
}

const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
const textHash = async (t: string) => hex(await crypto.subtle.digest("SHA-1", new TextEncoder().encode(t)));

/**
 * The answer against the room's table: new nodes are `insert`, changed texts `update`, nodes gone `delete` (their text
 * isn't kept — only its hash — so a delete's `text` is empty: ours). The table takes the answer.
 */
export async function diffTexts(sql: SqlLike, items: DiscoveryTextItem[]): Promise<{ action: "insert" | "update" | "delete"; nodeId: string; textType: DiscoveryTextItem["textType"]; text: string }[]> {
  tables(sql);
  const before = new Map(sql.exec<{ node_id: string; text_type: string; hash: string }>(`SELECT node_id, text_type, hash FROM discovery_text`).toArray().map((r) => [`${r.text_type} ${r.node_id}`, r.hash]));
  const out: Awaited<ReturnType<typeof diffTexts>> = [];
  const seen = new Set<string>();
  const next: { nodeId: string; textType: string; hash: string }[] = [];
  for (const it of items) {
    const k = `${it.textType} ${it.nodeId}`;
    if (seen.has(k)) continue;
    seen.add(k);
    const h = await textHash(it.text);
    const old = before.get(k);
    if (old === undefined) out.push({ action: "insert", ...it });
    else if (old !== h) out.push({ action: "update", ...it });
    if (old !== h) next.push({ nodeId: it.nodeId, textType: it.textType, hash: h });
  }
  const gone: string[] = [];
  for (const k of before.keys()) {
    if (seen.has(k)) continue;
    const [textType, ...rest] = k.split(" ");
    out.push({ action: "delete", nodeId: rest.join(" "), textType: textType as DiscoveryTextItem["textType"], text: "" });
    gone.push(k);
  }
  for (const n of next) sql.exec(`INSERT OR REPLACE INTO discovery_text (node_id, text_type, hash) VALUES (?, ?, ?)`, n.nodeId, n.textType, n.hash);
  for (const k of gone) {
    const [textType, ...rest] = k.split(" ");
    sql.exec(`DELETE FROM discovery_text WHERE node_id = ? AND text_type = ?`, rest.join(" "), textType);
  }
  return out;
}

/** Who may start a render helper for this file: its owner and editors (as rest/jobs.ts `wantedFor`) */
async function wantedOf(d1: D1Like, fileKey: string): Promise<string[]> {
  const { results } = await d1
    .prepare(`SELECT owner_id AS id FROM files WHERE key = ?1 UNION SELECT user_id AS id FROM members WHERE file_key = ?1 AND role = 'editor' AND user_id IS NOT NULL`)
    .bind(fileKey)
    .all<{ id: string }>();
  return results.map((r) => r.id);
}

/**
 * The room's alarm: when a change is waiting and its time came, and the file's org still has Discovery on, runs the
 * `discovery_text` job (never cached), diffs it and records the events at the job's time, attributed to the window's
 * last writer. No client and no helper: tried again in an hour (late events land in a later hour; past hours never
 * change). Returns when the room's alarm should ring next for Discovery (null: nothing waiting).
 */
export async function discoveryAlarm(room: DiscoveryRoom): Promise<number | null> {
  const l = ledgerOf(room);
  const now = room.now();
  if (l.due === null || now < l.due) return l.due;
  const key = room.fileKey();
  const write = lastWrite(room);
  const deps: DiscoveryDeps | null = room.d1 ? { db: { d1: room.d1 }, now: () => room.now() } : null;
  const orgRow = deps && key ? await room.d1!.prepare(`SELECT org_id FROM files WHERE key = ?1`).bind(key).first<{ org_id: string | null }>() : null;
  if (!deps || !key || !write || !(await discoveryOn(deps.db.d1, orgRow?.org_id ?? null, now))) {
    // Off (or nothing to attribute): forget the change, no job.
    l.due = null;
    l.lastRun = now;
    persist(room, l);
    return null;
  }
  const answer = await room.rest.run({ kind: "discovery_text" }, REST_TIMING.waitMs, await wantedOf(room.d1!, key));
  const part = answer.ok ? answer.parts.find((p) => p.name === "json") : undefined;
  // Opened through the room's cipher (a sealed part can't be parsed); a part that can't be opened is a failed run
  const bytes = part ? await Promise.resolve(room.rest.partBytes(part.sha1)).catch((e) => (console.error("discovery: the part couldn't be read", e), null)) : null;
  if (answer.ok) room.rest.dropParts(answer.parts);
  const items = bytes ? await readTextItems(bytes).catch(() => null) : null;
  if (!items) {
    // Backed off; given up after DISCOVERY_MAX_FAILS until the next write arms it again (discoveryTake)
    l.fails++;
    l.due = l.fails >= DISCOVERY_MAX_FAILS ? null : room.now() + DISCOVERY_EVERY_MS * 2 ** (l.fails - 1);
    if (l.due === null) l.fails = 0;
    persist(room, l);
    return l.due;
  }
  l.fails = 0;
  const changes = await diffTexts(room.sql, items);
  const at = Math.floor(room.now() / 1000);
  await recordDiscovery(
    deps,
    await fileTextEvents(
      deps,
      key,
      changes.map((c) => ({ text: c.text, action: c.action, textType: c.textType, nodeId: c.nodeId, userId: write.userId, timestamp: at })),
      orgRow?.org_id ?? null,
    ),
  );
  // Frames that came while the job ran wait for the next one.
  l.lastRun = now;
  l.due = l.writer && l.at > now ? Math.max(now + DISCOVERY_EVERY_MS, l.at + DISCOVERY_QUIET_MS) : null;
  persist(room, l);
  return l.due;
}

// ---- retention (the daily cron) --------------------------------------------------------------------------------------

/** Discovery events and developer logs older than 30 days go (docs/governance.md §2.11, §2.12) */
export async function sweepGovernanceLogs(d1: D1Like, now: number): Promise<void> {
  await d1.prepare(`DELETE FROM discovery_events WHERE timestamp < ?1`).bind(Math.floor((now - DISCOVERY_RETENTION_MS) / 1000)).run();
  await d1.prepare(`DELETE FROM developer_logs WHERE at < ?1`).bind(now - DEVELOPER_LOGS_RETENTION_MS).run();
}
