/**
 * The spend guard's state and its per-request check (docs/multiplayer.md §17.1). Two rows of `server_settings`
 * (migration 0019): `spend_guard` — the operator's mode and thresholds — and `spend_usage` — the latest usage snapshot
 * the five-minute cron wrote (guard/check.ts). Requests never read D1 for it: each isolate keeps the two rows for at most
 * a minute (`guardState`), and the decision itself is a dozen comparisons made with the request's clock, so the 1st of
 * the month (UTC) lifts an automatic guard at once.
 */
import { CAPACITY_REACHED_TEXT, DEFAULT_GUARD_PERCENT, DEFAULT_WARN_PERCENT, SPEND_GUARD_MODES, SPEND_INCLUDED, SPEND_METRICS, monthOf, type SpendGuardMode, type SpendMetric } from "../../../src/shared/spendGuard";
import type { Deps } from "../api";
import type { D1Like } from "../db";
import { HttpError, type ErrorCode } from "../org/http";
import { isOperatorEmail } from "../quota/quota";
import type { Usage } from "./usage";

export interface GuardSettings {
  mode: SpendGuardMode;
  /** The month a forced `normal` / `operator_only` holds for ("2026-10") */
  modeMonth: string | null;
  warnPercent: number;
  guardPercent: number;
}

export interface UsageSnapshot {
  /** The month the usage is of */
  month: string;
  /** The last check that reached Cloudflare (ms) */
  checkedAt: number | null;
  /** When this row was written (ms) — rewritten at least hourly */
  writtenAt: number;
  /** Known metrics only: a failed check leaves nothing, so nothing is enforced */
  usage: Usage;
  error: string | null;
  /** Metrics the operators were told about this month (past warnPercent) */
  warned: SpendMetric[];
  /** The operators were told the guard engaged this month */
  guardNotified: boolean;
}

export interface GuardState {
  settings: GuardSettings;
  snapshot: UsageSnapshot | null;
}

export const DEFAULT_SETTINGS: GuardSettings = { mode: "auto", modeMonth: null, warnPercent: DEFAULT_WARN_PERCENT, guardPercent: DEFAULT_GUARD_PERCENT };
/** How long an isolate trusts its copy of the state */
export const REFRESH_MS = 60_000;

const parse = <T>(v: string | undefined): Partial<T> | null => {
  if (!v) return null;
  try {
    const o = JSON.parse(v) as unknown;
    return o && typeof o === "object" ? (o as Partial<T>) : null;
  } catch {
    return null;
  }
};
const percent = (v: unknown, fallback: number) => (typeof v === "number" && Number.isFinite(v) && v > 0 && v <= 1000 ? v : fallback);

/** The two rows (one read) */
export async function readGuard(d1: D1Like): Promise<GuardState> {
  const { results } = await d1.prepare(`SELECT k, v FROM server_settings WHERE k IN ('spend_guard', 'spend_usage')`).all<{ k: string; v: string }>();
  const s = parse<GuardSettings>(results.find((r) => r.k === "spend_guard")?.v) ?? {};
  const settings: GuardSettings = {
    mode: SPEND_GUARD_MODES.includes(s.mode as SpendGuardMode) ? (s.mode as SpendGuardMode) : "auto",
    modeMonth: typeof s.modeMonth === "string" ? s.modeMonth : null,
    warnPercent: percent(s.warnPercent, DEFAULT_WARN_PERCENT),
    guardPercent: percent(s.guardPercent, DEFAULT_GUARD_PERCENT),
  };
  const u = parse<UsageSnapshot>(results.find((r) => r.k === "spend_usage")?.v);
  const snapshot: UsageSnapshot | null =
    u && typeof u.month === "string"
      ? {
          month: u.month,
          checkedAt: typeof u.checkedAt === "number" ? u.checkedAt : null,
          writtenAt: typeof u.writtenAt === "number" ? u.writtenAt : 0,
          usage: u.usage && typeof u.usage === "object" ? u.usage : {},
          error: typeof u.error === "string" ? u.error : null,
          warned: Array.isArray(u.warned) ? u.warned.filter((m): m is SpendMetric => SPEND_METRICS.includes(m)) : [],
          guardNotified: u.guardNotified === true,
        }
      : null;
  return { settings, snapshot };
}

