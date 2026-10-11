/**
 * The webhook events of the server's own routes (docs/multiplayer.md §16.10), each built from what the route just wrote
 * and handed to `emitWebhook`: FILE_COMMENT (comments.ts), FILE_VERSION_UPDATE (branches.ts, the versions routes),
 * LIBRARY_PUBLISH (libraries/routes.ts). Never failing the route that raised them.
 */
import type { LibraryItemData, RestUser } from "../../../src/shared/rest/types";
import type { Deps } from "../api";
import type { User } from "../db";
import { emitWebhook, waitOf, type WebhookEventInput } from "./emit";

const who = (u: Pick<User, "id" | "name" | "email">): RestUser => ({ id: u.id, handle: u.name || u.email, img_url: null });

async function place(deps: Deps, key: string) {
  return deps.db.d1.prepare(`SELECT key, name, org_id, team_id, project_id FROM files WHERE key = ?1`).bind(key).first<{ key: string; name: string; org_id: string | null; team_id: string | null; project_id: string | null }>();
}

async function emit(deps: Deps, key: string, make: (fileName: string) => WebhookEventInput | WebhookEventInput[]): Promise<void> {
  try {
    const f = await place(deps, key);
    if (!f) return;
    const events = make(f.name);
    for (const e of Array.isArray(events) ? events : [events]) await emitWebhook(deps, e, { fileKey: key, orgId: f.org_id, teamId: f.team_id, projectId: f.project_id }, waitOf(deps));
  } catch (e) {
    console.error("webhooks: event not built", e);
  }
}

/** FILE_COMMENT after a comment or reply was posted */
export async function commentPosted(deps: Deps, key: string, user: User, commentId: string): Promise<void> {
  const c = await deps.db.d1
    .prepare(`SELECT id, thread_id, message, mentions, number, created_at, resolved_at FROM comments WHERE id = ?1`)
    .bind(commentId)
    .first<{ id: string; thread_id: string; message: string; mentions: string; number: number | null; created_at: number; resolved_at: number | null }>();
  if (!c) return;
  let ids: string[] = [];
  try {
    ids = (JSON.parse(c.mentions) as unknown[]).filter((x): x is string => typeof x === "string");
  } catch {
    // none
  }
  const mentions: RestUser[] = [];
  for (const id of ids) {
    const u = await deps.db.user(id);
    if (u) mentions.push(who(u));
  }
  const root = c.thread_id === c.id;
  await emit(deps, key, (file_name) => ({
    event_type: "FILE_COMMENT",
    file_key: key,
    file_name,
    comment: [{ text: c.message }, ...mentions.map((m) => ({ mention: m.id }))],
    comment_id: c.id,
    mentions,
    order_id: root && c.number !== null ? String(c.number) : null,
    parent_id: root ? null : c.thread_id,
    created_at: new Date(c.created_at).toISOString(),
    resolved_at: c.resolved_at === null ? null : new Date(c.resolved_at).toISOString(),
    triggered_by: who(user),
  }));
}

/** FILE_VERSION_UPDATE after a named version (a new one, or an autosave given a name) */
export async function versionNamed(deps: Deps, key: string, user: User, v: { id: string; kind: string; title: string | null; description: string | null; createdAt: number }): Promise<void> {
  if (v.kind !== "named") return;
  await emit(deps, key, (file_name) => ({
    event_type: "FILE_VERSION_UPDATE",
    file_key: key,
    file_name,
    created_at: new Date(v.createdAt).toISOString(),
    version_id: v.id,
    label: v.title ?? "",
    description: v.description ?? "",
    triggered_by: who(user),
  }));
}

/** Asset changes of a publish: keys by what happened, with their kinds and names */
export interface PublishedChanges {
  created: { key: string; kind: string; name: string }[];
  modified: { key: string; kind: string; name: string }[];
  deleted: { key: string; kind: string; name: string }[];
}

/** Figma's split (ours: 200 items per list) */
export const LIBRARY_EVENT_ITEMS = 200;

/** LIBRARY_PUBLISH after a publish: one event per asset type that changed, split above 200 items in a list */
export async function libraryPublished(deps: Deps, key: string, user: User, description: string, ch: PublishedChanges): Promise<void> {
  const groups = { components: ["COMPONENT", "COMPONENT_SET"], styles: ["STYLE"], variables: ["VARIABLE"] } as const;
  const item = (a: { key: string; name: string }): LibraryItemData => ({ key: a.key, name: a.name });
  await emit(deps, key, (file_name) => {
    const out: WebhookEventInput[] = [];
    for (const [type, kinds] of Object.entries(groups) as [keyof typeof groups, readonly string[]][]) {
      const pick = (l: PublishedChanges["created"]) => l.filter((a) => kinds.includes(a.kind)).map(item);
      const lists = { created: pick(ch.created), modified: pick(ch.modified), deleted: pick(ch.deleted) };
      const n = Math.max(lists.created.length, lists.modified.length, lists.deleted.length);
      for (let i = 0; i < n; i += LIBRARY_EVENT_ITEMS) {
        const slice = (l: LibraryItemData[]) => l.slice(i, i + LIBRARY_EVENT_ITEMS);
        const empty: LibraryItemData[] = [];
        out.push({
          event_type: "LIBRARY_PUBLISH",
          file_key: key,
          file_name,
          description,
          created_components: type === "components" ? slice(lists.created) : empty,
          modified_components: type === "components" ? slice(lists.modified) : empty,
          deleted_components: type === "components" ? slice(lists.deleted) : empty,
          created_styles: type === "styles" ? slice(lists.created) : empty,
          modified_styles: type === "styles" ? slice(lists.modified) : empty,
          deleted_styles: type === "styles" ? slice(lists.deleted) : empty,
          created_variables: type === "variables" ? slice(lists.created) : empty,
          modified_variables: type === "variables" ? slice(lists.modified) : empty,
          deleted_variables: type === "variables" ? slice(lists.deleted) : empty,
          triggered_by: who(user),
        });
      }
    }
    return out;
  });
}
