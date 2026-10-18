/**
 * A post's words against its format (docs/social.md §5.1, §6.5): characters counted the platform's way (graphemes —
 * an emoji or a Turkish "İ" is one — or UTF-16 code units, as TikTok counts), hashtags and mentions read out of the
 * text, and the report the Post section's counter and the agents' set_post / check_posts show. Pure, shared by the
 * editor and the tools.
 */
import type { CaptionLimits } from "./types";

const segmenter = typeof Intl !== "undefined" && "Segmenter" in Intl ? new Intl.Segmenter(undefined, { granularity: "grapheme" }) : null;

/** The text's length as the platform counts it. */
export function captionCount(text: string, unit: CaptionLimits["unit"]): number {
  if (unit === "utf16") return text.length;
  if (!segmenter) return Array.from(text).length;
  let n = 0;
  for (const _ of segmenter.segment(text)) n++;
  return n;
}

// A tag starts after a space or the text's start (not inside a word, a URL's fragment or "&#…"); letters in any
// script, marks, digits and "_"; at least one letter or "_" (Instagram doesn't link "#2024").
const HASHTAG = /(^|[^\p{L}\p{M}\p{N}_&/])#([\p{L}\p{M}\p{N}_]+)/gu;
const MENTION = /(^|[^\p{L}\p{M}\p{N}_])@([\p{L}\p{N}_.]*[\p{L}\p{N}_])/gu;

/** The hashtags in a text, without "#", in order, each once (case-insensitive: the first spelling is kept). */
export function parseHashtags(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(HASHTAG)) {
    const tag = m[2];
    if (!/[\p{L}_]/u.test(tag)) continue;
    const k = tag.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(tag);
  }
  return out;
}

/** The @mentions in a text, without "@", each once. */
export function parseMentions(text: string): string[] {
  return [...new Set([...text.matchAll(MENTION)].map((m) => m[2].toLowerCase()))];
}

/** What is posted: the caption, then the post's hashtags on a line of their own (as the platforms show them). */
export function publishedText(caption: string, hashtags: readonly string[]): string {
  const tags = hashtags.map((h) => `#${h}`).join(" ");
  return tags ? (caption ? `${caption}\n\n${tags}` : tags) : caption;
}

export interface CaptionReport {
  /** The published text's length in the format's unit */
  count: number;
  /** 0: nothing to check (no caption, or no limit known) */
  max: number;
  unit: CaptionLimits["unit"];
  fold: number | null;
  over: boolean;
  hashtags: { count: number; max: number | null; over: boolean };
  mentions: { count: number; max: number | null; over: boolean };
}

/** The caption with the post's hashtags against the format's limits (a format without limits: nothing is over). */
export function captionReport(caption: string, hashtags: readonly string[], format: { caption: CaptionLimits } | null): CaptionReport {
  const limits = format?.caption ?? { max: 0, unit: "grapheme" as const };
  const text = publishedText(caption, hashtags);
  const count = captionCount(text, limits.unit);
  const tags = parseHashtags(text).length;
  const mentions = parseMentions(caption).length;
  return {
    count,
    max: limits.max,
    unit: limits.unit,
    fold: limits.fold ?? null,
    over: limits.max > 0 && count > limits.max,
    hashtags: { count: tags, max: limits.hashtags ?? null, over: limits.hashtags !== undefined && tags > limits.hashtags },
    mentions: { count: mentions, max: limits.mentions ?? null, over: limits.mentions !== undefined && mentions > limits.mentions },
  };
}
