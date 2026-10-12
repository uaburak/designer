import type { WebContents } from "electron";
import { homedir } from "node:os";
import { AI_TEXT_DEFAULT_ORDER, type AiAction, type AiRoute, type AiRunEvent, type AiRunRequest } from "../../shared/ai/types";
import { reportAiPrompt } from "../account/governanceReports";
import { initGovernanceReports } from "../account/governanceReportsWiring";
import { viewOf } from "../views";
import { agentSettings, providers, serverRoute } from "../agents/host";
import { cliSpec } from "../agents/providers";
import { cliEnv, cliPath, spawnCli } from "../agents/detect";
import { listModels } from "../agents/openaiBridge";
import { ledgerBalance } from "./ledger";
import { AiError } from "./oneShot";
import { AiRuns, type ResolvedRoute } from "./run";
import { aiSettings, aiWorkDir } from "./settings";

/**
 * Main's AI runs wired to the app (docs/ai.md §2.1–2.2): Settings › AI's routes over the Agents tab's providers, the
 * ledger (6g) for the credits stop, the CLIs' spawn. `ai:run` / `ai:cancel` (src/main/ipc.ts) land here; each event
 * goes back to the view that asked as `ai:event` with its runId.
 */

/** Which CLIs take `--json-schema` (their `--help` lists it), by path. */
const schemaFlag = new Map<string, Promise<boolean>>();

function helpLists(path: string, flag: string): Promise<boolean> {
  let p = schemaFlag.get(path);
  if (!p) {
    p = new Promise<boolean>((resolve) => {
      let out = "";
      const child = spawnCli(path, ["--help"], { env: cliEnv(), stdio: ["ignore", "pipe", "pipe"] });
      child.stdout?.on("data", (d) => (out += d));
      child.stderr?.on("data", (d) => (out += d));
      child.on("error", () => resolve(false));
      child.on("close", () => resolve(out.includes(flag)));
      setTimeout(() => child.exitCode === null && child.kill(), 8000).unref?.();
    });
    schemaFlag.set(path, p);
  }
  return p;
}

/** The route of an action (docs/ai.md §2.1): asked, the action's override, the text route, else the first connected default. */
export async function resolveRoute(action: AiAction, asked?: AiRoute): Promise<ResolvedRoute> {
  const s = aiSettings();
  let route: AiRoute | null = asked ?? s.actions[action] ?? s.text;
  if (!route) {
    const list = await providers();
    const first = AI_TEXT_DEFAULT_ORDER.map((id) => list.find((p) => p.id === id && p.available)).find(Boolean);
    if (!first) throw new AiError("no-provider", "No AI provider is connected. Pick one in Settings › AI, or set up an agent in Settings › Agents.");
    route = { providerId: first.id };
  }
  const saved = agentSettings().models[route.providerId];
  const spec = cliSpec(route.providerId);
  if (spec) {
    if (!spec.oneShot) throw new AiError("unsupported", `${spec.label} can't run AI actions.`);
    const path = cliPath(spec);
    if (!path) throw new AiError("no-provider", `${spec.label} isn't installed on this computer.`);
    return { kind: "cli", providerId: spec.id, spec, path, model: route.model ?? saved, effort: route.effort };
  }
  const srv = serverRoute(route.providerId);
  if (!srv) throw new AiError(route.providerId === "local" ? "unsupported" : "no-provider", route.providerId === "local" ? "Text actions need a model provider, not a local model." : "That AI provider isn't set up any more. Pick one in Settings › AI.");
  let model = route.model ?? saved;
  if (!model) {
    const models = await listModels(srv.baseUrl, { apiKey: srv.apiKey, timeoutMs: 3000 }).catch(() => [] as string[]);
    model = models[0];
  }
  if (!model) throw new AiError("no-model", `${srv.label} has no model loaded.`);
  return { kind: "server", providerId: srv.id, label: srv.label, baseUrl: srv.baseUrl, apiKey: srv.apiKey, model };
}

let runs: AiRuns | null = null;
// The org reports (docs/governance.md §2.11, §2.12) are wired the first time this module loads (the ai IPC handlers import it at startup).
initGovernanceReports();

/** The app's runs (6b's image runs `track` themselves here so `ai:cancel` reaches them). */
export function aiRuns(): AiRuns {
  runs ??= new AiRuns({
    settings: aiSettings,
    resolveRoute,
    balance: ledgerBalance,
    spawn: (cmd, args, options) => spawnCli(cmd, args, options),
    env: () => cliEnv(),
    workDir: aiWorkDir(),
    home: homedir(),
    takesSchema: (r) => helpLists(r.path, "--json-schema"),
  });
  return runs;
}

const watched = new WeakSet<WebContents>();

/** An event to the view that asked (dropped once it is gone). */
export const sendAiEvent = (sender: WebContents, runId: string, event: AiRunEvent) => {
  if (!sender.isDestroyed()) sender.send("ai:event", { runId, event });
};

/** `ai:run`: starts the run; its events come as `ai:event`. A view that goes away cancels its runs. */
export function startRun(sender: WebContents, req: AiRunRequest): void {
  if (!watched.has(sender)) {
    watched.add(sender);
    sender.once("destroyed", () => aiRuns().cancelAll(sender.id));
  }
  // Client-reported to Discovery for an org file (docs/governance.md §2.11): once per run, fire-and-forget.
  reportAiPrompt(viewOf(sender)?.fileKey ?? null, req.prompt, req.action);
  void aiRuns().start(sender.id, req, (e) => sendAiEvent(sender, req.runId, e));
}

export const cancelRun = (sender: WebContents, runId: string) => aiRuns().cancel(sender.id, runId);
