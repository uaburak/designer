// @vitest-environment happy-dom
/**
 * Home's libraries and fonts in an organization (docs/data.md §16–§17, docs/desktop.md §14.3): All teams › Libraries
 * (the org's analytics after a roll-up), a team's View settings › View team's libraries (Enabled by default, Default
 * mode) and View team's fonts (Upload fonts with the rights checkbox, Remove), a library file's Library analytics —
 * on the browser's MemoryStore talking to the real server's handler (src/store/libraries/fake/real.ts). Also: the team
 * page reads /members and /requests once on open.
 */
import { createHash } from "node:crypto";
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AccountState } from "@shared/account";
import type { SharedFontsApi } from "@shared/desktop";
import type { SharedFontFace } from "@shared/fonts/sharedTypes";
import type { CollectionModes, LibrarySettingsInput } from "@shared/libraries/orgTypes";
import { encodeMessage, newDocumentMessage } from "@shared/schema/codec";
import type { ToastOptions } from "@/ds/components/Toast";
import { $, $$, click, mount, type Mounted } from "@/ds/__tests__/dom";
import { MemoryStore } from "@/store/memory/memoryStore";
import { FileBrowser } from "../FileBrowser";
import type { Location } from "../model";
import { localSnapshot, type FilesBackend } from "../storeAccess";

const SERVER = "https://lib.test";
/** Ids as the server makes them (16 base62) */
const ORG = "Org0000000000001";
const TEAM = "Team000000000001";
const FOLDER = "Fold000000000001";
const hex = (s: string) => createHash("sha1").update(s).digest("hex");

/** The part of real.ts used here; loaded by a computed path so the web typecheck doesn't take in the Worker's code */
interface D1 {
  prepare(sql: string): { bind(...a: unknown[]): { run(): Promise<unknown> } };
}
interface RealLibraryServer {
  log: string[];
  clock: number;
  d1: D1;
  addUser(email: string, name?: string): Promise<{ user: { id: string; email: string }; token: string }>;
  addOrg(orgId: string, members: string[]): Promise<void>;
  addTeam(teamId: string, members: string[]): Promise<void>;
  addFile(key: string, f: { orgId: string; teamId?: string | null; projectId?: string | null; name?: string; editors?: string[] }): Promise<void>;
  fetch: typeof fetch;
}
const REAL = "../../../../store/libraries/fake/real";
const ROLLUP = "../../../../../server/src/analytics/rollup";

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
  for (const s of stores.splice(0)) s.dispose();
  vi.unstubAllGlobals();
});

const settle = (ms = 40) => act(async () => new Promise((r) => setTimeout(r, ms)));
const settleLong = async () => {
  for (let i = 0; i < 6; i++) await settle();
};
const press = (el: Element) =>
  act(() => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
const contextMenu = (el: Element) =>
  act(() => {
    el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 20, clientY: 20 }));
  });
const buttonNamed = (label: string) => $$("button").find((el) => el.textContent?.trim() === label);
const menuItem = (label: string) => $$('#ds-overlays [role^="menuitem"]').find((el) => el.textContent?.includes(label));
const dialog = (title: string) => $$('[role="dialog"]').find((d) => d.querySelector("h2, [id]")?.textContent?.trim() === title || d.getAttribute("aria-label") === title || d.textContent?.startsWith(title));
const dialogButton = (label: string) => $$('[role="dialog"] button').find((el) => el.textContent?.trim() === label);
async function choose(comboLabel: string, option: string) {
  const combo = $$('[role="combobox"]').find((el) => el.getAttribute("aria-label") === comboLabel)!;
  expect(combo, comboLabel).toBeTruthy();
  click(combo);
  await settle(10);
  click($$('[role="option"]').find((o) => o.textContent?.trim() === option)!);
  await settleLong();
}

