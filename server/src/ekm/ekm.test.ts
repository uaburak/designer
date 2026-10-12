/**
 * Round 14c — encryption key management, managed keys (docs/governance.md §2.10): the row cipher and the DEK wrapping,
 * the admin routes, and rooms (RoomBox + RoomEkm + RestJobs on node:sqlite, as FileRoom wires them) — the round trip,
 * a wrong or missing root key, lazy encryption on wake, encrypt-next, plain rows still readable, a region move.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { EKM_RECHECK_MS, ENC_HEADER_BYTES } from "../../../src/shared/org/governance";
import { Room } from "../../../src/shared/multiplayer/room";
import { Access } from "../org/db";
import type { Ctx } from "../org/http";
import { HttpError } from "../org/http";
import { moveObject, ROOM_PATHS } from "../policy/region";
import { RestJobs } from "../rest/roomJobs";
import { RoomBox } from "../roomBox";
import { sqliteStorage } from "../testing/memoryPreviews";
import { BRAND, DRAFT, sha1, WEB, world, type Any, type World } from "../testing/orgWorld";
import { readTextItems } from "../discovery/record";
import { sealWhere } from "./rows";
import { aesCipher, ENC_PREFIX_V1, isSealed, PLAIN_CIPHER, SealError } from "./cipher";
import { KeyUnavailable, newWrappedDek, unwrapDek } from "./keys";
import { RoomEkm } from "./room";
import { keyManagementRoute } from "./routes";

const ROOT = Buffer.alloc(32, 7).toString("base64");
const OTHER_ROOT = Buffer.alloc(32, 9).toString("base64");
const bytes = (s: string) => new TextEncoder().encode(s);
const str = (b: Uint8Array) => new TextDecoder().decode(b);
const big = (n: number, seed: number) => {
  const b = new Uint8Array(n);
  for (let i = 0; i < n; i++) b[i] = (i * 31 + seed) & 255;
  return b;
};

// ---- rooms as FileRoom wires them ---------------------------------------------------------------------------------

interface EkmRoom {
  storage: ReturnType<typeof sqliteStorage>;
  box: RoomBox;
  ekm: RoomEkm;
  rest: RestJobs;
  refused: number;
  /** A new object over the same storage (an eviction and a wake): the key read again before any call */
  wake(): Promise<void>;
  fetch(req: Request): Promise<Response>;
}

let w: World;
const env: { EKM_ROOT_KEY?: string } = {};
const rooms: Record<"default" | "eu", Map<string, EkmRoom>> = { default: new Map(), eu: new Map() };

function makeRoom(key: string): EkmRoom {
  const o = { storage: sqliteStorage(), refused: 0 } as EkmRoom;
  const now = () => w.now.t;
  const build = () => {
    const { sql, transaction } = o.storage;
    o.box = new RoomBox({ sql, transaction, now, setAlarm: () => {}, broadcast: () => {}, hasSession: () => false, cipher: () => o.ekm.key.cipher });
    o.ekm = new RoomEkm({ d1: w.d1, sql, rootKey: () => env.EKM_ROOT_KEY, now, fileKey: () => key, box: () => o.box, refuseSockets: () => void o.refused++ });
    const room = new Room(o.box.storage, () => {}, { now });
    o.rest = new RestJobs({ sql, transaction, now, room, lastSeq: () => o.box.storage.lastSeq(), hasVersion: () => false, wanted: async () => {} });
  };
  build();
  o.wake = async () => {
    build();
    await o.ekm.check();
  };
  o.fetch = async (req) => {
    const url = new URL(req.url);
    if (req.method === "DELETE" && url.pathname === "/room") {
      o.storage = sqliteStorage();
      build();
      return Response.json({ ok: true });
    }
    const gated = (await o.ekm.gate(req.method, url.pathname)) ?? (await o.ekm.route(req.method, url.pathname));
    if (gated) return gated;
    if (url.pathname.startsWith("/room/rest") || url.pathname === "/room/thumbnail") return (await o.ekm.rest(req, url, o.rest)) ?? new Response("not found", { status: 404 });
    return (await o.box.fetch(req)) ?? new Response("not found", { status: 404 });
  };
  return o;
}

