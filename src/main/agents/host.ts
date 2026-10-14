import { app, clipboard, dialog, nativeImage, safeStorage, shell, webContents, type WebContents } from "electron";
import { reportAiPrompt } from "../account/governanceReports";
import { sealAsync, unsealAsync } from "../sealed";
import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import type { ToolResult } from "../../shared/agents/tools";
import { MANAGER_TOOL_NAMES, MCP_SERVER_NAME, WAITING_TOOL_MS, WAITING_TOOLS, textResult } from "../../shared/agents/tools";
import { cleanManagerSettings, cleanManagerTools } from "../../shared/agents/manager";
import type { ManagerSettings } from "../../shared/studio/types";
import type { Connector, ConnectorConsent, ConnectorToolPolicy } from "../../shared/ai/types";
import { ConnectorHub, type ConsentAnswer, type StoredConnector } from "./connectors";
import { ReachHub, type ReachConsentRequest, type ReachRunner } from "./reach/hub";
import { ReachStore } from "./reach/store";
import { orgForcedOff } from "./reach/org";
import { grantProblem, isDeniedPath } from "./reach/paths";
import { REACH_NOTE, REACH_SKILLS, isReachPolicy, isRepoName, type AccessLogEntry, type ReachCapability, type ReachPatch, type ReachView } from "../../shared/agents/reach";
import { normalizeAllowedHost } from "../../shared/agents/reachNet";
import { aiSettings } from "../ai/settings";
import { ledgerBalance } from "../ai/ledger";
import { overLimit } from "../ai/run";
import { readyStore } from "../storeHost";
import type { AgentSettings, ChatEvent, ManagerToolDef, McpClientId, McpConnection, McpState, ProviderInfo, ToolCall, ToolCallResult, TurnRequest, UsageInfo } from "../../shared/agents/types";
import { cliSpec, type CliSpec } from "./providers";
import { runCliProcess, loginUrl, type AuthEnv, type CliModels, type RunResult } from "./providers/turns";
import { ImagePathError, resolveImagePaths } from "./imageArgs";
import { attachmentsDirOf, clipboardPaths, readFiles, saveAttachments, turnAttachments } from "./attachments";
import type { AttachResult } from "../../shared/agents/attachments";
import { configText, connectClient, disconnectClient, listClients, CLIENTS, type ClientEnv } from "./clients";
import { cliEnv, cliPath, detectProviders, LOCAL_SERVERS, searchPath, spawnCli, spawnShell, which } from "./detect";
import { McpServer, newToken } from "./mcpServer";
import { listModels, runOpenAiTurn, trimBase } from "./openaiBridge";
import { STDIO_BRIDGE_SOURCE } from "./stdioBridge";
import type { AuthState } from "../../shared/agents/types";
import { allViews } from "../views";
import { controllers } from "../window";
import { t as tr } from "../../shared/i18n";

/**
 * Main's side of Agents (docs/research/figma/R12-agents-mcp.md): the MCP server (started with the app, on
 * 127.0.0.1, the port kept between launches so connected clients' configs keep working), the chats' turns —
 * a CLI run headless with our server, or an OpenAI-compatible server bridged here — and "Connect" for MCP clients.
 * Tool calls go to the editor view that holds the session's file (`agents:tool-call` → `agents:tool-result`).
 *
 * Kept in userData/agents: settings.json (provider, models, servers, the port, the outside clients' token —
 * encrypted with safeStorage when the OS offers it), keys.json (servers' API keys, safeStorage only), server.json
 * (the running server's URL and token for the stdio bridge, mode 0600), designer-mcp.cjs (the bridge), work/ (the
 * CLIs' empty working folder).
 */

interface Stored {
  providerId: string | null;
  models: Record<string, string>;
  custom: { id: string; label: string; baseUrl: string }[];
  port?: number;
  /** The outside clients' token: "enc:<base64>" (safeStorage) or "raw:<token>" */
  token?: string;
  /** Agent settings › Manager (docs/studio.md §2.1); absent: DEFAULT_MANAGER_SETTINGS */
  manager?: ManagerSettings;
}

const dir = () => join(app.getPath("userData"), "agents");
const file = (name: string) => join(dir(), name);

function readStored(): Stored {
  try {
    const s = JSON.parse(readFileSync(file("settings.json"), "utf8")) as Partial<Stored>;
    return { providerId: s.providerId ?? null, models: s.models ?? {}, custom: Array.isArray(s.custom) ? s.custom : [], port: s.port, token: s.token, ...(s.manager ? { manager: cleanManagerSettings(s.manager) } : {}) };
  } catch {
    return { providerId: null, models: {}, custom: [] };
  }
}

function writePrivate(path: string, text: string) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, text, { mode: 0o600 });
  renameSync(tmp, path);
  chmodSync(path, 0o600);
}

const writeStored = (s: Stored) => writePrivate(file("settings.json"), JSON.stringify(s, null, 1));

