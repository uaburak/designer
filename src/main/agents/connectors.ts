import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { Connector, ConnectorConsent, ConnectorToolPolicy } from "../../shared/ai/types";
import { CONNECTOR_TOOL_SEP, type ToolResult } from "../../shared/agents/tools";
import type { SpawnFn } from "./providers/turns";
import { t as tr } from "../../shared/i18n";

/**
 * Connectors (docs/ai.md §2.11): MCP servers the owner adds — Streamable HTTP with an optional bearer key, or a stdio
 * command — kept in userData/agents/connectors.json (keys sealed apart). Agents never reach them directly: our MCP
 * server lists a chat's enabled connectors' tools as `‹connector›__‹tool›` and proxies each call here, so the policy
 * works the same for every CLI and local model. Each tool has a policy: Allow (runs), Ask (the chat's consent card:
 * Allow once / Always allow / Deny — Always allow makes it Allow) or Off (not listed, refused). New tools start at Ask.
 *
 * The MCP client is hand-written (as mcpServer.ts): initialize → notifications/initialized → tools/list, tools/call;
 * JSON or an SSE answer over HTTP, newline-delimited JSON-RPC over stdio. No OAuth this round. Electron-free: storage,
 * secrets, spawn, fetch and the consent prompt are injected (host.ts wires the app's; the tests use a local server).
 */

export const MCP_CLIENT_PROTOCOL = "2025-06-18";

export interface StoredConnector {
  id: string;
  name: string;
  transport: { kind: "http"; url: string } | { kind: "stdio"; command: string; args: string[] };
  enabled: boolean;
  /** The tools as last listed */
  tools: { name: string; description?: string; inputSchema?: Record<string, unknown> }[];
  policies: Record<string, ConnectorToolPolicy>;
}

export interface ConnectorStorage {
  read(): StoredConnector[];
  write(list: StoredConnector[]): void;
  key(id: string): string | null;
  setKey(id: string, key: string | null): void;
}

export interface ConsentAnswer {
  allow: boolean;
  remember?: boolean;
  /** A Local apps card: the window the owner picked (docs/agents-reach.md §9) */
  windowId?: string;
}

/** A tool as agents see it through our server. */
export interface ProxiedTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  connectorId: string;
  tool: string;
}

// ── The MCP client ──

interface Rpc {
  jsonrpc: "2.0";
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string };
}

export interface McpClient {
  request(method: string, params?: unknown, timeoutMs?: number): Promise<unknown>;
  notify(method: string, params?: unknown): Promise<void>;
  close(): void;
}

/** Streamable HTTP (MCP 2025-06-18): POST each message; a JSON or SSE answer; the session id kept. */
export class HttpMcpClient implements McpClient {
  private seq = 0;
  private session: string | null = null;
  private protocol: string | null = null;

  constructor(
    private url: string,
    private key: string | null,
    private doFetch: typeof fetch = fetch
  ) {}

  private headers(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(this.key ? { Authorization: `Bearer ${this.key}` } : {}),
      ...(this.session ? { "Mcp-Session-Id": this.session } : {}),
      ...(this.protocol ? { "MCP-Protocol-Version": this.protocol } : {}),
    };
  }

  async request(method: string, params?: unknown, timeoutMs = 30_000): Promise<unknown> {
    const id = ++this.seq;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await this.doFetch(this.url, { method: "POST", headers: this.headers(), body: JSON.stringify({ jsonrpc: "2.0", id, method, params }), signal: ctl.signal });
      const sid = res.headers.get("mcp-session-id");
      if (sid) this.session = sid;
      if (!res.ok) throw new Error(res.status === 401 || res.status === 403 ? tr("{status}: the server wants a key (or this one isn’t valid)", { status: res.status }) : `${res.status} ${res.statusText}`);
      const type = res.headers.get("content-type") ?? "";
      const text = await res.text();
      const reply = type.includes("text/event-stream") ? sseReply(text, id) : (JSON.parse(text) as Rpc | Rpc[]);
      const msg = Array.isArray(reply) ? reply.find((r) => r.id === id) : reply;
      if (!msg) throw new Error(tr("The server didn’t answer."));
      if (msg.error) throw new Error(msg.error.message || `Error ${msg.error.code}`);
      if (method === "initialize") this.protocol = String((msg.result as { protocolVersion?: string } | undefined)?.protocolVersion ?? MCP_CLIENT_PROTOCOL);
      return msg.result;
    } catch (err) {
      if (ctl.signal.aborted) throw new Error(tr("No answer in {s} s.", { s: Math.round(timeoutMs / 1000) }));
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  async notify(method: string, params?: unknown): Promise<void> {
    await this.doFetch(this.url, { method: "POST", headers: this.headers(), body: JSON.stringify({ jsonrpc: "2.0", method, params }) }).catch(() => undefined);
  }

  close(): void {
    if (this.session) void this.doFetch(this.url, { method: "DELETE", headers: this.headers() }).catch(() => undefined);
    this.session = null;
  }
}

