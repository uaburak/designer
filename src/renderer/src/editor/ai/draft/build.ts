/**
 * First Draft's builder (docs/ai.md §3): the model's plan (blocks with props), the kit and the theme → one frame as
 * node specs (agents/nodeSpec.ts — what create_nodes takes): 390 wide for an app, 1440 for a website, vertical auto
 * layout, plain layers (no components). Deterministic: the same plan, kit, theme and style give the same specs, so a
 * theme or a "Make changes" style control rebuilds the frame without asking the model again.
 */
import type { DraftPlan, DraftPropValue } from "@shared/ai/schemas";
import type { Kit, KitFont, KitPalette, KitTheme } from "@shared/ai/kits";
import type { Spec } from "../../agents/nodeSpec";

/** Make changes › the style controls (each unset: the theme's). */
export interface DraftStyle {
  mode: "light" | "dark";
  /** Color › a preset or custom: the primary colour */
  primary?: string;
  /** Border radius */
  radius?: number;
  /** Spacing: the base step */
  spacing?: number;
  /** Typography: families for title / body / label */
  fonts?: { title?: string; body?: string; label?: string };
}

export const DEFAULT_STYLE: DraftStyle = { mode: "light" };

interface Look {
  p: KitPalette;
  r: number;
  s: number;
  f: { title: KitFont; body: KitFont; label: KitFont };
  web: boolean;
  wire: boolean;
}

/** The theme with the style controls applied. */
export function lookOf(kit: Kit, theme: KitTheme, style: DraftStyle = DEFAULT_STYLE): Look {
  const base = style.mode === "dark" ? theme.dark : theme.light;
  const p = style.primary ? { ...base, primary: style.primary.toUpperCase(), onPrimary: onColor(style.primary) } : base;
  const fam = (f: KitFont, family?: string): KitFont => (family ? { family, style: f.style } : f);
  return {
    p,
    r: style.radius ?? theme.radius,
    s: style.spacing ?? theme.spacing,
    f: { title: fam(theme.fonts.title, style.fonts?.title), body: fam(theme.fonts.body, style.fonts?.body), label: fam(theme.fonts.label, style.fonts?.label) },
    web: kit.platform === "web",
    wire: kit.style === "wireframe",
  };
}

/** Black or white text on a colour (WCAG relative luminance). */
export function onColor(hex: string): string {
  const m = /^#?([0-9a-f]{6})/i.exec(hex);
  if (!m) return "#FFFFFF";
  const n = parseInt(m[1], 16);
  const lin = (c: number) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  const l = 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
  return l > 0.4 ? "#141414" : "#FFFFFF";
}

// ---- Props ------------------------------------------------------------------------------------------------------------

type Props = Record<string, DraftPropValue>;
const str = (p: Props, k: string, d: string): string => {
  const v = p[k];
  return typeof v === "string" && v.trim() ? v.trim() : typeof v === "number" ? String(v) : Array.isArray(v) && v.length ? v.join(", ") : d;
};
const arr = (p: Props, k: string, d: readonly string[]): string[] => {
  const v = p[k];
  if (Array.isArray(v) && v.length) return v.map(String);
  if (typeof v === "string" && v.trim()) return v.split(/\s*[,;\n]\s*/).filter(Boolean);
  return [...d];
};
const at = (list: readonly string[], i: number, d = "") => list[i] ?? d;

// ---- Primitives -------------------------------------------------------------------------------------------------------

type Role = "display" | "title" | "heading" | "body" | "label" | "small";
const SIZES: Record<"web" | "app", Record<Role, number>> = {
  web: { display: 56, title: 40, heading: 24, body: 18, label: 16, small: 14 },
  app: { display: 32, title: 24, heading: 18, body: 15, label: 15, small: 13 },
};

