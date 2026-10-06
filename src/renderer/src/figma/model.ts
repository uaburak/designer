import type { BlendMode, DesignVariable, InteractionAction, InteractionAnimation, InteractionDirection, InteractionEasing, InteractionTrigger, TextTag, VariableValue } from "@/types/design";
import type { AspectRatio, BadgeItem, DeviceVariant, EmbedEntry } from "./embeds/types";

/**
 * The Figma editor's file, as Figma's own: a canvas holding frames, shapes
 * and texts, components (with their variants in component sets) and
 * instances of them. A project's page is one of the top-level frames
 * (`FigmaDocument.pageId`): what the site shows at /projects/<slug>.
 *
 * Every node has its place (x, y — from its parent's top left; a top-level
 * one's from the canvas's origin) and size. A frame with auto layout lays its
 * children out itself (their x, y are ignored); its children then size as
 * Fixed, Hug or Fill.
 */

export type NodeType = "frame" | "rectangle" | "ellipse" | "line" | "text" | "component" | "componentSet" | "instance";

/** A gradient's stop: a colour at a place along it (0–100). */
export interface GradientStop {
  color: string;
  position: number;
}

/**
 * A fill: solid — a colour of its own (#rrggbb) or a colour variable's — or,
 * as Figma's, a linear gradient or an image; at an opacity (0–100).
 */
export interface Paint {
  type?: "solid" | "gradient" | "image";
  color: VariableValue;
  opacity?: number;
  visible?: boolean;
  gradient?: { angle: number; stops: GradientStop[] };
  /** A picture: its address, how it fills, and what it shows in words (its alt text — and in English) for those who can't see it */
  image?: { url: string; fit: "fill" | "fit" | "tile"; alt?: string; altEn?: string };
}

export const PAINT_LABEL: Record<NonNullable<Paint["type"]>, string> = { solid: "Solid", gradient: "Gradient", image: "Image" };

/** Figma's layout grids: columns, rows or a square grid drawn over a frame in the editor. */
export interface LayoutGrid {
  type: "columns" | "rows" | "grid";
  visible?: boolean;
  count: number;
  gutter: number;
  margin: number;
  /** The square grid's cell (px) */
  size: number;
  color: string;
  opacity: number;
}

export const newLayoutGrid = (type: LayoutGrid["type"]): LayoutGrid => ({ type, count: type === "grid" ? 0 : 5, gutter: 20, margin: 0, size: 8, color: "#ff0000", opacity: 10 });
export const LAYOUT_GRID_LABEL: Record<LayoutGrid["type"], string> = { columns: "Columns", rows: "Rows", grid: "Grid" };

/** An effect style: effects kept under a name, applied to layers. */
export interface EffectStyle {
  id: string;
  name: string;
  effects: Effect[];
}

/** Figma's Export settings on a layer. */
export interface ExportSetting {
  scale: 1 | 2 | 3 | 4;
  format: "png" | "jpg" | "svg";
}

export const BLEND_MODES: { value: BlendMode; label: string }[] = [
  { value: "pass-through", label: "Pass through" },
  { value: "normal", label: "Normal" },
  { value: "darken", label: "Darken" },
  { value: "multiply", label: "Multiply" },
  { value: "color-burn", label: "Color burn" },
  { value: "lighten", label: "Lighten" },
  { value: "screen", label: "Screen" },
  { value: "color-dodge", label: "Color dodge" },
  { value: "overlay", label: "Overlay" },
  { value: "soft-light", label: "Soft light" },
  { value: "hard-light", label: "Hard light" },
  { value: "difference", label: "Difference" },
  { value: "exclusion", label: "Exclusion" },
  { value: "hue", label: "Hue" },
  { value: "saturation", label: "Saturation" },
  { value: "color", label: "Color" },
  { value: "luminosity", label: "Luminosity" },
];

export type StrokeAlign = "inside" | "center" | "outside";

export interface StrokeStyle {
  color: VariableValue;
  opacity?: number;
  visible?: boolean;
  /** px — or a number variable */
  weight: VariableValue;
  align: StrokeAlign;
  /** Which sides it is drawn on (all when unset) */
  sides?: { top: boolean; right: boolean; bottom: boolean; left: boolean };
  /** Dashed */
  dashed?: boolean;
}

/** Figma's effects: a drop or inner shadow, a layer or background blur. */
export type Effect =
  | { type: "dropShadow" | "innerShadow"; visible?: boolean; x: number; y: number; blur: number; spread: number; color: string; opacity: number }
  | { type: "layerBlur" | "backgroundBlur"; visible?: boolean; radius: number };
/** (The drop shadow's shape, as effects were first stored.) */
export type Shadow = Extract<Effect, { type: "dropShadow" | "innerShadow" }>;

export const EFFECT_LABEL: Record<Effect["type"], string> = { dropShadow: "Drop shadow", innerShadow: "Inner shadow", layerBlur: "Layer blur", backgroundBlur: "Background blur" };
export const newEffect = (type: Effect["type"]): Effect =>
  type === "layerBlur" || type === "backgroundBlur" ? { type, radius: 4 } : { type, x: 0, y: 4, blur: 4, spread: 0, color: "#000000", opacity: 25 };

export type LayoutMode = "none" | "horizontal" | "vertical" | "grid";
export type SizingMode = "fixed" | "hug" | "fill";
export type PrimaryAlign = "min" | "center" | "max" | "spaceBetween";
export type CounterAlign = "min" | "center" | "max";
export type TextAlign = "left" | "center" | "right";
export type TextAutoResize = "widthHeight" | "height" | "none";

/** A variant's value of one of its set's properties ("State=Hover"). */
export interface VariantValue {
  property: string;
  value: string;
}

/** A prototype interaction of a variant: what turns its instances into another variant, and how it animates. */
export interface Reaction {
  id: string;
  trigger: InteractionTrigger;
  /** After a delay: how long (ms) */
  delay?: number;
  /** Key/Gamepad: the key (as KeyboardEvent.key names it) */
  key?: string;
  /** What it does — none: Change to (what a variant's reactions did before the other actions) */
  action?: InteractionAction;
  /** Navigate to / Scroll to: a frame (or a layer) on the page; Change to: a variant of the set; Back, Open link: "" */
  target: string;
  /** Open link: the address */
  url?: string;
  animation: InteractionAnimation;
  /** Move in / out, Push, Slide in / out: the way it goes */
  direction?: InteractionDirection;
  /** Move, Push, Slide: the layers both frames have Smart animated, too */
  matchLayers?: boolean;
  easing: InteractionEasing;
  /** Custom bezier: x1, y1, x2, y2 */
  bezier?: [number, number, number, number];
  /** Custom spring */
  spring?: { mass: number; stiffness: number; damping: number };
  duration: number;
}

/** What a reaction does (see Reaction.action). */
export const actionOf = (r: Reaction): InteractionAction => r.action ?? "change";

export type Corners = [VariableValue, VariableValue, VariableValue, VariableValue];

/**
 * Figma's component properties (besides the variant ones, which are the
 * set's variants' values): a boolean shows or hides a layer, a text gives a
 * text its words, an instance swap picks a nested instance's component.
 * They are defined on the main component — on the set, for its variants —
 * and layers bind to them (visibleProp, charactersProp, mainProp); each
 * instance keeps its own values (props).
 */
export type PropertyType = "boolean" | "text" | "instanceSwap";

export interface ComponentProperty {
  id: string;
  name: string;
  type: PropertyType;
  /** Its default: on / off, the words, or a component's id */
  value: string | boolean;
  /** Instance swap: the components offered first (ids) */
  preferred?: string[];
}

export type PropertyValues = Record<string, string | boolean>;

/**
 * What the site's own code draws in a frame's place — what shapes and texts
 * can't be: an image with its badges and second tab, a video playing, a code
 * sample (highlighted, with its preview), a Figma file or a page opening in
 * its window, a before / after slider, screens in their devices. The frame
 * is as tall as what is drawn; its data is kept as the site's blocks kept
 * theirs (the same fields), its caption under it.
 */
export type EmbedKind = "image" | "video" | "code" | "figma" | "iframe" | "compare" | "devices";