const ns = (j: "default" | "eu"): Any => ({
  idFromName: (n: string) => n,
  get: (id: string) => {
    let o = rooms[j].get(id);
    // FileRoom checks its key in `blockConcurrencyWhile`; here the first gated call (or roomOf) does.
    if (!o) rooms[j].set(id, (o = makeRoom(id)));
    return o;
  },
  ...(j === "default" ? { jurisdiction: () => ns("eu") } : {}),
});

/** The room of `key` in the default jurisdiction, woken (its key read) */
async function roomOf(key: string, j: "default" | "eu" = "default"): Promise<EkmRoom> {
  const o = ns(j).get(key) as EkmRoom;
  await o.ekm.check();
  return o;
}

const call = (o: EkmRoom, method: string, path: string, body?: BodyInit, user = "u1") => o.fetch(new Request(`https://room${path}`, { method, body, headers: { "x-user-id": user, "x-user-name": "U" } }));
const rawRows = (o: EkmRoom, table: string, col = "bytes") => o.storage.sql.exec<Record<string, ArrayBuffer>>(`SELECT ${col} AS b FROM ${table} ORDER BY rowid`).toArray().map((r) => new Uint8Array(r.b));

async function adminCall(method: string, rest = "", body?: unknown, who: "alice" | "bob" = "alice"): Promise<{ status: number; body: Any }> {
  const user = (await w.deps.db.user(w.people[who].id))!;
  const path = `/orgs/${w.orgId}/admin/key-management${rest}`;
  const url = new URL(`https://api${path}`);
  const req = new Request(url, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { "content-type": "application/json" } });
  const ctx: Ctx = { req, url, deps: w.deps, user, parts: path.split("/").filter(Boolean), m: method, acc: new Access(w.deps, user) };
  try {
    const res = await keyManagementRoute(ctx);
    return { status: res.status, body: await res.json() };
  } catch (e) {
    if (e instanceof HttpError) return { status: e.status, body: { error: e.message, code: e.code } };
    throw e;
  }
}

const enable = async () => {
  await w.run(`UPDATE orgs SET governance_plus = 1 WHERE id = ?1`, w.orgId);
  const r = await adminCall("PUT", "", { source: "managed" });
  expect(r.status).toBe(200);
  return r.body;
};

const activity = (action: string) => w.rows(`SELECT actor_id, entity_id, details FROM activity_log WHERE action = ?1 ORDER BY id`, action);

/** A room with a snapshot (2 chunks), an image, a base, frames and a named version */
async function populate(o: EkmRoom) {
  const snap = big(1_500_000, 3);
  const img = big(70_000, 5);
  expect((await call(o, "PUT", "/room/snapshot?seq=0", snap)).status).toBe(200);
  expect((await call(o, "PUT", `/room/blobs/${sha1(img)}`, img)).status).toBe(200);
  expect((await call(o, "PUT", "/room/base?seq=0", bytes("base@0"))).status).toBe(200);
  for (const [i, m] of ["edit-1", "edit-2"].entries()) o.box.storage.append({ seq: i + 1, sessionID: 1, batch: 1, message: bytes(m) });
  const v = await call(o, "POST", "/room/versions", JSON.stringify({ kind: "named", title: "V1" }));
  expect(v.status).toBe(201);
  return { snap, img, version: ((await v.json()) as Any).version };
}

async function expectContent(o: EkmRoom, c: Awaited<ReturnType<typeof populate>>) {
  expect(sha1(new Uint8Array(await (await call(o, "GET", "/room/snapshot")).arrayBuffer()))).toBe(sha1(c.snap));
  expect(sha1(new Uint8Array(await (await call(o, "GET", `/room/blobs/${sha1(c.img)}`)).arrayBuffer()))).toBe(sha1(c.img));
  expect(str(new Uint8Array(await (await call(o, "GET", "/room/base")).arrayBuffer()))).toBe("base@0");
  expect(sha1(new Uint8Array(await (await call(o, "GET", `/room/versions/${c.version.id}/snapshot`)).arrayBuffer()))).toBe(sha1(c.snap));
  const frames = new Uint8Array(await (await call(o, "GET", `/room/versions/${c.version.id}/frames`)).arrayBuffer());
  expect(str(frames)).toContain("edit-1");
  expect(str(frames)).toContain("edit-2");
}

