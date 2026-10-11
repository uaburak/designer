/**
 * Admin › Resources (docs/research/figma/R19-admin.md §9): **Libraries** — every library the admin can reach, the
 * "Approved" / "Added by default" filters, **Manage this library** ("Set as approved library", "Enable this library by
 * default" per organization or workspace and file type, "Manage default modes") — over `store.orgLibraries`
 * (docs/data.md §16.5, §16.10); the same list is a workspace's Libraries (Admin › ‹workspace› › Libraries). **Fonts** —
 * the organization's uploaded fonts, **Font** (main's Open dialog, the licence confirmation, Skip / Replace for a family
 * already uploaded) and removal, through the preload's shared-fonts API (docs/desktop.md §14.3).
 */
import { useMemo, useState } from "react";
import { Badge, Button, Checkbox, Dialog, Icon, SearchField, Select, Switch, showToast, tooltipProps } from "@/ds";
import { LIBRARY_EDITOR_TYPES, type LibraryEditorType, type LibraryScopeSetting, type OrgLibraryInfo, type OrgLibrarySummary, type SettingScope } from "@shared/libraries/orgTypes";
import type { FontConflict, FontConflictChoice, FontUploadCandidate, SharedFontFace, SharedFontScope } from "@shared/fonts/sharedTypes";
import { useAdmin, useLoad } from "./context";
import { formatAgo, formatDate } from "./labels";
import { ConfirmDialog, RowMenu, Table, byNumber, byText, styles, type Column } from "./parts";

/** Figma's file types for "Enable this library by default" [L-find] */
export const FILE_TYPE_LABEL: Record<LibraryEditorType, string> = { design: "Design files", figjam: "FigJam boards", slides: "Slide decks", buzz: "Figma Buzz files" };

function useOrgName(): string {
  const { orgId, store } = useAdmin();
  const { data } = useLoad(() => (store.orgs ? store.orgs.get(orgId).then((o) => o.name) : Promise.resolve("your organization")), [orgId, store.orgs]);
  return data ?? "your organization";
}

/** Workspace names: an org admin's list, else the one workspace the viewer administers, else the rows' names */
function useWorkspaceNames(): Map<string, string> {
  const { orgId, store, workspace } = useAdmin();
  const { data } = useLoad(() => (workspace ? Promise.resolve([]) : store.admin.workspaces(orgId)), [orgId, workspace?.id]);
  return useMemo(() => {
    const m = new Map((data ?? []).map((w) => [w.id, w.name]));
    if (workspace) m.set(workspace.id, workspace.name);
    return m;
  }, [data, workspace]);
}

const rowOf = (info: Pick<OrgLibraryInfo, "settings">, scope: SettingScope): LibraryScopeSetting | undefined => info.settings.find((r) => r.scope.type === scope.type && r.scope.id === scope.id);

/** On by default for a workspace's files of type `t` (§16.5: the workspace's row, else the org's) */
function onIn(l: OrgLibrarySummary, workspaceId: string | undefined, t: LibraryEditorType, rows?: LibraryScopeSetting[]): boolean {
  const ws = workspaceId ? rows?.find((r) => r.scope.type === "workspace" && r.scope.id === workspaceId)?.defaults[t] : undefined;
  if (ws !== undefined && ws !== null) return ws;
  return l.defaultIn.org.includes(t);
}
const isApproved = (l: OrgLibrarySummary, workspaceId?: string) => l.approved.org || (workspaceId ? l.approved.workspaceIds.includes(workspaceId) : false);

// ---------------------------------------------------------------------------------------------------- Libraries

