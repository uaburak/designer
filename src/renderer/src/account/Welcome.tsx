/**
 * The welcome page (docs/desktop.md §18.6): what someone who isn't signed in sees — the whole app, nothing else of it
 * reachable. Modeled on Figma's desktop first-run screen: the logo and name, a welcome line, Log in with Google
 * (primary), Log in with SSO (the server's single sign-on page: email → the org's IdP), a small footer. While a sign-in
 * waits: "Waiting for Google…" with Cancel. Before the kept session is known (and while a signed-in window takes over):
 * the splash — the logo alone, so someone signed in never sees this page flash.
 *
 * `Welcome` only draws what it's handed; `WelcomeScreen` runs it on an account bridge (the desktop's welcome view, or
 * the browser's own sign-in in Home). The welcome line and the footer are ours (Figma's own read "Welcome to Figma").
 */
import { useEffect, useState } from "react";
import { welcomeScreen, type AccountState, type SignInMethod, type SignInResult } from "@shared/account";
import { Banner, Button, Icon, Spinner } from "@/ds";
import { signInFailure } from "../files/account";
import styles from "./Welcome.module.css";

export const WELCOME_TEXT = {
  title: "Welcome to Designer",
  line: "Log in to open your files and start designing.",
  google: "Log in with Google",
  sso: "Log in with SSO",
  waitingGoogle: "Waiting for Google…",
  waitingSso: "Waiting for single sign-on…",
  waitingNote: "Finish logging in in the window that opened.",
  cancel: "Cancel",
} as const;

export interface WelcomeProps {
  state: AccountState | null;
  /** The button last used (the waiting line names it) */
  method: SignInMethod | null;
  error: string | null;
  version?: string;
  onSignIn(method: SignInMethod): void;
  onCancel(): void;
}

export function Welcome({ state, method, error, version, onSignIn, onCancel }: WelcomeProps) {
  const screen = welcomeScreen(state);
  return (
    <main className={styles.page} data-welcome={screen}>
      <div className={styles.drag} aria-hidden />
      <div className={styles.body}>
        <span className={styles.logo}>
          <Icon name="24.figma" size={48} label="Designer" />
        </span>
        {screen !== "splash" && (
          <>
            <span className={styles.wordmark}>Designer</span>
            <h1 className={styles.title}>{WELCOME_TEXT.title}</h1>
            {screen === "welcome" ? (
              <>
                <p className={styles.line}>{WELCOME_TEXT.line}</p>
                <div className={styles.actions}>
                  <Button variant="primary" size="large" fullWidth onClick={() => onSignIn("google")} data-welcome-google="">
                    {WELCOME_TEXT.google}
                  </Button>
                  <Button variant="link" onClick={() => onSignIn("sso")} data-welcome-sso="">
                    {WELCOME_TEXT.sso}
                  </Button>
                </div>
                {error && (
                  <Banner tone="danger" className={styles.error} data-welcome-error="">
                    {error}
                  </Banner>
                )}
              </>
            ) : (
              <div className={styles.waiting} data-welcome-waiting="">
                <Spinner size={24} />
                <p className={styles.line}>{method === "sso" ? WELCOME_TEXT.waitingSso : WELCOME_TEXT.waitingGoogle}</p>
                <p className={styles.note}>{WELCOME_TEXT.waitingNote}</p>
                <Button variant="secondary" size="large" onClick={onCancel} data-welcome-cancel="">
                  {WELCOME_TEXT.cancel}
                </Button>
              </div>
            )}
          </>
        )}
      </div>
      {screen !== "splash" && <footer className={styles.footer}>{version ? `Designer ${version}` : "Designer"}</footer>}
    </main>
  );
}

/** What a sign-in's failure says: Home's rule (a cancel says nothing; single sign-on's and the server's refusals —
 *  SIGN_IN_ERROR_TEXT — as they are; anything else "Couldn’t log in. Try again."). */
export const welcomeError: (r: SignInResult) => string | null = signInFailure;

/** The part of the account API the welcome page uses (the preload's, or the browser's webAccount) */
export interface WelcomeAccount {
  get(): Promise<AccountState>;
  signIn(opts?: { method?: SignInMethod }): Promise<SignInResult>;
  cancelSignIn(): Promise<AccountState>;
  onChanged(cb: (s: AccountState) => void): () => void;
}

/** The welcome page on an account: its state followed, the buttons signing in, a failure shown until the next try. */
export function WelcomeScreen({ account, version, initialError = null }: { account: WelcomeAccount; version?: string; initialError?: string | null }) {
  const [state, setState] = useState<AccountState | null>(null);
  const [method, setMethod] = useState<SignInMethod | null>(null);
  const [error, setError] = useState<string | null>(initialError);
  useEffect(() => {
    let live = true;
    void account.get().then((s) => live && setState(s));
    const off = account.onChanged((s) => setState(s));
    return () => {
      live = false;
      off();
    };
  }, [account]);
  const signIn = (m: SignInMethod) => {
    setMethod(m);
    setError(null);
    // Waiting shows at once (main's account:changed follows).
    setState((s) => (s ? { ...s, signingIn: true } : s));
    void account.signIn({ method: m }).then(
      (r) => {
        setState(r.state);
        setError(welcomeError(r));
      },
      () => setError("Couldn’t log in. Try again."),
    );
  };
  const cancel = () => void account.cancelSignIn().then(setState);
  return <Welcome state={state} method={method} error={error} version={version} onSignIn={signIn} onCancel={cancel} />;
}
