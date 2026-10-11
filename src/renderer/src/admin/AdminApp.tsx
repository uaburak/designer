/**
 * The Admin location (docs/design-system.md "Admin"; research docs/research/figma/R19-admin.md): Figma's admin
 * sections in a left sidebar — Dashboard, People (People | User groups), Content (Teams | Workspaces | Unassigned
 * drafts), Resources (Libraries | Fonts), Activity, Billing (Overview | Billing groups), Settings — each a page with its
 * header and tabs, against `AdminRepository` (docs/multiplayer.md §14.6), `orgLibraries` (docs/data.md §16.10) and the
 * preload's shared fonts (docs/desktop.md §14.3). A workspace admin who isn't an org admin gets the workspace's own
 * Admin (`workspace`): its Libraries. Home mounts it for admins; `?admin` runs it on the fake.
 */
import { useCallback, useState } from "react";
import { Icon, SidebarDivider, SidebarItem, Tabs, type IconName } from "@/ds";
import { ActivityTab } from "./Activity";
import { BillingGroupsTab, BillingOverview } from "./Billing";
import { TeamsTab, UnassignedDraftsTab, WorkspacesTab } from "./Content";
import { Dashboard, GuestRequestsPage, SeatRequestsPage } from "./Dashboard";
import { PeopleTab, UserGroupsTab } from "./People";
import { FontsTab, LibrariesTab } from "./Resources";
import { SettingsTab } from "./Settings";
import { AdminContext, useAdmin, useAdminState, useLoad, type AdminStore, type AdminWorkspaceScope } from "./context";
import type { SharedFontsApi } from "@shared/desktop";
import { styles } from "./parts";


export type AdminSection = "dashboard" | "people" | "content" | "resources" | "activity" | "billing" | "settings" | "libraries";

const SECTIONS: { id: AdminSection; label: string; icon: IconName; tabs?: { value: string; label: string }[] }[] = [
  { id: "dashboard", label: "Dashboard", icon: "24.grid" },
  { id: "people", label: "People", icon: "24.person", tabs: [{ value: "people", label: "People" }, { value: "groups", label: "User groups" }] },
  { id: "content", label: "Content", icon: "24.folder", tabs: [{ value: "teams", label: "Teams" }, { value: "workspaces", label: "Workspaces" }, { value: "unassigned", label: "Unassigned drafts" }] },
  { id: "resources", label: "Resources", icon: "24.library", tabs: [{ value: "libraries", label: "Libraries" }, { value: "fonts", label: "Fonts" }] },
  { id: "activity", label: "Activity", icon: "24.recent" },
  { id: "billing", label: "Billing", icon: "24.list-view", tabs: [{ value: "overview", label: "Overview" }, { value: "groups", label: "Billing groups" }] },
  { id: "settings", label: "Settings", icon: "24.settings.small" },
];
/** A workspace admin's Admin › ‹workspace› (Figma: "select the workspace, open the Libraries tab") */
const WORKSPACE_SECTIONS: typeof SECTIONS = [{ id: "libraries", label: "Libraries", icon: "24.library" }];

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
}

export function AdminApp({ orgId, store, onExportCsv, onBack, initial, now = Date.now, fonts, workspace }: AdminAppProps) {
  const ctx = useAdminState(orgId, store, onExportCsv, now, fonts, workspace);
  return (
    <AdminContext.Provider value={ctx}>
      <AdminLayout onBack={onBack} initial={initial} />
    </AdminContext.Provider>
  );
}

function AdminLayout({ onBack, initial }: { onBack?: () => void; initial?: AdminAppProps["initial"] }) {
  const { workspace } = useAdmin();
  const sections = workspace ? WORKSPACE_SECTIONS : SECTIONS;
  const [section, setSection] = useState<AdminSection>(initial && sections.some((s) => s.id === initial.section) ? initial.section : sections[0].id);
  const [tabs, setTabs] = useState<Partial<Record<AdminSection, string>>>(initial?.tab ? { [initial.section]: initial.tab } : {});
  const [dashView, setDashView] = useState<"seatRequests" | "guestRequests" | null>(null);
  const meta = sections.find((s) => s.id === section)!;
  const tab = tabs[section] ?? meta.tabs?.[0].value;
  const go = useCallback((s: AdminSection) => {
    setSection(s);
    setDashView(null);
  }, []);
  const title = section === "dashboard" && dashView ? (dashView === "seatRequests" ? "Seat requests" : "Guest requests") : meta.label;
  return (
    <div className={styles.app} data-admin="">
      <nav className={styles.sidebar} aria-label="Admin">
        <OrgHeader />
        {onBack && <SidebarItem icon="24.arrow.left" label="Back to files" onClick={onBack} />}
        {onBack && <SidebarDivider />}
        {sections.map((s) => (
          <SidebarItem key={s.id} icon={s.icon} label={s.label} selected={s.id === section} onClick={() => go(s.id)} />
        ))}
      </nav>
      <main className={styles.main}>
        <header className={styles.header}>
          {section === "dashboard" && dashView && (
            <button type="button" className={`${styles.sort} ${styles.back}`} aria-label="Back to Dashboard" onClick={() => setDashView(null)}>
              <Icon name="24.arrow.left" />
            </button>
          )}
          <h1 className={styles.title}>{title}</h1>
        </header>
        {meta.tabs && (
          <div className={styles.tabs}>
            <Tabs label={meta.label} value={tab!} tabs={meta.tabs} onChange={(v) => setTabs((t) => ({ ...t, [section]: v }))} />
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
          {section === "libraries" && workspace && <LibrariesTab workspaceId={workspace.id} />}
          {section === "activity" && <ActivityTab />}
          {section === "billing" && tab === "overview" && <BillingOverview />}
          {section === "billing" && tab === "groups" && <BillingGroupsTab />}
          {section === "settings" && <SettingsTab />}
        </div>
      </main>
    </div>
  );
}

function OrgHeader() {
  const { orgId, store, workspace } = useAdmin();
  const { data } = useLoad(() => (workspace ? Promise.resolve(workspace.name) : store.orgs ? store.orgs.get(orgId).then((o) => o.name) : Promise.resolve("Organization")), [orgId, store.orgs, workspace?.name]);
  return (
    <div className={styles.org}>
      <span className={styles.orgName}>{data ?? ""}</span>
      <span className={styles.orgTag}>Admin</span>
    </div>
  );
}