/** The JSON-RPC answer with `id` in an SSE body (`data:` lines, events split by blank lines). */
export function sseReply(body: string, id: number): Rpc | null {
  for (const event of body.split(/\r?\n\r?\n/)) {
    const data = event
      .split(/\r?\n/)
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trimStart())
      .join("\n");
    if (!data) continue;
    try {
      const m = JSON.parse(data) as Rpc | Rpc[];
      const found = Array.isArray(m) ? m.find((x) => x.id === id) : m.id === id ? m : null;
      if (found) return found;
    } catch {
      /* not JSON */
    }
  }
  return null;
}

/** stdio: the command started once, newline-delimited JSON-RPC on its stdin / stdout. */
export class StdioMcpClient implements McpClient {
  private seq = 0;
  private child: ChildProcess | null = null;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private buf = "";
  private stderr = "";

  constructor(
    private command: string,
    private args: string[],
    private spawn: SpawnFn,
    private env: NodeJS.ProcessEnv,
    private cwd: string
  ) {}

  private start(): ChildProcess {
    if (this.child && this.child.exitCode === null) return this.child;
    const child = this.spawn(this.command, this.args, { cwd: this.cwd, env: this.env, stdio: ["pipe", "pipe", "pipe"] });
    this.child = child;
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      this.buf += chunk;
      const lines = this.buf.split("\n");
      this.buf = lines.pop() ?? "";
      for (const l of lines) {
        let m: Rpc;
        try {
          m = JSON.parse(l) as Rpc;
        } catch {
          continue;
        }
        const p = typeof m.id === "number" ? this.pending.get(m.id) : undefined;
        if (!p || m.method) continue;
        this.pending.delete(m.id!);
        if (m.error) p.reject(new Error(m.error.message || `Error ${m.error.code}`));
        else p.resolve(m.result);
      }
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (d: string) => (this.stderr = (this.stderr + d).slice(-2000)));
    const fail = (why: string) => {
      for (const p of this.pending.values()) p.reject(new Error(why));
      this.pending.clear();
    };
    child.on("error", (e) => fail(`${this.command}: ${e.message}`));
    child.on("close", (code) => fail(`${this.command} exited (${code})${this.stderr.trim() ? `: ${this.stderr.trim().split("\n").pop()}` : ""}`));
    child.stdin?.on("error", () => undefined);
    return child;
  }

  request(method: string, params?: unknown, timeoutMs = 30_000): Promise<unknown> {
    const child = this.start();
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(tr("No answer in {s} s.", { s: Math.round(timeoutMs / 1000) })));
      }, timeoutMs);
      this.pending.set(id, { resolve: (v) => (clearTimeout(timer), resolve(v)), reject: (e) => (clearTimeout(timer), reject(e)) });
      child.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  async notify(method: string, params?: unknown): Promise<void> {
    this.start().stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  close(): void {
    if (this.child && this.child.exitCode === null) this.child.kill();
    this.child = null;
  }
}

// ── The hub ──

/** A connector's name as a tool prefix: lowercase letters, digits and hyphens. */
export const connectorSlug = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24) || "connector";

const errorResult = (text: string): ToolResult => ({ content: [{ type: "text", text }], isError: true });

export interface HubOptions {
  storage: ConnectorStorage;
  spawn: SpawnFn;
  env(): NodeJS.ProcessEnv;
  cwd: string;
  fetch?: typeof fetch;
  /** Ask the user (the chat's consent card); resolves with the answer */
  ask(consent: Omit<ConnectorConsent, "reqId">): Promise<ConsentAnswer>;
  /** The list changed (Settings and the composer refresh) */
  onChange?(list: Connector[]): void;
}

export class ConnectorHub {
  private clients = new Map<string, { client: McpClient; ready: Promise<void> }>();
  private state = new Map<string, { state: Connector["state"]; error?: string }>();

  constructor(private o: HubOptions) {}

  list(): Connector[] {
    return this.o.storage.read().map((c) => this.view(c));
  }

  private view(c: StoredConnector): Connector {
    const s = this.state.get(c.id);
    return {
      id: c.id,
      name: c.name,
      transport: c.transport.kind === "http" ? { kind: "http", url: c.transport.url, hasKey: !!this.o.storage.key(c.id) } : { ...c.transport, args: [...c.transport.args] },
      enabled: c.enabled,
      tools: c.tools.map((t) => ({ name: t.name, ...(t.description ? { description: t.description } : {}), policy: c.policies[t.name] ?? "ask" })),
      state: s?.state ?? "unknown",
      ...(s?.error ? { error: s.error } : {}),
    };
  }

