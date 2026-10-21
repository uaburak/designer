// @vitest-environment happy-dom
// The app tools (docs/research/agent-parity.md; editor/agents/appTools.ts) on a real engine: comments pinned on a
// layer, version history (save, list, restore as one step), export to files, Home's files and folders (deleting
// forever stays the owner's), Dev Mode's status, plugins, settings (none of Access / keys), sharing, and the website
// behaviours in set_prototype_settings — with the store's repositories given by the test.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { Engine } from "@/engine/Engine";
import { EngineStore } from "@/engine/EngineStore";
import { BUNDLED_FACES, fonts } from "@/engine/fonts";
import { loadEngine } from "@/engine/loadEngine";
import { SAMPLE_DOCUMENT } from "@/engine/sampleDocument";
import type { ToolResult } from "@shared/agents/tools";
import type { CommentsState, NewComment } from "@shared/comments";
import { EditorController } from "../controller";
import { memoryDocumentSource } from "../documentSource";
import { runTool, type ToolEnv } from "../agents/mcpTools";
import type { AppServices } from "../agents/appTools";
import { AgentTurns } from "../agents/turns";

const wasm = join(process.cwd(), "src/renderer/src/engine/wasm/engine.wasm");
const inter = join(process.cwd(), "src/renderer/src/engine/fonts/Inter-3.19.ttf");

beforeAll(async () => {
  globalThis.fetch = async () => new Response(null, { status: 404 });
  const bytes = readFileSync(wasm);
  await loadEngine({ wasmBinary: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), printErr: () => {} });
  fonts.setSource({ list: async () => BUNDLED_FACES, read: async () => new Uint8Array(readFileSync(inter)) });
});

function fakeComments() {
  const me = { id: "u0", name: "Burak" };
  let state: CommentsState = { fileKey: "file1", shared: true, me, canResolveAny: true, canDeleteAny: true, threads: [] };
  let n = 0;
  const added: NewComment[] = [];
  const repo = {
    added,
    list: async () => state,
    add: async (_k: string, c: NewComment) => {
      added.push(c);
      const id = `c${++n}`;
      const comment = { id, threadId: c.threadId ?? id, parentId: c.threadId ?? null, user: me, message: c.message, mentions: c.mentions ?? [], createdAt: n, editedAt: null, reactions: [] };
      if (c.threadId) state = { ...state, threads: state.threads.map((t) => (t.id === c.threadId ? { ...t, comments: [...t.comments, comment] } : t)) };
      else state = { ...state, threads: [...state.threads, { id, number: state.threads.length + 1, anchor: c.anchor!, comments: [comment], resolvedAt: null, resolvedBy: null, unread: false, readAt: 0 }] };
      return state;
    },
    edit: async (_k: string, id: string, message: string) => ((state = { ...state, threads: state.threads.map((t) => ({ ...t, comments: t.comments.map((c) => (c.id === id ? { ...c, message } : c)) })) }), state),
    remove: async (_k: string, id: string) => ((state = { ...state, threads: state.threads.filter((t) => t.id !== id) }), state),
    setResolved: async (_k: string, id: string, on: boolean) => ((state = { ...state, threads: state.threads.map((t) => (t.id === id ? { ...t, resolvedAt: on ? 5 : null } : t)) }), state),
    setRead: async () => state,
    react: async () => state,
    move: async () => state,
    mentionable: async () => [{ id: "u1", name: "Ana", email: "ana@example.com" }],
    watch: () => () => {},
  };
  return repo;
}

function fakeWorkspace() {
  const files = [
    { fileKey: "file1", name: "Tool app", folderId: null, updatedAt: 1, starred: false, trashedAt: null as number | null },
    { fileKey: "file2", name: "Old", folderId: null, updatedAt: 1, starred: false, trashedAt: null as number | null },
  ];
  const calls: string[] = [];
  return {
    files,
    calls,
    listFiles: async (q: { in: string }) => (q.in === "trash" ? files.filter((f) => f.trashedAt) : files.filter((f) => !f.trashedAt)),
    listFolders: async () => [{ id: "fo1", name: "Work", parentId: null, trashedAt: null }],
    createFile: async (i: { name?: string; folderId: string | null }) => (calls.push(`create ${i.name}`), { fileKey: "file3", name: i.name ?? "Untitled", folderId: i.folderId }),
    renameFile: async (k: string, name: string) => (calls.push(`rename ${k} ${name}`), { fileKey: k, name }),
    duplicateFile: async (k: string) => ({ fileKey: `${k}-copy`, name: "Copy" }),
    moveFiles: async (keys: string[], to: string | null) => void calls.push(`move ${keys.join(",")} ${to}`),
    setStarred: async () => void calls.push("star"),
    createFolder: async (i: { name: string }) => ({ id: "fo2", name: i.name, parentId: null }),
    updateFolder: async (id: string, p: { name: string }) => ({ id, name: p.name, parentId: null }),
    trash: async (i: { files?: string[] }) => void (i.files ?? []).forEach((k) => (files.find((f) => f.fileKey === k)!.trashedAt = 9)),
    restore: async (i: { files?: string[] }) => void (i.files ?? []).forEach((k) => (files.find((f) => f.fileKey === k)!.trashedAt = null)),
    deleteForever: vi.fn(),
    emptyTrash: vi.fn(),
  };
}

