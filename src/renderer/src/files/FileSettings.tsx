/**
 * File settings (ours — Figma has no such screen; docs/home.md "File settings [ours]"): Home's "File settings…" on a
 * file card or row opens this draggable dialog in Figma's UI3 style, with five tabs —
 *
 * - **Overview**: name, where it lives, owner, created / last edited (by whom), last viewed, its size here and in the
 *   cloud, versions, branches, whether it is only on this computer, a cloud draft, shared or an org file, its key / link.
 * - **Storage**: its bytes by kind here (`files.details`) and on the server (`multiplayer.fileReport`), as bars, and the
 *   owner's account quota (the public sign-up limits, src/shared/quota.ts).
 * - **People**: who has access and as what, link access, edit requests, who opened it — over the Share dialog's own
 *   calls (`multiplayer.members` / `invite` / `removeMember` / `answerRequest` / `setLinkAccess`).
 * - **Activity**: the local log (versions, editing sessions, previews) merged with the server's
 *   (`multiplayer.fileActivity`), filterable and paged.
 * - **Settings**: the per-file options Wecra has (starred, enabled libraries, library status, viewers' copying, offline
 *   availability, thumbnail).
 *
 * Signed out or offline, the local parts show and the server's say why they are empty. Everything comes through the
 * store's port (`FileSettingsSource`); nothing here reads or writes files.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Avatar, Badge, Button, Dialog, EmptyState, ScrollArea, SearchField, Select, Spinner, Switch, Tabs, timeAgo, type ToastOptions } from "@/ds";
import { t, tp, useT } from "@/i18n";
import type { AccountUsage } from "@shared/quota";
import { formatBytes } from "@shared/quota";
import type { AccessRequest, FileMember, FileShareState, LinkAccess, SharedFileInfo } from "@shared/multiplayer/types";
import { ACTIVITY_FILTERS, ACTIVITY_PAGE, filterActivity, kindsOf, mergeActivity, share, type ActivityFilter, type FileActivityEvent, type FileActivityPage, type FileDetails, type FileServerReport, type StoragePart } from "@shared/store/fileSettings";
import type { FileKey, FileListItem, Folder, LibraryRecord } from "@shared/store/types";
import type { WorkspaceRepository } from "@shared/store/repositories";
import type { BranchesRepository } from "@shared/merge/branches";
import styles from "./FileSettings.module.css";

/** What the dialog reads and changes, all over the store's port (storeAccess.ts builds it from the store client) */
export interface FileSettingsSource {
  details(fileKey: FileKey): Promise<FileDetails>;
  /** Null: not on the server, or signed out */
  report(fileKey: FileKey): Promise<FileServerReport | null>;
  activity(fileKey: FileKey, query: { cursor?: number; kinds?: readonly FileActivityEvent["kind"][]; limit?: number }): Promise<FileActivityPage | null>;
  /** Signed in to the server */
  signedIn(): Promise<boolean>;
  shareState?(fileKey: FileKey): Promise<FileShareState>;
  info?(fileKey: FileKey): Promise<SharedFileInfo>;
  members?(fileKey: FileKey): Promise<FileMember[]>;
  requests?(fileKey: FileKey): Promise<AccessRequest[]>;
  invite?(fileKey: FileKey, email: string, role: "editor" | "viewer"): Promise<FileMember[]>;
  removeMember?(fileKey: FileKey, email: string): Promise<FileMember[]>;
  answerRequest?(fileKey: FileKey, userId: string, approve: boolean): Promise<AccessRequest[]>;
  setLinkAccess?(fileKey: FileKey, access: LinkAccess): Promise<SharedFileInfo>;
  setViewersCanCopy?(fileKey: FileKey, on: boolean): Promise<SharedFileInfo>;
  /** The account's own quota (`GET /me/usage`) for a file the server doesn't have yet */
  usage?(): Promise<AccountUsage | null>;
  libraries?: { listAvailable(fileKey: FileKey): Promise<LibraryRecord[]>; setEnabled(fileKey: FileKey, libraryFileKey: FileKey, enabled: boolean): Promise<unknown> };
}

