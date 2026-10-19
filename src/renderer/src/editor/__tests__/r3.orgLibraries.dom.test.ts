// @vitest-environment happy-dom
/**
 * Org libraries in the editor (docs/data.md §16–§17, round 3c) on the real engine (headless Wasm), the browser's
 * MemoryStore and the real server's handler (src/store/libraries/fake/real.ts):
 * - "this file's library" is the room key (`libraryKeyOfFile`): record, publish, the clipboard's origin;
 * - the Publish dialog's "Allow any member of ‹org› to access the file" → `PublishRequest.scope` (the file's link
 *   becomes "Anyone at ‹org›"); unchecked: a team library;
 * - the Libraries modal of an org file: the org's libraries by team, approved ones pinned first with their check mark;
 * - a default mode applied at first use (§16.5): the collection's mode set on every page;
 * - usage events (§17.3): an insertion of a library component queued for the server, not its undo;
 * - "Review unpublished changes" on the Libraries button; the file name menu's "Library analytics".
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, createElement } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Engine } from "@/engine/Engine";
import { EngineStore } from "@/engine/EngineStore";
import { loadEngine } from "@/engine/loadEngine";
import type { Message } from "@/engine/codec";
import { $, $$, mount, type Mounted } from "@/ds/__tests__/dom";
import { encodeMessage } from "@shared/schema/codec";
import { messageToKiwi } from "../../store/engineMessage";
import { openStoreDocument } from "../../store/documentSource";
import { MemoryStore } from "../../store/memory/memoryStore";
import { EditorContext, EditorController } from "../controller";
import { COMPONENTS_DOCUMENT, VARIABLES_DOCUMENT } from "../fixtures";
import { draftPublish, ensureCopy, insertLibraryComponent, librariesButtonLabel, publishLibrary, setLibraryEnabled } from "../libraries";
import { renameVariable } from "../variables";
import { PublishDialog } from "../panels/libraries/PublishDialog";
import { LibrariesDialog } from "../panels/libraries/LibrariesDialog";
import { command } from "../commands";
import { canShowLibraryAnalytics } from "../analytics";
import { gid } from "../libraryUsage";

const SERVER = "https://lib.test";
const ORG = "Org0000000000001";
const TEAM = "Team000000000001";
const FOLDER = "Fold000000000001";

interface RealLibraryServer {
  log: string[];
  addUser(email: string, name?: string): Promise<{ user: { id: string; email: string }; token: string }>;
  addOrg(orgId: string, members: string[]): Promise<void>;
  addTeam(teamId: string, members: string[]): Promise<void>;
  addFile(key: string, f: { orgId: string; teamId?: string | null; projectId?: string | null; name?: string; editors?: string[] }): Promise<void>;
  library(key: string): Promise<{ scope: string; status: string; latestVersion: number } | null>;
  orgLinkAccess(key: string): Promise<string | null>;
  fetch: typeof fetch;
}
const REAL = "../../../../store/libraries/fake/real";
const wasm = resolve(process.cwd(), "src/renderer/src/engine/wasm/engine.wasm");

let srv: RealLibraryServer;
beforeAll(async () => {
  const bytes = readFileSync(wasm);
  await loadEngine({ wasmBinary: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), printErr: () => {} });
});

const cleanups: (() => void)[] = [];
let view: Mounted | null = null;
afterEach(() => {
  view?.unmount();
  view = null;
  document.body.innerHTML = "";
  for (const c of cleanups.splice(0)) c();
  vi.unstubAllGlobals();
});
const settle = (ms = 40) => act(async () => new Promise((r) => setTimeout(r, ms)));
const settleLong = async (n = 8) => {
  for (let i = 0; i < n; i++) await settle();
};

/** A file with its first page and that page's layers (no components of its own) */
const APP: Message = { type: "NODE_CHANGES", sessionID: 0, nodeChanges: COMPONENTS_DOCUMENT.nodeChanges.filter((n) => n.type === "DOCUMENT" || n.guid === "0:1" || (n.parentIndex?.guid === "0:1" && n.type !== "SYMBOL")) };

