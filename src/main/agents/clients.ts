import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { MCP_SERVER_NAME } from "../../shared/agents/tools";
import type { ConnectResult, McpClientId, McpClientInfo } from "../../shared/agents/types";

/**
 * "Connect to …" (the Agents tab's MCP setup, as Figma's "Set up agents for Figma MCP"): our server's entry written
 * into an MCP client's own config file, each in the format its docs give (docs/research/figma/R12-agents-mcp.md §4) —
 * after the user confirmed, with the file copied aside first (`<file>.designer-backup`), and nothing but our entry
 * touched. "Copy config" gives the same entry as text.
 */

export interface ClientEnv {
  home: string;
  /** An executable on PATH (or the usual places), or null */
  which(bin: string): string | null;
  exists(path: string): boolean;
}

export interface Endpoint {
  url: string;
  token: string;
}

interface ClientSpec {
  id: McpClientId;
  label: string;
  /** Config files written (the first is shown; others are written when they exist) */
  paths(env: ClientEnv): string[];
  installed(env: ClientEnv): boolean;
  format: "json" | "toml";
  /** The JSON key holding servers, and our entry */
  key?: string;
  entry(ep: Endpoint): Record<string, unknown>;
}

const auth = (ep: Endpoint) => ({ Authorization: `Bearer ${ep.token}` });
const apps = (env: ClientEnv, ...names: string[]) => names.some((n) => env.exists(join("/Applications", n)) || env.exists(join(env.home, "Applications", n)));

export const CLIENTS: ClientSpec[] = [
  {
    id: "claude-code",
    label: "Claude Code",
    // User scope (`claude mcp add -s user`): ~/.claude.json's top-level mcpServers.
    paths: (env) => [join(env.home, ".claude.json")],
    installed: (env) => !!env.which("claude"),
    format: "json",
    key: "mcpServers",
    entry: (ep) => ({ type: "http", url: ep.url, headers: auth(ep) }),
  },
  {
    id: "cursor",
    label: "Cursor",
    paths: (env) => [join(env.home, ".cursor", "mcp.json")],
    installed: (env) => apps(env, "Cursor.app") || env.exists(join(env.home, ".cursor")),
    format: "json",
    key: "mcpServers",
    entry: (ep) => ({ url: ep.url, headers: auth(ep) }),
  },
  {
    id: "vscode",
    label: "VS Code",
    paths: (env) => [join(env.home, "Library", "Application Support", "Code", "User", "mcp.json")],
    installed: (env) => apps(env, "Visual Studio Code.app") || env.exists(join(env.home, "Library", "Application Support", "Code", "User")),
    format: "json",
    key: "servers",
    entry: (ep) => ({ type: "http", url: ep.url, headers: auth(ep) }),
  },
  {
    id: "antigravity",
    label: "Antigravity",
    // The documented global file; the app's and the IDE's older folders get the entry too when they have a config.
    paths: (env) => {
      const main = join(env.home, ".gemini", "config", "mcp_config.json");
      const more = [join(env.home, ".gemini", "antigravity", "mcp_config.json"), join(env.home, ".gemini", "antigravity-ide", "mcp_config.json")].filter((p) => env.exists(p));
      return [main, ...more];
    },
    installed: (env) => apps(env, "Antigravity.app", "Antigravity IDE.app") || env.exists(join(env.home, ".gemini", "antigravity")),
    format: "json",
    key: "mcpServers",
    entry: (ep) => ({ serverUrl: ep.url, headers: auth(ep) }),
  },
  {
    id: "codex",
    label: "Codex",
    paths: (env) => [join(env.home, ".codex", "config.toml")],
    installed: (env) => !!env.which("codex") || env.exists(join(env.home, ".codex")),
    format: "toml",
    entry: (ep) => ({ url: ep.url, http_headers: auth(ep) }),
  },
];

const spec = (id: McpClientId) => {
  const s = CLIENTS.find((c) => c.id === id);
  if (!s) throw new Error(`Unknown client ${id}`);
  return s;
};

const tomlString = (s: string) => JSON.stringify(s);

/** Our `[mcp_servers.designer]` table for Codex. */
export function codexTable(ep: Endpoint): string {
  return `[mcp_servers.${MCP_SERVER_NAME}]\nurl = ${tomlString(ep.url)}\nhttp_headers = { Authorization = ${tomlString(`Bearer ${ep.token}`)} }\n`;
}

