/**
 * The spend guard's five-minute check and its operator routes (docs/multiplayer.md §17.1).
 *
 *   GET   /operator/spend-guard                                        SpendGuardStatus
 *   PATCH /operator/spend-guard {mode?, warnPercent?, guardPercent?, serverStorageBytes?: number | null}   SpendGuardStatus
 *         (serverStorageBytes: the cap on every account's stored bytes together; null = the default, guard/storageCap.ts)
 *   POST  /operator/spend-guard/check                                  SpendGuardStatus, after checking now
 *
 * The check reads month-to-date usage (guard/usage.ts), tells the operators once a month about each metric past
 * `warnPercent` and once when the guard engages (the bell, kind `capacity_warning`; and the log), and writes the
 * snapshot only when something changed materially (a metric moved half a point, a warning, the decision, the month, the
 * error) or an hour went by — at most one small D1 write per check.
 */
import { QUOTA_LIMITS } from "../../../src/shared/quota";
import { SPEND_GUARD_MODES, SPEND_INCLUDED, SPEND_METRICS, SPEND_METRIC_LABEL, formatSpend, monthOf, type SpendGuardMode, type SpendGuardStatus, type SpendMetric } from "../../../src/shared/spendGuard";
import type { Deps } from "../api";
import type { User } from "../db";
import { body, HttpError, json } from "../org/http";
import { notifyCapacity } from "../notifications";
import { operatorEmails } from "../quota/quota";
import { decide, metricsPast, percentOf, readGuard, resetGuardCache, type GuardSettings, type GuardState, type UsageSnapshot } from "./state";
import { MAX_SERVER_STORAGE, MIN_SERVER_STORAGE, serverStorageSetting } from "./storageCap";
import { configured, fetchUsage, type GuardEnv, type Usage } from "./usage";

const HOUR = 3_600_000;
/** A metric moving less than this (percentage points) isn't worth a write */
const MATERIAL_POINTS = 0.5;

let loggedFailure: string | null = null;

/** Tests */
export function resetCheckLog(): void {
  loggedFailure = null;
}

type CheckDeps = Pick<Deps, "db" | "env" | "now" | "fetch" | "inboxes">;

/** The cron's step: returns the state now in force */
export async function checkSpend(deps: CheckDeps): Promise<GuardState> {
  const d1 = deps.db.d1;
  const now = deps.now();
  const month = monthOf(now);
  const state = await readGuard(d1);
  const { usage, error } = await fetchUsage(deps.fetch, deps.env as GuardEnv, now);
  if (error && error !== loggedFailure) console.warn(`spend guard: ${error}${Object.keys(usage).length === 0 ? " — usage unknown, not enforcing" : ""}`);
  loggedFailure = error;

  // The 1st (UTC): last month's warnings go with it
  const prev = state.snapshot?.month === month ? state.snapshot : null;
  const known = Object.keys(usage).length > 0;
  const next: UsageSnapshot = {
    month,
    checkedAt: known ? now : (prev?.checkedAt ?? null),
    writtenAt: now,
    usage,
    error,
    warned: [...(prev?.warned ?? [])],
    guardNotified: prev?.guardNotified ?? false,
  };
  const { settings } = state;
  const fresh = metricsPast(usage, settings.warnPercent).filter((m) => !next.warned.includes(m));
  for (const m of fresh) {
    const line = `${SPEND_METRIC_LABEL[m]}: ${formatSpend(m, usage[m]!)} of ${formatSpend(m, SPEND_INCLUDED[m])} included this month (${Math.floor(percentOf(m, usage[m]!))}%). At ${settings.guardPercent}% only operators can use Wecra until the 1st.`;
    console.warn(`spend guard: ${line}`);
    await tellOperators(deps, line);
    next.warned.push(m);
  }
  const after: GuardState = { settings, snapshot: next };
  const decision = decide(after, now);
  if (decision.active && decision.reason === "usage" && !next.guardNotified) {
    const past = metricsPast(usage, settings.guardPercent).map((m) => SPEND_METRIC_LABEL[m]);
    const line = `${past.join(", ")} reached ${settings.guardPercent}% of what's included this month. Wecra now serves only operators until the 1st. Settings › Operator can change this.`;
    console.warn(`spend guard: ${line}`);
    await tellOperators(deps, line);
    next.guardNotified = true;
  }
  if (material(state, after, now)) {
    await d1
      .prepare(`INSERT INTO server_settings (k, v, updated_at, updated_by) VALUES ('spend_usage', ?1, ?2, NULL) ON CONFLICT (k) DO UPDATE SET v = ?1, updated_at = ?2, updated_by = NULL`)
      .bind(JSON.stringify(next), now)
      .run();
    resetGuardCache(after, now);
    return after;
  }
  return state;
}

/** Whether the new snapshot is worth a write over the stored one */
export function material(before: GuardState, after: GuardState, now: number): boolean {
  const a = before.snapshot;
  const b = after.snapshot!;
  if (!a || a.month !== b.month || a.error !== b.error || a.guardNotified !== b.guardNotified || a.warned.length !== b.warned.length) return true;
  if (now - a.writtenAt >= HOUR) return true;
  if (decide(before, now).active !== decide(after, now).active) return true;
  for (const m of SPEND_METRICS) {
    const x = a.usage[m];
    const y = b.usage[m];
    if ((x === undefined) !== (y === undefined)) return true;
    if (x !== undefined && y !== undefined && Math.abs(percentOf(m, y) - percentOf(m, x)) >= MATERIAL_POINTS) return true;
  }
  return false;
}

