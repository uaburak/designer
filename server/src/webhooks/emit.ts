/**
 * Webhooks V2's events (docs/multiplayer.md §16.9, §16.10): the server pieces outside `rest/` call `emitWebhook` after
 * something happened to a file. It finds the ACTIVE webhooks whose context reaches the file — the file's own (and its
 * main file's, for a branch), its folder chain's, its team's when the file is open to the team (Inherited, no Limited
 * folder on the way) — queues one `webhook_requests` row each and sends them through `waitUntil` (deliver.ts).
 */
import type { WebhookEvent, WebhookEventType, WebhookPayload } from "../../../src/shared/rest/types";
import type { Deps } from "../api";
import type { Db } from "../db";
import { deliverRows } from "./deliver";

export type WebhookEventInput = Exclude<WebhookEvent, { event_type: "PING" }>;

export interface HookRow {
  id: number;
  event_type: string;
  context: "team" | "project" | "file";
  context_id: string;
  passcode: string;
  endpoint: string;
}

/** The ACTIVE webhooks of `eventType` whose context reaches the file (null `eventType`: any event) */
export async function hooksFor(db: Db, fileKey: string, eventType: Exclude<WebhookEventType, "PING"> | null): Promise<HookRow[]> {
  const d1 = db.d1;
  const f = await d1.prepare(`SELECT key, team_id, project_id, access FROM files WHERE key = ?1`).bind(fileKey).first<{ key: string; team_id: string | null; project_id: string | null; access: string }>();
  if (!f) return [];
  const branch = await d1.prepare(`SELECT main_key FROM branches WHERE key = ?1`).bind(fileKey).first<{ main_key: string }>();
  // A branch is reached through its main file's place (§16.9: a file webhook fires for its branches too).
  const place = branch ? ((await d1.prepare(`SELECT key, team_id, project_id, access FROM files WHERE key = ?1`).bind(branch.main_key).first<typeof f>()) ?? f) : f;
  const files = branch ? [fileKey, branch.main_key] : [fileKey];
  const { results: chain } = place.project_id
    ? await d1
        .prepare(
          `WITH RECURSIVE chain(id, n) AS (SELECT id, 0 FROM projects WHERE id = ?1
             UNION ALL SELECT p.parent_id, c.n + 1 FROM chain c JOIN projects p ON p.id = c.id WHERE p.parent_id IS NOT NULL AND c.n < 11)
           SELECT p.id, p.access FROM chain c JOIN projects p ON p.id = c.id ORDER BY c.n`,
        )
        .bind(place.project_id)
        .all<{ id: string; access: string }>()
    : { results: [] as { id: string; access: string }[] };
  // A team webhook reaches the files open to the team (Figma: not in Limited folders, not Limited files).
  const team = place.team_id && place.access !== "limited" && !chain.some((p) => p.access === "limited") ? place.team_id : null;
  const { results } = await d1
    .prepare(
      `SELECT id, event_type, context, context_id, passcode, endpoint FROM webhooks WHERE status = 'ACTIVE' AND (?1 IS NULL OR event_type = ?1) AND (
         (context = 'file' AND context_id IN (SELECT value FROM json_each(?2)))
         OR (context = 'project' AND context_id IN (SELECT value FROM json_each(?3)))
         OR (context = 'team' AND context_id = ?4)) ORDER BY id`,
    )
    .bind(eventType, JSON.stringify(files), JSON.stringify(chain.map((p) => p.id)), team)
    .all<HookRow>();
  return results;
}

/** Does any webhook a FILE_UPDATE could reach exist for the file? (the room asks at wake, §16.10) */
export async function fileHasWebhooks(db: Db, fileKey: string): Promise<boolean> {
  return (await hooksFor(db, fileKey, "FILE_UPDATE")).length > 0;
}

/** Queue `payload` for `hooks` (one row each, attempt 0, due now); the row ids */
export async function queue(deps: Pick<Deps, "db" | "now">, hooks: HookRow[], event: WebhookEvent): Promise<number[]> {
  const now = deps.now();
  const ids: number[] = [];
  for (const h of hooks) {
    const payload: WebhookPayload = { ...event, passcode: h.passcode, timestamp: new Date(now).toISOString(), webhook_id: String(h.id) } as WebhookPayload;
    const r = await deps.db.d1
      .prepare(`INSERT INTO webhook_requests (webhook_id, endpoint, payload, attempt, next_at, created_at) VALUES (?1, ?2, ?3, 0, ?4, ?4) RETURNING id`)
      .bind(h.id, h.endpoint, JSON.stringify(payload), now)
      .first<{ id: number }>();
    if (r) ids.push(r.id);
  }
  return ids;
}

export async function emitWebhook(
  deps: Deps,
  event: WebhookEventInput,
  ctx: { fileKey: string; orgId: string | null; teamId: string | null; projectId: string | null },
  waitUntil: (p: Promise<unknown>) => void,
): Promise<void> {
  try {
    const hooks = await hooksFor(deps.db, ctx.fileKey, event.event_type);
    if (!hooks.length) return;
    const ids = await queue(deps, hooks, event);
    waitUntil(deliverRows(deps, ids).catch((e) => console.error("webhooks: delivery failed", e)));
  } catch (e) {
    // An event never fails the action that raised it.
    console.error("webhooks: not emitted", event.event_type, e);
  }
}

/** `waitUntil` from Deps (inline when absent, as in tests) */
export const waitOf = (deps: Deps) => (p: Promise<unknown>) => (deps.waitUntil ? deps.waitUntil(p) : void p);

/** FILE_UPDATE from the room's alarm (§16.10), with the object's own D1 */
export async function emitFileUpdate(db: Db, env: Deps["env"], fileKey: string, waitUntil: (p: Promise<unknown>) => void): Promise<void> {
  const f = await db.d1.prepare(`SELECT name, org_id, team_id, project_id FROM files WHERE key = ?1`).bind(fileKey).first<{ name: string; org_id: string | null; team_id: string | null; project_id: string | null }>();
  if (!f) return;
  const deps = { db, env, now: () => Date.now(), fetch: (...a: Parameters<typeof fetch>) => fetch(...a), rooms: { fetch: async () => new Response(null, { status: 404 }) } } as Deps;
  await emitWebhook(deps, { event_type: "FILE_UPDATE", file_key: fileKey, file_name: f.name }, { fileKey, orgId: f.org_id, teamId: f.team_id, projectId: f.project_id }, waitUntil);
}
