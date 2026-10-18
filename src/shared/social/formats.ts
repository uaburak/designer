/**
 * Social's formats catalogue (docs/social.md §5): every platform format a post can be, with what the platform's UI
 * covers (the safe area), its caption, image and video limits, and the pages that confirm them (SOCIAL_SOURCES,
 * accessed 2026-10-18). A field no official page confirms is named in its entry's `unverified`. Safe areas are px at
 * the format's size (Meta's percentages rounded); Meta states its safe zones for ads, and no platform publishes organic
 * ones — they are applied to organic posts [ours]. A brand's own sizes stay `Brand.formats` (Studio's); a post names
 * one as "brand:<brandId>:<formatId>" (brandFormatId), without limits.
 */
import type { SocialFormat } from "../studio/types";
import type { CaptionLimits, ImageLimits, Insets, Platform, PlatformFormat, VideoLimits } from "./types";

/**
 * The platforms first in line (docs/social.md §12.2 — the proposed default, pending the owner's confirmation): their
 * formats get starter templates, export presets and the review's limit checks; the others are catalogue entries (New
 * post, safe areas and limits work). The one place to change it.
 */
export const FIRST_PLATFORMS: readonly Platform[] = ["instagram", "linkedin"];

/** Every platform, in the New post menu's order. */
export const PLATFORMS: readonly Platform[] = ["instagram", "linkedin", "facebook", "x", "tiktok", "youtube", "pinterest"];

/** The platforms' own names (not translated). */
export const PLATFORM_NAMES: Record<Platform, string> = {
  instagram: "Instagram",
  linkedin: "LinkedIn",
  facebook: "Facebook",
  x: "X",
  tiktok: "TikTok",
  youtube: "YouTube",
  pinterest: "Pinterest",
};

/** Where each limit comes from (§5.3, accessed 2026-10-18): key → the page and what it confirms. */
export const SOCIAL_SOURCES: Record<string, { url: string; confirms: string }> = {
  "ig-api-media": { url: "https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user/media", confirms: "IG image JPEG ≤ 8 MB, width 320–1440, 4:5 … 1.91:1, sRGB; Reels MOV/MP4, HEVC/H.264, AAC ≤ 48 kHz, 23–60 fps, ≤ 1920 wide, 3 s–15 min, ≤ 300 MB, ≤ 25 Mbps; Story video 3–60 s, ≤ 100 MB; carousel ≤ 10; caption 2 200, 30 hashtags, 20 mentions" },
  "meta-reels-image": { url: "https://www.facebook.com/business/ads-guide/update/image/instagram-reels", confirms: "Reels 9:16, 1440 × 2560, safe zone ~14 % top, ~35 % bottom, ~6 % sides" },
  "meta-ig-story-video": { url: "https://en-gb.facebook.com/business/ads-guide/update/video/instagram-story", confirms: "IG Stories 9:16, 14 % / 35 % / 6 %" },
  "meta-fb-story-video": { url: "https://www.facebook.com/business/ads-guide/update/video/facebook-story", confirms: "FB Stories 9:16, 1 s–3 min, ≤ 4 GB, ~14 % (250 px) top, ~20 % (340 px) bottom" },
  "meta-fb-feed-image": { url: "https://www.facebook.com/business/ads-guide/update/image", confirms: "FB feed 4:5, 1440 × 1800, JPG / PNG ≤ 30 MB" },
  "li-video": { url: "https://www.linkedin.com/help/linkedin/answer/a548372", confirms: "LinkedIn video 75 KB–5 GB, 3 s–15 min, 256 × 144–4096 × 2304, 1:2.4–2.4:1, 10–60 fps, 192 kbps–30 Mbps, formats" },
  "li-image-ads": { url: "https://www.linkedin.com/help/lms/answer/a426534", confirms: "1200 × 628, 1200 × 1200, 720 × 900 (4:5), ≤ 7680 × 4320, JPG / PNG / GIF ≤ 5 MB; 150 characters before truncation, 3 000 max" },
  "li-document": { url: "https://www.linkedin.com/help/linkedin/answer/97459", confirms: "documents ≤ 100 MB, ≤ 300 pages, PPT / PPTX / DOC / DOCX / PDF" },
  "li-post": { url: "https://www.linkedin.com/help/linkedin/answer/a528176", confirms: "posts ≤ 3 000 characters" },
  "x-media": { url: "https://docs.x.com/x-api/media/quickstart/best-practices", confirms: "images ≤ 5 MB, GIF limits, video limits" },
  "tt-media": { url: "https://developers.tiktok.com/doc/content-posting-api-media-transfer-guide", confirms: "TikTok video and photo restrictions" },
  "tt-video-post": { url: "https://developers.tiktok.com/doc/content-posting-api-reference-direct-post", confirms: "caption ≤ 2 200 UTF-16 runes" },
  "tt-photo-post": { url: "https://developers.tiktok.com/doc/content-posting-api-reference-photo-post", confirms: "photo title 90, description 4 000, ≤ 35 photos" },
  "yt-thumbnail": { url: "https://support.google.com/youtube/answer/72431", confirms: "thumbnails 3840 × 2160 recommended, min 640 wide, 16:9, JPG / PNG, 2 MB mobile / 50 MB desktop" },
  "yt-shorts": { url: "https://support.google.com/youtube/answer/15424877", confirms: "Shorts up to 3 minutes, square or vertical" },
  "yt-hashtags": { url: "https://support.google.com/youtube/answer/6390658", confirms: "> 60 hashtags: all ignored; 3 shown by the title" },
  "yt-title": { url: "https://support.google.com/youtube/answer/57407", confirms: "title 100, description 5 000" },
  "pin-specs": { url: "https://help.pinterest.com/en/business/article/pinterest-product-specs", confirms: "2:3, 1000 × 1500, ≤ 20 MB; video 4 s–15 min, ≤ 2 GB, H.264 / H.265; title 100 (40 shown), description 800" },
};

