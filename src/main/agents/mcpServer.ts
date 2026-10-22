import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { MCP_INSTRUCTIONS } from "../../shared/agents/prompts";
import { MANAGER_TOOL_NAMES, MCP_SERVER_NAME, TOOL_BY_NAME, TOOLS, type ToolResult } from "../../shared/agents/tools";
import type { McpConnection } from "../../shared/agents/types";
import { drainGovernanceReports, reportMcpCall } from "../account/governanceReports";

/**
 * The app's MCP server (docs/research/figma/R12-agents-mcp.md; MCP 2025-06-18 "Streamable HTTP"): JSON-RPC over
 * POST /mcp on 127.0.0.1 only, answered as application/json (no server-initiated stream: GET is 405). Figma's
 * desktop server is the model (http://127.0.0.1:3845/mcp, the open file and its selection); ours also asks for a
 * bearer token, since anything on this computer can reach a loopback port.
 *
 * Tokens: one for outside clients (kept by main, written into the clients' configs by "Connect"), and one per chat
 * of the Agents tab — bound to the file the chat started from and its current turn. A session (Mcp-Session-Id) is
 * bound to one file: a chat's from its token, an outside client's to the file in front at its first tool call; a
 * call for a file that isn't open any more fails, and writes never go to another file.
 *
 * Electron-free (the host injects how a tool runs and which file is in front), so the protocol is unit-tested in Node.
 */

export const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];

export interface ChatGrant {
  fileKey: string;
  /** The turn whose writes are one undo step; updated by the host as turns start */
  turnId: string | null;
  /** The chat's provider ("Claude Code"): what the session shows as its client */
  client: string;
  /** The connectors this chat's turn may use (docs/ai.md §2.11): their tools are listed and proxied */
  connectors?: string[];
  /** Studio (docs/studio.md §2.2): a manager's turn (its tools listed) or a worker's (a task's own grant) */
  role?: "manager" | "worker";
  /** A manager's turn: its manager-only tools, listed for it alone and answered by the view */
  managerTools?: ExtraTool[];
}

/** A tool besides ours (a connector's, proxied — docs/ai.md §2.11; a manager's own — docs/studio.md §2.2). */
export interface ExtraTool {
  name: string;
  title?: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface McpSession {
  id: string;
  client: string;
  chat: ChatGrant | null;
  fileKey: string | null;
  lastSeen: number;
}

export interface McpHost {
  /** The file in front (an outside client's session binds to it at its first call), or null */
  activeFileKey(): string | null;
  /** Whether a file is open in an editor view */
  isOpen(fileKey: string): boolean;
  /** Runs a tool in the view that holds `fileKey` */
  runTool(fileKey: string, call: { turnId: string | null; client: string; session?: string; name: string; args: Record<string, unknown> }): Promise<ToolResult>;
  /**
   * Home's file tools (list_files, create_file, file_action) with no file to run on: an outside client at Home. Returns
   * the file it opened (create_file {open}, file_action open), which the session then works on.
   */
  runHomeTool?(name: string, args: Record<string, unknown>): Promise<{ result: ToolResult; opened?: string }>;
  /** Tools besides ours for a session (a chat's connectors'); their calls go to `runTool` too */
  extraTools?(session: McpSession): Promise<ExtraTool[]>;
  /** The connections changed (the right panel's count) */
  onConnections?(connections: McpConnection[]): void;
  version?: string;
}

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

type JsonRpcResponse = { jsonrpc: "2.0"; id: string | number | null; result?: unknown; error?: { code: number; message: string } };

const rpcError = (id: JsonRpcRequest["id"], code: number, message: string): JsonRpcResponse => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

/** Client names as people know them (clientInfo.name is a package name). */
export function prettyClient(name: unknown): string {
  const n = typeof name === "string" ? name.trim().slice(0, 80) : "";
  const known: [RegExp, string][] = [
    [/claude[-\s]?code|^claude$/i, "Claude Code"],
    [/claude/i, "Claude"],
    [/cursor/i, "Cursor"],
    [/antigravity/i, "Antigravity"],
    [/visual studio code|vscode|^code$/i, "VS Code"],
    [/gemini/i, "Gemini CLI"],
    [/codex/i, "Codex"],
    [/windsurf/i, "Windsurf"],
    [/designer/i, "Agents"],
  ];
  for (const [re, label] of known) if (re.test(n)) return label;
  return n || "MCP client";
}

const sameSecret = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

export const newToken = () => randomBytes(24).toString("base64url");

/** Sessions not heard from in this long stop counting as connections. */
export const SESSION_IDLE_MS = 15 * 60 * 1000;

export class McpServer {
  private server: Server | null = null;
  private port = 0;
  private sessions = new Map<string, McpSession>();
  private chats = new Map<string, ChatGrant>();
  private sweep: ReturnType<typeof setInterval> | null = null;
  private lastAnnounced = "";

