/**
 * Admin › Resources › Plugins / Widgets (docs/plugins.md §10.2–§10.3; research docs/research/figma/R19-admin.md §11,
 * help.figma.com 4404228724759 and 17882120337815): three lists over `store.plugins.admin(orgId, kind)` —
 * - **Approved**: the approved plugins, grouped by plugin (the organization, or the workspaces they're approved for);
 *   **Add plugin** (a plugin ID and its name: there is no Community here); a row opens the plugin with **Remove**
 *   (without workspaces, Figma's Organization plan) or **Edit approvals** (a switch for the organization and for each
 *   workspace, Figma's Enterprise plan);
 * - **Requests**: members' requests, pending first; a row opens the review — **Overview** (the manifest: editor types,
 *   network access with its reasoning, permissions, capabilities) and **Request history** — with **Try it out**,
 *   **Decline** (an optional reason) and **Approve** (for the organization or chosen workspaces);
 * - **Private**: the organization's private plugins (exempt from approval) with Remove.
 * A workspace admin (`workspaceId`) sees and changes only the workspace's approvals and requests.
 */
import { useMemo, useState } from "react";
import { Badge, Banner, Button, Checkbox, Dialog, Icon, RadioGroup, Switch, Tabs, TextArea, TextInput } from "@/ds";
import type { PluginApproval, PluginEditorType, PluginKind, PluginManifest, PluginRequest, PrivatePlugin } from "@shared/plugins/types";
import { useAdmin, useLoad } from "./context";
import { formatAgo, formatDate } from "./labels";
import { ConfirmDialog, Field, RowMenu, Table, Who, byNumber, byText, styles, type Column } from "./parts";
import { t, useT } from "@/i18n";

type View = "approved" | "requests" | "private";

/** One plugin's approval rows together */
export interface ApprovedPlugin {
  pluginId: string;
  kind: PluginKind;
  name: string;
  org: boolean;
  workspaceIds: string[];
  addedAt: number;
}

export function groupApprovals(rows: PluginApproval[]): ApprovedPlugin[] {
  const out = new Map<string, ApprovedPlugin>();
  for (const r of rows) {
    const g = out.get(r.pluginId) ?? { pluginId: r.pluginId, kind: r.kind, name: r.name, org: false, workspaceIds: [], addedAt: r.addedAt };
    if (r.scope.type === "org") g.org = true;
    else g.workspaceIds.push(r.scope.id);
    g.addedAt = Math.min(g.addedAt, r.addedAt);
    out.set(r.pluginId, g);
  }
  return [...out.values()];
}

/** Figma's product names for a manifest's `editorType` */
export const EDITOR_TYPE_LABEL: Record<PluginEditorType, string> = { figma: "Figma Design", dev: "Dev Mode", figjam: "FigJam", slides: "Figma Slides", buzz: "Figma Buzz" };

const NOUN: Record<PluginKind, { one: string; many: string; title: string }> = {
  plugin: { one: "plugin", many: "plugins", title: "Plugin" },
  widget: { one: "widget", many: "widgets", title: "Widget" },
};

/** A plugin's or a widget's own sentence (each language words them apart) */
const pw = (kind: PluginKind, plugin: string, widget: string) => (kind === "widget" ? widget : plugin);

function useNames() {
  const { orgId, store, workspace } = useAdmin();
  const { data: org } = useLoad(() => (store.orgs ? store.orgs.get(orgId).then((o) => o.name) : Promise.resolve(t("your organization"))), [orgId, store.orgs]);
  const { data: ws } = useLoad(() => (workspace ? Promise.resolve([]) : store.admin.workspaces(orgId).catch(() => [])), [orgId, workspace?.id]);
  return useMemo(() => {
    const workspaces = (ws ?? []).map((w) => ({ id: w.id, name: w.name }));
    if (workspace && !workspaces.some((w) => w.id === workspace.id)) workspaces.push({ id: workspace.id, name: workspace.name });
    return { orgName: org ?? t("your organization"), workspaces, wsName: (id: string) => workspaces.find((w) => w.id === id)?.name ?? id };
  }, [org, ws, workspace]);
}

