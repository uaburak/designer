/**
 * Branches of shared files and the rooms' version history on the server (docs/data.md §15.7; Phase 7 round 2c).
 *
 * A branch of a shared main is itself shared: its own `files` row (same org, team and folder as main), its own
 * `FileRoom`, and a `branches` row (migration 0011) linking it to main. Access goes through main (branchAccess.ts,
 * `Access.file`). The merge itself is computed by the client (the store's merge core) and sent here as one batch, which
 * the target room orders like any frame — if and only if its head is still the one the merge read (`stale` otherwise).
 *
 *   POST  /files/:main/branches                 can view main (+ copy), Full seat in an org
 *                                               {branchKey, name, baseSeq} → 201 {branch, sessionBase, mainVersionId};
 *                                               then the client uploads the branch's snapshot
 *                                               (PUT /files/:branchKey/snapshot?seq=0 — "Branch created") and its base
 *                                               (PUT /branches/:branchKey/base?seq=<baseSeq>)
 *   GET   /files/:main/branches?tab=active|archived|yours                     → {branches}
 *   GET   /files/:key/versions                   can view                     → {versions} (newest first)
 *   POST  /files/:key/versions                   can edit   {kind: autosave|named|restore|publish|import, title?,
 *                                               description?, seq?, restoredFrom?, libraryVersion?} → 201 {version}
 *   GET   /files/:key/versions/:id               can view                     → {version}
 *   PATCH /files/:key/versions/:id               can edit   {title?, description?} → {version} (an autosave named
 *                                               becomes "named")
 *   GET   /files/:key/versions/:id/snapshot      can view   the snapshot it starts from (x-seq, x-snapshot-seq)
 *   GET   /files/:key/versions/:id/frames        can view   [u32 length][changes-down frame]… after it, up to x-seq
 *   PUT   /files/:key/versions/:id/snapshot      can edit   the client's own snapshot of the version (no frames after)
 *
 *   GET    /branches/:key                        can view branch                → {branch}
 *   PATCH  /branches/:key                        can edit main, or the creator  {name?, status?: archived|active}
 *   DELETE /branches/:key                        can edit main, or the creator  an archived / merged branch, forever
 *   GET    /branches/:key/main                   can view branch   → {changed, mainHeadSeq, baseSeq, mainSeenSeq}
 *   POST   /branches/:key/seen                   can view branch   {mainSeq} → {branch}
 *   GET    /branches/:key/base · PUT …?seq=      can view / can edit the branch: the base snapshot (a later PUT is
 *                                               staged until the update that absorbs it)
 *   POST   /branches/:key/update                 can edit the branch   envelope {mainSeq, branchSeq, sessionID?, batch?}
 *                                               + batch → {branch, seq, versionId}
 *   POST   /branches/:key/merge                  can edit main   envelope {mainSeq, branchSeq, title?, description?,
 *                                               sessionID?, batch?} + batch → {branch, mainSeq, versionId,
 *                                               preVersionId, branchVersionId}
 *   GET    /branches/:key/reviews                can view branch   → {reviews}
 *   POST   /branches/:key/reviews                can view branch   {reviewerIds, description} → {review}
 *   POST   /branches/:key/reviews/:id/verdict    a reviewer        {verdict, comment?} → {review}
 *
 * The envelope is roomBox.ts `encodeEnvelope`: `[u32 BE json length][JSON][kiwi Message]`.
 */
import type { Role } from "../../src/shared/multiplayer/protocol";
import type { AccessGranted, AccessResult } from "../../src/shared/org/access";
import type { ActivityAction } from "../../src/shared/org/types";
import { logActivity, repoEntity } from "./activity";
import type { Deps } from "./api";
import type { BranchRow } from "./branchAccess";
import { normalizeEmail } from "./db";
import { canOpen, type FileRow } from "./org/db";
import { body, cleanName, HttpError, json, noContent, randomId, type Ctx, type ErrorCode } from "./org/http";
import { reauth } from "./org/reauth";
import { notifyBranchMerged, notifyBranchReview, notifyBranchVerdict, notifyInvite } from "./notifications";
import { decodeEnvelope, encodeEnvelope, SESSION_BLOCK, type ApplyMeta } from "./roomBox";

const FILE_KEY = /^[A-Za-z0-9_-]{6,64}$/;
const VERSION_ID = /^[0-9A-Za-z]{16}$/;
const MAX_SNAPSHOT_BYTES = 90 * 1024 * 1024;
/** A merge or update batch: a frame (MAX_FRAME_BYTES) plus its envelope */
const MAX_ENVELOPE_BYTES = 2 * 1024 * 1024;
/** Kinds a client may write; "branch", "update" and "merge" are made by the branch routes */
const CLIENT_KINDS = ["autosave", "named", "restore", "publish", "import"];

// --- Shapes ------------------------------------------------------------------------------------------------------------

