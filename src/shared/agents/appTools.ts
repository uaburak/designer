/**
 * The app beyond the canvas, for agents (docs/research/agent-parity.md, 2026-10-21 [ours]): what a signed-in person can
 * do in Wecra outside the layer tools — their Skills, comments, version history, export, libraries, Home's files and
 * folders, Dev Mode's status, plugins, the editor's and the app's own settings, sharing. Figma has no Plugin API for
 * most of these, so the shapes follow Figma's UI words and its REST API where it has one (comments: `message`,
 * `client_meta`; versions: `label`, `description`).
 *
 * Who answers: the Skills tools are main's (src/main/agents/skills.ts: the store and the chat's confirmation card); the
 * rest run in the file's view (src/renderer/src/editor/agents/appTools.ts). Destructive or outward calls — trash a
 * file, restore a version, publish a library, share, run a plugin, delete a comment, a comment that @mentions people,
 * any change to a Skill — wait for the owner's click on a confirmation card in the chat (as reach's "Ask each time"),
 * checked in main before the call goes anywhere (`confirmationFor`); an outside MCP client has no chat and is refused.
 *
 * Never reachable here (by design, not a gap): Operator's settings, org admin, sign-in, sessions, tokens and keys,
 * providers and connectors, agents' Access policies (reach), deleting files forever, emptying the trash.
 */
import type { ToolDef } from "./tools";

const str = { type: "string" };
const strs = { type: "array", items: { type: "string" } };
const fileKey = { type: "string", description: "A file's key (list_files lists them). Default: this file." };

// ── Skills (main) ──

export const SKILL_TOOLS: ToolDef[] = [
  {
    name: "list_skills",
    title: "List skills",
    description:
      "The owner's Skills (Agents › Skills — reusable instructions agents follow): id, name, description, enabled, size, plus Wecra's built-in ones. get_skill {name} reads one's instructions.",
    inputSchema: { type: "object", properties: {} },
    write: false,
  },
  {
    name: "create_skill",
    title: "Create skill",
    description:
      'Adds a Skill to the owner\'s Agents › Skills from instructions you wrote: {name (lowercase-hyphens, ≤ 64), description (when to use it, ≤ 1024), instructions (Markdown, ≤ 64 KB), enabled?: true}. The owner confirms it in the chat first; enabled skills are offered to agents from the next message on. Or `text`: a whole SKILL.md (YAML frontmatter name / description, then the instructions).',
    inputSchema: { type: "object", properties: { name: str, description: str, instructions: str, text: str, enabled: { type: "boolean" } } },
    write: false,
  },
  {
    name: "update_skill",
    title: "Update skill",
    description: "Changes one of the owner's Skills (by id or name): name, description, instructions, enabled (turn it on / off). The owner confirms the change in the chat first.",
    inputSchema: { type: "object", properties: { id: str, name: str, newName: str, description: str, instructions: str, enabled: { type: "boolean" } } },
    write: false,
  },
  {
    name: "remove_skill",
    title: "Remove skill",
    description: "Deletes one of the owner's Skills (by id or name). The owner confirms it in the chat first. Built-in skills can't be removed.",
    inputSchema: { type: "object", properties: { id: str, name: str } },
    write: false,
  },
  {
    name: "install_skill",
    title: "Install skill",
    description:
      'Adds a Skill found outside Wecra to the owner\'s Agents › Skills: `url` — a SKILL.md (or a skill folder) on the web, e.g. a GitHub page "https://github.com/anthropics/skills/tree/main/skills/frontend-design" or its raw file (needs Access › Web on; find_skills finds them) — or `repo` + `path` (+ `ref`) in a GitHub repository the owner lets you read (Access › GitHub). Only the SKILL.md text is taken (its scripts and other files are not installed, nothing is run). The owner sees the skill (name, description, source, the instructions) on a card in the chat and confirms; `replace: true` updates an existing skill of the same name. `name` overrides the skill\'s own name.',
    inputSchema: { type: "object", properties: { url: str, repo: str, path: str, ref: str, name: str, replace: { type: "boolean" }, enabled: { type: "boolean" } } },
    write: false,
  },
];

// ── The app (the file's view) ──

