/**
 * REST render jobs, the room's side (docs/multiplayer.md §16.6): pure over the room's SQL and its `Room`, so `FileRoom`
 * and Node's tests (testing/memoryRooms.ts) run the same code.
 *
 *   POST /room/rest-job {job, waitMs, wanted}        → {ok: true, parts, cached, jobKey} | {ok: false, status, err}
 *   PUT  /room/rest-parts/:id/:name   (x-user-id)    a part's bytes from the member the job went to (SHA-1 kept)
 *   GET  /room/rest-blob/:sha1                       a part (or an image fill: the room's `blobs`)
 *   GET  /room/rest-images                           {sha1s}: the image fills the room holds
 *   PUT  /room/thumbnail · GET /room/thumbnail       the file's thumbnail (PNG, ≤ 2 MB; x-sha1)
 *
 * A job: the cache by job key (SHA-1 of {kind, params sorted, seq | version}) first; else the members that can render,
 * in `Room.renderers()` order (editor idle longest › viewer › helper), each given `clientMs` (20 s) until one answers
 * `rest-job-done` with every part uploaded; nobody → `wanted` (the Worker's list of people whose desktop app may start
 * its render helper, sent `{t: "rest-wanted", fileKey}` through their inboxes), then wait for a renderer to join within
 * `waitMs`. `variables_post` is never cached and needs a member who can edit.
 *
 * Storage (as built — ours, not the room's `blobs`, so a cache eviction never touches an image fill): `rest_blobs`
 * (parts by SHA-1, 1 MB rows) and `rest_cache` (job key → parts, size, created / used). Results are dropped least
 * recently used once they pass 64 MB, and after 30 days. The tables are a cache: a move to another region doesn't copy
 * them (roomBox.ts ROOM_TABLES leaves them out).
 */
import type { RestJob, RestJobPart } from "../../../src/shared/rest/types";
import type { Connection, MemberState, RestAnswer, Room } from "../../../src/shared/multiplayer/room";
import type { SqlLike } from "../previews";

/** Timing (tests lower these) */
export const REST_TIMING = { clientMs: 20_000, waitMs: 25_000 };
export const REST_CACHE_BYTES = 64 * 1024 * 1024;
export const REST_CACHE_DAYS = 30;
export const MAX_PART_BYTES = 64 * 1024 * 1024;
export const MAX_THUMBNAIL_BYTES = 2 * 1024 * 1024;
const CHUNK = 1024 * 1024;
const THUMB_KEY = "thumbnail";

export type JobAnswer = { ok: true; parts: RestJobPart[]; cached: boolean; jobKey: string | null } | { ok: false; status: number; err: string };

export interface RestJobsHost {
  sql: SqlLike;
  transaction(fn: () => void): void;
  /** Milliseconds (cache dates) */
  now(): number;
  room: Room;
  /** The room's head (the job key's seq) */
  lastSeq(): number;
  /** Does the room hold this version? */
  hasVersion(id: string): boolean;
  /** `{t: "rest-wanted", fileKey}` to these people's inboxes */
  wanted(userIds: string[]): Promise<void>;
}

interface Pending {
  id: string;
  conn: Connection;
  userId: string;
  uploads: Map<string, { sha1: string; size: number }>;
  done(a: RestAnswer | null): void;
}

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8" } });

const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
export const sha1Hex = async (bytes: Uint8Array | string): Promise<string> => hex(await crypto.subtle.digest("SHA-1", typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes));

/** Stable JSON: keys sorted at every level */
export function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v as Record<string, unknown>)
      .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v);
}

/** §16.6's job key: SHA-1 of {kind, params sorted, seq | version}; null for jobs never cached */
export async function jobKeyOf(job: RestJob, seq: number): Promise<string | null> {
  if (job.kind === "variables_post") return null;
  const params = "params" in job ? job.params : {};
  return sha1Hex(canonical({ kind: job.kind, params, at: versionOf(job) ? `v:${versionOf(job)}` : `s:${seq}` }));
}

/** The version a job reads (none: the room's head) */
const versionOf = (job: RestJob): string | undefined => ("version" in job ? job.version : undefined);

const PART_NAME = /^[A-Za-z0-9:;_.-]{1,200}$/;

export class RestJobs {
  private pending = new Map<string, Pending>();
  private waiters: (() => void)[] = [];
  private inflight = new Map<string, Promise<JobAnswer>>();

