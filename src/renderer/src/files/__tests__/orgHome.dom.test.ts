// @vitest-environment happy-dom
/**
 * Home in an organization (docs/multiplayer.md §14.6) on the browser's MemoryStore talking to the real server's
 * contract fake (src/store/org/fake/server.ts; the real handler, fake/real.ts, needs node:sqlite and file URLs, which happy-dom has not): the space switcher and Create organization,
 * the org's sidebar, All teams / a team / a folder, creating files and folders, Move to a folder across spaces,
 * Recents saying the team, Ask to upgrade for a View seat, Admin.
 */
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AccountState } from "@shared/account";
import type { ToastOptions } from "@/ds/components/Toast";
import { $, $$, click, mount, type, type Mounted } from "@/ds/__tests__/dom";
import { MemoryStore } from "@/store/memory/memoryStore";
import { FakeOrgServer } from "../../../../store/org/fake/server";
import { FileBrowser } from "../FileBrowser";
import type { Location } from "../model";
import { localSnapshot, type FilesBackend } from "../storeAccess";

const SERVER = "https://org.test";

class NoSocket {
  binaryType = "arraybuffer";
  readyState = 0;
  onopen = null;
  onmessage = null;
  onclose = null;
  onerror = null;
  send() {}
  close() {}
}

let m: Mounted | null = null;
const stores: MemoryStore[] = [];
afterEach(() => {
  m?.unmount();
  m = null;
  document.body.innerHTML = "";
  delete (window as unknown as { designer?: unknown }).designer;
  for (const s of stores.splice(0)) {
    s.org.close();
    s.multiplayer.close();
  }
  vi.unstubAllGlobals();
});

const settle = (ms = 60) => act(async () => new Promise((r) => setTimeout(r, ms)));
/** Several rounds: the store answers from the server, then Home reloads */
const settleLong = async () => {
  for (let i = 0; i < 6; i++) await settle();
};

/** Main's account as the preload exposes it, signed in */
function signedIn(user: { id: string; email: string; name: string }) {
  const state: AccountState = { server: SERVER, user: { ...user, picture: null }, signingIn: false };
  (window as unknown as { designer: unknown }).designer = { account: { get: async () => state, signIn: async () => ({ ok: true, state }), cancelSignIn: async () => state, signOut: async () => state, onChanged: () => () => {} } };
}

async function person(srv: FakeOrgServer, token: string) {
  const store = await MemoryStore.open({ teamName: "Burak's team" });
  stores.push(store);
  await store.multiplayer.setSession({ server: SERVER, token });
  const api = store.api();
  const backend: FilesBackend = {
    workspace: api.workspace,
    source: "memory",
    thumbnailUrl: () => null,
    org: { orgs: api.orgs, teams: api.teams, projects: api.projects, admin: api.admin, openShared: (k) => api.multiplayer.openShared(k), snapshotOf: (k) => localSnapshot(api.files, k) },
  };
  return { store, api, backend };
}

async function setup(initialLocation: Location = { kind: "drafts" }) {
  vi.stubGlobal("WebSocket", NoSocket);
  const srv = new FakeOrgServer();
  vi.stubGlobal("fetch", srv.fetch);
  const alice = await srv.addUser("alice@example.com", "Alice");
  const a = await person(srv, alice.token);
  signedIn(alice.user);
  const toasts: ToastOptions[] = [];
  const opened: string[] = [];
  m = mount(FileBrowser, { backend: a.backend, initialLocation, toast: (t: ToastOptions) => toasts.push(t), openDeps: { navigate: (url: string) => opened.push(url) } });
  await settleLong();
  return { srv, alice, a, toasts, opened };
}

const sidebarItem = (label: string) => $$('nav [data-ds="SidebarItem"]').find((el) => el.textContent?.trim() === label);
const buttonNamed = (label: string) => $$("button").find((el) => el.textContent?.trim() === label && !el.closest('[data-ds="Breadcrumb"]'));
const menuItem = (label: string) => $$('#ds-overlays [role^="menuitem"]').find((el) => el.textContent?.includes(label));
const dialogButton = (label: string) => $$('[role="dialog"] button').find((el) => el.textContent?.trim() === label)!;
const press = (el: Element) =>
  act(() => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
const contextMenu = (el: Element) =>
  act(() => {
    el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 20, clientY: 20 }));
  });

