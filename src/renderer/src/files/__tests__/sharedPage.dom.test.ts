// @vitest-environment happy-dom
/**
 * Home › Shared (the owner's Home, 2026-10-19; SharedFiles.tsx): a sidebar page in Recents' place listing the files
 * other people shared with the person ("Shared with you", each card "From <name>") and the ones they shared ("Shared
 * by you"), newest share first, as Home's cards or list rows; signed out, failing or empty, Figma-style empty states.
 * The lists come from the store (`FilesBackend.shared` → `multiplayer.listRemote`), never from the view itself.
 */
import { act } from "react";
import { afterEach, describe, expect, it } from "vitest";
import type { AccountState, AccountUser } from "@shared/account";
import type { RemoteFile } from "@shared/multiplayer/types";
import { $, $$, mount, type Mounted } from "@/ds/__tests__/dom";
import { FileBrowser } from "../FileBrowser";
import { sharedRows, type SharedSource } from "../SharedFiles";
import type { Location } from "../model";
import type { FilesBackend } from "../storeAccess";
import { MemoryWorkspace } from "./memoryWorkspace";

let m: Mounted | null = null;
afterEach(() => {
  m?.unmount();
  m = null;
  document.body.innerHTML = "";
  delete (window as unknown as { designer?: unknown }).designer;
});