  constructor(
    private host: McpHost,
    /** The outside clients' token */
    private externalToken: string
  ) {}

  get url(): string | null {
    return this.server ? `http://127.0.0.1:${this.port}/mcp` : null;
  }

  get token(): string {
    return this.externalToken;
  }

  /** Listens on 127.0.0.1 — on `preferredPort` when it is free (so configs written before still work), else any. */
  async start(preferredPort = 0): Promise<number> {
    if (this.server) return this.port;
    const listen = (port: number) =>
      new Promise<Server>((resolve, reject) => {
        const s = createServer((req, res) => void this.handle(req, res));
        s.once("error", reject);
        s.listen(port, "127.0.0.1", () => resolve(s));
      });
    try {
      this.server = await listen(preferredPort);
    } catch {
      this.server = await listen(0);
    }
    this.port = (this.server.address() as AddressInfo).port;
    this.sweep = setInterval(() => this.announce(), 60_000);
    this.sweep.unref?.();
    return this.port;
  }

  async stop(): Promise<void> {
    if (this.sweep) clearInterval(this.sweep);
    this.sweep = null;
    const s = this.server;
    this.server = null;
    this.sessions.clear();
    void drainGovernanceReports();
    if (s) await new Promise<void>((resolve) => s.close(() => resolve()));
  }

  /** A chat's token (its sessions act on `grant.fileKey` only). */
  grantChat(grant: ChatGrant): string {
    const token = newToken();
    this.chats.set(token, grant);
    return token;
  }

  /** The chat's turn changed (its writes become another undo step). */
  updateChat(token: string, patch: Partial<ChatGrant>): void {
    const g = this.chats.get(token);
    if (g) Object.assign(g, patch);
  }

  /** A chat's turn ended: its CLI's sessions are over (the token stays for the next turn). */
  endChatSessions(token: string): void {
    const grant = this.chats.get(token);
    if (!grant) return;
    for (const [id, s] of this.sessions) if (s.chat === grant) this.sessions.delete(id);
    this.announce();
  }

  revokeChat(token: string): void {
    const grant = this.chats.get(token);
    this.chats.delete(token);
    for (const [id, s] of this.sessions) if (grant && s.chat === grant) this.sessions.delete(id);
    this.announce();
  }

  connections(now = Date.now()): McpConnection[] {
    return [...this.sessions.values()].filter((s) => now - s.lastSeen < SESSION_IDLE_MS).map((s) => ({ id: s.id, client: s.client, chat: !!s.chat, fileKey: s.fileKey }));
  }

  private announce() {
    const list = this.connections();
    const key = JSON.stringify(list);
    if (key === this.lastAnnounced) return;
    this.lastAnnounced = key;
    this.host.onConnections?.(list);
  }

