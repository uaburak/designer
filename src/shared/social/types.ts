/**
 * Social (docs/social.md, round 18 [ours]): the shared types of Social mode — the formats catalogue's shape, a post's
 * record, campaigns, templates and their slots, the Brands library's marker, review problems on a post, the export
 * presets' shape — and the plugin-data helpers every side reads them with. Posts, campaigns, templates and slots are
 * plugin data (schema `pluginData`, 204) under the reserved plugin ID `designer.social`, as the owner's frame status is
 * under `designer.workflow` (editor/workflowStatus.ts); plugins never see either ID (editor/plugins/api/nodes.ts).
 */
import type { AnimatedExportSettings } from "../motion/types";
import type { ReviewProblem, SocialFormat } from "../studio/types";

// ── The formats catalogue's shape (§5.1) ──────────────────────────────────────────────────────────────────────────

export type Platform = "instagram" | "linkedin" | "facebook" | "x" | "tiktok" | "youtube" | "pinterest";
export type PostKind = "image" | "carousel" | "document" | "video" | "thumbnail";

/** px at the format's size */
export interface Insets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface CaptionLimits {
  /** 0: the format has no caption (stories), or no limit is known — nothing is checked against it */
  max: number;
  /** How the platform counts: graphemes (Intl.Segmenter), UTF-16 code units */
  unit: "grapheme" | "utf16";
  /** Characters shown before "… more" (feed) */
  fold?: number;
  hashtags?: number;
  mentions?: number;
  /** A separate title field (YouTube, Pinterest, TikTok photo) */
  title?: number;
}

export interface VideoLimits {
  minSec: number;
  maxSec: number;
  fps: [number, number];
  codecs: ("h264" | "hevc" | "vp8" | "vp9")[];
  containers: ("mp4" | "mov" | "webm")[];
  maxMB: number;
  maxMbps?: number;
}

export interface ImageLimits {
  maxMB: number;
  types: ("jpeg" | "png" | "webp" | "gif")[];
}

export interface PlatformFormat extends SocialFormat {
  platform: Platform;
  kind: PostKind;
  /** "4:5" */
  aspect: string;
  /** What the platform's UI covers (0 where it covers nothing) */
  safeArea: Insets;
  caption: CaptionLimits;
  image?: ImageLimits;
  video?: VideoLimits;
  /** Carousels / documents: slides */
  items?: { min: number; max: number };
  tier: "first" | "catalogue";
  /** Keys of SOCIAL_SOURCES */
  sources: string[];
  /** Field paths not confirmed by an official page ("caption.fold", "safeArea") */
  unverified: string[];
}

// ── Posts, campaigns, templates (§3) ──────────────────────────────────────────────────────────────────────────────

export type PostStatus = "draft" | "reviewed" | "approved" | "exported";
export const POST_STATUSES: readonly PostStatus[] = ["draft", "reviewed", "approved", "exported"];

export type SlotRole = "logo" | "picture" | "headline" | "body" | "cta" | "label" | "accent" | "background";
export const SLOT_ROLES: readonly SlotRole[] = ["logo", "picture", "headline", "body", "cta", "label", "accent", "background"];

/** A review's problem on a post (§7.3): the manager's visual review ("review") or check_posts' limits ("check"). */
export type PostProblem = ReviewProblem & { source: "review" | "check" };

/** On a top-level FRAME (or INSTANCE / SYMBOL): `designer.social` / `post` (§3.1). A frame without it is not a post. */
export interface SocialPostData {
  v: 1;
  /** A catalogue id ("instagram.post") or "brand:<brandId>:<formatId>" */
  formatId: string;
  brandId: string | null;
  productIds: string[];
  campaignId: string | null;
  /** The template it was made from (the component set's key, local or library) and the variant's Format value */
  template: { key: string; variant: string } | null;
  /** Carousels and documents: one frame per slide, all sharing `group.id`; the caption lives on index 0 */
  group: { id: string; index: number } | null;
  caption: string;
  /** Without "#", in order */
  hashtags: string[];
  altText: string;
  status: PostStatus;
  /** The last review's problems on this post (pins, §6.5); cleared when fixed or left */
  problems: PostProblem[];
  exportedAt: number | null;
}

