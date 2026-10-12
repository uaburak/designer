/**
 * Public sign-up's guards on the server (docs/multiplayer.md §17; the numbers in src/shared/quota.ts):
 *
 * - **Counted quotas** (uploads and invitations a day, comments a minute, new accounts per IP and per day): one atomic
 *   upsert in `quota_counters` per counted action — a row of the window is made or moved on only while it is under
 *   the limit, so parallel requests can't get past it.
 * - **Totals** (files owned, previews, organizations created): a COUNT over the account's rows when one is added.
 * - **Stored bytes**: each upload's size is kept in `stored_items` (one row per stored thing, named by what holds it)
 *   and its change moves `users.stored_bytes` and the server's total — never a scan. Releasing a file, preview or
 *   library subtracts its rows by prefix.
 * - **Suspension** and the **sign-up mode**, the operator's (operator.ts).
 *
 * Over a quota: 403 (totals) or 429 (rates) `{error, code: "quota_exceeded", kind, limit}`.
 */
import { ACCOUNT_SUSPENDED_TEXT, DEFAULT_OPERATOR_EMAILS, DEFAULT_SIGNUP_MODE, QUOTA_LIMITS, SIGNUP_MODES, quotaText, type AccountQuotaKind, type QuotaKind, type QuotaOverrides, type SignupMode, type SignupSignInError } from "../../../src/shared/quota";
import type { Deps } from "../api";
import { normalizeEmail, parseOverrides, type D1Like, type User } from "../db";
import { HttpError } from "../org/http";

const MINUTE = 60_000;
const DAY = 86_400_000;
/** `quota_counters.subject` of the server's own counters */
const SERVER = "*";

// ---- who is who ------------------------------------------------------------------------------------------------------

/** `OPERATOR_EMAILS` (comma-separated), else the owner's */
export function operatorEmails(deps: Deps): string[] {
  const raw = (deps.env as { OPERATOR_EMAILS?: string }).OPERATOR_EMAILS;
  const list = (raw ?? "").split(",").map((s) => normalizeEmail(s)).filter(Boolean);
  return list.length ? list : DEFAULT_OPERATOR_EMAILS;
}

export const isOperatorEmail = (deps: Deps, email: string): boolean => operatorEmails(deps).includes(normalizeEmail(email));

/** 403 `account_suspended` (authenticate and the sign-in refuse a suspended account) */
export function requireActive(user: Pick<User, "suspendedAt">): void {
  if (user.suspendedAt != null) throw new HttpError(403, ACCOUNT_SUSPENDED_TEXT, "account_suspended");
}

// ---- limits ----------------------------------------------------------------------------------------------------------

export function quotaError(kind: QuotaKind, limit: number, status = 403): HttpError {
  return new HttpError(status, quotaText(kind, limit), "quota_exceeded", { kind, limit });
}

/** The account's number for `kind`: its override, else the default */
export const limitOf = (overrides: QuotaOverrides | undefined, kind: AccountQuotaKind): number => overrides?.[kind] ?? QUOTA_LIMITS[kind];

/** The overrides of a user loaded without them (a file's owner who isn't the caller) */
async function overridesOf(d1: D1Like, userId: string): Promise<QuotaOverrides> {
  const r = await d1.prepare(`SELECT quota_overrides FROM users WHERE id = ?1`).bind(userId).first<{ quota_overrides: string }>();
  return parseOverrides(r?.quota_overrides);
}

/**
 * One counted action of `subject` in the current window of `windowMs` (0: a running count). Throws `quota_exceeded`
 * (429) when the window already holds `limit`.
 */
export async function countAction(deps: Deps, subject: string, kind: QuotaKind, limit: number, windowMs: number): Promise<void> {
  if (limit <= 0) throw quotaError(kind, limit, 429);
  const window = windowMs ? Math.floor(deps.now() / windowMs) : 0;
  const r = await deps.db.d1
    .prepare(`INSERT INTO quota_counters (subject, kind, window, n) VALUES (?1, ?2, ?3, 1) ON CONFLICT (subject, kind, window) DO UPDATE SET n = n + 1 WHERE n < ?4 RETURNING n`)
    .bind(subject, kind, window, limit)
    .first<{ n: number }>();
  if (!r) throw quotaError(kind, limit, 429);
}