async function editor() {
  const source = Object.assign(memoryDocumentSource(SAMPLE_DOCUMENT, { fileName: "Tool app", versions: true }), { fileKey: "file1" });
  const engine = await Engine.create(null, { sessionID: 1 });
  engine.load(await source.load());
  engine.setViewport(1280, 800, 1, 1280, 800);
  const ed = new EditorController(engine, new EngineStore(engine), source);
  const turns = new AgentTurns(ed);
  const comments = fakeComments();
  const workspace = fakeWorkspace();
  const ran: string[] = [];
  let locale = "en";
  const app: AppServices = {
    comments: comments as never,
    workspace: workspace as never,
    multiplayer: { fileInfo: async () => ({ name: "Tool app", linkAccess: "none" }) as never, invite: vi.fn(async () => []), setLinkAccess: vi.fn(async () => ({}) as never), members: async () => [] },
    commentsChanged: vi.fn(),
    restoreVersion: async (e, v) => (await import("../VersionHistory")).restoreVersion(e, v),
    openFile: vi.fn(async () => {}),
    plugins: () => ({
      entries: () => [{ ref: { id: "p1", name: "Lorem" }, manifest: { menu: [{ name: "Fill", command: "fill" }, { name: "More", menu: [{ name: "Short", command: "short" }] }] }, disabled: null }],
      run: async (ref: never, command?: string) => (ran.push(`${(ref as { id: string }).id}:${command}`), {}),
    }),
    locale: () => locale as "en",
    setLocale: async (l) => void (locale = l),
    theme: () => "system",
    setTheme: vi.fn(),
  };
  const env: ToolEnv = { ed, write: (_l, fn, refs) => turns.write(null, "Claude Code", fn, refs), app };
  const call = (name: string, args: Record<string, unknown> = {}) => runTool(env, name, args);
  return { ed, engine, source, call, comments, workspace, app, ran };
}

const text = (r: ToolResult) => r.content.map((c) => (c.type === "text" ? c.text : "")).join("");
const json = (r: ToolResult) => {
  expect(r.isError, text(r)).toBeFalsy();
  return JSON.parse(text(r));
};

async function frame(call: (n: string, a: Record<string, unknown>) => Promise<ToolResult>) {
  const made = json(await call("create_nodes", { nodes: [{ type: "FRAME", name: "Card", x: 3000, y: 200, width: 200, height: 120, fills: [{ type: "SOLID", color: "#3366ff" }], children: [{ type: "RECTANGLE", name: "Dot", x: 20, y: 30, width: 10, height: 10 }] }] }));
  return { frame: made.created[0].id as string, dot: made.created[0].children?.[0]?.id as string | undefined };
}

describe("comments", () => {
  it("pins a thread on a layer (its top-level frame + offset), lists, replies, resolves, deletes", async () => {
    const { call, engine, comments, app } = await editor();
    const { frame: f } = await frame(call);
    const dot = engine.readNode(f, { childIds: true })!.childIds![0];
    json(await call("add_comment", { message: "Is this dot needed?", nodeId: dot, offset: { x: 2, y: 3 } }));
    expect(comments.added[0].anchor).toMatchObject({ nodeId: f, x: 3022, y: 233, offset: { x: 22, y: 33 } });
    const listed = json(await call("get_comments"));
    expect(listed.threads[0].comments[0].message).toBe("Is this dot needed?");
    expect(listed.mentionable[0].email).toBe("ana@example.com");
    const th = listed.threads[0].threadId;
    json(await call("reply_comment", { threadId: th, message: "Yes" }));
    json(await call("resolve_comment", { threadId: th }));
    expect(json(await call("get_comments")).threads).toHaveLength(0);
    expect(json(await call("get_comments", { includeResolved: true })).threads[0].resolved).toBe(true);
    json(await call("delete_comment", { commentId: th }));
    expect(app.commentsChanged).toHaveBeenCalled();
    expect(text(await call("add_comment", { message: "x".repeat(2001), nodeId: f }))).toMatch(/2000/);
    expect(text(await call("add_comment", { message: "where?" }))).toMatch(/nodeId/);
  });
});

