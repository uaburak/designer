/**
 * The Admin location (docs/design-system.md "Admin"; research docs/research/figma/R19-admin.md): Figma's admin
 * sections in a left sidebar — Dashboard, People (People | User groups), Content (Teams | Workspaces | Unassigned
 * drafts), Resources (Libraries | Fonts), Activity, Billing (Overview | Billing groups), Settings — each a page with its
 * header and tabs, against `AdminRepository` (docs/multiplayer.md §14.6), `orgLibraries` (docs/data.md §16.10) and the
 * preload's shared fonts (docs/desktop.md §14.3). A workspace admin who isn't an org admin gets the workspace's own
 * Admin (`workspace`): its Libraries. Home mounts it for admins; `?admin` runs it on the fake.
 */
import { useState } from "react";
import { Icon, SidebarDivider, SidebarItem, Tabs, type IconName } from "@/ds";
import { ActivityTab, DeveloperLogsTab } from "./Activity";
import { BillingGroupsTab, BillingOverview } from "./Billing";
import { TeamsTab, UnassignedDraftsTab, WorkspaceSettings, WorkspacesTab } from "./Content";
import { Dashboard, GuestRequestsPage, SeatRequestsPage } from "./Dashboard";
import { PeopleTab, UserGroupsTab } from "./People";
import { FontsTab, LibrariesTab } from "./Resources";
import { SettingsTab } from "./Settings";
import { PluginsTab } from "./Plugins";
import type { PluginRequest } from "@shared/plugins/types";
import { AdminContext, useAdmin, useAdminState, useLoad, type AdminStore, type AdminWorkspaceScope } from "./context";
import type { SharedFontsApi } from "@shared/desktop";
import { styles } from "./parts";
import { TeamIcon } from "@/files/parts";
import { t, useT } from "@/i18n";


export type AdminSection = "dashboard" | "people" | "content" | "resources" | "activity" | "billing" | "settings" | "workspace" | "libraries" | "plugins";

const SECTIONS: { id: AdminSection; label: string; icon: IconName; tabs?: { value: string; label: string }[] }[] = [
  { id: "dashboard", label: "Dashboard", icon: "24.grid" },
  { id: "people", label: "People", icon: "24.person", tabs: [{ value: "people", label: "People" }, { value: "groups", label: "User groups" }] },
  { id: "content", label: "Content", icon: "24.folder", tabs: [{ value: "teams", label: "Teams" }, { value: "workspaces", label: "Workspaces" }, { value: "unassigned", label: "Unassigned drafts" }] },
  { id: "resources", label: "Resources", icon: "24.library", tabs: [{ value: "libraries", label: "Libraries" }, { value: "fonts", label: "Fonts" }, { value: "plugins", label: "Plugins" }, { value: "widgets", label: "Widgets" }] },
  { id: "activity", label: "Activity", icon: "24.recent" },
  { id: "billing", label: "Billing", icon: "24.list-view", tabs: [{ value: "overview", label: "Overview" }, { value: "groups", label: "Billing groups" }] },
  { id: "settings", label: "Settings", icon: "24.settings.small" },
];
/** Activity's tabs with Governance+'s Developer logs (ours: Figma shows them at figma.com/developers/log) */
const ACTIVITY_TABS = [{ value: "log", label: "Activity log" }, { value: "developer", label: "Developer logs" }];
/** A workspace admin's Admin › ‹workspace› (Figma: "select the workspace, open the Libraries tab") */
const WORKSPACE_SECTIONS: typeof SECTIONS = [
  { id: "libraries", label: "Libraries", icon: "24.library" },
  // Enterprise: a workspace admin approves plugins and widgets for the workspace (docs/plugins.md §10.2)
  { id: "plugins", label: "Plugins", icon: "24.plugin", tabs: [{ value: "plugins", label: "Plugins" }, { value: "widgets", label: "Widgets" }] },
  // The workspace itself: its name, members and default teams (what the server lets a workspace admin change)
  { id: "workspace", label: "Workspace", icon: "24.settings.small" },
];

export interface AdminAppProps {
  orgId: string;
  store: AdminStore;
  /** Saves a CSV (main's Save dialog in the app); default: a browser download */
  onExportCsv?: (fileName: string, csv: string) => void;
  /** "Back to files" at the top of the sidebar */
  onBack?: () => void;
  /** The section (and tab) to open with */
  initial?: { section: AdminSection; tab?: string };
  /** The clock (tests) */
  now?: () => number;
  /** Admin › Resources › Fonts: `designer.fonts` (the preload's SharedFontsApi); absent: the tab says it's the desktop app's */
  fonts?: SharedFontsApi;
  /** The viewer administers only this workspace (not the org): Admin › ‹workspace› › Libraries */
  workspace?: AdminWorkspaceScope;
  /** Settings › SAML SSO › Test: Home passes `(tenant) => designer.account.signIn({ tenant })` (docs/desktop.md §18); absent: Test is disabled */
  onTestSso?: (tenantId: string) => Promise<unknown>;
  /** Resources › Plugins › a request's "Try it out" (a new local draft outside the org with the plugin); absent: disabled */
  onTryPlugin?: (request: PluginRequest) => Promise<unknown>;
}

