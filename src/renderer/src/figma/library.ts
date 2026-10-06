import type { VariableValue } from "@/types/design";
import { STARTING_TEXT_STYLES } from "@/components/project/textStyles";
import { isFrameLike, nid, type ComponentProperty, type FrameNode, type PropertyType, type PropertyValues, type Reaction, type SceneNode, type ShapeNode, type TextNode } from "./model";

/**
 * The site's starting components, as Figma's local components: every kind of
 * layer the old pages held (a Heading, a Project info, an Image, Steps…) and
 * the items those repeat (a Card, a Metric, a Step…) — each drawing what the
 * site's code drew before them (the same auto layouts, spacing, corners,
 * fills bound to the design variables, texts in the text styles), with
 * Figma's component properties: their texts bound to text properties, their
 * optional parts to booleans, their states as variants. They sit on a
 * "Components" page of every file; an instance of one goes on the project's
 * page from Assets.
 *
 * Their ids are fixed (c-…). They seed the site's library — every
 * project's components (see systemLibrary.ts); LIBRARY_VERSION bumps when
 * they change, and the library gets the current ones — those the user left
 * as they were seeded; a starting component the user edited stays.
 *
 * Versions: 2 — English names, component properties; 3 — Image and Gallery
 * item in ratio variants, List item in marker variants, the quote mark a
 * frame, media keeping their proportions; 4 — component sets as wide as
 * their variants (a Fill variant in a hugging set had no width to fill);
 * 5 — the Overview (the page's first section: see overview.ts).
 */

export const COMPONENTS_PAGE_ID = "p-components";

/** The example a new project's Overview opens with, to fill in (see page.ts). */
export const TEMPLATE_OVERVIEW = {
  category: "UX / UI Design",
  description: "Projeyi tek cümlede özetleyin: ne yapıldı, kimin için ve hangi sonucu doğurdu. Bu metin sayfanın en üstünde, kapak görselinin hemen üzerinde görünür.",
};
export const COMPONENTS_PAGE_NAME = "Components";
export const LIBRARY_VERSION = 5;

/** The site's content column: what a page-level component fills. */
const CONTENT = 940;

const v = (value: string | number): VariableValue => ({ value });
const a = (alias: string): VariableValue => ({ alias });

const fill = (color: string) => [{ color: a(color) }];
const stroke = (color: string, weight = 1, align: "inside" | "center" | "outside" = "inside") => [{ color: a(color), weight: v(weight), align }];

const prop = (id: string, name: string, type: PropertyType, value: string | boolean): ComponentProperty => ({ id, name, type, value });
const textProp = (id: string, name: string, value: string) => prop(id, name, "text", value);
const boolProp = (id: string, name: string, value = true) => prop(id, name, "boolean", value);

type Layout = Partial<Pick<FrameNode, "layoutMode" | "itemSpacing" | "counterSpacing" | "primaryAlign" | "counterAlign" | "layoutWrap" | "baselineAlign" | "gridColumns">> & {
  gap?: number;
  rowGap?: number;
  /** Padding: one for all, [y, x], or [top, right, bottom, left] */
  padding?: number | [number, number] | [number, number, number, number];
};

const paddings = (p: Layout["padding"]) => {
  const [t, r, b, l] = p === undefined ? [0, 0, 0, 0] : typeof p === "number" ? [p, p, p, p] : p.length === 2 ? [p[0], p[1], p[0], p[1]] : p;
  return { paddingTop: v(t), paddingRight: v(r), paddingBottom: v(b), paddingLeft: v(l) };
};

type FrameExtra = Partial<Omit<FrameNode, "children" | "type" | "id" | "name">>;

let ids = 0;
const fresh = (base: string) => `${base}-${(ids++).toString(36)}`;

/** A frame with auto layout (vertical unless said), hugging its height; transparent unless filled. */
function frame(name: string, layout: Layout, children: SceneNode[], extra: FrameExtra = {}, id = fresh("f")): FrameNode {
  const { gap = 0, rowGap, padding, layoutMode = "vertical", ...rest } = layout;
  return {
    id,
    name,
    type: "frame",
    x: 0,
    y: 0,
    width: CONTENT,
    height: 100,
    children,
    fills: [],
    strokes: [],
    clipsContent: false,
    layoutMode,
    itemSpacing: v(gap),
    ...(rowGap !== undefined ? { counterSpacing: v(rowGap) } : {}),
    ...paddings(padding),
    primaryAlign: "min",
    counterAlign: "min",
    sizingH: "fill",
    sizingV: "hug",
    ...rest,
    ...extra,
  };
}

/** A frame hugging both ways (a chip, a ring, a row of hugging texts). */
const hug = (name: string, layout: Layout, children: SceneNode[], extra: FrameExtra = {}) => frame(name, layout, children, { sizingH: "hug", sizingV: "hug", width: 100, ...extra });

/** A text in one of the site's text styles, filling its row (wrapping) unless hugging — its words from a text property when `prop` names one. */
function text(name: string, characters: string, style: string, extra: Partial<TextNode> & { hug?: boolean; en?: string; prop?: string } = {}): TextNode {
  const ts = STARTING_TEXT_STYLES.find((s) => s.id === style);
  if (!ts) throw new Error(`No text style ${style}`);
  const { hug: hugs, en, prop: bound, ...rest } = extra;
  return {
    id: fresh("t"),
    name,
    type: "text",
    x: 0,
    y: 0,
    width: hugs ? 100 : CONTENT,
    height: 24,
    characters,
    ...(en ? { charactersEn: en } : {}),
    ...(bound ? { charactersProp: bound } : {}),
    fontSize: ts.fontSize,
    fontWeight: ts.fontWeight,
    lineHeight: ts.lineHeight,
    ...(ts.letterSpacing ? { letterSpacing: ts.letterSpacing } : {}),
    textAlign: "left",
    textAutoResize: hugs ? "widthHeight" : "height",
    fills: [{ color: ts.color }],
    textStyle: style,
    sizingH: hugs ? "hug" : "fill",
    sizingV: "hug",
    ...rest,
  };
}

