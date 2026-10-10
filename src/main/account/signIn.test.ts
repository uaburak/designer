import { beforeEach, describe, expect, it } from "vitest";
import { handle, type Deps } from "../../../server/src/api";
import { Db } from "../../../server/src/db";
import { sqliteD1 } from "../../../server/src/testing/sqliteD1";
import { b64url } from "../../../server/src/tokens";
import { signInWithBrowser, SignInError } from "./signIn";

const SERVER = "https://designer.test";

let server: Deps;
/** What Google would do with the user's click: "allow" sends a code back, "deny" an error. */
let googleAnswer: "allow" | "deny";

beforeEach(() => {
  googleAnswer = "allow";
  server = {
    db: new Db(sqliteD1()),
    env: { SESSION_SECRET: "k".repeat(40), GOOGLE_CLIENT_ID: "cid", GOOGLE_CLIENT_SECRET: "sec" },
    rooms: { fetch: async () => new Response("") },
    now: () => Date.now(),
    fetch: async () =>
      Response.json({
        id_token: `h.${b64url(new TextEncoder().encode(JSON.stringify({ iss: "https://accounts.google.com", aud: "cid", sub: "g-42", email: "me@example.com", email_verified: true, name: "Me", exp: Date.now() / 1000 + 600 })))}.s`,
      }),
  };
});

/** The app's calls to the server go to the Worker's handler; the loopback is real HTTP. */
const appFetch: typeof fetch = (input, init) => {
  const url = String(input);
  return url.startsWith(SERVER) ? handle(new Request(url, init), server) : fetch(input, init);
};

/** The system browser: follows the server's redirects, plays Google, lands on the app's loopback. */
async function browser(url: string) {
  const login = await handle(new Request(url), server);
  const toGoogle = new URL(login.headers.get("location")!);
  const cb = new URL(`${SERVER}/auth/callback`);
  cb.searchParams.set("state", toGoogle.searchParams.get("state")!);
  if (googleAnswer === "allow") cb.searchParams.set("code", "c");
  else cb.searchParams.set("error", "access_denied");
  const back = await handle(new Request(cb), server);
  const page = await fetch(back.headers.get("location")!);
  return page.text();
}

describe("signInWithBrowser", () => {
  it("signs in through the browser and the loopback, ending with a session the server accepts", async () => {
    let shown = "";
    const s = await signInWithBrowser({ server: SERVER, fetch: appFetch, openBrowser: (u) => void browser(u).then((t) => (shown = t)) });
    expect(s.user.email).toBe("me@example.com");
    expect(s.expiresAt).toBeGreaterThan(Date.now() + 29 * 86400_000);
    const me = await appFetch(`${SERVER}/me`, { headers: { authorization: `Bearer ${s.token}` } });
    expect(((await me.json()) as { name: string }).name).toBe("Me");
    await new Promise((r) => setTimeout(r, 20));
    expect(shown).toContain("You're signed in");
  });

  it("reports a refusal in the browser as cancelled", async () => {
    googleAnswer = "deny";
    await expect(signInWithBrowser({ server: SERVER, fetch: appFetch, openBrowser: (u) => void browser(u) })).rejects.toMatchObject({ code: "cancelled" });
  });

  it("ignores a callback with someone else's state, and times out", async () => {
    let loopback = "";
    const p = signInWithBrowser({ server: SERVER, fetch: appFetch, timeoutMs: 300, openBrowser: (u) => void (loopback = `http://127.0.0.1:${new URL(u).searchParams.get("port")}`) });
    await new Promise((r) => setTimeout(r, 30));
    const stale = await fetch(`${loopback}/callback?state=${"x".repeat(32)}&code=abc`);
    expect(stale.status).toBe(400);
    await expect(p).rejects.toBeInstanceOf(SignInError);
    await expect(p).rejects.toMatchObject({ code: "timeout" });
  });

  it("can be cancelled", async () => {
    const ac = new AbortController();
    const p = signInWithBrowser({ server: SERVER, fetch: appFetch, signal: ac.signal, openBrowser: () => {} });
    setTimeout(() => ac.abort(), 20);
    await expect(p).rejects.toMatchObject({ code: "cancelled" });
  });
});
