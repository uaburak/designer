# Atlas 06 — Text and typography

Figma Design desktop 126.9.13, read statically (2026-10-16). Status tags: **CONFIRMED** means read directly in the build. **INFERRED** means deduced from what was read, or carried over from earlier research that cites its source. Evidence is given as `chunk @byte-offset`, as `chunk: "snippet"`, or as `wasm: "string"` (a string in `fullscreen__fullscreen-wasm__compiled_wasm.wasm`).

## 1. Scope and sources

**Covered:** text creation, sizing and truncation; the Typography panel and the Type settings modal with every field, unit, step and limit; the font picker, font sets, search and preview; the missing-fonts flow and the local font agent; line height, letter spacing, paragraph and list settings; case, decoration and OpenType features; vertical trim and hanging punctuation; text styles and variable bindings; shaping, line breaking, bidi, emoji and fallback fonts; editing shortcuts; text on a path; how text is rendered.

**Sources read** (in `~/.cache/figma-rea/figma/`, pretty-printed into a scratch folder with esbuild; offsets refer to the minified files):

| Source | What it holds | Where |
|---|---|---|
| `3653.min.js` (2.2 MB; `1540.min.js` holds near-identical code) | Typography panel, Type settings modal (Basics / Details / Variable / Underline drill-in), alignment controls, list-style control, font-size combo | type settings @≈831 000–875 000; font size @924 228 |
| `figma_app.min.js` | Line-height maths (module 387610), text-panel helpers (903991), number/letter-spacing formatters (543705), resizing control, font-style picker (448442), the `EnabledTypePanelControls` enum | modules named |
| `9489.min.js` | Line height field (505767) and letter spacing field (487761) | modules named |
| `3187.min.js` | Font picker (385381), font sets and search (119712, 33239), OpenType feature table (866936), missing-fonts modal, font agent client | modules named; agent @7 324 488 |
| `fullscreen__fullscreen-wasm__compiled_wasm.wasm` | C++ editor: class and source names, assertions, enums, the shortcut table (JSON) | `strings -n 6` (103 967 lines); shortcut JSON at strings lines 11 017–11 223 |

**Prior work reused:**
- `docs/research/figma/R11-fonts.md`: font sources, the Inter 3.19 digest, the Google Fonts catalog, and the font agent at `127.0.0.1:44950/figma/font-files`.
- `docs/research/rea/canvas.md` §29 and §36 (line 366): glyph rasterization (stencil-then-cover Loop-Blinn), and UAX #14 line breaking done in JavaScript through `JSTextLayout_getAllLineBreakPositions`.
- `docs/research/figma/live/behaviour/text.md`: double-click enters edit mode and selects the word under the cursor; the first Esc leaves edit mode and keeps the selection, the second Esc deselects.

## 2. Engine architecture of text (C++)

### 2.1 Source files

All CONFIRMED from `wasm` path strings:

| Area | Files |
|---|---|
| Text data / layout | `scenegraph/textdata/FGTextData.cpp`, `FGTextDataHelpers.cpp`, `FGLineLayout.cpp`, `FGTextLineData.cpp`, `FGStyleValueCache.cpp`, `FGTruncationHelper.cpp` |
| Editing | `scenegraph/textdata/FGTextEditor.cpp/.h`, `editor-ui/app/FGTextEditModeUi.cpp`, `editor/interactions/FGViewOnlyTextEditModeDelegate.cpp`, `editor-ui/interactions/FGDragTextCursorUsingTouchEventsBehavior.cpp` |
| Text on a path | `FGTextPathLayout.cpp`, `FGTextPathSelection.cpp`, `FGTessellatedTextPath.cpp` |
| Fonts | `scenegraph/FGFontMutator.cpp`, `FGFontStyleLookup.cpp`, `FGFontFieldUpdater.cpp`, `FGFontApiHelpers.cpp`, `editor/app/FGMissingFontScanner.cpp`, `design-systems/FGVariableFontStyle.cpp` |
| Unicode / emoji | `core/FGUnicodeUtils.cpp`, `graphics-util/FGEmojiId.cpp`, `scenegraph/FGEmojiImageSetForNode.cpp` |
| Collaborative text | `collaborativeText/FGCollaborativePlainText.cpp`, `FGCollaborativeTextRustHelpers.cpp` (CRDT text in Rust; `wasm: "CollaborativeTextOpID"`) |
| Node facet | `node/facets/FGTextFacet.cpp` |

### 2.2 Libraries

| Library | Status | Evidence |
|---|---|---|
| HarfBuzz (shaping) | CONFIRMED | `wasm: "harfbuzz "`, `"HB_SHAPER_LIST"`, `"HB_FONT_FUNCS"` |
| FreeType (outlines, metrics) | CONFIRMED | `wasm: "Unexpected: FT_Init_FreeType(&library)"`, `"FREETYPE_PROPERTIES"` |
| ICU ubidi (bidi), ICU conversions | CONFIRMED | `wasm: "Failed to get icu/ubidi info; falling back to LTR"`, `"bidi: failed to setParagraph"`, `"ICU: failed to convert UTF16 to UTF8"` |
| UAX #14 line breaks, done in JS | CONFIRMED (prior) | `JSTextLayout_getAllLineBreakPositions` in `fullscreen__fullscreen-wasm__compiled_wasm.js`; canvas.md §36 |

### 2.3 Layout pipeline

All CONFIRMED from assertion names:
- Shaped glyphs carry `firstCharacter`, `characterWidthPerShapedGlyph` and `logicalOrderOfShapedGlyphs`, which map visual order back to logical order after bidi.
- `LineLayout::addLine` and `LineLayout::layGlyph` lay the glyphs into lines.
- There is a shaping mode just for bullets and ellipses (`wasm: "SHAPE_TEXT_FOR_BULLETS_AND_ELLIPSES"`).
- Derived data dumps list `baselines`, `decorations`, `laidGlyphs`, `usedEmojiImages`, `truncationStartIndex` and `truncatedHeight`.