function shape(type: ShapeNode["type"], name: string, width: number, height: number, extra: Partial<ShapeNode> = {}): ShapeNode {
  return { id: fresh("s"), name, type, x: 0, y: 0, width, height, fills: [], strokes: [], ...extra };
}

/** A main component: a frame of the kind, under a fixed id, with its properties. */
function component(id: string, name: string, layout: Layout, children: SceneNode[], extra: FrameExtra = {}, properties?: ComponentProperty[]): FrameNode {
  return { ...frame(name, layout, children, { ...extra, ...(properties?.length ? { properties } : {}) }, id), type: "component" };
}

/** An instance of a component (by id) with its property values: Fill across a grid, hugging in a row. */
function instance(name: string, mainId: string, props?: PropertyValues, extra: FrameExtra = {}): FrameNode {
  return {
    ...frame(name, {}, [], { fills: [], strokes: [], ...(props ? { props } : {}), ...extra }, fresh("i")),
    type: "instance",
    mainId,
  };
}

/** A component set of `variants` (each a component with its values) and the properties they share, laid out as Figma's: a dashed frame, 16px in and between. */
function componentSet(id: string, name: string, variants: FrameNode[], properties?: ComponentProperty[], direction: "vertical" | "horizontal" = "vertical"): FrameNode {
  return {
    ...frame(name, { layoutMode: direction, gap: 16, padding: 16 }, variants, { sizingH: "hug", sizingV: "hug", fills: [], strokes: [], ...(properties?.length ? { properties } : {}) }, id),
    type: "componentSet",
  };
}

const reaction = (target: string, trigger: Reaction["trigger"] = "click"): Reaction => ({ id: fresh("r"), trigger, target, animation: "smart", easing: "ease-out", duration: 300 });

// ── The pieces the code drew (parts), as shapes ───────────────────────────────

/** A media box: the site's image frame — 32px corners, a hairline, the bg-2 grey — at the 16:9 of a 940px column, its proportions kept at any width (from version 3). */
const mediaBox = (name: string, height = 518, keepRatio = true) =>
  shape("rectangle", name, CONTENT, height, { fills: fill("bg-2"), strokes: stroke("border"), cornerRadius: a("radius-panel"), sizingH: "fill", ...(keepRatio ? { lockAspect: true } : {}) });

/** A component in each of `ratios` (its variants, by their "Ratio"): the first under `id` itself, so instances made before the set keep their component. */
const ratioSet = (id: string, name: string, ratios: [suffix: string, label: string, height: number][], build: (variantId: string, height: number) => FrameNode, properties: ComponentProperty[]) =>
  componentSet(`${id}-set`, name, ratios.map(([suffix, label, height]) => ({ ...build(suffix ? `${id}-${suffix}` : id, height), variant: [{ property: "Ratio", value: label }] }) as FrameNode), properties);

/** The variant of a ratio set an old block's aspect ratio is (see ratioSet) — the set's first when it has none such. */
export const IMAGE_RATIOS: [suffix: string, label: string, height: number][] = [["", "16:9", 518], ["4-3", "4:3", 705], ["1-1", "1:1", 940]];
export const GALLERY_RATIOS: [suffix: string, label: string, height: number][] = [["", "4:3", 348], ["16-9", "16:9", 261], ["1-1", "1:1", 464], ["3-4", "3:4", 619], ["9-16", "9:16", 825]];

const CAPTION_PROPS = [boolProp("caption", "Caption"), textProp("captionText", "Caption text", "Görsel açıklaması")];
const caption = (name = "Caption", words = "Görsel açıklaması") => text(name, words, "caption", { textAlign: "center", prop: "captionText", visibleProp: "caption" });

/** A media component: the medium, its caption centred under it — 48px over them, 36 under. */
const MEDIA_LAYOUT: Layout = { gap: 24, padding: [48, 0, 36, 0], counterAlign: "center" };
const media = (id: string, name: string, medium: SceneNode[], properties: ComponentProperty[] = []) =>
  component(id, name, MEDIA_LAYOUT, [...medium, caption()], {}, [...properties, ...CAPTION_PROPS]);

/** A board's (a table's, a chart's): 16px over and under. */
const board = (id: string, name: string, medium: SceneNode[], properties: ComponentProperty[] = []) =>
  component(id, name, { gap: 24, padding: [16, 0, 16, 0], counterAlign: "center" }, [...medium, caption()], {}, [...properties, ...CAPTION_PROPS]);

/** A round avatar with initials — the code's, at `size`. */
const avatar = (name: string, size: number, initials: string, bound?: string) =>
  hug(name, { layoutMode: "horizontal", primaryAlign: "center", counterAlign: "center" }, [
    text("Initials", initials, "small-strong", { hug: true, fontSize: v(Math.round(size * 0.36)), fontWeight: a("weight-medium"), lineHeight: v(Math.round(size * 0.36)), fills: fill("text-subtitle"), textStyle: undefined, prop: bound }),
  ], { width: size, height: size, sizingH: "fixed", sizingV: "fixed", fills: fill("bg-1"), strokes: stroke("border"), cornerRadius: a("radius-pill"), clipsContent: true });

/** A chevron: a square's two sides, turned — down when closed, up when open. */
const chevron = (open: boolean) =>
  hug("Chevron", { layoutMode: "horizontal", primaryAlign: "center", counterAlign: "center", padding: [0, 0, 3, 0] }, [
    shape("rectangle", "Line", 8, 8, { strokes: [{ color: a("text-subtitle"), weight: v(1.5), align: "inside", sides: { top: false, right: true, bottom: true, left: false } }], rotation: open ? 225 : 45 }),
  ], { width: 16, height: 16, sizingH: "fixed", sizingV: "fixed" });

/** The link glyph: two rings, as a chain. */
const linkIcon = () =>
  hug("Icon", { layoutMode: "none" }, [
    shape("ellipse", "Left ring", 11, 11, { x: 1, y: 4.5, strokes: stroke("text-title", 1.5) }),
    shape("ellipse", "Right ring", 11, 11, { x: 8, y: 4.5, strokes: stroke("text-title", 1.5) }),
  ], { width: 20, height: 20, sizingH: "fixed", sizingV: "fixed", visibleProp: "icon" });

