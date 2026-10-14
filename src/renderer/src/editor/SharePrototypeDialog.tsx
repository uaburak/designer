/**
 * Share prototype (docs/editor.md D-6; help.figma.com 360040531773): the share modal for a file's prototype, from the
 * presentation view's **Share prototype** and Share's More. Figma's layout in the Share modal's card: "Share prototype"
 * · Copy link · ✕; the invite field (emails → prototype-only members, `devMode.invitePrototype`), Invite; "Who has
 * access": the prototype's link — **Anyone with the link** (`protoLinkAccess`), **Anyone at ‹org›**
 * (`protoOrgLinkAccess`, org files) or **Only invited people** —, the people invited to the prototype with Remove;
 * Advanced: "Allow viewers to copy, share, and export" (the file's own setting, as Figma's modal shows it). Viewers by
 * these grants see the presentation view only. The org's policy holds: public links off → no "Anyone with the link".
 *
 * Standalone (a `fileKey`, the store): the presentation view's tab has no editor.
 */
import { t, useT } from "@/i18n";
import { useEffect, useRef, useState } from "react";
import { Avatar, Button, Checkbox, Icon, IconButton, Select, showToast } from "@/ds";
import { Portal } from "@/ds/overlay/Portal";
import { useFocusScope } from "@/ds/overlay/FocusTrap";
import { getStoreClient } from "@/store";
import { linkWith, type SharedFileInfo } from "@shared/multiplayer/types";
import styles from "./ShareDialog.module.css";

const EMAIL = /^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/;
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export type PrototypeAudience = "anyone" | "org" | "invited";

/** The prototype link's audience from the file's settings */
export function prototypeAudience(info: Pick<SharedFileInfo, "protoLinkAccess" | "protoOrgLinkAccess"> | null): PrototypeAudience {
  if (info?.protoLinkAccess === "viewer") return "anyone";
  if (info?.protoOrgLinkAccess === "viewer") return "org";
  return "invited";
}

/** The patch that sets an audience (one PATCH; the org's policy checks it) */
export function audiencePatch(a: PrototypeAudience, inOrg: boolean): { protoLinkAccess: "none" | "viewer"; protoOrgLinkAccess?: "none" | "viewer" } {
  return { protoLinkAccess: a === "anyone" ? "viewer" : "none", ...(inOrg ? { protoOrgLinkAccess: a === "org" ? "viewer" : "none" } : {}) };
}

export interface SharePrototypeDialogProps {
  /** The file (the store's key: a shared file's local copy, or its room key) */
  fileKey: string;
  /** The frame the link starts at */
  nodeId?: string | null;
  onClose: () => void;
}

interface Member {
  email: string;
  userId: string | null;
  name: string | null;
  picture?: string | null;
}

