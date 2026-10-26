// @vitest-environment happy-dom
/**
 * The bell's invites and requests to join a team (docs/multiplayer.md §14.18): an invite to the org or a team waiting
 * for an answer has Decline / Accept, a request to join Decline / Approve; answered rows say how.
 */
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { $$, click, mount, type Mounted } from "@/ds/__tests__/dom";
import type { NotificationItem, NotificationPage } from "@shared/notifications";

const item = (over: Partial<NotificationItem>): NotificationItem => ({
  id: over.id ?? "n", kind: "comment", fileKey: null, fileName: "Acme", actor: { id: "u2", name: "Ada", email: null, picture: null }, threadId: null, commentId: null, text: null, emoji: null, role: null, count: 1, state: null,
  createdAt: Date.UTC(2026, 9, 1), updatedAt: Date.UTC(2026, 9, 1), read: false, ...over,
});
const items: NotificationItem[] = [
  item({ id: "org", kind: "org_invite", state: "pending" }),
  item({ id: "team", kind: "team_invite", fileName: "Design", role: "editor", state: "pending" }),
  item({ id: "join", kind: "team_join_request", fileName: "Design", state: "pending" }),
  item({ id: "done", kind: "team_invite", fileName: "Brand", role: "viewer", state: "approved" }),
  item({ id: "old", kind: "team_invite", fileName: "Web", role: "editor", state: null }),
];
const page: NotificationPage = { items, unread: 5, pending: 3, files: [], next: null };
const answers: [string, boolean][] = [];
vi.mock("@/store", () => ({
  getStoreClient: () => ({ notifications: { list: async () => page, watch: () => () => {}, markRead: async () => ({ unread: 0 }), answer: async (id: string, approve: boolean) => (answers.push([id, approve]), page) } }),
}));
const { NotificationsPopover } = await import("../NotificationsPopover");

let m: Mounted | null = null;
afterEach(() => {
  m?.unmount();
  m = null;
  document.body.innerHTML = "";
});
const settle = () => act(async () => new Promise((r) => setTimeout(r, 0)));

describe("invites in the bell", () => {
  it("Accept / Decline an invite, Approve / Decline a request to join; answered rows say how", async () => {
    const anchor = document.createElement("button");
    document.body.append(anchor);
    m = mount(NotificationsPopover, { anchor, onClose: () => {}, onOpen: () => {}, onOpenSettings: () => {} });
    await settle();
    const rows = $$('[role="listitem"]');
    expect(rows.map((r) => r.querySelector("[class*=action]")?.textContent)).toEqual([
      "Invited you to join the organization · Acme",
      "Invited you to a team · Design",
      "Asked to join the team · Design",
      "Invited you to view a team · Brand",
      "Invited you to a team · Web",
    ]);
    const buttons = (row: Element) => [...row.querySelectorAll("button")].map((b) => b.textContent);
    expect(buttons(rows[0])).toEqual(["Decline", "Accept"]);
    expect(buttons(rows[1])).toEqual(["Decline", "Accept"]);
    expect(buttons(rows[2])).toEqual(["Decline", "Approve"]);
    expect(buttons(rows[3])).toEqual([]);
    expect(rows[3].textContent).toContain("Accepted");
    expect(buttons(rows[4])).toEqual([]);
    click([...rows[0].querySelectorAll("button")].find((b) => b.textContent === "Accept")!);
    await settle();
    click([...rows[2].querySelectorAll("button")].find((b) => b.textContent === "Decline")!);
    await settle();
    expect(answers).toEqual([
      ["org", true],
      ["join", false],
    ]);
  });
});
