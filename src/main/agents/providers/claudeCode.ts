import type { AuthState, ChatEvent } from "../../../shared/agents/types";
import { SYSTEM_PROMPT } from "../../../shared/agents/prompts";
import { MCP_SERVER_NAME } from "../../../shared/agents/tools";
import { mcpServerEntry, modelArg, promptWithContext, promptWithHistory, shortToolName, summarize, text, type CliSpec } from "./turns";

/**
 * Claude Code (`claude -p --output-format stream-json`, docs.claude.com "CLI reference" / "Headless mode"): no
 * built-in tools, only our MCP server (`--mcp-config` + `--strict-mcp-config`, allowed without asking), the skill
 * appended to its system prompt, the prompt on stdin, its own session continued with `--resume`. Sign-in: `claude auth
 * status --json`, `claude auth login --claudeai` (opens claude.ai in the browser and waits), `claude auth logout`.
 */

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
  models: ["default", "sonnet", "opus", "haiku"],
  plan: (t) => {
    const model = modelArg(claudeCode, t.request.model);
    return {
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
        ...(model ? ["--model", model] : []),
        ...(t.request.resume ? ["--resume", t.request.resume] : ["--session-id", t.sessionId]),
      ],
      // Its own session has the conversation; a chat started with another agent passes it along.
      stdin: t.request.resume ? promptWithContext(t.request) : promptWithHistory(t.request),
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
      case "result":
        if (line.is_error || (typeof line.subtype === "string" && line.subtype.startsWith("error"))) {
          const why = text(line.result);
          out.push({ type: "error", message: /not logged in|\/login/i.test(why) ? "Claude Code isn’t signed in on this computer. Sign in from Agent settings, then try again." : why || `Claude Code stopped (${String(line.subtype)}).` });
        }
        break;
    }
    return out;
  },
  auth: {
    status: { args: ["auth", "status", "--json"], parse: (r) => parseClaudeStatus(r.stdout) },
    login: { kind: "background", args: ["auth", "login", "--claudeai"] },
    logout: { kind: "command", args: ["auth", "logout"] },
  },
  install: { command: "curl -fsSL https://claude.ai/install.sh | bash", page: "https://docs.claude.com/en/docs/claude-code/setup" },
};