describe("version history", () => {
  it("saves a named version, lists it, restores it as one undoable step", async () => {
    const { call, engine, source } = await editor();
    const { frame: f } = await frame(call);
    // The store's restore: the diff back to the version (here: the name), applied by the editor as one step.
    Object.assign(source, { restoreVersion: async (id: string, apply: (m: never) => void) => (apply({ type: "NODE_CHANGES", sessionID: 0, nodeChanges: [{ guid: f, name: "Card" }] } as never), { id, kind: "restore", title: null, description: null, createdAt: 1 }) });
    const saved = json(await call("save_version", { title: "Before rename", description: "Card" }));
    expect(saved.saved.title).toBe("Before rename");
    json(await call("update_nodes", { updates: [{ nodeId: f, name: "Renamed" }] }));
    const list = json(await call("list_versions", { named: true }));
    expect(list.versions[0].id).toBe(saved.saved.id);
    json(await call("restore_version", { id: saved.saved.id }));
    expect(engine.readNode(f)!.name).toBe("Card");
    engine.command("UNDO");
    expect(engine.readNode(f)!.name).toBe("Renamed");
    expect(text(await call("restore_version", { id: "nope" }))).toMatch(/No version/);
  });
});

describe("export", () => {
  it("renders SVG and PDF as files for the working folder (PNG needs a canvas: its failure is said)", async () => {
    const { call } = await editor();
    const { frame: f } = await frame(call);
    const svg = await call("export_nodes", { nodeIds: [f], format: "SVG" });
    expect(json(svg).exported[0].name).toMatch(/Card.*\.svg$/);
    expect(svg.files?.[0].mimeType).toBe("image/svg+xml");
    expect(Buffer.from(svg.files![0].data, "base64").toString("utf8")).toContain("<svg");
    const pdf = await call("export_nodes", { nodeIds: [f], format: "PDF" });
    expect(Buffer.from(pdf.files![0].data, "base64").subarray(0, 5).toString()).toBe("%PDF-");
    const png = await call("export_nodes", { nodeIds: [f], format: "PNG", scale: "2x" });
    expect(png.isError || png.files?.length).toBeTruthy();
    expect(text(await call("export_nodes", { nodeIds: [f], scale: "huge" }))).toMatch(/scale/);
    expect(text(await call("export_nodes", { nodeIds: [f], useNodeSettings: true }))).toMatch(/export settings/);
  });
});

