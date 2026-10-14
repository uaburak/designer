// @vitest-environment happy-dom
/**
 * Home with personal Drafts in the cloud (docs/cloud.md §2): signed in, the personal space is the person's Drafts and
 * Trash (Figma's Starter layout) — no "All folders", no folder tree, no New folder, no Move to folder with nowhere to
 * go; offline, only the files on this computer list, each with "Available offline", under the offline line. Signed
 * out (no account), the local workspace as before.
 */
import { act } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { $, $$, mount, type Mounted } from "@/ds/__tests__/dom";
import type { CloudEvent, CloudRepository, CloudStatus } from "@shared/store/cloud";
import { AVAILABLE_OFFLINE, FileBrowser, OFFLINE_TEXT } from "../FileBrowser";
import type { Location } from "../model";
import type { FilesBackend } from "../storeAccess";
import { MemoryWorkspace } from "./memoryWorkspace";

let m: Mounted | null = null;
afterEach(() => {
  m?.unmount();
  m = null;
  document.body.innerHTML = "";
});

const settle = () => act(async () => new Promise((r) => setTimeout(r, 40)));

/** The store's `cloud` repository as Home sees it: a status, its events, refresh counted */
function fakeCloud(status: CloudStatus) {
  const listeners = new Set<(e: CloudEvent) => void>();
  let current = status;
  const refreshes: number[] = [];
  const repo: CloudRepository = {
    status: async () => current,
    refresh: async () => {
      refreshes.push(Date.now());
      return current;
    },
    cacheInfo: async () => ({ usedBytes: 0, limitBytes: 5 * 1024 ** 3, files: 0, pinned: 0 }),
    setCacheLimit: async () => ({ usedBytes: 0, limitBytes: 5 * 1024 ** 3, files: 0, pinned: 0 }),
    clearCache: async () => ({ usedBytes: 0, limitBytes: 5 * 1024 ** 3, files: 0, pinned: 0 }),
    watch: (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
  };
  return {
    repo,
    refreshes,
    set(next: Partial<CloudStatus>) {
      current = { ...current, ...next };
      for (const l of listeners) l({ type: "status", status: current });
    },
  };
}

const ONLINE: CloudStatus = { uid: "u_alice", online: true, checked: true, syncedAt: 1, migration: null };

async function setup(cloud: ReturnType<typeof fakeCloud> | null, initialLocation: Location = { kind: "drafts" }) {
  const ws = new MemoryWorkspace({ teamName: "Burak's team" });
  ws.seedFolder({ name: "KOC" });
  const now = Date.now();
  ws.seedFile({ name: "Logo", updatedAt: now - 3000, cloud: { uid: "u_alice", key: "roomLogo01" } });
  ws.seedFile({ name: "Poster", updatedAt: now - 2000, cloud: { uid: "u_alice", key: "roomPoster1", remote: true } });
  await ws.setBrowsePrefs({ sort: "alphabetical" });
  const backend: FilesBackend = { workspace: ws, source: "memory", thumbnailUrl: () => null, ...(cloud ? { cloud: cloud.repo } : {}) };
  m = mount(FileBrowser, { backend, initialLocation, toast: () => {}, openDeps: { navigate: () => {} } });
  await settle();
  return { ws };
}

const cards = () => $$('[data-ds="FileCard"]').map((el) => el.getAttribute("aria-label"));
const sidebarLabels = () => $$('nav [data-ds="SidebarItem"]').map((el) => el.textContent?.trim());
const buttonNamed = (label: string) => $$("button").find((el) => el.textContent?.trim() === label);

describe("Home's personal space (docs/cloud.md §2)", () => {
  it("signed in: All projects (the Drafts) and Trash, no folders or New folder; the store lists the Drafts again when Home shows", async () => {
    const cloud = fakeCloud(ONLINE);
    await setup(cloud);
    expect(sidebarLabels()).toEqual(["All projects", "Trash"]);
    expect(sidebarLabels()).not.toContain("All folders");
    expect(sidebarLabels()).not.toContain("KOC");
    expect(buttonNamed("New folder")).toBeUndefined();
    expect(buttonNamed("Design")).toBeTruthy();
    expect(cards()).toEqual(["Logo", "Poster"]);
    expect($("[data-offline-banner]")).toBeNull();
    expect(cloud.refreshes.length).toBe(1);
  });

  it("a folder page shows Drafts instead (personal Drafts are flat)", async () => {
    await setup(fakeCloud(ONLINE), { kind: "folders" });
    expect($('[data-ds="Breadcrumb"]').textContent).toContain("Drafts");
  });

  it("offline: only the files on this computer, each available offline, under the offline line", async () => {
    const cloud = fakeCloud(ONLINE);
    await setup(cloud);
    act(() => cloud.set({ online: false }));
    await settle();
    expect($("[data-offline-banner]")?.textContent).toBe(OFFLINE_TEXT);
    expect(cards()).toEqual(["Logo"]);
    expect($('[data-ds="FileCard"][aria-label="Logo"] [data-card-badge]')?.textContent).toBe(AVAILABLE_OFFLINE);
    act(() => cloud.set({ online: true }));
    await settle();
    expect(cards()).toEqual(["Logo", "Poster"]);
    expect($("[data-card-badge]")).toBeNull();
  });

  it("before the server was tried, no offline state shows", async () => {
    await setup(fakeCloud({ ...ONLINE, online: false, checked: false }));
    expect($("[data-offline-banner]")).toBeNull();
    expect(cards()).toEqual(["Logo", "Poster"]);
  });

  it("signed out (no account): the local team with its folders, as before", async () => {
    await setup(fakeCloud({ ...ONLINE, uid: null }));
    expect(sidebarLabels()).toContain("All folders");
    expect(sidebarLabels()).toContain("KOC");
    expect($("nav")!.textContent).toContain("Burak's team");
    expect(buttonNamed("New folder")).toBeUndefined(); // Drafts shows Design and Import; New folder is All folders'
  });
});