export interface Embed {
  kind: EmbedKind;
  /** The image, the video (YouTube, Vimeo, .mp4), the Figma prototype or the page */
  src?: string;
  alt?: string;
  altEn?: string;
  caption?: string;
  captionEn?: string;
  /** Its caption in the languages beyond Turkish and English (by language code) */
  captionI18n?: Record<string, string>;
  aspectRatio?: AspectRatio;
  badges?: BadgeItem[];
  /** A video file: autoplay muted loop without controls */
  videoLoop?: boolean;
  /** A code sample: its code, language, and what it shows (HTML drawn in a sandbox, or one of the site's demos) */
  content?: string;
  language?: string;
  codePreview?: string;
  previewComponent?: string;
  figmaWorkspace?: string;
  figmaCover?: string;
  figmaWorkspaceCover?: string;
  iframeViews?: ("desktop" | "tablet" | "mobile")[];
  iframeTabletUrl?: string;
  iframeMobileUrl?: string;
  iframeCover?: string;
  /** Before / after: its two sides; a device frame: its screens */
  entries?: EmbedEntry[];
  /** A device frame's device */
  variant?: DeviceVariant;
}

export const EMBED_LABEL: Record<EmbedKind, string> = { image: "Image", video: "Video", code: "Code", figma: "Figma", iframe: "iFrame", compare: "Before / After", devices: "Device frame" };

interface BaseNode {
  id: string;
  name: string;
  type: NodeType;
  x: number;
  y: number;
  width: number;
  height: number;
  /** Degrees, clockwise */
  rotation?: number;
  /** Shown (true when unset) */
  visible?: boolean;
  locked?: boolean;
  /** 0–100 (100 when unset) */
  opacity?: number;
  /** How it sizes in a frame with auto layout — Fixed when unset; a frame's own Hug sizes it to its content anywhere */
  sizingH?: SizingMode;
  sizingV?: SizingMode;
  /** Figma's blend mode (pass-through when unset) */
  blendMode?: BlendMode;
  /** Constrain proportions: W and H change together */
  lockAspect?: boolean;
  /** In a frame with auto layout: kept at its own x, y (Figma's absolute position) */
  absolute?: boolean;
  /** Fill, along its frame's flow: its share of the free space among the layers filling it (1 when unset) — a bar's part of its track */
  grow?: number;
  /** In a grid frame: the cell it was put in (1-based column and row — the next free one when unset) and how many columns it covers (1 when unset) */
  gridCol?: number;
  gridRow?: number;
  gridSpan?: number;
  /** Its export settings (Figma's Export section) */
  exports?: ExportSetting[];
  /** Mirrored (Figma's Flip horizontal / vertical) */
  flipH?: boolean;
  flipV?: boolean;
  /** Figma's min / max width and height (px) */
  minWidth?: number;
  maxWidth?: number;
  minHeight?: number;
  maxHeight?: number;
  /** W / H from a number variable ("Apply variable…") */
  widthVar?: VariableValue;
  heightVar?: VariableValue;
  /** Inside a main component: shown or hidden by this boolean property (its id) */
  visibleProp?: string;
  /** Where a click on it goes, on the site (a link) */
  href?: string;
  /** One of the project's own layers — its page's Overview or a part of it (see overview.ts): it stays, whole and in its place */
  fixed?: FixedPart;
  /** Its prototype: what clicking it, hovering it… does (a variant's: what its instances do) */
  reactions?: Reaction[];
}

/** The Overview's layers: the project's title, its category and year, its description and cover (see overview.ts). */
export type FixedPart = "overview" | "header" | "title" | "subtitle" | "description" | "cover" | "image";

interface Geometry {
  fills: Paint[];
  strokes: StrokeStyle[];
  cornerRadius?: VariableValue;
  /** Each corner on its own (top left, top right, bottom right, bottom left) — wins over cornerRadius */
  corners?: Corners;
  effects?: Effect[];
}

export interface ShapeNode extends BaseNode, Geometry {
  type: "rectangle" | "ellipse" | "line";
  effectStyle?: string;
}

export interface TextNode extends BaseNode {
  type: "text";
  characters: string;
  /** Its English text, when the site shows English */
  charactersEn?: string;
  /** Its text in the languages beyond Turkish and English (by language code) */
  translations?: Record<string, string>;
  fontSize: VariableValue;
  fontWeight: VariableValue;
  /** px — auto when unset */
  lineHeight?: VariableValue;
  /** px */
  letterSpacing?: VariableValue;
  textAlign: TextAlign;
  /** Grows with its text (both ways), down only (fixed width), or neither */
  textAutoResize: TextAutoResize;
  fills: Paint[];
  /** One of the site's text styles — its typography over the node's own */
  textStyle?: string;
  /** Inside a main component: its words from this text property (its id) */
  charactersProp?: string;
  /** Figma's type settings */
  textCase?: "upper" | "lower" | "title";
  textDecoration?: "underline" | "strikethrough";
  /** Where the text sits in a fixed-height box */
  verticalAlign?: "top" | "middle" | "bottom";
  /** What it is on the site's page (a heading's level, a paragraph) — its text style's when unset */
  tag?: TextTag;
  /** px between paragraphs (blank lines) */
  paragraphSpacing?: number;
}

export interface FrameNode extends BaseNode, Geometry {
  type: "frame" | "component" | "componentSet" | "instance";
  children: SceneNode[];
  clipsContent?: boolean;
  layoutMode: LayoutMode;
  /** px — or a number variable */
  itemSpacing: VariableValue;
  paddingTop: VariableValue;
  paddingRight: VariableValue;
  paddingBottom: VariableValue;
  paddingLeft: VariableValue;
  primaryAlign: PrimaryAlign;
  counterAlign: CounterAlign;
  layoutWrap?: boolean;
  /** Grid auto layout: its columns and rows */
  gridColumns?: number;
  gridRows?: number;
  /** …and their sizes, as CSS, one per column / row ("minmax(0,2fr)", "240px", "fit-content(100%)") — equal shares when unset, or when their count isn't the grid's */
  gridTracks?: string[];
  gridRowTracks?: string[];
  /**
   * On the site, on a narrower screen (the file itself has none): its
   * layers stacked, one to a row, as wide as it — under 768px ("stack") or
   * 640px ("stack-sm") — or, under 640px, in two columns ("two").
   */
  narrow?: "stack" | "stack-sm" | "two";
  /** The gap across the rows of a wrapping layout (the item spacing when unset) */
  counterSpacing?: VariableValue;
  /** Figma's advanced layout settings */
  strokesInLayout?: boolean;
  /** Canvas stacking: the first layer on top (the last, when unset) */
  firstOnTop?: boolean;
  /** Text baseline alignment */
  baselineAlign?: boolean;
  /** Figma's layout grids, drawn over it in the editor */
  layoutGrids?: LayoutGrid[];
  /** The effect style its effects come from */
  effectStyle?: string;
  /** A component in a set: its values of the set's properties */
  variant?: VariantValue[];
  /** A top-level frame where a flow of the prototype starts (Figma's flow starting point): its name */
  flowStart?: string;
  /** A main component's (or a set's, for its variants) properties */
  properties?: ComponentProperty[];
  /** An instance: its main component's id (a variant's, in a set) */
  mainId?: string;
  /** An instance's values of its component's properties (by property id) — the defaults where unset */
  props?: PropertyValues;
  /** An instance's English words for its text properties */
  propsEn?: Record<string, string>;
  /** Its words for its text properties in the languages beyond Turkish and English (by language code, then property id) */
  propsI18n?: Record<string, Record<string, string>>;
  /** An instance inside a main component: its component from this instance swap property (its id) */
  mainProp?: string;
  /**
   * An instance's overrides, by the overridden layer's name path inside the
   * main component ("Label", "Card›Title") — "" for the instance's own frame.
   */
  overrides?: Record<string, NodeOverride>;
  /** Drawn by the site's code instead of its children (see Embed) */
  embed?: Embed;
}

