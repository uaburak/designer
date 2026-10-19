// @vitest-environment happy-dom
/**
 * Home's File settings (ours — docs/home.md "File settings [ours]"; FileSettings.tsx): "File settings…" on a file's
 * card opens a draggable dialog with Overview, Storage, People, Activity and Settings. The local half comes from the
 * store (`files.details`), the server half from the file's room (`multiplayer.fileReport` / `fileActivity`); signed out
 * the server parts say why they are empty. Role changes and removals go through the Share dialog's own calls.
 */
import { act } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { $, $$, click, mount, type Mounted } from "@/ds/__tests__/dom";
import type { FileMember } from "@shared/multiplayer/types";
import type { FileActivityEvent, FileDetails, FileServerReport } from "@shared/store/fileSettings";
import { FileBrowser } from "../FileBrowser";
import { FileSettingsDialog, type FileSettingsSource } from "../FileSettings";
import { itemMenu } from "../menus";
import type { FilesBackend } from "../storeAccess";
import { MemoryWorkspace } from "./memoryWorkspace";

let m: Mounted | null = null;
afterEach(() => {
  m?.unmount();
  m = null;
  document.body.innerHTML = "";
});

const settle = () => act(async () => new Promise((r) => setTimeout(r, 30)));
const tab = (label: string) => $$('[role="tab"]').find((el) => el.querySelector("span > span")?.textContent?.trim() === label)!;
const text = () => $('[role="dialog"]').textContent ?? "";

const NOW = Date.now();
const ev = (id: string, at: number, kind: FileActivityEvent["kind"], action: string, source: FileActivityEvent["source"], actor: string | null = null, detail: string | null = null): FileActivityEvent => ({ id, at, kind, action, actor, detail, source });

function details(fileKey: string): FileDetails {
  return {
    fileKey,
    storage: [
      { kind: "document", bytes: 120_000 },
      { kind: "images", bytes: 2_500_000, count: 3 },
      { kind: "media", bytes: 0, count: 0 },
      { kind: "versions", bytes: 80_000, count: 2 },
      { kind: "previews", bytes: 0, count: 0 },
      { kind: "thumbnail", bytes: 9_000 },
    ],
    totalBytes: 2_709_000,
    documentHere: true,
    versions: { total: 2, named: 1, autosaves: 1, latestAt: NOW - 3600e3 },
    lastEditAt: NOW - 60e3,
    missingImages: 0,
    activity: [ev("l:s:1", NOW - 60e3, "edited", "session", "local"), ev("l:created", NOW - 86400e3, "created", "created", "local")],
  };
}

const REPORT: FileServerReport = {
  key: "room_key_1",
  name: "Landing page",
  owner: { id: "u_me", name: "Demo User", email: "demo@example.com", picture: null },
  createdAt: NOW - 86400e3,
  updatedAt: NOW - 120e3,
  lastEditedBy: "Ada Lovelace",
  role: "owner",
  place: { kind: "drafts", orgName: null, teamName: null, projectName: null },
  storage: [
    { kind: "document", bytes: 100_000 },
    { kind: "images", bytes: 2_000_000, count: 3 },
    { kind: "media", bytes: 0, count: 0 },
    { kind: "versions", bytes: 50_000, count: 2 },
    { kind: "previews", bytes: 0, count: 0 },
    { kind: "thumbnail", bytes: 9_000 },
  ],
  totalBytes: 2_159_000,
  versions: 4,
  branches: 1,
  comments: { threads: 2, open: 1 },
  previews: 0,
  visitors: [],
  quota: { storageBytes: 18 * 1024 ** 3, storageLimit: 20 * 1024 ** 3, files: 12, filesLimit: 5000, previews: 1, previewsLimit: 20 },
};

