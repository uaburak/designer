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
import { ChoiceDialog, ConfirmDialog, Field, NameDialog, PickDialog, RowMenu, Table, Who, byNumber, byText, personItem, styles, type Column } from "./parts";

// ---------------------------------------------------------------------------------------------------- Teams

export function TeamsTab() {
  const { orgId, store, run, exportCsv, now } = useAdmin();
  const [text, setText] = useState("");
  const [workspaceId, setWorkspaceId] = useState("all");
  const [hidden, setHidden] = useState(true);
  const [deleted, setDeleted] = useState(false);
  const [confirm, setConfirm] = useState<AdminTeam | null>(null);
  const query = { text: text.trim() || undefined, workspaceId: workspaceId === "all" ? undefined : workspaceId, includeHidden: hidden, includeDeleted: deleted };
  const { data } = useLoad(() => store.admin.teams(orgId, query), [orgId, JSON.stringify(query)]);
  const { data: workspaces } = useLoad(() => store.admin.workspaces(orgId), [orgId]);
  const wsName = (id: string | null) => (id ? workspaces?.find((w) => w.id === id)?.name ?? "" : "Unassigned");
  const teamsApi = store.teams;
  const menu = (t: AdminTeam) =>
    t.deletedAt !== null
      ? [{ id: "restore", label: "Restore team" }]
      : [{ id: "visibility", label: t.visibility === "hidden" ? "Make visible" : "Make hidden" }, "-" as const, { id: "delete", label: "Delete team", danger: true }];
  const columns: Column<AdminTeam>[] = [
    {
      id: "name", label: "Name", width: "minmax(200px, 2fr)", compare: byText((t) => t.name),
      render: (t) => <span>{t.name}{t.visibility === "hidden" && <> <Badge>Hidden</Badge></>}{t.deletedAt !== null && <> <Badge tone="danger">Deleted {formatDate(t.deletedAt)}</Badge></>}</span>,
    },
    { id: "owner", label: "Owner", compare: byText((t) => t.ownerName), render: (t) => t.ownerName ?? "" },
    { id: "members", label: "Members", width: 80, compare: byNumber((t) => t.memberCount), render: (t) => t.memberCount },
    { id: "folders", label: "Folders", width: 70, compare: byNumber((t) => t.projectCount), render: (t) => t.projectCount },
    { id: "files", label: "Files", width: 60, compare: byNumber((t) => t.fileCount), render: (t) => t.fileCount },
    { id: "access", label: "Access", width: 80, compare: byText(teamAccess), render: (t) => teamAccess(t) },
    { id: "workspace", label: "Workspace", compare: byText((t) => wsName(t.workspaceId)), render: (t) => <span className={t.workspaceId ? undefined : styles.muted}>{wsName(t.workspaceId)}</span> },
    { id: "active", label: "Last active", width: 110, compare: byNumber((t) => t.lastEditedAt), render: (t) => <span className={styles.muted}>{formatAgo(t.lastEditedAt, now())}</span> },
    {
      id: "menu", label: "", width: 32, align: "end",
      render: (t) => teamsApi && (
        <RowMenu
          label={`Actions for ${t.name}`}
          entries={menu(t)}
          onSelect={(id) => {
            if (id === "restore") void run(() => teamsApi.restore(t.id), `Restored ${t.name}`);
            else if (id === "visibility") void run(() => teamsApi.update(t.id, { visibility: t.visibility === "hidden" ? "visible" : "hidden" }));
            else if (id === "delete") setConfirm(t);
          }}
        />
      ),
    },
  ];
  return (
    <>
      <div className={styles.toolbar}>
        <SearchField className={styles.search} value={text} onChange={setText} placeholder="Search teams" />
        <Select label="Workspace" width={180} value={workspaceId} options={[{ value: "all", label: "All workspaces" }, ...(workspaces ?? []).map((w) => ({ value: w.id, label: w.name })), { value: "none", label: "Unassigned" }]} onChange={setWorkspaceId} />
        <Checkbox label="Show hidden teams" checked={hidden} onChange={setHidden} />
        <Checkbox label="Show deleted teams" checked={deleted} onChange={setDeleted} />
        <span className={styles.spacer} />
        <span className={styles.muted}>{data?.total ?? 0} teams</span>
        <Button variant="secondary" onClick={() => exportCsv("teams", query)}>Get CSV</Button>
      </div>
      <Table label="Teams" rows={data?.items ?? []} columns={columns} rowKey={(t) => t.id} muted={(t) => t.deletedAt !== null} initialSort={{ column: "name", direction: "ascending" }} empty="No teams" />
      {confirm && teamsApi && (
        <ConfirmDialog title={`Delete ${confirm.name}?`} body="The team's folders and files are deleted for everyone. Its admins can restore it within 28 days." confirm="Delete team" destructive onConfirm={() => run(() => teamsApi.remove(confirm.id), `Deleted ${confirm.name}`)} onClose={() => setConfirm(null)} />
      )}
    </>
  );
}

