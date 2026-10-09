import { app, dialog, safeStorage, shell, webContents, type WebContents } from "electron";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import type { ToolResult } from "../../shared/agents/tools";
import { MCP_SERVER_NAME } from "../../shared/agents/tools";
import type { AgentSettings, ChatEvent, McpClientId, McpConnection, McpState, ProviderInfo, ToolCall, ToolCallResult, TurnRequest } from "../../shared/agents/types";
import { cliSpec, type CliSpec } from "./providers";
import { runCliProcess, loginUrl, type AuthEnv, type RunResult } from "./providers/turns";
import { imageGenStatus, NANOBANANA_INSTALL } from "./providers/gemini";
import { ImagePathError, resolveImagePaths } from "./imageArgs";
import { configText, connectClient, disconnectClient, listClients, CLIENTS, type ClientEnv } from "./clients";
import { cliEnv, cliPath, detectProviders, LOCAL_SERVERS, searchPath, which } from "./detect";
import { McpServer, newToken } from "./mcpServer";
import { listModels, runOpenAiTurn, trimBase } from "./openaiBridge";
import { STDIO_BRIDGE_SOURCE } from "./stdioBridge";
import type { AuthState, ImageGenState } from "../../shared/agents/types";
import { allViews } from "../views";
import { controllers } from "../window";

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
}

const dir = () => join(app.getPath("userData"), "agents");
const file = (name: string) => join(dir(), name);

