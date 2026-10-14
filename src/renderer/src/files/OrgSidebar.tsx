/**
 * The sidebar's entries in an organization: All teams (the teams aren't listed here — the owner's Home, 2026-10-14: All
 * teams lists them, a team's page its folders), Resources, Trash, and Admin for the org's admins. All projects sits
 * above, in Sidebar (it spans every org).
 */
import { SidebarItem } from "@/ds";
import { t, useT } from "@/i18n";
import type * as O from "@shared/org/types";
import type { Location } from "./model";
import styles from "./Files.module.css";

export interface OrgSidebarProps {
  info: O.OrgInfo | null;
  location: Location;
  go: (loc: Location) => void;
}

export function OrgSidebar({ info, location, go }: OrgSidebarProps) {
  useT();
  const is = (kind: Location["kind"]) => location.kind === kind;
  return (
    <div className={styles.navGroup}>
      <SidebarItem icon="24.view.grid" label={t("All teams")} selected={is("teams") || is("team") || is("project")} onClick={() => go({ kind: "teams" })} />
      <SidebarItem icon="24.library" label={t("Resources")} selected={is("resources")} onClick={() => go({ kind: "resources" })} />
      <SidebarItem icon="24.trash.outline" label={t("Trash")} selected={is("org-trash")} onClick={() => go({ kind: "org-trash" })} />
      {(info?.role === "admin" || !!info?.workspaceAdminOf.length || !!info?.billingGroupAdminOf.length) && <SidebarItem icon="24.settings.small" label={t("Admin")} selected={is("admin")} onClick={() => go({ kind: "admin" })} />}
    </div>
  );
}