async function world() {
  srv = new ((await import(/* @vite-ignore */ REAL)) as { RealLibraryServer: new () => RealLibraryServer }).RealLibraryServer();
  const alice = await srv.addUser("alice@x.test");
  await srv.addOrg(ORG, [alice.user.id]);
  await srv.addTeam(TEAM, [alice.user.id]);
  for (const [key, name] of [["libf_Comp", "Components"], ["libf_Tok", "Tokens"], ["appf_App", "App"]]) await srv.addFile(key, { orgId: ORG, teamId: TEAM, projectId: FOLDER, name, editors: [alice.user.id] });
  // Engine fonts aren't on the server: a 404 for them, the handler for the rest
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => (String(input).startsWith(SERVER) ? srv.fetch(input, init) : Promise.resolve(new Response(null, { status: 404 }))));
  const store = await MemoryStore.open({ teamName: "Alice's team" });
  cleanups.push(() => store.dispose());
  const api = store.api();
  await api.multiplayer.setSession({ server: SERVER, token: alice.token });
  const space = (key: string) => ({ orgId: ORG, key, teamId: TEAM, projectId: FOLDER });
  const file = async (name: string, key: string, doc: Message) => (await store.addFile({ name, folderId: null, snapshot: encodeMessage(messageToKiwi(doc)), space: space(key) })).fileKey;
  const keys = { comp: await file("Components", "libf_Comp", COMPONENTS_DOCUMENT), tok: await file("Tokens", "libf_Tok", VARIABLES_DOCUMENT), app: await file("App", "appf_App", APP) };
  const open = async (fileKey: string) => {
    const source = await openStoreDocument(store.api({}), fileKey, { recordViewed: false });
    const engine = await Engine.create(null, { sessionID: source.sessionID });
    engine.load(await source.load());
    engine.setViewport(1280, 800, 1, 1280, 800);
    const ed = new EditorController(engine, new EngineStore(engine), source);
    engine.onDocumentChanged((_, e) => source.onChanges(e.message, { kind: e.kind, label: e.label }));
    await ed.libraries.refresh();
    cleanups.push(() => engine.destroy());
    return { ed, engine, source };
  };
  return { store, api, keys, open };
}

const publishAll = async (ed: EditorController, scope?: "team" | "org") => {
  const d = await draftPublish(ed);
  return publishLibrary(ed, d, { description: "", selected: new Set([...d.items.map((i) => i.key), ...d.removed.map((r) => r.key)]), moveModes: new Map(), ...(scope ? { scope } : {}) });
};

