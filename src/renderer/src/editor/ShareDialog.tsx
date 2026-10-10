/**
 * Share (the right panel's Share button, File ▸ Share…): Figma UI3's share modal, as captured from live Figma
 * (docs/research/figma/live/multiplayer/README.md "Share dialog", R13-multiplayer-sharing.md §2). Two cards at the top
 * centre of the window:
 *
 * - "Share this file" · Copy link · ✕ — the invite field ("Add comma separated emails to invite": emails become chips, a
 *   role select appears inside the field, default "can view"), Invite; "Who has access": the link row ("Anyone" / "People
 *   invited to file" — opens Share settings), the owner "(you)", members with their role menus (can edit, can view,
 *   Remove); "Ask to edit" requests with Approve / Deny.
 * - Developer preview (docs/data.md §13): its own view, as before.
 *
 * The first invite (or Copy link) shares the file: the editor's snapshot of it goes to the room at the journal seq it
 * stands at; the store keeps it in step with the room from then on (docs/multiplayer.md §5).
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Avatar, Button, Checkbox, Icon, IconButton, RadioGroup, Select, Spinner, showToast } from "@/ds";
import { Portal } from "@/ds/overlay/Portal";
import { useFocusScope } from "@/ds/overlay/FocusTrap";
import { useCurrentPage } from "@/engine/hooks";
import { getStoreClient } from "@/store";
import type { AccessRequest, FileMember, FileShareState, LinkAccess, SharedFileInfo } from "@shared/multiplayer/types";
import type { PreviewRecord } from "../../../shared/store/types";
import { useAccount } from "../files/account";
import { useEditor, type EditorController } from "./controller";
import { useUI } from "./hooks";
import { shareAccess, type SharePreviewOptions } from "./previews";
import styles from "./ShareDialog.module.css";

export function ShareDialog() {
  const open = useUI((s) => s.shareOpen);
  return open ? <Share /> : null;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const EMAIL = /^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/;
const ROLES = [
  { value: "editor", label: "can edit" },
  { value: "viewer", label: "can view" },
];

interface SharingSource {
  fileKey: string;
  knownHeadSeq: number;
  flush(): Promise<void>;
}

const sharingSource = (ed: EditorController): SharingSource | null => {
  const s = ed.source as unknown as Partial<SharingSource>;
  return typeof s.fileKey === "string" && typeof s.knownHeadSeq === "number" && typeof s.flush === "function" ? (s as SharingSource) : null;
};

type View = "main" | "settings" | "preview";

function Share() {
  const ed = useEditor();
  const [view, setView] = useState<View>("main");
  const modal = useRef<HTMLDivElement>(null);
  useFocusScope(modal, { trap: true });
  const close = () => {
    ed.ui.set({ shareOpen: false });
    ed.focusCanvas();
  };
  const people = usePeople(ed);
  return (
    <Portal>
      <div className={styles.layer} onPointerDown={(e) => e.target === e.currentTarget && close()} data-share-dialog="">
        <div
          ref={modal}
          className={styles.modal}
          role="dialog"
          aria-modal="true"
          aria-label="Share this file"
          tabIndex={-1}
          onKeyDown={(e) => {
            if (e.key !== "Escape" || (e.target as Element).closest("[role=listbox],[role=menu]")) return;
            e.stopPropagation();
            if (view === "main") close();
            else setView("main");
          }}
        >
          {view === "main" && (
            <>
              <section className={styles.card}>
                <header className={styles.head}>
                  <span className={styles.title}>Share this file</span>
                  <span className={styles.grow} />
                  {people.canShare && (
                    <button type="button" className={styles.link} onClick={() => void people.copyLink()} data-share="copy-link">
                      Copy link
                    </button>
                  )}
                  <IconButton icon="24.close.small" label="Close" tooltip={false} onClick={close} />
                </header>
                <PeopleBody p={people} onSettings={() => setView("settings")} />
              </section>
              <section className={`${styles.card} ${styles.rows}`}>
                <button type="button" className={styles.row} onClick={() => setView("preview")} data-share="preview">
                  <Icon name="24.text.code" />
                  <span>Developer preview</span>
                </button>
              </section>
            </>
          )}
          {view === "settings" && (
            <section className={styles.card}>
              <header className={styles.head}>
                <IconButton icon="24.arrow.left" label="Back" tooltip={false} onClick={() => setView("main")} />
                <span className={styles.title}>Share settings</span>
              </header>
              <ShareSettings p={people} />
            </section>
          )}
          {view === "preview" && (
            <section className={styles.card}>
              <header className={styles.head}>
                <IconButton icon="24.arrow.left" label="Back" tooltip={false} onClick={() => setView("main")} />
                <span className={styles.title}>Developer preview</span>
              </header>
              <PreviewView />
            </section>
          )}
        </div>
      </div>
    </Portal>
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// People: the state behind the main view and Share settings
// ---------------------------------------------------------------------------------------------------------------------

function usePeople(ed: EditorController) {
  const account = useAccount();
  const source = sharingSource(ed);
  const store = getStoreClient();
  const fileKey = source?.fileKey ?? null;
  const signedIn = !!account.state?.user;
  const [state, setState] = useState<FileShareState | null>(null);
  const [members, setMembers] = useState<FileMember[]>([]);
  const [info, setInfo] = useState<SharedFileInfo | null>(null);
  const [requests, setRequests] = useState<AccessRequest[]>([]);

  const refresh = async (s?: FileShareState) => {
    if (!fileKey) return;
    const st = s ?? (await store.multiplayer.fileState(fileKey));
    setState(st);
    if (!st.shared || !signedIn) return;
    const [m, i] = await Promise.all([store.multiplayer.members(fileKey).catch(() => [] as FileMember[]), store.multiplayer.fileInfo(fileKey).catch(() => null)]);
    setMembers(m);
    setInfo(i);
    if (st.role !== "viewer") setRequests(await store.multiplayer.requests(fileKey).catch(() => []));
  };

  useEffect(() => {
    if (!fileKey) return;
    let live = true;
    void Promise.resolve()
      .then(() => refresh())
      .catch(() => {});
    const off = store.multiplayer.watch((e) => {
      if (e.fileKey !== fileKey || !live) return;
      setState(e.state);
      if (e.notice?.kind === "access-request") void store.multiplayer.requests(fileKey).then((r) => live && setRequests(r), () => {});
    });
    return () => {
      live = false;
      off();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refresh reads the latest values; re-run on file / sign-in only
  }, [store, fileKey, signedIn]);

  /** Shares the file first if it isn't: the snapshot and its seq, read in one task after everything reached the store. */
  const ensureShared = async (): Promise<FileShareState> => {
    if (!fileKey || !source) throw new Error("This file isn't in your workspace");
    if (state?.shared) return state;
    await source.flush();
    const snapshot = ed.engine.encodeDocumentKiwi();
    const s = await store.multiplayer.share(fileKey, { snapshot, headSeq: source.knownHeadSeq });
    await refresh(s);
    return s;
  };

  const role = state?.shared ? state.role : "owner";
  return {
    account,
    signedIn,
    fileKey,
    state,
    members,
    info,
    requests,
    role,
    /** Owner or editor (Figma: anyone who can edit can share) */
    canShare: !!fileKey && signedIn && role !== "viewer",
    meEmail: account.state?.user?.email ?? null,
    async invite(emails: string[], as: "editor" | "viewer") {
      await ensureShared();
      let m = members;
      for (const email of emails) m = await store.multiplayer.invite(fileKey!, email, as);
      setMembers(m);
      setInfo(await store.multiplayer.fileInfo(fileKey!).catch(() => null));
    },
    async setRole(m: FileMember, value: string) {
      try {
        setMembers(value === "remove" ? await store.multiplayer.removeMember(fileKey!, m.email) : await store.multiplayer.invite(fileKey!, m.email, value === "viewer" ? "viewer" : "editor"));
      } catch (e) {
        showToast({ kind: "error", message: message(e) });
      }
    },
    async setLink(access: LinkAccess) {
      try {
        await ensureShared();
        setInfo(await store.multiplayer.setLinkAccess(fileKey!, access));
      } catch (e) {
        showToast({ kind: "error", message: message(e) });
      }
    },
    async setViewersCanCopy(on: boolean) {
      try {
        setInfo(await store.multiplayer.setViewersCanCopy(fileKey!, on));
      } catch (e) {
        showToast({ kind: "error", message: message(e) });
      }
    },
    async answer(r: AccessRequest, approve: boolean) {
      try {
        setRequests(await store.multiplayer.answerRequest(fileKey!, r.userId, approve));
        setMembers(await store.multiplayer.members(fileKey!).catch(() => members));
      } catch (e) {
        showToast({ kind: "error", message: message(e) });
      }
    },
    async copyLink() {
      try {
        await ensureShared();
        const i = info ?? (await store.multiplayer.fileInfo(fileKey!));
        setInfo(i);
        await navigator.clipboard?.writeText(i.link);
        showToast({ message: "Link copied to clipboard" });
      } catch (e) {
        showToast({ kind: "error", message: `Couldn’t copy the link: ${message(e)}` });
      }
    },
  };
}