  private save(list: StoredConnector[]): Connector[] {
    this.o.storage.write(list);
    const out = list.map((c) => this.view(c));
    this.o.onChange?.(out);
    return out;
  }

  add(p: { name: string; transport: { kind: "http"; url: string; key?: string } | { kind: "stdio"; command: string; args: string[] } }): Connector[] {
    const name = String(p?.name ?? "").trim().slice(0, 60);
    if (!name) throw new Error(tr("A connector needs a name."));
    const t = p.transport;
    let transport: StoredConnector["transport"];
    if (t?.kind === "http") {
      const url = String(t.url ?? "").trim();
      if (!/^https?:\/\/\S+$/i.test(url)) throw new Error(tr("A server URL like {example}", { example: "https://example.com/mcp" }));
      transport = { kind: "http", url };
    } else if (t?.kind === "stdio") {
      const command = String(t.command ?? "").trim();
      if (!command) throw new Error(tr("A command to start the server."));
      transport = { kind: "stdio", command: command.slice(0, 2000), args: (Array.isArray(t.args) ? t.args : []).slice(0, 50).map((a) => String(a).slice(0, 2000)) };
    } else throw new Error(tr("A server URL or a command."));
    const list = this.o.storage.read();
    const id = `con_${randomUUID().slice(0, 8)}`;
    list.push({ id, name, transport, enabled: true, tools: [], policies: {} });
    if (t.kind === "http" && t.key) this.o.storage.setKey(id, String(t.key));
    return this.save(list);
  }

  update(p: { id: string; enabled?: boolean; policies?: Record<string, ConnectorToolPolicy> }): Connector[] {
    const list = this.o.storage.read();
    const c = list.find((x) => x.id === p?.id);
    if (!c) throw new Error(tr("No such connector."));
    if (typeof p.enabled === "boolean") c.enabled = p.enabled;
    for (const [tool, policy] of Object.entries(p.policies ?? {})) if ((policy === "allow" || policy === "ask" || policy === "off") && tool.length <= 200) c.policies[tool] = policy;
    if (!c.enabled) this.disconnect(c.id);
    return this.save(list);
  }

  remove(id: string): Connector[] {
    this.disconnect(id);
    this.state.delete(id);
    this.o.storage.setKey(id, null);
    return this.save(this.o.storage.read().filter((c) => c.id !== id));
  }

  /** Connects (again) and reads its tools: new ones start at Ask. */
  async test(id: string): Promise<Connector> {
    this.disconnect(id);
    await this.refresh(id);
    const c = this.o.storage.read().find((x) => x.id === id);
    if (!c) throw new Error(tr("No such connector."));
    return this.view(c);
  }

  private disconnect(id: string) {
    this.clients.get(id)?.client.close();
    this.clients.delete(id);
  }

  private connect(c: StoredConnector): Promise<McpClient> {
    const live = this.clients.get(c.id);
    if (live) return live.ready.then(() => live.client);
    const client: McpClient =
      c.transport.kind === "http" ? new HttpMcpClient(c.transport.url, this.o.storage.key(c.id), this.o.fetch) : new StdioMcpClient(c.transport.command, c.transport.args, this.o.spawn, this.o.env(), this.o.cwd);
    const ready = (async () => {
      await client.request("initialize", { protocolVersion: MCP_CLIENT_PROTOCOL, capabilities: {}, clientInfo: { name: "designer-connectors", title: "Wecra", version: "1" } });
      await client.notify("notifications/initialized");
    })();
    this.clients.set(c.id, { client, ready });
    return ready.then(
      () => client,
      (err) => {
        this.disconnect(c.id);
        throw err;
      }
    );
  }

  /** Lists the connector's tools now, kept with its policies; its state set. */
  private async refresh(id: string): Promise<void> {
    const c = this.o.storage.read().find((x) => x.id === id);
    if (!c) return;
    try {
      const client = await this.connect(c);
      const r = (await client.request("tools/list", {})) as { tools?: { name?: string; description?: string; inputSchema?: Record<string, unknown> }[] };
      const tools = (r?.tools ?? []).filter((t) => typeof t?.name === "string" && /^[\w.-]{1,64}$/.test(t.name)).slice(0, 200);
      const list = this.o.storage.read();
      const stored = list.find((x) => x.id === id);
      if (stored) {
        stored.tools = tools.map((t) => ({ name: t.name!, ...(t.description ? { description: String(t.description).slice(0, 2000) } : {}), ...(t.inputSchema && typeof t.inputSchema === "object" ? { inputSchema: t.inputSchema } : {}) }));
        for (const t of stored.tools) stored.policies[t.name] ??= "ask";
      }
      this.state.set(id, { state: "connected" });
      this.save(list);
    } catch (err) {
      this.state.set(id, { state: "error", error: err instanceof Error ? err.message : String(err) });
      this.o.onChange?.(this.list());
    }
  }

