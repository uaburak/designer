import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { AuthState, ChatEvent } from "../../../shared/agents/types";
import { SYSTEM_PROMPT } from "../../../shared/agents/prompts";
import { MCP_SERVER_NAME } from "../../../shared/agents/tools";
import { friendlyApiError } from "../../../shared/agents/errors";
import { promptWithContext, promptWithHistory, text, type AuthEnv, type CliModels, type CliSpec, type RunResult } from "./turns";

/**
 * Google Antigravity's CLI (`agy`, antigravity.google/docs/cli): how a Google AI Pro / Ultra plan reaches the chat
 * since Google ended Gemini CLI's personal sign-in (2026-06-18). Headless: `agy -p <prompt> --output-format
 * stream-json` (docs/cli/headless: `init`, `step_update` — one per step, ACTIVE then DONE / ERROR, text in
 * `text_delta`, a tool's call and result in `tool_info` — and `result`), the conversation continued with
 * `--conversation <id>`.
 *
 * Our server: the chat folder's `.agents/mcp_config.json` (docs/mcp: the workspace's file, `serverUrl` + `headers`),
 * under a name of its own — a user-scope server of the same name (the owner's "Connect" to Antigravity writes
 * "designer" to ~/.gemini/config/mcp_config.json) wins over a workspace one, and acts on whichever file is in front.
 *
 * Permissions: a headless run soft-denies whatever would ask, and agy reads no workspace settings file — only the user's
 * settings.json and a project's grants (~/.gemini/config/projects/<id>.json, `permissionGrants.permissionGrants`
 * {allow, deny, ask}, merged over the user's). So the turns run in a project of this app's own (`--project`): our
 * server's tools allowed, commands, unsandboxed commands and the web denied. Files inside the chat folder are the
 * workspace's (allowed by default); everything else still asks, so it is denied.
 *
 * Pictures: its generate_image tool (Google AI plans include it) saves into the conversation's folder,
 * ~/.gemini/antigravity-cli/brain/<conversation id>/ — `imageDirs` lets place_image read that folder of this chat's
 * conversation only.
 *
 * Sign-in: agy has no status command; `agy models` answers without asking the model and lists nothing when signed out
 * (it fetches the list with the account's sign-in); the account is in its log ("authenticated successfully as …").
 * Signing in and out is its interactive start in Terminal (a browser sign-in; `/logout`).
 */

/** Our server's name in the chat folder's MCP config. */
export const AGY_SERVER = `${MCP_SERVER_NAME}-chat`;
/** This app's project for its chats (its permission grants). */
export const AGY_PROJECT = "designerv2-agents";
export const AGY_DEFAULT_MODEL = "gemini-3.8-flash-medium";

const agyHome = (home: string) => join(home, ".gemini", "antigravity-cli");

/** The project file: the chats' folder, our server's tools allowed, commands and the web denied. */
export function agyProject(workDir: string): string {
  return JSON.stringify(
    {
      id: AGY_PROJECT,
      name: "DesignerV2 chats",
      projectResources: { resources: [{ folderUri: `file://${encodeURI(workDir)}` }] },
      permissionGrants: {
        permissionGrants: {
          allow: [`mcp(${AGY_SERVER}/*)`],
          deny: ["command(*)", "unsandboxed(*)", "read_url(*)", "execute_url(*)"],
        },
        v2Migrated: true,
      },
    },
    null,
    2
  );
}

/** `agy models`: one model a line, "slug<TAB>label". */
export function parseAgyModels(stdout: string): CliModels | null {
  const rows = stdout
    .split("\n")
    .map((l) => l.split("\t"))
    .filter((c) => c.length >= 2 && /^[\w.-]+$/.test(c[0].trim()))
    .map(([slug, label]) => [slug.trim(), label.trim()] as const);
  if (!rows.length) return null;
  const labels = Object.fromEntries(rows);
  const slugs = rows.map(([s]) => s);
  // Its default first (the picker's first is the agent's default).
  const first = slugs.includes(AGY_DEFAULT_MODEL) ? AGY_DEFAULT_MODEL : slugs[0];
  return { models: [first, ...slugs.filter((s) => s !== first)], labels };
}

