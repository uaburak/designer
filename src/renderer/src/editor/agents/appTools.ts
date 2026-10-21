/**
 * The app beyond the canvas, run in the file's view (docs/research/agent-parity.md; the tools' definitions are in
 * src/shared/agents/appTools.ts): comments, version history, export, libraries, Home's files and folders, Dev Mode's
 * status, plugins, the person's own settings, sharing. Each calls the same code the menus, panels and dialogs call
 * (the store's repositories through `getStoreClient()`, the document source, libraries.ts, devStatus.ts, the plugins'
 * service, preferences.ts …), so what an agent does shows in the UI as if the person had clicked it.
 *
 * Confirmation: the destructive or outward calls (`confirmationFor`) were confirmed in main before they got here.
 * Writes to the document are one undo step each (`env.write`, or the code's own `ed.batch` step). Refusals say why.
 */
import type { Guid } from "@/engine/codec";
import { textResult, type ToolResult, type ToolFile } from "@shared/agents/tools";
import { APP_TOOL_NAMES } from "@shared/agents/appTools";
import { MAX_COMMENT_LENGTH, commentLength, type CommentAnchor, type CommentsRepository } from "@shared/comments";
import type { FileQuery, WorkspaceRepository } from "@shared/store/repositories";
import type { MultiplayerRepository } from "@shared/multiplayer/types";
import type { Locale } from "@shared/i18n";
import type { EditorController } from "../controller";
import type { VersionInfo } from "../documentSource";
import { normId, type Spec } from "./nodeSpec";
import { ToolError } from "./toolError";
import { writeTargets, type ToolEnv } from "./mcpTools";
import { base64 } from "./png";
import { exportAllowed, renderItems, type ExportItem } from "../exporting";
import { exportSettingsOf, nextExportSetting, parseScale, withConstraint, withFormat, type ExportFormat } from "../model/exports";
import { acceptUpdates, draftPublish, hasPublishChanges, insertLibraryComponent, publishLibrary, setLibraryEnabled, updateId } from "../libraries";
import { setDevStatusOf } from "../devStatus";
import { PREFERENCES, ACCESSIBILITY_PREFERENCES, pref, setPreference, type PreferenceKey } from "../preferences";
import { setNudge } from "../canvasTools";
import { setViewOption } from "../commands";
import { modeOf, setMode, type Mode } from "../devmode/devMode";
import { readWebOptions, writeWebOptions } from "../../present/webBehaviours";

/** What the tools reach besides the editor (the real ones by default; tests give their own). */
export interface AppServices {
  comments: CommentsRepository;
  workspace: WorkspaceRepository;
  multiplayer: Pick<MultiplayerRepository, "fileInfo" | "invite" | "setLinkAccess" | "members">;
  /** The comments panel reads the file's comments again */
  commentsChanged(ed: EditorController): void;
  restoreVersion(ed: EditorController, v: VersionInfo): Promise<boolean>;
  openFile(fileKey: string): Promise<unknown>;
  plugins(ed: EditorController): PluginsLike | null;
  locale(): Locale;
  setLocale(l: Locale): Promise<void>;
  theme(): string;
  setTheme(t: "light" | "dark" | "system"): void;
}

interface PluginsLike {
  entries(): { ref: { id: string; name: string }; manifest: { menu?: unknown[] } | null; disabled: string | null }[];
  run(ref: never, command?: string, options?: { parameters?: Record<string, unknown> }): Promise<unknown>;
}

async function realServices(): Promise<AppServices> {
  const [{ getStoreClient }, plugins, i18n, theme] = await Promise.all([import("@/store"), import("../plugins/service"), import("@/i18n"), import("@/ds/theme")]);
  const store = getStoreClient();
  return {
    comments: store.comments,
    workspace: store.workspace,
    multiplayer: store.multiplayer,
    commentsChanged: (ed) => void import("../comments/commentsController").then((m) => m.commentsOf(ed)?.reload()),
    restoreVersion: async (ed, v) => (await import("../VersionHistory")).restoreVersion(ed, v),
    openFile: async (fileKey) => {
      const nav = (window as unknown as { designer?: { nav?: { openFile?: (k: string) => Promise<unknown> } } }).designer?.nav;
      if (!nav?.openFile) throw new ToolError("Opening another file works in the desktop app only.");
      return nav.openFile(fileKey);
    },
    plugins: (ed) => plugins.pluginsOf(ed) as unknown as PluginsLike | null,
    locale: () => i18n.getLocale(),
    setLocale: (l) => i18n.setLocalePreference(l),
    theme: () => theme.currentTheme().preference,
    setTheme: (t) => theme.setThemePreference(t),
  };
}