function expectSealed(o: EkmRoom, sealed: boolean) {
  for (const [t, col] of [["snapshot", "bytes"], ["blobs", "bytes"], ["base_chunks", "bytes"], ["history_snapshots", "bytes"], ["history_frames", "message"]]) {
    const rows = rawRows(o, t, col);
    expect(rows.length, t).toBeGreaterThan(0);
    for (const r of rows) expect(isSealed(r), t).toBe(sealed);
  }
  // the live journal stays plain
  for (const r of rawRows(o, "frames", "message")) expect(isSealed(r)).toBe(false);
}

beforeEach(async () => {
  w = await world();
  env.EKM_ROOT_KEY = ROOT;
  Object.defineProperty(w.deps.env, "EKM_ROOT_KEY", { get: () => env.EKM_ROOT_KEY, configurable: true });
  rooms.default.clear();
  rooms.eu.clear();
  w.deps.rooms = {
    async fetch(key, path, init) {
      const o = ns("default").get(key) as EkmRoom;
      return o.fetch(new Request(`https://room${path}`, { method: init.method, body: init.body as BodyInit }));
    },
  };
});

// ---- the cipher and the keys ------------------------------------------------------------------------------------------

describe("the row cipher and managed keys", () => {
  it("seals as DV2E | 2 | iv | ciphertext + tag, opens it, and reads rows without the header as plain", async () => {
    const wrapped = await newWrappedDek(ROOT, "org1");
    const c = aesCipher(await unwrapDek(ROOT, "org1", wrapped), WEB);
    const sealed = await c.seal(bytes("hello"), "blobs");
    expect(str(sealed.subarray(0, 4))).toBe("DV2E");
    expect(sealed[4]).toBe(2);
    expect(sealed.length).toBe(ENC_HEADER_BYTES + 5 + 16);
    expect(isSealed(sealed)).toBe(true);
    expect(str(await c.open(sealed, "blobs"))).toBe("hello");
    // every seal has its own IV
    expect(await c.seal(bytes("hello"), "blobs")).not.toEqual(sealed);
    expect(str(await c.open(bytes("plain row"), "blobs"))).toBe("plain row");
    // another DEK can't open it; a damaged row neither
    const other = aesCipher(await unwrapDek(ROOT, "org1", await newWrappedDek(ROOT, "org1")), WEB);
    await expect(other.open(sealed, "blobs")).rejects.toBeInstanceOf(SealError);
    const bad = sealed.slice();
    bad[bad.length - 1] ^= 1;
    await expect(c.open(bad, "blobs")).rejects.toBeInstanceOf(SealError);
    expect(await PLAIN_CIPHER.seal(bytes("x"), "blobs")).toEqual(bytes("x"));
  });

  it("v2 binds the file and the table (review fix): another file's room or another table can't open the row; v1 rows still open", async () => {
    const key = await unwrapDek(ROOT, "org1", await newWrappedDek(ROOT, "org1"));
    const c = aesCipher(key, WEB);
    const sealed = await c.seal(bytes("hello"), "blobs");
    await expect(aesCipher(key, DRAFT).open(sealed, "blobs")).rejects.toBeInstanceOf(SealError);
    await expect(c.open(sealed, "rest_blobs")).rejects.toBeInstanceOf(SealError);
    // a version keeps the snapshot's rows as stored: snapshot and history_snapshots share one AAD name
    expect(str(await c.open(await c.seal(bytes("snap"), "snapshot"), "history_snapshots"))).toBe("snap");
    // a v1 row (the header alone as associated data), as sealed before the fix
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const v1 = new Uint8Array([...ENC_PREFIX_V1]);
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: v1 }, key, bytes("old row")));
    const row = new Uint8Array([...v1, ...iv, ...ct]);
    expect(isSealed(row)).toBe(true);
    expect(str(await c.open(row, "snapshot"))).toBe("old row");
  });

  it("a wrong, missing or malformed root key, or another org's row, doesn't unwrap the DEK", async () => {
    const wrapped = await newWrappedDek(ROOT, "org1");
    await expect(unwrapDek(OTHER_ROOT, "org1", wrapped)).rejects.toBeInstanceOf(KeyUnavailable);
    await expect(unwrapDek(undefined, "org1", wrapped)).rejects.toBeInstanceOf(KeyUnavailable);
    await expect(unwrapDek("not base64!", "org1", wrapped)).rejects.toBeInstanceOf(KeyUnavailable);
    await expect(unwrapDek(Buffer.alloc(16).toString("base64"), "org1", wrapped)).rejects.toBeInstanceOf(KeyUnavailable);
    await expect(unwrapDek(ROOT, "org2", wrapped)).rejects.toBeInstanceOf(KeyUnavailable);
    await expect(newWrappedDek(undefined, "org1")).rejects.toBeInstanceOf(KeyUnavailable);
  });
});

