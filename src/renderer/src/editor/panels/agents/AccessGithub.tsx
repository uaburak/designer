/**
 * Agent settings › Access › GitHub (docs/agents-reach.md §6.1): the connection — "Connect with GitHub" (a GitHub App's
 * device flow, when the build has one) or "Use a token" (a fine-grained, read-only token, sealed by main) — and the
 * repositories agents may read: the account's with a checkbox each, and public ones added by name. With none, nothing
 * can be read. The token goes to main once; this page never sees it again.
 */
import { useEffect, useRef, useState } from "react";
import { Button, Checkbox, Spinner, TextInput, showToast } from "@/ds";
import { isRepoName, type ReachPatch, type ReachView } from "@shared/agents/reach";
import { Block, Field, errorText } from "./settingsParts";
import { ListLine, changeReach, reachApi, refreshReach } from "./AccessSettings";
import styles from "./Agents.module.css";
import { t, useT } from "@/i18n";

const TOKEN_PAGE = "https://github.com/settings/personal-access-tokens/new";

const openExternal = (url: string) => {
  const d = (window as unknown as { designer?: { openExternal?: (u: string) => void } }).designer;
  if (d?.openExternal) d.openExternal(url);
  else window.open(url, "_blank", "noopener");
};

export function GithubConnection({ view, patch }: { view: ReachView; patch: (p: ReachPatch) => void }) {
  useT();
  return (
    <>
      <Connection view={view} />
      <Repositories view={view} patch={patch} />
    </>
  );
}

function Connection({ view }: { view: ReachView }) {
  useT();
  const g = view.github;
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [device, setDevice] = useState<{ userCode: string; verificationUri: string } | null>(null);
  const polling = useRef<ReturnType<typeof setInterval> | null>(null);
  const stop = () => {
    if (polling.current) clearInterval(polling.current);
    polling.current = null;
  };
  useEffect(() => stop, []);
  const api = reachApi();
  if (!api) return null;
  const startDevice = async () => {
    try {
      const d = await api.githubDeviceStart();
      setDevice(d);
      stop();
      polling.current = setInterval(() => {
        void api.githubDevicePoll().then((r) => {
          if (r.state === "pending") return;
          stop();
          setDevice(null);
          if (r.state === "connected") void refreshReach();
          else showToast({ message: r.state === "denied" ? t("GitHub sign-in was cancelled.") : t("The code expired. Try again."), kind: "error" });
        }, (err) => (stop(), setDevice(null), showToast({ message: errorText(err), kind: "error" })));
      }, 3000);
    } catch (err) {
      showToast({ message: errorText(err), kind: "error" });
    }
  };
  return (
    <Block title={t("Connection")}>
      <Field label={t("Status")} data-github-state={g.connected ? "connected" : "not-connected"}>
        {g.connected ? t("Connected as {login}", { login: g.login ? `@${g.login}` : "GitHub" }) : t("Not connected")}
      </Field>
      {g.connected ? (
        <div className={styles.actions}>
          <Button variant="secondary" onClick={() => void changeReach((a) => a.githubDisconnect())} data-github-disconnect="">{t("Disconnect")}</Button>
        </div>
      ) : (
        <>
          {g.deviceFlow &&
            (device ? (
              <div className={styles.pageBody}>
                <p className={styles.pageText}>{t("Enter this code on GitHub:")}</p>
                <span className={styles.mono} data-github-code="">{device.userCode}</span>
                <div className={styles.actions}>
                  <Button
                    variant="primary"
                    onClick={() => {
                      void navigator.clipboard?.writeText(device.userCode).catch(() => undefined);
                      openExternal(device.verificationUri);
                    }}
                  >
                    {t("Copy code and open GitHub")}
                  </Button>
                  <Spinner size={16} />
                </div>
              </div>
            ) : (
              <div className={styles.actions}>
                <Button variant="primary" onClick={() => void startDevice()} data-github-device="">{t("Connect with GitHub")}</Button>
              </div>
            ))}
          <p className={styles.pageText}>{t("Or use a fine-grained token, read-only: Repository access — the repositories you want; Permissions — Contents: Read-only and Metadata: Read-only.")}</p>
          <div className={styles.actions}>
            <TextInput label={t("Token")} placeholder="github_pat_…" secret value={token} onChange={setToken} data-github-token="" />
            <Button
              variant="secondary"
              disabled={busy || !token.trim()}
              onClick={async () => {
                setBusy(true);
                await changeReach((a) => a.githubToken(token.trim()));
                setToken("");
                setBusy(false);
              }}
              data-github-connect=""
            >
              {t("Connect")}
            </Button>
          </div>
          <button type="button" className={styles.link} onClick={() => openExternal(TOKEN_PAGE)}>
            {t("Create a token on GitHub")}
          </button>
        </>
      )}
    </Block>
  );
}

function Repositories({ view, patch }: { view: ReachView; patch: (p: ReachPatch) => void }) {
  useT();
  const repos = view.settings.github.repos;
  const [name, setName] = useState("");
  const [loaded, setAccount] = useState<{ fullName: string; private: boolean; description: string }[] | null>(null);
  const api = reachApi();
  const connected = view.github.connected;
  const account = connected ? loaded : null;
  useEffect(() => {
    if (!connected || !api) return;
    let live = true;
    void api.githubRepos().then((list) => live && setAccount(list), (err) => live && (setAccount([]), showToast({ message: errorText(err), kind: "error" })));
    return () => void (live = false);
  }, [connected, api]);
  const clean = name.trim().replace(/^https?:\/\/github\.com\//i, "").replace(/\.git$|\/$/g, "");
  const has = (r: string) => repos.some((x) => x.toLowerCase() === r.toLowerCase());
  const add = () => {
    if (!isRepoName(clean) || has(clean)) return;
    patch({ repos: [...repos, clean] });
    setName("");
  };
  const others = repos.filter((r) => !account?.some((a) => a.fullName.toLowerCase() === r.toLowerCase()));
  return (
    <Block title={t("Repositories agents can read")}>
      {!repos.length && <p className={styles.pageText}>{t("No repositories yet: agents can't read any.")}</p>}
      {connected && !account && <div className={styles.rowNote}><Spinner size={16} /></div>}
      {account?.map((r) => (
        <Checkbox key={r.fullName} label={r.private ? `${r.fullName} · ${t("Private")}` : r.fullName} checked={has(r.fullName)} onChange={(on) => patch({ repos: on ? [...repos, r.fullName] : repos.filter((x) => x.toLowerCase() !== r.fullName.toLowerCase()) })} data-github-repo={r.fullName} />
      ))}
      {others.map((r) => <ListLine key={r} text={r} onRemove={() => patch({ repos: repos.filter((x) => x !== r) })} data-access-repo={r} />)}
      <p className={styles.pageText}>{t("Add a public repository by name:")}</p>
      <div className={styles.actions}>
        <TextInput label={t("Repository")} placeholder="owner/name" value={name} onChange={setName} onExit={(r) => r === "enter" && add()} data-access-repo-input="" />
        <Button variant="secondary" disabled={!isRepoName(clean) || has(clean)} onClick={add} data-access-repo-add="">{t("Add")}</Button>
      </div>
    </Block>
  );
}