/** Admin › Resources › Libraries; with `workspaceId`, Admin › ‹workspace› › Libraries */
export function LibrariesTab({ workspaceId }: { workspaceId?: string }) {
  const { orgId, store, now } = useAdmin();
  const repo = store.orgLibraries;
  const [text, setText] = useState("");
  const [approved, setApproved] = useState(false);
  const [byDefault, setByDefault] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const names = useWorkspaceNames();
  const query = { text: text.trim() || undefined, approved: !workspaceId && approved ? true : undefined, enabledByDefault: !workspaceId && byDefault ? true : undefined };
  const { data, error } = useLoad(() => (repo ? repo.list(orgId, query) : Promise.resolve([])), [orgId, repo, JSON.stringify(query)]);
  if (!repo) return <p className={styles.note}>Libraries aren't available here. Sign in to your organization's server to manage them.</p>;
  // A workspace's view: approval and defaults as they stand for its files
  let rows = data ?? [];
  if (workspaceId && approved) rows = rows.filter((l) => isApproved(l, workspaceId));
  if (workspaceId && byDefault) rows = rows.filter((l) => l.defaultIn.org.length > 0 || l.defaultIn.workspaceIds.includes(workspaceId));
  const defaultsText = (l: OrgLibrarySummary) => {
    const on = workspaceId ? LIBRARY_EDITOR_TYPES.filter((t) => l.defaultIn.org.includes(t) || l.defaultIn.workspaceIds.includes(workspaceId)) : l.defaultIn.org;
    return on.length ? on.map((t) => FILE_TYPE_LABEL[t]).join(", ") : "Off";
  };
  const columns: Column<OrgLibrarySummary>[] = [
    {
      id: "name", label: "Name", width: "minmax(220px, 2fr)", compare: byText((l) => l.name),
      render: (l) => (
        <span className={styles.libName}>
          <Icon name="24.library" />
          <span className={styles.libNameText}>{l.name}</span>
          <ApprovedMark library={l} workspaceId={workspaceId} names={names} />
        </span>
      ),
    },
    { id: "team", label: "Team", compare: byText((l) => l.teamName), render: (l) => <span className={styles.muted}>{l.teamName ?? ""}</span> },
    { id: "components", label: "Components", width: 100, compare: byNumber((l) => l.counts.components), render: (l) => l.counts.components },
    { id: "styles", label: "Styles", width: 70, compare: byNumber((l) => l.counts.styles), render: (l) => l.counts.styles },
    { id: "variables", label: "Variables", width: 80, compare: byNumber((l) => l.counts.variables), render: (l) => l.counts.variables },
    {
      id: "default", label: "Enabled by default", width: "minmax(140px, 1.4fr)",
      render: (l) => <button type="button" className={styles.cellButton} data-default-cell={l.key} onClick={() => setOpen(l.key)}>{defaultsText(l)}</button>,
    },
    { id: "inserts", label: "Inserts last week", width: 130, align: "end", compare: byNumber((l) => l.insertsLastWeek), render: (l) => l.insertsLastWeek.toLocaleString("en-US") },
    { id: "published", label: "Last published", width: 120, compare: byNumber((l) => l.lastPublishedAt), render: (l) => <span className={styles.muted}>{formatAgo(l.lastPublishedAt, now())}</span> },
  ];
  return (
    <>
      <p className={styles.note + " " + styles.intro}>
        {workspaceId ? "Libraries people in this workspace can use. Approve a library or enable it by default for the workspace's files." : "The Libraries tab contains a list of all the libraries you have access to in the organization."}
      </p>
      <div className={styles.toolbar}>
        <SearchField className={styles.search} value={text} onChange={setText} placeholder="Search libraries" />
        <button type="button" className={styles.seatCount} aria-pressed={approved} data-filter="approved" onClick={() => setApproved((v) => !v)}>Approved</button>
        <button type="button" className={styles.seatCount} aria-pressed={byDefault} data-filter="default" onClick={() => setByDefault((v) => !v)}>Added by default</button>
        <span className={styles.spacer} />
        <span className={styles.muted}>{rows.length === 1 ? "1 library" : `${rows.length} libraries`}</span>
      </div>
      {error && <p className={styles.danger}>{error}</p>}
      <Table label="Libraries" rows={rows} columns={columns} rowKey={(l) => l.key} onRowClick={(l) => setOpen(l.key)} empty={data === undefined ? "Loading…" : approved || byDefault || text ? "No libraries match" : "No published libraries yet"} />
      {open && <ManageLibraryDialog libraryKey={open} workspaceId={workspaceId} onClose={() => setOpen(null)} />}
    </>
  );
}

/**
 * The check mark after an approved library's name: approved for the organization (or, in a workspace's list, for that
 * workspace); in the organization's list a library approved only by workspaces shows a secondary mark naming them.
 */
