/**
 * Share › people (docs/multiplayer.md §3, Figma's share dialog): invite by email as "can edit" or "can view", who has
 * access, and who is in the file now. The first invite shares the file: the editor's snapshot of it goes to the room
 * at the journal seq it stands at, and the store keeps the file in step with the room from then on.
 */
import { useEffect, useState } from "react";
import { Avatar, Banner, Button, Select, TextInput, showToast } from "@/ds";
import { getStoreClient } from "@/store";
import type { FileMember, FileShareState, LinkAccess, SharedFileInfo } from "@shared/multiplayer/types";
import { useAccount } from "../files/account";
import type { EditorController } from "./controller";
import styles from "./ShareDialog.module.css";

const ROLES = [
  { value: "editor", label: "can edit" },
  { value: "viewer", label: "can view" },
];

const LINK = [
  { value: "none", label: "Only people invited" },
  { value: "viewer", label: "Anyone with the link can view" },
  { value: "editor", label: "Anyone with the link can edit" },
];

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

interface SharingSource {
  fileKey: string;
  knownHeadSeq: number;
  flush(): Promise<void>;
}

const sharingSource = (ed: EditorController): SharingSource | null => {
  const s = ed.source as unknown as Partial<SharingSource>;
  return typeof s.fileKey === "string" && typeof s.knownHeadSeq === "number" && typeof s.flush === "function" ? (s as SharingSource) : null;
};

