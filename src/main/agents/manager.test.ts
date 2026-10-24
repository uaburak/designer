// The manager in main (docs/studio.md §2.1–2.2): its tools listed for a manager's turn only and refused for a worker,
// a plain chat or an outside client (who has the library's alone, docs/social.md §21); several turns of one chat at once, each with its own grant; the settings cleaned.
import { afterEach, describe, expect, it } from "vitest";
import type { ToolResult } from "../../shared/agents/tools";
import { MANAGER_TOOLS, WAITING_TOOLS } from "../../shared/agents/tools";
import { cleanManagerName, cleanManagerSettings, cleanManagerTools } from "../../shared/agents/manager";
import { DEFAULT_MANAGER_SETTINGS } from "../../shared/studio/types";
import { McpServer } from "./mcpServer";

const TOKEN = "outside-token";
type RpcBody = { result: { tools: { name: string }[]; isError?: boolean; content: { text: string }[] }; error: { code: number } };
let servers: McpServer[] = [];
afterEach(async () => {
  await Promise.all(servers.map((s) => s.stop()));
  servers = [];
});

async function start() {
  const calls: { name: string; turnId: string | null }[] = [];
  const server = new McpServer(
    {
      activeFileKey: () => "fileA",
      isOpen: () => true,
      runTool: async (_k, call): Promise<ToolResult> => {
        calls.push({ name: call.name, turnId: call.turnId });
        return { content: [{ type: "text", text: `${call.name} ran` }] };
      },
    },
    TOKEN
  );
  servers.push(server);
  await server.start(0);
  const post = async (token: string, body: unknown, session?: string) => {
    const r = await fetch(server.url!, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, ...(session ? { "Mcp-Session-Id": session } : {}) }, body: JSON.stringify(body) });
    return { session: r.headers.get("mcp-session-id"), body: (await r.json().catch(() => null)) as RpcBody };
  };
  const open = async (token: string) => (await post(token, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", clientInfo: { name: "claude-code" } } })).session!;
  const list = async (token: string) => {
    const s = await open(token);
    return ((await post(token, { jsonrpc: "2.0", id: 2, method: "tools/list" }, s)).body.result.tools as { name: string }[]).map((t) => t.name);
  };
  const call = async (token: string, name: string) => {
    const s = await open(token);
    return (await post(token, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name, arguments: {} } }, s)).body;
  };
  return { server, calls, list, call };
}

const libraryTool = { name: "library_find", description: "Finds brands", inputSchema: { type: "object", properties: {} } };

describe("manager-only tools", () => {
  it("are listed and answered for a manager's turn, refused for its workers, a plain chat and outside clients", async () => {
    const { server, calls, list, call } = await start();
    const managerTools = [...MANAGER_TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })), libraryTool];
    const manager = server.grantChat({ fileKey: "fileA", turnId: "m1", client: "Claude Code", role: "manager", managerTools });
    const worker = server.grantChat({ fileKey: "fileA", turnId: "w1", client: "Claude Code", role: "worker" });
    const chat = server.grantChat({ fileKey: "fileA", turnId: "c1", client: "Claude Code" });
    const names = await list(manager);
    expect(names).toEqual(expect.arrayContaining(["delegate_task", "wait_tasks", "make_posts", "report_review", "library_find", "get_selection"]));
    for (const t of [worker, chat, TOKEN]) {
      const l = await list(t);
      expect(l).toContain("create_nodes");
      expect(l).not.toContain("delegate_task");
      // The Brands library is the owner's to fill from his own outside client (docs/social.md §21), not a worker's or a chat's.
      if (t === TOKEN) expect(l).toEqual(expect.arrayContaining(["library_find", "library_save_brand", "library_save_product"]));
      else expect(l).not.toContain("library_find");
    }
    expect((await call(manager, "delegate_task")).result.content[0].text).toBe("delegate_task ran");
    expect(calls).toEqual([{ name: "delegate_task", turnId: "m1" }]);
    const refused = await call(worker, "delegate_task");
    expect(refused.result.isError).toBe(true);
    expect(refused.result.content[0].text).toMatch(/manager's tool/);
    expect((await call(TOKEN, "make_posts")).result.isError).toBe(true);
    // A library tool is unknown to a worker; an outside client's call reaches the editor without a turn.
    expect((await call(worker, "library_find")).error.code).toBe(-32602);
    expect((await call(TOKEN, "library_find")).result.content[0].text).toBe("library_find ran");
    expect(calls).toEqual([{ name: "delegate_task", turnId: "m1" }, { name: "library_find", turnId: null }]);
    calls.splice(1);
    // The worker's own turn and the manager's run side by side, each with its turn id.
    await call(worker, "get_selection");
    await call(manager, "get_selection");
    expect(calls.slice(1)).toEqual([{ name: "get_selection", turnId: "w1" }, { name: "get_selection", turnId: "m1" }]);
  });

  it("the waiting tools get the long timeout", () => {
    expect([...WAITING_TOOLS].sort()).toEqual(["ask_choice", "export_animation", "export_posts", "library_read_labels", "make_brand_library", "make_posts", "report_review", "show_form", "wait_tasks"]);
  });
});

