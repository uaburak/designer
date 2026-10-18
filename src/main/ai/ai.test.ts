// Main's one-shot AI runs and connectors without Electron (docs/ai.md §2.2, §2.9, §2.11): the answer's JSON and the
// schema check, runs on a fake OpenAI-compatible server (a local HTTP server) and on a stub CLI (a Node script that
// prints Claude Code's stream-json), the repair retry, cancel, the timeout, the credits stop — and connectors: a fake
// MCP server reached over HTTP and stdio, the Allow / Ask / Off policies, the consent round trip through our MCP server.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { DEFAULT_AI_SETTINGS, type AiBalance, type AiRunEvent, type AiRunRequest, type AiSettings } from "../../shared/ai/types";
import { claudeCode } from "../agents/providers/claudeCode";
import { antigravity } from "../agents/providers/antigravity";
import { codex } from "../agents/providers/codex";
import { cursorAgent } from "../agents/providers/cursor";
import { CLI_SPECS } from "../agents/providers";
import { skillsNote, type CliSpec, type SpawnFn } from "../agents/providers/turns";
import { ConnectorHub, sseReply, type ConnectorStorage, type ConsentAnswer, type StoredConnector } from "../agents/connectors";
import { McpServer } from "../agents/mcpServer";
import { lastJsonObject, readAnswer, schemaErrors } from "./json";
import { AiError, classify } from "./oneShot";
import { AiRuns, overLimit, type ResolvedRoute, type RunDeps } from "./run";

