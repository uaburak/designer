import type { ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { friendlyApiError } from "../../../shared/agents/errors";
import { LineSplitter, type SpawnFn } from "../../agents/providers/turns";
import { AiError, classify } from "../oneShot";
import { aspectOf } from "./gemini";
import { answerOf, referenceFile, type ImageAnswer, type ImageJob } from "./types";

/**
 * The Gemini CLI with Google's nanobanana extension (docs/studio.md §2.4, §5.3): one headless `gemini -p` run in the
 * run's own folder, where the input pictures are written. The extension is the only one loaded (`-e nanobanana`,
 * `--allowed-mcp-server-names nanobanana`) and a policy of the run's own allows its generate_image and edit_image and
 * denies every other tool (files, shell, web). The extension saves the picture in `nanobanana-output/` under its working
 * folder (the run's); the picture is the newest image there made during the run, else a path the run names that exists.
 *
 * Keys: the CLI's "Login with Google" no longer runs headless for individuals (it answers "This client is no longer
 * supported for Gemini Code Assist for individuals", found running it 2026-10-13), so the run uses an API key: it gets
 * a CLI home of its own (GEMINI_CLI_HOME, in the run's folder) whose settings pick "gemini-api-key" and which links the
 * owner's installed extension — the owner's own ~/.gemini is never written. The extension calls the Gemini API with a
 * key of its own: NANOBANANA_API_KEY (else NANOBANANA_GEMINI_API_KEY, NANOBANANA_GOOGLE_API_KEY, GEMINI_API_KEY,
 * GOOGLE_API_KEY), which `gemini extensions config nanobanana` keeps in the keychain. When Settings › AI has a Gemini key
 * it is passed as both GEMINI_API_KEY and NANOBANANA_API_KEY; the image model as NANOBANANA_MODEL (the extension's own
 * default otherwise).
 *
 * Its tools take one input picture: Fix label edits `image.png`; a request with references edits the first one (the
 * product photo) into the new picture, and the others are only named. The Gemini API route sends all of them.
 */

export const NANOBANANA = "nanobanana";
export const NANOBANANA_OUTPUT = "nanobanana-output";

/** The run's policy (the CLI's policy engine, TOML): the extension's two tools allowed, everything else denied. */
export const GEMINI_CLI_POLICY = `# Wecra image runs: only nanobanana's generate_image and edit_image
[[rule]]
mcpName = "${NANOBANANA}"
toolName = "generate_image"
decision = "allow"
priority = 900

[[rule]]
mcpName = "${NANOBANANA}"
toolName = "edit_image"
decision = "allow"
priority = 900

[[rule]]
toolName = "*"
decision = "deny"
priority = 100
`;

const IMAGE_FILE = /\.(png|jpe?g|webp)$/i;

/** The words the extension's tool gets: the request, its aspect, and which picture is which. */
function toolPrompt(job: Pick<ImageJob, "prompt" | "image" | "references" | "aspectRatio" | "size">): string {
  const parts = [job.prompt.trim()];
  const refs = job.references ?? [];
  if (!job.image && refs.length) parts.unshift(`The given picture is Image 1${refs[0].role ? ` (${refs[0].role})` : ""}: use it as the reference and make a new picture.`);
  const aspect = job.aspectRatio ?? aspectOf(job.size);
  if (aspect) parts.push(`Make the picture in the ${aspect} aspect ratio.`);
  return parts.join("\n\n");
}

/** The prompt for one run: which tool, on which file, with which words; answer with the saved path. */
export function geminiCliPrompt(job: Pick<ImageJob, "prompt" | "image" | "references" | "aspectRatio" | "size">): string {
  const refs = job.references ?? [];
  const file = job.image ? "image.png" : refs.length ? referenceFile(0, refs[0].mime) : null;
  const call = file ? `Call the ${NANOBANANA} edit_image tool exactly once, with file "${file}" and as prompt the text between <prompt> and </prompt>, word for word.` : `Call the ${NANOBANANA} generate_image tool exactly once, with outputCount 1 and as prompt the text between <prompt> and </prompt>, word for word.`;
  return [call, "Use no other tool. When the picture is saved, answer with only its absolute path.", `<prompt>\n${toolPrompt(job)}\n</prompt>`].join("\n\n");
}

/** Image files under `dir` changed at or after `since` (ms), newest first. */
function newImages(dir: string, since: number): string[] {
  if (!existsSync(dir)) return [];
  const out: { path: string; at: number }[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    try {
      const st = statSync(p);
      if (st.isFile() && IMAGE_FILE.test(name) && st.mtimeMs >= since - 1000) out.push({ path: p, at: st.mtimeMs });
    } catch {
      /* gone */
    }
  }
  return out.sort((a, b) => b.at - a.at).map((x) => x.path);
}

/** The extension's own words for a missing or refused key. */
const KEY_PROBLEM = /No valid API key|API key (?:not valid|is invalid)|Authentication failed|GEMINI_API_KEY (?:environment variable )?(?:not found|is not set)|must specify the GEMINI_API_KEY/i;
/** The key's prepaid credits are used up (the API's 402, seen 2026-10-13) */
const NO_CREDITS = /prepayment credits are depleted|Payment Required/i;

export interface GeminiCliImageOptions {
  path: string;
  spawn: SpawnFn;
  env: NodeJS.ProcessEnv;
  /** An empty folder of the run's own */
  cwd: string;
  /** Settings › AI's Gemini key, handed to the CLI and the extension (null: their own) */
  key?: string | null;
  /** The owner's home (the installed extension is ~/.gemini/extensions/nanobanana) */
  home: string;
}

/** The run's CLI home: API-key auth, the owner's nanobanana extension linked in. */
function cliHome(cwd: string, home: string): string {
  const dir = join(cwd, ".cli-home");
  const gemini = join(dir, ".gemini");
  mkdirSync(join(gemini, "extensions"), { recursive: true });
  writeFileSync(join(gemini, "settings.json"), JSON.stringify({ security: { auth: { selectedType: "gemini-api-key" } } }, null, 2));
  const ext = join(home, ".gemini", "extensions", NANOBANANA);
  if (existsSync(ext)) symlinkSync(ext, join(gemini, "extensions", NANOBANANA), "dir");
  return dir;
}

export function geminiCliImage(job: ImageJob, o: GeminiCliImageOptions): Promise<ImageAnswer> {
  mkdirSync(o.cwd, { recursive: true });
  if (job.image) writeFileSync(join(o.cwd, "image.png"), job.image);
  (job.references ?? []).forEach((r, i) => writeFileSync(join(o.cwd, referenceFile(i, r.mime)), r.data));
  const policy = join(o.cwd, "policy.toml");
  writeFileSync(policy, GEMINI_CLI_POLICY);
  const args = ["-p", geminiCliPrompt(job), "--output-format", "stream-json", "-e", NANOBANANA, "--allowed-mcp-server-names", NANOBANANA, "--policy", policy, "--skip-trust"];
  const env: NodeJS.ProcessEnv = { ...o.env, GEMINI_CLI_HOME: cliHome(o.cwd, o.home), ...(job.model ? { NANOBANANA_MODEL: job.model } : {}), ...(o.key ? { GEMINI_API_KEY: o.key, NANOBANANA_API_KEY: o.key } : {}) };
  const started = Date.now();
  return new Promise((resolve, reject) => {
    if (job.signal.aborted) return reject(new AiError("cancelled", "Cancelled."));
    let child: ChildProcess;
    try {
      child = o.spawn(o.path, args, { cwd: o.cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    } catch (err) {
      return reject(new AiError("no-provider", `The Gemini CLI couldn't start: ${err instanceof Error ? err.message : String(err)}`));
    }
    child.stdin?.end();
    const lines = new LineSplitter();
    let response = "";
    let error = "";
    const named: string[] = [];
    let stderr = "";
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      job.signal.removeEventListener("abort", onAbort);
      fn();
    };
    const onAbort = () => {
      if (child.exitCode === null) {
        child.kill("SIGINT");
        setTimeout(() => child.exitCode === null && child.kill("SIGKILL"), 3000).unref?.();
      }
      finish(() => reject(job.signal.reason instanceof AiError ? job.signal.reason : new AiError("cancelled", "Cancelled.")));
    };
    job.signal.addEventListener("abort", onAbort);
    const message = (e: unknown) => (typeof e === "string" ? e : ((e as { message?: string } | undefined)?.message ?? ""));
    const take = (l: Record<string, unknown>) => {
      if (l.type === "message" && l.role === "assistant" && typeof l.content === "string") response += l.content;
      else if (l.type === "tool_result") {
        const out = typeof l.output === "string" ? l.output : JSON.stringify(l.output ?? "");
        for (const m of out.matchAll(/((?:\/|[\w-]+\/)[^"'\s\\`]*\.(?:png|jpe?g|webp))/gi)) named.push(m[1]);
        if (l.status === "error" || KEY_PROBLEM.test(out)) error = message(l.error) || out;
      } else if (l.type === "error") error ||= message(l.message ?? l.error);
      else if (l.type === "result" && l.status && l.status !== "success") error ||= message(l.error) || `The Gemini CLI stopped (${String(l.status)}).`;
    };
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (c: string) => lines.push(c).forEach(take));
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (d: string) => (stderr = (stderr + d).slice(-4000)));
    child.on("error", (err) => finish(() => reject(new AiError("no-provider", `Gemini CLI: ${err.message}`))));
    child.on("close", (code) => {
      lines.push("\n").forEach(take);
      finish(() => {
        for (const m of response.matchAll(/(\/[^"'\s`]+\.(?:png|jpe?g|webp))/gi)) named.unshift(m[1]);
        // The inputs sit in the run's folder itself: never taken for the answer
        const fresh = (p: string) => dirname(p) !== o.cwd && existsSync(p) && statSync(p).mtimeMs >= started - 1000;
        const candidates = [...newImages(join(o.cwd, NANOBANANA_OUTPUT), started), ...named.map((p) => (isAbsolute(p) ? p : join(o.cwd, p))).filter(fresh)];
        for (const p of candidates) {
          const answer = answerOf(readFileSync(p), job.model);
          if (answer) return resolve(answer);
        }
        if (KEY_PROBLEM.test(error) || KEY_PROBLEM.test(stderr))
          return reject(new AiError("signed-out", "The nanobanana extension needs a Gemini API key. Add one in Settings › AI, or set it with “gemini extensions config nanobanana”."));
        if (NO_CREDITS.test(error) || NO_CREDITS.test(stderr)) return reject(new AiError("rate-limited", "Your Gemini API credits have run out. Add credits in Google AI Studio, or pick another image provider."));
        if (error) return reject(classify(friendlyApiError(error) || error));
        if (code !== 0) return reject(classify(`The Gemini CLI exited (${code})${stderr.trim() ? `: ${stderr.trim().split("\n").slice(-2).join(" ").slice(0, 400)}` : ""}`));
        reject(new AiError("bad-output", "The Gemini CLI didn't make a picture."));
      });
    });
  });
}