describe("manager settings and tools from a view", () => {
  it("cleans every field, keeps what is valid over the stored settings, defaults the rest", () => {
    expect(cleanManagerSettings(undefined)).toEqual(DEFAULT_MANAGER_SETTINGS);
    const base = cleanManagerSettings({ enabled: false, parallel: 2 });
    expect(base).toMatchObject({ enabled: false, parallel: 2, manager: DEFAULT_MANAGER_SETTINGS.manager });
    const next = cleanManagerSettings({ parallel: 9, image: { providerId: "gemini-images", model: "m", extra: 1 }, allowed: ["claude-code", 5, "claude-code"], general: { providerId: "" } }, base);
    expect(next).toEqual({ ...base, parallel: 4, image: { providerId: "gemini-images", model: "m" }, allowed: ["claude-code"], general: base.general });
    expect(cleanManagerSettings({ image: null, parallel: 0 }, next)).toMatchObject({ image: null, parallel: 1 });
  });

  it("the manager's name: kept clean, a missing or empty one (settings from before names) is the default", () => {
    expect(DEFAULT_MANAGER_SETTINGS.name).toBe("Manager");
    // Settings kept before the name existed: the default name.
    const { name: _name, ...old } = DEFAULT_MANAGER_SETTINGS;
    expect(cleanManagerSettings(old).name).toBe("Manager");
    expect(cleanManagerSettings({ enabled: false }).name).toBe("Manager");
    // A chosen name: one line, trimmed, at most 40 characters; kept over the stored one.
    const named = cleanManagerSettings({ name: "  Ada \n Lovelace  " });
    expect(named.name).toBe("Ada Lovelace");
    expect(cleanManagerSettings({ parallel: 2 }, named).name).toBe("Ada Lovelace");
    expect(cleanManagerSettings({ name: "" }, named).name).toBe("Ada Lovelace");
    expect(cleanManagerSettings({ name: 42 }, named).name).toBe("Ada Lovelace");
    expect(cleanManagerSettings({ name: "x".repeat(60) }).name).toHaveLength(40);
    expect(cleanManagerName("a\u0007b")).toBe("ab");
    expect(cleanManagerName("   ")).toBeNull();
    // A base without a name (an older settings file read as the base) still gives the default.
    expect(cleanManagerSettings({}, old as typeof DEFAULT_MANAGER_SETTINGS).name).toBe("Manager");
  });

  it("manager tools: MCP names, schemas as objects, no duplicates", () => {
    const tools = cleanManagerTools([libraryTool, { ...libraryTool }, { name: "Bad Name", description: "", inputSchema: {} }, { name: "x_y", description: "d", inputSchema: [] }, "nope"]);
    expect(tools.map((t) => t.name)).toEqual(["library_find"]);
  });
});
