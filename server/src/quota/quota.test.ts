/**
 * Public sign-up (docs/multiplayer.md §17) on a node:sqlite world: every quota kind, suspension, the sign-up modes,
 * operator-only access, account deletion, the legal pages, throttling and the unauthenticated routes writing nothing.
 */
import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { QUOTA_LIMITS } from "../../../src/shared/quota";
import type { PreviewManifest } from "../../../src/shared/preview/format";
import { handle, type Deps } from "../api";
import { Db, type D1Like } from "../db";
import type { PreviewEnv } from "../previews";
import { charge as restCharge } from "../rest/rate";
import { memoryPreviews } from "../testing/memoryPreviews";
import { sqliteD1 } from "../testing/sqliteD1";
import { b64url, sha256b64url } from "../tokens";
import { guardedUpload, sweepQuotas } from "./quota";
import { resetThrottle, THROTTLE_PER_MINUTE } from "./throttle";

const ORIGIN = "https://designer.example.workers.dev";
const OPERATOR = "design.burakkoc@gmail.com";
const MB = 1024 * 1024;

let now: number;
let d1: D1Like;
let deps: Deps;
let google: Record<string, unknown>;
let roomCalls: { key: string; path: string }[];

beforeEach(() => {
  now = Date.UTC(2026, 9, 12, 12);
  resetThrottle();
  roomCalls = [];
  d1 = sqliteD1();
  const previews = memoryPreviews(() => now);
  google = { iss: "https://accounts.google.com", aud: "cid", sub: "g-1", email: "new@example.com", email_verified: true, name: "New", exp: now / 1000 + 3600 };
  const env: PreviewEnv & Deps["env"] = { SESSION_SECRET: "s".repeat(40), DEV_AUTH: "1", GOOGLE_CLIENT_ID: "cid", GOOGLE_CLIENT_SECRET: "csecret", DB: d1, PREVIEWS: previews.binding };
  deps = {
    db: new Db(d1),
    env,
    rooms: {
      async fetch(key, path) {
        roomCalls.push({ key, path });
        return new Response("{}", { status: 200 });
      },
    },
    now: () => now,
    fetch: async () => Response.json({ id_token: `x.${b64url(new TextEncoder().encode(JSON.stringify(google)))}.y` }),
  };
});

const call = (method: string, path: string, opts: { token?: string; body?: unknown; headers?: Record<string, string> } = {}) =>
  handle(
    new Request(ORIGIN + path, {
      method,
      headers: { ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}), ...opts.headers },
      body: opts.body === undefined ? undefined : opts.body instanceof Uint8Array ? (opts.body as BodyInit) : JSON.stringify(opts.body),
    }),
    deps,
  );

async function dev(email: string): Promise<{ token: string; id: string }> {
  const r = await call("POST", "/auth/dev", { body: { email, name: email.split("@")[0] } });
  expect(r.status).toBe(200);
  const b = (await r.json()) as { token: string; user: { id: string } };
  return { token: b.token, id: b.user.id };
}

/** Google's flow up to the loopback: its `code` or `error` */
async function googleSignIn(claims: Record<string, unknown>, ip = "203.0.113.7"): Promise<{ code: string | null; error: string | null }> {
  Object.assign(google, claims);
  const challenge = await sha256b64url("v".repeat(50));
  const headers = { "cf-connecting-ip": ip };
  const login = await call("GET", `/auth/login?method=google&port=50123&state=${"a".repeat(20)}&challenge=${challenge}`, { headers });
  const st = new URL(login.headers.get("location")!).searchParams.get("state")!;
  const cb = await call("GET", `/auth/callback?code=good&state=${encodeURIComponent(st)}`, { headers });
  const back = new URL(cb.headers.get("location")!);
  return { code: back.searchParams.get("code"), error: back.searchParams.get("error") };
}

async function override(operator: string, userId: string, kind: string, limit: number | null) {
  const r = await call("PUT", `/operator/accounts/${userId}/quota`, { token: operator, body: { kind, limit } });
  expect(r.status).toBe(200);
}

const share = (token: string, key: string) => call("POST", "/files", { token, body: { key, name: key } });
const storedOf = async (id: string) => (await d1.prepare(`SELECT stored_bytes FROM users WHERE id = ?1`).bind(id).first<{ stored_bytes: number }>())!.stored_bytes;
const serverBytes = async () => (await d1.prepare(`SELECT n FROM quota_counters WHERE subject = '*' AND kind = 'server_storage_bytes'`).first<{ n: number }>())?.n ?? 0;
const bodyOf = async (r: Response) => (await r.json()) as Record<string, unknown>;

