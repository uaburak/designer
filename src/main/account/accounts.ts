/**
 * Several accounts at once (docs/desktop.md §18.7; help.figma.com 360041064554 "Switch between multiple accounts"):
 * up to 10 sessions kept, one current. Without Electron so the tests drive it — the list and its file
 * (userData/account/sessions.json, each token sealed on its own), and the flows that move between accounts (add,
 * switch, log out, log out of all, a refused session) with the windows' part handed in.
 */
import { sameServer, type AccountUser } from "../../shared/account";
import type { Session } from "./signIn";

/** Figma: "You can be logged in to a maximum of 10 accounts at a time." */
export const MAX_ACCOUNTS = 10;

/** One kept account: the token sealed ("enc:<base64>", or "raw:<token>" when the OS offers no encryption) */
export interface StoredAccount {
  server: string;
  token: string;
  expiresAt: number;
  user: AccountUser;
}

/** userData/account/sessions.json */
export interface StoredAccounts {
  version: 1;
  /** The current account's user id */
  current: string | null;
  accounts: StoredAccount[];
}

/** The accounts signed in, in the order they were added, and which one is current. */
export class AccountList {
  private items: Session[] = [];
  private currentId: string | null = null;

  constructor(items: readonly Session[] = [], current: string | null = null) {
    for (const s of items) if (!this.items.some((i) => i.user.id === s.user.id)) this.items.push(s);
    this.items = this.items.slice(0, MAX_ACCOUNTS);
    this.currentId = this.items.some((s) => s.user.id === current) ? current : (this.items[0]?.user.id ?? null);
  }

  get current(): Session | null {
    return this.items.find((s) => s.user.id === this.currentId) ?? null;
  }

  all(): readonly Session[] {
    return this.items;
  }

  get size(): number {
    return this.items.length;
  }

  has(userId: string): boolean {
    return this.items.some((s) => s.user.id === userId);
  }

  /** Another account may be added (a sign-in as one already here replaces its session instead). */
  get full(): boolean {
    return this.items.length >= MAX_ACCOUNTS;
  }

  /** A signed-in account: its session replaces the kept one of the same user, else it is added (when there's room). */
  put(s: Session): boolean {
    const at = this.items.findIndex((i) => i.user.id === s.user.id);
    if (at >= 0) this.items[at] = s;
    else if (this.full) return false;
    else this.items.push(s);
    if (this.currentId === null) this.currentId = s.user.id;
    return true;
  }

  /** The current account becomes `userId`'s; false when there's no such account. */
  select(userId: string): boolean {
    if (!this.has(userId)) return false;
    this.currentId = userId;
    return true;
  }

  /** An account gone (logged out, refused, expired): when it was current, the next one is (the one after it, else the
   *  one before), or none. */
  remove(userId: string): void {
    const at = this.items.findIndex((s) => s.user.id === userId);
    if (at < 0) return;
    this.items.splice(at, 1);
    if (this.currentId === userId) this.currentId = (this.items[at] ?? this.items[at - 1])?.user.id ?? null;
  }

  clear(): void {
    this.items = [];
    this.currentId = null;
  }

  /** The kept file, each token sealed by `seal` (in order: sealing may be async). */
  async encode(seal: (token: string) => Promise<string>): Promise<StoredAccounts> {
    const accounts: StoredAccount[] = [];
    for (const s of this.items) accounts.push({ server: s.server, token: await seal(s.token), expiresAt: s.expiresAt, user: s.user });
    return { version: 1, current: this.currentId, accounts };
  }
}

const isUser = (u: unknown): u is AccountUser => !!u && typeof u === "object" && typeof (u as AccountUser).id === "string" && typeof (u as AccountUser).email === "string";

/**
 * The kept file read back: sessions.json, or the single-account session.json of before (`legacy`). A session kept
 * for the server's former address (FORMER_SERVERS, workers.dev up to 1.0.3) is the current one's, read as wecra.app;
 * one for another server (DESIGNER_SERVER changed), past its end, or whose token can't be opened (another Mac's keychain) is
 * left out; the current one is kept when it survives, else the first.
 */
