/**
 * The daily roll-up (docs/data.md §17.5): `scheduled()` at 03:17 UTC recomputes what the analytics views read, for
 * the day D = yesterday (UTC), in a few statements that run inside D1 (the Worker spends no CPU on rows):
 *   1. library_asset_stats — per asset of every published library: instances, files and teams using it (current
 *      snapshots, drafts / branches / trashed files left out; a component set counts its variants), inserts and
 *      detaches over [D − 29, D];
 *   2. library_stats — per library: teams using it (instances, or actions in the last 30 days), the last whole week's
 *      inserts (Sunday–Saturday, Figma's weeks), the last seven days' inserts and detaches, through_day = D;
 *   3. retention — actions older than 53 weeks; the activity log older than a year (moved here from its read, §14.15).
 */
import type { D1Like } from "../db";
import { RETENTION_MS } from "../activity";
import { utcDay } from "./ingest";

const DAY_MS = 86_400_000;
const addDays = (day: string, n: number) => utcDay(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS);

/** The Sunday a day's week starts on (Figma's API weeks: Sunday 00:00 UTC) */
export const weekOf = (day: string): string => addDays(day, -new Date(`${day}T00:00:00Z`).getUTCDay());

/** The last whole week up to `day`: [Sunday, Saturday] */
export function lastWholeWeek(day: string): [string, string] {
  if (new Date(`${day}T00:00:00Z`).getUTCDay() === 6) return [addDays(day, -6), day];
  const sunday = weekOf(day);
  return [addDays(sunday, -7), addDays(sunday, -1)];
}

const LIVE_FILE = `f.project_id IS NOT NULL AND f.trashed_at IS NULL AND NOT EXISTS (SELECT 1 FROM branches b WHERE b.key = f.key)`;

export async function rollup(d1: D1Like, now: number): Promise<{ day: string }> {
  const D = utcDay(now - DAY_MS);
  const from30 = addDays(D, -29);
  const [weekStart, weekEnd] = lastWholeWeek(D);
  const from7 = addDays(D, -6);

  await d1
    .prepare(
      `WITH a AS (
         SELECT la.library_key, la.key, la.kind, la.component_set_key FROM library_assets la JOIN libraries l ON l.key = la.library_key
         WHERE l.status = 'published' AND la.dependency_only = 0 AND la.kind IN ('COMPONENT', 'COMPONENT_SET', 'STYLE', 'VARIABLE')
       ),
       m AS (
         SELECT library_key, key AS src, key AS dst FROM a
         UNION ALL SELECT library_key, key, component_set_key FROM a WHERE kind = 'COMPONENT' AND component_set_key IS NOT NULL
       ),
       u AS (
         SELECT m.library_key, m.dst, SUM(u.instances) AS inst, COUNT(DISTINCT u.file_key) AS files, COUNT(DISTINCT f.team_id) AS teams
         FROM m JOIN library_usage u ON u.library_key = m.library_key AND u.asset_key = m.src JOIN files f ON f.key = u.file_key
         WHERE ${LIVE_FILE} GROUP BY m.library_key, m.dst
       ),
       d AS (
         SELECT m.library_key, m.dst, SUM(CASE WHEN x.action = 'insert' THEN x.count ELSE 0 END) AS ins, SUM(CASE WHEN x.action = 'detach' THEN x.count ELSE 0 END) AS det
         FROM m JOIN library_actions_daily x ON x.library_key = m.library_key AND x.asset_key = m.src
         WHERE x.day BETWEEN ?1 AND ?2 GROUP BY m.library_key, m.dst
       )
       INSERT OR REPLACE INTO library_asset_stats (library_key, asset_key, asset_type, instances, files_using, teams_using, inserts_30d, detaches_30d)
       SELECT a.library_key, a.key, CASE a.kind WHEN 'STYLE' THEN 'style' WHEN 'VARIABLE' THEN 'variable' ELSE 'component' END,
              COALESCE(u.inst, 0), COALESCE(u.files, 0), COALESCE(u.teams, 0), COALESCE(d.ins, 0), COALESCE(d.det, 0)
       FROM a LEFT JOIN u ON u.library_key = a.library_key AND u.dst = a.key LEFT JOIN d ON d.library_key = a.library_key AND d.dst = a.key`,
    )
    .bind(from30, D)
    .run();

  await d1
    .prepare(
      `INSERT OR REPLACE INTO library_stats (library_key, teams_using, inserts_last_week, inserts_this_week, detaches_this_week, through_day)
       SELECT l.key,
         (SELECT COUNT(*) FROM (
            SELECT f.team_id AS t FROM library_usage u JOIN files f ON f.key = u.file_key WHERE u.library_key = l.key AND f.team_id IS NOT NULL AND ${LIVE_FILE}
            UNION SELECT team_id FROM library_actions_daily WHERE library_key = l.key AND day BETWEEN ?1 AND ?2 AND team_id IS NOT NULL)),
         (SELECT COALESCE(SUM(count), 0) FROM library_actions_daily WHERE library_key = l.key AND action = 'insert' AND day BETWEEN ?3 AND ?4),
         (SELECT COALESCE(SUM(count), 0) FROM library_actions_daily WHERE library_key = l.key AND action = 'insert' AND day BETWEEN ?5 AND ?2),
         (SELECT COALESCE(SUM(count), 0) FROM library_actions_daily WHERE library_key = l.key AND action = 'detach' AND day BETWEEN ?5 AND ?2),
         ?2
       FROM libraries l WHERE l.status = 'published'`,
    )
    .bind(from30, D, weekStart, weekEnd, from7)
    .run();

  await d1.prepare(`DELETE FROM library_actions_daily WHERE day < ?1`).bind(addDays(D, -371)).run();
  await d1.prepare(`DELETE FROM activity_log WHERE at < ?1`).bind(now - RETENTION_MS).run();
  return { day: D };
}

export { addDays };