describe("org libraries in the editor (docs/data.md §16–§17)", () => {
  it("publishes under the room key; the Publish dialog's org checkbox makes it an org library", async () => {
    const w = await world();
    const lib = await w.open(w.keys.comp);
    const access = lib.source.libraries;
    expect(access.fileKey).toBe(w.keys.comp);
    expect(access.libraryKey).toBe("libf_Comp");
    expect(lib.ed.libraries.get().inDrafts).toBe(false);
    expect(lib.ed.libraries.get().org).toMatchObject({ orgId: ORG, orgName: ORG, canShare: true, scope: null });

    lib.ed.ui.set({ publishOpen: true });
    view = mount(() => createElement(EditorContext.Provider, { value: lib.ed }, createElement(PublishDialog)), {});
    await settleLong();
    // Publish to (atlas 12 §3.2): the team first (never published), the organization chosen, the audience warning.
    const scope = $('[data-publish-org-scope] [role="combobox"]') as HTMLElement;
    expect(scope.textContent).toContain("Everyone on this file's team");
    expect($("[data-publish-audience]")).toBeNull();
    act(() => scope.click());
    act(() => ($$('[role="option"]').find((o) => o.textContent?.includes(`Everyone at ${ORG}`)) as HTMLElement).click());
    expect(($('[data-publish-org-scope] [role="combobox"]') as HTMLElement).textContent).toContain(`Everyone at ${ORG}`);
    expect($("[data-publish-audience]")?.textContent).toContain(`anyone in ${ORG}`);
    act(() => $$('[role="dialog"] button').find((b) => b.textContent?.trim() === "Publish")!.click());
    await settleLong(15);
    expect(srv.log).toContain("POST /libraries/libf_Comp/versions");
    expect(await srv.library("libf_Comp")).toMatchObject({ scope: "org", latestVersion: 1 });
    expect(await srv.orgLinkAccess("libf_Comp")).toBe("viewer");
    expect(lib.ed.libraries.get().own?.latestVersion).toBe(1);
    // Published, nothing changed since: the button's plain tooltip; Library analytics in the file name menu
    expect(librariesButtonLabel(lib.ed)).toBe("Libraries");
    await lib.ed.libraries.refresh();
    expect(lib.ed.libraries.get().org?.scope).toBe("org");
    expect(canShowLibraryAnalytics(lib.ed)).toBe(true);
    expect(command("file.library-analytics")?.label).toBe("Library analytics");
  });

  it("the Libraries modal: by team, approved pinned first with its check mark; a default mode at first use; usage events", async () => {
    const w = await world();
    const comp = await w.open(w.keys.comp);
    await publishAll(comp.ed, "org");
    const tok = await w.open(w.keys.tok);
    await publishAll(tok.ed);
    expect(await srv.library("libf_Tok")).toMatchObject({ scope: "team" });
    // Tokens: changed after its publish → "Review unpublished changes"
    await tok.ed.libraries.refresh();
    expect(tok.ed.libraries.get().own?.latestVersion).toBe(1);
    expect(librariesButtonLabel(tok.ed)).toBe("Libraries");
    expect(renameVariable(tok.ed, "5:20", "color/brand")).toBe(true);
    expect(librariesButtonLabel(tok.ed)).toBe("Review unpublished changes");

    // An org admin approves Tokens; the team's default mode for Theme is Dark
    const manifest = await w.api.libraries.getVersion("libf_Tok");
    const theme = manifest.assets.find((a) => a.kind === "VARIABLE_COLLECTION" && a.name === "Theme")!;
    const info = await w.api.orgLibraries.get(ORG, "libf_Tok");
    const dark = info.collections.find((c) => c.collectionKey === theme.key)!.modes.find((m) => m.name === "Dark")!;
    await w.api.orgLibraries.updateSettings(ORG, "libf_Tok", { scope: { type: "org", id: ORG }, approved: true });
    await w.api.orgLibraries.updateSettings(ORG, "libf_Tok", { scope: { type: "team", id: TEAM }, defaultModes: [{ collectionKey: theme.key, modeId: dark.id }] });

    const app = await w.open(w.keys.app);
    const state = app.ed.libraries.get();
    expect(state.available.map((e) => [e.name, e.org?.approved ?? null])).toEqual([
      ["Components", null],
      ["Tokens", "org"],
    ]);
    app.ed.ui.set({ librariesDialog: { tab: "libraries" } });
    view = mount(() => createElement(EditorContext.Provider, { value: app.ed }, createElement(LibrariesDialog)), {});
    await settleLong();
    const section = $(`section[aria-label="${TEAM}"]`)!;
    expect(section).toBeTruthy();
    expect($$("[data-library-row]", section).map((r) => r.getAttribute("data-library-row"))).toEqual(["Tokens", "Components"]);
    expect($("[data-library-row='Tokens'] [data-approved]")?.getAttribute("aria-label")).toBe(`Approved by ${ORG} admin`);
    expect($("[data-library-row='Components'] [data-approved]")).toBeNull();
    view.unmount();
    view = null;

    // First use of Theme: its default mode (Dark) on every page, in the same undo-able edit
    await setLibraryEnabled(app.ed, "libf_Tok", true);
    const brand = (await app.ed.libraries.manifest("libf_Tok"))!.assets.find((a) => a.kind === "VARIABLE" && a.collectionKey === theme.key)!;
    const varCopy = await ensureCopy(app.ed, "libf_Tok", brand.key);
    expect(varCopy).toBeTruthy();
    const themeCopy = app.ed.libraries.copies().find((c) => c.library === "libf_Tok" && c.key === theme.key)!;
    const page = app.ed.engine.readNode("0:1") as { variableModeBySetMap?: { entries?: { variableSetID?: { guid?: unknown }; variableModeID?: unknown }[] } };
    const entry = page.variableModeBySetMap?.entries?.find((e) => gid(e.variableSetID?.guid) === themeCopy.guid);
    expect(entry, "Theme's mode on the page").toBeTruthy();
    expect(gid(entry!.variableModeID)).toBe(dark.id);
    // A second collection read later doesn't change the page again (files already holding it are left alone)
    await ensureCopy(app.ed, "libf_Tok", brand.key);

    // Usage: inserting a Components instance queues an insert for the server; its undo doesn't take it back
    await setLibraryEnabled(app.ed, "libf_Comp", true);
    const button = (await app.ed.libraries.manifest("libf_Comp"))!.assets.find((a) => a.name === "Button")!;
    expect(await insertLibraryComponent(app.ed, "libf_Comp", button)).toBeTruthy();
    app.ed.engine.undo();
    await settle(2200);
    const pending = (w.store as unknown as { analytics: { pending(): { library: string; asset: string; type: string; action: string; count: number }[] } }).analytics.pending();
    expect(pending.filter((p) => p.library === "libf_Comp")).toEqual([expect.objectContaining({ asset: button.key, type: "component", action: "insert", count: 1 })]);
  }, 30_000);
});