export async function decodeAccounts(raw: unknown, o: { server: string; now: number; unseal: (sealed: string) => Promise<string | null> }): Promise<AccountList> {
  let stored: unknown[] = [];
  let current: string | null = null;
  if (raw && typeof raw === "object" && Array.isArray((raw as StoredAccounts).accounts)) {
    stored = (raw as StoredAccounts).accounts;
    const c = (raw as StoredAccounts).current;
    current = typeof c === "string" ? c : null;
  } else if (raw && typeof raw === "object" && "token" in raw) {
    stored = [raw];
  }
  const opened = await Promise.all(
    stored.map(async (a): Promise<Session | null> => {
      if (!a || typeof a !== "object") return null;
      const s = a as StoredAccount;
      if (!sameServer(s.server, o.server) || typeof s.expiresAt !== "number" || s.expiresAt <= o.now || !isUser(s.user) || typeof s.token !== "string") return null;
      const token = s.token.startsWith("raw:") ? s.token.slice(4) : s.token.startsWith("enc:") ? await o.unseal(s.token) : null;
      return token ? { server: o.server, token, expiresAt: s.expiresAt, user: { id: s.user.id, email: s.user.email, name: s.user.name ?? null, picture: s.user.picture ?? null } } : null;
    }),
  );
  return new AccountList(
    opened.filter((s): s is Session => s !== null),
    current,
  );
}

// ---- the flows (docs/desktop.md §18.7) -----------------------------------------------------------------------------

/** What the flows need from the app: the windows' part and the session's announcement. */
export interface AccountFlowDeps {
  list: AccountList;
  /** Leaving the current account: every open file settled (a failed save asks) — false: the person stays */
  settle(): Promise<boolean>;
  /** Leaving it for another: the windows' file tabs closed (their files flushed first), no questions */
  leave(): Promise<void>;
  /** The list changed: kept, every view and the store told (the store gets the current session) — resolves when the
   *  store has it */
  commit(): Promise<void>;
  /** Another account is current and the store has its session: Home again, for it */
  arrived(): void;
}

export type FlowResult = "switched" | "same" | "stayed" | "signed-out" | "unknown";

/** Switch to `userId` (the account menu's account rows): the files settled and closed, then the other account. */
export async function switchAccount(d: AccountFlowDeps, userId: string): Promise<FlowResult> {
  if (!d.list.has(userId)) return "unknown";
  if (d.list.current?.user.id === userId) return "same";
  if (d.list.current && !(await d.settle())) return "stayed";
  if (d.list.current) await d.leave();
  d.list.select(userId);
  await d.commit();
  d.arrived();
  return "switched";
}

/**
 * A sign-in finished (Log in on the welcome page, or Add account): the account is kept and becomes current. Signed in
 * as someone else already, that is a switch — the files settled and closed first; when the person stays with a file,
 * the new account is kept but the current one stays. The same person again: a fresh session, nothing else changes.
 */
export async function accountAdded(d: AccountFlowDeps, s: Session): Promise<FlowResult | "full"> {
  const before = d.list.current;
  if (!before) {
    if (!d.list.put(s)) return "full";
    d.list.select(s.user.id);
    await d.commit();
    return "switched";
  }
  if (before.user.id === s.user.id) {
    d.list.put(s);
    await d.commit();
    return "same";
  }
  if (!d.list.has(s.user.id) && d.list.full) return "full";
  if (!(await d.settle())) {
    d.list.put(s);
    await d.commit();
    return "stayed";
  }
  await d.leave();
  d.list.put(s);
  d.list.select(s.user.id);
  await d.commit();
  d.arrived();
  return "switched";
}

/**
 * Log out (the account menu): the current account only. Its files settled (Cancel keeps it), then it is gone; another
 * account still signed in becomes current (its Home), else the app is signed out (the welcome page).
 */
export async function logOut(d: AccountFlowDeps): Promise<FlowResult> {
  const cur = d.list.current;
  if (!cur) return "signed-out";
  if (!(await d.settle())) return "stayed";
  return goneFrom(d, cur.user.id);
}

/** Log out of all accounts: the files settled once, every account gone, the welcome page. */
export async function logOutAll(d: AccountFlowDeps): Promise<FlowResult> {
  if (!d.list.size) return "signed-out";
  if (d.list.current && !(await d.settle())) return "stayed";
  d.list.clear();
  await d.commit();
  return "signed-out";
}

/**
 * An account the server no longer accepts (a 401, the idle timeout, Delete account), or past its end: gone without
 * asking — only that one. When it was current and another remains, that one is current; else signed out.
 */
export async function accountDropped(d: AccountFlowDeps, userId: string): Promise<FlowResult> {
  if (!d.list.has(userId)) return "unknown";
  if (d.list.current?.user.id !== userId) {
    d.list.remove(userId);
    await d.commit();
    return "same";
  }
  return goneFrom(d, userId);
}

async function goneFrom(d: AccountFlowDeps, userId: string): Promise<FlowResult> {
  const others = d.list.size > 1;
  // Another account next: this one's files close in the window (signed out instead, the gate closes the window).
  if (others) await d.leave();
  d.list.remove(userId);
  await d.commit();
  if (!d.list.current) return "signed-out";
  d.arrived();
  return "switched";
}