/** A row of posts; on the page (CANVAS) under `designer.social` / `campaigns` as SocialCampaign[] (§3.2). */
export interface SocialCampaign {
  id: string;
  name: string;
  brandId: string | null;
  created: number;
}

/** On a template's component set (or a lone component): `designer.social` / `template` (§3.3). */
export interface SocialTemplateData {
  v: 1;
  name: string;
  /** Format variant value → catalogue format id ("Instagram post" → "instagram.post") */
  formats: Record<string, string>;
  animated: boolean;
  /** Platforms it was made for (the gallery's filter) */
  platforms: Platform[];
  /** "starter" (made by the agent's starter brief, §4.2) | "owner" */
  origin: "starter" | "owner";
}

/** On each slot layer inside a template's variant: `designer.social` / `slot` (§3.3). */
export interface TemplateSlotData {
  v: 1;
  role: SlotRole;
  /** The component property that drives it (TEXT slots: its TEXT property's name, "Headline#12:0") */
  property: string | null;
  /** The template's author says this must not change in a post (enforced by Social's controls and the agents' tools) */
  locked: boolean;
  /** Text slots: the most characters that fit, for the agent's copy */
  maxChars: number | null;
}

/** On the generated Brands library's DOCUMENT node: `designer.social` / `brandLibrary` (§3.4). */
export interface BrandLibraryMarker {
  v: 1;
  /** brandId → the Brand.updated it was generated from */
  generatedFrom: Record<string, number>;
}

// ── The manager's Social paragraph (§7.4) and export presets (§8) ─────────────────────────────────────────────────

export interface SocialPromptContext {
  brand: { id: string; name: string } | null;
  campaigns: { id: string; name: string; posts: number }[];
  /** Posts on the page outside any campaign */
  unplaced: number;
}

export interface SocialExportPreset {
  id: string;
  label: string;
  formatIds: string[];
  still?: { format: "PNG" | "JPEG" | "PDF"; scale: number; quality?: number };
  animated?: AnimatedExportSettings;
  /** Checked after rendering: over → a warning on the file */
  maxMB?: number;
}

// ── Plugin data (§3) ──────────────────────────────────────────────────────────────────────────────────────────────

export const SOCIAL_PLUGIN_ID = "designer.social";
export const SOCIAL_KEYS = { post: "post", campaigns: "campaigns", template: "template", slot: "slot", brandLibrary: "brandLibrary" } as const;
export type SocialKey = (typeof SOCIAL_KEYS)[keyof typeof SOCIAL_KEYS];

export type PluginDataEntry = { pluginID?: string; key?: string; value?: string };

/** Our entry under `key` in a node's pluginData, parsed; null when it is missing or not JSON. */
export function readSocial<T>(entries: readonly PluginDataEntry[] | undefined, key: SocialKey): T | null {
  const e = entries?.find((x) => x.pluginID === SOCIAL_PLUGIN_ID && x.key === key);
  if (!e?.value) return null;
  try {
    return JSON.parse(e.value) as T;
  } catch {
    return null;
  }
}

/** pluginData with our entry under `key` set to `value` (or removed, with null); every other entry kept, in order. */
export function withSocial(entries: readonly PluginDataEntry[] | undefined, key: SocialKey, value: unknown): PluginDataEntry[] {
  const rest = (entries ?? []).filter((e) => !(e.pluginID === SOCIAL_PLUGIN_ID && e.key === key));
  return value === null || value === undefined ? rest : [...rest, { pluginID: SOCIAL_PLUGIN_ID, key, value: JSON.stringify(value) }];
}
