import { accessSync, constants, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import type { CustomServer, ProviderInfo } from "../../shared/agents/types";
import { CLI_SPECS } from "./cliProviders";
import { listModels } from "./openaiBridge";

/**
 * What the Agents tab can talk to on this computer: the CLIs on PATH — an app started from the Dock has launchd's
 * short PATH, so the usual install folders are searched too — and the local model servers that answer.
 */

export function searchPath(home = homedir(), path = process.env.PATH ?? ""): string[] {
  const extra = [join(home, ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin", join(home, ".npm-global", "bin"), join(home, ".bun", "bin"), join(home, ".volta", "bin"), join(home, ".cursor", "bin"), join(home, ".lmstudio", "bin"), "/usr/bin", "/bin"];
  return [...new Set([...path.split(delimiter).filter(Boolean), ...extra])];
}

export function which(bin: string, dirs = searchPath()): string | null {
  for (const d of dirs) {
    const p = join(d, bin);
    try {
      if (!statSync(p).isFile()) continue;
      accessSync(p, constants.X_OK);
      return p;
    } catch {
      /* not here */
    }
  }
  return null;
}

/** The environment a CLI runs in: ours, with the search path (so its own helpers — node, git — are found). */
export function cliEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: searchPath().join(delimiter), ...extra };
  // Never hand the app's own Electron mode or a debugger to a child.
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NODE_OPTIONS;
  // The app started from inside a Claude Code session (a terminal, a script): that session's markers would make the
  // CLI a nested, "simple" run without the user's own sign-in — the CLI is the user's, as if started from the Dock.
  const hosted = !!(env.CLAUDECODE || env.CLAUDE_CODE_ENTRYPOINT);
  for (const k of Object.keys(env)) if (/^CLAUDE(CODE$|_CODE_|_AGENT_SDK_|_PID$|_EFFORT$|_PREVIEW_)/.test(k)) delete env[k];
  if (hosted) delete env.ANTHROPIC_BASE_URL;
  return env;
}

export const LOCAL_SERVERS: { id: string; label: string; baseUrl: string }[] = [
  { id: "ollama", label: "Ollama", baseUrl: "http://localhost:11434/v1" },
  { id: "lmstudio", label: "LM Studio", baseUrl: "http://localhost:1234/v1" },
];

export async function detectProviders(custom: CustomServer[], keyOf: (id: string) => string | undefined, options: { fetch?: typeof fetch; which?: (bin: string) => string | null } = {}): Promise<ProviderInfo[]> {
  const find = options.which ?? ((b: string) => which(b));
  const clis: ProviderInfo[] = CLI_SPECS.map((s) => {
    const path = s.bins.map((b) => find(b)).find(Boolean) ?? null;
    return { id: s.id, kind: s.id, label: s.label, available: !!path, detail: path ?? undefined, models: s.models, problem: path ? undefined : `${s.bins[0]} isn't installed` };
  });
  const servers = await Promise.all(
    [...LOCAL_SERVERS.map((s) => ({ ...s, hasKey: false })), ...custom].map(async (s): Promise<ProviderInfo> => {
      try {
        const models = await listModels(s.baseUrl, { fetch: options.fetch, apiKey: keyOf(s.id) });
        return { id: s.id, kind: "openai-compatible", label: s.label, available: models.length > 0, detail: s.baseUrl, models, problem: models.length ? undefined : "No models loaded", hasKey: s.hasKey };
      } catch {
        return { id: s.id, kind: "openai-compatible", label: s.label, available: false, detail: s.baseUrl, models: [], problem: `Not running at ${s.baseUrl}`, hasKey: s.hasKey };
      }
    })
  );
  return [...clis, ...servers];
}