export type FileSettingsTab = "overview" | "storage" | "people" | "activity" | "settings";

export const STORAGE_LABEL: Record<StoragePart["kind"], string> = {
  document: "Document",
  images: "Images",
  media: "Videos and sounds",
  versions: "Versions",
  previews: "Developer previews",
  thumbnail: "Thumbnail",
  other: "Other files",
};

/** Each log entry's words (FileActivityEvent.action) */
export const ACTION_LABEL: Record<string, string> = {
  created: "Created the file",
  imported: "Imported the file",
  import: "Imported the file",
  duplicated: "Duplicated the file",
  renamed: "Renamed the file",
  moved: "Moved the file",
  trashed: "Moved the file to trash",
  untrashed: "Restored the file from trash",
  opened: "Opened the file",
  prototype: "Viewed the prototype",
  exported: "Exported from the file",
  "saved-copy": "Saved a local copy",
  "member-added": "Gave access",
  "role-changed": "Changed access",
  "member-removed": "Removed access",
  "link-changed": "Changed link access",
  "link-expiry": "Changed when the link expires",
  "prototype-link": "Changed prototype link access",
  "password-set": "Set a link password",
  "password-removed": "Removed the link password",
  "viewers-copy": "Changed whether viewers can copy",
  comment: "Commented",
  reply: "Replied to a comment",
  resolved: "Resolved a comment",
  named: "Saved a version",
  autosave: "Edited the file",
  session: "Edited the file",
  restored: "Restored a version",
  restore: "Restored a version",
  published: "Published the library",
  publish: "Published the library",
  "branch-created": "Created a branch",
  merged: "Merged a branch",
  updated: "Updated from main",
  preview: "Published a developer preview",
};

const FILTER_LABEL: Record<ActivityFilter, string> = { all: "All activity", edits: "Edits", versions: "Versions", sharing: "Sharing", comments: "Comments", views: "Views" };

const bytes = (n: number) => (n < 1024 ? tp(n, "{n} byte", "{n} bytes") : formatBytes(n));
const when = (at: number | null | undefined) => (at ? `${new Date(at).toLocaleString()} · ${timeAgo(at)}` : "—");

interface Props {
  file: FileListItem;
  workspace: Pick<WorkspaceRepository, "getFile" | "listFolders" | "setStarred">;
  source: FileSettingsSource;
  branches?: Pick<BranchesRepository, "list">;
  /** The team's name (the local space's "‹Owner›'s team") */
  teamName?: string;
  initialTab?: FileSettingsTab;
  onClose: () => void;
  toast: (o: ToastOptions) => void;
}

/** The server half: loading, there, not there (and why) */
type Remote = { state: "loading" } | { state: "none"; why: "signed-out" | "local" | "failed" } | { state: "ok"; report: FileServerReport };

