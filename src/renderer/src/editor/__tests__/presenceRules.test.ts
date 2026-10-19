import { describe, expect, it } from "vitest";
import { MULTIPLAYER_COLORS, avatarColorIndex, colorIndexOf, leastUsedColor, peerColor } from "@shared/multiplayer/colors";
import { FACES_UNMEASURED, maxFaces, shownFaces, sortFaces } from "../multiplayer/facepile";
import { CHAT_FADE_MS, CHAT_GONE_MS, chatOpacity, chatText } from "../multiplayer/presence";

describe("Figma's multiplayer numbers (atlas 19 §4, docs/multiplayer.md §18.5)", () => {
  it("seven colours with their dark shades, yellow's text near-black; a room's colour or one by session", () => {
    expect(MULTIPLAYER_COLORS.map((c) => c.light.base)).toEqual(["#667799", "#007be5", "#9747ff", "#ff24bd", "#f24822", "#ffcd29", "#14ae5c"]);
    expect(MULTIPLAYER_COLORS[1].dark.base).toBe("#0a6dc2");
    expect(MULTIPLAYER_COLORS[5].text).toBe("rgba(0, 0, 0, 0.9)");
    expect(peerColor(4, 2)).toBe("#9747ff");
    expect(peerColor(4, 2, "dark")).toBe("#8a38f5");
    expect(colorIndexOf(9)).toBe(1); // a room before Phase 6: (session − 1) mod 7
    expect(colorIndexOf(9, 99)).toBe(1);
    expect(leastUsedColor([0, 1, 2, 3, 4, 5, 6, 0])).toBe(1);
    expect(leastUsedColor([])).toBe(0);
  });

  it("an avatar's colour from the user id's last four digits mod 7, else a 31-hash", () => {
    expect(avatarColorIndex("user_1234")).toBe(1234 % 7);
    const h = avatarColorIndex("u_abcd");
    expect(h).toBeGreaterThanOrEqual(0);
    expect(h).toBeLessThan(7);
    expect(avatarColorIndex("u_abcd")).toBe(h);
  });

  it("the facepile: min(floor(width / 21) + 1, 8) others, 3 unmeasured; past the max, max − 1 and the count", () => {
    expect(maxFaces(null)).toBe(FACES_UNMEASURED);
    expect(maxFaces(0)).toBe(1);
    expect(maxFaces(63)).toBe(4);
    expect(maxFaces(500)).toBe(8);
    const five = [1, 2, 3, 4, 5];
    expect(shownFaces(five, 8)).toEqual(five);
    expect(shownFaces(five, 5)).toEqual([1, 2, 3, 4]);
    expect(shownFaces(five, 3)).toEqual([1, 2]);
  });

  it("the facepile's order: presenter, followed, creator, speaker, others by name, anonymous last", () => {
    const p = (id: number, name: string, extra: { anonymous?: boolean; owner?: boolean } = {}) => ({ id, name, ...extra });
    const people = [p(1, "zed"), p(2, "Anonymous", { anonymous: true }), p(3, "Amy"), p(4, "Owner", { owner: true }), p(5, "Speaker"), p(6, "Followed"), p(7, "Presenter"), p(8, "amy")];
    const order = sortFaces(people, { presenter: 7, following: 6, creator: (x) => !!x.owner, speaker: 5 }).map((x) => x.id);
    expect(order).toEqual([7, 6, 4, 5, 3, 8, 1, 2]);
  });

  it("cursor chat: two lines of 50 at most; a bubble fades from 5 s and is gone at 8 s", () => {
    expect(chatText("x".repeat(60))).toBe("x".repeat(50));
    expect(chatText("one\ntwo\nthree")).toBe("two\nthree");
    expect(chatOpacity(0)).toBe(1);
    expect(chatOpacity(CHAT_FADE_MS)).toBe(1);
    expect(chatOpacity((CHAT_FADE_MS + CHAT_GONE_MS) / 2)).toBeCloseTo(0.5);
    expect(chatOpacity(CHAT_GONE_MS)).toBe(0);
  });
});
