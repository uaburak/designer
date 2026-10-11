/**
 * The Admin location (docs/design-system.md "Admin"; research docs/research/figma/R19-admin.md): Figma's admin
 * sections in a left sidebar — Dashboard, People (People | User groups), Content (Teams | Workspaces | Unassigned
 * drafts), Activity, Billing (Overview | Billing groups), Settings — each a page with its header and tabs, against
 * `AdminRepository` (docs/multiplayer.md §14.6). Home mounts it for admins; `?admin` runs it on the fake.
 */
import { useCallback, useState } from "react";
import { Icon, SidebarDivider, SidebarItem, Tabs, type IconName } from "@/ds";
import { ActivityTab } from "./Activity";
import { BillingGroupsTab, BillingOverview } from "./Billing";
import { TeamsTab, UnassignedDraftsTab, WorkspacesTab } from "./Content";
import { Dashboard, GuestRequestsPage, SeatRequestsPage } from "./Dashboard";
import { PeopleTab, UserGroupsTab } from "./People";
import { SettingsTab } from "./Settings";
import { AdminContext, useAdmin, useAdminState, useLoad, type AdminStore } from "./context";
import { styles } from "./parts";


export type AdminSection = "dashboard" | "people" | "content" | "activity" | "billing" | "settings";

const SECTIONS: { id: AdminSection; label: string; icon: IconName; tabs?: { value: string; label: string }[] }[] = [
  { id: "dashboard", label: "Dashboard", icon: "24.grid" },
  { id: "people", label: "People", icon: "24.person", tabs: [{ value: "people", label: "People" }, { value: "groups", label: "User groups" }] },
  { id: "content", label: "Content", icon: "24.folder", tabs: [{ value: "teams", label: "Teams" }, { value: "workspaces", label: "Workspaces" }, { value: "unassigned", label: "Unassigned drafts" }] },
  { id: "activity", label: "Activity", icon: "24.recent" },
  { id: "billing", label: "Billing", icon: "24.list-view", tabs: [{ value: "overview", label: "Overview" }, { value: "groups", label: "Billing groups" }] },
  { id: "settings", label: "Settings", icon: "24.settings.small" },
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
}

export function AdminApp({ orgId, store, onExportCsv, onBack, initial, now = Date.now }: AdminAppProps) {
  const ctx = useAdminState(orgId, store, onExportCsv, now);
  return (
    <AdminContext.Provider value={ctx}>
      <AdminLayout onBack={onBack} initial={initial} />
    </AdminContext.Provider>
  );
}

function AdminLayout({ onBack, initial }: { onBack?: () => void; initial?: AdminAppProps["initial"] }) {
  const [section, setSection] = useState<AdminSection>(initial?.section ?? "dashboard");
  const [tabs, setTabs] = useState<Partial<Record<AdminSection, string>>>(initial?.tab ? { [initial.section]: initial.tab } : {});
  const [dashView, setDashView] = useState<"seatRequests" | "guestRequests" | null>(null);
  const meta = SECTIONS.find((s) => s.id === section)!;
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
        {SECTIONS.map((s) => (
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
  const { orgId, store } = useAdmin();
  const { data } = useLoad(() => (store.orgs ? store.orgs.get(orgId).then((o) => o.name) : Promise.resolve("Organization")), [orgId, store.orgs]);
  return (
    <div className={styles.org}>
      <span className={styles.orgName}>{data ?? ""}</span>
      <span className={styles.orgTag}>Admin</span>
    </div>
  );
}