/** What an instance may change of a layer of its main component (of its own frame: the key ""). */
export interface NodeOverride {
  characters?: string;
  charactersEn?: string;
  translations?: Record<string, string>;
  fills?: Paint[];
  strokes?: StrokeStyle[];
  visible?: boolean;
  opacity?: number;
  cornerRadius?: VariableValue;
  corners?: Corners;
  effects?: Effect[];
  /** A frame's: its clip and auto layout's spacing and alignment */
  clipsContent?: boolean;
  itemSpacing?: VariableValue;
  counterSpacing?: VariableValue;
  paddingTop?: VariableValue;
  paddingRight?: VariableValue;
  paddingBottom?: VariableValue;
  paddingLeft?: VariableValue;
  primaryAlign?: PrimaryAlign;
  counterAlign?: CounterAlign;
  layoutWrap?: boolean;
  /** A nested instance's own overrides (a Card's texts inside a Project info instance) */
  overrides?: Record<string, NodeOverride>;
}

/** The fields of a layer an override may carry (see NodeOverride) — the look and layout an instance changes of its component's. */
export const OVERRIDABLE = ["fills", "strokes", "cornerRadius", "corners", "effects", "clipsContent", "itemSpacing", "counterSpacing", "paddingTop", "paddingRight", "paddingBottom", "paddingLeft", "primaryAlign", "counterAlign", "layoutWrap"] as const;

export type SceneNode = FrameNode | ShapeNode | TextNode;

/** One of the file's other pages (the first page — the document itself — is the project's page on the site). */
export interface DocumentPage {
  id: string;
  name: string;
  nodes: SceneNode[];
  background?: string;
}

// ── Languages ─────────────────────────────────────────────────────────────────
//
// The file is written in its base language (Turkish: the nodes' own words) and
// translated into the others. English keeps its own fields (charactersEn,
// propsEn, captionEn) as it always had; every language added beyond the two
// keeps its words in a map by language code (translations, propsI18n,
// captionI18n). The helpers below are the one place that knows where a
// language's words are.

/** A language code, lower case ("tr", "en", "de", "pt-br"). */
export type LangCode = string;

export interface Language {
  code: LangCode;
  /** As its speakers write it: "Türkçe", "Deutsch" */
  name: string;
}

export const BASE_LANGUAGE: LangCode = "tr";
export const DEFAULT_LANGUAGES: Language[] = [{ code: "tr", name: "Türkçe" }, { code: "en", name: "English" }];

/** The file's languages, the base first. */
export const languagesOf = (doc: Pick<FigmaDocument, "languages">): Language[] => (doc.languages?.length ? doc.languages : DEFAULT_LANGUAGES);

/**
 * The file's languages that have words of their own on its page (the base always)
 * — a language added but never written in shows nothing but the base's, so
 * the site offers no switch to it.
 */
export function writtenLanguages(doc: FigmaDocument): Language[] {
  const written = new Set<LangCode>([BASE_LANGUAGE]);
  const said = (s: unknown) => typeof s === "string" && s.trim() !== "";
  const visitOverrides = (overrides: Record<string, NodeOverride> | undefined) => {
    for (const o of Object.values(overrides ?? {})) {
      if (said(o.charactersEn)) written.add("en");
      for (const [code, words] of Object.entries(o.translations ?? {})) if (said(words)) written.add(code);
      visitOverrides(o.overrides);
    }
  };
  // The page's own words (its texts, its instances' values and overrides) — not the components' defaults, the same in every project.
  walk(doc.nodes, (n) => {
    if (n.type === "text") {
      if (said(n.charactersEn)) written.add("en");
      for (const [code, words] of Object.entries(n.translations ?? {})) if (said(words)) written.add(code);
      return;
    }
    if (!isFrameLike(n)) return;
    if (Object.values(n.propsEn ?? {}).some(said)) written.add("en");
    for (const [code, words] of Object.entries(n.propsI18n ?? {})) if (Object.values(words).some(said)) written.add(code);
    if (said(n.embed?.captionEn)) written.add("en");
    for (const [code, words] of Object.entries(n.embed?.captionI18n ?? {})) if (said(words)) written.add(code);
    visitOverrides(n.overrides);
  });
  return languagesOf(doc).filter((l) => written.has(l.code));
}

/** A text layer's — or an override's — words in a language; undefined where it has none of its own. */
export function wordsIn(node: Pick<TextNode, "characters" | "charactersEn" | "translations"> | Pick<NodeOverride, "characters" | "charactersEn" | "translations">, lang: LangCode): string | undefined {
  if (lang === BASE_LANGUAGE) return node.characters;
  if (lang === "en") return node.charactersEn;
  return node.translations?.[lang];
}

/** The fields that put `value` as a text layer's (or override's) words in a language. */
export function wordsPatch(node: Pick<TextNode, "translations"> | Pick<NodeOverride, "translations">, lang: LangCode, value: string): { characters: string } | { charactersEn: string } | { translations: Record<string, string> } {
  if (lang === BASE_LANGUAGE) return { characters: value };
  if (lang === "en") return { charactersEn: value };
  return { translations: { ...node.translations, [lang]: value } };
}

/** An instance's words for its text properties in a language (by property id). */
export function propsIn(instance: Pick<FrameNode, "propsEn" | "propsI18n">, lang: LangCode): Record<string, string> | undefined {
  if (lang === "en") return instance.propsEn;
  return instance.propsI18n?.[lang];
}

/** The fields that put `value` as an instance's words for a text property in a language (the base language's are its values: not here). */
export function propsPatch(instance: Pick<FrameNode, "propsEn" | "propsI18n">, lang: LangCode, propId: string, value: string): { propsEn: Record<string, string> } | { propsI18n: Record<string, Record<string, string>> } {
  if (lang === "en") return { propsEn: { ...instance.propsEn, [propId]: value } };
  return { propsI18n: { ...instance.propsI18n, [lang]: { ...instance.propsI18n?.[lang], [propId]: value } } };
}

/** An embed's caption in a language (the base one where it has none). */
export const captionIn = (embed: Pick<Embed, "caption" | "captionEn" | "captionI18n">, lang: LangCode): string | undefined =>
  lang === BASE_LANGUAGE ? embed.caption : (lang === "en" ? embed.captionEn : embed.captionI18n?.[lang]) || embed.caption;

/** The fields that put `value` as an embed's caption in a language. */
export function captionPatch(embed: Pick<Embed, "captionI18n">, lang: LangCode, value: string): { caption: string } | { captionEn: string } | { captionI18n: Record<string, string> } {
  if (lang === BASE_LANGUAGE) return { caption: value };
  if (lang === "en") return { captionEn: value };
  return { captionI18n: { ...embed.captionI18n, [lang]: value } };
}

/** The file without a language: its words in it go too (the base language stays) — but on `keepPage` (the site's library: every project's words, not this one's). */
export function withoutLanguage(doc: FigmaDocument, code: LangCode, keepPage?: string): FigmaDocument {
  if (code === BASE_LANGUAGE) return doc;
  const strip = (node: SceneNode): SceneNode => {
    let next: SceneNode = node;
    if (next.type === "text") {
      const { charactersEn, translations, ...rest } = next;
      const kept = translations ? Object.fromEntries(Object.entries(translations).filter(([k]) => k !== code)) : undefined;
      next = { ...rest, ...(code !== "en" && charactersEn !== undefined ? { charactersEn } : {}), ...(kept && Object.keys(kept).length ? { translations: kept } : {}) } as TextNode;
    } else if (isFrameLike(next)) {
      const { propsEn, propsI18n, ...rest } = next as FrameNode;
      const kept = propsI18n ? Object.fromEntries(Object.entries(propsI18n).filter(([k]) => k !== code)) : undefined;
      const embed = (next as FrameNode).embed;
      const keptCaptions = embed?.captionI18n ? Object.fromEntries(Object.entries(embed.captionI18n).filter(([k]) => k !== code)) : undefined;
      // An override left with nothing in it goes.
      const overrides = (next as FrameNode).overrides && Object.fromEntries(Object.entries((next as FrameNode).overrides!).map(([key, o]) => [key, stripOverride(o)]).filter(([, o]) => Object.keys(o).length));
      next = {
        ...rest,
        ...(code !== "en" && propsEn ? { propsEn } : {}),
        ...(kept && Object.keys(kept).length ? { propsI18n: kept } : {}),
        ...(embed ? { embed: code === "en" ? (({ captionEn, ...e }) => { void captionEn; return e; })(embed) : { ...embed, captionI18n: keptCaptions && Object.keys(keptCaptions).length ? keptCaptions : undefined } } : {}),
        ...(overrides ? { overrides } : {}),
        children: (next as FrameNode).children.map(strip),
      } as FrameNode;
    }
    return next;
  };
  const stripOverride = (o: NodeOverride): NodeOverride => {
    const { charactersEn, translations, overrides, ...rest } = o;
    const kept = translations ? Object.fromEntries(Object.entries(translations).filter(([k]) => k !== code)) : undefined;
    return {
      ...rest,
      ...(code !== "en" && charactersEn !== undefined ? { charactersEn } : {}),
      ...(kept && Object.keys(kept).length ? { translations: kept } : {}),
      ...(overrides ? { overrides: Object.fromEntries(Object.entries(overrides).map(([key, v]) => [key, stripOverride(v)]).filter(([, v]) => Object.keys(v).length)) } : {}),
    };
  };
  return {
    ...doc,
    languages: languagesOf(doc).filter((l) => l.code !== code),
    nodes: doc.nodes.map(strip),
    pages: doc.pages?.map((pg) => (pg.id === keepPage ? pg : { ...pg, nodes: pg.nodes.map(strip) })),
  };
}