export function PluginsTab({ kind, workspaceId }: { kind: PluginKind; workspaceId?: string }) {
  useT();
  const { orgId, store, now } = useAdmin();
  const repo = store.plugins;
  const noun = NOUN[kind];
  const [view, setView] = useState<View>("approved");
  const [adding, setAdding] = useState(false);
  const [openApproved, setOpenApproved] = useState<string | null>(null);
  const [review, setReview] = useState<string | null>(null);
  const [removing, setRemoving] = useState<PrivatePlugin | null>(null);
  const names = useNames();
  const { data, error } = useLoad(() => (repo ? repo.admin(orgId, kind) : Promise.resolve(null)), [orgId, repo, kind]);
  const { data: settings } = useLoad(() => (workspaceId ? Promise.resolve(null) : store.admin.settings(orgId).catch(() => null)), [orgId, workspaceId]);
  const { run } = useAdmin();
  if (!repo) return <p className={styles.note}>{pw(kind, t("Plugins aren't available here. Sign in to your organization's server to manage them."), t("Widgets aren't available here. Sign in to your organization's server to manage them."))}</p>;
  const approved = groupApprovals(data?.approved ?? []).filter((p) => !workspaceId || p.org || p.workspaceIds.includes(workspaceId));
  const requests = (data?.requests ?? []).filter((q) => !workspaceId || q.workspaceId === workspaceId);
  const pending = requests.filter((q) => q.state === "pending").length;
  const priv = data?.private ?? [];
  const approvalOff = settings && (kind === "widget" ? settings.widgetApproval : settings.pluginApproval) === "all";
  const approvedFor = (p: ApprovedPlugin) => (p.org ? names.orgName : p.workspaceIds.map(names.wsName).sort((a, b) => a.localeCompare(b)).join(", "));

  const approvedColumns: Column<ApprovedPlugin>[] = [
    {
      id: "name", label: "Name", width: "minmax(220px, 2fr)", compare: byText((p) => p.name),
      render: (p) => (
        <span className={styles.libName}>
          <Icon name="24.plugin" />
          <span className={styles.libNameText}>{p.name}</span>
        </span>
      ),
    },
    { id: "id", label: "ID", compare: byText((p) => p.pluginId), render: (p) => <span className={styles.muted}>{p.pluginId}</span> },
    { id: "for", label: "Approved for", width: "minmax(160px, 1.4fr)", compare: byText(approvedFor), render: (p) => <span data-approved-for={p.pluginId}>{approvedFor(p)}</span> },
    { id: "added", label: "Date added", width: 120, compare: byNumber((p) => p.addedAt), render: (p) => <span className={styles.muted}>{formatDate(p.addedAt)}</span> },
  ];
  const requestColumns: Column<PluginRequest>[] = [
    {
      id: "name", label: t(noun.title), width: "minmax(180px, 1.4fr)", compare: byText((q) => q.name),
      render: (q) => (
        <span className={styles.libName}>
          <Icon name="24.plugin" />
          <span className={styles.libNameText}>{q.name}</span>
        </span>
      ),
    },
    { id: "by", label: "Requested by", width: "minmax(200px, 1.6fr)", compare: byText((q) => q.requestedBy.name ?? q.requestedBy.email), render: (q) => <Who person={{ name: q.requestedBy.name, email: q.requestedBy.email, picture: null }} /> },
    ...(names.workspaces.length && !workspaceId ? [{ id: "workspace", label: "Workspace", compare: byText<PluginRequest>((q) => (q.workspaceId ? names.wsName(q.workspaceId) : "")), render: (q: PluginRequest) => <span className={styles.muted}>{q.workspaceId ? names.wsName(q.workspaceId) : ""}</span> }] : []),
    { id: "reason", label: "Reason", width: "minmax(160px, 2fr)", render: (q) => <span className={styles.muted}>{q.reason}</span> },
    { id: "date", label: "Requested", width: 110, compare: byNumber((q) => q.createdAt), render: (q) => <span className={styles.muted}>{formatAgo(q.createdAt, now())}</span> },
    { id: "state", label: "Status", width: 100, render: (q) => <StateBadge state={q.state} /> },
  ];
  const privateColumns: Column<PrivatePlugin>[] = [
    {
      id: "name", label: "Name", width: "minmax(200px, 2fr)", compare: byText((p) => p.name),
      render: (p) => (
        <span className={styles.libName}>
          <Icon name="24.plugin" />
          <span className={styles.whoText}>
            <span className={styles.whoName}>{p.name}</span>
            {p.description && <span className={styles.whoEmail}>{p.description}</span>}
          </span>
        </span>
      ),
    },
    { id: "version", label: "Version", width: 80, compare: byNumber((p) => p.version), render: (p) => p.version },
    { id: "by", label: "Published by", compare: byText((p) => p.publishedBy?.name), render: (p) => <span className={styles.muted}>{p.publishedBy?.name ?? ""}</span> },
    { id: "updated", label: "Last updated", width: 120, compare: byNumber((p) => p.updatedAt), render: (p) => <span className={styles.muted}>{formatAgo(p.updatedAt, now())}</span> },
    { id: "menu", label: "", width: 40, render: (p) => (p.canManage ? <RowMenu label={t("{label} options", { label: p.name })} entries={[{ id: "remove", label: pw(kind, t("Remove plugin"), t("Remove widget")), danger: true }]} onSelect={() => setRemoving(p)} /> : null) },
  ];
  const filter = (v: View, label: string) => (
    <button type="button" className={styles.seatCount} aria-pressed={view === v} data-plugins-view={v} onClick={() => setView(v)}>
      {label}
    </button>
  );
  return (
    <>
      {approvalOff && (
        <Banner data-plugins-notice="approval-off">
          {pw(kind, t("Members can use any plugin. To allow only approved plugins, choose “Only admin-approved plugins.” in Settings › Extensions."), t("Members can use any widget. To allow only approved widgets, choose “Only admin-approved widgets.” in Settings › Extensions."))}
        </Banner>
      )}
      <div className={styles.toolbar}>
        {filter("approved", t("Approved"))}
        {filter("requests", pending ? t("Requests ({n})", { n: pending }) : t("Requests"))}
        {!workspaceId && filter("private", t("From {org}", { org: names.orgName }))}
        <span className={styles.spacer} />
        {view === "approved" && (
          <Button variant="primary" onClick={() => setAdding(true)} data-plugins="add">
            {pw(kind, t("Add plugin"), t("Add widget"))}
          </Button>
        )}
      </div>
      {error && <p className={styles.danger}>{error}</p>}
      {view === "approved" && (
        <Table label={pw(kind, t("Approved plugins"), t("Approved widgets"))} rows={approved} columns={approvedColumns} rowKey={(p) => p.pluginId} onRowClick={(p) => setOpenApproved(p.pluginId)} empty={data === undefined ? t("Loading…") : pw(kind, t("No approved plugins yet"), t("No approved widgets yet"))} />
      )}
      {view === "requests" && (
        <Table label={pw(kind, t("Plugin requests"), t("Widget requests"))} rows={requests} columns={requestColumns} rowKey={(q) => q.id} onRowClick={(q) => setReview(q.id)} muted={(q) => q.state !== "pending"} empty={data === undefined ? t("Loading…") : t("No requests")} />
      )}
      {view === "private" && (
        <>
          <p className={`${styles.note} ${styles.intro}`}>
            {kind === "widget" ? t("Widgets aren't supported in Wecra yet.") : t("Private plugins published by members of {org}. They're available to every member without approval.", { org: names.orgName })}
          </p>
          <Table label={pw(kind, t("Private plugins"), t("Private widgets"))} rows={priv} columns={privateColumns} rowKey={(p) => p.id} empty={data === undefined ? t("Loading…") : pw(kind, t("No private plugins"), t("No private widgets"))} />
        </>
      )}
      {adding && <AddPluginDialog kind={kind} workspaceId={workspaceId} names={names} onClose={() => setAdding(false)} />}
      {openApproved && approved.some((p) => p.pluginId === openApproved) && (
        <ApprovedDialog plugin={approved.find((p) => p.pluginId === openApproved)!} workspaceId={workspaceId} names={names} onClose={() => setOpenApproved(null)} />
      )}
      {review && requests.some((q) => q.id === review) && (
        <ReviewDialog request={requests.find((q) => q.id === review)!} history={(data?.requests ?? []).filter((q) => q.pluginId === requests.find((r) => r.id === review)!.pluginId)} workspaceId={workspaceId} names={names} onClose={() => setReview(null)} />
      )}
      {removing && (
        <ConfirmDialog
          title={t("Remove {name}?", { name: removing.name })}
          body={t("Members of {org} won't be able to run it anymore. Its developer can publish it again.", { org: names.orgName })}
          confirm="Remove"
          destructive
          onConfirm={() => void run(() => repo.removePrivate(removing.id), t("Removed {name}", { name: removing.name }))}
          onClose={() => setRemoving(null)}
        />
      )}
    </>
  );
}

