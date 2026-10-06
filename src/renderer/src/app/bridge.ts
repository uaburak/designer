import type { TabReport } from "@shared/tabs";
import type { CommandId } from "@shared/commands";
import { desktopAs } from "./native";

/**
 * A file tab's page and the shell (the tab bar, Home, the other tabs).
 *
 * In the desktop app each tab is a view of its own — its own renderer
 * process — and talks to main over IPC (src/shared/ipc.ts) through its
 * preload's `window.designer`: `shellBridge()` is that. In a browser
 * (`npm run web`) the tabs are still same-origin iframes of the shell page
 * (app/Shell.tsx), and `shellBridge()` is the parent's `designerShell`.
 *
 * The other way, the tab's page registers `window.designerTab` (save, is it
 * unsaved, a menu command); tab/host.ts answers main's questions from it.
 */

export type { TabReport };

/** What a tab may ask of the shell. */
export interface ShellBridge {
  report(tabId: string, report: TabReport): void;
  openProject(slug: string): void;
  openPreview(slug: string): void;
  goHome(): void;
  closeTab(tabId: string): void;
  /** Signing out — the shell asks about every unsaved tab first */
  signOut(): void;
}

/** What the shell may ask of a tab. */
export interface TabBridge {
  /** Save what is unsaved: true when all of it is saved after */
  save(): Promise<boolean>;
  isDirty(): boolean;
  /** A menu command (Undo, Redo…): true when the page did it itself */
  command(command: CommandId): boolean | void;
}

declare global {
  interface Window {
    designerShell?: ShellBridge;
    designerTab?: TabBridge;
  }
}

let ipcShell: ShellBridge | undefined;

/** The shell, from inside a tab — undefined when the tab's page is open on its own. */
export function shellBridge(): ShellBridge | undefined {
  const api = desktopAs.editor();
  if (api) {
    // main knows which view speaks: the tab id the page passes is not needed (nor trusted).
    ipcShell ??= {
      report: (_tabId, report) => api.tab.report(report),
      openProject: (slug) => void api.nav.openFile({ kind: "project", slug }),
      openPreview: (slug) => void api.nav.openFile({ kind: "preview", slug, title: `${slug} — Preview` }),
      goHome: () => api.nav.goHome(),
      closeTab: () => api.tab.close(),
      signOut: () => api.session.requestSignOut(),
    };
    return ipcShell;
  }
  try {
    return window.parent !== window ? window.parent.designerShell : undefined;
  } catch {
    return undefined;
  }
}

const params = typeof location !== "undefined" ? new URLSearchParams(location.search) : new URLSearchParams();

/** This page as a tab: its id, what it opens. */
export const tabParams = {
  id: params.get("tab") ?? "",
  kind: params.get("kind") ?? "",
  slug: params.get("slug") ?? "",
};