// ---- the admin routes ---------------------------------------------------------------------------------------------------

describe("admin › key management", () => {
  it("org admins only; needs Governance+; can't be turned off; enabling twice is a no-op", async () => {
    expect((await adminCall("GET")).body).toEqual({ enabled: false, source: null, state: null, checkedAt: null, files: { total: 5, encrypted: 0 }, encrypting: null });
    expect((await adminCall("GET", "", undefined, "bob")).body.code).toBe("not_admin");
    expect((await adminCall("PUT", "", { source: "aws" })).status).toBe(400);
    const no = await adminCall("PUT", "", { source: "managed" });
    expect(no).toMatchObject({ status: 403, body: { code: "governance_plus_required" } });
    await w.run(`UPDATE orgs SET governance_plus = 1 WHERE id = ?1`, w.orgId);
    env.EKM_ROOT_KEY = undefined;
    expect((await adminCall("PUT", "", { source: "managed" })).body.code).toBe("key_unavailable");
    env.EKM_ROOT_KEY = ROOT;
    const on = await adminCall("PUT", "", { source: "managed" });
    expect(on.body).toMatchObject({ enabled: true, source: "managed", state: "ok", files: { total: 5, encrypted: 0 }, encrypting: null });
    expect(await adminCall("PUT", "", { source: "managed" })).toMatchObject({ status: 200, body: { enabled: true } });
    expect((await activity("ekm_enable")).map((r) => r.actor_id)).toEqual([w.people.alice.id]);
    expect((await adminCall("DELETE")).status).toBe(405);
    const [row] = await w.rows(`SELECT wrapped_dek, state FROM org_keys WHERE org_id = ?1`, w.orgId);
    expect(row.wrapped_dek).toMatch(/^v1\./);
    expect(row.state).toBe("ok");
  });

  it("GET checks the root key against the org's key and records it", async () => {
    await enable();
    w.now.t += 1000;
    expect((await adminCall("GET")).body).toMatchObject({ state: "ok", checkedAt: w.now.t });
    env.EKM_ROOT_KEY = OTHER_ROOT;
    expect((await adminCall("GET")).body).toMatchObject({ state: "unavailable" });
    expect(await activity("ekm_key_unavailable")).toHaveLength(1);
    expect((await adminCall("GET")).body.state).toBe("unavailable");
    expect(await activity("ekm_key_unavailable")).toHaveLength(1);
    env.EKM_ROOT_KEY = ROOT;
    expect((await adminCall("GET")).body.state).toBe("ok");
  });
});

// ---- rooms ----------------------------------------------------------------------------------------------------------

