import { describe, expect, it } from "vitest";
import { buildThreads, checkAttachments, commentLength, mentionsIn, type Comment } from "@shared/comments";
import { clusterClickZoom, clusterPeople, clusterPins, mergeDistance, pinAvatars, pinTabOrder, pinWidth, threadPeople } from "./clusters";
import { formatCommentTime, listedThreads, pinShownAt, timedThreads, type CommentsView } from "./commentsController";

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

  it("keeps Motion's time (docs/motion.md §6.8): ruler markers for the page, pins near the playhead, the card's 0:01.250", () => {
    const threads = buildThreads(
      [
        { comment: comment("a", "me", 10), number: 1, anchor: { pageId: "0:1", x: 0, y: 0, timeMs: 1250 } },
        { comment: comment("b", "x", 20), number: 2, anchor: { pageId: "0:1", x: 0, y: 0 } },
        { comment: comment("c", "x", 30), number: 3, anchor: { pageId: "0:2", x: 0, y: 0, timeMs: 0 } },
        { comment: comment("d", "x", 40), number: 4, anchor: { pageId: "0:1", x: 0, y: 0, timeMs: 61_005 }, resolvedAt: 50 },
      ],
      {},
      "me",
    );
    const v = { data: { fileKey: "f", shared: false, me: user("me"), canResolveAny: true, canDeleteAny: true, threads }, showResolved: false } as CommentsView;
    expect(timedThreads(v, "0:1")).toEqual([{ id: "a", number: 1, timeMs: 1250 }]);
    expect(timedThreads({ ...v, showResolved: true }, "0:1").map((x) => x.id)).toEqual(["a", "d"]);
    const a = threads[0].anchor;
    expect([pinShownAt(a, false, 0), pinShownAt(a, true, 1000), pinShownAt(a, true, 1500), pinShownAt(a, true, 1501)]).toEqual([true, true, true, false]);
    expect(pinShownAt(threads[1].anchor, true, 9999)).toBe(true);
    expect([formatCommentTime(1250), formatCommentTime(61_005), formatCommentTime(0)]).toEqual(["0:01.250", "1:01.005", "0:00.000"]);
  });

  it("sorts by the first comment's time, or by the last reply's (Sort by last action), and finds threads mentioning you", () => {
    const mention = { ...comment("r", "x", 50, "a", "@Me look"), mentions: ["me"] };
    const threads = buildThreads(
      [
        { comment: comment("a", "x", 10), number: 1, anchor: { pageId: "0:1", x: 0, y: 0 } },
        { comment: mention },
        { comment: comment("b", "x", 30), number: 2, anchor: { pageId: "0:1", x: 0, y: 0 } },
      ],
      { a: 99, b: 99 },
      "me",
    );
    const v: CommentsView = {
      data: { fileKey: "f", shared: true, me: user("me"), canResolveAny: true, canDeleteAny: true, threads },
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
    expect(ids({ sort: "recent" })).toEqual(["a", "b"]);
    expect(ids({ onlyMine: true })).toEqual(["a"]);
  });

  it("checks files by Figma's upload rules: type, duplicates, 30 / 100 MB, 5 in all", () => {
    const f = (name: string, type: string, size = 10, lastModified = 1) => ({ name, type, size, lastModified });
    const attached = [f("a.png", "image/png"), f("b.png", "image/png"), f("c.png", "image/png")];
    const r = checkAttachments(attached, [
      f("x.tiff", "image/tiff"),
      f("a.png", "image/png"),
      f("big.png", "image/png", 30_000_001),
      f("big.mp4", "video/mp4", 100_000_001),
      f("ok.mp4", "video/mp4", 100_000_000),
      f("ok.gif", "image/gif"),
      f("sixth.jpg", "image/jpeg"),
    ]);
    expect(r.ok.map((x) => x.name)).toEqual(["ok.mp4", "ok.gif"]);
    expect(r.errors).toEqual([
      { error: "INVALID_FILE_TYPE", names: ["x.tiff"] },
      { error: "DUPLICATE_FILE_UPLOAD", names: ["a.png"] },
      { error: "MAX_IMAGE_SIZE_EXCEEDED", names: ["big.png"] },
      { error: "MAX_VIDEO_SIZE_EXCEEDED", names: ["big.mp4"] },
      { error: "MAX_UPLOADS_EXCEEDED", names: ["sixth.jpg"] },
    ]);
  });

  it("counts a message's length in graphemes, trailing whitespace left out", () => {
    expect(commentLength("hi  \n")).toBe(2);
    expect(commentLength("👍🏽👨‍👩‍👧")).toBe(2);
  });
});

