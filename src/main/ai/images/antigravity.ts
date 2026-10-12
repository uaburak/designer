import type { ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { friendlyApiError } from "../../../shared/agents/errors";
import { AGY_DEFAULT_MODEL } from "../../agents/providers/antigravity";
import { LineSplitter, type SpawnFn } from "../../agents/providers/turns";
import { AiError, classify } from "../oneShot";
import { answerOf, type ImageAnswer, type ImageJob } from "./types";

/**
 * Antigravity's `generate_image` (docs/ai.md §2.5, owner §10.1): the owner's Google AI plan, no key. Make an image,
 * Edit with prompt and Expand (and Erase without a local model) are one headless `agy -p` run in a project of this
 * app's own that denies every MCP server, command and web call — what is left is reading its workspace (the run's
 * folder, where the input pictures are written) and its own generate_image, which saves the picture into the
 * conversation's folder (~/.gemini/antigravity-cli/brain/<conversation id>/). The picture is the newest image file
 * there made during the run (else a path the run names that exists).
 *
 * Expand: the picture on the larger canvas (the new area transparent) goes as `image.png` with the instruction to fill
 * the empty area; the view re-composites the untouched original over the answer, so it never shifts.
 */

export const AGY_IMAGE_PROJECT = "designerv2-images";

export function agyImageProject(workDir: string): string {
  return JSON.stringify(
    {
      id: AGY_IMAGE_PROJECT,
      name: "Wecra images",
      projectResources: { resources: [{ folderUri: `file://${encodeURI(workDir)}` }] },
      permissionGrants: { permissionGrants: { allow: [], deny: ["mcp(*)", "command(*)", "unsandboxed(*)", "read_url(*)", "execute_url(*)"] }, v2Migrated: true },
    },
    null,
    2
  );
}

const IMAGE_FILE = /\.(png|jpe?g|webp)$/i;

/** The prompt for one run: which files to look at, what to make, and to answer with the saved path. */
export function agyImagePrompt(job: Pick<ImageJob, "action" | "prompt" | "size" | "image" | "mask" | "reference">): string {
  const lines: string[] = [];
  const files: string[] = [];
  if (job.image) files.push("image.png (the picture to edit)");
  if (job.mask) files.push("mask.png (a mask: change only where it is transparent)");
  if (job.reference) files.push("reference.png (a reference for style and content)");
  if (files.length) lines.push(`Look at these files in your workspace with view_file: ${files.join(", ")}.`);
  const verb = job.image ? "Use your generate_image tool once to make the edited picture" : "Use your generate_image tool once to make this picture";
  const aspect = job.size ? ` Make it ${job.size.width} × ${job.size.height} px or the closest aspect ratio you can (${(job.size.width / job.size.height).toFixed(3)}:1).` : "";
  lines.push(`${verb}.${aspect}`);
  if (job.image) lines.push("Keep the picture's framing: the same composition, size and position of everything that should not change.");
  lines.push(`The request: ${job.prompt}`);
  lines.push("Use no other tool. When the picture is saved, answer with only its absolute path.");
  return lines.join("\n\n");
}

/** Image files under `dir` changed at or after `since` (ms), newest first. */
function newImages(dir: string, since: number): string[] {
  if (!existsSync(dir)) return [];
  const out: { path: string; at: number }[] = [];
  const walk = (d: string, depth: number) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      let st;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory() && depth < 3) walk(p, depth + 1);
      else if (st.isFile() && IMAGE_FILE.test(name) && st.mtimeMs >= since - 1000) out.push({ path: p, at: st.mtimeMs });
    }
  };
  walk(dir, 0);
  return out.sort((a, b) => b.at - a.at).map((x) => x.path);
}

export interface AgyImageOptions {
  path: string;
  spawn: SpawnFn;
  env: NodeJS.ProcessEnv;
  home: string;
  /** An empty folder of the run's own */
  cwd: string;
}