describe("a room's rows", () => {
  it("round trip: checkpoints and media are sealed at rest and read back plain; the journal and metadata stay plain", async () => {
    await enable();
    const o = await roomOf(WEB);
    expect(o.ekm.key.state).toBe("ok");
    const c = await populate(o);
    expectSealed(o, true);
    await expectContent(o, c);
    // a new file is encrypted at once: its first wake marked it
    expect((await w.rows(`SELECT encrypted_at FROM files WHERE key = ?1`, WEB))[0].encrypted_at).not.toBeNull();
    // the version's size is the plain size
    expect(c.version.sizeBytes).toBe(c.snap.length + "edit-1edit-2".length);
    // versions and meta are plain SQL
    expect(o.storage.sql.exec<Any>(`SELECT title FROM versions`).toArray()[0].title).toBe("V1");
  });

  it("rows without the header are still read (a snapshot half plain, half sealed)", async () => {
    await enable();
    const o = await roomOf(WEB);
    const c = await populate(o);
    // the first chunk written back plain (as a row from before encryption would be)
    const first = await o.ekm.key.cipher.open(rawRows(o, "snapshot")[0], "snapshot");
    o.storage.sql.exec(`UPDATE snapshot SET bytes = ? WHERE idx = 0`, first.slice().buffer);
    expect(isSealed(rawRows(o, "snapshot")[0])).toBe(false);
    expect(isSealed(rawRows(o, "snapshot")[1])).toBe(true);
    expect(sha1(new Uint8Array(await (await call(o, "GET", "/room/snapshot")).arrayBuffer()))).toBe(sha1(c.snap));
  });

  it("an existing room is encrypted on its next wake (fig_file_encrypt, no actor); a wake with nothing to do writes nothing", async () => {
    const o = await roomOf(WEB);
    expect(o.ekm.key.state).toBe("none");
    const c = await populate(o);
    expectSealed(o, false);
    await enable();
    // still awake: it learns at its hourly check
    expect(o.ekm.key.due()).toBe(false);
    await o.wake();
    expect(o.ekm.key.state).toBe("ok");
    expectSealed(o, true);
    await expectContent(o, c);
    expect((await activity("fig_file_encrypt")).map((r) => [r.actor_id, r.entity_id, JSON.parse(r.details).trigger])).toEqual([[null, WEB, "wake"]]);
    const before = rawRows(o, "snapshot");
    await o.wake();
    expect(rawRows(o, "snapshot").map(sha1)).toEqual(before.map(sha1));
    expect(await activity("fig_file_encrypt")).toHaveLength(1);
  });

  it("an awake room picks up a newly enabled key at its hourly re-check", async () => {
    const o = await roomOf(WEB);
    await populate(o);
    await enable();
    w.now.t += EKM_RECHECK_MS;
    expect((await call(o, "GET", "/room/head")).status).toBe(200);
    expectSealed(o, true);
  });

  it("a version's frames left plain by an object that stopped are sealed on the next wake", async () => {
    await enable();
    const o = await roomOf(WEB);
    await populate(o);
    // what an eviction between the version's transaction and its sealing leaves behind
    const plain = await o.ekm.key.cipher.open(rawRows(o, "history_frames", "message")[0], "history_frames");
    o.storage.sql.exec(`UPDATE history_frames SET message = ? WHERE seq = 1`, plain.slice().buffer);
    o.box.storage.setMeta("ekmDirty", 1);
    await o.wake();
    expectSealed(o, true);
    expect(o.box.storage.meta("ekmDirty")).toBe(-1);
  });

  it("a plain row that merely starts with the header is sealed by the first sweep (review fix); a row that doesn't open still answers key_unavailable", async () => {
    const o = await roomOf(WEB);
    const c = await populate(o);
    // a blob from before key management whose bytes happen to start with "DV2E" | 1
    const look = new Uint8Array([...ENC_PREFIX_V1, ...big(100, 1)]);
    expect((await call(o, "PUT", `/room/blobs/${sha1(look)}`, look)).status).toBe(200);
    expect(isSealed(rawRows(o, "blobs").at(-1)!)).toBe(true);
    await enable();
    await o.wake();
    expectSealed(o, true);
    expect(rawRows(o, "blobs").at(-1)![4]).toBe(2);
    expect(sha1(new Uint8Array(await (await call(o, "GET", `/room/blobs/${sha1(look)}`)).arrayBuffer()))).toBe(sha1(look));
    await expectContent(o, c);
    // a sealed row damaged afterwards is never read as plain
    const bad = rawRows(o, "blobs").at(-1)!.slice();
    bad[bad.length - 1] ^= 1;
    o.storage.sql.exec(`UPDATE blobs SET bytes = ? WHERE sha1 = ?`, bad.buffer, sha1(look));
    const r = await call(o, "GET", `/room/blobs/${sha1(look)}`);
    expect(r.status).toBe(503);
    expect(((await r.json()) as Any).code).toBe("key_unavailable");
  });

  it("Discovery's part is read opened (review fix): RestJobs' bytes are sealed, RoomEkm.partBytes opens them", async () => {
    await enable();
    const o = await roomOf(WEB);
    const json = bytes(JSON.stringify([{ nodeId: "1:2", textType: "in_file", text: "Hello" }]));
    const sha = sha1(json);
    // as RestJobs stores an uploaded part and RoomEkm.rest seals it right after
    o.storage.sql.exec(`INSERT INTO rest_blobs (sha1, idx, bytes) VALUES (?, 0, ?)`, sha, json.slice().buffer);
    expect(await sealWhere(o.storage.sql, o.ekm.key.cipher, "rest_blobs", "sha1 = ?", sha)).toBe(1);
    expect(await readTextItems(o.rest.partBytes(sha)!)).toBeNull();
    expect(await readTextItems((await o.ekm.partBytes(sha))!)).toEqual([{ nodeId: "1:2", textType: "in_file", text: "Hello" }]);
    expect(await o.ekm.partBytes("0".repeat(40))).toBeNull();
  });

  it("REST parts and the thumbnail (rest_blobs) are sealed; image fills come back plain", async () => {
    await enable();
    const o = await roomOf(WEB);
    const c = await populate(o);
    const png = big(5000, 9);
    expect((await call(o, "PUT", "/room/thumbnail", png)).status).toBe(200);
    for (const r of rawRows(o, "rest_blobs")) expect(isSealed(r)).toBe(true);
    const t = await call(o, "GET", "/room/thumbnail");
    expect(t.headers.get("x-sha1")).toBe(sha1(png));
    expect(sha1(new Uint8Array(await t.arrayBuffer()))).toBe(sha1(png));
    expect(sha1(new Uint8Array(await (await call(o, "GET", `/room/rest-blob/${sha1(png)}`)).arrayBuffer()))).toBe(sha1(png));
    expect(sha1(new Uint8Array(await (await call(o, "GET", `/room/rest-blob/${sha1(c.img)}`)).arrayBuffer()))).toBe(sha1(c.img));
  });
});