describe("comment pins", () => {
  const thread = (id: string, number: number, people: string[], unread = false) => ({
    ...buildThreads(
      people.map((p, i) => ({ comment: comment(i ? `${id}${i}` : id, p, i, id), number, anchor: { pageId: "0:1", x: 0, y: 0 } })),
      {},
      "me",
    )[0],
    unread,
  });

  it("are as wide as their faces: 32, 55, 78; past three, two faces and +N", () => {
    expect([1, 2, 3, 4].map(pinWidth)).toEqual([32, 55, 78, 78]);
    const t = thread("a", 1, ["x", "y", "x", "z", "w"]);
    expect(threadPeople(t).map((u) => u.id)).toEqual(["x", "y", "z", "w"]);
    expect(pinAvatars(threadPeople(t))).toMatchObject({ more: 2 });
    expect(pinAvatars(threadPeople(t)).shown.map((u) => u.id)).toEqual(["x", "y"]);
  });

  it("merge within 78 px, more below 76 % zoom, at the thread-weighted mean; the open one stays alone", () => {
    expect(mergeDistance(1)).toBe(78);
    expect(mergeDistance(0.25)).toBe(Math.ceil(78 + 0.51 * 64));
    const a = thread("a", 1, ["x"]);
    const b = thread("b", 2, ["y"], true);
    const c = thread("c", 3, ["x"]);
    const far = thread("d", 4, ["z"]);
    const out = clusterPins(
      [
        { thread: a, x: 0, y: 0 },
        { thread: b, x: 60, y: 0 },
        { thread: c, x: 30, y: 30 },
        { thread: far, x: 400, y: 0 },
      ],
      1,
    );
    expect(out.map((cl) => cl.threads.map((t) => t.id))).toEqual([["a", "b", "c"], ["d"]]);
    expect(out[0]).toMatchObject({ x: 30, y: 10, id: "0,0,3" });
    expect(clusterPeople(out[0].threads).map((p) => [p.user.id, p.unread])).toEqual([["x", 0], ["y", 1]]);
    expect(clusterPins([{ thread: a, x: 0, y: 0 }, { thread: b, x: 10, y: 0 }], 1, "a")).toHaveLength(2);
  });

  it("zoom in on a click: the farthest pin within 35 % of the larger side, ≥ 1.5 × the zoom, ≤ 1.26", () => {
    expect(clusterClickZoom(100, 0.1, { width: 1000, height: 600 })).toBeCloseTo(1.26);
    expect(clusterClickZoom(1000, 0.1, { width: 1000, height: 600 })).toBeCloseTo(0.35);
    expect(clusterClickZoom(10000, 0.1, { width: 1000, height: 600 })).toBeCloseTo(0.15);
  });

  it("Tab through them from the top-left, nearest next", () => {
    const order = pinTabOrder([
      { id: "far", x: 500, y: 500 },
      { id: "near", x: 60, y: 10 },
      { id: "first", x: 0, y: 0 },
      { id: "mid", x: 200, y: 200 },
    ]);
    expect(order.map((p) => p.id)).toEqual(["first", "near", "mid", "far"]);
  });
});
