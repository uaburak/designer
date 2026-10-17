# 07 — Paints, colour, gradients, images, blend modes

Figma Design desktop 126.9.13, read statically on 2026-10-16 from the cached editor build (`~/.cache/figma-rea/figma/`, outside the repo), following `~/.cache/figma-rea/BRIEF.md`. Figma's code is not copied here. This file records behaviour, numbers, enums and strings, each with its evidence.

Status tags:
- **CONFIRMED**: read directly in the build, or in a live capture of Figma in `docs/research/figma/live/`.
- **INFERRED**: deduced from what was read. Where an inference rests on Figma's help site rather than the build, the finding says so.

Evidence formats:
- `chunk @byte-offset`, or `chunk: "snippet"`, for the JavaScript chunks.
- `wasm: "string"` for a string in `fullscreen__fullscreen-wasm__compiled_wasm.wasm`. The `strings -n 6` dump has 103 967 lines.
- `live: file` for a capture in `docs/research/figma/live/`.

## 1. Scope and sources

**Covered:**
- The Fill and Stroke sections: add, remove, reorder, visibility, mixed values.
- Selection colors.
- Every paint type.
- The colour picker: layout, sizes, formats, input parsing, sliders, wheel, swatch sets.
- The eyedropper and its loupe.
- Colour spaces: the document profile, convert vs assign, authored colours.
- The gradient editor: stop bar, stop list, flip, rotate, interpolation.
- Image, GIF and video fills: scale modes, tile scale, rotation, adjustments, formats, sizes.
- Pattern fills.
- Blend modes: list, order, pass-through.
- Layer opacity and the number-key shortcuts.
- Masks.

**Not covered:** effects (chapter 08 and `docs/research/rea/effects.md`), variables and styles (chapter 11), and export colour profiles in depth (chapter 15).

**Sources read:**

| Source | What it holds | Where |
|---|---|---|
| `figma_app.min.js` | ColorControls (picker body, formats, inputs), colour-format enum, colour-space enums, image settings modal (scale modes, adjustments, tile scale), blend-mode option list, paint-type and scale-mode formatters, eyedropper accessibility strings | ColorControls @3 628 000–3 647 000; enums @7 368 261; image modal @3 667 000–3 685 000; blend list module 835764 @3 580 196; formatters @1 696 383 |
| `3187.min.js` (`7362` and `5519` are near-identical copies) | Gradient stop bar (GradientControlInner), gradient editor, stop list, flip, interpolation selects, colour-picker modal shell, swatch sets, pattern settings, document colour-profile modal | gradient @5 349 000–5 384 000; swatch sets @5 437 500–5 448 000; profile modal @1 231 500–1 240 000 |
| `2108.min.js` | Colour parsing: hex rules, the CSS named colours, `rgb()` / `hsl()` / `lab()` / `oklab()` / `oklch()` / `color()`, authored-colour CSS output, the hex formatter | modules 640649 @2 554 141, 822500 @374 502, 785738 @1 672 590 |
| `8936.min.js` (`7535` and `774` are copies) | Fill / Stroke paint list, Selection colors panel | @207 500–216 000; @236 500–244 000 |
| `4989.min.js` | The "+" entry-point menus (paint types, stroke kinds) | @113 000–122 000 |
| `3653.min.js` | Eyedropper v2: loupe canvas, panel, keys, desktop overlay window | @430 000–490 000 |
| `5581.min.js` | Mask panel (mask type select) | @90 500–95 000 |
| `2622.min.js` | Image decode and downscale (read in detail by canvas.md §2.5–2.6) | @854 472 |
| wasm strings | The keyboard-shortcut JSON (lines 11 017–11 223), image MIME types, eyedropper / gradient behaviour class names, visual-bell keys | lines named |
| `docs/research/figma/figma-schema-106.kiwi` | `Paint`, `PaintType`, `BlendMode`, `ImageScaleMode`, `MaskType`, `ColorSpace`, `AuthoredColor`, `PaintFilterMessage`, pattern enums, `DocumentColorProfile` | — |
| `docs/research/figma/live/popovers/fill-picker-*.txt`, `blend-mode-menu.txt`, `live/design/{rectangle,image-fill,mixed-multi}.txt` | Live geometry and English labels of the picker and the panels | — |

**Prior work reused:**
- `docs/research/rea/effects.md` §2.20–2.25 covers the gradient t-functions, dither, the interpolation colour space (Paint 41 / 42), the image scale-mode transforms, the exact image-adjustment shader, and blend-mode compositing. It is summarised in §13 below, not repeated.
- `docs/research/rea/canvas.md` §2.5–2.6 covers the image downscale rules and image decode colour handling. It is summarised in §8.6.

## 2. Data model (Figma's schema)

All CONFIRMED from `figma-schema-106.kiwi`.

| Item | Values / fields |
|---|---|
| `PaintType` | SOLID 0, GRADIENT_LINEAR 1, GRADIENT_RADIAL 2, GRADIENT_ANGULAR 3, GRADIENT_DIAMOND 4, IMAGE 5, EMOJI 6, VIDEO 7, PATTERN 8, NOISE 9, CUSTOM 10 |
| `Paint` | type 1, color 2, opacity 3, visible 4, blendMode 5, stops 6, transform 7, image 8, imageThumbnail 9, imageScaleMode 10, rotation 11, scale 12, filterColorAdjust 13, paintFilter 14, emojiCodePoints 15, animatedImage 16, animationFrame 17, video 18, originalImageWidth 19, originalImageHeight 20, colorVar 21, imageShouldColorManage 22, stopsVar 23, thumbHashBase64 24, thumbHash 25, sourceNodeId 26, spacing 27, patternTileType 28, verticalAlignment 29, horizontalAlignment 30, imageVar 31, id 32, altText 33, noiseType 34, density 35, noiseSize 36, patternSpacing 37, opacityVar 38, customEffectId 39, componentPropAssignments 40, interpolationColorSpace 41, interpolationHueMethod 42, gradientVar 43, authoredColor 44, authoredStops 45, paintVar 46 |
| `PaintFilterMessage` (image adjustments) | tint 1, shadows 2, highlights 3, detail 4, exposure 5, vignette 6, temperature 7, vibrance 8, contrast 9, brightness 10. Only seven are in the UI (§8.4). |
| `ImageScaleMode` | STRETCH 0 (shown as "Crop"), FIT 1, FILL 2, TILE 3 |
| `BlendMode` | PASS_THROUGH 0, NORMAL 1, DARKEN 2, MULTIPLY 3, LINEAR_BURN 4, COLOR_BURN 5, LIGHTEN 6, SCREEN 7, LINEAR_DODGE 8, COLOR_DODGE 9, OVERLAY 10, SOFT_LIGHT 11, HARD_LIGHT 12, DIFFERENCE 13, EXCLUSION 14, HUE 15, SATURATION 16, COLOR 17, LUMINOSITY 18 |
| `MaskType` (NodeChange 317) | ALPHA 0, OUTLINE 1 ("Vector" in the UI), LUMINANCE 2 |
| `ColorSpace` (for `AuthoredColor`) | DEFAULT 0, SRGB 1, DISPLAY_P3 2, HSL 3, HSB 4, OKLAB 5, OKLCH 6 |
| `AuthoredColor` | space 1, c0 2, c1 3, c2 4, c3 5 (c3 = alpha). `AuthoredColorStop` = authoredColor 1, position 2. |
| `DocumentColorProfile` (NodeChange 349) | LEGACY 0, SRGB 1, DISPLAY_P3 2 |
| `ColorProfile` (image tag, NodeChange 341) | SRGB 0, DISPLAY_P3 1 |
| `PatternTileType` | RECTANGULAR 0, HORIZONTAL_HEXAGONAL 1, VERTICAL_HEXAGONAL 2 |
| `PatternAlignment` | START 0, CENTER 1, END 2 |
| `InterpolationColorSpace` | DEFAULT 0, OKLAB 1, OKLCH 2, HSL 3, SRGB_LINEAR 4 |

