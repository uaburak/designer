import type { ChatEvent, TurnRequest } from "../../shared/agents/types";
import { SYSTEM_PROMPT } from "../../shared/agents/prompts";
import { MCP_SERVER_NAME } from "../../shared/agents/tools";

/**
 * The CLI agents the Agents tab drives headless (docs/research/figma/R12-agents-mcp.md §4): each runs in an empty
 * working folder of its own with no tools but our MCP server's — Claude Code (`claude -p --output-format
 * stream-json`), Codex (`codex exec --json`), Gemini CLI (`gemini -p --output-format stream-json`), Cursor's CLI
 * (`agent -p --output-format stream-json`). What a spec says: how to find it, its arguments for a turn, the files it
 * reads its MCP config from, and how its JSON lines become the chat's events. Electron-free (tested with recorded
 * output).
 */

export interface McpEndpoint {
  url: string;
  token: string;
}

export interface CliTurn {
  request: TurnRequest;
  mcp: McpEndpoint;
  /** The empty folder the CLI runs in */
  cwd: string;
  /** A new session id for the CLI (Claude Code `--session-id`), when the chat has none yet */
  sessionId: string;
  /** The MCP config file written for this turn (Claude Code `--mcp-config`) */
  mcpConfigPath: string;
}

export interface CliPlan {
  args: string[];
  /** The prompt on stdin (else it is in args) */
  stdin?: string;
  env?: Record<string, string>;
  /** Files written into cwd before the run (the CLI's project MCP config), mode 0600 */
  files?: Record<string, string>;
}

/** A parser's memory across the lines of one run. */
export interface ParseState {
  /** Text already streamed for the current message (a full message after partial deltas isn't repeated) */
  streamed: boolean;
  tools: Map<string, string>;
}

export interface CliSpec {
  id: "claude-code" | "codex" | "gemini" | "cursor-agent";
  label: string;
  /** Executable names, first found wins */
  bins: string[];
  models: string[];
  plan(turn: CliTurn): CliPlan;
  parse(line: Record<string, unknown>, state: ParseState): ChatEvent[];
}

/** The turn's prompt: the selection attached as context, then what the user typed. */
export function promptWithContext(r: TurnRequest): string {
  const c = r.context;
  const sel = c.selection.length
    ? c.selection.map((s) => `${s.type.toLowerCase()} "${s.name}" (id ${s.id}, ${Math.round(s.width)} × ${Math.round(s.height)})`).join(", ")
    : "nothing";
  return `[Design file "${c.fileName}", page "${c.pageName}". Selected: ${sel}.]\n\n${r.prompt}`;
}