const WINDOW: Partial<Record<AccountQuotaKind, number>> = { uploads_per_day: DAY, invitations_per_day: DAY, comments_per_minute: MINUTE };

/** An upload, an invitation or a comment by `user` (their overrides, if loaded; else read) */
export async function countFor(deps: Deps, user: Pick<User, "id" | "quotas">, kind: "uploads_per_day" | "invitations_per_day" | "comments_per_minute"): Promise<void> {
  const overrides = user.quotas ?? (await overridesOf(deps.db.d1, user.id));
  await countAction(deps, user.id, kind, limitOf(overrides, kind), WINDOW[kind]!);
}

/** A new file owned by `user` (shared, in an org, a draft or a branch): 403 when they own the limit already */
export async function requireFileSlot(deps: Deps, user: Pick<User, "id" | "quotas">): Promise<void> {
  const limit = limitOf(user.quotas ?? (await overridesOf(deps.db.d1, user.id)), "shared_files");
  const r = await deps.db.d1.prepare(`SELECT COUNT(*) AS n FROM files WHERE owner_id = ?1`).bind(user.id).first<{ n: number }>();
  if ((r?.n ?? 0) >= limit) throw quotaError("shared_files", limit);
}

/** A new organization created by `user` */
export async function requireOrgSlot(deps: Deps, user: Pick<User, "id" | "quotas">): Promise<void> {
  const limit = limitOf(user.quotas ?? (await overridesOf(deps.db.d1, user.id)), "orgs_created");
  const r = await deps.db.d1.prepare(`SELECT COUNT(*) AS n FROM orgs WHERE created_by = ?1`).bind(user.id).first<{ n: number }>();
  if ((r?.n ?? 0) >= limit) throw quotaError("orgs_created", limit);
}

/** A new developer preview of `userId` (previews.ts claims its id) */
export async function requirePreviewSlot(deps: Deps, d1: D1Like, userId: string): Promise<void> {
  const limit = limitOf(await overridesOf(d1, userId), "previews");
  const r = await d1.prepare(`SELECT COUNT(*) AS n FROM previews WHERE owner_id = ?1 AND (expires_at IS NULL OR expires_at > ?2)`).bind(userId, deps.now()).first<{ n: number }>();
  if ((r?.n ?? 0) >= limit) throw quotaError("previews", limit);
}

// ---- stored bytes ----------------------------------------------------------------------------------------------------

/** The server's stored bytes (the running counter) */
export async function serverStoredBytes(d1: D1Like): Promise<number> {
  const r = await d1.prepare(`SELECT n FROM quota_counters WHERE subject = ?1 AND kind = 'server_storage_bytes' AND window = 0`).bind(SERVER).first<{ n: number }>();
  return r?.n ?? 0;
}

export interface StorageReservation {
  /** Throws `quota_exceeded` when `bytes` (the body as read) would pass the owner's or the server's limit */
  check(bytes: number): void;
  /** The upload was kept: its size is recorded and the totals moved by the change */
  commit(bytes: number): Promise<void>;
}

/**
 * Before an upload of `item`, charged to `ownerId`: refuses at once when the declared size (content-length; 0 when
 * absent) would pass a limit — before the body is read — and gives the checks for the body as read and the record
 * once kept. A replaced item counts by its change only.
 */
