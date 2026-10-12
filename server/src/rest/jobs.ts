/**
 * Render jobs, the Worker's side (docs/multiplayer.md §16.6): ask the file's room (`POST /room/rest-job`), wait at
 * most 25 s, read a part's bytes back. The room does the rest (rest/roomJobs.ts).
 */
import type { RestJob, RestJobPart } from "../../../src/shared/rest/types";
import type { Deps } from "../api";
import { RestError } from "./http";
import { REST_TIMING, type JobAnswer } from "./roomJobs";

export interface JobOptions {
  /** People whose desktop render helper may start when no client can render (owner and editors) */
  wanted: string[];
}

export const NO_CLIENT = "No client available to render this file. Open the file in DesignerV2 and try again.";

export const KEY_UNAVAILABLE = "This file is unavailable because its encryption key can't be reached";

/** A room that can't unwrap its org's key answers 503 `key_unavailable` (docs/governance.md §2.10): so does the REST call */
async function throwIfKeyUnavailable(res: Response): Promise<void> {
  if (res.status !== 503) return;
  const body = (await res.clone().json().catch(() => null)) as { code?: unknown } | null;
  if (body?.code === "key_unavailable") throw new RestError(503, KEY_UNAVAILABLE, { code: "key_unavailable" });
}

/** The room's answer, or a 503 when it takes longer than the Worker waits */
export async function askRoom(deps: Deps, fileKey: string, job: RestJob, opts: JobOptions): Promise<JobAnswer> {
  const waitMs = REST_TIMING.waitMs;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<JobAnswer>((resolve) => {
    timer = setTimeout(() => resolve({ ok: false, status: 503, err: NO_CLIENT }), waitMs + 500);
  });
  const ask = (async (): Promise<JobAnswer> => {
    const res = await deps.rooms.fetch(fileKey, `/room/rest-job?fileKey=${encodeURIComponent(fileKey)}`, { method: "POST", body: JSON.stringify({ job, waitMs, wanted: opts.wanted }) });
    await throwIfKeyUnavailable(res);
    if (!res.ok && res.status !== 400) return { ok: false, status: 502, err: "The file's room couldn't take the job" };
    return (await res.json()) as JobAnswer;
  })();
  try {
    return await Promise.race([ask, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** A part's bytes from the room */
export async function partBytes(deps: Deps, fileKey: string, part: RestJobPart): Promise<Uint8Array | null> {
  const res = await deps.rooms.fetch(fileKey, `/room/rest-blob/${part.sha1}?fileKey=${encodeURIComponent(fileKey)}`, { method: "GET" });
  await throwIfKeyUnavailable(res);
  return res.ok ? new Uint8Array(await res.arrayBuffer()) : null;
}

/** Who may start a render helper for this file: its owner and its editors (§16.6) */
export async function wantedFor(deps: Deps, fileKey: string): Promise<string[]> {
  const { results } = await deps.db.d1
    .prepare(`SELECT owner_id AS id FROM files WHERE key = ?1 UNION SELECT user_id AS id FROM members WHERE file_key = ?1 AND role = 'editor' AND user_id IS NOT NULL`)
    .bind(fileKey)
    .all<{ id: string }>();
  return results.map((r) => r.id);
}

/** gzip of a string (a one-member stream) */
export async function gzip(text: string): Promise<Uint8Array> {
  const stream = new Blob([new TextEncoder().encode(text)]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Does the caller take gzip? */
export const acceptsGzip = (req: Request): boolean => /\bgzip\b/i.test(req.headers.get("accept-encoding") ?? "");

/**
 * A JSON answer from a gzipped part: passed through as it is to a caller that takes gzip (`content-encoding: gzip`,
 * the runtime told not to encode again), else unzipped. `prefix`: per-caller fields put before the part's own (file /
 * nodes: the part is the answer without its opening `{`), as a gzip member of its own.
 */
export async function jsonFromPart(req: Request, part: Uint8Array, prefix: string | null, headers: Record<string, string>): Promise<Response> {
  const base = { "content-type": "application/json; charset=utf-8", "access-control-allow-origin": "*", ...headers };
  if (acceptsGzip(req)) {
    const body = prefix === null ? part : concat([await gzip(prefix), part]);
    return new Response(body, { headers: { ...base, "content-encoding": "gzip" }, encodeBody: "manual" } as ResponseInit);
  }
  const text = await gunzip(part);
  return new Response(prefix === null ? text : concat([new TextEncoder().encode(prefix), text]), { headers: base });
}

export function concat(list: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(list.reduce((n, b) => n + b.length, 0));
  let at = 0;
  for (const b of list) {
    out.set(b, at);
    at += b.length;
  }
  return out;
}
