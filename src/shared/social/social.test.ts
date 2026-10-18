/**
 * Social's shared pieces (docs/social.md §3, §5): the catalogue as §5.2 lists it, the format lookups, characters
 * counted the platforms' ways (graphemes vs UTF-16, emoji, Turkish letters), hashtags, the caption report, and the
 * plugin-data helpers keeping other entries and surviving bad JSON.
 */
import { describe, expect, it } from "vitest";
import { captionCount, captionReport, parseHashtags, parseMentions, publishedText } from "./caption";
import { FIRST_PLATFORMS, SOCIAL_FORMATS, SOCIAL_SOURCES, brandFormatId, formatById, formatsFor, nearestFormat, parseBrandFormatId, resolveFormat } from "./formats";
import { SOCIAL_EXPORT_PRESETS } from "./presets";
import { SOCIAL_PLUGIN_ID, readSocial, withSocial, type SocialPostData } from "./types";

describe("the formats catalogue", () => {
  it("has §5.2's entries with their sizes and safe areas", () => {
    expect(SOCIAL_FORMATS.map((f) => f.id)).toEqual([
      "instagram.post", "instagram.square", "instagram.landscape", "instagram.carousel", "instagram.story", "instagram.reel",
      "linkedin.landscape", "linkedin.square", "linkedin.portrait", "linkedin.document", "linkedin.video", "linkedin.video-vertical",
      "facebook.post", "facebook.story", "x.image", "x.video", "tiktok.video", "tiktok.photo", "youtube.thumbnail", "youtube.short",
      "pinterest.pin", "pinterest.video",
    ]);
    const size = (id: string) => `${formatById(id)!.width}×${formatById(id)!.height}`;
    expect(size("instagram.post")).toBe("1080×1350");
    expect(size("instagram.landscape")).toBe("1080×566");
    expect(size("linkedin.landscape")).toBe("1200×628");
    expect(size("linkedin.square")).toBe("1200×1200");
    expect(size("pinterest.pin")).toBe("1000×1500");
    expect(formatById("instagram.story")!.safeArea).toEqual({ top: 269, right: 65, bottom: 672, left: 65 });
    expect(formatById("facebook.story")!.safeArea).toEqual({ top: 250, right: 0, bottom: 340, left: 0 });
    expect(formatById("instagram.post")!.caption).toMatchObject({ max: 2200, unit: "grapheme", fold: 125, hashtags: 30, mentions: 20 });
    expect(formatById("tiktok.video")!.caption.unit).toBe("utf16");
    expect(formatById("instagram.reel")!.video).toMatchObject({ minSec: 3, maxSec: 900, maxMB: 300, maxMbps: 25 });
    expect(formatById("instagram.carousel")!.items).toEqual({ min: 2, max: 10 });
  });

  it("names a source for every entry and marks what no official page confirms", () => {
    for (const f of SOCIAL_FORMATS) {
      expect(f.sources.length).toBeGreaterThan(0);
      for (const s of f.sources) expect(SOCIAL_SOURCES[s], `${f.id}: ${s}`).toBeDefined();
    }
    expect(formatById("instagram.post")!.unverified).toContain("caption.fold");
    expect(formatById("x.image")!.unverified).toEqual(expect.arrayContaining(["width", "height", "caption.max"]));
    expect(formatById("tiktok.video")!.unverified).toContain("safeArea");
  });

  it("puts Instagram and LinkedIn first (the proposed default), the rest in the catalogue", () => {
    expect(FIRST_PLATFORMS).toEqual(["instagram", "linkedin"]);
    expect(formatsFor("linkedin").every((f) => f.tier === "first")).toBe(true);
    expect(formatsFor("pinterest").every((f) => f.tier === "catalogue")).toBe(true);
  });

  it("finds a frame's format by size, then by aspect", () => {
    expect(nearestFormat(1080, 1350)?.id).toBe("instagram.post");
    expect(nearestFormat(1080, 1350, "linkedin")?.id).toBe("linkedin.portrait");
    expect(nearestFormat(540, 960)?.platform).toBeDefined();
    expect(nearestFormat(540, 960)!.aspect).toBe("9:16");
    expect(nearestFormat(1200, 627)?.id).toBe("linkedin.landscape");
    expect(nearestFormat(0, 100)).toBeNull();
  });

  it("names a brand's own size and resolves it from the brand", () => {
    const id = brandFormatId("b1", "post");
    expect(id).toBe("brand:b1:post");
    expect(parseBrandFormatId(id)).toEqual({ brandId: "b1", formatId: "post" });
    expect(parseBrandFormatId("instagram.post")).toBeNull();
    expect(formatById(id)).toBeNull();
    expect(resolveFormat(id, [{ id: "b1", formats: [{ id: "post", name: "Post", width: 1000, height: 1000 }] }])).toMatchObject({ width: 1000 });
    expect(resolveFormat("instagram.reel")).toMatchObject({ height: 1920 });
  });

  it("gives every first-platform format an export preset", () => {
    const covered = new Set(SOCIAL_EXPORT_PRESETS.flatMap((p) => p.formatIds));
    for (const f of SOCIAL_FORMATS.filter((x) => x.tier === "first")) expect(covered.has(f.id), f.id).toBe(true);
  });
});

