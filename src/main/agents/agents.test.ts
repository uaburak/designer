// Main's side of Agents without Electron: the MCP server's protocol and security (a real loopback HTTP server with a
// fake host), the CLI adapters (plans and recorded JSON lines; the process is a fake — the real Claude CLI is never
// run here), the OpenAI-compatible bridge (a mocked fetch), and "Connect" for MCP clients (a temporary home).
import { EventEmitter } from "node:events";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ToolResult } from "../../shared/agents/tools";
import type { ChatEvent, TurnRequest } from "../../shared/agents/types";
import { claudeCode, codex, cursorAgent, gemini, LineSplitter, promptWithContext, runCliProcess, type ParseState } from "./cliProviders";
import { codexTable, configText, connectClient, disconnectClient, listClients, mergeToml, type ClientEnv } from "./clients";
import { McpServer, prettyClient } from "./mcpServer";
import { listModels, readStream, runOpenAiTurn } from "./openaiBridge";
import { STDIO_BRIDGE_SOURCE } from "./stdioBridge";
import { spawn } from "node:child_process";

// ---- The MCP server -------------------------------------------------------------------------------------------------

const TOKEN = "test-token-123";

function fakeHost(active: { file: string | null }) {
  const calls: { fileKey: string; name: string; turnId: string | null; client: string }[] = [];
  const host = {
    activeFileKey: () => active.file,
    isOpen: (k: string) => k === "fileA" || k === "fileB",
    runTool: async (fileKey: string, call: { turnId: string | null; client: string; name: string; args: Record<string, unknown> }): Promise<ToolResult> => {
      calls.push({ fileKey, name: call.name, turnId: call.turnId, client: call.client });
      return { content: [{ type: "text", text: `${call.name} on ${fileKey}` }], touched: ["1:2"] };
    },
    onConnections: vi.fn(),
  };
  return { host, calls };
}

let servers: McpServer[] = [];
afterEach(async () => {
  await Promise.all(servers.map((s) => s.stop()));
  servers = [];
});