export function FileSettingsDialog({ file: initial, workspace, source, branches, teamName, initialTab = "overview", onClose, toast }: Props) {
  useT();
  const fileKey = initial.fileKey;
  const [tab, setTab] = useState<FileSettingsTab>(initialTab);
  const [file, setFile] = useState(initial);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [details, setDetails] = useState<FileDetails | null>(null);
  const [remote, setRemote] = useState<Remote>({ state: "loading" });
  const [branchCount, setBranchCount] = useState<number | null>(null);
  const [usage, setUsage] = useState<AccountUsage | null>(null);
  const [version, setVersion] = useState(0);
  const reload = useCallback(() => setVersion((v) => v + 1), []);

  useEffect(() => {
    let live = true;
    void workspace.getFile(fileKey).then((f) => live && setFile(f), () => {});
    void workspace.listFolders().then((f) => live && setFolders(f), () => {});
    void source.details(fileKey).then(
      (d) => live && setDetails(d),
      () => live && setDetails(null),
    );
    void (async () => {
      const signedIn = await source.signedIn().catch(() => false);
      if (!signedIn) return live && setRemote({ state: "none", why: "signed-out" });
      try {
        const report = await source.report(fileKey);
        if (live) setRemote(report ? { state: "ok", report } : { state: "none", why: "local" });
        if (!report?.quota && source.usage) {
          const u = await source.usage().catch(() => null);
          if (live) setUsage(u);
        }
      } catch {
        if (live) setRemote({ state: "none", why: "failed" });
      }
    })();
    if (branches && !initial.branch) void branches.list(fileKey, "active").then((b) => live && setBranchCount(b.length), () => live && setBranchCount(null));
    return () => {
      live = false;
    };
  }, [fileKey, workspace, source, branches, initial.branch, version]);

  const report = remote.state === "ok" ? remote.report : null;
  const tabs = [
    { value: "overview", label: t("Overview") },
    { value: "storage", label: t("Storage") },
    { value: "people", label: t("People") },
    { value: "activity", label: t("Activity") },
    { value: "settings", label: t("Settings") },
  ];
  return (
    <Dialog title={t("File settings")} size="large" open onClose={onClose} draggable header="small" className={styles.dialog}>
      <div className={styles.root} data-file-settings={fileKey}>
        <Tabs label={t("File settings")} value={tab} tabs={tabs} onChange={(v) => setTab(v as FileSettingsTab)} />
        <ScrollArea className={styles.body}>
          {tab === "overview" && <Overview file={file} folders={folders} teamName={teamName} details={details} remote={remote} branchCount={report ? report.branches : branchCount} toast={toast} />}
          {tab === "storage" && <Storage details={details} remote={remote} usage={report?.quota ? null : usage} />}
          {tab === "people" && <People fileKey={fileKey} remote={remote} source={source} toast={toast} onChanged={reload} />}
          {tab === "activity" && <Activity fileKey={fileKey} details={details} remote={remote} source={source} />}
          {tab === "settings" && <Settings file={file} details={details} remote={remote} workspace={workspace} source={source} toast={toast} onChanged={reload} />}
        </ScrollArea>
      </div>
    </Dialog>
  );
}

// --- the parts ----------------------------------------------------------------------------------------------------

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className={styles.row}>
      <dt className={styles.label}>{label}</dt>
      <dd className={styles.value}>{children}</dd>
    </div>
  );
}

function Section({ title, children, hint }: { title: string; children: React.ReactNode; hint?: string }) {
  return (
    <section className={styles.section} aria-label={title}>
      <h3 className={styles.heading}>{title}</h3>
      {hint && <p className={styles.hint}>{hint}</p>}
      {children}
    </section>
  );
}

/** Where the server part isn't there: why, in Figma's empty-state style */
function RemoteEmpty({ remote, what }: { remote: Remote; what: "people" | "storage" | "activity" }) {
  if (remote.state === "loading") return <Spinner size={16} />;
  if (remote.state === "ok") return null;
  const title = remote.why === "signed-out" ? t("Log in to see this") : remote.why === "failed" ? t("Couldn’t reach the server") : t("Only on this computer");
  const body =
    remote.why === "signed-out"
      ? t("Sharing, cloud storage and the file’s history on the server show once you’re logged in.")
      : remote.why === "failed"
        ? t("You may be offline. What this computer knows is shown; try again later.")
        : what === "people"
          ? t("Share the file to give people access.")
          : t("This file isn’t on the server yet, so nothing is stored there.");
  return <EmptyState icon={remote.why === "local" ? "24.lock.small" : "24.warning"} title={title} body={body} />;
}

function statusOf(file: FileListItem, remote: Remote): string {
  if (file.space) return t("In an organization");
  if (remote.state === "ok") return remote.report.place.kind === "drafts" && remote.report.role === "owner" ? t("In your cloud drafts") : t("Shared");
  if (file.cloud) return t("In your cloud drafts");
  return t("Local only");
}

function locationOf(file: FileListItem, folders: Folder[], remote: Remote, teamName?: string): string {
  if (file.trashedAt) return t("Trash");
  if (remote.state === "ok" && remote.report.place.kind === "org") {
    const p = remote.report.place;
    return [p.orgName, p.teamName, p.projectName ?? t("Drafts")].filter(Boolean).join(" / ");
  }
  if (remote.state === "ok" && remote.report.role !== "owner") return t("Shared with you");
  const byId = new Map(folders.map((f) => [f.id, f]));
  const path: string[] = [];
  for (let id = file.folderId, guard = 0; id && guard < 12; guard++) {
    const f = byId.get(id);
    if (!f) break;
    path.unshift(f.name);
    id = f.parentId;
  }
  return path.length ? [teamName, ...path].filter(Boolean).join(" / ") : t("Drafts");
}

