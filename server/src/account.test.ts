import { beforeEach, describe, expect, it } from "vitest";
import type { AccessTokenInfo, AccountProfile, SessionInfo } from "../../src/shared/account";
import { handle, type Deps } from "./api";
import { Db } from "./db";
import { sqliteD1 } from "./testing/sqliteD1";

const ORIGIN = "https://designer.example.workers.dev";
const MAC_CHROME = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
const IPHONE_SAFARI = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";

let deps: Deps;
let now: number;
let rooms: { key: string; path: string }[];

beforeEach(() => {
  now = Date.UTC(2026, 9, 11);
  rooms = [];
  deps = {
    db: new Db(sqliteD1()),
    env: { SESSION_SECRET: "s".repeat(40), DEV_AUTH: "1" },
    rooms: {
      async fetch(key, path) {
        rooms.push({ key, path });
        return Response.json({ ok: true });
      },
    },
    now: () => now,
    fetch: async () => new Response("no", { status: 500 }),
  };
});

/** A request as Cloudflare hands it over: `request.cf` and the client's IP. */
function request(method: string, path: string, opts: { token?: string; body?: unknown; ua?: string; cf?: { city?: string; country?: string }; ip?: string } = {}) {
  const req = new Request(ORIGIN + path, {
    method,
    headers: { ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}), ...(opts.body !== undefined ? { "content-type": "application/json" } : {}), ...(opts.ua ? { "user-agent": opts.ua } : {}), ...(opts.ip ? { "cf-connecting-ip": opts.ip } : {}) },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  if (opts.cf) Object.defineProperty(req, "cf", { value: opts.cf });
  return req;
}

const call = async <T = Record<string, unknown>>(method: string, path: string, opts: Parameters<typeof request>[2] = {}) => {
  const res = await handle(request(method, path, opts), deps);
  return { status: res.status, body: (await res.json()) as T & { error?: string } };
};

async function signIn(email: string, opts: Parameters<typeof request>[2] = {}) {
  const r = await call<{ token: string; user: { id: string } }>("POST", "/auth/dev", { ...opts, body: { email, name: email.split("@")[0] } });
  return r.body;
}

describe("sessions", () => {
  it("keeps a row per sign-in with where and what from, marks the current one, and signs a row out", async () => {
    const app = await signIn("me@x.co", { ua: "DesignerV2-Desktop/0.1.0 (macOS)", cf: { city: "Antalya", country: "TR" }, ip: "188.119.27.5" });
    now += 3_600_000;
    const web = await signIn("me@x.co", { ua: MAC_CHROME, cf: { country: "TR" }, ip: "46.221.39.115" });
    now += 60_000;
    const phone = await signIn("me@x.co", { ua: IPHONE_SAFARI, ip: "5.24.163.188" });
    const list = await call<{ sessions: SessionInfo[] }>("GET", "/me/sessions", { token: app.token });
    expect(list.status).toBe(200);
    expect(list.body.sessions.map((s) => [s.kind, s.os, s.browser, s.ip, s.city, s.country, s.current])).toEqual([
      ["app", "macOS", "DesignerV2 Desktop", "188.119.27.5", "Antalya", "Türkiye", true],
      ["login", "iOS (iPhone)", "Safari", "5.24.163.188", null, null, false],
      ["login", "macOS", "Chrome", "46.221.39.115", null, "Türkiye", false],
    ]);
    // "Last accessed" moves with use (at most every 5 minutes).
    now += 10 * 60_000;
    expect((await call("GET", "/me", { token: web.token })).status).toBe(200);
    const after = (await call<{ sessions: SessionInfo[] }>("GET", "/me/sessions", { token: app.token })).body.sessions;
    expect(after.find((s) => s.ip === "46.221.39.115")!.lastSeenAt).toBe(now);
    // Sign out on a row: exactly that token stops working.
    const phoneRow = after.find((s) => s.browser === "Safari")!;
    expect((await call("DELETE", `/me/sessions/${phoneRow.id}`, { token: app.token })).status).toBe(200);
    expect((await call("GET", "/me", { token: phone.token })).status).toBe(401);
    expect((await call("GET", "/me", { token: web.token })).status).toBe(200);
    // Not the current one (that's Log out), not someone else's.
    const current = after.find((s) => s.current)!;
    expect((await call("DELETE", `/me/sessions/${current.id}`, { token: app.token })).status).toBe(400);
    const other = await signIn("other@x.co");
    await call("DELETE", `/me/sessions/${current.id}`, { token: other.token });
    expect((await call("GET", "/me", { token: app.token })).status).toBe(200);
    // Sign out everywhere still ends them all, and their rows go.
    await call("POST", "/auth/signout-everywhere", { token: web.token });
    expect((await call("GET", "/me", { token: app.token })).status).toBe(401);
    const fresh = await signIn("me@x.co");
    expect((await call<{ sessions: SessionInfo[] }>("GET", "/me/sessions", { token: fresh.token })).body.sessions).toHaveLength(1);
    // Settings › Security's Sign out everywhere, as an account path (DELETE /me/sessions)
    const second = await signIn("me@x.co");
    expect((await call("DELETE", "/me/sessions", { token: fresh.token })).status).toBe(200);
    expect((await call("GET", "/me", { token: fresh.token })).status).toBe(401);
    expect((await call("GET", "/me", { token: second.token })).status).toBe(401);
  });
});