  constructor(private host: RestJobsHost) {
    this.reset();
  }

  reset(): void {
    this.host.sql.exec(`CREATE TABLE IF NOT EXISTS rest_blobs (sha1 TEXT NOT NULL, idx INTEGER NOT NULL, bytes BLOB NOT NULL, PRIMARY KEY (sha1, idx))`);
    this.host.sql.exec(`CREATE TABLE IF NOT EXISTS rest_cache (job_key TEXT PRIMARY KEY, parts TEXT NOT NULL, size INTEGER NOT NULL, created_at INTEGER NOT NULL, used_at INTEGER NOT NULL)`);
  }

  /** Room.onRest */
  answer(conn: Connection, member: MemberState, a: RestAnswer): void {
    const p = this.pending.get(a.id);
    if (!p || p.conn !== conn || p.userId !== member.userId) return;
    p.done(a);
  }

  /** Room.onRenderer: a job waiting for someone to render goes on */
  renderer(): void {
    const w = this.waiters.splice(0);
    for (const f of w) f();
  }

  /** The /room/rest… routes; null for the others */
  async fetch(req: Request): Promise<Response | null> {
    const url = new URL(req.url);
    const path = url.pathname;
    const m = req.method;
    if (path === "/room/rest-job" && m === "POST") {
      const b = (await req.json()) as { job?: RestJob; waitMs?: number; wanted?: string[] };
      if (!b.job || typeof b.job !== "object") return json({ ok: false, status: 400, err: "no job" }, 400);
      return json(await this.run(b.job, Math.min(Number(b.waitMs) || REST_TIMING.waitMs, REST_TIMING.waitMs), Array.isArray(b.wanted) ? b.wanted.filter((x) => typeof x === "string") : []));
    }
    const part = /^\/room\/rest-parts\/([A-Za-z0-9_-]{8,64})\/([^/]+)$/.exec(path);
    if (part && m === "PUT") {
      const p = this.pending.get(part[1]);
      const name = decodeURIComponent(part[2]);
      if (!p || p.userId !== req.headers.get("x-user-id")) return json({ error: "no such job for you" }, 404);
      if (!PART_NAME.test(name)) return json({ error: "bad part name" }, 400);
      const bytes = new Uint8Array(await req.arrayBuffer());
      if (bytes.length > MAX_PART_BYTES) return json({ error: "part too large" }, 413);
      const sha1 = await sha1Hex(bytes);
      this.putBlob(sha1, bytes);
      p.uploads.set(name, { sha1, size: bytes.length });
      return json({ ok: true, sha1, size: bytes.length });
    }
    const blob = /^\/room\/rest-blob\/([0-9a-f]{40})$/.exec(path);
    if (blob && m === "GET") {
      let rows = this.host.sql.exec<{ bytes: ArrayBuffer }>(`SELECT bytes FROM rest_blobs WHERE sha1 = ? ORDER BY idx`, blob[1]).toArray();
      if (!rows.length) rows = this.host.sql.exec<{ bytes: ArrayBuffer }>(`SELECT bytes FROM blobs WHERE sha1 = ? ORDER BY idx`, blob[1]).toArray();
      if (!rows.length) return new Response("no such blob", { status: 404 });
      return new Response(concat(rows), { headers: { "content-type": "application/octet-stream" } });
    }
    if (path === "/room/rest-images" && m === "GET") {
      return json({ sha1s: this.host.sql.exec<{ sha1: string }>(`SELECT sha1 FROM blobs WHERE idx = 0 ORDER BY sha1`).toArray().map((r) => r.sha1) });
    }
    if (path === "/room/thumbnail" && m === "PUT") {
      const bytes = new Uint8Array(await req.arrayBuffer());
      if (bytes.length > MAX_THUMBNAIL_BYTES) return json({ error: "thumbnail too large" }, 413);
      const sha1 = await sha1Hex(bytes);
      const now = this.host.now();
      this.host.transaction(() => {
        this.putBlob(sha1, bytes);
        this.host.sql.exec(`INSERT OR REPLACE INTO rest_cache (job_key, parts, size, created_at, used_at) VALUES (?, ?, ?, ?, ?)`, THUMB_KEY, JSON.stringify([{ name: "thumbnail", sha1, size: bytes.length, contentType: "image/png" }]), bytes.length, now, now);
        this.collect();
      });
      return json({ ok: true, sha1 });
    }
    if (path === "/room/thumbnail" && m === "GET") {
      const t = this.cacheRow(THUMB_KEY);
      if (!t) return new Response("no thumbnail", { status: 404 });
      const rows = this.host.sql.exec<{ bytes: ArrayBuffer }>(`SELECT bytes FROM rest_blobs WHERE sha1 = ? ORDER BY idx`, t.parts[0].sha1).toArray();
      return new Response(concat(rows), { headers: { "content-type": "image/png", "x-sha1": t.parts[0].sha1 } });
    }
    return null;
  }