/** Create organization… from the space row, then a team and a folder in it */
async function acme(ctx: Awaited<ReturnType<typeof setup>>) {
  press($('nav button[aria-label$="switch space"]')!);
  click(menuItem("Create organization…")!);
  type($('[role="dialog"] input') as HTMLInputElement, "Acme");
  click(dialogButton("Create organization"));
  await settleLong();
  click(buttonNamed("Create team")!);
  type($('[role="dialog"] input') as HTMLInputElement, "Design");
  click(dialogButton("Create team"));
  await settleLong();
  click(buttonNamed("New folder")!);
  type($('[role="dialog"] input') as HTMLInputElement, "Web");
  click(dialogButton("Create folder"));
  await settleLong();
  const orgId = (await ctx.a.api.orgs.list())[0].id;
  const team = (await ctx.a.api.teams.list(orgId))[0];
  const folder = (await ctx.a.api.projects.list(team.id))[0];
  return { orgId, team, folder };
}

describe("Home in an organization", () => {
  it("Create organization switches the space: the org row with its badge, Drafts / All teams / Resources / Trash / Admin", async () => {
    const ctx = await setup();
    expect($("nav")!.textContent).toContain("Burak's team");
    const { orgId, team, folder } = await acme(ctx);
    expect((await ctx.a.api.workspace.getPrefs()).browse.space).toBe(`org:${orgId}`);
    const nav = $("nav")!.textContent!;
    expect(nav).toContain("Acme");
    expect(nav).toContain("Enterprise"); // the plan's name, as Figma's badge (1.png "Professional")
    expect(nav).not.toContain("Organization");
    for (const label of ["Drafts", "All teams", "Design", "Resources", "Trash", "Admin"]) expect(sidebarItem(label), label).toBeTruthy();
    // The team page: its name, the folder made, Folders / Members
    expect($("main h1")?.textContent).toBe("Design");
    expect($$('[data-ds="FolderCard"]').map((el) => el.getAttribute("aria-label"))).toEqual(["Web"]);
    expect(team.name).toBe("Design");
    expect(folder.name).toBe("Web");
    // The sidebar opens the team to its folders
    click($('nav [role="treeitem"] button[aria-label="Expand"]')!);
    await settleLong();
    expect(sidebarItem("Web")).toBeTruthy();
    // The switcher lists both spaces; back to the local one
    press($('nav button[aria-label$="switch space"]')!);
    expect($$('#ds-overlays [role^="menuitem"]').map((el) => el.textContent?.trim())).toEqual(expect.arrayContaining(["Burak's team", "Acme", "Create organization…"]));
    click(menuItem("Burak's team")!);
    await settleLong();
    expect(sidebarItem("All folders")).toBeTruthy();
    expect(sidebarItem("All teams")).toBeFalsy();
  });

  it("the team's menu: Rename and Change icon (§14.16); the icon shows on the page, in the sidebar; the org's in the space row and switcher", async () => {
    const ctx = await setup();
    const { orgId, team } = await acme(ctx);
    const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 9, 9]);
    const teamMenu = async (label: string) => {
      press($('main button[aria-label="Team actions"]')!);
      await settle();
      click(menuItem(label)!);
      await settle();
    };
    // Without an icon: the initial
    expect($("main [data-team-icon]")?.getAttribute("data-initial")).toBe("D");
    await teamMenu("Rename");
    const input = $('[role="dialog"] input') as HTMLInputElement;
    expect(input.value).toBe("Design");
    type(input, "Product");
    click(dialogButton("Rename"));
    await settleLong();
    expect($("main h1")?.textContent).toBe("Product");
    expect(sidebarItem("Product")).toBeTruthy();

    await teamMenu("Change icon");
    const file = $('[role="dialog"] [data-icon-input]') as HTMLInputElement;
    act(() => {
      Object.defineProperty(file, "files", { value: [new File([PNG], "logo.png", { type: "image/png" })], configurable: true });
      file.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await settle();
    click(dialogButton("Save"));
    await settleLong();
    expect($$('[role="dialog"]')).toHaveLength(0);
    expect((await ctx.a.api.teams.get(team.id)).iconUrl).toMatch(new RegExp(`^/icons/${orgId}/`));
    const src = `data:image/png;base64,${Buffer.from(PNG).toString("base64")}`;
    expect($("main [data-team-icon] img")?.getAttribute("src")).toBe(src);
    expect(sidebarItem("Product")!.querySelector("[data-team-icon] img")?.getAttribute("src")).toBe(src);
    expect(ctx.srv.log).toContain(`PUT /teams/${team.id}/icon`);
    // Remove icon: the initial again
    await teamMenu("Remove icon");
    await settleLong();
    expect($("main [data-team-icon]")?.getAttribute("data-initial")).toBe("P");

    // The org's icon (Admin › Settings sets it): the space row and the switcher show it
    await ctx.a.api.orgs.setIcon(orgId, PNG);
    await settleLong();
    expect($('nav button[aria-label$="switch space"] [data-team-icon] img')?.getAttribute("src")).toBe(src);
    press($('nav button[aria-label$="switch space"]')!);
    await settle();
    expect(menuItem("Acme")!.querySelector("[data-menu-avatar] img")?.getAttribute("src")).toBe(src);
    expect(menuItem("Burak's team")!.querySelector("[data-menu-avatar]")?.getAttribute("data-initial")).toBe("B");
  });

  it("a folder: New design file makes the org file and opens it; Members lists the team; Admin opens the Admin app", async () => {
    const ctx = await setup();
    const { folder } = await acme(ctx);
    await press($$('[data-ds="FolderCard"]')[0]);
    await act(async () => {
      $$('[data-ds="FolderCard"]')[0].dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    });
    await settleLong();
    expect($('main [data-ds="Breadcrumb"]')?.textContent).toContain("Web");
    click($$("main header button").find((el) => el.textContent?.trim() === "Design" && !el.closest('[data-ds="Breadcrumb"]'))!);
    await settleLong();
    const files = await ctx.a.api.projects.files(folder.id);
    expect(files.map((f) => f.name)).toEqual(["Untitled"]);
    expect(ctx.opened.at(-1)).toContain(files[0].fileKey!);
    expect($$('[data-ds="FileCard"]').map((el) => el.getAttribute("aria-label"))).toEqual(["Untitled"]);
    // Members: Inherited, the team's people
    click($$('[role="tab"]').find((t) => t.textContent?.startsWith("Members"))!);
    await settle();
    expect($("main")!.textContent).toContain("Anyone in Design can access");
    expect($('ul[aria-label="Members"]')?.textContent).toContain("Alice");
    // Admin
    click(sidebarItem("Admin")!);
    await settleLong();
    expect(buttonNamed("Back to files")).toBeTruthy();
    click(buttonNamed("Back to files")!);
    await settleLong();
    expect(sidebarItem("Admin")).toBeTruthy();
  });

  it("Move to… takes a local file into a team folder; Recents says its team", async () => {
    const ctx = await setup();
    const { folder } = await acme(ctx);
    const local = await act(async () => ctx.a.api.workspace.createFile({ name: "Poster", folderId: null }));
    await ctx.a.api.workspace.recordViewed(local.fileKey);
    press($('nav button[aria-label$="switch space"]')!);
    click(menuItem("Burak's team")!);
    await settleLong();
    const card = $('[data-ds="FileCard"][aria-label="Poster"]')!;
    contextMenu(card);
    click(menuItem("Move to folder…")!);
    await settleLong();
    const dlg = $('[role="dialog"]')!;
    expect(dlg.textContent).toContain("Acme");
    click($$('[role="dialog"] [role="option"]').find((o) => o.textContent?.trim() === "Web")!);
    click(dialogButton("Move"));
    await settleLong();
    expect(ctx.toasts.map((t) => t.message)).toContain("Moved to Web");
    expect((await ctx.a.api.workspace.listFiles({ in: "drafts" })).map((f) => f.name)).not.toContain("Poster");
    expect((await ctx.a.api.projects.files(folder.id)).map((f) => f.name)).toContain("Poster");
    click(sidebarItem("Recents")!);
    await settleLong();
    expect($('[data-ds="FileCard"][aria-label="Poster"]')?.textContent).toContain("· Design");
  });

  it("All teams: another member joins a Visible team from its card; user groups at the right; the owner deletes and restores it", async () => {
    vi.stubGlobal("WebSocket", NoSocket);
    const srv = new FakeOrgServer();
    vi.stubGlobal("fetch", srv.fetch);
    const alice = srv.addUser("alice@example.com", "Alice");
    const bob = srv.addUser("bob@example.com", "Bob");
    const a = await person(srv, alice.token);
    const org = await a.api.orgs.create({ name: "Acme" });
    const team = await a.api.teams.create(org.id, { name: "Design" });
    await a.api.orgs.createGroup(org.id, { name: "Engineers" });
    await a.api.admin.addPeople(org.id, { emails: ["bob@example.com"], role: "member", seat: "full" });
    const b = await person(srv, bob.token);
    await b.api.workspace.setBrowsePrefs({ space: `org:${org.id}` });
    signedIn(bob.user);
    const toasts: ToastOptions[] = [];
    m = mount(FileBrowser, { backend: b.backend, initialLocation: { kind: "teams" }, toast: (t: ToastOptions) => toasts.push(t) });
    await settleLong();
    expect($("main")!.textContent).toContain("Other teams");
    expect($('aside[aria-label="User groups"]')?.textContent).toContain("Engineers");
    const card = $('[data-team-card="Design"]')!;
    click([...card.querySelectorAll("button")].find((x) => x.textContent?.trim() === "Ask to join")!);
    await settleLong();
    expect(toasts.map((t) => t.message)).toContain("You joined Design");
    expect(sidebarItem("Design")).toBeTruthy();
    expect((await a.api.teams.members(team.id)).map((x) => x.person?.email).sort()).toEqual(["alice@example.com", "bob@example.com"]);
    // The owner: Delete team…, then Restore from the team's page
    m!.unmount();
    signedIn(alice.user);
    await a.api.workspace.setBrowsePrefs({ space: `org:${org.id}` });
    m = mount(FileBrowser, { backend: a.backend, initialLocation: { kind: "team", teamId: team.id }, toast: (t: ToastOptions) => toasts.push(t) });
    await settleLong();
    press($('main [aria-label="Team actions"]')!);
    click(menuItem("Delete team…")!);
    click(dialogButton("Delete team"));
    await settleLong();
    expect((await a.api.teams.list(org.id)).map((t) => t.name)).toEqual([]);
    await a.api.teams.restore(team.id);
    await settleLong();
    expect(sidebarItem("Design")).toBeTruthy();
  });

  it("a View seat: Design asks to upgrade; the request reaches the admins", async () => {
    vi.stubGlobal("WebSocket", NoSocket);
    const srv = new FakeOrgServer();
    vi.stubGlobal("fetch", srv.fetch);
    const alice = await srv.addUser("alice@example.com", "Alice");
    const bob = await srv.addUser("bob@example.com", "Bob");
    const a = await person(srv, alice.token);
    const org = await a.api.orgs.create({ name: "Acme" });
    await a.api.admin.addPeople(org.id, { emails: ["bob@example.com"], role: "member" });
    const b = await person(srv, bob.token);
    await b.api.workspace.setBrowsePrefs({ space: `org:${org.id}` });
    signedIn(bob.user);
    const toasts: ToastOptions[] = [];
    m = mount(FileBrowser, { backend: b.backend, initialLocation: { kind: "org-drafts" }, toast: (t: ToastOptions) => toasts.push(t) });
    await settleLong();
    expect($('[data-ds="Banner"]')?.textContent).toContain("You have a View seat in Acme");
    expect(sidebarItem("Admin")).toBeFalsy();
    click($$("main header button").find((el) => el.textContent?.trim() === "Design" && !el.closest('[data-ds="Breadcrumb"]'))!);
    expect($('[role="dialog"]')?.textContent).toContain("Ask to upgrade");
    click(dialogButton("Send request"));
    await settleLong();
    expect(toasts.map((t) => t.message)).toContain("Request sent");
    expect((await a.api.admin.seatRequests(org.id)).map((r) => [r.person.email, r.seat])).toEqual([["bob@example.com", "full"]]);
  });
});