/** The bell of every operator who has an account (and nothing else when none has) */
async function tellOperators(deps: CheckDeps, text: string): Promise<void> {
  const emails = operatorEmails(deps as Deps);
  if (emails.length === 0) return;
  const { results } = await deps.db.d1
    .prepare(`SELECT id FROM users WHERE email IN (${emails.map((_, i) => `?${i + 1}`).join(", ")}) AND google_sub NOT LIKE 'deleted:%'`)
    .bind(...emails)
    .all<{ id: string }>();
  for (const { id } of results) await notifyCapacity(deps as Deps, { userId: id, text });
}

// ---- Settings › Operator -------------------------------------------------------------------------------------------------

export function statusOf(state: GuardState, env: GuardEnv, now: number, storage: number | null = null): SpendGuardStatus {
  const month = monthOf(now);
  const snap = state.snapshot?.month === month ? state.snapshot : null;
  const { active, reason } = decide(state, now);
  const usage: Usage = snap?.usage ?? {};
  const forced = state.settings.mode === "normal" || state.settings.mode === "operator_only";
  return {
    mode: forced && state.settings.modeMonth !== month ? "auto" : state.settings.mode,
    warnPercent: state.settings.warnPercent,
    guardPercent: state.settings.guardPercent,
    active,
    reason,
    configured: configured(env),
    month,
    checkedAt: state.snapshot?.checkedAt ?? null,
    error: configured(env) ? (state.snapshot?.error ?? null) : "CF_API_TOKEN or CF_ACCOUNT_ID isn't set",
    serverStorageBytes: storage ?? QUOTA_LIMITS.server_storage_bytes,
    serverStorageCustom: storage !== null,
    usage: SPEND_METRICS.map((m: SpendMetric) => ({ metric: m, label: SPEND_METRIC_LABEL[m], used: usage[m] ?? null, included: SPEND_INCLUDED[m], percent: usage[m] === undefined ? null : percentOf(m, usage[m]!) })),
  };
}

const wholePercent = (v: unknown) => typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 100;

/** `/operator/spend-guard…` (operatorRoute has checked the caller) */
export async function spendGuardRoute(req: Request, deps: Deps, user: User, parts: string[]): Promise<Response> {
  const d1 = deps.db.d1;
  const env = deps.env as GuardEnv;
  if (parts.length === 3 && parts[2] === "check" && req.method === "POST") {
    const state = await checkSpend(deps);
    return json(statusOf(state, env, deps.now(), await serverStorageSetting(d1)));
  }
  if (parts.length !== 2) throw new HttpError(404, "not found");
  if (req.method === "PATCH") {
    const b = await body<{ mode?: unknown; warnPercent?: unknown; guardPercent?: unknown; serverStorageBytes?: unknown }>(req);
    const cap = b.serverStorageBytes;
    if (cap !== undefined && cap !== null && (typeof cap !== "number" || !Number.isInteger(cap) || cap < MIN_SERVER_STORAGE || cap > MAX_SERVER_STORAGE)) throw new HttpError(400, "serverStorageBytes is a whole number of bytes from 1 MB to 1 TB, or null for the default");
    const current = (await readGuard(d1)).settings;
    const next: GuardSettings = { ...current };
    if (b.mode !== undefined) {
      if (!SPEND_GUARD_MODES.includes(b.mode as SpendGuardMode)) throw new HttpError(400, `mode is one of ${SPEND_GUARD_MODES.join(", ")}`);
      next.mode = b.mode as SpendGuardMode;
      next.modeMonth = next.mode === "normal" || next.mode === "operator_only" ? monthOf(deps.now()) : null;
    }
    for (const k of ["warnPercent", "guardPercent"] as const) {
      if (b[k] === undefined) continue;
      if (!wholePercent(b[k])) throw new HttpError(400, `${k} is a whole number from 1 to 100`);
      next[k] = b[k] as number;
    }
    if (next.warnPercent > next.guardPercent) throw new HttpError(400, "The warning can't come after the guard: warnPercent ≤ guardPercent");
    await d1
      .prepare(`INSERT INTO server_settings (k, v, updated_at, updated_by) VALUES ('spend_guard', ?1, ?2, ?3) ON CONFLICT (k) DO UPDATE SET v = ?1, updated_at = ?2, updated_by = ?3`)
      .bind(JSON.stringify(next), deps.now(), user.id)
      .run();
    if (cap === null) await d1.prepare(`DELETE FROM server_settings WHERE k = 'server_storage_bytes'`).run();
    else if (cap !== undefined)
      await d1
        .prepare(`INSERT INTO server_settings (k, v, updated_at, updated_by) VALUES ('server_storage_bytes', ?1, ?2, ?3) ON CONFLICT (k) DO UPDATE SET v = ?1, updated_at = ?2, updated_by = ?3`)
        .bind(String(cap), deps.now(), user.id)
        .run();
    // This isolate at once; the others within a minute
    resetGuardCache();
  } else if (req.method !== "GET") throw new HttpError(405, "method not allowed");
  return json(statusOf(await readGuard(d1), env, deps.now(), await serverStorageSetting(d1)));
}