const work = mkdtempSync(join(tmpdir(), "ai-test-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));

const SCHEMA = { type: "object", properties: { names: { type: "array", items: { type: "object", properties: { id: { type: "string" }, name: { type: "string", maxLength: 60 } }, required: ["id", "name"], additionalProperties: false } } }, required: ["names"] };

// ── The answer's JSON ──

describe("the answer's JSON", () => {
  it("takes the last complete object, past prose, fences and braces inside strings", () => {
    expect(lastJsonObject('Sure! ```json\n{"a": 1}\n``` and then {"b": "x } y", "c": [1, {"d": 2}]} done.')).toEqual({ value: { b: "x } y", c: [1, { d: 2 }] } });
    expect(lastJsonObject('{"a": 1} trailing {not json}')).toEqual({ value: { a: 1 } });
    expect(lastJsonObject("no json here")).toBeNull();
    expect(lastJsonObject("It's {\"q\": \"it's\"}")).toEqual({ value: { q: "it's" } });
  });

  it("checks it against the schema, saying where it doesn't fit", () => {
    expect(schemaErrors(SCHEMA, { names: [{ id: "1:2", name: "Header" }] })).toEqual([]);
    expect(schemaErrors(SCHEMA, { names: [{ id: 3, name: "x".repeat(61), extra: true }] })).toEqual(["$.names[0].id: expected string, got integer", "$.names[0].name: longer than 60", '$.names[0]: unexpected "extra"']);
    expect(schemaErrors(SCHEMA, {})).toEqual(['$: missing "names"']);
    expect(schemaErrors({ enum: ["ON_CLICK"] }, "ON_HOVER")).toEqual(['$: must be one of "ON_CLICK"']);
    expect(schemaErrors({ anyOf: [{ type: "string" }, { type: "null" }] }, 3)).toEqual(["$: matches none of the allowed shapes"]);
    expect(readAnswer("nothing", SCHEMA).errors).toEqual(["the answer has no JSON object"]);
    expect(readAnswer("ignored", SCHEMA, { names: [] })).toEqual({ json: { names: [] }, errors: [] });
  });

  it("classifies a provider's failure", () => {
    expect(classify("Claude Code isn’t signed in on this computer.").code).toBe("signed-out");
    expect(classify("429 Too Many Requests").code).toBe("rate-limited");
    expect(classify("model 'llama9' not found").code).toBe("no-model");
    expect(classify("connect ECONNREFUSED").code).toBe("network");
  });
});

// ── The providers' one-shot plans ──

describe("one-shot plans", () => {
  const input = { system: "You are Figma AI.", prompt: "Rename these", schema: SCHEMA, cwd: "/w/run1", home: "/h" };

  it("every CLI adapter has one", () => {
    for (const s of CLI_SPECS) expect(typeof s.oneShot).toBe("function");
  });

  it("Claude Code: no tools, no MCP, no session, its own system prompt, the schema flag; pictures inline", () => {
    const p = claudeCode.oneShot!(input);
    const a = p.args;
    expect(a[a.indexOf("--tools") + 1]).toBe("");
    expect(a).toContain("--strict-mcp-config");
    expect(a).not.toContain("--mcp-config");
    expect(a).toContain("--no-session-persistence");
    expect(a[a.indexOf("--system-prompt") + 1]).toBe("You are Figma AI.");
    expect(JSON.parse(a[a.indexOf("--json-schema") + 1])).toEqual(SCHEMA);
    expect(p.stdin).toBe("Rename these");
    const withImage = claudeCode.oneShot!({ ...input, images: [{ name: "a", path: "image-1.png", data: "iVBOR" }] });
    expect(withImage.args).toContain("--input-format");
    const msg = JSON.parse(withImage.stdin!.trim());
    expect(msg.message.content[0]).toEqual({ type: "image", source: { type: "base64", media_type: "image/png", data: "iVBOR" } });
    expect(p.line({ type: "result", structured_output: { names: [] }, usage: { input_tokens: 10, output_tokens: 5 } })).toEqual({ usage: { input: 10, output: 5 }, json: { names: [] }, result: '{"names":[]}' });
    expect(p.line({ type: "result", is_error: true, result: "Not logged in · Please run /login" }).error).toMatch(/isn’t signed in/);
  });

  it("Antigravity: its AI project (MCP, commands and the web denied), slash commands off", () => {
    const p = antigravity.oneShot!(input);
    expect(p.args).toContain("--disable-slash-commands");
    expect(p.args[p.args.indexOf("--project") + 1]).toBe("designerv2-ai");
    const project = JSON.parse(Object.values(p.files!)[0]);
    expect(project.permissionGrants.permissionGrants.deny).toContain("mcp(*)");
    expect(project.projectResources.resources[0].folderUri).toBe("file:///w");
    expect(p.line({ event: "result", result: { status: "SUCCESS", response: '{"names":[]}', usage: { input_tokens: 3, output_tokens: 2 } } })).toEqual({ usage: { input: 3, output: 2 }, result: '{"names":[]}' });
  });

  it("Codex: read-only, no MCP servers, the schema as a file; Cursor: shell and writes denied", () => {
    const c = codex.oneShot!(input);
    expect(c.args).toContain("mcp_servers={}");
    expect(c.args[c.args.indexOf("--output-schema") + 1]).toBe("schema.json");
    expect(JSON.parse(c.files!["schema.json"])).toEqual(SCHEMA);
    const k = cursorAgent.oneShot!(input);
    expect(JSON.parse(k.files![".cursor/cli.json"]).permissions.deny).toEqual(["Shell(*)", "Write(**)"]);
    expect(k.args.at(-1)).toContain("Rename these");
  });

  it("a chat turn carries the Skill run with /name in full and the others by name", () => {
    const note = skillsNote({ skill: { name: "brand-voice", instructions: "Write warmly." }, skills: [{ name: "brand-voice", description: "Our tone" }, { name: "a11y-check", description: "Checks contrast" }] });
    expect(note).toContain("- a11y-check: Checks contrast");
    expect(note).not.toContain("- brand-voice");
    expect(note).toContain('<skill name="brand-voice">\nWrite warmly.\n</skill>');
    expect(skillsNote({})).toBe("");
  });
});

// ── Runs on a fake OpenAI-compatible server ──

type Handler = (body: Record<string, unknown>, res: ServerResponse) => void;
let handler: Handler = () => undefined;
const requests: Record<string, unknown>[] = [];
let http: Server;
let base = "";

beforeAll(async () => {
  http = createServer((req, res) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      const body = JSON.parse(data || "{}") as Record<string, unknown>;
      requests.push(body);
      handler(body, res);
    });
  });
  await new Promise<void>((r) => http.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(http.address() as AddressInfo).port}/v1`;
});
afterAll(() => new Promise<void>((r) => http.close(() => r())));
afterEach(() => {
  requests.length = 0;
});

const sse = (res: ServerResponse, text: string, usage = { prompt_tokens: 100, completion_tokens: 20 }) => {
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  for (const part of text.match(/.{1,8}/gs) ?? []) res.write(`data: ${JSON.stringify({ model: "llama-test", choices: [{ delta: { content: part } }] })}\n\n`);
  res.write(`data: ${JSON.stringify({ choices: [], usage })}\n\n`);
  res.end("data: [DONE]\n\n");
};

const settings = (s: Partial<AiSettings> = {}): AiSettings => ({ ...DEFAULT_AI_SETTINGS, ...s });

function deps(o: Partial<RunDeps> & { route?: ResolvedRoute } = {}): RunDeps {
  return {
    settings: () => settings(),
    resolveRoute: async () => o.route ?? { kind: "server", providerId: "ollama", label: "Ollama", baseUrl: base, model: "llama-test" },
    balance: async () => null,
    spawn: ((cmd, args, options) => spawn(cmd, args, options)) as SpawnFn,
    env: () => process.env,
    workDir: work,
    home: work,
    ...o,
  };
}

const req = (r: Partial<AiRunRequest> = {}): AiRunRequest => ({ runId: "r1", action: "rewrite", system: "Answer with JSON only.", prompt: "Rename", schema: SCHEMA, ...r });

async function run(d: RunDeps, r = req(), during?: (runs: AiRuns) => void) {
  const events: AiRunEvent[] = [];
  const runs = new AiRuns(d);
  const p = runs.start("view1", r, (e) => events.push(e));
  during?.(runs);
  await p;
  return { events, types: events.map((e) => e.type), runs };
}

describe("a one-shot run on an OpenAI-compatible server", () => {
  it("streams the answer, asks for json_schema, reads the JSON and reports the tokens with credits", async () => {
    handler = (_b, res) => sse(res, 'Here: {"names":[{"id":"1:2","name":"Header"}]}');
    const { events, types } = await run(deps());
    expect(types[0]).toBe("status");
    expect(types.filter((t) => t === "delta").length).toBeGreaterThan(2);
    expect(types.slice(-3)).toEqual(["usage", "result", "done"]);
    // Who answered rides on the usage (found 2026-10-12: with "Automatic" the ledger said "auto"; only main knows).
    expect(events.find((e) => e.type === "usage")).toEqual({ type: "usage", usage: { input: 100, output: 20, images: 0, credits: 1, providerId: "ollama", model: "llama-test" } });
    expect(events.find((e) => e.type === "result")).toMatchObject({ json: { names: [{ id: "1:2", name: "Header" }] } });
    expect(requests[0]).toMatchObject({ model: "llama-test", stream: true, response_format: { type: "json_schema", json_schema: { schema: SCHEMA } } });
    expect((requests[0].messages as { role: string }[])[0]).toEqual({ role: "system", content: "Answer with JSON only." });
  });

  it("repairs a mismatched answer once, counting both attempts' tokens", async () => {
    let n = 0;
    handler = (_b, res) => sse(res, n++ === 0 ? '{"names":[{"id":1}]}' : '{"names":[{"id":"1","name":"Card"}]}');
    const { events, types } = await run(deps());
    expect(requests).toHaveLength(2);
    const repair = (requests[1].messages as { content: string }[])[1].content;
    expect(repair).toContain("doesn't match the required JSON schema");
    expect(repair).toContain("$.names[0].id: expected string");
    expect(events).toContainEqual({ type: "status", text: "Fixing the answer…" });
    expect(events.find((e) => e.type === "usage")).toMatchObject({ usage: { input: 200, output: 40 } });
    expect(types.slice(-2)).toEqual(["result", "done"]);
  });

  it("gives up with bad-output after the repair, still reporting the tokens spent", async () => {
    handler = (_b, res) => sse(res, "I can't do JSON today.");
    const { events, types } = await run(deps());
    expect(requests).toHaveLength(2);
    expect(types.slice(-3)).toEqual(["usage", "error", "done"]);
    expect(events.find((e) => e.type === "error")).toMatchObject({ code: "bad-output" });
  });

  it("falls back to json_object when the server refuses json_schema", async () => {
    handler = (b, res) => {
      if ((b.response_format as { type?: string })?.type === "json_schema") {
        res.writeHead(400, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ error: { message: "response_format json_schema is not supported" } }));
      }
      sse(res, '{"names":[]}');
    };
    const { types } = await run(deps({ resolveRoute: async () => ({ kind: "server", providerId: "custom:x", label: "X", baseUrl: base.replace("127.0.0.1", "localhost"), model: "m" }) }));
    expect(requests.map((r) => (r.response_format as { type: string }).type)).toEqual(["json_schema", "json_object"]);
    expect(types.at(-2)).toBe("result");
  });

  it("times out when no answer comes", async () => {
    handler = () => undefined; // never answers
    const { events, types } = await run(deps({ timeoutMs: 150 }));
    expect(events.find((e) => e.type === "error")).toMatchObject({ code: "timeout" });
    expect(types.at(-1)).toBe("done");
  });

  it("a request's own shorter limit wins (Add interactions: Figma's 60 s)", async () => {
    handler = () => undefined;
    const { events } = await run(deps(), req({ runId: "t2", timeoutMs: 150 }));
    expect(events.find((e) => e.type === "error")).toMatchObject({ code: "timeout", message: "No answer in 0 s." });
  });

  it("cancel ends it with done {cancelled} and nothing else", async () => {
    handler = () => undefined;
    const { events } = await run(deps(), req({ runId: "r2" }), (runs) => setTimeout(() => runs.cancel("view1", "r2"), 50));
    expect(events.filter((e) => e.type !== "status" && e.type !== "delta")).toEqual([{ type: "done", cancelled: true }]);
  });

  it("another view can't cancel it", async () => {
    handler = (_b, res) => setTimeout(() => sse(res, '{"names":[]}'), 80);
    const { types } = await run(deps(), req({ runId: "r3" }), (runs) => runs.cancel("view2", "r3"));
    expect(types.at(-2)).toBe("result");
  });
});

// ── The credits stop ──

describe("the credits stop", () => {
  const used = (remaining: number): AiBalance => ({ month: "2026-10", used: 4250 - remaining, allowance: 4250, remaining, resetsAt: Date.UTC(2026, 10, 1), byAction: {} });

  it("refuses with over-limit once the month's credits are used, before asking anyone", async () => {
    handler = (_b, res) => sse(res, '{"names":[]}');
    const { events } = await run(deps({ balance: async () => used(0) }));
    expect(requests).toHaveLength(0);
    expect(events[0]).toMatchObject({ type: "error", code: "over-limit" });
    expect((events[0] as { message: string }).message).toMatch(/4,250 AI credits.*reset on November 1/);
  });

  it("lets free actions through, warns only when stopAtLimit is off, and never refuses when the ledger can't say", async () => {
    const d = (s: Partial<AiSettings>, b: AiBalance | null) => ({ settings: () => settings(s), balance: async () => b });
    expect(await overLimit(d({}, used(0)), "rename-layers")).toBeNull();
    expect(await overLimit(d({ stopAtLimit: false }, used(0)), "rewrite")).toBeNull();
    expect(await overLimit(d({}, null), "rewrite")).toBeNull();
    expect(await overLimit(d({}, used(10)), "rewrite")).toBeNull();
    expect((await overLimit(d({}, used(0)), "agent"))?.code).toBe("over-limit");
  });

  it("AI off refuses with disabled", async () => {
    const { events } = await run(deps({ settings: () => settings({ enabled: false }) }));
    expect(events[0]).toMatchObject({ type: "error", code: "disabled" });
  });

  it("no provider: the route's error", async () => {
    const { events } = await run(deps({ resolveRoute: async () => Promise.reject(new AiError("no-provider", "No AI provider is connected.")) }));
    expect(events[0]).toMatchObject({ type: "error", code: "no-provider" });
  });
});

// ── Runs on a stub CLI (a Node script speaking Claude Code's stream-json) ──

const STUB = join(work, "stub-claude.cjs");
writeFileSync(
  STUB,
  `const mode = process.argv[2];
let input = "";
process.stdin.on("data", (d) => (input += d));
process.stdin.on("end", () => {
  const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
  out({ type: "system", subtype: "init", model: "claude-stub" });
  if (mode === "hang") return setTimeout(() => {}, 60000);
  if (mode === "signed-out") { out({ type: "result", is_error: true, result: "Not logged in · Please run /login" }); process.exit(1); }
  const answer = mode === "bad-then-good" && !input.includes("previous answer") ? '{"names":"oops"}' : '{"names":[{"id":"1:2","name":"Hero"}]}';
  for (const ch of answer.match(/.{1,6}/g)) out({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: ch } } });
  out({ type: "result", subtype: "success", result: answer, usage: { input_tokens: 40, cache_read_input_tokens: 10, output_tokens: 7 } });
});
`
);

const stubCli = (mode: string): ResolvedRoute => {
  const spec: CliSpec = { ...claudeCode, oneShot: (o) => ({ ...claudeCode.oneShot!(o), args: [STUB, mode] }) };
  return { kind: "cli", providerId: "claude-code", spec, path: process.execPath };
};

describe("a one-shot run on a CLI", () => {
  it("runs the plan in a folder of its own, streams the deltas, reads the result and its tokens", async () => {
    const { events, types } = await run(deps({ route: stubCli("ok") }));
    expect(types.filter((t) => t === "delta").length).toBeGreaterThan(3);
    expect(events.find((e) => e.type === "usage")).toMatchObject({ usage: { input: 50, output: 7 } });
    expect(events.find((e) => e.type === "result")).toMatchObject({ json: { names: [{ id: "1:2", name: "Hero" }] } });
  });

  it("repairs once on the CLI too", async () => {
    const { events, types } = await run(deps({ route: stubCli("bad-then-good") }));
    expect(events).toContainEqual({ type: "status", text: "Fixing the answer…" });
    expect(events.find((e) => e.type === "usage")).toMatchObject({ usage: { input: 100, output: 14 } });
    expect(types.at(-2)).toBe("result");
  });

  it("a CLI that isn't signed in: signed-out", async () => {
    const { events } = await run(deps({ route: stubCli("signed-out") }));
    expect(events.find((e) => e.type === "error")).toMatchObject({ code: "signed-out" });
  });

  it("cancel kills the CLI; a hung one times out", async () => {
    const c = await run(deps({ route: stubCli("hang") }), req({ runId: "c1" }), (runs) => setTimeout(() => runs.cancel("view1", "c1"), 300));
    expect(c.types.at(-1)).toBe("done");
    expect(c.events.at(-1)).toEqual({ type: "done", cancelled: true });
    const t = await run(deps({ route: stubCli("hang"), timeoutMs: 300 }), req({ runId: "c2" }));
    expect(t.events.find((e) => e.type === "error")).toMatchObject({ code: "timeout" });
  });
});

// ── Connectors ──

/** A fake MCP server (Streamable HTTP): an echo tool, a delete tool; tools/call answers as SSE. */
async function fakeMcp(key?: string) {
  const calls: { name: string; args: unknown }[] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      if (key && req.headers.authorization !== `Bearer ${key}`) return res.writeHead(401).end();
      if (req.method === "DELETE") return res.writeHead(200).end();
      const m = JSON.parse(data) as { id?: number; method: string; params?: { name?: string; arguments?: unknown } };
      if (m.id === undefined) return res.writeHead(202).end();
      const reply = (result: unknown, sseOut = false) => {
        const body = JSON.stringify({ jsonrpc: "2.0", id: m.id, result });
        if (sseOut) {
          res.writeHead(200, { "Content-Type": "text/event-stream", "Mcp-Session-Id": "s1" });
          return res.end(`event: message\ndata: ${body}\n\n`);
        }
        res.writeHead(200, { "Content-Type": "application/json", "Mcp-Session-Id": "s1" });
        res.end(body);
      };
      if (m.method === "initialize") return reply({ protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fake" } });
      if (m.method === "tools/list") return reply({ tools: [{ name: "echo", description: "Echoes", inputSchema: { type: "object", properties: { text: { type: "string" } } } }, { name: "delete_all", description: "Deletes" }] });
      if (m.method === "tools/call") {
        calls.push({ name: m.params!.name!, args: m.params!.arguments });
        return reply({ content: [{ type: "text", text: `echo: ${JSON.stringify(m.params!.arguments)}` }] }, true);
      }
      reply({});
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`, calls, close: () => new Promise<void>((r) => server.close(() => r())) };
}

