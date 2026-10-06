import { useEffect, useState } from "react";
import { GoogleAuthProvider, onAuthStateChanged, signInWithCredential, signInWithPopup, signOut, type User } from "firebase/auth";
import { auth } from "@/lib/firebase";
import { native } from "@/app/native";

/**
 * Who may use the app: these Google accounts (their verified emails). The
 * same list is in the site's firestore.rules and storage.rules — what really
 * keeps the data safe; this one only decides what the app shows.
 */
export const ADMIN_EMAILS = ["design.burakkoc@gmail.com"];

export const isAdmin = (user: User | null) => Boolean(user?.email && user.emailVerified && ADMIN_EMAILS.includes(user.email.toLowerCase()));

export type AuthState = { status: "loading" } | { status: "signed-out" } | { status: "signed-in"; user: User; admin: boolean };

/** The signed-in user, as Firebase Auth tells it (it remembers the sign-in on this computer). */
export function useAuth(): AuthState {
  const [state, setState] = useState<AuthState>({ status: "loading" });
  useEffect(() => onAuthStateChanged(auth, (user) => setState(user ? { status: "signed-in", user, admin: isAdmin(user) } : { status: "signed-out" })), []);
  return state;
}

/**
 * Sign in with Google. The desktop app: in the system's browser (Google
 * doesn't sign in inside an app's web view — see main/signIn.ts), the
 * credential it brings back signed in with here. A browser: Firebase's popup.
 */
export async function signInWithGoogle(): Promise<void> {
  const desktop = native();
  if (desktop) {
    const { idToken, accessToken } = await desktop.signInWithGoogle();
    await signInWithCredential(auth, GoogleAuthProvider.credential(idToken, accessToken ?? undefined));
    return;
  }
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: "select_account" });
  await signInWithPopup(auth, provider);
}

/** A sign-in waiting in the browser, given up. */
export const cancelSignIn = () => native()?.cancelSignIn();

export const signOutUser = () => signOut(auth);
