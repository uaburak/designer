/**
 * `?files`: the new Home, Figma's file browser on the store (docs/home.md). Mounts the DS's managers and the theme,
 * finds the workspace (storeAccess.ts) and shows the browser.
 */
import "@/ds/global.css";
import { useEffect, useState } from "react";
import { Spinner, ToastHost, TooltipManager, useThemeRoot } from "@/ds";
import { SettingsHost } from "../settings/SettingsModal";
import { IdleWarning } from "../account/IdleWarning";
import { FileBrowser } from "./FileBrowser";
import { filesBackend, type FilesBackend } from "./storeAccess";
import type { AccountState } from "@shared/account";
import { completeWebSignIn, webAccount } from "../store/webAccount";
import { Welcome, WelcomeScreen } from "../account/Welcome";
import { accountBridge, signInFailure } from "./account";
import styles from "./Files.module.css";

/**
 * The browser's login gate (docs/desktop.md §18.6, as the desktop's welcome window): signed out, Home is the welcome
 * page. Off with `?nologin` or VITE_DESIGNER_NO_LOGIN=1 (development, tests); the desktop's gate is main's.
 */
export function webLoginGated(): boolean {
  if (accountBridge() !== webAccount) return false;
  if ((import.meta.env.VITE_DESIGNER_NO_LOGIN as string | undefined) === "1") return false;
  return typeof location === "undefined" || !new URLSearchParams(location.search).has("nologin");
}

export default function FilesApp() {
  useThemeRoot();
  const [account, setAccount] = useState<AccountState | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const gated = webLoginGated();
  useEffect(() => {
    if (!gated) return;
    let live = true;
    // A sign-in coming back from Google is finished first (no welcome page flash for it), then the account decides.
    void completeWebSignIn().then(async (r) => {
      if (!live) return;
      if (r) setFailure(signInFailure(r));
      setAccount(await webAccount.get());
    });
    const off = webAccount.onChanged((s) => setAccount(s));
    return () => {
      live = false;
      off();
    };
  }, [gated]);
  if (gated && !account?.user) {
    return (
      <>
        {account ? <WelcomeScreen account={webAccount} initialError={failure} /> : <Welcome state={null} method={null} error={null} onSignIn={() => {}} onCancel={() => {}} />}
        <TooltipManager />
      </>
    );
  }
  return <Home />;
}

function Home() {
  const [backend, setBackend] = useState<FilesBackend | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    filesBackend().then(
      (b) => live && setBackend(b),
      (e) => live && setError(e instanceof Error ? e.message : String(e)),
    );
    return () => {
      live = false;
    };
  }, []);
  // The desktop shell shows the window once the first view has painted.
  useEffect(() => {
    if (backend) (window as unknown as { designer?: { ready?: () => void } }).designer?.ready?.();
  }, [backend]);
  return (
    <>
      {backend ? (
        <FileBrowser backend={backend} />
      ) : (
        <div className={styles.app} style={{ display: "flex" }}>
          <div className={styles.center} style={{ flex: 1 }}>
            {error ? <p className={styles.dialogText}>{error}</p> : <Spinner size={24} />}
          </div>
        </div>
      )}
      <SettingsHost />
      <IdleWarning />
      <TooltipManager />
      <ToastHost />
    </>
  );
}
