import type { ChildProcess } from "node:child_process";
import type { AuthState, ChatEvent, TurnRequest } from "../../../shared/agents/types";
import { MCP_SERVER_NAME } from "../../../shared/agents/tools";

/**
 * What every CLI agent's adapter shares (docs/research/figma/R12-agents-mcp.md §4): the shape of an adapter — how to
 * find the CLI, its arguments for a turn, the files it reads its MCP config from, how its JSON lines become the chat's
 * events, its own sign-in commands and its install command — and the turn's run: the prompt, NDJSON split into
 * lines, the process with its stderr kept for the error. Each CLI's adapter is a file of its own beside this one
 * (claudeCode.ts, codex.ts, gemini.ts, cursor.ts). Electron-free: tested with recorded output and fake processes.
 */

export interface McpEndpoint {
  url: string;
  token: string;
}

export interface CliTurn {
  request: TurnRequest;
  mcp: McpEndpoint;
  /** The chat's own empty folder the CLI runs in */
  cwd: string;
  /** A new session id for the CLI (Claude Code `--session-id`), when the chat has none yet */
  sessionId: string;
  /** The MCP config file written for this turn (Claude Code `--mcp-config`) */
  mcpConfigPath: string;
  /** The owner's own API key for this agent, pasted in Agent settings (Gemini: an AI Studio key) */
  apiKey?: string;
  /** The user's home folder (the CLI's own config lives there), the OS's when not given */
  home?: string;
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
  /** The step whose text streamed last (Antigravity: a new reply step after a tool starts a new paragraph) */
  textStep?: string;
}

export const newParseState = (): ParseState => ({ streamed: false, tools: new Map() });

export interface RunResult {
  code: number;
  stdout: string;
  stderr?: string;
}

/** What a status check may look at besides a command: the CLI's own files (Gemini CLI keeps no status command). */
export interface AuthEnv {
  home: string;
  readFile(path: string): string | null;
  exists(path: string): boolean;
  /** A folder's entries (Antigravity's logs), when the caller can list */
  list?(path: string): string[];
  env: NodeJS.ProcessEnv;
}

/**
 * A CLI's sign-in, with its own documented commands only — this app never sees a password or a key: the provider's
 * sign-in page opens in the browser (a background login that waits for it), or the CLI's own interactive sign-in runs
 * in the user's Terminal.
 */
export interface CliAuth {
  /** A status command and how its output reads */
  status?: { args: string[]; parse(r: RunResult, env?: AuthEnv): AuthState };
  /** Status read from the CLI's own files, when it has no status command */
  fromFiles?(env: AuthEnv): AuthState;
  login: { kind: "background"; args: string[] } | { kind: "terminal"; args: string[]; note: string };
  logout: { kind: "command"; args: string[] } | { kind: "terminal"; args: string[]; note: string };
}

/** How to get the tool: its documented install command (run in the user's Terminal after they confirm) and page. */
export interface InstallInfo {
  command?: string;
  page: string;
}

export type CliId = "claude-code" | "antigravity" | "codex" | "gemini" | "cursor-agent";

/** A CLI's own model list (Antigravity's `agy models`): the slugs, the default first, and their labels. */
export interface CliModels {
  models: string[];
  labels: Record<string, string>;
}

export interface CliSpec {
  id: CliId;
  /** As the chat and the settings show it */
  label: string;
  /** A second line in Agent settings */
  note?: string;
  /** Executable names, first found wins */
  bins: string[];
  /** Models to pick from; the first is the CLI's own default (no model flag) */
  models: string[];
  plan(turn: CliTurn): CliPlan;
  parse(line: Record<string, unknown>, state: ParseState): ChatEvent[];
  auth: CliAuth;
  install: InstallInfo;
  /** Its models read from its status command's output (instead of the fixed list), when it lists them */
  modelsFromStatus?(r: RunResult): CliModels | null;
  /**
   * Folders besides the chat's own where this agent saves the pictures it makes for a session (Antigravity's
   * generate_image: its conversation's folder), which place_image may then read.
   */
  imageDirs?(session: string, home: string): string[];
}

/** The model flag's value, or null for the CLI's default (the spec's first model). */
export const modelArg = (spec: Pick<CliSpec, "models">, model: string | undefined): string | null => (model && model !== spec.models[0] && model !== "default" ? model : null);

/** The turn's prompt: the selection attached as context, then what the user typed. */
export function promptWithContext(r: TurnRequest): string {
  const c = r.context;
  const sel = c.selection.length
    ? c.selection.map((s) => `${s.type.toLowerCase()} "${s.name}" (id ${s.id}, ${Math.round(s.width)} × ${Math.round(s.height)})`).join(", ")
    : "nothing";
  return `[Design file "${c.fileName}", page "${c.pageName}". Selected: ${sel}.]\n\n${r.prompt}`;
}

