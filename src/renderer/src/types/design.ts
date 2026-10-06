// ── Design variables (site-wide) ──────────────────────────────────────────────
//
// As Figma's variables: named values — colours, sizes, spacing, weights — the
// site's text styles and components are bound to. Colours have a light and a dark
// value (the site's themes); a value can also be another variable's (an
// alias), so a semantic one (card-title) can point at a base one (başlık/orta).
// Each variable is a CSS custom property on the page (see variablesCss): change
// it, and everything bound to it changes at once.

/** What a variable holds: a colour, a size in px (radius, gap, padding, font size, line height…) or a font weight. */
export type VariableKind = "color" | "number" | "weight";

/** A value of its own, or another variable's (by id). */
export type VariableValue = { value: string | number } | { alias: string };

export interface DesignVariable {
  id: string;
  /** Its name; "/" makes groups: "Metin/Başlık" */
  name: string;
  kind: VariableKind;
  /** Its value — in the light theme, for a colour */
  light: VariableValue;
  /** A colour's value in the dark theme (the light one when unset) */
  dark?: VariableValue;
  /** The site's own CSS token it drives (--bg-1, --text-title…): the starting variables */
  token?: string;
  /** Its collection in the Variables window (the default one when unset) */
  collection?: string;
}

// ── Text styles (site-wide) ───────────────────────────────────────────────────
//
// As Figma's text styles: a text's typography — its size, weight, line height
// and colour — each value its own or bound to a variable, as in Figma: change
// the variable, and every style bound to it changes; change the style, and
// every text using it changes, on every page. A text layer of a component uses
// one (see TextLayer); where it sits and how big its box is are up to its
// component. Each style is a CSS rule on its texts (see textStylesCss).

/** A text style's typography: each value its own, or a variable's (see VariableValue). */
export interface Typography {
  /** px — or a size variable */
  fontSize: VariableValue;
  /** 100–900 — or a weight variable */
  fontWeight: VariableValue;
  /** px — or a size variable */
  lineHeight: VariableValue;
  /** A colour variable (its light and dark values), or a colour of its own (the same in both themes) */
  color: VariableValue;
  /** px — none when unset */
  letterSpacing?: VariableValue;
}

export interface TextStyle extends Typography {
  id: string;
  /** Its name: "Etiket" — "/" makes groups, as a variable's */
  name: string;
  /** What it is for (Figma's description) */
  description?: string;
  /** Below 640px (a phone): its size, line height and letter spacing there — the web's one breakpoint */
  small?: Partial<Pick<Typography, "fontSize" | "lineHeight" | "letterSpacing">>;
  /** What its texts are on the site's page (a heading's level, a paragraph) — for search engines and screen readers; a text may say otherwise */
  tag?: TextTag;
}

/** A text's element on the site: a heading of a level, a paragraph, or a plain block. */
export type TextTag = "h1" | "h2" | "h3" | "h4" | "p" | "div";

/**
 * How a frame is composited with what is under it, as Figma's blend modes:
 * `pass-through` (unset) lets its children blend with what is under it,
 * `normal` blends them within it first; the rest are CSS's mix-blend-mode.
 */
export type BlendMode =
  | "pass-through"
  | "normal"
  | "darken"
  | "multiply"
  | "color-burn"
  | "lighten"
  | "screen"
  | "color-dodge"
  | "overlay"
  | "soft-light"
  | "hard-light"
  | "difference"
  | "exclusion"
  | "hue"
  | "saturation"
  | "color"
  | "luminosity";

// ── Prototyping (Figma's interactive components) ─────────────────────────────
//
// A variant of a component set can turn into another of its variants when
// something happens to an instance of it — a click, the pointer over it, a
// press, some time passing — animated as Figma's: at once, dissolving in, or
// Smart animate (each layer going from how it was to how it is, matched by
// its id — variants are copies of one another). On the site, every instance
// plays them; in the editor, the prototype's preview does.

/**
 * What starts it, as Figma's: a click, a drag, the pointer over it (back
 * when it leaves), a press (back on letting go), a key; the pointer coming
 * in, going out, pressing, letting go (no way back); some time passing.
 */
export type InteractionTrigger = "click" | "drag" | "hover" | "press" | "key" | "mouseenter" | "mouseleave" | "mousedown" | "mouseup" | "delay";
/** What it does: another frame shown (Navigate to), the instance another variant (Change to), the frame before (Back), a layer scrolled to, a page opened. */
export type InteractionAction = "navigate" | "change" | "back" | "scroll" | "url";
/** How the change animates, as Figma's: at once, dissolving, Smart animate — and, to another frame, moving or sliding in or out, pushing. */
export type InteractionAnimation = "instant" | "dissolve" | "smart" | "move-in" | "move-out" | "push" | "slide-in" | "slide-out";
/** Which way a move, push or slide goes. */
export type InteractionDirection = "left" | "right" | "up" | "down";
/** Its easing, as Figma's: curves (a custom one too), springs (a custom one too). */
export type InteractionEasing = "linear" | "ease-in" | "ease-out" | "ease-in-out" | "ease-in-back" | "ease-out-back" | "ease-in-out-back" | "custom-bezier" | "gentle" | "quick" | "bouncy" | "slow" | "custom-spring";