export function SharePrototypeDialog({ fileKey, nodeId, onClose }: SharePrototypeDialogProps) {
  useT();
  const store = getStoreClient();
  const modal = useRef<HTMLDivElement>(null);
  useFocusScope(modal, { trap: true });
  const [info, setInfo] = useState<SharedFileInfo | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [shared, setShared] = useState<boolean | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    let live = true;
    void (async () => {
      const st = await store.multiplayer.fileState(fileKey).catch(() => null);
      if (!live) return;
      setShared(!!st?.shared);
      if (!st?.shared) return;
      const [i, m] = await Promise.all([store.multiplayer.fileInfo(fileKey).catch(() => null), store.devMode.prototypeMembers(fileKey).catch(() => [] as Member[])]);
      if (!live) return;
      setInfo(i);
      setMembers(m);
    })();
    return () => {
      live = false;
    };
  }, [store, fileKey]);

  const inOrg = !!info?.org;
  const canManage = info?.access ? info.access.canManage : info?.role === "owner";
  const canShare = info?.access ? info.access.canShare : info?.role === "owner" || info?.role === "editor";
  const publicOff = info?.policy ? !info.policy.publicLinks : false;
  const audience = prototypeAudience(info);
  const setAudience = async (a: PrototypeAudience) => {
    try {
      setInfo(await store.multiplayer.updateLink(fileKey, audiencePatch(a, inOrg)));
    } catch (e) {
      showToast({ kind: "error", message: message(e) });
    }
  };
  const setCopy = async (on: boolean) => {
    try {
      setInfo(await store.multiplayer.updateLink(fileKey, { viewersCanCopy: on }));
    } catch (e) {
      showToast({ kind: "error", message: message(e) });
    }
  };
  const emails = text.split(/[,\s]+/).filter((e) => EMAIL.test(e));
  const invite = async () => {
    if (!emails.length) return;
    setBusy(true);
    try {
      for (const e of emails) await store.devMode.invitePrototype(fileKey, e);
      setMembers(await store.devMode.prototypeMembers(fileKey));
      setText("");
      showToast({ message: emails.length === 1 ? t("Invited {email}", { email: emails[0] }) : t("Invited {n} people", { n: emails.length }) });
    } catch (e) {
      showToast({ kind: "error", message: t("Couldn’t invite: {error}", { error: message(e) }) });
    } finally {
      setBusy(false);
    }
  };
  const remove = async (email: string) => {
    try {
      await store.devMode.removePrototype(fileKey, email);
      setMembers(await store.devMode.prototypeMembers(fileKey));
    } catch (e) {
      showToast({ kind: "error", message: message(e) });
    }
  };
  const copyLink = async () => {
    if (!info) return;
    try {
      await navigator.clipboard?.writeText(linkWith(info.link, { mode: "proto", ...(nodeId ? { nodeId } : {}) }));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (e) {
      showToast({ kind: "error", message: t("Couldn’t copy the link: {error}", { error: message(e) }) });
    }
  };
  const options = [
    ...(publicOff ? [] : [{ value: "anyone", label: t("Anyone with the link") }]),
    ...(inOrg ? [{ value: "org", label: t("Anyone at {org}", { org: info!.org!.name }) }] : []),
    { value: "invited", label: t("Only invited people") },
  ];
  return (
    <Portal>
      <div className={styles.layer} onPointerDown={(e) => e.target === e.currentTarget && onClose()} data-share-prototype="">
        <div
          ref={modal}
          className={styles.modal}
          role="dialog"
          aria-modal="true"
          aria-label={t("Share prototype")}
          tabIndex={-1}
          onKeyDown={(e) => {
            if (e.key !== "Escape" || (e.target as Element).closest("[role=listbox],[role=menu]")) return;
            e.stopPropagation();
            onClose();
          }}
        >
          <section className={styles.card}>
            <header className={styles.head}>
              <span className={styles.title}>{t("Share prototype")}</span>
              <span className={styles.grow} />
              {info && (
                <button type="button" className={styles.link} onClick={() => void copyLink()} data-share-prototype="copy-link">
                  {copied ? (
                    t("Link copied!")
                  ) : (
                    <>
                      <Icon name="24.link" className={styles.linkIcon} />
                      {t("Copy link")}
                    </>
                  )}
                </button>
              )}
              <IconButton icon="24.close.small" label={t("Close")} tooltip={false} onClick={onClose} />
            </header>
            {shared === false ? (
              <div className={styles.body}>
                <p className={styles.note}>{t("Share this file first: its prototype is shared with the file’s link and people.")}</p>
              </div>
            ) : (
              <div className={styles.body}>
                {canShare && (
                  <div className={styles.inviteBar}>
                    <div className={styles.field}>
                      <input
                        className={styles.input}
                        placeholder={t("Add comma separated emails to invite")}
                        aria-label={t("Add comma separated emails to invite")}
                        value={text}
                        data-share-prototype="emails"
                        onChange={(e) => setText(e.target.value)}
                        onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), void invite())}
                      />
                    </div>
                    <Button variant="primary" size="large" className={styles.invite} loading={busy} disabled={busy || !emails.length} onClick={() => void invite()} data-share-prototype="invite">
                      {t("Invite")}
                    </Button>
                  </div>
                )}
                <span className={styles.heading}>{t("Who has access")}</span>
                <ul className={styles.people}>
                  <li className={styles.person} data-prototype-link={audience}>
                    <span className={styles.glyph}>
                      <Icon name={audience === "invited" ? "24.lock.small" : audience === "org" ? "16.group" : "24.globe"} />
                    </span>
                    {canManage && info ? (
                      <Select label={t("Who can view the prototype")} value={audience} options={options} onChange={(v) => void setAudience(v as PrototypeAudience)} variant="ghost" width="hug" />
                    ) : (
                      <span className={styles.who}>
                        <span className={styles.name}>{audience === "anyone" ? t("Anyone with the link") : audience === "org" ? t("Anyone at {org}", { org: info?.org?.name ?? "" }) : t("Only invited people")}</span>
                      </span>
                    )}
                    <span className={styles.grow} />
                    <span className={styles.role}>{t("can view prototype")}</span>
                  </li>
                  {members.map((m) => (
                    <li key={m.email} className={styles.person} data-prototype-member={m.email}>
                      <Avatar name={m.name || m.email} src={m.picture ?? undefined} />
                      <span className={styles.who}>
                        <span className={styles.name}>{m.name || m.email}</span>
                        {!m.userId && <span className={styles.secondary}> · {t("invited")}</span>}
                      </span>
                      {canShare ? (
                        <Select label={t("{email} access", { email: m.email })} value="viewer" options={[{ value: "viewer", label: t("can view prototype") }, "-", { value: "remove", label: t("Remove") }]} onChange={(v) => v === "remove" && void remove(m.email)} variant="ghost" width="hug" />
                      ) : (
                        <span className={styles.role}>{t("can view prototype")}</span>
                      )}
                    </li>
                  ))}
                </ul>
                <span className={styles.heading}>{t("Advanced")}</span>
                <Checkbox label={t("Allow viewers to copy, share, and export")} checked={info?.viewersCanCopy ?? true} disabled={!canShare || !info} onChange={(on) => void setCopy(on === true)} />
                <p className={styles.note}>{t("People with prototype access see the presentation view only — not the design file, its layers or Dev Mode.")}</p>
              </div>
            )}
          </section>
        </div>
      </div>
    </Portal>
  );
}