export async function reserveStorage(deps: Deps, ownerId: string, item: string, declared: number): Promise<StorageReservation> {
  const d1 = deps.db.d1;
  const owner = await d1.prepare(`SELECT stored_bytes, quota_overrides FROM users WHERE id = ?1`).bind(ownerId).first<{ stored_bytes: number; quota_overrides: string }>();
  const old = (await d1.prepare(`SELECT bytes FROM stored_items WHERE item = ?1`).bind(item).first<{ bytes: number }>())?.bytes ?? 0;
  const total = await serverStoredBytes(d1);
  const limit = limitOf(parseOverrides(owner?.quota_overrides), "storage_bytes");
  const stored = owner?.stored_bytes ?? 0;
  const check = (bytes: number) => {
    const delta = bytes - old;
    if (delta <= 0) return;
    if (stored + delta > limit) throw quotaError("storage_bytes", limit);
    if (total + delta > QUOTA_LIMITS.server_storage_bytes) throw quotaError("server_storage_bytes", QUOTA_LIMITS.server_storage_bytes, 507);
  };
  check(Number.isFinite(declared) && declared > 0 ? declared : 0);
  return {
    check,
    async commit(bytes: number) {
      await recordStorage(deps, ownerId, item, bytes, old);
    },
  };
}

/** `item` (known only once uploaded, e.g. by its SHA-1) now weighs `bytes`, charged to `ownerId` */
export async function chargeStored(deps: Deps, ownerId: string, item: string, bytes: number): Promise<void> {
  const old = (await deps.db.d1.prepare(`SELECT bytes FROM stored_items WHERE item = ?1`).bind(item).first<{ bytes: number }>())?.bytes ?? 0;
  await recordStorage(deps, ownerId, item, bytes, old);
}

/** `item` now weighs `bytes` (it weighed `old`), charged to `ownerId`; the owner's and the server's totals moved */
async function recordStorage(deps: Deps, ownerId: string, item: string, bytes: number, old: number): Promise<void> {
  const d1 = deps.db.d1;
  const delta = bytes - old;
  const stmts = [
    d1.prepare(`INSERT INTO stored_items (item, owner_id, bytes) VALUES (?1, ?2, ?3) ON CONFLICT (item) DO UPDATE SET bytes = ?3, owner_id = ?2`).bind(item, ownerId, bytes),
    ...(delta ? [d1.prepare(`UPDATE users SET stored_bytes = MAX(0, stored_bytes + ?2) WHERE id = ?1`).bind(ownerId, delta), serverDelta(d1, delta)] : []),
  ];
  await runAll(d1, stmts);
}

const serverDelta = (d1: D1Like, delta: number) =>
  d1.prepare(`INSERT INTO quota_counters (subject, kind, window, n) VALUES (?1, 'server_storage_bytes', 0, MAX(0, ?2)) ON CONFLICT (subject, kind, window) DO UPDATE SET n = MAX(0, n + ?2)`).bind(SERVER, delta);

async function runAll(d1: D1Like, stmts: ReturnType<D1Like["prepare"]>[]): Promise<void> {
  if (d1.batch) await d1.batch(stmts);
  else for (const s of stmts) await s.run();
}

/** `prefix`'s upper bound in a range query (item names use [A-Za-z0-9_:-], all below "~") */
const range = (prefix: string): [string, string] => [prefix, `${prefix}~`];

/** Everything stored under `prefix` (a file `f:<key>:`, a preview `p:<id>:`, a library `l:<key>:`) is gone */
export async function releaseStorage(d1: D1Like, prefix: string): Promise<void> {
  const [lo, hi] = range(prefix);
  const { results } = await d1.prepare(`SELECT owner_id, SUM(bytes) AS bytes FROM stored_items WHERE item >= ?1 AND item < ?2 GROUP BY owner_id`).bind(lo, hi).all<{ owner_id: string; bytes: number }>();
  if (!results.length) return;
  const sum = results.reduce((n, r) => n + r.bytes, 0);
  await runAll(d1, [
    ...results.map((r) => d1.prepare(`UPDATE users SET stored_bytes = MAX(0, stored_bytes - ?2) WHERE id = ?1`).bind(r.owner_id, r.bytes)),
    serverDelta(d1, -sum),
    d1.prepare(`DELETE FROM stored_items WHERE item >= ?1 AND item < ?2`).bind(lo, hi),
  ]);
}

