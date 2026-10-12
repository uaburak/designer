/**
 * The Worker's side of render jobs (rest/jobs.ts) when the file's room refuses: found in the round 14 end-to-end run
 * (docs/governance.md "§9 End-to-end run") — a room that can't unwrap its org's key answers 503 `key_unavailable`, and
 * `/v1/files/:key` said 502 "The file's room couldn't take the job" instead of §2.10's 503 `key_unavailable`.
 */
import { describe, expect, it } from "vitest";
import type { Deps } from "../api";
import { RestError } from "./http";
import { askRoom, partBytes } from "./jobs";

const depsAnswering = (res: () => Response) => ({ rooms: { fetch: async () => res() } }) as unknown as Deps;
const keyUnavailable = () => Response.json({ error: "this file's encryption key is unavailable", code: "key_unavailable" }, { status: 503 });

describe("rest/jobs: the room's refusals", () => {
  it("key_unavailable from the room is a 503 key_unavailable for the REST call (jobs and parts)", async () => {
    const deps = depsAnswering(keyUnavailable);
    const job = askRoom(deps, "file_abc123", { kind: "file", params: {} }, { wanted: [] });
    await expect(job).rejects.toBeInstanceOf(RestError);
    await expect(job).rejects.toMatchObject({ status: 503, extra: { code: "key_unavailable" } });
    await expect(partBytes(deps, "file_abc123", { name: "json", sha1: "a".repeat(40), size: 1, contentType: "application/json" } as never)).rejects.toMatchObject({ status: 503, extra: { code: "key_unavailable" } });
  });

  it("other failures keep their answers: 502 for a job, null for a part", async () => {
    const deps = depsAnswering(() => new Response("boom", { status: 503 }));
    expect(await askRoom(deps, "file_abc123", { kind: "file", params: {} }, { wanted: [] })).toEqual({ ok: false, status: 502, err: "The file's room couldn't take the job" });
    expect(await partBytes(deps, "file_abc123", { name: "json", sha1: "a".repeat(40), size: 1, contentType: "application/json" } as never)).toBeNull();
  });
});