async function start(active = { file: "fileA" as string | null }) {
  const { host, calls } = fakeHost(active);
  const server = new McpServer(host, TOKEN);
  servers.push(server);
  await server.start(0);
  const post = async (body: unknown, headers: Record<string, string> = {}) => {
    const r = await fetch(server.url!, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${TOKEN}`, ...headers }, body: JSON.stringify(body) });
    const text = await r.text();
    return { status: r.status, session: r.headers.get("mcp-session-id"), body: text ? JSON.parse(text) : null };
  };
  return { server, host, calls, post, active };
}

const init = (name = "claude-code") => ({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name, version: "1" } } });

describe("MCP server", () => {
  it("listens on 127.0.0.1 only and refuses a request without its token, from a web page, or for another host", async () => {
    const { server, post } = await start();
    expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    expect((await post(init(), { Authorization: "" })).status).toBe(401);
    expect((await post(init(), { Authorization: "Bearer wrong" })).status).toBe(401);
    expect((await post(init(), { Origin: "https://evil.example" })).status).toBe(403);
    const r = await fetch(server.url!.replace("127.0.0.1", "127.0.0.1"), { method: "GET", headers: { Authorization: `Bearer ${TOKEN}` } });
    expect(r.status).toBe(405);
  });

  it("initialize → a session; tools/list; tools/call runs on the file in front, bound for the session", async () => {
    const { post, calls, active } = await start();
    const a = await post(init("Cursor"));
    expect(a.status).toBe(200);
    expect(a.body.result.serverInfo.name).toBe("designer");
    expect(a.body.result.protocolVersion).toBe("2025-06-18");
    expect(a.body.result.instructions).toContain("create_responsive_variant");
    const session = a.session!;
    expect(session).toBeTruthy();
    expect((await post({ jsonrpc: "2.0", method: "notifications/initialized" }, { "Mcp-Session-Id": session })).status).toBe(202);
    const list = await post({ jsonrpc: "2.0", id: 2, method: "tools/list" }, { "Mcp-Session-Id": session });
    const names = list.body.result.tools.map((t: { name: string }) => t.name);
    expect(names).toEqual(expect.arrayContaining(["get_metadata", "get_design_context", "get_screenshot", "get_variable_defs", "get_selection", "create_nodes", "update_nodes", "delete_nodes", "duplicate_nodes", "set_auto_layout", "apply_variable", "apply_style", "create_responsive_variant"]));
    expect(list.body.result.tools.find((t: { name: string }) => t.name === "get_metadata").annotations.readOnlyHint).toBe(true);
    const call = await post({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "get_metadata", arguments: {} } }, { "Mcp-Session-Id": session });
    expect(call.body.result.content[0].text).toBe("get_metadata on fileA");
    expect(call.body.result.touched).toBeUndefined();
    // Another file comes in front: the session keeps working on its own.
    active.file = "fileB";
    await post({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "create_nodes", arguments: { nodes: [] } } }, { "Mcp-Session-Id": session });
    expect(calls.map((c) => c.fileKey)).toEqual(["fileA", "fileA"]);
    expect(calls[0].client).toBe("Cursor");
    expect(calls[0].turnId).toBeNull();
    const unknown = await post({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "rm_rf", arguments: {} } }, { "Mcp-Session-Id": session });
    expect(unknown.body.error.code).toBe(-32602);
    expect((await post({ jsonrpc: "2.0", id: 6, method: "nope" }, { "Mcp-Session-Id": session })).body.error.code).toBe(-32601);
  });

  it("a chat's token works on its own file and turn only", async () => {
    const { server, post, calls, active } = await start({ file: "fileB" });
    const token = server.grantChat({ fileKey: "fileA", turnId: "turn-1", client: "Claude Code" });
    const a = await post(init(), { Authorization: `Bearer ${token}` });
    await post({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "update_nodes", arguments: { updates: [] } } }, { Authorization: `Bearer ${token}`, "Mcp-Session-Id": a.session! });
    expect(calls[0]).toMatchObject({ fileKey: "fileA", turnId: "turn-1", client: "Claude Code" });
    // The outside token can't use the chat's session.
    expect((await post({ jsonrpc: "2.0", id: 3, method: "tools/list" }, { "Mcp-Session-Id": a.session! })).status).toBe(403);
    server.updateChat(token, { turnId: "turn-2" });
    await post({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "get_selection", arguments: {} } }, { Authorization: `Bearer ${token}`, "Mcp-Session-Id": a.session! });
    expect(calls[1].turnId).toBe("turn-2");
    expect(active.file).toBe("fileB");
    expect(server.connections().map((c) => c.chat)).toEqual([true]);
    server.revokeChat(token);
    expect((await post({ jsonrpc: "2.0", id: 5, method: "tools/list" }, { Authorization: `Bearer ${token}` })).status).toBe(401);
  });

  it("with no file open, a call fails with a word why; connections are counted per session", async () => {
    const { server, post, host } = await start({ file: null });
    const a = await post(init("antigravity-ide"));
    const r = await post({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "get_selection", arguments: {} } }, { "Mcp-Session-Id": a.session! });
    expect(r.body.result.isError).toBe(true);
    expect(r.body.result.content[0].text).toMatch(/No design file is open/);
    await post(init("Visual Studio Code"));
    expect(server.connections().map((c) => c.client).sort()).toEqual(["Antigravity", "VS Code"]);
    expect(host.onConnections).toHaveBeenCalled();
    await fetch(server.url!, { method: "DELETE", headers: { Authorization: `Bearer ${TOKEN}`, "Mcp-Session-Id": a.session! } });
    expect(server.connections().map((c) => c.client)).toEqual(["VS Code"]);
  });

  it("the stdio bridge relays JSON-RPC lines to the running server, its token read from server.json", async () => {
    const { server } = await start();
    const dir = mkdtempSync(join(tmpdir(), "agents-bridge-"));
    try {
      writeFileSync(join(dir, "designer-mcp.cjs"), STDIO_BRIDGE_SOURCE);
      writeFileSync(join(dir, "server.json"), JSON.stringify({ url: server.url, token: TOKEN }));
      const child = spawn(process.execPath, [join(dir, "designer-mcp.cjs")], { stdio: ["pipe", "pipe", "inherit"] });
      const lines: Record<string, unknown>[] = [];
      const split = new LineSplitter();
      const got = new Promise<void>((resolve) => child.stdout.on("data", (d) => { lines.push(...split.push(String(d))); if (lines.length >= 2) resolve(); }));
      child.stdin.write(JSON.stringify(init("gemini-cli-mcp-client")) + "\n");
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
      await new Promise((r) => setTimeout(r, 100));
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "get_selection", arguments: {} } }) + "\n");
      await got;
      child.kill();
      expect((lines[0].result as { serverInfo: { name: string } }).serverInfo.name).toBe("designer");
      expect((lines[1].result as { content: { text: string }[] }).content[0].text).toBe("get_selection on fileA");
      expect(server.connections().map((c) => c.client)).toEqual(["Gemini CLI"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("names clients as people know them", () => {
    expect(prettyClient("claude-code")).toBe("Claude Code");
    expect(prettyClient("cursor-vscode")).toBe("Cursor");
    expect(prettyClient("Visual Studio Code")).toBe("VS Code");
    expect(prettyClient("antigravity")).toBe("Antigravity");
    expect(prettyClient("")).toBe("MCP client");
  });
});

// ---- CLI adapters -------------------------------------------------------------------------------------------------

const request: TurnRequest = {
  chatId: "c1",
  providerId: "claude-code",
  prompt: "Make the mobile version of this",
  history: [],
  context: { fileName: "Landing", pageName: "Page 1", selection: [{ id: "1:2", name: "Desktop", type: "FRAME", width: 1440, height: 1024 }] },
};

const parseAll = (spec: { parse: (l: Record<string, unknown>, s: ParseState) => ChatEvent[] }, lines: unknown[]) => {
  const state: ParseState = { streamed: false, tools: new Map() };
  return lines.flatMap((l) => spec.parse(l as Record<string, unknown>, state));
};

describe("CLI adapters", () => {
  it("Claude Code runs headless with only our MCP server, no built-in tools, the skill appended, the prompt on stdin", () => {
    const plan = claudeCode.plan({ request, mcp: { url: "http://127.0.0.1:4000/mcp", token: "tok" }, cwd: "/tmp/w", sessionId: "00000000-0000-4000-8000-000000000000", mcpConfigPath: "/tmp/w/mcp.json" });
    const a = plan.args;
    expect(a.slice(0, 2)).toEqual(["-p", "--output-format"]);
    expect(a[a.indexOf("--output-format") + 1]).toBe("stream-json");
    expect(a).toContain("--verbose");
    expect(a).toContain("--strict-mcp-config");
    expect(a[a.indexOf("--tools") + 1]).toBe("");
    expect(a[a.indexOf("--allowedTools") + 1]).toBe("mcp__designer");
    expect(a[a.indexOf("--mcp-config") + 1]).toBe("/tmp/w/mcp.json");
    expect(a[a.indexOf("--append-system-prompt") + 1]).toContain("responsive adaptation");
    expect(a[a.indexOf("--session-id") + 1]).toBe("00000000-0000-4000-8000-000000000000");
    expect(a).not.toContain("tok");
    expect(JSON.parse(plan.files!["/tmp/w/mcp.json"])).toEqual({ mcpServers: { designer: { type: "http", url: "http://127.0.0.1:4000/mcp", headers: { Authorization: "Bearer tok" } } } });
    expect(plan.stdin).toContain('frame "Desktop" (id 1:2, 1440 × 1024)');
    expect(plan.stdin).toContain("Make the mobile version of this");
    const resumed = claudeCode.plan({ request: { ...request, resume: "abc", model: "sonnet" }, mcp: { url: "u", token: "t" }, cwd: "/tmp/w", sessionId: "x", mcpConfigPath: "/tmp/w/mcp.json" }).args;
    expect(resumed[resumed.indexOf("--resume") + 1]).toBe("abc");
    expect(resumed[resumed.indexOf("--model") + 1]).toBe("sonnet");
    expect(resumed).not.toContain("--session-id");
  });

  it("Claude Code's stream-json becomes the chat's events", () => {
    const events = parseAll(claudeCode, [
      { type: "system", subtype: "init", session_id: "s-1", model: "claude-x", mcp_servers: [{ name: "designer", status: "connected" }] },
      { type: "stream_event", event: { type: "message_start" } },
      { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "Reading " } } },
      { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "the frame." } } },
      { type: "assistant", message: { content: [{ type: "text", text: "Reading the frame." }, { type: "tool_use", id: "tu1", name: "mcp__designer__get_design_context", input: { nodeId: "1:2" } }] } },
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu1", content: [{ type: "text", text: '{"nodes":[]}' }] }] } },
      { type: "assistant", message: { content: [{ type: "text", text: "Done." }] } },
      { type: "result", subtype: "success", is_error: false, result: "Done." },
    ]);
    expect(events).toEqual([
      { type: "session", resume: "s-1", model: "claude-x" },
      { type: "text", delta: "Reading " },
      { type: "text", delta: "the frame." },
      { type: "tool", id: "tu1", name: "get_design_context", args: { nodeId: "1:2" }, state: "running" },
      { type: "tool", id: "tu1", name: "get_design_context", state: "done", summary: '{"nodes":[]}' },
      { type: "text", delta: "Done." },
    ]);
    expect(parseAll(claudeCode, [{ type: "system", subtype: "init", session_id: "s", mcp_servers: [{ name: "designer", status: "failed" }] }])[1]).toMatchObject({ type: "error" });
    expect(parseAll(claudeCode, [{ type: "result", subtype: "error_max_turns", is_error: true }])[0]).toMatchObject({ type: "error" });
    // Recorded from the smoke test: an unsigned CLI.
    expect(parseAll(claudeCode, [{ type: "result", subtype: "success", is_error: true, result: "Not logged in · Please run /login" }])[0]).toMatchObject({ type: "error", message: expect.stringMatching(/isn’t signed in/) });
  });

  it("Codex, Gemini CLI and Cursor's agent: their plans carry our server; their events are read", () => {
    const mcp = { url: "http://127.0.0.1:4000/mcp", token: "tok" };
    const turn = { request, mcp, cwd: "/w", sessionId: "s", mcpConfigPath: "/w/mcp.json" };
    const cx = codex.plan(turn);
    expect(cx.args.slice(0, 2)).toEqual(["exec", "--json"]);
    expect(cx.args).toContain('mcp_servers.designer.url="http://127.0.0.1:4000/mcp"');
    expect(cx.env).toEqual({ DESIGNER_MCP_TOKEN: "tok" });
    expect(cx.args.join(" ")).not.toContain("tok\"");
    expect(parseAll(codex, [{ type: "thread.started", thread_id: "th" }, { type: "item.started", item: { id: "i1", type: "mcp_tool_call", server: "designer", tool: "get_selection", arguments: {} } }, { type: "item.completed", item: { id: "i1", type: "mcp_tool_call", tool: "get_selection", status: "completed" } }, { type: "item.completed", item: { id: "i2", type: "agent_message", text: "Hi" } }])).toEqual([
      { type: "session", resume: "th" },
      { type: "tool", id: "i1", name: "get_selection", args: {}, state: "running" },
      { type: "tool", id: "i1", name: "get_selection", args: undefined, state: "done" },
      { type: "text", delta: "Hi" },
    ]);
    const gm = gemini.plan(turn);
    expect(JSON.parse(gm.files![".gemini/settings.json"]).mcpServers.designer.httpUrl).toBe(mcp.url);
    expect(gm.args).toContain("stream-json");
    expect(parseAll(gemini, [{ type: "message", role: "assistant", content: "Hello" }, { type: "tool_use", tool_name: "designer.get_metadata", tool_id: "g1", parameters: {} }, { type: "tool_result", tool_id: "g1", status: "success" }]).map((e) => e.type)).toEqual(["text", "tool", "tool"]);
    const cu = cursorAgent.plan(turn);
    expect(JSON.parse(cu.files![".cursor/mcp.json"]).mcpServers.designer).toEqual({ url: mcp.url, headers: { Authorization: "Bearer tok" } });
    expect(parseAll(cursorAgent, [{ type: "assistant", message: { content: [{ type: "text", text: "Ok" }] } }])).toEqual([{ type: "text", delta: "Ok" }]);
  });

  it("splits NDJSON across chunks", () => {
    const s = new LineSplitter();
    expect(s.push('{"a":1}\n{"b"')).toEqual([{ a: 1 }]);
    expect(s.push(':2}\nnoise\n')).toEqual([{ b: 2 }]);
  });

  it("runs a (fake) CLI process: the prompt on stdin, its lines as events, a failure's stderr", async () => {
    const fake = () => {
      const child = new EventEmitter() as ChildProcess & EventEmitter;
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      const stdin = new PassThrough();
      Object.assign(child, { stdout, stderr, stdin });
      return { child, stdout, stderr, stdin };
    };
    const f = fake();
    const spawn = vi.fn(() => f.child);
    const events: ChatEvent[] = [];
    const done = vi.fn();
    const plan = claudeCode.plan({ request, mcp: { url: "u", token: "t" }, cwd: "/w", sessionId: "s", mcpConfigPath: "/w/mcp.json" });
    let stdinText = "";
    f.stdin.on("data", (d) => (stdinText += d));
    runCliProcess({ spec: claudeCode, path: "/bin/claude", plan, cwd: "/w", env: {}, spawn, emit: (e) => events.push(e), done, stopped: () => false });
    expect(spawn).toHaveBeenCalledWith("/bin/claude", plan.args, expect.objectContaining({ cwd: "/w" }));
    f.stdout.write(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Hello" }] } }) + "\n");
    await new Promise((r) => setTimeout(r, 10));
    f.child.emit("close", 0);
    expect(events).toEqual([{ type: "text", delta: "Hello" }]);
    expect(done).toHaveBeenCalledWith(undefined);
    expect(stdinText).toContain("Make the mobile version");

    const g = fake();
    const done2 = vi.fn();
    runCliProcess({ spec: claudeCode, path: "/bin/claude", plan, cwd: "/w", env: {}, spawn: () => g.child, emit: () => {}, done: done2, stopped: () => false });
    g.stderr.write("Invalid API key · Please run /login\n");
    await new Promise((r) => setTimeout(r, 10));
    g.child.emit("close", 1);
    expect(done2.mock.calls[0][0]).toMatch(/exited \(1\): Invalid API key/);
  });

  it("the prompt names the selection", () => {
    expect(promptWithContext({ ...request, context: { ...request.context, selection: [] } })).toContain("Selected: nothing");
  });
});

// ---- OpenAI-compatible bridge ------------------------------------------------------------------------------------

const sse = (chunks: unknown[]) => new Response(new ReadableStream({ start(c) { for (const ch of chunks) c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(ch)}\n\n`)); c.enqueue(new TextEncoder().encode("data: [DONE]\n\n")); c.close(); } }), { status: 200, headers: { "Content-Type": "text/event-stream" } });