function text(L: Look, role: Role, characters: string, o: { color?: string; name?: string; fill?: boolean; align?: "LEFT" | "CENTER" | "RIGHT" } = {}): Spec {
  const font = role === "display" || role === "title" || role === "heading" ? L.f.title : role === "label" ? L.f.label : L.f.body;
  const spec: Spec = {
    type: "TEXT",
    name: o.name ?? characters.slice(0, 40),
    characters,
    fontFamily: font.family,
    fontStyle: font.style,
    fontSize: SIZES[L.web ? "web" : "app"][role],
    fills: [o.color ?? (role === "small" ? L.p.muted : L.p.text)],
  };
  if (o.align) spec.textAlignHorizontal = o.align;
  if (o.fill) Object.assign(spec, { textAutoResize: "HEIGHT", layoutSizingHorizontal: "FILL" });
  else spec.textAutoResize = "WIDTH_AND_HEIGHT";
  return spec;
}

interface BoxOpts {
  gap?: number;
  pad?: number | number[];
  fill?: string;
  radius?: number;
  stroke?: string;
  align?: "MIN" | "CENTER" | "MAX";
  justify?: "MIN" | "CENTER" | "MAX" | "SPACE_BETWEEN";
  /** FILL (default), HUG, or a width */
  width?: "FILL" | "HUG" | number;
  height?: "HUG" | "FILL" | number;
  wrap?: boolean;
}

function box(name: string, dir: "VERTICAL" | "HORIZONTAL", children: Spec[], o: BoxOpts = {}): Spec {
  const spec: Spec = { type: "FRAME", name, layoutMode: dir, itemSpacing: o.gap ?? 0, fills: o.fill ? [o.fill] : [], children };
  if (o.pad !== undefined) spec.padding = o.pad;
  if (o.radius) spec.cornerRadius = o.radius;
  if (o.stroke) Object.assign(spec, { strokes: [o.stroke], strokeWeight: 1, strokeAlign: "INSIDE" });
  if (o.align) spec.counterAxisAlignItems = o.align;
  if (o.justify) spec.primaryAxisAlignItems = o.justify;
  if (o.wrap) spec.layoutWrap = "WRAP";
  const w = o.width ?? "FILL";
  if (typeof w === "number") spec.width = w;
  else spec.layoutSizingHorizontal = w;
  const h = o.height ?? "HUG";
  if (typeof h === "number") spec.height = h;
  else spec.layoutSizingVertical = h;
  return spec;
}

const rect = (name: string, color: string, o: { width?: number | "FILL"; height: number; radius?: number }): Spec => {
  const spec: Spec = { type: "RECTANGLE", name, fills: [color], height: o.height };
  if (o.radius) spec.cornerRadius = o.radius;
  if (o.width === "FILL" || o.width === undefined) spec.layoutSizingHorizontal = "FILL";
  else spec.width = o.width;
  return spec;
};

function button(L: Look, label: string, kind: "primary" | "secondary" = "primary", fill = false): Spec {
  const primary = kind === "primary";
  return box(`${label} button`.slice(0, 60), "HORIZONTAL", [text(L, "label", label, { color: primary ? L.p.onPrimary : L.p.text, name: "Label" })], {
    pad: L.web ? [14, 24] : [12, 20],
    fill: primary ? L.p.primary : undefined,
    stroke: primary ? undefined : L.p.border,
    radius: L.r,
    align: "CENTER",
    justify: "CENTER",
    width: fill ? "FILL" : "HUG",
  });
}

const image = (L: Look, what: string, height: number, width: number | "FILL" = "FILL"): Spec => ({ ...rect("Image", L.p.placeholder, { width, height, radius: L.r }), name: what ? `Image: ${what}`.slice(0, 60) : "Image" });

/** A web section: full width, generous padding; an app section: 16 at the sides. */
const section = (L: Look, name: string, children: Spec[], o: BoxOpts = {}): Spec =>
  box(name, "VERTICAL", children, { gap: L.s * (L.web ? 3 : 2), pad: L.web ? [L.s * 10, 120] : [L.s * 2, 16], ...o });