/** The Callout's icon: an "i" in a ring, in the title colour. */
const calloutIcon = () =>
  hug("Icon", { layoutMode: "none" }, [
    shape("ellipse", "Ring", 16, 16, { x: 2, y: 2, strokes: stroke("text-title", 1.5) }),
    shape("rectangle", "Dot", 2, 2, { x: 9, y: 6, fills: fill("text-title"), cornerRadius: v(1) }),
    shape("rectangle", "Bar", 2, 5, { x: 9, y: 9, fills: fill("text-title"), cornerRadius: v(1) }),
  ], { width: 20, height: 20, sizingH: "fixed", sizingV: "fixed" });

/** A Person's external-link mark: an arrow to the top right. */
const externalMark = () =>
  hug("Link mark", { layoutMode: "none" }, [
    shape("rectangle", "Corner", 7, 7, { x: 7, y: 2, strokes: [{ color: a("text-subtitle"), weight: v(1.3), align: "inside", sides: { top: true, right: true, bottom: false, left: false } }] }),
    shape("line", "Arrow", 13, 0, { x: 2, y: 7.5, rotation: -45, strokes: stroke("text-subtitle", 1.3, "center") }),
  ], { width: 16, height: 16, sizingH: "fixed", sizingV: "fixed", visibleProp: "linkMark" });

// ── The components ────────────────────────────────────────────────────────────

const LOREM = "Bu alana metniniz gelir. Bileşenin içindeki metni seçip yazmaya başlayın.";