/** A TOML file with our table replaced (or added), other tables as they were. */
export function mergeToml(text: string, table: string): string {
  const header = new RegExp(`^\\[mcp_servers\\.${MCP_SERVER_NAME}\\]\\s*$`, "m");
  const m = header.exec(text);
  if (!m) return (text.trimEnd() ? `${text.trimEnd()}\n\n` : "") + table;
  const after = text.slice(m.index + m[0].length);
  const next = /^\[/m.exec(after);
  const end = next ? m.index + m[0].length + next.index : text.length;
  return text.slice(0, m.index) + table + (next ? "\n" : "") + text.slice(end);
}

/** The entry as the text "Copy config" puts on the clipboard. */
export function configText(id: McpClientId, ep: Endpoint, env: ClientEnv): { path: string; text: string } {
  const s = spec(id);
  const path = s.paths(env)[0];
  if (s.format === "toml") return { path, text: codexTable(ep) };
  return { path, text: JSON.stringify({ [s.key!]: { [MCP_SERVER_NAME]: s.entry(ep) } }, null, 2) };
}

function readJson(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  const text = readFileSync(path, "utf8");
  if (!text.trim()) return {};
  const v = JSON.parse(text) as unknown;
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("not a JSON object");
  return v as Record<string, unknown>;
}

function atomicWrite(path: string, text: string) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.designer-tmp`;
  writeFileSync(tmp, text, { mode: 0o600 });
  renameSync(tmp, path);
}

/** Writes our entry into every config file of the client (backing each up first). */
export function connectClient(id: McpClientId, ep: Endpoint, env: ClientEnv): ConnectResult {
  const s = spec(id);
  const paths = s.paths(env);
  let backup: string | undefined;
  try {
    for (const path of paths) {
      const existed = existsSync(path);
      let next: string;
      if (s.format === "toml") {
        next = mergeToml(existed ? readFileSync(path, "utf8") : "", codexTable(ep));
      } else {
        const json = readJson(path);
        const servers = json[s.key!] && typeof json[s.key!] === "object" && !Array.isArray(json[s.key!]) ? { ...(json[s.key!] as Record<string, unknown>) } : {};
        servers[MCP_SERVER_NAME] = s.entry(ep);
        json[s.key!] = servers;
        next = `${JSON.stringify(json, null, 2)}\n`;
      }
      if (existed) {
        const b = `${path}.designer-backup`;
        copyFileSync(path, b);
        backup ??= b;
      }
      atomicWrite(path, next);
    }
    return { ok: true, path: paths[0], backup };
  } catch (err) {
    return { ok: false, path: paths[0], backup, error: `${paths[0]}: ${err instanceof Error ? err.message : String(err)} — use Copy config instead.` };
  }
}

/** Takes our entry out again. */
export function disconnectClient(id: McpClientId, env: ClientEnv): ConnectResult {
  const s = spec(id);
  const paths = s.paths(env);
  try {
    for (const path of paths) {
      if (!existsSync(path)) continue;
      copyFileSync(path, `${path}.designer-backup`);
      if (s.format === "toml") {
        const text = readFileSync(path, "utf8");
        atomicWrite(path, mergeToml(text, "").replace(/\n{3,}/g, "\n\n"));
      } else {
        const json = readJson(path);
        const servers = json[s.key!] as Record<string, unknown> | undefined;
        if (servers && MCP_SERVER_NAME in servers) {
          delete servers[MCP_SERVER_NAME];
          atomicWrite(path, `${JSON.stringify(json, null, 2)}\n`);
        }
      }
    }
    return { ok: true, path: paths[0] };
  } catch (err) {
    return { ok: false, path: paths[0], error: err instanceof Error ? err.message : String(err) };
  }
}

/** Whether a client's config has our server at `url`. */
function isConnected(s: ClientSpec, env: ClientEnv, url: string | null): boolean {
  const path = s.paths(env)[0];
  if (!url || !env.exists(path)) return false;
  try {
    if (s.format === "toml") return readFileSync(path, "utf8").includes(`[mcp_servers.${MCP_SERVER_NAME}]`) && readFileSync(path, "utf8").includes(url);
    const servers = readJson(path)[s.key!] as Record<string, Record<string, unknown>> | undefined;
    const e = servers?.[MCP_SERVER_NAME];
    return !!e && Object.values(e).includes(url);
  } catch {
    return false;
  }
}

export function listClients(env: ClientEnv, url: string | null): McpClientInfo[] {
  return CLIENTS.map((s) => ({ id: s.id, label: s.label, installed: s.installed(env), configPath: s.paths(env)[0], connected: isConnected(s, env, url) }));
}
