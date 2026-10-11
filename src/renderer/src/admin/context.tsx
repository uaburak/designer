/**
 * What every Admin view shares: the org, the repositories, a change counter that makes every list reload after a
 * write, the CSV hand-off, and `run` (a write with its error shown as a toast).
 */
import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { showToast } from "@/ds";
import type { SharedFontsApi } from "@shared/desktop";
import type { OrgLibrariesRepository } from "@shared/libraries/orgTypes";
import type { AdminRepository, IdentityRepository, OrgsRepository, TeamsRepository } from "@shared/org/repositories";

export type AdminTeamsApi = Pick<TeamsRepository, "restore" | "remove" | "update">;
export interface AdminStore {
  admin: AdminRepository;
  /** User groups (Admin › People › User groups); absent: the tab says it's unavailable */
  orgs?: OrgsRepository;
  /** Restoring deleted teams and hiding teams; absent: those actions are hidden */
  teams?: AdminTeamsApi;
  /** Admin › Resources › Libraries and a workspace's Libraries (docs/data.md §16.10); absent: those say they're unavailable */
  orgLibraries?: OrgLibrariesRepository;
  /** Admin › Settings › Login and provisioning and Data storage localization (docs/multiplayer.md §15.13); absent: those rows say they're unavailable */
  identity?: IdentityRepository;
}

/** The workspace a workspace admin (not an org admin) manages: Admin › ‹workspace› › Libraries */
export interface AdminWorkspaceScope {
  id: string;
  name: string;
}

export interface AdminCtx {
  orgId: string;
  store: AdminStore;
  /** Bumped after every write: lists reload */
  version: number;
  changed: () => void;
  /** Runs a write; its error becomes a toast; resolves to undefined on failure */
  run: <T>(write: () => Promise<T>, done?: string) => Promise<T | undefined>;
  exportCsv: (what: "people" | "teams" | "activity", query?: unknown) => Promise<void>;
  now: () => number;
  /** Admin › Resources › Fonts: the preload's shared-fonts API (docs/desktop.md §14.3) */
  fonts?: SharedFontsApi;
  /** Set when the viewer administers only this workspace */
  workspace?: AdminWorkspaceScope;
  /** SAML SSO › Test: a sign-in through the org's IdP (`designer.account.signIn({tenant})`); absent: Test is disabled */
  onTestSso?: (tenantId: string) => Promise<unknown>;
}

export const AdminContext = createContext<AdminCtx | null>(null);
export function useAdmin(): AdminCtx {
  const c = useContext(AdminContext);
  if (!c) throw new Error("Admin views need <AdminApp>");
  return c;
}

const FILE_NAMES = { people: "people", teams: "teams", activity: "activity" } as const;

/** Saves the CSV the default way in a browser: a download link (Electron's will-download shows the Save dialog). */
export function downloadCsv(fileName: string, csv: string): void {
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function useAdminState(orgId: string, store: AdminStore, onExportCsv: ((fileName: string, csv: string) => void) | undefined, now: () => number, fonts?: SharedFontsApi, workspace?: AdminWorkspaceScope, onTestSso?: (tenantId: string) => Promise<unknown>): AdminCtx {
  const [version, setVersion] = useState(0);
  const changed = useCallback(() => setVersion((v) => v + 1), []);
  const run = useCallback(async <T,>(write: () => Promise<T>, done?: string) => {
    try {
      const out = await write();
      changed();
      if (done) showToast({ message: done });
      return out;
    } catch (e) {
      showToast({ message: e instanceof Error ? e.message : String(e), kind: "error" });
      return undefined;
    }
  }, [changed]);
  const exportCsv = useCallback(async (what: "people" | "teams" | "activity", query?: unknown) => {
    const csv = await run(() => store.admin.exportCsv(orgId, what, query));
    if (csv === undefined) return;
    const stamp = new Date(now()).toISOString().slice(0, 10);
    (onExportCsv ?? downloadCsv)(`${FILE_NAMES[what]}-${stamp}.csv`, csv);
  }, [orgId, store, run, onExportCsv, now]);
  return { orgId, store, version, changed, run, exportCsv, now, fonts, workspace, onTestSso };
}

/** Loads with `load` whenever `deps` or the Admin's version change; keeps the last value while reloading. */
export function useLoad<T>(load: () => Promise<T>, deps: unknown[]): { data: T | undefined; error: string | null } {
  const { version } = useAdmin();
  const [state, setState] = useState<{ data: T | undefined; error: string | null }>({ data: undefined, error: null });
  useEffect(() => {
    let live = true;
    load().then(
      (data) => live && setState({ data, error: null }),
      (e: unknown) => live && setState((s) => ({ data: s.data, error: e instanceof Error ? e.message : String(e) }))
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version, ...deps]);
  return state;
}