/** The starting components as `version` of the library drew them (the current one unless said) — older ones to tell whether a file's are still as they were seeded. */
export function startingLibrary(version = LIBRARY_VERSION): { nodes: SceneNode[] } {
  ids = 0;
  const v3 = version >= 3;
  const cardLook: FrameExtra = { fills: fill("bg-4"), cornerRadius: a("radius-card") };

  // Texts
  const heading = component("c-heading", "Heading", {}, [
    text("Title", "Bölüm başlığı", "section-title", { en: "Section title", prop: "title" }),
    text("Subtitle", "Bölümün bir cümlelik özeti.", "subtitle", { en: "A one-line summary of the section.", prop: "subtitleText", visibleProp: "subtitle" }),
  ], {}, [textProp("title", "Title", "Bölüm başlığı"), boolProp("subtitle", "Subtitle"), textProp("subtitleText", "Subtitle text", "Bölümün bir cümlelik özeti.")]);
  const subheading = component("c-subheading", "Subheading", {}, [text("Text", "Alt başlık", "subtitle", { prop: "text" })], {}, [textProp("text", "Text", "Alt başlık")]);
  const paragraph = component("c-text", "Paragraph", {}, [text("Text", LOREM, "text", { prop: "text" })], {}, [textProp("text", "Text", LOREM)]);

  // Project info: two columns of Cards 10px apart
  const card = component("c-card", "Card", { padding: [12, 16], gap: 2 }, [text("Label", "Etiket", "label", { prop: "label" }), text("Value", "Değer", "value", { prop: "value" })], { ...cardLook, width: 465 }, [
    textProp("label", "Label", "Etiket"),
    textProp("value", "Value", "Değer"),
  ]);
  const info = component("c-info", "Project info", { layoutMode: "grid", gridColumns: 2, gap: 10 }, [
    instance("Card", card.id, { label: "Rol", value: "Ürün tasarımcısı" }, { sizingV: "fill" }),
    instance("Card", card.id, { label: "Süre", value: "3 ay" }, { sizingV: "fill" }),
    instance("Card", card.id, { label: "Ekip", value: "2 tasarımcı, 3 geliştirici" }, { sizingV: "fill" }),
    instance("Card", card.id, { label: "Yıl", value: "2025" }, { sizingV: "fill" }),
  ]);

  // Media
  const image = v3
    ? ratioSet("c-image", "Image", IMAGE_RATIOS, (id, height) => component(id, "Image", MEDIA_LAYOUT, [mediaBox("Image", height), caption()]), CAPTION_PROPS)
    : media("c-image", "Image", [mediaBox("Image", 518, false)]);
  const video = media("c-video", "Video", [
    frame("Video", { layoutMode: "horizontal", primaryAlign: "center", counterAlign: "center" }, [
      hug("Play", { layoutMode: "none" }, [
        // A play triangle: the right half of a turned square, in a clipping box.
        hug("Triangle", { layoutMode: "none" }, [shape("rectangle", "Square", 12, 12, { x: -6, y: 2, rotation: 45, fills: fill("text-title"), cornerRadius: v(1) })], {
          x: 24, y: 20, width: 10, height: 16, sizingH: "fixed", sizingV: "fixed", clipsContent: true,
        }),
      ], { width: 56, height: 56, sizingH: "fixed", sizingV: "fixed", fills: fill("bg-1"), strokes: stroke("border"), cornerRadius: a("radius-pill") }),
    ], { height: 518, sizingV: "fixed", fills: fill("bg-2"), strokes: stroke("border"), cornerRadius: a("radius-panel"), clipsContent: true }),
  ]);
  const code = media("c-code", "Code", [
    frame("Code", { gap: 6, padding: [24, 28] }, [
      text("Line 1", "const hero = document.querySelector(\".hero\");", "small"),
      text("Line 2", "hero.classList.add(\"is-visible\");", "small"),
      text("Line 3", "", "small"),
      text("Line 4", "export default hero;", "small"),
    ], { fills: fill("bg-code"), strokes: stroke("border"), cornerRadius: a("radius-panel"), clipsContent: true }),
  ]);
  const embed = (id: string, name: string, label: string) =>
    component(id, name, {}, [
      frame("Embed", { layoutMode: "horizontal", primaryAlign: "center", counterAlign: "center" }, [text("Label", label, "label", { hug: true, prop: "label" })], {
        height: 600,
        sizingV: "fixed",
        fills: fill("bg-2"),
        strokes: stroke("border"),
        cornerRadius: a("radius-panel"),
        clipsContent: true,
      }),
    ], {}, [textProp("label", "Label", label)]);
  const figma = embed("c-figma", "Figma", "Figma dosyası");
  const iframe = embed("c-iframe", "iFrame", "Gömülü sayfa");

  // Lists
  // A list item in each of the site's markers (its variants): a dot, its number, a dash, a box to tick — ticked, its text struck through.
  const markers: [id: string, value: string, marker: SceneNode, struck?: boolean][] = [
    ["c-list-item", "Bullet", hug("Marker", { padding: [9, 0, 0, 0] }, [shape("ellipse", "Dot", 6, 6, { fills: fill("text-title") })], { visibleProp: "marker" })],
    ["c-list-item-number", "Number", hug("Marker", { padding: [2, 0, 0, 0] }, [text("Number", "1.", "small-strong", { hug: true, fills: fill("text-subtitle"), prop: "number" })], { visibleProp: "marker", minWidth: 20 })],
    ["c-list-item-dash", "Dash", hug("Marker", { padding: [2, 0, 0, 0] }, [text("Dash", "—", "small-strong", { hug: true, fills: fill("text-subtitle") })], { visibleProp: "marker" })],
    ["c-list-item-check", "Check", hug("Marker", { padding: [3, 0, 0, 0] }, [shape("rectangle", "Box", 18, 18, { fills: fill("bg-1"), strokes: stroke("border-hover"), cornerRadius: v(5) })], { visibleProp: "marker" })],
    ["c-list-item-checked", "Checked", hug("Marker", { padding: [3, 0, 0, 0] }, [
      hug("Box", { layoutMode: "horizontal", primaryAlign: "center", counterAlign: "center" }, [text("Tick", "✓", "small-strong", { hug: true, fontSize: v(11), lineHeight: v(12), fills: fill("bg-1"), textStyle: undefined })], {
        width: 18, height: 18, sizingH: "fixed", sizingV: "fixed", fills: fill("text-title"), cornerRadius: v(5),
      }),
    ], { visibleProp: "marker" }), true],
  ];
  const listItem = !v3 ? component("c-list-item", "List item", { layoutMode: "horizontal", gap: 10, padding: [10, 16] }, [markers[0][2], text("Text", "Liste maddesi", "body", { prop: "text" })], cardLook, [textProp("text", "Text", "Liste maddesi"), boolProp("marker", "Marker")]) : componentSet("c-list-item-set", "List item", markers.map(([id, value, marker, struck]) => ({
    ...component(id, "List item", { layoutMode: "horizontal", gap: 10, padding: [10, 16] }, [
      marker,
      text("Text", "Liste maddesi", "body", { prop: "text", ...(struck ? { textDecoration: "strikethrough" as const, opacity: 50 } : {}) }),
    ], cardLook),
    variant: [{ property: "Marker", value }],
  }) as FrameNode), [textProp("text", "Text", "Liste maddesi"), boolProp("marker", "Marker"), textProp("number", "Number", "1.")]);
  const list = component("c-list", "List", { gap: 10 }, [
    instance("List item", "c-list-item", { text: "Birinci madde" }),
    instance("List item", "c-list-item", { text: "İkinci madde" }),
    instance("List item", "c-list-item", { text: "Üçüncü madde" }),
  ]);

  const metric = component("c-metric", "Metric", { gap: 4, padding: 20 }, [text("Value", "%42", "metric", { prop: "value" }), text("Label", "Açıklama", "label", { prop: "label" })], { ...cardLook, width: 306 }, [
    textProp("value", "Value", "%42"),
    textProp("label", "Label", "Açıklama"),
  ]);
  const stats = component("c-stats", "Metrics", { layoutMode: "grid", gridColumns: 3, gap: 10 }, [
    instance("Metric", metric.id, { value: "%42", label: "Dönüşüm artışı" }, { sizingV: "fill" }),
    instance("Metric", metric.id, { value: "3×", label: "Daha hızlı akış" }, { sizingV: "fill" }),
    instance("Metric", metric.id, { value: "12k", label: "Aylık kullanıcı" }, { sizingV: "fill" }),
  ]);

  const featureCard = component("c-feature-card", "Feature card", { gap: 8, padding: 20 }, [
    text("Eyebrow", "Üst etiket", "label", { prop: "eyebrowText", visibleProp: "eyebrow" }),
    text("Title", "Başlık", "strong", { prop: "title" }),
    text("Text", LOREM, "body", { prop: "text" }),
  ], { ...cardLook, width: 465 }, [boolProp("eyebrow", "Eyebrow"), textProp("eyebrowText", "Eyebrow text", "Üst etiket"), textProp("title", "Title", "Başlık"), textProp("text", "Text", LOREM)]);
  const cards = component("c-cards", "Cards", { layoutMode: "grid", gridColumns: 2, gap: 10 }, [
    instance("Feature card", featureCard.id, { eyebrowText: "01", title: "Birinci özellik" }, { sizingV: "fill" }),
    instance("Feature card", featureCard.id, { eyebrowText: "02", title: "İkinci özellik" }, { sizingV: "fill" }),
  ], { narrow: "stack-sm" });

  const step = component("c-step", "Step", { layoutMode: "horizontal", gap: 16 }, [
    shape("rectangle", "Line", 1, 64, { x: 16, y: 40, fills: fill("border-hover"), absolute: true, visibleProp: "line" }),
    hug("Number", { layoutMode: "horizontal", primaryAlign: "center", counterAlign: "center" }, [text("Digit", "1", "small-strong", { hug: true, prop: "number" })], {
      width: 32, height: 32, sizingH: "fixed", sizingV: "fixed", fills: fill("bg-2"), strokes: stroke("border-hover"), cornerRadius: a("radius-pill"),
    }),
    frame("Content", { gap: 4, padding: [4, 0, 0, 0] }, [
      frame("Header", { layoutMode: "horizontal", layoutWrap: true, gap: 8, rowGap: 0, baselineAlign: true }, [
        text("Title", "Adımın başlığı", "strong", { hug: true, prop: "title" }),
        text("Time", "1. hafta", "label", { hug: true, prop: "time", visibleProp: "showTime" }),
      ]),
      text("Text", LOREM, "text", { prop: "text" }),
    ]),
  ], {}, [textProp("number", "Number", "1"), textProp("title", "Title", "Adımın başlığı"), boolProp("showTime", "Time"), textProp("time", "Time text", "1. hafta"), textProp("text", "Text", LOREM), boolProp("line", "Line")]);
  const steps = component("c-steps", "Steps", { gap: 32 }, [
    instance("Step", step.id, { number: "1", title: "Keşif" }),
    instance("Step", step.id, { number: "2", title: "Tasarım" }),
    instance("Step", step.id, { number: "3", title: "Test", line: false }),
  ]);

  // Accordion: an item closed or open, each turning into the other on click
  const accordionItemVariant = (id: string, open: boolean, other: string) =>
    ({
      ...component(id, "Accordion item", {}, [
        frame("Header", { layoutMode: "horizontal", primaryAlign: "spaceBetween", counterAlign: "center", gap: 16, padding: [14, 20] }, [
          text("Title", "Madde başlığı", "value", { hug: true, prop: "title" }),
          chevron(open),
        ]),
        frame("Body", { padding: [0, 20, 16, 20] }, [text("Text", LOREM, "text", { prop: "text" })], { visible: open }),
      ], cardLook),
      variant: [{ property: "State", value: open ? "Open" : "Closed" }],
      reactions: [reaction(other)],
    }) as FrameNode;
  const accordionItem = componentSet("c-accordion-item", "Accordion item", [accordionItemVariant("c-accordion-item-closed", false, "c-accordion-item-open"), accordionItemVariant("c-accordion-item-open", true, "c-accordion-item-closed")], [
    textProp("title", "Title", "Madde başlığı"),
    textProp("text", "Text", LOREM),
  ]);
  const accordion = component("c-accordion", "Accordion", { gap: 10 }, [
    instance("Accordion item", "c-accordion-item-closed", { title: "Birinci madde" }),
    instance("Accordion item", "c-accordion-item-closed", { title: "İkinci madde" }),
  ]);

  const link = component("c-link", "Link", { layoutMode: "horizontal", counterAlign: "center", gap: 8, padding: [0, 16] }, [linkIcon(), text("Label", "Bağlantı", "small-strong", { hug: true, prop: "label" })], {
    sizingH: "hug", sizingV: "fixed", height: 40, width: 120, fills: fill("bg-2"), strokes: stroke("border"), cornerRadius: a("radius-pill"),
  }, [textProp("label", "Label", "Bağlantı"), boolProp("icon", "Icon")]);
  const links = component("c-links", "Links", { layoutMode: "horizontal", layoutWrap: true, gap: 8, rowGap: 8 }, [
    instance("Link", link.id, { label: "Canlı site" }, { sizingH: "hug", sizingV: "fixed", height: 40 }),
    instance("Link", link.id, { label: "Figma dosyası" }, { sizingH: "hug", sizingV: "fixed", height: 40 }),
  ]);

  const tag = component("c-tag", "Tag", { layoutMode: "horizontal", counterAlign: "center", padding: [0, 14] }, [text("Label", "Etiket", "chip", { hug: true, prop: "label" })], {
    sizingH: "hug", sizingV: "fixed", height: 32, width: 80, ...cardLook, cornerRadius: a("radius-pill"),
  }, [textProp("label", "Label", "Etiket")]);
  const tags = component("c-tags", "Tags", { layoutMode: "horizontal", layoutWrap: true, gap: 8, rowGap: 8 }, [
    instance("Tag", tag.id, { label: "Araştırma" }, { sizingH: "hug", sizingV: "fixed", height: 32 }),
    instance("Tag", tag.id, { label: "Prototip" }, { sizingH: "hug", sizingV: "fixed", height: 32 }),
    instance("Tag", tag.id, { label: "Tasarım sistemi" }, { sizingH: "hug", sizingV: "fixed", height: 32 }),
  ]);

  const person = component("c-person", "Person", { layoutMode: "horizontal", counterAlign: "center", gap: 12, padding: [12, 16, 12, 12] }, [
    avatar("Avatar", 44, "AB", "initials"),
    frame("Names", {}, [text("Name", "Ad Soyad", "strong", { prop: "name" }), text("Role", "Rol", "label", { prop: "role" })]),
    externalMark(),
  ], { ...cardLook, width: 465 }, [textProp("name", "Name", "Ad Soyad"), textProp("role", "Role", "Rol"), textProp("initials", "Initials", "AB"), boolProp("linkMark", "Link mark")]);
  const team = component("c-team", "Team", { layoutMode: "grid", gridColumns: 2, gap: 10 }, [
    instance("Person", person.id, { name: "Burak Koç", role: "Ürün tasarımcısı", initials: "BK" }, { sizingV: "fill" }),
    instance("Person", person.id, { name: "Ayşe Yılmaz", role: "Geliştirici", initials: "AY", linkMark: false }, { sizingV: "fill" }),
  ], { narrow: "stack-sm" });

  const color = component("c-color", "Color", {}, [
    shape("rectangle", "Swatch", 227, 96, { fills: [{ color: v("#1a1a1a") }], strokes: [{ color: a("border"), weight: v(1), align: "inside", sides: { top: false, right: false, bottom: true, left: false } }], sizingH: "fill" }),
    frame("Info", { gap: 2, padding: [12, 16] }, [text("Name", "Ad", "small-strong", { prop: "name" }), text("Code", "#1A1A1A", "micro", { prop: "code" }), text("Usage", "Kullanım", "micro-light", { prop: "usage" })]),
  ], { ...cardLook, clipsContent: true, width: 227 }, [textProp("name", "Name", "Ad"), textProp("code", "Code", "#1A1A1A"), textProp("usage", "Usage", "Kullanım")]);
  const swatch = (hex: string) => ({ Swatch: { fills: [{ color: v(hex) }] } });
  const palette = component("c-palette", "Color palette", { layoutMode: "grid", gridColumns: 4, gap: 10 }, [
    instance("Color", color.id, { name: "Mürekkep", code: "#1A1A1A", usage: "Başlıklar" }, { sizingV: "fill", overrides: swatch("#1a1a1a") }),
    instance("Color", color.id, { name: "Grafit", code: "#2A2A2A", usage: "Metin" }, { sizingV: "fill", overrides: swatch("#2a2a2a") }),
    instance("Color", color.id, { name: "Kağıt", code: "#F2F2F2", usage: "Yüzeyler" }, { sizingV: "fill", overrides: swatch("#f2f2f2") }),
    instance("Color", color.id, { name: "Vurgu", code: "#3B82F6", usage: "Bağlantılar" }, { sizingV: "fill", overrides: swatch("#3b82f6") }),
  ]);

  // Surfaces
  const quote = component("c-quote", "Quote", { gap: 20, padding: 32 }, [
    // The mark: 20px of room for a glyph taller than it (it reaches into the gap under it, as the site's) — a text of that height before version 3.
    v3
      ? frame("Quote mark", { layoutMode: "none" }, [text("Mark", "“", "quote", { hug: true, fontSize: v(48), fontWeight: a("weight-medium"), lineHeight: v(43), fills: fill("text-subtitle"), textStyle: undefined })], { height: 20, sizingV: "fixed", visibleProp: "mark" })
      : text("Quote mark", "“", "quote", { fontSize: v(48), fontWeight: a("weight-medium"), lineHeight: v(43), fills: fill("text-subtitle"), textStyle: undefined, height: 20, textAutoResize: "none", visibleProp: "mark" }),
    text("Quote", "Alıntının kendisi burada: bir kullanıcının, bir paydaşın ya da ekipten birinin sözleri.", "quote", { prop: "quote" }),
    frame("Person", {}, [text("Author", "Ad Soyad", "section-title", { prop: "author" }), text("Role", "Unvan", "subtitle", { prop: "role" })]),
  ], { fills: fill("bg-4"), cornerRadius: a("radius-panel") }, [
    textProp("quote", "Quote", "Alıntının kendisi burada: bir kullanıcının, bir paydaşın ya da ekipten birinin sözleri."),
    textProp("author", "Author", "Ad Soyad"),
    textProp("role", "Role", "Unvan"),
    boolProp("mark", "Quote mark"),
  ]);

  const callout = component("c-callout", "Callout", { layoutMode: "horizontal", gap: 14, padding: 20 }, [
    hug("Icon column", { padding: [2, 0, 0, 0] }, [calloutIcon()], { visibleProp: "icon" }),
    frame("Body", { gap: 4 }, [text("Title", "Not", "strong", { prop: "title" }), text("Text", LOREM, "text", { prop: "text" })]),
  ], cardLook, [textProp("title", "Title", "Not"), textProp("text", "Text", LOREM), boolProp("icon", "Icon")]);

  const splitVariant = (id: string, side: "Left" | "Right") => {
    const picture = shape("rectangle", "Image", 454, 340, { fills: fill("bg-2"), strokes: stroke("border"), cornerRadius: a("radius-media"), sizingH: "fill", ...(v3 ? { lockAspect: true } : {}) });
    const body = frame("Body", { gap: 8 }, [text("Title", "Başlık", "strong", { prop: "title" }), text("Text", LOREM, "text", { prop: "text" })]);
    return {
      // On a phone: the picture over the words (as the site's pages had them).
      ...component(id, "Image + Text", { layoutMode: "grid", gridColumns: 2, gap: 32, counterAlign: "center", padding: [24, 0] }, side === "Left" ? [picture, body] : [body, picture], { narrow: "stack-sm" }),
      variant: [{ property: "Image", value: side }],
    } as FrameNode;
  };
  const split = componentSet("c-split", "Image + Text", [splitVariant("c-split-left", "Left"), splitVariant("c-split-right", "Right")], [textProp("title", "Title", "Başlık"), textProp("text", "Text", LOREM)]);

  const personaGroup = component("c-persona-group", "Group", { gap: 8, padding: 16 }, [text("Title", "Hedefler", "small-strong", { prop: "title" }), text("Items", "• Birinci madde\n• İkinci madde\n• Üçüncü madde", "small-light", { prop: "items" })], {
    fills: fill("bg-1"), cornerRadius: a("radius-inner"), width: 441,
  }, [textProp("title", "Title", "Hedefler"), textProp("items", "Items", "• Birinci madde\n• İkinci madde\n• Üçüncü madde")]);
  const persona = component("c-persona", "Persona", { gap: 20, padding: 24 }, [
    frame("Identity", { layoutMode: "horizontal", counterAlign: "center", gap: 16 }, [
      avatar("Avatar", 64, "AY", "initials"),
      hug("Names", {}, [text("Name", "Ayşe, 34", "strong", { hug: true, prop: "name" }), text("Description", "Ürün yöneticisi", "subtitle", { hug: true, prop: "description" })]),
    ]),
    text("Text", LOREM, "text", { prop: "text" }),
    frame("Groups", { layoutMode: "grid", gridColumns: 2, gap: 10 }, [
      instance("Group", personaGroup.id, { title: "Hedefler" }, { sizingV: "fill" }),
      instance("Group", personaGroup.id, { title: "Zorluklar" }, { sizingV: "fill" }),
    ]),
  ], { fills: fill("bg-4"), cornerRadius: a("radius-panel") }, [textProp("name", "Name", "Ayşe, 34"), textProp("description", "Description", "Ürün yöneticisi"), textProp("initials", "Initials", "AY"), textProp("text", "Text", LOREM)]);

  const galleryItemOf = (id: string, height: number) => component(id, "Gallery item", { gap: 12 }, [
    shape("rectangle", "Image", 464, height, { fills: fill("bg-2"), strokes: stroke("border"), cornerRadius: a("radius-media"), sizingH: "fill", ...(v3 ? { lockAspect: true } : {}) }),
    text("Caption", "Görsel altı yazısı", "caption", { textAlign: "center", prop: "captionText", visibleProp: "caption" }),
  ], { width: 464 });
  const galleryProps = [boolProp("caption", "Caption"), textProp("captionText", "Caption text", "Görsel altı yazısı")];
  const galleryItem = v3 ? ratioSet("c-gallery-item", "Gallery item", GALLERY_RATIOS, galleryItemOf, galleryProps) : { ...galleryItemOf("c-gallery-item", 348), properties: galleryProps };
  const gallery = media("c-gallery", "Gallery", [
    frame("Images", { layoutMode: "grid", gridColumns: 2, gap: 12 }, [
      instance("Gallery item", "c-gallery-item", undefined, { sizingV: "fill" }),
      instance("Gallery item", "c-gallery-item", undefined, { sizingV: "fill" }),
    ]),
  ]);

  const compare = media("c-compare", "Before / After", [
    frame("Compare", { layoutMode: "horizontal" }, [
      shape("rectangle", "Before", 469, 518, { fills: fill("bg-4"), sizingH: "fill", sizingV: "fill" }),
      shape("rectangle", "Divider", 2, 518, { fills: fill("bg-1"), sizingV: "fill" }),
      shape("rectangle", "After", 469, 518, { fills: fill("bg-5"), sizingH: "fill", sizingV: "fill" }),
      hug("Before label", { layoutMode: "horizontal", padding: [4, 10] }, [text("Label", "Önce", "chip", { hug: true, prop: "beforeLabel" })], { x: 16, y: 470, absolute: true, fills: fill("bg-1"), cornerRadius: a("radius-pill"), visibleProp: "labels" }),
      hug("After label", { layoutMode: "horizontal", padding: [4, 10] }, [text("Label", "Sonra", "chip", { hug: true, prop: "afterLabel" })], { x: 866, y: 470, absolute: true, fills: fill("bg-1"), cornerRadius: a("radius-pill"), visibleProp: "labels" }),
    ], { height: 518, sizingV: "fixed", strokes: stroke("border"), cornerRadius: a("radius-panel"), clipsContent: true }),
  ], [boolProp("labels", "Labels"), textProp("beforeLabel", "Before label", "Önce"), textProp("afterLabel", "After label", "Sonra")]);

  const device = (name: string, w: number, h: number, radius: number, bound: string) =>
    shape("rectangle", name, w, h, { fills: fill("bg-1"), strokes: stroke("border-hover"), cornerRadius: v(radius), visibleProp: bound });
  const mockup = media("c-mockup", "Device frame", [
    frame("Panel", { layoutMode: "horizontal", primaryAlign: "center", counterAlign: "max", gap: 24, padding: 40 }, [
      device("Desktop", 520, 330, 12, "desktop"),
      device("Tablet", 200, 280, 20, "tablet"),
      device("Phone", 120, 250, 24, "phone"),
    ], { fills: fill("bg-4"), strokes: stroke("border"), cornerRadius: a("radius-panel"), clipsContent: true }),
  ], [boolProp("desktop", "Desktop"), boolProp("tablet", "Tablet"), boolProp("phone", "Phone")]);

  const cell = (words: string, style: string, i: number) => text(`Cell ${i + 1}`, words, style);
  const tableRow = (name: string, cells: string[], head = false) =>
    frame(name, { layoutMode: "horizontal", gap: 16, padding: [12, 16] }, cells.map((c, i) => cell(c, head ? "small-strong" : "small", i)), head
      ? { fills: fill("bg-4") }
      : { strokes: [{ color: a("border"), weight: v(1), align: "inside", sides: { top: true, right: false, bottom: false, left: false } }] });
  const table = board("c-table", "Table", [
    frame("Table", {}, [
      tableRow("Header row", ["Sütun 1", "Sütun 2", "Sütun 3"], true),
      tableRow("Row 1", ["Hücre", "Hücre", "Hücre"]),
      tableRow("Row 2", ["Hücre", "Hücre", "Hücre"]),
      tableRow("Row 3", ["Hücre", "Hücre", "Hücre"]),
    ], { strokes: stroke("border"), cornerRadius: a("radius-card"), clipsContent: true }),
  ]);

  const barItem = component("c-bar-item", "Bar", { gap: 8 }, [
    frame("Row", { layoutMode: "horizontal", primaryAlign: "spaceBetween", baselineAlign: true, gap: 16 }, [text("Option", "Seçenek", "small", { hug: true, prop: "option" }), text("Percent", "%62", "small-strong", { hug: true, prop: "percent" })]),
    frame("Track", { layoutMode: "none" }, [shape("rectangle", "Fill", 558, 8, { fills: fill("text-title"), cornerRadius: a("radius-pill") })], {
      height: 8, sizingV: "fixed", fills: fill("bg-5"), cornerRadius: a("radius-pill"), clipsContent: true,
    }),
    text("Note", "Kısa bir not", "caption", { prop: "noteText", visibleProp: "note" }),
  ], { width: 900 }, [textProp("option", "Option", "Seçenek"), textProp("percent", "Percent", "%62"), boolProp("note", "Note"), textProp("noteText", "Note text", "Kısa bir not")]);
  const bars = board("c-bars", "Survey results", [
    frame("Card", { gap: 16, padding: 20 }, [
      text("Question", "Anket sorusu?", "strong", { prop: "question" }),
      frame("Bars", { gap: 16 }, [
        instance("Bar", barItem.id, { option: "Evet", percent: "%62" }),
        instance("Bar", barItem.id, { option: "Hayır", percent: "%38", note: false }, { overrides: { "Track›Fill": { visible: false } } }),
      ]),
    ], cardLook),
  ], [textProp("question", "Question", "Anket sorusu?")]);

  // The project's overview: its title, category and year, description and cover — the first section of every project's page, an
  // instance of it (see overview.ts). Its layers are marked as the project's: they stay, and they are what the project's fields are read from.
  const overview = component("c-overview", "Overview", { gap: 24, padding: [10, 0, 0, 0] }, [
    frame("Header", {}, [
      text("Title", "Proje adı", "section-title", { en: "Project name", prop: "title", fixed: "title", tag: "h1" }),
      text("Subtitle", `${TEMPLATE_OVERVIEW.category} · 2026`, "subtitle", { prop: "subtitleText", visibleProp: "subtitle", fixed: "subtitle" }),
    ], { fixed: "header" }),
    text("Description", TEMPLATE_OVERVIEW.description, "text", { prop: "descriptionText", visibleProp: "description", fixed: "description" }),
    frame("Cover", { padding: [24, 0, 24, 0] }, [
      shape("rectangle", "Image", CONTENT, 518, { fills: fill("bg-2"), strokes: stroke("border"), cornerRadius: a("radius-panel"), sizingH: "fill", lockAspect: true, fixed: "image" }),
    ], { visibleProp: "cover", fixed: "cover" }),
  ], { fixed: "overview" }, [
    textProp("title", "Title", "Proje adı"),
    boolProp("subtitle", "Subtitle"),
    textProp("subtitleText", "Subtitle text", `${TEMPLATE_OVERVIEW.category} · 2026`),
    boolProp("description", "Description"),
    textProp("descriptionText", "Description text", TEMPLATE_OVERVIEW.description),
    boolProp("cover", "Cover"),
  ]);

  // ── The page: page-level components down the left, the items they repeat down the right ──
  const left: [FrameNode, number][] = [
    [heading, 60], [subheading, 30], [paragraph, 60], [info, 170], [image, v3 ? 2640 : 640], [video, 640], [code, 250], [figma, 610], [iframe, 610],
    [list, 150], [stats, 120], [cards, 170], [steps, 260], [accordion, 130], [links, 40], [tags, 32], [team, 80], [palette, 190],
    [quote, 260], [callout, 120], [split, 460], [persona, 380], [gallery, 520], [compare, 640], [mockup, 520], [table, 240], [bars, 320],
    ...(version >= 5 ? [[overview, 760] as [FrameNode, number]] : []),
  ];
  const right: [FrameNode, number][] = [
    [card, 60], [listItem, v3 ? 320 : 44], [metric, 100], [featureCard, 160], [step, 110], [accordionItem, 330], [link, 40], [tag, 32], [person, 70], [color, 180],
    [personaGroup, 120], [galleryItem, v3 ? 2700 : 380], [barItem, 70],
  ];
  const place = (list: [FrameNode, number][], x: number) => {
    let y = 0;
    return list.map(([node, height]) => {
      const placed = { ...node, x, y, height };
      y += height + 120;
      return placed;
    });
  };
  // From version 4 a set is as wide as its widest variant (and its padding): its Fill variants have a width to fill.
  const sized = (node: FrameNode): FrameNode =>
    version >= 4 && node.type === "componentSet" ? { ...node, sizingH: "fixed", width: Math.max(...node.children.map((c) => c.width)) + 32 } : node;
  return { nodes: uniqueNames([...place(left.map(([n, h]) => [sized(n), h]), 0), ...place(right.map(([n, h]) => [sized(n), h]), CONTENT + 160)]) };
}

