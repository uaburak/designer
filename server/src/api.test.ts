import { beforeEach, describe, expect, it } from "vitest";
import { handle, type Deps, type Rooms } from "./api";
import { Db } from "./db";
import { sqliteD1 } from "./testing/sqliteD1";
import { b64url, sha256b64url, signToken } from "./tokens";

const ORIGIN = "https://designer.example.workers.dev";
const SECRET = "s".repeat(40);

/** An unsigned ID token as Google's token endpoint returns it (no signature check: it came over TLS from Google). */
const idToken = (claims: Record<string, unknown>) => `x.${b64url(new TextEncoder().encode(JSON.stringify(claims)))}.y`;

interface RoomCall {
  key: string;
  path: string;
  method?: string;
  identity?: unknown;
}

let deps: Deps;
let roomCalls: RoomCall[];
let now: number;
let google: Record<string, unknown>;

beforeEach(() => {
  now = Date.UTC(2026, 9, 10);
  roomCalls = [];
  google = { iss: "https://accounts.google.com", aud: "cid", sub: "g-1", email: "Burak@Example.com", email_verified: true, name: "Burak", exp: now / 1000 + 3600 };
  const rooms: Rooms = {
    async fetch(key, path, init) {
      roomCalls.push({ key, path, method: init.method, identity: init.identity });
      return new Response("room", { status: 200 });
    },
  };
  deps = {
    db: new Db(sqliteD1()),
    env: { SESSION_SECRET: SECRET, GOOGLE_CLIENT_ID: "cid", GOOGLE_CLIENT_SECRET: "csecret" },
    rooms,
    now: () => now,
    fetch: async (input, init) => {
      expect(String(input)).toBe("https://oauth2.googleapis.com/token");
      const body = new URLSearchParams(String(init?.body));
      expect(body.get("client_secret")).toBe("csecret");
      expect(body.get("redirect_uri")).toBe(`${ORIGIN}/auth/callback`);
      if (body.get("code") === "bad") return new Response("{}", { status: 400 });
      return Response.json({ id_token: idToken(google) });
    },
  };
});

const call = (method: string, path: string, opts: { token?: string; body?: unknown; headers?: Record<string, string> } = {}) =>
  handle(
    new Request(ORIGIN + path, {
      method,
      headers: { ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}), ...(opts.body !== undefined ? { "content-type": "application/json" } : {}), ...opts.headers },
      body: opts.body === undefined ? undefined : typeof opts.body === "string" || opts.body instanceof Uint8Array ? (opts.body as BodyInit) : JSON.stringify(opts.body),
    }),
    deps,
  );

