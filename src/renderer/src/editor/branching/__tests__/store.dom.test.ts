// @vitest-environment happy-dom
// The editor's branching UI on the real store (round 2d): MemoryStore's `branches` (src/store/branches/service.ts) with
// real documents, not the fake. End to end through the DOM: Create branch… → an edit on the branch → Review and merge
// changes › Merge branch › Merge → main has the edit; and Update from main with a conflict resolved (Resolve all ›
// Pick branch, Next, Apply changes). Only `openSide` is left out: Compare changes draws with the engine (WebGL), which
// the DOM test has none of — the windows show their "couldn't be loaded" state for the pictures and work on.
import { act, createElement } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { click, mount, type, type Mounted } from "@/ds/__tests__/dom";
import { EditorContext, type EditorController } from "../../controller";
import { Store, type UIState } from "../../uiStore";
import { COMMAND_BY_ID } from "../../commands";
import { setBranchingBackend, type BranchingBackend } from "../access";
import { Branching, BranchTitle } from "../Branching";
import { MemoryStore } from "../../../store/memory/memoryStore";
import { memoryStorage } from "../../../store/memory/kv";
import { editFile, rect, tableOf } from "../../../../../store/branches/scenario";
import type { StoreApi } from "../../../../../shared/store/repositories";

let view: Mounted | null = null;
let store: MemoryStore | null = null;
afterEach(() => {
  view?.unmount();
  view = null;
  store?.dispose();
  store = null;
  document.body.innerHTML = "";
});

/** The store's promises and its timers (the main-changed notice is throttled) */
const settle = () => act(async () => new Promise((r) => setTimeout(r, 30)));

function fakeEditor(fileKey: string): EditorController {
  const ui = new Store<UIState>({ fileName: fileKey, branchDialog: false } as unknown as UIState);
  const fileOps = { fileKey, duplicate: async () => ({ fileKey: "x", name: "x" }), folders: async () => [], moveTo: async () => {}, branch: async () => ({ fileKey: "x", name: "x" }) };
  return { ui, source: { fileKey, fileOps, flush: async () => {} }, focusCanvas: () => {} } as unknown as EditorController;
}

function backendOver(api: StoreApi, opened: string[]): BranchingBackend {
  return {
    branches: {
      ...api.branches,
      openSide: async () => {
        throw new Error("no engine in the DOM test");
      },
    },
    fileName: async (k) => (await api.workspace.getFile(k).catch(() => null))?.name ?? null,
    reviewers: async () => [],
    me: async () => ({ id: null, name: null }),
    canEditMain: async () => true,
    openFile: async (k) => void opened.push(k),
    link: async () => null,
  };
}

async function openIn(api: StoreApi, fileKey: string, opened: string[]) {
  view?.unmount();
  const ed = fakeEditor(fileKey);
  setBranchingBackend(ed, backendOver(api, opened));
  const App = () => createElement(EditorContext.Provider, { value: ed }, createElement(BranchTitle, { name: fileKey }), createElement(Branching));
  view = mount(App, {});
  await settle();
  return ed;
}

const $ = (sel: string) => document.querySelector<HTMLElement>(sel);
const byText = (text: string, sel = "button") => [...document.querySelectorAll<HTMLElement>(sel)].find((e) => e.textContent?.trim() === text) ?? null;
const menuItem = (text: string) => [...document.querySelectorAll<HTMLElement>('#ds-overlays [role="menuitem"]')].find((e) => e.textContent?.includes(text)) ?? null;
const head = async (api: StoreApi, fileKey: string) => tableOf(await api.files.open(fileKey, { mode: "view" }));

async function newStore() {
  store = await MemoryStore.open({ storage: memoryStorage() });
  const api = store.api({});
  const main = await api.workspace.createFile({ name: "Design system", folderId: null });
  const s0 = await editFile(api, main.fileKey, (s) => [rect(s, 1, "!")]);
  return { api, main, s0 };
}

