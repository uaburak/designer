/**
 * Settings › Security, as live Figma (8–9.png): Password, Sessions (Location & IP / OS & Browser / Last accessed /
 * Manage — "Current", or "Sign out" ending exactly that session), Personal access tokens (Generate new token, the list,
 * Revoke access) and Connected apps — here the MCP clients connected to this computer's agents' server
 * (src/main/agents/clients.ts), Revoke access taking our server out of their config.
 *
 * We log in with Google: the password is the Google account's, so Change password opens Google's page ("Managed by
 * Google", as Figma shows for SSO accounts). Two-factor authentication is ours (docs/governance.md §2.4): TOTP on top
 * of any sign-in — Enable two-factor authentication (a QR code and the key as text, the 6-digit code, then the
 * recovery codes with Copy and Download), Regenerate recovery codes, and Turn off (a code required).
 */
import { useEffect, useMemo, useState } from "react";
import qrcode from "qrcode-generator";
import { Button, Dialog, Icon, Spinner, TextInput, showToast } from "@/ds";
import { getStoreClient } from "@/store";
import { accountBridge } from "../files/account";
import { timeAgo, type AccessTokenInfo, type SessionInfo } from "@shared/account";
import type { McpClientInfo } from "@shared/agents/types";
import type { TwoFactorSetup, TwoFactorStatus } from "@shared/org/governance";
import type { GovernanceRepository } from "@shared/org/repositories";
import { isStoreError } from "@shared/store/protocol";
import { Divider, Link, Section } from "./AccountTab";
import { accountCall, agentSetupBridge, openLink } from "./bridge";
import { GenerateTokenDialog } from "./SettingsDialogs";
import { useProfile } from "./useProfile";
import styles from "./Settings.module.css";
import own from "./SecurityTab.module.css";

/** "Now" for the "… ago" texts: when the tab was opened (a render stays pure). */
const useNow = () => useState(() => Date.now())[0];

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** "Antalya, Türkiye", "Türkiye", or the IP's place unknown. */
const place = (s: SessionInfo) => [s.city, s.country].filter(Boolean).join(", ") || "Unknown location";

export function SecurityTab() {
  const { account, profile } = useProfile();
  const signedIn = !!account.state?.user;
  return (
    <div className={styles.page} data-settings-security="">
      <Section heading="Password" data-settings-section="password">
        <Link onClick={() => openLink("https://myaccount.google.com/signinoptions/password")}>Change password</Link>
        {signedIn && <TwoFactor />}
        <p className={styles.note}>{profile?.provider === "dev" ? "A development account has no password." : "Managed by Google. You log in with your Google account, so its password is changed there."}</p>
      </Section>
      <Divider />
      {signedIn ? <Sessions /> : <LogInFirst heading="Sessions" text="Log in to see where your account is logged in." />}
      <Divider />
      {signedIn ? <Tokens /> : <LogInFirst heading="Personal access tokens" text="Log in to generate personal access tokens." />}
      <Divider />
      <ConnectedApps />
    </div>
  );
}

// ---- Two-factor authentication (docs/governance.md §2.4, §5 "Clients"; the wording is ours — unverified) ----

/** The store's Governance+ door (the caller's own 2FA); null where no store answers */
function governance(): GovernanceRepository | null {
  try {
    return getStoreClient().governance ?? null;
  } catch {
    return null;
  }
}

/** The server's refusals of a code in words (§4: 400 `two_factor_invalid`, 429 after five failures, 409 an expired setup) */
export function twoFactorErrorText(e: unknown): string {
  const detail = isStoreError(e) && e.detail && typeof e.detail === "object" ? (e.detail as { code?: string }).code : undefined;
  if (detail === "two_factor_invalid" || (isStoreError(e) && e.code === "invalid")) return "That code didn't work. Try again.";
  if (detail === "rate_limited") return "Too many tries. Try again in 10 minutes.";
  if (isStoreError(e) && e.code === "conflict") return "This setup expired. Close this and start again.";
  return errorText(e);
}