const NONE: Insets = { top: 0, right: 0, bottom: 0, left: 0 };
/** Meta's Reels / Stories safe zone at 1080 × 1920 (~14 % top, ~35 % bottom, ~6 % sides) */
const REELS_ZONE: Insets = { top: 269, right: 65, bottom: 672, left: 65 };

const IG_CAPTION: CaptionLimits = { max: 2200, unit: "grapheme", fold: 125, hashtags: 30, mentions: 20 };
const NO_CAPTION: CaptionLimits = { max: 0, unit: "grapheme" };
const LI_CAPTION: CaptionLimits = { max: 3000, unit: "grapheme", fold: 150 };
const X_CAPTION: CaptionLimits = { max: 280, unit: "grapheme" };
const YT_CAPTION: CaptionLimits = { max: 5000, unit: "grapheme", title: 100, hashtags: 60 };
const PIN_CAPTION: CaptionLimits = { max: 800, unit: "grapheme", title: 100 };

const IG_IMAGE: ImageLimits = { maxMB: 8, types: ["jpeg"] };
const IG_REEL_VIDEO: VideoLimits = { minSec: 3, maxSec: 900, fps: [23, 60], codecs: ["h264", "hevc"], containers: ["mp4", "mov"], maxMB: 300, maxMbps: 25 };
const LI_IMAGE: ImageLimits = { maxMB: 5, types: ["jpeg", "png", "gif"] };
const LI_VIDEO: VideoLimits = { minSec: 3, maxSec: 900, fps: [10, 60], codecs: ["h264", "hevc", "vp8", "vp9"], containers: ["mp4", "mov", "webm"], maxMB: 5120, maxMbps: 30 };
const IG_UNVERIFIED = ["caption.fold"];
const LI_UNVERIFIED = ["caption.fold", "caption.hashtags"];

type Entry = Omit<PlatformFormat, "tier">;

