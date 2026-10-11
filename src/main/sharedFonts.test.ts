// Organization and team fonts in main (docs/desktop.md §14.3) against a contract fake of the server's routes
// (sharedFontsFake.ts): the upload flow (pick → parse → conflicts → licence → Skip / Replace), who gets which fonts,
// `s:` ids read through the cache, offline, eviction when access ends, sign-out.
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SharedFontScope } from "../shared/fonts/sharedTypes";

vi.mock("electron", () => ({ app: { getPath: () => "/tmp" }, dialog: {}, webContents: { getAllWebContents: () => [] } }));
// fonts.ts hands sharedFonts.ts its font reader and routes `s:` ids to it.
const { readFont } = await import("./fonts");
const sf = await import("./sharedFonts");
const { fakeFontServer } = await import("./sharedFontsFake");

const INTER = fileURLToPath(new URL("../renderer/src/engine/fonts/Inter-3.19.ttf", import.meta.url));
const BASE = "https://fake.test";
const ORG: SharedFontScope = { type: "org", orgId: "acme" };
const TEAM: SharedFontScope = { type: "team", orgId: "acme", teamId: "brand" };

let dirs: string[] = [];
const temp = (prefix = "shared-fonts-") => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
};

let server: ReturnType<typeof fakeFontServer>;
let tokens: Record<string, string>;
let as: string | null;
let root: string;

beforeEach(() => {
  server = fakeFontServer(BASE);
  tokens = {
    admin: server.person("admin", [{ orgId: "acme", role: "admin" }]),
    member: server.person("member", [{ orgId: "acme", role: "member", teams: ["brand"] }]),
    other: server.person("other", [{ orgId: "acme", role: "member" }]),
    guest: server.person("guest", [{ orgId: "acme", role: "guest", teams: ["brand"] }]),
    teamAdmin: server.person("teamAdmin", [{ orgId: "acme", role: "member", teamAdmin: ["brand"] }]),
  };
  as = "admin";
  root = temp();
  sf.resetSharedFonts();
  sf.setSharedFontsRoot(root);
  sf.setSharedFontsFetch((url, init) => server.fetch(url, init));
  sf.setSharedFontsSession(() => (as ? { server: BASE, token: tokens[as], userId: as } : null));
});
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
  vi.restoreAllMocks();
});

/** Uploads Inter into a scope as the current person (no conflicts expected). */
async function uploadInter(scope: SharedFontScope) {
  const picked = await sf.prepareUpload(scope, [INTER]);
  expect(picked.conflicts).toEqual([]);
  return sf.uploadPicked(scope, picked.candidates.map((c) => c.token), {});
}

