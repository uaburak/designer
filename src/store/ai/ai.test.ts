/**
 * The store's `ai` repository (docs/ai.md §2.9, §2.10): the ledger's math and months, history pages, Skills as `.md`
 * files, and the daily org reports — on a memory host, then through LocalStore against the real server handler
 * (node:sqlite, server/src/testing/orgWorld.ts).
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handle } from "../../../server/src/api";
import { P2, T2, world, type World } from "../../../server/src/testing/orgWorld";
import { creditsFor, type AiUsageEntry } from "../../shared/ai/types";
import { parseSkillFile } from "../../shared/ai/skillFile";
import { StoreError } from "../../shared/store/protocol";
import type { FileMeta } from "../../shared/store/types";
import type { LibraryServer } from "../libraries/org";
import { openTestStore, type TestStore } from "../testing/harness";
import { AiService, MAX_ENTRIES, REPORT_AFTER_MS, balanceOf, monthOf, resetOf, type AiStoreHost } from "./service";

const entry = (over: Partial<Omit<AiUsageEntry, "id" | "at">> = {}): Omit<AiUsageEntry, "id" | "at"> => ({ action: "rewrite", providerId: "claude-code", input: 4000, output: 1000, images: 0, credits: 2, fileKey: null, orgId: null, local: false, ok: true, ...over });

interface FakeServer extends LibraryServer {
  calls: { path: string; body: unknown }[];
  status: number;
  signedIn: boolean;
  userId: string | null;
}

function memoryHost(t: { now: number }, server: FakeServer, metas: Record<string, FileMeta> = {}) {
  const files = new Map<string, string>();
  const timers: { fn: () => void; at: number }[] = [];
  let id = 0;
  const host: AiStoreHost = {
    read: async (n) => files.get(n) ?? null,
    write: async (n, text) => void files.set(n, text),
    remove: async (n) => void files.delete(n),
    list: async (dir) => [...files.keys()].filter((k) => k.startsWith(`${dir}/`)).map((k) => k.slice(dir.length + 1)),
    server,
    getMeta: (k) => metas[k] ?? null,
    newId: () => `id${++id}`,
    now: () => t.now,
    timers: { setTimeout: (fn, ms) => (timers.push({ fn, at: t.now + ms }), timers.length - 1), clearTimeout: (h) => void (timers[h as number] && (timers[h as number].fn = () => {})) },
    log: () => {},
  };
  return { host, files, timers };
}

function fakeServer(): FakeServer {
  const s: FakeServer = {
    calls: [],
    status: 200,
    signedIn: true,
    userId: "u1",
    request: async (_m, path, body) => {
      s.calls.push({ path, body: structuredClone(body) });
      return new Response(JSON.stringify({ accepted: 1, dropped: 0 }), { status: s.status });
    },
  };
  return s;
}

describe("the ledger (§2.9)", () => {
  it("adds credits per month and per action; the balance stops at the allowance; a new month starts at 0", async () => {
    const t = { now: new Date(2026, 9, 31, 22, 0).getTime() };
    const ai = new AiService(memoryHost(t, fakeServer()).host);
    expect(await ai.balance(4250)).toEqual({ month: "2026-10", used: 0, allowance: 4250, remaining: 4250, resetsAt: new Date(2026, 10, 1).getTime(), byAction: {} });
    await ai.record(entry({ credits: 2 }));
    await ai.record(entry({ action: "make-image", credits: 8, images: 1 }));
    await ai.record(entry({ action: "rename-layers", credits: 0 }));
    const b = await ai.balance(10);
    expect(b).toMatchObject({ used: 10, allowance: 10, remaining: 0, byAction: { rewrite: 2, "make-image": 8 } });
    expect((await ai.balance(4)).remaining).toBe(0); // over the limit never goes negative
    // Fractions add up without drift
    for (let i = 0; i < 10; i++) await ai.record(entry({ credits: 0.1 }));
    expect((await ai.balance(4250)).used).toBe(11);
    // Two hours later it is November (local time): a fresh month, October kept
    t.now += 2 * 3_600_000;
    expect(await ai.balance(4250)).toMatchObject({ month: "2026-11", used: 0, remaining: 4250, resetsAt: new Date(2026, 11, 1).getTime() });
    expect((await ai.balance(4250, new Date(2026, 9, 15).getTime())).used).toBe(11);
    // December's reset is January 1st of the next year
    expect(resetOf("2026-12")).toBe(new Date(2027, 0, 1).getTime());
    expect(monthOf(new Date(2027, 0, 1).getTime())).toBe("2027-01");
  });

  it("checks entries, fills the org from the file, and pages history newest first across months", async () => {
    const t = { now: new Date(2026, 8, 30, 12).getTime() };
    const meta = { fileKey: "f1", space: { orgId: "org1", key: "room1", teamId: null, projectId: "p1" } } as unknown as FileMeta;
    const ai = new AiService(memoryHost(t, fakeServer(), { f1: meta }).host);
    await expect(ai.record(entry({ action: "dance" as never }))).rejects.toBeInstanceOf(StoreError);
    await expect(ai.record(entry({ credits: -1 }))).rejects.toBeInstanceOf(StoreError);
    await expect(ai.record(entry({ providerId: "" }))).rejects.toBeInstanceOf(StoreError);
    const first = await ai.record(entry({ fileKey: "f1" }));
    expect(first).toMatchObject({ id: "id1", at: t.now, orgId: "org1", fileKey: "f1" });
    t.now = new Date(2026, 9, 2).getTime();
    for (let i = 0; i < 3; i++) await ai.record(entry({ credits: i + 1 }));
    const p1 = await ai.history({ limit: 2 });
    expect(p1.entries.map((e) => e.credits)).toEqual([3, 2]);
    const p2 = await ai.history({ limit: 2, cursor: p1.cursor! });
    expect(p2).toEqual({ entries: [expect.objectContaining({ credits: 1 }), first], cursor: null });
    // A page that ends at a month's end continues in the month before
    const q1 = await ai.history({ limit: 3 });
    expect(q1.cursor).toBe("2026-09:0");
    expect(await ai.history({ limit: 3, cursor: q1.cursor! })).toEqual({ entries: [first], cursor: null });
    expect((await ai.history({ month: "2026-09" })).entries).toEqual([first]);
    await expect(ai.history({ month: "Oct" })).rejects.toBeInstanceOf(StoreError);
  });

  it("keeps the last entries of a busy month but counts every run", async () => {
    const t = { now: new Date(2026, 9, 5).getTime() };
    const { host, files } = memoryHost(t, fakeServer());
    const ai = new AiService(host);
    // Written as the store would have after MAX_ENTRIES runs, then one more
    const month = { v: 1, month: "2026-10", used: MAX_ENTRIES, runs: MAX_ENTRIES, byAction: { rewrite: MAX_ENTRIES }, entries: Array.from({ length: MAX_ENTRIES }, (_, i) => ({ ...entry({ credits: 1 }), id: `old${i}`, at: t.now })) };
    files.set("usage/2026-10.json", JSON.stringify(month));
    await ai.record(entry({ credits: 1 }));
    const saved = JSON.parse(files.get("usage/2026-10.json")!);
    expect(saved.entries).toHaveLength(MAX_ENTRIES);
    expect(saved.entries[0].id).toBe("old1");
    expect(saved).toMatchObject({ used: MAX_ENTRIES + 1, runs: MAX_ENTRIES + 1 });
  });

  it("balanceOf and creditsFor agree with Figma's table where the contract says (§8)", () => {
    expect(balanceOf({ month: "2026-10", used: 4300, byAction: {} }, 4250)).toMatchObject({ remaining: 0, allowance: 4250 });
    expect(creditsFor("add-interactions", {})).toBe(20);
    expect(creditsFor("rename-layers", {})).toBe(0);
    expect(creditsFor("rewrite", { input: 8000, output: 500 })).toBe(3);
  });
});

describe("Skills (§2.10)", () => {
  it("are skills/<id>.md files with an index for enabled and dates; names are unique; hand-made files count", async () => {
    const t = { now: 1000 };
    const { host, files } = memoryHost(t, fakeServer());
    const ai = new AiService(host);
    const s = await ai.saveSkill({ name: "brand-voice", description: "Write like us.", instructions: "Short sentences.\n\nNo jargon." });
    expect(s).toEqual({ id: "id1", name: "brand-voice", description: "Write like us.", instructions: "Short sentences.\n\nNo jargon.", enabled: true, createdAt: 1000, updatedAt: 1000 });
    expect(parseSkillFile(files.get("skills/id1.md")!)).toEqual({ name: "brand-voice", description: "Write like us.", instructions: "Short sentences.\n\nNo jargon." });
    await expect(ai.saveSkill({ name: "brand-voice", description: "x", instructions: "y" })).rejects.toMatchObject({ code: "conflict" });
    await expect(ai.saveSkill({ name: "Bad Name", description: "x", instructions: "y" })).rejects.toMatchObject({ code: "invalid" });
    await expect(ai.saveSkill({ id: "nope", name: "other", description: "x", instructions: "y" })).rejects.toMatchObject({ code: "not-found" });
    t.now = 2000;
    const off = await ai.saveSkill({ id: "id1", name: "brand-voice", description: "Write like us, always.", instructions: "Short.", enabled: false });
    expect(off).toMatchObject({ enabled: false, createdAt: 1000, updatedAt: 2000, description: "Write like us, always." });
    files.set("skills/handmade.md", "---\nname: release-notes\ndescription: Notes for a release\n---\nList the changes.\n");
    files.set("skills/broken.md", "no frontmatter and no description");
    expect((await ai.skills()).map((x) => [x.id, x.name, x.enabled])).toEqual([
      ["id1", "brand-voice", false],
      ["handmade", "release-notes", true],
    ]);
    await ai.removeSkill("id1");
    expect(files.has("skills/id1.md")).toBe(false);
    expect(JSON.parse(files.get("skills.json")!).skills).toEqual({});
    expect((await ai.skills()).map((x) => x.name)).toEqual(["release-notes"]);
    await expect(ai.removeSkill("../x")).rejects.toBeInstanceOf(StoreError);
  });

  it("remembers the default skills turned off (§8.6) beside the index, through saves and removes", async () => {
    const t = { now: 1000 };
    const { host, files } = memoryHost(t, fakeServer());
    const ai = new AiService(host);
    expect(await ai.defaultSkillsOff()).toEqual([]);
    expect(await ai.setDefaultSkillOn("ux-review", false)).toEqual(["ux-review"]);
    expect(await ai.setDefaultSkillOn("motion-opus", false)).toEqual(["motion-opus", "ux-review"]);
    const s = await ai.saveSkill({ name: "brand-voice", description: "Write like us.", instructions: "Short." });
    await ai.removeSkill(s.id);
    expect(JSON.parse(files.get("skills.json")!).defaultsOff).toEqual(["motion-opus", "ux-review"]);
    expect(await ai.setDefaultSkillOn("ux-review", true)).toEqual(["motion-opus"]);
    // A new service reads it from disk; a bad name is refused.
    expect(await new AiService(host).defaultSkillsOff()).toEqual(["motion-opus"]);
    await expect(ai.setDefaultSkillOn("../x", false)).rejects.toBeInstanceOf(StoreError);
  });
});

describe("org reports (§2.9)", () => {
  it("sends each day's absolute total a minute after the last record, again only when it changed, and never as another account", async () => {
    const t = { now: Date.UTC(2026, 9, 6, 12) };
    const server = fakeServer();
    const meta = { fileKey: "f1", editorType: "design", space: { orgId: "org1", key: "room1", teamId: null, projectId: "p1" } } as unknown as FileMeta;
    const { host, timers } = memoryHost(t, server, { f1: meta });
    const ai = new AiService(host);
    await ai.record(entry({ fileKey: "f1", credits: 2 }));
    await ai.record(entry({ fileKey: "f1", credits: 3 }));
    await ai.record(entry({ credits: 50 })); // a draft of no org: not reported
    await ai.record(entry({ fileKey: "f1", credits: 0, action: "rename-layers" }));
    expect(await ai.pendingReports()).toEqual([{ orgId: "org1", day: "2026-10-06", editorType: "design", credits: 5 }]);
    expect(timers.at(-1)!.at).toBe(t.now + REPORT_AFTER_MS);
    timers.at(-1)!.fn();
    await ai.flush();
    expect(server.calls).toEqual([{ path: "/me/ai-usage", body: { rows: [{ orgId: "org1", day: "2026-10-06", editorType: "design", credits: 5 }] } }]);
    expect(await ai.pendingReports()).toEqual([]);
    await ai.flush();
    expect(server.calls).toHaveLength(1);
    // The server down: kept for later
    await ai.record(entry({ fileKey: "f1", credits: 1 }));
    server.status = 503;
    await ai.flush();
    expect(await ai.pendingReports()).toEqual([{ orgId: "org1", day: "2026-10-06", editorType: "design", credits: 6 }]);
    // Another account signs in: the first one's totals are dropped, not sent as them
    server.status = 200;
    server.userId = "u2";
    await ai.flush();
    expect(server.calls).toHaveLength(2);
    expect(await ai.pendingReports()).toEqual([]);
  });
});

// ---- through LocalStore and the real server ----

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
const ORIGIN = "https://designer.example.workers.dev";
let w: World;
const opened: TestStore[] = [];

beforeEach(async () => {
  vi.stubGlobal("WebSocket", NoSocket);
  w = await world();
});
afterEach(async () => {
  for (const s of opened.splice(0)) {
    await s.close().catch(() => undefined);
    s.dispose();
  }
  vi.unstubAllGlobals();
});

describe("LocalStore's ai (Workspace/spaces/ai)", () => {
  it("writes the ledger and skills under spaces/ai, reports an org file's credits to ai_usage_daily, and reads them back after a restart", async () => {
    const fetch: typeof globalThis.fetch = async (input, init) => handle(new Request(String(input), init), w.deps);
    const s = await openTestStore({ fetch });
    opened.push(s);
    await s.api.multiplayer.setSession({ server: ORIGIN, token: w.people.carol.token });
    const f = await s.api.workspace.createFile({ name: "Copy", folderId: null });
    await s.store.ws.queue.run(() => s.store.ws.setFileSpace(f.fileKey, { orgId: w.orgId, key: "file_web001", teamId: T2, projectId: P2 }));
    const e = await s.api.ai.record(entry({ fileKey: f.fileKey, credits: 7 }));
    expect(e.orgId).toBe(w.orgId);
    const skill = await s.api.ai.saveSkill({ name: "tone", description: "Our tone.", instructions: "Be kind." });
    const root = join(s.dir, "Workspace", "spaces", "ai");
    expect(readFileSync(join(root, "skills", `${skill.id}.md`), "utf8")).toContain("name: tone");
    expect(existsSync(join(root, "usage", `${monthOf(s.clock.now())}.json`))).toBe(true);
    await s.timers.advance(REPORT_AFTER_MS);
    await s.store.ai.flush();
    const rows = await w.rows(`SELECT user_id, editor_type, seat_credits FROM ai_usage_daily`);
    expect(rows).toEqual([{ user_id: w.people.carol.id, editor_type: "design", seat_credits: 7 }]);
    // A skill file dropped in by hand, then a restart
    writeFileSync(join(root, "skills", "byhand.md"), "---\nname: by-hand\ndescription: Made by hand\n---\nDo it.\n");
    await s.close();
    const again = await s.reopen({ fetch });
    opened.push(again);
    expect((await again.api.ai.balance(4250)).used).toBe(7);
    expect((await again.api.ai.skills()).map((x) => x.name)).toEqual(["by-hand", "tone"]);
  });
});
