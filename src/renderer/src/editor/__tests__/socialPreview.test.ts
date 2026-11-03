// @vitest-environment happy-dom
// A Social file's Prototype tab (docs/social.md §33): which posts are stories, the profile's feed and story rings from
// the board (a carousel's first slide only, rings by campaign, the posts without one as "Stories"), the caption as it
// would be posted, and the panel's width from its height at 9:16.
import { describe, expect, it } from "vitest";
import type { SocialPostData } from "@shared/social/types";
import { captionText, isStory, postDate, profileOf } from "../social/SocialPreview";
import { normalizePost } from "../social/posts";
import { handleOf } from "../social/BrandProfile";
import { pageBrandIn } from "../social/posts";
import { SOCIAL_PLUGIN_ID } from "@shared/social/types";
import { SOCIAL_RIGHT_PANEL, previewWidth } from "../social/SocialRightPanel";
import type { PostRow, SocialBoard } from "../social/socialState";

const data = (patch: Partial<SocialPostData> = {}): SocialPostData => ({
  v: 1,
  formatId: "instagram.post",
  brandId: null,
  productIds: [],
  campaignId: null,
  template: null,
  group: null,
  caption: "",
  hashtags: [],
  altText: "",
  status: "draft",
  problems: [],
  exportedAt: null,
  ...patch,
});

const row = (id: string, patch: Partial<SocialPostData> = {}, size = { width: 1080, height: 1350 }): PostRow => ({
  id,
  name: id,
  data: data(patch),
  campaignId: patch.campaignId ?? null,
  x: 0,
  y: 0,
  ...size,
  animated: false,
  duplicateOf: null,
});

describe("Prototype tab (docs/social.md §33)", () => {
  it("tells stories by format, a brand's own size by being 9:16 or taller", () => {
    expect(isStory(row("s", { formatId: "instagram.story" }, { width: 1080, height: 1920 }))).toBe(true);
    expect(isStory(row("r", { formatId: "instagram.reel" }, { width: 1080, height: 1920 }))).toBe(false);
    expect(isStory(row("p"))).toBe(false);
    expect(isStory(row("b", { formatId: "brand:x:tall" }, { width: 900, height: 1600 }))).toBe(true);
    expect(isStory(row("w", { formatId: "brand:x:wide" }, { width: 1600, height: 900 }))).toBe(false);
  });

  it("builds the feed (first slides) and the rings (by campaign, then Stories) from the board", () => {
    const camp = { id: "c1", name: "Kasım", brandId: null, created: 0 };
    const story = { formatId: "instagram.story" };
    const tall = { width: 1080, height: 1920 };
    const a = row("a", { campaignId: "c1", status: "approved" });
    const s1 = row("s1", { ...story, campaignId: "c1" }, tall);
    const c0 = row("c0", { group: { id: "g", index: 0 } });
    const c1 = row("c1x", { group: { id: "g", index: 1 } });
    const s2 = row("s2", story, tall);
    const board: SocialBoard = {
      page: "0:1",
      campaigns: [camp],
      groups: [
        { campaign: camp, posts: [a, s1] },
        { campaign: null, posts: [c0, c1, s2] },
      ],
      posts: [a, s1, c0, c1, s2],
      others: null,
      brandId: null,
    };
    const p = profileOf(board);
    expect(p.feed.map((x) => x.id)).toEqual(["a", "c0"]);
    expect(p.rings.map((r) => [r.id, r.name, r.stories.map((x) => x.id)])).toEqual([
      ["c1", "Kasım", ["s1"]],
      ["none", "Stories", ["s2"]],
    ]);
    expect(p.approved).toBe(1);
  });

  it("copies the caption with its hashtags as posted", () => {
    expect(captionText(row("x", { caption: " Bol çiçek ", hashtags: ["stoller", "tarım"] }))).toBe("Bol çiçek\n\n#stoller #tarım");
    expect(captionText(row("y", { hashtags: ["a"] }))).toBe("#a");
  });

  it("sizes the panel at 9:16 of its body's height, never under the panel's minimum", () => {
    expect(previewWidth(1920)).toBe(1080);
    expect(previewWidth(777)).toBe(437);
    expect(previewWidth(100)).toBe(SOCIAL_RIGHT_PANEL.minWidth);
  });

  it("reads a page's brand off its record, and the handle off the brand's name (§34)", () => {
    expect(pageBrandIn([{ pluginID: SOCIAL_PLUGIN_ID, key: "brand", value: JSON.stringify({ brandId: "2GD2dlwHqVuH" }) }])).toBe("2GD2dlwHqVuH");
    expect(pageBrandIn([{ pluginID: SOCIAL_PLUGIN_ID, key: "brand", value: "{}" }])).toBeNull();
    expect(pageBrandIn(undefined)).toBeNull();
    expect(handleOf("MTM Agro")).toBe("mtmagro");
    expect(handleOf("İyi Tarım")).toBe("iyitarım");
    expect(handleOf("  ")).toBe("brand");
  });

  it("badges a post with when it went out, else when it is planned (§35)", () => {
    expect(postDate(row("a", { scheduledAt: 1, publishedAt: 2 }))).toEqual({ kind: "published", at: 2 });
    expect(postDate(row("b", { scheduledAt: 1 }))).toEqual({ kind: "scheduled", at: 1 });
    expect(postDate(row("c"))).toEqual({ kind: "none", at: null });
    expect(postDate(row("d", { status: "posted" }))).toEqual({ kind: "published", at: null });
    expect(normalizePost({ formatId: "instagram.post", scheduledAt: 5, publishedAt: "x" })).toMatchObject({ scheduledAt: 5, publishedAt: null });
  });
});