describe("shared fonts: uploading", () => {
  it("parses the picked files, refuses what Figma refuses, uploads with the licence and lists the faces", async () => {
    const junkDir = temp("junk-");
    const junk = join(junkDir, "notes.ttf");
    writeFileSync(junk, "not a font");
    const ttc = join(junkDir, "Family.ttc");
    writeFileSync(ttc, Buffer.from("ttcf\0\x01\0\0\0\0\0\0", "latin1"));
    const fakeTtc = join(junkDir, "Collection.ttf");
    writeFileSync(fakeTtc, Buffer.from("ttcf\0\x01\0\0\0\0\0\0", "latin1"));
    const woff = join(junkDir, "Web.woff2");
    writeFileSync(woff, "wOF2");

    const picked = await sf.prepareUpload(ORG, [INTER, junk, ttc, fakeTtc, woff]);
    expect(picked.candidates).toHaveLength(1);
    const c = picked.candidates[0];
    expect(c).toMatchObject({ fileName: "Inter-3.19.ttf", format: "ttf" });
    expect(c.sha1).toMatch(/^[0-9a-f]{40}$/);
    // A variable font: one face per named instance, as the index lists it.
    expect(c.faces).toHaveLength(18);
    expect(c.faces.find((f) => f.style === "Bold Italic")).toMatchObject({ family: "Inter", weight: 700, italic: true, variable: true });
    expect(picked.failed).toEqual([
      { fileName: "notes.ttf", reason: "Not a font file" },
      { fileName: "Family.ttc", reason: "Only .TTF and .OTF files can be uploaded" },
      { fileName: "Collection.ttf", reason: "Font collections (.TTC) can't be uploaded" },
      { fileName: "Web.woff2", reason: "Only .TTF and .OTF files can be uploaded" },
    ]);
    expect(server.log).toContain("POST /orgs/acme/fonts/check");

    const changed = vi.fn();
    sf.onSharedFontsChanged(changed);
    const result = await sf.uploadPicked(ORG, [c.token], {});
    expect(result.uploaded).toHaveLength(18);
    expect(result.failed).toEqual([]);
    expect(server.log).toContain("PUT /orgs/acme/fonts");
    // The uploader's own list was refreshed (the Inbox notice would do it too) and views were told.
    expect(changed).toHaveBeenCalledTimes(1);
    expect(await sf.sharedFonts()).toHaveLength(18);
    expect((await sf.listScopeFonts(ORG)).faces).toHaveLength(18);
    // A token is used once.
    expect((await sf.uploadPicked(ORG, [c.token], {})).failed).toHaveLength(1);
  });

  it("asks about a family already there: Skip leaves the file out, Replace updates it", async () => {
    await uploadInter(ORG);
    const before = server.faces().map((f) => f.id);

    const again = await sf.prepareUpload(ORG, [INTER]);
    expect(again.conflicts).toEqual([{ family: "Inter", existing: 18 }]);
    const skip = await sf.uploadPicked(ORG, again.candidates.map((c) => c.token), { Inter: "skip" });
    expect(skip).toMatchObject({ uploaded: [], skipped: ["Inter"], replaced: [], failed: [] });
    expect(server.log.filter((l) => l.startsWith("PUT"))).toHaveLength(1);

    const third = await sf.prepareUpload(ORG, [INTER]);
    const replace = await sf.uploadPicked(ORG, third.candidates.map((c) => c.token), { Inter: "replace" });
    expect(replace.replaced).toEqual(["Inter"]);
    expect(replace.uploaded).toHaveLength(18);
    expect(server.log).toContain("PUT /orgs/acme/fonts?onConflict=replace");
    const after = server.faces().map((f) => f.id);
    expect(after).toHaveLength(18);
    expect(after.some((id) => before.includes(id))).toBe(false);
  });

  it("refuses a token from another scope or past ten minutes, and a scope that isn't one", async () => {
    const picked = await sf.prepareUpload(ORG, [INTER]);
    expect((await sf.uploadPicked(TEAM, [picked.candidates[0].token], {})).failed[0].reason).toMatch(/Pick it again/);
    const later = await sf.prepareUpload(ORG, [INTER]);
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + 11 * 60 * 1000);
    expect((await sf.uploadPicked(ORG, [later.candidates[0].token], {})).failed).toHaveLength(1);
    expect(() => sf.checkScope({ type: "org", orgId: "../x" })).toThrow();
    expect(() => sf.checkScope({ type: "team", orgId: "acme" })).toThrow();
    expect(sf.checkScope({ type: "team", orgId: "acme", teamId: "brand", extra: 1 })).toEqual(TEAM);
  });

  it("team fonts: a team admin uploads and removes; the server's refusals reach the view", async () => {
    as = "member";
    await expect(sf.prepareUpload(TEAM, [INTER])).rejects.toThrow("Only admins can upload fonts");
    as = "teamAdmin";
    expect((await uploadInter(TEAM)).uploaded).toHaveLength(18);
    expect(server.faces().every((f) => f.teamId === "brand")).toBe(true);
    const removed = await sf.removeScopeFonts(TEAM, { family: "Inter" });
    expect(removed.faces).toEqual([]);
    expect(server.log).toContain("DELETE /orgs/acme/fonts?team=brand&family=Inter");
  });
});