/** A chat without a CLI session of its own: the conversation so far, then the turn. */
export function promptWithHistory(r: TurnRequest): string {
  const past = r.history.slice(-12).map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.text}`).join("\n\n");
  return (past ? `Conversation so far:\n${past}\n\n` : "") + promptWithContext(r);
}

const mcpServers = (mcp: McpEndpoint) => ({ [MCP_SERVER_NAME]: { type: "http", url: mcp.url, headers: { Authorization: `Bearer ${mcp.token}` } } });

const shortToolName = (name: unknown) => String(name ?? "").replace(/^mcp__[^_]+(?:_[^_]+)*?__/, "").replace(new RegExp(`^${MCP_SERVER_NAME}[._/]`), "");

const text = (v: unknown) => (typeof v === "string" ? v : "");

export const claudeCode: CliSpec = {
  id: "claude-code",
  label: "Claude Code",
  bins: ["claude"],
  models: ["default", "sonnet", "opus", "haiku"],
  plan: (t) => ({
    args: [
      "-p",
      "--output-format", "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--mcp-config", t.mcpConfigPath,
      "--strict-mcp-config",
      // No built-in tools (no shell, files or web): only the design tools, allowed without asking.
      "--tools", "",
      "--allowedTools", `mcp__${MCP_SERVER_NAME}`,
      "--permission-mode", "dontAsk",
      "--append-system-prompt", SYSTEM_PROMPT,
      ...(t.request.model && t.request.model !== "default" ? ["--model", t.request.model] : []),
      ...(t.request.resume ? ["--resume", t.request.resume] : ["--session-id", t.sessionId]),
    ],
    stdin: promptWithContext(t.request),
    files: { [t.mcpConfigPath]: JSON.stringify({ mcpServers: mcpServers(t.mcp) }) },
  }),
  parse(line, state) {
    const out: ChatEvent[] = [];
    switch (line.type) {
      case "system":
        if (line.subtype === "init") {
          if (typeof line.session_id === "string") out.push({ type: "session", resume: line.session_id, model: text(line.model) || undefined });
          const servers = Array.isArray(line.mcp_servers) ? (line.mcp_servers as { name?: string; status?: string }[]) : [];
          const ours = servers.find((s) => s.name === MCP_SERVER_NAME);
          if (ours && ours.status !== "connected") out.push({ type: "error", message: `Claude Code couldn't connect to the design tools (${ours.status}).` });
        }
        break;
      case "stream_event": {
        const ev = line.event as { type?: string; delta?: { type?: string; text?: string } } | undefined;
        if (ev?.type === "content_block_delta" && ev.delta?.type === "text_delta" && ev.delta.text) {
          state.streamed = true;
          out.push({ type: "text", delta: ev.delta.text });
        } else if (ev?.type === "message_start") state.streamed = false;
        break;
      }
      case "assistant": {
        const content = ((line.message as { content?: unknown[] } | undefined)?.content ?? []) as { type?: string; text?: string; id?: string; name?: string; input?: unknown }[];
        for (const b of content) {
          // The CLI's own sign-in notice comes as a message too: the result's error says it once.
          if (b.type === "text" && b.text && !state.streamed && !/^Not logged in/i.test(b.text)) out.push({ type: "text", delta: b.text });
          if (b.type === "tool_use" && b.id) {
            const name = shortToolName(b.name);
            state.tools.set(b.id, name);
            out.push({ type: "tool", id: b.id, name, args: b.input, state: "running" });
          }
        }
        state.streamed = false;
        break;
      }
      case "user": {
        const content = ((line.message as { content?: unknown[] } | undefined)?.content ?? []) as { type?: string; tool_use_id?: string; is_error?: boolean; content?: unknown }[];
        for (const b of content)
          if (b.type === "tool_result" && b.tool_use_id) out.push({ type: "tool", id: b.tool_use_id, name: state.tools.get(b.tool_use_id) ?? "tool", state: b.is_error ? "error" : "done", summary: summarize(b.content) });
        break;
      }
      case "result":
        if (line.is_error || (typeof line.subtype === "string" && line.subtype.startsWith("error"))) {
          const why = text(line.result);
          out.push({ type: "error", message: /not logged in|\/login/i.test(why) ? "Claude Code isn’t signed in on this computer. Open Terminal, run “claude” and sign in with /login, then try again." : why || `Claude Code stopped (${String(line.subtype)}).` });
        }
        break;
    }
    return out;
  },
};

/** A tool result's first line, for the activity row. */
function summarize(content: unknown): string | undefined {
  const first = Array.isArray(content) ? (content as { type?: string; text?: string }[]).find((c) => c.type === "text")?.text : typeof content === "string" ? content : undefined;
  return first ? first.split("\n")[0].slice(0, 140) : undefined;
}

