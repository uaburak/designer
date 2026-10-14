/**
 * Admin › Content: Teams (hidden and deleted ones too, Restore, Get CSV — help.figma.com 18527655973015), Workspaces
 * (New workspace, admins, members, teams and default teams, Make it hidden — 4409612431383, 4419450594455) and
 * Unassigned drafts (a folder per removed person; Move, Permanently delete, Show trashed files — 4420549259799).
 */
import { useState } from "react";
import { Badge, Button, Checkbox, Dialog, Icon, SearchField, Select, Tabs, TextInput } from "@/ds";
import type { AdminPerson, AdminTeam, OrgFile, OrgWorkspace, UnassignedDrafts } from "@shared/org/types";
import { useAdmin, useLoad } from "./context";
import { formatAgo, formatDate, teamAccess } from "./labels";
import { LibrariesTab } from "./Resources";
import { ChoiceDialog, ConfirmDialog, Field, NameDialog, PickDialog, RowMenu, Table, Who, byNumber, byText, personItem, styles, type Column } from "./parts";
import { t, tp, useT } from "@/i18n";

// ---------------------------------------------------------------------------------------------------- Teams

export function TeamsTab() {
  useT();
  const { orgId, store, run, exportCsv, now } = useAdmin();
  const [text, setText] = useState("");
  const [workspaceId, setWorkspaceId] = useState("all");
  const [hidden, setHidden] = useState(true);
  const [deleted, setDeleted] = useState(false);
  const [confirm, setConfirm] = useState<AdminTeam | null>(null);
  const query = { text: text.trim() || undefined, workspaceId: workspaceId === "all" ? undefined : workspaceId, includeHidden: hidden, includeDeleted: deleted };
  const { data } = useLoad(() => store.admin.teams(orgId, query), [orgId, JSON.stringify(query)]);
  const { data: workspaces } = useLoad(() => store.admin.workspaces(orgId), [orgId]);
  const wsName = (id: string | null) => (id ? workspaces?.find((w) => w.id === id)?.name ?? "" : t("Unassigned"));
  const teamsApi = store.teams;
  const menu = (tm: AdminTeam) =>
    tm.deletedAt !== null
      ? [{ id: "restore", label: "Restore team" }]
      : [{ id: "visibility", label: tm.visibility === "hidden" ? "Make visible" : "Make hidden" }, "-" as const, { id: "delete", label: "Delete team", danger: true }];
  const columns: Column<AdminTeam>[] = [
    {
      id: "name", label: "Name", width: "minmax(200px, 2fr)", compare: byText((tm) => tm.name),
      render: (tm) => <span>{tm.name}{tm.visibility === "hidden" && <> <Badge>{t("Hidden")}</Badge></>}{tm.deletedAt !== null && <> <Badge tone="danger">{t("Deleted {date}", { date: formatDate(tm.deletedAt) })}</Badge></>}</span>,
    },
    { id: "owner", label: "Owner", compare: byText((tm) => tm.ownerName), render: (tm) => tm.ownerName ?? "" },
    { id: "members", label: "Members", width: 80, compare: byNumber((tm) => tm.memberCount), render: (tm) => tm.memberCount },
    { id: "folders", label: "Folders", width: 70, compare: byNumber((tm) => tm.projectCount), render: (tm) => tm.projectCount },
    { id: "files", label: "Files", width: 60, compare: byNumber((tm) => tm.fileCount), render: (tm) => tm.fileCount },
    { id: "access", label: "Access", width: 80, compare: byText(teamAccess), render: (tm) => teamAccess(tm) },
    { id: "workspace", label: "Workspace", compare: byText((tm) => wsName(tm.workspaceId)), render: (tm) => <span className={tm.workspaceId ? undefined : styles.muted}>{wsName(tm.workspaceId)}</span> },
    { id: "active", label: "Last active", width: 110, compare: byNumber((tm) => tm.lastEditedAt), render: (tm) => <span className={styles.muted}>{formatAgo(tm.lastEditedAt, now())}</span> },
    {
      id: "menu", label: "", width: 32, align: "end",
      render: (tm) => teamsApi && (
        <RowMenu
          label={t("Actions for {name}", { name: tm.name })}
          entries={menu(tm)}
          onSelect={(id) => {
            if (id === "restore") void run(() => teamsApi.restore(tm.id), t("Restored {name}", { name: tm.name }));
            else if (id === "visibility") void run(() => teamsApi.update(tm.id, { visibility: tm.visibility === "hidden" ? "visible" : "hidden" }));
            else if (id === "delete") setConfirm(tm);
          }}
        />
      ),
    },
  ];
  return (
    <>
      <div className={styles.toolbar}>
        <SearchField className={styles.search} value={text} onChange={setText} placeholder={t("Search teams")} />
        <Select label={t("Workspace")} width={180} value={workspaceId} options={[{ value: "all", label: t("All workspaces") }, ...(workspaces ?? []).map((w) => ({ value: w.id, label: w.name })), { value: "none", label: t("Unassigned") }]} onChange={setWorkspaceId} />
        <Checkbox label={t("Show hidden teams")} checked={hidden} onChange={setHidden} />
        <Checkbox label={t("Show deleted teams")} checked={deleted} onChange={setDeleted} />
        <span className={styles.spacer} />
        <span className={styles.muted}>{tp(data?.total ?? 0, "{n} team", "{n} teams")}</span>
        <Button variant="secondary" onClick={() => exportCsv("teams", query)}>{t("Get CSV")}</Button>
      </div>
      <Table label={t("Teams")} rows={data?.items ?? []} columns={columns} rowKey={(tm) => tm.id} muted={(tm) => tm.deletedAt !== null} initialSort={{ column: "name", direction: "ascending" }} empty="No teams" />
      {confirm && teamsApi && (
        <ConfirmDialog title={t("Delete {name}?", { name: confirm.name })} body={t("The team's folders and files are deleted for everyone. Its admins can restore it within 28 days.")} confirm="Delete team" destructive onConfirm={() => run(() => teamsApi.remove(confirm.id), t("Deleted {name}", { name: confirm.name }))} onClose={() => setConfirm(null)} />
      )}
    </>
  );
}