function fakeSource(o: { signedIn: boolean; report?: FileServerReport | null }) {
  const calls: string[] = [];
  let members: FileMember[] = [
    { email: "demo@example.com", userId: "u_me", name: "Demo User", role: "owner", pending: false },
    { email: "ada@example.com", userId: "u_ada", name: "Ada Lovelace", role: "editor", pending: false },
    { email: "alan@example.com", userId: null, name: null, role: "viewer", pending: true },
  ];
  const server = Array.from({ length: 60 }, (_, i) => ev(`s:${i}`, NOW - 120e3 - i * 1000, i % 2 ? "comment" : "opened", i % 2 ? "comment" : "opened", "server", "Ada Lovelace", i % 2 ? `Comment ${i}` : null));
  const source: FileSettingsSource = {
    details: async (k) => details(k),
    report: async () => o.report ?? null,
    activity: async (_k, q) => {
      calls.push(`activity:${q.cursor ?? 0}:${(q.kinds ?? []).join(",")}`);
      const wanted = q.kinds?.length ? server.filter((e) => q.kinds!.includes(e.kind)) : server;
      const from = q.cursor ?? 0;
      const page = wanted.slice(from, from + (q.limit ?? 50));
      return { events: page, next: from + page.length < wanted.length ? from + page.length : null };
    },
    signedIn: async () => o.signedIn,
    info: async () => ({ key: "room_key_1", name: "Landing page", role: "owner", linkAccess: "none", viewersCanCopy: true, link: "https://s/f/room_key_1", access: { canShare: true, canManage: true, capped: null } }),
    members: async () => members,
    requests: async () => [],
    invite: async (_k, email, role) => (calls.push(`invite:${email}:${role}`), (members = members.map((x) => (x.email === email ? { ...x, role } : x)))),
    removeMember: async (_k, email) => (calls.push(`remove:${email}`), (members = members.filter((x) => x.email !== email))),
  };
  return { source, calls };
}

async function open(source: FileSettingsSource) {
  const ws = new MemoryWorkspace({ teamName: "Demo's team" });
  const folder = await ws.createFolder({ name: "Marketing", parentId: null });
  const meta = await ws.createFile({ name: "Landing page", folderId: folder.id });
  const file = await ws.getFile(meta.fileKey);
  const toasts: string[] = [];
  m = mount(FileSettingsDialog, { file, workspace: ws, source, teamName: "Demo's team", onClose: () => {}, toast: (t: { message: string }) => toasts.push(t.message) });
  await settle();
  return { ws, file, toasts };
}

async function choose(label: string, option: string) {
  click($$('[role="combobox"]').find((el) => el.getAttribute("aria-label") === label)!);
  await settle();
  click($$('[role="option"]').find((o) => o.textContent?.trim() === option)!);
  await settle();
}