export function SharePeople({ ed }: { ed: EditorController }) {
  const account = useAccount();
  const source = sharingSource(ed);
  const store = getStoreClient();
  const [state, setState] = useState<FileShareState | null>(null);
  const [members, setMembers] = useState<FileMember[]>([]);
  const [emails, setEmails] = useState("");
  const [role, setRole] = useState<"editor" | "viewer">("editor");
  const [busy, setBusy] = useState(false);
  const [info, setInfo] = useState<SharedFileInfo | null>(null);
  const fileKey = source?.fileKey ?? null;
  const signedIn = !!account.state?.user;

  useEffect(() => {
    if (!fileKey) return;
    let live = true;
    const load = async () => {
      const s = await store.multiplayer.fileState(fileKey);
      if (!live) return;
      setState(s);
      if (s.shared && signedIn) {
        setMembers(await store.multiplayer.members(fileKey).catch(() => []));
        if (live) setInfo(await store.multiplayer.fileInfo(fileKey).catch(() => null));
      }
    };
    void load().catch(() => {});
    const off = store.multiplayer.watch((e) => e.fileKey === fileKey && setState(e.state));
    return () => {
      live = false;
      off();
    };
  }, [store, fileKey, signedIn]);

  if (!source || !fileKey) return null;
  const owner = state?.role === "owner" || !state?.shared;

  const invite = async () => {
    const list = emails
      .split(/[,\s]+/)
      .map((e) => e.trim())
      .filter(Boolean);
    if (!list.length) return;
    setBusy(true);
    try {
      let s = state;
      if (!s?.shared) {
        // The snapshot and the seq it stands at, read in one task after everything was handed to the store.
        await source.flush();
        const snapshot = ed.engine.encodeDocumentKiwi();
        s = await store.multiplayer.share(fileKey, { snapshot, headSeq: source.knownHeadSeq });
        setState(s);
      }
      let m = members;
      for (const email of list) m = await store.multiplayer.invite(fileKey, email, role);
      setMembers(m);
      setInfo(await store.multiplayer.fileInfo(fileKey).catch(() => null));
      setEmails("");
      showToast({ message: list.length === 1 ? `Invited ${list[0]}` : `Invited ${list.length} people` });
    } catch (e) {
      showToast({ kind: "error", message: `Couldn't invite: ${message(e)}` });
    } finally {
      setBusy(false);
    }
  };

  const changeRole = async (m: FileMember, value: string) => {
    try {
      setMembers(value === "remove" ? await store.multiplayer.removeMember(fileKey, m.email) : await store.multiplayer.invite(fileKey, m.email, value === "viewer" ? "viewer" : "editor"));
    } catch (e) {
      showToast({ kind: "error", message: message(e) });
    }
  };

  const setLink = async (access: LinkAccess) => {
    try {
      setInfo(await store.multiplayer.setLinkAccess(fileKey, access));
    } catch (e) {
      showToast({ kind: "error", message: message(e) });
    }
  };

  const copyLink = () => {
    if (!info) return;
    void navigator.clipboard?.writeText(info.link).then(
      () => showToast({ message: info.linkAccess === "none" ? "Link copied. Only people invited can open it." : "Link copied" }),
      () => showToast({ kind: "error", message: "Couldn't copy the link" }),
    );
  };

  if (!account.available) return null;
  if (!signedIn)
    return (
      <div className={styles.section}>
        <Banner tone="default">Log in to invite people to edit this file with you.</Banner>
        <div>
          <Button variant="secondary" onClick={() => void account.run("log-in")} data-share="log-in">
            Log in with Google…
          </Button>
        </div>
      </div>
    );

  const here = state?.peers ?? [];
  return (
    <div className={styles.section} data-share-people="">
      {owner && (
        <div className={styles.invite}>
          <TextInput label="Emails" placeholder="Add comma separated emails to invite" value={emails} onChange={setEmails} onCommit={setEmails} data-share="emails" />
          <Select label="Role" value={role} options={ROLES} onChange={(v) => setRole(v === "viewer" ? "viewer" : "editor")} width="hug" />
          <Button variant="primary" loading={busy} disabled={busy || !emails.trim()} onClick={() => void invite()} data-share="invite">
            Invite
          </Button>
        </div>
      )}
      {state?.shared && (
        <>
          <span className={styles.heading}>Who has access</span>
          <ul className={styles.people}>
            {members.map((m) => {
              const me = m.email === account.state?.user?.email;
              const online = here.some((p) => p.userId === m.userId);
              return (
                <li key={m.email} className={styles.person} data-member={m.email}>
                  <Avatar name={m.name || m.email} />
                  <span className={styles.who}>
                    <span>
                      {m.name || m.email}
                      {me ? " (you)" : ""}
                      {online && !me ? <span className={styles.online}> · in this file</span> : null}
                    </span>
                    {m.name && <span className={styles.email}>{m.pending ? `${m.email} · invited` : m.email}</span>}
                    {!m.name && m.pending && <span className={styles.email}>invited</span>}
                  </span>
                  {m.role === "owner" || state.role !== "owner" ? (
                    <span className={styles.role}>{m.role === "owner" ? "owner" : m.role === "editor" ? "can edit" : "can view"}</span>
                  ) : (
                    <Select label={`${m.email} role`} value={m.role} options={[...ROLES, "-", { value: "remove", label: "Remove" }]} onChange={(v) => void changeRole(m, v)} variant="ghost" width="hug" />
                  )}
                </li>
              );
            })}
          </ul>
          {info && (
            <div className={styles.invite} data-share-link={info.linkAccess}>
              {state.role === "owner" ? <Select label="Link access" value={info.linkAccess} options={LINK} onChange={(v) => void setLink(v as LinkAccess)} /> : <span className={styles.role}>{LINK.find((l) => l.value === info.linkAccess)?.label}</span>}
              <Button variant="secondary" onClick={copyLink} data-share="copy-link">
                Copy link
              </Button>
            </div>
          )}
          <p className={styles.note} data-share-connection={state.connection}>
            {state.connection === "live" ? (here.length ? `Live · ${here.length + 1} people in this file` : "Live · changes are shared as you make them") : state.connection === "connecting" ? "Connecting…" : "Offline · your changes are kept and sent when you’re back online"}
          </p>
        </>
      )}
    </div>
  );
}
