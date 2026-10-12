/**
 * The REST job runner (docs/multiplayer.md §16.6): an editor with a shared file's engine loaded tells the store it can
 * render (`multiplayer.restRender` — the room then hears `hello {render: true}`, `helper: true` in main's hidden render
 * helper), runs the jobs the room sends it one at a time, and hands back their parts (`multiplayer.restAnswer`; the
 * store uploads them and answers `rest-job-done`):
 *
 * - `file` / `nodes`: Figma's file JSON (fileJson.ts), part `json` — the answer without its opening `{`, gzipped;
 * - `images`: one part per id (images.ts);
 * - `variables_local`: part `json`, the gzipped answer (variablesJson.ts);
 * - `discovery_text`: part `json`, the gzipped DiscoveryTextItem[] (discoveryText.ts; docs/governance.md §2.11);
 * - `variables_post`: one actor write (variablesPost.ts), then part `json`; a refusal answers `"400 <message>"`.
 *
 * A job with `version` reads that version in a scratch engine (the source's `openVersion`, as Compare changes does).
 */
import { discoveryText } from "./discoveryText";
import { Engine } from "@/engine/Engine";
import type { Message } from "@/engine/codec";
import type { MultiplayerEvent, MultiplayerRepository, RestJobAnswer, RestJobRequest } from "../../../../shared/multiplayer/types";
import type { RestJob } from "../../../../shared/rest/types";
import type { ImageBytes } from "../exportCore";
import { fileJson, filePart, gzip, nodesJson } from "./fileJson";
import { renderImages } from "./images";
import { variablesLocalJson } from "./variablesJson";
import { applyVariablesPost } from "./variablesPost";

/** What a job runs against: the editor's engine and its file */
export interface RestRunnerHost {
  engine: Engine;
  fileKey: string;
  /** The file's images by SHA-1 (an SVG / PDF inlines them) */
  images: ImageBytes | null;
  /** Resolves once the edits made so far are with the store (a POST's frames go before its answer) */
  flush(): Promise<void>;
  /** A saved version as a document (room versions of a shared file); absent: versions can't be read here */
  openVersion?(id: string): Promise<Message>;
}

export type RestRunnerStore = Pick<MultiplayerRepository, "restRender" | "restAnswer" | "watch">;

const json = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));

/** One job's answer (never throws: a failure is `{err}`, with an HTTP status first where one fits) */
export async function runRestJob(host: RestRunnerHost, req: Pick<RestJobRequest, "job" | "seq" | "name" | "lastModified">): Promise<RestJobAnswer> {
  const job: RestJob = req.job;
  let engine = host.engine;
  let scratch: Engine | null = null;
  try {
    if (job.kind !== "variables_post" && job.version) {
      if (!host.openVersion) return { err: "400 This version can't be read here" };
      const message = await host.openVersion(job.version).catch(() => null);
      if (!message) return { err: "404 Version not found" };
      scratch = await Engine.create(null, { sessionID: 1 });
      scratch.load(message);
      engine = scratch;
    }
    const ctx = { name: req.name, lastModified: req.lastModified, version: job.kind !== "variables_post" && job.version ? job.version : String(req.seq) };
    switch (job.kind) {
      case "file":
        return { parts: [{ name: "json", bytes: await filePart(await fileJson(engine, job.params, ctx)), contentType: "application/json" }] };
      case "nodes":
        return { parts: [{ name: "json", bytes: await filePart(await nodesJson(engine, job.params, ctx)), contentType: "application/json" }] };
      case "images":
        return { parts: await renderImages(engine, host.images, job.params) };
      case "discovery_text":
        return { parts: [{ name: "json", bytes: await gzip(json(discoveryText(engine))), contentType: "application/json" }] };
      case "variables_local":
        return { parts: [{ name: "json", bytes: await gzip(json(variablesLocalJson(engine))), contentType: "application/json" }] };
      case "variables_post": {
        const r = await applyVariablesPost(engine, job.body);
        if (!r.ok) return { err: `${r.status} ${r.message}` };
        await host.flush();
        return { parts: [{ name: "json", bytes: await gzip(json(r.answer)), contentType: "application/json" }] };
      }
      default:
        return { err: "400 Unknown job" };
    }
  } catch (e) {
    return { err: `500 ${e instanceof Error ? e.message : String(e)}` };
  } finally {
    scratch?.destroy();
  }
}

/**
 * Registers the editor as the file's renderer and answers its jobs until the returned stop is called. `helper`: the
 * hidden render helper (asked after every editor and viewer).
 */
export function startRestRunner(host: RestRunnerHost, store: RestRunnerStore, opts: { helper?: boolean; onJob?: (req: RestJobRequest) => void } = {}): () => void {
  let token: string | null = null;
  let stopped = false;
  let queue: Promise<void> = Promise.resolve();
  const early: RestJobRequest[] = [];
  const take = (req: RestJobRequest) => {
    opts.onJob?.(req);
    queue = queue.then(async () => {
      if (stopped || host.engine.destroyed) return void (await store.restAnswer(host.fileKey, req.id, { err: "503 The file was closed" }).catch(() => {}));
      const answer = await runRestJob(host, req);
      await store.restAnswer(host.fileKey, req.id, answer).catch(() => {});
    });
  };
  const off = store.watch((e: MultiplayerEvent) => {
    const req = e.restJob;
    if (stopped || e.fileKey !== host.fileKey || !req) return;
    if (token === null) early.push(req);
    else if (req.to === token) take(req);
  });
  void store.restRender(host.fileKey, true, { helper: opts.helper === true }).then(
    (t) => {
      if (stopped) return void (t && store.restRender(host.fileKey, false, {}, t).catch(() => {}));
      token = t;
      for (const req of early.splice(0)) if (req.to === token) take(req);
    },
    () => {},
  );
  return () => {
    if (stopped) return;
    stopped = true;
    off();
    if (token) void store.restRender(host.fileKey, false, {}, token).catch(() => {});
  };
}