function memoryStorage(): ConnectorStorage & { list: StoredConnector[]; keys: Map<string, string> } {
  const s = {
    list: [] as StoredConnector[],
    keys: new Map<string, string>(),
    read: () => JSON.parse(JSON.stringify(s.list)) as StoredConnector[],
    write: (l: StoredConnector[]) => void (s.list = JSON.parse(JSON.stringify(l))),
    key: (id: string) => s.keys.get(id) ?? null,
    setKey: (id: string, k: string | null) => void (k ? s.keys.set(id, k) : s.keys.delete(id)),
  };
  return s;
}

describe("connectors", () => {
  it("reads an SSE answer", () => {
    expect(sseReply('event: message\ndata: {"jsonrpc":"2.0","id":3,"result":{"ok":true}}\n\n', 3)).toMatchObject({ result: { ok: true } });
    expect(sseReply("data: nope\n\n", 3)).toBeNull();
  });

  it("an HTTP server with a key: tested, its tools at Ask; Allow runs, Ask asks (Deny, Allow once, Always allow), Off is neither listed nor run", async () => {
    const mcp = await fakeMcp("k-123");
    const storage = memoryStorage();
    const ask = vi.fn(async (_c: unknown): Promise<ConsentAnswer> => ({ allow: false }));
    const hub = new ConnectorHub({ storage, spawn: spawn as unknown as SpawnFn, env: () => process.env, cwd: work, ask });
    try {
      const [c] = hub.add({ name: "My Notes", transport: { kind: "http", url: mcp.url, key: "k-123" } });
      expect(c).toMatchObject({ name: "My Notes", transport: { kind: "http", hasKey: true }, state: "unknown" });
      expect(JSON.stringify(storage.list)).not.toContain("k-123");
      const tested = await hub.test(c.id);
      expect(tested.state).toBe("connected");
      expect(tested.tools).toEqual([{ name: "echo", description: "Echoes", policy: "ask" }, { name: "delete_all", description: "Deletes", policy: "ask" }]);
      const tools = await hub.toolsFor([c.id]);
      expect(tools.map((t) => t.name)).toEqual(["my-notes__echo", "my-notes__delete_all"]);
      expect(await hub.toolsFor([])).toEqual([]);

      // Ask → Deny: not run, the agent is told.
      const denied = await hub.call([c.id], "my-notes__echo", { text: "hi" }, "turn1");
      expect(denied.isError).toBe(true);
      expect(ask).toHaveBeenCalledWith({ turnId: "turn1", connectorId: c.id, connector: "My Notes", tool: "echo", args: { text: "hi" } });
      expect(mcp.calls).toHaveLength(0);
      // Ask → Allow once: run, still Ask.
      ask.mockResolvedValueOnce({ allow: true });
      expect((await hub.call([c.id], "my-notes__echo", { text: "once" }, "turn1")).content[0]).toEqual({ type: "text", text: 'echo: {"text":"once"}' });
      expect(hub.list()[0].tools[0].policy).toBe("ask");
      // Ask → Always allow: run, and Allow from now on (no more asking).
      ask.mockResolvedValueOnce({ allow: true, remember: true });
      await hub.call([c.id], "my-notes__echo", { text: "always" }, "turn1");
      expect(hub.list()[0].tools[0].policy).toBe("allow");
      ask.mockClear();
      await hub.call([c.id], "my-notes__echo", { text: "again" }, "turn2");
      expect(ask).not.toHaveBeenCalled();
      expect(mcp.calls.map((x) => x.args)).toEqual([{ text: "once" }, { text: "always" }, { text: "again" }]);
      // Off: not listed, refused.
      hub.update({ id: c.id, policies: { delete_all: "off" } });
      expect((await hub.toolsFor([c.id])).map((t) => t.name)).toEqual(["my-notes__echo"]);
      expect((await hub.call([c.id], "my-notes__delete_all", {}, "turn2")).isError).toBe(true);
      // A disabled connector offers nothing.
      hub.update({ id: c.id, enabled: false });
      expect(await hub.toolsFor([c.id])).toEqual([]);
      expect(hub.remove(c.id)).toEqual([]);
      expect(storage.keys.size).toBe(0);
    } finally {
      hub.close();
      await mcp.close();
    }
  });

  it("a wrong key: the connector's state says so", async () => {
    const mcp = await fakeMcp("right");
    const hub = new ConnectorHub({ storage: memoryStorage(), spawn: spawn as unknown as SpawnFn, env: () => process.env, cwd: work, ask: async () => ({ allow: false }) });
    try {
      const [c] = hub.add({ name: "Locked", transport: { kind: "http", url: mcp.url, key: "wrong" } });
      const t = await hub.test(c.id);
      expect(t.state).toBe("error");
      expect(t.error).toMatch(/401/);
    } finally {
      hub.close();
      await mcp.close();
    }
  });

  it("a stdio server: started, listed and called over newline-delimited JSON-RPC", async () => {
    const script = join(work, "stdio-mcp.cjs");
    writeFileSync(
      script,
      `let buf = "";
process.stdin.on("data", (d) => {
  buf += d;
  const lines = buf.split("\\n"); buf = lines.pop();
  for (const l of lines) {
    if (!l.trim()) continue;
    const m = JSON.parse(l);
    if (m.id === undefined) continue;
    const r = m.method === "initialize" ? { protocolVersion: "2025-06-18", capabilities: {} } : m.method === "tools/list" ? { tools: [{ name: "now", description: "The time" }] } : { content: [{ type: "text", text: "12:00" }] };
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: r }) + "\\n");
  }
});`
    );
    const hub = new ConnectorHub({ storage: memoryStorage(), spawn: spawn as unknown as SpawnFn, env: () => process.env, cwd: work, ask: async () => ({ allow: true }) });
    try {
      const [c] = hub.add({ name: "Clock", transport: { kind: "stdio", command: process.execPath, args: [script] } });
      expect((await hub.test(c.id)).tools).toEqual([{ name: "now", description: "The time", policy: "ask" }]);
      expect((await hub.call([c.id], "clock__now", {}, "t")).content).toEqual([{ type: "text", text: "12:00" }]);
    } finally {
      hub.close();
    }
  });

  it("through our MCP server: a chat with the connector lists and calls its tools (the consent round trip); an outside client doesn't see them", async () => {
    const mcp = await fakeMcp();
    const pendingAsk: ((a: { allow: boolean; remember?: boolean }) => void)[] = [];
    const hub = new ConnectorHub({ storage: memoryStorage(), spawn: spawn as unknown as SpawnFn, env: () => process.env, cwd: work, ask: () => new Promise((resolve) => pendingAsk.push(resolve)) });
    const [c] = hub.add({ name: "Notes", transport: { kind: "http", url: mcp.url } });
    const turnConnectors = new Map<string, string[]>([["turn9", [c.id]]]);
    const ours = new McpServer(
      {
        activeFileKey: () => "fileA",
        isOpen: () => true,
        extraTools: (session) => hub.toolsFor(session.chat?.connectors ?? []),
        runTool: async (_file, call) => {
          const ids = turnConnectors.get(call.turnId ?? "") ?? [];
          return hub.has(ids, call.name) ? hub.call(ids, call.name, call.args, call.turnId!) : { content: [{ type: "text", text: "design tool" }] };
        },
      },
      "outside-token"
    );
    await ours.start(0);
    try {
      const chatToken = ours.grantChat({ fileKey: "fileA", turnId: "turn9", client: "Claude Code", connectors: [c.id] });
      const post = async (token: string, body: unknown) => (await fetch(ours.url!, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify(body) })).json();
      const list = async (token: string) => ((await post(token, { jsonrpc: "2.0", id: 1, method: "tools/list" })) as { result: { tools: { name: string }[] } }).result.tools.map((t) => t.name);
      expect(await list(chatToken)).toContain("notes__echo");
      expect(await list(chatToken)).toContain("get_skill");
      expect(await list("outside-token")).not.toContain("notes__echo");
      // The call waits on the consent card; "Allow once" lets it through.
      const call = post(chatToken, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "notes__echo", arguments: { text: "from the agent" } } });
      await vi.waitFor(() => expect(pendingAsk).toHaveLength(1));
      expect(mcp.calls).toHaveLength(0);
      pendingAsk[0]({ allow: true });
      expect(((await call) as { result: { content: { text: string }[] } }).result.content[0].text).toBe('echo: {"text":"from the agent"}');
      // An outside client can't call a chat's connector tool.
      expect(((await post("outside-token", { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "notes__echo", arguments: {} } })) as { error?: unknown }).error).toBeTruthy();
    } finally {
      hub.close();
      await ours.stop();
      await mcp.close();
    }
  });
});
