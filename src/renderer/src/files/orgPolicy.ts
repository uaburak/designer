/**
 * Org policies Home follows (docs/multiplayer.md §15.6, §15.9):
 *
 * - **Access to external content** [F-external]: a member whose home org (domain capture on, external content
 *   restricted) is another org can't create files or folders outside it — Home hides Design / Import / New folder /
 *   Create team in the local space and in other orgs' spaces (the server refuses with `external_restricted` anyway).
 *   The client doesn't see the org's domains, so the home org is the org where the person is a member or admin that
 *   has domain capture on and restricts external content (the server's `homeOrgId` also needs their email on one of its
 *   verified domains — capture puts everyone on them into the org, so the two agree for captured people).
 * - **Admin for workspace admins**: an org member who administers a workspace gets Admin › ‹workspace› (its Libraries).
 */
import { useEffect, useMemo, useState } from "react";
import type * as O from "@shared/org/types";
import type { OrgBackend } from "./storeAccess";

/** Said when a restricted member tries to create outside their home org (ours: Figma's words aren't documented) */
export const EXTERNAL_RESTRICTED_TEXT = "Your organization doesn’t allow you to create files outside it.";

/** The org restricting this person's external content, or null */
export function useHomeOrg(org: OrgBackend | undefined, orgs: readonly O.OrgSummary[]): string | null {
  // The answer for the org list it was read for (a changed list reads again)
  const [home, setHome] = useState<{ ids: string; home: string | null }>({ ids: "", home: null });
  const ids = orgs
    .filter((o) => o.role !== "guest")
    .map((o) => o.id)
    .sort()
    .join(",");
  useEffect(() => {
    if (!org || !ids) return;
    let live = true;
    void Promise.all(ids.split(",").map((id) => org.orgs.get(id).catch(() => null))).then((infos) => {
      if (!live) return;
      const restricting = infos.find((i) => i && i.role !== "guest" && i.settings.domainCapture && i.settings.externalContent === "restricted");
      setHome({ ids, home: restricting?.id ?? null });
    });
    return () => {
      live = false;
    };
  }, [org, ids]);
  return org && ids && home.ids === ids ? home.home : null;
}

/** Admin's `workspace` scope for a workspace admin who isn't an org admin (null: an org admin, or nobody) */
export function useAdminWorkspace(org: OrgBackend | undefined, orgId: string | null, info: O.OrgInfo | null): { id: string; name: string } | null {
  const [names, setNames] = useState<{ orgId: string; names: Record<string, string> } | null>(null);
  const first = info && info.id === orgId && info.role !== "admin" ? (info.workspaceAdminOf[0] ?? null) : null;
  useEffect(() => {
    if (!org || !orgId || !first) return;
    let live = true;
    void org.admin.workspaces(orgId).then(
      (list) => live && setNames({ orgId, names: Object.fromEntries(list.map((w) => [w.id, w.name])) }),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [org, orgId, first]);
  const name = (names?.orgId === orgId && first ? names.names[first] : undefined) ?? "Workspace";
  const on = !!org && !!orgId && !!first;
  return useMemo(() => (on && first ? { id: first, name } : null), [on, first, name]);
}