function StateBadge({ state }: { state: PluginRequest["state"] }) {
  useT();
  return state === "pending" ? <Badge tone="brand">{t("Pending")}</Badge> : state === "approved" ? <Badge tone="success">{t("Approved")}</Badge> : <Badge>{t("Declined")}</Badge>;
}

type Names = ReturnType<typeof useNames>;

/** Where to approve: the organization, or chosen workspaces (Enterprise; a workspace admin: their workspace) */
function ScopePicker({ names, value, onChange }: { names: Names; value: { org: boolean; ids: string[] }; onChange: (v: { org: boolean; ids: string[] }) => void }) {
  useT();
  return (
    <div className={styles.form}>
      <RadioGroup
        label={t("Approve for")}
        value={value.org ? "org" : "workspaces"}
        options={[
          { value: "org", label: t("Everyone at {org}", { org: names.orgName }) },
          { value: "workspaces", label: t("Specific workspaces") },
        ]}
        onChange={(v) => onChange({ ...value, org: v === "org" })}
      />
      {!value.org && (
        <div className={styles.pickList} role="list" data-plugins="workspaces">
          {names.workspaces.map((w) => (
            <div key={w.id} role="listitem" className={styles.pickRow}>
              <Checkbox label={w.name} checked={value.ids.includes(w.id)} onChange={(on) => onChange({ ...value, ids: on ? [...value.ids, w.id] : value.ids.filter((x) => x !== w.id) })} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const scopeOf = (v: { org: boolean; ids: string[] }, workspaceId?: string): { type: "org" } | { type: "workspace"; ids: string[] } =>
  workspaceId ? { type: "workspace", ids: [workspaceId] } : v.org ? { type: "org" } : { type: "workspace", ids: v.ids };

/** "Add plugin": a plugin ID (the manifest's `id`) and its name — Figma's takes a Community link */
function AddPluginDialog({ kind, workspaceId, names, onClose }: { kind: PluginKind; workspaceId?: string; names: Names; onClose: () => void }) {
  useT();
  const { orgId, store, run } = useAdmin();
  const [id, setId] = useState("");
  const [name, setName] = useState("");
  const [scope, setScope] = useState({ org: true, ids: [] as string[] });
  const enterprise = !workspaceId && names.workspaces.length > 0;
  const valid = /^[A-Za-z0-9_.:-]{1,100}$/.test(id.trim()) && name.trim().length > 0 && (workspaceId || scope.org || scope.ids.length > 0);
  const add = async () => {
    const ok = await run(() => store.plugins!.approve(orgId, { pluginId: id.trim(), kind, name: name.trim(), scope: scopeOf(scope, workspaceId) }), t("Approved {name}", { name: name.trim() }));
    if (ok !== undefined) onClose();
  };
  return (
    <Dialog
      title={pw(kind, t("Add plugin"), t("Add widget"))}
      open
      size="medium"
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>{t("Cancel")}</Button>
          <Button variant="primary" disabled={!valid} onClick={() => void add()} data-plugins="add-confirm">{t("Add")}</Button>
        </>
      }
    >
      <div className={styles.form} data-add-plugin="">
        <p className={styles.note}>{pw(kind, t("Paste the plugin's ID — the \"id\" in its manifest.json. Members of {place} can use it once it's added.", { place: workspaceId ? names.wsName(workspaceId) : names.orgName }), t("Paste the widget's ID — the \"id\" in its manifest.json. Members of {place} can use it once it's added.", { place: workspaceId ? names.wsName(workspaceId) : names.orgName }))}</p>
        <Field title={pw(kind, t("Plugin ID"), t("Widget ID"))}>
          <TextInput label={pw(kind, t("Plugin ID"), t("Widget ID"))} value={id} onChange={setId} placeholder="1234567890123456789" autoFocus variant="outlined" />
        </Field>
        <Field title={t("Name")}>
          <TextInput label={t("Name")} value={name} onChange={setName} placeholder={pw(kind, t("Plugin name"), t("Widget name"))} variant="outlined" />
        </Field>
        {enterprise && <ScopePicker names={names} value={scope} onChange={setScope} />}
      </div>
    </Dialog>
  );
}

/** An approved plugin: Remove (Organization plan) or Edit approvals (workspaces: a switch each) */
function ApprovedDialog({ plugin: p, workspaceId, names, onClose }: { plugin: ApprovedPlugin; workspaceId?: string; names: Names; onClose: () => void }) {
  useT();
  const { orgId, store, run } = useAdmin();
  const repo = store.plugins!;
  const enterprise = workspaceId !== undefined || names.workspaces.length > 0;
  const [editing, setEditing] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const ref = { pluginId: p.pluginId, kind: p.kind, name: p.name };
  const setOrg = (on: boolean) => void run(() => (on ? repo.approve(orgId, { ...ref, scope: { type: "org" } }) : repo.unapprove(orgId, p.pluginId)));
  const setWs = (id: string, on: boolean) => void run(() => (on ? repo.approve(orgId, { ...ref, scope: { type: "workspace", ids: [id] } }) : repo.unapprove(orgId, p.pluginId, id)));
  const rows = workspaceId ? names.workspaces.filter((w) => w.id === workspaceId) : names.workspaces;
  return (
    <>
      <Dialog
        title={p.name}
        open
        size="medium"
        onClose={onClose}
        footer={
          <>
            <Button variant="secondary" onClick={onClose}>{t("Done")}</Button>
            {!enterprise && <Button variant="destructive" onClick={() => setConfirm(true)} data-plugins="remove">{t("Remove")}</Button>}
            {enterprise && !editing && <Button variant="primary" onClick={() => setEditing(true)} data-plugins="edit-approvals">{t("Edit approvals")}</Button>}
          </>
        }
      >
        <div className={styles.form} data-approved-plugin={p.pluginId}>
          <div className={styles.kvList}>
            <div className={styles.kv}><span className={styles.kvLabel}>{pw(p.kind, t("Plugin ID"), t("Widget ID"))}</span><span className={styles.kvValue}>{p.pluginId}</span><span /></div>
            <div className={styles.kv}><span className={styles.kvLabel}>{t("Approved for")}</span><span className={styles.kvValue}>{p.org ? names.orgName : p.workspaceIds.map(names.wsName).join(", ")}</span><span /></div>
            <div className={styles.kv}><span className={styles.kvLabel}>{t("Date added")}</span><span className={styles.kvValue}>{formatDate(p.addedAt)}</span><span /></div>
          </div>
          {editing && (
            <div className={styles.form} data-plugins="approvals">
              {!workspaceId && (
                <div className={styles.switchRow} data-approval-scope="org">
                  <span className={styles.settingText}>
                    <span className={styles.settingLabel}>{names.orgName}</span>
                    <span className={styles.settingDescription}>{t("Every member, in every workspace and in drafts.")}</span>
                  </span>
                  <span className={styles.spacer} />
                  <Switch label={names.orgName} checked={p.org} onChange={setOrg} />
                </div>
              )}
              {workspaceId && p.org && <p className={styles.note}>{t("Approved for {org}. Only organization admins can change this.", { org: names.orgName })}</p>}
              {rows.map((w) => (
                <div key={w.id} className={styles.switchRow} data-approval-scope={w.id}>
                  <span className={styles.settingText}>
                    <span className={styles.settingLabel}>{w.name}</span>
                  </span>
                  <span className={styles.spacer} />
                  <Switch label={w.name} checked={p.org || p.workspaceIds.includes(w.id)} disabled={p.org} onChange={(on) => setWs(w.id, on)} />
                </div>
              ))}
            </div>
          )}
        </div>
      </Dialog>
      {confirm && (
        <ConfirmDialog
          title={t("Remove {name}?", { name: p.name })}
          body={pw(p.kind, t("Members of {org} won't be able to use this plugin anymore.", { org: names.orgName }), t("Members of {org} won't be able to use this widget anymore.", { org: names.orgName }))}
          confirm="Remove"
          destructive
          onConfirm={() => void run(() => repo.unapprove(orgId, p.pluginId), t("Removed {name}", { name: p.name })).then(onClose)}
          onClose={() => setConfirm(false)}
        />
      )}
    </>
  );
}

/** The network line of a manifest ("No network access" for Figma's ["none"]) */
function networkText(m: PluginManifest): string {
  const d = m.networkAccess?.allowedDomains;
  if (!d) return t("Not declared");
  if (d.length === 1 && d[0] === "none") return t("No network access");
  if (d.includes("*")) return t("Any domain");
  return d.join(", ");
}

/** A request's review: Overview | Request history; Try it out, Decline, Approve */
function ReviewDialog({ request: q, history, workspaceId, names, onClose }: { request: PluginRequest; history: PluginRequest[]; workspaceId?: string; names: Names; onClose: () => void }) {
  useT();
  const { orgId, store, run, now, onTryPlugin } = useAdmin();
  const [tab, setTab] = useState<"overview" | "history">("overview");
  const [step, setStep] = useState<"review" | "decline" | "approve">("review");
  const [reason, setReason] = useState("");
  const [scope, setScope] = useState({ org: true, ids: q.workspaceId ? [q.workspaceId] : ([] as string[]) });
  const enterprise = !workspaceId && names.workspaces.length > 0;
  const pending = q.state === "pending";
  const answer = async (approve: boolean) => {
    const s = scopeOf(scope, workspaceId);
    const out = await run(
      () => store.plugins!.answer(orgId, q.id, approve ? (s.type === "org" ? { approve } : { approve, workspaceIds: s.ids }) : { approve, ...(reason.trim() ? { reason: reason.trim() } : {}) }),
      approve ? t("Approved {name}", { name: q.name }) : t("Declined {name}", { name: q.name }),
    );
    if (out !== undefined) onClose();
  };
  const m = q.manifest;
  const footer =
    step === "decline" ? (
      <>
        <Button variant="secondary" onClick={() => setStep("review")}>{t("Back")}</Button>
        <Button variant="destructive" onClick={() => void answer(false)} data-review="decline-confirm">{t("Decline")}</Button>
      </>
    ) : step === "approve" ? (
      <>
        <Button variant="secondary" onClick={() => setStep("review")}>{t("Back")}</Button>
        <Button variant="primary" disabled={!scope.org && !scope.ids.length} onClick={() => void answer(true)} data-review="approve-confirm">{t("Approve")}</Button>
      </>
    ) : pending ? (
      <>
        <Button variant="secondary" disabled={!onTryPlugin} tooltip={onTryPlugin ? undefined : t("Try it out runs in the desktop app")} onClick={() => onTryPlugin && void run(() => onTryPlugin(q))} data-review="try">{t("Try it out")}</Button>
        <Button variant="secondary" onClick={() => setStep("decline")} data-review="decline">{t("Decline")}</Button>
        <Button variant="primary" onClick={() => (enterprise ? setStep("approve") : void answer(true))} data-review="approve">{t("Approve")}</Button>
      </>
    ) : (
      <Button variant="secondary" onClick={onClose}>{t("Done")}</Button>
    );
  return (
    <Dialog title={q.name} open size="large" onClose={onClose} footer={footer}>
      <div className={styles.form} data-review={q.id}>
        {step === "decline" && (
          <>
            <p className={styles.note}>{t("{name} will be told you declined. They can ask again with more information.", { name: q.requestedBy.name ?? q.requestedBy.email })}</p>
            <TextArea label={t("Reason (optional)")} value={reason} onChange={setReason} placeholder={t("Reason (optional)")} />
          </>
        )}
        {step === "approve" && <ScopePicker names={names} value={scope} onChange={setScope} />}
        {step === "review" && (
          <>
            <Tabs label={t("Review")} value={tab} tabs={[{ value: "overview", label: t("Overview") }, { value: "history", label: t("Request history") }]} onChange={(v) => setTab(v === "history" ? "history" : "overview")} />
            {tab === "overview" && (
              <>
                <div className={styles.libHeader}>
                  <Who person={{ name: q.requestedBy.name, email: q.requestedBy.email, picture: null }} />
                  <span className={styles.spacer} />
                  <StateBadge state={q.state} />
                </div>
                {q.reason && <p className={styles.note} data-review="reason">{`“${q.reason}”`}</p>}
                {q.state === "declined" && q.declineReason && <p className={styles.note}>{t("Declined: {reason}", { reason: q.declineReason })}</p>}
                <div className={styles.kvList}>
                  <div className={styles.kv}><span className={styles.kvLabel}>{pw(q.kind, t("Plugin ID"), t("Widget ID"))}</span><span className={styles.kvValue}>{q.pluginId}</span><span /></div>
                  {q.workspaceId && <div className={styles.kv}><span className={styles.kvLabel}>{t("Workspace")}</span><span className={styles.kvValue}>{names.wsName(q.workspaceId)}</span><span /></div>}
                  {m ? (
                    <>
                      <div className={styles.kv}><span className={styles.kvLabel}>{t("Works in")}</span><span className={styles.kvValue}>{(m.editorType ?? ["figma"]).map((e) => t(EDITOR_TYPE_LABEL[e] ?? e)).join(", ")}</span><span /></div>
                      <div className={styles.kv} data-review="network"><span className={styles.kvLabel}>{t("Network access")}</span><span className={styles.kvValue}>{networkText(m)}</span><span /></div>
                      {m.networkAccess?.reasoning && <div className={styles.kv}><span className={styles.kvLabel}>{t("Why")}</span><span className={styles.kvValue}>{m.networkAccess.reasoning}</span><span /></div>}
                      <div className={styles.kv}><span className={styles.kvLabel}>{t("Permissions")}</span><span className={styles.kvValue}>{m.permissions?.length ? m.permissions.join(", ") : t("None")}</span><span /></div>
                      {m.capabilities?.length ? <div className={styles.kv}><span className={styles.kvLabel}>{t("Capabilities")}</span><span className={styles.kvValue}>{m.capabilities.join(", ")}</span><span /></div> : null}
                    </>
                  ) : (
                    <div className={styles.kv}><span className={styles.kvLabel}>{t("Manifest")}</span><span className={styles.kvValue}>{t("Not sent with this request")}</span><span /></div>
                  )}
                </div>
              </>
            )}
            {tab === "history" && (
              <div className={styles.kvList} data-review="history">
                {[...history].sort((a, b) => b.createdAt - a.createdAt).map((h) => (
                  <div key={h.id} className={styles.kv}>
                    <span className={styles.kvLabel}>{formatAgo(h.createdAt, now())}</span>
                    <span className={styles.kvValue}>
                      {h.workspaceId ? t("{name} requested for {workspace}", { name: h.requestedBy.name ?? h.requestedBy.email, workspace: names.wsName(h.workspaceId) }) : t("{name} requested", { name: h.requestedBy.name ?? h.requestedBy.email })}
                      {h.state === "declined" && h.declineReason ? ` · ${h.declineReason}` : ""} <StateBadge state={h.state} />
                    </span>
                    <span />
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </Dialog>
  );
}