/** A deleted account's remaining rows (things charged to it in others' files and libraries) leave the totals */
export async function releaseOwner(d1: D1Like, ownerId: string): Promise<void> {
  const r = await d1.prepare(`SELECT SUM(bytes) AS bytes FROM stored_items WHERE owner_id = ?1`).bind(ownerId).first<{ bytes: number | null }>();
  if (!r?.bytes) return;
  await runAll(d1, [serverDelta(d1, -r.bytes), d1.prepare(`DELETE FROM stored_items WHERE owner_id = ?1`).bind(ownerId)]);
}

/** A preview went live with `keep` (its doc and listed images): the images it dropped are released */
export async function pruneStorage(deps: Deps, prefix: string, keep: Set<string>): Promise<void> {
  const d1 = deps.db.d1;
  const [lo, hi] = range(prefix);
  const { results } = await d1.prepare(`SELECT item, owner_id, bytes FROM stored_items WHERE item >= ?1 AND item < ?2`).bind(lo, hi).all<{ item: string; owner_id: string; bytes: number }>();
  const gone = results.filter((r) => !keep.has(r.item));
  if (!gone.length) return;
  const byOwner = new Map<string, number>();
  for (const r of gone) byOwner.set(r.owner_id, (byOwner.get(r.owner_id) ?? 0) + r.bytes);
  const sum = gone.reduce((n, r) => n + r.bytes, 0);
  await runAll(d1, [
    ...[...byOwner].map(([id, bytes]) => d1.prepare(`UPDATE users SET stored_bytes = MAX(0, stored_bytes - ?2) WHERE id = ?1`).bind(id, bytes)),
    serverDelta(d1, -sum),
    ...gone.map((r) => d1.prepare(`DELETE FROM stored_items WHERE item = ?1`).bind(r.item)),
  ]);
}

/** A file changed owner ("Transfer ownership"): what it stores is charged to the new owner */
export async function moveStorage(deps: Deps, prefix: string, toOwner: string): Promise<void> {
  const d1 = deps.db.d1;
  const [lo, hi] = range(prefix);
  const { results } = await d1.prepare(`SELECT owner_id, SUM(bytes) AS bytes FROM stored_items WHERE item >= ?1 AND item < ?2 AND owner_id <> ?3 GROUP BY owner_id`).bind(lo, hi, toOwner).all<{ owner_id: string; bytes: number }>();
  if (!results.length) return;
  const sum = results.reduce((n, r) => n + r.bytes, 0);
  await runAll(d1, [
    ...results.map((r) => d1.prepare(`UPDATE users SET stored_bytes = MAX(0, stored_bytes - ?2) WHERE id = ?1`).bind(r.owner_id, r.bytes)),
    d1.prepare(`UPDATE users SET stored_bytes = stored_bytes + ?2 WHERE id = ?1`).bind(toOwner, sum),
    d1.prepare(`UPDATE stored_items SET owner_id = ?3 WHERE item >= ?1 AND item < ?2`).bind(lo, hi, toOwner),
  ]);
}

/**
 * An upload route's guard, in order: the uploader's daily count, the owner's and the server's bytes for the declared
 * size (before the body is read), the body read (refused past `max` without reading on, by its declared length), the
 * bytes checked again as read. → the body and the record to make once the upload is kept.
 */
export async function guardedUpload(deps: Deps, req: Request, uploader: Pick<User, "id" | "quotas">, charge: { ownerId: string; item: string } | null, max: number, tooLarge: string): Promise<{ body: ArrayBuffer; commit(): Promise<void> }> {
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared > max) throw new HttpError(413, tooLarge);
  await countFor(deps, uploader, "uploads_per_day");
  const reservation = charge ? await reserveStorage(deps, charge.ownerId, charge.item, declared) : null;
  const body = await req.arrayBuffer();
  if (body.byteLength > max) throw new HttpError(413, tooLarge);
  reservation?.check(body.byteLength);
  return { body, commit: async () => void (await reservation?.commit(body.byteLength)) };
}

