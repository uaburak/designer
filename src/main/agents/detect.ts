import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import type { AuthState, CustomServer, ProviderInfo } from "../../shared/agents/types";
import { CLI_SPECS, LOCAL_SERVERS, type CliSpec } from "./providers";
import type { CliModels } from "./providers/turns";
import { listModels } from "./openaiBridge";
import { t as tr } from "../../shared/i18n";

/**
 * What the Agents tab can talk to on this computer: the CLIs on PATH — an app started from the Dock has launchd's
 * short PATH, so the usual install folders are searched too — and the local model servers that answer.
 */

const WIN = process.platform === "win32";

export function searchPath(home = homedir(), path = process.env.PATH ?? ""): string[] {
  // Windows: npm's global shims (%APPDATA%\npm), the native installers' ~\.local\bin, Bun, Volta, Cursor, LM Studio.
  if (WIN) {
    const appData = process.env.APPDATA ?? join(home, "AppData", "Roaming");
    const local = process.env.LOCALAPPDATA ?? join(home, "AppData", "Local");
    const extra = [join(home, ".local", "bin"), join(appData, "npm"), join(home, ".bun", "bin"), join(local, "Volta", "bin"), join(local, "Programs", "cursor", "resources", "app", "bin"), join(home, ".lmstudio", "bin")];
    return [...new Set([...path.split(delimiter).filter(Boolean), ...extra])];
  }
  const extra = [join(home, ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin", join(home, ".npm-global", "bin"), join(home, ".bun", "bin"), join(home, ".volta", "bin"), join(home, ".cursor", "bin"), join(home, ".lmstudio", "bin"), "/usr/bin", "/bin"];
  return [...new Set([...path.split(delimiter).filter(Boolean), ...extra])];
}

/** Windows: a bare name runs as name.exe / .cmd / .bat (PATHEXT; .exe first). */
const exts = (bin: string) => (WIN && !/\.[a-z0-9]+$/i.test(bin) ? [".exe", ...(process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").toLowerCase().split(";").filter((e) => e && e !== ".exe")] : [""]);

export function which(bin: string, dirs = searchPath()): string | null {
  for (const d of dirs) for (const ext of exts(bin)) {
    const p = join(d, bin + ext);
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

/** Windows quoting for a .cmd / .bat shim run through cmd.exe: each argument in "", inner quotes escaped. */
const winQuote = (a: string) => `"${a.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, "$1$1")}"`;

/** Starts a CLI found by `which`: Windows runs a .cmd / .bat shim (npm's) through the shell, which Node requires. */
export function spawnCli(cmd: string, args: readonly string[], options: SpawnOptions): ChildProcess {
  if (WIN && /\.(cmd|bat)$/i.test(cmd)) return spawn(winQuote(cmd), args.map(winQuote), { ...options, shell: true, windowsHide: true });
  return spawn(cmd, args, { ...options, windowsHide: true });
}

/** A shell command line (an installer's documented one): zsh on a Mac, cmd.exe on Windows. */
export function spawnShell(command: string, options: SpawnOptions): ChildProcess {
  if (WIN) return spawn(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", command], { ...options, windowsHide: true, windowsVerbatimArguments: true });
  return spawn("/bin/zsh", ["-c", command], options);
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

export { LOCAL_SERVERS };

/** A CLI's executable on this computer, or null. */
export const cliPath = (spec: Pick<CliSpec, "bins">, find: (bin: string) => string | null = (b) => which(b)): string | null => spec.bins.map((b) => find(b)).find(Boolean) ?? null;

/**
 * Every agent with its state: a CLI is usable in the chat (`available`) when it is installed and signed in (its own
 * status, `authOf`); a server when it answers with models.
 */
export async function detectProviders(
  custom: CustomServer[],
  keyOf: (id: string) => string | undefined,
  options: { fetch?: typeof fetch; which?: (bin: string) => string | null; authOf?: (spec: CliSpec, path: string) => Promise<AuthState>; modelsOf?: (spec: CliSpec) => CliModels | undefined } = {}
): Promise<ProviderInfo[]> {
  const find = options.which ?? ((b: string) => which(b));
  const clis: ProviderInfo[] = await Promise.all(
    CLI_SPECS.map(async (s): Promise<ProviderInfo> => {
      const path = cliPath(s, find);
      const auth: AuthState = !path ? { state: "not-installed" } : options.authOf ? await options.authOf(s, path).catch((): AuthState => ({ state: "signed-out", detail: tr("Couldn't read its sign-in") })) : { state: "connected" };
      const connected = auth.state === "connected";
      const own = options.modelsOf?.(s);
      return {
        id: s.id,
        kind: s.id,
        label: s.label,
        note: s.note && tr(s.note),
        available: !!path && connected,
        detail: path ?? undefined,
        models: own?.models ?? s.models,
        ...(own ? { modelLabels: own.labels } : {}),
        ...(s.efforts ? { efforts: s.efforts } : {}),
        problem: !path ? `${s.bins[0]} isn't installed` : connected ? undefined : "Signed out",
        auth,
        install: s.install,
      };
    })
  );
  const servers = await Promise.all(
    [...LOCAL_SERVERS.map((s) => ({ ...s, hasKey: false })), ...custom.map((c) => ({ ...c, install: undefined }))].map(async (s): Promise<ProviderInfo> => {
      try {
        const models = await listModels(s.baseUrl, { fetch: options.fetch, apiKey: keyOf(s.id) });
        return { id: s.id, kind: "openai-compatible", label: s.label, available: models.length > 0, detail: s.baseUrl, models, problem: models.length ? undefined : "No models loaded", hasKey: s.hasKey, install: s.install };
      } catch {
        return { id: s.id, kind: "openai-compatible", label: s.label, available: false, detail: s.baseUrl, models: [], problem: `Not running at ${s.baseUrl}`, hasKey: s.hasKey, install: s.install };
      }
    })
  );
  return [...clis, ...servers];
}