// ---------------------------------------------------------------------------------------------------- Workspaces

export function WorkspacesTab() {
  useT();
  const { orgId, store } = useAdmin();
  const { data } = useLoad(() => store.admin.workspaces(orgId), [orgId]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const open = data?.find((w) => w.id === openId);
  if (open) return <WorkspaceDetail workspace={open} onBack={() => setOpenId(null)} />;
  const columns: Column<OrgWorkspace>[] = [
    { id: "name", label: "Name", width: "minmax(180px, 2fr)", compare: byText((w) => w.name), render: (w) => <span>{w.name}{w.hidden && <> <Badge>{t("Hidden")}</Badge></>}</span> },
    { id: "admins", label: "Workspace admins", width: "minmax(180px, 2fr)", render: (w) => <span className={styles.muted}>{w.admins.map((a) => a.name ?? a.email).join(", ")}</span> },
    { id: "members", label: "Members", width: 90, compare: byNumber((w) => w.memberCount), render: (w) => w.memberCount },
    { id: "teams", label: "Teams", width: 80, compare: byNumber((w) => w.teamCount), render: (w) => w.teamCount },
    { id: "created", label: "Created", width: 120, compare: byNumber((w) => w.createdAt), render: (w) => <span className={styles.muted}>{formatDate(w.createdAt)}</span> },
  ];
  return (
    <>
      <div className={styles.toolbar}>
        <span className={styles.muted}>{t("Workspaces group related teams and people. Each person belongs to one workspace.")}</span>
        <span className={styles.spacer} />
        <Button variant="primary" onClick={() => setCreating(true)}>{t("New workspace")}</Button>
      </div>
      <Table label={t("Workspaces")} rows={data ?? []} columns={columns} rowKey={(w) => w.id} onRowClick={(w) => setOpenId(w.id)} initialSort={{ column: "name", direction: "ascending" }} empty="No workspaces yet" />
      {creating && <NewWorkspaceDialog onClose={() => setCreating(false)} onCreated={(id) => setOpenId(id)} />}
    </>
  );
}

function NewWorkspaceDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  useT();
  const { orgId, store, run } = useAdmin();
  const { data: people } = useLoad(() => store.admin.people(orgId), [orgId]);
  const [name, setName] = useState("");
  const [admins, setAdmins] = useState<string[]>([]);
  const [hidden, setHidden] = useState(false);
  const [picking, setPicking] = useState(false);
  const all = (people?.items ?? []).filter((p) => !p.pending && p.role !== "guest");
  const create = async () => {
    const w = await run(() => store.admin.createWorkspace(orgId, { name: name.trim(), adminIds: admins, hidden }), t("Created {name}", { name: name.trim() }));
    if (w) {
      onClose();
      onCreated(w.id);
    }
  };
  return (
    <>
      <Dialog
        title={t("New workspace")}
        open={!picking}
        size="medium"
        onClose={onClose}
        footer={
          <>
            <Button variant="secondary" onClick={onClose}>{t("Cancel")}</Button>
            <Button variant="primary" disabled={!name.trim() || admins.length === 0} onClick={() => void create()}>{t("Create workspace")}</Button>
          </>
        }
      >
        <div className={styles.form}>
          <Field title={t("Name")}>
            <TextInput label={t("Workspace name")} value={name} onChange={setName} placeholder={t("Workspace name")} variant="outlined" autoFocus />
          </Field>
          <Field title={t("Workspace admin")}>
            <div className={styles.chips}>
              {admins.map((id) => {
                const p = all.find((x) => x.id === id);
                return <span key={id} className={styles.chip}>{p?.name ?? p?.email}</span>;
              })}
              <Button variant="secondary" icon="24.plus.small" onClick={() => setPicking(true)}>{admins.length ? t("Change") : t("Add workspace admin")}</Button>
            </div>
          </Field>
          <Checkbox label={t("Make it hidden")} checked={hidden} onChange={setHidden} />
          <span className={styles.note}>{t("A hidden workspace is only shown to its members in All workspaces.")}</span>
        </div>
      </Dialog>
      {picking && <PickDialog title={t("Workspace admin")} items={all.map(personItem)} initial={admins} confirm="Done" min={1} onSave={setAdmins} onClose={() => setPicking(false)} />}
    </>
  );
}