describe("Home: files and folders", () => {
  it("lists, creates, renames, moves, trashes and restores — never deletes forever", async () => {
    const { call, workspace } = await editor();
    const l = json(await call("list_files", { in: "recents" }));
    expect(l.files.find((f: { fileKey: string }) => f.fileKey === "file1").thisFile).toBe(true);
    expect(l.folders[0].name).toBe("Work");
    expect(json(await call("create_file", { name: "Landing" })).created.fileKey).toBe("file3");
    json(await call("file_action", { action: "rename", fileKey: "file2", name: "Archive" }));
    json(await call("file_action", { action: "move", fileKeys: ["file2"], folderId: "fo1" }));
    json(await call("file_action", { action: "trash", fileKeys: ["file2"] }));
    expect(json(await call("list_files", { in: "trash" })).files.map((f: { fileKey: string }) => f.fileKey)).toEqual(["file2"]);
    json(await call("file_action", { action: "restore", fileKeys: ["file2"] }));
    expect(text(await call("file_action", { action: "delete_forever", fileKeys: ["file2"] }))).toMatch(/owner's/);
    expect(workspace.deleteForever).not.toHaveBeenCalled();
    expect(workspace.calls).toEqual(["create Landing", "rename file2 Archive", "move file2 fo1"]);
  });
});

describe("share, dev status, plugins", () => {
  it("invites with a checked email; reads people", async () => {
    const { call, app } = await editor();
    expect(text(await call("share_file", { invite: { email: "not-an-email", role: "editor" } }))).toMatch(/email/);
    json(await call("share_file", { invite: { email: "ana@example.com", role: "editor" } }));
    expect(app.multiplayer.invite).toHaveBeenCalledWith("file1", "ana@example.com", "editor");
  });

  it("marks a top-level frame ready for dev in one undo step; refuses a nested layer", async () => {
    const { call, engine, ed } = await editor();
    const { frame: f } = await frame(call);
    const dot = engine.readNode(f, { childIds: true })!.childIds![0];
    expect(text(await call("set_dev_status", { nodeIds: [dot], status: "READY_FOR_DEV" }))).toMatch(/top-level/);
    json(await call("set_dev_status", { nodeIds: [f], status: "READY_FOR_DEV", description: "v1" }));
    expect((engine.readNode(f, { fields: ["sectionStatusInfo"] }) as { sectionStatusInfo?: { status: string } }).sectionStatusInfo?.status).toBe("BUILD");
    expect(ed.engine).toBeTruthy();
  });

  it("lists plugins with their commands and runs one", async () => {
    const { call, ran } = await editor();
    const p = json(await call("list_plugins"));
    expect(p.plugins[0].commands).toEqual([{ command: "fill", name: "Fill" }, { command: "short", name: "More › Short" }]);
    json(await call("run_plugin", { id: "p1", command: "short" }));
    expect(ran).toEqual(["p1:short"]);
  });
});

describe("settings", () => {
  it("reads and changes the person's settings; refuses Access, keys and the like", async () => {
    const { call, ed } = await editor();
    const s = json(await call("get_app_settings"));
    expect(s.preferences["preferences.snapToPixelGrid"]).toBe(true);
    json(await call("set_app_setting", { key: "preferences.snapToPixelGrid", value: false }));
    expect(json(await call("get_app_settings")).preferences["preferences.snapToPixelGrid"]).toBe(false);
    json(await call("set_app_setting", { key: "nudge", value: { small: 2, big: 8 } }));
    expect(ed.ui.get().nudge).toEqual({ small: 2, big: 8 });
    json(await call("set_app_setting", { key: "view.rulers", value: true }));
    expect(ed.ui.get().rulers).toBe(true);
    json(await call("set_app_setting", { key: "language", value: "tr" }));
    expect(json(await call("get_app_settings")).language).toBe("tr");
    json(await call("set_app_setting", { key: "present.websiteBehaviours", value: false }));
    expect(json(await call("get_app_settings")).present["present.websiteBehaviours"]).toBe(false);
    for (const key of ["access.web", "reach.policies", "providers.claude", "keys.openai", "operator.signups"]) expect(text(await call("set_app_setting", { key, value: "allow" })), key).toMatch(/isn't a setting an agent can change/);
    expect(text(await call("set_app_setting", { key: "language", value: "de" }))).toMatch(/en/);
  });
});

describe("prototype website behaviours", () => {
  it("set_prototype_settings writes Text input, Cursor, Keep in window, Stack and Fit to window; get_prototype reads them back", async () => {
    const { call, engine } = await editor();
    const made = json(await call("create_nodes", { nodes: [{ type: "FRAME", name: "Toast", x: 5000, y: 0, width: 300, height: 60, children: [{ type: "TEXT", name: "Field", characters: "Email" }] }] }));
    const f = made.created[0].id as string;
    const field = engine.readNode(f, { childIds: true })!.childIds![0];
    json(await call("set_prototype_settings", { nodes: [{ nodeId: field, prototypeTextInput: { type: "EMAIL", maxLength: 80 }, prototypeCursor: "TEXT" }, { nodeId: f, overlayEdgeBehavior: "NONE", overlayStack: { gap: 12, max: 4 }, overlayFitWindow: "WIDTH" }] }));
    const p = json(await call("get_prototype", {}));
    const byId = new Map(p.settings.map((s: { nodeId: string }) => [s.nodeId, s]));
    expect(byId.get(field)).toMatchObject({ prototypeTextInput: { type: "EMAIL", maxLength: 80 }, prototypeCursor: "TEXT" });
    expect(byId.get(f)).toMatchObject({ overlayEdgeBehavior: "NONE", overlayStack: { gap: 12, max: 4 }, overlayFitWindow: "WIDTH" });
    json(await call("set_prototype_settings", { nodes: [{ nodeId: f, overlayStack: null, overlayFitWindow: "NONE" }] }));
    const after = json(await call("get_prototype", {})).settings.find((s: { nodeId: string }) => s.nodeId === f);
    expect(after?.overlayStack).toBeUndefined();
    expect(text(await call("set_prototype_settings", { nodes: [{ nodeId: f, prototypeCursor: "HAND" }] }))).toMatch(/prototypeCursor/);
  });
});
