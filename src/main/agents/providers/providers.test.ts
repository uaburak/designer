// The CLI agents' adapters (one file each beside this one) without running any CLI: their plans for a turn, their
// stream parsers on sample output (fixtures/*.ndjson — Claude Code's and Antigravity's recorded from real runs; Codex's and
// Cursor's written from their documented event formats, those CLIs not being installed where this was built), their
// sign-in status readers, and the shared turn runner on a fake process.
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import type { ChatEvent, TurnRequest } from "../../../shared/agents/types";
import { AGY_PROJECT, AGY_SERVER, agyProject, agyStatus, antigravity, parseAgyModels } from "./antigravity";
import { claudeCode, parseClaudeStatus } from "./claudeCode";
import { codex, parseCodexStatus } from "./codex";
import { cursorAgent, parseCursorStatus } from "./cursor";
import { CLI_SPECS } from "./index";
import { friendlyApiError, readableError } from "../../../shared/agents/errors";
import { LineSplitter, loginUrl, newParseState, parseRecorded, promptWithContext, promptWithHistory, runCliProcess, shortToolName, type CliSpec } from "./turns";

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
    expect(CLI_SPECS.map((s) => s.id)).toEqual(["claude-code", "antigravity", "codex", "cursor-agent"]);
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

describe("Google API errors", () => {
  it("unwraps the nested 402", () => {
    const raw = String.raw`[API Error: {"error":{"message":"{\n  \"error\": {\n    \"code\": 402,\n    \"message\": \"Your prepayment credits are depleted. Please go to AI Studio.\",\n    \"status\": \"RESOURCE_EXHAUSTED\"\n  }\n}\n","code":402,"status":"Payment Required"}}]`;
    expect(friendlyApiError(raw)).toBe("Google refused the request: out of prepaid credits (Your prepayment credits are depleted. Please go to AI Studio.)");
  });

  it("says what a tool's nested 429 with no quota means, and the chat reads any nested message", () => {
    const inner = JSON.stringify({ error: { code: 429, message: "You exceeded your current quota, please check your plan and billing details.\n* Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 0, model: gemini-2.5-flash-image", status: "RESOURCE_EXHAUSTED" } });
    const raw = `MCP tool 'generate_image' reported tool error for function call: {"name":"generate_image"} with response: ${JSON.stringify([{ functionResponse: { response: { error: { content: [{ type: "text", text: `Error: ${inner}` }] } } } }])}`;
    expect(friendlyApiError(raw)).toBe("Google: no quota for the image model on this account (limit 0)");
    expect(readableError(raw)).toMatch(/^You exceeded your current quota.*limit: 0, model: gemini-2\.5-flash-image$/);
    expect(readableError("No API key found")).toBe("No API key found");
  });
});

