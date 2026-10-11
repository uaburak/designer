// Branches in the desktop store (docs/data.md §15.5): the shared scenario (scenario.ts) on disk, plus the store's own
// files (branch.json, base.kiwi, store.json's GUID block) and a restart.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { splitSessionId } from "../../shared/schema/guid";
import { openTestStore, type TestStore } from "../testing/harness";
import { editFile, rect, scenario } from "./scenario";
import { SESSION_BLOCK } from "./service";

let t: TestStore | null = null;
afterEach(async () => {
  await t?.close().catch(() => {});
  t?.dispose();
  t = null;
});

describe("branches (docs/data.md §15.5)", () => {
  it("the desktop store: create, update, merge, archive, reviews", async () => {
    t = await openTestStore();
    await scenario(t.api, () => t!.idle());
  });

  it("records, base and versions survive a restart; a renamed branch file renames the branch", async () => {
    t = await openTestStore();
    const main = await t.api.workspace.createFile({ name: "Design", folderId: null });
    await editFile(t.api, main.fileKey, (s) => [rect(s, 1, "!")]);
    const b = await t.api.branches.create(main.fileKey, "Feature");
    const dir = join(t.dir, "Workspace", "files", b.branchFileKey, "branch");
    expect(JSON.parse(readFileSync(join(dir, "branch.json"), "utf8"))).toMatchObject({ name: "Feature", status: "active" });
    await t.api.workspace.renameFile(b.branchFileKey, "Renamed");
    for (let i = 0; i < 50 && (await t.api.branches.get(b.branchFileKey))?.name !== "Renamed"; i++) await new Promise((r) => setTimeout(r, 10));
    expect((await t.api.branches.get(b.branchFileKey))?.name).toBe("Renamed");
    await t.close();
    const again = await t.reopen();
    t = again;
    expect(await again.api.branches.get(b.branchFileKey)).toMatchObject({ name: "Renamed", base: { mainSeq: 1 } });
    const p = await again.api.branches.preview(b.branchFileKey, "merge");
    expect(p.conflicts).toEqual([]);
    expect(p.chunks).toEqual([]);
  });

  it("a branch at the end of its GUID block takes the next one from its main file", async () => {
    t = await openTestStore();
    const main = await t.api.workspace.createFile({ name: "Design", folderId: null });
    const b = await t.api.branches.create(main.fileKey, "Feature");
    const statePath = join(t.dir, "Workspace", "files", b.branchFileKey, "store.json");
    await t.close();
    const st = JSON.parse(readFileSync(statePath, "utf8"));
    expect(st.sessions.blockEnd - st.sessions.nextLocal).toBe(SESSION_BLOCK);
    st.sessions.blockEnd = st.sessions.nextLocal + 1;
    writeFileSync(statePath, JSON.stringify(st));
    t = await t.reopen();
    const first = await t.api.files.open(b.branchFileKey, { mode: "edit" });
    await t.api.files.close(b.branchFileKey, first.sessionID);
    const second = await t.api.files.open(b.branchFileKey, { mode: "edit" });
    await t.api.files.close(b.branchFileKey, second.sessionID);
    const m = await t.api.files.open(main.fileKey, { mode: "edit" });
    // The second block was main's next numbers; main moved past it.
    expect(splitSessionId(second.sessionID).n).toBe(splitSessionId(first.sessionID).n + 1 + SESSION_BLOCK - 1);
    expect(splitSessionId(m.sessionID).n).toBe(splitSessionId(second.sessionID).n + SESSION_BLOCK);
  });
});
