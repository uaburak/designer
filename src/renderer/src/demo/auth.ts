import { useSyncExternalStore } from "react";
import type { User } from "firebase/auth";
import type * as Real from "@/lib/auth";

/**
 * The demo's sign-in (`--mode demo`): a made-up admin, signed in until
 * "Sign out" — then "Continue with Google" signs straight back in. No Google,
 * no Firebase.
 */

export type { AuthState } from "@/lib/auth";

const KEY = "designer-demo-signed-out";
const EVENT = "designer-demo-auth";

const DEMO_USER = { uid: "demo", displayName: "Demo Designer", email: "demo@designer.local", emailVerified: true, photoURL: null, isAnonymous: false, providerData: [] } as unknown as User;

const signedOut = () => {
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
};
const subscribe = (cb: () => void) => {
  const other = (e: StorageEvent) => e.key === KEY && cb();
  window.addEventListener(EVENT, cb);
  window.addEventListener("storage", other);
  return () => {
    window.removeEventListener(EVENT, cb);
    window.removeEventListener("storage", other);
  };
};
const setSignedOut = (out: boolean) => {
  try {
    if (out) localStorage.setItem(KEY, "1");
    else localStorage.removeItem(KEY);
  } catch {
    /* this page only */
  }
  window.dispatchEvent(new Event(EVENT));
};

export const ADMIN_EMAILS: typeof Real.ADMIN_EMAILS = ["demo@designer.local"];
export const isAdmin: typeof Real.isAdmin = (user) => Boolean(user);

const SIGNED_IN = { status: "signed-in", user: DEMO_USER, admin: true } as const;
const SIGNED_OUT = { status: "signed-out" } as const;

export const useAuth: typeof Real.useAuth = () => (useSyncExternalStore(subscribe, signedOut, () => false) ? SIGNED_OUT : SIGNED_IN);
export const signInWithGoogle: typeof Real.signInWithGoogle = async () => setSignedOut(false);
export const cancelSignIn: typeof Real.cancelSignIn = () => undefined;
export const signOutUser: typeof Real.signOutUser = async () => setSignedOut(true);