describe("Antigravity (agy)", () => {
  const files = (home: string, list: Record<string, string>) => ({
    home,
    readFile: (p: string) => list[p] ?? null,
    exists: (p: string) => p in list,
    list: (d: string) => Object.keys(list).filter((p) => p.startsWith(`${d}/`)).map((p) => p.slice(d.length + 1)),
    env: {},
  });

  it("runs headless in stream-json in its own project, our server from the chat folder's .agents/mcp_config.json", () => {
    const plan = antigravity.plan({ ...turn({ model: "gemini-3.1-pro-high" }), cwd: "/data/agents/work/c1", home: "/Users/me" });
    const a = plan.args;
    expect(a[0]).toBe("-p");
    expect(a[1]).toContain(`"${AGY_SERVER}" MCP tools`);
    expect(a[1]).toContain("generate_image");
    expect(a[1]).toContain("place_image");
    expect(a[a.indexOf("--output-format") + 1]).toBe("stream-json");
    expect(a[a.indexOf("--model") + 1]).toBe("gemini-3.1-pro-high");
    expect(a[a.indexOf("--project") + 1]).toBe(AGY_PROJECT);
    expect(a).not.toContain("--dangerously-skip-permissions");
    expect(a).not.toContain("--conversation");
    expect(JSON.parse(plan.files![".agents/mcp_config.json"])).toEqual({ mcpServers: { [AGY_SERVER]: { serverUrl: mcp.url, headers: { Authorization: "Bearer tok" } } } });
    const project = JSON.parse(plan.files![`/Users/me/.gemini/config/projects/${AGY_PROJECT}.json`]);
    expect(project.projectResources.resources[0].folderUri).toBe("file:///data/agents/work");
    expect(project.permissionGrants.permissionGrants.allow).toEqual([`mcp(${AGY_SERVER}/*)`]);
    expect(project.permissionGrants.permissionGrants.deny).toEqual(expect.arrayContaining(["command(*)", "read_url(*)", "execute_url(*)"]));
    expect(agyProject("/w")).not.toMatch(/tok/);
    // Its default model when none is picked; a resumed conversation gets the turn without the prompt and history again.
    expect(antigravity.plan(turn()).args).toContain("gemini-3.8-flash-medium");
    const resumed = antigravity.plan(turn({ resume: "conv-1" })).args;
    expect(resumed[resumed.indexOf("--conversation") + 1]).toBe("conv-1");
    expect(resumed[1]).not.toContain("responsive adaptation");
  });

  it("reads a recorded turn: the session, our tool by its own name, the reply", () => {
    expect(parseRecorded(antigravity, fixture("antigravity.ndjson"))).toEqual([
      { type: "session", resume: "32678092-8f02-401f-b7d2-67057446c91b", model: "gemini-3.8-flash-medium" },
      { type: "tool", id: "32678092-8f02-401f-b7d2-67057446c91b:2", name: "get_metadata", args: {}, state: "running" },
      { type: "tool", id: "32678092-8f02-401f-b7d2-67057446c91b:2", name: "get_metadata", state: "done", summary: "<pages>" },
      { type: "text", delta: "There is 1 page in this document: **Page 1**.\n" },
    ]);
  });

  it("reads a recorded image turn: the image, place_image with the picture's path, its own bookkeeping hidden", () => {
    const events = parseRecorded(antigravity, fixture("antigravity-image.ndjson"));
    const tools = events.filter((e) => e.type === "tool" && e.state !== "running").map((e) => (e as { name: string }).name);
    expect(tools).toEqual(["generate_image", "place_image", "set_selection"]);
    const place = events.find((e) => e.type === "tool" && e.name === "place_image" && e.state === "running") as { args: { path: string } };
    expect(place.args.path).toMatch(/\.gemini\/antigravity-cli\/brain\/32678092-8f02-401f-b7d2-67057446c91b\/red_circle_\d+\.jpg$/);
    const reply = events.filter((e) => e.type === "text").map((e) => (e as { delta: string }).delta).join("");
    expect(reply).toMatch(/^Generating the red circle image now.*\n\n?I generated a red circle image/s);
    expect(events.some((e) => e.type === "error")).toBe(false);
  });

  it("tool errors, a failed run and denied permissions", () => {
    const step = (state: string, tool_info: unknown) => ({ event: "step_update", step_update: { conversation_id: "c", step_index: 3, state, step_type: "tool", tool_name: "call_mcp_tool", tool_info } });
    const params = { ServerName: AGY_SERVER, ToolName: "update_nodes", Arguments: { updates: [] } };
    expect(parseAll(antigravity, [step("ACTIVE", { name: "call_mcp_tool", parameters: params }), step("ERROR", { name: "call_mcp_tool", parameters: params, error: { type: "TOOL_ERROR", message: "Node 1:2 not found\nmore" } })])).toEqual([
      { type: "tool", id: "c:3", name: "update_nodes", args: { updates: [] }, state: "running" },
      { type: "tool", id: "c:3", name: "update_nodes", state: "error", summary: "Node 1:2 not found" },
    ]);
    expect(parseAll(antigravity, [{ event: "result", result: { status: "ERROR", error: "quota exceeded" } }])).toEqual([{ type: "error", message: "quota exceeded" }]);
    expect(parseAll(antigravity, [{ event: "result", result: { status: "SUCCESS", response: "", denied_actions: [{ action: "mcp", display_name: "CallMcpTool" }] } }])[0]).toMatchObject({ type: "error", message: expect.stringContaining("CallMcpTool") });
  });

  it("signs in by its models list (no model call), the account from its log; its models and labels", () => {
    const out = "gemini-3.8-flash-high\tGemini 3.8 Flash (High)\ngemini-3.8-flash-medium\tGemini 3.8 Flash (Medium)\nclaude-opus-5-5-low\tClaude Opus 5.5 (Low)\n";
    const env = files("/h", { "/h/.gemini/antigravity-cli/log/cli-20261009_1.log": "x", "/h/.gemini/antigravity-cli/log/cli-20261009_2.log": "I1009 server_oauth.go:209] OAuth: authenticated successfully as me@gmail.com\n" });
    expect(agyStatus({ code: 0, stdout: out, stderr: "Fetching available models...\n" }, env)).toEqual({ state: "connected", account: "me@gmail.com", plan: "Google account" });
    expect(agyStatus({ code: 0, stdout: "", stderr: "Fetching available models...\n" }, env).state).toBe("signed-out");
    expect(antigravity.auth.status!.args).toEqual(["models"]);
    const m = parseAgyModels(out)!;
    expect(m.models).toEqual(["gemini-3.8-flash-medium", "gemini-3.8-flash-high", "claude-opus-5-5-low"]);
    expect(m.labels["claude-opus-5-5-low"]).toBe("Claude Opus 5.5 (Low)");
    expect(antigravity.modelsFromStatus!({ code: 1, stdout: out })).toBeNull();
  });

  it("place_image may read its conversation's picture folder only", () => {
    expect(antigravity.imageDirs!("32678092-8f02", "/h")).toEqual(["/h/.gemini/antigravity-cli/brain/32678092-8f02"]);
    expect(antigravity.imageDirs!("../x", "/h")).toEqual([]);
  });
});