  /** A job: cache, then the members in order; the same job asked twice at once runs once */
  async run(job: RestJob, waitMs: number, wanted: string[]): Promise<JobAnswer> {
    const version = versionOf(job);
    if (version && !this.host.hasVersion(version)) return { ok: false, status: 404, err: "Version not found" };
    const key = await jobKeyOf(job, this.host.lastSeq());
    if (key) {
      const hit = this.cacheRow(key);
      if (hit) {
        this.host.sql.exec(`UPDATE rest_cache SET used_at = ? WHERE job_key = ?`, this.host.now(), key);
        return { ok: true, parts: hit.parts, cached: true, jobKey: key };
      }
      const running = this.inflight.get(key);
      if (running) return running;
      const p = this.dispatch(job, key, waitMs, wanted);
      this.inflight.set(key, p);
      try {
        return await p;
      } finally {
        this.inflight.delete(key);
      }
    }
    return this.dispatch(job, null, waitMs, wanted);
  }

  private async dispatch(job: RestJob, key: string | null, waitMs: number, wanted: string[]): Promise<JobAnswer> {
    const deadline = Date.now() + waitMs;
    const canEdit = job.kind === "variables_post";
    const tried = new Set<Connection>();
    let asked = false;
    for (;;) {
      const next = this.host.room.renderers({ canEdit }).find((c) => !tried.has(c));
      if (!next) {
        // Nobody (left) to ask: the render helpers of the file's people may start, once (§16.6).
        if (!asked && wanted.length) {
          asked = true;
          await this.host.wanted(wanted).catch(() => undefined);
          continue; // a helper may have joined meanwhile
        }
        if (!(await this.waitRenderer(deadline))) return { ok: false, status: 503, err: "No client available to render this file. Open the file in DesignerV2 and try again." };
        continue;
      }
      tried.add(next);
      const left = deadline - Date.now();
      if (left <= 0) break;
      const a = await this.ask(next, job, Math.min(REST_TIMING.clientMs, left));
      if (!a) continue; // timed out or left: the next one
      if (a.ok) {
        if (key) this.commit(key, a.parts);
        return { ok: true, parts: a.parts, cached: false, jobKey: key };
      }
      return a;
    }
    return { ok: false, status: 503, err: "No client available to render this file. Open the file in DesignerV2 and try again." };
  }

