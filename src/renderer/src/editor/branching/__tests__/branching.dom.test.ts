// @vitest-environment happy-dom
// The editor's branching UI (branching/, docs/editor.md "Branching") on the in-memory repository (fake/): Create
// branch…, the "‹file› / ‹branch›" title and its badge, the main-changed notice → Update from main file with Resolve
// conflicts (Resolve all › Pick branch, Next, Apply changes), the Branches modal (tabs, Open, Archive, Restore, Rename),
// Request review / Add your review, Merge branch; the commands' enabled states and menu rows.
import { act, createElement } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { click, mount, type, type Mounted } from "@/ds/__tests__/dom";
import { EditorContext, type EditorController } from "../../controller";
import { Store, type UIState } from "../../uiStore";
import { COMMAND_BY_ID, isEnabled } from "../../commands";
import { setBranchingBackend } from "../access";
import { Branching, BranchTitle } from "../Branching";
import { branchMenuIds } from "../commands";
import { fakeChunk, fakeConflict, MemoryBranches, type FakeOptions } from "../fake/memoryBranches";
import { branching, setBranching } from "../state";

let view: Mounted | null = null;
afterEach(() => {
  view?.unmount();
  view = null;
  document.body.innerHTML = "";
});

const settle = () =>
  act(async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve();
  });

function fakeEditor(fileKey: string): EditorController {
  const ui = new Store<UIState>({ fileName: fileKey, branchDialog: false } as unknown as UIState);
  const fileOps = { fileKey, duplicate: async () => ({ fileKey: "x", name: "x" }), folders: async () => [], moveTo: async () => {}, branch: async () => ({ fileKey: "x", name: "x" }) };
  return { ui, source: { fileKey, fileOps, flush: async () => {} }, focusCanvas: () => {} } as unknown as EditorController;
}

async function setup(fileKey: string, opts: FakeOptions = {}, seed?: (r: MemoryBranches) => void) {
  const repo = new MemoryBranches({ files: { main: "Design system" }, ...opts });
  seed?.(repo);
  const ed = fakeEditor(fileKey);
  setBranchingBackend(ed, repo.backend());
  const App = () => createElement(EditorContext.Provider, { value: ed }, createElement(BranchTitle, { name: fileKey }), createElement(Branching));
  view = mount(App, {});
  await settle();
  return { ed, repo };
}

const $ = (sel: string) => document.querySelector<HTMLElement>(sel);
const byText = (text: string, sel = "button") => [...document.querySelectorAll<HTMLElement>(sel)].find((e) => e.textContent?.trim() === text) ?? null;
const enabled = (ed: EditorController, id: string) => isEnabled(ed, COMMAND_BY_ID.get(id)!);
const menuItem = (text: string) => [...document.querySelectorAll<HTMLElement>('#ds-overlays [role="menuitem"]')].find((e) => e.textContent?.includes(text)) ?? null;