/** The signed-in account from agy's newest logs. */
export function agyAccount(env: AuthEnv): string | undefined {
  const dir = join(agyHome(env.home), "log");
  const logs = (env.list?.(dir) ?? []).filter((f) => /^cli-.*\.log$/.test(f)).sort().reverse().slice(0, 4);
  for (const f of logs) {
    const m = /authenticated successfully as ([\w.+-]+@[\w-]+(?:\.[\w-]+)+)|applyAuthResult: email=([\w.+-]+@[\w-]+(?:\.[\w-]+)+)/.exec(env.readFile(join(dir, f)) ?? "");
    if (m) return m[1] ?? m[2];
  }
  return undefined;
}

export function agyStatus(r: RunResult, env?: AuthEnv): AuthState {
  if (r.code === 0 && parseAgyModels(r.stdout)) return { state: "connected", account: env ? agyAccount(env) : undefined, plan: "Google account" };
  const why = (r.stderr ?? "").split("\n").map((l) => l.trim()).filter((l) => l && !/^Fetching available models/i.test(l)).pop();
  return { state: "signed-out", detail: why ? why.slice(0, 200) : undefined };
}

/** Told to the agent on a chat's first turn, after the shared prompt. */
export const AGY_NOTE = `Your design tools are the tools of the "${AGY_SERVER}" MCP server (call_mcp_tool with ServerName "${AGY_SERVER}"). Use no other MCP server, no terminal and no browser.

Images: when the user wants a picture (a photo, an illustration, an icon as an image), make it with your generate_image tool — it saves the file in your conversation's folder and tells you its absolute path — then put it on the canvas with place_image. When a layer is selected (a frame — with auto layout too — a rectangle, an ellipse or any shape), fill that layer with the picture: place_image {path: "<that absolute path>", nodeId: "<the selected layer's id>"} — no new layer, no child. With nothing selected: place_image {path: "<that absolute path>"}. Use the file as it is: don't copy or convert it.`;

const BOOKKEEPING = new Set(["view_file", "list_dir", "find_by_name", "grep_search", "read_knowledge"]);
/** Its own coordination steps: notes to a subagent, a timer while one works. */
const INTERNAL = new Set(["send_message", "schedule", "command_status"]);