describe("shared fonts: using them", () => {
  it("serves org fonts to members (not guests) and team fonts to the team; s: ids download once into the cache", async () => {
    await uploadInter(ORG);
    as = "teamAdmin";
    await uploadInter(TEAM);

    as = "member";
    sf.resetSharedFonts();
    expect(await sf.refreshSharedFonts()).toBe(true);
    const mine = await sf.sharedFonts();
    expect(mine.filter((f) => f.teamId === null)).toHaveLength(18);
    expect(mine.filter((f) => f.teamId === "brand")).toHaveLength(18);

    as = "other";
    sf.resetSharedFonts();
    await sf.refreshSharedFonts();
    expect((await sf.sharedFonts()).every((f) => f.teamId === null)).toBe(true);

    // The owner's default: guests don't get org fonts (team fonts yes, in their team).
    as = "guest";
    sf.resetSharedFonts();
    await sf.refreshSharedFonts();
    expect((await sf.sharedFonts()).map((f) => f.teamId)).toEqual(Array(18).fill("brand"));

    as = "member";
    sf.resetSharedFonts();
    await sf.refreshSharedFonts();
    const face = (await sf.sharedFonts())[0];
    const bytes = await readFont(`s:${face.id}`);
    expect(bytes.length).toBeGreaterThan(100_000);
    await readFont(`s:${(await sf.sharedFonts())[1].id}`);
    expect(server.log.filter((l) => l.startsWith("GET /fonts/"))).toHaveLength(1);
    expect(readdirSync(join(root, "fonts", "shared"))).toEqual([`${face.sha1}.ttf`]);
    await expect(readFont("s:nope")).rejects.toThrow();
  });

  it("works offline from the cached list and files; another account sees none of them", async () => {
    await uploadInter(ORG);
    const face = (await sf.sharedFonts())[0];
    await readFont(`s:${face.id}`);

    server.offline = true;
    sf.resetSharedFonts();
    expect(await sf.refreshSharedFonts()).toBe(false);
    expect(await sf.sharedFonts()).toHaveLength(18);
    expect((await readFont(`s:${face.id}`)).length).toBeGreaterThan(100_000);
    await expect(sf.listScopeFonts(ORG)).rejects.toThrow("You're offline");

    as = "other";
    sf.resetSharedFonts();
    expect(await sf.sharedFonts()).toEqual([]);
  });

  it("deletes a cached file once the person may no longer use it; signed out the list empties and files stay", async () => {
    await uploadInter(ORG);
    as = "member";
    sf.resetSharedFonts();
    await sf.refreshSharedFonts();
    const face = (await sf.sharedFonts())[0];
    await readFont(`s:${face.id}`);
    const file = join(root, "fonts", "shared", `${face.sha1}.ttf`);
    expect(existsSync(file)).toBe(true);

    as = null;
    expect(await sf.refreshSharedFonts()).toBe(true);
    expect(await sf.sharedFonts()).toEqual([]);
    expect(existsSync(file)).toBe(true);
    await expect(readFont(`s:${face.id}`)).rejects.toThrow();

    // An admin removes them on another computer.
    for (const f of [...server.faces()]) await server.fetch(`${BASE}/orgs/acme/fonts/${f.id}`, { method: "DELETE", headers: { authorization: `Bearer ${tokens.admin}` } });
    as = "member";
    sf.resetSharedFonts();
    expect(await sf.sharedFonts()).toHaveLength(18); // the cached list, until the refresh answers
    expect(await sf.refreshSharedFonts()).toBe(true);
    expect(await sf.sharedFonts()).toEqual([]);
    expect(existsSync(file)).toBe(false);
  });

  it("refreshes on the store's fonts event, on sign-in / sign-out, and on focus at most every 6 hours", async () => {
    const hooks = { store: () => {}, session: () => {}, focus: () => {} };
    const changed = vi.fn();
    sf.onSharedFontsChanged(changed);
    const stop = sf.startSharedFonts({
      onStoreFonts: (cb) => ((hooks.store = cb), () => {}),
      onSession: (cb) => ((hooks.session = cb), () => {}),
      onFocus: (cb) => ((hooks.focus = cb), () => {}),
    });
    await vi.waitFor(() => expect(server.log).toContain("GET /me/fonts"));
    const gets = () => server.log.filter((l) => l === "GET /me/fonts").length;
    // Nothing shared yet: the first refresh changed nothing.
    expect(changed).not.toHaveBeenCalled();

    // An admin uploads on another computer; the Inbox notice reaches main through the store.
    const c = await sf.readCandidate(INTER);
    if (!("token" in c)) throw new Error("Inter didn't parse");
    await server.fetch(`${BASE}/orgs/acme/fonts`, {
      method: "PUT",
      body: (await import("node:fs")).readFileSync(INTER),
      headers: { authorization: `Bearer ${tokens.admin}`, "x-font-licence": "confirmed", "x-font-faces": Buffer.from(JSON.stringify(c.faces)).toString("base64") },
    });
    const n = gets();
    hooks.store();
    await vi.waitFor(() => expect(changed).toHaveBeenCalled());
    expect(gets()).toBe(n + 1);
    expect(await sf.sharedFonts()).toHaveLength(18);

    // Focus right after a refresh: nothing; six hours later: a refresh.
    hooks.focus();
    expect(gets()).toBe(n + 1);
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + sf.FOCUS_REFRESH_MS + 1);
    hooks.focus();
    await vi.waitFor(() => expect(gets()).toBe(n + 2));

    // Signed out: an empty list at once.
    as = null;
    hooks.session();
    await vi.waitFor(() => expect(changed).toHaveBeenCalledTimes(2));
    expect(await sf.sharedFonts()).toEqual([]);
    stop();
  });
});
