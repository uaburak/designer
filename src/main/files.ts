import { dialog, type BaseWindow } from "electron";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { exportMime, planExportPaths, safeParts } from "../shared/exportFiles";
import type { ExportAsset, ImportResult } from "../shared/ipc";
import { readyStore } from "./storeHost";
import { EXPORT_RESTRICTED_MESSAGE, mayExportFile } from "./exportAccess";
import { t } from "../shared/i18n";

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
    const options = { title: t("Import"), filters: [{ name: t("Figma files"), extensions: ["fig"] }], properties: ["openFile", "multiSelections"] as Array<"openFile" | "multiSelections"> };
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
      result.failed.push({ path, error: t("Only .fig files can be imported.") });
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
  const dialogOptions = { title: t("Export preview as HTML"), defaultPath: `${safe}.html`, filters: [{ name: t("Web page"), extensions: ["html"] }] };
  const picked = win && !win.isDestroyed() ? await dialog.showSaveDialog(win, dialogOptions) : await dialog.showSaveDialog(dialogOptions);
  if (picked.canceled || !picked.filePath) return { cancelled: true };
  const r = await store.previews.exportHtml(fileKey, { snapshot, options: { ...options, expiresInDays: null } }, picked.filePath);
  return { path: r.path, bytes: r.bytes };
}

/**
 * The file as a .fig where the Save dialog says. `partial` (Figma's "Save partial file", atlas 22 §4): images still
 * downloading are left out and the name says so — "<name> - partial copy <date>", the date's / and _ as -.
 */
export async function saveLocalCopy(win: BaseWindow | null, fileKey: string, opts: { partial?: boolean } = {}): Promise<{ path: string } | { cancelled: true }> {
  const store = await readyStore();
  // A viewer the file's export setting restricts (docs/governance.md §2.7) saves no copy, whichever view asked.
  if (!(await mayExportFile(store.multiplayer, fileKey))) throw new Error(t(EXPORT_RESTRICTED_MESSAGE));
  const file = await store.workspace.getFile(fileKey);
  const safe = (file.name || "Untitled").replace(/[/\\:]/g, "-");
  const name = opts.partial ? partialCopyName(safe, new Date()) : safe;
  const options = { title: t("Save local copy"), defaultPath: `${name}.fig`, filters: [{ name: t("Figma files"), extensions: ["fig"] }] };
  const picked = win && !win.isDestroyed() ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options);
  if (picked.canceled || !picked.filePath) return { cancelled: true };
  await store.files.exportLocalCopy(fileKey, picked.filePath, { partial: opts.partial === true });
  return { path: picked.filePath };
}

/** "<name> - partial copy <date>": the locale's date with its / and _ as - (Figma's save_partial_file_name_suffix; its English isn't read) */
export function partialCopyName(name: string, date: Date): string {
  return `${name} - ${t("partial copy {date}", { date: date.toLocaleDateString().replace(/[/_]/g, "-") })}`;
}

const FORMATS: Record<string, string> = { "image/png": "PNG", "image/jpeg": "JPG", "image/svg+xml": "SVG", "application/pdf": "PDF" };

/**
 * Exported files (Figma's desktop app: "you're prompted to rename the file and choose a location"): one through the
 * Save dialog; more into a folder picked in the Open dialog, each at its planned path (folders for "/" in names,
 * "name1.png" for a name already there, as Figma numbers names in its archive).
 */
export async function exportAssets(win: BaseWindow | null, files: ExportAsset[]): Promise<{ paths: string[] } | { cancelled: true }> {
  const parent = win && !win.isDestroyed() ? win : null;
  if (files.length === 1) {
    const parts = safeParts(files[0].name);
    const file = parts[parts.length - 1];
    const ext = file.includes(".") ? file.slice(file.lastIndexOf(".") + 1) : "";
    const format = FORMATS[exportMime(file)];
    const options = { title: t("Export"), defaultPath: file, filters: format ? [{ name: format, extensions: [ext] }] : [] };
    const picked = parent ? await dialog.showSaveDialog(parent, options) : await dialog.showSaveDialog(options);
    if (picked.canceled || !picked.filePath) return { cancelled: true };
    await writeFile(picked.filePath, files[0].bytes);
    return { paths: [picked.filePath] };
  }
  const options = { title: t("Export"), buttonLabel: t("Export"), properties: ["openDirectory", "createDirectory"] as Array<"openDirectory" | "createDirectory"> };
  const picked = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options);
  if (picked.canceled || !picked.filePaths[0]) return { cancelled: true };
  const folder = picked.filePaths[0];
  const planned = planExportPaths(
    files.map((f) => f.name),
    (rel) => existsSync(join(folder, ...rel.split("/")))
  );
  const paths: string[] = [];
  for (let i = 0; i < files.length; i++) {
    const path = join(folder, ...planned[i].split("/"));
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, files[i].bytes);
    paths.push(path);
  }
  return { paths };
}