/**
 * Siblings with one name numbered ("Card 1", "Card 2"…): an instance's
 * overrides are keyed by name path, and its layers drawn keyed by name, so
 * no two layers of a frame may share one.
 */
export function uniqueNames(nodes: SceneNode[]): SceneNode[] {
  const counts = new Map<string, number>();
  for (const n of nodes) counts.set(n.name, (counts.get(n.name) ?? 0) + 1);
  const seen = new Map<string, number>();
  return nodes.map((n) => {
    let name = n.name;
    if ((counts.get(n.name) ?? 0) > 1) {
      const i = (seen.get(n.name) ?? 0) + 1;
      seen.set(n.name, i);
      name = `${n.name} ${i}`;
    }
    const renamed = name === n.name ? n : { ...n, name };
    return renamed.type !== "text" && "children" in renamed ? { ...renamed, children: uniqueNames(renamed.children) } : renamed;
  });
}

/** Is it one of the starting components (or a set of them)? */
export const isStarting = (node: SceneNode) => node.id.startsWith("c-");

/** Every id in `nodes`, their layers' too. */
export function idsIn(nodes: readonly SceneNode[], into = new Set<string>()): Set<string> {
  for (const n of nodes) {
    into.add(n.id);
    if (isFrameLike(n)) idsIn(n.children, into);
  }
  return into;
}