describe("captions", () => {
  it("counts graphemes or UTF-16 units", () => {
    expect(captionCount("Merhaba", "grapheme")).toBe(7);
    // Turkish letters are one each either way.
    expect(captionCount("İğdır şükür", "grapheme")).toBe(11);
    expect(captionCount("İğdır şükür", "utf16")).toBe(11);
    // A family emoji is one grapheme, eleven UTF-16 units; a flag one grapheme, four units.
    expect(captionCount("👨‍👩‍👧‍👦", "grapheme")).toBe(1);
    expect(captionCount("👨‍👩‍👧‍👦", "utf16")).toBe(11);
    expect(captionCount("🇹🇷", "grapheme")).toBe(1);
    expect(captionCount("🇹🇷", "utf16")).toBe(4);
    // A decomposed "é" (e + combining accent) is one grapheme.
    expect(captionCount("é", "grapheme")).toBe(1);
  });

  it("reads hashtags in order, once, in any script", () => {
    expect(parseHashtags("Yeni ürün #LiqHumus #organik_tarım ve #Gübre #liqhumus")).toEqual(["LiqHumus", "organik_tarım", "Gübre"]);
    expect(parseHashtags("#İstanbul'da")).toEqual(["İstanbul"]);
    // Not a tag: numbers alone, inside a word, an HTML entity, a URL's fragment.
    expect(parseHashtags("#2024 a#b &#39; https://x.com/#top")).toEqual([]);
    expect(parseMentions("@partner.agro ve @Ali, @ali.")).toEqual(["partner.agro", "ali"]);
  });

  it("reports the published text against the format", () => {
    expect(publishedText("Merhaba", ["a", "b"])).toBe("Merhaba\n\n#a #b");
    const ig = formatById("instagram.post");
    const ok = captionReport("Merhaba", ["tarım"], ig);
    expect(ok).toMatchObject({ count: 15, max: 2200, fold: 125, over: false, hashtags: { count: 1, max: 30, over: false } });
    const long = captionReport("x".repeat(2201), [], ig);
    expect(long.over).toBe(true);
    const tags = captionReport("", Array.from({ length: 31 }, (_, i) => `t${i}`), ig);
    expect(tags.hashtags).toEqual({ count: 31, max: 30, over: true });
    // A story has no caption: nothing to check.
    expect(captionReport("x".repeat(5000), [], formatById("instagram.story")).over).toBe(false);
    expect(captionReport("x", [], null)).toMatchObject({ max: 0, over: false });
  });
});

describe("plugin data", () => {
  const post: SocialPostData = { v: 1, formatId: "instagram.post", brandId: null, productIds: [], campaignId: null, template: null, group: null, caption: "", hashtags: [], altText: "", status: "draft", problems: [], exportedAt: null };
  const other = { pluginID: "designer.workflow", key: "status", value: "done" };

  it("writes our entry and keeps the others", () => {
    const entries = withSocial([other], "post", post);
    expect(entries).toEqual([other, { pluginID: SOCIAL_PLUGIN_ID, key: "post", value: JSON.stringify(post) }]);
    expect(readSocial<SocialPostData>(entries, "post")).toEqual(post);
    // Replaced, not added twice; removed with null.
    const again = withSocial(entries, "post", { ...post, caption: "a" });
    expect(again.filter((e) => e.pluginID === SOCIAL_PLUGIN_ID)).toHaveLength(1);
    expect(withSocial(again, "post", null)).toEqual([other]);
  });

  it("reads bad JSON or a missing entry as null", () => {
    expect(readSocial([{ pluginID: SOCIAL_PLUGIN_ID, key: "post", value: "{not json" }], "post")).toBeNull();
    expect(readSocial([other], "post")).toBeNull();
    expect(readSocial(undefined, "campaigns")).toBeNull();
  });
});
