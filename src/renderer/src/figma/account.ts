import { signOutUser, useAuth } from "@/lib/auth";
import { shellBridge } from "@/app/bridge";

/** The person using the editor, for the account button at the panel's corner: the signed-in Google account. */
export interface Account {
  photoURL: string | null;
  name: string | null;
  email: string | null;
  signOut: (() => void) | null;
}

export function useAccount(): Account {
  const auth = useAuth();
  if (auth.status !== "signed-in") return { photoURL: null, name: null, email: null, signOut: null };
  // Signing out is the app's (the shell asks about every unsaved tab first).
  const shell = shellBridge();
  return { photoURL: auth.user.photoURL, name: auth.user.displayName, email: auth.user.email, signOut: () => (shell ? shell.signOut() : void signOutUser()) };
}
