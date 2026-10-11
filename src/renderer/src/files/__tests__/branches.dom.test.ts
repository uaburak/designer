// @vitest-environment happy-dom
// Branches in Home (help.figma.com "View and manage branches", docs/data.md §15.9) over the real dev store
// (MemoryStore's workspace and branches): the tile's branch icon and count, its dropdown (Main file, the branches,
// Create branch…, See all branches), the Branches modal (Active / Archived with the merged one, Yours), and a branch's
// own tile in Recents as "‹file› / ‹branch›".
import { act } from "react";
import { afterEach, describe, expect, it } from "vitest";
import type { ToastOptions } from "@/ds/components/Toast";
import { $, $$, click, mount, type, type Mounted } from "@/ds/__tests__/dom";
import { FileBrowser, type FileBrowserProps } from "../FileBrowser";
import type { FilesBackend } from "../storeAccess";
import type { Location } from "../model";
import { MemoryStore } from "../../store/memory/memoryStore";
import { memoryStorage } from "../../store/memory/kv";
import { editFile, rect } from "../../../../store/branches/scenario";
import { branchCountLabel, branchSwitchMenu, branchTileSubtitle, branchTileTitle } from "../branchesModel";
import type { BranchRecord } from "@shared/merge/branches";
import type { FileListItem } from "@shared/store/types";

let m: Mounted | null = null;
let store: MemoryStore | null = null;
afterEach(() => {
  m?.unmount();
  m = null;
  store?.dispose();
  store = null;
  document.body.innerHTML = "";
});

const settle = () => act(async () => new Promise((r) => setTimeout(r, 40)));

async function setup(initialLocation: Location = { kind: "drafts" }) {
  store = await MemoryStore.open({ storage: memoryStorage() });
  const api = store.api({});
  const main = await api.workspace.createFile({ name: "Design system", folderId: null });
  await api.workspace.createFile({ name: "Plain", folderId: null });
  await editFile(api, main.fileKey, (s) => [rect(s, 1, "!")]);
  const nav = await api.branches.create(main.fileKey, "Nav");
  const tokens = await api.branches.create(main.fileKey, "Tokens");
  const old = await api.branches.create(main.fileKey, "Old");
  const p = await api.branches.preview(old.branchFileKey, "merge");
  await api.branches.merge(old.branchFileKey, { previewId: p.previewId, resolutions: {} });
  await api.workspace.recordViewed(nav.branchFileKey);
  await api.workspace.setBrowsePrefs({ sort: "alphabetical" });
  const toasts: ToastOptions[] = [];
  const opened: { url: string; newTab: boolean }[] = [];
  const backend: FilesBackend = { workspace: api.workspace, source: "memory", thumbnailUrl: () => null, branches: api.branches };
  const props: FileBrowserProps = { backend, initialLocation, toast: (t) => toasts.push(t), openDeps: { navigate: (url, newTab) => opened.push({ url, newTab }) } };
  m = mount(FileBrowser, props);
  await settle();
  await settle();
  return { api, main, nav, tokens, old, toasts, opened };
}

const card = (name: string) => $(`[data-ds="FileCard"][aria-label="${name}"]`);
const menuItems = () => $$('#ds-overlays [role^="menuitem"]').map((el) => el.textContent?.trim());
const menuItem = (label: string) => $$('#ds-overlays [role="menuitem"]').find((el) => el.textContent?.includes(label))!;