/** The real services, with a test's in place of any of them (`env.app`); a test gives all it uses, so nothing heavy loads. */
const services = async (env: ToolEnv): Promise<AppServices> => (env.app && Object.keys(env.app).length >= 4 ? (env.app as AppServices) : { ...(await realServices()), ...(env.app ?? {}) });

const fileKeyOf = (ed: EditorController): string | null => {
  const k = (ed.source as { fileKey?: unknown }).fileKey;
  return typeof k === "string" ? k : null;
};
const mustFileKey = (ed: EditorController) => {
  const k = fileKeyOf(ed);
  if (!k) throw new ToolError("This document isn't a file of the workspace (a playground or a preview): it has no comments, versions or sharing.");
  return k;
};
const str = (v: unknown, name: string, max = 10_000): string => {
  if (typeof v !== "string" || !v.trim()) throw new ToolError(`${name}: required text.`);
  if (v.length > max) throw new ToolError(`${name}: at most ${max} characters.`);
  return v;
};
const opt = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const iso = (ms: number | null | undefined) => (ms ? new Date(ms).toISOString() : null);

// ---- Comments ---------------------------------------------------------------------------------------------------------

function message(v: unknown): string {
  const m = str(v, "message", 20_000);
  if (commentLength(m) > MAX_COMMENT_LENGTH) throw new ToolError(`message: at most ${MAX_COMMENT_LENGTH} characters (Figma's limit).`);
  return m;
}

/** A layer's page-absolute top-left (its ancestors' translations; rotation ignored) and its top-level frame. */
function layerPlace(env: ToolEnv, id: Guid): { pageId: Guid; x: number; y: number; top: Guid; topX: number; topY: number } {
  let n = env.ed.engine.readNode(id, { fields: ["parentIndex", "type", "transform"] });
  if (!n) throw new ToolError(`No layer ${id} in this file.`);
  if (n.type === "CANVAS") throw new ToolError(`${id} is a page: give pageId with x and y, or a layer on it.`);
  let x = 0;
  let y = 0;
  const chain: { id: Guid; x: number; y: number }[] = [];
  for (let i = 0; n && n.type !== "CANVAS" && i < 400; i++) {
    x += n.transform?.m02 ?? 0;
    y += n.transform?.m12 ?? 0;
    chain.push({ id: n.guid, x: n.transform?.m02 ?? 0, y: n.transform?.m12 ?? 0 });
    n = n.parentIndex?.guid ? env.ed.engine.readNode(n.parentIndex.guid, { fields: ["parentIndex", "type", "transform"] }) : null;
  }
  if (!n) throw new ToolError(`${id} isn't on a page.`);
  const top = chain[chain.length - 1];
  return { pageId: n.guid, x, y, top: top.id, topX: top.x, topY: top.y };
}

function anchorOf(env: ToolEnv, args: Spec): CommentAnchor {
  if (opt(args.nodeId)) {
    const p = layerPlace(env, normId(args.nodeId));
    const off = args.offset && typeof args.offset === "object" ? (args.offset as { x?: unknown; y?: unknown }) : {};
    const ox = typeof off.x === "number" ? off.x : 0;
    const oy = typeof off.y === "number" ? off.y : 0;
    const x = p.x + ox;
    const y = p.y + oy;
    return { pageId: p.pageId, x, y, nodeId: p.top, offset: { x: x - p.topX, y: y - p.topY } };
  }
  const pages = env.ed.engine.pages();
  const pageId = opt(args.pageId) ? normId(args.pageId) : (env.page?.() ?? env.ed.store.page);
  if (!pages.some((p) => p.guid === pageId)) throw new ToolError(`No page ${String(args.pageId)} (has ${pages.map((p) => `${p.name} (${p.guid})`).join(", ")}).`);
  if (typeof args.x !== "number" || typeof args.y !== "number") throw new ToolError("Where: nodeId (a layer, the pin at its top-left or at `offset`), or pageId with x and y.");
  return { pageId, x: args.x, y: args.y, nodeId: null, offset: null };
}