export interface BranchReviewJson {
  id: string;
  state: "in-review" | "approved" | "changes-suggested" | "closed";
  requestedBy: string | null;
  description: string;
  createdAt: number;
  updatedAt: number;
  reviewers: { userId: string; name: string | null; verdict: "pending" | "approved" | "changes-suggested"; comment: string; at: number | null }[];
}

/** A branch as the routes answer it: data.md §15.2's `BranchRecord` with the room's fields (the store maps it) */
export interface BranchJson {
  branchKey: string;
  mainKey: string;
  name: string;
  status: BranchRow["status"];
  createdBy: { id: string; name: string | null };
  createdAt: number;
  baseSeq: number;
  mainSeenSeq: number;
  sessionBase: number;
  archivedAt: number | null;
  archivedBy: string | null;
  mergedAt: number | null;
  mergedBy: string | null;
  mergeVersionId: string | null;
  review: BranchReviewJson | null;
}

type Row = BranchRow & { creator_name: string | null; creator_email: string | null };

const SELECT = `SELECT b.*, u.name AS creator_name, u.email AS creator_email FROM branches b LEFT JOIN users u ON u.id = b.created_by`;

async function reviewsOf(deps: Deps, branchKey: string, latestOnly: boolean): Promise<BranchReviewJson[]> {
  const d1 = deps.db.d1;
  const { results } = await d1
    .prepare(`SELECT * FROM branch_reviews WHERE branch_key = ?1 ORDER BY created_at DESC, id DESC ${latestOnly ? "LIMIT 1" : ""}`)
    .bind(branchKey)
    .all<{ id: string; requested_by: string; description: string; state: BranchReviewJson["state"]; created_at: number; updated_at: number }>();
  const out: BranchReviewJson[] = [];
  for (const r of results) {
    const { results: people } = await d1
      .prepare(`SELECT r.user_id, r.verdict, r.comment, r.at, u.name, u.email FROM branch_reviewers r LEFT JOIN users u ON u.id = r.user_id WHERE r.review_id = ?1 ORDER BY u.email`)
      .bind(r.id)
      .all<{ user_id: string; verdict: BranchReviewJson["reviewers"][number]["verdict"]; comment: string; at: number | null; name: string | null; email: string | null }>();
    out.push({
      id: r.id,
      state: r.state,
      requestedBy: r.requested_by,
      description: r.description,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      reviewers: people.map((p) => ({ userId: p.user_id, name: p.name || p.email, verdict: p.verdict, comment: p.comment, at: p.at })),
    });
  }
  return out;
}

async function toJson(deps: Deps, r: Row): Promise<BranchJson> {
  return {
    branchKey: r.key,
    mainKey: r.main_key,
    name: r.name,
    status: r.status,
    createdBy: { id: r.created_by, name: r.creator_name || r.creator_email },
    createdAt: r.created_at,
    baseSeq: r.base_seq,
    mainSeenSeq: r.main_seen_seq,
    sessionBase: r.session_base,
    archivedAt: r.archived_at,
    archivedBy: r.archived_by,
    mergedAt: r.merged_at,
    mergedBy: r.merged_by,
    mergeVersionId: r.merge_version,
    review: (await reviewsOf(deps, r.key, true))[0] ?? null,
  };
}

async function branchJson(deps: Deps, key: string): Promise<BranchJson> {
  const r = await deps.db.d1.prepare(`${SELECT} WHERE b.key = ?1`).bind(key).first<Row>();
  if (!r) throw new HttpError(404, "no such branch");
  return toJson(deps, r);
}

/** `branch` of GET /files/:key: the file's main and branch name when it is a branch, else null */
export async function branchInfo(deps: Deps, key: string): Promise<{ mainKey: string; mainName: string; name: string; status: BranchRow["status"] } | null> {
  const r = await deps.db.d1.prepare(`SELECT b.main_key, b.name, b.status, f.name AS main_name FROM branches b JOIN files f ON f.key = b.main_key WHERE b.key = ?1`).bind(key).first<{ main_key: string; name: string; status: BranchRow["status"]; main_name: string }>();
  return r ? { mainKey: r.main_key, mainName: r.main_name, name: r.name, status: r.status } : null;
}

// --- Rooms --------------------------------------------------------------------------------------------------------------

type Identity = { userId: string; name: string | null; role: Role };

/** A room's JSON answer; its refusals become HttpErrors (`stale` keeps its code). */
async function roomJson<T>(deps: Deps, key: string, path: string, init: { method: string; body?: RequestInit["body"]; identity?: Identity }): Promise<T> {
  const res = await deps.rooms.fetch(key, path, { method: init.method, body: init.body, identity: init.identity });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const { error, code, ...rest } = data;
    const c: ErrorCode | undefined = code === "stale" ? "stale" : undefined;
    throw new HttpError(res.status, typeof error === "string" ? error : "the file's room refused", c, rest);
  }
  return data as T;
}

interface Head {
  lastSeq: number;
  snapshotSeq: number;
  baseSeq: number | null;
  baseNextSeq: number | null;
  frozen: boolean;
}

