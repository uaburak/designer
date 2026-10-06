import { useEffect, useState, type ReactNode } from "react";
import type { User } from "firebase/auth";
import { cancelSignIn, signInWithGoogle, signOutUser, useAuth, ADMIN_EMAILS } from "@/lib/auth";
import { AppMark } from "./icons";
import { isMac, native } from "./native";
import { Button, Spinner } from "./ui";

/**
 * The legacy sign-in gate: its children only for the site's admin, the
 * sign-in otherwise. `onAdmin` hears whether an admin is in (Home tells main).
 */
export function AuthGate({ children, dragStrip = false, onAdmin }: { children: (user: User) => ReactNode; dragStrip?: boolean; onAdmin?: (admin: boolean) => void }) {
  const auth = useAuth();
  const admin = auth.status === "signed-in" && auth.admin;
  useEffect(() => {
    if (auth.status !== "loading") onAdmin?.(admin);
  }, [auth.status, admin, onAdmin]);
  if (auth.status === "signed-in" && auth.admin) return <>{children(auth.user)}</>;
  return (
    <div className="flex flex-col h-full bg-[var(--f-bg)] text-[var(--f-text)] select-none">
      {/* The window moves by its top, as everywhere in the app. */}
      {dragStrip && <div className="app-drag h-[var(--tabbar-height)] shrink-0" />}
      <div className={`flex-1 min-h-0 flex items-center justify-center px-6 ${dragStrip ? "pb-[var(--tabbar-height)]" : ""}`}>
        {auth.status === "loading" ? <Spinner /> : auth.status === "signed-in" ? <NotAdmin email={auth.user.email} /> : <SignIn />}
      </div>
    </div>
  );
}

/** What a failed sign-in says. */
function failure(err: unknown): string {
  const code = (err as { code?: string }).code;
  const message = err instanceof Error ? err.message : String(err);
  if (message.includes("cancelled")) return "";
  if (code === "auth/popup-closed-by-user" || code === "auth/cancelled-popup-request") return "";
  if (code === "auth/network-request-failed") return "Offline — check the connection and try again.";
  if (code === "auth/unauthorized-domain") return `This address (${window.location.hostname}) isn't an authorized domain in Firebase Authentication.`;
  if (code === "auth/invalid-credential") return "Google's answer couldn't be used — try again.";
  return message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
}

function SignIn() {
  const [waiting, setWaiting] = useState(false);
  const [error, setError] = useState("");
  const desktop = Boolean(native());
  const start = async () => {
    setWaiting(true);
    setError("");
    try {
      await signInWithGoogle();
    } catch (err) {
      setError(failure(err));
      setWaiting(false);
    }
  };
  return (
    <div className="flex flex-col items-center w-[320px] text-center">
      <AppMark size={56} />
      <h1 className="mt-5 text-[20px] font-[600] leading-7 tracking-[-0.01em]">Sign in to DesignerV2</h1>
      <p className="mt-1.5 text-[13px] leading-5 text-[var(--f-text-secondary)]">burakkoc.net’s design tool. Use the Google account that runs the site.</p>
      {waiting && desktop ? (
        <div className="mt-6 flex flex-col items-center gap-3 w-full">
          <div className="flex items-center gap-2 text-[13px] leading-5">
            <Spinner size={16} />
            Continue in your browser to sign in…
          </div>
          <Button
            kind="ghost"
            onClick={() => {
              cancelSignIn();
              setWaiting(false);
            }}
          >
            Cancel
          </Button>
        </div>
      ) : (
        <Button kind="secondary" className="mt-6 w-full h-10 gap-2.5" disabled={waiting} onClick={() => void start()}>
          <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden>
            <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 13 4 4 13 4 24s9 20 20 20 20-9 20-20c0-1.3-.1-2.4-.4-3.5z" />
            <path fill="#FF3D00" d="m6.3 14.7 6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" />
            <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-7.9l-6.5 5C9.5 39.6 16.2 44 24 44z" />
            <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z" />
          </svg>
          Continue with Google
        </Button>
      )}
      {error && <p className="mt-3 text-[12px] leading-4 text-[#f24822]">{error}</p>}
      {desktop && !waiting && <p className="mt-4 text-[11px] leading-4 text-[var(--f-text-tertiary)]">Google’s sign-in opens in your browser{isMac ? "" : " window"}; you’ll come back here once it’s done.</p>}
    </div>
  );
}

function NotAdmin({ email }: { email: string | null }) {
  return (
    <div className="flex flex-col items-center w-[340px] text-center">
      <AppMark size={56} />
      <h1 className="mt-5 text-[20px] font-[600] leading-7 tracking-[-0.01em]">This account can’t use DesignerV2</h1>
      <p className="mt-1.5 text-[13px] leading-5 text-[var(--f-text-secondary)]">
        {email ?? "This account"} isn’t the site’s admin. Sign in with {ADMIN_EMAILS.length === 1 ? ADMIN_EMAILS[0] : "the admin account"}.
      </p>
      <Button className="mt-6" onClick={() => void signOutUser()}>Sign out</Button>
    </div>
  );
}
