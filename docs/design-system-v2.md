# Design system v2: the "Wecra UI" file, rebuilt clean

Status: plan (2026-10-15). It replaces `tools/ui-kit/atomic-plan.md` as the guide for the design file of the app's own chrome
(Home, editor panels, menus, dialogs, settings). `docs/design-system.md` stays the contract for the **code**; this
document is the contract for the **file**, and every number in Part 2 comes from the code as it is today
(`src/renderer/src/ds/tokens.css`, the components' props, and their uses across `src/renderer/src`, Gallery excluded).
The code keeps its token names until the file is done; `token-map.json` is then regenerated from the tables below.

Why a rebuild: the first file mirrored captures, not the system — 118 colour primitives and 223 role colours (108 of
them never used by the app), one variant per screen occurrence, buttons in menus and popovers drawn as frames, sizes
typed in. v2 starts from what the app really uses and adds nothing else.

---

## Part 1 — Research and the rules we follow

### 1.1 Sources (read 2026-10-15)

| Source | What we take |
|---|---|
| Figma: [Overview of variables, collections and modes](https://help.figma.com/hc/en-us/articles/14506821864087-Overview-of-variables-collections-and-modes) | Types (colour, number, string, boolean), aliasing to a variable of the same type, modes per collection (Light / Dark), ≤ 5,000 variables per collection. |
| Figma: [Variable API](https://developers.figma.com/docs/plugins/api/Variable) and Help Center on hiding from publishing | `scopes` filter the pickers (a UI filter, not a lock); `hiddenFromPublishing` per variable and per collection (a `.`/`_` prefix hides a collection); `codeSyntax` (WEB: `var(--…)`). |
| Figma: [Explore component properties](https://help.figma.com/hc/en-us/articles/5579474826519-Explore-component-properties) | Boolean, instance swap (with **preferred values**), text, variant, slot; expose nested instances; "use boolean properties for simple on/off changes … instead of creating a variant for each combination". |
| Figma: [Create and use variants](https://help.figma.com/hc/en-us/articles/360056440594-Create-and-use-variants) | Name properties descriptively, only real combinations are needed, the top-left variant is the default, large sets cost performance, "don't group different icons as variants". |
| Figma: [Use slots to build flexible components](https://help.figma.com/hc/en-us/articles/38231200344599) | A slot is a frame in a component whose content is edited freely in the instance, with preferred instances and min/max children; replaces placeholder-swap hacks (lists, menus, dialogs' bodies). |
| Material 3: [Design tokens](https://m3.material.io/foundations/design-tokens/overview) | Three tiers: reference (raw palette) → system (roles) → component (only where a component needs its own). |
| Atlassian: [Design tokens](https://atlassian.design/foundations/tokens/design-tokens), [Button](https://atlassian.design/components/button/examples) | Names `foundation.property.modifier` (`color.text.subtle`, `color.icon.success`); pick a token by **meaning**, never because the value matches; Button and Icon button are separate components; `iconBefore` / `iconAfter`, `isSelected`, `isLoading`. |
| IBM Carbon: [Colour tokens](https://carbondesignsystem.com/elements/color/tokens/) | Role groups (background, layer, field, border, text, link, icon, support, focus) and state suffixes `-hover`, `-active`, `-selected`, `-disabled`; component tokens only for one component. |
| Radix Colors: [Understanding the scale](https://www.radix-ui.com/colors/docs/palette-composition/understanding-the-scale) | A hue scale needs at most 12 steps, each with a job (bg, hover, pressed, border, solid, solid hover, low/high-contrast text). We need far fewer per hue. |
| shadcn/ui: [Theming](https://ui.shadcn.com/docs/theming) | A deliberately small role set with background/foreground pairs (`primary` / `primary-foreground`, `muted`, `accent`, `destructive`, `border`, `input`, `ring`). |

### 1.2 Rules

1. **Two colour tiers, a third only when earned.** *Primitives* (one mode, hidden from publishing, no scopes) hold each
   distinct value once. *Semantic* (Light / Dark) holds roles; every value is an alias, never a raw colour. A
   component token exists only when no role fits (scrollbar, folder colours, picker); it aliases a primitive.
2. **One meaning, one token; two meanings, two tokens.** `text/disabled` and `text/tertiary` have the same values but
   stay separate. Tokens with the same meaning and value merge (`bg/hover` absorbs `bg-pressed`). No token for a role
   the app does not use.
3. **Names** `group/role[-modifier][-state]`: groups `bg/ text/ icon/ border/`, states `-hover -pressed -selected
   -disabled`, contrast pairs `on…` (`text/onbrand`). Primitives `hue/step` (`blue/500`, `black/a40`). Sizes
   `space/8`, `radius/5`, `stroke/1`, `size/control`.
4. **Scopes**: colour roles scoped to their property (text → text fill, icon → shape fill, border → stroke, bg →
   frame/shape fill); spacing → gap/padding; radius → corner radius; stroke → stroke weight. Code syntax WEB = the
   CSS variable the code uses.
5. **Variants only for what changes structure or many values at once** (Variant, Size, State); **properties for
   content** (text, boolean show/hide, instance swap with preferred values, slot for free lists). Target ≤ 4 variant
   axes and only the combinations the app uses.
6. **One component per thing.** A screen never copies a component; buttons inside menus, popovers and the colour
   picker are Button / Icon button instances. If two components differ only in content, they are one.
7. **States** in the set: Default, Hover, Pressed, Focus, Disabled (+ Selected / Mixed where the control toggles).
   Focus is the 1-px `border/selected` ring at 1-px offset everywhere.
8. **Everything bound**: fills, strokes, padding, gap, radius, stroke weight, fixed sizes, text styles. A raw value
   in a component is a bug (checked by readback, Part 2 f).
9. **Document in the file**: each set has a description (purpose, props, where used) and a labelled grid.
10. **Avoid**: variant explosion (the old Button had 192), duplicate tokens with the same meaning, one-off
    per-screen components, hidden layers standing in for slots, raw values.

---

## Part 2 — What Wecra needs

Counts are JSX uses outside the Gallery (`<Button` 443 in 92 files …) and CSS `var()` uses.

### a) Colours

**Today**: 223 role tokens per mode (174 `--figma-color-*`, 49 `--ds-color-*`), **115 used**, 108 never used.
118 distinct values in the two modes (94 among the used tokens), 66 distinct Light|Dark pairs. Raw colours in CSS
modules: about 35 places (`#383838` ×10, `#2c2c2c` ×7, …) — they move to tokens.

**Primitives — 118 → 73** (merges are ≤ 6 units per channel and named; the owner checks them in step 1).

| Scale | Steps (value) | Merged into it |
|---|---|---|
| white | `#ffffff` | |
| gray (12) | 100 `#f5f5f5` · 200 `#e6e6e6` · 300 `#d9d9d9` · 400 `#cccccc` · 500 `#b3b3b3` · 600 `#8c8c8c` · 700 `#757575` · 750 `#5c5c5c` · 800 `#444444` · 850 `#383838` · 900 `#2c2c2c` · 950 `#1e1e1e` | f4f4f4→100, dcdcdc→300, cfcfcf→400, 585858→750, 4f4f4f/4a4a4a/404040→800, 3b3b3b→850 |
| black alpha (7) | a5 `0d` · a10 `1a` · a20 `33` · a30 `4d` · a40 `66` · a50 `80` · a90 `e5` | a15 `26`→a20, a35 `59`→a40 |
| white alpha (8) | a5 · a10 · a20 · a30 · a40 · a70 `b2` · a80 `cc` · a90 `e5` | `b3`→a70, `59`→a40 |
| blue (9 + 2) | 50 `#f2f9ff` · 100 `#e5f4ff` · 200 `#bde3ff` · 300 `#7cc4f8` · 500 `#0d99ff` · 550 `#0c8ce9` · 600 `#007be5` · 700 `#0a6dc2` · 800 `#105cad`; a10 `#0d99ff1a`, a40 `#0d99ff66` | 80caff (unused) dropped; 0768cf (unused) dropped; `#0c8ce926`→a10 |
| slate (3, dark selection) | 700 `#4a5878` · 800 `#394360` · 900 `#32394d` | 536383/667799/30344c (unused or raw) dropped |
| purple (8) | 100 `#f1e5ff` · 200 `#e4ccff` · 300 `#d1a8ff` · 500 `#9747ff` · 600 `#8638e5` · 700 `#7a2ed6` · 800 `#652ca8` · 900 `#473956` | 8a38f5→600 |
| red (8) | 100 `#ffe2e0` · 200 `#ffc7c2` · 300 `#fca397` · 500 `#f24822` · 600 `#dc3412` · 700 `#c4381c` · 800 `#963323` · 900 `#7c2622` | e03e1a→600 |
| green (5) | 100 `#cff7d3` · 300 `#79d297` · 500 `#14ae5c` · 600 `#009951` · 900 `#0a4c2d` | 198f51→600 |
| yellow (7) | 100 `#fff1c2` · 200 `#ffe8a3` · 300 `#f7d15f` · 500 `#ffcd29` · 700 `#c58011` · 800 `#b86200` · 900 `#925711` | f3c11b→500 |
| folder hues (3) | orange `#ffa629` · teal `#0fa8a8` · pink `#ff24bd` | their dark twins (f0941d, 119a9a, e81fae) |

Shadows stay raw inside the 5 effect styles (below); they are not primitives.

**Semantic colours — 115 used tokens → 91** (Light / Dark as primitive aliases; ← the current tokens it replaces).

| Token | Light | Dark | ← current (uses) |
|---|---|---|---|
| text/default | black/a90 | white | text (335) |
| text/secondary | black/a50 | white/a70 | text-secondary (286), ds tabbar-text |
| text/tertiary | black/a30 | white/a40 | text-tertiary (46) |
| text/disabled | black/a30 | white/a40 | text-disabled (22) |
| text/brand | blue/600 | blue/300 | text-brand (26) |
| text/danger · success · warning · component | red/600 · green/600 · yellow/800 · purple/600 | red/300 · green/300 · yellow/300 · purple/300 | text-danger (32), -success (7), -warning (6), -component (5) |
| text/onbrand | white | white | text-onbrand (22), -onsuccess, -ondanger, -oncomponent, -ondisabled (dark #2c2c2c → white), ds menu-text |
| text/onbrand-secondary | white/a80 | white/a80 | text-onbrand-secondary, -ondanger-secondary, ds menu-text-on-highlight-secondary |
| text/oninverse | white/a90 | black/a90 | text-oninverse |
| text/onwarning | black/a90 | black/a90 | text-onwarning |
| text/menu-secondary · menu-disabled | white/a70 · white/a40 | same | ds menu-text-secondary, -disabled |
| icon/default | black/a90 | white | icon (86), icon-hover |
| icon/secondary · tertiary · disabled | black/a50 · a30 · a30 | white/a70 · a40 · a40 | icon-secondary (108), -tertiary (19), -disabled (13) |
| icon/brand | blue/600 | blue/300 | icon-brand (16), icon-selected |
| icon/danger · success · warning · component | red/500 · green/500 · yellow/500 · purple/600 | red/600 · green/600 · yellow/500 · purple/300 | icon-danger, -success, -warning, -component |
| icon/onbrand | white | white | icon-onbrand (10), -oncomponent, -ondisabled |
| icon/oninverse | white/a90 | black/a90 | icon-oninverse |
| bg/default | white | gray/900 | bg (145) |
| bg/secondary | gray/100 | gray/850 | bg-secondary (117) |
| bg/tertiary | gray/200 | gray/800 | bg-tertiary (24) |
| bg/hover | gray/100 | gray/850 | bg-hover (120), bg-pressed |
| bg/transparent-hover · transparent-pressed | black/a5 · a10 | white/a5 · a10 | ds bg-transparent-hover, -pressed, asset-card-bg |
| bg/selected | blue/100 | slate/800 | bg-selected (34), bg-brand-tertiary |
| bg/selected-secondary | blue/50 | slate/900 | bg-selected-secondary |
| bg/selected-hover | blue/200 | slate/700 | bg-selected-hover, bg-onselected |
| bg/brand | blue/500 | blue/550 | bg-brand (44), ds file-design |
| bg/brand-hover | blue/600 | blue/700 | bg-brand-hover, -pressed |
| bg/danger · danger-hover · danger-tertiary | red/500 · 600 · 100 | red/600 · 700 · 900 | bg-danger (10), -hover, -pressed, -tertiary |
| bg/success · success-tertiary | green/500 · 100 | green/600 · 900 | bg-success (10), -tertiary |
| bg/warning · warning-tertiary | yellow/500 · 100 | yellow/500 · 700 | bg-warning, -tertiary |
| bg/component · component-hover · component-tertiary | purple/500 · 600 · 100 | purple/600 · 700 · 900 | bg-component, -hover, -tertiary |
| bg/disabled | gray/300 | gray/700 | bg-disabled |
| bg/inverse | gray/900 | white | bg-inverse |
| bg/canvas | gray/100 | gray/950 | ds canvas-default |
| bg/menu · menu-highlight | gray/950 · blue/550 | same | ds menu-bg (12), menu-highlight |
| bg/tabbar · tabbar-hover | gray/200 · 300 | gray/850 · 800 | ds tabbar-bg, tabbar-hover |
| bg/switch-hover | gray/100 | gray/750 | ds switch-hover |
| bg/knob | white | white | ds switch-knob, picker-thumb |
| bg/scrim · overlay | black/a40 · a50 | same | ds scrim; picker-preview-shade, asset-variants-bg |
| border/default | gray/200 | gray/800 | border (203), ds rail-separator |
| border/strong | gray/900 | white/a90 | border-strong |
| border/hover | gray/400 | gray/750 | ds card-border-hover |
| border/selected | blue/500 | blue/550 | border-selected (60), ds focus-color |
| border/selected-strong | blue/600 | blue/300 | border-selected-strong, border-brand-strong |
| border/brand · danger · danger-strong · warning · component | blue/200 · red/200 · red/600 · yellow/200 · purple/200 | blue/800 · red/800 · red/300 · yellow/900 · purple/800 | the same names |
| border/disabled | black/a30 | white/a40 | border-disabled-strong |
| border/onbrand | white | white | border-oncomponent-strong |
| border/translucent · translucent-strong | black/a10 · a20 | white/a10 · a20 | ds border-translucent, -strong |
| border/tabbar | gray/300 | gray/800 | ds tabbar-line, tabbar-separator |
| border/menu | gray/850 | gray/850 | ds menu-separator |
| *component:* scrollbar/thumb · thumb-hover | black/a20 · a40 | white/a20 · a40 | ds scrollbar-* |
| *component:* selection/text · marquee | blue/a40 · a10 | same | ds text-selection, marquee-fill |
| *component:* picker/ring · stop-shadow · empty | black/a30 · a20 · gray/300 | same | ds picker-thumb-ring, -stop-shadow, -preview-empty (≈) |
| *component:* ai/shine | white/a70 | white/a30 | ds ai-shine |
| *component:* folder/blue · red · green · yellow · purple · orange · teal · pink · gray | brand hues 500, orange · teal · pink, gray/500 | 550/600 steps where the scale has one, else same | ds folder-* |

Count: text 15, icon 11, bg 32, border 16, component 17 = **91**. The 108 unused role tokens (most of Figma's
published list: `-hover`/`-pressed` of every tone, `*-secondary`, `*-tertiary` borders, figjam, assistive …) are not
created; one is added only when the app starts using it.

**Effect styles**: Elevation 100 (12 uses), 200 (12), 400 menu/panel (12), 500 modal (10), Menu (8). Effect styles have
no modes and Dark has a different layer list (an inset highlight), so each is built twice — `Elevation/100/Light`,
`Elevation/100/Dark` … (Menu is the same in both) = **9 styles**, shadow colours raw inside them.

### b) Sizes (one collection "Sizes", one mode; aliases of a `Number` primitive scale)

| Variable | Values (uses) |
|---|---|
| space/ | 0 · 2 (51) · 4 (414) · 6 (50) · 8 (813) · 12 (184) · 16 (304) · 20 (12) · 24 (59) · 32 (37) · 40 (4) · 48 (26) · 64 (12) — **13** |
| radius/ | 0 · 2 (46) · 5 (267) · 9 (7, absorbs asset-tile 10) · 13 (43) · full (61) — **6**; raw 1/3/4/6 px in CSS are rounded to 2 or 5 |
| stroke/ | 1 (169) · 2 (10) — **2**; focus width 1, offset 1 |
| size/ controls | control 24 (213), control-large 32 (46), row 32 (layer, list header, account), row-large 40 (section header, list row), nav 28 (Home sidebar), checkbox 16, switch 28×16, switch-large 32 |
| size/ icons | icon 16, icon 24 (the two boxes every icon is drawn in; 10/32/48 appear once each, as scaled instances) |
| size/ surfaces | toolbar 48, rail 56, tabbar 38, panel 240, popover 240, menu-max 320, dialog 320 · 480 · 640 |

Off-scale paddings in CSS (1, 5, 7, 9 px — 1-px border compensation) are not variables: in the file the stroke is
inside and the padding is the scale value.

### c) Typography — 20 font tokens → 9 text styles

| Style | Font | Uses | Absorbs |
|---|---|---|---|
| Body small | Inter 450 9/14, +0.045 | 34 | panel-label, ruler |
| Body medium | Inter 450 11/16, +0.055 | 235 | menu (identical), body-medium-regular (400, 28) |
| Body medium strong | Inter 550 11/16 | 103 | |
| Body large | Inter 450 13/22, −0.0325 | 19 | body-large-regular (8), settings-caption |
| Body large strong | Inter 550 13/22 | 26 | |
| Heading medium | Inter 550 15/25, −0.13 | 12 | settings-title, settings-heading |
| Heading large | Inter 550 24/32, −0.47 | 6 | |
| Code | SF Mono 400 11/16 | 10 | |
| Key | Inter 400 12/15 | 1 + KeyCap | menu-key, settings-cell (12/16, 9), settings-sample |

The merges marked with a weight or size change (regular → 450, settings-cell 12 → Key) are for the owner to confirm
in step 4; if he keeps one, it becomes a tenth style, not an override.

### d) Components

Evidence = JSX uses / files. **V** = variant property, **P** = component property. "Replaces" lists what is retired.

**Atoms**

| Component | Variant properties (values used) | Content properties | Replaces / evidence |
|---|---|---|---|
| **Icon / ‹name›** | Set = Figma · Wecra; Style = Default · Outline (as decided) | — | 281 `<Icon>`, 78 icons at 16, 303 at 24 in code; the file has 135 |
| **Button** | Variant = Primary (157) · Secondary (230) · Ghost (16) · Destructive (13) · Destructive secondary (4); Size = Default 24 (403) · Large 32 (40); State = Default · Hover · Pressed · Focus · Selected · Disabled · Loading | P: Start icon (bool, 32 uses, swap: preferred `24.plus.small`, `24.design`, `24.library`, …), Label (text), End icon (bool, swap: `16.chevron.down`) | Button, MenuButton's label + chevron (64), ToolTextButton (10). `tinted` (10) is Secondary + Selected; `link` (3) becomes a text with `text/brand` (no variant). 5×2×7 = 70 at most, only used combinations built (Selected only on Secondary/Ghost, Loading only on Primary/Secondary) ≈ 50 |
| **Icon button** | Tone = Default (106) · Secondary (97); Size = Default 24 (199) · Large 32 (4 + toolbar/rail/tab bar); State = Default · Hover · Pressed · Focus · Selected · Mixed · Disabled | P: Icon (swap, preferred the 24 set), Menu chevron (bool — toolbar tools) | IconButton (203), ToggleIconButton (22: Selected/Mixed), HelpButton (1), ToolButton (3), close / header buttons of Popover, Dialog, Menu, ColorPicker, and ~170 raw `<button>`s (AgentsPanel 12, ShareDialog 11, DevPanel 11, Multiplayer 7, Thread 6 …) |
| **Checkbox** | Checked = False · True · Mixed; State = Default · Hover · Focus · Disabled | P: Label (bool + text) | 64 uses; `tone` panel/brand → one look (owner check) |
| **Radio** | Checked = False · True; State = Default · Focus · Disabled | P: Label | RadioGroup (23) |
| **Switch** | Checked = False · True; Size = Default (20) · Large (6); State = Default · Hover · Disabled | P: Label (bool + text) | 26 |
| **Badge** | Tone = Default (11) · Brand (3) · Success (4) · Warning (4) · Danger (2) · Component | P: Label (text) | Badge (26), Tabs count. `count` is just a short label |
| **Avatar** | Size = 16 (4) · 24 (14) · 28 (1) · 48 (1) | P: Image (bool) / Initial (text) | 27 |
| **Spinner** | Size = 16 (26) · 24 (16) | — | 54 |
| **Swatch** | Shape = Square · Round; Size = 14 · 16 | P: Mixed (bool) | 10 |
| **Divider** | Orientation = Horizontal · Vertical | — | 16, menu separators |
| **Key cap** | Size = Default · Small; State = Default · Lit · Recording | P: Key (text) / Icon (swap) | KeyCap, Kbd, menu shortcut glyphs |
| **Skeleton** | Radius = Small · Medium · Full | — | Skeleton |
| **Field** | Variant = Filled (≈ 270) · Outlined (48) · Ghost (42); Size = Default · Large (10); State = Default · Hover · Focus · Disabled · Invalid | P: Start content (bool) + Start icon (swap) / Prefix (text), Value (text), Placeholder (bool, `text/tertiary` layer), End content (bool) + End icon (swap: chevron, clear) / Suffix (text) | the base of TextInput (121), NumericInput (89), Select (154), SearchField (23), ColorInput (11) |
| **Text area** | State = Default · Focus · Disabled | P: Value / Placeholder | TextArea (22) |
| **Slider** | State = Default · Focus · Disabled | — | Slider (2), colour picker hue / alpha |

**Molecules** (made only of atom instances; few or no variants)

| Component | Variants | Content | Replaces / evidence |
|---|---|---|---|
| **Select** | — (Field variant/size passed through) | Field instance with End icon = chevron; Value | 154 |
| **Search field** | Size = Default · Large | Field + `search` icon + clear | 23 |
| **Numeric input** | — | Field + Prefix (icon or letter) + Suffix (unit) | 89 |
| **Color input** | — | Swatch + Field (hex) + Field (%) | 11 |
| **Segmented control** | Tone = Panel · Toolbar | Slot of **Segment** (State = Default · Hover · Selected; Icon or Label) | 41 |
| **Tab** + **Tabs** | Tabs Style = Default (15) · Card (1); Tab State = Default · Hover · Selected | Tab: Label, Badge (bool); Tabs: slot of Tab | 16 |
| **Menu item** | State = Default · Highlighted · Disabled; Kind = Item · Header · Separator | P: Check (bool), Glyph (bool + swap: icon / swatch / avatar), Label, Hint (bool + text), Shortcut (bool + text), Badge (bool), Submenu chevron (bool) | the 100 menu rows (MenuItem fields in `util/menu.ts`) |
| **Sidebar item** | State = Default · Hover · Selected · Drop target | P: Icon (swap), Label, Count (bool + text), Trailing (bool), Indent (number variable) | 12 + Home nav |
| **List row** + **List header** | State = Default · Hover · Selected · Drop target · Muted | Slot of cells | ListRow (5), FileRow |
| **Layer row** / **Page row** | State = Default · Hover · Selected · Selected-child; Kind = Frame · Component · Instance … only the icon differs → **swap, not variant** | P: Icon, Name, Lock / Eye (bool) | LayerRow, PageRow |
| **Property row** | Span = 1 · 2 | slots: Label, Control(s), Action, Action 2 (Icon button) | PropertyRow (33), PropertyGrid (6) |
| **Banner** | Tone = Default (3) · Brand (4) · Warning (11) · Danger (4) | P: Icon (swap), Message, Action (bool → Button Ghost), Dismiss (bool → Icon button) | 22 |
| **Toast** | — | Message, Action (bool → Button) | 230 `showToast` calls, 1 component |
| **Tooltip** | — | Label, Shortcut (bool) | 47 `tooltip=` props |
| **Empty state** | Size = Panel · Page | Icon (swap), Title, Body (bool), Action (bool → Button Secondary) | 53 |
| **Breadcrumb** | — | slot of Button Ghost + chevron | 2 |
| **Inline edit** | State = Default · Editing | Field (Ghost) | 9 |

**Organisms** (instances + slots; variants only where the frame changes)

| Component | Variants | Built of |
|---|---|---|
| **Menu** | — | slot of Menu item (dark in both themes: `bg/menu`, Elevation Menu, radius 13) — ContextMenu (27), menus of MenuButton (64), Select |
| **Popover** | Header = Title · Tabs · None | Title + Icon button (close) + slot (35 uses) |
| **Dialog** | Size = Small 320 (8) · Medium 480 (47) · Large 640 (17) | Title, Icon button (close), body slot, footer slot of Buttons (102 uses) |
| **Panel section** | State = Open · Closed; Pad = None · Default · Large | Title, Actions slot (Icon buttons), body slot (23) |
| **Color picker** | Tab = Custom · Libraries | Segmented control, Slider ×2, Color input, Icon buttons |
| **Alignment matrix** | — | 9 cells (State = Default · Hover · Selected) |
| **Toolbar** (bottom) + **Editor toolbar** | Mode = Design · Draw · Dev | slots of Icon button Large (Menu chevron) and Divider |
| **Rail** | — | Rail item (State = Default · Hover · Selected) slot |
| **Tab bar** | — | Home tab + Tab bar tab (State = Default · Hover · Selected) |
| **File card** / **Folder card** | State = Default · Hover · Selected | thumbnail, title, meta, Avatar / folder colour (`folder/*`) |
| **Sidebar** (Home), **Layers panel**, **Properties panel** | — | slots of the molecules above |

**Screens** (step 12): the 33 captures in `tools/ui-kit/out/screens/` (home-grid/list/folder/trash, editor-*, dialog-*,
menu-*, popover-*), each built only from instances, Light, with one Dark copy of Home and the editor.

### e) Icons

- Keep as decided: one component set per icon, **Set = Figma · Wecra**, **Style = Default · Outline**; drawn on a 16
  or 24 box (`size/icon-16`, `size/icon-24`), fill bound to `icon/default` so instances recolour by override of the
  role (`icon/secondary`, `icon/brand` …), never by raw colour.
- Add a **"Icon set" collection** (modes Figma / Wecra) with a string variable `icon/set`, and `icon/style`
  (Default / Outline), bound to the Set / Style variant property of every icon instance inside the atoms; switching
  the mode on a page switches all icons (Figma binds string variables to variant properties).
- Preferred values on every icon swap property: the 24 set for Button / Icon button, the 16 set for End icons and
  Menu item glyphs.

### f) Build order (each step small; each ends with a readback that must pass)

Work in a **new file "Wecra UI v2"**; copy the icon sets from the old file; the old file stays as the reference
until step 12 passes.

| # | Step | Readback must show |
|---|---|---|
| 1 | Primitives collection (one mode, hidden, no scopes): 73 colours, Number scale (0…64, full) | 73 colour + number vars; 0 duplicates by value; merges table signed off |
| 2 | Semantic colours (Light / Dark) | 91 vars; every value an alias in both modes (0 raw); scopes set; code syntax = CSS name |
| 3 | Sizes collection: space 13, radius 6, stroke 2, size/* | each an alias of the scale; scopes gap/padding, radius, stroke, width/height |
| 4 | 9 text styles, 9 effect styles | names and values as in c) and a); no other styles |
| 5 | Icon set collection + icon sets re-bound | every icon fill = `icon/default`; switching the mode changes Set on a test instance |
| 6 | Button | ≤ 50 variants, 4 axes, 3 content props; 0 unbound fill / stroke / padding / gap / radius / text |
| 7 | Icon button | Tone × Size × State only; Icon swap with preferred values |
| 8 | Form atoms: Checkbox, Radio, Switch, Field, Text area, Slider | same "0 unbound" check per set |
| 9 | Small atoms: Badge, Avatar, Spinner, Swatch, Divider, Key cap, Skeleton | as above |
| 10 | Molecules (table order: Select … Inline edit) | each contains only instances of atoms + its own frame; Menu item covers the 13 MenuItem fields |
| 11 | Organisms | no raw button / input frames inside; Dialog footer uses Button; Menu uses Menu item |
| 12 | Screens (33) | built from instances only; pixel diff against the captures (`shots.mjs`, `diff.mjs`) within the old tolerance |
| 13 | Code follow-up | regenerate `token-map.json` from these tables; code adds the primitive layer and the merges in a later round |

Global check after every step: no component is a copy of another, no variable with the same meaning twice, no
variant combination that the app does not use.