describe("branches in Home", () => {
  it("a main file's tile: the branch icon, its active branches' count and the dropdown; Drafts leave branches out", async () => {
    const { nav, opened } = await setup();
    expect($$('[data-ds="FileCard"]').map((el) => el.getAttribute("aria-label"))).toEqual(["Design system", "Plain"]);
    expect(card("Design system")!.querySelector("[data-branch-icon]")).not.toBeNull();
    expect(card("Plain")!.querySelector("[data-branch-icon]")).toBeNull();
    const count = card("Design system")!.querySelector<HTMLElement>("[data-branches-button]")!;
    expect(count.textContent).toBe("2 branches");

    click(count);
    await settle();
    expect(menuItems()[0]).toBe("Main file");
    expect(menuItems().slice(1, 3).sort()).toEqual(["Nav", "Tokens"]);
    expect(menuItems().slice(3)).toEqual(["Create branch…", "See all branches"]);
    click(menuItem("Nav"));
    await settle();
    expect(opened.at(-1)?.url).toContain(nav.branchFileKey);
  });

  it("Create branch… from the dropdown makes the branch and opens it", async () => {
    const { api, main, opened } = await setup();
    click(card("Design system")!.querySelector<HTMLElement>("[data-branches-button]")!);
    await settle();
    click(menuItem("Create branch…"));
    await settle();
    type($('[role="dialog"] input') as HTMLInputElement, "Icons");
    click($$('[role="dialog"] button').find((b) => b.textContent?.trim() === "Create")!);
    await settle();
    await settle();
    const icons = (await api.branches.list(main.fileKey, "active")).find((b) => b.name === "Icons");
    expect(icons).toBeDefined();
    expect(opened.at(-1)?.url).toContain(icons!.branchFileKey);
    expect(card("Design system")!.querySelector("[data-branches-button]")!.textContent).toBe("3 branches");
  });

  it("See all branches: Active, Archived (the merged one, its badge, no Restore), Archive, Open", async () => {
    const { api, nav, tokens, old, opened } = await setup();
    click(card("Design system")!.querySelector<HTMLElement>("[data-branches-button]")!);
    await settle();
    click(menuItem("See all branches"));
    await settle();
    const rows = () => $$("[data-home-branches] [data-branch]").map((r) => r.getAttribute("data-branch"));
    expect($('[role="dialog"]')!.textContent).toContain("Branches");
    expect(rows().sort()).toEqual([tokens.branchFileKey, nav.branchFileKey].sort());

    click($(`[data-branch="${tokens.branchFileKey}"] [aria-label="Branch actions"]`)!);
    click(menuItem("Archive"));
    await settle();
    expect((await api.branches.get(tokens.branchFileKey))?.status).toBe("archived");
    expect(rows()).toEqual([nav.branchFileKey]);

    click($$('[data-home-branches] [role="tab"]')[1]);
    await settle();
    expect(rows().sort()).toEqual([tokens.branchFileKey, old.branchFileKey].sort());
    expect($(`[data-branch="${old.branchFileKey}"] [data-branch-badge]`)?.textContent).toBe("Merged");
    expect($(`[data-branch="${tokens.branchFileKey}"] [data-branch-badge]`)?.textContent).toBe("Archived");
    click($(`[data-branch="${old.branchFileKey}"] [aria-label="Branch actions"]`)!);
    expect(menuItem("Restore").getAttribute("aria-disabled")).toBe("true");
    act(() => (document.activeElement as HTMLElement | null)?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));

    // Open an archived branch (it opens read-only in the editor)
    click($(`[data-branch="${tokens.branchFileKey}"] [data-open-branch]`)!);
    await settle();
    expect(opened.at(-1)?.url).toContain(tokens.branchFileKey);
    expect($("[data-home-branches]")).toBeNull();
  });

  it("Recents lists a branch as ‹file› / ‹branch› with the branch icon", async () => {
    await setup({ kind: "recents" });
    const tile = card("Design system / Nav");
    expect(tile).not.toBeNull();
    expect(tile!.querySelector("[data-branch-icon]")).not.toBeNull();
  });
});

describe("branches in Home, the pure part", () => {
  const rec = (over: Partial<BranchRecord>): BranchRecord => ({ branchFileKey: "b", mainFileKey: "m", mainKey: null, branchKey: null, name: "B", createdBy: { id: null, name: null }, createdAt: 1, status: "active", base: { mainSeq: 1, mainVersionId: null, at: 1 }, mainSeenSeq: 1, archivedAt: null, mergedAt: null, mergedBy: null, mergeVersionId: null, review: null, ...over });
  it("the dropdown lists active branches newest first; counts; titles", () => {
    const menu = branchSwitchMenu([rec({ branchFileKey: "a", name: "A", createdAt: 1 }), rec({ branchFileKey: "c", name: "C", createdAt: 3 }), rec({ branchFileKey: "x", name: "X", status: "archived" })], { canCreate: false });
    expect(menu.map((e) => (typeof e === "string" ? e : "id" in e ? e.label : e.header))).toEqual(["Main file", "-", "Branches", "C", "A", "-", "Create branch…", "See all branches"]);
    expect(menu.find((e) => typeof e !== "string" && "id" in e && e.id === "create")).toMatchObject({ disabled: true });
    expect(branchCountLabel(1)).toBe("1 branch");
    expect(branchCountLabel(4)).toBe("4 branches");
    const f = { name: "Nav", branch: { mainFileKey: "m", name: "Nav", status: "merged" }, trashedAt: null, updatedAt: 0 } as unknown as FileListItem;
    expect(branchTileTitle(f, "Design")).toBe("Design / Nav");
    expect(branchTileTitle(f, null)).toBe("Nav");
    expect(branchTileSubtitle(f, 0)).toMatch(/^Merged · Edited/);
  });
});
