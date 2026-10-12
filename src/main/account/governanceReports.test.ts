import { afterEach, describe, expect, it } from "vitest";
import { McpServer } from "../agents/mcpServer";
import { FLUSH_AT, FLUSH_MS, GovernanceReports, setGovernanceReports } from "./governanceReports";

const setup = (orgs: Record<string, string | null>, signedIn = true) => {
  const posts: { path: string; body: { calls: unknown[] } }[] = [];
  const timers: { fn: () => void; ms: number; cleared: boolean }[] = [];
  const r = new GovernanceReports({
    signedIn: () => signedIn,
    orgOf: async (k) => orgs[k] ?? null,
    post: async (path, body) => void posts.push({ path, body: body as { calls: unknown[] } }),
    now: () => 1000,
    timers: {
      setTimeout: (fn, ms) => {
        const t = { fn, ms, cleared: false };
        timers.push(t);
        return t;
      },
      clearTimeout: (t) => void ((t as { cleared: boolean }).cleared = true),
    },
  });
  return { r, posts, timers };
};
const settle = () => new Promise((res) => setTimeout(res, 0));

afterEach(() => setGovernanceReports(null));

describe("governance reports", () => {
  it("batches MCP calls per org and flushes after 60 s", async () => {
    const { r, posts, timers } = setup({ a: "org1", b: "org2", c: null });
    r.mcpCall("a", "get_selection");
    r.mcpCall("a", "create_frame");
    r.mcpCall("b", "get_selection");
    r.mcpCall("c", "get_selection");
    await settle();
    expect(posts).toEqual([]);
    expect(timers.filter((t) => !t.cleared)).toHaveLength(1);
    expect(timers[0].ms).toBe(FLUSH_MS);
    timers[0].fn();
    await settle();
    expect(posts.map((p) => p.path).sort()).toEqual(["/orgs/org1/developer-logs/mcp", "/orgs/org2/developer-logs/mcp"]);
    expect(posts.find((p) => p.path.includes("org1"))!.body.calls).toEqual([
      { tool: "get_selection", fileKey: "a", at: 1000 },
      { tool: "create_frame", fileKey: "a", at: 1000 },
    ]);
  });

  it("flushes at 50 calls", async () => {
    const { r, posts } = setup({ a: "org1" });
    for (let i = 0; i < FLUSH_AT; i++) r.mcpCall("a", "t");
    await settle();
    expect(posts).toHaveLength(1);
    expect(posts[0].body.calls).toHaveLength(FLUSH_AT);
  });

  it("flushes on quit (drain) and cancels the timer", async () => {
    const { r, posts, timers } = setup({ a: "org1" });
    r.mcpCall("a", "t");
    await r.drain();
    expect(posts).toHaveLength(1);
    expect(timers[0].cleared).toBe(true);
    await r.drain();
    expect(posts).toHaveLength(1);
  });

  it("reports nothing for local files or when signed out", async () => {
    const local = setup({ a: null });
    local.r.mcpCall("a", "t");
    local.r.aiPrompt("a", "make it blue", "make-image");
    await local.r.drain();
    expect(local.posts).toEqual([]);
    const out = setup({ a: "org1" }, false);
    out.r.mcpCall("a", "t");
    out.r.aiPrompt("a", "hi", "x");
    await out.r.drain();
    expect(out.posts).toEqual([]);
  });

  it("posts an AI prompt once, at once, and never throws on a failing server", async () => {
    const { r, posts } = setup({ a: "org1" });
    r.aiPrompt("a", "Rename layers", "rename-layers");
    await settle();
    expect(posts).toEqual([{ path: "/orgs/org1/discovery/ai-prompt", body: { fileKey: "a", text: "Rename layers", feature: "rename-layers", at: 1000 } }]);
    const bad = new GovernanceReports({ signedIn: () => true, orgOf: async () => "o", post: async () => Promise.reject(new Error("down")) });
    bad.mcpCall("a", "t");
    bad.aiPrompt("a", "x", "y");
    await expect(bad.drain()).resolves.toBeUndefined();
  });

  it("a tool call on the MCP server reports the file and never fails", async () => {
    const { r, posts } = setup({ f1: "org1" });
    setGovernanceReports(r);
    const server = new McpServer({ activeFileKey: () => "f1", isOpen: () => true, runTool: async () => ({ content: [{ type: "text", text: "ok" }] }) }, "tok");
    const res = await server.call({ id: "s", client: "x", chat: null, fileKey: null, lastSeen: 0 }, "get_selection", {});
    expect(res.isError).toBeUndefined();
    await r.drain();
    expect(posts).toHaveLength(1);
    expect(posts[0].body.calls[0]).toMatchObject({ tool: "get_selection", fileKey: "f1" });
  });
});
