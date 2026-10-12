// Several accounts (docs/desktop.md §18.7): the kept list and its file, and the flows between accounts with the
// windows faked.
import { describe, expect, it } from "vitest";
import { AccountList, accountAdded, accountDropped, decodeAccounts, logOut, logOutAll, MAX_ACCOUNTS, switchAccount, type AccountFlowDeps } from "./accounts";
import type { Session } from "./signIn";
import { DEFAULT_SERVER, FORMER_SERVERS, sameServer } from "../../shared/account";

const SERVER = "https://designer.example";
const NOW = 1_800_000_000_000;
const session = (id: string, o: Partial<Session> = {}): Session => ({ server: SERVER, token: `t-${id}`, expiresAt: NOW + 86_400_000, user: { id, email: `${id}@example.com`, name: id.toUpperCase(), picture: null }, ...o });

/** A keychain stand-in: "enc:" + the token reversed */
const seal = async (t: string) => `enc:${[...t].reverse().join("")}`;
const unseal = async (v: string) => (v.startsWith("enc:") ? [...v.slice(4)].reverse().join("") : null);

describe("the kept accounts", () => {
  it("adds, replaces the same person's session, selects and removes (the next one current)", () => {
    const l = new AccountList();
    expect(l.current).toBeNull();
    l.put(session("a"));
    expect(l.current?.user.id).toBe("a");
    l.put(session("b"));
    l.put(session("c"));
    expect(l.current?.user.id).toBe("a");
    l.put(session("a", { token: "fresh" }));
    expect(l.size).toBe(3);
    expect(l.current?.token).toBe("fresh");
    expect(l.select("b")).toBe(true);
    expect(l.select("zz")).toBe(false);
    l.remove("b");
    expect(l.current?.user.id).toBe("c");
    l.remove("c");
    expect(l.current?.user.id).toBe("a");
    l.remove("a");
    expect(l.current).toBeNull();
  });

  it("holds at most 10 (Figma's limit); the same person again still fits", () => {
    const l = new AccountList();
    for (let i = 0; i < MAX_ACCOUNTS; i++) expect(l.put(session(`u${i}`))).toBe(true);
    expect(l.full).toBe(true);
    expect(l.put(session("one-more"))).toBe(false);
    expect(l.put(session("u3", { token: "again" }))).toBe(true);
    expect(l.size).toBe(MAX_ACCOUNTS);
  });

  it("is kept with each token sealed, and read back with the current one", async () => {
    const l = new AccountList([session("a"), session("b")], "b");
    const stored = await l.encode(seal);
    expect(stored.current).toBe("b");
    expect(stored.accounts.map((a) => a.token)).toEqual(["enc:a-t", "enc:b-t"]);
    expect(JSON.stringify(stored)).not.toContain("t-a");
    const back = await decodeAccounts(JSON.parse(JSON.stringify(stored)), { server: SERVER, now: NOW, unseal });
    expect(back.all().map((s) => s.token)).toEqual(["t-a", "t-b"]);
    expect(back.current?.user.id).toBe("b");
  });

  it("reads the single session.json of before as one account", async () => {
    const legacy = { server: SERVER, token: await seal("old"), expiresAt: NOW + 1000, user: { id: "a", email: "a@example.com", name: "A", picture: null } };
    const l = await decodeAccounts(legacy, { server: SERVER, now: NOW, unseal });
    expect(l.size).toBe(1);
    expect(l.current?.token).toBe("old");
    expect((await decodeAccounts({ server: SERVER, token: "raw:plain", expiresAt: NOW + 1000, user: legacy.user }, { server: SERVER, now: NOW, unseal })).current?.token).toBe("plain");
  });

  it("leaves out sessions for another server, past their end, or whose token won't open; the current falls to the first left", async () => {
    const stored = await new AccountList([session("a"), session("b", { server: "https://other" }), session("c", { expiresAt: NOW - 1 }), session("d")], "c").encode(seal);
    stored.accounts[3].token = "enc:" + "garbage";
    const l = await decodeAccounts(stored, { server: SERVER, now: NOW, unseal: async (v) => (v === "enc:garbage" ? null : unseal(v)) });
    expect(l.all().map((s) => s.user.id)).toEqual(["a"]);
    expect(l.current?.user.id).toBe("a");
    expect((await decodeAccounts(null, { server: SERVER, now: NOW, unseal })).size).toBe(0);
    expect((await decodeAccounts({ nonsense: true }, { server: SERVER, now: NOW, unseal })).size).toBe(0);
  });

  it("keeps a session signed in at the workers.dev address (up to 1.0.3) as wecra.app's — the same Worker", async () => {
    const stored = await new AccountList([session("a", { server: FORMER_SERVERS[0] }), session("b", { server: DEFAULT_SERVER })], "a").encode(seal);
    const l = await decodeAccounts(stored, { server: DEFAULT_SERVER, now: NOW, unseal });
    expect(l.all().map((s) => [s.user.id, s.server, s.token])).toEqual([["a", "https://wecra.app", "t-a"], ["b", "https://wecra.app", "t-b"]]);
    expect(l.current?.user.id).toBe("a");
    // Only for the default server: a development server doesn't take the production one's sessions
    expect((await decodeAccounts(stored, { server: "http://localhost:8787", now: NOW, unseal })).size).toBe(0);
    expect(sameServer("https://wecra.app/", DEFAULT_SERVER)).toBe(true);
    expect(sameServer(FORMER_SERVERS[0], "https://other")).toBe(false);
  });
});