describe("profile", () => {
  it("changes the name (kept over Google's at the next sign-in), the photo, the role, the Community profile and prefs", async () => {
    const me = await signIn("me@x.co");
    const p0 = await call<AccountProfile>("GET", "/me/profile", { token: me.token });
    expect(p0.body).toMatchObject({ email: "me@x.co", name: "me", role: null, community: {}, prefs: {}, provider: "dev" });
    const photo = "data:image/png;base64,iVBORw0KGgo=";
    const p1 = await call<AccountProfile>("PATCH", "/me/profile", { token: me.token, body: { name: " Burak Koç ", picture: photo, role: "Design", prefs: { closedCaptions: true, viewHistory: false } } });
    expect(p1.body).toMatchObject({ name: "Burak Koç", picture: photo, role: "Design", prefs: { closedCaptions: true, viewHistory: false } });
    // Signing in again doesn't take Google's name or photo back.
    await signIn("me@x.co");
    expect((await call<{ name: string; picture: string }>("GET", "/me", { token: me.token })).body).toMatchObject({ name: "Burak Koç", picture: photo });
    expect((await call("PATCH", "/me/profile", { token: me.token, body: { role: "Astronaut" } })).status).toBe(400);
    expect((await call("PATCH", "/me/profile", { token: me.token, body: { picture: "https://evil/x.png" } })).status).toBe(400);
    expect((await call("PATCH", "/me/profile", { token: me.token, body: { prefs: { language: "fr" } } })).status).toBe(400);
    // Community: a unique handle, 15 characters; the bio 160.
    const c = await call<AccountProfile>("PATCH", "/me/profile", { token: me.token, body: { community: { handle: "burak_k", bio: "Designer", website: "burak.design" } } });
    expect(c.body.community).toEqual({ handle: "burak_k", bio: "Designer", website: "https://burak.design" });
    const other = await signIn("other@x.co");
    const taken = await call("PATCH", "/me/profile", { token: other.token, body: { community: { handle: "BURAK_K" } } });
    expect(taken).toMatchObject({ status: 400, body: { error: "That handle is taken" } });
    expect((await call("PATCH", "/me/profile", { token: other.token, body: { community: { handle: "has space" } } })).status).toBe(400);
    expect((await call("PATCH", "/me/profile", { token: other.token, body: { community: { bio: "x".repeat(161) } } })).status).toBe(400);
  });
});