async function getComments(env: ToolEnv, args: Spec, s: AppServices): Promise<ToolResult> {
  const fileKey = mustFileKey(env.ed);
  const data = await s.comments.list(fileKey);
  const page = opt(args.pageId) ? normId(args.pageId) : null;
  const threads = data.threads
    .filter((th) => (args.includeResolved === true || !th.resolvedAt) && (!page || th.anchor.pageId === page))
    .map((th) => ({
      threadId: th.id,
      number: th.number,
      pageId: th.anchor.pageId,
      at: { x: Math.round(th.anchor.x), y: Math.round(th.anchor.y), ...(th.anchor.nodeId ? { nodeId: th.anchor.nodeId } : {}) },
      resolved: !!th.resolvedAt,
      unread: th.unread,
      comments: th.comments.map((c) => ({ id: c.id, author: c.user.name, message: c.message, ...(c.mentions.length ? { mentions: c.mentions } : {}), ...(c.reactions.length ? { reactions: c.reactions.map((r) => `${r.emoji} ${r.users.length}`) } : {}), at: iso(c.createdAt) })),
    }));
  const people = data.shared ? await s.comments.mentionable(fileKey).catch(() => []) : [];
  return textResult({ me: data.me.name, shared: data.shared, threads, ...(people.length ? { mentionable: people.map((p) => ({ id: p.id, name: p.name, email: p.email })) } : {}) });
}

async function commentWrite(env: ToolEnv, name: string, args: Spec, s: AppServices): Promise<ToolResult> {
  const fileKey = mustFileKey(env.ed);
  const mentions = Array.isArray(args.mentions) ? (args.mentions as unknown[]).filter((m): m is string => typeof m === "string").slice(0, 50) : [];
  let state;
  switch (name) {
    case "add_comment":
      state = await s.comments.add(fileKey, { message: message(args.message), mentions, anchor: anchorOf(env, args) });
      break;
    case "reply_comment":
      state = await s.comments.add(fileKey, { threadId: str(args.threadId, "threadId", 200), message: message(args.message), mentions });
      break;
    case "edit_comment":
      state = await s.comments.edit(fileKey, str(args.commentId, "commentId", 200), message(args.message));
      break;
    case "resolve_comment": {
      const react = args.react && typeof args.react === "object" ? (args.react as Spec) : null;
      if (react) state = await s.comments.react(fileKey, str(react.commentId, "react.commentId", 200), str(react.emoji, "react.emoji", 32), react.on !== false);
      if (opt(args.threadId)) state = await s.comments.setResolved(fileKey, String(args.threadId), args.resolved !== false);
      if (!state) throw new ToolError("Give threadId (to resolve) or react {commentId, emoji}.");
      break;
    }
    case "delete_comment":
      state = await s.comments.remove(fileKey, str(args.commentId, "commentId", 200));
      break;
  }
  s.commentsChanged(env.ed);
  const latest = state?.threads.reduce<{ id: string; at: number } | null>((best, th) => th.comments.reduce((b, c) => (!b || c.createdAt > b.at ? { id: c.id, at: c.createdAt } : b), best), null);
  return textResult({ done: name, threads: state?.threads.length ?? 0, ...(name === "add_comment" || name === "reply_comment" ? { commentId: latest?.id } : {}) });
}

// ---- Version history --------------------------------------------------------------------------------------------------

const versionView = (v: VersionInfo) => ({ id: v.id, kind: v.kind, title: v.title, description: v.description, savedAt: iso(v.createdAt), ...(v.editors?.length ? { by: v.editors } : {}) });

async function versionTool(env: ToolEnv, name: string, args: Spec, s: AppServices): Promise<ToolResult> {
  const src = env.ed.source;
  if (!src.listVersions) throw new ToolError("This file has no version history (a playground or a preview).");
  if (name === "list_versions") {
    const all = await src.listVersions();
    const limit = typeof args.limit === "number" ? Math.max(1, Math.min(200, Math.round(args.limit))) : 50;
    return textResult({ versions: all.filter((v) => !args.named || v.kind !== "autosave").slice(0, limit).map(versionView) });
  }
  if (name === "save_version") {
    const patch = { ...(typeof args.title === "string" ? { title: args.title.slice(0, 200) } : {}), ...(typeof args.description === "string" ? { description: args.description.slice(0, 5000) } : {}) };
    if (opt(args.id)) {
      if (!src.updateVersion) throw new ToolError("Versions can't be renamed here.");
      return textResult({ updated: versionView(await src.updateVersion(String(args.id), patch)) });
    }
    if (!src.saveVersion) throw new ToolError("Versions can't be saved here.");
    await src.flush();
    return textResult({ saved: versionView(await src.saveVersion(patch)) });
  }
  // restore_version
  const id = str(args.id, "id", 200);
  const v = (await src.listVersions()).find((x) => x.id === id);
  if (!v) throw new ToolError(`No version ${id} (list_versions lists them).`);
  if (args.duplicate === true) {
    if (!src.duplicateVersion) throw new ToolError("Versions can't be duplicated here.");
    const copy = await src.duplicateVersion(id);
    return textResult({ duplicated: { fileKey: copy.fileKey, name: copy.name, note: "A new file in Drafts." } });
  }
  if (!src.restoreVersion) throw new ToolError("Versions can't be restored here.");
  if (!(await s.restoreVersion(env.ed, v))) throw new ToolError("The version couldn't be restored.");
  return textResult({ restored: versionView(v), note: "One step: ⌘Z takes it back." });
}