/** "abcd efgh …": the key in groups of four, as authenticator apps show it */
export const groupKey = (secret: string) => secret.replace(/(.{4})(?=.)/g, "$1 ");

function TwoFactor() {
  const [gov] = useState(governance);
  const [status, setStatus] = useState<TwoFactorStatus | null>(null);
  const [dialog, setDialog] = useState<"enable" | "regenerate" | "disable" | null>(null);
  const load = () => {
    if (!gov) return;
    void gov.twoFactor().then(setStatus, () => setStatus(null));
  };
  useEffect(load, [gov]);
  const close = () => {
    setDialog(null);
    load();
  };
  return (
    <>
      {status?.enabled ? (
        <div className={own.status} data-two-factor="on">
          <p className={styles.value}>Two-factor authentication is on.</p>
          <p className={`${styles.value} ${styles.muted}`}>{status.recoveryCodesLeft === 1 ? "1 recovery code left" : `${status.recoveryCodesLeft} recovery codes left`}</p>
          <div className={own.actions}>
            <Link tight onClick={() => setDialog("regenerate")} data-two-factor-regenerate="">
              Regenerate recovery codes
            </Link>
            <Link tight danger onClick={() => setDialog("disable")} data-two-factor-disable="">
              Turn off two-factor authentication
            </Link>
          </div>
        </div>
      ) : (
        <Link onClick={() => setDialog("enable")} disabled={!gov} data-two-factor-enable="">
          Enable two-factor authentication
        </Link>
      )}
      {gov && dialog === "enable" && <EnableTwoFactorDialog gov={gov} onClose={close} />}
      {gov && (dialog === "regenerate" || dialog === "disable") && <TwoFactorCodeDialog gov={gov} kind={dialog} onClose={close} />}
    </>
  );
}

/** The QR code of the `otpauth://` URL: dark modules on white in both themes (scanners want that), drawn as one path. */
export function QrCode({ value }: { value: string }) {
  const { d, size } = useMemo(() => {
    const q = qrcode(0, "M");
    q.addData(value);
    q.make();
    const n = q.getModuleCount();
    const quiet = 4;
    let path = "";
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (q.isDark(r, c)) path += `M${c + quiet} ${r + quiet}h1v1h-1z`;
    return { d: path, size: n + quiet * 2 };
  }, [value]);
  return (
    <svg className={own.qr} viewBox={`0 0 ${size} ${size}`} shapeRendering="crispEdges" role="img" aria-label="QR code for your authenticator app" data-two-factor-qr="">
      <path d={d} />
    </svg>
  );
}

function EnableTwoFactorDialog({ gov, onClose }: { gov: GovernanceRepository; onClose: () => void }) {
  const [setup, setSetup] = useState<TwoFactorSetup | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [codes, setCodes] = useState<string[] | null>(null);
  useEffect(() => {
    let live = true;
    gov.setupTwoFactor().then(
      (s) => live && setSetup(s),
      (e: unknown) => live && setFailed(errorText(e)),
    );
    return () => {
      live = false;
    };
  }, [gov]);
  const verify = async () => {
    if (code.length !== 6 || busy) return;
    setBusy(true);
    setError(null);
    try {
      setCodes((await gov.enableTwoFactor(code)).recoveryCodes);
    } catch (e) {
      setError(twoFactorErrorText(e));
    } finally {
      setBusy(false);
    }
  };
  if (codes) return <RecoveryCodesDialog title="Save your recovery codes" codes={codes} onClose={onClose} />;
  return (
    <Dialog
      title="Enable two-factor authentication"
      size="medium"
      open
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} disabled={!setup || code.length !== 6} onClick={() => void verify()} data-two-factor-verify="">
            Verify
          </Button>
        </>
      }
    >
      <div className={styles.form} data-two-factor-setup="">
        {failed && <p className={styles.text}>{failed}</p>}
        {!setup && !failed && <Spinner />}
        {setup && (
          <>
            <p className={styles.text}>Scan this QR code with an authenticator app, such as Google Authenticator or 1Password.</p>
            <QrCode value={setup.otpauthUrl} />
            <div className={styles.formRow}>
              <span className={styles.formLabel}>Can’t scan the code? Enter this key in the app instead:</span>
              <code className={styles.tokenValue} data-two-factor-key="">{groupKey(setup.secret)}</code>
            </div>
            <div className={styles.formRow}>
              <span className={styles.formLabel}>Enter the 6-digit code from your authenticator app</span>
              <TextInput label="6-digit code" value={code} onChange={(v) => setCode(v.replace(/\D/g, "").slice(0, 6))} placeholder="123456" maxLength={6} variant="outlined" invalid={!!error} autoFocus data-two-factor-code="" />
              {error && <span className={own.error} role="alert">{error}</span>}
            </div>
          </>
        )}
      </div>
    </Dialog>
  );
}

