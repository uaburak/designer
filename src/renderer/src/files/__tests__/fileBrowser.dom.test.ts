// @vitest-environment happy-dom
import { act } from "react";
import { afterEach, describe, expect, it } from "vitest";
import type { ToastOptions } from "@/ds/components/Toast";
import { $, $$, click, key, mount, type, type Mounted } from "@/ds/__tests__/dom";
import { FileBrowser, type FileBrowserProps } from "../FileBrowser";
import type { Location } from "../model";
import type { FilesBackend } from "../storeAccess";
import { MemoryWorkspace } from "./memoryWorkspace";

let m: Mounted | null = null;
afterEach(() => {
  m?.unmount();
  m = null;
  document.body.innerHTML = "";
});

/** Lets the store's promises and Home's coalesced reload (16 ms) run. */
const settle = () => act(async () => new Promise((r) => setTimeout(r, 40)));

async function setup(initialLocation: Location = { kind: "drafts" }) {
  const ws = new MemoryWorkspace({ teamName: "Burak's team" });
  const brand = ws.seedFolder({ name: "Brand", color: "purple" });
  const icons = ws.seedFolder({ name: "Icons", parentId: brand.id });
  ws.seedFile({ name: "Logo", folderId: brand.id });
  const now = Date.now();
  const a = ws.seedFile({ name: "Alpha", updatedAt: now - 3000 });
  const b = ws.seedFile({ name: "Beta", updatedAt: now - 2000 });
  const c = ws.seedFile({ name: "Gamma", updatedAt: now - 1000 });
  ws.seedFile({ name: "Old", trashedAt: now - 5000 });
  await ws.setBrowsePrefs({ sort: "alphabetical" });
  const toasts: ToastOptions[] = [];
  const opened: { url: string; newTab: boolean }[] = [];
  const backend: FilesBackend = { workspace: ws, source: "memory", thumbnailUrl: () => null, importFigBytes: (file, folderId) => (file.name.startsWith("bad") ? Promise.reject(new Error("This file uses a compression the browser can't read")) : ws.importFig(file.name, folderId)) };
  const props: FileBrowserProps = { backend, initialLocation, toast: (t) => toasts.push(t), openDeps: { navigate: (url, newTab) => opened.push({ url, newTab }) } };
  m = mount(FileBrowser, props);
  await settle();
  return { ws, brand, icons, a, b, c, toasts, opened };
}

const cards = () => $$('[data-ds="FileCard"]').map((el) => el.getAttribute("aria-label"));
const card = (name: string) => $(`[data-ds="FileCard"][aria-label="${name}"]`);
const selectedNames = () => $$('[data-collection-item][aria-selected="true"]').map((el) => el.getAttribute("aria-label"));
const sidebar = (label: string) => $$('nav [data-ds="SidebarItem"]').find((el) => el.textContent?.trim() === label)!;
const menuItem = (label: string) => $$('#ds-overlays [role="menuitem"]').find((el) => el.textContent?.includes(label))!;
const buttonNamed = (label: string) => $$("button").find((el) => el.textContent?.trim() === label)!;
const mouse = (el: Element, type: "click" | "contextmenu", init: MouseEventInit = {}) =>
  act(() => {
    el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX: 20, clientY: 20, ...init }));
  });

