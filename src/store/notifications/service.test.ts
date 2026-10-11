/**
 * The store's notifications: the real API (server/src/api.ts + notifications.ts on node:sqlite), the inbox socket
 * following the session, its messages as events, and the repository's calls.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { handle, type Deps } from "../../../server/src/api";
import { Db } from "../../../server/src/db";
import { sqliteD1 } from "../../../server/src/testing/sqliteD1";
import type { MultiplayerSession } from "../../shared/multiplayer/types";
import type { NotificationsEvent } from "../../shared/notifications";
import type { MultiplayerService } from "../multiplayer/service";
import { NotificationsService } from "./service";

const SERVER = "https://n.test";
let now = 0;
let server: Deps;
/** userId → token, so the fake inbox finds the sockets of a person */
const tokens = new Map<string, string>();

class FakeSocket {
  static all: FakeSocket[] = [];
  binaryType = "blob";
  readyState = 0;
  sent: string[] = [];
  closed = false;
  onopen: ((e: unknown) => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onclose: ((e: { code: number; reason: string }) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  constructor(readonly url: string) {
    FakeSocket.all.push(this);
    queueMicrotask(() => {
      this.readyState = 1;
      this.onopen?.({});
    });
  }
  send(d: string) {
    this.sent.push(d);
  }
  close() {
    this.closed = true;
    this.readyState = 3;
  }
  drop() {
    this.readyState = 3;
    this.onclose?.({ code: 1006, reason: "" });
  }
}

beforeEach(() => {
  now = Date.UTC(2026, 9, 11);
  FakeSocket.all = [];
  tokens.clear();
  server = {
    db: new Db(sqliteD1()),
    env: { SESSION_SECRET: "s".repeat(40), DEV_AUTH: "1" },
    rooms: { fetch: async () => Response.json({ ok: true }) },
    inboxes: {
      async notify(userId, msg) {
        const token = tokens.get(userId);
        for (const ws of FakeSocket.all) if (!ws.closed && ws.readyState === 1 && token && ws.url.includes(token)) ws.onmessage?.({ data: JSON.stringify(msg) });
      },
      connect: async () => new Response(null, { status: 204 }),
    },
    now: () => (now += 1),
    fetch,
  };
});

/** The parts of MultiplayerService the notifications use, over the real handler */
function fakeMp() {
  let session: MultiplayerSession | null = null;
  const listeners = new Set<(s: MultiplayerSession | null) => void>();
  return {
    get signedIn() {
      return session !== null;
    },
    onSession: (l: (s: MultiplayerSession | null) => void) => (listeners.add(l), () => listeners.delete(l)),
    setSession(s: MultiplayerSession | null) {
      session = s;
      listeners.forEach((l) => l(s));
    },
    wsUrl: (path: string) => (session ? `wss://n.test${path}?token=${session.token}` : null),
    call: async (method: string, path: string, body?: unknown) => {
      const res = await handle(new Request(SERVER + path, { method, headers: { authorization: `Bearer ${session?.token}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }), server);
      if (!res.ok) throw new Error(((await res.json()) as { error: string }).error);
      return res.json();
    },
  };
}

const devSignIn = async (email: string) => {
  const r = (await (await handle(new Request(`${SERVER}/auth/dev`, { method: "POST", body: JSON.stringify({ email, name: email.split("@")[0] }) }), server)).json()) as { token: string; user: { id: string } };
  tokens.set(r.user.id, r.token);
  return r;
};

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("notifications in the store", () => {
  it("follows the session with the inbox socket and turns its messages into events", async () => {
    const alice = await devSignIn("alice@x.co");
    const bob = await devSignIn("bob@x.co");
    const mp = fakeMp();
    const s = new NotificationsService(mp as unknown as MultiplayerService, { WebSocket: FakeSocket as never, backoff: () => 0, pingMs: 0 });
    const events: NotificationsEvent[] = [];
    s.onChange((e) => events.push(e));
    // Signed out: nothing, no socket; the settings are kept here.
    expect(await s.list()).toMatchObject({ items: [], unread: 0 });
    expect(FakeSocket.all).toHaveLength(0);
    const prefs = await s.prefs();
    expect((await s.setPrefs({ ...prefs, desktop: { enabled: false, comments: "none" } })).desktop.enabled).toBe(false);

    mp.setSession({ server: SERVER, token: bob.token });
    expect(FakeSocket.all).toHaveLength(1);
    expect(FakeSocket.all[0].url).toBe(`wss://n.test/notifications/ws?token=${bob.token}`);
    await tick();

    // Alice shares a file and invites Bob: his inbox hears of it at once.
    const asAlice = fakeMp();
    asAlice.setSession({ server: SERVER, token: alice.token });
    await asAlice.call("POST", "/files", { key: "file_notif1", name: "AWA V3" });
    await asAlice.call("PUT", "/files/file_notif1/members", { email: "bob@x.co", role: "viewer" });
    expect(events.at(-1)).toMatchObject({ unread: 1, pending: 0, desktop: true, item: { kind: "invite", fileName: "AWA V3", actor: { name: "alice" } } });

    const page = await s.list();
    expect(page.items).toHaveLength(1);
    expect(await s.markRead({ all: true })).toEqual({ unread: 0 });
    expect(events.at(-1)).toMatchObject({ unread: 0 });
    // Bob asks to edit; Alice answers from her Requests tab.
    await mp.call("POST", "/files/file_notif1/requests");
    const as = new NotificationsService(asAlice as unknown as MultiplayerService, { WebSocket: FakeSocket as never, pingMs: 0 });
    const req = await as.list({ filter: "requests" });
    expect(req.items[0]).toMatchObject({ kind: "edit-request", state: "pending" });
    expect((await as.answer(req.items[0].id, true)).items[0].state).toBe("approved");
    expect(events.at(-1)).toMatchObject({ item: { kind: "request-approved" } });
    // Prefs saved on the server once signed in.
    expect((await s.setPrefs({ ...(await s.prefs()), productNews: false })).productNews).toBe(false);
    expect((await s.prefs()).productNews).toBe(false);

    // A dropped socket comes back; signing out closes it.
    FakeSocket.all[0].drop();
    await tick();
    const back = FakeSocket.all.filter((w) => w.url.includes(bob.token));
    expect(back).toHaveLength(2);
    mp.setSession(null);
    expect(back[1].closed).toBe(true);
    expect(events.at(-1)).toMatchObject({ unread: 0, pending: 0 });
    s.close();
    as.close();
  });
});