function Overview({ file, folders, teamName, details, remote, branchCount, toast }: { file: FileListItem; folders: Folder[]; teamName?: string; details: FileDetails | null; remote: Remote; branchCount: number | null; toast: (o: ToastOptions) => void }) {
  const report = remote.state === "ok" ? remote.report : null;
  const link = `designerv2://file/${file.fileKey}`;
  const copy = () =>
    void navigator.clipboard?.writeText(link).then(
      () => toast({ message: t("Link copied to clipboard") }),
      () => toast({ kind: "error", message: t("Couldn’t copy the link") }),
    );
  const ownerName = report?.owner ? report.owner.name || report.owner.email : remote.state === "ok" ? "—" : t("You");
  const lastEdit = Math.max(file.updatedAt, details?.lastEditAt ?? 0, report?.updatedAt ?? 0);
  return (
    <dl className={styles.grid}>
      <Row label={t("Name")}>{file.name}</Row>
      <Row label={t("Location")}>{locationOf(file, folders, remote, teamName)}</Row>
      <Row label={t("Owner")}>
        <span className={styles.person}>
          <Avatar name={ownerName} src={report?.owner?.picture ?? undefined} size={16} />
          {ownerName}
        </span>
      </Row>
      <Row label={t("Created")}>{when(report?.createdAt ?? file.createdAt)}</Row>
      <Row label={t("Last edited")}>{report?.lastEditedBy ? t("{time} by {name}", { time: when(lastEdit), name: report.lastEditedBy }) : when(lastEdit)}</Row>
      <Row label={t("Last viewed")}>{when(file.lastViewedAt)}</Row>
      <Row label={t("Size on this computer")}>{details ? (details.documentHere ? bytes(details.totalBytes) : t("Not downloaded")) : <Spinner size={16} />}</Row>
      <Row label={t("Size in the cloud")}>{report ? bytes(report.totalBytes) : remote.state === "loading" ? <Spinner size={16} /> : "—"}</Row>
      <Row label={t("Versions")}>{details ? (report && report.versions > details.versions.total ? report.versions : details.versions.total) : "—"}</Row>
      <Row label={t("Branches")}>{file.branch ? t("This file is a branch of another file") : branchCount === null ? "—" : branchCount}</Row>
      <Row label={t("Comments")}>{report ? tp(report.comments.threads, "{n} thread ({open} open)", "{n} threads ({open} open)", { open: report.comments.open }) : "—"}</Row>
      <Row label={t("Status")}>
        <Badge tone={file.space || remote.state === "ok" ? "brand" : "default"}>{statusOf(file, remote)}</Badge>
      </Row>
      <Row label={t("File key")}>
        <span className={styles.key}>
          <code className={styles.code}>{report?.key ?? file.fileKey}</code>
          <Button variant="secondary" onClick={copy}>
            {t("Copy link")}
          </Button>
        </span>
      </Row>
    </dl>
  );
}

function Bar({ parts, total, label }: { parts: readonly StoragePart[]; total: number; label: string }) {
  return (
    <div className={styles.bar} role="img" aria-label={label}>
      {total > 0 && parts.filter((p) => p.bytes > 0).map((p) => <span key={p.kind} className={styles[`seg_${p.kind}`]} style={{ width: `${(p.bytes / total) * 100}%` }} />)}
    </div>
  );
}