// ---------------------------------------------------------------------------------------------------- Workspaces

export function WorkspacesTab() {
  const { orgId, store } = useAdmin();
  const { data } = useLoad(() => store.admin.workspaces(orgId), [orgId]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const open = data?.find((w) => w.id === openId);
  if (open) return <WorkspaceDetail workspace={open} onBack={() => setOpenId(null)} />;
  const columns: Column<OrgWorkspace>[] = [
    { id: "name", label: "Name", width: "minmax(180px, 2fr)", compare: byText((w) => w.name), render: (w) => <span>{w.name}{w.hidden && <> <Badge>Hidden</Badge></>}</span> },
    { id: "admins", label: "Workspace admins", width: "minmax(180px, 2fr)", render: (w) => <span className={styles.muted}>{w.admins.map((a) => a.name ?? a.email).join(", ")}</span> },
    { id: "members", label: "Members", width: 90, compare: byNumber((w) => w.memberCount), render: (w) => w.memberCount },
    { id: "teams", label: "Teams", width: 80, compare: byNumber((w) => w.teamCount), render: (w) => w.teamCount },
    { id: "created", label: "Created", width: 120, compare: byNumber((w) => w.createdAt), render: (w) => <span className={styles.muted}>{formatDate(w.createdAt)}</span> },
  ];
  return (
    <>
      <div className={styles.toolbar}>
        <span className={styles.muted}>Workspaces group related teams and people. Each person belongs to one workspace.</span>
        <span className={styles.spacer} />
        <Button variant="primary" onClick={() => setCreating(true)}>New workspace</Button>
      </div>
      <Table label="Workspaces" rows={data ?? []} columns={columns} rowKey={(w) => w.id} onRowClick={(w) => setOpenId(w.id)} initialSort={{ column: "name", direction: "ascending" }} empty="No workspaces yet" />
      {creating && <NewWorkspaceDialog onClose={() => setCreating(false)} onCreated={(id) => setOpenId(id)} />}
    </>
  );
}

function NewWorkspaceDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const { orgId, store, run } = useAdmin();
  const { data: people } = useLoad(() => store.admin.people(orgId), [orgId]);
  const [name, setName] = useState("");
  const [admins, setAdmins] = useState<string[]>([]);
  const [hidden, setHidden] = useState(false);
  const [picking, setPicking] = useState(false);
  const all = (people?.items ?? []).filter((p) => !p.pending && p.role !== "guest");
  const create = async () => {
    const w = await run(() => store.admin.createWorkspace(orgId, { name: name.trim(), adminIds: admins, hidden }), `Created ${name.trim()}`);
    if (w) {
      onClose();
      onCreated(w.id);
    }
  };
  return (
    <>
      <Dialog
        title="New workspace"
        open={!picking}
        size="medium"
        onClose={onClose}
        footer={
          <>
            <Button variant="secondary" onClick={onClose}>Cancel</Button>
            <Button variant="primary" disabled={!name.trim() || admins.length === 0} onClick={() => void create()}>Create workspace</Button>
          </>
        }
      >
        <div className={styles.form}>
          <Field title="Name">
            <TextInput label="Workspace name" value={name} onChange={setName} placeholder="Workspace name" variant="outlined" autoFocus />
          </Field>
          <Field title="Workspace admin">
            <div className={styles.chips}>
              {admins.map((id) => {
                const p = all.find((x) => x.id === id);
                return <span key={id} className={styles.chip}>{p?.name ?? p?.email}</span>;
              })}
              <Button variant="secondary" icon="24.plus.small" onClick={() => setPicking(true)}>{admins.length ? "Change" : "Add workspace admin"}</Button>
            </div>
          </Field>
          <Checkbox label="Make it hidden" checked={hidden} onChange={setHidden} />
          <span className={styles.note}>A hidden workspace is only shown to its members in All workspaces.</span>
        </div>
      </Dialog>
      {picking && <PickDialog title="Workspace admin" items={all.map(personItem)} initial={admins} confirm="Done" min={1} onSave={setAdmins} onClose={() => setPicking(false)} />}
    </>
  );
}