function WorkspaceDetail({ workspace: w, onBack }: { workspace: OrgWorkspace; onBack: () => void }) {
  useT();
  const { orgId, store, run } = useAdmin();
  const [tab, setTab] = useState("members");
  const [dialog, setDialog] = useState<"rename" | "delete" | "admins" | "addMembers" | "addTeams" | null>(null);
  const { data: people } = useLoad(() => store.admin.people(orgId), [orgId]);
  const { data: teams } = useLoad(() => store.admin.teams(orgId, { includeHidden: true }), [orgId]);
  const all = people?.items ?? [];
  const members = all.filter((p) => p.workspaceId === w.id);
  const wsTeams = (teams?.items ?? []).filter((tm) => tm.workspaceId === w.id);
  const patch = (p: Parameters<typeof store.admin.updateWorkspace>[1], done?: string) => run(() => store.admin.updateWorkspace(w.id, p), done);
  const memberColumns: Column<AdminPerson>[] = [
    { id: "name", label: "Name", width: "minmax(220px, 2fr)", compare: byText((p) => p.name ?? p.email), render: (p) => <Who person={p} /> },
    { id: "role", label: "Role", width: 100, render: (p) => (w.admins.some((a) => a.id === p.id) ? t("Workspace admin") : p.role === "guest" ? t("Guest") : t("Member")) },
    { id: "remove", label: "", width: 90, align: "end", render: (p) => <Button variant="ghost" onClick={() => patch({ members: { remove: [p.id] } }, "Removed from workspace")}>{t("Remove")}</Button> },
  ];
  const teamColumns: Column<AdminTeam>[] = [
    { id: "name", label: "Name", width: "minmax(200px, 2fr)", compare: byText((tm) => tm.name), render: (tm) => <span>{tm.name}{tm.visibility === "hidden" && <> <Badge>{t("Hidden")}</Badge></>}</span> },
    { id: "members", label: "Members", width: 90, compare: byNumber((tm) => tm.memberCount), render: (tm) => tm.memberCount },
    {
      id: "default", label: "Default team", width: 110,
      render: (tm) => <Checkbox label={t("{name} is a default team", { name: tm.name })} hideLabel checked={w.defaultTeamIds.includes(tm.id)} onChange={(on) => patch({ defaultTeamIds: on ? [...w.defaultTeamIds, tm.id] : w.defaultTeamIds.filter((d) => d !== tm.id) }, on ? t("{name} is now a default team", { name: tm.name }) : undefined)} />,
    },
    { id: "remove", label: "", width: 90, align: "end", render: (tm) => <Button variant="ghost" onClick={() => patch({ teams: { remove: [tm.id] } }, "Removed from workspace")}>{t("Remove")}</Button> },
  ];
  const adminColumns: Column<OrgWorkspace["admins"][number]>[] = [{ id: "name", label: "Name", compare: byText((p) => p.name ?? p.email), render: (p) => <Who person={p} /> }];
  return (
    <>
      <div className={styles.toolbar}>
        <button type="button" className={`${styles.link} ${styles.back}`} onClick={onBack}><Icon name="24.arrow.left" /> {t("Workspaces")}</button>
      </div>
      <div className={styles.sectionHeader}>
        <h2 className={styles.sectionTitle}>{w.name}{w.hidden && <> <Badge>{t("Hidden")}</Badge></>}</h2>
        <Button variant="secondary" onClick={() => setDialog("rename")}>{t("Rename")}</Button>
        <Button variant="secondary" onClick={() => patch({ hidden: !w.hidden }, w.hidden ? "Workspace is visible" : "Workspace is hidden")}>{w.hidden ? t("Make it visible") : t("Make it hidden")}</Button>
        <Button variant="destructive-secondary" onClick={() => setDialog("delete")}>{t("Delete workspace")}</Button>
      </div>
      <div className={styles.toolbar}>
        <Tabs label={t("Workspace")} value={tab} onChange={setTab} tabs={[{ value: "members", label: t("Members ({n})", { n: members.length }) }, { value: "teams", label: t("Teams ({n})", { n: wsTeams.length }) }, { value: "admins", label: t("Workspace admins ({n})", { n: w.admins.length }) }, ...(store.orgLibraries ? [{ value: "libraries", label: t("Libraries") }] : [])]} />
        <span className={styles.spacer} />
        {tab === "members" && <Button variant="primary" onClick={() => setDialog("addMembers")}>{t("Add members")}</Button>}
        {tab === "teams" && <Button variant="primary" onClick={() => setDialog("addTeams")}>{t("Add teams")}</Button>}
        {tab === "admins" && <Button variant="primary" onClick={() => setDialog("admins")}>{t("Edit workspace admins")}</Button>}
      </div>
      {tab === "members" && <Table label={t("Workspace members")} rows={members} columns={memberColumns} rowKey={(p) => p.id} initialSort={{ column: "name", direction: "ascending" }} empty="No members in this workspace" />}
      {tab === "teams" && (
        <>
          <p className={styles.note}>{t("Members of this workspace are added to its default teams when they join, and when a team becomes a default team. Guests aren't.")}</p>
          <Table label={t("Workspace teams")} rows={wsTeams} columns={teamColumns} rowKey={(tm) => tm.id} initialSort={{ column: "name", direction: "ascending" }} empty="No teams in this workspace" />
        </>
      )}
      {tab === "admins" && <Table label={t("Workspace admins")} rows={w.admins} columns={adminColumns} rowKey={(p) => p.id} />}
      {tab === "libraries" && <LibrariesTab workspaceId={w.id} />}
      {dialog === "rename" && <NameDialog title={t("Rename workspace")} label={t("Workspace name")} value={w.name} confirm="Save" onSave={(name) => patch({ name })} onClose={() => setDialog(null)} />}
      {dialog === "delete" && <ConfirmDialog title={t("Delete {name}?", { name: w.name })} body={t("Its teams and people become unassigned. Nothing else is deleted.")} confirm="Delete workspace" destructive onConfirm={() => run(() => store.admin.deleteWorkspace(w.id), t("Deleted {name}", { name: w.name })).then(onBack)} onClose={() => setDialog(null)} />}
      {dialog === "admins" && <PickDialog title={t("Workspace admins")} items={all.filter((p) => !p.pending && p.role !== "guest").map(personItem)} initial={w.admins.map((a) => a.id)} confirm="Save" min={1} onSave={(ids) => patch({ adminIds: ids }, "Workspace admins saved")} onClose={() => setDialog(null)} />}
      {dialog === "addMembers" && <PickDialog title={t("Add members to {name}", { name: w.name })} items={all.filter((p) => p.workspaceId === null).map(personItem)} confirm="Add" min={1} onSave={(ids) => patch({ members: { add: ids } }, tp(ids.length, "Added {n} member", "Added {n} members"))} onClose={() => setDialog(null)} />}
      {dialog === "addTeams" && <PickDialog title={t("Add teams to {name}", { name: w.name })} items={(teams?.items ?? []).filter((tm) => tm.workspaceId === null && tm.deletedAt === null).map((tm) => ({ id: tm.id, label: tm.name, sub: tp(tm.memberCount, "{n} member", "{n} members") }))} confirm="Add" min={1} onSave={(ids) => patch({ teams: { add: ids } }, "Teams added")} onClose={() => setDialog(null)} />}
    </>
  );
}

