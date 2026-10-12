import type { WebContents } from "electron";
import { homedir } from "node:os";
import type { AiImageRequest } from "../../../shared/ai/types";
import { reportAiPrompt } from "../../account/governanceReports";
import { viewOf } from "../../views";
import { cliEnv, cliPath, spawnCli } from "../../agents/detect";
import { cliSpec } from "../../agents/providers";
import { aiRuns, sendAiEvent } from "../host";
import { ledgerBalance } from "../ledger";
import { aiSettings, aiWorkDir, imageKey } from "../settings";
import { runImage, type ImageRunDeps } from "./run";

/**
 * `ai:image` wired to the app (docs/ai.md §2.5): the run is tracked by main's AI runs (so `ai:cancel` and a closed
 * view stop it), its events go back to the view that asked as `ai:event`.
 */

export { cleanImageRequest } from "./run";

const deps = (): ImageRunDeps => ({
  settings: aiSettings,
  balance: ledgerBalance,
  imageKey,
  agyPath: () => {
    const spec = cliSpec("antigravity");
    return spec ? cliPath(spec) : null;
  },
  spawn: (cmd, args, options) => spawnCli(cmd, args, options),
  env: () => cliEnv(),
  home: homedir(),
  workDir: aiWorkDir(),
});

const watched = new WeakSet<WebContents>();

export function startImageRun(sender: WebContents, req: AiImageRequest): void {
  if (!watched.has(sender)) {
    watched.add(sender);
    sender.once("destroyed", () => aiRuns().cancelAll(sender.id));
  }
  if (req.prompt) reportAiPrompt(viewOf(sender)?.fileKey ?? null, req.prompt, req.action);
  const emit = (e: Parameters<typeof sendAiEvent>[2]) => sendAiEvent(sender, req.runId, e);
  const { signal, end } = aiRuns().track(sender.id, req.runId, emit);
  void runImage(req, deps(), emit, signal).finally(end);
}