The JS runtime has a wider authored-colour enum: `DEFAULT 0, SRGB 1, DISPLAY_P3 2, HSL 3, HSB 4, OKLAB 5, OKLCH 6, CMYK 7`. CMYK is gated (`zine_support`) and has no kiwi value in schema 106 (CONFIRMED, `figma_app @7 368 853`).

Other JS enums (all CONFIRMED, `figma_app @7 368 261–7 369 400`):
- `ColorFormat`: HEX 0, RGB 1, CSS 2, HSL 3, HSB 4, UIColor 5, CMYK 6.
- `ColorProfile`: SRGB 0, DISPLAY_P3 1.
- Colour-conversion kinds: NO_CONVERSION, SRGB_TO_DISPLAY_P3, DISPLAY_P3_TO_SRGB, HLG_BT2020_TO_SRGB / _DISPLAY_P3, PQ_BT2020_TO_SRGB / _DISPLAY_P3. The last four are for HDR video.
- `DocumentColorProfile`: LEGACY / SRGB / DISPLAY_P3.
- `ExportColorProfile`: DOCUMENT 0, SRGB 1, DISPLAY_P3_V4 2, CMYK 3.

## 3. The Fill and Stroke sections

### 3.1 Layout (live, rectangle selected; right panel 240 px wide)