describe("branching on main", () => {
  it("Create branch… makes the branch from main and opens it; the commands and menu rows", async () => {
    const { ed, repo } = await setup("main");
    expect(enabled(ed, "file.create-branch")).toBe(true);
    expect(enabled(ed, "file.see-all-branches")).toBe(true);
    expect(enabled(ed, "file.update-from-main")).toBe(false);
    expect(enabled(ed, "file.review-and-merge")).toBe(false);
    expect(branchMenuIds(ed)).toEqual(["file.create-branch", "file.see-all-branches"]);
    expect($("[data-branch-title]")).toBeNull();

    act(() => COMMAND_BY_ID.get("file.create-branch")!.run(ed));
    const field = $("[data-create-branch] input") as HTMLInputElement;
    expect(field).not.toBeNull();
    type(field, "Explore nav");
    click(byText("Create")!);
    await settle();
    expect(repo.calls.find((c) => c.method === "create")?.args).toEqual(["main", "Explore nav"]);
    expect(repo.opened).toEqual(["branch-1"]);
    expect(ed.ui.get().branchDialog).toBe(false);
  });

  it("Create branch: Return in the name field creates it (the field keeps Enter to itself)", async () => {
    const { ed, repo } = await setup("main");
    act(() => COMMAND_BY_ID.get("file.create-branch")!.run(ed));
    const field = $("[data-create-branch] input") as HTMLInputElement;
    type(field, "Explore nav");
    act(() => field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    await settle();
    expect(repo.calls.find((c) => c.method === "create")?.args).toEqual(["main", "Explore nav"]);
    expect(repo.opened).toEqual(["branch-1"]);
    expect(ed.ui.get().branchDialog).toBe(false);
  });

  it("the Branches modal: Active / Archived / Yours, Open, Archive, Restore, Rename", async () => {
    const { ed, repo } = await setup("main", {}, (r) => {
      r.seed({ branchFileKey: "b1", mainFileKey: "main", name: "Nav", createdAt: 2 });
      r.seed({ branchFileKey: "b2", mainFileKey: "main", name: "Old", status: "merged", createdAt: 1 });
    });
    act(() => COMMAND_BY_ID.get("file.see-all-branches")!.run(ed));
    await settle();
    expect($('[role="dialog"]')?.textContent).toContain("Branches");
    const tabs = [...document.querySelectorAll('[role="tab"]')].map((t) => t.textContent!.replace(/^(.+)\1$/, "$1")); // the label twice: its bold twin holds the width
    expect(tabs).toEqual(["Active", "Archived", "Yours"]);
    expect([...document.querySelectorAll("[data-branch]")].map((r) => r.getAttribute("data-branch"))).toEqual(["b1"]);

    // Rename in place
    click($('[data-branch="b1"] [aria-label="Branch actions"]')!);
    click(menuItem("Rename")!);
    const input = $('[data-branch="b1"] input') as HTMLInputElement;
    type(input, "Navigation");
    act(() => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    await settle();
    expect(repo.records.get("b1")?.name).toBe("Navigation");

    // Archive → it moves to Archived; Restore brings it back; a merged one can't be restored
    click($('[data-branch="b1"] [aria-label="Branch actions"]')!);
    click(menuItem("Archive")!);
    await settle();
    expect(repo.records.get("b1")?.status).toBe("archived");
    expect(document.querySelectorAll("[data-branch]")).toHaveLength(0);
    click(document.querySelectorAll('[role="tab"]')[1]);
    await settle();
    expect([...document.querySelectorAll("[data-branch]")].map((r) => r.getAttribute("data-branch")).sort()).toEqual(["b1", "b2"]);
    expect($('[data-branch="b2"] [data-branch-badge]')?.textContent).toBe("Merged");
    click($('[data-branch="b2"] [aria-label="Branch actions"]')!);
    expect(menuItem("Restore")?.getAttribute("aria-disabled")).toBe("true");
    act(() => (document.activeElement as HTMLElement | null)?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    click($('[data-branch="b1"] [aria-label="Branch actions"]')!);
    click(menuItem("Restore")!);
    await settle();
    expect(repo.records.get("b1")?.status).toBe("active");

    // Open (back in Active)
    click(document.querySelectorAll('[role="tab"]')[0]);
    await settle();
    click($('[data-branch="b1"] [data-open-branch]')!);
    await settle();
    expect(repo.opened).toEqual(["b1"]);
  });
});

describe("branching on a branch", () => {
  const onBranch = (opts: FakeOptions = {}, seed?: (r: MemoryBranches) => void) =>
    setup("b1", opts, (r) => {
      r.seed({ branchFileKey: "b1", mainFileKey: "main", name: "Explore nav" });
      seed?.(r);
    });

  it("the title is ‹file› / ‹branch›; the items follow; no branches of branches; publishing off", async () => {
    const { ed } = await onBranch();
    expect($("[data-branch-title]")?.textContent).toBe("Design system/Explore nav");
    expect(branching(ed).record?.name).toBe("Explore nav");
    expect(enabled(ed, "file.create-branch")).toBe(false);
    // Figma's gate (atlas 16 §4.2): Update from main only once main has changed.
    expect(enabled(ed, "file.update-from-main")).toBe(false);
    setBranching(ed, { mainChanged: true });
    expect(enabled(ed, "file.update-from-main")).toBe(true);
    expect(enabled(ed, "file.review-and-merge")).toBe(true);
    expect(branchMenuIds(ed)).toEqual(["file.update-from-main", "file.review-and-merge", "file.see-all-branches", "file.archive-branch"]);
    const publish = COMMAND_BY_ID.get("file.publish-library")!;
    (ed as unknown as { libraries: unknown }).libraries = { get: () => ({ on: true }) };
    expect(publish.enabled!(ed)).toBe(false);
  });

  it("main changed: the notice, Update from main file, Resolve conflicts (Resolve all › Pick branch), Apply changes", async () => {
    const { repo } = await onBranch({ preview: { update: { chunks: [fakeChunk(0, { phase: "CREATED" }), fakeChunk(1, { conflicts: ["1:11|fillPaints"] }), fakeChunk(2, { canvasId: "0:2", canvasName: "Icons", phase: "REMOVED" })], conflicts: [fakeConflict(1)] } } });
    expect($("[data-main-changed]")).toBeNull();
    act(() => repo.touchMain("b1"));
    await settle();
    expect($("[data-main-changed]")?.textContent).toContain("There are updates from the main file");
    click(byText("Update")!);
    await settle();
    expect($('[data-branch-window="Update from main file"]')).not.toBeNull();
    expect($("[data-main-changed]")).toBeNull();
    // Changes by page, tagged
    expect([...document.querySelectorAll("[data-page]")].map((p) => p.getAttribute("data-page"))).toEqual(["Page 1", "Icons"]);
    expect([...document.querySelectorAll("[data-chunk] [data-tag]")].map((t) => t.textContent)).toEqual(["Added", "Edited", "Removed"]);
    // The side opened for the preview (main's latest version)
    expect(repo.calls.some((c) => c.method === "openSide" && c.args[1] === "main")).toBe(true);
    const apply = $("[data-apply]") as HTMLButtonElement;
    expect(apply.disabled).toBe(true);

    click($("[data-conflict-banner] button")!);
    expect($("[data-conflicts]")).not.toBeNull();
    expect(document.querySelectorAll("[data-conflict-chunk]")).toHaveLength(1);
    await settle();
    expect(repo.calls.some((c) => c.method === "openSide" && c.args[1] === "branch")).toBe(true);
    const next = byText("Next") as HTMLButtonElement;
    expect(next.disabled).toBe(true);
    click(byText("Resolve all")!.closest("button")!);
    click(menuItem("Pick branch")!);
    expect($("[data-conflict-chunk] [data-pick]")?.textContent).toBe("branch");
    expect(next.disabled).toBe(false);
    click(next);
    expect(($("[data-apply]") as HTMLButtonElement).disabled).toBe(false);
    click($("[data-apply]")!);
    await settle();
    const applied = repo.calls.find((c) => c.method === "applyUpdate");
    expect((applied?.args[1] as { resolutions: unknown }).resolutions).toEqual({ "*": "branch" });
    expect($('[data-branch-window="Update from main file"]')).toBeNull();
  });

  it("Request review → In review; a reviewer's Add your review → Changes suggested", async () => {
    const reviewers = [
      { userId: "u2", name: "Ada", email: "ada@x.test" },
      { userId: "u3", name: "Linus", email: "linus@x.test" },
    ];
    const { ed, repo } = await onBranch({ reviewers, preview: { merge: { chunks: [fakeChunk(0)], conflicts: [] } } });
    act(() => COMMAND_BY_ID.get("file.review-and-merge")!.run(ed));
    await settle();
    expect($('[data-branch-window="Branch review"]')).not.toBeNull();
    click(byText("Request review")!);
    await settle();
    expect(document.querySelectorAll("[data-person]")).toHaveLength(2);
    click($('[data-person="u2"] button')!);
    click($("[data-request-review]")!);
    const area = $("[data-review-describe] textarea") as HTMLTextAreaElement;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(area, "New nav bar");
      area.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect($("[data-send-review]")?.textContent).toBe("Send to 1 reviewer");
    click($("[data-send-review]")!);
    await settle();
    expect(repo.calls.find((c) => c.method === "requestReview")?.args[1]).toEqual({ reviewerIds: ["u2"], description: "New nav bar" });
    expect($("[data-branch-title] [data-branch-badge]")?.textContent).toBe("In review");
    expect($("[data-review-request]")?.textContent).toContain("New nav bar");
    view!.unmount();

    // Ada opens the branch
    const ada = await onBranch({ me: { id: "u2", name: "Ada" }, reviewers, preview: { merge: { chunks: [fakeChunk(0)], conflicts: [] } } }, (r) => {
      r.records.set("b1", { ...r.records.get("b1")!, createdBy: { id: "u1", name: "Burak" }, review: repo.records.get("b1")!.review });
    });
    act(() => COMMAND_BY_ID.get("file.review-and-merge")!.run(ada.ed));
    await settle();
    click($("[data-add-review]")!);
    expect($("[data-finish-review]")).not.toBeNull();
    click(byText("Suggest changes", '[role="radio"]') ?? byText("Suggest changes", "label")!);
    expect($("[data-finish-review]")?.textContent).toContain("Add any general comments you want to make (optional).");
    click($("[data-submit-review]")!);
    await settle();
    expect(ada.repo.calls.find((c) => c.method === "answerReview")?.args[1]).toEqual({ verdict: "changes-suggested", comment: undefined });
    expect($("[data-branch-title] [data-branch-badge]")?.textContent).toBe("Changes suggested");
    expect($("[data-add-review]")?.textContent).toBe("Review again");
  });

  it("Merge branch: conflicts picked first, then Name / Description, Merge; main opens", async () => {
    const { ed, repo } = await onBranch({ preview: { merge: { chunks: [fakeChunk(0, { conflicts: ["1:10|fillPaints"] }), fakeChunk(1)], conflicts: [fakeConflict(0)] } } });
    act(() => COMMAND_BY_ID.get("file.review-and-merge")!.run(ed));
    await settle();
    const merge = $("[data-merge-branch]") as HTMLButtonElement;
    expect(merge.disabled).toBe(true);
    click($("[data-conflict-banner] button")!);
    click($('[data-keep="main"]')!);
    expect($("[data-conflict-chunk] [data-pick]")?.textContent).toBe("main");
    click(byText("Next")!);
    expect(($("[data-merge-branch]") as HTMLButtonElement).disabled).toBe(false);
    click($("[data-merge-branch]")!);
    expect(($("[data-merge-step] input") as HTMLInputElement).value).toBe("Explore nav");
    click($("[data-merge]")!);
    await settle();
    const merged = repo.calls.find((c) => c.method === "merge")?.args[1] as { resolutions: unknown; title: string };
    expect(merged.resolutions).toEqual({ "chunk:0": "main" });
    expect(merged.title).toBe("Explore nav");
    expect(repo.records.get("b1")?.status).toBe("merged");
    expect(repo.opened).toEqual(["main"]);
    expect($("[data-branch-title] [data-branch-badge]")?.textContent).toBe("Merged");
  });
});