const headOf = (deps: Deps, key: string) => roomJson<Head>(deps, key, "/room/head", { method: "GET" });

/** A room's answer passed on as it is (bytes with their headers), its refusals as HttpErrors */
async function passThrough(deps: Deps, key: string, path: string, init: { method: string; body?: RequestInit["body"]; identity?: Identity }): Promise<Response> {
  const res = await deps.rooms.fetch(key, path, { method: init.method, body: init.body, identity: init.identity });
  if (res.ok) return res;
  const text = await res.text();
  let msg = text;
  try {
    msg = (JSON.parse(text) as { error?: string }).error ?? text;
  } catch {
    // plain text
  }
  throw new HttpError(res.status, msg || "the file's room refused");
}

// --- /files/:key/branches and /files/:key/versions -------------------------------------------------------------------------

/** The routes under a file: its branches (when main) and its version history (any shared file). */
export async function fileBranchesRoute(ctx: Ctx, f: FileRow, a: AccessGranted | null): Promise<Response> {
  const { deps, user, parts, m, url, acc } = ctx;
  if (!a) throw new HttpError(403, "password required", "password_required");
  const key = f.key;
  const identity: Identity = { userId: user.id, name: user.name, role: a.roomRole };
  const canEdit = a.canEdit && !a.trashed;

  if (parts[2] === "branches" && parts.length === 3) {
    const own = await acc.branch(key);
    if (m === "GET") {
      if (own) throw new HttpError(400, "a branch has no branches");
      const tab = url.searchParams.get("tab") ?? "active";
      const where = tab === "archived" ? `b.status IN ('archived', 'merged')` : tab === "yours" ? `b.created_by = ?2` : `b.status = 'active'`;
      const stmt = deps.db.d1.prepare(`${SELECT} WHERE b.main_key = ?1 AND ${where} ORDER BY b.created_at DESC`);
      const { results } = await (tab === "yours" ? stmt.bind(key, user.id) : stmt.bind(key)).all<Row>();
      const branches: BranchJson[] = [];
      for (const r of results) branches.push(await toJson(deps, r));
      return json({ branches });
    }
    if (m === "POST") return json(await createBranch(ctx, f, a, own !== null), 201);
    throw new HttpError(405, "method not allowed");
  }

  if (parts[2] !== "versions") throw new HttpError(404, "not found");
  if (parts.length === 3) {
    if (m === "GET") return passThrough(deps, key, "/room/versions", { method: "GET", identity });
    if (m === "POST") {
      if (!canEdit) throw new HttpError(403, "you can only view this file");
      const b = await body<Record<string, unknown>>(ctx.req);
      if (typeof b.kind !== "string" || !CLIENT_KINDS.includes(b.kind)) throw new HttpError(400, `kind is one of ${CLIENT_KINDS.join(", ")}`);
      // Publishing a library happens only from main (§15.5 "Elsewhere").
      if (b.kind === "publish" && (await acc.branch(key))) throw new HttpError(400, "publish libraries from the main file", "branch_cannot_publish");
      if (b.seq !== undefined && b.seq !== null && (!Number.isInteger(b.seq) || (b.seq as number) < 0)) throw new HttpError(400, "bad seq");
      if (b.restoredFrom !== undefined && b.restoredFrom !== null && (typeof b.restoredFrom !== "string" || !VERSION_ID.test(b.restoredFrom))) throw new HttpError(400, "bad restoredFrom");
      const res = await roomJson<{ version: unknown }>(deps, key, "/room/versions", {
        method: "POST",
        identity,
        body: JSON.stringify({ kind: b.kind, title: b.title, description: b.description, seq: b.seq, restoredFrom: b.restoredFrom, libraryVersion: b.libraryVersion }),
      });
      return json(res, 201);
    }
    throw new HttpError(405, "method not allowed");
  }
  const id = parts[3];
  if (!VERSION_ID.test(id) || parts.length > 5) throw new HttpError(404, "no such version");
  const sub = parts[4];
  if (!sub) {
    if (m === "GET") return passThrough(deps, key, `/room/versions/${id}`, { method: "GET", identity });
    if (m === "PATCH") {
      if (!canEdit) throw new HttpError(403, "you can only view this file");
      const b = await body<{ title?: unknown; description?: unknown }>(ctx.req);
      return json(await roomJson(deps, key, `/room/versions/${id}`, { method: "PATCH", identity, body: JSON.stringify({ title: b.title, description: b.description }) }));
    }
  } else if (sub === "snapshot" || sub === "frames") {
    if (m === "GET") return passThrough(deps, key, `/room/versions/${id}/${sub}`, { method: "GET", identity });
    if (m === "PUT" && sub === "snapshot") {
      if (!canEdit) throw new HttpError(403, "you can only view this file");
      const bytes = await ctx.req.arrayBuffer();
      if (bytes.byteLength > MAX_SNAPSHOT_BYTES) throw new HttpError(413, "snapshot too large");
      return json(await roomJson(deps, key, `/room/versions/${id}/snapshot`, { method: "PUT", identity, body: bytes }));
    }
  }
  throw new HttpError(404, "not found");
}