export interface FigmaDocument {
  version: 1;
  /** The canvas's top-level nodes, back to front */
  nodes: SceneNode[];
  /** The top-level frame that is the project's page on the site */
  pageId: string;
  /** The canvas's own colour (Figma's page background) */
  background?: string;
  /** The first page's name (the project's) */
  pageName?: string;
  /** The file's other pages, as Figma's: their own canvases */
  pages?: DocumentPage[];
  /** Which page is open in the editor (the first when unset) */
  currentPage?: string;
  /** The file's effect styles */
  effectStyles?: EffectStyle[];
  /** The languages the file is written in (Turkish and English when unset) — the first is the base: its words are the nodes' own, the rest are translations */
  languages?: Language[];
  /** Which starting library its Components page was seeded from (see library.ts) */
  libraryVersion?: number;
  /** Its page was made from the project's page as it was before the Figma editor: the version of what made it (see withLegacyPage) */
  fromLegacy?: number;
}

/** A file as stored, brought up to date: effects made before they had a type are drop shadows. */
export function upgradeDocument(doc: FigmaDocument): FigmaDocument {
  const fix = (node: SceneNode): SceneNode => {
    const next = node.type === "text" ? node : { ...node, effects: node.effects?.map((e) => ("type" in e && e.type ? e : { ...(e as object), type: "dropShadow" } as Effect)) };
    return isFrameLike(next) ? { ...next, children: next.children.map(fix) } : next;
  };
  return { ...doc, nodes: doc.nodes.map(fix) };
}

/** Every node of the file, the open page's first — where components are found, whichever page they sit on (Figma's local components). */
export function libraryOf(doc: FigmaDocument): SceneNode[] {
  const current = doc.currentPage ? doc.pages?.find((p) => p.id === doc.currentPage) : undefined;
  const others = (doc.pages ?? []).filter((p) => p !== current).flatMap((p) => p.nodes);
  return current ? [...current.nodes, ...doc.nodes, ...others] : [...doc.nodes, ...others];
}

/** The page node `id` sits on: "" for the project's page, a page's id otherwise, null when it is nowhere. */
export function pageOfNode(doc: FigmaDocument, id: string): string | null {
  if (findNode(doc.nodes, id)) return "";
  return doc.pages?.find((p) => findNode(p.nodes, id))?.id ?? null;
}

/** The file with node `id` changed by `update`, whichever page it sits on. */
export function updateAnywhere(doc: FigmaDocument, id: string, update: (node: SceneNode) => SceneNode): FigmaDocument {
  const nodes = updateNode(doc.nodes, id, update);
  let pages = doc.pages;
  if (pages) {
    const next = pages.map((p) => {
      const n = updateNode(p.nodes, id, update);
      return n === p.nodes ? p : { ...p, nodes: n };
    });
    if (next.some((p, i) => p !== pages![i])) pages = next;
  }
  return nodes === doc.nodes && pages === doc.pages ? doc : { ...doc, nodes, pages };
}

export const isFrameLike = (node: SceneNode): node is FrameNode =>
  node.type === "frame" || node.type === "component" || node.type === "componentSet" || node.type === "instance";

// ── Ids and factories ─────────────────────────────────────────────────────────

let counter = 0;
export function nid(prefix = "n") {
  counter += 1;
  return `${prefix}${Date.now().toString(36)}${counter.toString(36)}${Math.random().toString(36).slice(2, 5)}`;
}

const own = (value: string | number): VariableValue => ({ value });

const baseFrame = (name: string, x: number, y: number, width: number, height: number): FrameNode => ({
  id: nid(),
  name,
  type: "frame",
  x: Math.round(x),
  y: Math.round(y),
  width: Math.round(width),
  height: Math.round(height),
  children: [],
  // Bound to the site's colours, so the dark theme draws them too (a colour of its own stays the same in both).
  fills: [{ color: { alias: "bg-1" } }],
  strokes: [],
  clipsContent: true,
  layoutMode: "none",
  itemSpacing: own(0),
  paddingTop: own(0),
  paddingRight: own(0),
  paddingBottom: own(0),
  paddingLeft: own(0),
  primaryAlign: "min",
  counterAlign: "min",
});

export const makeFrame = (name: string, x: number, y: number, width: number, height: number): FrameNode => baseFrame(name, x, y, width, height);

export const makeShape = (type: ShapeNode["type"], name: string, x: number, y: number, width: number, height: number): ShapeNode => ({
  id: nid(),
  name,
  type,
  x: Math.round(x),
  y: Math.round(y),
  width: Math.round(width),
  height: type === "line" ? 0 : Math.round(height),
  fills: type === "line" ? [] : [{ color: { alias: "bg-5" } }],
  strokes: type === "line" ? [{ color: { alias: "text-title" }, weight: own(1), align: "center" }] : [],
});

export const makeText = (x: number, y: number, characters = ""): TextNode => ({
  id: nid(),
  name: characters || "Text",
  type: "text",
  x: Math.round(x),
  y: Math.round(y),
  width: 100,
  height: 24,
  characters,
  fontSize: own(16),
  fontWeight: own(400),
  textAlign: "left",
  textAutoResize: "widthHeight",
  fills: [{ color: { alias: "text-title" } }],
});

/** A new file: the project's page — a 1440 × 1024 frame, white, stacking what is put in it (set its height to Sar to grow with it). */
export function newDocument(title: string): FigmaDocument {
  const page = baseFrame(title || "Page", 0, 0, 1440, 1024);
  page.layoutMode = "vertical";
  page.clipsContent = false;
  return { version: 1, nodes: [page], pageId: page.id };
}

// ── The tree ──────────────────────────────────────────────────────────────────

export interface Found {
  node: SceneNode;
  parent: FrameNode | null;
  index: number;
  /** The ids from the top-level node down to it */
  path: string[];
}

/** Every node, depth first, parents before children. */
export function walk(nodes: readonly SceneNode[], visit: (node: SceneNode, parent: FrameNode | null, path: string[]) => void, parent: FrameNode | null = null, path: string[] = []) {
  for (const node of nodes) {
    const here = [...path, node.id];
    visit(node, parent, here);
    if (isFrameLike(node)) walk(node.children, visit, node, here);
  }
}

/** Where each node of a tree is: itself, its parent and its place in it. */
type IndexEntry = { node: SceneNode; parent: FrameNode | null; index: number };

/**
 * The trees indexed by id, each built once and kept while the tree is the
 * same array (the editor never changes a tree in place: a change makes new
 * arrays where it goes) — a lookup is then a map's, not a walk of the file.
 */
const indexes = new WeakMap<readonly SceneNode[], { length: number; first: SceneNode | undefined; map: Map<string, IndexEntry> }>();

function nodeIndex(nodes: readonly SceneNode[]): Map<string, IndexEntry> {
  const cached = indexes.get(nodes);
  if (cached && cached.length === nodes.length && cached.first === nodes[0]) return cached.map;
  const map = new Map<string, IndexEntry>();
  const visit = (list: readonly SceneNode[], parent: FrameNode | null) => {
    for (let index = 0; index < list.length; index++) {
      const node = list[index];
      // The first one of an id, depth first (as a walk would find it).
      if (!map.has(node.id)) map.set(node.id, { node, parent, index });
      if (isFrameLike(node)) visit(node.children, node);
    }
  };
  visit(nodes, null);
  indexes.set(nodes, { length: nodes.length, first: nodes[0], map });
  return map;
}

