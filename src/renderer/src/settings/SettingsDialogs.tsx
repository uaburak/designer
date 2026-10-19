/**
 * The Settings modal's small dialogs (ds Dialog, 320 / 480): Change name, Change email, Change role,
 * View history, Delete account, Generate new token, and the drafts' libraries. Each takes what it changes and says
 * when it is done; the server's refusals come back as toasts (useProfile.save) or inline.
 */
import { useEffect, useState } from "react";
import { Button, Checkbox, Dialog, RadioGroup, Select, showToast, Switch, TextInput } from "@/ds";
import { ROLES, TOKEN_EXPIRATIONS, TOKEN_SCOPES, type AccessTokenInfo, type TokenScope } from "@shared/account";
import type { LibraryRecord } from "@shared/store/types";
import { getStoreClient } from "@/store";
import { accountCall } from "./bridge";
import { t, tp, useT } from "@/i18n";
import styles from "./Settings.module.css";

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function ChangeNameDialog({ name, onSave, onClose, title = t("Change name"), label = t("Name") }: { name: string; onSave: (name: string) => Promise<unknown>; onClose: () => void; /** Rename team (the local team, §14.16) */ title?: string; label?: string }) {
  useT();
  const [value, setValue] = useState(name);
  const [busy, setBusy] = useState(false);
  const ok = value.trim().length > 0 && value.trim() !== name;
  return (
    <Dialog
      title={title}
      open
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>{t("Cancel")}</Button>
          <Button variant="primary" disabled={!ok} loading={busy} onClick={async () => { setBusy(true); await onSave(value.trim()); setBusy(false); onClose(); }} data-save-name="">
            {t("Save")}
          </Button>
        </>
      }
    >
      <div className={styles.formRow}>
        <span className={styles.formLabel}>{label}</span>
        <TextInput label={label} value={value} onChange={setValue} autoFocus maxLength={100} />
      </div>
    </Dialog>
  );
}

/** Figma: a Google-SSO account's email is "Managed by Google" — it changes in the Google account, not here. */
export function ChangeEmailDialog({ email, provider, onClose }: { email: string; provider: "google" | "dev"; onClose: () => void }) {
  useT();
  return (
    <Dialog title={t("Change email")} open onClose={onClose} footer={<Button variant="primary" onClick={onClose}>{t("Done")}</Button>}>
      <div className={styles.form}>
        <p className={styles.text}>{email}</p>
        <p className={styles.text}>
          {provider === "google"
            ? t("Managed by Google. You log in with your Google account, so your email can only be changed in your Google account. Log in with the other Google account to use another email.")
            : t("This is a development account; its email can't be changed.")}
        </p>
      </div>
    </Dialog>
  );
}

export function ChangeRoleDialog({ role, onSave, onClose }: { role: string | null; onSave: (role: string) => Promise<unknown>; onClose: () => void }) {
  useT();
  const [value, setValue] = useState(role ?? "");
  return (
    <Dialog
      title={t("Change role")}
      open
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>{t("Cancel")}</Button>
          <Button variant="primary" disabled={!value || value === role} onClick={async () => { await onSave(value); onClose(); }} data-save-role="">
            {t("Save")}
          </Button>
        </>
      }
    >
      <div className={styles.form}>
        <span className={styles.formLabel}>{t("What kind of work do you do?")}</span>
        <RadioGroup label={t("Role")} value={value} options={ROLES.map((r) => ({ value: r, label: t(r) }))} onChange={setValue} />
      </div>
    </Dialog>
  );
}

/** help.figma.com 29638316371479: "Off" — your views of files aren't shown to others (and you don't see theirs). */
export function ViewHistoryDialog({ on, onSave, onClose }: { on: boolean; onSave: (on: boolean) => Promise<unknown>; onClose: () => void }) {
  useT();
  const [value, setValue] = useState(on ? "on" : "off");
  return (
    <Dialog
      title={t("View history")}
      open
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>{t("Cancel")}</Button>
          <Button variant="primary" disabled={(value === "on") === on} onClick={async () => { await onSave(value === "on"); onClose(); }} data-save-view-history="">
            {t("Save")}
          </Button>
        </>
      }
    >
      <RadioGroup
        label={t("View history")}
        value={value}
        options={[
          { value: "on", label: t("On — see who viewed your files and let others see your views") },
          { value: "off", label: t("Off — don’t show when you view files, and don’t see others’ views") },
        ]}
        onChange={setValue}
      />
    </Dialog>
  );
}

