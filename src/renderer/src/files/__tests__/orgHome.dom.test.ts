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
  // A team page lists projects, not folders (the owner's Home): the folder its projects go into is made through the store
  const orgId = (await ctx.a.api.orgs.list())[0].id;
  const team = (await ctx.a.api.teams.list(orgId))[0];
  const folder = await act(async () => ctx.a.api.projects.create(team.id, { name: "Web" }));
  await settleLong();
  return { orgId, team, folder };
}

describe("Home in an organization", () => {
  it("Create organization switches the space: the org row with its badge, All projects / All teams / Resources / Trash / Admin — no teams listed", async () => {
    const ctx = await setup();
    expect($("nav")!.textContent).toContain("Burak's team");
    const { orgId, team, folder } = await acme(ctx);
    expect((await ctx.a.api.workspace.getPrefs()).browse.space).toBe(`org:${orgId}`);
    const nav = $("nav")!.textContent!;
    expect(nav).toContain("Acme");
    expect(nav).toContain("Enterprise"); // the plan's name, as Figma's badge (1.png "Professional")
    expect(nav).not.toContain("Organization");
    for (const label of ["All projects", "All teams", "Resources", "Trash", "Admin"]) expect(sidebarItem(label), label).toBeTruthy();
    // Recents and Drafts are gone; the teams are on All teams, not in the sidebar
    for (const label of ["Recents", "Drafts", "Design"]) expect(sidebarItem(label), label).toBeFalsy();
    // The team page: its name, Projects / Members, no folders
    expect($("main h1")?.textContent).toBe("Design");
    expect($$('main [role="tab"]').map((el) => (el.textContent?.startsWith("Projects") ? "Projects" : el.textContent?.startsWith("Members") ? "Members" : el.textContent))).toEqual(["Projects", "Members"]);
    expect($$('[data-ds="FolderCard"]')).toHaveLength(0);
    expect(team.name).toBe("Design");
    expect(folder.name).toBe("Web");
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
      press($('main button[aria-label="Team settings"]')!);
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
    // A double-click on the name renames it in place (the owner's Home): the team's, then the org's on All teams
    await act(async () => void $('main h1 [data-ds="InlineEdit"] > span')!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
    const inline = $("main h1 input") as HTMLInputElement;
    type(inline, "Brand");
    await act(async () => void inline.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    await settleLong();
    expect((await ctx.a.api.teams.get(team.id)).name).toBe("Brand");
    expect($("main h1")?.textContent).toBe("Brand");

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
    expect(ctx.srv.log).toContain(`PUT /teams/${team.id}/icon`);
    // Remove icon: the initial again
    await teamMenu("Remove icon");
    await settleLong();
    expect($("main [data-team-icon]")?.getAttribute("data-initial")).toBe("B");

    // The org's icon (Admin › Settings sets it): the space row and the switcher show it
    await ctx.a.api.orgs.setIcon(orgId, PNG);
    await settleLong();
    expect($('nav button[aria-label$="switch space"] [data-team-icon] img')?.getAttribute("src")).toBe(src);
    press($('nav button[aria-label$="switch space"]')!);
    await settle();
    expect(menuItem("Acme")!.querySelector("[data-menu-avatar] img")?.getAttribute("src")).toBe(src);
    expect(menuItem("Burak's team")!.querySelector("[data-menu-avatar]")?.getAttribute("data-initial")).toBe("B");
  });

  it("a team: Design makes a project in it (its folder) and opens it; Members lists the team; Admin opens the Admin app", async () => {
    const ctx = await setup();
    const { folder } = await acme(ctx);
    click($$("main header button").find((el) => el.textContent?.trim() === "Design" && !el.closest('[data-ds="Breadcrumb"]'))!);
    await settleLong();
    const files = await ctx.a.api.projects.files(folder.id);
    expect(files.map((f) => f.name)).toEqual(["Untitled"]);
    expect(ctx.opened.at(-1)).toContain(files[0].fileKey!);
    expect($$('[data-ds="FileCard"]').map((el) => el.getAttribute("aria-label"))).toEqual(["Untitled"]);
    // Members: the team's people
    click($$('[role="tab"]').find((t) => t.textContent?.startsWith("Members"))!);
    await settle();
    expect($('ul[aria-label="Members"]')?.textContent).toContain("Alice");
    // Admin
    click(sidebarItem("Admin")!);
    await settleLong();
    expect(buttonNamed("Back to files")).toBeTruthy();
    click(buttonNamed("Back to files")!);
    await settleLong();
    expect(sidebarItem("Admin")).toBeTruthy();
  });

  it("Move to… takes a local file into a team folder; All projects lists it", async () => {
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
    press($('nav button[aria-label$="switch space"]')!);
    click(menuItem("Acme")!);
    await settleLong();
    click(sidebarItem("All projects")!);
    await settleLong();
    const poster = $('[data-ds="FileCard"][aria-label="Poster"]')!;
    // Its team at the top left, the star at the top right: starring it puts it in Starred
    expect(poster.querySelector("[data-card-place]")?.textContent).toBe("Design");
    click(poster.querySelector('button[aria-label="Star"]')!);
    await settleLong();
    expect($('[data-ds="FileCard"][aria-label="Poster"] button[aria-label="Unstar"]')).toBeTruthy();
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
    expect((await a.api.teams.members(team.id)).map((x) => x.person?.email).sort()).toEqual(["alice@example.com", "bob@example.com"]);
    // The owner: Delete team…, then Restore from the team's page
    m!.unmount();
    signedIn(alice.user);
    await a.api.workspace.setBrowsePrefs({ space: `org:${org.id}` });
    m = mount(FileBrowser, { backend: a.backend, initialLocation: { kind: "team", teamId: team.id }, toast: (t: ToastOptions) => toasts.push(t) });
    await settleLong();
    press($('main [aria-label="Team settings"]')!);
    click(menuItem("Delete team…")!);
    click(dialogButton("Delete team"));
    await settleLong();
    expect((await a.api.teams.list(org.id)).map((t) => t.name)).toEqual([]);
    await a.api.teams.restore(team.id);
    await settleLong();
    expect((await a.api.teams.list(org.id)).map((t) => t.name)).toEqual(["Design"]);
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

describe("Adding files in an organization (help.figma.com 360041003114)", () => {
  /** Acme (Alice admin) with team Design › folder Web; Bob a member with `bobSeat` and `bobRole` on the team. Home opens
   *  for `who` at `at`, the shell's Import and the backend's `.fig` import spied. */
  async function org(who: "alice" | "bob", at: (ids: { orgId: string; teamId: string; folderId: string }) => Location, opts: { bobSeat?: "full" | "view"; bobRole?: "editor" | "viewer" } = {}) {
    vi.stubGlobal("WebSocket", NoSocket);
    const srv = new FakeOrgServer();
    vi.stubGlobal("fetch", srv.fetch);
    const alice = await srv.addUser("alice@example.com", "Alice");
    const bob = await srv.addUser("bob@example.com", "Bob");
    const a = await person(srv, alice.token);
    const o = await a.api.orgs.create({ name: "Acme" });
    await a.api.admin.addPeople(o.id, { emails: ["bob@example.com"], role: "member", seat: opts.bobSeat ?? "full" });
    const team = await a.api.teams.create(o.id, { name: "Design" });
    await a.api.teams.invite(team.id, { email: "bob@example.com", role: opts.bobRole ?? "editor" });
    const folder = await a.api.projects.create(team.id, { name: "Web" });
    const me = who === "alice" ? a : await person(srv, bob.token);
    await me.api.workspace.setBrowsePrefs({ space: `org:${o.id}` });
    signedIn(who === "alice" ? alice.user : bob.user);
    const shellImport = vi.fn(async () => ({ files: [], failed: [] }));
    (window as unknown as { designer: { files?: unknown } }).designer.files = { import: shellImport };
    const imported: string[] = [];
    const backend: FilesBackend = { ...me.backend, importFigBytes: async (file) => (imported.push(file.name), { name: file.name.replace(/\.fig$/, "") }) as never };
    const toasts: ToastOptions[] = [];
    m = mount(FileBrowser, { backend, initialLocation: at({ orgId: o.id, teamId: team.id, folderId: folder.id }), toast: (t: ToastOptions) => toasts.push(t) });
    await settleLong();
    return { srv, a, me, o, team, folder, shellImport, imported, toasts };
  }
  const header = () => $$("main header button").filter((el) => !el.closest('[data-ds="Breadcrumb"]') && !el.getAttribute("aria-label")).map((el) => el.textContent?.trim());
  const headerButton = (label: string) => $$("main header button").find((el) => el.textContent?.trim() === label && !el.closest('[data-ds="Breadcrumb"]'))!;
  const dropFiles = (el: Element, names: string[]) =>
    act(() => {
      const files = names.map((n) => new File([new Uint8Array([1, 2, 3])], n));
      for (const type of ["dragover", "drop"]) {
        const e = new Event(type, { bubbles: true, cancelable: true });
        Object.defineProperty(e, "dataTransfer", { value: { types: ["Files"], files, dropEffect: "none", getData: () => "" } });
        el.dispatchEvent(e);
      }
    });

  it("the org's Drafts: Design and Import; Import opens the import path; .fig files dropped on the page are imported", async () => {
    const ctx = await org("bob", () => ({ kind: "org-drafts" }));
    expect(header()).toEqual(["Design", "Import"]);
    click(headerButton("Import"));
    await settleLong();
    expect(ctx.shellImport).not.toHaveBeenCalled(); // into an org the page reads the .fig itself (the upload panel path), not main's dialog
    dropFiles($('[data-ds="EmptyState"]')!, ["Poster.fig"]);
    await settleLong();
    expect(ctx.imported).toEqual(["Poster.fig"]);
    // The blank area's menu: New design file, Import…
    await contextMenu($('[data-ds="EmptyState"]')!);
    expect(menuItem("New design file")).toBeTruthy();
    click(menuItem("Import…")!);
    await settleLong();
    expect(ctx.shellImport).not.toHaveBeenCalled();
  });

  it("a folder: New folder, Design and Import; files dropped on it (or on a subfolder's card) are imported", async () => {
    const ctx = await org("bob", (ids) => ({ kind: "project", projectId: ids.folderId }));
    expect(header()).toEqual(["New folder", "Design", "Import"]);
    click(headerButton("Import"));
    await settleLong();
    expect(ctx.shellImport).not.toHaveBeenCalled(); // into an org the page reads the .fig itself (the upload panel path), not main's dialog
    dropFiles($('[data-ds="EmptyState"]')!, ["Logo.fig"]);
    await settleLong();
    expect(ctx.imported).toEqual(["Logo.fig"]);
  });

  it("a team page: Design and Import add projects to the team directly; files dropped on the page go in", async () => {
    const ctx = await org("bob", (ids) => ({ kind: "team", teamId: ids.teamId }));
    expect(header()).toEqual(["Design", "Import"]);
    expect($$('[data-ds="FolderCard"]')).toHaveLength(0);
    dropFiles($('main [role="listbox"][aria-label="Projects"], main [data-ds="EmptyState"]')!, ["Icons.fig"]);
    await settleLong();
    expect(ctx.imported).toEqual(["Icons.fig"]);
    expect(ctx.shellImport).not.toHaveBeenCalled(); // into an org the page reads the .fig itself (the upload panel path), not main's dialog
  });

  it("gated by the caller's role and seat: a team viewer gets no New / Import; a View seat is asked to upgrade", async () => {
    let ctx = await org("bob", (ids) => ({ kind: "project", projectId: ids.folderId }), { bobRole: "viewer" });
    expect(header()).toEqual([]);
    dropFiles($('[data-ds="EmptyState"]')!, ["Logo.fig"]);
    await settleLong();
    expect(ctx.imported).toEqual([]);
    m?.unmount();
    m = null;
    ctx = await org("bob", () => ({ kind: "org-drafts" }), { bobSeat: "view" });
    click(headerButton("Import"));
    await settle();
    expect($('[role="dialog"]')?.textContent).toContain("Ask to upgrade");
    expect(ctx.shellImport).not.toHaveBeenCalled();
  });
});

describe("Leaving and deleting an organization", () => {
  it("Leave organization from the space row's right-click: back to the person's own space", async () => {
    vi.stubGlobal("WebSocket", NoSocket);
    const srv = new FakeOrgServer();
    vi.stubGlobal("fetch", srv.fetch);
    const alice = await srv.addUser("alice@example.com", "Alice");
    const bob = await srv.addUser("bob@example.com", "Bob");
    const a = await person(srv, alice.token);
    const o = await a.api.orgs.create({ name: "Acme" });
    await a.api.admin.addPeople(o.id, { emails: ["bob@example.com"], role: "member" });
    const b = await person(srv, bob.token);
    await b.api.workspace.setBrowsePrefs({ space: `org:${o.id}` });
    signedIn(bob.user);
    const toasts: ToastOptions[] = [];
    m = mount(FileBrowser, { backend: b.backend, initialLocation: { kind: "org-drafts" }, toast: (t: ToastOptions) => toasts.push(t) });
    await settleLong();
    await contextMenu($('nav button[aria-label$="switch space"]')!.closest("div")!);
    click(menuItem("Leave organization…")!);
    expect($('[role="dialog"]')?.textContent).toContain("Leave Acme?");
    click(dialogButton("Leave organization"));
    await settleLong();
    expect(toasts.map((t) => t.message)).toContain("You left Acme");
    expect(await b.api.orgs.list()).toEqual([]);
    expect((await b.api.workspace.getPrefs()).browse.space).toBe("local");
  });

  it("a deleted org shows its admin Restore, and Restore brings it back; its Trash lists trashed drafts with Delete forever", async () => {
    vi.stubGlobal("WebSocket", NoSocket);
    const srv = new FakeOrgServer();
    vi.stubGlobal("fetch", srv.fetch);
    const alice = await srv.addUser("alice@example.com", "Alice");
    const a = await person(srv, alice.token);
    const o = await a.api.orgs.create({ name: "Acme" });
    const { file } = await a.api.orgs.createDraft(o.id, { name: "Sketch" });
    await a.api.projects.trashFiles([file.key]);
    await a.api.workspace.setBrowsePrefs({ space: `org:${o.id}` });
    signedIn(alice.user);
    const toasts: ToastOptions[] = [];
    m = mount(FileBrowser, { backend: a.backend, initialLocation: { kind: "org-trash" }, toast: (t: ToastOptions) => toasts.push(t) });
    await settleLong();
    // Trash: the draft, Restore and Delete forever
    expect($('section[aria-label="Drafts"]')?.textContent).toContain("Sketch");
    await contextMenu($$('[data-ds="FileCard"]').find((c) => c.getAttribute("aria-label") === "Sketch")!);
    click(menuItem("Delete forever")!);
    click(dialogButton("Delete forever"));
    await settleLong();
    expect(await a.api.orgs.trashedDrafts(o.id)).toEqual([]);
    expect($('[data-ds="EmptyState"]')?.textContent).toContain("Trash is empty");
    // Deleted: the page says so, with Restore
    await a.api.orgs.remove(o.id, "Acme");
    await settleLong();
    expect($("main")!.textContent).toContain("Acme was deleted");
    click(buttonNamed("Restore organization")!);
    await settleLong();
    expect(toasts.map((t) => t.message)).toContain("Acme restored");
    expect((await a.api.orgs.list())[0].deletedAt).toBeUndefined();
    expect($("main")!.textContent).not.toContain("Acme was deleted");
  });
});