// ---- Export -----------------------------------------------------------------------------------------------------------

async function exportTool(env: ToolEnv, args: Spec): Promise<ToolResult> {
  if (!exportAllowed(env.ed)) throw new ToolError("This file doesn't allow viewers to copy or export (its owner turned it off).");
  const raw = Array.isArray(args.nodeIds) ? (args.nodeIds as unknown[]).map((x) => normId(x)).filter(Boolean) : [];
  if (!raw.length) throw new ToolError("export_nodes: nodeIds (layers or pages) required.");
  const pages = new Set(env.ed.engine.pages().map((p) => p.guid));
  const layers = raw.filter((id) => !pages.has(id));
  if (layers.length) writeTargets(env, { nodeIds: layers }, "export_nodes");
  const fmt = String(args.format ?? "PNG").toUpperCase();
  const format: ExportFormat = fmt === "JPG" ? "JPEG" : (fmt as ExportFormat);
  if (!["PNG", "JPEG", "SVG", "PDF"].includes(format)) throw new ToolError("format: PNG, JPG, SVG or PDF.");
  let setting = withFormat(nextExportSetting([]), format);
  if (typeof args.scale === "string" && args.scale.trim()) {
    const c = parseScale(args.scale.trim());
    if (!c) throw new ToolError(`scale: "2x", "0.5x", "512w" or "300h" (got ${JSON.stringify(args.scale)}).`);
    setting = withConstraint(setting, c);
  }
  if (typeof args.suffix === "string") setting = { ...setting, suffix: args.suffix.slice(0, 100) };
  const items: ExportItem[] = raw.map((id) => {
    const n = env.ed.engine.readNode(id, { fields: ["name", "exportSettings"] });
    const own = exportSettingsOf(n as { exportSettings?: unknown });
    return { ref: pages.has(id) ? null : id, name: n?.name ?? id, settings: args.useNodeSettings === true ? own : [setting] };
  });
  if (items.every((i) => !i.settings.length)) throw new ToolError("None of these layers has export settings: give a format, or add settings with set_properties {exportSettings}.");
  if (raw.some((id) => pages.has(id)) && raw.some((id) => pages.has(id) && id !== (env.page?.() ?? env.ed.store.page))) throw new ToolError("A page exports only while it is the current one: set_current_page first.");
  const { files, failed } = await renderItems(env.ed, items);
  const out: ToolFile[] = files.map((f) => ({ name: f.name, data: base64(f.bytes), mimeType: f.name.endsWith(".svg") ? "image/svg+xml" : f.name.endsWith(".pdf") ? "application/pdf" : f.name.endsWith(".jpg") ? "image/jpeg" : "image/png" }));
  const r = textResult({ exported: files.map((f) => ({ name: f.name, bytes: f.bytes.length })), ...(failed.length ? { failed } : {}) }, !files.length);
  if (out.length) r.files = out;
  return r;
}

// ---- Libraries --------------------------------------------------------------------------------------------------------

