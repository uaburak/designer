import { describe, expect, it } from "vitest";
import type { ToastOptions } from "@/ds/components/Toast";
import * as act from "../actions";
import { FolderIndex } from "../model";
import { MemoryWorkspace } from "./memoryWorkspace";

async function setup() {
  const ws = new MemoryWorkspace({ sync: true });
  const brand = ws.seedFolder({ name: "Brand", color: "purple" });
  const sub = ws.seedFolder({ name: "Icons", parentId: brand.id });
  const logo = ws.seedFile({ name: "Logo", folderId: brand.id });
  const draft = ws.seedFile({ name: "Draft" });
  const toasts: ToastOptions[] = [];
  const ctx = async (): Promise<act.ActionContext> => ({ repo: ws, folders: new FolderIndex(await ws.listFolders()), known: [...(await ws.listFiles({ in: "drafts" })), ...(await ws.listFiles({ in: "folder", folderId: brand.id }))], toast: (t) => toasts.push(t) });
  return { ws, brand, sub, logo, draft, toasts, ctx };
}

describe("actions", () => {
  it("Move to trash, with Undo restoring", async () => {
    const { ws, draft, toasts, ctx } = await setup();
    await act.moveToTrash(await ctx(), { files: [draft.fileKey], folders: [] });
    expect((await ws.listFiles({ in: "drafts" })).map((f) => f.name)).toEqual([]);
    expect((await ws.listFiles({ in: "trash" })).map((f) => f.name)).toEqual(["Draft"]);
    expect(toasts[0]).toMatchObject({ message: "File moved to trash", action: { label: "Undo" } });
    toasts[0].action!.onAction();
    await new Promise((r) => setTimeout(r));
    expect((await ws.listFiles({ in: "drafts" })).map((f) => f.name)).toEqual(["Draft"]);
  });

  it("a trashed folder takes its files with it; restore brings them back", async () => {
    const { ws, brand, toasts, ctx } = await setup();
    await act.moveToTrash(await ctx(), { files: [], folders: [brand.id] });
    expect(toasts[0].message).toBe("Folder moved to trash");
    expect(await ws.listFiles({ in: "folder", folderId: brand.id })).toEqual([]);
    await act.restore(await ctx(), { files: [], folders: [brand.id] });
    expect((await ws.listFiles({ in: "folder", folderId: brand.id })).map((f) => f.name)).toEqual(["Logo"]);
    expect(toasts[1].message).toBe("Folder restored");
  });

  it("Move to folder, with Undo putting each file back where it was", async () => {
    const { ws, brand, sub, logo, draft, toasts, ctx } = await setup();
    await act.moveTo(await ctx(), { files: [logo.fileKey, draft.fileKey], folders: [] }, sub.id);
    expect((await ws.listFiles({ in: "folder", folderId: sub.id })).map((f) => f.name).sort()).toEqual(["Draft", "Logo"]);
    expect(toasts[0].message).toBe("Moved to Icons");
    toasts[0].action!.onAction();
    await new Promise((r) => setTimeout(r));
    expect((await ws.getFile(logo.fileKey)).folderId).toBe(brand.id);
    expect((await ws.getFile(draft.fileKey)).folderId).toBeNull();
  });

  it("a folder can't move into its own subfolder (the store says why)", async () => {
    const { brand, sub, toasts, ctx } = await setup();
    await act.moveTo(await ctx(), { files: [], folders: [brand.id] }, sub.id);
    expect(toasts[0]).toMatchObject({ kind: "error", message: "A folder can't be moved into itself" });
  });

  it("Duplicate names the copy “(Copy)”; Delete forever and Empty trash", async () => {
    const { ws, draft, toasts, ctx } = await setup();
    const [copy] = await act.duplicate(await ctx(), [draft.fileKey]);
    expect((await ws.getFile(copy)).name).toBe("Draft (Copy)");
    expect(toasts[0].message).toBe("File duplicated");
    await ws.trash({ files: [copy, draft.fileKey] });
    await act.deleteForever(await ctx(), { files: [copy], folders: [] });
    expect((await ws.listFiles({ in: "trash" })).map((f) => f.name)).toEqual(["Draft"]);
    await act.emptyTrash(await ctx());
    expect(await ws.listFiles({ in: "trash" })).toEqual([]);
    expect(toasts.map((t) => t.message)).toContain("Trash emptied");
  });

  it("rename ignores empty names; folders get colours and nest", async () => {
    const { ws, draft, brand, ctx } = await setup();
    expect(await act.renameFile(await ctx(), draft.fileKey, "   ")).toBe(false);
    await act.renameFile(await ctx(), draft.fileKey, "  Poster ");
    expect((await ws.getFile(draft.fileKey)).name).toBe("Poster");
    await act.setFolderColor(await ctx(), brand.id, "teal");
    const id = await act.createFolder(await ctx(), "Nested", brand.id);
    const folders = await ws.listFolders();
    expect(folders.find((f) => f.id === brand.id)?.color).toBe("teal");
    expect(folders.find((f) => f.id === id)?.parentId).toBe(brand.id);
  });
});
