/**
 * Home's File settings (docs/home.md "File settings [ours]"): `GET /files/:key/report` and `GET /files/:key/activity`
 * put together what the server already keeps about a file — its owner, its stored bytes by kind, its versions,
 * comments and invitations — for the people with access to it, paged and filtered.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { handle, type Deps } from "./api";
import { Db } from "./db";
import { pageOf, storedKind } from "./fileReport";
import { sqliteD1 } from "./testing/sqliteD1";
import type { FileActivityEvent, FileActivityPage, FileServerReport } from "../../src/shared/store/fileSettings";

const ORIGIN = "https://designer.example.workers.dev";
let deps: Deps;
let now: number;

beforeEach(() => {
  now = Date.UTC(2026, 9, 19);
  deps = {
    db: new Db(sqliteD1()),
    env: { SESSION_SECRET: "s".repeat(40), DEV_AUTH: "1" },
    rooms: {
      async fetch(_key, path) {
        if (path === "/room/versions")
          return Response.json({
            versions: [
              { id: "v2", kind: "named", title: "Hand-off", createdAt: now - 1000, editors: [{ id: "u1", name: "Ada" }] },
              { id: "v1", kind: "autosave", title: null, createdAt: now - 5000, editors: [{ id: "u1", name: "Ada" }] },
            ],
          });
        return new Response("room");
      },
    },
    now: () => now,
    fetch: async () => new Response("{}"),
  };
});

const call = (method: string, path: string, token?: string, body?: unknown) =>
  handle(new Request(ORIGIN + path, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined }), deps);

async function signIn(email: string) {
  const res = await call("POST", "/auth/dev", undefined, { email, name: email.split("@")[0] });
  return (await res.json()) as { token: string; user: { id: string } };
}

async function sharedFile() {
  const owner = await signIn("owner@example.com");
  expect((await call("POST", "/files", owner.token, { key: "file_rep001", name: "Landing" })).status).toBe(201);
  now += 60_000;
  expect((await call("PUT", "/files/file_rep001/members", owner.token, { email: "viewer@example.com", role: "viewer" })).status).toBe(200);
  const d1 = deps.db.d1;
  for (const [item, bytes] of [
    ["f:file_rep001:snap", 1000],
    ["f:file_rep001:thumb", 50],
    ["f:file_rep001:b:aaaa", 300],
    ["f:file_rep001:b:bbbb", 200],
    ["f:file_rep001:v:v2", 900],
    ["f:file_rep0010:snap", 7], // another file whose key starts the same: not counted
  ] as const)
    await d1.prepare(`INSERT INTO stored_items (item, owner_id, bytes) VALUES (?1, ?2, ?3)`).bind(item, owner.user.id, bytes).run();
  await d1.prepare(`INSERT INTO comments (id, file_key, thread_id, user_id, message, created_at) VALUES ('c1', 'file_rep001', 'c1', ?1, 'Make the button bigger', ?2)`).bind(owner.user.id, now).run();
  return owner;
}

describe("GET /files/:key/report", () => {
  it("gives the owner, the stored bytes by kind, versions, comments and the owner's quota", async () => {
    const owner = await sharedFile();
    const res = await call("GET", "/files/file_rep001/report", owner.token);
    expect(res.status).toBe(200);
    const r = (await res.json()) as FileServerReport;
    expect(r.owner?.email).toBe("owner@example.com");
    expect(r.role).toBe("owner");
    expect(r.place.kind).toBe("drafts"); // POST /files makes a draft of its owner (docs/cloud.md §2)
    const by = Object.fromEntries(r.storage.map((p) => [p.kind, p]));
    expect(by.document.bytes).toBe(1000);
    expect(by.thumbnail.bytes).toBe(50);
    expect(by.images).toEqual({ kind: "images", bytes: 500, count: 2 });
    expect(by.versions.bytes).toBe(900);
    expect(r.totalBytes).toBe(2450);
    expect(r.versions).toBe(2);
    expect(r.lastEditedBy).toBe("Ada");
    expect(r.comments).toEqual({ threads: 1, open: 1 });
    expect(r.quota?.storageLimit).toBeGreaterThan(0);
    expect(r.quota?.files).toBe(1);
  });

  it("is for people with access only, and gives a viewer no quota", async () => {
    await sharedFile();
    const stranger = await signIn("stranger@example.com");
    expect((await call("GET", "/files/file_rep001/report", stranger.token)).status).toBe(404);
    const viewer = await signIn("viewer@example.com");
    const r = (await (await call("GET", "/files/file_rep001/report", viewer.token)).json()) as FileServerReport;
    expect(r.role).toBe("viewer");
    expect(r.quota).toBeNull();
  });
});

describe("GET /files/:key/activity", () => {
  it("lists creation, invitations, comments and versions, newest first, filtered and paged", async () => {
    const owner = await sharedFile();
    const page = (await (await call("GET", "/files/file_rep001/activity", owner.token)).json()) as FileActivityPage;
    expect(page.events.map((e) => e.action)).toEqual(["comment", "member-added", "named", "autosave", "created"]);
    expect(page.events.find((e) => e.action === "member-added")?.detail).toBe("viewer@example.com · viewer");
    expect(page.next).toBeNull();
    const comments = (await (await call("GET", "/files/file_rep001/activity?kinds=comment", owner.token)).json()) as FileActivityPage;
    expect(comments.events.map((e) => e.detail)).toEqual(["Make the button bigger"]);
    const first = (await (await call("GET", "/files/file_rep001/activity?limit=2", owner.token)).json()) as FileActivityPage;
    expect(first.events).toHaveLength(2);
    expect(first.next).toBe(2);
    const rest = (await (await call("GET", `/files/file_rep001/activity?limit=10&cursor=${first.next}`, owner.token)).json()) as FileActivityPage;
    expect(rest.events.map((e) => e.action)).toEqual(["named", "autosave", "created"]);
  });

  it("doesn't tell a viewer who was invited", async () => {
    await sharedFile();
    const viewer = await signIn("viewer@example.com");
    const page = (await (await call("GET", "/files/file_rep001/activity?kinds=access", viewer.token)).json()) as FileActivityPage;
    expect(page.events).toHaveLength(1);
    expect(page.events[0].detail).toBeNull();
  });
});

describe("helpers", () => {
  it("names stored items' kinds", () => {
    expect(storedKind("f:k:snap")).toBe("document");
    expect(storedKind("f:k:base")).toBe("document");
    expect(storedKind("f:k:thumb")).toBe("thumbnail");
    expect(storedKind("f:k:b:abc")).toBe("images");
    expect(storedKind("f:k:v:abc")).toBe("versions");
    expect(storedKind("p:id:doc")).toBe("previews");
  });

  it("pages a filtered log", () => {
    const ev = (n: number, kind: FileActivityEvent["kind"]): FileActivityEvent => ({ id: `s:${n}`, at: n, kind, action: kind, actor: null, detail: null, source: "server" });
    const all = [ev(5, "comment"), ev(4, "opened"), ev(3, "comment"), ev(2, "comment")];
    expect(pageOf(all, ["comment"], 0, 2)).toEqual({ events: [all[0], all[2]], next: 2 });
    expect(pageOf(all, ["comment"], 2, 2)).toEqual({ events: [all[3]], next: null });
  });
});