  /** The bearer token's grant: "external", a chat's grant, or null (refused). */
  private authorize(req: IncomingMessage): "external" | ChatGrant | null {
    const auth = req.headers.authorization ?? "";
    const m = /^Bearer\s+(\S+)$/i.exec(Array.isArray(auth) ? auth[0] : auth);
    if (!m) return null;
    const token = m[1];
    if (sameSecret(token, this.externalToken)) return "external";
    for (const [t, grant] of this.chats) if (sameSecret(token, t)) return grant;
    return null;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const send = (status: number, body?: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, { ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...headers });
      res.end(body === undefined ? undefined : JSON.stringify(body));
    };
    // DNS rebinding: only our own host names, and no web page (a browser always sends Origin on a cross-site POST).
    const hostHeader = String(req.headers.host ?? "");
    if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/i.test(hostHeader)) return send(403, rpcError(null, -32000, "Forbidden host"));
    if (req.headers.origin && req.headers.origin !== "null") return send(403, rpcError(null, -32000, "Forbidden origin"));
    const path = (req.url ?? "").split("?")[0];
    if (path !== "/mcp") return send(404, rpcError(null, -32000, "Not found"));
    const grant = this.authorize(req);
    if (!grant) return send(401, rpcError(null, -32001, "Unauthorized: this server needs its token (Agents › Set up agents)"), { "WWW-Authenticate": "Bearer" });
    const sessionHeader = req.headers["mcp-session-id"];
    const sessionId = typeof sessionHeader === "string" ? sessionHeader : null;
    if (req.method === "DELETE") {
      if (sessionId) this.sessions.delete(sessionId);
      this.announce();
      return send(200);
    }
    if (req.method === "GET") return send(405, undefined, { Allow: "POST, DELETE" });
    if (req.method !== "POST") return send(405, undefined, { Allow: "POST, DELETE" });