describe("personal access tokens", () => {
  it("are shown once, kept hashed, read within their scopes only, expire and revoke", async () => {
    const me = await signIn("me@x.co");
    await call("POST", "/files", { token: me.token, body: { key: "file_t00001", name: "Tokens" } });
    expect((await call("POST", "/me/tokens", { token: me.token, body: { description: "", expiresInDays: 30, scopes: ["file_content:read"] } })).status).toBe(400);
    expect((await call("POST", "/me/tokens", { token: me.token, body: { description: "CI", expiresInDays: 365, scopes: ["file_content:read"] } })).status).toBe(400);
    expect((await call("POST", "/me/tokens", { token: me.token, body: { description: "CI", expiresInDays: 30, scopes: ["admin"] } })).status).toBe(400);
    const made = await call<{ token: string; info: AccessTokenInfo }>("POST", "/me/tokens", { token: me.token, body: { description: "CI", expiresInDays: 30, scopes: ["file_metadata:read", "file_comments:read"] } });
    expect(made.status).toBe(201);
    expect(made.body.token).toMatch(/^dsgn_[A-Za-z0-9_-]{43}$/);
    const pat = made.body.token;
    // Its scopes: the files list and a file's name, comments read; not /me (no current_user:read), not writes, not the account.
    expect((await call<{ files: unknown[] }>("GET", "/files", { token: pat })).body.files).toHaveLength(1);
    expect((await call("GET", "/files/file_t00001", { token: pat })).status).toBe(200);
    expect((await call("GET", "/files/file_t00001/comments", { token: pat })).status).toBe(200);
    expect((await call("POST", "/files/file_t00001/comments", { token: pat, body: { message: "hi", anchor: { pageId: "0:1", x: 0, y: 0 } } })).status).toBe(403);
    expect((await call("GET", "/files/file_t00001/snapshot", { token: pat })).status).toBe(403);
    expect((await call("PUT", "/files/file_t00001/members", { token: pat, body: { email: "a@b.co", role: "editor" } })).status).toBe(403);
    expect((await call("GET", "/me", { token: pat })).status).toBe(403);
    expect((await call("GET", "/me/tokens", { token: pat })).status).toBe(403);
    expect((await call("POST", "/devices", { token: pat, body: { installationId: "a".repeat(20) } })).status).toBe(403);
    // Listed without the token, with its last use.
    const list = await call<{ tokens: AccessTokenInfo[] }>("GET", "/me/tokens", { token: me.token });
    expect(list.body.tokens).toEqual([{ id: made.body.info.id, description: "CI", scopes: ["file_metadata:read", "file_comments:read"], kind: "personal", orgId: null, createdAt: now, expiresAt: now + 30 * 86_400_000, lastUsedAt: now }]);
    expect(JSON.stringify(list.body)).not.toContain(pat);
    // Expired, then revoked.
    now += 31 * 86_400_000;
    expect((await call("GET", "/files", { token: pat })).status).toBe(401);
    now -= 31 * 86_400_000;
    expect((await call("DELETE", `/me/tokens/${made.body.info.id}`, { token: me.token })).status).toBe(200);
    expect((await call("GET", "/files", { token: pat })).status).toBe(401);
    const user = await call<{ token: string }>("POST", "/me/tokens", { token: me.token, body: { description: "me", expiresInDays: 1, scopes: ["current_user:read"] } });
    expect((await call<{ email: string }>("GET", "/me", { token: user.body.token })).body.email).toBe("me@x.co");
  });
});

describe("delete account", () => {
  it("asks for the email, then removes the account: owned files unshared, memberships, comments, sessions, tokens", async () => {
    const me = await signIn("me@x.co");
    const friend = await signIn("friend@x.co");
    await call("POST", "/files", { token: me.token, body: { key: "file_mine01", name: "Mine" } });
    await call("POST", "/files", { token: friend.token, body: { key: "file_hers01", name: "Hers" } });
    await call("PUT", "/files/file_hers01/members", { token: friend.token, body: { email: "me@x.co", role: "editor" } });
    await call("PUT", "/files/file_mine01/members", { token: me.token, body: { email: "friend@x.co", role: "viewer" } });
    await call("POST", "/files/file_hers01/comments", { token: me.token, body: { message: "mine", anchor: { pageId: "0:1", x: 0, y: 0 } } });
    await call("POST", "/me/tokens", { token: me.token, body: { description: "x", expiresInDays: 7, scopes: ["file_content:read"] } });
    expect((await call("DELETE", "/me", { token: me.token, body: { confirm: "wrong@x.co" } })).status).toBe(400);
    rooms.length = 0;
    expect((await call("DELETE", "/me", { token: me.token, body: { confirm: "ME@x.co" } })).status).toBe(200);
    expect(rooms).toContainEqual({ key: "file_mine01", path: "/room" });
    expect((await call("GET", "/me", { token: me.token })).status).toBe(401);
    expect((await call<{ files: { key: string }[] }>("GET", "/files", { token: friend.token })).body.files.map((f) => f.key)).toEqual(["file_hers01"]);
    expect((await call<{ members: { email: string }[] }>("GET", "/files/file_hers01/members", { token: friend.token })).body.members.map((m) => m.email)).toEqual(["friend@x.co"]);
    expect((await call<{ threads: unknown[] }>("GET", "/files/file_hers01/comments", { token: friend.token })).body.threads).toEqual([]);
    // The same Google account can come back as a new user.
    expect((await signIn("me@x.co")).user.id).not.toBe(me.user.id);
  });
});