export function findNode(nodes: readonly SceneNode[], id: string): Found | null {
  const index = nodeIndex(nodes);
  const entry = index.get(id);
  if (!entry) return null;
  const path = [id];
  for (let p = entry.parent; p; p = index.get(p.id)?.parent ?? null) path.unshift(p.id);
  return { node: entry.node, parent: entry.parent, index: entry.index, path };
}

export const getNode = (nodes: readonly SceneNode[], id: string) => nodeIndex(nodes).get(id)?.node ?? null;

/** The tree with node `id` replaced by `update(node)` — the same arrays where nothing changed. */
export function updateNode(nodes: SceneNode[], id: string, update: (node: SceneNode) => SceneNode): SceneNode[] {
  let changed = false;
  const next = nodes.map((node) => {
    if (node.id === id) {
      const updated = update(node);
      if (updated !== node) changed = true;
      return updated;
    }
    if (isFrameLike(node)) {
      const children = updateNode(node.children, id, update);
      if (children !== node.children) {
        changed = true;
        return { ...node, children };
      }
    }
    return node;
  });
  return changed ? next : nodes;
}

/** Several nodes changed at once. */
export function updateNodes(nodes: SceneNode[], ids: readonly string[], update: (node: SceneNode) => SceneNode): SceneNode[] {
  return ids.reduce((list, id) => updateNode(list, id, update), nodes);
}

export function removeNodes(nodes: SceneNode[], ids: ReadonlySet<string>): SceneNode[] {
  return nodes
    .filter((node) => !ids.has(node.id))
    .map((node) => (isFrameLike(node) ? { ...node, children: removeNodes(node.children, ids) } : node));
}

/**
 * `node` put into `parentId`'s children (null: the canvas) at `index` (the
 * end when unset) — named apart from them ("Card 2" beside a "Card"): an
 * instance's overrides and its layers' ids inside it go by name path, so no
 * two layers of a frame may share one.
 */
export function insertNode(nodes: SceneNode[], parentId: string | null, node: SceneNode, index?: number): SceneNode[] {
  const put = (list: SceneNode[]) => {
    const next = [...list];
    const name = freeName(node.name, list);
    next.splice(index === undefined || index < 0 || index > list.length ? list.length : index, 0, name === node.name ? node : { ...node, name });
    return next;
  };
  if (!parentId) return put(nodes);
  return updateNode(nodes, parentId, (parent) => (isFrameLike(parent) ? { ...parent, children: put(parent.children) } : parent));
}

/**
 * A copy with fresh ids, everywhere in it — a layer like any other (a copy of
 * the Overview is not the project's), unless `keepParts`: a variant of the
 * Overview's component is as much its as the first (see overview.ts).
 */
export function cloneNode<T extends SceneNode>(node: T, keepParts = false): T {
  const copy = structuredClone(node) as T;
  const ids = new Map<string, string>();
  const rename = (n: SceneNode) => {
    const id = nid();
    ids.set(n.id, id);
    n.id = id;
    if (!keepParts) delete n.fixed;
    if (isFrameLike(n)) n.children.forEach(rename);
  };
  rename(copy);
  // A copied set's prototype: its variants' reactions go to the copies' variants (a reaction to one outside it stays as it is).
  walk([copy], (n) => {
    if (n.reactions?.length) n.reactions = n.reactions.map((r) => ({ ...r, id: nid("r"), target: ids.get(r.target) ?? r.target }));
  });
  return copy;
}

/** The nodes in `ids` that have no ancestor in `ids` — what a multi-selection moves as one. */
export function topmost(nodes: readonly SceneNode[], ids: readonly string[]): Found[] {
  const set = new Set(ids);
  return ids
    .map((id) => findNode(nodes, id))
    .filter((f): f is Found => Boolean(f))
    .filter((f) => !f.path.slice(0, -1).some((ancestor) => set.has(ancestor)));
}

/** Is `node` (or a frame it sits in) locked? */
export function isLocked(nodes: readonly SceneNode[], id: string) {
  const found = findNode(nodes, id);
  if (!found) return false;
  return found.path.some((pid) => getNode(nodes, pid)?.locked);
}

