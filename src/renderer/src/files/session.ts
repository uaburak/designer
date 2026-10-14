/**
 * Home's part of the session's end (docs/multiplayer.md §15.8, §15.18; docs/desktop.md §18.2):
 *
 * - the store's `session` event (`multiplayer.watchSession`): the server refused the session (401) — `idle_timeout`
 *   is the idle logout ("You were logged out because you were inactive."), `expired` any other end of it (signed out
 *   everywhere, the row deleted in Settings, its token's age). Both sign the account out: the store already dropped the
 *   session, main (or the web page) forgets it too, so Home shows the signed-out state;
 * - in a plain browser, the sign-in that came back with this page load (Google or SSO — single sign-on's refusals say
 *   why, `SIGN_IN_ERROR_TEXT`).
 */
import { useEffect } from "react";
import type { ToastOptions } from "@/ds";
import { t } from "@/i18n";
import { toastIdleLoggedOut } from "../account/IdleWarning";
import { webSignInResult } from "../store/webAccount";
import { accountBridge, signInFailure } from "./account";
import type { FilesBackend } from "./storeAccess";

/** The toast when the server ended the session for another reason than inactivity (ours: Figma's isn't documented) */
export const SESSION_ENDED_TEXT = "You were logged out. Log in again to work on shared files.";

export function useSessionNotices(backend: Pick<FilesBackend, "watchSession" | "source">, toast: (o: ToastOptions) => void): void {
  const { watchSession, source } = backend;
  useEffect(() => {
    let live = true;
    const off = watchSession?.((e) => {
      if (!live) return;
      void accountBridge()?.signOut();
      if (e.reason === "idle_timeout") toastIdleLoggedOut(toast);
      else toast({ message: t(SESSION_ENDED_TEXT) });
    });
    if (source === "dev")
      void webSignInResult().then((r) => {
        const failure = r && live ? signInFailure(r) : null;
        if (failure) toast({ kind: "error", message: failure });
      });
    return () => {
      live = false;
      off?.();
    };
  }, [watchSession, source, toast]);
}