/** A fake of Home's preload fonts API (main's channels), one team's faces */
function fakeFonts() {
  let faces: SharedFontFace[] = [];
  const calls: string[] = [];
  const face = (family: string, style: string, id: string): SharedFontFace => ({ id, family, style, postscriptName: `${family}-${style}`, weight: 400, italic: false, stretch: 5, variable: false, sha1: hex(id), format: "otf", size: 10, fileName: `${family}.otf`, orgId: ORG, teamId: TEAM, uploadedAt: 0, uploadedBy: null });
  faces = [face("Brand Sans", "Regular", "f1"), face("Brand Sans", "Bold", "f2")];
  const api: SharedFontsApi = {
    sharedList: async () => ({ faces }),
    sharedPick: async () => {
      calls.push("pick");
      return {
        candidates: [{ token: "tok1", fileName: "Brand Serif.otf", format: "otf", size: 10, sha1: hex("x"), faces: [{ family: "Brand Serif", style: "Regular", postscriptName: "BrandSerif", weight: 400, italic: false, stretch: 5, variable: false }] }],
        conflicts: [],
        failed: [],
      };
    },
    sharedUpload: async (req) => {
      calls.push(`upload ${req.tokens.join(",")} ${req.licenceConfirmed}`);
      const f = face("Brand Serif", "Regular", "f3");
      faces = [...faces, f];
      return { uploaded: [f], skipped: [], replaced: [], failed: [] };
    },
    sharedRemove: async (req) => {
      calls.push(`remove ${req.family}`);
      faces = faces.filter((f) => f.family !== req.family);
      return { faces };
    },
  };
  return { api, calls };
}

async function setup(initialLocation: Location) {
  vi.stubGlobal("WebSocket", NoSocket);
  const srv = new ((await import(/* @vite-ignore */ REAL)) as { RealLibraryServer: new () => RealLibraryServer }).RealLibraryServer();
  const alice = await srv.addUser("alice@x.test", "Alice");
  await srv.addOrg(ORG, [alice.user.id]);
  await srv.addTeam(TEAM, [alice.user.id]);
  await srv.addFile("libf_A", { orgId: ORG, teamId: TEAM, projectId: FOLDER, name: "Design System", editors: [alice.user.id] });
  await srv.addFile("appf_B", { orgId: ORG, teamId: TEAM, projectId: FOLDER, name: "App", editors: [alice.user.id] });
  vi.stubGlobal("fetch", srv.fetch);
  const state: AccountState = { server: SERVER, user: { id: alice.user.id, email: alice.user.email, name: "Alice", picture: null }, signingIn: false };
  (window as unknown as { designer: unknown }).designer = { account: { get: async () => state, signIn: async () => ({ ok: true, state }), cancelSignIn: async () => state, signOut: async () => state, onChanged: () => () => {} } };

  const store = await MemoryStore.open({ teamName: "Alice's team" });
  stores.push(store);
  const api = store.api();
  await api.multiplayer.setSession({ server: SERVER, token: alice.token });
  // Publish the library from its org copy (a component), then a week of inserts and the daily roll-up
  const space = (key: string) => ({ orgId: ORG, key, teamId: TEAM, projectId: FOLDER });
  await store.addFile({ name: "Design System", folderId: null, snapshot: encodeMessage(newDocumentMessage()), space: space("libf_A") });
  const payload = encodeMessage({ type: "NODE_CHANGES", sessionID: 0, ackID: 0, nodeChanges: [{ guid: { sessionID: 1048577, localID: 1 }, phase: "CREATED", type: "SYMBOL", name: "Button" }], blobs: [] });
  const button = { key: hex("button"), kind: "COMPONENT" as const, name: "Button", description: "", guid: "1048577:1", versionHash: hex("b@1"), dependencyOnly: false, dependencies: [], payload };
  await api.libraries.publish({ libraryFileKey: "libf_A", description: "", assets: [button], moves: [] });
  await srv.d1
    .prepare(`INSERT INTO library_actions_daily (day, library_key, asset_key, asset_type, file_key, team_id, workspace_id, action, count) VALUES ('2026-10-08', 'libf_A', ?1, 'component', 'appf_B', ?2, NULL, 'insert', 7)`)
    .bind(button.key, TEAM)
    .run();
  const { rollup } = (await import(/* @vite-ignore */ ROLLUP)) as { rollup: (d1: D1, now: number) => Promise<unknown> };
  await rollup(srv.d1, srv.clock);
  await api.workspace.setBrowsePrefs({ space: `org:${ORG}` });

  const fonts = fakeFonts();
  const settingsCalls: LibrarySettingsInput[] = [];
  const collections: CollectionModes[] = [{ collectionKey: hex("c"), name: "Theme", modes: [{ id: "m1", name: "Light" }, { id: "m2", name: "Dark" }] }];
  const backend: FilesBackend = {
    workspace: api.workspace,
    source: "memory",
    thumbnailUrl: () => null,
    org: {
      orgs: api.orgs,
      teams: api.teams,
      projects: api.projects,
      admin: api.admin,
      openShared: (k) => api.multiplayer.openShared(k),
      snapshotOf: (k) => localSnapshot(api.files, k),
      // The real repository; `get` adds a two-mode collection (publishing one needs the editor's payloads)
      orgLibraries: {
        ...api.orgLibraries,
        get: async (orgId, key) => ({ ...(await api.orgLibraries.get(orgId, key)), collections }),
        updateSettings: (orgId, key, input) => {
          settingsCalls.push(input);
          return api.orgLibraries.updateSettings(orgId, key, input);
        },
      },
      analytics: api.analytics,
      fonts: fonts.api,
    },
  };
  const toasts: ToastOptions[] = [];
  srv.log.length = 0;
  m = mount(FileBrowser, { backend, initialLocation, toast: (t: ToastOptions) => toasts.push(t), openDeps: { navigate: () => {} } });
  await settleLong();
  return { srv, api, fonts, toasts, settingsCalls };
}

