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

function useNames() {
  const { orgId, store, workspace } = useAdmin();
  const { data: org } = useLoad(() => (store.orgs ? store.orgs.get(orgId).then((o) => o.name) : Promise.resolve("your organization")), [orgId, store.orgs]);
  const { data: ws } = useLoad(() => (workspace ? Promise.resolve([]) : store.admin.workspaces(orgId).catch(() => [])), [orgId, workspace?.id]);
  return useMemo(() => {
    const workspaces = (ws ?? []).map((w) => ({ id: w.id, name: w.name }));
    if (workspace && !workspaces.some((w) => w.id === workspace.id)) workspaces.push({ id: workspace.id, name: workspace.name });
    return { orgName: org ?? "your organization", workspaces, wsName: (id: string) => workspaces.find((w) => w.id === id)?.name ?? id };
  }, [org, ws, workspace]);
}

export function PluginsTab({ kind, workspaceId }: { kind: PluginKind; workspaceId?: string }) {
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
  if (!repo) return <p className={styles.note}>{`${noun.title}s aren't available here. Sign in to your organization's server to manage them.`}</p>;
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
      id: "name", label: noun.title, width: "minmax(180px, 1.4fr)", compare: byText((q) => q.name),
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
    { id: "menu", label: "", width: 40, render: (p) => (p.canManage ? <RowMenu label={`${p.name} options`} entries={[{ id: "remove", label: `Remove ${noun.one}`, danger: true }]} onSelect={() => setRemoving(p)} /> : null) },
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
          {`Members can use any ${noun.one}. To allow only approved ${noun.many}, choose “Only admin-approved ${noun.many}.” in Settings › Extensions.`}
        </Banner>
      )}
      <div className={styles.toolbar}>
        {filter("approved", "Approved")}
        {filter("requests", pending ? `Requests (${pending})` : "Requests")}
        {!workspaceId && filter("private", `From ${names.orgName}`)}
        <span className={styles.spacer} />
        {view === "approved" && (
          <Button variant="primary" onClick={() => setAdding(true)} data-plugins="add">
            {`Add ${noun.one}`}
          </Button>
        )}
      </div>
      {error && <p className={styles.danger}>{error}</p>}
      {view === "approved" && (
        <Table label={`Approved ${noun.many}`} rows={approved} columns={approvedColumns} rowKey={(p) => p.pluginId} onRowClick={(p) => setOpenApproved(p.pluginId)} empty={data === undefined ? "Loading…" : `No approved ${noun.many} yet`} />
      )}
      {view === "requests" && (
        <Table label={`${noun.title} requests`} rows={requests} columns={requestColumns} rowKey={(q) => q.id} onRowClick={(q) => setReview(q.id)} muted={(q) => q.state !== "pending"} empty={data === undefined ? "Loading…" : "No requests"} />
      )}
      {view === "private" && (
        <>
          <p className={`${styles.note} ${styles.intro}`}>
            {kind === "widget" ? "Widgets aren't supported in Wecra yet." : `Private plugins published by members of ${names.orgName}. They're available to every member without approval.`}
          </p>
          <Table label={`Private ${noun.many}`} rows={priv} columns={privateColumns} rowKey={(p) => p.id} empty={data === undefined ? "Loading…" : `No private ${noun.many}`} />
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
          title={`Remove ${removing.name}?`}
          body={`Members of ${names.orgName} won't be able to run it anymore. Its developer can publish it again.`}
          confirm="Remove"
          destructive
          onConfirm={() => void run(() => repo.removePrivate(removing.id), `Removed ${removing.name}`)}
          onClose={() => setRemoving(null)}
        />
      )}
    </>
  );
}

function StateBadge({ state }: { state: PluginRequest["state"] }) {
  return state === "pending" ? <Badge tone="brand">Pending</Badge> : state === "approved" ? <Badge tone="success">Approved</Badge> : <Badge>Declined</Badge>;
}

type Names = ReturnType<typeof useNames>;