const ENTRIES: Entry[] = [
  // Instagram
  { id: "instagram.post", name: "Instagram post", width: 1080, height: 1350, platform: "instagram", kind: "image", aspect: "4:5", safeArea: NONE, caption: IG_CAPTION, image: IG_IMAGE, sources: ["ig-api-media"], unverified: IG_UNVERIFIED },
  { id: "instagram.square", name: "Instagram square", width: 1080, height: 1080, platform: "instagram", kind: "image", aspect: "1:1", safeArea: NONE, caption: IG_CAPTION, image: IG_IMAGE, sources: ["ig-api-media"], unverified: IG_UNVERIFIED },
  { id: "instagram.landscape", name: "Instagram landscape", width: 1080, height: 566, platform: "instagram", kind: "image", aspect: "1.91:1", safeArea: NONE, caption: IG_CAPTION, image: IG_IMAGE, sources: ["ig-api-media"], unverified: IG_UNVERIFIED },
  // One caption for the set; slides may be videos (Reel limits).
  { id: "instagram.carousel", name: "Instagram carousel", width: 1080, height: 1350, platform: "instagram", kind: "carousel", aspect: "4:5", safeArea: NONE, caption: IG_CAPTION, image: IG_IMAGE, video: IG_REEL_VIDEO, items: { min: 2, max: 10 }, sources: ["ig-api-media"], unverified: IG_UNVERIFIED },
  // A story is a picture or a video (kind "image", with its video limits); no caption.
  {
    id: "instagram.story",
    name: "Instagram story",
    width: 1080,
    height: 1920,
    platform: "instagram",
    kind: "image",
    aspect: "9:16",
    safeArea: REELS_ZONE,
    caption: NO_CAPTION,
    image: IG_IMAGE,
    video: { minSec: 3, maxSec: 60, fps: [23, 60], codecs: ["h264", "hevc"], containers: ["mp4", "mov"], maxMB: 100, maxMbps: 25 },
    sources: ["ig-api-media", "meta-ig-story-video"],
    unverified: [],
  },
  { id: "instagram.reel", name: "Instagram reel", width: 1080, height: 1920, platform: "instagram", kind: "video", aspect: "9:16", safeArea: REELS_ZONE, caption: IG_CAPTION, video: IG_REEL_VIDEO, sources: ["ig-api-media", "meta-reels-image"], unverified: IG_UNVERIFIED },
  // LinkedIn (sizes: LinkedIn's recommended pixels; the portrait is 1.5× its 720 × 900 [ours])
  { id: "linkedin.landscape", name: "LinkedIn landscape", width: 1200, height: 628, platform: "linkedin", kind: "image", aspect: "1.91:1", safeArea: NONE, caption: LI_CAPTION, image: LI_IMAGE, sources: ["li-image-ads", "li-post"], unverified: LI_UNVERIFIED },
  { id: "linkedin.square", name: "LinkedIn square", width: 1200, height: 1200, platform: "linkedin", kind: "image", aspect: "1:1", safeArea: NONE, caption: LI_CAPTION, image: LI_IMAGE, sources: ["li-image-ads", "li-post"], unverified: LI_UNVERIFIED },
  { id: "linkedin.portrait", name: "LinkedIn portrait", width: 1080, height: 1350, platform: "linkedin", kind: "image", aspect: "4:5", safeArea: NONE, caption: LI_CAPTION, image: LI_IMAGE, sources: ["li-image-ads", "li-post"], unverified: LI_UNVERIFIED },
  // A PDF ≤ 100 MB, ≤ 300 pages (the export preset checks the file).
  { id: "linkedin.document", name: "LinkedIn document", width: 1080, height: 1350, platform: "linkedin", kind: "document", aspect: "4:5", safeArea: NONE, caption: LI_CAPTION, items: { min: 1, max: 300 }, sources: ["li-document", "li-post"], unverified: LI_UNVERIFIED },
  { id: "linkedin.video", name: "LinkedIn video", width: 1080, height: 1350, platform: "linkedin", kind: "video", aspect: "4:5", safeArea: NONE, caption: LI_CAPTION, video: LI_VIDEO, sources: ["li-video", "li-post"], unverified: LI_UNVERIFIED },
  { id: "linkedin.video-vertical", name: "LinkedIn vertical video", width: 1080, height: 1920, platform: "linkedin", kind: "video", aspect: "9:16", safeArea: NONE, caption: LI_CAPTION, video: LI_VIDEO, sources: ["li-video", "li-post"], unverified: [...LI_UNVERIFIED, "safeArea"] },
  // Facebook (Meta's feed ad spec says 1440 × 1800; ours is the 4:5 at 1080)
  { id: "facebook.post", name: "Facebook post", width: 1080, height: 1350, platform: "facebook", kind: "image", aspect: "4:5", safeArea: NONE, caption: NO_CAPTION, image: { maxMB: 30, types: ["jpeg", "png"] }, sources: ["meta-fb-feed-image"], unverified: ["caption"] },
  {
    id: "facebook.story",
    name: "Facebook story",
    width: 1080,
    height: 1920,
    platform: "facebook",
    kind: "image",
    aspect: "9:16",
    safeArea: { top: 250, right: 0, bottom: 340, left: 0 },
    caption: NO_CAPTION,
    image: { maxMB: 30, types: ["jpeg", "png"] },
    video: { minSec: 1, maxSec: 180, fps: [23, 60], codecs: ["h264"], containers: ["mp4", "mov"], maxMB: 4096 },
    sources: ["meta-fb-story-video"],
    unverified: ["video.fps", "video.codecs", "video.containers"],
  },
  // X (Figma's Twitter post preset is 1200 × 675; the 280 characters: help.x.com refused the fetch)
  { id: "x.image", name: "X image", width: 1600, height: 900, platform: "x", kind: "image", aspect: "16:9", safeArea: NONE, caption: X_CAPTION, image: { maxMB: 5, types: ["jpeg", "png", "gif", "webp"] }, sources: ["x-media"], unverified: ["width", "height", "caption.max"] },
  { id: "x.video", name: "X video", width: 1280, height: 720, platform: "x", kind: "video", aspect: "16:9", safeArea: NONE, caption: X_CAPTION, video: { minSec: 0.5, maxSec: 1200, fps: [1, 60], codecs: ["h264"], containers: ["mp4", "mov"], maxMB: 8192 }, sources: ["x-media"], unverified: ["caption.max"] },
  // TikTok (no official safe area: Meta's Reels zones stand in)
  {
    id: "tiktok.video",
    name: "TikTok video",
    width: 1080,
    height: 1920,
    platform: "tiktok",
    kind: "video",
    aspect: "9:16",
    safeArea: REELS_ZONE,
    caption: { max: 2200, unit: "utf16" },
    video: { minSec: 1, maxSec: 600, fps: [23, 60], codecs: ["h264", "hevc", "vp8", "vp9"], containers: ["mp4", "webm", "mov"], maxMB: 4096 },
    sources: ["tt-media", "tt-video-post"],
    unverified: ["safeArea", "video.minSec"],
  },
  { id: "tiktok.photo", name: "TikTok photo", width: 1080, height: 1920, platform: "tiktok", kind: "carousel", aspect: "9:16", safeArea: NONE, caption: { max: 4000, unit: "utf16", title: 90 }, image: { maxMB: 20, types: ["jpeg", "webp"] }, items: { min: 1, max: 35 }, sources: ["tt-media", "tt-photo-post"], unverified: ["safeArea"] },
  // YouTube (the thumbnail exports at 3×: YouTube recommends 3840 × 2160)
  { id: "youtube.thumbnail", name: "YouTube thumbnail", width: 1280, height: 720, platform: "youtube", kind: "thumbnail", aspect: "16:9", safeArea: NONE, caption: YT_CAPTION, image: { maxMB: 2, types: ["jpeg", "png"] }, sources: ["yt-thumbnail", "yt-title", "yt-hashtags"], unverified: [] },
  {
    id: "youtube.short",
    name: "YouTube Short",
    width: 1080,
    height: 1920,
    platform: "youtube",
    kind: "video",
    aspect: "9:16",
    safeArea: REELS_ZONE,
    caption: YT_CAPTION,
    video: { minSec: 1, maxSec: 180, fps: [24, 60], codecs: ["h264"], containers: ["mp4", "mov"], maxMB: 4096 },
    sources: ["yt-shorts", "yt-title", "yt-hashtags"],
    unverified: ["safeArea", "video.minSec", "video.fps", "video.codecs", "video.containers", "video.maxMB"],
  },
  // Pinterest
  { id: "pinterest.pin", name: "Pinterest pin", width: 1000, height: 1500, platform: "pinterest", kind: "image", aspect: "2:3", safeArea: NONE, caption: PIN_CAPTION, image: { maxMB: 20, types: ["png", "jpeg"] }, sources: ["pin-specs"], unverified: [] },
  { id: "pinterest.video", name: "Pinterest video pin", width: 1000, height: 1500, platform: "pinterest", kind: "video", aspect: "2:3", safeArea: NONE, caption: PIN_CAPTION, video: { minSec: 4, maxSec: 900, fps: [1, 60], codecs: ["h264", "hevc"], containers: ["mp4", "mov"], maxMB: 2048 }, sources: ["pin-specs"], unverified: ["video.fps"] },
];