// ---------------------------------------------------------------------------------------------------- Unassigned drafts

const PRODUCT: Record<OrgFile["editorType"], string> = { design: "Design", figjam: "FigJam", slides: "Slides", buzz: "Buzz", sites: "Sites", make: "Make" };

export function UnassignedDraftsTab() {
  useT();
  const { orgId, store, run, now } = useAdmin();
  const { data } = useLoad(() => store.admin.unassignedDrafts(orgId), [orgId]);
  const { data: teams } = useLoad(() => store.admin.teams(orgId, { includeHidden: true }), [orgId]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [trashed, setTrashed] = useState(false);
  const [move, setMove] = useState<{ ownerId?: string; fileKeys?: string[]; name: string } | null>(null);
  const [del, setDel] = useState<{ fileKeys: string[]; name: string } | null>(null);
  const folders = data ?? [];
  const open = folders.find((f) => f.owner.id === openId);
  const liveTeams = (teams?.items ?? []).filter((tm) => tm.deletedAt === null);
  const visible = (f: UnassignedDrafts) => f.files.filter((x) => trashed || x.trashedAt === null);
  const folderColumns: Column<UnassignedDrafts>[] = [
    { id: "name", label: "Name", width: "minmax(220px, 2fr)", compare: byText((f) => f.owner.name ?? f.owner.email), render: (f) => <span className={styles.who}><Icon name="24.folder" /><Who person={{ ...f.owner, picture: null }} /></span> },
    { id: "files", label: "Files", width: 80, compare: byNumber((f) => visible(f).length), render: (f) => visible(f).length },
    { id: "removed", label: "Removed", width: 140, compare: byNumber((f) => f.owner.removedAt), render: (f) => <span className={styles.muted}>{formatDate(f.owner.removedAt)}</span> },
    {
      id: "menu", label: "", width: 32, align: "end",
      render: (f) => <RowMenu label={t("Actions for {name}", { name: t("{name}'s drafts", { name: f.owner.name ?? f.owner.email }) })} entries={[{ id: "move", label: "Move" }, { id: "delete", label: "Permanently delete", danger: true }]} onSelect={(id) => (id === "move" ? setMove({ ownerId: f.owner.id, name: t("{name}'s drafts", { name: f.owner.name ?? f.owner.email }) }) : setDel({ fileKeys: f.files.map((x) => x.key), name: t("{name}'s drafts", { name: f.owner.name ?? f.owner.email }) }))} />,
    },
  ];
  const fileColumns: Column<OrgFile>[] = [
    { id: "name", label: "Name", width: "minmax(220px, 2fr)", compare: byText((f) => f.name), render: (f) => <span>{f.name}{f.trashedAt !== null && <> <Badge>{t("In trash")}</Badge></>}</span> },
    { id: "product", label: "Type", width: 90, compare: byText((f) => f.editorType), render: (f) => t(PRODUCT[f.editorType]) },
    { id: "updated", label: "Last modified", width: 130, compare: byNumber((f) => f.updatedAt), render: (f) => <span className={styles.muted}>{formatAgo(f.updatedAt, now())}</span> },
    { id: "menu", label: "", width: 32, align: "end", render: (f) => <RowMenu label={t("Actions for {name}", { name: f.name })} entries={[{ id: "move", label: "Move" }, { id: "delete", label: "Permanently delete", danger: true }]} onSelect={(id) => (id === "move" ? setMove({ fileKeys: [f.key], name: f.name }) : setDel({ fileKeys: [f.key], name: f.name }))} /> },
  ];
  return (
    <>
      <div className={styles.toolbar}>
        {open ? (
          <button type="button" className={`${styles.link} ${styles.back}`} onClick={() => setOpenId(null)}><Icon name="24.arrow.left" /> {t("Unassigned drafts")}</button>
        ) : (
          <span className={styles.muted}>{t("When someone is removed from the organization, their drafts move here. Move them into a team, or delete them for good.")}</span>
        )}
        <span className={styles.spacer} />
        <Checkbox label={t("Show trashed files")} checked={trashed} onChange={setTrashed} />
      </div>
      {open ? (
        <>
          <div className={styles.sectionHeader}><h2 className={styles.sectionTitle}>{t("{name}'s drafts", { name: open.owner.name ?? open.owner.email })}</h2></div>
          <Table label={t("Unassigned files")} rows={visible(open)} columns={fileColumns} rowKey={(f) => f.key} muted={(f) => f.trashedAt !== null} initialSort={{ column: "updated", direction: "descending" }} empty={t("No files")} />
        </>
      ) : (
        <Table label={t("Unassigned drafts")} rows={folders} columns={folderColumns} rowKey={(f) => f.owner.id} onRowClick={(f) => setOpenId(f.owner.id)} initialSort={{ column: "removed", direction: "descending" }} empty={t("No unassigned drafts")} />
      )}
      {move && (
        <ChoiceDialog
          title={t("Move {name}", { name: move.name })}
          label={t("Team")}
          intro="Choose a team in the organization."
          choices={liveTeams.map((tm) => ({ value: tm.id, label: tm.name }))}
          value={null}
          confirm="Move"
          onSave={(teamId) => run(() => store.admin.moveUnassigned(orgId, { ownerId: move.ownerId, fileKeys: move.fileKeys, to: { teamId } }), t("Moved to {name}", { name: liveTeams.find((tm) => tm.id === teamId)?.name ?? "" })).then(() => move.ownerId && setOpenId(null))}
          onClose={() => setMove(null)}
        />
      )}
      {del && <ConfirmDialog title={t("Permanently delete {name}?", { name: del.name })} body={t("Deleted folders and files can't be restored.")} confirm="Permanently delete" destructive onConfirm={() => run(() => store.admin.deleteUnassigned(orgId, del.fileKeys), "Permanently deleted")} onClose={() => setDel(null)} />}
    </>
  );
}
