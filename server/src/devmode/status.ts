/**
 * Ready for dev: the status report, Dev Mode viewers and their notifications (docs/editor.md D-4; D1
 * `dev_mode_viewers`, migration 0015).
 *
 *   POST /files/:key/dev-status {nodeId, nodeName, status, kind, changeMessage?}   → 204
 *        the editor's report of a committed status change (shared files): DEV_MODE_STATUS_UPDATE (§16.9) and the
 *        notifications. Edit access and a Full or Dev seat in orgs.
 *   POST /files/:key/dev-status/viewed                                             → 204
 *        entering Dev Mode: upserts the caller into dev_mode_viewers (at most hourly; Full / Dev seats in orgs,
 *        everyone outside them) — the people told of status changes.
 *   GET  /files/:key/dev-status/notify                                             → {notify, viewed}
 *   PUT  /files/:key/dev-status/notify {notify}                                    → {notify}
 *        Dev Mode's comment panel › Settings: "Status changes" / "Nothing" for this file.
 *
 * Who is told: the file's Dev Mode viewers with notify on who can still open it with Dev Mode (resolveAccess; not
 * prototype-only), not the actor. `dev_ready` everywhere; `dev_completed` and `dev_changed` only for org files
 * (Figma: Organization / Enterprise). "removed" tells no one. Rows fold per person, kind and file within an hour
 * (notifications.ts).
 */
import type { DevStatus, DevStatusReport } from "../../../src/shared/devmode/types";
import type { AccessResult } from "../../../src/shared/org/access";
import type { RestUser } from "../../../src/shared/rest/types";
import type { Deps } from "../api";
import type { User } from "../db";
import { notifyDevStatus } from "../notifications";
import { canOpen, type FileRow } from "../org/db";
import { body, HttpError, noContent } from "../org/http";
import { emitWebhook } from "../webhooks/emit";
import { canReadDev, json, line, nodeId, requireReadDev, requireWriteDev } from "./common";
import { listResources } from "./devResources";

const STATUSES: DevStatus[] = ["READY_FOR_DEV", "COMPLETED", "NONE"];
const KINDS: DevStatusReport["kind"][] = ["ready", "completed", "changed_done", "removed"];
/** "Entering Dev Mode" counts once an hour per person and file */
export const VIEWED_EVERY_MS = 3_600_000;

export const restUser = (u: Pick<User, "id" | "name" | "email">): RestUser => ({ id: u.id, handle: u.name || u.email, img_url: null });

/** The people to tell of a status change (not the actor) */
export async function statusRecipients(deps: Deps, key: string, actorId: string): Promise<string[]> {
  const { results } = await deps.db.d1.prepare(`SELECT user_id FROM dev_mode_viewers WHERE file_key = ?1 AND notify = 1 AND user_id <> ?2`).bind(key, actorId).all<{ user_id: string }>();
  const out: string[] = [];
  for (const r of results) {
    const a = await canOpen(deps, key, r.user_id);
    if (a && canReadDev(a) && a.canDevMode) out.push(r.user_id);
  }
  return out;
}

export async function reportStatus(req: Request, deps: Deps, user: User, f: FileRow, report: DevStatusReport): Promise<void> {
  // The webhook: Figma's DEV_MODE_STATUS_UPDATE, with the node's dev resources as related links
  const links = (await listResources(deps, f.key, [report.nodeId])).map((r) => ({ id: r.id, name: r.name, url: r.url, file_key: r.fileKey, node_id: r.nodeId }));
  await emitWebhook(
    deps,
    { event_type: "DEV_MODE_STATUS_UPDATE", file_key: f.key, node_id: report.nodeId, status: report.status, change_message: report.changeMessage ?? "", related_links: links, triggered_by: restUser(user) },
    { fileKey: f.key, orgId: f.org_id, teamId: f.team_id, projectId: f.project_id },
    (p) => (deps.waitUntil ? deps.waitUntil(p) : void p.catch((e) => console.error("devmode: webhook failed", e))),
  );
  const kind = report.kind === "ready" ? "dev_ready" : report.kind === "completed" ? "dev_completed" : report.kind === "changed_done" ? "dev_changed" : null;
  if (!kind) return;
  if (kind !== "dev_ready" && !f.org_id) return;
  await notifyDevStatus(deps, { key: f.key, by: user, kind, design: report.nodeName, reason: report.changeMessage, userIds: await statusRecipients(deps, f.key, user.id) });
}

