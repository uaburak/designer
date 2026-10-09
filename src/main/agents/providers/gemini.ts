import { join } from "node:path";
import type { AuthState, ChatEvent, ImageGenState } from "../../../shared/agents/types";
import { SYSTEM_PROMPT } from "../../../shared/agents/prompts";
import { MCP_SERVER_NAME } from "../../../shared/agents/tools";
import { modelArg, promptWithHistory, shortToolName, text, type AuthEnv, type CliSpec } from "./turns";

/**
 * Google's Gemini CLI, headless (`gemini -p … --output-format stream-json`, docs/cli/headless.md; the event types are
 * packages/core/src/output/types.ts: init, message, tool_use, tool_result, error, result). This is also how
 * Antigravity's Gemini models reach the chat: Antigravity's own agent API is private, Gemini CLI is Google's documented
 * headless agent with the same Google sign-in.
 *
 * Our server comes from the chat folder's `.gemini/settings.json` (`httpUrl` = Streamable HTTP, `trust` = its tools
 * run without asking); `--allowed-mcp-server-names` keeps the user's other servers out except the Nano Banana image
 * extension (when the user installed it, its pictures land in the chat folder's `nanobanana-output/`, which
 * `place_image` reads). `--approval-mode yolo` lets the tools run headless; the shell tool is excluded and the CLI's file
 * tools stay inside the empty chat folder.
 *
 * Sign-in: Gemini CLI has no status command; it signs in with Google in its own interactive start ("Sign in with
 * Google", the browser page) and caches the credentials (~/.gemini/oauth_creds.json, or the keychain), the method in
 * ~/.gemini/settings.json `security.auth.selectedType`, the account in ~/.gemini/google_accounts.json. Signing out is
 * its `/auth logout`.
 */

/** Nano Banana's MCP server name (github.com/gemini-cli-extensions/nanobanana, gemini-extension.json). */
export const NANOBANANA = "nanobanana";

const stripJsonComments = (s: string) => s.replace(/("(?:\\.|[^"\\])*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (m, str: string | undefined) => str ?? "");

