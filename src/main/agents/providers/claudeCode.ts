import type { AuthState, ChatEvent, UsageWindow } from "../../../shared/agents/types";
import { SYSTEM_PROMPT } from "../../../shared/agents/prompts";
import { MCP_SERVER_NAME } from "../../../shared/agents/tools";
import { effortArg, mcpServerEntry, modelArg, promptWithContext, promptWithHistory, shortToolName, summarize, text, tokenUsage, type CliSpec, type RunResult } from "./turns";

/**
 * Claude Code (`claude -p --output-format stream-json`, docs.claude.com "CLI reference" / "Headless mode"): no
 * built-in tools, only our MCP server (`--mcp-config` + `--strict-mcp-config`, allowed without asking), the skill
 * appended to its system prompt, the prompt on stdin, its own session continued with `--resume`. Sign-in: `claude auth
 * status --json`, `claude auth login --claudeai` (opens claude.ai in the browser and waits), `claude auth logout`.
 *
 * Attachments: a chat with files attached gets one built-in tool, Read (`--tools Read`), allowed only inside the chat's
 * attachments folder (`--allowedTools "Read(//<folder>/**)"`; `dontAsk` denies every other read) — Read shows it
 * images and PDFs. Effort: `--effort`. Usage: `claude -p /usage` is its local command (no model call, no turn) — the
 * plan's limits as text; during a turn `rate_limit_event` lines carry them too.
 */

/** "Current session: 5% used · resets Oct 10 at 3:59am (Europe/Istanbul)" lines of `claude -p /usage`. */
export function parseClaudeUsage(r: RunResult): UsageWindow[] | null {
  let out: { local_command?: string; result?: string; is_error?: boolean };
  try {
    out = JSON.parse(r.stdout) as typeof out;
  } catch {
    return null;
  }
  if (out.local_command !== "usage" || out.is_error || typeof out.result !== "string") return null;
  const windows = out.result
    .split("\n")
    .map((l) => /^\s*([^:\n]{2,60}):\s*(\d{1,3}(?:\.\d+)?)%\s*used(?:\s*·\s*resets\s+(.+?))?\s*$/i.exec(l))
    .filter((m): m is RegExpExecArray => !!m)
    .map((m): UsageWindow => ({ label: m[1].trim(), usedPct: Math.min(100, Number(m[2])), ...(m[3] ? { resetText: m[3].replace(/\s*\([^)]*\)\s*$/, "") } : {}) }));
  return windows.length ? windows : null;
}

const WINDOW_LABEL: Record<string, string> = { five_hour: "Current session", seven_day: "Current week" };

/** A `rate_limit_event`'s windows (utilization 0–1, resetsAt in seconds). */
export function claudeRateLimits(info: unknown): UsageWindow[] {
  const i = (info ?? {}) as { unifiedWindows?: Record<string, { utilization?: number; resetsAt?: number }>; rateLimitType?: string; resetsAt?: number; utilization?: number };
  const entries = Object.entries(i.unifiedWindows ?? {});
  return entries
    .filter(([, w]) => typeof w?.utilization === "number")
    .map(([k, w]) => ({ label: WINDOW_LABEL[k] ?? `Current ${k.replace(/^seven_day_?/, "week ").replace(/_/g, " ").trim()}`, usedPct: Math.round(w.utilization! * 1000) / 10, ...(typeof w.resetsAt === "number" ? { resetsAt: w.resetsAt * 1000 } : {}) }));
}

export function parseClaudeStatus(stdout: string): AuthState {
  try {
    const s = JSON.parse(stdout) as { loggedIn?: boolean; email?: string; authMethod?: string; subscriptionType?: string; orgName?: string };
    if (!s.loggedIn) return { state: "signed-out" };
    const plan = s.subscriptionType ? `Claude ${s.subscriptionType.charAt(0).toUpperCase()}${s.subscriptionType.slice(1)}` : s.authMethod;
    return { state: "connected", account: s.email, plan: [plan, s.orgName].filter(Boolean).join(" · ") || undefined };
  } catch {
    return { state: "signed-out", detail: "Couldn't read “claude auth status”" };
  }
}

export const claudeCode: CliSpec = {
  id: "claude-code",
  label: "Claude Code",
  bins: ["claude"],
  models: ["default", "opus", "sonnet", "haiku"],
  efforts: ["high", "low", "medium", "xhigh", "max"],
  attachHow: "Look at each with your Read tool (it shows images and PDFs).",
  plan: (t) => {
    const model = modelArg(claudeCode, t.request.model);
    const effort = effortArg(claudeCode, t.request.effort);
    // Read only inside the chat's attachments folder ("//" starts an absolute path in a permission rule).
    const read = t.attachmentsDir ? `Read(/${t.attachmentsDir.replace(/\/+$/, "")}/**)` : null;
    const how = claudeCode.attachHow;
    return {
      args: [
        "-p",
        "--output-format", "stream-json",
        "--verbose",
        "--include-partial-messages",
        "--mcp-config", t.mcpConfigPath,
        "--strict-mcp-config",
        // No built-in tools (no shell, files or web): only the design tools, allowed without asking — and with files
        // attached, Read inside their folder.
        "--tools", read ? "Read" : "",
        "--allowedTools", `mcp__${MCP_SERVER_NAME}`, ...(read ? [read] : []),
        "--permission-mode", "dontAsk",
        "--append-system-prompt", SYSTEM_PROMPT,
        ...(model ? ["--model", model] : []),
        ...(effort ? ["--effort", effort] : []),
        ...(t.request.resume ? ["--resume", t.request.resume] : ["--session-id", t.sessionId]),
      ],
      // Its own session has the conversation; a chat started with another agent passes it along.
      stdin: t.request.resume ? promptWithContext(t.request, how) : promptWithHistory(t.request, how),
      files: { [t.mcpConfigPath]: JSON.stringify({ mcpServers: mcpServerEntry(t.mcp) }) },
    };
  },
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
      case "rate_limit_event": {
        const windows = claudeRateLimits(line.rate_limit_info);
        if (windows.length) out.push({ type: "limits", windows });
        break;
      }
      case "result": {
        const usage = tokenUsage(line.usage);
        if (usage) out.push({ type: "usage", usage });
        if (line.is_error || (typeof line.subtype === "string" && line.subtype.startsWith("error"))) {
          const why = text(line.result);
          out.push({ type: "error", message: /not logged in|\/login/i.test(why) ? "Claude Code isn’t signed in on this computer. Sign in from Agent settings, then try again." : why || `Claude Code stopped (${String(line.subtype)}).` });
        }
        break;
      }
    }
    return out;
  },
  // Its local /usage command: no model call, no session kept, no MCP servers started.
  usage: { args: ["-p", "/usage", "--output-format", "json", "--no-session-persistence", "--strict-mcp-config", "--tools", ""], parse: parseClaudeUsage },
  auth: {
    status: { args: ["auth", "status", "--json"], parse: (r) => parseClaudeStatus(r.stdout) },
    login: { kind: "background", args: ["auth", "login", "--claudeai"] },
    logout: { kind: "command", args: ["auth", "logout"] },
  },
  install: { command: "curl -fsSL https://claude.ai/install.sh | bash", page: "https://docs.claude.com/en/docs/claude-code/setup" },
};
