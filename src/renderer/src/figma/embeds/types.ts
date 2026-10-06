/**
 * The data of what the site's code draws in a frame's place (see Embed in
 * model.ts): an image's badges and second tab, a before / after pair, the
 * screens of a device frame.
 */

export type AspectRatio = "16/9" | "4/3" | "1/1" | "3/4" | "9/16";

export type BadgeIconType = "link" | "search" | "play" | "external" | "gear" | "segmented";
export type BadgePosition = "top-right" | "top-left" | "bottom-right" | "bottom-left";

/** What a segmented badge's second tab shows instead of the medium. */
export interface SegmentedSecondTab {
  type: "image" | "video" | "code" | "text";
  src?: string;
  content?: string;
  language?: string;
  codePreview?: string;
  previewComponent?: string;
}

export interface BadgeItem {
  id: string;
  icon: BadgeIconType;
  position: BadgePosition;
  /** For "link" and "external" badges */
  href?: string;
  tab1Label?: string;
  tab2Label?: string;
  tab2?: SegmentedSecondTab;
}

/** One picture of an embed: a before / after side, a device's screen. */
export interface EmbedEntry {
  id: string;
  /** The side's label, the browser's address */
  label?: string;
  labelEn?: string;
  src?: string;
  alt?: string;
  altEn?: string;
}

export type DeviceVariant = "phone" | "tablet" | "browser";