function readStored(): Stored {
  try {
    const s = JSON.parse(readFileSync(file("settings.json"), "utf8")) as Partial<Stored>;
    return { providerId: s.providerId ?? null, models: s.models ?? {}, custom: Array.isArray(s.custom) ? s.custom : [], port: s.port, token: s.token };
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
  return { providerId: s.providerId, models: s.models, custom: s.custom.map((c) => ({ ...c, hasKey: !!keys[c.id] })) };
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
}

let server: McpServer | null = null;
let providerCache: { at: number; list: ProviderInfo[] } | null = null;
const turns = new Map<string, Turn>();
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
    if (info.role !== "editor") continue;
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
    const root = t ? chatDir(t.chatId) : homedir();
    call = { ...call0, args: resolveImagePaths(call0.name, call0.args ?? {}, root) };
  } catch (err) {
    if (err instanceof ImagePathError) return Promise.resolve({ content: [{ type: "text", text: err.message }], isError: true });
    throw err;
  }
  const reqId = ++reqSeq;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(reqId);
      resolve({ content: [{ type: "text", text: "The tool took too long (120 s)." }], isError: true });
    }, 120_000);
    pending.set(reqId, { resolve, sender: wc.id, timer });
    wc.send("agents:tool-call", { reqId, ...call });
  });
}

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
  let token = unseal(stored.token);
  if (!token) {
    token = newToken();
    stored.token = seal(token);
    writeStored(stored);
  }
  server = new McpServer(
    {
      activeFileKey,
      isOpen: (k) => !!viewFor(k),
      runTool: (fileKey, call) => runToolInView(fileKey, call),
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
  await server?.stop();
  server = null;
}

// ── Settings and providers ──

export const agentSettings = (): AgentSettings => publicSettings(readStored());

export function setAgentSettings(patch: Partial<Pick<AgentSettings, "providerId" | "models">>): AgentSettings {
  const s = readStored();
  if (typeof patch.providerId === "string" || patch.providerId === null) s.providerId = patch.providerId;
  if (patch.models && typeof patch.models === "object") for (const [k, v] of Object.entries(patch.models)) if (typeof v === "string" && k.length < 100 && v.length < 300) s.models[k] = v;
  writeStored(s);
  return publicSettings(s);
}

export function addServer(p: { label: string; baseUrl: string; apiKey?: string }): AgentSettings {
  const base = trimBase(String(p.baseUrl ?? ""));
  if (!/^https?:\/\/[^\s]+$/i.test(base)) throw new Error("A base URL like http://localhost:8080/v1");
  const s = readStored();
  const id = `custom:${randomUUID().slice(0, 8)}`;
  s.custom.push({ id, label: String(p.label || new URL(base).host).slice(0, 80), baseUrl: base });
  writeStored(s);
  if (p.apiKey) {
    if (!canEncrypt()) throw new Error("This Mac's keychain isn't available: the key wasn't kept");
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
  const list = await detectProviders(s.custom.map((c) => ({ ...c, hasKey: false })), keyOf, { authOf: (spec, path) => cliAuthStatus(spec, path), imageGen: (signedIn, installed) => imageGen(signedIn, installed) });
  providerCache = { at: Date.now(), list };
  return list;
}

const serverOf = (id: string) => [...LOCAL_SERVERS, ...readStored().custom].find((s) => s.id === id);

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
    return { ok: true, models: spec.models, version };
  }
  const srv = serverOf(id);
  if (!srv) return { ok: false, models: [], error: "Unknown provider" };
  try {
    const models = await listModels(srv.baseUrl, { apiKey: keyOf(id), timeoutMs: 3000 });
    providerCache = null;
    return models.length ? { ok: true, models } : { ok: false, models, error: "The server answers but has no models loaded" };
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
  if (t.grant) {
    server?.updateChat(t.grant, { turnId: null });
    server?.endChatSessions(t.grant);
  }
}

/** A chat's MCP token, bound to its file (made on its first turn). */
function grantFor(fileKey: string, chatId: string, client: string, turnId: string): string {
  const key = `${fileKey}/${chatId}`;
  let token = chatTokens.get(key);
  if (!token) {
    token = server!.grantChat({ fileKey, turnId, client });
    chatTokens.set(key, token);
  } else server!.updateChat(token, { turnId, client });
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
  if (!server?.url) throw new Error("The agents' server isn't running");
  const turnId = randomUUID();
  const t: Turn = { id: turnId, chatId: String(req.chatId).slice(0, 80), fileKey, sender, stopped: false };
  turns.set(turnId, t);
  const s = readStored();
  const providerId = String(req.providerId);
  const spec = cliSpec(providerId);
  const model = req.model ?? s.models[providerId];
  queueMicrotask(() => {
    if (spec) runCli(t, spec, { ...req, model });
    else {
      const srv = serverOf(providerId);
      if (!srv) return finishTurn(t, { type: "error", message: "Pick an agent first (the model menu under the message box)." });
      runServer(t, srv, { ...req, model });
    }
  });
  return { turnId };
}

function runCli(t: Turn, spec: CliSpec, req: TurnRequest) {
  const path = cliPath(spec);
  if (!path) return finishTurn(t, { type: "error", message: `${spec.label} isn't installed on this computer.` });
  const token = grantFor(t.fileKey, t.chatId, spec.label, t.id);
  t.grant = token;
  // Each chat gets its own empty folder (its CLI session's project), the turn's MCP config in it.
  const cwd = chatDir(t.chatId);
  mkdirSync(cwd, { recursive: true });
  const plan = spec.plan({ request: req, mcp: { url: server!.url!, token }, cwd, sessionId: randomUUID(), mcpConfigPath: join(cwd, "mcp.json") });
  for (const [name, text] of Object.entries(plan.files ?? {})) writePrivate(isAbsolute(name) ? name : join(cwd, name), text);
  emit(t, { type: "status", text: `Starting ${spec.label}…` });
  const child = runCliProcess({
    spec,
    path,
    plan,
    cwd,
    env: cliEnv({ ...plan.env, ...imageKeyEnv(spec) }),
    spawn: (cmd, args, options) => spawn(cmd, args, options),
    emit: (e) => emit(t, e),
    done: (error) => finishTurn(t, error ? { type: "error", message: error } : undefined),
    stopped: () => t.stopped,
    // A developer's recording of the raw output (the adapters' test fixtures): DESIGNER_AGENTS_RECORD=<folder>.
    raw: process.env.DESIGNER_AGENTS_RECORD ? (chunk) => appendFileSync(join(process.env.DESIGNER_AGENTS_RECORD!, `${spec.id}-${t.id}.ndjson`), chunk) : undefined,
  });
  if (child) t.child = child;
}

function runServer(t: Turn, srv: { id: string; label: string; baseUrl: string }, req: TurnRequest) {
  const abort = new AbortController();
  t.abort = abort;
  const model = req.model;
  if (!model) return finishTurn(t, { type: "error", message: `Pick a model of ${srv.label} first.` });
  emit(t, { type: "status", text: `Asking ${model} on ${srv.label}…` });
  runOpenAiTurn({
    baseUrl: srv.baseUrl,
    apiKey: keyOf(srv.id),
    model,
    request: req,
    signal: abort.signal,
    emit: (e) => emit(t, e),
    runTool: (name, args) => runToolInView(t.fileKey, { turnId: t.id, client: srv.label, name, args }),
  })
    .then(() => finishTurn(t))
    .catch((err) => finishTurn(t, t.stopped ? undefined : { type: "error", message: `${srv.label}: ${err instanceof Error ? err.message : String(err)}` }));
}

export function stopTurn(turnId: string) {
  const t = turns.get(turnId);
  if (!t) return;
  t.stopped = true;
  t.abort?.abort();
  if (t.child && t.child.exitCode === null) {
    t.child.kill("SIGINT");
    setTimeout(() => t.child?.exitCode === null && t.child.kill("SIGKILL"), 3000);
  } else if (!t.child) finishTurn(t);
}

/** A view went away: its turns stop, its pending calls fail. */
export function viewGone(sender: WebContents) {
  for (const t of turns.values()) if (t.sender === sender) stopTurn(t.id);
  for (const [id, p] of pending)
    if (p.sender === sender.id) {
      clearTimeout(p.timer);
      pending.delete(id);
      p.resolve({ content: [{ type: "text", text: "The file was closed." }], isError: true });
    }
}

// ── Sign-in, install, image generation (each CLI's own commands; the browser or Terminal does the sign-in) ──

/** A CLI command's result, killed after `ms`. */
function runBin(path: string, args: string[], ms = 15_000): Promise<RunResult> {
  return new Promise((resolve) => {
    mkdirSync(file("work"), { recursive: true });
    const child = spawn(path, args, { env: cliEnv(), cwd: file("work"), stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
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
  const s: AuthState = a.status ? a.status.parse(await runBin(path, a.status.args, 10_000)) : a.fromFiles ? a.fromFiles(authEnv()) : { state: "connected" };
  const l = logins.get(spec.id);
  if (s.state === "connected") {
    if (l) {
      l.child?.kill();
      logins.delete(spec.id);
    }
    return s;
  }
  const waiting = l && (l.child ? l.child.exitCode === null : Date.now() - l.at < 10 * 60_000);
  if (l && waiting) return { state: "signing-in", detail: l.note ?? "Waiting for sign-in in your browser…", url: loginUrl(l.out) ?? undefined };
  return s;
}

export async function authStatus(providerId: string): Promise<AuthState> {
  const spec = cliSpec(providerId);
  if (!spec) return { state: "not-installed", detail: "Not a CLI agent" };
  const path = cliPath(spec);
  if (!path) return { state: "not-installed", detail: `Looked for “${spec.bins[0]}” on PATH and in ~/.local/bin, /opt/homebrew/bin, /usr/local/bin` };
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
      const child = spawn(path, login.args, { env: cliEnv(), cwd: file("work"), stdio: ["pipe", "pipe", "pipe"] });
      const entry = { child, out: "", at: Date.now() };
      child.stdout?.on("data", (d) => (entry.out = (entry.out + d).slice(-8000)));
      child.stderr?.on("data", (d) => (entry.out = (entry.out + d).slice(-8000)));
      child.on("error", () => {});
      setTimeout(() => child.exitCode === null && child.kill(), 10 * 60_000);
      logins.set(spec.id, entry);
    }
    return { state: "signing-in", detail: "Waiting for sign-in in your browser…" };
  }
  const err = await openInTerminal(`${spec.id}-sign-in`, [`echo ${shq(login.note)}`, "echo", [shq(path), ...login.args.map(shq)].join(" ")]);
  if (err) return { state: "signed-out", detail: `Couldn't open Terminal: ${err}` };
  logins.set(spec.id, { out: "", at: Date.now(), note: login.note });
  return { state: "signing-in", detail: login.note };
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
  return { ...s, detail: err ? `Couldn't open Terminal: ${err}` : out.note };
}

/** Install: the documented command in Terminal (it waits for Return), or the download page. */
export async function install(providerId: string, target?: "nanobanana"): Promise<{ ok: boolean; opened?: "terminal" | "page"; error?: string }> {
  const spec = cliSpec(providerId);
  const srv = LOCAL_SERVERS.find((x) => x.id === providerId);
  const what: { label: string; command?: string; page: string } | null =
    target === "nanobanana" ? { label: "the Nano Banana extension for Gemini CLI", command: NANOBANANA_INSTALL, page: "https://github.com/gemini-cli-extensions/nanobanana" } : spec ? { label: spec.label, ...spec.install } : srv ? { label: srv.label, ...srv.install } : null;
  if (!what) return { ok: false, error: "Unknown agent" };
  if (!what.command) {
    await shell.openExternal(what.page);
    return { ok: true, opened: "page" };
  }
  const err = await openInTerminal(`install-${target ?? providerId}`, [
    `echo ${shq(`This installs ${what.label} with its official command (${what.page}):`)}`,
    "echo",
    `echo ${shq(`  ${what.command}`)}`,
    "echo",
    `read ${shq("?Press Return to install, or close this window to cancel. ")}`,
    what.command,
    "echo",
    `echo ${shq("Done. Back in DesignerV2, click “Look again” in Agent settings.")}`,
  ]);
  providerCache = null;
  return err ? { ok: false, error: `Couldn't open Terminal: ${err}` } : { ok: true, opened: "terminal" };
}

/** The keys.json entry of the owner's own Gemini API key for Nano Banana. */
const IMAGE_KEY = "gemini:nanobanana";

/** A Gemini run gets the owner's Nano Banana key (if they added one) in its environment — never in its arguments. */
function imageKeyEnv(spec: CliSpec): Record<string, string> {
  const key = spec.id === "gemini" ? keyOf(IMAGE_KEY) : undefined;
  return key ? { NANOBANANA_API_KEY: key } : {};
}

function imageGen(signedIn: boolean, installed: boolean): ImageGenState {
  return imageGenStatus(authEnv(), { signedIn, installed, hasKey: !!keyOf(IMAGE_KEY) });
}

export async function setImageKey(key: string | null): Promise<ImageGenState> {
  const keys = readKeys();
  if (key && key.trim()) {
    if (!canEncrypt()) throw new Error("This Mac's keychain isn't available: the key wasn't kept");
    keys[IMAGE_KEY] = seal(key.trim());
  } else delete keys[IMAGE_KEY];
  writePrivate(file("keys.json"), JSON.stringify(keys));
  providerCache = null;
  const spec = cliSpec("gemini")!;
  const path = cliPath(spec);
  const auth = path ? await cliAuthStatus(spec, path) : null;
  return imageGen(auth?.state === "connected", !!path);
}

// ── MCP state and clients ──

export const mcp = (): McpState => mcpState();

export const clients = () => listClients(clientEnv(), server?.url ?? null);

function stdioSnippet(): string {
  return JSON.stringify({ [MCP_SERVER_NAME]: { command: process.execPath, args: [file("designer-mcp.cjs")], env: { ELECTRON_RUN_AS_NODE: "1" } } }, null, 2);
}

export function clientConfig(client: McpClientId) {
  if (!server?.url) throw new Error("The MCP server isn't running");
  const { path, text } = configText(client, { url: server.url, token: server.token }, clientEnv());
  return { path, text, stdio: stdioSnippet() };
}

export async function connect(sender: WebContents, client: McpClientId) {
  if (!server?.url) throw new Error("The MCP server isn't running");
  const spec = CLIENTS.find((c) => c.id === client);
  if (!spec) throw new Error("Unknown client");
  const { path } = configText(client, { url: server.url, token: server.token }, clientEnv());
  const win = [...controllers.values()].find((c) => c.tabs.contentViews().some((v) => v.webContents === sender))?.win;
  const options = {
    type: "question" as const,
    buttons: ["Connect", "Cancel"],
    defaultId: 0,
    cancelId: 1,
    message: `Connect ${spec.label} to this app's MCP server?`,
    detail: `This adds a “${MCP_SERVER_NAME}” server (${server.url}, with its access token) to ${path.replace(homedir(), "~")}. Nothing else in the file changes, and a copy of it is kept next to it. ${spec.label} can then read and edit the file you have open here.`,
  };
  const answer = win ? await dialog.showMessageBox(win as unknown as Electron.BrowserWindow, options) : await dialog.showMessageBox(options);
  if (answer.response !== 0) return { ok: false, path };
  // Claude Code keeps ~/.claude.json open itself: its own command adds the server when it is there.
  if (client === "claude-code") {
    const bin = which("claude");
    if (bin) {
      const run = (args: string[]) => new Promise<number>((resolve) => spawn(bin, args, { env: cliEnv(), cwd: file("work"), stdio: "ignore" }).on("close", (c) => resolve(c ?? 1)).on("error", () => resolve(1)));
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
      const code = await new Promise<number>((resolve) => spawn(bin, ["mcp", "remove", "--scope", "user", MCP_SERVER_NAME], { env: cliEnv(), cwd: file("work"), stdio: "ignore" }).on("close", (c) => resolve(c ?? 1)).on("error", () => resolve(1)));
      if (code === 0) return { ok: true, path: join(homedir(), ".claude.json") };
    }
  }
  return disconnectClient(client, clientEnv());
}
