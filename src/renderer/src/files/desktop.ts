/**
 * What Home asks of the shell (docs/desktop.md §10, `HomeApi` in src/shared/desktop.ts): opening a file in a tab,
 * a new design file, importing `.fig`s, the menu bar's commands. In the desktop app these go through
 * `window.designer` (main opens tabs, shows the Open dialog and calls the store's import, which needs a path); in a
 * plain browser a file opens as `?editor&file=<fileKey>`.
 */
import type { WorkspaceRepository } from "@shared/store/repositories";
import type { FileKey, FolderId } from "@shared/store/types";

export interface ImportResult {
  files: { fileKey: FileKey; name: string }[];
  failed: { path: string; error: string }[];
}

/** The parts of Home's preload API used here (a structural subset of `HomeApi`, so Home also runs without it). */
interface HomeBridge {
  role?: string;
  nav?: {
    openFile?: (fileKey: string, options?: { title?: string; background?: boolean }) => Promise<unknown>;
    newFile?: (folderId?: string | null, name?: string) => Promise<{ fileKey: string; tabId: string } | null>;
  };
  files?: {
    import?: (folderId: string | null, paths?: string[]) => Promise<ImportResult>;
    saveLocalCopy?: (fileKey: string) => Promise<{ path: string } | { cancelled: true }>;
  };
  home?: { onReveal?: (cb: (r: { fileKey: string }) => void) => () => void };
  menu?: { onCommand?: (cb: (c: { id: string }) => void) => () => void; setState?: (patch: { enabled?: Record<string, boolean>; checked?: Record<string, boolean> }) => void };
}

const bridge = (): HomeBridge | null => (typeof window === "undefined" ? null : ((window as unknown as { designer?: HomeBridge }).designer ?? null));

/** The browser's address of a file (the `?editor` route). */
export const editorUrl = (fileKey: FileKey) => `${location.pathname}?editor&file=${encodeURIComponent(fileKey)}`;

export interface OpenDeps {
  /** In a browser nothing activates a tab, so Home records the view itself (in the app main does, docs/desktop.md §5) */
  workspace?: Pick<WorkspaceRepository, "recordViewed">;
  /** Navigation, replaceable in tests */
  navigate?: (url: string, newTab: boolean) => void;
}

const browserNavigate = (url: string, newTab: boolean) => {
  if (newTab) window.open(url, "_blank", "noopener");
  else location.assign(url);
};

/**
 * Opens a file: in the app, its tab (an open one comes to the front; "Open in new tab" leaves Home in front), else
 * the editor page (a new browser tab for "Open in new tab").
 */
export async function openFile(fileKey: FileKey, { newTab = false, title }: { newTab?: boolean; title?: string } = {}, deps: OpenDeps = {}): Promise<void> {
  const d = bridge();
  if (d?.nav?.openFile) {
    await d.nav.openFile(fileKey, { title, background: newTab });
    return;
  }
  await deps.workspace?.recordViewed(fileKey).catch(() => {});
  (deps.navigate ?? browserNavigate)(editorUrl(fileKey), newTab);
}

/** "New design file": `Untitled` in Drafts or the folder shown, opened at once (docs/data.md §4). */
export async function newDesignFile(folderId: FolderId | null, workspace: Pick<WorkspaceRepository, "createFile" | "recordViewed">, deps: OpenDeps = {}): Promise<FileKey | null> {
  const d = bridge();
  if (d?.nav?.newFile) {
    const r = await d.nav.newFile(folderId);
    if (r) return r.fileKey;
  }
  const meta = await workspace.createFile({ folderId });
  await openFile(meta.fileKey, { title: meta.name }, { workspace, ...deps });
  return meta.fileKey;
}

/** Import in the app: main shows the Open dialog and imports each `.fig` into the folder. Null without the shell. */
export async function importWithShell(folderId: FolderId | null): Promise<ImportResult | null> {
  const d = bridge();
  if (!d?.files?.import) return null;
  return d.files.import(folderId);
}

/** "Save local copy…" in the app (main's Save dialog, then the store's export). Null without the shell. */
export async function saveLocalCopy(fileKey: FileKey): Promise<{ path: string } | { cancelled: true } | null> {
  const d = bridge();
  return d?.files?.saveLocalCopy ? d.files.saveLocalCopy(fileKey) : null;
}

/** The browser's file picker for `.fig` files. */
export function pickFigFiles(): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".fig";
    input.multiple = true;
    input.style.display = "none";
    input.addEventListener("change", () => {
      resolve([...(input.files ?? [])]);
      input.remove();
    });
    input.addEventListener("cancel", () => {
      resolve([]);
      input.remove();
    });
    document.body.appendChild(input);
    input.click();
  });
}

/** The menu bar's commands for Home (`menu:command`): Edit ▸ Select all / Delete, File ▸ Duplicate / Rename… */
export function onShellCommand(cb: (id: string) => void): () => void {
  return bridge()?.menu?.onCommand?.((c) => cb(String(c.id))) ?? (() => {});
}

/** Which of Home's menu-bar commands are enabled now (`menu:state`). */
export function setMenuState(enabled: Record<string, boolean>): void {
  bridge()?.menu?.setState?.({ enabled });
}

/** "Show in file browser" / an editor's "Back to files": main asks Home to show a file. */
export function onReveal(cb: (fileKey: FileKey) => void): () => void {
  return bridge()?.home?.onReveal?.((r) => cb(String(r.fileKey))) ?? (() => {});
}