function Breakdown({ parts, total, title }: { parts: readonly StoragePart[]; total: number; title: string }) {
  return (
    <>
      <div className={styles.barHead}>
        <span>{title}</span>
        <span className={styles.total}>{bytes(total)}</span>
      </div>
      <Bar parts={parts} total={total} label={t("{what}: {size}", { what: title, size: bytes(total) })} />
      <ul className={styles.legend}>
        {parts.map((p) => (
          <li key={p.kind} className={styles.legendRow} data-storage={p.kind}>
            <span className={`${styles.dot} ${styles[`seg_${p.kind}`]}`} />
            <span className={styles.legendName}>{t(STORAGE_LABEL[p.kind])}</span>
            {p.count !== undefined && <span className={styles.legendCount}>{tp(p.count, "{n} item", "{n} items")}</span>}
            <span className={styles.legendBytes}>{bytes(p.bytes)}</span>
          </li>
        ))}
      </ul>
    </>
  );
}

function Meter({ label, used, limit, format = (n: number) => String(n) }: { label: string; used: number; limit: number; format?: (n: number) => string }) {
  const s = share(used, limit);
  return (
    <div className={styles.meter} data-quota={label}>
      <div className={styles.barHead}>
        <span>{label}</span>
        <span className={styles.total}>{t("{used} of {limit}", { used: format(used), limit: format(limit) })}</span>
      </div>
      <div className={styles.bar} role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={limit} aria-valuenow={used}>
        <span className={s >= 0.9 ? styles.fillDanger : s >= 0.75 ? styles.fillWarning : styles.fill} style={{ width: `${s * 100}%` }} />
      </div>
    </div>
  );
}

function Storage({ details, remote, usage }: { details: FileDetails | null; remote: Remote; usage: AccountUsage | null }) {
  const report = remote.state === "ok" ? remote.report : null;
  const quota = report?.quota ?? (usage ? { storageBytes: usage.usage.storageBytes, storageLimit: usage.limits.storage_bytes, files: usage.usage.sharedFiles, filesLimit: usage.limits.shared_files, previews: usage.usage.previews, previewsLimit: usage.limits.previews } : null);
  return (
    <>
      <Section title={t("On this computer")} hint={details && !details.documentHere ? t("The file isn’t downloaded: it opens from the cloud.") : details?.missingImages ? tp(details.missingImages, "{n} image is still downloading.", "{n} images are still downloading.") : undefined}>
        {details ? <Breakdown parts={details.storage} total={details.totalBytes} title={t("This file")} /> : <Spinner size={16} />}
      </Section>
      <Section title={t("In the cloud")}>{report ? <Breakdown parts={report.storage} total={report.totalBytes} title={t("This file")} /> : <RemoteEmpty remote={remote} what="storage" />}</Section>
      <Section title={t("Your account’s quota")} hint={quota ? t("Files in organizations count against their owner’s quota; organizations have no separate one.") : undefined}>
        {quota ? (
          <>
            <Meter label={t("Storage")} used={quota.storageBytes} limit={quota.storageLimit} format={bytes} />
            <Meter label={t("Files on the server")} used={quota.files} limit={quota.filesLimit} />
            <Meter label={t("Developer previews")} used={quota.previews} limit={quota.previewsLimit} />
          </>
        ) : report ? (
          <p className={styles.hint}>{t("Only the file’s owner sees their quota.")}</p>
        ) : (
          <RemoteEmpty remote={remote} what="storage" />
        )}
      </Section>
    </>
  );
}