describe("branching on the real store (MemoryStore)", () => {
  it("Create branch → an edit on the branch → Review and merge changes → main has the edit", async () => {
    const { api, main, s0 } = await newStore();
    const opened: string[] = [];

    // On main: File › Create branch…
    const onMain = await openIn(api, main.fileKey, opened);
    act(() => COMMAND_BY_ID.get("file.create-branch")!.run(onMain));
    type($("[data-create-branch] input") as HTMLInputElement, "Explore nav");
    click(byText("Create")!);
    await settle();
    const [made] = await api.branches.list(main.fileKey, "active");
    expect(made.name).toBe("Explore nav");
    expect(opened).toEqual([made.branchFileKey]);

    // The branch is edited (a new rectangle, the first one renamed).
    const sb = await editFile(api, made.branchFileKey, (s) => [rect(s, 1, '"'), { guid: { sessionID: s0, localID: 1 }, name: "Renamed on the branch" }]);

    // On the branch: its title, Review and merge changes, Merge branch, Merge.
    const onBranch = await openIn(api, made.branchFileKey, opened);
    expect($("[data-branch-title]")?.textContent).toBe("Design system/Explore nav");
    act(() => COMMAND_BY_ID.get("file.review-and-merge")!.run(onBranch));
    await settle();
    expect($('[data-branch-window="Branch review"]')).not.toBeNull();
    const mergeButton = $("[data-merge-branch]") as HTMLButtonElement;
    expect(mergeButton.disabled).toBe(false);
    click(mergeButton);
    expect(($("[data-merge-step] input") as HTMLInputElement).value).toBe("Explore nav");
    click($("[data-merge]")!);
    await settle();
    await settle();

    // Main has the branch's changes; the branch is merged; main opened; history says so.
    const m = await head(api, main.fileKey);
    expect(m.get(`${sb}:1`)).toBeDefined();
    expect(m.get(`${s0}:1`)?.name).toBe("Renamed on the branch");
    expect((await api.branches.get(made.branchFileKey))?.status).toBe("merged");
    expect(opened.at(-1)).toBe(main.fileKey);
    expect((await api.files.listVersions(main.fileKey)).map((v) => v.kind)).toEqual(["merge", "autosave", "branch"]);
    // The branch's savepoint before the merge too.
    expect((await api.files.listVersions(made.branchFileKey)).map((v) => v.kind)).toEqual(["merge", "autosave", "branch"]);
    expect($("[data-branch-title] [data-branch-badge]")?.textContent).toBe("Merged");
  });

  it("the Branches modal: Active / Archived, Rename, Archive, Restore; a merged branch can't be restored", async () => {
    const { api, main } = await newStore();
    const nav = await api.branches.create(main.fileKey, "Nav");
    const old = await api.branches.create(main.fileKey, "Old");
    const p = await api.branches.preview(old.branchFileKey, "merge");
    await api.branches.merge(old.branchFileKey, { previewId: p.previewId, resolutions: {} });
    const ed = await openIn(api, main.fileKey, []);
    act(() => COMMAND_BY_ID.get("file.see-all-branches")!.run(ed));
    await settle();
    const rows = () => [...document.querySelectorAll("[data-branch]")].map((r) => r.getAttribute("data-branch"));
    expect(rows()).toEqual([nav.branchFileKey]);

    click($(`[data-branch="${nav.branchFileKey}"] [aria-label="Branch actions"]`)!);
    click(menuItem("Rename")!);
    const input = $(`[data-branch="${nav.branchFileKey}"] input`) as HTMLInputElement;
    type(input, "Navigation");
    act(() => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    await settle();
    expect((await api.workspace.getFile(nav.branchFileKey)).name).toBe("Navigation");

    click($(`[data-branch="${nav.branchFileKey}"] [aria-label="Branch actions"]`)!);
    click(menuItem("Archive")!);
    await settle();
    expect((await api.branches.get(nav.branchFileKey))?.status).toBe("archived");
    click(document.querySelectorAll('[role="tab"]')[1]);
    await settle();
    expect(rows().sort()).toEqual([nav.branchFileKey, old.branchFileKey].sort());
    expect($(`[data-branch="${old.branchFileKey}"] [data-branch-badge]`)?.textContent).toBe("Merged");
    click($(`[data-branch="${old.branchFileKey}"] [aria-label="Branch actions"]`)!);
    expect(menuItem("Restore")?.getAttribute("aria-disabled")).toBe("true");
    act(() => (document.activeElement as HTMLElement | null)?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    click($(`[data-branch="${nav.branchFileKey}"] [aria-label="Branch actions"]`)!);
    click(menuItem("Restore")!);
    await settle();
    expect((await api.branches.get(nav.branchFileKey))?.status).toBe("active");
  });

  it("Update from main with a conflict: Resolve all › Pick branch, Next, Apply changes", async () => {
    const { api, main, s0 } = await newStore();
    const b = await api.branches.create(main.fileKey, "Tokens");
    await editFile(api, b.branchFileKey, () => [{ guid: { sessionID: s0, localID: 1 }, name: "Branch's" }]);
    const sm = await editFile(api, main.fileKey, (s) => [{ guid: { sessionID: s0, localID: 1 }, name: "Main's" }, rect(s, 1, "#")]);

    const opened: string[] = [];
    const ed = await openIn(api, b.branchFileKey, opened);
    act(() => COMMAND_BY_ID.get("file.update-from-main")!.run(ed));
    await settle();
    expect($('[data-branch-window="Update from main file"]')).not.toBeNull();
    const apply = () => $("[data-apply]") as HTMLButtonElement;
    expect(apply().disabled).toBe(true);
    click($("[data-conflict-banner] button")!);
    await settle();
    expect(document.querySelectorAll("[data-conflict-chunk]")).toHaveLength(1);
    click(byText("Resolve all")!.closest("button")!);
    click(menuItem("Pick branch")!);
    expect($("[data-conflict-chunk] [data-pick]")?.textContent).toBe("branch");
    click(byText("Next")!);
    expect(apply().disabled).toBe(false);
    click(apply());
    await settle();
    await settle();
    expect($('[data-branch-window="Update from main file"]')).toBeNull();

    // The branch has main's new layer and keeps its own name; its base moved.
    const t = await head(api, b.branchFileKey);
    expect(t.get(`${sm}:1`)).toBeDefined();
    expect(t.get(`${s0}:1`)?.name).toBe("Branch's");
    expect((await api.files.listVersions(b.branchFileKey)).map((v) => v.kind)).toEqual(["update", "autosave", "branch"]);
    expect((await api.branches.mainStatus(b.branchFileKey)).changed).toBe(false);
  });
});
