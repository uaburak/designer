/**
 * Home's changes to the workspace, each one store call (or a few) plus Figma's toast — with Undo where Figma offers
 * it (moving to Trash, moving to a folder). Live updates come back through the workspace watch, so nothing here
 * patches the screen by hand.
 */
import type { ToastOptions } from "@/ds/components/Toast";
import type { WorkspaceRepository } from "@shared/store/repositories";
import type { FileKey, FileListItem, FolderColor, FolderId } from "@shared/store/types";
import { cleanName, countLabel, type FolderIndex } from "./model";

export interface Targets {
  files: FileKey[];
  folders: FolderId[];
}

export interface ActionContext {
  repo: WorkspaceRepository;
  folders: FolderIndex;
  /** Files Home knows about (the listed ones), for names and where they were */
  known: readonly FileListItem[];
  toast: (o: ToastOptions) => void;
}

const UNDO = "Undo";

export const errorText = (e: unknown) => {
  const m = e instanceof Error ? e.message : typeof e === "string" ? e : "";
  return m || "Something went wrong";
};

async function attempt<T>(ctx: ActionContext, run: () => Promise<T>): Promise<T | undefined> {
  try {
    return await run();
  } catch (e) {
    ctx.toast({ kind: "error", message: errorText(e) });
    return undefined;
  }
}

const empty = (t: Targets) => !t.files.length && !t.folders.length;

/** Move to trash, with Undo (restore). */
export async function moveToTrash(ctx: ActionContext, t: Targets): Promise<boolean> {
  if (empty(t)) return false;
  const done = await attempt(ctx, async () => {
    await ctx.repo.trash(t);
    return true;
  });
  if (!done) return false;
  ctx.toast({
    message: `${countLabel(t).subject} moved to trash`,
    action: { label: UNDO, onAction: () => void attempt(ctx, () => ctx.repo.restore(t)) },
  });
  return true;
}

export async function restore(ctx: ActionContext, t: Targets): Promise<boolean> {
  if (empty(t)) return false;
  const done = await attempt(ctx, async () => {
    await ctx.repo.restore(t);
    return true;
  });
  if (done) ctx.toast({ message: `${countLabel(t).subject} restored` });
  return !!done;
}

/** After the confirmation: irreversible. */
export async function deleteForever(ctx: ActionContext, t: Targets): Promise<boolean> {
  if (empty(t)) return false;
  const done = await attempt(ctx, async () => {
    await ctx.repo.deleteForever(t);
    return true;
  });
  if (done) ctx.toast({ message: `${countLabel(t).subject} deleted forever` });
  return !!done;
}

export async function emptyTrash(ctx: ActionContext): Promise<boolean> {
  const done = await attempt(ctx, async () => {
    await ctx.repo.emptyTrash();
    return true;
  });
  if (done) ctx.toast({ message: "Trash emptied" });
  return !!done;
}

/** Copies named "‹name› (Copy)" in the same place (the store names them). */
export async function duplicate(ctx: ActionContext, files: FileKey[]): Promise<FileKey[]> {
  const out: FileKey[] = [];
  for (const k of files) {
    const meta = await attempt(ctx, () => ctx.repo.duplicateFile(k));
    if (meta) out.push(meta.fileKey);
  }
  if (out.length) ctx.toast({ message: out.length === 1 ? "File duplicated" : `${out.length} files duplicated` });
  return out;
}

export async function renameFile(ctx: ActionContext, fileKey: FileKey, name: string): Promise<boolean> {
  const n = cleanName(name);
  if (!n) return false;
  return !!(await attempt(ctx, async () => {
    await ctx.repo.renameFile(fileKey, n);
    return true;
  }));
}

export async function renameFolder(ctx: ActionContext, folderId: FolderId, name: string): Promise<boolean> {
  const n = cleanName(name);
  if (!n) return false;
  return !!(await attempt(ctx, async () => {
    await ctx.repo.updateFolder(folderId, { name: n });
    return true;
  }));
}

export async function setFolderColor(ctx: ActionContext, folderId: FolderId, color: FolderColor): Promise<boolean> {
  return !!(await attempt(ctx, async () => {
    await ctx.repo.updateFolder(folderId, { color });
    return true;
  }));
}

export async function createFolder(ctx: ActionContext, name: string, parentId: FolderId | null): Promise<FolderId | null> {
  const n = cleanName(name);
  if (!n) return null;
  const f = await attempt(ctx, () => ctx.repo.createFolder({ name: n, parentId }));
  return f?.id ?? null;
}

export async function setStarred(ctx: ActionContext, target: { fileKey: FileKey } | { folderId: FolderId }, starred: boolean): Promise<boolean> {
  return !!(await attempt(ctx, async () => {
    await ctx.repo.setStarred(target, starred);
    return true;
  }));
}

export async function removeFromRecents(ctx: ActionContext, files: FileKey[]): Promise<boolean> {
  return !!(await attempt(ctx, async () => {
    for (const k of files) await ctx.repo.removeFromRecents(k);
    return true;
  }));
}

/** The name of a destination: "Drafts" for files, "All folders" (the top level) for folders. */
export const destinationName = (folders: FolderIndex, dest: FolderId | null, forFolders: boolean) => (dest === null ? (forFolders ? "All folders" : "Drafts") : (folders.get(dest)?.name ?? "folder"));

/**
 * Files into a folder (or Drafts), folders under a folder (or the top level), with Undo putting each back where it
 * was. Items already there are skipped; a folder can't go into itself (the store refuses, the toast says why).
 */
export async function moveTo(ctx: ActionContext, t: Targets, dest: FolderId | null): Promise<boolean> {
  const fileFrom = new Map<FolderId | null, FileKey[]>();
  for (const k of t.files) {
    const from = ctx.known.find((f) => f.fileKey === k)?.folderId ?? (await ctx.repo.getFile(k).then((f) => f.folderId, () => undefined));
    if (from === undefined || from === dest) continue;
    fileFrom.set(from, [...(fileFrom.get(from) ?? []), k]);
  }
  const folderFrom = t.folders.map((id) => ({ id, from: ctx.folders.get(id)?.parentId ?? null })).filter((x) => x.from !== dest && x.id !== dest);
  const moved = await attempt(ctx, async () => {
    const files = [...fileFrom.values()].flat();
    if (files.length) await ctx.repo.moveFiles(files, dest);
    for (const { id } of folderFrom) await ctx.repo.updateFolder(id, { parentId: dest });
    return files.length + folderFrom.length;
  });
  if (!moved) return false;
  ctx.toast({
    message: `Moved to ${destinationName(ctx.folders, dest, !t.files.length)}`,
    action: {
      label: UNDO,
      onAction: () =>
        void attempt(ctx, async () => {
          for (const [from, keys] of fileFrom) await ctx.repo.moveFiles(keys, from);
          for (const { id, from } of folderFrom) await ctx.repo.updateFolder(id, { parentId: from });
        }),
    },
  });
  return true;
}
