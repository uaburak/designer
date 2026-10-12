/**
 * First Draft's libraries (docs/ai.md §3 "Kits"): our own, licence-safe block sets — no Figma or third-party UI kit is
 * copied. A kit is a platform's block catalogue (what the model may plan with: each block's props, described) and a
 * style (wireframe or design) with four themes. The editor's builder (editor/ai/draft/build.ts) draws the blocks.
 */

export type KitPlatform = "app" | "web";
export type KitStyle = "wireframe" | "design";
export type KitId = "app-wireframe" | "web-wireframe" | "app-design" | "web-design";

export interface KitBlock {
  id: string;
  /** What the block is, for the model */
  description: string;
  /** The props the model may set: name → what it holds (strings, numbers, or lists of strings) */
  props: Record<string, string>;
}

export interface KitPalette {
  background: string;
  surface: string;
  text: string;
  muted: string;
  primary: string;
  onPrimary: string;
  border: string;
  /** Image placeholders and illustrations */
  placeholder: string;
}

export interface KitFont {
  family: string;
  style: string;
}

export interface KitTheme {
  id: string;
  name: string;
  light: KitPalette;
  dark: KitPalette;
  /** Corner radius of cards, fields and buttons */
  radius: number;
  /** The base spacing step (gaps are multiples of it) */
  spacing: number;
  fonts: { title: KitFont; body: KitFont; label: KitFont };
}

export interface Kit {
  id: KitId;
  /** The "Library" menu's name [ours] */
  name: string;
  platform: KitPlatform;
  style: KitStyle;
  /** The draft frame's width: 390 for an app, 1440 for a website */
  width: number;
  blocks: readonly KitBlock[];
  themes: readonly KitTheme[];
}