// ---- Blocks -----------------------------------------------------------------------------------------------------------

type Render = (L: Look, p: Props) => Spec;

const BLOCKS: Record<string, Render> = {
  // Web
  nav: (L, p) =>
    box("Navigation", "HORIZONTAL", [text(L, "heading", str(p, "brand", "Brand"), { name: "Brand" }), box("Links", "HORIZONTAL", arr(p, "links", ["Product", "Pricing", "About"]).map((l) => text(L, "label", l, { color: L.p.muted })), { gap: L.s * 4, width: "HUG", align: "CENTER" }), button(L, str(p, "cta", "Get started"))], {
      pad: [L.s * 3, 120],
      justify: "SPACE_BETWEEN",
      align: "CENTER",
      fill: L.p.background,
      stroke: undefined,
    }),
  hero: (L, p) =>
    section(L, "Hero", [
      box("Content", "VERTICAL", [
        ...(p.eyebrow ? [text(L, "label", str(p, "eyebrow", ""), { color: L.p.primary, name: "Eyebrow" })] : []),
        text(L, "display", str(p, "title", "A headline that says what you do"), { fill: true, name: "Title" }),
        text(L, "body", str(p, "body", "One or two sentences that support the headline."), { fill: true, color: L.p.muted, name: "Body" }),
        box("Buttons", "HORIZONTAL", [button(L, str(p, "primary", "Get started")), ...(p.secondary ? [button(L, str(p, "secondary", ""), "secondary")] : [])], { gap: L.s * 2, width: "HUG" }),
      ], { gap: L.s * 3 }),
      image(L, str(p, "image", ""), L.web ? 480 : 220),
    ], { gap: L.s * 6 }),
  "logo-row": (L, p) =>
    section(L, "Logos", [
      text(L, "small", str(p, "title", "Trusted by teams at"), { align: "CENTER", fill: true, name: "Title" }),
      box("Logo row", "HORIZONTAL", arr(p, "logos", ["Northwind", "Acme", "Globex", "Initech"]).map((n) => text(L, "heading", n, { color: L.p.muted })), { gap: L.s * 6, justify: "CENTER", align: "CENTER" }),
    ], { pad: [L.s * 6, 120] }),
  "feature-grid": (L, p) => {
    const titles = arr(p, "features", ["Fast", "Secure", "Simple"]);
    const details = arr(p, "details", []);
    return section(L, "Features", [
      text(L, "title", str(p, "title", "Features"), { fill: true, name: "Title" }),
      ...(p.body ? [text(L, "body", str(p, "body", ""), { fill: true, color: L.p.muted, name: "Body" })] : []),
      box("Feature grid", "HORIZONTAL", titles.map((t, i) => box(t.slice(0, 60), "VERTICAL", [rect("Icon", L.p.primary, { width: 40, height: 40, radius: L.r }), text(L, "heading", t, { fill: true, name: "Title" }), text(L, "body", at(details, i, "A short sentence about this feature."), { fill: true, color: L.p.muted, name: "Description" })], { gap: L.s * 2, pad: L.s * 3, fill: L.p.surface, radius: L.r, width: L.web ? 380 : "FILL" })), { gap: L.s * 3, wrap: L.web }),
    ]);
  },
  stats: (L, p) => {
    const labels = arr(p, "labels", []);
    return section(L, "Stats", [box("Stat row", "HORIZONTAL", arr(p, "values", ["10k+", "99.9%", "24/7"]).map((v, i) => box(at(labels, i, "Stat").slice(0, 60), "VERTICAL", [text(L, "display", v, { name: "Value" }), text(L, "body", at(labels, i, ""), { color: L.p.muted, name: "Label" })], { gap: L.s, width: "HUG" })), { gap: L.s * 10, justify: "CENTER" })]);
  },
  pricing: (L, p) => {
    const plans = arr(p, "plans", ["Starter", "Pro"]);
    const prices = arr(p, "prices", []);
    const features = arr(p, "features", ["Unlimited projects", "Email support"]);
    return section(L, "Pricing", [
      text(L, "title", str(p, "title", "Pricing"), { align: "CENTER", fill: true, name: "Title" }),
      box("Plans", "HORIZONTAL", plans.map((name, i) => box(name.slice(0, 60), "VERTICAL", [text(L, "heading", name, { name: "Plan" }), text(L, "display", at(prices, i, "$0"), { name: "Price" }), ...features.map((f) => text(L, "body", `✓ ${f}`, { color: L.p.muted, fill: true, name: "Feature" })), button(L, str(p, "cta", "Choose plan"), i === plans.length - 1 ? "primary" : "secondary", true)], { gap: L.s * 2, pad: L.s * 4, fill: L.p.surface, radius: L.r, width: L.web ? 360 : "FILL" })), { gap: L.s * 3, justify: "CENTER", wrap: L.web }),
    ]);
  },
  testimonial: (L, p) =>
    section(L, "Testimonial", [
      text(L, "title", `“${str(p, "quote", "This changed how our team works.")}”`, { fill: true, align: "CENTER", name: "Quote" }),
      box("Author", "HORIZONTAL", [rect("Avatar", L.p.placeholder, { width: 48, height: 48, radius: 24 }), box("Name", "VERTICAL", [text(L, "label", str(p, "author", "Alex Morgan"), { name: "Name" }), text(L, "small", str(p, "role", "Head of Design"), { name: "Role" })], { width: "HUG", gap: 2 })], { gap: L.s * 2, justify: "CENTER", align: "CENTER" }),
    ], { align: "CENTER" }),
  faq: (L, p) => {
    const answers = arr(p, "answers", []);
    return section(L, "FAQ", [text(L, "title", str(p, "title", "Frequently asked questions"), { fill: true, name: "Title" }), ...arr(p, "questions", ["How does it work?", "Can I cancel anytime?"]).map((q, i) => box("Question", "VERTICAL", [text(L, "heading", q, { fill: true, name: "Question" }), text(L, "body", at(answers, i, "A short answer."), { fill: true, color: L.p.muted, name: "Answer" })], { gap: L.s, pad: [L.s * 3, 0], stroke: undefined }))]);
  },
  cta: (L, p) =>
    section(L, "Call to action", [box("Band", "VERTICAL", [text(L, "title", str(p, "title", "Ready to start?"), { align: "CENTER", fill: true, color: L.p.onPrimary, name: "Title" }), text(L, "body", str(p, "body", "Join thousands of teams today."), { align: "CENTER", fill: true, color: L.p.onPrimary, name: "Body" }), box("Button", "HORIZONTAL", [box(`${str(p, "cta", "Get started")} button`.slice(0, 60), "HORIZONTAL", [text(L, "label", str(p, "cta", "Get started"), { color: L.p.primary, name: "Label" })], { pad: [12, 24], fill: L.p.onPrimary, radius: L.r, width: "HUG" })], { justify: "CENTER" })], { gap: L.s * 3, pad: L.s * 8, fill: L.p.primary, radius: L.r * 2, align: "CENTER" })]),
  form: (L, p) => formBlock(L, "Form", str(p, "title", "Contact us"), arr(p, "fields", ["Name", "Email", "Message"]), [], str(p, "submit", "Send")),
  table: (L, p) => {
    const cols = arr(p, "columns", ["Name", "Status", "Date"]);
    const rows = arr(p, "rows", []).map((r) => r.split(/\s*[,|]\s*/));
    const cell = (s: string, head: boolean) => box("Cell", "HORIZONTAL", [text(L, head ? "label" : "body", s, { color: head ? L.p.muted : L.p.text, name: "Text" })], { pad: [L.s * 1.5, L.s * 2] });
    return section(L, "Table", [text(L, "title", str(p, "title", "Overview"), { fill: true, name: "Title" }), box("Table", "VERTICAL", [box("Header row", "HORIZONTAL", cols.map((c) => cell(c, true)), { fill: L.p.surface }), ...(rows.length ? rows : [cols.map(() => "—")]).map((r) => box("Row", "HORIZONTAL", cols.map((_, i) => cell(at(r, i, ""), false)), { stroke: L.p.border }))], { radius: L.r, stroke: L.p.border })]);
  },
  footer: (L, p) =>
    box("Footer", "VERTICAL", [box("Top", "HORIZONTAL", [text(L, "heading", str(p, "brand", "Brand"), { name: "Brand" }), box("Links", "HORIZONTAL", arr(p, "links", ["About", "Careers", "Blog", "Contact"]).map((l) => text(L, "small", l)), { gap: L.s * 4, width: "HUG", wrap: true })], { justify: "SPACE_BETWEEN" }), text(L, "small", str(p, "legal", "© 2026 Brand. All rights reserved."), { name: "Legal" })], { gap: L.s * 4, pad: L.web ? [L.s * 8, 120] : [L.s * 3, 16], fill: L.p.surface }),
  // App
  "status-bar": (L, p) => box("Status bar", "HORIZONTAL", [text(L, "label", str(p, "time", "9:41"), { name: "Time" }), box("Indicators", "HORIZONTAL", [rect("Signal", L.p.text, { width: 18, height: 10, radius: 2 }), rect("Battery", L.p.text, { width: 24, height: 11, radius: 3 })], { gap: 6, width: "HUG", align: "CENTER" })], { pad: [14, 24], justify: "SPACE_BETWEEN", align: "CENTER", height: 47 }),
  "top-bar": (L, p) => {
    const back = /^(yes|true|1)$/i.test(str(p, "back", "no"));
    return box("Top bar", "HORIZONTAL", [box("Leading", "HORIZONTAL", [...(back ? [text(L, "heading", "‹", { name: "Back" })] : []), text(L, "title", str(p, "title", "Title"), { name: "Title" })], { gap: L.s, width: "HUG", align: "CENTER" }), ...(p.action ? [text(L, "label", str(p, "action", ""), { color: L.p.primary, name: "Action" })] : [])], { pad: [L.s, 16], justify: "SPACE_BETWEEN", align: "CENTER", height: 52 });
  },
  search: (L, p) => box("Search", "HORIZONTAL", [box("Field", "HORIZONTAL", [text(L, "body", `⌕  ${str(p, "placeholder", "Search")}`, { color: L.p.muted, name: "Placeholder" })], { pad: [10, 12], fill: L.p.surface, radius: L.r, align: "CENTER" })], { pad: [L.s, 16] }),
  chips: (L, p) => {
    const sel = str(p, "selected", "");
    return box("Chips", "HORIZONTAL", arr(p, "chips", ["All", "New", "Popular"]).map((c, i) => {
      const on = sel ? c === sel : i === 0;
      return box(c.slice(0, 60), "HORIZONTAL", [text(L, "small", c, { color: on ? L.p.onPrimary : L.p.text, name: "Label" })], { pad: [6, 12], fill: on ? L.p.primary : L.p.surface, radius: 100, width: "HUG" });
    }), { gap: L.s, pad: [L.s, 16], wrap: true });
  },
  "list-rows": (L, p) => {
    const subs = arr(p, "subtitles", []);
    const vals = arr(p, "values", []);
    return section(L, "List", [...(p.title ? [text(L, "heading", str(p, "title", ""), { name: "Title" })] : []), ...arr(p, "items", ["First item", "Second item", "Third item"]).map((t, i) => box("Row", "HORIZONTAL", [rect("Thumbnail", L.p.placeholder, { width: 44, height: 44, radius: L.r }), box("Text", "VERTICAL", [text(L, "label", t, { fill: true, name: "Title" }), ...(subs[i] ? [text(L, "small", subs[i], { fill: true, name: "Subtitle" })] : [])], { gap: 2 }), ...(vals[i] ? [text(L, "label", vals[i], { name: "Value" })] : [])], { gap: L.s * 1.5, align: "CENTER" }))], { gap: L.s * 2 });
  },
  card: (L, p) => section(L, "Card", [box("Card", "VERTICAL", [image(L, str(p, "image", ""), 160), box("Content", "VERTICAL", [text(L, "heading", str(p, "title", "Card title"), { fill: true, name: "Title" }), text(L, "body", str(p, "body", "A short description."), { fill: true, color: L.p.muted, name: "Body" }), ...(p.cta ? [button(L, str(p, "cta", ""), "primary", true)] : [])], { gap: L.s, pad: L.s * 2 })], { fill: L.p.surface, radius: L.r })]),
  "profile-header": (L, p) =>
    section(L, "Profile header", [rect("Avatar", L.p.placeholder, { width: 88, height: 88, radius: 44 }), text(L, "title", str(p, "name", "Sam Lee"), { name: "Name" }), text(L, "small", str(p, "detail", "@samlee"), { name: "Detail" }), box("Stats", "HORIZONTAL", arr(p, "stats", ["120 Posts", "2.4k Followers"]).map((s) => text(L, "label", s)), { gap: L.s * 3, justify: "CENTER", width: "HUG" })], { align: "CENTER", gap: L.s }),
  "settings-list": (L, p) => {
    const vals = arr(p, "values", []);
    return section(L, "Settings", [...(p.title ? [text(L, "small", str(p, "title", "").toUpperCase(), { name: "Title" })] : []), box("Group", "VERTICAL", arr(p, "items", ["Notifications", "Dark mode", "Language"]).map((t, i) => {
      const v = at(vals, i, "");
      const toggle = /^(on|off)$/i.test(v);
      return box("Row", "HORIZONTAL", [text(L, "body", t, { name: "Title" }), toggle ? box("Switch", "HORIZONTAL", [rect("Knob", "#FFFFFF", { width: 22, height: 22, radius: 11 })], { pad: 3, fill: /on/i.test(v) ? L.p.primary : L.p.border, radius: 14, width: 50, justify: /on/i.test(v) ? "MAX" : "MIN" }) : text(L, "body", v || "›", { color: L.p.muted, name: "Value" })], { pad: [L.s * 1.5, L.s * 2], justify: "SPACE_BETWEEN", align: "CENTER" });
    }), { fill: L.p.surface, radius: L.r })], { gap: L.s });
  },
  "form-fields": (L, p) => formBlock(L, "Form", str(p, "title", ""), arr(p, "fields", ["Email", "Password"]), arr(p, "placeholders", []), ""),
  buttons: (L, p) => section(L, "Buttons", [button(L, str(p, "primary", "Continue"), "primary", true), ...(p.secondary ? [button(L, str(p, "secondary", ""), "secondary", true)] : [])], { gap: L.s * 1.5 }),
  "empty-state": (L, p) => section(L, "Empty state", [rect("Illustration", L.p.placeholder, { width: 120, height: 120, radius: 60 }), text(L, "title", str(p, "title", "Nothing here yet"), { align: "CENTER", fill: true, name: "Title" }), text(L, "body", str(p, "body", "When you add something, it shows up here."), { align: "CENTER", fill: true, color: L.p.muted, name: "Body" }), ...(p.cta ? [button(L, str(p, "cta", ""))] : [])], { align: "CENTER", pad: [L.s * 6, 32] }),
  chat: (L, p) => section(L, "Chat", arr(p, "messages", ["Hi! How can I help?", "I'd like to change my order.", "Sure, which one?"]).map((m, i) => {
    const mine = i % 2 === 1;
    return box(mine ? "Sent" : "Received", "HORIZONTAL", [box("Bubble", "HORIZONTAL", [text(L, "body", m, { color: mine ? L.p.onPrimary : L.p.text, name: "Message" })], { pad: [10, 14], fill: mine ? L.p.primary : L.p.surface, radius: L.r * 1.5, width: "HUG" })], { justify: mine ? "MAX" : "MIN" });
  }), { gap: L.s }),
  "checkout-summary": (L, p) => {
    const prices = arr(p, "prices", []);
    return section(L, "Order summary", [box("Summary", "VERTICAL", [...arr(p, "items", ["Item", "Shipping"]).map((t, i) => box("Line", "HORIZONTAL", [text(L, "body", t, { name: "Item" }), text(L, "body", at(prices, i, "$0.00"), { name: "Price" })], { justify: "SPACE_BETWEEN" })), rect("Divider", L.p.border, { height: 1 }), box("Total", "HORIZONTAL", [text(L, "heading", "Total", { name: "Label" }), text(L, "heading", str(p, "total", "$0.00"), { name: "Amount" })], { justify: "SPACE_BETWEEN" })], { gap: L.s * 1.5, pad: L.s * 2, fill: L.p.surface, radius: L.r }), button(L, str(p, "cta", "Pay now"), "primary", true)]);
  },
  "tab-bar": (L, p) => {
    const tabs = arr(p, "tabs", ["Home", "Search", "Profile"]);
    const sel = str(p, "selected", tabs[0]);
    return box("Tab bar", "HORIZONTAL", tabs.map((t) => box(t.slice(0, 60), "VERTICAL", [rect("Icon", t === sel ? L.p.primary : L.p.muted, { width: 24, height: 24, radius: 6 }), text(L, "small", t, { color: t === sel ? L.p.primary : L.p.muted, name: "Label" })], { gap: 4, align: "CENTER", width: "FILL" })), { pad: [L.s, 8, L.s * 3, 8], fill: L.p.background, stroke: L.p.border, justify: "SPACE_BETWEEN" });
  },
};