function People({ fileKey, remote, source, toast, onChanged }: { fileKey: FileKey; remote: Remote; source: FileSettingsSource; toast: (o: ToastOptions) => void; onChanged: () => void }) {
  const [members, setMembers] = useState<FileMember[] | null>(null);
  const [requests, setRequests] = useState<AccessRequest[]>([]);
  const [info, setInfo] = useState<SharedFileInfo | null>(null);
  const shared = remote.state === "ok";
  useEffect(() => {
    if (!shared) return;
    let live = true;
    void source.members?.(fileKey).then((m) => live && setMembers(m), () => live && setMembers([]));
    void source.info?.(fileKey).then((i) => live && setInfo(i), () => {});
    void source.requests?.(fileKey).then((r) => live && setRequests(r), () => {});
    return () => {
      live = false;
    };
  }, [fileKey, source, shared]);
  if (!shared) return <RemoteEmpty remote={remote} what="people" />;
  const report = remote.report;
  const canShare = info?.access?.canShare ?? (report.role === "owner" || report.role === "editor");
  const canManage = info?.access?.canManage ?? report.role === "owner";
  const write = async <T,>(run: () => Promise<T> | undefined, done: string, then: (v: T) => void) => {
    try {
      const v = await run();
      if (v !== undefined) then(v);
      toast({ message: done });
      onChanged();
    } catch (e) {
      toast({ kind: "error", message: t("Couldn’t change access: {error}", { error: e instanceof Error ? e.message : String(e) }) });
    }
  };
  const roleLabel = (r: string) => (r === "owner" ? t("Owner") : r === "editor" ? t("Can edit") : t("Can view"));
  return (
    <>
      {info && (
        <Section title={t("Link access")}>
          <Select
            label={t("Link access")}
            value={info.linkAccess}
            disabled={!canManage || !source.setLinkAccess}
            options={[
              { value: "none", label: t("Only people invited to this file") },
              { value: "viewer", label: t("Anyone with the link can view") },
              { value: "editor", label: t("Anyone with the link can edit") },
            ]}
            onChange={(v) => void write(() => source.setLinkAccess?.(fileKey, v as LinkAccess), t("Link access changed"), setInfo)}
          />
        </Section>
      )}
      <Section title={t("Who has access")}>
        {members === null ? (
          <Spinner size={16} />
        ) : (
          <ul className={styles.people}>
            {members.map((m) => (
              <li key={m.email} className={styles.personRow} data-member={m.email}>
                <Avatar name={m.name || m.email} src={m.picture ?? undefined} size={24} />
                <span className={styles.personText}>
                  <span className={styles.personName}>{m.name || m.email}</span>
                  <span className={styles.personHint}>{m.pending ? t("Invited · {email}", { email: m.email }) : m.email}</span>
                </span>
                {m.role === "owner" || !canShare ? (
                  <span className={styles.personRole}>{roleLabel(m.role)}</span>
                ) : (
                  <Select
                    label={t("Access for {name}", { name: m.name || m.email })}
                    value={m.role}
                    variant="ghost"
                    width="hug"
                    options={[{ value: "editor", label: t("Can edit") }, { value: "viewer", label: t("Can view") }, "-", { value: "remove", label: t("Remove") }]}
                    onChange={(v) =>
                      void write(
                        () => (v === "remove" ? source.removeMember?.(fileKey, m.email) : source.invite?.(fileKey, m.email, v === "viewer" ? "viewer" : "editor")),
                        v === "remove" ? t("Removed {email}", { email: m.email }) : t("Access changed"),
                        setMembers,
                      )
                    }
                  />
                )}
              </li>
            ))}
          </ul>
        )}
      </Section>
      {canShare && requests.length > 0 && (
        <Section title={t("Requests to edit")}>
          <ul className={styles.people}>
            {requests.map((r) => (
              <li key={r.userId} className={styles.personRow} data-request={r.userId}>
                <Avatar name={r.name || r.email} src={r.picture ?? undefined} size={24} />
                <span className={styles.personText}>
                  <span className={styles.personName}>{r.name || r.email}</span>
                  <span className={styles.personHint}>{timeAgo(r.createdAt)}</span>
                </span>
                <Button variant="secondary" onClick={() => void write(() => source.answerRequest?.(fileKey, r.userId, false), t("Request declined"), setRequests)}>
                  {t("Decline")}
                </Button>
                <Button variant="primary" onClick={() => void write(() => source.answerRequest?.(fileKey, r.userId, true), t("Request approved"), setRequests)}>
                  {t("Approve")}
                </Button>
              </li>
            ))}
          </ul>
        </Section>
      )}
      <Section title={t("Opened by")} hint={report.visitors.length ? undefined : t("Opens are recorded for files in organizations.")}>
        <ul className={styles.people}>
          {report.visitors.map((v) => (
            <li key={v.userId} className={styles.personRow} data-visitor={v.userId}>
              <Avatar name={v.name || v.email} src={v.picture ?? undefined} size={24} />
              <span className={styles.personText}>
                <span className={styles.personName}>{v.name || v.email}</span>
                <span className={styles.personHint}>{t("Last opened {time}", { time: timeAgo(v.lastAt) })}</span>
              </span>
              <span className={styles.personRole}>{tp(v.opens, "{n} open", "{n} opens")}</span>
            </li>
          ))}
        </ul>
      </Section>
    </>
  );
}