/** "Create branch…" on a shared main (§15.5): the rows, main's session block and "branch" version, the branch room. */
async function createBranch(ctx: Ctx, f: FileRow, a: AccessGranted, isBranch: boolean) {
  const { deps, user, acc } = ctx;
  if (isBranch) throw new HttpError(400, "a branch can't be branched");
  if (a.trashed) throw new HttpError(403, "the file is in the trash");
  // Viewers branch only when "viewers can copy" is on (Figma: otherwise they don't see the option).
  if (!a.canExport) throw new HttpError(403, "the owner turned off copying for viewers");
  if (f.org_id) {
    const me = await acc.membership(f.org_id);
    if (!me || me.seat !== "full") throw new HttpError(403, "branching needs a Full seat", "seat_required", { seat: "full", current: me?.seat ?? null });
  }
  const b = await body<{ branchKey?: unknown; name?: unknown; baseSeq?: unknown }>(ctx.req);
  const branchKey = typeof b.branchKey === "string" ? b.branchKey : "";
  if (!FILE_KEY.test(branchKey)) throw new HttpError(400, "bad branch key");
  const name = cleanName(b.name, "name");
  const baseSeq = b.baseSeq;
  if (typeof baseSeq !== "number" || !Number.isInteger(baseSeq) || baseSeq < 0) throw new HttpError(400, "baseSeq");
  if (await acc.fileRow(branchKey)) throw new HttpError(409, "file key taken");
  const identity: Identity = { userId: user.id, name: user.name, role: a.roomRole };
  const head = await headOf(deps, f.key);
  if (baseSeq > head.lastSeq) throw new HttpError(400, "baseSeq is past the main file's head", undefined, { lastSeq: head.lastSeq });

  // Main's counter jumps a block; the branch's sessions are the block (two files with the same GUIDs never mint the same new ones).
  const { sessionBase } = await roomJson<{ sessionBase: number }>(deps, f.key, "/room/session-block", { method: "POST", body: JSON.stringify({ size: SESSION_BLOCK }) });
  // Main's "branch" version, at the branch point when the room still has it, else at its head.
  let mainVersionId: string | null = null;
  for (const seq of [baseSeq, undefined]) {
    try {
      mainVersionId = (await roomJson<{ version: { id: string } }>(deps, f.key, "/room/versions", { method: "POST", identity, body: JSON.stringify({ kind: "branch", title: name, seq }) })).version.id;
      break;
    } catch (e) {
      if (!(e instanceof HttpError) || e.status !== 409) throw e;
    }
  }
  const now = deps.now();
  const d1 = deps.db.d1;
  await d1
    .prepare(`INSERT INTO files (key, owner_id, name, created_at, updated_at, org_id, team_id, project_id, editor_type) VALUES (?1, ?2, ?3, ?4, ?4, ?5, ?6, ?7, ?8)`)
    .bind(branchKey, user.id, name, now, f.org_id, f.team_id, f.project_id, f.editor_type)
    .run();
  await d1
    .prepare(`INSERT INTO branches (key, main_key, name, created_by, created_at, base_seq, main_seen_seq, session_base) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6, ?7)`)
    .bind(branchKey, f.key, name, user.id, now, baseSeq, sessionBase)
    .run();
  acc.reset();
  await roomJson(deps, branchKey, "/room/init-branch", { method: "POST", body: JSON.stringify({ sessionBase }) });
  await logBranch(ctx, f, "branch_create", { branch_key: branchKey, branch_name: name });
  return { branch: await branchJson(deps, branchKey), sessionBase, mainVersionId };
}

async function logBranch(ctx: Ctx, main: FileRow, action: ActivityAction, details: Record<string, unknown>): Promise<void> {
  if (!main.org_id) return;
  await logActivity(ctx.deps, { orgId: main.org_id, action, actor: ctx.user, entity: repoEntity(main), teamId: main.team_id, details, req: ctx.req });
}

// --- /branches/:key ---------------------------------------------------------------------------------------------------

interface Resolved {
  b: BranchRow;
  f: FileRow;
  main: FileRow;
  /** The caller on the branch (through main) */
  a: AccessGranted;
  /** The caller on main */
  am: AccessResult;
  canEditMain: boolean;
  creator: boolean;
}

async function resolve(ctx: Ctx, key: string): Promise<Resolved> {
  const { acc, user } = ctx;
  if (!FILE_KEY.test(key)) throw new HttpError(400, "bad branch key");
  const b = await acc.branch(key);
  const f = b && (await acc.fileRow(key));
  const main = b && (await acc.fileRow(b.main_key));
  if (!b || !f || !main) throw new HttpError(404, "no such branch");
  const a = await acc.file(f, { viaLink: true, passOk: false });
  if (!a.ok) throw new HttpError(404, "no such branch");
  const am = await acc.file(main, { viaLink: true, passOk: false });
  return { b, f, main, a, am, canEditMain: am.ok && !am.trashed && am.canEdit, creator: b.created_by === user.id };
}