const canEncrypt = () => {
  try {
    return safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
};

const seal = (secret: string) => (canEncrypt() ? `enc:${safeStorage.encryptString(secret).toString("base64")}` : `raw:${secret}`);
function unseal(v: string | undefined): string | null {
  if (!v) return null;
  try {
    if (v.startsWith("enc:")) return safeStorage.decryptString(Buffer.from(v.slice(4), "base64"));
    if (v.startsWith("raw:")) return v.slice(4);
  } catch {
    return null;
  }
  return null;
}

function readKeys(): Record<string, string> {
  try {
    return JSON.parse(readFileSync(file("keys.json"), "utf8")) as Record<string, string>;
  } catch {
    return {};
  }
}

const keyOf = (id: string): string | undefined => {
  const v = readKeys()[id];
  return v?.startsWith("enc:") ? (unseal(v) ?? undefined) : undefined;
};

const publicSettings = (s: Stored): AgentSettings => {
  const keys = readKeys();
  return { providerId: s.providerId, models: s.models, custom: s.custom.map((c) => ({ ...c, hasKey: !!keys[c.id] })), manager: cleanManagerSettings(s.manager) };
};

const clientEnv = (): ClientEnv => ({ home: homedir(), which: (b) => which(b), exists: (p) => existsSync(p) });

interface Turn {
  id: string;
  chatId: string;
  fileKey: string;
  sender: WebContents;
  child?: ChildProcess;
  abort?: AbortController;
  stopped: boolean;
  grant?: string;
  /** Folders besides the chat's own whose pictures place_image may read (the agent's own output folder for this chat) */
  imageDirs: string[];
  /** The connectors this turn may use (enabled ones the chat turned on) */
  connectors: string[];
  /** Studio (docs/studio.md §2.2): a manager's turn, a worker's (a task: its own grant and folder), or a chat's */
  role?: "manager" | "worker";
  /** A manager's turn: the manager-only tools the view answers */
  managerTools: ManagerToolDef[];
  /** Its CLI's working folder: the chat's own, or a worker's own inside it */
  cwd: string;
}

let server: McpServer | null = null;
let providerCache: { at: number; list: ProviderInfo[] } | null = null;
const turns = new Map<string, Turn>();
/** CLIs' own model lists, read with their status (Antigravity's `agy models`) */
const cliModels = new Map<string, CliModels>();
/** A chat's grant (its MCP token), kept across its turns: `${fileKey}/${chatId}` → token */
const chatTokens = new Map<string, string>();
let reqSeq = 0;
const pending = new Map<number, { resolve: (r: ToolResult) => void; sender: number; timer: ReturnType<typeof setTimeout> }>();

/** The editor view showing `fileKey` (its edit view; a prototype tab can't run tools). */
function viewFor(fileKey: string): WebContents | null {
  for (const [id, info] of allViews()) {
    if (info.role !== "editor" || info.fileKey !== fileKey) continue;
    const wc = webContents.fromId(id);
    if (wc && !wc.isDestroyed() && !/[?&]present(?:[=&]|$)/.test(wc.getURL())) return wc;
  }
  return null;
}

function activeFileKey(): string | null {
  for (const ctl of controllers.values()) {
    if (!ctl.win.isFocused() && controllers.size > 1) continue;
    const snap = ctl.tabs.snapshot();
    const tab = snap.tabs.find((t) => t.id === snap.activeTabId);
    if (tab?.fileKey && tab.kind === "file") return tab.fileKey;
  }
  return null;
}

function broadcast(state: McpState) {
  for (const [id, info] of allViews()) {
    // Home too: its Settings › Agents shows the server's connections.
    if (info.role !== "editor" && info.role !== "home") continue;
    const wc = webContents.fromId(id);
    if (wc && !wc.isDestroyed()) wc.send("agents:mcp-state", state);
  }
}

const mcpState = (connections?: McpConnection[]): McpState => ({ running: !!server?.url, url: server?.url ?? null, connections: connections ?? server?.connections() ?? [] });

/** A chat's own working folder (its CLI's project; where its pictures are saved). */
const chatDir = (chatId: string) => join(file("work"), chatId.replace(/[^\w-]/g, "_"));

function runToolInView(fileKey: string, call0: Omit<ToolCall, "reqId">): Promise<ToolResult> {
  const wc = viewFor(fileKey);
  if (!wc) return Promise.resolve({ content: [{ type: "text", text: "The file isn't open." }], isError: true });
  // Image paths are read here (the view can't read files): a chat's from its own folder, an outside client's from home.
  let call = call0;
  try {
    const t = call0.turnId ? turns.get(call0.turnId) : undefined;
    const roots = t ? [...new Set([chatDir(t.chatId), t.cwd]), ...t.imageDirs] : [homedir()];
    call = { ...call0, args: resolveImagePaths(call0.name, call0.args ?? {}, roots) };
    // The manager's library_add_image of a file the owner attached in the chat (docs/studio.md §3.3): read here, sent as data.
    if (t?.role === "manager" && call.name === "library_add_image" && typeof call.args.path === "string") {
      const { path, ...rest } = call.args;
      const read = resolveImagePaths("place_image", { path }, roots);
      call = { ...call, args: { ...rest, data: read.data, ...(typeof rest.name === "string" ? {} : { name: read.name }) } };
    }
  } catch (err) {
    if (err instanceof ImagePathError) return Promise.resolve({ content: [{ type: "text", text: err.message }], isError: true });
    throw err;
  }
  const reqId = ++reqSeq;
  // The manager's waits (tasks, the owner's answer on a card) may take a while (docs/studio.md §2.2).
  const ms = WAITING_TOOLS.has(call.name) ? WAITING_TOOL_MS : 120_000;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(reqId);
      resolve({ content: [{ type: "text", text: `The tool took too long (${ms >= 60_000 ? `${ms / 60_000} min` : `${ms / 1000} s`}).` }], isError: true });
    }, ms);
    pending.set(reqId, { resolve, sender: wc.id, timer });
    wc.send("agents:tool-call", { reqId, ...call });
  });
}

/**
 * Any tool of a chat or an outside client: `get_skill` answered here, a connector's tool proxied (its policy and the
 * consent card — docs/ai.md §2.11), the rest run in the file's view.
 */
async function runAnyTool(fileKey: string, call: Omit<ToolCall, "reqId">): Promise<ToolResult> {
  if (call.name === "get_skill") return getSkill(String(call.args?.name ?? ""));
  const t = call.turnId ? turns.get(call.turnId) : undefined;
  // Agents' reach (docs/agents-reach.md): through the gate, for the Agents tab's chats only.
  if (reachHub().has(call.name)) {
    if (!t) return textResult(`${call.name} works only in Wecra's Agents chats.`, true);
    return reachHub().call({ turnId: t.id, chatId: t.chatId, fileKey: t.fileKey, agent: call.client }, call.name, call.args ?? {});
  }
  if (t && hub?.has(t.connectors, call.name)) return hub.call(t.connectors, call.name, call.args ?? {}, t.id);
  // The manager's tools are for its own turns (docs/studio.md §2.2): a worker (or anyone else) is refused here too.
  if (t?.role !== "manager" && (MANAGER_TOOL_NAMES.has(call.name) || isManagerOnly(call.name))) return textResult(`${call.name} is the manager's tool: a task can't call it.`, true);
  return runToolInView(fileKey, call);
}

/** Names a manager turn listed as its own (the library's tools, which main doesn't know by name). */
const managerOnlyNames = new Set<string>();
const isManagerOnly = (name: string) => managerOnlyNames.has(name);