export const codex: CliSpec = {
  id: "codex",
  label: "Codex",
  bins: ["codex"],
  models: ["default"],
  plan: (t) => ({
    args: [
      "exec",
      "--json",
      "--skip-git-repo-check",
      "--sandbox", "read-only",
      "-c", `mcp_servers.${MCP_SERVER_NAME}.url="${t.mcp.url}"`,
      "-c", `mcp_servers.${MCP_SERVER_NAME}.bearer_token_env_var="DESIGNER_MCP_TOKEN"`,
      ...(t.request.model && t.request.model !== "default" ? ["-m", t.request.model] : []),
      "-",
    ],
    stdin: `${SYSTEM_PROMPT}\n\n${promptWithHistory(t.request)}`,
    env: { DESIGNER_MCP_TOKEN: t.mcp.token },
  }),
  parse(line) {
    const out: ChatEvent[] = [];
    const item = line.item as { id?: string; type?: string; text?: string; tool?: string; arguments?: unknown; status?: string; error?: unknown } | undefined;
    if (line.type === "thread.started" && typeof line.thread_id === "string") out.push({ type: "session", resume: line.thread_id });
    if ((line.type === "item.started" || line.type === "item.completed") && item) {
      if (item.type === "agent_message" && line.type === "item.completed" && item.text) out.push({ type: "text", delta: item.text });
      if (item.type === "mcp_tool_call" && item.id)
        out.push({ type: "tool", id: item.id, name: shortToolName(item.tool), args: item.arguments, state: line.type === "item.started" ? "running" : item.status === "failed" || item.error ? "error" : "done" });
    }
    if (line.type === "turn.failed" || line.type === "error") out.push({ type: "error", message: text((line.error as { message?: string } | undefined)?.message) || text(line.message) || "Codex failed." });
    return out;
  },
};

export const gemini: CliSpec = {
  id: "gemini",
  label: "Gemini CLI",
  bins: ["gemini"],
  models: ["default", "gemini-2.5-pro", "gemini-2.5-flash"],
  plan: (t) => ({
    args: ["-p", `${SYSTEM_PROMPT}\n\n${promptWithHistory(t.request)}`, "--output-format", "stream-json", "--allowed-mcp-server-names", MCP_SERVER_NAME, "--yolo", ...(t.request.model && t.request.model !== "default" ? ["-m", t.request.model] : [])],
    env: { DESIGNER_MCP_TOKEN: t.mcp.token },
    // The project settings Gemini CLI reads from its working folder: our server, Streamable HTTP (`httpUrl`).
    files: { ".gemini/settings.json": JSON.stringify({ mcpServers: { [MCP_SERVER_NAME]: { httpUrl: t.mcp.url, headers: { Authorization: `Bearer ${t.mcp.token}` }, trust: true } }, tools: { core: [] } }) },
  }),
  parse(line, state) {
    const out: ChatEvent[] = [];
    if (line.type === "init" && typeof line.session_id === "string") out.push({ type: "session", resume: line.session_id, model: text(line.model) || undefined });
    if (line.type === "message" && line.role === "assistant") {
      const content = text(line.content);
      if (content) {
        state.streamed = true;
        out.push({ type: "text", delta: content });
      }
    }
    if (line.type === "tool_use") {
      const id = text(line.tool_id) || `${state.tools.size}`;
      state.tools.set(id, shortToolName(line.tool_name));
      out.push({ type: "tool", id, name: shortToolName(line.tool_name), args: line.parameters, state: "running" });
    }
    if (line.type === "tool_result") {
      const id = text(line.tool_id);
      out.push({ type: "tool", id, name: state.tools.get(id) ?? "tool", state: line.status === "error" ? "error" : "done" });
    }
    if (line.type === "error") out.push({ type: "error", message: text(line.message) || "Gemini CLI failed." });
    return out;
  },
};

