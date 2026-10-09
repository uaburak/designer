import type { AuthState, ChatEvent } from "../../../shared/agents/types";
import { SYSTEM_PROMPT } from "../../../shared/agents/prompts";
import { MCP_SERVER_NAME } from "../../../shared/agents/tools";
import { emailIn, mcpServerEntry, modelArg, promptWithHistory, shortToolName, summarize, text, type CliSpec, type RunResult } from "./turns";

/**
 * Cursor's CLI agent, print mode (`cursor-agent -p --output-format stream-json`, cursor.com/docs/cli "Output format":
 * system init, user, assistant, tool_call started / completed, result). Our server comes from the chat folder's
 * `.cursor/mcp.json` (`--approve-mcps` takes it without asking); `--force` lets tools run headless while the folder's
 * `.cursor/cli.json` denies the shell and file writes. Sign-in ("Authentication"): `cursor-agent login` (the browser
 * flow), `cursor-agent status`, `cursor-agent logout`. Newer installs name the binary `agent` too.
 */

export function parseCursorStatus(r: RunResult): AuthState {
  const out = `${r.stdout}\n${r.stderr ?? ""}`;
  if (/not (?:logged|signed) in|not authenticated|unauthenticated/i.test(out)) return { state: "signed-out" };
  if (r.code === 0 && /logged in|signed in|authenticated/i.test(out)) return { state: "connected", account: emailIn(out) };
  return { state: "signed-out" };
}

type CursorCall = Record<string, { args?: { name?: string; toolName?: string; args?: unknown; arguments?: unknown }; name?: string; arguments?: unknown; result?: { success?: unknown; error?: { message?: string } | string; rejected?: unknown } }>;

function callOf(line: Record<string, unknown>) {
  const call = (line.tool_call ?? {}) as CursorCall;
  const [kind, body] = Object.entries(call)[0] ?? ["tool", {}];
  const a = body?.args;
  const raw = a?.toolName ?? a?.name ?? body?.name ?? kind.replace(/ToolCall$/, "");
  let args = a?.args ?? a?.arguments ?? body?.arguments;
  if (typeof args === "string") {
    try {
      args = JSON.parse(args);
    } catch {
      /* kept as text */
    }
  }
  return { name: shortToolName(raw), args, result: body?.result };
}

export const cursorAgent: CliSpec = {
  id: "cursor-agent",
  label: "Cursor Agent",
  bins: ["cursor-agent", "agent"],
  models: ["auto"],
  plan: (t) => {
    const model = modelArg(cursorAgent, t.request.model);
    return {
      // No flag of its own for files (cursor.com/docs/cli): their paths in the prompt, read with its file tools (reads
      // are allowed in the chat's folder; the shell and writes are denied).
      args: ["-p", "--output-format", "stream-json", "--stream-partial-output", "--force", "--approve-mcps", ...(model ? ["--model", model] : []), `${SYSTEM_PROMPT}\n\n${promptWithHistory(t.request, "Read them with your file tools; they are in your workspace.")}`],
      files: {
        ".cursor/mcp.json": JSON.stringify({ mcpServers: { [MCP_SERVER_NAME]: { url: t.mcp.url, headers: mcpServerEntry(t.mcp)[MCP_SERVER_NAME].headers } } }),
        ".cursor/cli.json": JSON.stringify({ permissions: { allow: [], deny: ["Shell(*)", "Write(**)"] } }),
      },
    };
  },
  parse(line, state) {
    const out: ChatEvent[] = [];
    if (line.type === "system" && line.subtype === "init" && typeof line.session_id === "string") out.push({ type: "session", resume: line.session_id, model: text(line.model) || undefined });
    if (line.type === "assistant") {
      const content = ((line.message as { content?: { type?: string; text?: string }[] } | undefined)?.content ?? []).filter((c) => c.type === "text").map((c) => c.text ?? "").join("");
      // With --stream-partial-output the chunks carry timestamp_ms; a whole message after them repeats them.
      if (content) {
        if (line.timestamp_ms !== undefined) {
          state.streamed = true;
          out.push({ type: "text", delta: content });
        } else if (state.streamed) state.streamed = false;
        else out.push({ type: "text", delta: content });
      }
    }
    if (line.type === "tool_call") {
      state.streamed = false;
      const id = text(line.call_id) || `c${state.tools.size}`;
      const { name, args, result } = callOf(line);
      if (line.subtype === "started") {
        state.tools.set(id, name);
        out.push({ type: "tool", id, name, args, state: "running" });
      } else {
        const err = result?.error ?? (result?.rejected ? "Rejected" : undefined);
        const success = result?.success as { content?: unknown } | undefined;
        out.push({ type: "tool", id, name: state.tools.get(id) ?? name, state: err ? "error" : "done", summary: err ? (typeof err === "string" ? err : err.message) : summarize(success?.content) });
      }
    }
    if (line.type === "result" && line.is_error) {
      const why = text(line.result) || "Cursor's agent failed.";
      out.push({ type: "error", message: /not (?:logged|signed) in|authenticat|login/i.test(why) ? `Cursor Agent isn’t signed in on this computer (${why}). Sign in from Agent settings.` : why });
    }
    return out;
  },
  auth: {
    status: { args: ["status"], parse: parseCursorStatus },
    login: { kind: "background", args: ["login"] },
    logout: { kind: "command", args: ["logout"] },
  },
  install: { command: "curl https://cursor.com/install -fsS | bash", page: "https://cursor.com/cli" },
};