/** A tool step's name in the chat: our tool's own name for call_mcp_tool, a subagent's job for invoke_subagent. */
function stepTool(u: Record<string, unknown>): { name: string; args?: unknown; hidden: boolean } {
  const info = (u.tool_info ?? {}) as { name?: string; parameters?: Record<string, unknown> };
  const raw = text(u.tool_name) || text(info.name) || "tool";
  const params = info.parameters ?? {};
  if (raw === "call_mcp_tool") return { name: text(params.ToolName) || "tool", args: params.Arguments, hidden: false };
  if (u.step_type === "subagent") {
    const sub = ((u.subagent_info as { subagents?: { type_name?: string }[] } | undefined)?.subagents ?? [])[0];
    const kind = text(sub?.type_name);
    return { name: /image/i.test(kind) ? "generate_image" : kind || "subagent", hidden: false };
  }
  // Its own reads of its tool schemas and its conversation's logs (~/.gemini/antigravity-cli/…) and its coordination
  // steps aren't the user's business.
  const path = text(params.AbsolutePath) || text(params.DirectoryPath) || text(params.SearchPath);
  return { name: raw, args: params, hidden: INTERNAL.has(raw) || (BOOKKEEPING.has(raw) && /\/\.gemini\/antigravity-cli\//.test(path)) };
}

const firstLine = (s: string) => s.split("\n")[0].slice(0, 140) || undefined;

export const antigravity: CliSpec = {
  id: "antigravity",
  label: "Antigravity (Google AI)",
  note: "Google’s agent with your Google AI plan — Gemini models and image generation.",
  bins: ["agy"],
  models: [AGY_DEFAULT_MODEL, "gemini-3.8-flash-high", "gemini-3.8-flash-low", "gemini-3.1-pro-high", "gemini-3.1-pro-low"],
  plan: (t) => {
    const workDir = dirname(t.cwd);
    const home = t.home ?? homedir();
    const model = t.request.model && t.request.model !== "default" ? t.request.model : AGY_DEFAULT_MODEL;
    const prompt = t.request.resume
      ? promptWithContext(t.request)
      : `${SYSTEM_PROMPT.replace(`"${MCP_SERVER_NAME}" MCP tools`, `"${AGY_SERVER}" MCP tools`)}\n\n${AGY_NOTE}\n\n${promptWithHistory(t.request)}`;
    return {
      args: ["-p", prompt, "--output-format", "stream-json", "--model", model, "--project", AGY_PROJECT, ...(t.request.resume ? ["--conversation", t.request.resume] : [])],
      files: {
        ".agents/mcp_config.json": JSON.stringify({ mcpServers: { [AGY_SERVER]: { serverUrl: t.mcp.url, headers: { Authorization: `Bearer ${t.mcp.token}` } } } }),
        [join(home, ".gemini", "config", "projects", `${AGY_PROJECT}.json`)]: agyProject(workDir),
      },
    };
  },
  parse(line, state) {
    const out: ChatEvent[] = [];
    switch (line.event) {
      case "init": {
        const init = (line.init ?? {}) as { model?: string };
        if (typeof line.conversation_id === "string" && line.conversation_id) out.push({ type: "session", resume: line.conversation_id, model: text(init.model) || undefined });
        break;
      }
      case "step_update": {
        const u = (line.step_update ?? {}) as Record<string, unknown>;
        const step = `${text(u.conversation_id)}:${String(u.step_index)}`;
        if (u.step_type === "agent_response") {
          const delta = text(u.text_delta);
          if (!delta) break;
          // A reply after a tool is a new paragraph.
          if (state.textStep && state.textStep !== step && state.streamed) out.push({ type: "text", delta: "\n\n" });
          state.textStep = step;
          state.streamed = !delta.endsWith("\n\n");
          out.push({ type: "text", delta });
          break;
        }
        if (u.step_type !== "tool" && u.step_type !== "subagent") break;
        const known = state.tools.get(step);
        if (known === "") break;
        const t = stepTool(u);
        if (known === undefined) {
          state.tools.set(step, t.hidden ? "" : t.name);
          if (t.hidden) break;
        }
        const name = known || t.name;
        const info = (u.tool_info ?? {}) as { output?: unknown; error?: { message?: string } | string };
        if (u.state === "ACTIVE") out.push({ type: "tool", id: step, name, args: t.args, state: "running" });
        else if (u.state === "ERROR") {
          const why = typeof info.error === "string" ? info.error : text(info.error?.message) || text(info.output);
          out.push({ type: "tool", id: step, name, state: "error", summary: why ? friendlyApiError(firstLine(why) ?? why) : undefined });
        } else if (u.state === "DONE") out.push({ type: "tool", id: step, name, state: "done", summary: u.step_type === "subagent" ? undefined : firstLine(text(info.output)) });
        break;
      }
      case "result": {
        const r = (line.result ?? {}) as { status?: string; error?: unknown; response?: string; denied_actions?: { action?: string; display_name?: string }[] };
        if (r.status && r.status !== "SUCCESS") {
          const why = typeof r.error === "string" ? r.error : text((r.error as { message?: string } | undefined)?.message);
          out.push({ type: "error", message: r.status === "CANCELED" || r.status === "INTERRUPTED" ? "Antigravity stopped." : friendlyApiError(why) || `Antigravity stopped (${r.status}).` });
        } else if (!text(r.response).trim() && r.denied_actions?.length)
          out.push({ type: "error", message: `Antigravity wasn’t allowed to ${[...new Set(r.denied_actions.map((d) => d.display_name || d.action))].join(", ")} here.` });
        break;
      }
    }
    return out;
  },
  auth: {
    status: { args: ["models"], parse: agyStatus },
    login: { kind: "terminal", args: [], note: "Antigravity opens in Terminal: sign in with your Google account in the browser, then type /quit." },
    logout: { kind: "terminal", args: [], note: "Antigravity opens in Terminal: type /logout, then /quit." },
  },
  install: { command: "curl -fsSL https://antigravity.google/cli/install.sh | bash", page: "https://antigravity.google/docs/cli/install" },
  modelsFromStatus: (r) => (r.code === 0 ? parseAgyModels(r.stdout) : null),
  imageDirs: (session, home) => (/^[\w-]+$/.test(session) ? [join(agyHome(home), "brain", session)] : []),
};
