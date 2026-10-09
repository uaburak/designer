/**
 * Agents (docs/research/figma/R12-agents-mcp.md): the Agents tab's chats with AI tools that run on this computer,
 * and the MCP server that gives them — and any MCP client the user connects — the open file. Shared by main
 * (src/main/agents) and the editor (src/renderer/src/editor/agents); the IPC channels are in src/shared/ipc.ts.
 */
import type { ToolContent } from "./tools";
import type { AttachResult, TurnAttachment } from "./attachments";

/** How a provider is driven: a CLI run headless with our MCP server, or an OpenAI-compatible chat API we bridge. */
export type ProviderKind = "claude-code" | "antigravity" | "codex" | "cursor-agent" | "openai-compatible";

export interface ProviderInfo {
  /** "claude-code", "antigravity", "codex", "cursor-agent", "ollama", "lmstudio", or "custom:<n>" */
  id: string;
  kind: ProviderKind;
  label: string;
  /** Found on this computer (the CLI on PATH, the server answering) */
  available: boolean;
  /** Where: the CLI's path or the server's base URL */
  detail?: string;
  /** Models to pick from (a server's /v1/models; a CLI's aliases) — the first is the default */
  models: string[];
  /** Models' names as the agent itself gives them ("Gemini 3.8 Flash (Medium)"), when it does */
  modelLabels?: Record<string, string>;
  /** Reasoning efforts its effort flag takes (Claude Code `--effort`), the default first; none when it has no flag */
  efforts?: string[];
  /** Why it isn't available, in the panel's words */
  problem?: string;
  /** A custom server with a key kept in the OS keychain */
  hasKey?: boolean;
  /** A second line for its card ("Google’s agent with your Google AI plan …") */
  note?: string;
  /** A CLI's sign-in (Connected / Signed out / Not installed); a server: connected while it answers */
  auth?: AuthState;
  /** How to get it: its documented install command (run in Terminal after a confirmation) and its page */
  install?: { command?: string; page: string };
}

export interface CustomServer {
  id: string;
  label: string;
  baseUrl: string;
  hasKey: boolean;
}

/** What main keeps (userData/agents/settings.json; keys apart, encrypted with safeStorage). */
export interface AgentSettings {
  providerId: string | null;
  /** The model picked per provider */
  models: Record<string, string>;
  custom: CustomServer[];
}

export interface ChatTurnMessage {
  role: "user" | "assistant";
  text: string;
}

/** A CLI agent's sign-in, as the provider's status card shows it. */
export interface AuthState {
  state: "not-installed" | "signed-out" | "signing-in" | "connected";
  /** The signed-in account (email) */
  account?: string;
  /** "Claude Team · Org" */
  plan?: string;
  /** Why, or what is happening */
  detail?: string;
  /** While signing in: the sign-in page, when the CLI printed it */
  url?: string;
}

/** What the composer sends: the prompt, the chat so far (for providers without sessions) and the selection it is about. */
export interface TurnRequest {
  chatId: string;
  providerId: string;
  model?: string;
  prompt: string;
  history: ChatTurnMessage[];
  /** The selection attached as context ("Frame “Desktop” 1440 × 900", ids) */
  context: { fileName: string; pageName: string; selection: { id: string; name: string; type: string; width: number; height: number }[] };
  /** The CLI's own session to continue (Claude Code `--resume`) */
  resume?: string;
  /** The reasoning effort (one of the provider's `efforts`) */
  effort?: string;
  /** Files attached to this message, copied into the chat's folder (agents:attach) */
  attachments?: TurnAttachment[];
}

/** One of a plan's limits ("Current session", 5 % used, resets at …). */
export interface UsageWindow {
  label: string;
  /** The models it counts (Antigravity's "Gemini Models" / "Claude and GPT models") */
  group?: string;
  usedPct: number;
  /** When it resets (ms since 1970), or its time as the CLI wrote it */
  resetsAt?: number;
  resetText?: string;
}

/** A plan's limits as the agent's CLI reports them without a model call (`claude -p /usage`, `agy -p /usage`). */
export interface UsageInfo {
  providerId: string;
  windows: UsageWindow[];
  /** When it was read (ms) */
  at: number;
}

/** A turn's tokens. */
export interface TokenUsage {
  input: number;
  output: number;
}

/** A turn's stream, main → the view (`agents:event`). */
export type ChatEvent =
  | { type: "status"; text: string }
  | { type: "session"; resume: string; model?: string }
  | { type: "text"; delta: string }
  | { type: "tool"; id: string; name: string; args?: unknown; state: "running" | "done" | "error"; summary?: string }
  | { type: "error"; message: string }
  /** The turn's tokens (its result) */
  | { type: "usage"; usage: TokenUsage }
  /** The plan's limits as they stand (Claude Code's rate_limit_event) */
  | { type: "limits"; windows: UsageWindow[] }
  | { type: "done"; stopped?: boolean };