function formBlock(L: Look, name: string, title: string, fields: string[], placeholders: string[], submit: string): Spec {
  return section(L, name, [
    ...(title ? [text(L, "title", title, { fill: true, name: "Title" })] : []),
    ...fields.map((f, i) => box(f.slice(0, 60), "VERTICAL", [text(L, "label", f, { name: "Label" }), box("Input", "HORIZONTAL", [text(L, "body", at(placeholders, i, ""), { color: L.p.muted, name: "Placeholder" })], { pad: [12, 14], radius: L.r, stroke: L.p.border, fill: L.p.background, height: L.web ? 48 : 44, align: "CENTER" })], { gap: L.s * 0.75 })),
    ...(submit ? [button(L, submit, "primary", !L.web)] : []),
  ], { gap: L.s * 2 });
}

/** The kit's blocks this builder draws (every kit block has a renderer). */
export const BUILT_BLOCKS: ReadonlySet<string> = new Set(Object.keys(BLOCKS));

/** The draft frame's spec: `plan` drawn with `kit` in `theme` and `style`; blocks the kit doesn't have are left out. */
export function buildDraft(plan: DraftPlan, kit: Kit, theme: KitTheme, style: DraftStyle = DEFAULT_STYLE, at?: { x: number; y: number }): Spec {
  const L = lookOf(kit, theme, style);
  const ids = new Set(kit.blocks.map((b) => b.id));
  const children = plan.blocks.filter((b) => ids.has(b.block) && BLOCKS[b.block]).map((b) => BLOCKS[b.block](L, b.props));
  const frame: Spec = {
    type: "FRAME",
    name: plan.name || "First Draft",
    width: kit.width,
    layoutMode: "VERTICAL",
    itemSpacing: 0,
    layoutSizingVertical: "HUG",
    fills: [L.p.background],
    clipsContent: true,
    children,
  };
  if (at) Object.assign(frame, at);
  return frame;
}