async function librariesTool(env: ToolEnv, name: string, args: Spec): Promise<ToolResult> {
  const ed = env.ed;
  const access = ed.source.libraries;
  if (!access) throw new ToolError("Libraries aren't available for this file.");
  const st = ed.libraries.get();
  const nameOf = (k: string) => st.available.find((l) => l.fileKey === k)?.name ?? st.names.get(k) ?? k;
  const libKey = (v: unknown) => {
    const k = str(v, "library", 200);
    const hit = st.available.find((l) => l.fileKey === k || l.name === k);
    if (!hit) throw new ToolError(`No library ${k} (get_libraries lists them).`);
    return hit.fileKey;
  };
  switch (name) {
    case "get_libraries": {
      if (opt(args.assets)) {
        const k = libKey(args.assets);
        const v = st.manifests.get(k) ?? (await access.version(k));
        return textResult({ library: nameOf(k), version: v?.version ?? null, assets: (v?.assets ?? []).filter((a) => !a.dependencyOnly).slice(0, 2000).map((a) => ({ key: a.key, kind: a.kind, name: a.name, ...(a.description ? { description: a.description.slice(0, 200) } : {}) })) });
      }
      const updates = ed.libraries.updates();
      return textResult({
        thisFile: { published: !!st.own && st.own.status === "published", version: st.own?.latestVersion ?? null, inDrafts: st.inDrafts },
        libraries: st.available.map((l) => ({ library: l.fileKey, name: l.name, location: l.location, enabled: st.enabled.includes(l.fileKey), counts: l.record.counts, version: l.record.latestVersion })),
        updates: updates.map((u) => ({ key: updateId(u), library: u.libraryName, kind: u.kind, name: u.copy.name })),
      });
    }
    case "set_library_enabled": {
      const k = libKey(args.library);
      await setLibraryEnabled(ed, k, args.enabled === true);
      return textResult({ library: nameOf(k), enabled: ed.libraries.get().enabled.includes(k) });
    }
    case "accept_library_updates": {
      const all = ed.libraries.updates();
      const keys = Array.isArray(args.keys) ? new Set((args.keys as unknown[]).map(String)) : null;
      const items = keys ? all.filter((u) => keys.has(updateId(u))) : all;
      if (!items.length) return textResult({ accepted: 0, note: all.length ? "None of those keys is waiting (get_libraries lists the updates)." : "No updates are waiting." });
      const n = await acceptUpdates(ed, items);
      return textResult({ accepted: n });
    }
    case "insert_library_component": {
      const k = libKey(args.library);
      const v = st.manifests.get(k) ?? (await access.version(k));
      const asset = v?.assets.find((a) => a.key === args.key && (a.kind === "COMPONENT" || a.kind === "COMPONENT_SET" || a.kind === ("STATE_GROUP" as never)));
      if (!asset) throw new ToolError(`No component ${String(args.key)} in ${nameOf(k)} (get_libraries {assets: "${k}"} lists them).`);
      const cam = ed.engine.getCamera();
      const at = typeof args.x === "number" && typeof args.y === "number" ? { x: args.x * cam.zoom + cam.x, y: args.y * cam.zoom + cam.y } : undefined;
      const id = await insertLibraryComponent(ed, k, asset, at);
      if (!id) throw new ToolError("The component couldn't be inserted.");
      const r = textResult({ inserted: id, name: asset.name });
      r.touched = [id];
      return r;
    }
    case "publish_library": {
      if (st.inDrafts) throw new ToolError("A file in Drafts can't be published: move it to a team's project or folder first (file_action move).");
      const draft = await draftPublish(ed);
      if (!hasPublishChanges(draft)) return textResult({ published: false, note: "Nothing changed since the last publish." });
      const selected = new Set([...draft.items.filter((i) => i.status === "created" || i.status === "modified").map((i) => i.key), ...draft.removed.map((a) => a.key)]);
      const v = await publishLibrary(ed, draft, { description: typeof args.description === "string" ? args.description.slice(0, 5000) : "", selected, moveModes: new Map(draft.moves.map((m) => [m.fromKey, "move" as const])) });
      return textResult({ published: true, version: v.version, assets: v.assets.length, changes: { created: v.changes.created.length, modified: v.changes.modified.length, removed: v.changes.removed.length } });
    }
  }
  throw new ToolError(`Unknown tool ${name}`);
}

// ---- Home: files and folders ------------------------------------------------------------------------------------------