describe("FileBrowser", () => {
  it("lists Drafts in the chosen sort, with the folder tree and the team in the sidebar", async () => {
    await setup();
    expect(cards()).toEqual(["Alpha", "Beta", "Gamma"]);
    expect($('nav').textContent).toContain("Burak's team");
    expect(sidebar("Brand")).toBeTruthy();
    expect($('[data-ds="Breadcrumb"]').textContent).toContain("Drafts");
  });

  it("click selects, ⌘-click adds, ⇧-click selects the range, ⌘A selects all, Esc clears", async () => {
    await setup();
    click(card("Alpha"));
    expect(selectedNames()).toEqual(["Alpha"]);
    mouse(card("Gamma"), "click", { shiftKey: true });
    expect(selectedNames()).toEqual(["Alpha", "Beta", "Gamma"]);
    mouse(card("Beta"), "click", { metaKey: true });
    expect(selectedNames()).toEqual(["Alpha", "Gamma"]);
    click(card("Beta"));
    key(document.body, "Escape");
    expect(selectedNames()).toEqual([]);
    key(document.body, "a", { metaKey: true });
    expect(selectedNames()).toEqual(["Alpha", "Beta", "Gamma"]);
  });

  it("Delete moves the selection to Trash with an Undo toast; the list follows the store", async () => {
    const { ws, toasts } = await setup();
    click(card("Alpha"));
    mouse(card("Beta"), "click", { metaKey: true });
    key(document.body, "Backspace");
    await settle();
    expect(cards()).toEqual(["Gamma"]);
    expect(toasts.at(-1)).toMatchObject({ message: "2 files moved to trash", action: { label: "Undo" } });
    await act(async () => toasts.at(-1)!.action!.onAction());
    await settle();
    expect(cards()).toEqual(["Alpha", "Beta", "Gamma"]);
    expect((await ws.listFiles({ in: "trash" })).map((f) => f.name)).toEqual(["Old"]);
  });

  it("Enter opens the file (the editor page in a browser) and records the view for Recents", async () => {
    const { ws, b, opened } = await setup();
    click(card("Beta"));
    key(document.body, "Enter");
    await settle();
    expect(opened).toEqual([{ url: `${location.pathname}?editor&file=${b.fileKey}`, newTab: false }]);
    expect((await ws.listFiles({ in: "recents" })).map((f) => f.name)).toEqual(["Beta"]);
  });

  it("context menu: Open in new tab, Rename in place", async () => {
    const { ws, c, opened } = await setup();
    mouse(card("Gamma"), "contextmenu");
    click(menuItem("Open in new tab"));
    await settle();
    expect(opened.at(-1)).toEqual({ url: `${location.pathname}?editor&file=${c.fileKey}`, newTab: true });
    mouse(card("Gamma"), "contextmenu");
    click(menuItem("Rename"));
    const input = $('[data-ds="FileCard"] input') as HTMLInputElement;
    expect(input).toBeTruthy();
    type(input, "Poster");
    key(input, "Enter");
    await settle();
    expect((await ws.getFile(c.fileKey)).name).toBe("Poster");
    expect(cards()).toEqual(["Alpha", "Beta", "Poster"]);
  });

  it("live updates: a file made elsewhere shows up", async () => {
    const { ws } = await setup();
    await act(async () => {
      await ws.createFile({ name: "From another view", folderId: null });
    });
    await settle();
    expect(cards()).toContain("From another view");
  });

  it("folders: open from the sidebar, subfolders first, New folder creates inside", async () => {
    const { ws, brand } = await setup();
    click(sidebar("Brand"));
    await settle();
    expect($$('[data-ds="FolderCard"]').map((el) => el.getAttribute("aria-label"))).toEqual(["Icons"]);
    expect(cards()).toEqual(["Logo"]);
    expect($('[data-ds="Breadcrumb"]').textContent).toContain("All folders");
    click(buttonNamed("New folder"));
    const input = $('[role="dialog"] input') as HTMLInputElement;
    type(input, "Exports");
    click(buttonNamed("Create folder"));
    await settle();
    const made = (await ws.listFolders()).find((f) => f.name === "Exports");
    expect(made?.parentId).toBe(brand.id);
    expect($$('[data-ds="FolderCard"]').map((el) => el.getAttribute("aria-label"))).toEqual(["Exports", "Icons"]);
  });

  it("Trash: Delete forever after a confirmation", async () => {
    const { ws } = await setup({ kind: "trash" });
    expect(cards()).toEqual(["Old"]);
    mouse(card("Old"), "contextmenu");
    click(menuItem("Delete forever"));
    expect($('[role="dialog"]').textContent).toContain("“Old” will be deleted forever");
    click($$('[role="dialog"] button').find((b) => b.textContent === "Delete forever")!);
    await settle();
    expect(await ws.listFiles({ in: "trash" })).toEqual([]);
    expect($('[data-ds="EmptyState"]').textContent).toContain("Trash is empty");
  });

  it("Trash: Restore puts a file back where it was", async () => {
    const { ws, a } = await setup();
    await act(async () => ws.trash({ files: [a.fileKey] }));
    click(sidebar("Trash"));
    await settle();
    expect(cards()).toEqual(["Alpha", "Old"]);
    mouse(card("Alpha"), "contextmenu");
    click(menuItem("Restore"));
    await settle();
    expect(cards()).toEqual(["Old"]);
    expect((await ws.listFiles({ in: "drafts" })).map((f) => f.name)).toContain("Alpha");
  });

  it(".fig files dropped from Finder are imported into the folder shown (or the folder dropped on); failures are toasts", async () => {
    const { ws, brand, toasts } = await setup();
    const drop = (el: Element, names: string[]) =>
      act(() => {
        const files = names.map((n) => new File([new Uint8Array([1, 2, 3])], n));
        for (const type of ["dragover", "drop"]) {
          const e = new Event(type, { bubbles: true, cancelable: true });
          Object.defineProperty(e, "dataTransfer", { value: { types: ["Files"], files, dropEffect: "none", getData: () => "" } });
          el.dispatchEvent(e);
        }
      });
    drop($('[data-ds="CollectionView"]'), ["Poster.fig", "notes.txt", "bad.fig"]);
    await settle();
    expect((await ws.listFiles({ in: "drafts" })).map((f) => f.name)).toContain("Poster");
    expect(toasts.map((t) => t.message)).toEqual(expect.arrayContaining(["Only .fig files can be imported", "Couldn’t import “bad.fig”: This file uses a compression the browser can't read", "Imported “Poster”"]));
    drop(sidebar("Brand"), ["Logo kit.fig"]);
    await settle();
    expect((await ws.listFiles({ in: "folder", folderId: brand.id })).map((f) => f.name)).toContain("Logo kit");
  });

  it("New design file is made in the folder shown and opened", async () => {
    const { ws, brand, opened } = await setup({ kind: "folder", folderId: "missing" });
    expect($('[data-ds="EmptyState"]').textContent).toContain("This folder is in trash or was deleted");
    click(sidebar("Brand"));
    await settle();
    click(buttonNamed("Design"));
    await settle();
    const files = await ws.listFiles({ in: "folder", folderId: brand.id });
    const made = files.find((f) => f.name === "Untitled");
    expect(made).toBeTruthy();
    expect(opened.at(-1)?.url).toContain(made!.fileKey);
  });
});