function readJson(env: AuthEnv, path: string): Record<string, unknown> | null {
  const raw = env.readFile(path);
  if (!raw) return null;
  try {
    return JSON.parse(stripJsonComments(raw)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function geminiStatus(env: AuthEnv): AuthState {
  // The owner's AI Studio key (Agent settings) wins: Google ended Gemini CLI's personal Google sign-in ("This client is
  // no longer supported for Gemini Code Assist for individuals"), Google AI Pro / Ultra included.
  if (env.env.DESIGNER_GEMINI_KEY) return { state: "connected", plan: "Gemini API key" };
  const dir = join(env.home, ".gemini");
  const settings = readJson(env, join(dir, "settings.json"));
  const selected = String(((settings?.security as { auth?: { selectedType?: string } } | undefined)?.auth?.selectedType ?? settings?.selectedAuthType ?? "") || "");
  const account = (readJson(env, join(dir, "google_accounts.json"))?.active as string | undefined) || undefined;
  const creds = env.exists(join(dir, "oauth_creds.json"));
  if (selected === "oauth-personal" || (!selected && creds)) return creds || selected ? { state: "connected", account, plan: "Google account" } : { state: "signed-out" };
  if (selected === "gemini-api-key") return env.env.GEMINI_API_KEY ? { state: "connected", plan: "Gemini API key" } : { state: "signed-out", detail: "Set up for an API key, but GEMINI_API_KEY isn't set for apps" };
  if (selected === "vertex-ai") return { state: "connected", plan: "Vertex AI" };
  if (selected === "cloud-shell" || selected === "compute-default-credentials") return { state: "connected", plan: "Google Cloud" };
  return { state: "signed-out" };
}

/**
 * Image generation through Nano Banana (github.com/gemini-cli-extensions/nanobanana, README "Prerequisites"): a
 * Gemini CLI extension whose MCP server calls the Gemini API with an AI Studio API key (`NANOBANANA_API_KEY`) — the
 * Google sign-in doesn't cover it, a Google AI Ultra plan included. The key is the owner's: pasted into Agent settings
 * (kept with safeStorage) or set in the extension's own settings when it was installed (its `.env`).
 */
// --consent: the owner's Install click is the consent; --skip-settings: its key comes from our run's environment (an
// interactive settings prompt would wait forever without a terminal).
export const NANOBANANA_INSTALL = "gemini extensions install https://github.com/gemini-cli-extensions/nanobanana --consent --skip-settings";
export const NANOBANANA_KEY_PAGE = "https://aistudio.google.com/apikey";
const KEY_VARS = ["NANOBANANA_API_KEY", "NANOBANANA_GEMINI_API_KEY", "NANOBANANA_GOOGLE_API_KEY"];

export function imageGenStatus(env: AuthEnv & { list(path: string): string[] }, o: { signedIn: boolean; installed: boolean; hasKey: boolean }): ImageGenState {
  const s = imageGenState(env, o);
  return o.hasKey ? { ...s, keyAdded: true } : s;
}

function imageGenState(env: AuthEnv & { list(path: string): string[] }, o: { signedIn: boolean; installed: boolean; hasKey: boolean }): ImageGenState {
  if (!o.installed) return { state: "unavailable", detail: "Gemini CLI isn't installed" };
  const dir = join(env.home, ".gemini", "extensions");
  const ext = env.list(dir).find((d) => /nanobanana/i.test(d));
  if (!ext) return { state: "not-installed", detail: "The Nano Banana extension isn't installed" };
  const dotenv = env.readFile(join(dir, ext, ".env")) ?? "";
  const keyed = o.hasKey || KEY_VARS.some((k) => !!env.env[k] || new RegExp(`^\\s*${k}\\s*=\\s*\\S`, "m").test(dotenv));
  if (!o.signedIn && !o.hasKey) return { state: "needs-sign-in", detail: "Add a Gemini API key first" };
  if (!keyed) return { state: "needs-key", detail: "Nano Banana needs a Gemini API key from Google AI Studio" };
  return { state: "ready", detail: o.hasKey ? "With the API key you added" : "With the extension's own API key" };
}

/** Told to Gemini: pictures come from Nano Banana's tools when they are there, then go on the canvas with place_image. */
export const IMAGE_NOTE = `Images: when the user wants a picture (a photo, an illustration, an icon as an image) and you have the ${NANOBANANA} tools (generate_image), generate it with them — they save it under nanobanana-output/ in your working folder — then put it on the canvas with place_image {path: "nanobanana-output/<file>"} (or fill an existing layer with nodeId). Without those tools, say that image generation needs the Nano Banana extension (Agent settings).`;

const signInHint = (why: string) => /auth method|GEMINI_API_KEY|login|sign in|credentials|401|UNAUTHENTICATED/i.test(why);

/** Google's refusal of the personal Google sign-in (IneligibleTierError, UNSUPPORTED_CLIENT) in the CLI's output. */
export const INELIGIBLE = /IneligibleTier|throwIneligibleOrProjectIdError|no longer supported for Gemini Code Assist/i;
export const INELIGIBLE_MESSAGE = "Google no longer lets Gemini CLI use a personal Google sign-in (Google AI Pro and Ultra included). Add a Gemini API key from Google AI Studio in Agent settings — it runs both the chat and Nano Banana.";

export const gemini: CliSpec = {
  id: "gemini",
  label: "Antigravity / Gemini CLI",
  note: "Google’s Gemini models, as in Antigravity — run by Gemini CLI with your Gemini API key.",
  bins: ["gemini"],
  models: ["auto", "pro", "flash", "flash-lite"],
  plan: (t) => {
    const model = modelArg(gemini, t.request.model);
    return {
      args: ["-p", `${SYSTEM_PROMPT}\n\n${IMAGE_NOTE}\n\n${promptWithHistory(t.request)}`, "--output-format", "stream-json", "--approval-mode", "yolo", "--allowed-mcp-server-names", `${MCP_SERVER_NAME},${NANOBANANA}`, ...(model ? ["-m", model] : [])],
      files: {
        ".gemini/settings.json": JSON.stringify({
          mcpServers: { [MCP_SERVER_NAME]: { httpUrl: t.mcp.url, headers: { Authorization: `Bearer ${t.mcp.token}` }, trust: true } },
          tools: { exclude: ["run_shell_command"] },
          // With the owner's key the chat folder's settings switch the CLI to it (workspace settings win over ~/.gemini).
          ...(t.apiKey ? { security: { auth: { selectedType: "gemini-api-key" } } } : {}),
        }),
      },
      // The chat folder is ours (docs/cli/trusted-folders: headless runs need it trusted to read its settings); the key
      // goes in the environment only, never in the arguments or files.
      env: { GEMINI_CLI_TRUST_WORKSPACE: "true", ...(t.apiKey ? { GEMINI_API_KEY: t.apiKey, NANOBANANA_API_KEY: t.apiKey } : {}) },
    };
  },
  parse(line, state) {
    const out: ChatEvent[] = [];
    switch (line.type) {
      case "init":
        if (typeof line.session_id === "string") out.push({ type: "session", resume: line.session_id, model: text(line.model) || undefined });
        break;
      case "message": {
        if (line.role !== "assistant") break;
        const content = text(line.content);
        if (!content) break;
        // Deltas stream the reply; a whole message after them repeats it.
        if (line.delta === true) state.streamed = true;
        else if (state.streamed) {
          state.streamed = false;
          break;
        }
        out.push({ type: "text", delta: content });
        break;
      }
      case "tool_use": {
        const id = text(line.tool_id) || `g${state.tools.size}`;
        const name = shortToolName(line.tool_name);
        state.tools.set(id, name);
        state.streamed = false;
        out.push({ type: "tool", id, name, args: line.parameters, state: "running" });
        break;
      }
      case "tool_result": {
        const id = text(line.tool_id);
        const err = line.error as { message?: string } | undefined;
        out.push({ type: "tool", id, name: state.tools.get(id) ?? "tool", state: line.status === "error" ? "error" : "done", summary: (line.status === "error" ? err?.message : text(line.output).split("\n")[0].slice(0, 140)) || undefined });
        break;
      }
      case "error":
        // Warnings (a retry, a fallback model) don't end the turn.
        if (line.severity !== "warning") out.push({ type: "error", message: text(line.message) || "Gemini CLI failed." });
        break;
      case "result":
        if (line.status === "error") {
          const why = text((line.error as { message?: string } | undefined)?.message) || "Gemini CLI failed.";
          out.push({ type: "error", message: signInHint(why) ? `Gemini CLI isn’t signed in on this computer (${why}). Sign in from Agent settings.` : why });
        }
        break;
    }
    return out;
  },
  auth: {
    fromFiles: geminiStatus,
    login: { kind: "terminal", args: [], note: "Gemini CLI opens in Terminal: choose “Sign in with Google” and finish in your browser, then type /quit." },
    logout: { kind: "terminal", args: [], note: "Gemini CLI opens in Terminal: type /auth logout, then /quit." },
  },
  install: { command: "npm install -g @google/gemini-cli", page: "https://github.com/google-gemini/gemini-cli#-installation" },
};