export interface TurnEvent {
  turnId: string;
  chatId: string;
  event: ChatEvent;
}

/** A tool call for the view that holds the session's file (`agents:tool-call`); answered with `agents:tool-result`. */
export interface ToolCall {
  reqId: number;
  /** The chat turn it belongs to (one undo step per turn), or null for an outside client's call */
  turnId: string | null;
  /** Who is calling ("Claude Code", "Cursor") — the undo step's and the version's label */
  client: string;
  name: string;
  args: Record<string, unknown>;
}

export interface ToolCallResult {
  reqId: number;
  content: ToolContent[];
  isError?: boolean;
  touched?: string[];
}

/** One MCP connection as the right panel's "MCP" section counts it. */
export interface McpConnection {
  id: string;
  /** The client's name from `initialize` (clientInfo.name), prettified */
  client: string;
  /** A chat of the Agents tab (its own session), or an outside client */
  chat: boolean;
  fileKey: string | null;
}

export interface McpState {
  running: boolean;
  url: string | null;
  connections: McpConnection[];
}

/** An MCP client this computer has, which "Connect" can set up (its config file, written after a confirmation). */
export type McpClientId = "claude-code" | "cursor" | "vscode" | "antigravity" | "codex";

export interface McpClientInfo {
  id: McpClientId;
  label: string;
  /** The app or CLI is on this computer */
  installed: boolean;
  /** The config file "Connect" writes */
  configPath: string;
  /** Our server is in it already */
  connected: boolean;
}

export interface ConnectResult {
  ok: boolean;
  path: string;
  /** The file as it was, copied next to it before the change */
  backup?: string;
  error?: string;
}

/**
 * What the Agents tab and the MCP section talk to: the editor view's preload (`window.designer.agents`, main's
 * src/main/agents) — or, in a browser and in the editor shots, a stand-in with the same calls.
 */
export interface AgentsApi {
  providers(): Promise<ProviderInfo[]>;
  settings(): Promise<AgentSettings>;
  setSettings(patch: Partial<Pick<AgentSettings, "providerId" | "models">>): Promise<AgentSettings>;
  addServer(server: { label: string; baseUrl: string; apiKey?: string }): Promise<AgentSettings>;
  removeServer(id: string): Promise<AgentSettings>;
  test(providerId: string): Promise<{ ok: boolean; models: string[]; error?: string; version?: string }>;
  /** A CLI agent's sign-in (Claude Code: `claude auth status`) */
  auth(providerId: string): Promise<AuthState>;
  /** The CLI's own sign-in in the browser (`claude auth login --claudeai`); poll auth() until connected */
  signIn(providerId: string): Promise<AuthState>;
  signOut(providerId: string): Promise<AuthState>;
  /** Runs the tool's documented install command or opens its download page */
  install(providerId: string): Promise<{ ok: boolean; opened?: "installed" | "page"; error?: string }>;
  turn(request: TurnRequest): Promise<{ turnId: string }>;
  /** Files dropped or pasted into the composer, copied into the chat's folder */
  attach(chatId: string, files: { name: string; bytes: Uint8Array }[]): Promise<AttachResult>;
  /** The "+" button: main's file dialog (PDF and images), the picked files copied into the chat's folder */
  pickAttachments(chatId: string): Promise<AttachResult>;
  /** ⌘V of a file or a picture: the system clipboard's files (Finder) or picture (a screenshot), read by main */
  attachClipboard(chatId: string): Promise<AttachResult>;
  /** The plan's limits, from the agent's own CLI without a model call (null when it reports none) */
  usage(providerId: string, fresh?: boolean): Promise<UsageInfo | null>;
  stop(turnId: string): Promise<void>;
  onEvent(cb: (e: TurnEvent) => void): () => void;
  /** Tool calls for this view's file; the handler's result goes back to main */
  onToolCall(handler: (call: ToolCall) => Promise<Omit<ToolCallResult, "reqId">>): () => void;
  mcp(): Promise<McpState>;
  onMcpState(cb: (s: McpState) => void): () => void;
  clients(): Promise<McpClientInfo[]>;
  connect(client: McpClientId): Promise<ConnectResult>;
  disconnect(client: McpClientId): Promise<ConnectResult>;
  clientConfig(client: McpClientId): Promise<{ path: string; text: string; stdio: string }>;
}
