/**
 * The Settings modal's small dialogs (ds Dialog, 320 / 480): Change name, Change email, Change role, Change language,
 * View history, Delete account, Generate new token, and the drafts' libraries. Each takes what it changes and says
 * when it is done; the server's refusals come back as toasts (useProfile.save) or inline.
 */
import { useEffect, useState } from "react";
import { Button, Checkbox, Dialog, RadioGroup, Select, showToast, Switch, TextInput } from "@/ds";
import { LANGUAGES, ROLES, TOKEN_EXPIRATIONS, TOKEN_SCOPES, type AccessTokenInfo, type TokenScope } from "@shared/account";
import type { LibraryRecord } from "@shared/store/types";
import { getStoreClient } from "@/store";
import { accountCall } from "./bridge";
import styles from "./Settings.module.css";

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function ChangeNameDialog({ name, onSave, onClose }: { name: string; onSave: (name: string) => Promise<unknown>; onClose: () => void }) {
  const [value, setValue] = useState(name);
  const [busy, setBusy] = useState(false);
  const ok = value.trim().length > 0 && value.trim() !== name;
  return (
    <Dialog
      title="Change name"
      open
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!ok} loading={busy} onClick={async () => { setBusy(true); await onSave(value.trim()); setBusy(false); onClose(); }} data-save-name="">
            Save
          </Button>
        </>
      }
    >
      <div className={styles.formRow}>
        <span className={styles.formLabel}>Name</span>
        <TextInput label="Name" value={value} onChange={setValue} autoFocus maxLength={100} />
      </div>
    </Dialog>
  );
}

/** Figma: a Google-SSO account's email is "Managed by Google" — it changes in the Google account, not here. */
export function ChangeEmailDialog({ email, provider, onClose }: { email: string; provider: "google" | "dev"; onClose: () => void }) {
  return (
    <Dialog title="Change email" open onClose={onClose} footer={<Button variant="primary" onClick={onClose}>Done</Button>}>
      <div className={styles.form}>
        <p className={styles.text}>{email}</p>
        <p className={styles.text}>
          {provider === "google"
            ? "Managed by Google. You log in with your Google account, so your email can only be changed in your Google account. Log in with the other Google account to use another email."
            : "This is a development account; its email can't be changed."}
        </p>
      </div>
    </Dialog>
  );
}

export function ChangeRoleDialog({ role, onSave, onClose }: { role: string | null; onSave: (role: string) => Promise<unknown>; onClose: () => void }) {
  const [value, setValue] = useState(role ?? "");
  return (
    <Dialog
      title="Change role"
      open
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!value || value === role} onClick={async () => { await onSave(value); onClose(); }} data-save-role="">
            Save
          </Button>
        </>
      }
    >
      <div className={styles.form}>
        <span className={styles.formLabel}>What kind of work do you do?</span>
        <RadioGroup label="Role" value={value} options={ROLES.map((r) => ({ value: r, label: r }))} onChange={setValue} />
      </div>
    </Dialog>
  );
}

export function ChangeLanguageDialog({ language, onSave, onClose }: { language: string; onSave: (language: string) => Promise<unknown>; onClose: () => void }) {
  const [value, setValue] = useState(language);
  return (
    <Dialog
      title="Change language"
      open
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={value === language} onClick={async () => { await onSave(value); onClose(); }}>
            Save
          </Button>
        </>
      }
    >
      <div className={styles.form}>
        <Select label="Language" value={value} options={LANGUAGES.map((l) => ({ value: l.id, label: l.label, disabled: !l.available, hint: l.available ? undefined : "Coming later" }))} onChange={setValue} />
        <p className={`${styles.text} ${styles.muted}`}>DesignerV2 is in English for now; the other languages Figma has are listed for later.</p>
      </div>
    </Dialog>
  );
}

/** help.figma.com 29638316371479: "Off" — your views of files aren't shown to others (and you don't see theirs). */
export function ViewHistoryDialog({ on, onSave, onClose }: { on: boolean; onSave: (on: boolean) => Promise<unknown>; onClose: () => void }) {
  const [value, setValue] = useState(on ? "on" : "off");
  return (
    <Dialog
      title="View history"
      open
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={(value === "on") === on} onClick={async () => { await onSave(value === "on"); onClose(); }} data-save-view-history="">
            Save
          </Button>
        </>
      }
    >
      <RadioGroup
        label="View history"
        value={value}
        options={[
          { value: "on", label: "On — see who viewed your files and let others see your views" },
          { value: "off", label: "Off — don’t show when you view files, and don’t see others’ views" },
        ]}
        onChange={setValue}
      />
    </Dialog>
  );
}