async function filesTool(env: ToolEnv, name: string, args: Spec, s: AppServices): Promise<ToolResult> {
  const ws = s.workspace;
  if (name === "list_files") {
    const where = String(args.in ?? "recents");
    const q: FileQuery =
      where === "folder" ? { in: "folder", folderId: str(args.folderId, "folderId", 200) } : where === "search" ? { in: "search", text: str(args.text, "text", 200) } : where === "drafts" || where === "starred" || where === "trash" ? { in: where } : { in: "recents" };
    const [files, folders] = await Promise.all([ws.listFiles(q), ws.listFolders()]);
    return textResult({
      in: q.in,
      files: files.slice(0, 500).map((f) => ({ fileKey: f.fileKey, name: f.name, folderId: f.folderId, updatedAt: iso(f.updatedAt), starred: f.starred, ...(f.trashedAt ? { trashed: true } : {}), ...(f.fileKey === fileKeyOf(env.ed) ? { thisFile: true } : {}) })),
      folders: folders.filter((f) => !f.trashedAt || where === "trash").map((f) => ({ folderId: f.id, name: f.name, parentId: f.parentId, ...(f.trashedAt ? { trashed: true } : {}) })),
    });
  }
  if (name === "create_file") {
    const meta = await ws.createFile({ name: opt(args.name)?.slice(0, 200), folderId: opt(args.folderId) ?? null });
    if (args.open === true) await s.openFile(meta.fileKey);
    return textResult({ created: { fileKey: meta.fileKey, name: meta.name, folderId: meta.folderId }, ...(args.open === true ? { note: "Opened in a new tab; your tools still work on this file." } : {}) });
  }
  // file_action
  const keyOr = (v: unknown) => opt(v) ?? mustFileKey(env.ed);
  const keys = () => {
    const list = Array.isArray(args.fileKeys) ? (args.fileKeys as unknown[]).filter((x): x is string => typeof x === "string") : [];
    if (opt(args.fileKey)) list.push(String(args.fileKey));
    return list;
  };
  const folderIds = () => (Array.isArray(args.folderIds) ? (args.folderIds as unknown[]).filter((x): x is string => typeof x === "string") : []);
  switch (String(args.action ?? "")) {
    case "rename": {
      const k = keyOr(args.fileKey);
      const nm = str(args.name, "name", 200).trim();
      if (k === fileKeyOf(env.ed) && env.ed.source.rename) await env.ed.source.rename(nm);
      else await ws.renameFile(k, nm);
      return textResult({ renamed: { fileKey: k, name: nm } });
    }
    case "duplicate": {
      const k = keyOr(args.fileKey);
      if (k === fileKeyOf(env.ed)) await env.ed.source.flush();
      const copy = await ws.duplicateFile(k);
      return textResult({ duplicated: { fileKey: copy.fileKey, name: copy.name } });
    }
    case "move": {
      const list = keys();
      if (!list.length) list.push(mustFileKey(env.ed));
      const folderId = args.folderId === null || args.folderId === undefined || args.folderId === "" ? null : String(args.folderId);
      await ws.moveFiles(list, folderId);
      return textResult({ moved: list, to: folderId ?? "Drafts" });
    }
    case "star":
    case "unstar": {
      const on = args.action === "star";
      if (opt(args.folderId)) await ws.setStarred({ folderId: String(args.folderId) }, on);
      else await ws.setStarred({ fileKey: keyOr(args.fileKey) }, on);
      return textResult({ starred: on });
    }
    case "create_folder": {
      const f = await ws.createFolder({ name: str(args.name, "name", 200).trim(), parentId: opt(args.parentId) ?? null, ...(opt(args.color) ? { color: args.color as never } : {}) });
      return textResult({ created: { folderId: f.id, name: f.name, parentId: f.parentId } });
    }
    case "rename_folder": {
      const f = await ws.updateFolder(str(args.folderId, "folderId", 200), { name: str(args.name, "name", 200).trim() });
      return textResult({ renamed: { folderId: f.id, name: f.name } });
    }
    case "branch": {
      // File › Create branch… (docs/data.md §15): a copy named "<file> / <branch>".
      const ops = (env.ed.source as { fileOps?: { branch(name: string): Promise<{ fileKey: string; name: string }> } }).fileOps;
      if (!ops) throw new ToolError("Branches need a file of the workspace.");
      await env.ed.source.flush();
      const b = await ops.branch(str(args.name, "name", 200).trim());
      return textResult({ branch: { fileKey: b.fileKey, name: b.name }, note: "Open it with file_action open; merging stays a review in the app (File › Review and merge)." });
    }
    case "open": {
      const k = str(args.fileKey, "fileKey", 200);
      await s.openFile(k);
      return textResult({ opened: k, note: "In a new tab; your tools still work on this file." });
    }
    case "trash":
    case "restore": {
      const files = keys();
      const folders = folderIds();
      if (!files.length && !folders.length) throw new ToolError("fileKeys or folderIds: what to move.");
      if (args.action === "trash") await ws.trash({ files, folders });
      else await ws.restore({ files, folders });
      return textResult({ [args.action === "trash" ? "trashed" : "restored"]: { files, folders }, ...(args.action === "trash" ? { note: "In the trash: restore brings them back; deleting forever stays the owner's." } : {}) });
    }
    case "delete_forever":
    case "empty_trash":
      throw new ToolError("Deleting forever and emptying the trash stay the owner's: ask them to do it in Home › Trash.");
  }
  throw new ToolError("action: rename, duplicate, move, star, unstar, create_folder, rename_folder, branch, open, trash or restore.");
}

async function shareTool(env: ToolEnv, args: Spec, s: AppServices): Promise<ToolResult> {
  const fileKey = mustFileKey(env.ed);
  const inv = args.invite && typeof args.invite === "object" ? (args.invite as Spec) : null;
  if (inv) {
    const email = str(inv.email, "invite.email", 320).trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new ToolError("invite.email: an email address.");
    const role = inv.role === "editor" ? "editor" : "viewer";
    await s.multiplayer.invite(fileKey, email, role);
  }
  if (args.linkAccess !== undefined) {
    if (!["none", "viewer", "editor"].includes(String(args.linkAccess))) throw new ToolError("linkAccess: none, viewer or editor.");
    await s.multiplayer.setLinkAccess(fileKey, args.linkAccess as "none" | "viewer" | "editor");
  }
  const info = await s.multiplayer.fileInfo(fileKey);
  const members = await s.multiplayer.members(fileKey).catch(() => []);
  return textResult({ file: info, people: members });
}

