/**
 * The REST API's test world (docs/multiplayer.md §16.14): orgWorld's org (alice admin, bob, carol, dan with a View
 * seat, …) with real rooms (memoryRooms: RoomBox + Room + RestJobs on node:sqlite), fake render clients that upload
 * their parts through the API and answer `rest-job-done`, a recording `fetch` for webhook deliveries, and token helpers.
 */
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import type { Role } from "../../../src/shared/multiplayer/protocol";
import type { RestJob, RestJobPart } from "../../../src/shared/rest/types";
import { REST_TIMING } from "../rest/roomJobs";
import { memoryRooms, type MemoryMember, type MemoryRooms } from "./memoryRooms";
import { world, type Any, type World } from "./orgWorld";

export const sha1 = (b: Uint8Array) => createHash("sha1").update(b).digest("hex");

export interface Delivery {
  url: string;
  headers: Record<string, string>;
  body: Any;
  raw: string;
}

export interface RestWorld extends World {
  mem: MemoryRooms;
  deliveries: Delivery[];
  /** What the next deliveries answer (default 200) */
  answer: { status: number };
  /** A REST call with headers (`X-Figma-Token` by default) */
  rest(method: string, path: string, token?: string | null, body?: unknown, headers?: Record<string, string>): Promise<{ status: number; body: Any; headers: Headers; bytes: Uint8Array }>;
  pat(person: keyof World["people"], scopes: string[]): Promise<string>;
  planToken(scopes: string[]): Promise<string>;
  /** A render client of `key` for `person`: answers each job with `answer(job)` (parts: name → bytes), or never */
  renderer(key: string, person: keyof World["people"], role: Role, opts?: { helper?: boolean; answer?: (job: RestJob) => Record<string, Uint8Array> | { fail: string } | null; log?: string[] }): MemoryMember;
  /** Wait for pending async work (deliveries in waitUntil) */
  settle(): Promise<void>;
}

/** A file / nodes part: the answer's JSON without its opening brace, gzipped (§16.6) */
export const filePart = (doc: Record<string, unknown>) => gzipSync(Buffer.from(JSON.stringify(doc).slice(1)));
export const jsonPart = (doc: unknown) => gzipSync(Buffer.from(JSON.stringify(doc)));

export async function restWorld(): Promise<RestWorld> {
  REST_TIMING.clientMs = 150;
  REST_TIMING.waitMs = 600;
  const w = (await world()) as RestWorld;
  const mem = memoryRooms(() => w.now.t);
  w.mem = mem;
  w.deps.rooms = mem.rooms;
  w.deliveries = [];
  w.answer = { status: 200 };
  const pending: Promise<unknown>[] = [];
  w.deps.waitUntil = (p) => void pending.push(p);
  w.deps.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = String(init?.body ?? "");
    w.deliveries.push({ url: String(input), headers: Object.fromEntries(new Headers(init?.headers).entries()), body: JSON.parse(raw), raw });
    if (w.answer.status === 0) throw new Error("connection refused");
    return new Response("ok", { status: w.answer.status });
  }) as typeof fetch;
  w.settle = async () => {
    while (pending.length) await Promise.all(pending.splice(0));
  };
  w.rest = (method, path, token, body, headers = {}) => w.call(method, path, undefined, body, { ...(token ? { "x-figma-token": token } : {}), ...headers });
  w.pat = async (person, scopes) => {
    const r = await w.call("POST", "/me/tokens", w.people[person].token, { description: "ci", expiresInDays: 30, scopes });
    if (r.status !== 201) throw new Error(JSON.stringify(r.body));
    return r.body.token as string;
  };
  w.planToken = async (scopes) => {
    const r = await w.call("POST", `/orgs/${w.orgId}/admin/plan-tokens`, w.people.alice.token, { description: "plan", expiresInDays: 30, scopes });
    if (r.status !== 201) throw new Error(JSON.stringify(r.body));
    return r.body.token as string;
  };
  w.renderer = (key, person, role, opts = {}) => {
    const p = w.people[person];
    return mem.join(key, p.id, role, undefined, {
      render: true,
      helper: opts.helper,
      onJob: (id, job, member) => {
        opts.log?.push(`${person}:${job.kind}`);
        const a = opts.answer ? opts.answer(job) : null;
        if (!a) return;
        void (async () => {
          if ("fail" in a) return mem.say(key, member, { t: "rest-job-failed", id, err: a.fail });
          const parts: RestJobPart[] = [];
          for (const [name, bytes] of Object.entries(a as Record<string, Uint8Array>)) {
            const r = await w.call("PUT", `/files/${key}/rest-jobs/${id}/parts/${encodeURIComponent(name)}`, p.token, bytes);
            if (r.status !== 200) throw new Error(`upload ${r.status} ${JSON.stringify(r.body)}`);
            parts.push({ name, sha1: sha1(bytes), size: bytes.length, contentType: name === "json" ? "application/json" : "image/png" });
          }
          mem.say(key, member, { t: "rest-job-done", id, parts });
        })();
      },
    });
  };
  return w;
}