/** The whole Google flow as the desktop app drives it; returns the session token. */
async function signInWithGoogle(claims: Partial<typeof google> = {}) {
  Object.assign(google, claims);
  const verifier = "v".repeat(50);
  const challenge = await sha256b64url(verifier);
  const login = await call("GET", `/auth/login?port=50123&state=${"a".repeat(20)}&challenge=${challenge}`);
  expect(login.status).toBe(302);
  const toGoogle = new URL(login.headers.get("location")!);
  expect(toGoogle.origin + toGoogle.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
  expect(toGoogle.searchParams.get("client_id")).toBe("cid");
  const cb = await call("GET", `/auth/callback?code=good&state=${encodeURIComponent(toGoogle.searchParams.get("state")!)}`);
  const back = new URL(cb.headers.get("location")!);
  expect(back.origin + back.pathname).toBe("http://127.0.0.1:50123/callback");
  expect(back.searchParams.get("state")).toBe("a".repeat(20));
  const res = await call("POST", "/auth/token", { body: { code: back.searchParams.get("code"), verifier } });
  expect(res.status).toBe(200);
  return (await res.json()) as { token: string; expiresAt: number; user: { id: string; email: string } };
}

async function devSignIn(email: string) {
  deps.env.DEV_AUTH = "1";
  const res = await call("POST", "/auth/dev", { body: { email, name: email.split("@")[0] } });
  return ((await res.json()) as { token: string; user: { id: string } });
}

describe("sign-in", () => {
  it("runs Google's flow through the Worker and the app's loopback with PKCE", async () => {
    const s = await signInWithGoogle();
    expect(s.user.email).toBe("burak@example.com");
    expect(s.expiresAt).toBe(now + 30 * 86400_000);
    const me = await call("GET", "/me", { token: s.token });
    expect(await me.json()).toMatchObject({ email: "burak@example.com", name: "Burak" });
    // The same Google account signs in as the same user.
    expect((await signInWithGoogle({ name: "Burak K" })).user.id).toBe(s.user.id);
  });

  it("refuses a reused code, a wrong verifier and an expired code", async () => {
    const verifier = "w".repeat(50);
    const login = await call("GET", `/auth/login?port=50123&state=${"b".repeat(20)}&challenge=${await sha256b64url(verifier)}`);
    const state = new URL(login.headers.get("location")!).searchParams.get("state")!;
    const code = async () => new URL((await call("GET", `/auth/callback?code=good&state=${encodeURIComponent(state)}`)).headers.get("location")!).searchParams.get("code");
    const c1 = await code();
    expect((await call("POST", "/auth/token", { body: { code: c1, verifier: "x".repeat(50) } })).status).toBe(400);
    expect((await call("POST", "/auth/token", { body: { code: c1, verifier } })).status).toBe(400); // used by the failed try
    const c2 = await code();
    now += 121_000;
    expect((await call("POST", "/auth/token", { body: { code: c2, verifier } })).status).toBe(400);
  });

  it("sends Google's refusals and failures back to the loopback as errors", async () => {
    const login = await call("GET", `/auth/login?port=50123&state=${"c".repeat(20)}&challenge=${"C".repeat(43)}`);
    const state = encodeURIComponent(new URL(login.headers.get("location")!).searchParams.get("state")!);
    const denied = new URL((await call("GET", `/auth/callback?error=access_denied&state=${state}`)).headers.get("location")!);
    expect(denied.searchParams.get("error")).toBe("access_denied");
    const failed = new URL((await call("GET", `/auth/callback?code=bad&state=${state}`)).headers.get("location")!);
    expect(failed.searchParams.get("error")).toBe("google_failed");
    google.email_verified = false;
    const unverified = new URL((await call("GET", `/auth/callback?code=good&state=${state}`)).headers.get("location")!);
    expect(unverified.searchParams.get("error")).toBe("google_failed");
    expect((await call("GET", `/auth/callback?code=good&state=forged`)).status).toBe(400);
  });

  it("checks login parameters and refuses unsigned, forged, expired and signed-out sessions", async () => {
    expect((await call("GET", `/auth/login?port=80&state=${"a".repeat(20)}&challenge=${"C".repeat(43)}`)).status).toBe(400);
    expect((await call("GET", "/me")).status).toBe(401);
    expect((await call("GET", "/me", { token: "v1.e30.AAAA" })).status).toBe(401);
    expect((await call("GET", "/me", { token: "v1.e30.AAAAA" })).status).toBe(401); // a length base64 can't have
    expect((await call("GET", "/me", { token: "v1.!!.AAAA" })).status).toBe(401);
    const s = await signInWithGoogle();
    const forged = await signToken({ uid: s.user.id, tv: 0, exp: now / 1000 + 100 }, "t".repeat(40));
    expect((await call("GET", "/me", { token: forged })).status).toBe(401);
    now += 31 * 86400_000;
    expect((await call("GET", "/me", { token: s.token })).status).toBe(401);
    now -= 31 * 86400_000;
    expect((await call("POST", "/auth/signout-everywhere", { token: s.token })).status).toBe(200);
    expect((await call("GET", "/me", { token: s.token })).status).toBe(401);
  });

  it("offers dev sign-in only when DEV_AUTH is on", async () => {
    expect((await call("POST", "/auth/dev", { body: { email: "a@b.co" } })).status).toBe(404);
    const s = await devSignIn("a@b.co");
    expect((await call("GET", "/me", { token: s.token })).status).toBe(200);
  });
});

describe("devices", () => {
  it("gives each installation one ordinal from 2 up, the same on every ask", async () => {
    const a = await devSignIn("a@x.co");
    const b = await devSignIn("b@x.co");
    const ask = async (token: string, installationId: string) => (await (await call("POST", "/devices", { token, body: { installationId } })).json()) as { ordinal: number };
    expect((await ask(a.token, "inst-aaaaaaaaaaaaaaaa")).ordinal).toBe(2);
    expect((await ask(b.token, "inst-bbbbbbbbbbbbbbbb")).ordinal).toBe(3);
    expect((await ask(a.token, "inst-aaaaaaaaaaaaaaaa")).ordinal).toBe(2);
    // Another account on the same installation keeps the installation's ordinal.
    expect((await ask(b.token, "inst-aaaaaaaaaaaaaaaa")).ordinal).toBe(2);
    expect((await call("POST", "/devices", { token: a.token, body: { installationId: "short" } })).status).toBe(400);
    expect((await call("POST", "/devices", { body: { installationId: "inst-cccccccccccccccc" } })).status).toBe(401);
  });
});

describe("the web app", () => {
  const WEB = "http://localhost:5199";
  beforeEach(() => {
    deps.env.WEB_ORIGINS = WEB;
  });

  it("signs in by coming back to its own page with auth_ parameters", async () => {
    const verifier = "q".repeat(50);
    const page = `${WEB}/?files&state=keep`;
    const login = await call("GET", `/auth/login?return=${encodeURIComponent(page)}&state=${"w".repeat(20)}&challenge=${await sha256b64url(verifier)}`);
    expect(login.status).toBe(302);
    const state = new URL(login.headers.get("location")!).searchParams.get("state")!;
    const back = new URL((await call("GET", `/auth/callback?code=good&state=${encodeURIComponent(state)}`)).headers.get("location")!);
    expect(back.origin).toBe(WEB);
    expect(back.searchParams.get("state")).toBe("keep"); // the page's own parameters untouched
    expect(back.searchParams.get("auth_state")).toBe("w".repeat(20));
    const res = await call("POST", "/auth/token", { body: { code: back.searchParams.get("auth_code"), verifier }, headers: { origin: WEB } });
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe(WEB);
  });

  it("refuses pages and origins not listed, and answers CORS preflights only for listed ones", async () => {
    expect((await call("GET", `/auth/login?return=${encodeURIComponent("https://evil.example/")}&state=${"w".repeat(20)}&challenge=${"C".repeat(43)}`)).status).toBe(400);
    const ok = await handle(new Request(`${ORIGIN}/files`, { method: "OPTIONS", headers: { origin: WEB } }), deps);
    expect(ok.status).toBe(204);
    expect(ok.headers.get("access-control-allow-headers")).toContain("authorization");
    expect((await handle(new Request(`${ORIGIN}/files`, { method: "OPTIONS", headers: { origin: "https://evil.example" } }), deps)).status).toBe(403);
    const s = await devSignIn("a@x.co");
    const other = await call("GET", "/me", { token: s.token, headers: { origin: "https://evil.example" } });
    expect(other.headers.get("access-control-allow-origin")).toBeNull();
  });
});

describe("files and sharing", () => {
  it("shares a file, invites by email, and gives each person their role", async () => {
    const owner = await signInWithGoogle();
    expect((await call("POST", "/files", { token: owner.token, body: { key: "file_abc123", name: "  Landing  " } })).status).toBe(201);
    // Invite someone who has no account yet, and someone who has.
    const viewer = await devSignIn("viewer@x.co");
    expect((await call("PUT", "/files/file_abc123/members", { token: owner.token, body: { email: "Editor@X.co", role: "editor" } })).status).toBe(200);
    expect((await call("PUT", "/files/file_abc123/members", { token: owner.token, body: { email: "viewer@x.co", role: "viewer" } })).status).toBe(200);
    expect(roomCalls.at(-1)).toMatchObject({ key: "file_abc123", path: "/room/revoke" });
    const members = (await (await call("GET", "/files/file_abc123/members", { token: viewer.token })).json()) as { members: { email: string; role: string; pending: boolean }[] };
    expect(members.members.map((m) => [m.email, m.role, m.pending])).toEqual([
      ["burak@example.com", "owner", false],
      ["editor@x.co", "editor", true],
      ["viewer@x.co", "viewer", false],
    ]);
    // The invited editor signs in later: the invite is theirs.
    const editor = await devSignIn("editor@x.co");
    const list = (await (await call("GET", "/files", { token: editor.token })).json()) as { files: { key: string; name: string; role: string }[] };
    expect(list.files).toMatchObject([{ key: "file_abc123", name: "Landing", role: "editor" }]);
    expect(((await (await call("GET", "/files", { token: owner.token })).json()) as { files: { role: string }[] }).files[0].role).toBe("owner");

    // What each role may do.
    expect((await call("PATCH", "/files/file_abc123", { token: editor.token, body: { name: "Landing v2" } })).status).toBe(200);
    expect((await call("PATCH", "/files/file_abc123", { token: viewer.token, body: { name: "no" } })).status).toBe(403);
    expect((await call("PUT", "/files/file_abc123/members", { token: editor.token, body: { email: "z@x.co", role: "viewer" } })).status).toBe(403);
    expect((await call("PUT", "/files/file_abc123/snapshot?seq=0", { token: viewer.token, body: new Uint8Array([1]) })).status).toBe(403);
    expect((await call("PUT", "/files/file_abc123/snapshot?seq=0", { token: editor.token, body: new Uint8Array([1, 2]) })).status).toBe(200);
    expect(roomCalls.at(-1)).toMatchObject({ path: "/room/snapshot?seq=0", method: "PUT", identity: { role: "editor" } });
    expect((await call("GET", "/files/file_abc123/snapshot", { token: viewer.token })).status).toBe(200);
    expect(roomCalls.at(-1)).toMatchObject({ path: "/room/snapshot", identity: { role: "viewer" } });

    // A stranger can't see that the file exists.
    const stranger = await devSignIn("stranger@x.co");
    expect((await call("GET", "/files/file_abc123/members", { token: stranger.token })).status).toBe(404);
    // Nobody else can take the key.
    expect((await call("POST", "/files", { token: stranger.token, body: { key: "file_abc123" } })).status).toBe(409);

    // Removing a member closes their sockets; deleting the file drops the room.
    expect((await call("DELETE", "/files/file_abc123/members/viewer@x.co", { token: owner.token })).status).toBe(200);
    expect(roomCalls.at(-1)).toMatchObject({ path: "/room/revoke" });
    expect((await call("GET", "/files", { token: viewer.token }).then((r) => r.json())) as unknown).toEqual({ files: [] });
    expect((await call("DELETE", "/files/file_abc123", { token: editor.token })).status).toBe(403);
    expect((await call("DELETE", "/files/file_abc123", { token: owner.token })).status).toBe(200);
    expect(roomCalls.at(-1)).toMatchObject({ path: "/room", method: "DELETE" });
    expect((await call("GET", "/files/file_abc123/members", { token: editor.token })).status).toBe(404);
  });

  it("opens the room's socket with the caller's role, the token on the URL", async () => {
    const owner = await devSignIn("o@x.co");
    await call("POST", "/files", { token: owner.token, body: { key: "file_ws0001" } });
    expect((await call("GET", `/files/file_ws0001/ws?token=${owner.token}`)).status).toBe(426);
    const res = await call("GET", `/files/file_ws0001/ws?token=${owner.token}`, { headers: { upgrade: "websocket" } });
    expect(res.status).toBe(200);
    expect(roomCalls.at(-1)).toMatchObject({ path: "/room/ws", identity: { role: "owner" } });
    // The query token is accepted only for the socket.
    expect((await call("GET", `/me?token=${owner.token}`)).status).toBe(401);
  });

  it("validates input", async () => {
    const owner = await devSignIn("o@x.co");
    expect((await call("POST", "/files", { token: owner.token, body: { key: "../x" } })).status).toBe(400);
    expect((await call("POST", "/files", { token: owner.token, body: "nope" })).status).toBe(400);
    await call("POST", "/files", { token: owner.token, body: { key: "file_v00001" } });
    expect((await call("PUT", "/files/file_v00001/members", { token: owner.token, body: { email: "x", role: "editor" } })).status).toBe(400);
    expect((await call("PUT", "/files/file_v00001/members", { token: owner.token, body: { email: "a@b.co", role: "owner" } })).status).toBe(400);
    expect((await call("PUT", "/files/file_v00001/members", { token: owner.token, body: { email: "o@x.co", role: "editor" } })).status).toBe(400);
    expect((await call("PUT", "/files/file_v00001/snapshot?seq=-1", { token: owner.token, body: new Uint8Array() })).status).toBe(400);
  });
});
