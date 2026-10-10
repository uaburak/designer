import { describe, expect, it } from "vitest";
import { buildThreads, mentionsIn, type Comment } from "@shared/comments";
import { listedThreads, type CommentsView } from "./commentsController";

const user = (id: string) => ({ id, name: id === "me" ? "Me" : `User ${id}` });
const comment = (id: string, by: string, at: number, threadId = id, message = `text ${id}`): Comment => ({
  id,
  threadId,
  parentId: threadId === id ? null : threadId,
  user: user(by),
  message,
  mentions: [],
  createdAt: at,
  editedAt: null,
  reactions: [],
});

describe("comment threads", () => {
  it("groups replies under their thread, numbers and unread from read marks", () => {
    const threads = buildThreads(
      [
        { comment: comment("b", "x", 30), number: 2, anchor: { pageId: "0:2", x: 0, y: 0 } },
        { comment: comment("a", "me", 10), number: 1, anchor: { pageId: "0:1", x: 1, y: 2 } },
        { comment: comment("r2", "x", 25, "a") },
        { comment: comment("r1", "me", 20, "a") },
      ],
      { a: 21 },
      "me",
    );
    expect(threads.map((t) => t.number)).toEqual([1, 2]);
    expect(threads[0].comments.map((c) => c.id)).toEqual(["a", "r1", "r2"]);
    expect(threads.map((t) => t.unread)).toEqual([true, true]);
    expect(buildThreads([{ comment: comment("a", "x", 10) }], { a: 10 }, "me")[0].unread).toBe(false);
  });

  it("finds @mentions of people with access, the longest name first", () => {
    const people = [
      { id: "1", name: "Bob", email: "bob@x.co" },
      { id: "2", name: "Bob Builder", email: "bb@x.co" },
      { id: "3", name: "Alice", email: "a@x.co" },
    ];
    expect(mentionsIn("Hey @bob builder and @Alice", people)).toEqual(["2", "3"]);
    expect(mentionsIn("no one", people)).toEqual([]);
  });

  it("lists as the Sort/Filter menu says", () => {
    const threads = buildThreads(
      [
        { comment: comment("a", "me", 10), number: 1, anchor: { pageId: "0:1", x: 0, y: 0 } },
        { comment: comment("b", "x", 30, "b", "find me"), number: 2, anchor: { pageId: "0:2", x: 0, y: 0 } },
        { comment: comment("c", "x", 20), number: 3, anchor: { pageId: "0:1", x: 0, y: 0 }, resolvedAt: 40 },
      ],
      { b: 31 },
      "me",
    );
    const v: CommentsView = {
      data: { fileKey: "f", shared: false, me: user("me"), canResolveAny: true, canDeleteAny: true, threads },
      draft: null,
      open: null,
      search: "",
      sort: "date",
      showResolved: false,
      onlyMine: false,
      onlyPage: false,
      notifications: "everything",
      people: [],
    };
    const ids = (patch: Partial<CommentsView>) => listedThreads({ ...v, ...patch }, "0:1").map((t) => t.id);
    expect(ids({})).toEqual(["b", "a"]);
    expect(ids({ showResolved: true })).toEqual(["b", "c", "a"]);
    expect(ids({ onlyMine: true })).toEqual(["a"]);
    expect(ids({ onlyPage: true })).toEqual(["a"]);
    expect(ids({ search: "FIND" })).toEqual(["b"]);
    expect(ids({ sort: "unread", showResolved: true })).toEqual(["c", "b", "a"]);
  });
});
