import type { DefaultSkill } from "./types";

export const ACCESSIBILITY_AUDIT: DefaultSkill = {
  name: "accessibility-audit",
  description:
    "Audit a design for accessibility against WCAG 2.2 AA in Wecra: text contrast computed from the actual fills, non-text contrast, target sizes, text sizes, focus order and Focus variants (Website behaviours: Tab order, focus rings), labels and states; report, pin comments, and fix on request. Use when asked about accessibility, contrast, a11y or WCAG.",
  instructions: `Measure; don't eyeball. Every finding names the layer, the measured value and the target.

## 1. Collect
get_selection / get_metadata for the screens, get_screenshot to see them, get_design_context for each screen (fills, strokes, text sizes, weights, opacity, sizes, component properties, bound variables with resolved values), get_prototype for interactions.

## 2. Text contrast (WCAG 1.4.3)
- Foreground: the text's fill (resolved variable value), times the text's and its ancestors' opacity. Background: the nearest filled ancestor or the layer underneath at that spot (walk up the tree; composite semi-transparent fills over what is below; over an image or gradient take the worst case at the text's area, or flag "needs check on image").
- Relative luminance: for each sRGB channel c = v/255, c ≤ 0.04045 ? c/12.92 : ((c+0.055)/1.055)^2.4; L = 0.2126 R + 0.7152 G + 0.0722 B. Ratio = (L1 + 0.05) / (L2 + 0.05), lighter over darker.
- Targets: 4.5:1 normal text; 3:1 large text (≥ 24 px regular, or ≥ 18.66 px bold/700+). Disabled text is exempt but say so. Placeholders are text: 4.5:1.
- Quick anchors: #767676 on white = 4.54 (pass); #999 on white = 2.85 (fail); white on #0A84FF ≈ 3.65 (large only).

## 3. Non-text contrast (1.4.11)
Input borders, icon-only buttons, focus rings, toggles' on/off, chart lines: 3:1 against adjacent colours. A text field with only a #E5E5E5 border on white fails.

## 4. Sizes
- Targets (2.5.8 AA): at least 24 × 24 px including spacing; recommend 44 × 44 (iOS) / 48 × 48 (Android) for touch. Check every clickable layer (hotspots in get_prototype, buttons, icon buttons, links in text).
- Text: body ≥ 16 on web/mobile (≥ 14 in dense desktop apps), nothing under 12; line height ≥ 1.4 for paragraphs; line length ≤ ~80 characters.

## 5. Keyboard and focus (prototypes with Website behaviours on)
- Wecra's player gives Tab focus to click / press hotspots, text inputs and links — not disabled instances, not hidden layers. Order: an auto layout frame's children in layout order, other frames in reading order (rows, then left to right). So: put interactive things in auto layout in the order a keyboard user should meet them; a visual order that differs from the layer order is a finding.
- Focus visible (2.4.7): each interactive component set needs a Focus variant (a property value Focus / Focused / Focus visible differing in that one property) — otherwise the player draws a default 2 px #005FCC ring, which may not fit the brand or may be clipped. The Focus variant's ring needs 3:1 against the background.
- Modals: an overlay with a background traps focus and returns it on close (built in) — check it has a close control and closes on Esc (closeOnClickOutside makes it dismissible).
- Disabled: use a variant or a boolean property named "Disabled" so the player treats it as disabled.
- Text inputs: Prototype › Text input (set_prototype_settings prototypeTextInput) with a visible label above, not placeholder only.

## 6. Meaning and structure
Colour isn't the only signal (errors also have an icon or text; links underlined or otherwise distinct); icon-only buttons have a tooltip / name in the layer name; headings look like headings in a clear order; error messages say how to fix.

## 7. Report and fix
- In the chat: a table — layer, check, measured, target, pass/fail — then the failures ranked.
- When asked to annotate: add_comment on each failing layer: "[A11y AA 1.4.3] Contrast 3.1:1 (#8A8A8A on #FFFFFF), needs 4.5:1. Fix: text/secondary → #6B6B6B (4.9:1)."
- When asked to fix: change the token, not the layer, when the colour is a variable (set_variable_value in the right mode) — it fixes every use; else update_nodes. Add Focus variants per component-authoring; enlarge hit areas with padding instead of scaling icons. Re-measure after fixing.
- Dev handoff: annotations (set_properties {annotations}) for focus order or labels that the design can't show.

## Checklist
- [ ] Contrast computed per text (opacity and composites included), large-text rule applied
- [ ] Non-text contrast for borders, icons, focus rings
- [ ] Targets ≥ 24 px (44/48 recommended), text ≥ 12 (body ≥ 16)
- [ ] Tab order follows layout order; Focus variants exist and are visible
- [ ] Not colour alone; labels on inputs; modals closable
- [ ] Table report; comments or token-level fixes as asked; re-measured`,
};