/**
 * A starting component as it is drawn, to compare with another: its layers'
 * own ids (made as the library is built) and its place on the canvas left
 * out; keys in order (the stored file keeps none), unset values dropped
 * (the stored file has none).
 */
export function signature(node: SceneNode): string {
  const strip = (value: unknown, top: boolean): unknown => {
    if (Array.isArray(value)) return value.map((x) => strip(x, false));
    if (!value || typeof value !== "object") return value;
    const obj = value as Record<string, unknown>;
    // A layer's or a reaction's own id — not a starting component's (c-…), not a property's.
    const ownId = ("width" in obj && "x" in obj) || "trigger" in obj;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) {
      const x = obj[key];
      if (x === undefined) continue;
      if (key === "id" && ownId && !(typeof x === "string" && x.startsWith("c-"))) continue;
      if (top && (key === "x" || key === "y" || key === "height")) continue;
      out[key] = strip(x, false);
    }
    return out;
  };
  return JSON.stringify(strip(node, true));
}

/** `node` with each of its layers' own ids the file already has (`taken`) made new — a starting component's (c-…) are its name and stay. */
export function withFreeIds<T extends SceneNode>(node: T, taken: Set<string>): T {
  const next = { ...node } as T;
  if (!next.id.startsWith("c-") && taken.has(next.id)) next.id = nid("u");
  taken.add(next.id);
  if (isFrameLike(next)) (next as FrameNode).children = (next as FrameNode).children.map((c) => withFreeIds(c, taken));
  return next;
}