/** The catalogue (§5.2), in the New post menu's order; `tier` follows FIRST_PLATFORMS. */
export const SOCIAL_FORMATS: readonly PlatformFormat[] = ENTRIES.map((f) => ({ ...f, tier: FIRST_PLATFORMS.includes(f.platform) ? "first" : "catalogue" }));

const BY_ID = new Map(SOCIAL_FORMATS.map((f) => [f.id, f]));

/** A catalogue format by id ("instagram.post"); null for a brand's own ("brand:…") or an unknown id. */
export const formatById = (id: string | null | undefined): PlatformFormat | null => (id ? (BY_ID.get(id) ?? null) : null);

/** A platform's formats, in the catalogue's order. */
export const formatsFor = (platform: Platform): PlatformFormat[] => SOCIAL_FORMATS.filter((f) => f.platform === platform);

/** A brand's own size as a post's format id. */
export const brandFormatId = (brandId: string, formatId: string): string => `brand:${brandId}:${formatId}`;

/** The brand and its format in a "brand:<brandId>:<formatId>" id; null for a catalogue id. */
export function parseBrandFormatId(id: string): { brandId: string; formatId: string } | null {
  const m = /^brand:([^:]+):(.+)$/.exec(id);
  return m ? { brandId: m[1], formatId: m[2] } : null;
}

