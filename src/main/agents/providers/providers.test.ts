// The CLI agents' adapters (one file each beside this one) without running any CLI: their plans for a turn, their
// stream parsers on sample output (fixtures/*.ndjson — Claude Code's recorded from a real run; Gemini CLI's, Codex's and
// Cursor's written from their documented event formats, those CLIs not being installed where this was built), their
// sign-in status readers, and the shared turn runner on a fake process.
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import type { ChatEvent, TurnRequest } from "../../../shared/agents/types";
import { claudeCode, parseClaudeStatus } from "./claudeCode";
import { codex, parseCodexStatus } from "./codex";
import { cursorAgent, parseCursorStatus } from "./cursor";
import { gemini, geminiStatus, imageGenStatus, NANOBANANA } from "./gemini";
import { CLI_SPECS } from "./index";
import { LineSplitter, loginUrl, newParseState, parseRecorded, promptWithContext, promptWithHistory, runCliProcess, shortToolName, type AuthEnv, type CliSpec } from "./turns";

const fixture = (name: string) => readFileSync(join(import.meta.dirname, "fixtures", name), "utf8");

const request: TurnRequest = {
  chatId: "c1",
  providerId: "claude-code",
  prompt: "Make the mobile version of this",
  history: [],
  context: { fileName: "Landing", pageName: "Page 1", selection: [{ id: "1:2", name: "Desktop", type: "FRAME", width: 1440, height: 1024 }] },
};
const mcp = { url: "http://127.0.0.1:4000/mcp", token: "tok" };
const turn = (r: Partial<TurnRequest> = {}) => ({ request: { ...request, ...r }, mcp, cwd: "/w", sessionId: "00000000-0000-4000-8000-000000000000", mcpConfigPath: "/w/mcp.json" });
const parseAll = (spec: Pick<CliSpec, "parse">, lines: unknown[]) => {
  const state = newParseState();
  return lines.flatMap((l) => spec.parse(l as Record<string, unknown>, state));
};