function WorkspaceDetail({ workspace: w, onBack }: { workspace: OrgWorkspace; onBack: () => void }) {
  const { orgId, store, run } = useAdmin();
  const [tab, setTab] = useState("members");
  const [dialog, setDialog] = useState<"rename" | "delete" | "admins" | "addMembers" | "addTeams" | null>(null);
  const { data: people } = useLoad(() => store.admin.people(orgId), [orgId]);
  const { data: teams } = useLoad(() => store.admin.teams(orgId, { includeHidden: true }), [orgId]);
  const all = people?.items ?? [];
  const members = all.filter((p) => p.workspaceId === w.id);
  const wsTeams = (teams?.items ?? []).filter((t) => t.workspaceId === w.id);
  const patch = (p: Parameters<typeof store.admin.updateWorkspace>[1], done?: string) => run(() => store.admin.updateWorkspace(w.id, p), done);
  const memberColumns: Column<AdminPerson>[] = [
    { id: "name", label: "Name", width: "minmax(220px, 2fr)", compare: byText((p) => p.name ?? p.email), render: (p) => <Who person={p} /> },
    { id: "role", label: "Role", width: 100, render: (p) => (w.admins.some((a) => a.id === p.id) ? "Workspace admin" : p.role === "guest" ? "Guest" : "Member") },
    { id: "remove", label: "", width: 90, align: "end", render: (p) => <Button variant="ghost" onClick={() => patch({ members: { remove: [p.id] } }, "Removed from workspace")}>Remove</Button> },
  ];
  const teamColumns: Column<AdminTeam>[] = [
    { id: "name", label: "Name", width: "minmax(200px, 2fr)", compare: byText((t) => t.name), render: (t) => <span>{t.name}{t.visibility === "hidden" && <> <Badge>Hidden</Badge></>}</span> },
    { id: "members", label: "Members", width: 90, compare: byNumber((t) => t.memberCount), render: (t) => t.memberCount },
    {
      id: "default", label: "Default team", width: 110,
      render: (t) => <Checkbox label={`${t.name} is a default team`} hideLabel checked={w.defaultTeamIds.includes(t.id)} onChange={(on) => patch({ defaultTeamIds: on ? [...w.defaultTeamIds, t.id] : w.defaultTeamIds.filter((d) => d !== t.id) }, on ? `${t.name} is now a default team` : undefined)} />,
    },
    { id: "remove", label: "", width: 90, align: "end", render: (t) => <Button variant="ghost" onClick={() => patch({ teams: { remove: [t.id] } }, "Removed from workspace")}>Remove</Button> },
  ];
  const adminColumns: Column<OrgWorkspace["admins"][number]>[] = [{ id: "name", label: "Name", compare: byText((p) => p.name ?? p.email), render: (p) => <Who person={p} /> }];
  return (
    <>
      <div className={styles.toolbar}>
        <button type="button" className={`${styles.link} ${styles.back}`} onClick={onBack}><Icon name="24.arrow.left" /> Workspaces</button>
      </div>
      <div className={styles.sectionHeader}>
        <h2 className={styles.sectionTitle}>{w.name}{w.hidden && <> <Badge>Hidden</Badge></>}</h2>
        <Button variant="secondary" onClick={() => setDialog("rename")}>Rename</Button>
        <Button variant="secondary" onClick={() => patch({ hidden: !w.hidden }, w.hidden ? "Workspace is visible" : "Workspace is hidden")}>{w.hidden ? "Make it visible" : "Make it hidden"}</Button>
        <Button variant="destructive-secondary" onClick={() => setDialog("delete")}>Delete workspace</Button>
      </div>
      <div className={styles.toolbar}>
        <Tabs label="Workspace" value={tab} onChange={setTab} tabs={[{ value: "members", label: `Members (${members.length})` }, { value: "teams", label: `Teams (${wsTeams.length})` }, { value: "admins", label: `Workspace admins (${w.admins.length})` }]} />
        <span className={styles.spacer} />
        {tab === "members" && <Button variant="primary" onClick={() => setDialog("addMembers")}>Add members</Button>}
        {tab === "teams" && <Button variant="primary" onClick={() => setDialog("addTeams")}>Add teams</Button>}
        {tab === "admins" && <Button variant="primary" onClick={() => setDialog("admins")}>Edit workspace admins</Button>}
      </div>
      {tab === "members" && <Table label="Workspace members" rows={members} columns={memberColumns} rowKey={(p) => p.id} initialSort={{ column: "name", direction: "ascending" }} empty="No members in this workspace" />}
      {tab === "teams" && (
        <>
          <p className={styles.note}>Members of this workspace are added to its default teams when they join, and when a team becomes a default team. Guests aren't.</p>
          <Table label="Workspace teams" rows={wsTeams} columns={teamColumns} rowKey={(t) => t.id} initialSort={{ column: "name", direction: "ascending" }} empty="No teams in this workspace" />
        </>
      )}
      {tab === "admins" && <Table label="Workspace admins" rows={w.admins} columns={adminColumns} rowKey={(p) => p.id} />}
      {dialog === "rename" && <NameDialog title="Rename workspace" label="Workspace name" value={w.name} confirm="Save" onSave={(name) => patch({ name })} onClose={() => setDialog(null)} />}
      {dialog === "delete" && <ConfirmDialog title={`Delete ${w.name}?`} body="Its teams and people become unassigned. Nothing else is deleted." confirm="Delete workspace" destructive onConfirm={() => run(() => store.admin.deleteWorkspace(w.id), `Deleted ${w.name}`).then(onBack)} onClose={() => setDialog(null)} />}
      {dialog === "admins" && <PickDialog title="Workspace admins" items={all.filter((p) => !p.pending && p.role !== "guest").map(personItem)} initial={w.admins.map((a) => a.id)} confirm="Save" min={1} onSave={(ids) => patch({ adminIds: ids }, "Workspace admins saved")} onClose={() => setDialog(null)} />}
      {dialog === "addMembers" && <PickDialog title={`Add members to ${w.name}`} items={all.filter((p) => p.workspaceId === null).map(personItem)} confirm="Add" min={1} onSave={(ids) => patch({ members: { add: ids } }, ids.length === 1 ? "Added 1 member" : `Added ${ids.length} members`)} onClose={() => setDialog(null)} />}
      {dialog === "addTeams" && <PickDialog title={`Add teams to ${w.name}`} items={(teams?.items ?? []).filter((t) => t.workspaceId === null && t.deletedAt === null).map((t) => ({ id: t.id, label: t.name, sub: `${t.memberCount} members` }))} confirm="Add" min={1} onSave={(ids) => patch({ teams: { add: ids } }, "Teams added")} onClose={() => setDialog(null)} />}
    </>
  );
}