/** Delete account (help.figma.com 360039826814): permanent; the email typed to confirm. */
export function DeleteAccountDialog({ email, onClose, onDeleted }: { email: string; onClose: () => void; onDeleted: () => void }) {
  useT();
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const ok = typed.trim().toLowerCase() === email.toLowerCase();
  return (
    <Dialog
      title={t("Delete account")}
      open
      onClose={onClose}
      size="medium"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>{t("Cancel")}</Button>
          <Button
            variant="destructive"
            disabled={!ok}
            loading={busy}
            data-confirm-delete-account=""
            onClick={async () => {
              setBusy(true);
              try {
                await accountCall("DELETE", "/me", { confirm: typed.trim() });
                onDeleted();
              } catch (e) {
                showToast({ kind: "error", message: errorText(e) });
                setBusy(false);
              }
            }}
          >
            {t("Delete account")}
          </Button>
        </>
      }
    >
      <div className={styles.form}>
        <p className={styles.text}>{t("Deleting your account is permanent and can’t be undone. You won’t be able to log in with it again.")}</p>
        <p className={styles.text}>{t("Files you shared stop being shared, and you’re removed from files others shared with you. Your comments and developer previews are deleted. The files on this computer stay yours.")}</p>
        <div className={styles.formRow}>
          <span className={styles.formLabel}>{t("Type {email} to confirm", { email })}</span>
          <TextInput label={t("Email")} value={typed} onChange={setTyped} placeholder={email} autoFocus />
        </div>
      </div>
    </Dialog>
  );
}

/**
 * The scopes a personal access token may hold, in `TOKEN_SCOPES`' groups (Figma's scopes page lists them without groups;
 * the groups are ours). Plan-only scopes are hidden: `org:ai_metering_usage_read` is read only with a plan access token
 * (docs/multiplayer.md §16.3, Figma's AI usage API), made in Admin › Settings › Plan access tokens.
 */
export const PLAN_ONLY_SCOPES: ReadonlySet<TokenScope> = new Set<TokenScope>(["org:ai_metering_usage_read"]);
export const PERSONAL_TOKEN_SCOPES = TOKEN_SCOPES.filter((s) => !PLAN_ONLY_SCOPES.has(s.id));
/** Figma's note on the org scopes: "Must be an organization admin." */
const ADMIN_ONLY_SCOPES: ReadonlySet<TokenScope> = new Set<TokenScope>(["org:activity_log_read"]);

