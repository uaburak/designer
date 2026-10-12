/**
 * A file's snapshot and images on their way to its room (2026-10-12: a moved file's upload died on the Worker's CPU,
 * leaving a file with no snapshot): with a declared length the body streams through the Worker untouched; a file
 * with no snapshot yet answers 404 `no_snapshot` (the store says "still uploading").
 */
import { beforeEach, describe, expect, it } from "vitest";
import { memoryRoomNamespace } from "./testing/memoryRooms";
import { WEB, world, type World } from "./testing/orgWorld";
import { roomsOn } from "./policy/region";

let w: World;

beforeEach(async () => {
  w = await world();
  const ns = memoryRoomNamespace(() => w.now.t);
  w.deps.rooms = roomsOn(ns.binding, w.d1);
});

const bytes = (n: number) => Uint8Array.from({ length: n }, (_, i) => (i * 7) & 255);

describe("uploads to a file's room", () => {
  it("a file with no snapshot yet: 404 no_snapshot", async () => {
    const r = await w.call("GET", `/files/${WEB}/snapshot`, w.people.alice.token);
    expect(r.status).toBe(404);
    expect(r.body).toEqual({ error: "no snapshot yet", code: "no_snapshot" });
  });

  it("with a content-length the snapshot streams to the room, charged by its length", async () => {
    const body = bytes(300_000);
    const put = await w.call("PUT", `/files/${WEB}/snapshot?seq=0`, w.people.alice.token, body, { "content-length": String(body.length) });
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    const got = await w.call("GET", `/files/${WEB}/snapshot`, w.people.alice.token);
    expect(got.status).toBe(200);
    expect(got.bytes).toEqual(body);
    expect(await w.rows(`SELECT bytes FROM stored_items WHERE item = ?1`, `f:${WEB}:snap`)).toEqual([{ bytes: body.length }]);
  });

  it("a declared length past the limit is refused before the body is read; without one, the body is read and checked", async () => {
    const big = await w.call("PUT", `/files/${WEB}/snapshot?seq=0`, w.people.alice.token, bytes(10), { "content-length": String(200 * 1024 * 1024) });
    expect(big.status).toBe(413);
    const image = bytes(5000);
    const sha = (await import("node:crypto")).createHash("sha1").update(image).digest("hex");
    const put = await w.call("PUT", `/files/${WEB}/blobs/${sha}`, w.people.alice.token, image);
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    expect(await w.rows(`SELECT bytes FROM stored_items WHERE item = ?1`, `f:${WEB}:b:${sha}`)).toEqual([{ bytes: image.length }]);
  });
});