describe("account quotas", () => {
  it("shared_files: at most the limit of files owned; re-sharing one's own is free; an override raises it", async () => {
    const op = await dev(OPERATOR);
    const a = await dev("a@x.co");
    await override(op.token, a.id, "shared_files", 2);
    expect((await share(a.token, "file-1")).status).toBe(201);
    expect((await share(a.token, "file-2")).status).toBe(201);
    expect((await share(a.token, "file-1")).status).toBe(201);
    const refused = await share(a.token, "file-3");
    expect(refused.status).toBe(403);
    expect(await bodyOf(refused)).toMatchObject({ code: "quota_exceeded", kind: "shared_files", limit: 2, error: expect.stringContaining("limit of 2 files") });
    await override(op.token, a.id, "shared_files", null);
    expect((await share(a.token, "file-3")).status).toBe(201);
  });

  it("storage_bytes: uploads charge the file's owner by their change; over the limit 403 before the room; deletion releases", async () => {
    const op = await dev(OPERATOR);
    const a = await dev("a@x.co");
    await override(op.token, a.id, "storage_bytes", 1000);
    await share(a.token, "file-1");
    expect((await call("PUT", "/files/file-1/snapshot?seq=0", { token: a.token, body: new Uint8Array(600) })).status).toBe(200);
    expect(await storedOf(a.id)).toBe(600);
    // A new snapshot replaces the old one: only the change counts
    expect((await call("PUT", "/files/file-1/snapshot?seq=5", { token: a.token, body: new Uint8Array(700) })).status).toBe(200);
    expect(await storedOf(a.id)).toBe(700);
    const sha = "a".repeat(40);
    roomCalls = [];
    const over = await call("PUT", `/files/file-1/blobs/${sha}`, { token: a.token, body: new Uint8Array(400) });
    expect(over.status).toBe(403);
    expect(await bodyOf(over)).toMatchObject({ code: "quota_exceeded", kind: "storage_bytes", limit: 1000 });
    expect(roomCalls).toEqual([]);
    expect((await call("PUT", `/files/file-1/blobs/${sha}`, { token: a.token, body: new Uint8Array(300) })).status).toBe(200);
    expect(await storedOf(a.id)).toBe(1000);
    expect(await serverBytes()).toBe(1000);
    expect((await call("DELETE", "/files/file-1", { token: a.token })).status).toBe(200);
    expect(await storedOf(a.id)).toBe(0);
    expect(await serverBytes()).toBe(0);
  });

  it("an editor's upload is charged to the owner; ownership moves the charge", async () => {
    const a = await dev("a@x.co");
    const b = await dev("b@x.co");
    await share(a.token, "file-1");
    expect((await call("PUT", "/files/file-1/members", { token: a.token, body: { email: "b@x.co", role: "editor" } })).status).toBe(200);
    expect((await call("PUT", "/files/file-1/snapshot?seq=0", { token: b.token, body: new Uint8Array(50) })).status).toBe(200);
    expect([await storedOf(a.id), await storedOf(b.id)]).toEqual([50, 0]);
    expect((await call("POST", "/files/file-1/transfer", { token: a.token, body: { email: "b@x.co" } })).status).toBe(200);
    expect([await storedOf(a.id), await storedOf(b.id)]).toEqual([0, 50]);
  });

  it("server_storage_bytes: no cap by default (docs/cloud.md §3); the operator's stops uploads for everyone (507)", async () => {
    const a = await dev("a@x.co");
    await share(a.token, "file-1");
    await d1.prepare(`INSERT INTO quota_counters (subject, kind, window, n) VALUES ('*', 'server_storage_bytes', 0, ?1)`).bind(2 * 1024 * MB - 10).run();
    expect((await call("PUT", "/files/file-1/snapshot?seq=0", { token: a.token, body: new Uint8Array(20) })).status).toBe(200);
    await d1.prepare(`INSERT INTO server_settings (k, v, updated_at) VALUES ('server_storage_bytes', ?1, 0)`).bind(String(2 * 1024 * MB)).run();
    const r = await call("PUT", "/files/file-1/snapshot?seq=0", { token: a.token, body: new Uint8Array(40) });
    expect(r.status).toBe(507);
    expect(await bodyOf(r)).toMatchObject({ code: "quota_exceeded", kind: "server_storage_bytes" });
  });

  it("a huge upload is refused by its declared length, before the body is read", async () => {
    const a = await dev("a@x.co");
    let read = false;
    const req = { headers: new Headers({ "content-length": String(200 * MB) }), arrayBuffer: async () => ((read = true), new ArrayBuffer(0)) } as unknown as Request;
    await expect(guardedUpload(deps, req, { id: a.id }, { ownerId: a.id, item: "f:x:snap" }, 90 * MB, "snapshot too large")).rejects.toMatchObject({ status: 413 });
    // Declared within the size limit but past the storage quota: refused before reading too
    const big = { headers: new Headers({ "content-length": String(QUOTA_LIMITS.storage_bytes + 1) }), arrayBuffer: async () => ((read = true), new ArrayBuffer(0)) } as unknown as Request;
    await expect(guardedUpload(deps, big, { id: a.id }, { ownerId: a.id, item: "f:x:snap" }, 64 * 1024 * MB, "too large")).rejects.toMatchObject({ status: 403, code: "quota_exceeded" });
    expect(read).toBe(false);
  });

  it("uploads_per_day: 429 past the day's count; the next day counts again", async () => {
    const op = await dev(OPERATOR);
    const a = await dev("a@x.co");
    await override(op.token, a.id, "uploads_per_day", 2);
    await share(a.token, "file-1");
    for (let i = 0; i < 2; i++) expect((await call("PUT", `/files/file-1/snapshot?seq=${i}`, { token: a.token, body: new Uint8Array(1) })).status).toBe(200);
    const r = await call("PUT", "/files/file-1/snapshot?seq=3", { token: a.token, body: new Uint8Array(1) });
    expect(r.status).toBe(429);
    expect(await bodyOf(r)).toMatchObject({ code: "quota_exceeded", kind: "uploads_per_day", limit: 2 });
    now += 86_400_000;
    expect((await call("PUT", "/files/file-1/snapshot?seq=4", { token: a.token, body: new Uint8Array(1) })).status).toBe(200);
  });

  it("previews: the count, their bytes charged, dropped images and unpublish released, expired ones swept", async () => {
    const op = await dev(OPERATOR);
    const a = await dev("a@x.co");
    await override(op.token, a.id, "previews", 1);
    const sha1 = (b: Uint8Array) => createHash("sha1").update(b).digest("hex");
    const img = new Uint8Array(30).fill(3);
    const manifest = (id: string, images: string[], expiresAt: number | null = null): PreviewManifest => ({ format: 1, previewId: id, fileName: "P", publishedAt: now, expiresAt, pages: [{ id: "0:1", name: "Page 1", frames: [] }], snapshot: "doc.kiwi", documentFormatVersion: 1, derivedDataVersion: 1, images, options: { inspect: true, export: true } });
    const id = "P".repeat(22);
    expect((await call("PUT", `/previews/${id}/images/${sha1(img)}`, { token: a.token, body: img })).status).toBe(200);
    expect((await call("PUT", `/previews/${id}/doc`, { token: a.token, body: new Uint8Array(10) })).status).toBe(200);
    expect((await call("PUT", `/previews/${id}/manifest`, { token: a.token, body: { manifest: manifest(id, [sha1(img)]) } })).status).toBe(200);
    expect(await storedOf(a.id)).toBe(40);
    // Republished without the image: it is no longer charged
    expect((await call("PUT", `/previews/${id}/manifest`, { token: a.token, body: { manifest: manifest(id, []) } })).status).toBe(200);
    expect(await storedOf(a.id)).toBe(10);
    const second = await call("PUT", `/previews/${"Q".repeat(22)}/doc`, { token: a.token, body: new Uint8Array(1) });
    expect(second.status).toBe(403);
    expect(await bodyOf(second)).toMatchObject({ code: "quota_exceeded", kind: "previews", limit: 1 });
    expect((await call("DELETE", `/previews/${id}`, { token: a.token })).status).toBe(200);
    expect(await storedOf(a.id)).toBe(0);
    // An expired preview: the daily sweep drops its row and its bytes
    const id2 = "R".repeat(22);
    expect((await call("PUT", `/previews/${id2}/doc`, { token: a.token, body: new Uint8Array(5) })).status).toBe(200);
    expect((await call("PUT", `/previews/${id2}/manifest`, { token: a.token, body: { manifest: manifest(id2, [], now + 1000) } })).status).toBe(200);
    expect(await storedOf(a.id)).toBe(5);
    now += 2000;
    await sweepQuotas(deps);
    expect(await storedOf(a.id)).toBe(0);
    expect(await d1.prepare(`SELECT id FROM previews`).all()).toEqual({ results: [] });
  });

  it("orgs_created: at most the limit of organizations", async () => {
    const op = await dev(OPERATOR);
    const a = await dev("a@x.co");
    await override(op.token, a.id, "orgs_created", 1);
    expect((await call("POST", "/orgs", { token: a.token, body: { name: "One" } })).status).toBe(201);
    const r = await call("POST", "/orgs", { token: a.token, body: { name: "Two" } });
    expect(r.status).toBe(403);
    expect(await bodyOf(r)).toMatchObject({ code: "quota_exceeded", kind: "orgs_created", limit: 1 });
  });

  it("invitations_per_day: new people invited to files and to organizations; changing a role is free", async () => {
    const op = await dev(OPERATOR);
    const a = await dev("a@x.co");
    await override(op.token, a.id, "invitations_per_day", 2);
    await share(a.token, "file-1");
    const invite = (email: string, role = "viewer") => call("PUT", "/files/file-1/members", { token: a.token, body: { email, role } });
    expect((await invite("p1@x.co")).status).toBe(200);
    expect((await invite("p1@x.co", "editor")).status).toBe(200);
    expect((await invite("p2@x.co")).status).toBe(200);
    const r = await invite("p3@x.co");
    expect(r.status).toBe(429);
    expect(await bodyOf(r)).toMatchObject({ code: "quota_exceeded", kind: "invitations_per_day", limit: 2 });
    // Into an organization: the same count
    const org = (await bodyOf(await call("POST", "/orgs", { token: a.token, body: { name: "One" } }))).org as { id: string };
    const add = await call("POST", `/orgs/${org.id}/admin/people`, { token: a.token, body: { emails: ["q@x.co"], role: "member" } });
    expect(add.status).toBe(429);
    expect(await bodyOf(add)).toMatchObject({ code: "quota_exceeded", kind: "invitations_per_day" });
  });

  it("comments_per_minute: 429 past the minute's count", async () => {
    const op = await dev(OPERATOR);
    const a = await dev("a@x.co");
    await override(op.token, a.id, "comments_per_minute", 2);
    await share(a.token, "file-1");
    for (let i = 0; i < 2; i++) expect((await call("POST", "/files/file-1/comments", { token: a.token, body: { message: `hi ${i}`, anchor: { pageId: "0:1", x: 0, y: 0 } } })).status).toBe(200);
    const r = await call("POST", "/files/file-1/comments", { token: a.token, body: { message: "again", anchor: { pageId: "0:1", x: 0, y: 0 } } });
    expect(r.status).toBe(429);
    expect(await bodyOf(r)).toMatchObject({ code: "quota_exceeded", kind: "comments_per_minute", limit: 2 });
    now += 60_000;
    expect((await call("POST", "/files/file-1/comments", { token: a.token, body: { message: "later", anchor: { pageId: "0:1", x: 0, y: 0 } } })).status).toBe(200);
  });

  it("rest_calls_per_day: the REST API's daily cap follows the account's override", async () => {
    const a = await dev("a@x.co");
    const user = { ...(await deps.db.user(a.id))!, quotas: { rest_calls_per_day: 2 } };
    const caller = { kind: "personal", user, scopes: [] } as unknown as Parameters<typeof restCharge>[1];
    await restCharge(deps, caller, 1, "high", false);
    await restCharge(deps, caller, 1, "high", false);
    await expect(restCharge(deps, caller, 1, "high", false)).rejects.toMatchObject({ status: 429 });
  });

  it("GET /me/usage: what the account uses, its limits, whether it operates the server", async () => {
    const a = await dev("a@x.co");
    await share(a.token, "file-1");
    await call("PUT", "/files/file-1/snapshot?seq=0", { token: a.token, body: new Uint8Array(12) });
    expect(await bodyOf(await call("GET", "/me/usage", { token: a.token }))).toMatchObject({ usage: { sharedFiles: 1, storageBytes: 12, previews: 0, orgsCreated: 0 }, limits: { shared_files: QUOTA_LIMITS.shared_files }, operator: false });
    const op = await dev(OPERATOR);
    expect(await bodyOf(await call("GET", "/me/usage", { token: op.token }))).toMatchObject({ operator: true });
  });
});