### 2.4 Layout versions

Three per-node version fields decide which layout rules a text uses (CONFIRMED, `3653`, `ek2`/`ev2`):

| Field | Current value | Effect |
|---|---|---|
| `textUserLayoutVersion` | 1 | 0 marks an older text. Older texts keep fractional pixel line heights; version ≥ 1 rounds a percent or RAW line height to whole pixels (`figma_app` 387610 `u()`: `Math.round` unless the version is 0 or mixed). |
| `textExplicitLayoutVersion` | 1 | Upgraded through `upgradeToLatestTextExplicitLayoutVersion(bool)`. Not checked for text styles. |
| `textBidiVersion` | 1 | Anything else counts as "needs bidi upgrade". |

When any upgrade is due, Type settings shows a banner with a description, an info tooltip and an **Update** button:
- Two or more pending upgrades show "older text rendering method used". A mixed selection shows "… for part of the selection". Otherwise the explicit-layout text or the bidi text is shown.
- **Update** sets `textUserLayoutVersion = 1` and `textBidiVersion = 1`, then calls the explicit-layout upgrade.
- When the text is already on version 1, a **Revert** link sets both `textUserLayoutVersion` and `textExplicitLayoutVersion` to 0.

CONFIRMED (`3653 @≈872 000`: `"downgrade-text-user-layout-version"`).

## 3. Text nodes: creation, sizing, truncation

### 3.1 Resizing modes

The Resizing control sits in the panel's dimension rows (`figma_app` 903991 neighbour). Its i18n key is misspelled in the build: `fullscreeen.type_panel.resizing`. CONFIRMED.

| Value | Label key | Meaning |
|---|---|---|
| `WIDTH_AND_HEIGHT` | `fullscreen.type_panel.auto_width` | width and height hug the text |
| `HEIGHT` | `fullscreen.type_panel.auto_height` | fixed width, height hugs |
| `NONE` | `fullscreen.type_panel.fixed_size` | fixed box |
| `TRUNCATE` | — | legacy enum value still in the C++ enum (`wasm: "TRUNCATE"`, `"Invalid value for textAutoResize"`); the panel does not offer it |

The control is disabled when the font list has not loaded, when the font is missing, or when bit 2 of `enabledTypePanelControls` is off (`TEXT_AUTO_RESIZE = 2`). CONFIRMED.

`EnabledTypePanelControls` bits (CONFIRMED, `figma_app`: "TEXT_AUTO_RESIZE=2 … TEXT_TRUNCATION=4"):

| Bit | Control |
|---|---|
| 0 | TEXT_ALIGN_HORIZONTAL |
| 1 | TEXT_ALIGN_VERTICAL |
| 2 | TEXT_AUTO_RESIZE |
| 3 | TEXT_STYLE |
| 4 | TEXT_TRUNCATION |

`NUM_VALUES` = 5.

### 3.2 Creation (click vs drag)

The text tool is `set-tool-type`, shortcut **T**, inactive in TEXT edit mode (CONFIRMED, shortcut JSON). A click creates an auto-width text and a drag creates a fixed-width, auto-height box. That is INFERRED: the repo's engine.md §7.6 states it and the editor C++ does not expose it as strings. Leaving edit mode with empty text deletes the node (INFERRED, same source).

### 3.3 Truncation

Type settings › Basics, CONFIRMED (`3653 @831 282`):
- "Truncate text" is a segmented control: `DISABLED` ("No truncation") or `ENDING` ("Truncation enabled").
- It appears only when bit 4 of `enabledTypePanelControls` is on and the selection is not a text-style consumer.
- "Max lines" is shown only when `textAutoResize ≠ NONE` and truncation is `ENDING`.
  - It is a number field with min 1 and a scrub multiplier of 0.25; nudge amounts are the app's defaults (1 / 10).
  - An empty value shows the mixed/empty placeholder.
- The panel remembers the last max-lines value: switching to DISABLED stores it, and switching back to ENDING restores it.
- Hover previews draw the bounding box (`TRUNCATION_ENABLED` / `TRUNCATION_DISABLED`).

C++ behaviour, CONFIRMED from strings:
- The ellipsis is shaped in its own pass. Errors: "Shaped too many glyphs for ellipsis", "Missing font face, cannot truncate text".
- `truncationStartIndex` and `truncatedHeight` are stored together ("Missing truncatedHeight when truncationStartIndex is set").
- A fixed box truncates by its height. A max-lines limit applies to texts that grow (`"Assertion failure: maxHeightAppliesToText(node)"`).
- Agent / lint hint, user-visible: "Limit the text height and enable ending truncation. This hides content; consider enlarging the container instead."

### 3.4 Text wrap style

CONFIRMED (`3653`, `rw`): a dropdown labelled "Wrap" with `AUTO`, `PRETTY` and `BALANCE` (in that order). "Mixed" appears as a disabled first option followed by a separator. The control sits behind the feature gate `ce_tl_text_wrap_balance_pretty` and is shown only for non-consumers of a style.

## 4. Typography panel (right sidebar)

### 4.1 Layout

CONFIRMED (`3653`, `rZ` "CustomControls"):

| Row | Content |
|---|---|
| 1 | Font family combo box (`font-family-combo-box`); a bound FONT_FAMILY variable shows as a pill with a detach action |
| 2 | Font style (`font_style`) on the left, font size combo (`font-size-combo-box`) on the right; this row's icon slot holds the second icon button |
| 3 | "Line height" on the left, "Letter spacing" on the right; the icon slot holds the **Type settings** button (tooltip "Type settings", onboarding key `type-panel-settings`). Slides hides this row. |
| Alignment | "Alignment" with horizontal (Left / Center / Right, plus Justify only when every selected node is a TEXT_PATH) and vertical (Top / Middle / Bottom) controls |