function cleanReport(b: Record<string, unknown>): DevStatusReport {
  const status = b.status as DevStatus;
  const kind = b.kind as DevStatusReport["kind"];
  if (!STATUSES.includes(status)) throw new HttpError(400, "status is READY_FOR_DEV, COMPLETED or NONE");
  if (!KINDS.includes(kind)) throw new HttpError(400, "kind is ready, completed, changed_done or removed");
  const expected: Record<DevStatusReport["kind"], DevStatus[]> = { ready: ["READY_FOR_DEV"], completed: ["COMPLETED"], changed_done: ["READY_FOR_DEV", "COMPLETED"], removed: ["NONE"] };
  if (!expected[kind].includes(status)) throw new HttpError(400, `kind ${kind} doesn't go with status ${status}`);
  const changeMessage = typeof b.changeMessage === "string" ? b.changeMessage.trim().slice(0, 500) : undefined;
  return { nodeId: nodeId(b.nodeId), nodeName: line(b.nodeName, 200) || "Untitled", status, kind, ...(changeMessage ? { changeMessage } : {}) };
}

/** `/files/:key/dev-status…` (parts: ["files", key, "dev-status", "viewed" | "notify"?]) */
export async function devStatusRoute(req: Request, deps: Deps, user: User, parts: string[], f: FileRow, a: AccessResult, isBranch: boolean): Promise<Response> {
  const m = req.method;
  const d1 = deps.db.d1;
  if (parts.length === 3 && m === "POST") {
    requireWriteDev(a);
    const report = cleanReport(await body(req));
    // A branch's statuses are its own until merged: nobody is told (ours; Figma's rule is unverified)
    if (!isBranch) await reportStatus(req, deps, user, f, report);
    return noContent();
  }
  if (parts.length === 4 && parts[3] === "viewed" && m === "POST") {
    requireReadDev(a);
    if (!a.ok || !a.canDevMode || isBranch) return noContent();
    const now = deps.now();
    await d1
      .prepare(`INSERT INTO dev_mode_viewers (file_key, user_id, viewed_at) VALUES (?1, ?2, ?3) ON CONFLICT (file_key, user_id) DO UPDATE SET viewed_at = ?3 WHERE viewed_at < ?4`)
      .bind(f.key, user.id, now, now - VIEWED_EVERY_MS)
      .run();
    return noContent();
  }
  if (parts.length === 4 && parts[3] === "notify") {
    requireReadDev(a);
    if (m === "GET") {
      const r = await d1.prepare(`SELECT notify FROM dev_mode_viewers WHERE file_key = ?1 AND user_id = ?2`).bind(f.key, user.id).first<{ notify: number }>();
      return json({ notify: r ? r.notify === 1 : true, viewed: !!r });
    }
    if (m === "PUT") {
      const { notify } = await body<{ notify?: unknown }>(req);
      if (typeof notify !== "boolean") throw new HttpError(400, "notify is true (Status changes) or false (Nothing)");
      await d1
        .prepare(`INSERT INTO dev_mode_viewers (file_key, user_id, viewed_at, notify) VALUES (?1, ?2, ?3, ?4) ON CONFLICT (file_key, user_id) DO UPDATE SET notify = ?4`)
        .bind(f.key, user.id, deps.now(), notify ? 1 : 0)
        .run();
      return json({ notify });
    }
  }
  throw new HttpError(405, "method not allowed");
}
