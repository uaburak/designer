import type { MenuCommand } from "@shared/api";

/**
 * The shell (the top page: the tab bar, the home) and its tabs (each open
 * file is a page of its own, in a frame — its keys, its clipboard, its
 * listeners are its own). Same origin: they call each other directly.
 */

/** What a tab tells the shell about itself. */
export interface TabReport {
  title?: string;
  dirty?: boolean;
  status?: "loading" | "ready" | "missing" | "error";
  /** A save went through (ms): the home's list is out of date */
  savedAt?: number;
}

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
  command(command: MenuCommand): void;
}

declare global {
  interface Window {
    designerShell?: ShellBridge;
    designerTab?: TabBridge;
  }
}

/** The shell, from inside a tab — undefined when the tab's page is open on its own. */
export function shellBridge(): ShellBridge | undefined {
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