/** Where to approve: the organization, or chosen workspaces (Enterprise; a workspace admin: their workspace) */
function ScopePicker({ names, value, onChange }: { names: Names; value: { org: boolean; ids: string[] }; onChange: (v: { org: boolean; ids: string[] }) => void }) {
  return (
    <div className={styles.form}>
      <RadioGroup
        label="Approve for"
        value={value.org ? "org" : "workspaces"}
        options={[
          { value: "org", label: `Everyone at ${names.orgName}` },
          { value: "workspaces", label: "Specific workspaces" },
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
  const { orgId, store, run } = useAdmin();
  const noun = NOUN[kind];
  const [id, setId] = useState("");
  const [name, setName] = useState("");
  const [scope, setScope] = useState({ org: true, ids: [] as string[] });
  const enterprise = !workspaceId && names.workspaces.length > 0;
  const valid = /^[A-Za-z0-9_.:-]{1,100}$/.test(id.trim()) && name.trim().length > 0 && (workspaceId || scope.org || scope.ids.length > 0);
  const add = async () => {
    const ok = await run(() => store.plugins!.approve(orgId, { pluginId: id.trim(), kind, name: name.trim(), scope: scopeOf(scope, workspaceId) }), `Approved ${name.trim()}`);
    if (ok !== undefined) onClose();
  };
  return (
    <Dialog
      title={`Add ${noun.one}`}
      open
      size="medium"
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!valid} onClick={() => void add()} data-plugins="add-confirm">Add</Button>
        </>
      }
    >
      <div className={styles.form} data-add-plugin="">
        <p className={styles.note}>{`Paste the ${noun.one}'s ID — the "id" in its manifest.json. Members of ${workspaceId ? names.wsName(workspaceId) : names.orgName} can use it once it's added.`}</p>
        <Field title={`${noun.title} ID`}>
          <TextInput label={`${noun.title} ID`} value={id} onChange={setId} placeholder="1234567890123456789" autoFocus variant="outlined" />
        </Field>
        <Field title="Name">
          <TextInput label="Name" value={name} onChange={setName} placeholder={`${noun.title} name`} variant="outlined" />
        </Field>
        {enterprise && <ScopePicker names={names} value={scope} onChange={setScope} />}
      </div>
    </Dialog>
  );
}

/** An approved plugin: Remove (Organization plan) or Edit approvals (workspaces: a switch each) */
function ApprovedDialog({ plugin: p, workspaceId, names, onClose }: { plugin: ApprovedPlugin; workspaceId?: string; names: Names; onClose: () => void }) {
  const { orgId, store, run } = useAdmin();
  const repo = store.plugins!;
  const noun = NOUN[p.kind];
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
            <Button variant="secondary" onClick={onClose}>Done</Button>
            {!enterprise && <Button variant="destructive" onClick={() => setConfirm(true)} data-plugins="remove">Remove</Button>}
            {enterprise && !editing && <Button variant="primary" onClick={() => setEditing(true)} data-plugins="edit-approvals">Edit approvals</Button>}
          </>
        }
      >
        <div className={styles.form} data-approved-plugin={p.pluginId}>
          <div className={styles.kvList}>
            <div className={styles.kv}><span className={styles.kvLabel}>{`${noun.title} ID`}</span><span className={styles.kvValue}>{p.pluginId}</span><span /></div>
            <div className={styles.kv}><span className={styles.kvLabel}>Approved for</span><span className={styles.kvValue}>{p.org ? names.orgName : p.workspaceIds.map(names.wsName).join(", ")}</span><span /></div>
            <div className={styles.kv}><span className={styles.kvLabel}>Date added</span><span className={styles.kvValue}>{formatDate(p.addedAt)}</span><span /></div>
          </div>
          {editing && (
            <div className={styles.form} data-plugins="approvals">
              {!workspaceId && (
                <div className={styles.switchRow} data-approval-scope="org">
                  <span className={styles.settingText}>
                    <span className={styles.settingLabel}>{names.orgName}</span>
                    <span className={styles.settingDescription}>{`Every member, in every workspace and in drafts.`}</span>
                  </span>
                  <span className={styles.spacer} />
                  <Switch label={names.orgName} checked={p.org} onChange={setOrg} />
                </div>
              )}
              {workspaceId && p.org && <p className={styles.note}>{`Approved for ${names.orgName}. Only organization admins can change this.`}</p>}
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
          title={`Remove ${p.name}?`}
          body={`Members of ${names.orgName} won't be able to use this ${noun.one} anymore.`}
          confirm="Remove"
          destructive
          onConfirm={() => void run(() => repo.unapprove(orgId, p.pluginId), `Removed ${p.name}`).then(onClose)}
          onClose={() => setConfirm(false)}
        />
      )}
    </>
  );
}

/** The network line of a manifest ("No network access" for Figma's ["none"]) */
function networkText(m: PluginManifest): string {
  const d = m.networkAccess?.allowedDomains;
  if (!d) return "Not declared";
  if (d.length === 1 && d[0] === "none") return "No network access";
  if (d.includes("*")) return "Any domain";
  return d.join(", ");
}