describe("OpenAI-compatible bridge", () => {
  it("offers the tools, runs the model's tool calls on the file and streams its answer", async () => {
    const bodies: { messages: { role: string; content?: string; tool_call_id?: string }[]; tools?: unknown[] }[] = [];
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      if (bodies.length === 1)
        return sse([
          { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "get_selection", arguments: "" } }] } }] },
          { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "{}" } }] }, finish_reason: "tool_calls" }] },
        ]);
      return sse([{ choices: [{ delta: { content: "Made " } }] }, { choices: [{ delta: { content: "it." }, finish_reason: "stop" }] }]);
    });
    const events: ChatEvent[] = [];
    const runTool = vi.fn(async (): Promise<ToolResult> => ({ content: [{ type: "text", text: '{"selection":[]}' }, { type: "image", data: "AAAA", mimeType: "image/png" }] }));
    await runOpenAiTurn({ baseUrl: "http://localhost:11434/v1/", model: "qwen3", request, runTool, emit: (e) => events.push(e), signal: new AbortController().signal, fetch: fetchMock as unknown as typeof fetch });
    expect(fetchMock.mock.calls[0][0]).toBe("http://localhost:11434/v1/chat/completions");
    expect(bodies[0].tools?.length).toBeGreaterThan(10);
    expect(bodies[0].messages[0].role).toBe("system");
    expect(runTool).toHaveBeenCalledWith("get_selection", {});
    const toolMsg = bodies[1].messages.find((m) => m.role === "tool")!;
    expect(toolMsg.tool_call_id).toBe("call_1");
    expect(toolMsg.content).toContain('{"selection":[]}');
    expect(toolMsg.content).toContain("screenshot");
    expect(events.filter((e) => e.type === "text").map((e) => (e as { delta: string }).delta).join("")).toBe("Made it.");
    expect(events.filter((e) => e.type === "tool").map((e) => (e as { state: string }).state)).toEqual(["running", "done"]);
  });

  it("an error status is an error with its text", async () => {
    const fetchMock = vi.fn(async () => new Response("model not found", { status: 404, statusText: "Not Found" }));
    await expect(runOpenAiTurn({ baseUrl: "http://x/v1", model: "m", request, runTool: async () => ({ content: [] }), emit: () => {}, signal: new AbortController().signal, fetch: fetchMock as unknown as typeof fetch })).rejects.toThrow(/404 Not Found: model not found/);
  });

  it("lists models (OpenAI's /models; Ollama's /api/tags as a fallback)", async () => {
    const f1 = vi.fn(async () => Response.json({ data: [{ id: "a" }, { id: "b" }] }));
    expect(await listModels("http://localhost:1234/v1", { fetch: f1 as unknown as typeof fetch })).toEqual(["a", "b"]);
    const f2 = vi.fn(async (u: string) => (u.endsWith("/models") ? new Response("", { status: 404 }) : Response.json({ models: [{ name: "llama3.1:8b" }] })));
    expect(await listModels("http://localhost:11434/v1", { fetch: f2 as unknown as typeof fetch })).toEqual(["llama3.1:8b"]);
    expect(f2.mock.calls[1][0]).toBe("http://localhost:11434/api/tags");
  });

  it("reads tool calls split across deltas", async () => {
    const r = sse([{ choices: [{ delta: { tool_calls: [{ index: 0, id: "c", function: { name: "create_", arguments: '{"no' } }] } }] }, { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: "nodes", arguments: 'des":[]}' } }] } }] }]);
    const out = await readStream(r.body!, () => {});
    expect(out.toolCalls).toEqual([{ id: "c", name: "create_nodes", arguments: '{"nodes":[]}' }]);
  });
});