/** A chat without a CLI session of its own (or one started with another agent): the conversation so far, then the turn. */
export function promptWithHistory(r: TurnRequest): string {
  const past = r.history.slice(-12).map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.text}`).join("\n\n");
  return (past ? `Conversation so far:\n${past}\n\n` : "") + promptWithContext(r);
}

/** Our server as the CLIs' JSON configs name it (Streamable HTTP with the chat's token). */
export const mcpServerEntry = (mcp: McpEndpoint) => ({ [MCP_SERVER_NAME]: { type: "http", url: mcp.url, headers: { Authorization: `Bearer ${mcp.token}` } } });

/**
 * A tool's name without its server's prefix, as each CLI spells it: `mcp__designer__get_metadata` (Claude Code),
 * `mcp_designer_get_metadata` / `designer__get_metadata` (Gemini CLI), `designer.get_metadata`, `designer-get_metadata` (Cursor).
 */
export function shortToolName(name: unknown): string {
  const s = String(name ?? "");
  const server = MCP_SERVER_NAME;
  return s
    .replace(/^mcp__[^_]+(?:_[^_]+)*?__/, "")
    .replace(new RegExp(`^mcp_${server}_`), "")
    .replace(new RegExp(`^${server}(?:__|[._/-])`), "");
}

export const text = (v: unknown) => (typeof v === "string" ? v : "");

/** A tool result's first line, for the activity row (MCP content blocks or a string). */
export function summarize(content: unknown): string | undefined {
  const first = Array.isArray(content) ? (content as { type?: string; text?: string }[]).find((c) => c?.type === "text")?.text : typeof content === "string" ? content : undefined;
  return first ? first.split("\n")[0].slice(0, 140) : undefined;
}

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

/** A whole recorded output (NDJSON text) through an adapter's parser: the chat's events. */
export function parseRecorded(spec: Pick<CliSpec, "parse">, ndjson: string): ChatEvent[] {
  const state = newParseState();
  return new LineSplitter().push(ndjson.endsWith("\n") ? ndjson : `${ndjson}\n`).flatMap((l) => spec.parse(l, state));
}

/** What runCliProcess needs of child_process.spawn (a fake in the tests: the real CLI is never run there). */
export type SpawnFn = (command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; stdio: ["pipe", "pipe", "pipe"] }) => ChildProcess;

/**
 * One CLI run: spawned with the plan, its JSON lines parsed into events, the prompt on stdin; `done` once it ended
 * (an error event first when it failed). Returns the child (to stop it), or null when it couldn't start.
 */
export function runCliProcess(o: { spec: CliSpec; path: string; plan: CliPlan; cwd: string; env: NodeJS.ProcessEnv; spawn: SpawnFn; emit: (e: ChatEvent) => void; done: (error?: string) => void; stopped: () => boolean; raw?: (chunk: string) => void }): ChildProcess | null {
  const { spec } = o;
  let child: ChildProcess;
  try {
    child = o.spawn(o.path, o.plan.args, { cwd: o.cwd, env: o.env, stdio: ["pipe", "pipe", "pipe"] });
  } catch (err) {
    o.done(`${spec.label} couldn't start: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
  const lines = new LineSplitter();
  const state = newParseState();
  let stderr = "";
  let gotOutput = false;
  let errored = false;
  let ended = false;
  const end = (error?: string) => {
    if (ended) return;
    ended = true;
    o.done(error);
  };
  const take = (line: Record<string, unknown>) => {
    gotOutput = true;
    for (const e of spec.parse(line, state)) {
      if (e.type === "error") errored = true;
      o.emit(e);
    }
  };
  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    o.raw?.(chunk);
    lines.push(chunk).forEach(take);
  });
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (d: string) => (stderr = (stderr + d).slice(-4000)));
  child.on("error", (err) => end(`${spec.label}: ${err.message}`));
  child.on("close", (code) => {
    lines.push("\n").forEach(take);
    // Its own error event said why already (e.g. "Not logged in"): no second message.
    if (o.stopped() || code === 0 || errored) return end();
    const why = stderr.trim().split("\n").slice(-3).join(" ").slice(0, 600);
    end(`${spec.label} exited (${code})${why ? `: ${why}` : gotOutput ? "" : " without output — is it signed in? Use Sign in in Agent settings."}`);
  });
  child.stdin?.on("error", () => {
    /* the CLI exited before reading its prompt: its close says why */
  });
  child.stdin?.end(o.plan.stdin ?? "");
  return child;
}

/** The first https address in a CLI's output (its sign-in page, shown when the browser didn't open by itself). */
export const loginUrl = (out: string): string | null => /https:\/\/[^\s"'<>]+/.exec(out)?.[0] ?? null;

/** An email address in a status line ("Logged in as a@b.c"). */
export const emailIn = (s: string): string | undefined => /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/.exec(s)?.[0];
