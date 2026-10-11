/**
 * Where document reads and renders come from (docs/multiplayer.md §16.2 decisions 6–7, §16.6): `RenderBackend` is the
 * seam. Round 5 builds `ClientBackend` (the file's room hands the job to a connected client: an editor, a viewer, the
 * desktop app's render helper). `ServerBackend` (SVG / PDF / file JSON from a server build of the engine in the
 * file's Durable Object, `REST_SERVER_RENDER=1`, Workers Paid) is specified, not built: `serverRenderEnabled` stays
 * false and the room never tries it.
 */
import type { RestJob, RestJobResult } from "../../../src/shared/rest/types";
import type { Deps } from "../api";
import { askRoom, type JobOptions } from "./jobs";

export interface RenderBackend {
  canRender(job: RestJob): boolean;
  run(job: RestJob): Promise<RestJobResult>;
}

export class ClientBackend implements RenderBackend {
  constructor(
    private deps: Deps,
    private fileKey: string,
    private opts: JobOptions,
  ) {}

  canRender(): boolean {
    return true;
  }

  async run(job: RestJob): Promise<RestJobResult> {
    const a = await askRoom(this.deps, this.fileKey, job, this.opts);
    return a.ok ? { ok: true, parts: a.parts } : { ok: false, status: a.status, err: a.err };
  }
}

/** `REST_SERVER_RENDER=1` would turn the server backend on; it isn't built (decision 7), so never. */
export function serverRenderEnabled(env: Deps["env"]): boolean {
  void env;
  return false;
}

/** The backend for a job: the client one (round 5) */
export function backendFor(deps: Deps, fileKey: string, opts: JobOptions): RenderBackend {
  return new ClientBackend(deps, fileKey, opts);
}