On a text path the vertical labels become "Align above", "Align on" and "Align below" (`fullscreen.type_panel.text_on_a_path_align_*`), and a **Flip** icon button is added (`flip-text-path-orientation` → `flipTextPathStartForSelection`). Section title: "Typography"; style-modal title: "Properties". When the selection has ever held RTL text (`hasHadRTLText`), a **Switch text direction** button appears; it cycles to LTR or RTL (`text-set-directionality-ltr/rtl`). CONFIRMED.

The panel is disabled while the font list loads (`isFontListLoaded()`). Size, line height and letter spacing are also disabled when the font is missing. CONFIRMED.

### 4.2 Fields

| Field | Unit / parse | Min / max | Small / big nudge | Scrub | Evidence |
|---|---|---|---|---|---|
| Font size | px; display "N px" in aria-label | min 1, no max | user nudge prefs (default 1 / 10) | — | `3653`: "min: 1 … `${en}: ${t2} px`" |
| Font size presets | 10, 11, 12, 13, 14, 15, 16, 20, 24, 32, 36, 40, 48, 64, 96, 128 + divider + "Apply variable" (value −1) | — | — | — | `3653 @924 228`: "F = [10, 11, 12, …128]" |
| Line height | text without a unit → **PIXELS**; "N%" → **RAW** N/100 (multiple of the font size); "" or any prefix of "auto%" → `{100, PERCENT}` = Auto; "%" alone converts the current value to its RAW equivalent; "px" converts to its PIXELS equivalent | min 0 (clamp) | PIXELS: user nudges; RAW: 0.01 / 0.1; PERCENT: nudge × 100 / (intrinsic × size) | 1 for px, 0.01 otherwise | `9489` 505767 |
| Line height display | Auto → placeholder showing the auto value (1 decimal); PIXELS → `N` (1 decimal); RAW → `N%` (×100, 1 decimal); PERCENT (not auto) → `(value/100 × intrinsic × 100)%` | — | — | — | `figma_app` 387610 `p()` |
| Letter spacing | "N%" PERCENT, "Npx" PIXELS; bare number keeps the current unit (PERCENT when none) | no clamp | 1 / 10 for both units | — | `figma_app` 543705 class `N` |
| Letter spacing display | `N%` or `Npx`, 2 decimals; RAW shown ×100 % | — | — | — | same |
| Paragraph spacing | px number | none given | user nudges | — | `3653` `rN` |
| Paragraph indent | px number | none | user nudges | — | `3653` `rN` |
| List spacing | px number | none | user nudges | — | `3653` |

**Font size changes the line height** (CONFIRMED, 387610 `d()`): when the size changes and the line height is a non-Auto PERCENT, the panel first converts it to the equivalent RAW multiple. This keeps the proportion fixed against the font size.

**Font family changes do the same**, CONFIRMED (903991 `S`/`A`):
- The same PERCENT-to-RAW conversion runs.
- Variable-axis values are clamped into the new family's axis ranges.
- Live preview while browsing uses `previewFontFamily` (not committed).

### 4.3 Line height model

CONFIRMED (`figma_app` 387610):
- `PIXELS`: absolute.
- `RAW`: a multiple of the font size.
- `PERCENT`: a percent of the font's intrinsic line height (`intrinsicLineHeight`, i.e. `fontLineHeight`, which is (hhea ascender − descender + lineGap) / UPM per R11 §2). **Auto** is `{100, PERCENT}`, tested as |value − 100| < 0.1.
- Pixel equivalent:
  - RAW: value × size.
  - PERCENT: value/100 × intrinsic × size.
  - Either result is rounded to whole pixels when `textUserLayoutVersion ≥ 1`.
  - PIXELS is used as is.

### 4.4 Shortcuts that change type

CONFIRMED, shortcut JSON in `wasm`; editModes GLOBAL unless noted:

