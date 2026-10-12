/**
 * The spend guard (docs/multiplayer.md §17.1; ours): Cloudflare has no hard spending cap, so the server keeps the
 * owner's bill at the Workers Paid base ($5/month) itself. Every five minutes it reads the account's month-to-date
 * usage from Cloudflare's GraphQL Analytics API; at 80% of any included amount the operators are told, at 95% the
 * server serves only its operators until the 1st (UTC). Shared by the server (server/src/guard/) and Settings › Operator.
 */

/** What the Workers Paid plan includes each month, as the guard measures it */
export type SpendMetric =
  | "workers_requests"
  | "workers_cpu_ms"
  | "do_requests"
  | "do_duration_gbs"
  | "do_rows_read"
  | "do_rows_written"
  | "do_storage_bytes"
  | "d1_rows_read"
  | "d1_rows_written"
  | "d1_storage_bytes"
  | "log_events";

export const SPEND_METRICS: readonly SpendMetric[] = ["workers_requests", "workers_cpu_ms", "do_requests", "do_duration_gbs", "do_rows_read", "do_rows_written", "do_storage_bytes", "d1_rows_read", "d1_rows_written", "d1_storage_bytes", "log_events"];

const GB = 1e9;

/**
 * Workers Paid's included usage per month: the owner's order summary (2026-10-12) — Workers 10M requests and 30M CPU-ms,
 * Durable Objects 1M requests, 400K GB-s and 1 GB of storage — and developers.cloudflare.com (read 2026-10-12) for the
 * rest: durable-objects/platform/pricing (WebSocket messages billed 20:1, SQLite rows), d1/platform/pricing, Workers Logs
 * (workers/observability/logs/workers-logs). Static-asset requests are free; the Cache API has no charge of its own;
 * Workers KV, R2, Queues aren't used. Storage is compared as a level (GB-month ≈ the stored size held all month).
 */
export const SPEND_INCLUDED: Record<SpendMetric, number> = {
  workers_requests: 10_000_000,
  workers_cpu_ms: 30_000_000,
  do_requests: 1_000_000,
  do_duration_gbs: 400_000,
  do_rows_read: 25_000_000_000,
  do_rows_written: 50_000_000,
  do_storage_bytes: 1 * GB,
  d1_rows_read: 25_000_000_000,
  d1_rows_written: 50_000_000,
  d1_storage_bytes: 5 * GB,
  log_events: 20_000_000,
};

export const SPEND_METRIC_LABEL: Record<SpendMetric, string> = {
  workers_requests: "Workers requests",
  workers_cpu_ms: "Workers CPU time",
  do_requests: "Durable Objects requests",
  do_duration_gbs: "Durable Objects duration",
  do_rows_read: "Durable Objects rows read",
  do_rows_written: "Durable Objects rows written",
  do_storage_bytes: "Durable Objects storage",
  d1_rows_read: "D1 rows read",
  d1_rows_written: "D1 rows written",
  d1_storage_bytes: "D1 storage",
  log_events: "Workers Logs events (estimated)",
};

/**
 * `auto` (default): the guard engages by itself at `guardPercent`. `normal` / `operator_only`: forced by the operator
 * until the end of the month (then `auto` again). `off`: no enforcement until changed (warnings still come).
 */
export type SpendGuardMode = "auto" | "normal" | "operator_only" | "off";
export const SPEND_GUARD_MODES: readonly SpendGuardMode[] = ["auto", "normal", "operator_only", "off"];
export const SPEND_GUARD_MODE_LABEL: Record<SpendGuardMode, string> = {
  auto: "Automatic",
  normal: "Everyone (this month)",
  operator_only: "Operators only (this month)",
  off: "Off (no enforcement)",
};

export const DEFAULT_WARN_PERCENT = 80;
export const DEFAULT_GUARD_PERCENT = 95;

/** 503 `capacity_reached`: every non-operator request while the guard is on */
export const CAPACITY_REACHED_TEXT = "Wecra has reached its capacity for this month. Try again on the 1st.";

export interface SpendUsageRow {
  metric: SpendMetric;
  label: string;
  /** Month to date; null when Cloudflare's API didn't say (Usage unknown) */
  used: number | null;
  included: number;
  /** used / included × 100, null when unknown */
  percent: number | null;
}

/** `GET /operator/spend-guard` */
export interface SpendGuardStatus {
  mode: SpendGuardMode;
  warnPercent: number;
  guardPercent: number;
  /** Non-operators are refused now */
  active: boolean;
  /** Why: "usage" (a metric past guardPercent) or "forced" (the operator's `operator_only`) */
  reason: "usage" | "forced" | null;
  /** CF_API_TOKEN and CF_ACCOUNT_ID are set */
  configured: boolean;
  /** "2026-10" (UTC) */
  month: string;
  /** The last check that reached Cloudflare (ms), null before the first */
  checkedAt: number | null;
  /** The last check's failure, if it failed */
  error: string | null;
  /** The cap on every account's stored bytes together (`server_storage_bytes`: the operator's, else QUOTA_LIMITS') */
  serverStorageBytes: number;
  /** The operator changed it */
  serverStorageCustom: boolean;
  usage: SpendUsageRow[];
}

/** "1.2M", "830K", "3.4 GB" — a metric's amount in the usage table */
export function formatSpend(metric: SpendMetric, n: number): string {
  if (metric === "do_storage_bytes" || metric === "d1_storage_bytes") {
    if (n >= GB) return `${(n / GB).toFixed(2)} GB`;
    return `${Math.round(n / 1e6)} MB`;
  }
  const unit = metric === "do_duration_gbs" ? " GB-s" : metric === "workers_cpu_ms" ? " ms" : "";
  if (n >= 1e9) return `${+(n / 1e9).toFixed(2)}B${unit}`;
  if (n >= 1e6) return `${+(n / 1e6).toFixed(2)}M${unit}`;
  if (n >= 1e3) return `${+(n / 1e3).toFixed(1)}K${unit}`;
  return `${Math.round(n)}${unit}`;
}

/** "2026-10" for a moment (UTC) */
export const monthOf = (ms: number): string => new Date(ms).toISOString().slice(0, 7);
