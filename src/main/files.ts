import { dialog, type BaseWindow } from "electron";
import { isAbsolute } from "node:path";
import type { ImportResult } from "../shared/ipc";
import { readyStore } from "./storeHost";

/**
 * What needs a native dialog or a path (docs/desktop.md §10.2 "Files and
 * native dialogs"): importing .fig files and saving a local copy. The views
 * never name a path to the store; main asks the system's dialog, then main's
 * own store client does the work (`files.importLocalCopy`, `exportLocalCopy`).
 */

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** .fig files into a folder (null: Drafts): the given paths (dropped on Home), or the ones picked in the Open dialog. */
export async function importFiles(win: BaseWindow | null, folderId: string | null, paths?: string[]): Promise<ImportResult> {
  let list = paths;
  if (!list) {
    const options = { title: "Import", filters: [{ name: "Figma files", extensions: ["fig"] }], properties: ["openFile", "multiSelections"] as Array<"openFile" | "multiSelections"> };
    const picked = win && !win.isDestroyed() ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
    if (picked.canceled) return { files: [], failed: [] };
    list = picked.filePaths;
  }
  const result: ImportResult = { files: [], failed: [] };
  const usable = list.filter((p) => typeof p === "string" && isAbsolute(p)).slice(0, 200);
  if (!usable.length) return result;
  const store = await readyStore();
  for (const path of usable) {
    if (!path.toLowerCase().endsWith(".fig")) {
      result.failed.push({ path, error: "Only .fig files can be imported." });
      continue;
    }
    try {
      const meta = await store.files.importLocalCopy(path, folderId);
      result.files.push({ fileKey: meta.fileKey, name: meta.name });
    } catch (err) {
      result.failed.push({ path, error: message(err) });
    }
  }
  return result;
}

/** A developer preview as one HTML file where the Save dialog says (docs/data.md §13); the store writes it. */
export async function exportPreview(
  win: BaseWindow | null,
  fileKey: string,
  snapshot: Uint8Array,
  options: { pageIds: string[] | "all"; inspect: boolean; export: boolean },
): Promise<{ path: string; bytes: number } | { cancelled: true }> {
  const store = await readyStore();
  const file = await store.workspace.getFile(fileKey);
  const safe = (file.name || "Untitled").replace(/[/\\:]/g, "-");
  const dialogOptions = { title: "Export preview as HTML", defaultPath: `${safe}.html`, filters: [{ name: "Web page", extensions: ["html"] }] };
  const picked = win && !win.isDestroyed() ? await dialog.showSaveDialog(win, dialogOptions) : await dialog.showSaveDialog(dialogOptions);
  if (picked.canceled || !picked.filePath) return { cancelled: true };
  const r = await store.previews.exportHtml(fileKey, { snapshot, options: { ...options, expiresInDays: null } }, picked.filePath);
  return { path: r.path, bytes: r.bytes };
}

/** The file as a .fig where the Save dialog says. */
export async function saveLocalCopy(win: BaseWindow | null, fileKey: string): Promise<{ path: string } | { cancelled: true }> {
  const store = await readyStore();
  const file = await store.workspace.getFile(fileKey);
  const safe = (file.name || "Untitled").replace(/[/\\:]/g, "-");
  const options = { title: "Save local copy", defaultPath: `${safe}.fig`, filters: [{ name: "Figma files", extensions: ["fig"] }] };
  const picked = win && !win.isDestroyed() ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options);
  if (picked.canceled || !picked.filePath) return { cancelled: true };
  await store.files.exportLocalCopy(fileKey, picked.filePath);
  return { path: picked.filePath };
}