/** `get_skill {name}`: an enabled Skill's instructions, from the store (6g's skills; docs/ai.md §2.10). */
async function getSkill(name: string): Promise<ToolResult> {
  const wanted = name.trim().replace(/^\//, "").toLowerCase();
  // The built-in skills of agents' reach (docs/agents-reach.md §6.3), while their capability is on.
  const builtIn = REACH_SKILLS.find((s) => s.name === wanted);
  if (builtIn) {
    const on = await reachHub().on();
    if (builtIn.capabilities.some((c) => on.includes(c))) return textResult(`<skill name="${builtIn.name}">\n${builtIn.instructions}\n</skill>`);
  }
  try {
    const skills = await (await readyStore()).ai.skills();
    const s = skills.find((k) => k.enabled && k.name === wanted);
    if (!s) return textResult(`No enabled Skill is named “${wanted}”. The Skills you can use are listed with the message.`, true);
    return textResult(`<skill name="${s.name}">\n${s.instructions}\n</skill>`);
  } catch (err) {
    return textResult(`Skills aren't available: ${err instanceof Error ? err.message : String(err)}`, true);
  }
}

// ── Connectors (docs/ai.md §2.11): userData/agents/connectors.json, keys sealed in keys.json as "connector:<id>" ──

let hub: ConnectorHub | null = null;
let consentSeq = 0;
const consents = new Map<number, { resolve: (a: ConsentAnswer) => void; sender: number; turnId: string; timer: ReturnType<typeof setTimeout> }>();

function connectorHub(): ConnectorHub {
  hub ??= new ConnectorHub({
    storage: {
      read: () => {
        try {
          const list = JSON.parse(readFileSync(file("connectors.json"), "utf8")) as unknown;
          return Array.isArray(list) ? (list as StoredConnector[]) : [];
        } catch {
          return [];
        }
      },
      write: (list) => writePrivate(file("connectors.json"), JSON.stringify(list, null, 1)),
      key: (id) => keyOf(`connector:${id}`) ?? null,
      setKey: (id, key) => {
        const keys = readKeys();
        if (key) {
          if (!canEncrypt()) throw new Error(tr("This computer's keychain isn't available: the key wasn't kept"));
          keys[`connector:${id}`] = seal(key);
        } else delete keys[`connector:${id}`];
        writePrivate(file("keys.json"), JSON.stringify(keys));
      },
    },
    spawn: (cmd, args, options) => spawnCli(cmd, args, options),
    env: () => cliEnv(),
    cwd: file("work"),
    ask: askConsent,
  });
  return hub;
}

/** Ask: the consent card in the chat of the turn that called (`agents:consent`), denied after 5 minutes unanswered. */
function askConsent(c: Omit<ConnectorConsent, "reqId">): Promise<ConsentAnswer> {
  const t = turns.get(c.turnId);
  if (!t || t.sender.isDestroyed()) return Promise.resolve({ allow: false });
  const reqId = ++consentSeq;
  return new Promise((resolve) => {
    const timer = setTimeout(() => settleConsent(reqId, { allow: false }), 5 * 60_000);
    consents.set(reqId, { resolve, sender: t.sender.id, turnId: t.id, timer });
    t.sender.send("agents:consent", { reqId, chatId: t.chatId, ...c } satisfies ConnectorConsent);
  });
}

// ── Agents' reach (docs/agents-reach.md): Agent settings › Access, the gate, the runners ──

const CAPABILITY_LABEL: Record<ReachCapability, string> = { web: "Web", github: "GitHub", files: "Local files", apps: "Local apps" };
let reachStore: ReachStore | null = null;
const reachStoreOf = () => (reachStore ??= new ReachStore(dir()));
/** The capabilities' runners, each phase's (web.ts, github.ts, files.ts, apps.ts): a capability without one isn't listed */
const reachRunners: Partial<Record<ReachCapability, ReachRunner>> = {};
let reach: ReachHub | null = null;

function reachHub(): ReachHub {
  reach ??= new ReachHub({
    settings: () => reachStoreOf().settings(),
    setPolicy: (cap, policy) => {
      const s = reachStoreOf().settings();
      s.policies[cap] = policy;
      reachStoreOf().saveSettings(s);
    },
    forcedOff: () => orgForcedOff(),
    ask: (req) => askAccess(req),
    log: (e) => reachStoreOf().append(e),
    runners: reachRunners,
  });
  return reach;
}

/** A reach capability's consent card (or, for Local apps, its window picker) in the turn's chat. */
function askAccess(req: ReachConsentRequest): Promise<ConsentAnswer> {
  return askConsent({ turnId: req.turnId, connectorId: `access:${req.access.capability}`, connector: tr(CAPABILITY_LABEL[req.access.capability]), tool: req.tool, args: req.args, access: req.access });
}

/** Phase-specific parts of the Access page's view (GitHub's connection, the Screen Recording permission). */
const reachExtras: { github?: () => Promise<ReachView["github"]>; screen?: () => ReachView["screenPermission"] } = {};

export async function accessView(): Promise<ReachView> {
  return {
    settings: reachStoreOf().settings(),
    forcedOff: await orgForcedOff().catch(() => []),
    github: (await reachExtras.github?.().catch(() => null)) ?? { connected: false, login: null, via: null, deviceFlow: false },
    screenPermission: reachExtras.screen?.() ?? "unknown",
  };
}

/** A change from Agent settings › Access, checked here again; folders only shrink (they are added with the picker). */
export function setAccess(patch: ReachPatch): Promise<ReachView> {
  const s = reachStoreOf().settings();
  for (const [cap, p] of Object.entries(patch?.policies ?? {})) if (cap in s.policies && isReachPolicy(p)) s.policies[cap as ReachCapability] = p;
  if (Array.isArray(patch?.allowedHosts)) s.web.allowedHosts = [...new Set(patch.allowedHosts.flatMap((h) => normalizeAllowedHost(String(h)) ?? []))];
  if (Array.isArray(patch?.repos)) s.github.repos = [...new Set(patch.repos.filter(isRepoName))];
  if (Array.isArray(patch?.folders)) s.files.folders = s.files.folders.filter((f) => patch.folders!.includes(f));
  reachStoreOf().saveSettings(s);
  return accessView();
}

/** Add folder…: main's picker, the folder's real path granted (read-only) unless it is too wide or may hold secrets. */
export async function addAccessFolder(sender: WebContents): Promise<ReachView> {
  const win = windowOf(sender);
  const options: Electron.OpenDialogOptions = { title: tr("Add a folder agents can read"), buttonLabel: tr("Add folder"), properties: ["openDirectory"] };
  const picked = win ? await dialog.showOpenDialog(win as unknown as Electron.BrowserWindow, options) : await dialog.showOpenDialog(options);
  if (picked.canceled || !picked.filePaths[0]) return accessView();
  const real = realpathSync(picked.filePaths[0]);
  const problem = grantProblem(real) ?? (isDeniedPath(real) ? "That folder may hold secrets and can't be granted." : null);
  if (problem) throw new Error(tr(problem));
  const s = reachStoreOf().settings();
  if (!s.files.folders.includes(real)) s.files.folders.push(real);
  reachStoreOf().saveSettings(s);
  return accessView();
}

export const accessLog = (): AccessLogEntry[] => reachStoreOf().entries();
export const clearAccessLog = () => reachStoreOf().clearLog();

function settleConsent(reqId: number, a: ConsentAnswer) {
  const p = consents.get(reqId);
  if (!p) return;
  clearTimeout(p.timer);
  consents.delete(reqId);
  p.resolve(a);
}

/** `agents:consent-answer` from a view: only the view the card went to may answer it. */
export function answerConsent(sender: WebContents, a: { reqId: number; allow: boolean; remember?: boolean; windowId?: string }) {
  const p = consents.get(a?.reqId);
  if (!p || p.sender !== sender.id) return;
  settleConsent(a.reqId, { allow: a.allow === true, remember: a.allow === true && a.remember === true, ...(a.allow === true && typeof a.windowId === "string" ? { windowId: a.windowId.slice(0, 200) } : {}) });
}

const denyConsents = (match: (p: { sender: number; turnId: string }) => boolean) => {
  for (const [id, p] of consents) if (match(p)) settleConsent(id, { allow: false });
};

export const connectors = (): Connector[] => connectorHub().list();
export const addConnector = (p: { name: string; transport: { kind: "http"; url: string; key?: string } | { kind: "stdio"; command: string; args: string[] } }) => connectorHub().add(p);
export const updateConnector = (p: { id: string; enabled?: boolean; policies?: Record<string, ConnectorToolPolicy> }) => connectorHub().update(p);
export const removeConnector = (id: string) => connectorHub().remove(id);
export const testConnector = (id: string) => connectorHub().test(id);

/** `agents:tool-result` from a view: only the view the call went to may answer it. */
export function settleToolCall(sender: WebContents, r: ToolCallResult) {
  const p = pending.get(r?.reqId);
  if (!p || p.sender !== sender.id) return;
  clearTimeout(p.timer);
  pending.delete(r.reqId);
  const content = Array.isArray(r.content) ? r.content.filter((c) => c && (c.type === "text" ? typeof c.text === "string" : c.type === "image" && typeof c.data === "string")).slice(0, 20) : [];
  p.resolve({ content: content.length ? content : [{ type: "text", text: "(no result)" }], isError: r.isError === true });
}

/** Starts the MCP server (with the app). */
export async function startAgents(): Promise<void> {
  const stored = readStored();
  // The keychain off main's thread (sealed.ts): a keychain prompt nobody answers only keeps the MCP server waiting.
  let token = await unsealAsync(stored.token);
  if (!token) {
    token = newToken();
    stored.token = await sealAsync(token);
    writeStored({ ...readStored(), token: stored.token });
  }
  server = new McpServer(
    {
      activeFileKey,
      isOpen: (k) => !!viewFor(k),
      runTool: (fileKey, call) => runAnyTool(fileKey, call),
      // A chat's connectors' tools, then the reach tools that are on (outside clients get none: mcpServer.ts).
      extraTools: async (session) => [...(await connectorHub().toolsFor(session.chat?.connectors ?? [])), ...(await reachHub().tools())],
      onConnections: (list) => broadcast(mcpState(list)),
      version: app.getVersion(),
    },
    token
  );
  // A port of its own, kept: the clients' configs name it.
  const preferred = stored.port ?? 3900 + Math.floor(Math.random() * 900);
  const port = await server.start(preferred);
  if (port !== stored.port) writeStored({ ...readStored(), port });
  writePrivate(file("server.json"), JSON.stringify({ url: server.url, token, pid: process.pid }));
  writePrivate(file("designer-mcp.cjs"), STDIO_BRIDGE_SOURCE);
  mkdirSync(file("work"), { recursive: true });
}

export async function stopAgents(): Promise<void> {
  for (const t of turns.values()) stopTurn(t.id);
  hub?.close();
  await server?.stop();
  server = null;
}

// ── Settings and providers ──

export const agentSettings = (): AgentSettings => publicSettings(readStored());

export function setAgentSettings(patch: Partial<Pick<AgentSettings, "providerId" | "models" | "manager">>): AgentSettings {
  const s = readStored();
  if (typeof patch.providerId === "string" || patch.providerId === null) s.providerId = patch.providerId;
  if (patch.models && typeof patch.models === "object") for (const [k, v] of Object.entries(patch.models)) if (typeof v === "string" && k.length < 100 && v.length < 300) s.models[k] = v;
  // The manager's settings (docs/studio.md §2.1): a whole or partial ManagerSettings over what is kept, cleaned.
  if (patch.manager && typeof patch.manager === "object") s.manager = cleanManagerSettings(patch.manager, cleanManagerSettings(s.manager));
  writeStored(s);
  return publicSettings(s);
}

export function addServer(p: { label: string; baseUrl: string; apiKey?: string }): AgentSettings {
  const base = trimBase(String(p.baseUrl ?? ""));
  if (!/^https?:\/\/[^\s]+$/i.test(base)) throw new Error(tr("A base URL like {example}", { example: "http://localhost:8080/v1" }));
  const s = readStored();
  const id = `custom:${randomUUID().slice(0, 8)}`;
  s.custom.push({ id, label: String(p.label || new URL(base).host).slice(0, 80), baseUrl: base });
  writeStored(s);
  if (p.apiKey) {
    if (!canEncrypt()) throw new Error(tr("This Mac's keychain isn't available: the key wasn't kept"));
    const keys = readKeys();
    keys[id] = seal(String(p.apiKey));
    writePrivate(file("keys.json"), JSON.stringify(keys));
  }
  providerCache = null;
  return publicSettings(s);
}

export function removeServer(id: string): AgentSettings {
  const s = readStored();
  s.custom = s.custom.filter((c) => c.id !== id);
  if (s.providerId === id) s.providerId = null;
  writeStored(s);
  const keys = readKeys();
  if (keys[id]) {
    delete keys[id];
    writePrivate(file("keys.json"), JSON.stringify(keys));
  }
  providerCache = null;
  return publicSettings(s);
}

export async function providers(fresh = false): Promise<ProviderInfo[]> {
  if (!fresh && providerCache && Date.now() - providerCache.at < 15_000) return providerCache.list;
  const s = readStored();
  const list = await detectProviders(s.custom.map((c) => ({ ...c, hasKey: false })), keyOf, { authOf: (spec, path) => cliAuthStatus(spec, path), modelsOf: (spec) => cliModels.get(spec.id) });
  providerCache = { at: Date.now(), list };
  return list;
}

const serverOf = (id: string) => [...LOCAL_SERVERS, ...readStored().custom].find((s) => s.id === id);

/** An OpenAI-compatible server's address and key, for a one-shot AI run's route (src/main/ai/host.ts); null if unknown. */
export function serverRoute(id: string): { id: string; label: string; baseUrl: string; apiKey?: string } | null {
  const srv = serverOf(id);
  return srv ? { id: srv.id, label: srv.label, baseUrl: srv.baseUrl, apiKey: keyOf(srv.id) } : null;
}

export async function testProvider(id: string): Promise<{ ok: boolean; models: string[]; error?: string; version?: string }> {
  const spec = cliSpec(id);
  if (spec) {
    const path = cliPath(spec);
    if (!path) return { ok: false, models: [], error: `${spec.bins[0]} isn't installed (looked on PATH and in ~/.local/bin, /opt/homebrew/bin, /usr/local/bin)` };
    // `--version` and the CLI's own sign-in status only: nothing is sent to the model.
    const version = (await runBin(path, ["--version"], 8000)).stdout.trim().split("\n")[0];
    if (!version) return { ok: false, models: [], error: `${path} didn't answer --version` };
    const auth = await cliAuthStatus(spec, path);
    providerCache = null;
    if (auth.state !== "connected") return { ok: false, models: [], error: `${version} — signed out: use Sign in` };
    return { ok: true, models: cliModels.get(spec.id)?.models ?? spec.models, version };
  }
  const srv = serverOf(id);
  if (!srv) return { ok: false, models: [], error: tr("Unknown provider") };
  try {
    const models = await listModels(srv.baseUrl, { apiKey: keyOf(id), timeoutMs: 3000 });
    providerCache = null;
    return models.length ? { ok: true, models } : { ok: false, models, error: tr("The server answers but has no models loaded") };
  } catch (err) {
    return { ok: false, models: [], error: `${srv.baseUrl}: ${err instanceof Error ? err.message : String(err)}` };
  }
}

// ── Turns ──

function emit(t: Turn, event: ChatEvent) {
  if (!t.sender.isDestroyed()) t.sender.send("agents:event", { turnId: t.id, chatId: t.chatId, event });
}

function finishTurn(t: Turn, event?: ChatEvent) {
  if (!turns.has(t.id)) return;
  if (event) emit(t, event);
  emit(t, { type: "done", stopped: t.stopped || undefined });
  turns.delete(t.id);
  reach?.forgetTurn(t.id);
  // A worker's grant was its own: it goes with the turn. A chat's stays for its next turn.
  if (t.grant && t.role === "worker") server?.revokeChat(t.grant);
  else if (t.grant) {
    server?.updateChat(t.grant, { turnId: null });
    server?.endChatSessions(t.grant);
  }
}

/**
 * A turn's MCP token, bound to its file: a chat's own (made on its first turn, kept for the next) — with the manager's
 * tools listed while a manager's turn runs on it — or, for a worker, one of its own for this turn only, so a chat's
 * tasks run at once beside its manager, each with its own turn (docs/studio.md §2.2).
 */
function grantFor(t: Turn, client: string): string {
  const role = t.role;
  const managerTools = role === "manager" ? t.managerTools : undefined;
  if (role === "worker") return server!.grantChat({ fileKey: t.fileKey, turnId: t.id, client, connectors: t.connectors, role });
  const key = `${t.fileKey}/${t.chatId}`;
  let token = chatTokens.get(key);
  if (!token) {
    token = server!.grantChat({ fileKey: t.fileKey, turnId: t.id, client, connectors: t.connectors, role, managerTools });
    chatTokens.set(key, token);
  } else server!.updateChat(token, { turnId: t.id, client, connectors: t.connectors, role, managerTools });
  return token;
}

/** Forgets a closed file's chats' tokens (their sessions end). */
export function forgetFile(fileKey: string) {
  for (const [key, token] of chatTokens)
    if (key.startsWith(`${fileKey}/`)) {
      server?.revokeChat(token);
      chatTokens.delete(key);
    }
}

export function startTurn(sender: WebContents, fileKey: string, req: TurnRequest): { turnId: string } {
  if (!server?.url) throw new Error(tr("The agents' server isn't running"));
  const turnId = randomUUID();
  // The chat's connectors that exist and are on (docs/ai.md §2.11).
  const known = new Set(connectorHub().list().filter((c) => c.enabled).map((c) => c.id));
  const chatId = String(req.chatId).slice(0, 80);
  const role = req.role === "manager" || req.role === "worker" ? req.role : undefined;
  // A worker works in a folder of its own inside its chat's (its own CLI session; pictures it saves stay apart).
  const cwd = role === "worker" ? join(chatDir(chatId), "tasks", turnId) : chatDir(chatId);
  const managerTools = role === "manager" ? cleanManagerTools(req.managerTools) : [];
  for (const m of managerTools) managerOnlyNames.add(m.name);
  const t: Turn = { id: turnId, chatId, fileKey, sender, stopped: false, imageDirs: [], connectors: (req.connectors ?? []).filter((id) => known.has(id)), role, managerTools, cwd };
  turns.set(turnId, t);
  // Client-reported to Discovery for an org file (docs/governance.md §2.11): once per turn, fire-and-forget.
  reportAiPrompt(fileKey, String(req.prompt ?? ""), "agents_chat");
  const s = readStored();
  const providerId = String(req.providerId);
  const spec = cliSpec(providerId);
  // Only files in this chat's own attachments folder.
  const request: TurnRequest = { ...req, model: req.model ?? s.models[providerId], attachments: turnAttachments(chatDir(t.chatId), req.attachments) };
  void (async () => {
    // The credits stop (docs/ai.md §2.9): AI off, or the month's credits used up, refuses the turn.
    const ai = aiSettings();
    if (!ai.enabled) return finishTurn(t, { type: "error", message: tr("AI is turned off in Settings › AI.") });
    const over = await overLimit({ settings: () => ai, balance: ledgerBalance }, "agent");
    if (over) return finishTurn(t, { type: "error", message: over.message });
    if (t.stopped) return finishTurn(t);
    // Agents' reach on (docs/agents-reach.md §4.4, §6.3): the untrusted-data note once, and the built-in skills listed.
    const on = await reachHub().on().catch(() => [] as ReachCapability[]);
    if (on.length) {
      request.prompt = `${REACH_NOTE}\n\n${request.prompt}`;
      request.skills = [...(request.skills ?? []), ...REACH_SKILLS.filter((k) => k.capabilities.some((c) => on.includes(c))).map(({ name, description }) => ({ name, description }))];
    }
    if (spec) runCli(t, spec, request);
    else {
      const srv = serverOf(providerId);
      if (!srv) return finishTurn(t, { type: "error", message: tr("Pick an agent first (the model menu under the message box).") });
      await runServer(t, srv, request);
    }
  })().catch((err) => finishTurn(t, { type: "error", message: err instanceof Error ? err.message : String(err) }));
  return { turnId };
}

function runCli(t: Turn, spec: CliSpec, req: TurnRequest) {
  const path = cliPath(spec);
  if (!path) return finishTurn(t, { type: "error", message: tr("{agent} isn't installed on this computer.", { agent: spec.label }) });
  const token = grantFor(t, spec.label);
  t.grant = token;
  // Each chat gets its own empty folder (its CLI session's project), the turn's MCP config in it; a worker its own.
  const cwd = t.cwd;
  mkdirSync(cwd, { recursive: true });
  // Files attached in this chat (this message's or earlier ones') are readable by the agent in their folder.
  const attached = attachmentsDirOf(chatDir(t.chatId));
  const plan = spec.plan({ request: req, mcp: { url: server!.url!, token }, cwd, sessionId: randomUUID(), mcpConfigPath: join(cwd, "mcp.json"), home: homedir(), ...(existsSync(attached) ? { attachmentsDir: realpathSync(attached) } : {}) });
  // The agent's own picture folder for this chat's session (Antigravity: its conversation's), known now or from its start.
  const addImageDirs = (session: string) => {
    for (const d of spec.imageDirs?.(session, homedir()) ?? []) if (!t.imageDirs.includes(d)) t.imageDirs.push(d);
  };
  if (req.resume) addImageDirs(req.resume);
  for (const [name, text] of Object.entries(plan.files ?? {})) writePrivate(isAbsolute(name) ? name : join(cwd, name), text);
  emit(t, { type: "status", text: `Starting ${spec.label}…` });
  const child = runCliProcess({
    spec,
    path,
    plan,
    cwd,
    env: cliEnv({ ...plan.env }),
    spawn: (cmd, args, options) => spawnCli(cmd, args, options),
    emit: (e) => {
      if (e.type === "session") addImageDirs(e.resume);
      emit(t, e);
    },
    done: (error) => finishTurn(t, error ? { type: "error", message: error } : undefined),
    stopped: () => t.stopped,
    // A developer's recording of the raw output (the adapters' test fixtures): DESIGNER_AGENTS_RECORD=<folder>.
    raw: process.env.DESIGNER_AGENTS_RECORD ? (chunk) => appendFileSync(join(process.env.DESIGNER_AGENTS_RECORD!, `${spec.id}-${t.id}.ndjson`), chunk) : undefined,
  });
  if (child) t.child = child;
}

async function runServer(t: Turn, srv: { id: string; label: string; baseUrl: string }, req: TurnRequest) {
  const abort = new AbortController();
  t.abort = abort;
  const model = req.model;
  if (!model) return finishTurn(t, { type: "error", message: tr("Pick a model of {agent} first.", { agent: srv.label }) });
  emit(t, { type: "status", text: `Asking ${model} on ${srv.label}…` });
  const extraTools = [...t.managerTools, ...(t.connectors.length ? await connectorHub().toolsFor(t.connectors) : []), ...(await reachHub().tools())];
  return runOpenAiTurn({
    baseUrl: srv.baseUrl,
    apiKey: keyOf(srv.id),
    model,
    request: req,
    signal: abort.signal,
    emit: (e) => emit(t, e),
    extraTools,
    runTool: (name, args) => runAnyTool(t.fileKey, { turnId: t.id, client: srv.label, name, args }),
  })
    .then(() => finishTurn(t))
    .catch((err) => finishTurn(t, t.stopped ? undefined : { type: "error", message: `${srv.label}: ${err instanceof Error ? err.message : String(err)}` }));
}

export function stopTurn(turnId: string) {
  const t = turns.get(turnId);
  if (!t) return;
  t.stopped = true;
  denyConsents((p) => p.turnId === turnId);
  t.abort?.abort();
  if (t.child && t.child.exitCode === null) {
    t.child.kill("SIGINT");
    setTimeout(() => t.child?.exitCode === null && t.child.kill("SIGKILL"), 3000);
  } else if (!t.child) finishTurn(t);
}

/** A view went away: its turns stop, its pending calls fail. */
export function viewGone(sender: WebContents) {
  for (const t of turns.values()) if (t.sender === sender) stopTurn(t.id);
  denyConsents((p) => p.sender === sender.id);
  for (const [id, p] of pending)
    if (p.sender === sender.id) {
      clearTimeout(p.timer);
      pending.delete(id);
      p.resolve({ content: [{ type: "text", text: "The file was closed." }], isError: true });
    }
}

// ── Attachments (the composer's files: copied into the chat's folder, the only place they are written) ──

/** A small picture of an attached file for its chip: Quick Look's (images and PDFs), else the image scaled down. */
async function thumbOf(path: string, mime: string, bytes: Uint8Array): Promise<string | undefined> {
  const size = { width: 64, height: 64 };
  try {
    const t = await nativeImage.createThumbnailFromPath(path, size);
    if (!t.isEmpty()) return t.toDataURL();
  } catch {
    /* not on this OS, or Quick Look can't */
  }
  if (!mime.startsWith("image/")) return undefined;
  const img = nativeImage.createFromBuffer(Buffer.from(bytes));
  if (img.isEmpty()) return undefined;
  const s = img.getSize();
  return (s.height > s.width ? img.resize({ height: size.height }) : img.resize({ width: size.width })).toDataURL();
}

const save = (chatId: string, files: { name: string; bytes: Uint8Array }[]) => saveAttachments(chatDir(String(chatId).slice(0, 80)), files, { thumb: thumbOf });

/** Files dropped or pasted in the composer (their bytes, from the view). */
export const attach = (chatId: string, files: { name: string; bytes: Uint8Array }[]) => save(chatId, files);

const windowOf = (sender: WebContents) => [...controllers.values()].find((c) => c.tabs.contentViews().some((v) => v.webContents === sender))?.win;

/** The composer's "+": the files the user picks in main's dialog. */
export async function pickAttachments(sender: WebContents, chatId: string): Promise<AttachResult> {
  const win = windowOf(sender);
  const options: Electron.OpenDialogOptions = { title: tr("Add files and photos"), buttonLabel: tr("Add"), properties: ["openFile", "multiSelections"], filters: [{ name: tr("Images and PDFs"), extensions: ["pdf", "png", "jpg", "jpeg", "webp", "gif"] }] };
  const picked = win ? await dialog.showOpenDialog(win as unknown as Electron.BrowserWindow, options) : await dialog.showOpenDialog(options);
  if (picked.canceled || !picked.filePaths.length) return { attachments: [], errors: [] };
  const { files, errors } = readFiles(picked.filePaths);
  const r = await save(chatId, files);
  return { attachments: r.attachments, errors: [...errors, ...r.errors] };
}

/**
 * ⌘V of a file or a picture in the composer: the files copied in Finder (their paths on the clipboard — not the icon
 * Finder puts beside them), else the clipboard's picture (a screenshot, a copied image) as a PNG.
 */
export async function attachClipboard(chatId: string): Promise<AttachResult> {
  const none: AttachResult = { attachments: [], errors: [] };
  const items = await clipboard.read().catch(() => []);
  const text = async (item: Electron.ClipboardItem, type: string) => {
    try {
      const b = await item.getType(type);
      return b instanceof Blob ? await b.text() : "";
    } catch {
      return "";
    }
  };
  for (const item of items) {
    const listType = item.types.find((t) => /format="NSFilenamesPboardType"/i.test(t));
    const paths = clipboardPaths({ filenames: listType ? await text(item, listType) : "", fileUrl: item.types.includes("text/uri-list") ? (await text(item, "text/uri-list")).split(/\r?\n/).find((l) => l.startsWith("file://")) : "" });
    if (paths.length) {
      const { files, errors } = readFiles(paths);
      const r = await save(chatId, files);
      return { attachments: r.attachments, errors: [...errors, ...r.errors] };
    }
  }
  for (const item of items) {
    // A picture: PNG as it is (a screenshot), else the OS's TIFF made a PNG.
    const type = item.types.find((t) => t === "image/png") ?? item.types.find((t) => /^image\//.test(t) || /format="(?:NeXT TIFF v4\.0 pasteboard type|public\.tiff)"/i.test(t));
    if (!type) continue;
    const blob = await item.getType(type).catch(() => null);
    if (!(blob instanceof Blob)) continue;
    let bytes: Uint8Array = new Uint8Array(await blob.arrayBuffer());
    if (type !== "image/png") {
      const img = nativeImage.createFromBuffer(Buffer.from(bytes));
      if (img.isEmpty()) continue;
      bytes = img.toPNG();
    }
    return save(chatId, [{ name: "Pasted image.png", bytes }]);
  }
  return none;
}

// ── Usage (the plan's limits, from each CLI's own /usage without a model call) ──

const usageCache = new Map<string, { at: number; info: Promise<UsageInfo | null> }>();

export function usage(providerId: string, fresh = false): Promise<UsageInfo | null> {
  const spec = cliSpec(providerId);
  const path = spec?.usage && cliPath(spec);
  if (!spec?.usage || !path) return Promise.resolve(null);
  const cached = usageCache.get(providerId);
  if (cached && !fresh && Date.now() - cached.at < 60_000) return cached.info;
  const parse = spec.usage.parse;
  const info = runBin(path, spec.usage.args, 20_000).then((r) => {
    const windows = r.code === 0 ? parse(r) : null;
    return windows ? { providerId, windows, at: Date.now() } : null;
  });
  usageCache.set(providerId, { at: Date.now(), info });
  return info;
}

// ── Sign-in, install, image generation (each CLI's own commands; the browser or Terminal does the sign-in) ──

/** A CLI command's result, killed after `ms`. */
function runBin(path: string, args: string[], ms = 15_000): Promise<RunResult> {
  return new Promise((resolve) => {
    mkdirSync(file("work"), { recursive: true });
    const child = spawnCli(path, args, { env: cliEnv(), cwd: file("work"), stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d) => (stdout += d));
    child.stderr?.on("data", (d) => (stderr += d));
    child.on("error", () => resolve({ code: 1, stdout, stderr }));
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
    setTimeout(() => child.exitCode === null && child.kill(), ms);
  });
}

const authEnv = (): AuthEnv & { list(path: string): string[] } => ({
  home: homedir(),
  readFile: (p) => {
    try {
      return readFileSync(p, "utf8");
    } catch {
      return null;
    }
  },
  exists: (p) => existsSync(p),
  list: (p) => {
    try {
      return readdirSync(p);
    } catch {
      return [];
    }
  },
  env: process.env,
});

/** Sign-ins in progress: a background login (its output, for the page's address) or the CLI in Terminal (since when). */
const logins = new Map<string, { child?: ChildProcess; out: string; at: number; note?: string }>();

async function cliAuthStatus(spec: CliSpec, path: string): Promise<AuthState> {
  const a = spec.auth;
  let s: AuthState;
  if (a.status) {
    const r = await runBin(path, a.status.args, 10_000);
    s = a.status.parse(r, authEnv());
    const models = spec.modelsFromStatus?.(r);
    if (models) cliModels.set(spec.id, models);
  } else s = a.fromFiles ? a.fromFiles(authEnv()) : { state: "connected" };
  const l = logins.get(spec.id);
  if (s.state === "connected") {
    if (l) {
      l.child?.kill();
      logins.delete(spec.id);
    }
    return s;
  }
  const waiting = l && (l.child ? l.child.exitCode === null : Date.now() - l.at < 10 * 60_000);
  if (l && waiting) return { state: "signing-in", detail: tr(l.note ?? "Waiting for sign-in in your browser…"), url: loginUrl(l.out) ?? undefined };
  return s;
}

export async function authStatus(providerId: string): Promise<AuthState> {
  const spec = cliSpec(providerId);
  if (!spec) return { state: "not-installed", detail: tr("Not a CLI agent") };
  const path = cliPath(spec);
  if (!path) return { state: "not-installed", detail: tr("Looked for “{bin}” on PATH and in {dirs}", { bin: spec.bins[0], dirs: "~/.local/bin, /opt/homebrew/bin, /usr/local/bin" }) };
  return cliAuthStatus(spec, path);
}

const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * Runs a command in the user's Terminal (a .command file macOS opens in Terminal): the CLI's interactive sign-in, or
 * an install command — which waits for Return first, so nothing is installed without the user's go.
 */
async function openInTerminal(name: string, lines: string[]): Promise<string | null> {
  const path = file(`terminal/${name}.command`);
  const body = ["#!/bin/zsh", `export PATH=${shq(searchPath().join(delimiter))}`, `cd ${shq(file("work"))}`, "clear", ...lines, ""].join("\n");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body, { mode: 0o700 });
  chmodSync(path, 0o700);
  const err = await shell.openPath(path);
  return err || null;
}

export async function signIn(providerId: string): Promise<AuthState> {
  const spec = cliSpec(providerId);
  const path = spec && cliPath(spec);
  if (!spec || !path) return authStatus(providerId);
  const login = spec.auth.login;
  const l = logins.get(spec.id);
  if (login.kind === "background") {
    if (!l?.child || l.child.exitCode !== null) {
      mkdirSync(file("work"), { recursive: true });
      // The CLI's own login: its sign-in page opens in the browser, the CLI waits for it.
      const child = spawnCli(path, login.args, { env: cliEnv(), cwd: file("work"), stdio: ["pipe", "pipe", "pipe"] });
      const entry = { child, out: "", at: Date.now() };
      child.stdout?.on("data", (d) => (entry.out = (entry.out + d).slice(-8000)));
      child.stderr?.on("data", (d) => (entry.out = (entry.out + d).slice(-8000)));
      child.on("error", () => {});
      setTimeout(() => child.exitCode === null && child.kill(), 10 * 60_000);
      logins.set(spec.id, entry);
    }
    return { state: "signing-in", detail: tr("Waiting for sign-in in your browser…") };
  }
  const err = await openInTerminal(`${spec.id}-sign-in`, [`echo ${shq(login.note)}`, "echo", [shq(path), ...login.args.map(shq)].join(" ")]);
  if (err) return { state: "signed-out", detail: tr("Couldn't open Terminal: {error}", { error: err }) };
  logins.set(spec.id, { out: "", at: Date.now(), note: login.note });
  return { state: "signing-in", detail: tr(login.note) };
}

export async function signOut(providerId: string): Promise<AuthState> {
  const spec = cliSpec(providerId);
  const path = spec && cliPath(spec);
  providerCache = null;
  if (!spec || !path) return authStatus(providerId);
  logins.delete(spec.id);
  const out = spec.auth.logout;
  if (out.kind === "command") {
    await runBin(path, out.args);
    return authStatus(providerId);
  }
  const err = await openInTerminal(`${spec.id}-sign-out`, [`echo ${shq(out.note)}`, "echo", [shq(path), ...out.args.map(shq)].join(" ")]);
  const s = await authStatus(providerId);
  return { ...s, detail: err ? tr("Couldn't open Terminal: {error}", { error: err }) : tr(out.note) };
}

/**
 * npm's global folder is root's on a stock Mac (/usr/local/lib/node_modules), so a global install goes under the
 * user's own ~/.local instead (its bin is on our search path) — no sudo, no password.
 */
export function userInstallCommand(command: string): string {
  if (process.platform === "win32") return command; // %APPDATA%\npm is the user's own
  return /^npm install -g /.test(command) ? command.replace(/^npm install -g /, `npm install -g --prefix ${shq(join(homedir(), ".local"))} `) : command;
}

const installing = new Map<string, Promise<{ ok: boolean; opened?: "installed" | "page"; error?: string }>>();

/** Install: one click runs the documented command here (output kept for the error), or opens the download page. */
export async function install(providerId: string): Promise<{ ok: boolean; opened?: "installed" | "page"; error?: string }> {
  const spec = cliSpec(providerId);
  const srv = LOCAL_SERVERS.find((x) => x.id === providerId);
  const what: { label: string; command?: string; page: string } | null =
    spec ? { label: spec.label, ...spec.install } : srv ? { label: srv.label, ...srv.install } : null;
  if (!what) return { ok: false, error: tr("Unknown agent") };
  // Windows: a Unix installer line (curl … | bash) can't run here — the download page instead.
  if (!what.command || (process.platform === "win32" && /\b(curl|bash|sh|brew)\b/.test(what.command))) {
    await shell.openExternal(what.page);
    return { ok: true, opened: "page" };
  }
  const key = providerId;
  const running = installing.get(key);
  if (running) return running;
  const command = userInstallCommand(what.command);
  const job = new Promise<{ ok: boolean; opened?: "installed" | "page"; error?: string }>((resolve) => {
    mkdirSync(file("work"), { recursive: true });
    const child = spawnShell(command, { env: { ...cliEnv(), PATH: searchPath().join(delimiter) }, cwd: file("work"), stdio: ["pipe", "pipe", "pipe"] });
    // The owner's click is the go: an installer's own "continue? [Y/n]" gets yes.
    child.stdin?.end("y\n");
    let out = "";
    child.stdout?.on("data", (d) => (out = (out + d).slice(-4000)));
    child.stderr?.on("data", (d) => (out = (out + d).slice(-4000)));
    const timer = setTimeout(() => child.kill(), 10 * 60_000);
    child.on("error", (e) => { clearTimeout(timer); resolve({ ok: false, error: tr("Couldn't install {agent}: {error}", { agent: what.label, error: e.message }) }); });
    child.on("close", (code) => {
      clearTimeout(timer);
      providerCache = null;
      const last = out.trim().split("\n").slice(-3).join(" ");
      resolve(code === 0 ? { ok: true, opened: "installed" } : { ok: false, error: last ? tr("Couldn't install {agent}: {error}", { agent: what.label, error: last }) : tr("Couldn't install {agent}", { agent: what.label }) });
    });
  }).finally(() => installing.delete(key));
  installing.set(key, job);
  return job;
}

// ── MCP state and clients ──

export const mcp = (): McpState => mcpState();

/** The MCP clients; a connected one with when (its config file's last change — Settings › Security › Connected apps). */
export const clients = () =>
  listClients(clientEnv(), server?.url ?? null).map((c) => {
    if (!c.connected) return c;
    try {
      return { ...c, connectedAt: statSync(c.configPath).mtimeMs };
    } catch {
      return c;
    }
  });

function stdioSnippet(): string {
  return JSON.stringify({ [MCP_SERVER_NAME]: { command: process.execPath, args: [file("designer-mcp.cjs")], env: { ELECTRON_RUN_AS_NODE: "1" } } }, null, 2);
}

export function clientConfig(client: McpClientId) {
  if (!server?.url) throw new Error(tr("The MCP server isn't running"));
  const { path, text } = configText(client, { url: server.url, token: server.token }, clientEnv());
  return { path, text, stdio: stdioSnippet() };
}

export async function connect(sender: WebContents, client: McpClientId) {
  if (!server?.url) throw new Error(tr("The MCP server isn't running"));
  const spec = CLIENTS.find((c) => c.id === client);
  if (!spec) throw new Error("Unknown client");
  const { path } = configText(client, { url: server.url, token: server.token }, clientEnv());
  const win = [...controllers.values()].find((c) => c.tabs.contentViews().some((v) => v.webContents === sender))?.win;
  const options = {
    type: "question" as const,
    buttons: [tr("Connect"), tr("Cancel")],
    defaultId: 0,
    cancelId: 1,
    message: tr("Connect {client} to this app's MCP server?", { client: spec.label }),
    detail: tr("This adds a “{server}” server ({url}, with its access token) to {path}. Nothing else in the file changes, and a copy of it is kept next to it. {client} can then read and edit the file you have open here.", { server: MCP_SERVER_NAME, url: server.url, path: path.replace(homedir(), "~"), client: spec.label }),
  };
  const answer = win ? await dialog.showMessageBox(win as unknown as Electron.BrowserWindow, options) : await dialog.showMessageBox(options);
  if (answer.response !== 0) return { ok: false, path };
  // Claude Code keeps ~/.claude.json open itself: its own command adds the server when it is there.
  if (client === "claude-code") {
    const bin = which("claude");
    if (bin) {
      const run = (args: string[]) => new Promise<number>((resolve) => spawnCli(bin, args, { env: cliEnv(), cwd: file("work"), stdio: "ignore" }).on("close", (c) => resolve(c ?? 1)).on("error", () => resolve(1)));
      await run(["mcp", "remove", "--scope", "user", MCP_SERVER_NAME]);
      const code = await run(["mcp", "add", "--transport", "http", "--scope", "user", MCP_SERVER_NAME, server.url, "--header", `Authorization: Bearer ${server.token}`]);
      if (code === 0) return { ok: true, path };
    }
  }
  return connectClient(client, { url: server.url, token: server.token }, clientEnv());
}

export async function disconnect(client: McpClientId) {
  if (client === "claude-code") {
    const bin = which("claude");
    if (bin) {
      const code = await new Promise<number>((resolve) => spawnCli(bin, ["mcp", "remove", "--scope", "user", MCP_SERVER_NAME], { env: cliEnv(), cwd: file("work"), stdio: "ignore" }).on("close", (c) => resolve(c ?? 1)).on("error", () => resolve(1)));
      if (code === 0) return { ok: true, path: join(homedir(), ".claude.json") };
    }
  }
  return disconnectClient(client, clientEnv());
}