// ---------------------------------------------------------------------------------------------------- Unassigned drafts

const PRODUCT: Record<OrgFile["editorType"], string> = { design: "Design", figjam: "FigJam", slides: "Slides", buzz: "Buzz", sites: "Sites", make: "Make" };

export function UnassignedDraftsTab() {
  const { orgId, store, run, now } = useAdmin();
  const { data } = useLoad(() => store.admin.unassignedDrafts(orgId), [orgId]);
  const { data: teams } = useLoad(() => store.admin.teams(orgId, { includeHidden: true }), [orgId]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [trashed, setTrashed] = useState(false);
  const [move, setMove] = useState<{ ownerId?: string; fileKeys?: string[]; name: string } | null>(null);
  const [del, setDel] = useState<{ fileKeys: string[]; name: string } | null>(null);
  const folders = data ?? [];
  const open = folders.find((f) => f.owner.id === openId);
  const liveTeams = (teams?.items ?? []).filter((t) => t.deletedAt === null);
  const visible = (f: UnassignedDrafts) => f.files.filter((x) => trashed || x.trashedAt === null);
  const folderColumns: Column<UnassignedDrafts>[] = [
    { id: "name", label: "Name", width: "minmax(220px, 2fr)", compare: byText((f) => f.owner.name ?? f.owner.email), render: (f) => <span className={styles.who}><Icon name="24.folder" /><Who person={{ ...f.owner, picture: null }} /></span> },
    { id: "files", label: "Files", width: 80, compare: byNumber((f) => visible(f).length), render: (f) => visible(f).length },
    { id: "removed", label: "Removed", width: 140, compare: byNumber((f) => f.owner.removedAt), render: (f) => <span className={styles.muted}>{formatDate(f.owner.removedAt)}</span> },
    {
      id: "menu", label: "", width: 32, align: "end",
      render: (f) => <RowMenu label={`Actions for ${f.owner.name ?? f.owner.email}'s drafts`} entries={[{ id: "move", label: "Move" }, { id: "delete", label: "Permanently delete", danger: true }]} onSelect={(id) => (id === "move" ? setMove({ ownerId: f.owner.id, name: `${f.owner.name ?? f.owner.email}'s drafts` }) : setDel({ fileKeys: f.files.map((x) => x.key), name: `${f.owner.name ?? f.owner.email}'s drafts` }))} />,
    },
  ];
  const fileColumns: Column<OrgFile>[] = [
    { id: "name", label: "Name", width: "minmax(220px, 2fr)", compare: byText((f) => f.name), render: (f) => <span>{f.name}{f.trashedAt !== null && <> <Badge>In trash</Badge></>}</span> },
    { id: "product", label: "Type", width: 90, compare: byText((f) => f.editorType), render: (f) => PRODUCT[f.editorType] },
    { id: "updated", label: "Last modified", width: 130, compare: byNumber((f) => f.updatedAt), render: (f) => <span className={styles.muted}>{formatAgo(f.updatedAt, now())}</span> },
    { id: "menu", label: "", width: 32, align: "end", render: (f) => <RowMenu label={`Actions for ${f.name}`} entries={[{ id: "move", label: "Move" }, { id: "delete", label: "Permanently delete", danger: true }]} onSelect={(id) => (id === "move" ? setMove({ fileKeys: [f.key], name: f.name }) : setDel({ fileKeys: [f.key], name: f.name }))} /> },
  ];
  return (
    <>
      <div className={styles.toolbar}>
        {open ? (
          <button type="button" className={`${styles.link} ${styles.back}`} onClick={() => setOpenId(null)}><Icon name="24.arrow.left" /> Unassigned drafts</button>
        ) : (
          <span className={styles.muted}>When someone is removed from the organization, their drafts move here. Move them into a team, or delete them for good.</span>
        )}
        <span className={styles.spacer} />
        <Checkbox label="Show trashed files" checked={trashed} onChange={setTrashed} />
      </div>
      {open ? (
        <>
          <div className={styles.sectionHeader}><h2 className={styles.sectionTitle}>{open.owner.name ?? open.owner.email}'s drafts</h2></div>
          <Table label="Unassigned files" rows={visible(open)} columns={fileColumns} rowKey={(f) => f.key} muted={(f) => f.trashedAt !== null} initialSort={{ column: "updated", direction: "descending" }} empty="No files" />
        </>
      ) : (
        <Table label="Unassigned drafts" rows={folders} columns={folderColumns} rowKey={(f) => f.owner.id} onRowClick={(f) => setOpenId(f.owner.id)} initialSort={{ column: "removed", direction: "descending" }} empty="No unassigned drafts" />
      )}
      {move && (
        <ChoiceDialog
          title={`Move ${move.name}`}
          label="Team"
          intro="Choose a team in the organization."
          choices={liveTeams.map((t) => ({ value: t.id, label: t.name }))}
          value={null}
          confirm="Move"
          onSave={(teamId) => run(() => store.admin.moveUnassigned(orgId, { ownerId: move.ownerId, fileKeys: move.fileKeys, to: { teamId } }), `Moved to ${liveTeams.find((t) => t.id === teamId)?.name}`).then(() => move.ownerId && setOpenId(null))}
          onClose={() => setMove(null)}
        />
      )}
      {del && <ConfirmDialog title={`Permanently delete ${del.name}?`} body="Deleted folders and files can't be restored." confirm="Permanently delete" destructive onConfirm={() => run(() => store.admin.deleteUnassigned(orgId, del.fileKeys), "Permanently deleted")} onClose={() => setDel(null)} />}
    </>
  );
}
