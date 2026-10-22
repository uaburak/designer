/**
 * Home's file tools for an MCP session with no design file open (an outside client at Home): list_files, create_file
 * and file_action run in main against the store's workspace — the same answers the editor's copy gives
 * (src/renderer/src/editor/agents/appTools.ts filesTool) — so a client can find, make and open a file from Home.
 */
import type { FileQuery } from "../../shared/store/repositories";
import type { ToolResult } from "../../shared/agents/tools";
import { textResult } from "../../shared/agents/tools";
import { readyStore } from "../storeHost";
import { controllers } from "../window";

export const HOME_TOOL_NAMES = new Set(["list_files", "create_file", "file_action"]);

const str = (v: unknown, name: string): string => {
  if (typeof v !== "string" || !v.trim()) throw new Error(`${name} is required`);
  return v.slice(0, 200);
};
const opt = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.slice(0, 200) : undefined);
const iso = (t: number | null | undefined) => (t ? new Date(t).toISOString() : null);

/** Opens a file in the window in front (a tab of its own), as Home's double-click does. */
export function openFileTab(fileKey: string, title?: string): void {
  const list = [...controllers.values()];
  const ctl = list.find((c) => c.win.isFocused()) ?? list[0];
  if (!ctl) throw new Error("No Wecra window is open.");
  ctl.tabs.openFile({ fileKey, ...(title ? { title } : {}) });
}

/** The tool's result and, for create_file {open} / file_action open, the file it opened. */
export async function runHomeTool(name: string, args: Record<string, unknown>): Promise<{ result: ToolResult; opened?: string }> {
  const ws = (await readyStore()).workspace;
  if (name === "list_files") {
    const where = String(args.in ?? "recents");
    const q: FileQuery =
      where === "folder" ? { in: "folder", folderId: str(args.folderId, "folderId") } : where === "search" ? { in: "search", text: str(args.text, "text") } : where === "drafts" || where === "starred" || where === "trash" ? { in: where } : { in: "recents" };
    const [files, folders] = await Promise.all([ws.listFiles(q), ws.listFolders()]);
    return {
      result: textResult({
        in: q.in,
        files: files.slice(0, 500).map((f) => ({ fileKey: f.fileKey, name: f.name, folderId: f.folderId, updatedAt: iso(f.updatedAt), starred: f.starred, ...(f.trashedAt ? { trashed: true } : {}) })),
        folders: folders.filter((f) => !f.trashedAt || where === "trash").map((f) => ({ folderId: f.id, name: f.name, parentId: f.parentId, ...(f.trashedAt ? { trashed: true } : {}) })),
      }),
    };
  }
  if (name === "create_file") {
    const meta = await ws.createFile({ name: opt(args.name), folderId: opt(args.folderId) ?? null });
    if (args.open === true) openFileTab(meta.fileKey, meta.name);
    return { result: textResult({ created: { fileKey: meta.fileKey, name: meta.name, folderId: meta.folderId }, ...(args.open === true ? { note: "Opened; your tools now work on it." } : {}) }), ...(args.open === true ? { opened: meta.fileKey } : {}) };
  }
  const keys = (): string[] => {
    const list = Array.isArray(args.fileKeys) ? (args.fileKeys as unknown[]).filter((x): x is string => typeof x === "string") : [];
    if (opt(args.fileKey)) list.push(String(args.fileKey));
    return list;
  };
  const folderIds = () => (Array.isArray(args.folderIds) ? (args.folderIds as unknown[]).filter((x): x is string => typeof x === "string") : []);
  switch (String(args.action ?? "")) {
    case "open": {
      const k = str(args.fileKey, "fileKey");
      const f = await ws.getFile(k);
      openFileTab(k, f.name);
      return { result: textResult({ opened: k, name: f.name, note: "Opened; your tools now work on it." }), opened: k };
    }
    case "rename": {
      const meta = await ws.renameFile(str(args.fileKey, "fileKey"), str(args.name, "name").trim());
      return { result: textResult({ renamed: { fileKey: meta.fileKey, name: meta.name } }) };
    }
    case "duplicate": {
      const copy = await ws.duplicateFile(str(args.fileKey, "fileKey"));
      return { result: textResult({ duplicated: { fileKey: copy.fileKey, name: copy.name } }) };
    }
    case "move": {
      const list = keys();
      if (!list.length) throw new Error("fileKeys: which files to move");
      const folderId = args.folderId === null || args.folderId === undefined || args.folderId === "" ? null : String(args.folderId);
      await ws.moveFiles(list, folderId);
      return { result: textResult({ moved: list, to: folderId ?? "Drafts" }) };
    }
    case "star":
    case "unstar": {
      const on = args.action === "star";
      if (opt(args.folderId)) await ws.setStarred({ folderId: String(args.folderId) }, on);
      else await ws.setStarred({ fileKey: str(args.fileKey, "fileKey") }, on);
      return { result: textResult({ starred: on }) };
    }
    case "create_folder": {
      const f = await ws.createFolder({ name: str(args.name, "name").trim(), parentId: opt(args.parentId) ?? null, ...(opt(args.color) ? { color: args.color as never } : {}) });
      return { result: textResult({ created: { folderId: f.id, name: f.name, parentId: f.parentId } }) };
    }
    case "rename_folder": {
      const f = await ws.updateFolder(str(args.folderId, "folderId"), { name: str(args.name, "name").trim() });
      return { result: textResult({ renamed: { folderId: f.id, name: f.name } }) };
    }
    case "trash":
    case "restore": {
      const files = keys();
      const folders = folderIds();
      if (!files.length && !folders.length) throw new Error("fileKeys or folderIds: what to move");
      if (args.action === "trash") await ws.trash({ files, folders });
      else await ws.restore({ files, folders });
      return { result: textResult({ [args.action === "trash" ? "trashed" : "restored"]: { files, folders } }) };
    }
    default:
      throw new Error(`file_action ${String(args.action)} needs a design file open (branch works on the open file)`);
  }
}