export const cursorAgent: CliSpec = {
  id: "cursor-agent",
  label: "Cursor Agent",
  bins: ["cursor-agent", "agent"],
  models: ["default"],
  plan: (t) => ({
    args: ["-p", "--output-format", "stream-json", "--stream-partial-output", "--force", "--approve-mcps", ...(t.request.model && t.request.model !== "default" ? ["--model", t.request.model] : []), `${SYSTEM_PROMPT}\n\n${promptWithHistory(t.request)}`],
    // The project MCP config Cursor's CLI reads from its working folder.
    files: { ".cursor/mcp.json": JSON.stringify({ mcpServers: { [MCP_SERVER_NAME]: { url: t.mcp.url, headers: { Authorization: `Bearer ${t.mcp.token}` } } } }) },
  }),
  parse(line, state) {
    const out: ChatEvent[] = [];
    if (line.type === "system" && line.subtype === "init" && typeof line.session_id === "string") out.push({ type: "session", resume: line.session_id, model: text(line.model) || undefined });
    if (line.type === "assistant") {
      const content = ((line.message as { content?: { type?: string; text?: string }[] } | undefined)?.content ?? []).filter((c) => c.type === "text").map((c) => c.text ?? "").join("");
      if (content) out.push({ type: "text", delta: content });
    }
    if (line.type === "tool_call") {
      const id = text(line.call_id) || `${state.tools.size}`;
      const call = (line.tool_call ?? {}) as Record<string, { args?: { name?: string; toolName?: string; args?: unknown } }>;
      const inner = Object.values(call)[0]?.args;
      const name = shortToolName(inner?.toolName ?? inner?.name ?? Object.keys(call)[0] ?? "tool");
      if (line.subtype === "started") state.tools.set(id, name);
      out.push({ type: "tool", id, name: state.tools.get(id) ?? name, args: inner?.args, state: line.subtype === "started" ? "running" : "done" });
    }
    if (line.type === "result" && line.is_error) out.push({ type: "error", message: text(line.result) || "Cursor's agent failed." });
    return out;
  },
};

export const CLI_SPECS: CliSpec[] = [claudeCode, codex, gemini, cursorAgent];

/** NDJSON from a stream: complete lines out, the partial one kept. */
export class LineSplitter {
  private rest = "";
  push(chunk: string): Record<string, unknown>[] {
    this.rest += chunk;
    const lines = this.rest.split("\n");
    this.rest = lines.pop() ?? "";
    return lines.flatMap((l) => {
      const s = l.trim();
      if (!s.startsWith("{")) return [];
      try {
        return [JSON.parse(s) as Record<string, unknown>];
      } catch {
        return [];
      }
    });
  }
}

/** What runCliProcess needs of child_process.spawn (a fake in the tests: the real CLI is never run there). */
export type SpawnFn = (command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; stdio: ["pipe", "pipe", "pipe"] }) => import("node:child_process").ChildProcess;

/**
 * One CLI run: spawned with the plan, its JSON lines parsed into events, the prompt on stdin; `done` once it ended
 * (an error event first when it failed). Returns the child (to stop it), or null when it couldn't start.
 */
export function runCliProcess(o: { spec: CliSpec; path: string; plan: CliPlan; cwd: string; env: NodeJS.ProcessEnv; spawn: SpawnFn; emit: (e: ChatEvent) => void; done: (error?: string) => void; stopped: () => boolean }): import("node:child_process").ChildProcess | null {
  const { spec } = o;
  let child: import("node:child_process").ChildProcess;
  try {
    child = o.spawn(o.path, o.plan.args, { cwd: o.cwd, env: o.env, stdio: ["pipe", "pipe", "pipe"] });
  } catch (err) {
    o.done(`${spec.label} couldn't start: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
  const lines = new LineSplitter();
  const state: ParseState = { streamed: false, tools: new Map() };
  let stderr = "";
  let gotOutput = false;
  let errored = false;
  let ended = false;
  const end = (error?: string) => {
    if (ended) return;
    ended = true;
    o.done(error);
  };
  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    for (const line of lines.push(chunk)) {
      gotOutput = true;
      for (const e of spec.parse(line, state)) {
        if (e.type === "error") errored = true;
        o.emit(e);
      }
    }
  });
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (d: string) => (stderr = (stderr + d).slice(-4000)));
  child.on("error", (err) => end(`${spec.label}: ${err.message}`));
  child.on("close", (code) => {
    for (const line of lines.push("\n")) for (const e of spec.parse(line, state)) o.emit(e);
    // Its own error event said why already (e.g. "Not logged in"): no second message.
    if (o.stopped() || code === 0 || errored) return end();
    const why = stderr.trim().split("\n").slice(-3).join(" ").slice(0, 600);
    end(`${spec.label} exited (${code})${why ? `: ${why}` : gotOutput ? "" : " without output — is it signed in? Run it once in Terminal."}`);
  });
  child.stdin?.on("error", () => {
    /* the CLI exited before reading its prompt: its close says why */
  });
  child.stdin?.end(o.plan.stdin ?? "");
  return child;
}