export const APP_TOOLS: ToolDef[] = [
  // Comments (Figma's comments: threads pinned on the canvas, replies, resolve, reactions)
  {
    name: "get_comments",
    title: "Get comments",
    description:
      "This file's comment threads: id, number, page, pinned point / layer, resolved, and each comment (id, author, message, mentions, reactions, time). `includeResolved` (default false), `pageId` filters. Also who can be @mentioned (people with access to a shared file).",
    inputSchema: { type: "object", properties: { includeResolved: { type: "boolean" }, pageId: str } },
    write: false,
  },
  {
    name: "add_comment",
    title: "Add comment",
    description:
      'Posts a new comment thread, as the owner, pinned on a layer (`nodeId`: the pin at its top-left, or `offset` {x, y} inside it) or at a page point (`pageId`, `x`, `y`). `message` ≤ 2000 characters. `mentions`: people\'s ids or emails (get_comments lists who can be mentioned) — they get notified, so the owner confirms first.',
    inputSchema: { type: "object", properties: { message: str, nodeId: str, offset: { type: "object", properties: { x: { type: "number" }, y: { type: "number" } } }, pageId: str, x: { type: "number" }, y: { type: "number" }, mentions: strs }, required: ["message"] },
    write: false,
  },
  {
    name: "reply_comment",
    title: "Reply to comment",
    description: "Replies in a thread (threadId from get_comments), as the owner. `mentions` as in add_comment (confirmed first).",
    inputSchema: { type: "object", properties: { threadId: str, message: str, mentions: strs }, required: ["threadId", "message"] },
    write: false,
  },
  {
    name: "edit_comment",
    title: "Edit comment",
    description: "Edits the text of one of the owner's comments.",
    inputSchema: { type: "object", properties: { commentId: str, message: str }, required: ["commentId", "message"] },
    write: false,
  },
  {
    name: "resolve_comment",
    title: "Resolve comment",
    description: "Resolves a thread (or re-opens it with resolved: false). Reactions: `react` {commentId, emoji, on?}.",
    inputSchema: { type: "object", properties: { threadId: str, resolved: { type: "boolean" }, react: { type: "object", properties: { commentId: str, emoji: str, on: { type: "boolean" } } } } },
    write: false,
  },
  {
    name: "delete_comment",
    title: "Delete comment",
    description: "Deletes a comment (a thread's first comment deletes the whole thread). The owner confirms first.",
    inputSchema: { type: "object", properties: { commentId: str }, required: ["commentId"] },
    write: false,
  },
  // Version history
  {
    name: "list_versions",
    title: "List versions",
    description: "The file's version history, newest first: id, title, description, saved at, by, autosave or named. `named: true` leaves autosaves out.",
    inputSchema: { type: "object", properties: { named: { type: "boolean" }, limit: { type: "number" } } },
    write: false,
  },
  {
    name: "save_version",
    title: "Save to version history",
    description: "File › Save to version history: a named version of the file as it is now ({title, description}). With `id`, names / describes an existing version instead (empty strings clear).",
    inputSchema: { type: "object", properties: { title: str, description: str, id: str } },
    write: false,
  },
  {
    name: "restore_version",
    title: "Restore version",
    description: "Restores the file to a version (by id; non-destructive: one undoable step, the history keeps everything). `duplicate: true` instead copies that version to a new file in Drafts. The owner confirms a restore first.",
    inputSchema: { type: "object", properties: { id: str, duplicate: { type: "boolean" } }, required: ["id"] },
    write: true,
  },
  // Export
  {
    name: "export_nodes",
    title: "Export",
    description:
      'Exports layers as files in your working folder (the Export section\'s formats): nodeIds, format PNG | JPG | SVG | PDF (default PNG), scale ("1x", "2x", "512w", "300h"; default 1x), suffix. `useNodeSettings: true` uses each layer\'s own export settings instead (Design › Export). Pages: a page id exports its whole canvas. Set a layer\'s export settings with set_properties {exportSettings}.',
    inputSchema: { type: "object", properties: { nodeIds: strs, format: { enum: ["PNG", "JPG", "JPEG", "SVG", "PDF"] }, scale: str, suffix: str, useNodeSettings: { type: "boolean" } }, required: ["nodeIds"] },
    write: false,
  },
  // Libraries
  {
    name: "get_libraries",
    title: "Get libraries",
    description: "Libraries as this file sees them (Assets › Libraries): this file's own library (published or not), every library of the workspace (enabled here or not, its components / styles / variables), and the updates waiting to be accepted. `assets: <libraryFileKey>` lists that library's published assets (key, kind, name) for insert_library_component.",
    inputSchema: { type: "object", properties: { assets: str } },
    write: false,
  },
  {
    name: "set_library_enabled",
    title: "Enable library",
    description: "Adds a library to this file (enabled: true) or removes it (false) — Assets › Libraries' switch.",
    inputSchema: { type: "object", properties: { library: str, enabled: { type: "boolean" } }, required: ["library", "enabled"] },
    write: true,
  },
  {
    name: "accept_library_updates",
    title: "Accept library updates",
    description: "Accepts library updates (Assets › Updates › Update all): every waiting update, or `keys` (\"<library>/<assetKey>\" from get_libraries).",
    inputSchema: { type: "object", properties: { keys: strs } },
    write: true,
  },
  {
    name: "insert_library_component",
    title: "Insert library component",
    description: "Places an instance of a library's component (library + key from get_libraries {assets}) at {x, y} on the current page (default: where the user is looking). Returns the instance's id; move it with reparent_nodes.",
    inputSchema: { type: "object", properties: { library: str, key: str, x: { type: "number" }, y: { type: "number" } }, required: ["library", "key"] },
    write: true,
  },
  {
    name: "publish_library",
    title: "Publish library",
    description: "Publishes this file's components, styles and variables as a library (Assets › Publish), with a description of the changes. It reaches everyone using the library, so the owner confirms first. Returns the version.",
    inputSchema: { type: "object", properties: { description: str } },
    write: false,
  },
  // Home: files and folders
  {
    name: "list_files",
    title: "List files",
    description: 'Files in Home: `in` recents (default) | drafts | starred | trash | folder (with folderId) | search (with text). Each: fileKey, name, folder, updated, starred, trashed. Also the folders (id, name, parent).',
    inputSchema: { type: "object", properties: { in: { enum: ["recents", "drafts", "starred", "trash", "folder", "search"] }, folderId: str, text: str } },
    write: false,
  },
  {
    name: "create_file",
    title: "Create file",
    description: "A new design file in Drafts or a folder ({name, folderId}). `open: true` opens it in a new tab (your session stays on this file).",
    inputSchema: { type: "object", properties: { name: str, folderId: str, open: { type: "boolean" } } },
    write: false,
  },
  {
    name: "file_action",
    title: "File action",
    description:
      'A file or folder action of Home\'s menus: rename {fileKey, name}, duplicate {fileKey}, move {fileKeys, folderId (null: Drafts)}, star / unstar {fileKey | folderId}, create_folder {name, parentId?, color?}, rename_folder {folderId, name}, open {fileKey}, trash {fileKeys, folderIds} (confirmed by the owner first), restore {fileKeys, folderIds} (from the trash). Deleting forever and emptying the trash stay the owner\'s.',
    inputSchema: { type: "object", properties: { action: { enum: ["rename", "duplicate", "move", "star", "unstar", "create_folder", "rename_folder", "open", "trash", "restore"] }, fileKey, fileKeys: strs, folderId: { type: ["string", "null"] }, folderIds: strs, name: str, parentId: str, color: str }, required: ["action"] },
    write: false,
  },
  {
    name: "share_file",
    title: "Share",
    description: "Shares this file (Share dialog): `invite` {email, role: editor | viewer}, `linkAccess` none | viewer | editor (Anyone with the link), or neither to read who has access and the link. Invites and link changes reach other people: the owner confirms first.",
    inputSchema: { type: "object", properties: { invite: { type: "object", properties: { email: str, role: { enum: ["editor", "viewer"] } } }, linkAccess: { enum: ["none", "viewer", "editor"] } } },
    write: false,
  },
  // Dev Mode
  {
    name: "set_dev_status",
    title: "Set dev status",
    description: 'Dev Mode\'s status on frames / sections: status READY_FOR_DEV (Mark as ready for dev) | COMPLETED | null (remove), with an optional description ("what changed"). One undo step. Annotations and measurements: set_properties {annotations} (describe_schema Annotation).',
    inputSchema: { type: "object", properties: { nodeIds: strs, status: { type: ["string", "null"] }, description: str }, required: ["nodeIds", "status"] },
    write: true,
  },
  // Plugins
  {
    name: "list_plugins",
    title: "List plugins",
    description: "The plugins that run in this file (development plugins and the organization's): id, name, its menu commands, and why one can't run here.",
    inputSchema: { type: "object", properties: {} },
    write: false,
  },
  {
    name: "run_plugin",
    title: "Run plugin",
    description: "Runs a plugin (id from list_plugins) with an optional menu `command` and `parameters`, as Plugins › ‹name› does. A plugin is code the owner installed: they confirm each run first.",
    inputSchema: { type: "object", properties: { id: str, command: str, parameters: { type: "object" } }, required: ["id"] },
    write: true,
  },
  // Settings the person can change (none that is a secret or a policy)
  {
    name: "get_app_settings",
    title: "Get app settings",
    description:
      "The person's own settings an agent may read and change: language, theme, the editor's Preferences (snap to geometry / objects / pixel grid, keep tool selected, highlight on hover, rename duplicated layers, show dimensions, invert zoom, number keys for opacity …), nudge amounts, view options (rulers, pixel grid, layout guides, outlines, multiplayer cursors, comments), presentation options (website behaviours, keep state on reload), and the mode (design / dev / prototype …). Keys as set_app_setting takes them.",
    inputSchema: { type: "object", properties: {} },
    write: false,
  },
  {
    name: "set_app_setting",
    title: "Set app setting",
    description:
      'Changes one of get_app_settings\' settings: {key, value} — e.g. {key: "language", value: "tr"}, {key: "theme", value: "dark"}, {key: "preferences.snapToPixelGrid", value: false}, {key: "nudge", value: {small: 1, big: 8}}, {key: "view.rulers", value: true}, {key: "present.websiteBehaviours", value: false}. Agents\' Access, providers, keys, sign-in and Operator settings are not settings an agent can change.',
    inputSchema: { type: "object", properties: { key: str, value: {} }, required: ["key", "value"] },
    write: false,
  },
];