describe("sign-up", () => {
  it("open: new accounts per IP a day, and the server's daily count", async () => {
    for (let i = 0; i < QUOTA_LIMITS.signups_per_ip_per_day; i++) expect((await googleSignIn({ sub: `g-${i}`, email: `n${i}@x.co` })).code).toBeTruthy();
    expect(await googleSignIn({ sub: "g-9", email: "n9@x.co" })).toEqual({ code: null, error: "signup_limit" });
    // An existing account from the same IP still signs in
    expect((await googleSignIn({ sub: "g-0", email: "n0@x.co" })).code).toBeTruthy();
    // Another IP is fine, until the server's count for the day is full
    expect((await googleSignIn({ sub: "g-10", email: "n10@x.co" }, "198.51.100.1")).code).toBeTruthy();
    await d1.prepare(`UPDATE quota_counters SET n = ?1 WHERE subject = '*' AND kind = 'signups_per_day'`).bind(QUOTA_LIMITS.signups_per_day).run();
    expect((await googleSignIn({ sub: "g-11", email: "n11@x.co" }, "198.51.100.2")).error).toBe("signup_limit");
  });

  it("closed: existing accounts only (operators always); invite: invited people and the allowlist", async () => {
    const op = await dev(OPERATOR);
    const a = await dev("a@x.co");
    const mode = (signupMode: string) => call("PATCH", "/operator/settings", { token: op.token, body: { signupMode } });
    expect((await mode("closed")).status).toBe(200);
    expect((await googleSignIn({ sub: "g-s", email: "stranger@x.co" })).error).toBe("signup_closed");
    const devRefused = await call("POST", "/auth/dev", { body: { email: "other@x.co" } });
    expect(devRefused.status).toBe(403);
    expect(await bodyOf(devRefused)).toMatchObject({ reason: "signup_closed" });
    expect((await call("POST", "/auth/dev", { body: { email: "a@x.co" } })).status).toBe(200);
    expect((await mode("invite")).status).toBe(200);
    expect((await googleSignIn({ sub: "g-s", email: "stranger@x.co" })).error).toBe("signup_invite_only");
    await share(a.token, "file-1");
    await call("PUT", "/files/file-1/members", { token: a.token, body: { email: "friend@x.co", role: "viewer" } });
    expect((await googleSignIn({ sub: "g-f", email: "friend@x.co" })).code).toBeTruthy();
    const allowed = await call("PATCH", "/operator/settings", { token: op.token, body: { allow: "Listed@X.co" } });
    expect(await bodyOf(allowed)).toMatchObject({ signupMode: "invite", allowlist: ["listed@x.co"] });
    expect((await googleSignIn({ sub: "g-l", email: "listed@x.co" })).code).toBeTruthy();
    expect((await mode("sometimes")).status).toBe(400);
  });

  it("an operator's email signs up whatever the mode (OPERATOR_EMAILS decides who that is)", async () => {
    (deps.env as { OPERATOR_EMAILS?: string }).OPERATOR_EMAILS = "boss@x.co, other.boss@x.co";
    const boss = await dev("boss@x.co");
    expect((await call("PATCH", "/operator/settings", { token: boss.token, body: { signupMode: "closed" } })).status).toBe(200);
    expect((await googleSignIn({ sub: "g-b", email: "other.boss@x.co" })).code).toBeTruthy();
    // The default owner is no operator once the list is set
    expect((await call("POST", "/auth/dev", { body: { email: OPERATOR } })).status).toBe(403);
  });
});

