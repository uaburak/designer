/**
 * The signed-in account's profile for Settings (`GET /me/profile`), changed with `PATCH /me/profile`; null while
 * loading or signed out.
 */
import { useCallback, useEffect, useState } from "react";
import { showToast } from "@/ds";
import type { AccountProfile, ProfilePatch } from "@shared/account";
import { useAccount } from "../files/account";
import { accountCall } from "./bridge";

export function useProfile() {
  const account = useAccount();
  const userId = account.state?.user?.id ?? null;
  const [profile, setProfile] = useState<AccountProfile | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!userId) return;
    let live = true;
    accountCall<AccountProfile>("GET", "/me/profile").then(
      (p) => {
        if (!live) return;
        setProfile(p);
        setError(null);
      },
      (e: unknown) => live && setError(e instanceof Error ? e.message : String(e)),
    );
    return () => {
      live = false;
    };
  }, [userId]);
  /** Saves a change; the new profile, or null after a toast with the server's reason. */
  const save = useCallback(async (patch: ProfilePatch): Promise<AccountProfile | null> => {
    try {
      const p = await accountCall<AccountProfile>("PATCH", "/me/profile", patch);
      setProfile(p);
      return p;
    } catch (e) {
      showToast({ kind: "error", message: e instanceof Error ? e.message : String(e) });
      return null;
    }
  }, []);
  return { account, profile: userId && profile?.id === userId ? profile : null, error: userId ? error : null, save };
}