| Element | Geometry | Evidence |
|---|---|---|
| Section title "Fill" | x 16, 11 px / 550 | live: design/rectangle.txt |
| Header buttons | "Fill, Apply styles and variables" (4-dot icon) at x 180, "Add fill" (+) at x 208; both 24 × 24, r 5 | same |
| Paint row | 156 × 24 field (bg #383838, r 5). It holds a 14 × 14 chit (r 2) at x 21, a hex input of 77 px, then the opacity input of 38 px + "%". | same |
| Row buttons | "Toggle visibility" (eye) at x 180, "Remove" (−) at x 208; 24 × 24 | same |
| Image row | The chit + "Image" label button is 100 px wide; opacity follows | live: design/image-fill.txt |
| Stroke title | Shown dimmed (`#ffffffb2`) when empty | live: design/rectangle.txt |

### 3.2 Behaviour

| Rule | Detail | Status / evidence |
|---|---|---|
| Add | Fill "+" runs the engine action `add-fill-to-selection`; in a style it runs `add-fill-to-style-selection`. Stroke "+" runs `add-stroke-to-selection`. The new row's picker opens automatically unless `preventAutoToggle` is set. | CONFIRMED, `8936 @213 000` |
| Add menu (entry-point) | When enabled, "+" opens a menu, in this order: Solid, Gradient, Pattern, Image, Video, a divider, then "Custom effect" (shader; feature-gated). | CONFIRMED, `4989 @116 000` |
| One pattern per list | When the list already holds a PATTERN paint, the menu's Pattern item and the picker's Pattern tab are disabled. | CONFIRMED, `8936: "PATTERN"===e.type).length>=1"` |
| Stroke "+" with hidden strokes | If strokes exist but none is visible, they are all made visible. If the stroke weight is 0, it becomes 1. | CONFIRMED, `4989 @119 500` |
| Stroke "+" tooltip | "Add stroke" when the list is empty, else `section_stroke.tooltip_addStrokeFill`. | CONFIRMED, `8936 @213 500` |
| Stroke kinds menu | Basic / Dynamic / Brush (Draw strokes; see chapter 05). | CONFIRMED, `4989 @118 900` |
| Remove | Filters the paint out at that index, then deselects the property. | CONFIRMED, `8936 @211 000` |
| Reorder | Rows are draggable (`onReorder`). Row 0 is the top paint in the panel. | CONFIRMED (handler), `8936` |
| Visibility | Eye toggle per paint (`visible`). `hasVisiblePaintBelow` is computed per row. It is used by the picker's contrast checker. | CONFIRMED |
| Single row | `singletonRow` = list length ≤ 1. | CONFIRMED |
| Mixed | A multi-selection with different paint lists shows "Click + to replace mixed content" and a "Style" header button. Pressing + replaces the paints of every selected node. | CONFIRMED, live: design/mixed-multi.txt |
| Row hex input | Typing autocompletes variable names (a11y text "Autofill available. Type to see suggestions."). | CONFIRMED (live string); key `fullscreen.accessibility_dom.variable_search.autofill_label` INFERRED |
| Remove fill / stroke shortcuts | `remove-fill` Alt+/ (Alt+, on German, Nordic, Italian, Spanish, Portuguese layouts; Alt+: on AZERTY). `remove-stroke` Shift+/. `swap-fill-and-stroke` Shift+X. | CONFIRMED, wasm shortcut JSON |
| New fill colour | Not readable statically: the engine action decides. | open question 1 |

## 4. Selection colors

| Rule | Value | Evidence |
|---|---|---|
| Sources | `mirror.selectionPaints`: `paints` (each with `count`, `uniqueNodeIds`, `conflictNodesCount`) and `styles`. For multi-selection, `styles`; for one node, `stylesDirectlyOnSingleNode`. | CONFIRMED, `8936 @238 000`; `figma_app @3 594 477` |
| Order | Variable-bound paints first, then styles, then raw paints | CONFIRMED, `8936: "[...l.paints.filter(e=>!!e.paint.colorVar),...l.styles]"` |
| Fewer than 4 entries | Always expanded, not collapsible | CONFIRMED |
| 4 or more | Collapsible. It **starts collapsed**: the header shows the first 3 swatches and a "+N" badge, N = total − 3. | CONFIRMED |
| Expanded, more than 12 | Shows 11 rows, then a "See all N colors" button. Clicking it shows all. | CONFIRMED, `$<=12?$:11` |
| Too many nodes | When the engine stops collecting (`emptyDueToLimitExceeded`), a "Show selection colors" button calls `ignoreLimitWhenCollectingPaints()`. The node limit lives in C++ and was not read. | CONFIRMED (flow); limit: open question 2 |
| Editing | Each row edits that colour on every node that uses it. The picker hides the Image and Pattern tabs. A paint used more than 500 times debounces its edits. | CONFIRMED, `debounce:!!t.count&&t.count>500` |
| Reset | The collapsed state resets when the scene selection changes or on undo (`forceUpdateForUndo`). | CONFIRMED |
| Select matching | `select_item_using_this_color` | CONFIRMED (key) |
| Live layout | Title row 240 × 40 (a button); rows are like the fill rows | live: design/mixed-multi.txt |

## 5. The colour picker

### 5.1 Shell

| Item | Value | Evidence |
|---|---|---|
| Modal width | **240 px**; **280 px** when a CUSTOM (shader) paint is open | CONFIRMED, `figma_app: "modalWidth:ty?280:240"`; `ee=(0,v.K_)("240px")` |
| Header | "Color picker" (a11y title); tabs **Custom** and **Libraries**, plus a CMS tab when bound to CMS; "New style or variable" button at x 180; Close at x 208 | CONFIRMED, live: fill-picker-solid.txt; `3187 @5 351 000` |
| Opening tab | Libraries if the paint is bound to a library asset, else Custom | CONFIRMED, `3187: "initialView||(t?"library":n?"cms":"custom_color")"` |
| Paint-type tabs (row y 48, 24 × 24 every 28 px) | Solid, Gradient, Pattern, Image, Video, Shader (CUSTOM, beta); Blend mode at x 180 and "Check color contrast" at x 208 (Solid only) | CONFIRMED, live |
| Closing | Clicking outside closes it unless the click is inside the canvas root or the picker's own layers. Closing turns the eyedropper off. | CONFIRMED, `3187 @5 349 000` |
| Paint opacity row | Large preview rows show an "Opacity" field at the bottom | CONFIRMED, module 118813 |

### 5.2 Solid tab layout (live, 240 × 537)

| Element | Geometry |
|---|---|
| Saturation/brightness square ("Color picker reticle") | 208 × 208 at (16, 97); reticle 16 px |
| Sample color (eyedropper) | 24 × 24 at (16, 327) |
| Hue slider | 180 × 24 at (48, 313); thumb 16 px |
| Opacity slider | 180 × 24 at (48, 341) |
| Format select | 55 × 24 at (16, 373), default "Hex" |
| Hex input | 89 × 24 (left half), opacity 54 × 24 with "%" |
| Swatch-set select | 208 × 24 at (16, 425), default "On this page" |
| Swatches | 16 × 16, radius 20 %, 24 px pitch, **9 per row** (x 16 … 208) |

The whiteboard variant uses a 184 px square (`size:184`) (CONFIRMED, `figma_app @3 638 500`).

### 5.3 Formats

| Item | Value | Evidence |
|---|---|---|
| Menu (Design) | Hex, RGB, CSS, HSL, HSB, plus CMYK when supported. Live menu: Hex · RGB · CSS · HSL · HSB. | CONFIRMED, `figma_app @3 646 885`; live: fill-picker-color-format-menu.txt |
| Inspect panel (Dev Mode) | Hex, RGB, HSL, HSB, UIColor (when the platform is iOS), else CSS in place of UIColor | CONFIRMED, `figma_app: "eN=[…UIColor],eR=[…CSS…]"` |
| Persistence | `colorFormat` is a user preference shared by the picker, the eyedropper and Inspect. CSS falls back to RGB where unavailable, as do UIColor and CMYK. | CONFIRMED, `figma_app: "t===o.NV.CSS&&e||t===o.NV.UIColor&&!e?o.NV.RGB:t"` |
| Authored spaces | With `ce_tl_color_spaces`, a colour authored in HSL or HSB opens in that format; any other non-DEFAULT space opens in CSS | CONFIRMED, `figma_app @3 632 000` |
| Hex field | 6 hex digits in uppercase (`#` hidden in the panel), plus a separate opacity % | CONFIRMED |
| RGB fields | Three 0–255 fields + opacity (the grid is `1fr 1fr 1fr 54px`) | CONFIRMED, `new L.o1({normalizeFactor:255,min:0,max:1})` |
| HSL / HSB fields | H 0–360, S and L/B 0–100 + opacity. Tooltips: Hue, Saturation, Lightness / Brightness. | CONFIRMED |
| CSS field | Plain colours: `rgba(R, G, B, A)` (A to 4 dp; `color(display-p3 …)` in P3). Authored colours: `hsl(Hdeg S% L% / A)`, `oklab(L% a b / A)`, `oklch(L% C Hdeg / A)`, `color(srgb …)` / `color(display-p3 …)`, values to 2 dp (4 dp in another formatter). | CONFIRMED, `7362 @2 133 805`; `2108 @2 554 141` |
| CMYK | Four sliders C/M/Y/K, 0–1, step 0.01, big step 0.1, value text "N%". A white-to-ink track per channel. Hides the SV square and the eyedropper. | CONFIRMED, `figma_app @3 639 700` |

### 5.4 Hex and colour-string parsing (any colour field)

The order of attempts is: `rgb()` / `rgba()` → `color(display-p3 …)` / `color(srgb …)` → a CSS named colour → `rgb%` / `hsl()` / `lab()` / `oklch()` / `oklab()` → hex. All CONFIRMED (`2108 @2 554 141`, functions `u`, `E`, `f`).

| Hex digits typed (after stripping any leading non-hex characters) | Result |
|---|---|
| 1 | Grey: the digit repeated (e.g. `8` → #888888) |
| 2 | Grey: the byte repeated (`80` → #808080) |
| 3 | Short form RGB (`f80` → #FF8800) |
| 4 (alpha parsing on) | Short form RGBA |
| 5 (alpha on) | RGB short + 2-digit alpha |
| 6 or more (alpha off), or 6 (alpha on) | RRGGBB; extra digits ignored when alpha is off |
| 7 (alpha on) | RRGGBB + 1-digit alpha |
| 8+ (alpha on) | RRGGBBAA |

- **Named colours**: the full 148-name CSS list (aliceblue … yellowgreen, with both gray/grey spellings) (CONFIRMED).
- **Lenient vs strict**: the non-strict parser takes the first run of hex digits after any junk. Strict mode accepts only `#?hex;?` (CONFIRMED).
- **Arrow keys in the hex field**: they step the channel under the caret. Characters 1–2 are R, 3–4 G, 5–6 B (`getIncrementTargets`). Plain arrows step by 1, Shift by 10 in 0–255 units (INFERRED from the base formatter's nudge 1 / 10).
- **Lab conversion**: D65, 95.047 / 100 / 108.883, then the sRGB OETF (CONFIRMED).

### 5.5 Sliders, the square and the wheel

| Control | Range / step | Evidence |
|---|---|---|
| Hue slider | 0–359°, step 1, big step 10, **loops**; value text "N°" | CONFIRMED, `3187 @7 902 452` |
| Opacity slider | 0–1, step 0.01, big step 0.1 | CONFIRMED |
| SV square keys | PageUp / PageDown jump to the top / bottom, Home / End to the left / right; arrows step | CONFIRMED |
| SV square pointer | s = x, v (or l) = 1 − y, clamped to [0, 1]; an 8 px top inset is subtracted (`p=8`) | CONFIRMED, `3187 @5 346 320` |
| Wheel on the square | delta = (−dx + dy) / 2000. Plain wheel: **hue** wraps around. **Alt + wheel: alpha**, rounded to 0.001 and snapped to the nearest 10 % when within 0.3 %, clamped to [0, 1]. Ctrl + wheel is ignored (it zooms). | CONFIRMED |
| Hue memory | When saturation becomes 0, or lightness 0 / 1, or brightness 0, the previous saturation and hue are kept, so dragging back restores them. Hue 0 ↔ 1 flips keep the old hue. | CONFIRMED, function `ei` @3 631 000 |
| Colour equality | Compared after `Math.fround` per channel, to skip no-op updates | CONFIRMED |

### 5.6 Swatch sets (below the picker)

| Item | Value | Evidence |
|---|---|---|
| Sets | **On this page** (`current_page_colors`), always first. **Local assets** (`local_assets`) only when the file has COLOR variables or FILL styles. Then a separator and each subscribed library except the current file, sorted by file name. | CONFIRMED, `3187 @5 445 167` |
| On this page | `getColorsUsedOnCurrentPage()` from the engine, as a NODE_CHANGES message: name + first fill paint. Recomputed per page. | CONFIRMED |
| Local / library content | COLOR variables sorted by `sortPosition` first, then FILL styles | CONFIRMED |
| Remembered set | localStorage `library-color-swatch-selected-swatch-set-id` | CONFIRMED |
| Grid | 9 per row; 4 placeholder rows while loading | CONFIRMED, `Math.ceil(n.length/9)` |
| Click | A paint swatch applies its colour (and authored colour). A style swatch resolves the style's colour. A variable swatch applies its resolved value, unbound. | CONFIRMED |
| Recent colours | None: there is no "recent colours" list in the build | CONFIRMED by absence (`recentColors` / `recent_colors` not found) |

### 5.7 Colour contrast (picker button "Check color contrast")

- WCAG levels AA / AAA and categories normal text / large text / graphics, with an auto-correct action (CONFIRMED, keys `fullscreen.properties_panel.color_contrast.*`).
- It is unavailable for gradients, images, video, text, mixed backgrounds, and blend modes on either the foreground or the background (CONFIRMED, keys `…unavailable.*`).
- The thresholds were not read: 4.5 / 3 / 7 are assumed from WCAG (INFERRED).

## 6. Eyedropper

| Item | Value | Evidence |
|---|---|---|
| Shortcuts | `toggle-dropper`: **I** (not in text edit), and **Control+C** on mac | CONFIRMED, wasm shortcut JSON |
| Picker button | "Sample color" in the picker. Whiteboard: "Eyedropper". It toggles the DROPPER_COLOR tool. | CONFIRMED |
| Loupe | Canvas of **48 × 48 CSS px** × devicePixelRatio, corner radius 5, a 1 px `rgba(0,0,0,.1)` outline. The sampled pixel block is drawn without smoothing. When the grid is on, 6 lines every 7 px (at 6.5, 13.5 … 41.5) split it into **7 × 7 cells**, stroke `rgba(0,0,0,.1)`. A centre "sampling square" is overlaid. | CONFIRMED, `3653 @480 000`; the 7 × 7 sample size is INFERRED from the grid (open question 3) |
| Panel | 260 px wide (64 px "mini" in whiteboard), 64 px tall, offset **12 px** right / below the cursor. It flips to the left / top when it would leave the work area (12 + width + 16 > edge). | CONFIRMED, `figma_app @161 217: "eyedropperWidth:"260px""`; `3653 @437 469` |
| Panel rows | Row 1: swatch + colour text in the current format (`eyedropperFormat`). Row 2: depends on the hovered colour. A style shows its name with a Shift badge. A variable shows its name with a Shift badge. With no style or variable, it shows "Create style" / "Create variable" with Shift + ⌘ badges (creation flow) or "Click to copy" / "Click to sample". | CONFIRMED |
| Keys while active | **Tab** cycles the colour format, skipping CSS, UIColor and CMYK. **Shift** selects row 2 (apply the style / variable). Shift + ⌘ enables creation. **Enter** applies. | CONFIRMED |
| Click with nothing to apply | Copies the colour to the clipboard; toast `visual_bell.copied_color_to_clipboard_figma_design` | CONFIRMED |
| Click with a selection | Applies the colour as a solid paint, with the variable / style when row 2 was chosen | CONFIRMED (`applyPaint(...)`) |
| Global (desktop) | On the desktop app, a transparent overlay window samples outside Figma's window. It needs the screen-recording permission (modal `eyedropper.global_permission_modal.*`). It falls back to in-window sampling if the overlay fails 5 times or takes > 3 s. | CONFIRMED, `3653 @430 000–437 000` |
| Engine | `FGDropperManager.cpp`, `EyeDropperBehavior`, `EyedropperBackbufferCopy`: samples the rendered back buffer | CONFIRMED, wasm strings |

## 7. Gradients

### 7.1 Gradient editor layout (live: fill-picker-gradient_linear.txt, 240 × 297)

| Element | Value |
|---|---|
| Type select | 96 × 24: Linear, Radial, Angular, Diamond (`GRADIENT_*`) |
| Buttons | "Flip gradient" (x 180), "Rotate gradient" / rotate 90° (x 208) |
| Stop bar | Track **208 × 32** (panel width − 2 × 16 margin), drawn on a 2-D canvas over a checkerboard. Stops are chits with an arrow. |
| "Stops" header | "+" (Add gradient stop) at x 208 |
| Stop rows | 32 px tall: position 48 × 24 ("0%"), a 128 px colour field (chit, hex, opacity), and a "Delete gradient stop" button (only when stops > min) |
| Interpolation row | "Color interpolation" label + colour space select (+ hue method select) |

The editor has a `maxHeight` of 500 (CONFIRMED, `3187 @5 384 000`).

### 7.2 Stop-bar interaction (GradientControlInner, `3187 @5 355 500`)

| Action | Rule | Status |
|---|---|---|
| Click empty track | Adds a stop at that position with the **interpolated colour there**, selects it and starts dragging. A click outside [0, 1] is ignored. | CONFIRMED |
| Drag threshold | 5 px before a press on a stop becomes a drag | CONFIRMED, `THRESHOLD=5` |
| Shift while placing / dragging | Snaps the position to **5 %** steps | CONFIRMED, `.05*Math.round(o/.05)` |
| Neighbour magnet | Dropped within **2 %** of a neighbour, the stop goes to the neighbour ± 0.0001, so it sits just inside and keeps its order. **Alt** turns this off. | CONFIRMED |
| Alt + press on a stop | Duplicates that stop (colour, variable, authored colour) at the pointer | CONFIRMED |
| Double-click a stop | **Redistributes** all stops evenly (i / (n − 1)), only when there is no context menu | CONFIRMED |
| Right-click a stop | Menu: Delete stop, Redistribute stops (when more than the minimum number of stops) | CONFIRMED |
| Keys (stop focused) | ← / → move by **1 %**; Shift + arrows by **5 %**; Backspace / Delete remove the selected stop when count > `minStops` (default 1) | CONFIRMED |
| Hover | A ghost stop shows the colour under the pointer | CONFIRMED |
| Ordering | Stops are re-sorted by position after every change; the selection follows the moved stop | CONFIRMED |
| Max stops | Optional `maxStops`: "+" is disabled at the cap. None in the main fill picker. | CONFIRMED |

### 7.3 Stop list and buttons

| Action | Rule | Status |
|---|---|---|
| "+" Add stop | Midpoint between the selected stop and the next one. If the last stop is selected: the midpoint between the last two. With a single stop: at 1 if that stop is below 0.5, else at 0, same colour. The colour is interpolated in the paint's interpolation space. | CONFIRMED, `3187 @5 377 500` |
| Tab / Shift + Tab in the position field | Moves to the next / previous stop row | CONFIRMED |
| Position field | Integer % (decimals 0), no scrubbing | CONFIRMED |
| Flip | position → 1 − position for stops, `stopsVar` and `authoredStops`. The hue method INCREASING ↔ DECREASING swaps. Disabled with fewer than 2 stops. | CONFIRMED, module 797765 |
| Rotate 90° | Calls `rotateGradient90Degrees()` in the engine; enabled only in gradient edit mode, or on a stroke preset (whose paint transform is rotated in JS) | CONFIRMED |
| Interpolation | Colour space options DEFAULT, OKLAB, OKLCH, HSL, SRGB_LINEAR. The hue method select appears only for OKLCH / HSL, with INCREASING (default) and DECREASING. The formatter also knows SHORTER / LONGER. Hovering an option previews it. | CONFIRMED |
| Bar preview | Painted per pixel column in the chosen space. DEFAULT in sRGB uses a canvas linear gradient. | CONFIRMED |

### 7.4 On-canvas handles

The engine has `GradientPaintMoveHandleBehavior`, `GradientPaintMoveStopBehavior`, `GradientPaintStopRotationBehavior`, `gradientHandlePositions`, the cursor `gradient-tool-rotate`, the images `handle-gradient(-selected|-preview).png` and `bounds-gradient.png`, and the undo label "gradient paint rotate 90 degrees" (CONFIRMED, wasm strings). Handle sizes, hit radii and the rotation snap were not readable statically (open question 4).

## 8. Image, GIF and video fills

### 8.1 Image tab layout (live: fill-picker-image.txt, 240 × 577)

| Element | Value |
|---|---|
| Scale-mode select | 96 × 24 at (16, 93), label "Image scale mode" |
| Rotate | "Rotate 90º" at x 208 |
| Preview | **208 × 208**, checkerboard background, drag-and-drop target. Its overlay holds "Upload from computer" (primary). When the selection already has a fill: "Current selection has a fill" and "Make an image" (AI). |
| Adjustments | 7 slider rows at y 355 … 547, 32 px apart |

### 8.2 Scale modes

| Order | Kiwi | Label | Behaviour |
|---|---|---|---|
| 1 | FILL | Fill | Cover |
| 2 | FIT | Fit | Contain |
| 3 | STRETCH | **Crop** | Choosing it does not set the mode directly: it runs the `crop-image` action (crop mode on canvas) |
| 4 | TILE | Tile | Shows a scale field (tooltip "Scaling factor") |

All CONFIRMED (`figma_app @3 683 100`, `ev=["FILL","FIT","STRETCH","TILE"]`). The transforms per mode are in effects.md §2.23. In raster edit mode, arrow keys inside the select are passed to the canvas (CONFIRMED).

### 8.3 Tile scale and rotation

- **Tile scaling factor:** min **0.01**, max **100**. It applies only in TILE; other modes report 1 (CONFIRMED, `figma_app: "min:.01,max:100"`).
- **Rotate 90º:** adds 90° to the paint rotation and repairs the thumbnails (CONFIRMED, `(0,z.Lt)(this.props.paint,90)`).

### 8.4 Adjustments

| Order | Field (`paintFilter`) | Label | Range | Step / big step | Notes |
|---|---|---|---|---|---|
| 1 | exposure | Exposure | −1 … 1 | 0.01 / 0.1 | default 0, a tick at 0, track filled from 0 |
| 2 | contrast | Contrast | **−0.3 … 0.3** | 0.01 / 0.1 | stored range ±0.3 |
| 3 | vibrance | **Saturation** | −1 … 1 | 0.01 / 0.1 | the label differs from the field name |
| 4 | temperature | Temperature | −1 … 1 | 0.01 / 0.1 | |
| 5 | tint | Tint | −1 … 1 | 0.01 / 0.1 | |
| 6 | highlights | Highlights | −1 … 1 | 0.01 / 0.1 | |
| 7 | shadows | Shadows | −1 … 1 | 0.01 / 0.1 | |

All CONFIRMED (`figma_app @3 684 248`, `"min:"contrast"===e?-.3:-1"`, `bigStep:.1,…hints:[0],…rangeAnchor:0,…step:.01`).
- Labels: live: fill-picker-image.txt.
- The shader pipeline is in effects.md §2.24.
- The sliders are hidden for GIF and video paints. For GIF the frame scrubber takes their place; for video, the video controls.

### 8.5 GIF and video

| Item | Value | Evidence |
|---|---|---|
| GIF | An IMAGE paint with `animatedImage`; the type label reads "GIF". The preview animates. A frame scrubber with play and "set cover frame" (`animationFrame`) is shown. A one-time hint: "GIFs in Figma prototypes" / "choose which frame is displayed". | CONFIRMED, `figma_app @3 672 000` |
| Video | A VIDEO paint (`video.hash`, `s3Url`). Its tab has the same scale select and Rotate. Upload: "Upload from computer". Playback controls; Volume 0–2 (slider max 2); Autoplay / Loop / Mute / Show playback controls (prototype settings). | CONFIRMED |
| Video upload | The engine blocks an S3 upload over a size limit ("s3 upload blocked, video size exceeds limit"); the number was not found | CONFIRMED (string); value: open question 5 |
| Video MIME | mp4, quicktime (.mov), webm (wasm); the JS also lists mp2t, matroska, avi | CONFIRMED |

### 8.6 Formats, sizes and colour handling

| Item | Value | Evidence |
|---|---|---|
| Image MIME types | png, jpeg, gif, webp, avif, tiff, bmp, heic, svg+xml, vnd.ms-photo (JPEG XR) | CONFIRMED, wasm strings lines 20 363–30 705 |
| HEIC | Converted server-side (`/api/upnode/heic_convert`, 3 retries), optionally decoded in a worker | CONFIRMED, `2622` |
| Decode limit | `decodeAsync(bytes, type, 4096, 4096, …)` | CONFIRMED, `figma_app: "decodeAsync(e,t,4096,4096,!0)"` |
| Downscale rules | Fit inside 4096 × 4096, keeping the aspect ratio. Exception: an image whose area is under half the box's area is kept (6000 × 1000 stays). The clamp to the GPU's max texture size is optional. Thumbnails halve until ≤ 512. | CONFIRMED in canvas.md §2.5 |
| Engine error | "Maximum supported image dimension is %u pixels" | CONFIRMED, wasm |
| Re-encode | Unsupported compressed types are re-encoded (`imageTypeToEncode`); JPEG at quality 60 for generated data | CONFIRMED, `2622` |
| Import errors | `fullscreen.file_import.oversized_files_images_exceeded_max_size`, `import_invalid_images` | CONFIRMED (keys) |
| Colour management | Embedded profiles are stripped or classified; pixels are uploaded unconverted with an SRGB / DISPLAY_P3 tag; `Paint.imageShouldColorManage` (22) | CONFIRMED, canvas.md §2.6; schema |

## 9. Pattern fills (live: fill-picker-pattern.txt)

| Field | Values | Evidence |
|---|---|---|
| Source | "Select source…" picks a node (`sourceNodeId`); there is a "Go to source" button | CONFIRMED |
| Tile type | Rectangular / Hexagonal (segmented control). Hexagonal writes HORIZONTAL_HEXAGONAL. | CONFIRMED, `7362 @5 417 600` |
| Direction (hexagonal only) | Horizontal / Vertical ↔ HORIZONTAL_ / VERTICAL_HEXAGONAL | CONFIRMED |
| Scale | **0.01 … 20** (shown as %, 100 % = 1), nudge 1 / 10 | CONFIRMED |
| Spacing X / Y | **−0.5 … 20** each (shown as %), nudge 1 / 10. Y is **linked** to X while they are equal: it shows X as a placeholder, and clearing Y re-links it. Writing spacing sets the legacy `spacing` to 0. | CONFIRMED |
| Alignment | A 3 × 3 anchor grid → `horizontalAlignment` / `verticalAlignment` START / CENTER / END | CONFIRMED |
| Limit | One pattern paint per paint list (§3.2) | CONFIRMED |

## 10. Blend modes

### 10.1 List and order

The paint (picker) list starts at Normal. The layer list prepends **Pass through**. Dividers separate the groups.

| Group | Modes (UI label) |
|---|---|
| (layer only) | Pass through |
| 1 | Normal |
| 2 | Darken, Multiply, **Plus darker** (LINEAR_BURN), Color burn |
| 3 | Lighten, Screen, **Plus lighter** (LINEAR_DODGE), Color dodge |
| 4 | Overlay, Soft light, Hard light |
| 5 | Difference, Exclusion |
| 6 | Hue, Saturation, Color, Luminosity |

CONFIRMED: `figma_app @3 580 196` (module 835764, `["NORMAL","SELECT_DIVIDER","DARKEN",…]`, layer list `["PASS_THROUGH"].concat(d)`); live: blend-mode-menu.txt.

Note: in the live layer menu, Pass through and Normal sit in one group with no divider between them.

### 10.2 Rules

| Rule | Detail | Status |
|---|---|---|
| Setting a layer blend mode | Also sets `visible: true` on the selection | CONFIRMED, `updateSelectionProperties({blendMode:e,visible:!0})` |
| Preview | Hovering an option previews the mode (`updatePreview`), and leaving it restores the old one | CONFIRMED |
| Default icon | The trigger shows the "default" icon when the value is NORMAL (for paints), else the "applied" icon | CONFIRMED, module 707386 |
| Pass through | The default for frames and groups. Children blend with what is below the group. NORMAL isolates the group. | INFERRED (W3C / Figma semantics; the compositing is in effects.md §2.25) |
| Dev Mode / CSS | NORMAL and PASS_THROUGH are omitted. Otherwise the output is `mix-blend-mode: <lowercase>`. Plus darker / lighter get a code hint (`background_blend_mode_plus_lighter_darker`). | CONFIRMED, module 821581 |
| Compositing maths | W3C formulas; COLOR_BURN / DODGE with a 1/255 epsilon; LINEAR_BURN `max(0, s + d − αsαd)` | CONFIRMED in effects.md §2.25 |

## 11. Layer opacity and number keys

| Item | Value | Evidence |
|---|---|---|
| Appearance row | "Opacity" (label 9 px / 500), an 88 × 24 field showing "100%"; "Apply blend mode" button at x 208; "Hide" toggle at x 179 | CONFIRMED, live: design/rectangle.txt |
| Actions | `set-opacity-0` … `set-opacity-9` and `set-opacity-00`; the toast `visual_bell.opacity_set_to_d` ("Opacity set to N%") | CONFIRMED, wasm strings |
| Preference `use-numbers-for-opacity` **on** | 0–9 and Num 0–9 set opacity. Zoom moves to Shift: Shift+0 = 100 %, Shift+1 / Shift+9 = zoom to fit, Shift+2 = zoom to selection. | CONFIRMED, wasm shortcut JSON |
| Preference **off** | 0 = zoom 100 %, 1 / 9 = fit, 2 = selection; **Shift+digit** sets opacity | CONFIRMED |
| Edit modes | GLOBAL, not in TEXT edit | CONFIRMED |
| Storage | A user flag `use_numbers_for_opacity`, toggled by the action `toggle-use-numbers-for-opacity`. The engine writes it via `saveUseNumbersForOpacityPreference`. | CONFIRMED, `figma_app` |
| Default | The JS reads a missing flag as **false** (`ut(…useNumbersForOpacity,!1)`) | CONFIRMED in JS; which behaviour a new account gets is open question 6 |
| Digit → value | 1 → 10 %, … 9 → 90 %, 0 → 100 %. Two digits typed quickly give their value (4 then 5 → 45 %). `00` → 0 %. | INFERRED (help-site behaviour; the action names, including `set-opacity-00`, are CONFIRMED). The two-key timeout lives in C++ and was not read (open question 7). |

## 12. Masks

| Item | Value | Evidence |
|---|---|---|
| Create | `mask-selection`: **⌘ + Ctrl + M** (mac) / **Ctrl + Alt + M**. It creates a "Mask group"; the bottom-most selected layer becomes the mask (`isMask`). | CONFIRMED (shortcut, name); the bottom-layer rule is INFERRED from Figma's documented behaviour |
| Mask type select | Label "Mask". Options **Alpha**, **Vector** (OUTLINE), **Luminance**, each with an extended description (`*_extended`). "Mixed" is shown (and disabled) for a mixed selection. Hover preview is debounced by **50 ms**. | CONFIRMED, `5581 @92 760` |
| Rendering | Luminance has its own tile shaders (`MaskTileLuminance`, `…PassThrough`); `is-this-or-parent-outline-mask` | CONFIRMED (names); the luminance weights were not read (open question 8) |
| Scope | A mask clips the siblings above it in the same parent, up to the end of the group | INFERRED (Figma semantics) |
| Other | `toggle-show-masks`, the layer row mask decorator, "Remove mask" (`fullscreen.menu.remove_mask`) | CONFIRMED (strings / keys) |

## 13. Rendering details already established (summary of effects.md)

| Topic | One line | Where |
|---|---|---|
| Gradient t | LINEAR h.x + 0.5; RADIAL 2·\|h\|; ANGULAR fract(atan2/2π); DIAMOND 2(\|x\| + \|y\|); ramp atlas row | effects.md §2.20 |
| Dither | ±1/255 on all channels for gradients and analytic shadows | §2.21 |
| Interpolation spaces | Paint 41 / 42, CSS `in oklab` / `in oklch <hue>` … | §2.22 |
| Image transforms | FILL / FIT scale by max / min component; TILE rotates about the centre | §2.23 |
| Image adjustments | Linearise → shadows / highlights → Lab temperature / tint / contrast → exposure → vibrance → re-encode | §2.24 |
| Blend maths | W3C, with the burn / dodge epsilon | §2.25 |
| Image decode colour | Profiles stripped and classified; straight alpha uploaded | canvas.md §2.6 |

## 14. Colour spaces and the document profile

| Item | Value | Evidence |
|---|---|---|
| Document profile | LEGACY (unmanaged), SRGB, DISPLAY_P3; shown in the file-name menu as "Color profile" | CONFIRMED, keys `fullscreen.filename_view.color_management.*` |
| Change modal | Title per target profile. Options: **Convert** (default; the choice is remembered in localStorage `preferred-document-color-profile-change-option`) or **Assign**. Convert subtitles: sRGB → Display P3 / Display P3 → sRGB. Converting to sRGB warns that colours are clamped. Cancel names the other profile. Confirm: "Convert to …" / "Assign …". | CONFIRMED, `3187 @1 236 000` |
| P3 support warnings | Status values `SupportedNatively`, `SupportedWithPolyfill`, `ClientNotSupported` (with convert / assign wording), `MonitorNotSupported` | CONFIRMED |
| History | Adds a version-history entry "Color profile": LEGACY → "assign" wording, else "sRGB → Display P3" | CONFIRMED |
| Engine actions | `assign-document-color-profile-srgb` / `-display-p3`, `convert-document-color-profile-srgb` / `-display-p3` | CONFIRMED |
| User display profile | A per-user modal (`user_color_profile_modal`): view as sRGB or Display P3 in the browser, with warnings when the display or client lacks P3 | CONFIRMED (keys) |
| Picker in P3 | The gradient bar and swatches render through a `display-p3` canvas or a CSS `color(display-p3 …)`; a polyfill draws P3 chits as images | CONFIRMED, `figma_app @3 580 600`; `3187 @5 355 500` |
| Authored colours | Behind `ce_tl_color_spaces`: the exact typed space is kept (`authoredColor` 44, `authoredStops` 45), and the RGB value is derived for the document profile (`computeDisplayColor`). OKLAB / OKLCH convert straight to P3 in P3 documents. | CONFIRMED, `2108 @2 554 141` |
| Export | Color profile: Document / sRGB / Display P3 / CMYK | CONFIRMED (enum, keys) |

## 15. UI strings

The build carries i18n keys only. English text is given where it is attested by a live capture ("live") or by existing repo strings; otherwise only the key is listed.

**Attested English (live captures):**
- Picker: "Color picker", "Custom", "Libraries", "New style or variable", "Close", "Solid", "Gradient", "Pattern", "Image", "Video", "Shader", "Blend mode", "Check color contrast", "Color picker reticle", "Sample color", "Hue", "Opacity", "Color format", "Color", "Hex", "RGB", "CSS", "HSL", "HSB", "On this page", "Color swatch set selector", "Solid color hex: XXXXXX", "Search", "Variable set", "All libraries", "Show as grid", "No colors available".
- Gradient: "Paint type", "Linear", "Flip gradient", "Rotate gradient", "Stops", "Add gradient stop", "Gradient stop position", "Gradient Stop Color", "Delete gradient stop".
- Image: "Image scale mode", "Fill", "Rotate 90º", "Upload from computer", "Current selection has a fill", "Make an image", "Exposure", "Contrast", "Saturation", "Temperature", "Tint", "Highlights", "Shadows".
- Pattern: "Select source…", "Tile type", "Rectangular", "Hexagonal", "Scale", "Spacing", "X", "Y", "Alignment", "Anchor point", "Align top left" … "Align bottom right".
- Shader: "Shader fills", "Beta", "Create with agents", "Created by you", "Create new", "AI", "By Figma", "Moving gradient", "Mesh gradient", "Nebula", "Water caustic", "Fractal noise", "Clouds", "Moire", "Glowing wave", "Concentric patterns", "Pattern grid".
- Blend modes: "Pass through", "Normal", "Darken", "Multiply", "Plus darker", "Color burn", "Lighten", "Screen", "Plus lighter", "Color dodge", "Overlay", "Soft light", "Hard light", "Difference", "Exclusion", "Hue", "Saturation", "Color", "Luminosity".
- Panels: "Appearance", "Hide", "Apply blend mode", "Opacity", "Fill", "Fill, Apply styles and variables", "Add fill", "Toggle visibility", "Remove", "Stroke", "Stroke, Apply styles and variables", "Add stroke", "Style", "Click + to replace mixed content", "Selection colors", "Autofill available. Type to see suggestions.".

**Keys only (English not attested in the repo's captures):**
- Fill / selection colors: `fullscreen.properties_panel.fill.{see_all_x_colors, show_selection_colors, selection_colors, detach_style, detach_variable, remove, swap_start_and_end_points, start_point, end_point, show_in_exports, include_the_canvas_or_group_background_in_exports}`, `section_stroke.tooltip_addStrokeFill`, `select_item_using_this_color`.
- Picker: `color_picker.{interpolation_color_space.aria_label, interpolation_hue_method.aria_label, paint_type.aria_label, weave_fill, color_contrast_info.*}`, `current_page_colors`, `local_assets`, `library_swatch_select.aria_label`, `color_controls.{red, green, blue, hue, saturation, lightness, brightness, cyan, magenta, yellow, black, eyedropper}`.
- Gradient: `gradient_picker.{color_interpolation, redistribute_stops, delete_stop_shorthand, rotate_90, stop_color_a11y_label, stop_position}`, `interpolation_color_space.{default, oklab, oklch, hsl, srgb_linear}`, `interpolation_hue_method.{shorter, longer, increasing, decreasing}`.
- Paint names: `properties_panel.{solid, linear, radial, angular, diamond, gif, noise, shader_chooser.custom_fill}`, `accessibility.chit_*`.
- Image / video: `image_scale.{fill, fit, crop, tile}`, `image_settings.{scaling_factor, upload_new, remove_image, generate_new}`, `video_controls.{autoplay, loop, mute, show_playback_controls}`, `gifs_in_figma_prototypes`, `choose_which_frame_displayed`, `common.media.volume`.
- Pattern: `properties_panel.pattern.{direction, horizontal, vertical, go_to_source, select_source}`.
- Eyedropper: `eyedropper.{click_to_copy, click_to_sample, create_style, create_variable, global_informational_text, global_permission_modal.*}`, `visual_bell.copied_color_to_clipboard_figma_design`, `accessibility.eyedropper_*`.
- Opacity: `visual_bell.opacity_set_to_d`, `fullscreen_actions.toggle-use-numbers-for-opacity`.
- Masks: `mask_panel.{mask, alpha, alpha_extended, vector, vector_extended, luminance, luminance_extended}`, `fullscreen.menu.remove_mask`, `fullscreen_actions.show_mask_outlines`.
- Colour management: `color_management.document_modal.*`, `color_management.user_color_profile_modal.*`, `filename_view.color_management.*`, `export_settings_color_profile.{document, srgb, display_p3, p3, cmyk}`.
- Contrast: `color_contrast.*`.

## 16. DesignerV2 today

From a read-only survey of `src/renderer/src` (`ds/components/ColorPicker.tsx` = CP, `editor/panels/design/Paints.tsx`, `SelectionColors.tsx`, `editor/opacityKeys.ts`, `editor/images.ts`), `engine/src/editor/PaintEditing.cpp` and `schema/document.kiwi`.

**Matches Figma:**
- Picker 240 wide with a 208 SV square and 180 px sliders; Custom / Libraries tabs; Hex / RGB / CSS / HSL / HSB.
- 9 swatches per row; "On this page".
- Fill add / remove / reorder / visibility; the "Click + to replace mixed content" text.
- Alt+/, Shift+/, Shift+X.
- Paint tabs Solid / Gradient / Pattern / Image / Video / Shader.
- Image scale modes (Crop = STRETCH) and Rotate 90.
- The seven adjustments, with contrast stored at ±0.3 and saturation mapped to vibrance.
- The 4096 cap with the half-area exception.
- Blend-mode list, order, dividers and Plus darker / lighter names; Pass through only on layers.
- Number keys for opacity with Shift+0 / 1 / 2 zoom, "00", and a 475 ms two-digit window (`opacityKeys.ts:12`).
- Schema enums for MaskType, DocumentColorProfile, Paint 41 / 42.
- The eyedropper card is 260 × 64 with a 48 px loupe of 7 × 7 px.

**Differs:**
- Hex parsing: no 1- / 2- / 5- / 7-digit forms, 4-digit only in panel rows, and 18 named colours instead of 148.
- Gradient stop-bar keys step 10 % with Shift (Figma: 5 %).
- Canvas Shift-snap is 10 % (Figma's bar: 5 %); the canvas drag threshold is 2 px (Figma's bar: 5 px).
- Dragging a stop 32 px off the bar deletes it (not found in Figma's bar).
- The "+" stop rule adds +10 % for equal positions (Figma: the single-stop 0 / 1 rule).
- Selection colors: no collapsed "+N" header, no 12 / 11 rule, threshold handling differs. It includes gradients as rows; Figma's order is variables, then styles, then raw paints.
- The export profile label always reads "sRGB (same as file)".
- `docs/engine.md:831` says the loupe is 11 × 11, but the code uses 7 × 7.

**Missing:**
- A persisted colour-format preference (shared with the eyedropper / Inspect).
- Wheel on the SV square (hue; Alt = alpha with 10 % snap), and hue memory at s = 0.
- Swatch sets for Local assets and libraries.
- The add-fill paint-type menu and the one-pattern rule.
- The 500-use debounce.
- Gradient bar: Alt-click duplicate, double-click / context-menu redistribute, the 2 % neighbour magnet, Shift-snap while dragging, the interpolation colour-space / hue-method menu (the renderer already honours 41 / 42).
- Eyedropper: copy to the clipboard on click, Tab to cycle formats, the Shift style / variable rows.
- Image formats avif / tiff / bmp / heic.
- Tile scaling factor (0.01–100) for images.
- GIF playback and cover frame; the video volume / controls.
- The setting where digits zoom and Shift+digit sets opacity.
- The document profile convert / assign modal (menu items are `later()` placeholders).
- The mask-type panel (Alpha / Vector / Luminance); Ctrl+Alt+M on Windows; "Use as mask" is still a pending engine command.
- The EMOJI paint type (6) is dropped from the schema.

Note: DesignerV2's new-fill defaults (frame #FFFFFF, shape #D9D9D9, any later paint black at 20 %, `Paints.tsx:63-67`) were not verified against Figma. See open question 1.

**As built (2026-10-17, wave 1)** — branch "paints and effects":
- **Colour strings** (`ds/util/color.ts` `parseColor`, `hexDigitsToRgba`, `parseHexInput`): §5.4's order (rgb() → color(display-p3 | srgb) → the 148 names → hsl() / lab() / oklch() / oklab() → hex); 1–8 hex digits as the table says (alpha only when typed); lenient = the first hex run after junk, strict = `#?hex;?`. Every hex field (the fill rows, the picker, the stops, Selection colors) and the CSS field read it. Not built: the hex field's arrow keys on the channel under the caret (INFERRED steps; the field is the DS ColorInput).
- **Picker** (`ds/components/ColorPicker.tsx`): the wheel over the square — hue round the circle, ⌥ opacity rounded to 0.001 and snapped to 10 % within 0.3 %, ⌃ left to the canvas — as one undo step per turn (settled after 300 ms, our choice); the hue slider 1° / ⇧ 10°, looping, "N°"; PageUp / PageDown / Home / End on the square. The colour format is kept per machine and shared by every picker and the eyedropper (`editor/colorFormat.ts`). Swatch sets: "On this page" and "Local assets" (COLOR variables in order, then FILL styles), the choice under Figma's localStorage key; one set per library is **not built** (their colours aren't in the file until used).
- **Gradient bar** (§7.2–7.3): a press on the track adds a stop in the colour there and drags it; a stop moves after 5 px; ⇧ 5 % steps; dropped within 2 % of another it goes to it ± 0.0001 unless ⌥; ⌥-press copies the stop; double-click redistributes; right-click "Delete stop" / "Redistribute stops"; ← / → 1 % (⇧ 5 %); Delete down to one stop (minStops 1; the Delete button only above it, the canvas's ⌫ too); the stops re-sorted after each change, the selection following; a ghost stop under the pointer; "+" halfway to the next stop (the last: between the last two; a lone stop: 1 or 0); Tab / ⇧Tab between the position fields, no scrubbing; Flip swaps Increasing / Decreasing. The drag-off-the-bar deletion is gone. **Color interpolation**: Default / OKLAB / OKLCH / HSL / sRGB linear, the hue select (Increasing / Decreasing) for OKLCH and HSL, written as Paint 41 / 42; the bar previews it with CSS Color 4 interpolation and new stops (picker and canvas) take the colour in that space (the engine's `interpolateColor`). Not built: hovering an option previews it; `authoredStops` (45) are left as they were when stops change.
- **Canvas gradient handles**: unchanged (Shift 10 %, 2 px threshold) — Figma's canvas values are open question 4, not the bar's.
- **Eyedropper** (`canvas/CanvasTools.tsx`, `editor/eyedropper.ts`): row 1 in the colour format, Tab cycles it (CSS skipped); row 2 names a local COLOR variable (variables first) or a FILL style (one opaque solid paint) of the hovered colour with a ⇧ badge — ⇧ held, the pick binds the variable on the fill it sets, or applies the style; otherwise "Click to sample" / "Click to copy"; a pick with nothing selected copies the colour text to the clipboard (toast wording ours). Not built: Enter applies, the global (outside the window) sampling, the creation flow (⇧⌘ "Create style / variable").
- **Selection colors**: fewer than four always open; four or more fold and start folded, the title row showing the first three and "+N" (the whole row a toggle); open, past twelve, eleven rows and "See all N colors"; a new selection starts over; past the node limit (5000, ours — Figma's is open question 2) "Show selection colors" reads them all; a colour used more than 500 times debounces a drag's writes (100 ms, ours). Gradients stay as rows (Figma's `selectionPaints` includes them per the help site; unverified).
- **Paint lists**: one Pattern per list (the picker's Pattern tab greyed while another paint is one); a tile's "Scaling factor" (Paint.scale, 1–10000 %, i.e. 0.01–100) beside Rotate 90º. Not built: the "+" paint-type menu (feature-gated in the build).
- **Masks**: a "Mask" section (`panels/design/Mask.tsx`) when every selected layer is a mask: Alpha / Vector (OUTLINE) / Luminance, Mixed shown disabled. Unverified: where UI3 places the row, the extended descriptions, the 50 ms hover preview.
- **Colour profile** (`editor/colorProfile.ts`, `ColorProfileDialog.tsx`, File › Color profile…): sRGB / Display P3; Convert (the default, remembered under `preferred-document-color-profile-change-option`; every `{r, g, b, a}` in every node — paints, stops, effects, guides, variables, styles, pages — through the P3 ↔ sRGB matrices, into sRGB clamped) or Assign; "Convert to …" / "Assign …"; one undo step; the canvas switches its colour space at once and on undo / redo (`Engine.refreshColorProfile`). The modal's English is ours (keys only in the build). Not built: the version-history entry, the per-user display profile modal (Preferences › Color profile… stays a placeholder), re-uploading images already decoded in the old space. The export's "Document" profile now names the file's (sRGB / Display P3).
- **Still missing from the lists above**: image formats avif / tiff / bmp / heic in the importer, GIF playback and cover frame, the video volume / controls, the digits-zoom setting (Preferences' "Use number keys for opacity" exists), Ctrl+Alt+M on Windows (the shortcut table, wave 4), the EMOJI paint type, the contrast checker's auto-correct.

## 17. Open questions

| # | Question | Probe that settles it |
|---|---|---|
| 1 | The colour of a newly added fill: on an empty frame, on a shape, and as a second fill on top of an existing one | Live: add fills in each case and read the hex |
| 2 | The node / paint count at which Selection colors stops collecting (`emptyDueToLimitExceeded`) | Live: select growing numbers of coloured nodes; or REA a C++ call graph from `ignoreLimitWhenCollectingPaints` |
| 3 | The loupe's sample size (7 × 7 inferred) and its magnification at high zoom | Live: screenshot the loupe over a 1 px checker pattern |
| 4 | On-canvas gradient handles: sizes, hit radius, the angle snap on Shift, the linear-handle width ratio | Live: drag the handles with Shift; measure in screenshots |
| 5 | The video upload size limit and the GIF / image file-size limit | Live: upload oversized files; or find the C++ constant behind "video size exceeds limit" |
| 6 | Whether a new account has `use_numbers_for_opacity` on (number keys = opacity) | Live: a fresh account; press 5 and watch opacity vs zoom |
| 7 | The two-digit opacity window (ms) | Live: type 4, wait n ms, type 5; find the threshold |
| 8 | The luminance mask's luma weights (Rec. 709 vs Rec. 601) | Read the `MaskTileLuminance` GLSL in the wasm; or render a #00FF00 luminance mask and read the alpha |
| 9 | (wave 1) Where UI3 shows the mask type row, and the options' extended descriptions | Live: select a mask layer; read the panel and the dropdown |
| 10 | (wave 1) The colour profile modal's and the eyedropper's copy toast's English | Live: File-name menu › Color profile › Display P3; eyedropper click with nothing selected |
| 11 | (wave 1) Whether Selection colors lists gradients as rows, and the order within a selected layer (by hex is inferred) | Live: a frame holding a gradient and solids |
| 12 | (wave 1) How long a wheel turn on the square stays one undo step (Wecra: 300 ms of rest) | Live: wheel, pause, wheel, ⌘Z |