describe("the key unavailable", () => {
  it("a wrong or missing root key: 503 key_unavailable to calls and sockets, org_keys marked and logged once; restored, it works again", async () => {
    await enable();
    const o = await roomOf(WEB);
    const c = await populate(o);
    for (const root of [OTHER_ROOT, undefined]) {
      env.EKM_ROOT_KEY = root;
      await o.wake();
      expect(o.ekm.key.state).toBe("unavailable");
      for (const [m, p] of [["GET", "/room/snapshot"], ["GET", "/room/ws"], ["PUT", "/room/snapshot?seq=2"], ["GET", "/room/rest-blob/" + sha1(c.img)], ["POST", "/room/versions"]]) {
        const res = await call(o, m, p, m === "GET" ? undefined : "x");
        expect([p, res.status, ((await res.json()) as Any).code]).toEqual([p, 503, "key_unavailable"]);
      }
    }
    expect((await w.rows(`SELECT state FROM org_keys`))[0].state).toBe("unavailable");
    expect(await activity("ekm_key_unavailable")).toHaveLength(1);
    // another room of the org: no second log
    const b = await roomOf(BRAND);
    expect(b.ekm.key.state).toBe("unavailable");
    expect(await activity("ekm_key_unavailable")).toHaveLength(1);
    // a move's dump needs no key
    expect((await call(o, "GET", "/room/dump")).status).toBe(200);
    env.EKM_ROOT_KEY = ROOT;
    await o.wake();
    expect(o.ekm.key.state).toBe("ok");
    expect((await w.rows(`SELECT state FROM org_keys`))[0].state).toBe("ok");
    await expectContent(o, c);
  });

  it("an awake room whose key fails at the hourly re-check closes its sockets", async () => {
    await enable();
    const o = await roomOf(WEB);
    await populate(o);
    env.EKM_ROOT_KEY = OTHER_ROOT;
    expect((await call(o, "GET", "/room/head")).status).toBe(200);
    w.now.t += EKM_RECHECK_MS;
    expect((await call(o, "GET", "/room/head")).status).toBe(503);
    expect(o.refused).toBe(1);
  });

  it("a room that holds sealed rows but finds no key in D1 is unavailable, not plain", async () => {
    await enable();
    const o = await roomOf(WEB);
    await populate(o);
    await w.run(`DELETE FROM org_keys`);
    await o.wake();
    expect(o.ekm.key.state).toBe("unavailable");
  });
});

