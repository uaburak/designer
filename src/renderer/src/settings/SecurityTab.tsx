/**
 * Settings › Security, as live Figma (8–9.png): Password, Sessions (Location & IP / OS & Browser / Last accessed /
 * Manage — "Current", or "Sign out" ending exactly that session), Personal access tokens (Generate new token, the list,
 * Revoke access) and Connected apps — here the MCP clients connected to this computer's agents' server
 * (src/main/agents/clients.ts), Revoke access taking our server out of their config.
 *
 * We log in with Google: the password and two-factor authentication are the Google account's, so Figma's two links
 * open Google's own pages for them ("Managed by Google", as Figma shows for SSO accounts).
 */
import { useEffect, useState } from "react";
import { Button, Dialog, Icon, showToast } from "@/ds";
import { accountBridge } from "../files/account";
import { timeAgo, type AccessTokenInfo, type SessionInfo } from "@shared/account";
import type { McpClientInfo } from "@shared/agents/types";
import { Divider, Link, Section } from "./AccountTab";
import { accountCall, agentSetupBridge, openLink } from "./bridge";
import { GenerateTokenDialog } from "./SettingsDialogs";
import { useProfile } from "./useProfile";
import styles from "./Settings.module.css";

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
        <Link onClick={() => openLink("https://myaccount.google.com/signinoptions/twosv")}>Enable two-factor authentication</Link>
        <p className={styles.note}>{profile?.provider === "dev" ? "A development account has no password." : "Managed by Google. You log in with your Google account, so its password and two-factor authentication are changed there."}</p>
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
