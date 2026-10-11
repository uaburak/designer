// Where an org file is, under its name in the editor, and File › Move to folder… in an org (the owner's run: a file
// made in "Design team / Website" said "Drafts", and the dialog listed the local workspace's folders). The org's
// folders are stand-ins over MemoryStore's real `StoreApi`.
import { describe, expect, it } from "vitest";
import type { StoreApi } from "../../../../shared/store/repositories";
import { memoryStorage } from "../memory/kv";
import { MemoryStore } from "../memory/memoryStore";
import { openStoreDocument } from "../documentSource";

const settle = () => new Promise((r) => setTimeout(r, 0));

describe("an org file's place in the editor", () => {
  it("shows its org folder (a branch: its main's), and moves among the org's folders", async () => {
    const store = await MemoryStore.open({ storage: memoryStorage(), seed: undefined });
    try {
      const api = store.api({});
      const moved: unknown[] = [];
      const org: StoreApi = {
        ...api,
        orgs: { ...api.orgs, list: async () => [{ id: "o1", name: "Acme", role: "member", seat: "full", workspaceId: null }] },
        teams: { ...api.teams, list: async () => [{ id: "t1", name: "Design team" }] as never },
        projects: {
          ...api.projects,
          get: async (id: string) => ({ id, name: id === "p1" ? "Website" : "App" }) as never,
          list: async (_team: string, parent?: string | null) =>
            (parent ? [{ id: "p3", name: "Old", me: "viewer", folderCount: 0, trashedAt: null }] : [
              { id: "p1", name: "Website", me: "editor", folderCount: 1, trashedAt: null },
              { id: "p2", name: "App", me: "owner", folderCount: 0, trashedAt: null },
            ]) as never,
          moveFiles: async (keys: string[], to: { projectId: string | null }) => void moved.push([keys, to]),
        },
      };
      const main = await api.workspace.createFile({ name: "Untitled", folderId: null });
      await store.ws.setFileSpace(main.fileKey, { orgId: "o1", key: "file_room1", teamId: "t1", projectId: "p1" });

      const src = await openStoreDocument(org, main.fileKey, { prepareEagerly: false });
      await settle();
      expect(src.location).toBe("Website");

      const ops = (src as unknown as { fileOps: { folders(): Promise<{ id: string | null; name: string }[]>; moveTo(id: string | null): Promise<void> } }).fileOps;
      expect(await ops.folders()).toEqual([
        { id: null, name: "Drafts" },
        { id: "p1", name: "Design team / Website" },
        { id: "p2", name: "Design team / App" },
      ]);
      await ops.moveTo("p2");
      expect(moved).toEqual([[["file_room1"], { projectId: "p2" }]]);
      await src.close();

      // A branch has no org place of its own: it is where its main is.
      const branch = await api.workspace.createFile({ name: "Feature", folderId: null });
      await store.ws.patchFile(branch.fileKey, { branch: { mainFileKey: main.fileKey, name: "Feature", status: "active" } });
      const bsrc = await openStoreDocument(org, branch.fileKey, { prepareEagerly: false });
      await settle();
      await settle();
      expect(bsrc.location).toBe("Website");
      await bsrc.close();
    } finally {
      store.dispose();
    }
  });
});