// ---- Connect -----------------------------------------------------------------------------------------------------

describe("Connect to MCP clients", () => {
  let home = "";
  const env = (): ClientEnv => ({ home, which: (b) => (b === "claude" ? "/usr/local/bin/claude" : null), exists: (p) => existsSync(p) });
  const ep = { url: "http://127.0.0.1:4321/mcp", token: "secret" };
  afterEach(() => home && rmSync(home, { recursive: true, force: true }));

  it("Cursor: our entry merged into ~/.cursor/mcp.json, other servers kept, the old file backed up", () => {
    home = mkdtempSync(join(tmpdir(), "agents-home-"));
    mkdirSync(join(home, ".cursor"));
    writeFileSync(join(home, ".cursor", "mcp.json"), JSON.stringify({ mcpServers: { other: { command: "x" } }, extra: true }));
    const r = connectClient("cursor", ep, env());
    expect(r.ok).toBe(true);
    const json = JSON.parse(readFileSync(join(home, ".cursor", "mcp.json"), "utf8"));
    expect(json).toEqual({ mcpServers: { other: { command: "x" }, designer: { url: ep.url, headers: { Authorization: "Bearer secret" } } }, extra: true });
    expect(JSON.parse(readFileSync(r.backup!, "utf8")).mcpServers.designer).toBeUndefined();
    expect(listClients(env(), ep.url).find((c) => c.id === "cursor")).toMatchObject({ installed: true, connected: true });
    expect(disconnectClient("cursor", env()).ok).toBe(true);
    expect(JSON.parse(readFileSync(join(home, ".cursor", "mcp.json"), "utf8")).mcpServers).toEqual({ other: { command: "x" } });
  });

  it("Antigravity uses serverUrl in ~/.gemini/config/mcp_config.json (and its older folders when they have one); VS Code `servers` with type http", () => {
    home = mkdtempSync(join(tmpdir(), "agents-home-"));
    mkdirSync(join(home, ".gemini", "antigravity"), { recursive: true });
    writeFileSync(join(home, ".gemini", "antigravity", "mcp_config.json"), JSON.stringify({ mcpServers: { figma: { serverUrl: "http://127.0.0.1:3845/mcp" } } }));
    expect(connectClient("antigravity", ep, env()).ok).toBe(true);
    expect(JSON.parse(readFileSync(join(home, ".gemini", "config", "mcp_config.json"), "utf8")).mcpServers.designer).toEqual({ serverUrl: ep.url, headers: { Authorization: "Bearer secret" } });
    const old = JSON.parse(readFileSync(join(home, ".gemini", "antigravity", "mcp_config.json"), "utf8")).mcpServers;
    expect(Object.keys(old)).toEqual(["figma", "designer"]);
    expect(connectClient("vscode", ep, env()).ok).toBe(true);
    expect(JSON.parse(readFileSync(join(home, "Library", "Application Support", "Code", "User", "mcp.json"), "utf8"))).toEqual({ servers: { designer: { type: "http", url: ep.url, headers: { Authorization: "Bearer secret" } } } });
    expect(configText("gemini", ep, env()).text).toContain('"httpUrl"');
  });

  it("a config that isn't JSON is left as it is", () => {
    home = mkdtempSync(join(tmpdir(), "agents-home-"));
    mkdirSync(join(home, ".cursor"));
    writeFileSync(join(home, ".cursor", "mcp.json"), "{ // a comment\n}");
    const r = connectClient("cursor", ep, env());
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/Copy config/);
    expect(readFileSync(join(home, ".cursor", "mcp.json"), "utf8")).toBe("{ // a comment\n}");
  });

  it("Codex: our TOML table replaced in place, other tables kept", () => {
    const before = `model = "o4"\n\n[mcp_servers.designer]\nurl = "http://old"\n\n[mcp_servers.other]\ncommand = "x"\n`;
    const after = mergeToml(before, codexTable(ep));
    expect(after).toContain('[mcp_servers.other]\ncommand = "x"');
    expect(after).toContain(`url = "${ep.url}"`);
    expect(after).not.toContain("http://old");
    expect(after.match(/\[mcp_servers\.designer\]/g)?.length).toBe(1);
    expect(mergeToml("", codexTable(ep))).toBe(codexTable(ep));
  });
});