/** Regenerate recovery codes / Turn off: both take a code from the app or an unused recovery code (§4, 14a). */
function TwoFactorCodeDialog({ gov, kind, onClose }: { gov: GovernanceRepository; kind: "regenerate" | "disable"; onClose: () => void }) {
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [codes, setCodes] = useState<string[] | null>(null);
  const off = kind === "disable";
  const run = async () => {
    if (!code.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      if (off) {
        await gov.disableTwoFactor(code.trim());
        showToast({ message: "Two-factor authentication is off" });
        onClose();
      } else setCodes((await gov.regenerateRecoveryCodes(code.trim())).recoveryCodes);
    } catch (e) {
      setError(twoFactorErrorText(e));
    } finally {
      setBusy(false);
    }
  };
  if (codes) return <RecoveryCodesDialog title="Your new recovery codes" codes={codes} onClose={onClose} />;
  return (
    <Dialog
      title={off ? "Turn off two-factor authentication?" : "Regenerate recovery codes"}
      size="small"
      open
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant={off ? "destructive" : "primary"} loading={busy} disabled={!code.trim()} onClick={() => void run()} data-two-factor-confirm="">
            {off ? "Turn off" : "Regenerate"}
          </Button>
        </>
      }
    >
      <div className={styles.form}>
        <p className={styles.text}>{off ? "Logging in will no longer ask for a code from your authenticator app." : "Your current recovery codes will stop working."}</p>
        <div className={styles.formRow}>
          <span className={styles.formLabel}>Enter the 6-digit code from your authenticator app, or one of your recovery codes</span>
          <TextInput label="Code" value={code} onChange={setCode} maxLength={20} variant="outlined" invalid={!!error} autoFocus data-two-factor-code="" />
          {error && <span className={own.error} role="alert">{error}</span>}
        </div>
      </div>
    </Dialog>
  );
}

const codesText = (codes: readonly string[]) => `DesignerV2 recovery codes\n\nEach code can be used once.\n\n${codes.join("\n")}\n`;