/** A layer's name as it may be kept: "/" and "›" separate the composite ids and name paths layers inside instances are known by — they become "∕" and ">". */
export const layerName = (name: string) => name.replace(/\//g, "∕").replace(/›/g, ">");

/** `base`, or `base 2`, `base 3`… — a name no sibling (no other variable, text style…) has. */
export function freeName(base: string, siblings: readonly { name: string }[]) {
  const names = new Set(siblings.map((s) => s.name));
  if (!names.has(base)) return base;
  for (let n = 2; ; n++) if (!names.has(`${base} ${n}`)) return `${base} ${n}`;
}

/** The next "Frame 3" after "Frame 2", counting the whole file — as Figma numbers what it draws. */
export function nextName(nodes: readonly SceneNode[], base: string) {
  let max = 0;
  const re = new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} (\\d+)$`);
  walk(nodes, (node) => {
    const m = node.name.match(re);
    if (m) max = Math.max(max, Number(m[1]));
  });
  return `${base} ${max + 1}`;
}

// ── Components ────────────────────────────────────────────────────────────────

/** Every component in the file (a set's variants included), with the set holding it. */
export function allComponents(nodes: readonly SceneNode[]): { component: FrameNode; set: FrameNode | null }[] {
  const out: { component: FrameNode; set: FrameNode | null }[] = [];
  walk(nodes, (node, parent) => {
    if (node.type === "component") out.push({ component: node, set: parent?.type === "componentSet" ? parent : null });
  });
  return out;
}

export const findComponent = (nodes: readonly SceneNode[], id: string): FrameNode | null => {
  const node = getNode(nodes, id);
  return node && node.type === "component" ? node : null;
};

/** The set a variant is in, or null. */
export function setOf(nodes: readonly SceneNode[], componentId: string): FrameNode | null {
  const parent = nodeIndex(nodes).get(componentId)?.parent;
  return parent?.type === "componentSet" ? parent : null;
}

/** A set's variants, in their order. */
export const variantsOf = (set: FrameNode) => set.children.filter((c): c is FrameNode => c.type === "component");

export const variantValue = (variant: FrameNode, property: string) => variant.variant?.find((v) => v.property === property)?.value ?? "";

/** A set's properties and each one's values, from its variants (in the order they appear). */
export function variantProperties(set: FrameNode): { name: string; values: string[] }[] {
  const props: { name: string; values: string[] }[] = [];
  for (const v of variantsOf(set)) {
    for (const { property, value } of v.variant ?? []) {
      let p = props.find((x) => x.name === property);
      if (!p) {
        p = { name: property, values: [] };
        props.push(p);
      }
      if (!p.values.includes(value)) p.values.push(value);
    }
  }
  return props;
}

/** Where a component's properties are defined: its set, when it is a variant; itself otherwise. */
export function propertyHolder(nodes: readonly SceneNode[], componentId: string): FrameNode | null {
  const component = findComponent(nodes, componentId);
  if (!component) return null;
  return setOf(nodes, component.id) ?? component;
}

/** A component's properties (its set's, for a variant). */
export const propertiesOf = (nodes: readonly SceneNode[], componentId: string): ComponentProperty[] => propertyHolder(nodes, componentId)?.properties ?? [];

/** An instance's values of its component's properties: the defaults, the instance's own over them. */
export function propertyValues(nodes: readonly SceneNode[], main: FrameNode, instance: Pick<FrameNode, "props">): PropertyValues {
  const values: PropertyValues = {};
  for (const p of propertiesOf(nodes, main.id)) values[p.id] = p.value;
  for (const [id, v] of Object.entries(instance.props ?? {})) if (id in values) values[id] = v;
  return values;
}

/** The main component a node sits in (itself, when it is one), with where its properties live — null outside main components. */
export function componentAround(nodes: readonly SceneNode[], id: string): { component: FrameNode; holder: FrameNode } | null {
  const found = findNode(nodes, id);
  if (!found) return null;
  for (let i = found.path.length - 1; i >= 0; i--) {
    const n = getNode(nodes, found.path[i]);
    if (n?.type === "component") return { component: n, holder: setOf(nodes, n.id) ?? n };
  }
  return null;
}

/** A property name no other of the holder's has: `base`, else `base 2`, `base 3`… */
export function freePropertyName(holder: FrameNode, base: string) {
  const names = new Set((holder.properties ?? []).map((p) => p.name));
  for (const p of variantProperties(holder)) names.add(p.name);
  if (!names.has(base)) return base;
  for (let n = 2; ; n++) if (!names.has(`${base} ${n}`)) return `${base} ${n}`;
}

/** `holder` with every layer bound to property `id` given `value`: shown or hidden, its words, its component. */
export function applyPropertyValue(holder: FrameNode, id: string, value: string | boolean): FrameNode {
  const visit = (n: SceneNode): SceneNode => {
    let next = n;
    if (n.visibleProp === id) next = { ...next, visible: value ? undefined : false };
    if (next.type === "text" && next.charactersProp === id && typeof value === "string") next = { ...next, characters: value };
    if (next.type === "instance" && next.mainProp === id && typeof value === "string") next = { ...next, mainId: value };
    return isFrameLike(next) ? { ...next, children: next.children.map(visit) } : next;
  };
  return visit(holder) as FrameNode;
}

/** `holder` with its layers' bindings to properties not in `keep` taken off. */
export function pruneBindings(holder: FrameNode, keep: ReadonlySet<string>): FrameNode {
  const visit = (n: SceneNode): SceneNode => {
    let next = n;
    if (n.visibleProp && !keep.has(n.visibleProp)) next = { ...next, visibleProp: undefined };
    if (next.type === "text" && next.charactersProp && !keep.has(next.charactersProp)) next = { ...next, charactersProp: undefined };
    if (next.type === "instance" && next.mainProp && !keep.has(next.mainProp)) next = { ...next, mainProp: undefined };
    return isFrameLike(next) ? { ...next, children: next.children.map(visit) } : next;
  };
  return visit(holder) as FrameNode;
}

/** A variant's name, as Figma shows it: "State=Hover, Size=Large". */
export const variantName = (variant: FrameNode) => (variant.variant?.length ? variant.variant.map((v) => `${v.property}=${v.value}`).join(", ") : variant.name);

/** The variant of `set` closest to `current` with `property` set to `value` (the one sharing the most other values). */
export function pickVariant(set: FrameNode, current: FrameNode, property: string, value: string): FrameNode {
  const variants = variantsOf(set);
  const scored = variants
    .filter((v) => variantValue(v, property) === value)
    .map((v) => ({ v, score: (current.variant ?? []).filter((cv) => cv.property !== property && variantValue(v, cv.property) === cv.value).length }))
    .sort((a, b) => b.score - a.score);
  return scored[0]?.v ?? current;
}

/** A layer's path of names inside a component ("Card›Title"), the key its overrides are kept under. */
export const PATH_SEP = "›";
export function namePath(component: FrameNode, id: string): string | null {
  const search = (list: SceneNode[], path: string[]): string | null => {
    for (const child of list) {
      const here = [...path, child.name];
      if (child.id === id) return here.join(PATH_SEP);
      if (isFrameLike(child)) {
        const found = search(child.children, here);
        if (found) return found;
      }
    }
    return null;
  };
  return search(component.children, []);
}

/**
 * An instance drawn: its main component's frame (the instance's own place,
 * size and sizing over it) and children, the instance's overrides applied by
 * name path. `mainId` may name a set's variant the instance turned into.
 */
export function resolveInstance(nodes: readonly SceneNode[], instance: FrameNode, shownId?: string): FrameNode | null {
  const main = findComponent(nodes, shownId ?? instance.mainId ?? "");
  if (!main) return null;
  const overrides = instance.overrides ?? {};
  const values = propertyValues(nodes, main, instance);
  const valuesEn = instance.propsEn ?? {};
  const valuesI18n = instance.propsI18n;
  // A layer bound to a property: shown by a boolean, worded by a text, swapped by an instance swap.
  const applyProps = <T extends SceneNode>(node: T): T => {
    let next = node;
    if (node.visibleProp && node.visibleProp in values) next = { ...next, visible: Boolean(values[node.visibleProp]) };
    if (next.type === "text" && next.charactersProp && typeof values[next.charactersProp] === "string") {
      const prop = next.charactersProp;
      // Its words the instance's — in a language it has none of its own in, the component's own (its default's) while the instance
      // keeps the default's words too; words of its own untranslated show as they are (see textOf).
      const ownBase = instance.props?.[prop] !== undefined;
      const text = next as TextNode;
      const translations = { ...(ownBase ? {} : text.translations ?? {}), ...Object.fromEntries(Object.entries(valuesI18n ?? {}).flatMap(([code, words]) => (words[prop] !== undefined ? [[code, words[prop]]] : []))) };
      next = { ...next, characters: values[prop] as string, charactersEn: valuesEn[prop] ?? (ownBase ? undefined : text.charactersEn), translations: Object.keys(translations).length ? translations : undefined } as T;
    }
    if (next.type === "instance" && (next as FrameNode).mainProp) {
      const id = values[(next as FrameNode).mainProp!];
      if (typeof id === "string" && findComponent(nodes, id)) next = { ...next, mainId: id } as T;
    }
    return next;
  };
  const applyOverride = <T extends SceneNode>(node: T, key: string): T => {
    const o = overrides[key];
    if (!o) return node;
    const next = { ...node } as T;
    if (o.visible !== undefined) next.visible = o.visible;
    if (o.opacity !== undefined) next.opacity = o.opacity;
    if (next.type === "text") {
      if (o.characters !== undefined) (next as TextNode).characters = o.characters;
      if (o.charactersEn !== undefined) (next as TextNode).charactersEn = o.charactersEn;
      if (o.translations) (next as TextNode).translations = { ...(next as TextNode).translations, ...o.translations };
      if (o.fills) (next as TextNode).fills = o.fills;
    } else {
      const own = next as unknown as Record<string, unknown>;
      // Its look (a shape's, a frame's), and a frame's layout.
      for (const key of OVERRIDABLE) {
        if (o[key] === undefined) continue;
        if (!isFrameLike(next) && !(key === "fills" || key === "strokes" || key === "cornerRadius" || key === "corners" || key === "effects")) continue;
        own[key] = o[key];
      }
      // A nested instance: the outer instance's overrides of it over its own.
      if (o.overrides && next.type === "instance") (next as FrameNode).overrides = mergeOverrides((next as FrameNode).overrides, o.overrides);
    }
    return next;
  };
  const children = (list: SceneNode[], path: string): SceneNode[] =>
    list.map((child) => {
      const key = path ? `${path}${PATH_SEP}${child.name}` : child.name;
      const applied = applyOverride(applyProps(child), key);
      return isFrameLike(applied) && applied.type !== "instance" ? { ...applied, children: children(applied.children, key) } : applied;
    });
  const self = applyOverride(main, "");
  return {
    ...self,
    id: instance.id,
    name: instance.name,
    type: "instance",
    x: instance.x,
    y: instance.y,
    width: instance.width,
    height: instance.height,
    rotation: instance.rotation,
    flipH: instance.flipH,
    flipV: instance.flipV,
    opacity: instance.opacity ?? self.opacity,
    blendMode: instance.blendMode ?? self.blendMode,
    absolute: instance.absolute,
    lockAspect: instance.lockAspect,
    locked: instance.locked,
    visible: instance.visible,
    sizingH: instance.sizingH,
    sizingV: instance.sizingV,
    minWidth: instance.minWidth,
    maxWidth: instance.maxWidth,
    minHeight: instance.minHeight,
    maxHeight: instance.maxHeight,
    widthVar: instance.widthVar,
    heightVar: instance.heightVar,
    href: instance.href,
    gridCol: instance.gridCol,
    gridRow: instance.gridRow,
    gridSpan: instance.gridSpan,
    narrow: instance.narrow ?? self.narrow,
    variant: undefined,
    reactions: undefined,
    mainId: instance.mainId,
    overrides: instance.overrides,
    children: children(main.children, ""),
  };
}

/** `over` on top of `base`, key by key (nested maps merged too). */
export function mergeOverrides(base: Record<string, NodeOverride> | undefined, over: Record<string, NodeOverride>): Record<string, NodeOverride> {
  const out: Record<string, NodeOverride> = { ...(base ?? {}) };
  for (const [key, o] of Object.entries(over)) {
    const b = out[key];
    out[key] = b ? { ...b, ...o, ...(b.overrides || o.overrides ? { overrides: mergeOverrides(b.overrides, o.overrides ?? {}) } : {}) } : o;
  }
  return out;
}

/**
 * An instance's overrides with `patch` on the layer at `keys` — a name path,
 * then one more per nested instance ("Card" → "Label" for the Label of a
 * Card inside a Project info). Cleared values (undefined) come off; an
 * emptied override goes.
 */
export function withOverride(overrides: Record<string, NodeOverride> | undefined, keys: readonly string[], patch: NodeOverride): Record<string, NodeOverride> | undefined {
  const [key, ...rest] = keys;
  const current = { ...(overrides?.[key] ?? {}) } as Record<string, unknown>;
  if (rest.length) current.overrides = withOverride(current.overrides as Record<string, NodeOverride> | undefined, rest, patch);
  else Object.assign(current, patch);
  Object.keys(current).forEach((k) => current[k] === undefined && delete current[k]);
  const next = { ...overrides, [key]: current as NodeOverride };
  if (!Object.keys(current).length) delete next[key];
  return Object.keys(next).length ? next : undefined;
}

/** The override an instance holds at these keys (a nested one's through its outer's), as stored. */
export function overrideAt(overrides: Record<string, NodeOverride> | undefined, keys: readonly string[]): NodeOverride | undefined {
  let at: NodeOverride | undefined;
  let level = overrides;
  for (const key of keys) {
    at = level?.[key];
    level = at?.overrides;
  }
  return at;
}

/**
 * The layer a composite id names — "instanceId/Kart›Etiket", one "/" more per
 * nested instance ("instanceId/Kart/Etiket") — as it is drawn (its overrides
 * applied), with the instance holding it and the keys its override sits under.
 */
export function layerAt(nodes: readonly SceneNode[], compositeId: string): { instance: FrameNode; node: SceneNode; keys: string[] } | null {
  const slash = compositeId.indexOf("/");
  if (slash < 0) return null;
  const instance = getNode(nodes, compositeId.slice(0, slash));
  if (!instance || instance.type !== "instance") return null;
  const keys = compositeId.slice(slash + 1).split("/");
  let holder: FrameNode | null = resolveInstance(nodes, instance);
  let node: SceneNode | null = null;
  for (let i = 0; i < keys.length && holder; i++) {
    let list: SceneNode[] = holder.children;
    node = null;
    for (const name of keys[i].split(PATH_SEP)) {
      node = list.find((c) => c.name === name) ?? null;
      list = node && isFrameLike(node) ? node.children : [];
    }
    holder = node?.type === "instance" && i < keys.length - 1 ? resolveInstance(nodes, node) : null;
  }
  return node ? { instance, node, keys } : null;
}

/**
 * The file with layer `id` renamed (apart from its siblings, without the
 * separators — see layerName) — and, when it sits in a main component, every
 * instance's overrides of it (and of what is inside it), anywhere in the
 * file, nested ones too, kept under its new name path.
 */
export function withRenamedLayer(doc: FigmaDocument, id: string, wanted: string): FigmaDocument {
  const all = libraryOf(doc);
  const found = findNode(all, id);
  if (!found) return doc;
  const siblings = (found.parent ? found.parent.children : []).filter((n) => n.id !== id);
  const top = found.path.length === 1;
  const name = freeName(top && (found.node.type === "component" || found.node.type === "componentSet") ? wanted.trim() : layerName(wanted.trim()), siblings);
  if (!name || name === found.node.name) return doc;
  const renamed = updateAnywhere(doc, id, (n) => ({ ...n, name }));
  const around = componentAround(all, id);
  if (!around || around.component.id === id) return renamed;
  const from = namePath(around.component, id);
  if (!from) return renamed;
  const to = [...from.split(PATH_SEP).slice(0, -1), name].join(PATH_SEP);
  const moved = (key: string) => (key === from ? to : key.startsWith(from + PATH_SEP) ? to + key.slice(from.length) : key);
  const lib = libraryOf(renamed);
  /** Overrides of an instance of `mainId`, their keys moved where they are the renamed layer's, nested instances' through theirs. */
  const migrate = (overrides: Record<string, NodeOverride>, mainId: string | undefined): Record<string, NodeOverride> => {
    const main = mainId ? findComponent(lib, mainId) : null;
    let changed = false;
    const out: Record<string, NodeOverride> = {};
    for (const [key, o] of Object.entries(overrides)) {
      const k = mainId === around.component.id ? moved(key) : key;
      let next = o;
      if (o.overrides && main) {
        // The nested instance this key names, in the main component (as it is now: renamed).
        const at = layerByPath(main, k);
        const inner = at?.type === "instance" ? migrate(o.overrides, at.mainId) : o.overrides;
        if (inner !== o.overrides) next = { ...o, overrides: inner };
      }
      if (k !== key || next !== o) changed = true;
      out[k] = next;
    }
    return changed ? out : overrides;
  };
  const fix = (n: SceneNode): SceneNode => {
    let next = n;
    if (n.type === "instance" && n.overrides) {
      const overrides = migrate(n.overrides, n.mainId);
      if (overrides !== n.overrides) next = { ...n, overrides };
    }
    if (isFrameLike(next)) {
      const children = next.children.map(fix);
      if (children.some((c, i) => c !== (next as FrameNode).children[i])) next = { ...next, children };
    }
    return next;
  };
  return { ...renamed, nodes: renamed.nodes.map(fix), pages: renamed.pages?.map((p) => ({ ...p, nodes: p.nodes.map(fix) })) };
}

/** The layer at a name path inside a component, as stored. */
function layerByPath(component: FrameNode, path: string): SceneNode | null {
  let list: SceneNode[] = component.children;
  let node: SceneNode | null = null;
  for (const name of path.split(PATH_SEP)) {
    node = list.find((c) => c.name === name) ?? null;
    if (!node) return null;
    list = isFrameLike(node) ? node.children : [];
  }
  return node;
}

/** An instance of `component`, at `x`, `y` — its size the component's. */
export function makeInstance(component: FrameNode, x: number, y: number): FrameNode {
  return {
    ...baseFrame(component.name, x, y, component.width, component.height),
    type: "instance",
    mainId: component.id,
    sizingH: component.sizingH,
    sizingV: component.sizingV,
    fills: [],
    strokes: [],
    layoutMode: component.layoutMode,
  };
}

// ── Variables ─────────────────────────────────────────────────────────────────

export const byIdMap = (variables: readonly DesignVariable[]) => new Map(variables.map((v) => [v.id, v]));

/** A value's own number (a bound one resolved, in the light theme) — for the editor's arithmetic. */
export function numberOf(value: VariableValue | undefined, byId: Map<string, DesignVariable>, fallback = 0): number {
  if (!value) return fallback;
  if (!("alias" in value)) return Number(value.value) || 0;
  const v = byId.get(value.alias);
  if (!v) return fallback;
  const seen = new Set<string>();
  let current: VariableValue = v.light;
  while ("alias" in current) {
    if (seen.has(current.alias)) return fallback;
    seen.add(current.alias);
    const next = byId.get(current.alias);
    if (!next) return fallback;
    current = next.light;
  }
  return Number(current.value) || 0;
}

// ── Resetting and pushing an instance's changes (Figma's Reset ▸ / Push changes to main component) ──

/** What an instance's changes are, by name — the rows of Figma's Reset menu — and the fields each is made of. */
export const OVERRIDE_GROUPS: { label: string; fields: (keyof NodeOverride)[] }[] = [
  { label: "Text", fields: ["characters", "charactersEn", "translations"] },
  { label: "Visibility", fields: ["visible"] },
  { label: "Fill", fields: ["fills"] },
  { label: "Stroke", fields: ["strokes"] },
  { label: "Opacity", fields: ["opacity"] },
  { label: "Corner radius", fields: ["cornerRadius", "corners"] },
  { label: "Effects", fields: ["effects"] },
  { label: "Clip content", fields: ["clipsContent"] },
  { label: "Auto layout", fields: ["itemSpacing", "counterSpacing", "paddingTop", "paddingRight", "paddingBottom", "paddingLeft", "primaryAlign", "counterAlign", "layoutWrap"] },
];

/** The kinds of change these overrides make — their layers', nested instances' too — in the menu's order. */
export function overriddenGroups(overrides: Record<string, NodeOverride> | undefined): string[] {
  const found = new Set<string>();
  const visit = (o: NodeOverride) => {
    for (const g of OVERRIDE_GROUPS) if (g.fields.some((f) => o[f] !== undefined)) found.add(g.label);
    Object.values(o.overrides ?? {}).forEach(visit);
  };
  Object.values(overrides ?? {}).forEach(visit);
  return OVERRIDE_GROUPS.filter((g) => found.has(g.label)).map((g) => g.label);
}

/** An override without one kind of change — in it and in the nested ones; emptied ones go. */
function withoutGroupIn(o: NodeOverride, label: string): NodeOverride {
  const fields = new Set<string>(OVERRIDE_GROUPS.find((g) => g.label === label)?.fields ?? []);
  const next = Object.fromEntries(Object.entries(o).filter(([k]) => !fields.has(k) && k !== "overrides")) as NodeOverride;
  const nested = o.overrides ? withoutGroup(o.overrides, label) : undefined;
  return nested ? { ...next, overrides: nested } : next;
}

/** The overrides without one kind of change (every layer's) — or, no `label`, without any. */
export function withoutGroup(overrides: Record<string, NodeOverride> | undefined, label?: string): Record<string, NodeOverride> | undefined {
  if (!overrides || !label) return undefined;
  const out: Record<string, NodeOverride> = {};
  for (const [key, o] of Object.entries(overrides)) {
    const next = withoutGroupIn(o, label);
    if (Object.keys(next).length) out[key] = next;
  }
  return Object.keys(out).length ? out : undefined;
}

/** The overrides with the layer at `keys` reset: one kind of change of it (and of what it holds), or — no `label` — all of them. */
export function withResetAt(overrides: Record<string, NodeOverride> | undefined, keys: readonly string[], label?: string): Record<string, NodeOverride> | undefined {
  const [key, ...rest] = keys;
  const current = overrides?.[key];
  if (!overrides || !current) return overrides;
  let next: NodeOverride | undefined;
  if (rest.length) {
    const inner = withResetAt(current.overrides, rest, label);
    next = { ...current };
    if (inner) next.overrides = inner;
    else delete next.overrides;
  } else next = label ? withoutGroupIn(current, label) : undefined;
  const out = { ...overrides };
  if (next && Object.keys(next).length) out[key] = next;
  else delete out[key];
  return Object.keys(out).length ? out : undefined;
}

/**
 * The main component with an instance's changes in it (Figma's Push changes
 * to main component): each override put on the layer it names (the key ""
 * the component's own frame; a nested instance's own overrides merged into
 * that instance's) — every instance then shows them.
 */
export function withPushedOverrides(main: FrameNode, overrides: Record<string, NodeOverride>): FrameNode {
  const apply = (node: SceneNode, o: NodeOverride): SceneNode => {
    const { overrides: nested, ...fields } = o;
    let next = { ...node, ...fields } as SceneNode;
    if (nested && next.type === "instance") next = { ...next, overrides: mergeOverrides(next.overrides, nested) };
    return next;
  };
  let out: FrameNode = main;
  for (const [key, o] of Object.entries(overrides)) {
    if (key === "") {
      out = apply(out, o) as FrameNode;
      continue;
    }
    const target = layerByPath(out, key);
    if (!target) continue;
    const replace = (list: SceneNode[]): SceneNode[] => list.map((c) => (c === target ? apply(c, o) : isFrameLike(c) ? { ...c, children: replace(c.children) } : c));
    out = { ...out, children: replace(out.children) };
  }
  return out;
}

/**
 * What an instance — or a layer inside one (a composite id) — has changed of
 * its main component's: the rows of Figma's Reset menu. A property's value
 * set on the instance is a row of its own (its key "prop:<id>").
 */
export function changesAt(nodes: readonly SceneNode[], id: string): { key: string; label: string }[] {
  if (id.includes("/")) {
    const at = layerAt(nodes, id);
    const o = at ? overrideAt(at.instance.overrides, at.keys) : undefined;
    return o ? overriddenGroups({ o }).map((label) => ({ key: label, label })) : [];
  }
  const node = getNode(nodes, id);
  if (!node || node.type !== "instance") return [];
  const own = overriddenGroups(node.overrides).map((label) => ({ key: label, label }));
  const props = node.mainId ? propertiesOf(nodes, node.mainId) : [];
  const set = new Set([...Object.keys(node.props ?? {}), ...Object.keys(node.propsEn ?? {}), ...Object.values(node.propsI18n ?? {}).flatMap((w) => Object.keys(w))]);
  const named = props.filter((p) => set.has(p.id)).map((p) => ({ key: `prop:${p.id}`, label: p.name }));
  return [...named, ...own];
}

/** An instance without one of its changes (see changesAt) — or, no `key`, without any. */
export function withoutChange(instance: FrameNode, key?: string): FrameNode {
  if (!key) return { ...instance, overrides: undefined, props: undefined, propsEn: undefined, propsI18n: undefined };
  if (key.startsWith("prop:")) {
    const id = key.slice(5);
    const drop = <T,>(r: Record<string, T> | undefined) => {
      if (!r) return undefined;
      const { [id]: gone, ...rest } = r;
      void gone;
      return Object.keys(rest).length ? rest : undefined;
    };
    const i18n = instance.propsI18n ? Object.fromEntries(Object.entries(instance.propsI18n).map(([lang, words]) => [lang, drop(words)]).filter(([, w]) => w)) : undefined;
    return { ...instance, props: drop(instance.props), propsEn: drop(instance.propsEn), propsI18n: i18n && Object.keys(i18n).length ? i18n : undefined };
  }
  return { ...instance, overrides: withoutGroup(instance.overrides, key) };
}

// ── A variant's layer name (Figma's "Property=Value, Property 2=Value") ──────

/** A variant's row in the layers, as Figma shows it: its values — a True/False one with its property ("iconOnly=False"), alone it says nothing. */
export const variantLabel = (variant: FrameNode) =>
  (variant.variant ?? []).map((v) => (/^(true|false)$/i.test(v.value) ? `${v.property}=${v.value}` : v.value)).join(", ");

/**
 * A variant's typed name read as its properties: "State=active, Size=lg" —
 * or, its values alone, in the set's properties' order ("active, lg"). Null
 * when it isn't one (Figma's "This layer has an invalid name"): a part
 * without a property or a value, a property named twice.
 */
export function parseVariantName(name: string, properties: readonly string[]): { property: string; value: string }[] | null {
  const parts = name.split(",").map((p) => p.trim()).filter(Boolean);
  if (!parts.length) return null;
  if (parts.every((p) => p.includes("="))) {
    const pairs = parts.map((p) => {
      const at = p.indexOf("=");
      return { property: p.slice(0, at).trim(), value: p.slice(at + 1).trim() };
    });
    if (pairs.some((p) => !p.property || !p.value || p.value.includes("="))) return null;
    if (new Set(pairs.map((p) => p.property)).size !== pairs.length) return null;
    return pairs;
  }
  if (parts.some((p) => p.includes("=")) || parts.length !== properties.length) return null;
  return parts.map((value, i) => ({ property: properties[i], value }));
}

/**
 * The set with one variant's properties as its name says (see
 * parseVariantName): the values it names set, the properties it leaves out
 * kept as they were, and a property new to the set given to every other
 * variant too — with the value this one has — so each still has all of them.
 */
export function withVariantName(set: FrameNode, variantId: string, pairs: readonly { property: string; value: string }[]): FrameNode {
  const known = new Set(variantProperties(set).map((p) => p.name));
  const added = pairs.filter((p) => !known.has(p.property));
  const children = set.children.map((c) => {
    if (c.type !== "component") return c;
    if (c.id === variantId) {
      const named = new Map(pairs.map((p) => [p.property, p.value]));
      const kept = (c.variant ?? []).map((v) => (named.has(v.property) ? { ...v, value: named.get(v.property)! } : v));
      const variant = [...kept, ...added];
      const next = { ...c, variant };
      return { ...next, name: variantName(next) };
    }
    return added.length ? { ...c, variant: [...(c.variant ?? []), ...added] } : c;
  });
  return { ...set, children };
}