/** Delete account (help.figma.com 360039826814): permanent; the email typed to confirm. */
export function DeleteAccountDialog({ email, onClose, onDeleted }: { email: string; onClose: () => void; onDeleted: () => void }) {
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const ok = typed.trim().toLowerCase() === email.toLowerCase();
  return (
    <Dialog
      title="Delete account"
      open
      onClose={onClose}
      size="medium"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
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
            Delete account
          </Button>
        </>
      }
    >
      <div className={styles.form}>
        <p className={styles.text}>Deleting your account is permanent and can’t be undone. You won’t be able to log in with it again.</p>
        <p className={styles.text}>Files you shared stop being shared, and you’re removed from files others shared with you. Your comments and developer previews are deleted. The files on this computer stay yours.</p>
        <div className={styles.formRow}>
          <span className={styles.formLabel}>{`Type ${email} to confirm`}</span>
          <TextInput label="Email" value={typed} onChange={setTyped} placeholder={email} autoFocus />
        </div>
      </div>
    </Dialog>
  );
}

/** "Generate new token": a name, an expiration, scopes → the token, shown once. */
export function GenerateTokenDialog({ onClose, onMade }: { onClose: () => void; onMade: (info: AccessTokenInfo) => void }) {
  const [name, setName] = useState("");
  const [days, setDays] = useState("30");
  const [scopes, setScopes] = useState<Set<TokenScope>>(new Set(["file_content:read"]));
  const [token, setToken] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const toggle = (s: TokenScope, on: boolean) => setScopes((was) => { const next = new Set(was); if (on) next.add(s); else next.delete(s); return next; });
  if (token)
    return (
      <Dialog
        title="Personal access token"
        open
        onClose={onClose}
        size="medium"
        footer={
          <>
            <Button variant="secondary" onClick={() => void navigator.clipboard.writeText(token).then(() => showToast({ message: "Copied to clipboard" }))}>Copy token</Button>
            <Button variant="primary" onClick={onClose}>Done</Button>
          </>
        }
      >
        <div className={styles.form}>
          <p className={styles.text}>Copy this token now. The token only displays immediately after being generated — if you leave, generate a new one.</p>
          <div className={styles.tokenValue} data-new-token="">{token}</div>
          <p className={`${styles.text} ${styles.muted}`}>Use it as a Bearer token: Authorization: Bearer &lt;token&gt;.</p>
        </div>
      </Dialog>
    );
  const groups = [...new Set(TOKEN_SCOPES.map((s) => s.group))];
  return (
    <Dialog
      title="Generate new token"
      open
      onClose={onClose}
      size="medium"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
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
            Generate token
          </Button>
        </>
      }
    >
      <div className={styles.form}>
        <div className={styles.formRow}>
          <span className={styles.formLabel}>Token name</span>
          <TextInput label="Token name" value={name} onChange={setName} placeholder="Token name" autoFocus maxLength={100} />
        </div>
        <div className={styles.formRow}>
          <span className={styles.formLabel}>Expiration</span>
          <Select label="Expiration" value={days} options={TOKEN_EXPIRATIONS.map((e) => ({ value: String(e.days), label: e.label }))} onChange={setDays} />
        </div>
        <div className={styles.scopes}>
          <span className={styles.formLabel}>Scopes</span>
          {groups.map((g) => (
            <div key={g} className={styles.scopes}>
              <h4 className={styles.scopeGroup}>{g}</h4>
              {TOKEN_SCOPES.filter((s) => s.group === g).map((s) => (
                <div key={s.id}>
                  <Checkbox label={s.id} checked={scopes.has(s.id)} onChange={(on) => toggle(s.id, on === true)} />
                  <p className={styles.scopeHint}>{s.label}</p>
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
  const [libs, setLibs] = useState<{ key: string; name: string }[] | null>(null);
  const [on, setOn] = useState<Set<string>>(new Set());
  useEffect(() => {
    const store = getStoreClient();
    let live = true;
    void (async () => {
      const [records, ws] = await Promise.all([store.libraries.listAvailable(), store.workspace.getWorkspace()]);
      const names = await Promise.all(records.map(async (r: LibraryRecord) => ({ key: r.libraryFileKey, name: (await store.workspace.getFile(r.libraryFileKey).catch(() => null))?.name ?? "Untitled" })));
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
    <Dialog title="Libraries" open onClose={onClose} size="medium" footer={<Button variant="primary" onClick={onClose}>Done</Button>}>
      <div className={styles.form}>
        <p className={styles.text}>Enabled libraries are available in every file in your drafts, and in new files.</p>
        {libs === null ? null : libs.length === 0 ? (
          <p className={`${styles.text} ${styles.muted}`}>No libraries yet. Publish one from a file in a folder (Assets › Libraries › Publish).</p>
        ) : (
          <div className={styles.libraries}>
            {libs.map((l) => (
              <div key={l.key} className={styles.libraryRow} data-draft-library={l.key}>
                <span className={styles.libraryName}>{l.name}</span>
                <Switch label={`Enable ${l.name}`} checked={on.has(l.key)} onChange={(c) => void set(l.key, c)} />
              </div>
            ))}
          </div>
        )}
      </div>
    </Dialog>
  );
}
