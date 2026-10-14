// A tiny MCP client for Wecra's server (src/main/agents/mcpServer.ts): JSON-RPC over POST, Bearer token, Mcp-Session-Id.
// The url and token come from ~/.claude.json → mcpServers.designer (written by Agents › Set up agents › Claude Code).
import { readFileSync } from "node:fs";
import { homedir } from "node:os";

export function endpoint() {
  const cfg = JSON.parse(readFileSync(`${homedir()}/.claude.json`, "utf8")).mcpServers?.designer;
  if (!cfg?.url) throw new Error("No designer MCP server in ~/.claude.json: Agents › Set up agents for MCP › Claude Code in Wecra");
  return { url: cfg.url, auth: cfg.headers?.Authorization ?? cfg.headers?.authorization };
}

export async function connect() {
  const { url, auth } = endpoint();
  let session = null;
  let id = 0;
  const rpc = async (method, params) => {
    const headers = { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: auth };
    if (session) headers["Mcp-Session-Id"] = session;
    const res = await fetch(url, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }) });
    session = res.headers.get("mcp-session-id") ?? session;
    const body = await res.json();
    if (body.error) throw new Error(`${method}: ${body.error.message}`);
    return body.result;
  };
  await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "claude-code-ui-kit", version: "1" } });
  // Pacing (the app draws every change; a burst of writes can stall its editor): a pause between calls, and before
  // every write a cheap round-trip (get_selection) — while it is slow, wait and back off.
  const PACE = Number(process.env.UIKIT_PACE_MS ?? 60);
  const READS = new Set(["get_selection", "get_metadata", "get_design_context", "get_screenshot", "get_variable_defs", "describe_schema", "list_commands"]);
  let last = 0;
  const healthy = async () => {
    for (let wait = 500; ; wait = Math.min(wait * 2, 15000)) {
      const t = Date.now();
      await rpc("tools/call", { name: "get_selection", arguments: {} });
      const rtt = Date.now() - t;
      if (rtt < 400) return rtt;
      console.warn(`app slow (${rtt} ms): waiting ${wait} ms`);
      await new Promise((r) => setTimeout(r, wait));
    }
  };
  /** A tool call: the parsed JSON of its text (or the text), images as {image}; throws on isError unless `soft`. */
  const call = async (name, args = {}, { soft = false } = {}) => {
    const gap = PACE - (Date.now() - last);
    if (gap > 0) await new Promise((r) => setTimeout(r, gap));
    if (!READS.has(name)) await healthy();
    last = Date.now();
    const r = await rpc("tools/call", { name, arguments: args });
    const out = r.content.map((c) => (c.type === "text" ? tryJson(c.text) : { image: c.data, mimeType: c.mimeType }));
    if (r.isError && !soft) throw new Error(`${name}: ${typeof out[0] === "string" ? out[0] : JSON.stringify(out[0]).slice(0, 2000)}`);
    return out.length === 1 ? out[0] : out;
  };
  return { call, rpc, healthy };
}

const tryJson = (t) => {
  try {
    return JSON.parse(t);
  } catch {
    return t;
  }
};