export const APP_TOOL_NAMES: ReadonlySet<string> = new Set(APP_TOOLS.map((t) => t.name));
export const SKILL_TOOL_NAMES: ReadonlySet<string> = new Set(SKILL_TOOLS.map((t) => t.name));
/** Skill tools that change the owner's Skills (the Agents panel reads them again when one is done). */
export const SKILL_WRITE_TOOLS: ReadonlySet<string> = new Set(["create_skill", "update_skill", "remove_skill", "install_skill"]);

// ── Confirmation (the chat's card) ──

/** What the confirmation card shows: "Agent wants to ‹action›", the target, and an optional preview. */
export interface ConfirmRequest {
  /** In the card's words, an English UI key ("move files to the trash") */
  action: string;
  target: string;
  preview?: string;
}

const s = (v: unknown, max = 300) => (typeof v === "string" ? v.slice(0, max) : "");
const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

/**
 * The confirmation a call needs before it runs (null: none) — destructive or outward actions only. Main asks for it
 * (src/main/agents/host.ts) whoever answers the call; Skills' writes ask in skills.ts, with the skill's text.
 */
export function confirmationFor(name: string, args: Record<string, unknown> = {}): ConfirmRequest | null {
  switch (name) {
    case "file_action": {
      if (args.action !== "trash") return null;
      const files = list(args.fileKeys).concat(s(args.fileKey) ? [s(args.fileKey)] : []);
      const folders = list(args.folderIds);
      return { action: "move files to the trash", target: [files.length ? `${files.length} file(s): ${files.slice(0, 10).join(", ")}` : "", folders.length ? `${folders.length} folder(s): ${folders.slice(0, 10).join(", ")}` : ""].filter(Boolean).join(" · ") || "(nothing given)" };
    }
    case "restore_version":
      return args.duplicate === true ? null : { action: "restore this file to an earlier version", target: `version ${s(args.id, 80)}` };
    case "publish_library":
      return { action: "publish this file as a library", target: s(args.description, 500) || "(no description)" };
    case "share_file": {
      const inv = (args.invite && typeof args.invite === "object" ? args.invite : null) as { email?: unknown; role?: unknown } | null;
      if (!inv && args.linkAccess === undefined) return null;
      return { action: "share this file", target: [inv ? `invite ${s(inv.email, 200)} as ${s(inv.role, 20) || "viewer"}` : "", args.linkAccess !== undefined ? `anyone with the link: ${s(args.linkAccess, 20)}` : ""].filter(Boolean).join(" · ") };
    }
    case "delete_comment":
      return { action: "delete a comment", target: s(args.commentId, 80) };
    case "add_comment":
    case "reply_comment": {
      const m = list(args.mentions);
      return m.length ? { action: "post a comment that notifies people", target: m.slice(0, 20).join(", "), preview: s(args.message, 2000) } : null;
    }
    case "run_plugin":
      return { action: "run a plugin", target: [s(args.id, 120), s(args.command, 120)].filter(Boolean).join(" › ") };
    default:
      return null;
  }
}