export async function branchesRoute(ctx: Ctx): Promise<Response> {
  const { deps, user, parts, m } = ctx;
  if (parts.length < 2) throw new HttpError(404, "not found");
  const key = parts[1];
  const r = await resolve(ctx, key);
  const { b, a } = r;
  const d1 = deps.db.d1;
  const identity: Identity = { userId: user.id, name: user.name, role: a.roomRole };
  const sub = parts[2];

  if (!sub) {
    if (m === "GET") return json({ branch: await branchJson(deps, key) });
    if (m === "PATCH") return json({ branch: await patchBranch(ctx, r) });
    if (m === "DELETE") {
      if (!r.canEditMain && !r.creator) throw new HttpError(403, "only people who can edit the main file can delete branches");
      if (b.status === "active") throw new HttpError(409, "archive the branch first");
      await deps.rooms.fetch(key, "/room", { method: "DELETE" });
      await deps.db.deleteFile(key);
      await logBranch(ctx, r.main, "branch_delete", { branch_key: key, branch_name: b.name });
      return noContent();
    }
    throw new HttpError(405, "method not allowed");
  }
  if (parts.length === 3) {
    switch (`${m} ${sub}`) {
      case "GET main": {
        const head = await headOf(deps, b.main_key);
        return json({ changed: head.lastSeq > b.base_seq, mainHeadSeq: head.lastSeq, baseSeq: b.base_seq, mainSeenSeq: b.main_seen_seq });
      }
      case "POST seen": {
        const { mainSeq } = await body<{ mainSeq?: unknown }>(ctx.req);
        if (typeof mainSeq !== "number" || !Number.isInteger(mainSeq) || mainSeq < 0) throw new HttpError(400, "mainSeq");
        const head = await headOf(deps, b.main_key);
        await d1.prepare(`UPDATE branches SET main_seen_seq = MAX(main_seen_seq, ?2) WHERE key = ?1`).bind(key, Math.min(mainSeq, head.lastSeq)).run();
        return json({ branch: await branchJson(deps, key) });
      }
      case "GET base":
        return passThrough(deps, key, "/room/base", { method: "GET", identity });
      case "PUT base": {
        if (!a.canEdit) throw new HttpError(403, "you can only view this branch");
        const seq = Number(ctx.url.searchParams.get("seq"));
        if (!Number.isInteger(seq) || seq < 0) throw new HttpError(400, "bad seq");
        const head = await headOf(deps, b.main_key);
        if (seq > head.lastSeq) throw new HttpError(400, "seq is past the main file's head", undefined, { lastSeq: head.lastSeq });
        const bytes = await ctx.req.arrayBuffer();
        if (bytes.byteLength > MAX_SNAPSHOT_BYTES) throw new HttpError(413, "snapshot too large");
        return json(await roomJson(deps, key, `/room/base?seq=${seq}`, { method: "PUT", identity, body: bytes }));
      }
      case "POST update":
        return json(await applyUpdate(ctx, r));
      case "POST merge":
        return json(await applyMerge(ctx, r));
      case "GET reviews":
        return json({ reviews: await reviewsOf(deps, key, false) });
      case "POST reviews":
        return json({ review: await requestReview(ctx, r) }, 201);
    }
  }
  if (parts.length === 5 && sub === "reviews" && parts[4] === "verdict" && m === "POST") return json({ review: await answerReview(ctx, r, parts[3]) });
  throw new HttpError(404, "not found");
}

async function patchBranch(ctx: Ctx, r: Resolved): Promise<BranchJson> {
  const { deps, user } = ctx;
  const { b } = r;
  if (!r.canEditMain && !r.creator) throw new HttpError(403, "only people who can edit the main file can change branches");
  const p = await body<{ name?: unknown; status?: unknown }>(ctx.req);
  const d1 = deps.db.d1;
  const now = deps.now();
  if (p.name !== undefined) {
    const name = cleanName(p.name, "name");
    await d1.prepare(`UPDATE branches SET name = ?2 WHERE key = ?1`).bind(b.key, name).run();
    await d1.prepare(`UPDATE files SET name = ?2, updated_at = ?3 WHERE key = ?1`).bind(b.key, name, now).run();
  }
  if (p.status !== undefined) {
    if (p.status !== "archived" && p.status !== "active") throw new HttpError(400, "status is archived or active");
    if (p.status === "archived" && b.status === "active") {
      await d1.prepare(`UPDATE branches SET status = 'archived', archived_at = ?2, archived_by = ?3 WHERE key = ?1`).bind(b.key, now, user.id).run();
      await logBranch(ctx, r.main, "branch_archive", { branch_key: b.key, branch_name: b.name });
      // Archived is read-only: everyone in it reconnects as a viewer.
      await reauth(deps, [b.key]);
    } else if (p.status === "active" && b.status !== "active") {
      if (b.status === "merged") throw new HttpError(400, "a merged branch can't be restored; duplicate it instead");
      await d1.prepare(`UPDATE branches SET status = 'active', archived_at = NULL, archived_by = NULL WHERE key = ?1`).bind(b.key).run();
      await logBranch(ctx, r.main, "branch_unarchive", { branch_key: b.key, branch_name: b.name });
    }
  }
  return branchJson(deps, b.key);
}