/** The app's part faked: what happened, in order; `settle` answers `stay` to keep the person where they are */
function world(list: AccountList, o: { stay?: boolean } = {}) {
  const log: string[] = [];
  const d: AccountFlowDeps = {
    list,
    settle: async () => (log.push("settle"), !o.stay),
    leave: async () => void log.push(`leave ${list.current?.user.id}`),
    commit: async () => void log.push(`commit ${list.current?.user.id ?? "none"}`),
    arrived: () => void log.push(`home ${list.current?.user.id}`),
  };
  return { d, log };
}

describe("moving between accounts", () => {
  it("switches: the files settled and closed under the old account, then the new one, then Home", async () => {
    const { d, log } = world(new AccountList([session("a"), session("b")], "a"));
    expect(await switchAccount(d, "b")).toBe("switched");
    expect(log).toEqual(["settle", "leave a", "commit b", "home b"]);
    expect(await switchAccount(d, "b")).toBe("same");
    expect(await switchAccount(d, "nobody")).toBe("unknown");
  });

  it("stays when a file isn't settled (Cancel on a failed save)", async () => {
    const { d, log } = world(new AccountList([session("a"), session("b")], "a"), { stay: true });
    expect(await switchAccount(d, "b")).toBe("stayed");
    expect(log).toEqual(["settle"]);
    expect(d.list.current?.user.id).toBe("a");
  });

  it("Add account: the first sign-in just signs in; another person is a switch; the same person a fresh session", async () => {
    const { d, log } = world(new AccountList());
    expect(await accountAdded(d, session("a"))).toBe("switched");
    expect(log).toEqual(["commit a"]);
    log.length = 0;
    expect(await accountAdded(d, session("b"))).toBe("switched");
    expect(log).toEqual(["settle", "leave a", "commit b", "home b"]);
    log.length = 0;
    expect(await accountAdded(d, session("b", { token: "new" }))).toBe("same");
    expect(log).toEqual(["commit b"]);
    expect(d.list.current?.token).toBe("new");
    expect(d.list.size).toBe(2);
  });

  it("Add account kept but not switched to when the person stays with a file; refused past 10", async () => {
    const { d } = world(new AccountList([session("a")], "a"), { stay: true });
    expect(await accountAdded(d, session("b"))).toBe("stayed");
    expect(d.list.current?.user.id).toBe("a");
    expect(d.list.has("b")).toBe(true);
    const full = world(new AccountList(Array.from({ length: MAX_ACCOUNTS }, (_, i) => session(`u${i}`)), "u0"));
    expect(await accountAdded(full.d, session("eleventh"))).toBe("full");
    expect(full.log).toEqual([]);
  });

  it("Log out leaves the current account only: the next one takes over (its Home); the last one signs out", async () => {
    const { d, log } = world(new AccountList([session("a"), session("b")], "a"));
    expect(await logOut(d)).toBe("switched");
    expect(log).toEqual(["settle", "leave a", "commit b", "home b"]);
    log.length = 0;
    expect(await logOut(d)).toBe("signed-out");
    // The last account: no tabs closed here — the gate closes the window and shows the welcome page.
    expect(log).toEqual(["settle", "commit none"]);
    expect(await logOut(d)).toBe("signed-out");
  });

  it("Log out keeps the account when a file isn't settled", async () => {
    const { d } = world(new AccountList([session("a"), session("b")], "a"), { stay: true });
    expect(await logOut(d)).toBe("stayed");
    expect(d.list.size).toBe(2);
  });

  it("Log out of all accounts: settled once, every account gone", async () => {
    const { d, log } = world(new AccountList([session("a"), session("b"), session("c")], "b"));
    expect(await logOutAll(d)).toBe("signed-out");
    expect(log).toEqual(["settle", "commit none"]);
    expect(d.list.size).toBe(0);
  });

  it("a refused session (401, the idle timeout) drops that account only, without asking", async () => {
    const { d, log } = world(new AccountList([session("a"), session("b"), session("c")], "b"));
    expect(await accountDropped(d, "c")).toBe("same");
    expect(log).toEqual(["commit b"]);
    log.length = 0;
    expect(await accountDropped(d, "b")).toBe("switched");
    expect(log).toEqual(["leave b", "commit a", "home a"]);
    log.length = 0;
    expect(await accountDropped(d, "a")).toBe("signed-out");
    expect(log).toEqual(["commit none"]);
    expect(await accountDropped(d, "a")).toBe("unknown");
  });
});