type People = ReturnType<typeof usePeople>;

function PeopleBody({ p, onSettings }: { p: People; onSettings: () => void }) {
  if (!p.fileKey) return <p className={styles.note}>Sharing needs a file in your workspace.</p>;
  if (!p.account.available) return <p className={styles.note}>Sharing needs the desktop app or a signed-in browser.</p>;
  if (!p.signedIn)
    return (
      <div className={styles.body}>
        <p className={styles.note}>Log in to invite people to this file and work on it together.</p>
        <div>
          <Button variant="primary" onClick={() => void p.account.run("log-in")} data-share="log-in">
            Log in with Google…
          </Button>
        </div>
      </div>
    );
  return (
    <div className={styles.body}>
      {p.canShare && <InviteBar p={p} />}
      <span className={styles.heading}>Who has access</span>
      <ul className={styles.people}>
        <LinkRow p={p} onClick={onSettings} />
        {(p.members.length ? p.members : [{ email: p.meEmail ?? "", userId: null, name: p.account.state?.user?.name ?? null, role: "owner" as const, pending: false }]).map((m) => (
          <MemberRow key={m.email} p={p} m={m} />
        ))}
      </ul>
      {p.requests.length > 0 && (
        <>
          <span className={styles.heading}>Requests</span>
          <ul className={styles.people}>
            {p.requests.map((r) => (
              <li key={r.userId} className={styles.person} data-request={r.email}>
                <Avatar name={r.name || r.email} />
                <span className={styles.who}>
                  <span className={styles.name}>{r.name || r.email}</span>
                  <span className={styles.secondary}> wants to edit</span>
                </span>
                <Button variant="secondary" onClick={() => void p.answer(r, false)}>
                  Deny
                </Button>
                <Button variant="primary" onClick={() => void p.answer(r, true)}>
                  Approve
                </Button>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

/** The invite field: emails turn into chips on a comma, space or Enter; a role select inside once there is one. */
function InviteBar({ p }: { p: People }) {
  const [chips, setChips] = useState<string[]>([]);
  const [text, setText] = useState("");
  const [role, setRole] = useState<"editor" | "viewer">("viewer");
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const take = (raw: string) => {
    const parts = raw.split(/[,\s]+/).filter(Boolean);
    const done = parts.filter((e) => EMAIL.test(e));
    if (done.length) setChips((c) => [...c, ...done.filter((e) => !c.includes(e))]);
    return parts.filter((e) => !EMAIL.test(e)).join(" ");
  };
  const pending = [...chips, ...text.split(/[,\s]+/).filter((e) => EMAIL.test(e))];
  const invite = async () => {
    if (!pending.length) return;
    setBusy(true);
    try {
      await p.invite(pending, role);
      showToast({ message: pending.length === 1 ? `Invited ${pending[0]}` : `Invited ${pending.length} people` });
      setChips([]);
      setText("");
    } catch (e) {
      showToast({ kind: "error", message: `Couldn’t invite: ${message(e)}` });
    } finally {
      setBusy(false);
    }
  };
  const active = chips.length > 0 || text.trim().length > 0;
  return (
    <div className={styles.inviteBar}>
      <div className={styles.field} onPointerDown={(e) => e.target === e.currentTarget && input.current?.focus()}>
        {chips.map((c) => (
          <span key={c} className={styles.chip} aria-label={`Remove ${c}`}>
            <span>{c}</span>
            <button type="button" aria-label="Remove" onClick={() => setChips((x) => x.filter((y) => y !== c))}>
              <Icon name="16.close" />
            </button>
          </span>
        ))}
        <input
          ref={input}
          className={styles.input}
          placeholder={chips.length ? "" : "Add comma separated emails to invite"}
          aria-label="Add comma separated emails to invite"
          value={text}
          data-share="emails"
          onChange={(e) => setText(/[,\s]$/.test(e.target.value) ? take(e.target.value) : e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              if (text.trim()) setText(take(text));
              else void invite();
            } else if (e.key === "Backspace" && !text && chips.length) setChips((c) => c.slice(0, -1));
          }}
          onBlur={() => text.trim() && setText(take(text))}
        />
        {active && <Select label="Permission Level" value={role} options={ROLES} onChange={(v) => setRole(v === "editor" ? "editor" : "viewer")} variant="outlined" width="hug" className={styles.roleSelect} />}
      </div>
      <Button variant="primary" size="large" className={styles.invite} loading={busy} disabled={busy || !pending.length} onClick={() => void invite()} data-share="invite">
        Invite
      </Button>
    </div>
  );
}

function LinkRow({ p, onClick }: { p: People; onClick: () => void }) {
  const access = p.info?.linkAccess ?? "none";
  const label = access === "none" ? "People invited to file" : "Anyone";
  const right = access === "editor" ? "can edit" : access === "viewer" ? "can view" : null;
  const editable = p.canShare;
  const content: ReactNode = (
    <>
      <span className={styles.glyph}>
        <Icon name={access === "none" ? "24.lock.small" : "24.globe"} />
      </span>
      <span className={styles.who}>
        <span className={styles.name}>{label}</span>
      </span>
      {right && <span className={styles.role}>{right}</span>}
      {editable && <Icon name="16.chevron.down" className={styles.chevron} />}
    </>
  );
  return (
    <li className={styles.person} data-share-link={access}>
      {editable ? (
        <button type="button" className={styles.personButton} onClick={onClick}>
          {content}
        </button>
      ) : (
        content
      )}
    </li>
  );
}

function MemberRow({ p, m }: { p: People; m: FileMember }) {
  const me = m.email === p.meEmail;
  const online = p.state?.peers.some((x) => x.userId === m.userId) ?? false;
  const roleText = m.role === "owner" ? "owner" : m.role === "editor" ? "can edit" : "can view";
  return (
    <li className={styles.person} data-member={m.email}>
      <Avatar name={m.name || m.email} />
      <span className={styles.who}>
        <span className={styles.name}>{m.name || m.email}</span>
        {me && <span className={styles.secondary}> (you)</span>}
        {m.pending && <span className={styles.secondary}> · invited</span>}
        {online && !me && <span className={styles.online}> · in this file</span>}
      </span>
      {m.role === "owner" || !p.canShare || me ? (
        <span className={styles.role}>{roleText}</span>
      ) : (
        <Select label={`${m.email} role`} value={m.role} options={[...ROLES, "-", { value: "remove", label: "Remove" }]} onChange={(v) => void p.setRole(m, v)} variant="ghost" width="hug" />
      )}
    </li>
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// Share settings (the link row): who can access, what they can do, Advanced
// ---------------------------------------------------------------------------------------------------------------------

function ShareSettings({ p }: { p: People }) {
  const access = p.info?.linkAccess ?? "none";
  const anyone = access !== "none";
  return (
    <div className={styles.body} data-share-settings="">
      <span className={styles.section}>Who can access</span>
      <Select
        label="Audience"
        value={anyone ? "anyone" : "invited"}
        options={[
          { value: "invited", label: "People invited to file" },
          { value: "anyone", label: "Anyone" },
        ]}
        prefix={anyone ? "24.globe" : "24.lock.small"}
        variant="outlined"
        size="large"
        onChange={(v) => void p.setLink(v === "anyone" ? (access === "editor" ? "editor" : "viewer") : "none")}
        disabled={!p.canShare}
      />
      <p className={styles.caption}>{anyone ? "Anyone with the link who is logged in will be able to access this file." : "Only people invited to this file can access it."}</p>
      {anyone && (
        <>
          <span className={styles.heading}>What can they do</span>
          <RadioGroup
            label="What can they do"
            value={access}
            options={[
              { value: "viewer", label: "View" },
              { value: "editor", label: "Edit" },
            ]}
            onChange={(v) => void p.setLink(v === "editor" ? "editor" : "viewer")}
            disabled={!p.canShare}
          />
          <p className={styles.caption}>{access === "editor" ? "Can view, comment and edit this file." : "Can view and comment on this file."}</p>
        </>
      )}
      <hr className={styles.divider} />
      <span className={styles.section}>Advanced</span>
      <Checkbox label="Viewers can copy, save, and export from this file" checked={p.info?.viewersCanCopy ?? true} onChange={(on) => void p.setViewersCanCopy(on === true)} disabled={!p.canShare || !p.info} />
      <p className={`${styles.caption} ${styles.indent}`}>
        This setting applies to anyone in the file with <strong>can view</strong> access
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// Developer preview (docs/data.md §13), unchanged in what it does
// ---------------------------------------------------------------------------------------------------------------------

const EXPIRY = [
  { value: "never", label: "Never" },
  { value: "7", label: "In 7 days" },
  { value: "30", label: "In 30 days" },
];

function PreviewView() {
  const ed = useEditor();
  const page = useCurrentPage(ed.store);
  const pages = ed.engine.pages();
  const [access] = useState(() => shareAccess(ed));
  const [status, setStatus] = useState<{ publish: boolean; reason: string | null } | null>(null);
  const [record, setRecord] = useState<PreviewRecord | null>(null);
  const [which, setWhich] = useState<"all" | "page">("all");
  const [inspect, setInspect] = useState(true);
  const [allowExport, setAllowExport] = useState(true);
  const [expiry, setExpiry] = useState("never");
  const [busy, setBusy] = useState<null | "publish" | "export" | "stop">(null);

  useEffect(() => {
    let live = true;
    void Promise.all([access.status(), access.current()]).then(
      ([s, r]) => {
        if (!live) return;
        setStatus(s);
        setRecord(r);
        if (r) {
          setInspect(r.options.inspect);
          setAllowExport(r.options.export);
          setExpiry(r.options.expiresInDays === null ? "never" : String(r.options.expiresInDays));
          setWhich(r.options.pageIds === "all" ? "all" : "page");
        }
      },
      () => live && setStatus({ publish: false, reason: "The store couldn't be reached" }),
    );
    return () => {
      live = false;
    };
  }, [access]);

  const options = (): SharePreviewOptions => ({ pageIds: which === "all" ? "all" : [page], inspect, export: allowExport, expiresInDays: expiry === "7" ? 7 : expiry === "30" ? 30 : null });
  const copy = (url: string) => void navigator.clipboard?.writeText(url).then(() => showToast({ message: "Link copied to clipboard" }), () => showToast({ message: "Couldn't copy the link" }));
  const run = async (kind: "publish" | "export" | "stop") => {
    setBusy(kind);
    try {
      if (kind === "publish") {
        const r = await access.publish(options());
        setRecord(r);
        copy(r.url);
      } else if (kind === "stop" && record) {
        await access.stop(record.previewId);
        setRecord(null);
        showToast({ message: "Preview unpublished" });
      } else if (kind === "export" && access.exportHtml) {
        const r = await access.exportHtml(options());
        if (!("cancelled" in r)) showToast({ message: `Preview exported (${(r.bytes / 1_000_000).toFixed(1)} MB)` });
      }
    } catch (e) {
      showToast({ message: `Couldn't ${kind === "export" ? "export" : kind === "stop" ? "unpublish" : "publish"} the preview: ${message(e)}` });
    } finally {
      setBusy(null);
    }
  };
  const currentName = pages.find((x) => x.guid === page)?.name ?? "This page";
  const canPublish = !!status?.publish;
  return (
    <div className={styles.body}>
      <p className={styles.caption}>Developers see the file as it looks now, with Inspect for each layer&apos;s properties and code. They can&apos;t edit it or see your other files.</p>
      <div className={styles.field2}>
        <span className={styles.secondary}>Pages</span>
        <Select
          label="Pages"
          value={which}
          options={[
            { value: "all", label: pages.length === 1 ? "All pages" : `All pages (${pages.length})` },
            { value: "page", label: `Only “${currentName}”` },
          ]}
          onChange={(v) => setWhich(v as "all" | "page")}
        />
      </div>
      <Checkbox label="Inspect" checked={inspect} onChange={setInspect} />
      <Checkbox label="Allow exporting assets" checked={allowExport} onChange={setAllowExport} />
      <div className={styles.field2}>
        <span className={styles.secondary}>Link expires</span>
        <Select label="Link expires" value={expiry} options={EXPIRY} onChange={setExpiry} disabled={!canPublish} />
      </div>
      {!status ? <Spinner size={16} /> : !record && !canPublish ? <p className={styles.caption}>{`${status.reason ?? "Publishing links isn't available"}. ${access.exportHtml ? "Export the preview as an HTML file to send it instead." : "Exporting it as an HTML file needs the desktop app."}`}</p> : null}
      {record && (
        <div className={styles.previewLink}>
          <span className={styles.previewUrl} title={record.url} data-share="preview-url">
            {record.url}
          </span>
          <button type="button" className={styles.link} onClick={() => copy(record.url)} data-share="copy-preview-link">
            Copy link
          </button>
        </div>
      )}
      <div className={styles.actions}>
        {access.exportHtml && (
          <Button variant="secondary" loading={busy === "export"} disabled={!!busy} onClick={() => void run("export")} data-share="export">
            Export as HTML…
          </Button>
        )}
        {record && (
          <Button variant="destructive-secondary" loading={busy === "stop"} disabled={!!busy || !canPublish} onClick={() => void run("stop")} data-share="unpublish">
            Unpublish
          </Button>
        )}
        <Button variant="primary" loading={busy === "publish"} disabled={!!busy || !canPublish} onClick={() => void run("publish")} data-share="publish">
          {record ? "Update preview" : "Publish preview"}
        </Button>
      </div>
      {busy && busy !== "stop" && <p className={styles.caption}>Preparing the preview… every page is laid out with its fonts first.</p>}
    </div>
  );
}