  /** Tool names for a chat's connectors: `‹slug›__‹tool›` (slugs made unique among them). */
  private names(ids: readonly string[]): Map<string, { c: StoredConnector; tool: string }> {
    const out = new Map<string, { c: StoredConnector; tool: string }>();
    const used = new Map<string, string>();
    for (const c of this.o.storage.read().filter((x) => x.enabled && ids.includes(x.id))) {
      let slug = connectorSlug(c.name);
      if (used.has(slug) && used.get(slug) !== c.id) slug = `${slug}-${c.id.slice(-4)}`;
      used.set(slug, c.id);
      for (const t of c.tools) if ((c.policies[t.name] ?? "ask") !== "off") out.set(`${slug}${CONNECTOR_TOOL_SEP}${t.name}`.slice(0, 64), { c, tool: t.name });
    }
    return out;
  }

  /** The tools a chat's connectors offer (connecting those not connected yet). Off tools aren't listed. */
  async toolsFor(ids: readonly string[]): Promise<ProxiedTool[]> {
    const wanted = this.o.storage.read().filter((x) => x.enabled && ids.includes(x.id));
    await Promise.all(wanted.filter((c) => this.state.get(c.id)?.state !== "connected").map((c) => this.refresh(c.id)));
    return [...this.names(ids)].map(([name, { c, tool }]) => {
      const t = c.tools.find((x) => x.name === tool)!;
      return { name, description: `${c.name}: ${t.description ?? tool}`, inputSchema: t.inputSchema ?? { type: "object", properties: {} }, connectorId: c.id, tool };
    });
  }

  /** Whether `name` is one of a chat's connectors' tools. */
  has(ids: readonly string[], name: string): boolean {
    return this.names(ids).has(name);
  }

  /** A proxied call, after its policy: Off refused, Ask asks the user (Always allow keeps Allow), Allow runs. */
  async call(ids: readonly string[], name: string, args: Record<string, unknown>, turnId: string): Promise<ToolResult> {
    const hit = this.names(ids).get(name);
    if (!hit) return errorResult(`${name} isn't one of this chat's connectors' tools (or it is turned off).`);
    const { c, tool } = hit;
    const policy = c.policies[tool] ?? "ask";
    if (policy === "off") return errorResult(`${tool} of ${c.name} is turned off.`);
    if (policy === "ask") {
      const answer = await this.o.ask({ turnId, connectorId: c.id, connector: c.name, tool, args }).catch((): ConsentAnswer => ({ allow: false }));
      if (!answer.allow) return errorResult(`The user didn't allow ${tool} of ${c.name}. Don't call it again for this request.`);
      if (answer.remember) this.update({ id: c.id, policies: { [tool]: "allow" } });
    }
    try {
      const client = await this.connect(c);
      const r = (await client.request("tools/call", { name: tool, arguments: args }, 120_000)) as { content?: unknown[]; isError?: boolean; structuredContent?: unknown };
      const content = (Array.isArray(r?.content) ? r.content : [])
        .flatMap((b): ToolResult["content"] => {
          const x = b as { type?: string; text?: string; data?: string; mimeType?: string; resource?: { text?: string; uri?: string } };
          if (x?.type === "text" && typeof x.text === "string") return [{ type: "text", text: x.text.slice(0, 100_000) }];
          if (x?.type === "image" && typeof x.data === "string" && typeof x.mimeType === "string") return [{ type: "image", data: x.data, mimeType: x.mimeType }];
          if (x?.type === "resource" && x.resource) return [{ type: "text", text: (x.resource.text ?? x.resource.uri ?? "").slice(0, 100_000) }];
          return [];
        })
        .slice(0, 20);
      if (!content.length && r?.structuredContent !== undefined) content.push({ type: "text", text: JSON.stringify(r.structuredContent).slice(0, 100_000) });
      this.state.set(c.id, { state: "connected" });
      return { content: content.length ? content : [{ type: "text", text: "(no result)" }], isError: r?.isError === true || undefined };
    } catch (err) {
      this.state.set(c.id, { state: "error", error: err instanceof Error ? err.message : String(err) });
      return errorResult(`${c.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  close(): void {
    for (const id of [...this.clients.keys()]) this.disconnect(id);
  }
}