// ---- Dev Mode, plugins ------------------------------------------------------------------------------------------------

function devStatusTool(env: ToolEnv, args: Spec): ToolResult {
  const ids = writeTargets(env, args, "set_dev_status");
  const raw = args.status === null || args.status === undefined ? null : String(args.status).toUpperCase().replace(/[\s-]+/g, "_");
  const status = raw === null || raw === "NONE" || raw === "REMOVE" ? null : raw === "READY_FOR_DEV" || raw === "BUILD" || raw === "READY" ? "BUILD" : raw === "COMPLETED" ? "COMPLETED" : undefined;
  if (status === undefined) throw new ToolError("status: READY_FOR_DEV, COMPLETED or null (remove).");
  for (const id of ids) {
    const n = env.ed.engine.readNode(id, { fields: ["type", "parentIndex"] });
    const parentType = n?.parentIndex?.guid ? env.ed.engine.readNode(n.parentIndex.guid, { fields: ["type"] })?.type : null;
    if (!(n?.type === "SECTION" || ((n?.type === "FRAME" || n?.type === "SYMBOL" || n?.type === "INSTANCE") && parentType === "CANVAS"))) throw new ToolError(`${id}: a status goes on a top-level frame, component or section (Dev Mode's rule).`);
  }
  env.write("Set status", () => setDevStatusOf(env.ed, ids, status as "BUILD" | "COMPLETED" | null, opt(args.description) ? { description: String(args.description).slice(0, 1000) } : {}), ids);
  const r = textResult({ status: status === "BUILD" ? "READY_FOR_DEV" : status, nodes: ids });
  r.touched = ids;
  return r;
}

type MenuItem = { name?: string; command?: string; menu?: MenuItem[]; separator?: boolean };
const flatMenu = (items: MenuItem[] = [], prefix = ""): { command: string; name: string }[] =>
  items.flatMap((m) => (m.menu ? flatMenu(m.menu, `${prefix}${m.name} › `) : m.command !== undefined && m.name ? [{ command: m.command, name: `${prefix}${m.name}` }] : []));

async function pluginsTool(env: ToolEnv, name: string, args: Spec, s: AppServices): Promise<ToolResult> {
  const svc = s.plugins(env.ed);
  if (!svc) throw new ToolError("Plugins aren't available in this file.");
  const entries = svc.entries();
  if (name === "list_plugins") return textResult({ plugins: entries.map((e) => ({ id: e.ref.id, name: e.ref.name, commands: flatMenu((e.manifest?.menu ?? []) as MenuItem[]), ...(e.disabled ? { cantRun: e.disabled } : {}) })) });
  const id = str(args.id, "id", 200);
  const e = entries.find((x) => x.ref.id === id || x.ref.name === id);
  if (!e) throw new ToolError(`No plugin ${id} (list_plugins lists them).`);
  if (e.disabled) throw new ToolError(`${e.ref.name} can't run here: ${e.disabled}`);
  const run = await svc.run(e.ref as never, typeof args.command === "string" ? args.command : "", args.parameters && typeof args.parameters === "object" ? { parameters: args.parameters as Record<string, unknown> } : {});
  if (!run) throw new ToolError(`${e.ref.name} didn't start (the app showed why).`);
  return textResult({ started: e.ref.name, note: "It runs like a plugin run from the menu (its own undo steps); check the canvas with get_screenshot." });
}

// ---- Settings ---------------------------------------------------------------------------------------------------------

const VIEW_KEYS = ["rulers", "pixelGrid", "layoutGuides", "outlines", "showSlices"] as const;
const MODES: readonly Mode[] = ["design", "dev", "draw", "social", "motion"];