/** "Generate new token": a name, an expiration, scopes → the token, shown once. */
export function GenerateTokenDialog({ onClose, onMade }: { onClose: () => void; onMade: (info: AccessTokenInfo) => void }) {
  useT();
  const [name, setName] = useState("");
  // Figma's default: 1 day (atlas 21 §6.3, `nQ=[1,7,30,90]`).
  const [days, setDays] = useState("1");
  const [scopes, setScopes] = useState<Set<TokenScope>>(new Set(["file_content:read"]));
  const [token, setToken] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const toggle = (s: TokenScope, on: boolean) => setScopes((was) => { const next = new Set(was); if (on) next.add(s); else next.delete(s); return next; });
  if (token)
    return (
      <Dialog
        title={t("Personal access token")}
        open
        onClose={onClose}
        size="medium"
        footer={
          <>
            <Button variant="secondary" onClick={() => void navigator.clipboard.writeText(token).then(() => showToast({ message: t("Copied to clipboard") }))}>{t("Copy token")}</Button>
            <Button variant="primary" onClick={onClose}>{t("Done")}</Button>
          </>
        }
      >
        <div className={styles.form}>
          <p className={styles.text}>{t("Copy this token now. The token only displays immediately after being generated — if you leave, generate a new one.")}</p>
          <div className={styles.tokenValue} data-new-token="">{token}</div>
          <p className={`${styles.text} ${styles.muted}`}>{t("Send it in the X-Figma-Token header (or as a Bearer token).")}</p>
        </div>
      </Dialog>
    );
  const groups = [...new Set(PERSONAL_TOKEN_SCOPES.map((s) => s.group))];
  return (
    <Dialog
      title={t("Generate new token")}
      open
      onClose={onClose}
      size="medium"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>{t("Cancel")}</Button>
          <Button
            variant="primary"
            disabled={!name.trim() || !scopes.size}
            loading={busy}
            data-generate-token=""
            onClick={async () => {
              setBusy(true);
              try {
                const r = await accountCall<{ token: string; info: AccessTokenInfo }>("POST", "/me/tokens", { description: name.trim(), expiresInDays: Number(days), scopes: [...scopes] });
                setToken(r.token);
                onMade(r.info);
              } catch (e) {
                showToast({ kind: "error", message: errorText(e) });
              } finally {
                setBusy(false);
              }
            }}
          >
            {t("Generate token")}
          </Button>
        </>
      }
    >
      <div className={styles.form}>
        <div className={styles.formRow}>
          <span className={styles.formLabel}>{t("Token name")}</span>
          <TextInput label={t("Token name")} value={name} onChange={setName} placeholder={t("Token name")} autoFocus maxLength={100} />
        </div>
        <div className={styles.formRow}>
          <span className={styles.formLabel}>{t("Expiration")}</span>
          <Select label={t("Expiration")} value={days} options={TOKEN_EXPIRATIONS.map((e) => ({ value: String(e.days), label: tp(e.days, "{n} day", "{n} days") }))} onChange={setDays} />
        </div>
        <div className={styles.scopes}>
          <span className={styles.formLabel}>{t("Scopes")}</span>
          {groups.map((g) => (
            <div key={g} className={styles.scopes}>
              <h4 className={styles.scopeGroup}>{t(g)}</h4>
              {PERSONAL_TOKEN_SCOPES.filter((s) => s.group === g).map((s) => (
                <div key={s.id}>
                  <Checkbox label={s.id} checked={scopes.has(s.id)} onChange={(on) => toggle(s.id, on === true)} />
                  <p className={styles.scopeHint}>{ADMIN_ONLY_SCOPES.has(s.id) ? `${t(s.label)} ${t("Must be an organization admin.")}` : t(s.label)}</p>
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    </Dialog>
  );
}

/**
 * "Enable libraries for all files in your drafts": the published libraries, each a switch. On, it is enabled in every
 * file in Drafts now and in every new file (the workspace's default libraries, docs/data.md); off, the reverse.
 */
export function DraftLibrariesDialog({ onClose }: { onClose: () => void }) {
  useT();
  const [libs, setLibs] = useState<{ key: string; name: string }[] | null>(null);
  const [on, setOn] = useState<Set<string>>(new Set());
  useEffect(() => {
    const store = getStoreClient();
    let live = true;
    void (async () => {
      const [records, ws] = await Promise.all([store.libraries.listAvailable(), store.workspace.getWorkspace()]);
      const names = await Promise.all(records.map(async (r: LibraryRecord) => ({ key: r.libraryFileKey, name: (await store.workspace.getFile(r.libraryFileKey).catch(() => null))?.name ?? t("Untitled") })));
      if (!live) return;
      setLibs(names);
      setOn(new Set(ws.defaultLibraries));
    })().catch((e: unknown) => showToast({ kind: "error", message: errorText(e) }));
    return () => {
      live = false;
    };
  }, []);
  const set = async (key: string, enabled: boolean) => {
    const store = getStoreClient();
    const next = new Set(on);
    if (enabled) next.add(key);
    else next.delete(key);
    setOn(next);
    try {
      await store.workspace.updateWorkspace({ defaultLibraries: [...next] });
      const drafts = await store.workspace.listFiles({ in: "drafts" });
      for (const f of drafts) if (f.fileKey !== key) await store.libraries.setEnabled(f.fileKey, key, enabled).catch(() => {});
    } catch (e) {
      showToast({ kind: "error", message: errorText(e) });
    }
  };
  return (
    <Dialog title={t("Libraries")} open onClose={onClose} size="medium" footer={<Button variant="primary" onClick={onClose}>{t("Done")}</Button>}>
      <div className={styles.form}>
        <p className={styles.text}>{t("Enabled libraries are available in every file in your drafts, and in new files.")}</p>
        {libs === null ? null : libs.length === 0 ? (
          <p className={`${styles.text} ${styles.muted}`}>{t("No libraries yet. Publish one from a file in a folder (Assets › Libraries › Publish).")}</p>
        ) : (
          <div className={styles.libraries}>
            {libs.map((l) => (
              <div key={l.key} className={styles.libraryRow} data-draft-library={l.key}>
                <span className={styles.libraryName}>{l.name}</span>
                <Switch label={t("Enable {name}", { name: l.name })} checked={on.has(l.key)} onChange={(c) => void set(l.key, c)} />
              </div>
            ))}
          </div>
        )}
      </div>
    </Dialog>
  );
}
