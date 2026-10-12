// @vitest-environment happy-dom
/**
 * The web app (docs/cloud.md §7) from the welcome page to Home: signed out, `/` is the welcome page and Log in with
 * Google leaves for this origin's `/auth/login`; back with a code, the page trades it, opens the account's IndexedDB
 * cache and shows Home with the person's Drafts from the server (the real Worker handler) — no local "My team", no
 * demo files; Log out deletes the account's cache. The product's routes only.
 */
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { realServer } from "../../store/__tests__/realServer";
import { fakeIndexedDb, type FakeIdb } from "../../store/memory/fakeIdb";

class NoSocket {
  binaryType = "arraybuffer";
  readyState = 0;
  onopen = null;
  onmessage = null;
  onclose = null;
  onerror = null;
  send() {}
  close() {}
}

let idb: FakeIdb;
let assigned: string[];
let replaced: string[];

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv("VITE_WECRA_WEB", "1");
  idb = fakeIndexedDb();
  vi.stubGlobal("indexedDB", idb.factory);
  vi.stubGlobal("WebSocket", NoSocket);
  assigned = [];
  replaced = [];
  localStorage.clear();
  sessionStorage.clear();
  vi.spyOn(window.location, "assign").mockImplementation((u: string | URL) => void assigned.push(String(u)));
  vi.spyOn(window.location, "replace").mockImplementation((u: string | URL) => void replaced.push(String(u)));
  history.replaceState(null, "", "/");
  document.body.innerHTML = '<div id="root"></div>';
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

const settle = (ms = 40) => act(async () => new Promise((r) => setTimeout(r, ms)));
const text = () => document.body.textContent ?? "";

async function mountFiles() {
  const { createRoot } = await import("react-dom/client");
  const { createElement } = await import("react");
  const FilesApp = (await import("../../files/FilesApp")).default;
  const root = createRoot(document.getElementById("root")!);
  act(() => root.render(createElement(FilesApp)));
  return root;
}

describe("the web app: welcome → Home", () => {
  it("routes: the product's only; isWebApp; the server is the page's origin", async () => {
    const { isWebApp, webRoute, figFileName } = await import("../webApp");
    const { webServer } = await import("../../store/webAccount");
    expect(isWebApp()).toBe(true);
    expect(webServer()).toBe(location.origin);
    expect(webRoute("")).toBe("files");
    expect(webRoute("?editor&file=abc")).toBe("editor");
    expect(webRoute("?present&file=abc")).toBe("present");
    expect(webRoute("?editor")).toBe("files");
    expect(webRoute("?gallery")).toBe("files");
    expect(webRoute("?admin")).toBe("files");
    expect(figFileName("KOC/Logo")).toBe("KOC Logo.fig");
    expect(figFileName("  ")).toBe("Untitled.fig");
  });

  it("signed out: the welcome page; Log in with Google goes to this origin's /auth/login and comes back here", async () => {
    const root = await mountFiles();
    await settle();
    expect(text()).toContain("Welcome to Wecra");
    const google = document.querySelector("[data-welcome-google]") as HTMLElement;
    act(() => void google.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await settle();
    const login = new URL(assigned[0]);
    expect(login.origin).toBe(location.origin);
    expect(login.pathname).toBe("/auth/login");
    expect(login.searchParams.get("method")).toBe("google");
    expect(new URL(login.searchParams.get("return")!).origin).toBe(location.origin);
    act(() => root.unmount());
  });

  it("back with a code: the session, the account's cache, Home with the person's Drafts from the server; Log out deletes the cache", async () => {
    const srv = await realServer();
    const alice = await srv.addUser("alice@example.com", "Alice");
    // A draft made elsewhere (another browser)
    expect((await srv.call("POST", "/me/drafts", alice.token, { name: "Poster" })).status).toBe(201);
    // The Worker on this origin: the code exchange, then the real handler
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input instanceof Request ? input.url : input));
      if (url.pathname === "/auth/token") return Response.json({ token: alice.token, expiresAt: Date.now() + 86_400_000, user: { ...alice.user, picture: null } });
      return srv.fetch(input, init);
    });
    sessionStorage.setItem("designer.web.signin", JSON.stringify({ state: "st", verifier: "v" }));
    history.replaceState(null, "", "/?auth_code=code&auth_state=st");
    const root = await mountFiles();
    await vi.waitFor(() => expect(text()).toContain("Drafts"), { timeout: 3000 });
    // Home opens on Recents; the person's Drafts list the draft made elsewhere
    const drafts = [...document.querySelectorAll<HTMLElement>("button, a, [role=treeitem], [role=link], [role=button]")].find((e) => e.textContent?.trim() === "Drafts")!;
    expect(drafts).toBeTruthy();
    act(() => void drafts.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await vi.waitFor(() => expect(text()).toContain("Poster"), { timeout: 3000 });
    expect(location.search).toBe("");
    expect(text()).not.toContain("Welcome to Wecra");
    expect(text()).toContain("Alice");
    expect(text()).toContain("Drafts");
    expect(text()).not.toContain("My team");
    // The account's own cache
    expect(idb.names()).toEqual([`wecra.cache.${alice.user.id}`]);

    // Log out: the session and the account's cache go; the page starts over at /
    const { webAccount } = await import("../../store/webAccount");
    await act(async () => void (await webAccount.signOut()));
    await vi.waitFor(() => expect(idb.names()).toEqual([]), { timeout: 3000 });
    await vi.waitFor(() => expect(replaced).toEqual(["/"]));
    expect(localStorage.getItem("designer.web.session")).toBeNull();
    act(() => root.unmount());
  });
});