export function antigravityImage(job: ImageJob, o: AgyImageOptions): Promise<ImageAnswer> {
  const model = job.model && job.model !== "default" ? job.model : AGY_DEFAULT_MODEL;
  mkdirSync(o.cwd, { recursive: true });
  if (job.image) writeFileSync(join(o.cwd, "image.png"), job.image);
  if (job.mask) writeFileSync(join(o.cwd, "mask.png"), job.mask);
  if (job.reference) writeFileSync(join(o.cwd, "reference.png"), job.reference);
  const projectFile = join(o.home, ".gemini", "config", "projects", `${AGY_IMAGE_PROJECT}.json`);
  mkdirSync(dirname(projectFile), { recursive: true });
  writeFileSync(projectFile, agyImageProject(dirname(o.cwd)), { mode: 0o600 });
  const args = ["-p", agyImagePrompt(job), "--output-format", "stream-json", "--model", model, "--project", AGY_IMAGE_PROJECT, "--disable-slash-commands"];
  const started = Date.now();
  return new Promise((resolve, reject) => {
    if (job.signal.aborted) return reject(new AiError("cancelled", "Cancelled."));
    let child: ChildProcess;
    try {
      child = o.spawn(o.path, args, { cwd: o.cwd, env: o.env, stdio: ["pipe", "pipe", "pipe"] });
    } catch (err) {
      return reject(new AiError("no-provider", `Antigravity couldn't start: ${err instanceof Error ? err.message : String(err)}`));
    }
    child.stdin?.end();
    const lines = new LineSplitter();
    let conversation = "";
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
    const take = (l: Record<string, unknown>) => {
      if (typeof l.conversation_id === "string") conversation ||= l.conversation_id;
      if (l.event === "step_update") {
        const u = (l.step_update ?? {}) as Record<string, unknown>;
        if (typeof u.conversation_id === "string") conversation ||= u.conversation_id;
        const out = JSON.stringify((u.tool_info as { output?: unknown } | undefined)?.output ?? "");
        for (const m of out.matchAll(/(\/[^"'\s\\]+\.(?:png|jpe?g|webp))/gi)) named.push(m[1]);
        if (u.step_type === "agent_response" && typeof u.text_delta === "string") response += u.text_delta;
        if (u.state === "ERROR") {
          const info = (u.tool_info ?? {}) as { error?: { message?: string } | string };
          const why = typeof info.error === "string" ? info.error : (info.error?.message ?? "");
          if (why) error = why;
        }
      } else if (l.event === "result") {
        const r = (l.result ?? {}) as { status?: string; error?: unknown; response?: string };
        if (typeof r.response === "string") response = r.response;
        if (r.status && r.status !== "SUCCESS") error = (typeof r.error === "string" ? r.error : (r.error as { message?: string } | undefined)?.message) || `Antigravity stopped (${r.status}).`;
      }
    };
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (c: string) => lines.push(c).forEach(take));
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (d: string) => (stderr = (stderr + d).slice(-4000)));
    child.on("error", (err) => finish(() => reject(new AiError("no-provider", `Antigravity: ${err.message}`))));
    child.on("close", (code) => {
      lines.push("\n").forEach(take);
      finish(() => {
        for (const m of response.matchAll(/(\/[^"'\s`]+\.(?:png|jpe?g|webp))/gi)) named.unshift(m[1]);
        const brain = conversation && /^[\w-]+$/.test(conversation) ? join(o.home, ".gemini", "antigravity-cli", "brain", conversation) : null;
        const candidates = [...(brain ? newImages(brain, started) : []), ...named.filter((p) => isAbsolute(p) && existsSync(p) && statSync(p).mtimeMs >= started - 1000)];
        for (const p of candidates) {
          const answer = answerOf(readFileSync(p), model);
          if (answer) return resolve(answer);
        }
        if (error) return reject(classify(friendlyApiError(error) || error));
        if (code !== 0) return reject(classify(`Antigravity exited (${code})${stderr.trim() ? `: ${stderr.trim().split("\n").slice(-2).join(" ").slice(0, 400)}` : ""}`));
        reject(new AiError("bad-output", "Antigravity didn't make a picture."));
      });
    });
  });
}
