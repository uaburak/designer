// Teams and organisations (docs/site.md §2.1, "Working together"; docs/multiplayer.md §14–§15): Home in an
// organisation — the app's own sidebar (files/Sidebar.tsx with files/OrgSidebar.tsx, rendered as they are) and a
// team's Members (files/OrgMain.tsx's team page: its header, Projects | Members, the invite row, each member's role,
// with Files.module.css) — and a glance at Admin › Settings (admin/Settings.tsx's rows: SAML SSO, two-factor for
// guests). One action: a member's role, "can view", opens its list over the field and becomes "can edit".
import { useRef, useState } from "react";
import { Button, IconButton } from "@/ds/components/Button";
import { Breadcrumb } from "@/ds/components/Breadcrumb";
import { Avatar } from "@/ds/components/Misc";
import { Select } from "@/ds/components/Select";
import { Switch } from "@/ds/components/Switch";
import { Tabs } from "@/ds/components/Tabs";
import { TextInput } from "@/ds/components/TextInput";
import admin from "@/admin/Admin.module.css";
import files from "@/files/Files.module.css";
import { OrgSidebar } from "@/files/OrgSidebar";
import { TeamIcon } from "@/files/parts";
import { Sidebar, type SidebarProps } from "@/files/Sidebar";
import type { OrgInfo } from "@shared/org/types";
import type { FileListItem } from "@shared/store/types";
import { Collage, CURSOR, Cursor, Piece, usePointer } from "../collage/kit";
import { noop } from "../collage/ui";
import { BEZIER } from "../runtime/easing";
import type { Run } from "../runtime/motion";
import { highlight, optionOf, pointOf } from "./pick";
import styles from "./together.module.css";

const ORG = "Orbit Studio";
const TEAM = "Product design";
const ROLE_OPTIONS = [{ value: "admin", label: "admin" }, { value: "editor", label: "can edit" }, { value: "viewer", label: "can view" }, "-" as const, { value: "remove", label: "Remove" }];

interface Member {
  name: string;
  email: string;
  role: "owner" | "admin" | "editor" | "viewer";
  group?: number;
}
const MEMBERS: Member[] = [
  { name: "Burak Koç", email: "burak@orbit.studio", role: "owner" },
  { name: "Mert Demir", email: "mert@orbit.studio", role: "viewer" },
  { name: "Ayşe Kaya", email: "ayse@orbit.studio", role: "admin" },
  { name: "Deniz Aydın", email: "deniz@orbit.studio", role: "editor" },
  { name: "Brand", email: "", role: "viewer", group: 6 },
];

const TEAM_LOCATION = { kind: "team", teamId: "product", tab: "members" } as const;

const sidebar: SidebarProps = {
  ownerName: "Burak Koç",
  onAccountMenu: noop,
  teamName: ORG,
  location: TEAM_LOCATION,
  search: "",
  onSearch: noop,
  onSearchExit: noop,
  go: noop,
  folders: { children: () => [] } as unknown as SidebarProps["folders"],
  expanded: new Set(),
  onToggle: noop,
  starredFolders: [],
  starredFiles: [
    { fileKey: "a", name: "Orbit — Website" },
    { fileKey: "b", name: "Design system" },
  ] as FileListItem[],
  starredOpen: true,
  onStarredOpen: noop,
  onOpenFile: noop,
  onFolderMenu: noop,
  onFileMenu: noop,
  onAllFoldersMenu: noop,
  onTrashMenu: noop,
  dnd: { accepts: () => false, drop: noop },
  onSpaceMenu: noop,
  spaceBadge: "Enterprise",
  allProjects: { kind: "all-projects" },
};
const ORG_INFO = { role: "admin", workspaceAdminOf: [], billingGroupAdminOf: [] } as unknown as OrgInfo;