/** A request's review: Overview | Request history; Try it out, Decline, Approve */
function ReviewDialog({ request: q, history, workspaceId, names, onClose }: { request: PluginRequest; history: PluginRequest[]; workspaceId?: string; names: Names; onClose: () => void }) {
  const { orgId, store, run, now, onTryPlugin } = useAdmin();
  const noun = NOUN[q.kind];
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
      approve ? `Approved ${q.name}` : `Declined ${q.name}`,
    );
    if (out !== undefined) onClose();
  };
  const m = q.manifest;
  const footer =
    step === "decline" ? (
      <>
        <Button variant="secondary" onClick={() => setStep("review")}>Back</Button>
        <Button variant="destructive" onClick={() => void answer(false)} data-review="decline-confirm">Decline</Button>
      </>
    ) : step === "approve" ? (
      <>
        <Button variant="secondary" onClick={() => setStep("review")}>Back</Button>
        <Button variant="primary" disabled={!scope.org && !scope.ids.length} onClick={() => void answer(true)} data-review="approve-confirm">Approve</Button>
      </>
    ) : pending ? (
      <>
        <Button variant="secondary" disabled={!onTryPlugin} tooltip={onTryPlugin ? undefined : "Try it out runs in the desktop app"} onClick={() => onTryPlugin && void run(() => onTryPlugin(q))} data-review="try">Try it out</Button>
        <Button variant="secondary" onClick={() => setStep("decline")} data-review="decline">Decline</Button>
        <Button variant="primary" onClick={() => (enterprise ? setStep("approve") : void answer(true))} data-review="approve">Approve</Button>
      </>
    ) : (
      <Button variant="secondary" onClick={onClose}>Done</Button>
    );
  return (
    <Dialog title={q.name} open size="large" onClose={onClose} footer={footer}>
      <div className={styles.form} data-review={q.id}>
        {step === "decline" && (
          <>
            <p className={styles.note}>{`${q.requestedBy.name ?? q.requestedBy.email} will be told you declined. They can ask again with more information.`}</p>
            <TextArea label="Reason (optional)" value={reason} onChange={setReason} placeholder="Reason (optional)" />
          </>
        )}
        {step === "approve" && <ScopePicker names={names} value={scope} onChange={setScope} />}
        {step === "review" && (
          <>
            <Tabs label="Review" value={tab} tabs={[{ value: "overview", label: "Overview" }, { value: "history", label: "Request history" }]} onChange={(v) => setTab(v === "history" ? "history" : "overview")} />
            {tab === "overview" && (
              <>
                <div className={styles.libHeader}>
                  <Who person={{ name: q.requestedBy.name, email: q.requestedBy.email, picture: null }} />
                  <span className={styles.spacer} />
                  <StateBadge state={q.state} />
                </div>
                {q.reason && <p className={styles.note} data-review="reason">{`“${q.reason}”`}</p>}
                {q.state === "declined" && q.declineReason && <p className={styles.note}>{`Declined: ${q.declineReason}`}</p>}
                <div className={styles.kvList}>
                  <div className={styles.kv}><span className={styles.kvLabel}>{`${noun.title} ID`}</span><span className={styles.kvValue}>{q.pluginId}</span><span /></div>
                  {q.workspaceId && <div className={styles.kv}><span className={styles.kvLabel}>Workspace</span><span className={styles.kvValue}>{names.wsName(q.workspaceId)}</span><span /></div>}
                  {m ? (
                    <>
                      <div className={styles.kv}><span className={styles.kvLabel}>Works in</span><span className={styles.kvValue}>{(m.editorType ?? ["figma"]).map((t) => EDITOR_TYPE_LABEL[t] ?? t).join(", ")}</span><span /></div>
                      <div className={styles.kv} data-review="network"><span className={styles.kvLabel}>Network access</span><span className={styles.kvValue}>{networkText(m)}</span><span /></div>
                      {m.networkAccess?.reasoning && <div className={styles.kv}><span className={styles.kvLabel}>Why</span><span className={styles.kvValue}>{m.networkAccess.reasoning}</span><span /></div>}
                      <div className={styles.kv}><span className={styles.kvLabel}>Permissions</span><span className={styles.kvValue}>{m.permissions?.length ? m.permissions.join(", ") : "None"}</span><span /></div>
                      {m.capabilities?.length ? <div className={styles.kv}><span className={styles.kvLabel}>Capabilities</span><span className={styles.kvValue}>{m.capabilities.join(", ")}</span><span /></div> : null}
                    </>
                  ) : (
                    <div className={styles.kv}><span className={styles.kvLabel}>Manifest</span><span className={styles.kvValue}>Not sent with this request</span><span /></div>
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
                      {`${h.requestedBy.name ?? h.requestedBy.email} requested${h.workspaceId ? ` for ${names.wsName(h.workspaceId)}` : ""}`}
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
