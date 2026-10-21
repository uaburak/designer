import type { DefaultSkill } from "./types";

export const FRONTEND_DESIGN: DefaultSkill = {
  name: "frontend-design",
  description:
    "Design a distinctive, non-generic interface (landing page, app screen, dashboard, marketing site) in Wecra: a direction grounded in the subject, a type pairing, a palette with tinted neutrals, a layout rhythm, real content — built as auto layout frames on styles and variables. Use when asked to design or redesign a screen or page from a brief, or when a result looks like a template.",
  instructions: `Goal: a screen someone would remember, that could only belong to this product — not the average of every SaaS page.

## 1. Ground it in the subject (before any layer)
- Read what exists: get_selection, get_metadata of the page, get_variable_defs {all: true}, get_libraries. If the file or an enabled library has tokens and components, the wecra-design-system skill applies on top of this one.
- Write three lines for yourself: who uses it, what they must do or feel on this screen, and one concrete reference from the subject's own world (a ferry timetable, a lab notebook, a record sleeve, an Ottoman tile, a pharmacy label). The visual idea comes from that reference, not from "modern and clean".
- Pick one memorable move and spend the boldness there (an oversized numeral, a hard grid with hairlines, a single saturated colour field, a cut-out photo breaking the frame). Everything else stays quiet.

## 2. Type
- Two families at most: a display face with character for headings and a workhorse for text, or one superfamily used with contrast of weight and size. Use fonts the file already uses first; otherwise pairings with real contrast (a grotesk with a serif, a mono for data). Inter alone for everything is the default look to avoid unless the brand is Inter.
- A scale with a clear ratio (1.25 for apps, 1.333–1.5 for marketing): e.g. 12 / 14 / 16 / 20 / 25 / 31 / 39 / 49. Body 16 on web, 14 in dense apps. Line height 1.4–1.6 for text, 1.0–1.15 for display. Tighten display letter spacing (-1% to -3%); open up all-caps labels (+4% to +8%).
- Make each level a text style (create_text_style: "Display/XL", "Heading/L", "Body/M", "Label/S") and apply it (apply_style) instead of loose font settings.

## 3. Colour
- Start from one brand or accent hue. Neutrals are tinted toward it (a warm product gets warm greys: #F7F4EF not #F5F5F5; a cool one #F3F5F8). Pure #000 text and pure #FFF everywhere are tells — use a near-black of the hue (#14110F) and an off-white surface.
- Roles, not swatches: background, surface, surface-raised, border, text, text-secondary, accent, accent-text (on accent), plus success / warning / danger. Make them variables (create_variable_collection "Color" with Light and Dark modes when both are needed; the theme-factory skill covers modes) and bind them (bind_variable field "fills[0]", "strokes[0]").
- Accent covers under ~10% of the screen. Check text contrast as the accessibility-audit skill says (4.5:1 body, 3:1 large).

## 4. Layout rhythm
- One spacing scale on 4 or 8 (4, 8, 12, 16, 24, 32, 48, 64, 96, 128) as FLOAT variables ("space/4" …) bound to padding and itemSpacing. Larger gaps between sections than inside them — grouping is shown by space first, lines and boxes second.
- A grid: 12 columns at 1440 with 80–120 side margins, or a deliberate asymmetric split (5/7, 4/8). Content width for reading 560–720.
- Build everything as auto layout (create_nodes with layoutMode, or set_auto_layout): sections are vertical stacks filling the width, rows are horizontal stacks, cards hug their content. Absolute positioning only for deliberate overlaps (stackPositioning ABSOLUTE).
- Vary section shapes: not every section is "centered heading + three cards". Mix a full-bleed band, a two-column text/image, a dense table, a quote set large.

## 5. Real content
- Write the actual words: a headline that says what it does in the subject's language, believable names, prices, dates, numbers with units. No lorem ipsum, no "Feature 1". Turkish UI: follow the turkish-microcopy skill.
- Pictures: place_image into the frame the picture fills (nodeId of that frame) — or a shape with an honest placeholder fill; never stock-photo clichés described in words.

## 6. Avoid the AI-default look
Purple-to-blue gradients, glassmorphism cards on a blurred blob, every corner at 16, centered everything, three identical feature cards with emoji icons, grey #6B7280 body text on white, drop shadows on everything, "Unlock the power of …" headlines. If the result could be any product's, change the one memorable move and the type before anything else.

## 7. Build order in Wecra
1. A top-level frame per screen (1440 × auto for web, 390 for phone; name it "Home / Desktop", "Home / Mobile" so prototypes switch breakpoints).
2. Variables and text styles first, then sections top to bottom with create_nodes (whole sections per call, nested children).
3. Repeated parts (nav item, card, button) as components (component-authoring skill) and instances.
4. get_screenshot after each section; fix alignment, rhythm and contrast before moving on.
5. Place new screens beside existing ones, never on top. Finish with set_selection on what you made.

## Checklist
- [ ] A stated reference from the subject drives one memorable move
- [ ] ≤ 2 type families, a ratio-based scale, text styles applied
- [ ] Tinted neutrals and colour roles as bound variables; accent under ~10%
- [ ] Spacing on the scale; sections further apart than their parts
- [ ] All auto layout; real copy; no lorem ipsum
- [ ] None of the AI-default tells; screenshot checked`,
};