  /** Wait for a member that can render to say hello (false: the deadline passed) */
  private waitRenderer(deadline: number): Promise<boolean> {
    const left = deadline - Date.now();
    if (left <= 0) return Promise.resolve(false);
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== wake);
        resolve(false);
      }, left);
      const wake = () => {
        clearTimeout(t);
        resolve(true);
      };
      this.waiters.push(wake);
    });
  }

  /** One member: the job, then its answer within `ms` (null: no answer, a part missing, or it left) */
  private ask(conn: Connection, job: RestJob, ms: number): Promise<{ ok: true; parts: RestJobPart[] } | { ok: false; status: number; err: string } | null> {
    const member = this.host.room.member(conn);
    if (!member) return Promise.resolve(null);
    const id = randomId();
    return new Promise((resolve) => {
      const timer = setTimeout(() => finish(null), ms);
      const finish = (a: RestAnswer | null) => {
        clearTimeout(timer);
        const p = this.pending.get(id);
        this.pending.delete(id);
        if (!a || !p) return resolve(null);
        if (a.t === "rest-job-failed") return resolve(failure(job, a.err));
        const parts = Array.isArray(a.parts) ? a.parts : [];
        // Every part the client names must be the bytes it uploaded.
        for (const part of parts) {
          const up = p.uploads.get(part?.name);
          if (!up || up.sha1 !== part.sha1 || up.size !== part.size) return resolve(null);
        }
        resolve({ ok: true, parts: parts.map((x) => ({ name: x.name, sha1: x.sha1, size: x.size, contentType: typeof x.contentType === "string" ? x.contentType : "application/octet-stream" })) });
      };
      this.pending.set(id, { id, conn, userId: member.userId, uploads: new Map(), done: finish });
      try {
        this.host.room.sendJob(conn, id, job);
      } catch {
        finish(null);
      }
    });
  }

  private cacheRow(key: string): { parts: RestJobPart[] } | null {
    const r = this.host.sql.exec<{ parts: string }>(`SELECT parts FROM rest_cache WHERE job_key = ?`, key).toArray()[0];
    return r ? { parts: JSON.parse(r.parts) as RestJobPart[] } : null;
  }

  private commit(key: string, parts: RestJobPart[]): void {
    const now = this.host.now();
    this.host.transaction(() => {
      this.host.sql.exec(`INSERT OR REPLACE INTO rest_cache (job_key, parts, size, created_at, used_at) VALUES (?, ?, ?, ?, ?)`, key, JSON.stringify(parts), parts.reduce((n, p) => n + p.size, 0), now, now);
      this.host.sql.exec(`DELETE FROM rest_cache WHERE created_at < ? AND job_key <> ?`, now - REST_CACHE_DAYS * 86_400_000, THUMB_KEY);
      // LRU over 64 MB (the thumbnail stays)
      const rows = this.host.sql.exec<{ job_key: string; size: number }>(`SELECT job_key, size FROM rest_cache WHERE job_key <> ? ORDER BY used_at DESC, created_at DESC`, THUMB_KEY).toArray();
      let total = 0;
      for (const r of rows) {
        total += r.size;
        if (total > REST_CACHE_BYTES && r.job_key !== key) this.host.sql.exec(`DELETE FROM rest_cache WHERE job_key = ?`, r.job_key);
      }
      this.collect();
    });
  }

  /** Parts no cache entry (nor a job running now) refers to */
  private collect(): void {
    const keep = new Set<string>();
    for (const r of this.host.sql.exec<{ parts: string }>(`SELECT parts FROM rest_cache`).toArray()) for (const p of JSON.parse(r.parts) as RestJobPart[]) keep.add(p.sha1);
    for (const p of this.pending.values()) for (const u of p.uploads.values()) keep.add(u.sha1);
    for (const r of this.host.sql.exec<{ sha1: string }>(`SELECT DISTINCT sha1 FROM rest_blobs`).toArray()) if (!keep.has(r.sha1)) this.host.sql.exec(`DELETE FROM rest_blobs WHERE sha1 = ?`, r.sha1);
  }

  private putBlob(sha1: string, bytes: Uint8Array): void {
    if (this.host.sql.exec(`SELECT sha1 FROM rest_blobs WHERE sha1 = ? AND idx = 0`, sha1).toArray().length) return;
    for (let i = 0, idx = 0; i < bytes.length || idx === 0; i += CHUNK, idx++) this.host.sql.exec(`INSERT OR REPLACE INTO rest_blobs (sha1, idx, bytes) VALUES (?, ?, ?)`, sha1, idx, bytes.slice(i, i + CHUNK).buffer);
  }
}

/** A client's failure: "404 Version not found" carries its status; otherwise 400 for variables_post, 500 for the rest */
function failure(job: RestJob, err: unknown): { ok: false; status: number; err: string } {
  const text = typeof err === "string" ? err.slice(0, 2000) : "the client couldn't run the job";
  const m = /^([45]\d\d) (.*)$/s.exec(text);
  if (m) return { ok: false, status: Number(m[1]), err: m[2] };
  return { ok: false, status: job.kind === "variables_post" ? 400 : 500, err: text };
}

function concat(rows: { bytes: ArrayBuffer }[]): Uint8Array {
  const out = new Uint8Array(rows.reduce((n, r) => n + r.bytes.byteLength, 0));
  let at = 0;
  for (const r of rows) {
    out.set(new Uint8Array(r.bytes), at);
    at += r.bytes.byteLength;
  }
  return out;
}

function randomId(): string {
  return [...crypto.getRandomValues(new Uint8Array(12))].map((b) => b.toString(16).padStart(2, "0")).join("");
}