function envelopeOf<T>(bytes: ArrayBuffer): { meta: T; message: Uint8Array } {
  if (bytes.byteLength > MAX_ENVELOPE_BYTES) throw new HttpError(413, "batch too large");
  const env = decodeEnvelope<T>(new Uint8Array(bytes));
  if (!env) throw new HttpError(400, "expected [u32 length][JSON][kiwi Message]");
  return env;
}

const seqOf = (v: unknown, what: string): number => {
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0) throw new HttpError(400, what);
  return v;
};

const optInt = (v: unknown): number | undefined => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : undefined);

/**
 * "Apply changes" of Update from main (§15.5): main's head must still be `mainSeq` (the T the update read) and the
 * branch's `branchSeq`; the batch lands on the branch as one frame, the staged base (main at mainSeq, PUT …/base)
 * becomes the base with it, then the branch's "update" version.
 */
async function applyUpdate(ctx: Ctx, r: Resolved) {
  const { deps, user } = ctx;
  const { b, a } = r;
  if (b.status !== "active") throw new HttpError(409, "the branch is archived");
  if (!a.canEdit) throw new HttpError(403, "you can only view this branch");
  const { meta, message } = envelopeOf<{ mainSeq?: unknown; branchSeq?: unknown; sessionID?: unknown; batch?: unknown }>(await ctx.req.arrayBuffer());
  const mainSeq = seqOf(meta.mainSeq, "mainSeq");
  const branchSeq = seqOf(meta.branchSeq, "branchSeq");
  const head = await headOf(deps, b.main_key);
  if (head.lastSeq !== mainSeq) throw new HttpError(409, "the main file changed since the preview", "stale", { mainHeadSeq: head.lastSeq });
  const apply: ApplyMeta = { expectSeq: branchSeq, kind: "update", promoteBase: mainSeq, sessionID: optInt(meta.sessionID), batch: optInt(meta.batch) };
  const res = await roomJson<{ seq: number; versionId: string }>(deps, b.key, "/room/apply", { method: "POST", identity: { userId: user.id, name: user.name, role: a.roomRole }, body: encodeEnvelope(apply, message) });
  await deps.db.d1.prepare(`UPDATE branches SET base_seq = ?2, main_seen_seq = MAX(main_seen_seq, ?2) WHERE key = ?1`).bind(b.key, mainSeq).run();
  await logBranch(ctx, r.main, "repo_merge_from_source", { branch_key: b.key, branch_name: b.name, main_seq: mainSeq, version_id: res.versionId });
  return { branch: await branchJson(deps, b.key), seq: res.seq, versionId: res.versionId };
}

/**
 * Merge (§15.5): the branch is frozen at `branchSeq` (its head must be the one the merge read), then main takes the
 * pre-merge checkpoint, the batch as one frame and the "merge" version — if its head is still `mainSeq` (else the
 * branch thaws and the answer is `stale`). The branch gets its "merge" version, is marked merged and archived; its
 * people reconnect read-only. The creator and reviewers are told.
 */