/** A post's format, a catalogue entry or a brand's own size (found in `brands`); null when neither is known. */
export function resolveFormat(id: string, brands?: readonly { id: string; formats: readonly SocialFormat[] }[]): PlatformFormat | SocialFormat | null {
  const own = parseBrandFormatId(id);
  if (!own) return formatById(id);
  return brands?.find((b) => b.id === own.brandId)?.formats.find((f) => f.id === own.formatId) ?? null;
}

/**
 * The catalogue format a frame of this size is (Studio's sizes, a frame drawn by hand): the exact size first, else the
 * nearest aspect ratio (then the nearest area), within `platform` when given.
 */
export function nearestFormat(width: number, height: number, platform?: Platform): PlatformFormat | null {
  const pool = platform ? formatsFor(platform) : SOCIAL_FORMATS;
  if (!pool.length || !(width > 0) || !(height > 0)) return null;
  const exact = pool.find((f) => f.width === width && f.height === height);
  if (exact) return exact;
  const ratio = Math.log(width / height);
  let best: PlatformFormat | null = null;
  let bestScore = Infinity;
  for (const f of pool) {
    const score = Math.abs(Math.log(f.width / f.height) - ratio) * 1e6 + Math.abs(f.width * f.height - width * height) / 1e6;
    if (score < bestScore) {
      best = f;
      bestScore = score;
    }
  }
  return best;
}