describe("the CLIs' environment", () => {
  it("drops a hosting Claude Code session's markers (the CLI uses the user's own sign-in)", async () => {
    const { cliEnv } = await import("./detect");
    const saved = { ...process.env };
    try {
      Object.assign(process.env, { CLAUDECODE: "1", CLAUDE_CODE_SIMPLE: "1", CLAUDE_CODE_ENTRYPOINT: "x", ANTHROPIC_BASE_URL: "http://proxy", ELECTRON_RUN_AS_NODE: "1", KEEP_ME: "y" });
      const env = cliEnv({ DESIGNER_MCP_TOKEN: "t" });
      expect(env.CLAUDECODE).toBeUndefined();
      expect(env.CLAUDE_CODE_SIMPLE).toBeUndefined();
      expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
      expect(env.ELECTRON_RUN_AS_NODE).toBeUndefined();
      expect(env.KEEP_ME).toBe("y");
      expect(env.DESIGNER_MCP_TOKEN).toBe("t");
      expect(env.PATH).toContain(".local/bin");
    } finally {
      for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
      Object.assign(process.env, saved);
    }
  });
});

describe("Claude Code sign-in (its own auth commands, faked)", () => {
  it("not installed → signed out → connected, from `claude auth status --json`", async () => {
    const { claudeAuthStatus, parseClaudeStatus, CLAUDE_STATUS, CLAUDE_LOGIN, loginUrl } = await import("./cliAuth");
    expect(await claudeAuthStatus(null, async () => ({ code: 0, stdout: "" }))).toMatchObject({ state: "not-installed" });
    const run = vi.fn(async () => ({ code: 0, stdout: JSON.stringify({ loggedIn: false, authMethod: "none" }) }));
    expect(await claudeAuthStatus("/bin/claude", run)).toEqual({ state: "signed-out" });
    expect(run).toHaveBeenCalledWith(CLAUDE_STATUS);
    expect(parseClaudeStatus(JSON.stringify({ loggedIn: true, authMethod: "claude.ai", email: "a@b.c", subscriptionType: "team", orgName: "Org" }))).toEqual({ state: "connected", account: "a@b.c", plan: "Claude Team · Org" });
    expect(parseClaudeStatus("not json").state).toBe("signed-out");
    expect(CLAUDE_LOGIN).toEqual(["auth", "login", "--claudeai"]);
    expect(loginUrl("Opening https://claude.ai/oauth/authorize?code=1 in your browser")).toBe("https://claude.ai/oauth/authorize?code=1");
  });
});
