// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { urlIntent } from "../../editor/multiplayer/links";
import { notificationIntent } from "../../notifications/intent";
import { editorUrl } from "../desktop";

// Found running round 5 end to end (2026-10-12): in the browser, a Ready for dev notification opened the file in Dev
// Mode but not on the ready-for-dev view — the editor's address kept only `node-id` and `m`, so `devMode` (and a
// comment notification's thread) were lost between Home and the editor.
describe("the browser's editor address carries the whole open intent", () => {
  const roundTrip = (intent: Parameters<typeof editorUrl>[1]) => {
    const u = new URL(editorUrl("abc", intent), "http://127.0.0.1:5199");
    return urlIntent(u.search, u.hash);
  };
  it("a Dev Mode status notification lands on the ready-for-dev view", () => {
    expect(roundTrip(notificationIntent({ kind: "dev_ready", threadId: null }))).toEqual({ mode: "dev", devMode: "ready" });
  });
  it("a comment notification's thread, a frame and a mode", () => {
    expect(roundTrip({ commentId: "c_imFgd003oKp-8VRl" })).toEqual({ commentId: "c_imFgd003oKp-8VRl" });
    expect(roundTrip({ nodeId: "12:34", mode: "proto" })).toEqual({ nodeId: "12:34", mode: "proto" });
  });
  it("a plain file's address has no intent", () => {
    expect(roundTrip({})).toBeNull();
  });
});
