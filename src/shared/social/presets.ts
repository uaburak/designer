/**
 * Social's export presets (docs/social.md §8): per format, the still or animated export a post leaves as. Data only —
 * the renderer side (picking "auto", the JPEG quality steps, the size checks, the campaign zip) is round 18d's
 * editor/social/export/exportPosts.ts. The animated settings are Motion's Animated export as built (shared/motion/types.ts).
 */
import type { SocialExportPreset } from "./types";

const STATIC_IG = ["instagram.post", "instagram.portrait", "instagram.square", "instagram.landscape", "instagram.carousel", "instagram.story"];

export const SOCIAL_EXPORT_PRESETS: readonly SocialExportPreset[] = [
  { id: "instagram-image", label: "Instagram image", formatIds: STATIC_IG, still: { format: "JPEG", scale: 1, quality: 0.92 }, maxMB: 8 },
  // A story with a timeline exports as video; the size checked per format (Reel 300 MB, Story 100 MB) by 18d.
  { id: "instagram-reel", label: "Instagram reel", formatIds: ["instagram.reel", "instagram.story"], animated: { format: "MP4", size: { width: 1080, height: 1920 }, fps: 30, quality: "HIGH", loop: false }, maxMB: 300 },
  // PNG; JPEG 0.92 when the PNG is over 5 MB (18d).
  { id: "linkedin-image", label: "LinkedIn image", formatIds: ["linkedin.landscape", "linkedin.square", "linkedin.portrait"], still: { format: "PNG", scale: 1 }, maxMB: 5 },
  // The group's frames in `index` order, Export frames to PDF's renderer; ≤ 300 pages.
  { id: "linkedin-document", label: "LinkedIn document", formatIds: ["linkedin.document"], still: { format: "PDF", scale: 1 }, maxMB: 100 },
  { id: "linkedin-video", label: "LinkedIn video", formatIds: ["linkedin.video", "linkedin.video-vertical"], animated: { format: "MP4", size: { scale: 1 }, fps: 30, quality: "HIGH", loop: false } },
  { id: "vertical-video", label: "Vertical video", formatIds: ["tiktok.video", "youtube.short", "facebook.story"], animated: { format: "MP4", size: { width: 1080, height: 1920 }, fps: 30, quality: "HIGH", loop: false } },
  // 3840 × 2160; the quality lowered in steps until ≤ 2 MB (18d).
  { id: "youtube-thumbnail", label: "YouTube thumbnail", formatIds: ["youtube.thumbnail"], still: { format: "JPEG", scale: 3, quality: 0.92 }, maxMB: 2 },
  // Everything else: the format's own limits are checked.
  { id: "generic-image", label: "Image", formatIds: [], still: { format: "PNG", scale: 1 } },
  { id: "generic-video", label: "Video", formatIds: [], animated: { format: "MP4", size: { scale: 1 }, fps: 30, quality: "HIGH", loop: false } },
];

/** A preset by id. */
export const presetById = (id: string): SocialExportPreset | null => SOCIAL_EXPORT_PRESETS.find((p) => p.id === id) ?? null;