async function applyMerge(ctx: Ctx, r: Resolved) {
  const { deps, user } = ctx;
  const { b, main } = r;
  if (b.status !== "active") throw new HttpError(409, b.status === "merged" ? "the branch is already merged" : "the branch is archived");
  if (!r.canEditMain || !r.am.ok) throw new HttpError(403, "only people who can edit the main file can merge; request a review");
  const { meta, message } = envelopeOf<{ mainSeq?: unknown; branchSeq?: unknown; title?: unknown; description?: unknown; sessionID?: unknown; batch?: unknown }>(await ctx.req.arrayBuffer());
  const mainSeq = seqOf(meta.mainSeq, "mainSeq");
  const branchSeq = seqOf(meta.branchSeq, "branchSeq");
  const title = (typeof meta.title === "string" && meta.title.trim() ? meta.title.trim() : b.name).slice(0, 200);
  const description = typeof meta.description === "string" && meta.description.trim() ? meta.description.trim().slice(0, 5000) : null;
  const mainIdentity: Identity = { userId: user.id, name: user.name, role: r.am.roomRole };
  await roomJson(deps, b.key, "/room/freeze", { method: "POST", body: JSON.stringify({ expectSeq: branchSeq }) });
  let res: { seq: number; versionId: string; preVersionId: string | null };
  try {
    const apply: ApplyMeta = { expectSeq: mainSeq, kind: "merge", checkpoint: true, title, description, sessionID: optInt(meta.sessionID), batch: optInt(meta.batch) };
    res = await roomJson(deps, main.key, "/room/apply", { method: "POST", identity: mainIdentity, body: encodeEnvelope(apply, message) });
  } catch (e) {
    await deps.rooms.fetch(b.key, "/room/unfreeze", { method: "POST" });
    throw e;
  }
  let branchVersionId: string | null = null;
  try {
    branchVersionId = (await roomJson<{ version: { id: string } }>(deps, b.key, "/room/versions", { method: "POST", identity: { userId: user.id, name: user.name, role: "viewer" }, body: JSON.stringify({ kind: "merge", title, description }) })).version.id;
  } catch (e) {
    // The merge is done on main; the branch's own checkpoint is a nicety (it has no snapshot yet, say).
    console.error("branches: the branch's merge version", e);
  }
  const now = deps.now();
  await deps.db.d1
    .prepare(`UPDATE branches SET status = 'merged', merged_at = ?2, merged_by = ?3, merge_version = ?4, archived_at = ?2, archived_by = ?3 WHERE key = ?1`)
    .bind(b.key, now, user.id, res.versionId)
    .run();
  await deps.db.d1.prepare(`UPDATE files SET updated_at = ?2 WHERE key = ?1`).bind(main.key, now).run();
  await logBranch(ctx, main, "repo_merge_to_source", { branch_key: b.key, branch_name: b.name, main_seq: res.seq, version_id: res.versionId });
  const { results: reviewers } = await deps.db.d1.prepare(`SELECT DISTINCT r.user_id FROM branch_reviewers r JOIN branch_reviews v ON v.id = r.review_id WHERE v.branch_key = ?1`).bind(b.key).all<{ user_id: string }>();
  await notifyBranchMerged(deps, { key: b.key, by: user, userIds: [b.created_by, ...reviewers.map((x) => x.user_id)] });
  await reauth(deps, [b.key]);
  return { branch: await branchJson(deps, b.key), mainSeq: res.seq, versionId: res.versionId, preVersionId: res.preVersionId, branchVersionId };
}

/** "Request review" / "Request another review" (§15.5): reviewers who can open the branch, a description. */
async function requestReview(ctx: Ctx, r: Resolved): Promise<BranchReviewJson> {
  const { deps, user } = ctx;
  const { b } = r;
  if (b.status !== "active") throw new HttpError(409, "the branch is archived");
  const p = await body<{ reviewerIds?: unknown; description?: unknown }>(ctx.req);
  const ids = Array.isArray(p.reviewerIds) ? [...new Set(p.reviewerIds.filter((x): x is string => typeof x === "string"))] : [];
  if (!ids.length || ids.length > 50) throw new HttpError(400, "reviewerIds: 1 to 50 people");
  for (const id of ids) if (!(await canOpen(deps, b.key, id))) throw new HttpError(400, "a reviewer can't open this branch", undefined, { userId: id });
  const description = typeof p.description === "string" ? p.description.trim().slice(0, 5000) : "";
  const d1 = deps.db.d1;
  const now = deps.now();
  // An open review is asked again: verdicts back to pending (Figma's "Request another review").
  const open = await d1.prepare(`SELECT id FROM branch_reviews WHERE branch_key = ?1 AND state <> 'closed' ORDER BY created_at DESC LIMIT 1`).bind(b.key).first<{ id: string }>();
  const id = open?.id ?? randomId();
  if (open) {
    await d1.prepare(`UPDATE branch_reviews SET state = 'in-review', description = ?2, requested_by = ?3, updated_at = ?4 WHERE id = ?1`).bind(id, description, user.id, now).run();
    await d1.prepare(`DELETE FROM branch_reviewers WHERE review_id = ?1`).bind(id).run();
  } else {
    await d1.prepare(`INSERT INTO branch_reviews (id, branch_key, requested_by, description, state, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, 'in-review', ?5, ?5)`).bind(id, b.key, user.id, description, now).run();
  }
  for (const u of ids) await d1.prepare(`INSERT INTO branch_reviewers (review_id, user_id) VALUES (?1, ?2)`).bind(id, u).run();
  await notifyBranchReview(deps, { key: b.key, by: user, reviewerIds: ids, description });
  return (await reviewsOf(deps, b.key, true))[0];
}