export function AdminApp({ orgId, store, onExportCsv, onBack, initial, now = Date.now, fonts, workspace, onTestSso, onTryPlugin }: AdminAppProps) {
  useT();
  const ctx = useAdminState(orgId, store, onExportCsv, now, fonts, workspace, onTestSso, onTryPlugin);
  return (
    <AdminContext.Provider value={ctx}>
      <AdminLayout onBack={onBack} initial={initial} />
    </AdminContext.Provider>
  );
}

function AdminLayout({ onBack, initial }: { onBack?: () => void; initial?: AdminAppProps["initial"] }) {
  useT();
  const { workspace, store } = useAdmin();
  // Round 14h: with `store.governance`, Activity gains the Developer logs tab (docs/governance.md §5)
  const sections = workspace ? WORKSPACE_SECTIONS : store.governance ? SECTIONS.map((s) => (s.id === "activity" ? { ...s, tabs: ACTIVITY_TABS } : s)) : SECTIONS;
  const [section, setSection] = useState<AdminSection>(initial && sections.some((s) => s.id === initial.section) ? initial.section : sections[0].id);
  const [tabs, setTabs] = useState<Partial<Record<AdminSection, string>>>(initial?.tab ? { [initial.section]: initial.tab } : {});
  const [dashView, setDashView] = useState<"seatRequests" | "guestRequests" | null>(null);
  const meta = sections.find((s) => s.id === section)!;
  const tab = tabs[section] ?? meta.tabs?.[0].value;
  const go = (s: AdminSection) => {
    setSection(s);
    setDashView(null);
  };
  const title = section === "dashboard" && dashView ? (dashView === "seatRequests" ? t("Seat requests") : t("Guest requests")) : t(meta.label);
  return (
    <div className={styles.app} data-admin="">
      <nav className={styles.sidebar} aria-label={t("Admin")}>
        <OrgHeader />
        {onBack && <SidebarItem icon="24.arrow.left" label={t("Back to files")} onClick={onBack} />}
        {onBack && <SidebarDivider />}
        {sections.map((s) => (
          <SidebarItem key={s.id} icon={s.icon} label={t(s.label)} selected={s.id === section} onClick={() => go(s.id)} />
        ))}
      </nav>
      <main className={styles.main}>
        <header className={styles.header}>
          {section === "dashboard" && dashView && (
            <button type="button" className={`${styles.sort} ${styles.back}`} aria-label={t("Back to Dashboard")} onClick={() => setDashView(null)}>
              <Icon name="24.arrow.left" />
            </button>
          )}
          <h1 className={styles.title}>{title}</h1>
        </header>
        {meta.tabs && (
          <div className={styles.tabs}>
            <Tabs label={t(meta.label)} value={tab!} tabs={meta.tabs.map((x) => ({ ...x, label: t(x.label) }))} onChange={(v) => setTabs((was) => ({ ...was, [section]: v }))} />
          </div>
        )}
        <div className={styles.body} data-admin-page={`${section}${tab ? `/${tab}` : ""}${dashView ? `/${dashView}` : ""}`}>
          {section === "dashboard" && !dashView && <Dashboard onView={setDashView} />}
          {section === "dashboard" && dashView === "seatRequests" && <SeatRequestsPage />}
          {section === "dashboard" && dashView === "guestRequests" && <GuestRequestsPage />}
          {section === "people" && tab === "people" && <PeopleTab />}
          {section === "people" && tab === "groups" && <UserGroupsTab />}
          {section === "content" && tab === "teams" && <TeamsTab />}
          {section === "content" && tab === "workspaces" && <WorkspacesTab />}
          {section === "content" && tab === "unassigned" && <UnassignedDraftsTab />}
          {section === "resources" && tab === "libraries" && <LibrariesTab />}
          {section === "resources" && tab === "fonts" && <FontsTab />}
          {section === "resources" && (tab === "plugins" || tab === "widgets") && <PluginsTab key={tab} kind={tab === "widgets" ? "widget" : "plugin"} />}
          {section === "workspace" && workspace && <WorkspaceSettings workspaceId={workspace.id} />}
          {section === "libraries" && workspace && <LibrariesTab workspaceId={workspace.id} />}
          {section === "plugins" && workspace && <PluginsTab key={tab} kind={tab === "widgets" ? "widget" : "plugin"} workspaceId={workspace.id} />}
          {section === "activity" && tab !== "developer" && <ActivityTab />}
          {section === "activity" && tab === "developer" && <DeveloperLogsTab />}
          {section === "billing" && tab === "overview" && <BillingOverview />}
          {section === "billing" && tab === "groups" && <BillingGroupsTab />}
          {section === "settings" && <SettingsTab />}
        </div>
      </main>
    </div>
  );
}

/** The sidebar's head: the org's icon (§14.16) and name with "Admin" (a workspace admin: the workspace's name) */
function OrgHeader() {
  useT();
  const { orgId, store, workspace } = useAdmin();
  const { data } = useLoad(
    () => (workspace ? Promise.resolve({ name: workspace.name, iconUrl: null }) : store.orgs ? store.orgs.get(orgId).then((o) => ({ name: o.name, iconUrl: o.iconUrl ?? null })) : Promise.resolve({ name: t("Organization"), iconUrl: null })),
    [orgId, store.orgs, workspace?.name],
  );
  return (
    <div className={styles.org}>
      {data && !workspace && <TeamIcon name={data.name} iconUrl={data.iconUrl} size={24} />}
      <span className={styles.orgName}>{data?.name ?? ""}</span>
      <span className={styles.orgTag}>{t("Admin")}</span>
    </div>
  );
}