const teamMenu = async (label: string) => {
  press($('[aria-label="Team actions"]')!);
  await settle(10);
  click(menuItem(label)!);
  await settleLong();
};

describe("libraries and fonts in Home (docs/data.md §16–§17)", () => {
  it("All teams › Libraries: the org's totals and each library's inserts last week; Search; a row opens Library analytics", async () => {
    await setup({ kind: "teams" });
    click(buttonNamed("Libraries")!);
    await settleLong();
    const d = dialog("Libraries")!;
    expect(d).toBeTruthy();
    const totals = Object.fromEntries($$("dl[aria-label='Totals'] > div", d).map((el) => [el.querySelector("dt")!.textContent, el.querySelector("dd")!.textContent]));
    expect(totals).toMatchObject({ "Total teams": "1", "Teams with libraries": "1", "Total libraries": "1", "Total components": "1", "Total styles": "0" });
    expect($$("th", d).map((th) => th.textContent)).toEqual(["Library", "# of components", "# of styles", "Inserts last week"]);
    const row = $("tr[data-library='Design System']", d)!;
    expect([...row.querySelectorAll("td")].slice(1).map((td) => td.textContent)).toEqual(["1", "0", "7"]);
    // Search filters by name
    const search = $("input", d) as HTMLInputElement;
    act(() => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      set.call(search, "zzz");
      search.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await settle();
    expect($("tr[data-library='Design System']", d)).toBeNull();
    expect(d.textContent).toContain("No libraries match “zzz”.");
    act(() => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      set.call(search, "design");
      search.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await settle();
    click($("tr[data-library='Design System'] button", d)!);
    await settleLong();
    expect(dialog("Library analytics")).toBeTruthy();
  });

  it("a library file's context menu offers Library analytics; other files don't", async () => {
    await setup({ kind: "project", projectId: FOLDER });
    const card = (name: string) => $$('[data-ds="FileCard"]').find((el) => el.getAttribute("aria-label") === name)!;
    contextMenu(card("App"));
    await settle();
    expect(menuItem("Library analytics")).toBeUndefined();
    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    await settle();
    contextMenu(card("Design System"));
    await settle();
    click(menuItem("Library analytics")!);
    await settleLong();
    const d = dialog("Library analytics")!;
    expect(d.textContent).toContain("Design System");
  });

  it("the team page reads /members and /requests once on open", async () => {
    const { srv } = await setup({ kind: "team", teamId: TEAM });
    expect($("main h1")?.textContent).toBe(TEAM);
    expect(srv.log.filter((l) => l === `GET /teams/${TEAM}/members`)).toHaveLength(1);
    expect(srv.log.filter((l) => l === `GET /teams/${TEAM}/requests`)).toHaveLength(1);
  });

  it("View settings › View team's libraries: Enabled by default and Default mode write the team's row", async () => {
    const { api, settingsCalls } = await setup({ kind: "team", teamId: TEAM });
    await teamMenu("View settings");
    expect(dialog(`${TEAM} settings`)?.textContent).toContain("Shared");
    click(dialogButton("View team’s libraries")!);
    await settleLong();
    const d = dialog("Libraries")!;
    expect($$("th", d).map((th) => th.textContent)).toEqual(["Library", "Enabled by default", "Default mode"]);
    const combo = (label: string) => $$('[role="combobox"]', d).find((el) => el.getAttribute("aria-label") === label);
    expect(combo("Design System: Enabled by default")?.textContent).toContain("Off");
    expect(combo("Design System: Theme default mode")).toBeUndefined(); // only once on for Design files
    await choose("Design System: Enabled by default", "Design files");
    expect(settingsCalls[0]).toEqual({ scope: { type: "team", id: TEAM }, defaults: { design: true, figjam: null, slides: null, buzz: null } });
    const row = (await api.orgLibraries.teamLibraries(TEAM)).find((r) => r.key === "libf_A")!;
    expect(row.setting.defaults.design).toBe(true);
    expect(combo("Design System: Enabled by default")?.textContent).toContain("Design files");
    // The Default mode column: the collection's modes, the first being its default
    expect(combo("Design System: Theme default mode")?.textContent).toContain("Light");
    await choose("Design System: Theme default mode", "Dark");
    expect(settingsCalls[1]).toEqual({ scope: { type: "team", id: TEAM }, defaultModes: [{ collectionKey: hex("c"), modeId: "m2" }] });
    // All files, then Off again
    await choose("Design System: Enabled by default", "All files");
    expect((await api.orgLibraries.teamLibraries(TEAM)).find((r) => r.key === "libf_A")!.setting.defaults).toEqual({ design: true, figjam: true, slides: true, buzz: true });
    await choose("Design System: Enabled by default", "Off");
    expect(settingsCalls.at(-1)!.defaults).toEqual({ design: null, figjam: null, slides: null, buzz: null });
  });

  it("View settings › View team's fonts: the families, Upload fonts after the rights checkbox, Remove", async () => {
    const { fonts } = await setup({ kind: "team", teamId: TEAM });
    await teamMenu("View settings");
    click(dialogButton("View team’s fonts")!);
    await settleLong();
    let d = dialog("Fonts")!;
    expect($$("li[data-family]", d).map((li) => li.textContent)).toEqual(["Brand Sans2 styles"]);
    click(dialogButton("Upload fonts")!);
    await settleLong();
    d = dialog("Upload fonts")!;
    expect(d.textContent).toContain("Brand Serif.otf");
    const upload = dialogButton("Upload")! as HTMLButtonElement;
    expect(upload.disabled).toBe(true);
    click($("label", d)!.closest("label")!.querySelector("input") ?? $("label", d)!);
    await settle();
    expect((dialogButton("Upload") as HTMLButtonElement).disabled).toBe(false);
    click(dialogButton("Upload")!);
    await settleLong();
    expect(fonts.calls).toEqual(["pick", "upload tok1 true"]);
    d = dialog("Fonts")!;
    expect($$("li[data-family]", d).map((li) => li.getAttribute("data-family"))).toEqual(["Brand Sans", "Brand Serif"]);
    click($('[aria-label="Remove Brand Sans"]', d)!);
    await settleLong();
    expect(fonts.calls.at(-1)).toBe("remove Brand Sans");
    expect($$("li[data-family]", dialog("Fonts")!).map((li) => li.getAttribute("data-family"))).toEqual(["Brand Serif"]);
  });
});