describe("every adapter", () => {
  it("has its file, an install command or page, a sign-in and a status reader", () => {
    expect(CLI_SPECS.map((s) => s.id)).toEqual(["claude-code", "gemini", "codex", "cursor-agent"]);
    for (const s of CLI_SPECS) {
      expect(s.install.page).toMatch(/^https:\/\//);
      expect(s.auth.status ?? s.auth.fromFiles).toBeTruthy();
      expect(s.models.length).toBeGreaterThan(0);
      // The chat's token never goes into the arguments (other processes can read those).
      expect(s.plan(turn()).args.join(" ")).not.toMatch(/\btok\b/);
    }
  });

  it("a history goes along when the agent has no session of its own (a chat started with another agent)", () => {
    const history = [{ role: "user" as const, text: "Make a login screen" }, { role: "assistant" as const, text: "Done — “Login” is next to Desktop." }];
    expect(promptWithHistory({ ...request, history })).toContain("Conversation so far:\nUser: Make a login screen");
    expect(claudeCode.plan(turn({ history })).stdin).toContain("Conversation so far");
    expect(claudeCode.plan(turn({ history, resume: "s1" })).stdin).not.toContain("Conversation so far");
    expect(promptWithContext({ ...request, context: { ...request.context, selection: [] } })).toContain("Selected: nothing");
  });

  it("tool names lose their server's prefix however the CLI spells it", () => {
    for (const n of ["mcp__designer__get_metadata", "mcp_designer_get_metadata", "designer__get_metadata", "designer.get_metadata", "designer-get_metadata", "designer/get_metadata", "get_metadata"]) expect(shortToolName(n)).toBe("get_metadata");
    expect(shortToolName("generate_image")).toBe("generate_image");
  });
});

describe("Claude Code", () => {
  it("runs headless with only our MCP server, no built-in tools, the skill appended, the prompt on stdin", () => {
    const plan = claudeCode.plan(turn());
    const a = plan.args;
    expect(a.slice(0, 2)).toEqual(["-p", "--output-format"]);
    expect(a[a.indexOf("--output-format") + 1]).toBe("stream-json");
    expect(a).toContain("--verbose");
    expect(a).toContain("--strict-mcp-config");
    expect(a[a.indexOf("--tools") + 1]).toBe("");
    expect(a[a.indexOf("--allowedTools") + 1]).toBe("mcp__designer");
    expect(a[a.indexOf("--mcp-config") + 1]).toBe("/w/mcp.json");
    expect(a[a.indexOf("--append-system-prompt") + 1]).toContain("responsive adaptation");
    expect(a[a.indexOf("--session-id") + 1]).toBe("00000000-0000-4000-8000-000000000000");
    expect(a).not.toContain("--model");
    expect(JSON.parse(plan.files!["/w/mcp.json"])).toEqual({ mcpServers: { designer: { type: "http", url: mcp.url, headers: { Authorization: "Bearer tok" } } } });
    expect(plan.stdin).toContain('frame "Desktop" (id 1:2, 1440 × 1024)');
    const resumed = claudeCode.plan(turn({ resume: "abc", model: "haiku" })).args;
    expect(resumed[resumed.indexOf("--resume") + 1]).toBe("abc");
    expect(resumed[resumed.indexOf("--model") + 1]).toBe("haiku");
    expect(resumed).not.toContain("--session-id");
  });

  it("reads its recorded stream-json: the session, streamed text once, our tools with their results", () => {
    const events = parseRecorded(claudeCode, fixture("claude-code.ndjson"));
    expect(events[0]).toMatchObject({ type: "session", resume: expect.any(String) });
    const tools = events.filter((e): e is Extract<ChatEvent, { type: "tool" }> => e.type === "tool");
    expect(tools.find((t) => t.state === "running")?.name).toBe("get_metadata");
    expect(tools.find((t) => t.state === "done")?.name).toBe("get_metadata");
    expect(tools.find((t) => t.state === "done")?.summary).toBeTruthy();
    const text = events.filter((e): e is Extract<ChatEvent, { type: "text" }> => e.type === "text").map((e) => e.delta).join("");
    expect(text.length).toBeGreaterThan(5);
    // Streamed deltas aren't repeated by the whole message that follows them.
    const assistantTexts = fixture("claude-code.ndjson").split("\n").filter((l) => l.includes('"type":"assistant"') && l.includes('"type":"text"')).length;
    expect(assistantTexts).toBeGreaterThan(0);
    expect(text.split(text.slice(0, 12)).length - 1).toBe(1);
    expect(events.some((e) => e.type === "error")).toBe(false);
  });

  it("errors: our server not connected, a failed result, an unsigned CLI", () => {
    expect(parseAll(claudeCode, [{ type: "system", subtype: "init", session_id: "s", mcp_servers: [{ name: "designer", status: "failed" }] }])[1]).toMatchObject({ type: "error" });
    expect(parseAll(claudeCode, [{ type: "result", subtype: "error_max_turns", is_error: true }])[0]).toMatchObject({ type: "error" });
    expect(parseAll(claudeCode, [{ type: "result", subtype: "success", is_error: true, result: "Not logged in · Please run /login" }])[0]).toMatchObject({ type: "error", message: expect.stringMatching(/isn’t signed in/) });
  });

  it("sign-in from `claude auth status --json`; login and logout are its own commands", () => {
    expect(claudeCode.auth.status?.args).toEqual(["auth", "status", "--json"]);
    expect(parseClaudeStatus(JSON.stringify({ loggedIn: false, authMethod: "none" }))).toEqual({ state: "signed-out" });
    expect(parseClaudeStatus(JSON.stringify({ loggedIn: true, authMethod: "claude.ai", email: "a@b.c", subscriptionType: "team", orgName: "Org" }))).toEqual({ state: "connected", account: "a@b.c", plan: "Claude Team · Org" });
    expect(parseClaudeStatus("not json").state).toBe("signed-out");
    expect(claudeCode.auth.login).toEqual({ kind: "background", args: ["auth", "login", "--claudeai"] });
    expect(claudeCode.auth.logout).toEqual({ kind: "command", args: ["auth", "logout"] });
    expect(loginUrl("Opening https://claude.ai/oauth/authorize?code=1 in your browser")).toBe("https://claude.ai/oauth/authorize?code=1");
  });
});

describe("Gemini CLI (Antigravity's models)", () => {
  it("runs headless in stream-json with our server from the chat folder's settings, the shell excluded, Nano Banana allowed", () => {
    const plan = gemini.plan(turn({ model: "flash" }));
    const a = plan.args;
    expect(a[0]).toBe("-p");
    expect(a[1]).toContain("responsive adaptation");
    expect(a[1]).toContain("place_image");
    expect(a[a.indexOf("--output-format") + 1]).toBe("stream-json");
    expect(a[a.indexOf("--approval-mode") + 1]).toBe("yolo");
    expect(a[a.indexOf("--allowed-mcp-server-names") + 1]).toBe(`designer,${NANOBANANA}`);
    expect(a[a.indexOf("-m") + 1]).toBe("flash");
    expect(gemini.plan(turn({ model: "auto" })).args).not.toContain("-m");
    const settings = JSON.parse(plan.files![".gemini/settings.json"]);
    expect(settings.mcpServers.designer).toEqual({ httpUrl: mcp.url, headers: { Authorization: "Bearer tok" }, trust: true });
    expect(settings.tools.exclude).toContain("run_shell_command");
    expect(gemini.label).toContain("Antigravity");
  });

  it("reads its stream: deltas, our tools and others, warnings ignored, errors", () => {
    expect(parseRecorded(gemini, fixture("gemini.ndjson"))).toEqual([
      { type: "session", resume: "6f1e2d3c-0000-4000-8000-000000000001", model: "gemini-2.5-pro" },
      { type: "text", delta: "Let me look " },
      { type: "text", delta: "at the page." },
      { type: "tool", id: "get_metadata-1760000000000-1", name: "get_metadata", args: {}, state: "running" },
      { type: "tool", id: "get_metadata-1760000000000-1", name: "get_metadata", state: "done", summary: "<pages>" },
      { type: "tool", id: "generate_image-1760000000000-2", name: "generate_image", args: { prompt: "a hero photo" }, state: "running" },
      { type: "tool", id: "generate_image-1760000000000-2", name: "generate_image", state: "error", summary: "No API key found" },
      { type: "text", delta: 'The page has one frame, "Desktop".' },
    ]);
    // A whole message after the deltas isn't repeated; a non-delta message alone is the text.
    expect(parseAll(gemini, [{ type: "message", role: "assistant", content: "Hi", delta: true }, { type: "message", role: "assistant", content: "Hi" }])).toEqual([{ type: "text", delta: "Hi" }]);
    expect(parseAll(gemini, [{ type: "message", role: "assistant", content: "Hi" }])).toEqual([{ type: "text", delta: "Hi" }]);
    expect(parseAll(gemini, [{ type: "result", status: "error", error: { type: "auth", message: "Please set an Auth method in your settings.json" } }])[0]).toMatchObject({ type: "error", message: expect.stringMatching(/isn’t signed in/) });
  });

  const env = (files: Record<string, string>, extra: Partial<AuthEnv> = {}): AuthEnv & { list(p: string): string[] } => ({
    home: "/h",
    readFile: (p) => files[p] ?? null,
    exists: (p) => p in files,
    list: (p) => [...new Set(Object.keys(files).filter((f) => f.startsWith(`${p}/`)).map((f) => f.slice(p.length + 1).split("/")[0]))],
    env: {},
    ...extra,
  });

  it("sign-in read from its own files (it has no status command); signing in and out happen in Terminal", () => {
    expect(geminiStatus(env({}))).toEqual({ state: "signed-out" });
    expect(geminiStatus(env({ "/h/.gemini/settings.json": '{ // comment\n "security": { "auth": { "selectedType": "oauth-personal" } } }', "/h/.gemini/oauth_creds.json": "{}", "/h/.gemini/google_accounts.json": '{"active":"me@gmail.com","old":[]}' }))).toEqual({ state: "connected", account: "me@gmail.com", plan: "Google account" });
    expect(geminiStatus(env({ "/h/.gemini/settings.json": '{"security":{"auth":{"selectedType":"gemini-api-key"}}}' })).state).toBe("signed-out");
    expect(geminiStatus(env({ "/h/.gemini/settings.json": '{"security":{"auth":{"selectedType":"gemini-api-key"}}}' }, { env: { GEMINI_API_KEY: "x" } })).state).toBe("connected");
    expect(gemini.auth.login.kind).toBe("terminal");
    expect(gemini.auth.logout).toMatchObject({ kind: "terminal", note: expect.stringContaining("/auth logout") });
  });

  it("image generation: Nano Banana installed, signed in, with a key (the owner's, or the extension's own .env)", () => {
    const signedIn = { signedIn: true, installed: true, hasKey: false };
    expect(imageGenStatus(env({}), { ...signedIn, installed: false }).state).toBe("unavailable");
    expect(imageGenStatus(env({}), signedIn).state).toBe("not-installed");
    const ext = { "/h/.gemini/extensions/nanobanana/gemini-extension.json": "{}" };
    expect(imageGenStatus(env(ext), { ...signedIn, signedIn: false }).state).toBe("needs-sign-in");
    expect(imageGenStatus(env(ext), signedIn).state).toBe("needs-key");
    expect(imageGenStatus(env(ext), { ...signedIn, hasKey: true })).toEqual({ state: "ready", detail: "With the API key you added" });
    expect(imageGenStatus(env({ ...ext, "/h/.gemini/extensions/nanobanana/.env": "NANOBANANA_API_KEY=abc\n" }), signedIn).state).toBe("ready");
  });
});

describe("Codex", () => {
  it("runs `codex exec --json -` read-only with our server as -c overrides, the token in the environment", () => {
    const plan = codex.plan(turn());
    expect(plan.args.slice(0, 2)).toEqual(["exec", "--json"]);
    expect(plan.args).toContain('mcp_servers.designer.url="http://127.0.0.1:4000/mcp"');
    expect(plan.args).toContain('mcp_servers.designer.bearer_token_env_var="DESIGNER_MCP_TOKEN"');
    expect(plan.args).toContain('mcp_servers.designer.default_tools_approval_mode="approve"');
    expect(plan.args[plan.args.indexOf("--sandbox") + 1]).toBe("read-only");
    expect(plan.args[plan.args.length - 1]).toBe("-");
    expect(plan.env).toEqual({ DESIGNER_MCP_TOKEN: "tok" });
    expect(plan.stdin).toContain("Make the mobile version of this");
  });

  it("reads its JSONL: thread, MCP tool calls with results and failures, the agent's message", () => {
    expect(parseRecorded(codex, fixture("codex.ndjson"))).toEqual([
      { type: "session", resume: "0199a213-81c0-7800-8aa1-bbab2a035a53" },
      { type: "tool", id: "item_1", name: "get_metadata", args: {}, state: "running" },
      { type: "tool", id: "item_1", name: "get_metadata", state: "done", summary: "<pages>" },
      { type: "tool", id: "item_2", name: "delete_nodes", args: { nodeIds: ["9:9"] }, state: "running" },
      { type: "tool", id: "item_2", name: "delete_nodes", state: "error", summary: "No such layer 9:9" },
      { type: "text", delta: 'The page has one frame, "Desktop".' },
    ]);
    expect(parseAll(codex, [{ type: "turn.failed", error: { message: "401 Unauthorized" } }])[0]).toMatchObject({ type: "error", message: expect.stringMatching(/isn’t signed in/) });
  });

  it("sign-in from `codex login status`", () => {
    expect(codex.auth.status?.args).toEqual(["login", "status"]);
    expect(parseCodexStatus({ code: 0, stdout: "", stderr: "Logged in using ChatGPT\n" })).toEqual({ state: "connected", plan: "ChatGPT" });
    expect(parseCodexStatus({ code: 0, stdout: "Logged in using an API key - sk-proj-***ABCD\n" })).toEqual({ state: "connected", plan: "API key" });
    expect(parseCodexStatus({ code: 1, stdout: "Not logged in\n" })).toEqual({ state: "signed-out" });
    expect(codex.auth.login).toEqual({ kind: "background", args: ["login"] });
  });
});

describe("Cursor Agent", () => {
  it("runs print mode with our server and a no-shell, no-write permission file in the chat folder", () => {
    const plan = cursorAgent.plan(turn());
    expect(plan.args.slice(0, 3)).toEqual(["-p", "--output-format", "stream-json"]);
    expect(plan.args).toContain("--approve-mcps");
    expect(JSON.parse(plan.files![".cursor/mcp.json"]).mcpServers.designer).toEqual({ url: mcp.url, headers: { Authorization: "Bearer tok" } });
    expect(JSON.parse(plan.files![".cursor/cli.json"]).permissions.deny).toEqual(["Shell(*)", "Write(**)"]);
    expect(cursorAgent.bins).toEqual(["cursor-agent", "agent"]);
  });

  it("reads its stream-json: partial chunks once, MCP and function tool calls, errors", () => {
    expect(parseRecorded(cursorAgent, fixture("cursor.ndjson"))).toEqual([
      { type: "session", resume: "c6b62c6f-7ead-4fd6-9922-e952131177ff", model: "Auto" },
      { type: "text", delta: "Let me " },
      { type: "text", delta: "look." },
      { type: "tool", id: "toolu_1", name: "get_metadata", args: {}, state: "running" },
      { type: "tool", id: "toolu_1", name: "get_metadata", state: "done", summary: "<pages>" },
      { type: "tool", id: "toolu_2", name: "delete_nodes", args: { nodeIds: ["9:9"] }, state: "running" },
      { type: "tool", id: "toolu_2", name: "delete_nodes", state: "error", summary: "No such layer" },
      { type: "text", delta: "One frame." },
    ]);
    expect(parseAll(cursorAgent, [{ type: "result", is_error: true, result: "Not logged in" }])[0]).toMatchObject({ type: "error", message: expect.stringMatching(/isn’t signed in/) });
  });

  it("sign-in from `cursor-agent status`", () => {
    expect(parseCursorStatus({ code: 0, stdout: "\n ✓ Logged in as me@example.com\n" })).toEqual({ state: "connected", account: "me@example.com" });
    expect(parseCursorStatus({ code: 1, stdout: "Not logged in" })).toEqual({ state: "signed-out" });
    expect(cursorAgent.auth.logout).toEqual({ kind: "command", args: ["logout"] });
  });
});

describe("the turn runner (turns.ts)", () => {
  it("splits NDJSON across chunks", () => {
    const s = new LineSplitter();
    expect(s.push('{"a":1}\n{"b"')).toEqual([{ a: 1 }]);
    expect(s.push(':2}\nnoise\n')).toEqual([{ b: 2 }]);
  });

  it("runs a (fake) CLI process: the prompt on stdin, its lines as events, the raw output, a failure's stderr", async () => {
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
    const raw: string[] = [];
    const done = vi.fn();
    const plan = claudeCode.plan(turn());
    let stdinText = "";
    f.stdin.on("data", (d) => (stdinText += d));
    runCliProcess({ spec: claudeCode, path: "/bin/claude", plan, cwd: "/w", env: {}, spawn, emit: (e) => events.push(e), done, stopped: () => false, raw: (c) => raw.push(c) });
    expect(spawn).toHaveBeenCalledWith("/bin/claude", plan.args, expect.objectContaining({ cwd: "/w" }));
    f.stdout.write(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Hello" }] } }) + "\n");
    await new Promise((r) => setTimeout(r, 10));
    f.child.emit("close", 0);
    expect(events).toEqual([{ type: "text", delta: "Hello" }]);
    expect(raw.join("")).toContain("Hello");
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
});

describe("Gemini with the owner's API key", () => {
  it("switches the chat folder to the key and passes it only in the environment", () => {
    const plan = gemini.plan({ ...turn(), apiKey: "k" });
    expect(JSON.parse(plan.files![".gemini/settings.json"]).security.auth.selectedType).toBe("gemini-api-key");
    expect(plan.env).toMatchObject({ GEMINI_API_KEY: "k", NANOBANANA_API_KEY: "k", GEMINI_CLI_TRUST_WORKSPACE: "true" });
    expect(plan.args).not.toContain("k");
  });
});