export default function WorkspaceCollage() {
  const [open, setOpen] = useState(false);
  const [mert, setMert] = useState<Member["role"]>("viewer");
  const me = usePointer([600, 560]);
  const rowRef = useRef<HTMLLIElement>(null);

  const script = async (run: Run) => {
    await run.wait(1400);
    const field = pointOf(rowRef.current?.querySelector('[data-ds="Select"] button'), [0.45, 0.55]);
    if (field) await me.click(run, field, { beat: 260 });
    setOpen(true);
    await run.wait(500);
    const option = optionOf(rowRef.current, "can edit");
    const at = pointOf(option, [0.42, 0.55]);
    if (at) await me.to(run, at, { ms: 560, ease: BEZIER.standard });
    highlight(option);
    await me.click(run, undefined, { beat: 320 });
    setMert("editor");
    setOpen(false);
  };

  return (
    <Collage size={[1100, 620]} focus={[0.32, 0.5]} safe={680} script={script}>
      <Piece surface x={32} y={32} w={672} h={556} d={0} from="up">
        <div className={styles.home}>
          <Sidebar {...sidebar} spaceSection={<OrgSidebar info={ORG_INFO} location={TEAM_LOCATION} go={noop} />} />
          <main className={files.main}>
            <header className={files.topbar}>
              <div className={files.nav}>
                <IconButton icon="24.arrow.left" label="Back" tone="secondary" tooltip={false} />
                <IconButton icon="24.arrow.right" label="Forward" tone="secondary" disabled tooltip={false} />
              </div>
              <div className={files.title}>
                <Breadcrumb items={[{ id: "teams", label: "All teams" }, { id: "product", label: TEAM }]} onNavigate={noop} />
              </div>
            </header>
            <div className={`${files.orgContent} ${styles.content}`}>
              <div className={files.teamHeader}>
                <span className={files.roundIcon}>
                  <TeamIcon name={TEAM} size={32} />
                </span>
                <div className={files.headerTitleRow}>
                  <h1 className={files.teamTitle}>{TEAM}</h1>
                </div>
              </div>
              <Tabs className={files.orgTabs} label="Sections" value="members" tabs={[{ value: "main", label: "Projects" }, { value: "members", label: "Members" }]} onChange={noop} />
              <div className={files.membersPane}>
                <div className={files.inviteRow}>
                  <TextInput className={files.inviteEmail} label="Email" placeholder="Add people by email" size="large" value="" onChange={noop} />
                  <Select label="Permission" width="hug" value="editor" options={ROLE_OPTIONS.slice(1, 3)} onChange={noop} />
                  <Button variant="primary" size="large" disabled>
                    Invite
                  </Button>
                </div>
                <ul className={files.memberList}>
                  {MEMBERS.map((m) => {
                    const mine = m.name === "Mert Demir";
                    const role = mine ? mert : m.role;
                    return (
                      <li key={m.name} ref={mine ? rowRef : undefined} className={`${files.memberRow} ${styles.memberRow} ${styles.overField}`} data-open={(mine && open) || undefined} style={{ ["--over" as string]: "60px" }}>
                        <span className={files.memberWho}>
                          <Avatar name={m.name} />
                          <span className={files.memberText}>
                            <span className={files.memberName}>{m.name}</span>
                            <span className={files.mutedText}>{m.group ? `${m.group} members` : m.email}</span>
                          </span>
                        </span>
                        {m.role === "owner" ? (
                          <span className={files.memberRole}>owner</span>
                        ) : (
                          <Select label={`${m.name}’s permission`} variant="ghost" width="hug" value={role} options={ROLE_OPTIONS} onChange={noop} static={mine && open} />
                        )}
                      </li>
                    );
                  })}
                </ul>
              </div>
            </div>
          </main>
        </div>
      </Piece>

      {/* Admin › Settings: how members log in, and two-factor for guests */}
      <Piece surface x={728} y={96} w={340} d={160} from="right" className={styles.admin}>
        <div className={styles.adminHead}>
          <strong>Admin</strong>
          <span>›</span>
          <span>Settings</span>
        </div>
        <section className={admin.settingsGroup}>
          <h2 className={admin.settingsGroupTitle}>Login and provisioning</h2>
          <div className={admin.settingRow}>
            <span className={admin.settingText}>
              <span className={admin.settingLabel}>Authentication</span>
              <span className={admin.settingDescription}>Members must log in with SAML SSO.</span>
            </span>
            <span className={admin.settingValue}>SAML SSO</span>
          </div>
          <div className={admin.settingRow}>
            <span className={admin.settingText}>
              <span className={admin.settingLabel}>SAML SSO</span>
              <span className={admin.settingDescription}>Let members log in through your identity provider.</span>
            </span>
            <span className={admin.settingValue}>Okta · Tested</span>
          </div>
        </section>
        <section className={admin.settingsGroup}>
          <h2 className={admin.settingsGroupTitle}>External access</h2>
          <div className={admin.settingRow}>
            <span className={admin.settingText}>
              <span className={admin.settingLabel}>2FA for Guests</span>
              <span className={admin.settingDescription}>Guests must use two-factor authentication to open the organization’s content.</span>
            </span>
            <Switch label="2FA for Guests" checked onChange={noop} />
          </div>
        </section>
      </Piece>

      <Cursor {...me.state} color={CURSOR.ink} d={300} z={30} />
    </Collage>
  );
}