const settle = () => act(async () => new Promise((r) => setTimeout(r, 40)));
const press = (el: Element) =>
  act(() => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
const dbl = (el: Element) =>
  act(() => {
    el.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
  });

const me: AccountUser = { id: "u_me", email: "demo@example.com", name: "Demo User", picture: null };

/** Main's account as the preload exposes it: signed in (or not) */
function fakeAccount(user: AccountUser | null) {
  const state: AccountState = { server: "https://s", user, signingIn: false, accounts: user ? [user] : [] };
  const calls: string[] = [];
  const account = {
    get: async () => state,
    signIn: async () => (calls.push("signIn"), { ok: true, state }),
    cancelSignIn: async () => state,
    signOut: async () => state,
    onChanged: () => () => {},
    request: async () => ({ ok: true, status: 200, body: null }),
  };
  (window as unknown as { designer: unknown }).designer = { account };
  return calls;
}

const HOUR = 3600e3;
const now = Date.now();
const FILES: RemoteFile[] = [
  { key: "file_a", name: "Marketing site", role: "viewer", ownerId: "u_alan", ownerName: "Alan Turing", sharedAt: now - 26 * HOUR, updatedAt: now - HOUR, fileKey: null },
  { key: "file_b", name: "Mobile app", role: "editor", ownerId: "u_ada", ownerName: "Ada Lovelace", sharedAt: now - 2 * HOUR, updatedAt: now - HOUR, fileKey: null },
  { key: "file_c", name: "Design system", role: "owner", ownerId: "u_me", ownerName: "Demo User", sharedAt: now - 3 * HOUR, updatedAt: now - HOUR, fileKey: null },
];

function fakeSource(files: () => Promise<RemoteFile[]>) {
  const opened: string[] = [];
  let lists = 0;
  const source: SharedSource = {
    list: () => (lists++, files()),
    open: async (key) => (opened.push(key), { fileKey: `local_${key}` }),
  };
  return { source, opened, lists: () => lists };
}

async function setup(shared: SharedSource | undefined, initialLocation: Location = { kind: "drafts" }) {
  const ws = new MemoryWorkspace({ teamName: "My team" });
  const navigated: string[] = [];
  const backend: FilesBackend = { workspace: ws, source: "memory", thumbnailUrl: () => null, ...(shared ? { shared } : {}) };
  m = mount(FileBrowser, { backend, initialLocation, toast: () => {}, openDeps: { navigate: (url: string) => navigated.push(url) } });
  await settle();
  return { navigated };
}

const sidebarLabels = () => $$('nav [data-ds="SidebarItem"]').map((el) => el.textContent?.trim());
const sidebarItem = (label: string) => $$('nav [data-ds="SidebarItem"]').find((el) => el.textContent?.trim() === label)!;
const cards = () => $$('[data-ds="FileCard"]').map((el) => [el.getAttribute("aria-label"), el.querySelector("[class*='subtitle']")?.textContent]);
const tab = (id: string) => $(`[data-shared-tab="${id}"]`);

async function openShared() {
  await press(sidebarItem("Shared"));
  await settle();
}

describe("Home › Shared", () => {
  it("is in the sidebar right under All projects (Recents' place) and titles the page", async () => {
    await setup(undefined);
    expect(sidebarLabels().slice(0, 2)).toEqual(["All projects", "Shared"]);
    await openShared();
    expect(sidebarItem("Shared").getAttribute("aria-current")).toBe("page");
    expect($('[data-ds="Breadcrumb"]').textContent).toContain("Shared");
    // Its two lists as tabs; no Design / Import there
    expect($$('[role="tab"]').map((el) => el.textContent)).toEqual(["Shared with you", "Shared by you"]);
    expect($$("button").some((el) => el.textContent?.trim() === "Import")).toBe(false);
  });

  it("signed out: says to log in, and Log in signs in", async () => {
    const calls = fakeAccount(null);
    const { source, lists } = fakeSource(async () => FILES);
    await setup(source);
    await openShared();
    expect($('[data-shared-empty="signed-out"]').textContent).toContain("Log in to see shared files");
    expect(lists()).toBe(0);
    const logIn = $$('[data-shared-empty] button').find((el) => el.textContent === "Log in")!;
    await press(logIn);
    expect(calls).toEqual(["signIn"]);
  });

  it("signed in: Shared with you lists the others' files newest share first, each “From <name>”; Shared by you the person's own", async () => {
    fakeAccount(me);
    const { source } = fakeSource(async () => FILES);
    await setup(source);
    await openShared();
    expect(cards()).toEqual([
      ["Mobile app", "From Ada Lovelace"],
      ["Marketing site", "From Alan Turing"],
    ]);
    expect($$("button").some((el) => el.textContent === "Open link…")).toBe(true);
    await press(tab("by-you"));
    expect(tab("by-you").getAttribute("aria-selected")).toBe("true");
    expect(cards()).toEqual([["Design system", "Shared 3 hours ago"]]);
  });

  it("the list view shows rows with who shared each file and when", async () => {
    fakeAccount(me);
    const { source } = fakeSource(async () => FILES);
    await setup(source);
    await openShared();
    await press($('[data-ds="SegmentedControl"] [aria-label="List view"], [data-ds="SegmentedControl"] button:last-child'));
    await settle();
    const rows = $$('[data-shared-files] [data-ds="ListRow"]');
    expect(rows.map((r) => r.textContent)).toEqual([expect.stringContaining("Mobile app"), expect.stringContaining("Marketing site")]);
    expect(rows[0].textContent).toContain("Ada Lovelace");
    expect($('[data-shared-files] [data-ds="ListHeader"]').textContent).toContain("Date shared");
  });

  it("opens a shared file's local copy through the store on double-click", async () => {
    fakeAccount(me);
    const { source, opened } = fakeSource(async () => FILES);
    await setup(source);
    await openShared();
    await dbl($('[data-shared-file="file_b"] [data-ds="FileCard"]'));
    await settle();
    expect(opened).toEqual(["file_b"]);
  });

  it("offline (the server not answering): Couldn’t load shared files, and Try again asks again", async () => {
    fakeAccount(me);
    let fail = true;
    const { source, lists } = fakeSource(async () => {
      if (fail) throw new Error("You’re offline");
      return FILES;
    });
    await setup(source);
    await openShared();
    expect($('[data-shared-empty="failed"]').textContent).toContain("Couldn’t load shared files");
    expect($('[data-shared-empty="failed"]').textContent).toContain("You’re offline");
    fail = false;
    await press($$('[data-shared-empty] button').find((el) => el.textContent === "Try again")!);
    await settle();
    expect(lists()).toBe(2);
    expect(cards().length).toBe(2);
  });

  it("nothing shared: Figma's empty states for each list", async () => {
    fakeAccount(me);
    const { source } = fakeSource(async () => []);
    await setup(source);
    await openShared();
    expect($('[data-shared-empty="none"]').textContent).toContain("No shared files");
    await press(tab("by-you"));
    expect($('[data-shared-empty="none"]').textContent).toContain("You haven’t shared any files");
  });
});

describe("sharedRows", () => {
  it("splits by role and orders by date shared", () => {
    expect(sharedRows(FILES, "with-you").map((f) => f.key)).toEqual(["file_b", "file_a"]);
    expect(sharedRows(FILES, "with-you", "reversed").map((f) => f.key)).toEqual(["file_a", "file_b"]);
    expect(sharedRows(FILES, "by-you").map((f) => f.key)).toEqual(["file_c"]);
  });
});
