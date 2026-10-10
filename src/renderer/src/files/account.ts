/**
 * Home's account (docs/multiplayer.md §2): the sidebar's account row shows who is signed in to the multiplayer server
 * and opens Figma's account menu — Log in / Log out. Main does the sign-in in the system browser; Home only asks.
 */
import { useEffect, useState } from "react";
import type { AccountState, SignInResult } from "@shared/account";
import type { MenuEntry } from "@/ds";
import { storeMode } from "../store";
import { webAccount } from "../store/webAccount";

/** The part of the preload API used here (absent in a plain browser: no account there). */
interface AccountBridge {
  get(): Promise<AccountState>;
  signIn(): Promise<SignInResult>;
  cancelSignIn(): Promise<AccountState>;
  signOut(): Promise<AccountState>;
  onChanged(cb: (s: AccountState) => void): () => void;
}

/** The desktop app's preload, or the page's own sign-in in a plain browser (docs/multiplayer.md §2). */
const bridge = (): AccountBridge | null => {
  if (typeof window === "undefined") return null;
  const desktop = (window as unknown as { designer?: { account?: AccountBridge } }).designer?.account;
  if (desktop) return desktop;
  return storeMode() === "dev" && typeof crypto !== "undefined" && !!crypto.subtle ? webAccount : null;
};

export type AccountMenuId = "log-in" | "cancel-log-in" | "log-out";

/** Figma's account menu: the email over Log out when signed in; Log in otherwise (a waiting sign-in can be cancelled). */
export function accountMenu(state: AccountState | null): MenuEntry[] {
  if (!state) return [];
  if (state.user) return [{ header: state.user.email }, { id: "log-out", label: "Log out" }];
  if (state.signingIn) return [{ id: "waiting", label: "Waiting for the browser…", disabled: true }, { id: "cancel-log-in", label: "Cancel" }];
  return [{ id: "log-in", label: "Log in with Google…" }];
}

/** Sign-in failures worth a toast (a cancel isn't one). */
export function signInFailure(r: SignInResult): string | null {
  if (r.ok || r.error === "cancelled") return null;
  return r.error === "timeout" ? "Log in timed out. Try again." : "Couldn’t log in. Try again.";
}

export function useAccount() {
  const [state, setState] = useState<AccountState | null>(null);
  useEffect(() => {
    const b = bridge();
    if (!b) return;
    let live = true;
    void b.get().then((s) => live && setState(s));
    const off = b.onChanged((s) => setState(s));
    return () => {
      live = false;
      off();
    };
  }, []);
  return {
    state,
    available: bridge() !== null,
    /** Runs a menu choice; resolves to a failure message for a toast, if any */
    async run(id: string): Promise<string | null> {
      const b = bridge();
      if (!b) return null;
      if (id === "log-in") return signInFailure(await b.signIn());
      if (id === "cancel-log-in") await b.cancelSignIn();
      if (id === "log-out") await b.signOut();
      return null;
    },
  };
}
