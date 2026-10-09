import type { AuthState, ChatEvent } from "../../../shared/agents/types";
import { SYSTEM_PROMPT } from "../../../shared/agents/prompts";
import { MCP_SERVER_NAME } from "../../../shared/agents/tools";
import { effortArg, modelArg, promptWithHistory, shortToolName, summarize, text, tokenUsage, type CliSpec, type RunResult } from "./turns";

/**
 * OpenAI's Codex CLI, non-interactive (`codex exec --json -`, learn.chatgpt.com "Non-interactive mode"): JSON Lines
 * of thread / turn / item events on stdout, the prompt on stdin, a read-only sandbox in the chat's empty folder. Our
 * server comes in as `-c` overrides of `[mcp_servers.designer]` ("MCP": `url`, `bearer_token_env_var` — the token
 * stays in the environment, never in the arguments — `default_tools_approval_mode`, `required`). Attached pictures go
 * with the prompt (`codex exec --image`), the effort as `-c model_reasoning_effort` ("Config"). Sign-in ("Auth"):
 * `codex login` (the browser flow, the CLI waits), `codex login status`, `codex logout`.
 */

export function parseCodexStatus(r: RunResult): AuthState {
  const out = `${r.stdout}\n${r.stderr ?? ""}`.trim();
  if (r.code === 0 && /logged in/i.test(out) && !/not logged in/i.test(out)) {
    const how = /using (?:an? )?([^\n-]+)/i.exec(out)?.[1]?.trim();
    return { state: "connected", plan: how ? (/chatgpt/i.test(how) ? "ChatGPT" : how.replace(/^api key.*/i, "API key")) : undefined };
  }
  return { state: "signed-out" };
}

const toml = (v: string) => JSON.stringify(v);

export const codex: CliSpec = {
  id: "codex",
  label: "Codex",
  bins: ["codex"],
  models: ["default"],
  // Its config's model_reasoning_effort (a `-c` override); its default first.
  efforts: ["medium", "low", "high"],
  attachHow: "The images come with this message too; open the others to see them.",
  plan: (t) => {
    const model = modelArg(codex, t.request.model);
    const effort = effortArg(codex, t.request.effort);
    const server = `mcp_servers.${MCP_SERVER_NAME}`;
    // Attached pictures go with the prompt (`--image`, a comma list — the copies' names have no commas).
    const images = (t.request.attachments ?? []).filter((a) => a.mime.startsWith("image/")).map((a) => a.path);
    return {
      args: [
        "exec",
        "--json",
        "--skip-git-repo-check",
        "--sandbox", "read-only",
        "-c", `${server}.url=${toml(t.mcp.url)}`,
        "-c", `${server}.bearer_token_env_var=${toml("DESIGNER_MCP_TOKEN")}`,
        "-c", `${server}.default_tools_approval_mode=${toml("approve")}`,
        "-c", `${server}.required=true`,
        ...(effort ? ["-c", `model_reasoning_effort=${toml(effort)}`] : []),
        ...(model ? ["-m", model] : []),
        ...(images.length ? [`--image=${images.join(",")}`] : []),
        "-",
      ],
      stdin: `${SYSTEM_PROMPT}\n\n${promptWithHistory(t.request, codex.attachHow)}`,
      env: { DESIGNER_MCP_TOKEN: t.mcp.token },
    };
  },
  parse(line) {
    const out: ChatEvent[] = [];
    const item = line.item as { id?: string; type?: string; text?: string; server?: string; tool?: string; arguments?: unknown; status?: string; result?: { content?: unknown } | null; error?: { message?: string } | null } | undefined;
    if (line.type === "thread.started" && typeof line.thread_id === "string") out.push({ type: "session", resume: line.thread_id });
    if ((line.type === "item.started" || line.type === "item.completed") && item) {
      if (item.type === "agent_message" && line.type === "item.completed" && item.text) out.push({ type: "text", delta: item.text });
      if (item.type === "mcp_tool_call" && item.id) {
        const name = shortToolName(item.tool);
        if (line.type === "item.started") out.push({ type: "tool", id: item.id, name, args: item.arguments, state: "running" });
        else {
          const failed = item.status === "failed" || !!item.error;
          out.push({ type: "tool", id: item.id, name, state: failed ? "error" : "done", summary: failed ? item.error?.message : summarize(item.result?.content) });
        }
      }
    }
    if (line.type === "turn.completed") {
      const usage = tokenUsage(line.usage);
      if (usage) out.push({ type: "usage", usage });
    }
    if (line.type === "turn.failed" || line.type === "error") {
      const why = text((line.error as { message?: string } | undefined)?.message) || text(line.message) || "Codex failed.";
      out.push({ type: "error", message: /not logged in|login|401|unauthorized/i.test(why) ? `Codex isn’t signed in on this computer (${why}). Sign in from Agent settings.` : why });
    }
    return out;
  },
  auth: {
    status: { args: ["login", "status"], parse: parseCodexStatus },
    login: { kind: "background", args: ["login"] },
    logout: { kind: "command", args: ["logout"] },
  },
  install: { command: "npm install -g @openai/codex", page: "https://developers.openai.com/codex/cli" },
};