| Action id | Mac | Win/Linux |
|---|---|---|
| `text-font-size-increase` / `-decrease` | ⌘⇧. / ⌘⇧, (shown ⌘⇧> / ⌘⇧<), not in FigJam | Ctrl⇧. / Ctrl⇧, |
| `text-bold-increase` / `-decrease` | ⌘⌥. / ⌘⌥, (shown ⌘⌥> / <) | Ctrl⌥ |
| `text-letter-spacing-increase` / `-decrease` | ⌥. / ⌥, (shown ⌥> / <) | Alt |
| `text-line-height-increase` / `-decrease` | ⌥⇧. / ⌥⇧, | Alt⇧ |
| `toggle-bold` | ⌘B | Ctrl+B |
| `text-toggle-italic` | ⌘I | Ctrl+I |
| `text-toggle-underline` | ⌘U | Ctrl+U |
| `text-toggle-strikethrough` | ⌘⇧X | Ctrl⇧X |
| `text-edit-hyperlink` | ⌘⇧U (not in Sites) | Ctrl⇧U |
| `text-align-left` / `-center` / `-right` / `-justified` | ⌘⌥L / ⌘⌥T / ⌘⌥R / ⌘⌥J | Ctrl⌥… |
| `text-toggle-unordered-list` / `-ordered-list` | ⌘⇧8 / ⌘⇧7 | Ctrl⇧8 / 7 |
| `text-indent-list` (TEXT mode) | Tab, ⌘], ⌥⌘], ⌃⌘], ⇧⌘] | Ctrl+], Ctrl⌥], Ctrl⇧], Tab |
| `text-dedent-list` (TEXT mode) | ⇧Tab, ⌘[ and its variants | Ctrl+[ … |
| `text-delete-selection-or-end` (TEXT) | ⌃K | — |
| `text-delete-selection-or-next-character` (TEXT) | ⌃D | — |
| `select-all` | ⌘A | Ctrl+A |
| `paste-over-selection` / `paste-to-replace` / `paste-properties` | ⌘⇧V / ⌘⇧R or ⌘⇧⌥V / ⌘⌥V | Ctrl… |
| `text-style-title`, `-h1`, `-h2`, `-h3`, `-normal` | ⌘⌥1–4, 0/5 | FigJam only |

Each `<`/`>` binding has per-keyboard-layout variants (us_qwerty, dvorak, uk_mac, uk_pc, korean, hiragana_kana, unknown …) with a `display` override. Other action ids with no default key: `text-upper-case`, `text-lower-case`, `text-original-case`, `select-all-text`, `select-same-font`, `text-clear-list-formatting`, `text-upgrade-to-bidi`, `text-upgrade-explicit-layout-version`, `text-relayout`, `toggle-google-fonts`. CONFIRMED (`3653` action list). The step sizes behind the "increase/decrease" actions live in C++ and are not readable as strings (see §13).

## 5. Type settings modal

### 5.1 Frame

CONFIRMED (`3653`, `rC` "TypeSettings"):
- Body height is fixed at **506 px**, for every panel including the Underline drill-in.
- Tabs: **Basics**, **Details**, **Variable**.
  - Basics is dropped for a text-path-only selection.
  - Details and Variable are shown only to non-consumers of a style or when editing a style.
  - Variable is shown only when the font has variation axes.
  - With a single tab the header is just "Type settings".
- Opening from the panel with a style-consumer selection forces Basics; opening for text paths forces Details.

Every tab starts with a **preview box**, rendered by the engine as SVG (`t8O.getPreview(override, feature, variation, w, viewportH)`):
- The placeholder reads "Preview". "No preview available" is logged at most once per 30 s per family/style/feature.
- List, hanging and wrap previews are scaled to fit, with the scale shared across sibling options (`rc`).
- List previews shift right.
- Hover sets a preview override. On leave, a **300 ms** timeout clears it.

Closing: Esc closes, except while in TEXT edit mode; an outside click does not close. CONFIRMED.

### 5.2 Basics tab

Rows in order (CONFIRMED):

1. **Alignment**: Left / Center / Right / Justified, 4 segments, each with a tooltip and shortcut. For non-text-path selections.
2. **Decoration**: None / Underline / Strikethrough. Choosing anything but Underline resets `textDecorationSkipInk` to false. Double-clicking Underline, or the drill-in button (tooltip key `type_settings.decoration.details`), opens the **Underline** panel (§5.5).
3. **Case**: As typed / Uppercase / Lowercase / Title case / Small caps / Forced small caps.
   - Small caps is read-only, with the tooltip "Font doesn't support small caps", when the font lacks `SMCP`.
   - Forced small caps appears only when the font has `C2SC`.
   - Small caps are stored as `textCase ORIGINAL` + `fontVariantCaps SMALL`; forced is `ALL_SMALL`.
4. **Vertical trim** (`leadingTrim`): None / Cap height. For style owners only. Read-only when `leadingTrimDisabled`, with the tooltip "Font does not support vertical trim".
5. **List style**: None / Bulleted / Numbered (actions `text-clear-list-formatting`, `text-toggle-unordered-list`, `text-toggle-ordered-list`). Followed by **List spacing**, shown only when the whole node is not PLAIN.
6. **Paragraph spacing** (variable-bindable `PARAGRAPH_SPACING`).
7. **Truncate text** / **Max lines** (§3.3).
8. **Wrap** (§3.4).

For text-path-only selections, Basics instead holds **Position**: Subscript / Normal / Superscript.

### 5.3 Details tab

In order, CONFIRMED:

1. **Indentation** group:
   - "Hanging punctuation" on/off; label dimmed when not applicable.
   - "Hanging lists" on/off; dimmed for plain text.
   - "Paragraph indent" (variable-bindable `PARAGRAPH_INDENT`).
2. **Letter case** group: the Case control again, then PCAP, CASE, CPSP, TITL and UNIC toggles. C2PC is folded into Forced small caps.
3. **Numbers** group:
   - Style: Font default / Proportional lining / Proportional old style / Monospace lining / Monospace old style, mapped onto `fontVariantNumericFigure` × `fontVariantNumericSpacing`.
   - Position (Sub / Normal / Super).
   - Fractions (FRAC → `fontVariantNumericFraction` STACKED / NORMAL).
   - AFRC and ZERO toggles.
4. Feature groups (§5.6): **Letterforms**, **Stylistic sets**, **Character variants**, **Math**, **Horizontal spacing**, **Writing direction**, **More features**.
5. The layout-version banner (§2.4).

Each OpenType row is an Off / On segmented control:
- A row exists only if the font supports the tag. A supported tag that is not applicable to the selected characters gets a dimmed label with the tooltip "Not applicable for selected text" (1200 ms delay).
- Labels longer than 25 characters make the row 1.25× tall.
- The label is the font's own feature name when it provides one (`supported[tag]`), else Figma's name.
- DLIG and HLIG write `fontVariantDiscretionaryLigatures` / `fontVariantHistoricalLigatures`. Other tags write `toggledOnOTFeatures` / `toggledOffOTFeatures` (on a style) or `…ForSelection` with a `mixedStateOTFeaturesForSelection` list.

### 5.4 Variable tab

CONFIRMED (`3653` `rk`, `rv`):
- One slider and one field per axis, labelled by a known axis name or else the font's axis name or tag.
- `ital` is never shown.
- Hidden axes go under a collapsible "Additional axes". A per-family override exists only for `"SF Pro"`, where `wdth` is shown and `yaxs` is hidden.
- `wght` is wrapped in a variable-binding entry point.

| Axis range (max − min) | Slider step | Big step |
|---|---|---|
| ≤ 3 | 0.01 | 0.25 |
| ≤ 6 | 0.1 | 1 |
| otherwise | 1 | 10 |
| ≥ 500 | 1 | 25 |

- **Slider hints:** the named-instance values plus the default. Hints closer than 15 × step are thinned. With more than 15 left, only the default is kept.
- The field nudges 1 / 10.
- **Optical size:** `opsz` follows the font size, clamped into the axis range, until the checkbox **"Set optical size automatically"** is cleared. That writes `detachOpticalSizeFromFontSize` and `fontVariations: [{opsz, value}]`.
- Moving any non-opsz axis never writes opsz unless it is detached. Dragging opsz detaches it.

### 5.5 Underline drill-in

CONFIRMED (`3653` `re`): header "Basics / Underline" (or "Type settings / Underline"), with Back.

| Control | Values | Limits |
|---|---|---|
| Decoration | None / Underline / Strikethrough | — |
| Style | Solid / Dotted / Wavy | disabled unless underline |
| Thickness | field + slider; default = font's underline thickness × 100 as RAW "N%"; typing "%" or "px" | % : 0.5 … 20; px: 0.5 … 0.2 × fontSize (font size 12 if mixed) |
| Offset | field + slider; default = font's underline offset × 100 %; tooltip "Underline offset" | % : 0 … 25; px: 0 … 0.25 × fontSize |
| Skip ink | Off / On | disabled unless underline |
| Custom color | paint chit, solid only, variable-bindable (`TEXT_DECORATION_FILL_PAINT_DATA`); an empty list means "auto" (text colour) | hidden for None / Strikethrough |

Field formatter for thickness and offset:
- Nudge ÷ 2 for percent units and ÷ 10 for px.
- Display: "Auto" for RAW, then `N%` or `Npx` with 2 decimals.
- An empty input, "%", "px" or a prefix of "auto%" resets to the default.

C++ guards (CONFIRMED): "Cannot set text decoration {color, offset, skip ink, style, thickness} on a non-underlined text range". Invalid dotted or wavy rectangles are dropped with "TextDataHelpers (dotted|wavy): removed invalid decoration rect".

### 5.6 OpenType feature table

CONFIRMED (`3187` 866936):

| Group | Tags (panel order) |
|---|---|
| Letter case | PCAP C2PC CASE CPSP TITL UNIC |
| Numbers | AFRC ZERO (plus the numeric controls) |
| Letterforms | LIGA CLIG DLIG HLIG CALT RCLT ORDN RVRN VERT SWSH CSWH NALT STCH HIST ORNM ITAL RAND |
| Stylistic sets | SALT SS01–SS20 |
| Character variants | CV01–CV99 |
| Math | DTLS FLAC MGRK SSTY |
| Horizontal spacing | KERN FWID HWID HALT TWID QWID PWID JUST LFBD OPBD RTBD PALT PKNA |
| Writing direction | LTRA LTRM RTLA RTLM |
| More features | DNOM NUMR SINF ABRV VALT VHAL CFAR CPCT CURS EXPT FALT FINA FIN2 FIN3 HALN HKNA HNGL HOJO INIT ISOL JP78 JP83 JP90 JP04 LJMO MEDI MED2 NLCK PREF VPAL PSTF RUBY SMPL TJMO TNAM TRAD VJMO VKNA VKRN VRTR VRT2 |

- **On by default:** CALT, CLIG, CURS, KERN, LIGA, RCLT, CCMP, LOCL, MARK, MKMK, RLIG. Toggling one of these off records it in `toggledOff…`.
- 111 feature names are translated (`type_settings.open_type_features.*`). The `OpenTypeFeature` enum is in `schema/document.kiwi`.

## 6. Font picker

CONFIRMED, `3187` 385381, 119712 and 33239.

### 6.1 Structure and behaviour

- **Rows:**
  - Rows are 28 px tall, virtualised with an overscan of 10.
  - The search bar adds 40 px when the container height is fixed.
  - The selected family is scrolled to the middle of the list.
- **Keyboard:**
  - ↑ / ↓ move the faux focus (↑ can reach −1).
  - Enter applies the focused family.
  - Esc closes.
  - Any key disables mouse hover until the mouse moves.
- **Live preview:**
  - Focusing a row previews that family on the canvas, debounced **50 ms** and uncommitted.
  - There is no preview when the page has more than 50 directly selected nodes.
  - A mousedown on the canvas, or closing the picker, reverts the preview.
- **Search:**
  - The search box is focused and selected on open. Its placeholder is the current family.
  - The query is cleared when the selection, font set or current font changes.
- **Font set:**
  - The current font set is stored in `localStorage["fontPickerFontSet"]` and broadcast to other tabs.
  - A Shared fonts set with no team or org falls back to All fonts; Web fonts outside Sites also falls back.
- **Clear selection** button: only when the picker is clearable (e.g. replacing fonts).

### 6.2 Font sets

`Qr` enum, labels from `fullscreen.properties_panel.font_picker.font_set.*`:

| Value | Label key | Members |
|---|---|---|
| `all_fonts` | all_fonts | everything |
| `document_fonts` | document_fonts | `collectDocumentFonts()` from the engine, sorted by use count (descending) |
| `shared_fonts` | shared_fonts / ".org" / ".team" (named) | org or team uploads |
| `web_fonts` | web_fonts | uploaded-for-publishing + Google (Sites) |
| `uploaded_fonts` | uploaded_fonts | the user's uploads |
| `user_installed_fonts` | user_installed_fonts | LOCAL with `userInstalled` |
| `google_fonts` | google_fonts | GOOGLE source, excluding Ested-VF, Figma Hand, Font Awesome 5/6, KyivType, Material Icons, SF Pro (+Rounded), SF Compact (+Rounded), Sudo Var, Wavefont |
| `variable_fonts` | variable_fonts | every version has variation axes |
| `popular_fonts` | popular_fonts | a fixed 15-slot list (first available name per slot): Inter · Roboto · Segoe / Segoe UI · SF Pro Text / SF UI Text · Serif · Crimson Text · New York · Playfair Display · Source Serif Pro · Caveat · Figma Hand · Pacifico · Anonymous Pro · IBM Plex Mono · Roboto Mono |
| `summer_new` | summer_new | new Google families by preview-path allow-list |

### 6.3 Family list rules

- Families with no styles are skipped.
- These Google families are hidden: names ending in "charted", Playwrite families (except "Playwrite US Modern" and "Playwrite US Trad"), "Noto Color Emoji Compat Test", "?????", "Decovar Alpha", and families banned for the editor type.
- Colour-font Google families that cannot render are dropped: Blaka Ink, Bungee Color, Bungee Spice, Cairo Play, Foldit, Honk, Kalnia Glaze, Noto Color Emoji, Noto Znamenny Musical Notation.
- **"Recently installed":** a LOCAL family whose newest style was modified within 7 days.
- **Sort:** names starting with punctuation go last, then `localeCompare`.
- **Search:**
  1. The query is lowercased and split on spaces and punctuation.
  2. Every token must be a substring of the family name; families starting with "." are excluded.
  3. Families starting with the first token come first, then the standard order.

### 6.4 Row preview

- **Local fonts:** `/font-preview?file=<id>&font_size=12&postscript=…&family=…&style=…&v=5` from the agent.
- **Server fonts:** `previewUrl`. **Google fonts:** pre-fetched SVGs.
- **Style chosen for the preview:** the style closest to weight 400 and stretch 5, preferring non-italic, with ties going to "regular" / "medium" / "r".
- **SVG rescale:**
  - "… Mono" and the monospace set ×0.92
  - Workbench ×1.2
  - "… Script" / "… Brush" / the script set ×1.25
  - Nabla ×0.95
  - Monofett ×1.3
  - a per-family table otherwise

### 6.5 Font style dropdown

CONFIRMED (`figma_app` 448442):
- Sort order: non-italic before italic, then stretch, optical size and weight ascending, then name.
- A variable font adds "Variable font axes…", which opens Type settings on the Variable tab.
- "Apply variable…" binds `FONT_STYLE`, as a string or as a float (weight).
- An invalid bound style shows "missing font style".

### 6.6 Local fonts and the agent

CONFIRMED (`3653` `rY`, `3187` @7 324 488):
- **Update prompt:** shown on Mac and Windows when the local font agent's version is **< 14**. "Update your font installer" can be dismissed for **7 days** (604 800 000 ms, key `font-agent-update-dismissed`).
- **Agent protocol:** the client calls `/version` and `/font-files?freetype_minimum_api_version=…&isolate=true&`. Every call is refused while the browser's local-network-access permission is "prompt" or "denied".
- **Version gate:** an agent version ≥ 22 (or the desktop app) enables an extra capability (`R4`). INFERRED: newer metadata.
- **No local fonts:** the picker shows empty states ("Installed by you" headers) and a local-network-access banner that can be dismissed (`local_network_access_font_picker_search_error_dismissed`).
- Google families come from Figma's own catalog (R11 §1).

## 7. Missing fonts

CONFIRMED (`3187` missing_fonts_modal; `wasm`):
- **Toolbar entry:** "Missing fonts". It opens the modal, **536 px** wide.
- **Scope:** Current selection, Current page or All pages. "All pages" first loads every page, with a spinner toast "Finding missing fonts" after a **1500 ms** delay, then calls `getMissingFontInfoFromAllPages()`. Without an active page the engine logs "Attempting to search missing fonts in current page scope without active page".
- **Rows:**
  - One row per missing family / style, with "Select N items using this font".
  - Each row has a replacement family picker and a style select.
  - Families can be expanded to their styles.
  - "Show other missing fonts" reveals the rest.
- **Apply:** "Replace fonts", with a "Replace on the whole page" checkbox when the scope is the selection.
- **Banners:**
  - Fonts uploaded only for publishing: "… install its OTF/TTF file to edit".
  - Org upsell: separate admin and non-admin text.
  - Unreachable agent and local-network-access banners.
- **Editing a text with a missing font:**
  - The panel's style controls turn read-only.
  - Engine refusals: "Can't insert text due to missing font", "Can't replace text due to missing font".
  - Design systems show "missing font, can't make changes".
- **Rendering:** a missing font is shown with the last laid-out glyphs stored in the file (`derivedTextData`). INFERRED, the canonical Figma behaviour; consistent with "Missing font face, cannot truncate text".
- **Canvas search:** a "Missing fonts" filter (`canvas_search.missing_fonts`).

## 8. Text styles and variables

CONFIRMED (`3653`, `9489`, `figma_app` 532626):

**Bindable fields** (variables):

| Field | Variable type |
|---|---|
| FONT_FAMILY | string |
| FONT_STYLE | string, or float = weight |
| FONT_SIZE | float, also via the "Apply variable" preset |
| LINE_HEIGHT | float |
| LETTER_SPACING | float |
| PARAGRAPH_SPACING | float |
| PARAGRAPH_INDENT | float |
| TEXT_DATA | string, or float stringified by an expression; also a component text property or a CMS field |

Variable scopes used: FONT_FAMILY, FONT_STYLE, FONT_SIZE, TEXT_CONTENT.

**Responsive text styles:** a text style can hold per-variant font size, line height and letter spacing (`editVariantFontSizeForTextStyleNode`, `editVariantLineHeightForTextStyleNode`, `editVariantLetterSpacingForTextStyleNode`, `editVariantVCMForTextStyleNode`). The C++ also has `responsiveSetScalingMin/MaxFontSize`.

**Style consumer behaviour:**
- A node using a style sees the Basics tab only.
- "Mixed" styles in the selection turn on the add-property action (`clobberSelectedTextStyles`).
- Creating a style is disabled while a font is missing, while only the style is mixed, or when decoration, leading trim or wrap is mixed.

## 9. Lists, indentation, hanging

CONFIRMED:
- **List types:** `PLAIN`, `ORDERED_LIST`, `UNORDERED_LIST`. FigJam and Slides add `BLOCKQUOTE` / `HEADER`, already noted in the repo schema.
- Indent and dedent use Tab / ⇧Tab and ⌘] / ⌘[ in TEXT mode.
- The engine exposes `ChangeListSpacingBehavior`, an on-canvas list-spacing drag (INFERRED from the name).
- **Hanging lists:** markers sit outside the text box. **Hanging punctuation:** quotes hang into the margin. The schema fields are `hangingList` and `hangingPunctuation`.
- An HTML export note: "For hanging lists, 0 padding should be applied to the &lt;ul&gt; element."
- Previews `LIST_STYLE_*` and `HANGING_*` exist for each.
- Bullet glyphs are shaped in the bullets/ellipses pass (§2.3).

## 10. Shaping, line breaking, bidi, emoji, fallback

| Topic | Figma | Status / evidence |
|---|---|---|
| Shaping | HarfBuzz in wasm | CONFIRMED (§2.2) |
| Line breaks | UAX #14 in JS (`linebreak`-style state names), asked once per string | CONFIRMED (prior, canvas.md §36) |
| Bidi | ICU ubidi per paragraph. On failure it falls back to LTR. Gated per node by `textBidiVersion = 1`. `SourceDirectionality` AUTO / LTR / RTL, `DirectionalityIntent` | CONFIRMED (`wasm` strings) |
| Directionality UI | "Switch text direction" (only after RTL text was seen) | CONFIRMED |
| Fallback fonts | A built-in Noto Sans set: Noto Sans, Arabic, Bengali, Devanagari, Georgian, Gujarati, HK, JP, Javanese, KR, Kannada, Khmer, Lao, Malayalam, Math, New Tai Lue, SC, Symbols, Symbols2, TC, Tai Le, Tai Tham, Tai Viet, Tamil, Telugu, Thai | CONFIRMED (names); order and per-script choice INFERRED / unknown |
| Emoji | Drawn as **images**, never as glyph outlines. Per-node `emojiImageSet` (APPLE = 0, NOTO = 1); `usedEmojiImages`, `emojiCodePoints`, `emojiPaintIndices` in the geometry; downloaded by `emojiId` from `baseUrlForEmojis`; resource versions ≥ 5 pick the size; a default skin-tone preference exists | CONFIRMED (`wasm`: "Emoji should always be rendered by renderGeometryDirectly", "_emojiResourceVersion is >= 5…"; `figma_app`: "APPLE=0 … NOTO=1") |
| CJK | Kana / Hangul / JIS OpenType features listed; no kinsoku strings found | INFERRED: UAX #14 rules only |

## 11. Text editing behaviours

| Behaviour | Status | Evidence |
|---|---|---|
| Enter edit mode | double-click (selects the word under the pointer); `toggle-edit-mode` ⌘Enter (not FigJam, not with the AI assistant flag) | CONFIRMED live (behaviour/text.md); shortcut JSON |
| Leave | Esc keeps the text selected; a second Esc deselects; a remote event can exit ("Exiting text edit mode due to remote event") | CONFIRMED |
| Hidden editor | a focused DIV/textarea takes the input; IME `compositionstart` / `compositionupdate`; a fix for doubled input from the Microsoft IME | CONFIRMED (`figma_app`: "isHandlingDoubleInputForMicrosoftIMEFix") |
| Touch | `SelectTextUsingTouchEventsBehavior`, `DragTextCursorUsingTouchEventsBehavior`, view-only variants | CONFIRMED |
| Spell-check squiggle | an SDF shader (`RSQUIGGLE_SDF`) | CONFIRMED |
| Context menu | its own text-edit-mode context menu | CONFIRMED (`wasm`: "Tried to open text edit mode context menu without being in text edit mode.") |
| Caret / word / paragraph motion, triple-click | not readable as strings | open (§13) |

## 12. Text on a path and rendering

**Text on a path** (CONFIRMED):
- Node type `TEXT_PATH`, made with the tool `set-tool-text-path`.
- Behaviours: `ConvertTextPathBehavior`, `EditTextPathBehavior`; `combine-text-path-layers` / `separate-text-path-layers`.
- `TextPathStart{t, forward}` per segment.
- Vertical alignment means above / on / below the path.
- Flip reverses the direction.
- A tessellated path cache, `TessellatedTextPath`, checks its total distance.
- SVG export of hyperlinks on a text path is "not yet implemented".

The repo's docs/draw.md covers the rest.

**Rendering** (CONFIRMED):
- Glyphs are filled vector geometry, drawn with stencil-then-cover Loop-Blinn shaders (`LOOP_BLINN_GLYPHS_{UINT,USHORT}`).
- Glyph batches are deduplicated (`deduplicateGlyphRendering*`), and paths are cached in a glyph cache ("Glyph path not found in glyph cache after insert").
- The editor's own UI text uses a separate `TEXT_ALPHA` shader.
- No hinting, subpixel or LCD strings exist in the editor wasm. This matches grayscale, unhinted text (INFERRED; canvas.md §29).

## 13. UI strings

i18n keys in the build. The English bundle is not shipped in these chunks, so the labels below are given as the keys' plain readings. Where Figma's English wording is not certain, it is marked *(key)*.

**Panel:**
- Typography, Properties *(style modal)*, Font family, Font style, Font size, Mixed *(font size)*, Line height, Letter spacing, Paragraph spacing, Alignment.
- Align left, Align center, Align right, Justify, Align top, Align middle, Align bottom, Align above / Align on / Align below *(text on path)*, Flip *(text on path)*.
- Auto width, Auto height, Fixed size, Resizing.
- Type settings, Type details, Switch text direction, Variable font axes…, Apply variable…, Update your font installer, Update *(agent CTA)*.
- No list, Bulleted list, Numbered list, Underline offset.

**Type settings:**
- Tabs and headers: Basics, Details, Variable, Preview, Wrap, Auto, Pretty, Balance.
- Truncation: Truncate text, No truncation, Truncation enabled, Max lines.
- Decoration: Decoration, None, Underline, Strikethrough, Style, Solid, Dotted, Wavy, Thickness, Offset, Skip ink, Skip ink off, Skip ink on, Custom color, Details *(underline drill-in)*.
- Spacing and indentation: List spacing, Paragraph spacing, Paragraph indent, Indentation, Hanging punctuation, Hanging lists, List style.
- Case and trim: Case, Letter case, As typed, Uppercase, Lowercase, Title case, Small caps, Forced small caps, Font doesn't support small caps, Vertical trim *(leading_trim)*, Cap height, Font does not support vertical trim.
- Numbers: Numbers, Font default, Proportional lining, Proportional old style, Monospace lining, Monospace old style, Position, Subscript, Normal, Superscript, Fractions.
- Feature groups: Letterforms, Stylistic sets, Character variants, Math, Horizontal spacing, Writing direction, More features, Not applicable for selected text.
- Variable axes: Additional axes, Set optical size automatically.
- Layout-version banner: Older text rendering method used, … for part of the selection, the explicit-layout and bidi update descriptions and tooltips, Update, Revert, Disabled, Enabled.

**Font picker:**
- Search fonts, Clear selection, New *(badge)*.
- Font sets: All fonts, In this file *(document_fonts)*, Shared fonts / Used at {org} / Used by {team}, Web fonts, Uploaded by you, Installed by you, Google fonts, Variable fonts, Popular fonts, New this summer *(summer_new)*.
- Empty states: No search results, No fonts in current set, No shared fonts (+CTA), org upsell (+CTA).
- Local-fonts help: Enable local fonts, Use local fonts, "Figma comes preloaded …", "Bring your own fonts", "You can always download the font installer later from the settings page", "Do this later in account settings".

**Missing fonts:**
- Missing fonts, Replace fonts, Replacement, Select font, Select style, Current page, All pages, Replace on the whole page, Show other missing fonts, Finding missing fonts, Select N items using this font, Enable font.
- Uploaded-for-publishing notices, org upsell admin and non-admin texts, cannot connect to agent, local network access.

**Errors:**
- Can't insert text due to missing font.
- Can't replace text due to missing font.
- Missing font face, cannot truncate text.
- Limit the text height and enable ending truncation. This hides content; consider enlarging the container instead.
- Review rotated or transformed text manually before changing its bounds.
- Invalid value for textAutoResize / textDecoration / textDecorationStyle / textTruncation.

## 14. DesignerV2 today

The repo is mostly there. `engine/src/text` has HarfBuzz, libunibreak, truncation, leading trim, Balance / Pretty, lists and decorations. The Typography panel and TypeSettings.tsx have Basics, Details and Variable. `commands.ts` has every adjust shortcut. The schema (`schema/document.kiwi`) already holds every field above, the layout-version fields included.

**Matches:**
- Font size presets (`Typography.tsx:56`).
- Auto = `{100, PERCENT}` and "N%" → RAW.
- The shortcut keys of §4.4.
- The decoration styles.
- The OpenType enum.
- The Type settings tab set.

**Differs:**
1. **Pixel rounding.** Line heights round to whole pixels always (`TextLayout.cpp:268–281`). Figma rounds only when `textUserLayoutVersion ≥ 1`, so files with version-0 texts keep fractional line heights.
2. **Auto test.** The repo tests Auto as `|v − 100| < 1e-6`; Figma uses `< 0.1`.
3. **engine.md §7.4 wording.** It says "RAW 100% means Auto" and "PERCENT of the font size". The code does Figma's rule; the document is wrong.
4. **Font search.** Same AND-of-substrings, but no punctuation split, no prefix-first ranking, and no punctuation-last order (`fontList.ts:144`).
5. **Popular fonts.** The repo uses Google's top 50 instead of Figma's 15-slot list. There are no hidden-family or colour-font exclusions.
6. **Fallback chain.** macOS system families (`fonts.ts:92`) instead of Figma's Noto Sans set.
7. **Glyph rasterisation.** A curve-coverage shader (deliberate; canvas.md §29).

**Missing:**
1. **Bidi.** The repo hardcodes `HB_DIRECTION_LTR` and puts bidi in phase E3.2 (`TextLayout.cpp:156`). There is no "Switch text direction" panel button.
2. **Emoji.** None. Figma uses emoji image sets (Apple / Noto) per node, not colour-font glyphs.
3. **Optical size.** No `opsz` follows the font size, and there is no "Set optical size automatically" checkbox (`detachOpticalSizeFromFontSize` unused).
4. **Layout-version banner.** No Update / Revert banner, and nothing reads the layout-version fields.
5. **Variable-axis slider.** No step rules or tick hints; there is no "Additional axes" fold.
6. **Underline limits.** Thickness and offset are not limited to 0.5–20 % / 0–25 % (or 0.2× / 0.25× the font size in px). The defaults are not taken from the font's `post` metrics as "N%".
7. **Font picker.** No live preview debounce (50 ms) or >50-node cut-off; the font set is not persisted across tabs.
8. **Missing-fonts modal.** No All-pages scope or "Replace on the whole page". Not verified in depth.

## 15. Open questions

| # | Question | Probe that settles it |
|---|---|---|
| 1 | Steps of `text-font-size-*`, `text-bold-*`, `text-letter-spacing-*` and `text-line-height-*` (+1 px? ×1.1? next preset?), and how Shift changes them | Live: 16 px text, press ⌘⇧> five times and read the size; repeat for ⌥> (letter spacing in %/px) and ⌥⇧> (line height). Or decompile the wasm handler that the action id strings reach. |
| 2 | Click vs drag creation thresholds (drag distance before a fixed box is made; default box width) | Live: drag 2, 4, 8 px with the T tool and read `textAutoResize` and the width. |
| 3 | Default font of a new text (Inter Regular 12? last-used font?) | Live: create text after changing the font of another text. |
| 4 | Order of the Noto fallback chain, and whether local system fonts take part | Live: type mixed Thai + Arabic + CJK in Inter and read `derivedTextData.fontMetaData`. |
| 5 | Caret blink rate, word definition for double-click and ⌥←, triple-click scope (line or paragraph) | Live `scripts/drive.mjs` with `getSelection()`-style probes. |
| 6 | English wording of the keys marked *(key)* | Live: open each panel and capture its text. |
| 7 | What `R4` (agent version ≥ 22) unlocks | Read `3187` 33239 callers of `R4`. |
| 8 | Emoji image host and sizes (`baseUrlForEmojis`, resource versions) | Watch the network requests while typing 😀 in a text. |