/** Shown once: the codes, Copy, Download (a download link — Electron's will-download shows the Save dialog), Done. */
function RecoveryCodesDialog({ title, codes, onClose }: { title: string; codes: string[]; onClose: () => void }) {
  const download = () => {
    const url = URL.createObjectURL(new Blob([codesText(codes)], { type: "text/plain" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = "designer-recovery-codes.txt";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const copy = () =>
    void navigator.clipboard?.writeText(codes.join("\n")).then(
      () => showToast({ message: "Copied to clipboard" }),
      () => showToast({ kind: "error", message: "Couldn't copy" }),
    );
  return (
    <Dialog
      title={title}
      size="small"
      open
      onClose={onClose}
      footer={
        <Button variant="primary" onClick={onClose} data-two-factor-done="">
          Done
        </Button>
      }
    >
      <div className={styles.form}>
        <p className={styles.text}>Keep these codes somewhere safe. If you lose your device, each code logs you in once. They won’t be shown again.</p>
        <ul className={own.codes} data-recovery-codes="">
          {codes.map((c) => (
            <li key={c}>{c}</li>
          ))}
        </ul>
        <div className={own.actions}>
          <Button variant="secondary" onClick={copy} data-recovery-copy="">
            Copy
          </Button>
          <Button variant="secondary" onClick={download} data-recovery-download="">
            Download
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

function LogInFirst({ heading, text }: { heading: string; text: string }) {
  return (
    <Section heading={heading}>
      <p className={`${styles.text} ${styles.muted}`}>{text}</p>
    </Section>
  );
}

function Sessions() {
  const [sessions, setSessions] = useState<SessionInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = () =>
    accountCall<{ sessions: SessionInfo[] }>("GET", "/me/sessions").then(
      (r) => {
        setSessions(r.sessions);
        setError(null);
      },
      (e: unknown) => setError(errorText(e)),
    );
  useEffect(() => {
    void load();
  }, []);
  const now = useNow();
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  /** Every session token stops working (the server's token version, §13), this one too: then signed out here */
  const everywhere = async () => {
    setBusy(true);
    try {
      await accountCall("DELETE", "/me/sessions");
      setConfirm(false);
      await accountBridge()?.signOut();
    } catch (e) {
      showToast({ kind: "error", message: errorText(e) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Section heading="Sessions" data-settings-section="sessions">
      <p className={styles.text}>All of your active sessions are listed below. End any sessions you don't recognize or trust.</p>
      {error && <p className={styles.note}>{error}</p>}
      {sessions && (
        <table className={styles.sessions}>
          <colgroup>
            <col className={styles.colLocation} />
            <col className={styles.colOs} />
            <col className={styles.colLast} />
            <col />
          </colgroup>
          <thead>
            <tr>
              <th>Location &amp; IP</th>
              <th>OS &amp; Browser</th>
              <th>Last accessed</th>
              <th>Manage</th>
            </tr>
          </thead>
          <tbody>
            {sessions.map((s) => (
              <tr key={s.id} data-session={s.id} data-current={s.current ? "" : undefined}>
                <td>
                  <div className={styles.where}>
                    <span className={styles.whereIcon}>
                      <Icon name={/iOS|Android/.test(s.os ?? "") ? "24.device.mobile" : "24.device.desktop"} />
                    </span>
                    <span className={styles.lines}>
                      <span>{place(s)}</span>
                      <span className={styles.muted}>{`${s.kind === "app" ? "App" : "Login"} · ${s.ip ?? "—"}`}</span>
                    </span>
                  </div>
                </td>
                <td>
                  <span className={styles.lines}>
                    <span>{s.os ?? "-"}</span>
                    <span>{s.browser ?? "-"}</span>
                  </span>
                </td>
                <td>
                  <span className={styles.lines}>
                    <span>{s.current ? "Just now" : timeAgo(s.lastSeenAt, now)}</span>
                    <span>{`Created ${timeAgo(s.createdAt, now).replace("Just now", "just now")}`}</span>
                  </span>
                </td>
                <td>
                  <div className={styles.manage}>
                    {s.current ? (
                      <span className={styles.current}>Current</span>
                    ) : (
                      <button
                        type="button"
                        className={`${styles.link} ${styles.signOut}`}
                        data-sign-out-session=""
                        onClick={async () => {
                          try {
                            await accountCall("DELETE", `/me/sessions/${s.id}`);
                            setSessions((all) => all?.filter((x) => x.id !== s.id) ?? null);
                          } catch (e) {
                            showToast({ kind: "error", message: errorText(e) });
                          }
                        }}
                      >
                        Sign out
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {sessions && (
        <button type="button" className={`${styles.link} ${styles.signOut} ${styles.everywhere}`} onClick={() => setConfirm(true)} data-sign-out-everywhere="">
          Sign out everywhere
        </button>
      )}
      {confirm && (
        <Dialog
          title="Sign out everywhere?"
          size="small"
          open
          onClose={() => setConfirm(false)}
          footer={
            <>
              <Button variant="secondary" onClick={() => setConfirm(false)}>
                Cancel
              </Button>
              <Button variant="destructive" loading={busy} onClick={() => void everywhere()} data-confirm-sign-out-everywhere="">
                Sign out everywhere
              </Button>
            </>
          }
        >
          <p className={styles.text}>You’ll be signed out of every session on every device, including this one.</p>
        </Dialog>
      )}
    </Section>
  );
}

function Tokens() {
  const [tokens, setTokens] = useState<AccessTokenInfo[]>([]);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    let live = true;
    accountCall<{ tokens: AccessTokenInfo[] }>("GET", "/me/tokens").then((r) => live && setTokens(r.tokens), () => {});
    return () => {
      live = false;
    };
  }, []);
  const now = useNow();
  return (
    <Section heading="Personal access tokens" data-settings-section="tokens">
      <p className={styles.text}>Personal access tokens allow you to access your own data via the API. Do not give out your personal access tokens to anybody who you don't want to access your files.</p>
      <Link tight onClick={() => setOpen(true)} data-new-token-link="">
        Generate new token
      </Link>
      {tokens.length > 0 && (
        <div className={styles.tokens} role="list" aria-label="Personal access tokens">
          {tokens.map((t) => {
            const expired = t.expiresAt !== null && t.expiresAt <= now;
            const expires = t.expiresAt === null ? "Never expires" : expired ? "Expired" : `Expires in ${timeAgo(now, t.expiresAt).replace(" ago", "")}`;
            return (
              <div key={t.id} role="listitem" className={styles.tokenRow} data-token={t.id}>
                <span className={styles.tokenName} title={t.scopes.join(", ")}>{t.description}</span>
                <span className={styles.muted}>{t.lastUsedAt ? `Last used ${timeAgo(t.lastUsedAt, now).toLowerCase()}` : "Never used"}</span>
                <span className={styles.muted}>{expires}</span>
                <button
                  type="button"
                  className={styles.link}
                  onClick={async () => {
                    try {
                      await accountCall("DELETE", `/me/tokens/${t.id}`);
                      setTokens((all) => all.filter((x) => x.id !== t.id));
                    } catch (e) {
                      showToast({ kind: "error", message: errorText(e) });
                    }
                  }}
                >
                  Revoke access
                </button>
              </div>
            );
          })}
        </div>
      )}
      {open && <GenerateTokenDialog onClose={() => setOpen(false)} onMade={(info) => setTokens((all) => [info, ...all])} />}
    </Section>
  );
}

/** The MCP clients connected to this computer's agents' server: "Connected N days ago", Revoke access (Disconnect). */
function ConnectedApps() {
  const api = agentSetupBridge();
  const [clients, setClients] = useState<McpClientInfo[]>([]);
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!api) return;
    let live = true;
    void Promise.all([api.clients(), api.mcp()]).then(([c, m]) => {
      if (!live) return;
      setClients(c);
      setUrl(m.url);
    }, () => {});
    return () => {
      live = false;
    };
  }, [api]);
  const connected = clients.filter((c) => c.connected);
  const now = useNow();
  return (
    <Section heading="Connected apps" data-settings-section="connected-apps">
      <p className={styles.text}>The following apps have been given permission to access your files on your behalf. If you see any apps you're not expecting here, remove their permissions below.</p>
      {!api && <p className={styles.note}>Apps connect to the desktop app’s agents’ server.</p>}
      {api && connected.length === 0 && <p className={styles.note}>No apps are connected. Connect them in Agents › Connect other apps.</p>}
      {connected.length > 0 && (
        <div className={styles.apps} role="list" aria-label="Connected apps">
          {connected.map((c) => (
            <div key={c.id} role="listitem" className={styles.appRow} data-connected-app={c.id}>
              <span className={styles.appIcon}><Icon name="24.plugin" /></span>
              <span className={styles.appName}>{c.label}</span>
              <span className={styles.appUrl}>{url ?? ""}</span>
              {c.connectedAt && <span className={styles.appWhen}>{`Connected ${timeAgo(c.connectedAt, now).toLowerCase()}`}</span>}
              <button
                type="button"
                className={`${styles.link} ${styles.appRevoke}`}
                onClick={async () => {
                  const r = await api!.disconnect(c.id);
                  if (!r.ok && r.error) showToast({ kind: "error", message: r.error });
                  setClients(await api!.clients());
                }}
              >
                Revoke access
              </button>
            </div>
          ))}
        </div>
      )}
    </Section>
  );
}
