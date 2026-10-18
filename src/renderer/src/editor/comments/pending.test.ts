// Optimistic comments (atlas 16 §2.1, §2.3): a new comment or reply is shown before the store answers, marked pending;
// the store's answer replaces it, and a failure takes it away and gives the new comment back to its composer.
import { describe, expect, it, vi } from "vitest";
import type { CommentsState } from "@shared/comments";

const store = vi.hoisted(() => ({ add: null as null | ((...a: unknown[]) => Promise<unknown>) }));
vi.mock("@/store", () => ({ getStoreClient: () => ({ comments: { add: (...a: unknown[]) => store.add!(...a), list: async () => null } }) }));
vi.mock("@/ds", () => ({ showToast: () => {} }));
const { CommentsController, PENDING } = await import("./commentsController");

const me = { id: "u1", name: "Burak", email: "b@x", picture: null };
const anchor = { pageId: "0:1", x: 10, y: 20, nodeId: null, offset: null } as unknown as NonNullable<InstanceType<typeof CommentsController>["view"]["draft"]>;
const empty: CommentsState = { fileKey: "f", shared: false, me, canResolveAny: true, canDeleteAny: true, threads: [] };

function controller() {
  const c = new CommentsController({} as never, "f");
  (c as unknown as { set(p: object): void }).set({ data: empty, draft: anchor });
  return c;
}

describe("pending comments", () => {
  it("shows a new comment at once, then the store's", async () => {
    let answer!: (s: CommentsState) => void;
    store.add = () => new Promise<CommentsState>((r) => (answer = r));
    const c = controller();
    const posting = c.post("Hello");
    const shown = c.view.data!.threads;
    expect(shown).toHaveLength(1);
    expect(shown[0].id.startsWith(PENDING)).toBe(true);
    expect(shown[0].comments[0]).toMatchObject({ message: "Hello", pending: true, user: me });
    expect(c.view.draft).toBeNull();
    const saved = { ...empty, threads: [{ ...shown[0], id: "t1", number: 1, comments: [{ ...shown[0].comments[0], id: "t1", threadId: "t1", pending: undefined }] }] };
    answer(saved as CommentsState);
    expect(await posting).toBe(true);
    expect(c.view.data!.threads.map((t) => t.id)).toEqual(["t1"]);
  });

  it("a failed write takes the pending comment away and gives the draft back", async () => {
    store.add = () => Promise.reject(new Error("offline"));
    const c = controller();
    c.draftText = "Draft";
    expect(await c.post("Hello")).toBe(false);
    expect(c.view.data!.threads).toEqual([]);
    expect(c.view.draft).toEqual(anchor);
    expect(c.draftText).toBe("Draft");
  });

  it("shows a reply at once in its thread", async () => {
    store.add = () => new Promise(() => {});
    const c = controller();
    const thread = { id: "t1", number: 1, anchor, comments: [{ id: "t1", threadId: "t1", parentId: null, user: me, message: "Hi", mentions: [], createdAt: 1, editedAt: null, reactions: [] }], resolvedAt: null, resolvedBy: null, unread: false, readAt: 0 };
    (c as unknown as { set(p: object): void }).set({ data: { ...empty, threads: [thread] } });
    void c.reply("t1", "Answer");
    expect(c.view.data!.threads[0].comments.map((x) => [x.message, x.pending ?? false, x.parentId])).toEqual([
      ["Hi", false, null],
      ["Answer", true, "t1"],
    ]);
  });
});