function ApprovedMark({ library: l, workspaceId, names }: { library: OrgLibrarySummary; workspaceId?: string; names: Map<string, string> }) {
  if (isApproved(l, workspaceId)) return <span className={styles.approved} data-approved="" aria-label="Approved" {...tooltipProps("Approved")}><Icon name="16.check" /></span>;
  if (workspaceId || l.approved.workspaceIds.length === 0) return null;
  const label = `Approved for ${l.approved.workspaceIds.map((id) => names.get(id) ?? id).join(", ")}`;
  return <span className={styles.approvedWorkspace} data-approved="workspace" aria-label={label} {...tooltipProps(label)}><Icon name="16.check" /></span>;
}

/** "Manage this library" [L-find] */
export function ManageLibraryDialog({ libraryKey, workspaceId, onClose }: { libraryKey: string; workspaceId?: string; onClose: () => void }) {
  const { orgId, store, run } = useAdmin();
  const repo = store.orgLibraries!;
  const orgName = useOrgName();
  const names = useWorkspaceNames();
  const { data: loaded, error } = useLoad(() => repo.get(orgId, libraryKey), [orgId, libraryKey]);
  const [fresh, setFresh] = useState<OrgLibraryInfo | null>(null);
  const info = fresh ?? loaded;
  const [scopeId, setScopeId] = useState<string | null>(null);
  const [warn, setWarn] = useState<LibraryEditorType | null>(null);
  const save = async (scope: SettingScope, input: { approved?: boolean; defaults?: Partial<Record<LibraryEditorType, boolean | null>>; defaultModes?: { collectionKey: string; modeId: string | null }[] }) => {
    const out = await run(() => repo.updateSettings(orgId, libraryKey, { scope, ...input }));
    if (out) setFresh(out);
  };
  const body = () => {
    if (!info) return <p className={styles.note}>{error ?? "Loading…"}</p>;
    const orgScope: SettingScope = { type: "org", id: orgId };
    const scopes: { scope: SettingScope; label: string }[] = [
      ...(!workspaceId && info.canManage.org ? [{ scope: orgScope, label: orgName }] : []),
      ...info.canManage.workspaceIds
        .filter((id) => !workspaceId || id === workspaceId)
        .map((id) => ({ scope: { type: "workspace", id } as SettingScope, label: names.get(id) ?? info.settings.find((r) => r.scope.type === "workspace" && r.scope.id === id)?.scopeName ?? id })),
    ];
    const current = scopes.find((s) => `${s.scope.type}:${s.scope.id}` === scopeId) ?? scopes[0];
    // Approval: the organization's here; a workspace's in its own Libraries
    const approveScope: SettingScope | null = workspaceId ? { type: "workspace", id: workspaceId } : info.canManage.org ? orgScope : null;
    const approvedAbove = workspaceId ? info.approved.org : false;
    const approvedHere = workspaceId ? approvedAbove || info.approved.workspaceIds.includes(workspaceId) : info.approved.org;
    const row = current ? rowOf(info, current.scope) : undefined;
    const orgRow = rowOf(info, orgScope);
    const multi = info.collections.filter((c) => c.modes.length >= 2);
    const designOn = current?.scope.type === "workspace" && onIn(info, current.scope.id, "design", info.settings);
    return (
      <div className={styles.form} data-manage-library={info.key}>
        <div className={styles.libHeader}>
          <Icon name="24.library" />
          <div className={styles.settingText}>
            <span className={styles.settingLabel}>
              {info.name} {approvedHere && <span className={styles.approved} aria-label="Approved"><Icon name="16.check" /></span>}
            </span>
            <span className={styles.settingDescription}>
              {[info.teamName, info.scope === "org" ? `Anyone at ${orgName}` : "Team members", `Published ${formatDate(info.lastPublishedAt)}`].filter(Boolean).join(" · ")}
            </span>
            <span className={styles.settingDescription}>{`${info.counts.components} components · ${info.counts.styles} styles · ${info.counts.variables} variables`}</span>
          </div>
        </div>
        {approveScope && (
          <div className={styles.settingRow}>
            <div className={styles.settingText}>
              <span className={styles.settingLabel}>Set as approved library</span>
              <span className={styles.settingDescription}>
                {approvedAbove ? `Approved for ${orgName}. Only organization admins can change this.` : "Approved libraries show a check mark and are pinned to the top of the list."}
              </span>
            </div>
            <Switch label="Set as approved library" checked={approvedHere} disabled={approvedAbove} onChange={(on) => void save(approveScope, { approved: on })} />
          </div>
        )}
        {current && (
          <>
            <div className={styles.sectionHeader}>
              <h3 className={styles.sectionTitle}>Enable this library by default</h3>
              {scopes.length > 1 && (
                <Select label="Where" width={200} value={`${current.scope.type}:${current.scope.id}`} options={scopes.map((s) => ({ value: `${s.scope.type}:${s.scope.id}`, label: s.label }))} onChange={setScopeId} />
              )}
            </div>
            <p className={styles.note}>{current.scope.type === "org" ? `On by default in every file of ${orgName} of these types. People can still remove it from a file.` : `On by default in ${current.label}'s files of these types. This overrides the organization's setting.`}</p>
            {LIBRARY_EDITOR_TYPES.map((t) => {
              const value = row?.defaults[t] ?? null;
              return (
                <div key={t} className={`${styles.settingRow} ${styles.typeRow}`} data-file-type={t}>
                  <span className={styles.settingText}>{FILE_TYPE_LABEL[t]}</span>
                  {current.scope.type === "org" ? (
                    <Switch
                      label={FILE_TYPE_LABEL[t]}
                      checked={value === true}
                      onChange={(on) => (on && info.scope === "team" ? setWarn(t) : void save(current.scope, { defaults: { [t]: on ? true : null } }))}
                    />
                  ) : (
                    <Select
                      label={FILE_TYPE_LABEL[t]}
                      width={200}
                      value={value === null ? "inherit" : value ? "on" : "off"}
                      options={[{ value: "inherit", label: `Organization setting (${orgRow?.defaults[t] === true || info.defaultIn.org.includes(t) ? "On" : "Off"})` }, { value: "on", label: "On" }, { value: "off", label: "Off" }]}
                      onChange={(v) => void save(current.scope, { defaults: { [t]: v === "inherit" ? null : v === "on" } })}
                    />
                  )}
                </div>
              );
            })}
            {current.scope.type === "workspace" && (
              <div className={styles.modes} data-default-modes="">
                <h3 className={styles.sectionTitle}>Manage default modes</h3>
                {multi.length === 0 ? (
                  <p className={styles.note}>Publish a variable collection with at least two modes to choose a default mode.</p>
                ) : !designOn ? (
                  <p className={styles.note}>Turn on Design files to choose default modes for {current.label}.</p>
                ) : (
                  <>
                    <p className={styles.note}>New uses of these collections in {current.label}'s files start in this mode. People can switch to another mode whenever they need to.</p>
                    {multi.map((c) => {
                      const chosen = row?.defaultModes.find((m) => m.collectionKey === c.collectionKey)?.modeId ?? "default";
                      return (
                        <div key={c.collectionKey} className={`${styles.settingRow} ${styles.typeRow}`} data-collection={c.collectionKey}>
                          <span className={styles.settingText}>{c.name}</span>
                          <Select
                            label={`Default mode for ${c.name}`}
                            width={200}
                            value={chosen}
                            options={[{ value: "default", label: `${c.modes[0].name} (collection default)` }, ...c.modes.map((m) => ({ value: m.id, label: m.name }))]}
                            onChange={(v) => void save(current.scope, { defaultModes: [{ collectionKey: c.collectionKey, modeId: v === "default" ? null : v }] })}
                          />
                        </div>
                      );
                    })}
                  </>
                )}
              </div>
            )}
          </>
        )}
        {!approveScope && !current && <p className={styles.note}>Only admins can change this library's settings.</p>}
      </div>
    );
  };
  return (
    <>
      <Dialog title="Manage this library" open={!warn} size="medium" onClose={onClose} footer={<Button variant="primary" onClick={onClose}>Done</Button>}>
        {body()}
      </Dialog>
      {warn && info && (
        <ConfirmDialog
          title="Publish to the organization?"
          body={`${info.name} isn't shared with everyone at ${orgName}. Enabling it by default will publish the library to the organization and change the file's permissions: anyone at ${orgName} will be able to view it.`}
          confirm="Enable by default"
          onConfirm={() => void save({ type: "org", id: orgId }, { defaults: { [warn]: true } })}
          onClose={() => setWarn(null)}
        />
      )}
    </>
  );
}

// ---------------------------------------------------------------------------------------------------- Fonts

interface Family {
  family: string;
  faces: SharedFontFace[];
}

export function FontsTab() {
  const { orgId, fonts, run, now } = useAdmin();
  const orgName = useOrgName();
  const scope: SharedFontScope = { type: "org", orgId };
  const { data, error } = useLoad(() => (fonts ? fonts.sharedList(scope).then((r) => r.faces) : Promise.resolve([])), [orgId, fonts]);
  const [picked, setPicked] = useState<Picked | null>(null);
  const [remove, setRemove] = useState<Family | null>(null);
  if (!fonts) return <p className={styles.note}>Fonts can be uploaded in the desktop app.</p>;
  // Font › main's Open dialog (TTF, OTF, several files), each file parsed and the conflicts asked
  const pick = async () => {
    try {
      const r = await fonts.sharedPick(scope);
      if (!("cancelled" in r)) setPicked(r);
    } catch (e) {
      showToast({ message: e instanceof Error ? e.message : String(e), kind: "error" });
    }
  };
  const families: Family[] = [];
  for (const f of data ?? []) {
    const fam = families.find((x) => x.family.toLowerCase() === f.family.toLowerCase());
    if (fam) fam.faces.push(f);
    else families.push({ family: f.family, faces: [f] });
  }
  for (const fam of families) fam.faces.sort((a, b) => a.weight - b.weight || Number(a.italic) - Number(b.italic));
  const latest = (f: Family) => Math.max(...f.faces.map((x) => x.uploadedAt));
  const columns: Column<Family>[] = [
    { id: "family", label: "Font", width: "minmax(200px, 2fr)", compare: byText((f) => f.family), render: (f) => <span className={styles.settingLabel}>{f.family}</span> },
    { id: "styles", label: "Styles", width: "minmax(200px, 2fr)", compare: byNumber((f) => f.faces.length), render: (f) => <span className={styles.muted}>{f.faces.map((x) => x.style).join(", ")}</span> },
    { id: "by", label: "Uploaded by", compare: byText((f) => f.faces[0].uploadedBy?.name), render: (f) => f.faces[0].uploadedBy?.name ?? "" },
    { id: "added", label: "Date added", width: 120, compare: byNumber(latest), render: (f) => <span className={styles.muted}>{formatAgo(latest(f), now())}</span> },
    { id: "menu", label: "", width: 32, align: "end", render: (f) => <RowMenu label={`Actions for ${f.family}`} entries={[{ id: "remove", label: "Remove font", danger: true }]} onSelect={() => setRemove(f)} /> },
  ];
  return (
    <>
      <div className={styles.toolbar}>
        <span className={styles.muted}>Fonts uploaded here are available in the font picker for files in {orgName}. Admins should only upload fonts they own or have a license to use.</span>
        <span className={styles.spacer} />
        <span className={styles.muted}>{families.length === 1 ? "1 font" : `${families.length} fonts`}</span>
        <Button variant="primary" icon="24.plus.small" onClick={() => void pick()}>Font</Button>
      </div>
      {error && <p className={styles.danger}>{error}</p>}
      <Table label="Fonts" rows={families} columns={columns} rowKey={(f) => f.family} initialSort={{ column: "family", direction: "ascending" }} empty={data === undefined ? "Loading…" : "No fonts uploaded yet"} />
      {picked && <FontUpload scope={scope} orgName={orgName} picked={picked} onClose={() => setPicked(null)} />}
      {remove && (
        <ConfirmDialog
          title={`Remove ${remove.family}?`}
          body={`People at ${orgName} can no longer use ${remove.family}. Text already set in it shows as a missing font.`}
          confirm="Remove"
          destructive
          onConfirm={() => void run(() => fonts.sharedRemove({ scope, family: remove.family }), `Removed ${remove.family}`)}
          onClose={() => setRemove(null)}
        />
      )}
    </>
  );
}

type Picked = { candidates: FontUploadCandidate[]; conflicts: FontConflict[]; failed: { fileName: string; reason: string }[] };

/** Font › Open (main's dialog) › confirm the licence › Upload › Skip or Replace for each family already uploaded [SF] */
function FontUpload({ scope, orgName, picked, onClose }: { scope: SharedFontScope; orgName: string; picked: Picked; onClose: () => void }) {
  const { fonts, run } = useAdmin();
  const [licence, setLicence] = useState(false);
  const [asking, setAsking] = useState<number | null>(null);
  const [choices, setChoices] = useState<Record<string, FontConflictChoice>>({});
  const upload = async (all: Record<string, FontConflictChoice>) => {
    const out = await run(() => fonts!.sharedUpload({ scope, tokens: picked.candidates.map((c) => c.token), licenceConfirmed: true, choices: all }));
    onClose();
    if (!out) return;
    const n = out.uploaded.length;
    if (n) showToast({ message: n === 1 ? "Uploaded 1 font" : `Uploaded ${n} fonts` });
    for (const f of out.failed) showToast({ message: `Couldn't upload ${f.fileName}: ${f.reason}`, kind: "error" });
  };
  const next = (i: number, all: Record<string, FontConflictChoice>) => {
    if (i < picked.conflicts.length) setAsking(i);
    else void upload(all);
  };
  if (asking !== null) {
    const c = picked.conflicts[asking];
    const choose = (v: FontConflictChoice) => {
      const all = { ...choices, [c.family]: v };
      setChoices(all);
      next(asking + 1, all);
    };
    return (
      <Dialog
        title="This font family is already uploaded"
        open
        onClose={onClose}
        footer={
          <>
            <Button variant="secondary" onClick={() => choose("skip")}>Skip</Button>
            <Button variant="primary" onClick={() => choose("replace")}>Replace</Button>
          </>
        }
      >
        <div className={styles.note} data-font-conflict={c.family}>
          {`${orgName} already has fonts uploaded with the family name ${c.family} (${c.existing === 1 ? "1 style" : `${c.existing} styles`}). Click Skip to leave the font out of the upload, or Replace to update the existing font.`}
        </div>
      </Dialog>
    );
  }
  const faces = picked.candidates.reduce((n, c) => n + c.faces.length, 0);
  return (
    <Dialog
      title="Upload fonts"
      open
      size="medium"
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!licence || picked.candidates.length === 0} onClick={() => next(0, {})}>Upload</Button>
        </>
      }
    >
      <div className={styles.form}>
        <div className={styles.pickList} role="list" aria-label="Fonts to upload">
          {picked.candidates.map((c) => (
            <div key={c.token} role="listitem" className={styles.pickRow} data-font-file={c.fileName}>
              <Icon name="24.text.font-size" />
              <span className={styles.whoText}>
                <span className={styles.whoName}>{c.faces.map((f) => `${f.family} ${f.style}`).join(", ")}</span>
                <span className={styles.whoEmail}>{c.fileName}</span>
              </span>
              {picked.conflicts.some((x) => c.faces.some((f) => f.family.toLowerCase() === x.family.toLowerCase())) && <Badge tone="warning">Already uploaded</Badge>}
            </div>
          ))}
          {picked.failed.map((f) => (
            <div key={f.fileName} role="listitem" className={styles.pickRow} data-font-failed={f.fileName}>
              <Icon name="24.missing-fonts" />
              <span className={styles.whoText}>
                <span className={styles.whoName}>{f.fileName}</span>
                <span className={styles.danger}>{f.reason}</span>
              </span>
            </div>
          ))}
        </div>
        {picked.candidates.length > 0 && <span className={styles.note}>{faces === 1 ? "1 font style" : `${faces} font styles`} will be available in the font picker for files in {orgName}.</span>}
        <Checkbox label="I confirm I have the necessary rights and licenses to use the font(s)" checked={licence} onChange={setLicence} disabled={picked.candidates.length === 0} />
      </div>
    </Dialog>
  );
}
