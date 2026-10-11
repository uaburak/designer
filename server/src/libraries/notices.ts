/**
 * Update notices (docs/data.md §16.7): who hears that a library published, changed status, or that an org's library
 * settings changed. The messages go through notifications.ts's inbox helpers.
 *
 * Recipients of a library's notices, in one query: the file's owner, members, its folder's members and the groups
 * invited to it; its team's owner, members and groups; and — scope `org` — the org's members and admins with an
 * account. More than 500: the rest after the answer (`deps.waitUntil`), inline where there is none (tests).
 */
import type { LibraryKey } from "../../../src/shared/libraries/orgTypes";
import type { Deps } from "../api";
import { inboxMessage, orgNotice } from "../notifications";

const FIRST = 500;

export async function libraryAudience(deps: Deps, key: LibraryKey): Promise<string[]> {
  const d1 = deps.db.d1;
  const lib = await d1
    .prepare(`SELECT l.org_id, l.scope, f.team_id, f.project_id FROM libraries l LEFT JOIN files f ON f.key = l.key WHERE l.key = ?1`)
    .bind(key)
    .first<{ org_id: string; scope: string; team_id: string | null; project_id: string | null }>();
  if (!lib) return [];
  // Two queries: D1 allows at most 5 terms in a compound SELECT ("too many terms in compound SELECT" past that).
  const [file, team] = await Promise.all([
    d1
      .prepare(
        `SELECT owner_id AS id FROM files WHERE key = ?1
         UNION SELECT user_id FROM members WHERE file_key = ?1 AND user_id IS NOT NULL
         UNION SELECT u.user_id FROM group_grants g JOIN user_group_members u ON u.group_id = g.group_id WHERE g.resource_type = 'file' AND g.resource_id = ?1
         UNION SELECT user_id FROM project_members WHERE project_id = ?2 AND user_id IS NOT NULL`,
      )
      .bind(key, lib.project_id)
      .all<{ id: string | null }>(),
    d1
      .prepare(
        `SELECT owner_id AS id FROM teams WHERE id = ?1
         UNION SELECT user_id FROM team_members WHERE team_id = ?1 AND user_id IS NOT NULL
         UNION SELECT u.user_id FROM group_grants g JOIN user_group_members u ON u.group_id = g.group_id WHERE g.resource_type = 'team' AND g.resource_id = ?1
         UNION SELECT user_id FROM org_members WHERE ?3 = 'org' AND org_id = ?2 AND role IN ('admin', 'member') AND user_id IS NOT NULL`,
      )
      .bind(lib.team_id, lib.org_id, lib.scope)
      .all<{ id: string | null }>(),
  ]);
  return [...new Set([...file.results, ...team.results].map((r) => r.id).filter((x): x is string => !!x))];
}

/** Sends `message` to everyone: the first 500 now, the rest after the answer. */
export async function tell(deps: Deps, userIds: string[], message: unknown): Promise<void> {
  const now = userIds.slice(0, FIRST);
  const later = userIds.slice(FIRST);
  await inboxMessage(deps, now, message);
  if (!later.length) return;
  const rest = inboxMessage(deps, later, message);
  if (deps.waitUntil) deps.waitUntil(rest);
  else await rest;
}

/** A new version: `{t: "library", libraryKey, version}` */
export async function libraryPublishedNotice(deps: Deps, key: LibraryKey, version: number): Promise<void> {
  await tell(deps, await libraryAudience(deps, key), { t: "library", libraryKey: key, version });
}

/** Reads the audience now (before a deletion takes the rows); the returned function tells them the new status. */
export async function libraryStatusNotice(deps: Deps, key: LibraryKey): Promise<(status: string) => Promise<void>> {
  const audience = await libraryAudience(deps, key);
  return (status) => tell(deps, audience, { t: "library", libraryKey: key, status });
}

/** Approve, defaults, default modes, scope: the org's members drop their cached `listAvailable` (§16.7). */
export async function librarySettingsNotice(deps: Deps, orgId: string): Promise<void> {
  const { results } = await deps.db.d1.prepare(`SELECT user_id FROM org_members WHERE org_id = ?1 AND user_id IS NOT NULL`).bind(orgId).all<{ user_id: string }>();
  await orgNotice(deps, results.map((r) => r.user_id), { what: "libraries", orgId });
}