describe("encrypt-next", () => {
  it("encrypts one file per call, with progress, until none is left", async () => {
    expect((await adminCall("POST", "/encrypt-next")).status).toBe(409);
    const web = await roomOf(WEB);
    const brand = await roomOf(BRAND);
    const cw = await populate(web);
    await populate(brand);
    await enable();
    const seen: string[] = [];
    for (;;) {
      const r = await adminCall("POST", "/encrypt-next");
      expect(r.status).toBe(200);
      if (!r.body.encrypting) {
        expect(r.body.files).toEqual({ total: 5, encrypted: 5 });
        break;
      }
      seen.push(r.body.encrypting);
      expect(r.body.files.encrypted).toBe(seen.length);
    }
    expect(seen).toHaveLength(5);
    expect(seen).toContain(WEB);
    expectSealed(web, true);
    expectSealed(brand, true);
    await expectContent(web, cw);
    // WEB and BRAND were awake (no key yet): the admin's call encrypted them. The others woke for it and encrypted
    // themselves on wake, as FileRoom does (no actor).
    const log = await activity("fig_file_encrypt");
    expect(log).toHaveLength(5);
    expect(log.filter((r) => r.actor_id === w.people.alice.id).map((r) => r.entity_id).sort()).toEqual([BRAND, WEB].sort());
  });

  it("answers 503 key_unavailable when the room can't unwrap the key", async () => {
    await populate(await roomOf(WEB));
    await enable();
    env.EKM_ROOT_KEY = OTHER_ROOT;
    expect((await adminCall("POST", "/encrypt-next")).body.code).toBe("key_unavailable");
    expect((await w.rows(`SELECT COUNT(encrypted_at) AS n FROM files`))[0].n).toBe(0);
  });
});

describe("the region move of an encrypted room (§15.10)", () => {
  it("copies the sealed rows as they are; the copy reads them with the org's key", async () => {
    await enable();
    const old = await roomOf(WEB);
    const c = await populate(old);
    const sealedSnap = rawRows(old, "snapshot");
    await moveObject(ns("default"), WEB, null, "eu", ROOM_PATHS, async () => {});
    const copy = rooms.eu.get(WEB)!;
    await copy.ekm.check();
    expect(rawRows(copy, "snapshot").map(sha1)).toEqual(sealedSnap.map(sha1));
    expect(copy.box.storage.meta("ekmDirty")).toBe(-1);
    expectSealed(copy, true);
    await expectContent(copy, c);
  });

  it("a plain room moved into an org with a key is sealed by its copy", async () => {
    const old = await roomOf(WEB);
    const c = await populate(old);
    await enable();
    // the old object is still awake with no key (its hourly check hasn't come): it dumps plain rows
    await moveObject(ns("default"), WEB, null, "eu", ROOM_PATHS, async () => {});
    const copy = rooms.eu.get(WEB)!;
    expect(copy.box.storage.meta("ekmDirty")).toBe(1);
    await copy.ekm.check();
    expectSealed(copy, true);
    await expectContent(copy, c);
  });
});