describe("operator", () => {
  it("only operators reach /operator; personal access tokens never", async () => {
    const a = await dev("a@x.co");
    for (const [m, p] of [["GET", "/operator/accounts"], ["GET", "/operator/settings"], ["PATCH", "/operator/settings"], ["POST", `/operator/accounts/${a.id}/suspend`]] as const) {
      const r = await call(m, p, { token: a.token, body: m === "GET" ? undefined : {} });
      expect(r.status).toBe(403);
    }
    const op = await dev(OPERATOR);
    const pat = await bodyOf(await call("POST", "/me/tokens", { token: op.token, body: { description: "t", expiresInDays: 30, scopes: ["current_user:read"] } }));
    expect((await call("GET", "/operator/accounts", { token: pat.token as string })).status).toBe(403);
    expect((await call("GET", "/operator/accounts", { token: op.token })).status).toBe(200);
  });

  it("lists accounts with their usage, searches them, pages them", async () => {
    const op = await dev(OPERATOR);
    const a = await dev("alice@x.co");
    await share(a.token, "file-1");
    await call("PUT", "/files/file-1/snapshot?seq=0", { token: a.token, body: new Uint8Array(7) });
    const list = await bodyOf(await call("GET", "/operator/accounts", { token: op.token }));
    expect(list.accounts).toHaveLength(2);
    const alice = (list.accounts as { email: string }[]).find((x) => x.email === "alice@x.co");
    expect(alice).toMatchObject({ sharedFiles: 1, storageBytes: 7, previews: 0, orgsCreated: 0, suspendedAt: null, operator: false, overrides: {} });
    expect((await bodyOf(await call("GET", "/operator/accounts?text=ALI", { token: op.token }))).accounts).toHaveLength(1);
    expect(await bodyOf(await call("GET", "/operator/accounts?limit=1", { token: op.token }))).toMatchObject({ cursor: "1" });
    expect((await call("PUT", `/operator/accounts/${a.id}/quota`, { token: op.token, body: { kind: "nope", limit: 1 } })).status).toBe(400);
    expect((await call("PUT", `/operator/accounts/${a.id}/quota`, { token: op.token, body: { kind: "previews", limit: -1 } })).status).toBe(400);
    expect((await call("PUT", "/operator/accounts/u_missing/quota", { token: op.token, body: { kind: "previews", limit: 1 } })).status).toBe(404);
  });

  it("suspension: 403 account_suspended everywhere, sessions and tokens end, sign-in refused, previews and embeds hidden; unsuspend", async () => {
    const op = await dev(OPERATOR);
    const a = await dev("a@x.co");
    const pat = (await bodyOf(await call("POST", "/me/tokens", { token: a.token, body: { description: "t", expiresInDays: 30, scopes: ["current_user:read"] } }))).token as string;
    await share(a.token, "file-1");
    await call("PATCH", "/files/file-1", { token: a.token, body: { linkAccess: "viewer" } });
    roomCalls = [];
    const s = await call("POST", `/operator/accounts/${a.id}/suspend`, { token: op.token, body: { reason: "spam" } });
    expect(await bodyOf(s)).toMatchObject({ account: { suspendedAt: now, suspendedReason: "spam" } });
    expect(roomCalls).toContainEqual({ key: "file-1", path: "/room/revoke" });
    for (const token of [a.token, pat]) {
      const r = await call("GET", "/me", { token });
      expect(r.status).toBe(403);
      expect(await bodyOf(r)).toMatchObject({ code: "account_suspended" });
    }
    expect(await d1.prepare(`SELECT id FROM sessions WHERE user_id = ?1`).bind(a.id).all()).toEqual({ results: [] });
    expect((await call("POST", "/auth/dev", { body: { email: "a@x.co" } })).status).toBe(403);
    expect((await call("GET", "/embed/file-1/snapshot")).status).toBe(404);
    // An operator can't be suspended
    expect((await call("POST", `/operator/accounts/${op.id}/suspend`, { token: op.token })).status).toBe(400);
    expect(await bodyOf(await call("POST", `/operator/accounts/${a.id}/unsuspend`, { token: op.token }))).toMatchObject({ account: { suspendedAt: null } });
    const again = await dev("a@x.co");
    expect((await call("GET", "/me", { token: again.token })).status).toBe(200);
  });

  it("a suspended Google account goes back to the app with error=account_suspended", async () => {
    const op = await dev(OPERATOR);
    expect((await googleSignIn({ sub: "g-x", email: "x@x.co" })).code).toBeTruthy();
    const id = (await d1.prepare(`SELECT id FROM users WHERE email = 'x@x.co'`).first<{ id: string }>())!.id;
    await call("POST", `/operator/accounts/${id}/suspend`, { token: op.token });
    expect((await googleSignIn({ sub: "g-x", email: "x@x.co" })).error).toBe("account_suspended");
  });
});