function Activity({ fileKey, details, remote, source }: { fileKey: FileKey; details: FileDetails | null; remote: Remote; source: FileSettingsSource }) {
  const [filter, setFilter] = useState<ActivityFilter>("all");
  const [text, setText] = useState("");
  // The server's pages for the filter shown (`filter` says which filter they were read for: another one is loading)
  const [log, setLog] = useState<{ filter: ActivityFilter; events: FileActivityEvent[]; next: number | null } | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [shown, setShown] = useState(ACTIVITY_PAGE);
  const online = remote.state === "ok";
  const query = useCallback((cursor: number, f: ActivityFilter) => source.activity(fileKey, { cursor, kinds: f === "all" ? undefined : kindsOf(f), limit: ACTIVITY_PAGE }), [fileKey, source]);
  useEffect(() => {
    if (!online) return;
    let live = true;
    void query(0, filter).then(
      (page) => live && setLog({ filter, events: page?.events ?? [], next: page?.next ?? null }),
      () => live && setLog({ filter, events: [], next: null }),
    );
    return () => {
      live = false;
    };
  }, [online, filter, query]);
  const current = log?.filter === filter ? log : null;
  const server = useMemo(() => current?.events ?? [], [current]);
  const next = current?.next ?? null;
  const loading = loadingMore || (online && !current);
  const loadMore = async (cursor: number) => {
    setLoadingMore(true);
    try {
      const page = await query(cursor, filter);
      setLog((l) => (l && l.filter === filter ? { filter, events: [...l.events, ...(page?.events ?? [])], next: page?.next ?? null } : l));
    } catch {
      setLog((l) => (l ? { ...l, next: null } : l));
    } finally {
      setLoadingMore(false);
    }
  };
  const events = useMemo(() => filterActivity(mergeActivity(details?.activity ?? [], server), filter, text), [details, server, filter, text]);
  const more = shown < events.length || next !== null;
  return (
    <>
      <div className={styles.filters}>
        <Select
          label={t("Show")}
          value={filter}
          options={ACTIVITY_FILTERS.map((f) => ({ value: f, label: t(FILTER_LABEL[f]) }))}
          onChange={(v) => {
            setShown(ACTIVITY_PAGE);
            setFilter(v as ActivityFilter);
          }}
          width={160}
        />
        <SearchField value={text} onChange={setText} placeholder={t("Search activity")} label={t("Search activity")} className={styles.search} />
      </div>
      {!online && remote.state !== "loading" && <p className={styles.hint}>{remote.why === "signed-out" ? t("Only this computer’s activity is shown. Log in to see the file’s history on the server.") : remote.why === "failed" ? t("Only this computer’s activity is shown: the server didn’t answer.") : t("Only this computer’s activity is shown: the file isn’t on the server.")}</p>}
      {!events.length && !loading ? (
        <EmptyState title={t("No activity")} body={text || filter !== "all" ? t("Nothing matches this filter.") : undefined} />
      ) : (
        <ol className={styles.log}>
          {events.slice(0, shown).map((e) => (
            <li key={e.id} className={styles.logRow} data-activity={e.action} data-source={e.source}>
              <span className={styles.logText}>
                <span className={styles.logWhat}>{t(ACTION_LABEL[e.action] ?? e.kind)}</span>
                <span className={styles.logDetail}>{[e.actor ?? (e.source === "local" ? t("You") : t("Someone")), e.count !== undefined && e.action === "session" ? tp(e.count, "{n} change", "{n} changes") : null, e.detail].filter(Boolean).join(" · ")}</span>
              </span>
              {e.source === "local" && <Badge>{t("This computer")}</Badge>}
              <time className={styles.logTime} dateTime={new Date(e.at).toISOString()} title={new Date(e.at).toLocaleString()}>
                {timeAgo(e.at)}
              </time>
            </li>
          ))}
        </ol>
      )}
      {loading && <Spinner size={16} />}
      {more && !loading && (
        <Button
          variant="secondary"
          onClick={() => {
            if (shown < events.length) setShown((n) => n + ACTIVITY_PAGE);
            if (next !== null && shown + ACTIVITY_PAGE >= events.length) void loadMore(next);
          }}
        >
          {t("Show more")}
        </Button>
      )}
    </>
  );
}