    let body: unknown;
    try {
      body = JSON.parse(await readBody(req, 4 * 1024 * 1024));
    } catch {
      return send(400, rpcError(null, -32700, "Parse error"));
    }
    const batch = Array.isArray(body);
    const messages = (batch ? body : [body]) as JsonRpcRequest[];
    const isInit = messages.some((m) => m?.method === "initialize");
    let session = sessionId ? this.sessions.get(sessionId) : undefined;
    if (session && (grant === "external" ? !!session.chat : session.chat !== grant)) return send(403, rpcError(null, -32000, "Session belongs to another token"));
    if (!session && !isInit) {
      if (sessionId) return send(404, rpcError(null, -32000, "Session not found"));
      // A client that skips the session header (allowed by the spec): a session of its own, made now.
    }
    const headers: Record<string, string> = {};
    if (!session) {
      session = { id: randomUUID(), client: grant === "external" ? "MCP client" : grant.client, chat: grant === "external" ? null : grant, fileKey: grant === "external" ? null : grant.fileKey, lastSeen: Date.now() };
      this.sessions.set(session.id, session);
    }
    session.lastSeen = Date.now();
    headers["Mcp-Session-Id"] = session.id;
    const replies: JsonRpcResponse[] = [];
    for (const m of messages) {
      const reply = await this.dispatch(session, m);
      if (reply) replies.push(reply);
    }
    this.announce();
    if (!replies.length) return send(202, undefined, headers);
    return send(200, batch ? replies : replies[0], headers);
  }

  /** One JSON-RPC message; null for a notification. */
  async dispatch(session: McpSession, m: JsonRpcRequest): Promise<JsonRpcResponse | null> {
    if (!m || m.jsonrpc !== "2.0" || typeof m.method !== "string") return rpcError(m?.id ?? null, -32600, "Invalid request");
    const notification = m.id === undefined;
    const ok = (result: unknown): JsonRpcResponse | null => (notification ? null : { jsonrpc: "2.0", id: m.id ?? null, result });
    switch (m.method) {
      case "initialize": {
        const params = m.params ?? {};
        const asked = typeof params.protocolVersion === "string" ? params.protocolVersion : PROTOCOL_VERSIONS[0];
        if (!session.chat) session.client = prettyClient((params.clientInfo as { name?: unknown } | undefined)?.name);
        return ok({
          protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: MCP_SERVER_NAME, title: "Wecra", version: this.host.version ?? "0" },
          instructions: MCP_INSTRUCTIONS,
        });
      }
      case "ping":
        return ok({});
      case "tools/list": {
        const extra = await this.extraTools(session);
        return ok({
          tools: [
            ...TOOLS.map((t) => ({ name: t.name, title: t.title, description: t.description, inputSchema: t.inputSchema, annotations: { title: t.title, readOnlyHint: !t.write, destructiveHint: t.name === "delete_nodes" } })),
            ...managerTools(session).map((t) => ({ name: t.name, ...(t.title ? { title: t.title } : {}), description: t.description, inputSchema: t.inputSchema })),
            ...extra.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
          ],
        });
      }
      case "tools/call": {
        const name = String(m.params?.name ?? "");
        const args = (m.params?.arguments ?? {}) as Record<string, unknown>;
        // The manager's tools are the manager's alone (docs/studio.md §2.2): a worker, a plain chat or an outside client is refused.
        const own = managerTools(session).some((t) => t.name === name);
        if (!own && MANAGER_TOOL_NAMES.has(name)) return ok({ content: [{ type: "text", text: `${name} is the manager's tool: a task can't call it. Do the work you were given with the design tools.` }], isError: true });
        if (!own && !TOOL_BY_NAME.has(name) && !(await this.extraTools(session)).some((t) => t.name === name)) return rpcError(m.id, -32602, `Unknown tool: ${name}`);
        if (typeof args !== "object" || Array.isArray(args)) return rpcError(m.id, -32602, "arguments must be an object");
        const result = await this.call(session, name, args);
        const { touched: _touched, ...wire } = result;
        return ok(wire);
      }
      case "resources/list":
        return ok({ resources: [] });
      case "prompts/list":
        return ok({ prompts: [] });
      default:
        return notification ? null : rpcError(m.id, -32601, `Method not found: ${m.method}`);
    }
  }

  /** A chat session's connectors' and reach tools (none for outside clients); a failing host lists none. */
  private async extraTools(session: McpSession): Promise<ExtraTool[]> {
    if (!session.chat || !this.host.extraTools) return [];
    return this.host.extraTools(session).catch(() => []);
  }

  /** The session moves to `fileKey` once its editor is up (a new tab takes a moment to load), at most ~15 s. */
  private async bindWhenOpen(session: McpSession, fileKey: string): Promise<void> {
    for (let i = 0; i < 60 && !this.host.isOpen(fileKey); i++) await new Promise((r) => setTimeout(r, 250));
    session.fileKey = fileKey;
  }

  /** A tool on the session's file (bound now if it is an outside client's first call). */
  async call(session: McpSession, name: string, args: Record<string, unknown>): Promise<ToolResult> {
    if (!session.fileKey) session.fileKey = this.host.activeFileKey();
    const fileKey = session.fileKey;
    const error = (text: string): ToolResult => ({ content: [{ type: "text", text }], isError: true });
    const homeTool = name === "list_files" || name === "create_file" || name === "file_action";
    if (!fileKey) {
      if (!homeTool || !this.host.runHomeTool) return error("No design file is open in Wecra. Open a file (list_files, then file_action open) or create one (create_file with open: true) and try again.");
      try {
        const r = await this.host.runHomeTool(name, args);
        if (r.opened) await this.bindWhenOpen(session, r.opened);
        return r.result;
      } catch (err) {
        return error(err instanceof Error ? err.message : String(err));
      }
    }
    if (!this.host.isOpen(fileKey)) return error("The file this session works on is closed. Open it again (or start a new session) and try again.");
    // Client-reported to the org's developer logs (docs/governance.md §2.12): batched, fire-and-forget, a no-op for local files.
    try {
      reportMcpCall(fileKey, name);
    } catch {
      /* never fails a call */
    }
    try {
      const result = await this.host.runTool(fileKey, { turnId: session.chat?.turnId ?? null, client: session.client, session: session.id, name, args });
      // An outside client that opens another file works on it from then on (a chat's agent stays on its own file)
      if (!session.chat && !result.isError && homeTool) {
        const opened = name === "file_action" && args.action === "open" ? String(args.fileKey ?? "") : name === "create_file" && args.open === true ? openedKeyOf(result) : "";
        if (opened && opened !== fileKey) await this.bindWhenOpen(session, opened);
      }
      return result;
    } catch (err) {
      return error(err instanceof Error ? err.message : String(err));
    }
  }
}

/** create_file's answer names the file it made: `{"created": {"fileKey": …}}`. */
function openedKeyOf(result: ToolResult): string {
  try {
    const text = (result.content as { type: string; text?: string }[]).find((c) => c.type === "text")?.text ?? "";
    return String((JSON.parse(text) as { created?: { fileKey?: string } }).created?.fileKey ?? "");
  } catch {
    return "";
  }
}

/** A session's manager-only tools: a manager's turn's, none for anyone else. */
const managerTools = (session: McpSession): ExtraTool[] => (session.chat?.role === "manager" ? (session.chat.managerTools ?? []) : []);

function readBody(req: IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new Error("too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}
