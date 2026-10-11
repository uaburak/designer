// @vitest-environment happy-dom
/**
 * The bell's rows for round 5's kinds (docs/editor.md D-4, docs/plugins.md §10.3): Dev Mode statuses ("Marked … as
 * ready for dev", folded counts, the reason) with Inspect in Dev Mode opening the ready-for-dev view, plugin requests
 * and their answers; where a row opens its file (`notificationIntent`).
 */
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { $$, click, mount, type Mounted } from "@/ds/__tests__/dom";
import type { NotificationItem, NotificationPage } from "@shared/notifications";

const item = (over: Partial<NotificationItem>): NotificationItem => ({
  id: over.id ?? "n", kind: "comment", fileKey: null, fileName: "Shop", actor: { id: "u2", name: "Ada", email: null, picture: null }, threadId: null, commentId: null, text: null, emoji: null, role: null, count: 1, state: null,
  createdAt: Date.UTC(2026, 9, 1), updatedAt: Date.UTC(2026, 9, 1), read: false, ...over,
});
const items: NotificationItem[] = [
  item({ id: "a", kind: "dev_ready", fileKey: "k1", text: "Checkout" }),
  item({ id: "b", kind: "dev_completed", fileKey: "k1", text: "Cart", count: 3 }),
  item({ id: "c", kind: "dev_changed", fileKey: "k1", text: "Checkout\nNew totals" }),
  item({ id: "d", kind: "plugin_request", fileName: "Studio", text: "Stark", state: "pending" }),
  item({ id: "e", kind: "plugin_request_answer", fileName: "Studio", text: "Stark", state: "denied" }),
];
const page: NotificationPage = { items, unread: 5, pending: 1, files: [], next: null };
vi.mock("@/store", () => ({
  getStoreClient: () => ({ notifications: { list: async () => page, watch: () => () => {}, markRead: async () => ({ unread: 0 }), answer: async () => page } }),
}));
const { NotificationsPopover } = await import("../NotificationsPopover");
const { notificationIntent } = await import("../intent");

let m: Mounted | null = null;
afterEach(() => {
  m?.unmount();
  m = null;
  document.body.innerHTML = "";
});
const settle = () => act(async () => new Promise((r) => setTimeout(r, 0)));

describe("round 5's notification rows", () => {
  it("Dev Mode statuses and plugin requests in Figma's words; Inspect in Dev Mode opens the file", async () => {
    const anchor = document.createElement("button");
    document.body.append(anchor);
    const opened: string[] = [];
    m = mount(NotificationsPopover, { anchor, onClose: () => {}, onOpen: (n: NotificationItem) => opened.push(n.id), onOpenSettings: () => {} });
    await settle();
    const rows = $$('[role="listitem"]');
    expect(rows.map((r) => r.querySelector("[class*=action]")?.textContent)).toEqual([
      "Marked Checkout as ready for dev · Shop",
      "Marked 3 designs as completed · Shop",
      "Marked Checkout as ready for dev after changes: New totals · Shop",
      "Requested approval for Stark · Studio",
      "Declined your request for Stark · Studio",
    ]);
    expect(rows[3].textContent).toContain("Review it in Admin › Resources");
    click($$("[data-notification='inspect']")[0]);
    await settle();
    expect(opened).toEqual(["a"]);
  });

  it("where a row opens: Dev Mode's ready-for-dev view, a comment's thread, else the file", () => {
    expect(notificationIntent(item({ kind: "dev_changed" }))).toEqual({ mode: "dev", devMode: "ready" });
    expect(notificationIntent(item({ kind: "reply", threadId: "thread-1" }))).toEqual({ commentId: "thread-1" });
    expect(notificationIntent(item({ kind: "invite", threadId: "x" }))).toEqual({});
  });
});