function Settings({ file, details, remote, workspace, source, toast, onChanged }: { file: FileListItem; details: FileDetails | null; remote: Remote; workspace: Props["workspace"]; source: FileSettingsSource; toast: (o: ToastOptions) => void; onChanged: () => void }) {
  const [libs, setLibs] = useState<{ key: FileKey; name: string }[] | null>(null);
  const [info, setInfo] = useState<SharedFileInfo | null>(null);
  const shared = remote.state === "ok";
  useEffect(() => {
    let live = true;
    if (source.libraries)
      void source.libraries.listAvailable(file.fileKey).then(
        async (records) => {
          const named = await Promise.all(records.filter((r) => r.libraryFileKey !== file.fileKey && r.status === "published").map(async (r) => ({ key: r.libraryFileKey, name: await workspace.getFile(r.libraryFileKey).then((f) => f.name, () => r.libraryFileKey) })));
          if (live) setLibs(named);
        },
        () => live && setLibs([]),
      );
    if (shared) void source.info?.(file.fileKey).then((i) => live && setInfo(i), () => {});
    return () => {
      live = false;
    };
  }, [file.fileKey, source, workspace, shared]);
  const fail = (e: unknown) => toast({ kind: "error", message: t("Couldn’t change the setting: {error}", { error: e instanceof Error ? e.message : String(e) }) });
  const enabled = new Set(file.enabledLibraries);
  const offline = !file.cloud && !file.space ? t("Always — the file is only on this computer") : details?.documentHere ? t("Downloaded — opens offline") : t("Not downloaded — opens when you’re online");
  const canManage = info?.access?.canManage ?? info?.role === "owner";
  return (
    <>
      <Section title={t("General")}>
        <div className={styles.setting}>
          <span className={styles.settingText}>{t("Starred")}</span>
          <Switch label={t("Starred")} checked={file.starred} onChange={(on) => void workspace.setStarred({ fileKey: file.fileKey }, on).then(onChanged, fail)} />
        </div>
        <dl className={styles.grid}>
          <Row label={t("Available offline")}>{offline}</Row>
          <Row label={t("Thumbnail")}>{file.thumbnail ? t("{w} × {h}", { w: file.thumbnail.width, h: file.thumbnail.height }) : t("None yet — made when the file is next opened")}</Row>
          <Row label={t("Library")}>{file.library.status === "published" ? t("Published (version {n})", { n: file.library.latestVersion ?? 1 }) : file.library.status === "unpublished" ? t("Unpublished") : t("Not published")}</Row>
        </dl>
      </Section>
      {info && (
        <Section title={t("Sharing")}>
          <div className={styles.setting}>
            <span className={styles.settingText}>{t("Viewers can copy, save, and export from this file")}</span>
            <Switch label={t("Viewers can copy, save, and export from this file")} checked={info.viewersCanCopy} disabled={!canManage || !source.setViewersCanCopy} onChange={(on) => void source.setViewersCanCopy?.(file.fileKey, on).then((i) => (setInfo(i), onChanged()), fail)} />
          </div>
        </Section>
      )}
      {source.libraries && (
        <Section title={t("Libraries in this file")} hint={t("Components, styles and variables from these libraries can be used here.")}>
          {libs === null ? (
            <Spinner size={16} />
          ) : !libs.length ? (
            <p className={styles.hint}>{t("No libraries are published yet.")}</p>
          ) : (
            libs.map((l) => (
              <div key={l.key} className={styles.setting} data-library={l.key}>
                <span className={styles.settingText}>{l.name}</span>
                <Switch label={l.name} checked={enabled.has(l.key)} onChange={(on) => void source.libraries!.setEnabled(file.fileKey, l.key, on).then(onChanged, fail)} />
              </div>
            ))
          )}
        </Section>
      )}
    </>
  );
}