describe("account deletion", () => {
  it("DELETE /me releases what the account stored and its counters", async () => {
    const a = await dev("a@x.co");
    await share(a.token, "file-1");
    await call("PUT", "/files/file-1/snapshot?seq=0", { token: a.token, body: new Uint8Array(33) });
    expect(await serverBytes()).toBe(33);
    expect((await call("DELETE", "/me", { token: a.token, body: { confirm: "a@x.co" } })).status).toBe(200);
    expect(await serverBytes()).toBe(0);
    expect(await d1.prepare(`SELECT * FROM stored_items`).all()).toEqual({ results: [] });
    expect(await d1.prepare(`SELECT * FROM quota_counters WHERE subject = ?1`).bind(a.id).all()).toEqual({ results: [] });
    expect(await d1.prepare(`SELECT id FROM users WHERE id = ?1`).bind(a.id).first()).toBeNull();
  });
});

describe("public routes", () => {
  it("serves /privacy and /terms with the operator's contact", async () => {
    for (const p of ["/privacy", "/terms"]) {
      const r = await call("GET", p);
      expect(r.status).toBe(200);
      expect(r.headers.get("content-type")).toContain("text/html");
      expect(r.headers.get("cache-control")).toContain("max-age");
      const html = await r.text();
      expect(html).toContain(OPERATOR);
      if (p === "/privacy") for (const word of ["Cloudflare", "openid", "Delete account", "don't sell"]) expect(html).toContain(word);
    }
  });

  it("serves Search Console's verification file when it is configured", async () => {
    expect((await call("GET", "/google0123456789abcdef.html")).status).toBe(401);
    (deps.env as { GOOGLE_SITE_VERIFICATION?: string }).GOOGLE_SITE_VERIFICATION = "google0123456789abcdef.html";
    expect(await (await call("GET", "/google0123456789abcdef.html")).text()).toBe("google-site-verification: google0123456789abcdef.html");
  });

  it("throttles sign-in steps and public reads per IP", async () => {
    const headers = { "cf-connecting-ip": "192.0.2.1" };
    for (let i = 0; i < THROTTLE_PER_MINUTE.auth; i++) expect((await call("GET", "/auth/login", { headers })).status).not.toBe(429);
    const r = await call("GET", "/auth/login", { headers });
    expect(r.status).toBe(429);
    expect(await bodyOf(r)).toMatchObject({ code: "rate_limited" });
    expect((await call("GET", "/auth/login", { headers: { "cf-connecting-ip": "192.0.2.2" } })).status).not.toBe(429);
    for (let i = 0; i < THROTTLE_PER_MINUTE.public; i++) await call("GET", `/f/file-1`, { headers });
    expect((await call("GET", "/privacy", { headers })).status).toBe(429);
    now += 60_000;
    expect((await call("GET", "/privacy", { headers })).status).toBe(200);
  });

  it("no route lets an unauthenticated caller write a D1 row", async () => {
    const a = await dev("a@x.co");
    await share(a.token, "file-1");
    await call("PATCH", "/files/file-1", { token: a.token, body: { linkAccess: "viewer" } });
    const tables = (await d1.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`).all<{ name: string }>()).results.map((t) => t.name);
    const snapshot = async () => {
      const out: Record<string, number> = {};
      for (const t of tables) out[t] = (await d1.prepare(`SELECT COUNT(*) AS n FROM "${t}"`).first<{ n: number }>())!.n;
      return out;
    };
    const before = await snapshot();
    const id = "P".repeat(22);
    const challenge = await sha256b64url("v".repeat(50));
    const anon: [string, string, unknown?][] = [
      ["GET", "/"],
      ["GET", "/privacy"],
      ["GET", "/terms"],
      ["GET", `/auth/login?port=50123&state=${"a".repeat(20)}&challenge=${challenge}`],
      ["GET", "/auth/callback?state=bad"],
      ["POST", "/auth/token", { code: "x", verifier: "y" }],
      ["POST", "/auth/sso", { email: "a@x.co" }],
      ["GET", "/f/file-1"],
      ["GET", "/embed/file-1"],
      ["GET", "/embed/file-1/snapshot"],
      ["GET", `/p/${id}`],
      ["GET", `/previews/${id}/manifest.json`],
      ["PUT", `/previews/${id}/doc`, new Uint8Array(3)],
      ["POST", "/files", { key: "file-9" }],
      ["POST", "/orgs", { name: "x" }],
      ["GET", "/operator/accounts"],
    ];
    for (const [m, p, body] of anon) {
      const headers: Record<string, string> = body !== undefined && !(body instanceof Uint8Array) ? { "content-type": "application/json" } : {};
      await call(m, p, { body, headers });
    }
    expect(await snapshot()).toEqual(before);
  });
});
