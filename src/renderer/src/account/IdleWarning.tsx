/**
 * The idle session timeout's prompt (docs/desktop.md §18.2; help.figma.com 14376092335127 — "a prompt to stay logged in
 * when less than one minute remains"): main (the desktop app) or the web page's own timer (store/webAccount.ts) says
 * `warning` with the deadline; the modal counts down — **Stay logged in** posts the activity, **Log out** signs out now.
 * `cleared` (input anywhere, Stay in another view) closes it; `logged-out` shows the toast. Figma documents the prompt
 * but not its words: these are ours (to be replaced by Figma's when seen). Rendered once by Home and by each editor.
 */
import { useEffect, useState } from "react";
import { Button, Dialog, showToast, type ToastOptions } from "@/ds";
import type { IdleNotice } from "@shared/ipc";
import { accountBridge } from "../files/account";
import styles from "./IdleWarning.module.css";

/** The toast after an idle logout (docs/desktop.md §18.2) */
export const IDLE_LOGGED_OUT_TEXT = "You were logged out because you were inactive.";

let lastLoggedOutToast = 0;
/** Shown once even when main's notice and the store's `session` event both say it (within a few seconds) */
export function toastIdleLoggedOut(toast: (o: ToastOptions) => void = showToast): void {
  const now = Date.now();
  if (now - lastLoggedOutToast < 5000) return;
  lastLoggedOutToast = now;
  toast({ message: IDLE_LOGGED_OUT_TEXT });
}

/** "in 42 seconds" / "in 1 second" */
export function idleWarningText(seconds: number): string {
  return `For your security, you’ll be logged out in ${seconds} ${seconds === 1 ? "second" : "seconds"} because you’ve been inactive.`;
}

export function IdleWarning({ toast = showToast }: { toast?: (o: ToastOptions) => void } = {}) {
  const [logoutAt, setLogoutAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const b = accountBridge();
    if (!b?.onIdle) return;
    return b.onIdle((n: IdleNotice) => {
      if (n.state === "warning") {
        setNow(Date.now());
        setLogoutAt(n.logoutAt);
      } else {
        setLogoutAt(null);
        if (n.state === "logged-out") toastIdleLoggedOut(toast);
      }
    });
  }, [toast]);

  useEffect(() => {
    if (logoutAt === null) return;
    const t = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(t);
  }, [logoutAt]);

  if (logoutAt === null) return null;
  const seconds = Math.max(0, Math.ceil((logoutAt - now) / 1000));
  const stay = () => {
    setLogoutAt(null);
    void accountBridge()?.staySignedIn?.();
  };
  const logOut = () => {
    setLogoutAt(null);
    void accountBridge()?.signOut();
  };
  return (
    <Dialog
      title="Are you still there?"
      size="small"
      open
      // Esc or a click outside is someone here: staying.
      onClose={stay}
      footer={
        <>
          <Button variant="secondary" onClick={logOut} data-idle="log-out">
            Log out
          </Button>
          <Button variant="primary" onClick={stay} data-idle="stay" data-autofocus="">
            Stay logged in
          </Button>
        </>
      }
    >
      <p className={styles.text} data-idle-warning="">
        {idleWarningText(seconds)}
      </p>
    </Dialog>
  );
}