function settingsView(env: ToolEnv, s: AppServices) {
  const ui = env.ed.ui.get();
  return {
    language: s.locale(),
    theme: s.theme(),
    mode: modeOf(env.ed),
    preferences: Object.fromEntries([...PREFERENCES, ...ACCESSIBILITY_PREFERENCES].map((p) => [`preferences.${p.key}`, pref(ui, p.key)])),
    nudge: ui.nudge ?? { small: 1, big: 10 },
    view: {
      "view.rulers": !!ui.rulers,
      "view.pixelGrid": ui.pixelGrid !== false,
      "view.layoutGuides": ui.layoutGuides !== false,
      "view.outlines": !!ui.outlines,
      "view.showSlices": ui.showSlices !== false,
      "view.multiplayerCursors": ui.multiplayerCursors !== false,
      "view.comments": ui.comments !== false,
    },
    present: Object.fromEntries(Object.entries(readWebOptions()).map(([k, v]) => [`present.${k}`, v])),
    notChangeable: "Agents' Access, providers and keys, connectors, sign-in, sessions and tokens, and Operator settings are changed by the person only.",
  };
}

async function settingsTool(env: ToolEnv, name: string, args: Spec, s: AppServices): Promise<ToolResult> {
  if (name === "get_app_settings") return textResult(settingsView(env, s));
  const key = str(args.key, "key", 100).trim();
  const v = args.value;
  const bool = () => {
    if (typeof v !== "boolean") throw new ToolError(`${key}: true or false.`);
    return v;
  };
  if (key === "language") {
    if (v !== "en" && v !== "tr") throw new ToolError('language: "en" (English) or "tr" (Turkish).');
    await s.setLocale(v);
  } else if (key === "theme") {
    if (v !== "light" && v !== "dark" && v !== "system") throw new ToolError('theme: "light", "dark" or "system".');
    s.setTheme(v);
  } else if (key === "mode") {
    if (!MODES.includes(v as Mode)) throw new ToolError(`mode: one of ${MODES.join(", ")}.`);
    setMode(env.ed, v as Mode);
  } else if (key.startsWith("preferences.")) {
    const k = key.slice("preferences.".length) as PreferenceKey;
    if (![...PREFERENCES, ...ACCESSIBILITY_PREFERENCES].some((p) => p.key === k)) throw new ToolError(`No preference ${k} (get_app_settings lists them).`);
    setPreference(env.ed, k, bool());
  } else if (key === "nudge") {
    const o = (v && typeof v === "object" ? v : {}) as { small?: unknown; big?: unknown };
    const ok = (n: unknown) => typeof n === "number" && n > 0 && n <= 1000;
    if (!ok(o.small) || !ok(o.big)) throw new ToolError("nudge: {small, big} in px (0 < n ≤ 1000).");
    setNudge(env.ed, { small: o.small as number, big: o.big as number });
  } else if (key === "view.multiplayerCursors") {
    env.ed.ui.set({ multiplayerCursors: bool() });
  } else if (key === "view.comments") {
    env.ed.ui.set({ comments: bool() });
  } else if (key.startsWith("view.") && (VIEW_KEYS as readonly string[]).includes(key.slice(5))) {
    setViewOption(env.ed, { [key.slice(5)]: bool() });
  } else if (key === "present.websiteBehaviours" || key === "present.keepState") {
    writeWebOptions({ [key.slice(8)]: bool() });
  } else if (/^(access|reach|agents?|providers?|connectors?|keys?|tokens?|sessions?|operator|account\.(password|email|delete))/i.test(key)) {
    throw new ToolError(`${key} isn't a setting an agent can change: the person changes it themselves (Settings / Agent settings).`);
  } else throw new ToolError(`No setting ${key} (get_app_settings lists the keys).`);
  return textResult({ set: key, value: v });
}

// ---- Dispatch ---------------------------------------------------------------------------------------------------------

/** One of the app tools, or null when `name` isn't one. */
export async function runAppTool(env: ToolEnv, name: string, args: Spec): Promise<ToolResult | null> {
  if (!APP_TOOL_NAMES.has(name)) return null;
  const s = await services(env);
  switch (name) {
    case "get_comments":
      return getComments(env, args, s);
    case "add_comment":
    case "reply_comment":
    case "edit_comment":
    case "resolve_comment":
    case "delete_comment":
      return commentWrite(env, name, args, s);
    case "list_versions":
    case "save_version":
    case "restore_version":
      return versionTool(env, name, args, s);
    case "export_nodes":
      return exportTool(env, args);
    case "get_libraries":
    case "set_library_enabled":
    case "accept_library_updates":
    case "insert_library_component":
    case "publish_library":
      return librariesTool(env, name, args);
    case "list_files":
    case "create_file":
    case "file_action":
      return filesTool(env, name, args, s);
    case "share_file":
      return shareTool(env, args, s);
    case "set_dev_status":
      return devStatusTool(env, args);
    case "list_plugins":
    case "run_plugin":
      return pluginsTool(env, name, args, s);
    case "get_app_settings":
    case "set_app_setting":
      return settingsTool(env, name, args, s);
  }
  return null;
}

