/**
 * The daily AI usage report (docs/ai.md §2.9): the store sends, for each (org, UTC day, editor type) of org files, the
 * day's **absolute** credits so far — `POST /me/ai-usage {rows}` → `{accepted, dropped}`; the server upserts
 * `ai_usage_daily.seat_credits` (migration 0015), so sending a row again is harmless. `GET /v1/ai_usage/daily`
 * (docs/multiplayer.md §16.7) reads those rows.
 */
import type { EditorType } from "../org/types";

export interface AiUsageReportRow {
  orgId: string;
  /** UTC, YYYY-MM-DD */
  day: string;
  editorType: EditorType;
  /** The person's credits that day in that org's files of that type, in all (not a delta) */
  credits: number;
}

/** Rows per call */
export const AI_REPORT_MAX_ROWS = 200;
/** Days back the server still takes (a month and a few days, so a month's last days arrive after a week offline) */
export const AI_REPORT_KEEP_DAYS = 35;
/** One person's credits in a day, at most */
export const AI_REPORT_MAX_CREDITS = 10_000_000;
