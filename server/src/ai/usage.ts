/**
 * AI usage from the people's apps (docs/ai.md §2.9; docs/multiplayer.md §16.7):
 *
 *   POST /me/ai-usage {rows: AiUsageReportRow[]}   → {accepted, dropped}
 *
 * Each row is the caller's credits so far on one UTC day in one org's files of one editor type — an absolute total, so
 * the upsert into `ai_usage_daily` (0015) is idempotent: `seat_credits` is replaced, never added to. Plan credits (a
 * pooled allowance) don't exist here and stay 0. Kept: orgs the caller is in (members and guests), days in
 * [today − 35, today + 1] (UTC, a day of slack for clocks), Figma's editor types, credits 0…10,000,000. The caller's
 * workspace and billing group are copied from their membership (the `/v1` rows name them). Rate: 60 calls an hour per
 * person, per Worker isolate (as library analytics).
 */
import { AI_REPORT_KEEP_DAYS, AI_REPORT_MAX_CREDITS, AI_REPORT_MAX_ROWS, type AiUsageReportRow } from "../../../src/shared/ai/usageReport";
import type { EditorType } from "../../../src/shared/org/types";
import { body, HttpError, json, type Ctx } from "../org/http";
import { EDITOR_TYPES } from "../org/orgs";

const DAY_MS = 86_400_000;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
export const AI_CALLS_PER_HOUR = 60;

const utcDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

const calls = new Map<string, { hour: number; n: number }>();
function rateLimit(userId: string, now: number): void {
  const hour = Math.floor(now / 3_600_000);
  const c = calls.get(userId);
  if (!c || c.hour !== hour) calls.set(userId, { hour, n: 1 });
  else if (++c.n > AI_CALLS_PER_HOUR) throw new HttpError(429, "too many AI usage reports; try again later", "rate_limited");
  if (calls.size > 10_000) for (const [k, v] of calls) if (v.hour !== hour) calls.delete(k);
}

export async function aiUsageRoute(ctx: Ctx): Promise<Response> {
  const { parts, m, deps, user, acc } = ctx;
  if (parts.length !== 2 || m !== "POST") throw new HttpError(405, "method not allowed");
  const input = await body<{ rows?: unknown }>(ctx.req);
  if (!Array.isArray(input.rows)) throw new HttpError(400, "rows is required");
  if (input.rows.length > AI_REPORT_MAX_ROWS) throw new HttpError(413, `at most ${AI_REPORT_MAX_ROWS} rows per call`);
  rateLimit(user.id, deps.now());
  const now = deps.now();
  const oldest = utcDay(now - AI_REPORT_KEEP_DAYS * DAY_MS);
  const newest = utcDay(now + DAY_MS);
  // One row per key: the last one sent wins (they are totals).
  const rows = new Map<string, AiUsageReportRow>();
  let dropped = 0;
  for (const r of input.rows as Partial<AiUsageReportRow>[]) {
    const ok =
      r && typeof r === "object" &&
      typeof r.orgId === "string" && r.orgId.length > 0 && r.orgId.length <= 64 &&
      typeof r.day === "string" && DAY.test(r.day) && r.day >= oldest && r.day <= newest && !Number.isNaN(Date.parse(r.day)) &&
      EDITOR_TYPES.includes(r.editorType as EditorType) &&
      typeof r.credits === "number" && Number.isFinite(r.credits) && r.credits >= 0 && r.credits <= AI_REPORT_MAX_CREDITS;
    if (!ok) {
      dropped++;
      continue;
    }
    const k = `${r.orgId}\u0000${r.day}\u0000${r.editorType}`;
    if (rows.has(k)) dropped++;
    rows.set(k, { orgId: r.orgId!, day: r.day!, editorType: r.editorType as EditorType, credits: Math.round(r.credits! * 100) / 100 });
  }
  let accepted = 0;
  for (const r of rows.values()) {
    const member = await acc.membership(r.orgId);
    if (!member) {
      dropped++;
      continue;
    }
    await acc.d1
      .prepare(
        `INSERT INTO ai_usage_daily (org_id, user_id, day, editor_type, seat_credits, plan_credits, workspace_id, team_id, billing_group_id)
         VALUES (?1, ?2, ?3, ?4, ?5, 0, ?6, NULL, ?7)
         ON CONFLICT (org_id, user_id, day, editor_type) DO UPDATE SET seat_credits = excluded.seat_credits, workspace_id = excluded.workspace_id, billing_group_id = excluded.billing_group_id`,
      )
      .bind(r.orgId, user.id, r.day, r.editorType, r.credits, member.workspace_id ?? null, member.billing_group_id ?? null)
      .run();
    accepted++;
  }
  return json({ accepted, dropped });
}