/** "Add your review" › Approve / Suggest changes: the review's state is the latest verdict; the asker is told. */
async function answerReview(ctx: Ctx, r: Resolved, reviewId: string): Promise<BranchReviewJson> {
  const { deps, user } = ctx;
  const d1 = deps.db.d1;
  const review = await d1.prepare(`SELECT id, requested_by, state FROM branch_reviews WHERE id = ?1 AND branch_key = ?2`).bind(reviewId, r.b.key).first<{ id: string; requested_by: string; state: string }>();
  if (!review) throw new HttpError(404, "no such review");
  if (review.state === "closed") throw new HttpError(409, "the review is closed");
  const mine = await d1.prepare(`SELECT 1 AS x FROM branch_reviewers WHERE review_id = ?1 AND user_id = ?2`).bind(review.id, user.id).first();
  if (!mine) throw new HttpError(403, "only the reviewers asked can review");
  const p = await body<{ verdict?: unknown; comment?: unknown }>(ctx.req);
  if (p.verdict !== "approved" && p.verdict !== "changes-suggested") throw new HttpError(400, "verdict is approved or changes-suggested");
  const comment = typeof p.comment === "string" ? p.comment.trim().slice(0, 5000) : "";
  const now = deps.now();
  await d1.prepare(`UPDATE branch_reviewers SET verdict = ?3, comment = ?4, at = ?5 WHERE review_id = ?1 AND user_id = ?2`).bind(review.id, user.id, p.verdict, comment, now).run();
  await d1.prepare(`UPDATE branch_reviews SET state = ?2, updated_at = ?3 WHERE id = ?1`).bind(review.id, p.verdict, now).run();
  await notifyBranchVerdict(deps, { key: r.b.key, by: user, toId: review.requested_by, verdict: p.verdict, comment });
  return (await reviewsOf(deps, r.b.key, true)).find((x) => x.id === review.id) ?? (await reviewsOf(deps, r.b.key, false)).find((x) => x.id === review.id)!;
}

// --- Elsewhere --------------------------------------------------------------------------------------------------------------

/**
 * Inviting to a branch (§15.7; Figma: "inviting someone to a branch also gives them main"): the grant is written on main
 * and on the branch, logged `branch_member_add` / `_permission_change`. Removing someone from a branch removes the
 * branch's row only (`branch_member_remove`): their access to main, and so to the branch, stays main's to change.
 */
export async function branchMembers(ctx: Ctx, b: BranchRow): Promise<Response> {
  const { deps, user, parts, m, acc } = ctx;
  const main = await acc.fileRow(b.main_key);
  if (!main) throw new HttpError(404, "no such file");
  const am = await acc.file(main, { viaLink: true, passOk: false });
  const canInvite = am.ok && !am.trashed && (main.org_id ? am.canShare || am.canManage : am.canManage);
  if (!canInvite) throw new HttpError(403, main.org_id ? "only people who can edit the main file can share its branches" : "only the main file's owner can");
  if (parts.length === 3 && m === "PUT") {
    const p = await body<{ email?: unknown; role?: unknown }>(ctx.req);
    if (p.role !== "editor" && p.role !== "viewer") throw new HttpError(400, "role is editor or viewer");
    const email = normalizeEmail(typeof p.email === "string" ? p.email : "");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, "bad email");
    const before = (await deps.db.members(b.key)).find((x) => x.email === email);
    const onMain = (await deps.db.members(main.key)).find((x) => x.email === email);
    if (onMain?.role === "owner") throw new HttpError(400, "they own the main file");
    // In an org, outside emails come in through the main file's Share (guest rules, §14.15); here only people already in.
    if (main.org_id && !onMain && !(await deps.db.d1.prepare(`SELECT 1 AS x FROM org_members WHERE org_id = ?1 AND email = ?2`).bind(main.org_id, email).first())) {
      throw new HttpError(400, "invite them to the main file first");
    }
    if (!onMain || (onMain.role === "viewer" && p.role === "editor")) await deps.db.putMember(main.key, email, p.role, user.id, deps.now());
    const memberId = await deps.db.putMember(b.key, email, p.role, user.id, deps.now());
    if (memberId) for (const k of [main.key, b.key]) await deps.rooms.fetch(k, "/room/revoke", { method: "POST", body: JSON.stringify({ userId: memberId }) });
    if (memberId && !before) await notifyInvite(deps, { key: b.key, by: user, userId: memberId, role: p.role });
    await logBranch(ctx, main, before ? "branch_member_permission_change" : "branch_member_add", { branch_key: b.key, email, user_id: memberId, role: p.role, from: before?.role ?? null });
    return json({ ok: true });
  }
  if (parts.length === 4 && m === "DELETE") {
    const memberId = await deps.db.removeMember(b.key, parts[3]);
    await logBranch(ctx, main, "branch_member_remove", { branch_key: b.key, email: normalizeEmail(parts[3]), user_id: memberId });
    return json({ ok: true });
  }
  throw new HttpError(404, "not found");
}

/** A main file deleted for good takes its branches (their rooms and rows) with it. */
export async function deleteBranchesOf(deps: Deps, mainKey: string): Promise<void> {
  const { results } = await deps.db.d1.prepare(`SELECT key FROM branches WHERE main_key = ?1`).bind(mainKey).all<{ key: string }>();
  for (const { key } of results) {
    await deps.rooms.fetch(key, "/room", { method: "DELETE" });
    await deps.db.deleteFile(key);
  }
}