describe("File settings…", () => {
  it("is on a single file's menu when the backend has it", () => {
    const ids = (e: ReturnType<typeof itemMenu>) => e.map((x) => (typeof x === "object" && "id" in x ? x.id : x));
    expect(ids(itemMenu({ location: { kind: "drafts" }, files: 1, folders: 0, allStarred: false, fileSettings: true }))).toContain("file-settings");
    expect(ids(itemMenu({ location: { kind: "drafts" }, files: 2, folders: 0, allStarred: false, fileSettings: true }))).not.toContain("file-settings");
    expect(ids(itemMenu({ location: { kind: "drafts" }, files: 1, folders: 0, allStarred: false }))).not.toContain("file-settings");
  });

  it("opens from a file card's context menu in Home", async () => {
    const ws = new MemoryWorkspace({ teamName: "Demo's team" });
    await ws.createFile({ name: "Landing page", folderId: null });
    const { source } = fakeSource({ signedIn: false });
    const backend: FilesBackend = { workspace: ws, source: "memory", thumbnailUrl: () => null, fileSettings: source };
    m = mount(FileBrowser, { backend, initialLocation: { kind: "drafts" }, toast: () => {} });
    await settle();
    const card = $('[data-ds="FileCard"]');
    act(() => {
      card.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));
    });
    await settle();
    click($$('#ds-overlays [role^="menuitem"]').find((el) => el.textContent?.includes("File settings…"))!);
    await settle();
    expect($('[role="dialog"]').getAttribute("aria-labelledby")).toBeTruthy();
    expect($("[data-file-settings]")).toBeTruthy();
    expect(text()).toContain("Overview");
  });

  it("shows the overview from the store and the server", async () => {
    const { source } = fakeSource({ signedIn: true, report: REPORT });
    await open(source);
    expect(tab("Overview").getAttribute("aria-selected")).toBe("true");
    const t = text();
    expect(t).toContain("Landing page");
    expect(t).toContain("Demo User");
    expect(t).toContain("by Ada Lovelace");
    expect(t).toContain("2.6 MB"); // on this computer
    expect(t).toContain("2.1 MB"); // in the cloud
    expect(t).toContain("In your cloud drafts");
    expect(t).toContain("room_key_1");
    expect(t).toContain("2 threads (1 open)");
  });

  it("draws storage bars by kind and the owner's quota", async () => {
    const { source } = fakeSource({ signedIn: true, report: REPORT });
    await open(source);
    click(tab("Storage"));
    await settle();
    expect($$('[data-storage="images"]')).toHaveLength(2); // here and in the cloud
    expect($$('[data-storage="images"]')[0].textContent).toContain("3 items");
    const storage = $$('[role="meter"]').find((el) => el.getAttribute("aria-label") === "Storage")!;
    expect(Number(storage.getAttribute("aria-valuenow"))).toBe(18 * 1024 ** 3);
    // 90 %: the danger fill
    expect((storage.firstElementChild as HTMLElement).style.width).toBe("90%");
  });

  it("says why the server parts are empty when signed out, and still shows the local ones", async () => {
    const { source, calls } = fakeSource({ signedIn: false });
    await open(source);
    expect(text()).toContain("Marketing"); // its folder
    click(tab("People"));
    await settle();
    expect(text()).toContain("Log in to see this");
    click(tab("Activity"));
    await settle();
    expect(text()).toContain("Only this computer’s activity is shown");
    expect($$("[data-activity]").map((e) => e.getAttribute("data-activity"))).toEqual(["session", "created"]);
    expect(calls.filter((c) => c.startsWith("activity"))).toEqual([]);
  });

  it("changes a member's role and removes one through the sharing calls", async () => {
    const { source, calls } = fakeSource({ signedIn: true, report: REPORT });
    const { toasts } = await open(source);
    click(tab("People"));
    await settle();
    expect($$("[data-member]").map((e) => e.getAttribute("data-member"))).toEqual(["demo@example.com", "ada@example.com", "alan@example.com"]);
    expect($('[data-member="alan@example.com"]').textContent).toContain("Invited");
    await choose("Access for Ada Lovelace", "Can view");
    expect(calls).toContain("invite:ada@example.com:viewer");
    await choose("Access for alan@example.com", "Remove");
    expect(calls).toContain("remove:alan@example.com");
    expect($$("[data-member]")).toHaveLength(2);
    expect(toasts).toContain("Removed alan@example.com");
  });

  it("merges, filters and pages the activity log", async () => {
    const { source, calls } = fakeSource({ signedIn: true, report: REPORT });
    await open(source);
    click(tab("Activity"));
    await settle();
    expect($$("[data-activity]")).toHaveLength(50);
    expect($$('[data-source="local"]')[0].textContent).toContain("This computer");
    click($$("button").find((b) => b.textContent?.trim() === "Show more")!);
    await settle();
    expect(calls).toContain("activity:50:");
    expect($$("[data-activity]")).toHaveLength(62);
    await choose("Show", "Comments");
    expect(calls).toContain("activity:0:comment");
    expect(new Set($$("[data-activity]").map((e) => e.getAttribute("data-activity")))).toEqual(new Set(["comment"]));
  });

  it("toggles a per-file setting (starred) through the store", async () => {
    const { source } = fakeSource({ signedIn: false });
    const { ws, file } = await open(source);
    click(tab("Settings"));
    await settle();
    expect(text()).toContain("Always — the file is only on this computer");
    click($$('[role="switch"]').find((s) => s.getAttribute("aria-label") === "Starred")!);
    await settle();
    expect((await ws.getFile(file.fileKey)).starred).toBe(true);
  });
});
