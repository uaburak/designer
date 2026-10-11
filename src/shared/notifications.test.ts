import { describe, expect, it } from "vitest";
import { intentFromLink, keyFromLink, linkWith } from "./multiplayer/types";
import { cleanPrefs, DEFAULT_NOTIFICATION_PREFS, desktopText, notificationAction, notificationDate, notificationLink, wantsDesktop, type NotificationItem } from "./notifications";

const item = (over: Partial<NotificationItem>): NotificationItem => ({
  id: "n1",
  kind: "comment",
  fileKey: "file_abc123",
  fileName: "Insider V3",
  actor: { id: "u1", name: "oguz berk acar", email: null, picture: null },
  threadId: "c_thread01",
  commentId: "c_thread01",
  text: "bence tekli row olsun kucuk kaldi",
  emoji: null,
  role: null,
  count: 1,
  state: null,
  createdAt: 0,
  updatedAt: 0,
  read: false,
  ...over,
});

describe("notifications (shared)", () => {
  it("words rows as Figma does", () => {
    expect(notificationAction(item({}))).toBe("Commented");
    expect(notificationAction(item({ count: 4 }))).toBe("4 comments");
    expect(notificationAction(item({ kind: "reaction" }))).toBe("Reacted");
    expect(notificationAction(item({ kind: "reaction", count: 2 }))).toBe("2 reactions");
    expect(notificationAction(item({ kind: "mention" }))).toBe("Mentioned you");
    expect(notificationAction(item({ kind: "edit-request" }))).toBe("Requested to edit");
    expect(desktopText(item({}))).toEqual({ title: "oguz berk acar", body: "Commented · Insider V3\nbence tekli row olsun kucuk kaldi" });
    expect(desktopText(item({ count: 4 })).body).toBe("4 comments · Insider V3");
  });

  it("dates rows like the capture", () => {
    const now = new Date(2026, 9, 11, 15, 0).getTime();
    expect(notificationDate(new Date(2026, 8, 21, 9).getTime(), now)).toBe("Sep 21");
    expect(notificationDate(new Date(2025, 7, 4).getTime(), now)).toBe("Aug 4, 2025");
    expect(notificationDate(new Date(2026, 9, 11, 9, 5).getTime(), now)).toBe("9:05 AM");
  });

  it("cleans preferences and decides the computer's", () => {
    expect(cleanPrefs(null)).toEqual(DEFAULT_NOTIFICATION_PREFS);
    const p = cleanPrefs({ desktop: { enabled: true, comments: "mentions" }, email: { invites: "response", userGroups: "x" }, productNews: false });
    expect(p).toMatchObject({ desktop: { comments: "mentions" }, email: { invites: "response", userGroups: "all", enabled: true }, productNews: false });
    expect(wantsDesktop(p, "comment")).toBe(false);
    expect(wantsDesktop(p, "reply")).toBe(true);
    expect(wantsDesktop(p, "edit-request")).toBe(true);
    expect(wantsDesktop({ ...p, desktop: { enabled: false, comments: "all" } }, "invite")).toBe(false);
    expect(wantsDesktop({ ...p, desktop: { enabled: true, comments: "none" } }, "mention")).toBe(false);
  });

  it("links a click to the file, at the thread", () => {
    const link = notificationLink(item({}))!;
    expect(link).toBe("designer://open?key=file_abc123#comment-c_thread01");
    expect(keyFromLink(link)).toBe("file_abc123");
    expect(intentFromLink(link)).toEqual({ commentId: "c_thread01" });
    expect(notificationLink(item({ kind: "invite", threadId: null }))).toBe("designer://open?key=file_abc123");
    expect(linkWith("https://x.dev/f/file_abc123", { commentId: "c_thread01" })).toBe("https://x.dev/f/file_abc123#comment-c_thread01");
  });
});

describe("round 5's kinds (docs/editor.md D-4, docs/plugins.md §10.3)", () => {
  it("Dev Mode statuses follow Settings › Notifications › Dev Mode; plugin rows always come", () => {
    expect(DEFAULT_NOTIFICATION_PREFS.devMode).toBe("status");
    expect(cleanPrefs({ devMode: "none" }).devMode).toBe("none");
    expect(cleanPrefs({ devMode: "x" }).devMode).toBe("status");
    const off = { ...DEFAULT_NOTIFICATION_PREFS, devMode: "none" as const };
    expect([wantsDesktop(off, "dev_ready"), wantsDesktop(off, "dev_changed"), wantsDesktop(off, "plugin_request"), wantsDesktop(DEFAULT_NOTIFICATION_PREFS, "dev_completed")]).toEqual([false, false, true, true]);
  });

  it("rows, desktop text and the link into Dev Mode's ready-for-dev view", () => {
    const n = item({ kind: "dev_changed", text: "Checkout\nNew totals", fileName: "Shop" });
    expect(notificationAction(n)).toBe("Marked Checkout as ready for dev after changes: New totals");
    expect(desktopText(n).body).toBe("Marked Checkout as ready for dev after changes: New totals · Shop");
    expect(notificationAction(item({ kind: "dev_completed", count: 3, text: "X" }))).toBe("Marked 3 designs as completed");
    expect(notificationAction(item({ kind: "plugin_request_answer", state: "denied", text: "Unsplash" }))).toBe("Declined your request for Unsplash");
    expect(notificationLink(item({ kind: "dev_ready", fileKey: "file_abc123" }))).toBe("designer://open?key=file_abc123&m=dev&dev=ready");
  });
});
