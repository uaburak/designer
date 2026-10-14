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
  // Writes name their targets: a tool given no ids (or an empty list) acts on the user's selection — a script must
  // never do that (an empty list once moved the owner's selected screen into an icon component).
  const TARGETS = { reparent_nodes: ["nodeIds"], delete_nodes: ["nodeIds"], duplicate_nodes: ["nodeIds"], set_properties: ["nodeIds", "nodeId"], bind_variable: ["nodeIds", "nodeId"], apply_variable: ["nodeIds", "nodeId"], apply_style: ["nodeIds"], set_variable_mode: ["nodeIds", "nodeId"], set_auto_layout: ["nodeId"], create_nodes: ["parentId"], place_image: ["parentId", "nodeId"] };
  const named = (name, args) => {
    const keys = TARGETS[name];
    if (name === "run_command" && args.command && !(Array.isArray(args.nodeIds) && args.nodeIds.length)) return false;
    if (name === "run_command" && Array.isArray(args.nodeIds) && !args.nodeIds.length) return false;
    if (!keys) return true;
    return keys.some((k) => (Array.isArray(args[k]) ? args[k].length > 0 : typeof args[k] === "string" && args[k].length > 0));
  };
  /**
   * The page a layer is on: each page's outline read in pieces (get_metadata trims a large answer, saying so), cached;
   * read again once on a miss.
   */
  let pageIndex = null;
  const outline = async (id) => String((await rpc("tools/call", { name: "get_metadata", arguments: { nodeId: id, depth: 40 } })).content[0].text);
  const scanInto = async (id, page, depth = 0) => {
    const xml = await outline(id);
    for (const m of xml.matchAll(/ id="([^"]+)"/g)) pageIndex.set(m[1], page);
    if (!/left out/.test(xml) || depth > 6) return;
    // Trimmed: the direct children, each read on its own
    const kids = [...String((await rpc("tools/call", { name: "get_metadata", arguments: { nodeId: id, depth: 1 } })).content[0].text).matchAll(/^ {2}<\w+ id="([^"]+)"/gm)].map((m) => m[1]);
    for (const k of kids) if (!k.startsWith("I")) await scanInto(k, page, depth + 1);
  };
  const pageOf = async (id) => {
    if (pageIndex?.has(id)) return pageIndex.get(id);
    pageIndex = pageIndex ?? new Map();
    const sel = await rpc("tools/call", { name: "get_selection", arguments: {} });
    for (const p of JSON.parse(sel.content[0].text).pages) {
      pageIndex.set(p.id, p.name);
      await scanInto(p.id, p.name);
      if (pageIndex.has(id)) break;
    }
    return pageIndex.get(id) ?? null;
  };
  const call = async (name, args = {}, { soft = false, page = null } = {}) => {
    if (!READS.has(name) && !named(name, args)) throw new Error(`${name}: refused by the script's guard — a write must name its targets (no ids = the user's selection): ${JSON.stringify(args).slice(0, 200)}`);
    if (page) {
      for (const k of ["parentId", "nodeId"]) {
        if (typeof args[k] !== "string") continue;
        const on = await pageOf(args[k]);
        if (on !== page && args[k] !== page) throw new Error(`${name}: refused by the script's guard — ${k} ${args[k]} is on "${on}", not "${page}"`);
      }
    }
    const gap = PACE - (Date.now() - last);
    if (gap > 0) await new Promise((r) => setTimeout(r, gap));
    if (!READS.has(name)) await healthy();
    last = Date.now();
    const r = await rpc("tools/call", { name, arguments: args });
    const out = r.content.map((c) => (c.type === "text" ? tryJson(c.text) : { image: c.data, mimeType: c.mimeType }));
    if (page && pageIndex && !r.isError) for (const o of out) for (const n of o?.nodes ?? o?.copies ?? []) if (n?.nodeId || n?.id) pageIndex.set(n.nodeId ?? n.id, page);
    if (r.isError && !soft) throw new Error(`${name}: ${typeof out[0] === "string" ? out[0] : JSON.stringify(out[0]).slice(0, 2000)}`);
    return out.length === 1 ? out[0] : out;
  };
  return { call, rpc, healthy, pageOf };
}

const tryJson = (t) => {
  try {
    return JSON.parse(t);
  } catch {
    return t;
  }
};