/** A metric's share of what's included, in percent */
export const percentOf = (metric: SpendMetric, used: number): number => (used / SPEND_INCLUDED[metric]) * 100;

/** The metrics at or past `threshold` percent in this usage */
export const metricsPast = (usage: Usage, threshold: number): SpendMetric[] => SPEND_METRICS.filter((m) => usage[m] !== undefined && percentOf(m, usage[m]!) >= threshold);

/** The mode in force this month: a forced one from an earlier month is `auto` again */
export function effectiveMode(settings: GuardSettings, now: number): SpendGuardMode {
  if ((settings.mode === "normal" || settings.mode === "operator_only") && settings.modeMonth !== monthOf(now)) return "auto";
  return settings.mode;
}

/** Whether non-operators are refused now, and why */
export function decide(state: GuardState, now: number): { active: boolean; reason: "usage" | "forced" | null } {
  const mode = effectiveMode(state.settings, now);
  if (mode === "off" || mode === "normal") return { active: false, reason: null };
  if (mode === "operator_only") return { active: true, reason: "forced" };
  const snap = state.snapshot;
  // Last month's usage doesn't count (Cloudflare's month starts again on the 1st, UTC); unknown usage isn't enforced
  if (!snap || snap.month !== monthOf(now)) return { active: false, reason: null };
  return metricsPast(snap.usage, state.settings.guardPercent).length > 0 ? { active: true, reason: "usage" } : { active: false, reason: null };
}

// ---- the per-isolate cache ---------------------------------------------------------------------------------------------

let cached: { at: number; state: GuardState } | null = null;
let loading: Promise<GuardState> | null = null;
let loggedReadFailure = false;

/** Tests, and this isolate after the operator changed the settings */
export function resetGuardCache(state?: GuardState, at = 0): void {
  cached = state ? { at, state } : null;
  loading = null;
}

/** The state, read from D1 at most once a minute per isolate (concurrent requests share the read). A failed read is
 *  no guard (and logged once). */
export async function guardState(deps: Pick<Deps, "db" | "now">): Promise<GuardState> {
  const now = deps.now();
  if (cached && now - cached.at < REFRESH_MS && now >= cached.at) return cached.state;
  loading ??= readGuard(deps.db.d1)
    .catch((e: unknown) => {
      if (!loggedReadFailure) console.error("spend guard: can't read its state; not enforcing", e);
      loggedReadFailure = true;
      return { settings: DEFAULT_SETTINGS, snapshot: null } satisfies GuardState;
    })
    .then((state) => {
      cached = { at: now, state };
      loading = null;
      return state;
    });
  return loading;
}

export async function guardActive(deps: Pick<Deps, "db" | "now">): Promise<boolean> {
  return decide(await guardState(deps), deps.now()).active;
}

// ---- enforcement (hooks in api.ts and quota.ts) -------------------------------------------------------------------------

export const capacityError = (): HttpError => new HttpError(503, CAPACITY_REACHED_TEXT, "capacity_reached" as ErrorCode);

/** An authenticated caller: refused unless an operator while the guard is on */
export async function requireCapacity(deps: Deps, user: { email: string }): Promise<void> {
  if ((await guardActive(deps)) && !isOperatorEmail(deps, user.email)) throw capacityError();
}

/** Public previews (`/p/…`, their public reads), file links (`/f/…`) and embeds: off for everyone while the guard is on */
const PUBLIC = /^\/(p|f|embed)\/|^\/previews\/[^/]+\/(manifest\.json|doc\.kiwi|images\/[0-9a-f]{40})$/;
export async function capacityGate(deps: Deps, path: string): Promise<void> {
  if (PUBLIC.test(path) && (await guardActive(deps))) throw capacityError();
}