// ---- sign-up ---------------------------------------------------------------------------------------------------------

export async function signupMode(d1: D1Like): Promise<SignupMode> {
  const r = await d1.prepare(`SELECT v FROM server_settings WHERE k = 'signup_mode'`).first<{ v: string }>();
  return SIGNUP_MODES.includes(r?.v as SignupMode) ? (r!.v as SignupMode) : DEFAULT_SIGNUP_MODE;
}

/** Someone invited to anything on the server (a file, an org, a team, a folder) who has no account yet, or allowlisted */
async function invited(d1: D1Like, email: string): Promise<boolean> {
  const r = await d1
    .prepare(
      `SELECT (EXISTS (SELECT 1 FROM signup_allowlist WHERE email = ?1) OR EXISTS (SELECT 1 FROM members WHERE email = ?1)
         OR EXISTS (SELECT 1 FROM org_members WHERE email = ?1) OR EXISTS (SELECT 1 FROM team_members WHERE email = ?1)
         OR EXISTS (SELECT 1 FROM project_members WHERE email = ?1)) AS ok`,
    )
    .bind(email)
    .first<{ ok: number }>();
  return r?.ok === 1;
}

/**
 * Google's sign-in, before the account is made or refreshed: an existing account passes unless suspended; a new one
 * passes the sign-up mode (operators always), then the per-IP and the server's daily counts. → the loopback's error,
 * or null.
 */
export async function admitSignIn(deps: Deps, p: { sub: string; email: string }, req: Request): Promise<SignupSignInError | null> {
  const d1 = deps.db.d1;
  const email = normalizeEmail(p.email);
  const existing = await d1
    .prepare(`SELECT suspended_at FROM users WHERE google_sub = ?1 OR (email = ?2 AND google_sub LIKE 'none:%') ORDER BY google_sub = ?1 DESC LIMIT 1`)
    .bind(p.sub, email)
    .first<{ suspended_at: number | null }>();
  if (existing) return existing.suspended_at != null ? "account_suspended" : null;
  if (isOperatorEmail(deps, email)) return null;
  const mode = await signupMode(d1);
  if (mode === "closed") return "signup_closed";
  if (mode === "invite" && !(await invited(d1, email))) return "signup_invite_only";
  try {
    // Cloudflare always says the client's IP; without it (local tools, tests) there is no one to tell apart
    const ip = req.headers.get("cf-connecting-ip");
    if (ip) await countAction(deps, `ip:${ip}`, "signups_per_ip_per_day", QUOTA_LIMITS.signups_per_ip_per_day, DAY);
    await countAction(deps, SERVER, "signups_per_day", QUOTA_LIMITS.signups_per_day, DAY);
  } catch (e) {
    if (e instanceof HttpError && e.code === "quota_exceeded") return "signup_limit";
    throw e;
  }
  return null;
}

// ---- the daily cron ----------------------------------------------------------------------------------------------------

/**
 * Counters of past windows go (two days kept; running totals, window 0, stay); expired previews' rows and stored bytes
 * are released (their objects delete themselves at expiry).
 */
export async function sweepQuotas(deps: Deps): Promise<void> {
  const d1 = deps.db.d1;
  const now = deps.now();
  const day = Math.floor(now / DAY);
  await d1.prepare(`DELETE FROM quota_counters WHERE window <> 0 AND ((kind = 'comments_per_minute' AND window < ?2) OR (kind <> 'comments_per_minute' AND window < ?1))`).bind(day - 2, Math.floor(now / MINUTE) - 60).run();
  const { results } = await d1.prepare(`SELECT id FROM previews WHERE expires_at IS NOT NULL AND expires_at <= ?1 LIMIT 500`).bind(now).all<{ id: string }>();
  for (const { id } of results) {
    await releaseStorage(d1, `p:${id}:`);
    await d1.prepare(`DELETE FROM previews WHERE id = ?1`).bind(id).run();
  }
}
