# 14 — Dev Mode (Figma Design desktop 126.9.13)

Dev Mode end to end, read from the shipped build: how it is entered and left, how its chrome differs, the Inspect panel, the code generators (CSS, SwiftUI, UIKit, Compose, Android XML) down to their number formatting, units and scale, variables in code, measurement, annotations, statuses, Compare changes, focus view, playground, Code Connect, plugins, assets / export and dev resources. The code generators come first because they are the part DesignerV2 most needs to match byte for byte.

## 1. Scope and sources

**Prior work reused.** `docs/research/figma/R9-dev-mode.md` (help-site research, rounds 5–6): the layout of the Inspect tab, Code / List, the units menu, Assets, statuses, annotations, measurements, Compare changes, ready-for-dev view and focus view, all as help.figma.com words them. This chapter summarises R9 in one line per point and spends the effort on what the code settles. Where they disagree, the code wins. Related atlas chapters: 04 (measurement tokens, ⌥ hover, saved measurements), 07 (colour formats in Inspect), 08 (CSS mapping of effects), 10 (documentation links, variant toggles), 11 (variables' code syntax).

**Sources read** (all under `~/.cache/figma-rea/figma/`, read-only; module numbers are webpack ids, offsets are byte offsets of the module's start).

| File @offset | Module | What it holds |
|---|---|---|
| `5519.min.js` @2355917 (copies in `3187` @2357000, `7362` @2354200) | 694547 | **The first-party code generators.** Compose, SwiftUI, CSS, the internal `CSSBUILDER`, the default-value table, the CSS property order, the node cache and `runExtension` (dispatch per language) |
| `5519.min.js` @875660 | 653694 | Unit enum (PIXEL 0 / SCALED 1), the scale-and-round function, the "hide layout / hide colour" settings |
| `5519.min.js` @850256 | 576667 | CSS value classes: px length (3-decimal rounding), percent, plain, keyword, `normal` |
| `5519.min.js` @843857 | 818410 | CSS colour (hex / rgba / display-p3) |
| `5519.min.js` @846211–849552 | 560811, 348613 | Bound-variable markers; CSS gradients (linear / radial / angular / diamond) |
| `5519.min.js` @853494 | 222911 | Name → identifier converters (CSS kebab, camelCase, Swift / Kotlin identifiers) |
| `5519.min.js` @827414 | 493533 | Language ids: WEB, IOS, IOS_UIKIT, ANDROID, ANDROID_XML, CSSBUILDER, FIGMA_PROPERTIES |
| `5519.min.js` @838702 | 108798 | Language dropdown items (first-party group, iOS and Android submenus, third-party plugins, Browse, Development) |
| `7362.min.js` | 408415, 372608 | display-p3 colour string; aspect-ratio fraction |
| `figma_app.min.js` @1056970 | 238204 | Style / variable reference `var(--name, value)` |
| `figma_app.min.js` @1058185 | 422609 | Code line shape `{code, indent, hint, matchingVars}`; 2-space indent; supported highlight languages |
| `figma_app.min.js` @1058708 | 7973 | Code hint enum (23 hints) |
| `figma_app.min.js` @1061089 | 610168 | Variable lookup, suggested-variable markers, paint filtering |
| `figma_app.min.js` @1028187 | 291897 | Code-language dropdown component |
| `figma_app.min.js` @1032624 | 994971 | "Unit scale" modal (scale-factor choices, rem-on-text checkbox) |
| `figma_app.min.js` @1035723–1040497 | 59683, 285217 | Unit labels per language; scaling of values shown in the panel |
| `figma_app.min.js` @~941068 | 506701 | Language label formatter; code-syntax slot per platform; default language |
| `figma_app.min.js` @1014755 | 33524 | Asset types and their labels |
| `figma_app.min.js` @~3102432 | 923530 | Annotation category presets and colour tokens |
| `figma_app.min.js` | (toolbar, unnamed) | Mode-switch toast (`switched_to_inspect`) with its delay and timeout |
| `7987.min.js` (31 KB) | — | Code block UI: copy, ⇧-copy-all, hint tooltips, "Show N more", pills for variables / instances / slots |
| `2276.min.js`, `2865.min.js`, `2323.min.js`, `1462.min.js` | — | Collapse thresholds of code sections |
| `3167.min.js` | — | Dev resources: add-link validation |
| `4752.min.js` | — | Command names of the code-settings menu (quick actions) |
| `scratchpad/wasm_strings.txt` (strings of `fullscreen__fullscreen-wasm__compiled_wasm.wasm`) | — | Keyboard-shortcut JSON; UIKit and Android XML templates (both generated in C++); Dev Mode C++ class names |
| `schema/document.kiwi` (repo) | — | SectionStatus, EditInfo, SectionStatusInfo, Annotation*, AnnotationMeasurement, CodeSyntaxMap |

No live probe was run. Findings are **CONFIRMED** (read in code), **INFERRED** (deduced from code), or **HELP** (help.figma.com, through R9).

---

## 2. Entering and leaving Dev Mode

| Item | Value | Evidence |
|---|---|---|
| Enter | **⇧D** = `enter-inspect-mode`. Not in FigJam, Zoom, Sites, Slides or Buzz. Edit modes GLOBAL and not TEXT, so ⇧D types a "D" while editing text. | wasm shortcut JSON: `"enter-inspect-mode" … ["Shift+D","!dev_handoff","!figjam"…]`. CONFIRMED |
| Leave | **⇧D** = `enter-design-mode`, only while in Dev Mode. Not in the VS Code extension (`handoff_extension`), the MCP app, Slides or Buzz. | `"enter-design-mode" … ["Shift+D","dev_handoff","!handoff_extension"…]`. CONFIRMED |
| Toolbar control | A segmented control for Design / Draw / Dev Mode, called `toolbelt_mode_segmented_control` in UI3. | `fullscreen.toolbar.toolbelt_mode_segmented_control.switched_to_dev_mode`. CONFIRMED |
| Switch announcement | A toast (visual bell) appears 200 ms after the switch. It stays **3000 ms** with the UI3 segmented control (`ce_il_root` flag) or **1200 ms** with the older toggle. The texts are "switched_to_dev_mode / _draw / _design" (UI3) or `dev_handoff.inspect_mode.switched_to_inspect / _design` (older). A screen-reader status message is also sent. No toast when the switch comes from the user's own toggle click (`l.has(t)`). | figma_app: `delay:200,timeoutOverride:c` with `c=3e3` / `c=1200`. CONFIRMED |
| Editor type | Dev Mode is `EditorType.DEV_HANDOFF = 3` (also stamped on edits made from it, `EditScope.editorType`). | `schema/document.kiwi` EditorType. CONFIRMED |
| Edit mode | Dev Mode is edit mode `DEV_HANDOFF`. Its default tool is **V** (`set-tool-default-dev-handoff`). Design's V (`set-tool-default`) is disabled there. | wasm JSON. CONFIRMED |
| Panel tabs | **⌥8** = Inspect (`show-dev-mode-inspect-panel`) and **⌥9** = Plugins (`show-dev-mode-plugins-panel`), Dev Mode only. In Design, ⌥8 / ⌥9 are Design / Prototype. | wasm JSON. CONFIRMED |
| Frame stepping | **→ / ←** = `dev-handoff-focus-next` / `-previous` (step through top-level frames). | wasm JSON. CONFIRMED |
| Disabled in Dev Mode | Boolean shortcuts ⌥⇧U / S / I / E, and Design's default tool. Editing shortcuts are generally `!dev_handoff`. | wasm JSON. CONFIRMED |
| Other shortcuts | ⇧T or **Y** = annotate (`set-tool-annotate`). ⇧M = measure (`set-tool-measure`; not while editing text or vectors). **⇧Y** = show / hide annotations (`toggle-show-annotations`; not FigJam, the VS Code extension, Slides, Sites or Draw). C = comment. | wasm JSON. CONFIRMED (R9 had ⇧Y as "user report": now confirmed) |
| VS Code extension | ⌘P file search, ⌘W close window, ⌘Q quit, plus a command palette. All gated `handoff_extension`. | wasm JSON. CONFIRMED |
| Gating | Dev Mode is a paid seat. `dev_handoff.paywall.*` (54 keys) and `demo_file.get_dev_mode_to_simplify` gate it. A user without access gets the upsell (`inspect_panel.properties.dev_mode_upsell_message`). | key list. CONFIRMED (keys) |

## 3. Chrome differences

R9 lists the panels from the help site. The code adds the following.

| Area | What the code shows | Evidence |
|---|---|---|
| Left panel | "Ready for dev" view (with count) above Pages and Layers. Its node rows show "Created" / "Edited" (`nodes_panel.created / edited`) and a thumbnail. Pages offer "Show all" / "Hide other" (`pages.show_all / hide_other`). Breadcrumbs collapse with an ellipsis and say how many layers are hidden (`breadcrumbs.ellipsis / hidden_nodes`). Locked layers have a tooltip (`layers_panel.locked_tooltip`). | keys. CONFIRMED |
| Right panel | Tabs Inspect / Plugins (`tab.inspect / tab.plugins`), plus `tab.comment` and `tab.string_management`. The C++ state is `DevModeActiveTab`, and the Inspect split position is a saved preference (`devHandoffInspectSplitPosition`). | keys; wasm `EditorPreferences…devHandoffInspectSplitPosition`. CONFIRMED |
| Inspect header | The layer's type label from `inspect_panel.node_type.*`: frame, frame_auto_layout, frame_with_animation, group, section, slice, text, rectangle, ellipse, line, polygon, star, vector, union / subtract / intersect / exclude, instance, instance_with_attribution, main_component, main_component_set, main_variant, detached_component, slot, slot_auto_layout, table, widget, code_instance, make_embed, figjam, page. Copy-name buttons for the layer and the page. "History" → Compare changes. | keys. CONFIRMED |
| Layer properties | The **box model** for a non-text layer (copy buttons for each width, height, padding, padding-to-parent, gap, distance, border side and corner radius: 27 `box_model.copy_*` keys), or the **typography preview** for text (`typography_preview_missing_font / _multiple_styles / _not_available`). | keys. CONFIRMED |
| Code / List | One toggle saved per user (atom `dev-mode-code-or-properties`), default **code**. Its labels are "Code" (`inspect_panel.code.code`) and "List" (`dev_handoff.layer_properties_list`). | figma_app module 77231: `E3("dev-mode-code-or-properties","code")`. CONFIRMED |
| Selection colours | `selection_colors` lists solid colours and gradient kinds (linear / radial / angular / diamond), with style details. | keys. CONFIRMED |
| Variables | Details panel: name, collection, mode, value, scope, code syntax, "from other mode", "values not all from same mode", "view in collection", local / community. Display switch: **Figma name** vs **code syntax** (`variables.panel_display_figma_name / _code_syntax`). | keys. CONFIRMED |
| Search | A filter bar in Inspect (`search_bar_filter`) that can also search codegen options. | keys. CONFIRMED |

---

## 4. Code generation: architecture

| Point | Value | Evidence |
|---|---|---|
| Runtime | The first-party generators run as a **built-in plugin** inside the plugin VM: name "First Party", pluginID "CSS", capability `codegen`, editor types DEV and INSPECT, private API on, `skipInvisibleInstanceChildren = true` (hidden instance children are never in code). | 694547 `prepareVmIfNeeded`. CONFIRMED |
| Languages (ids) | `WEB` (CSS), `IOS` (SwiftUI), `IOS_UIKIT`, `ANDROID` (Compose), `ANDROID_XML`, `CSSBUILDER` (internal, not in the dropdown), `FIGMA_PROPERTIES` ("Figma" properties view, always px). | 493533. CONFIRMED |
| Where each runs | CSS, SwiftUI, Compose and CSSBUILDER are **JavaScript** (694547). UIKit and Android XML are **C++** (`generateIOSSwiftCodeForNode`, `generateAndroidCodeForNode` on the fullscreen bridge). | 694547 `runExtension`. CONFIRMED |
| Not supported in C++ generators | UIKit gets a first line "Auto layout, grids, variables, and unit scale are not yet supported" as a `//` comment. XML gets the same sentence as an XML comment. | 694547. CONFIRMED |
| Default language | `{type:"first-party", id:"WEB"}`. An unknown id falls back to WEB. The choice lives in `appModel.devHandoffCodeLanguage`, and the units in `appModel.devHandoffPreferences.codeExtensionPreferences[languageId]` (C++, saved per user). | 506701 `p()`; appModel defaults. CONFIRMED |
| Set as default (org / team) | The ⋯ options menu has "Set as default" (`code.settings.set_as_default`). It stores `{behavior: OVERRIDE, language, preferences}`. Unticking it goes back to INHERIT. | figma_app 826747. CONFIRMED |
| Preferences passed | `{unit: PIXEL 0 \| SCALED 1, scaleFactor (default 1), customSettings, isExportRestricted, generateForCodePanel}`. | 694547 `runExtension`. CONFIRMED |
| Code line | `{code, indent (levels), hint?, matchingVars?}`. One indent level is **2 spaces**. A section is `{name, language, lines, matchingVars?, isTextSegment?, collapseAfterIndex?}`. | 422609 `"  ".repeat(indent)`. CONFIRMED |
| Highlight languages | typescript, cpp, ruby, css, javascript, html, json, graphql, python, go, sql, swift, kotlin, rust, bash, xml, plaintext, jsx, tsx, dart (also what plugins may return). | 422609 set `hq`. CONFIRMED |
| Node classes | Vector, boolean, or an "asset" (`isAsset` without image / video fill, unless it is a frame / component / instance with auto layout) → **vector class** (CSS gives an SVG section; SwiftUI gives `Image("name")`; Compose gives `Image(painterResource…)`). FRAME / GROUP / SLOT → frame. COMPONENT → component. COMPONENT_SET → nothing. INSTANCE → instance. RECTANGLE / ELLIPSE / LINE → shape. TEXT → text. | 694547 `n_.getNode`. CONFIRMED |
| Sub-tree export | `getCSSPropertiesOfSubTree` walks **at most 20 nodes** (depth-first through children) and returns camel-cased CSS properties per node (used by agents / MCP). `getHTMLSkeleton` returns an empty string (stub). | 694547 `tD(…,20)`. CONFIRMED |
| Gate | Codegen refuses when the file restricts copying and exporting ("Codegen is not allowed"). An export-restricted file gives **no SVG section**. | 694547; 753682. CONFIRMED |
| Colour profile | For a **Display P3** document, CSS colours are `color(display-p3 …)`. The sRGB equivalents are added as extra *fallback* lines with the hint "Display P3 fallback". | 694547 `e8`; 408415. CONFIRMED |

### 4.1 Hints (tooltips on code lines)

A code line can carry an info icon whose tooltip is `dev_handoff.code.hints.<name>`. Ids are from 7973.

| Id | Hint | Raised when |
|---|---|---|
| 0 | color_missing_style | A colour is neither a style nor a variable |
| 1 | variable_not_resolved | A bound variable could not be resolved |
| 2 | absolute_position (`{name}` = parent) | `left / right / top / bottom` of an absolute child |
| 3 | borders_dont_take_up_space | Strokes on an auto-layout container that are **not** included in layout |
| 4 | single_paint | Several visible paints, but the language takes only the first |
| 5 | unsupported_paint | Image / video / pattern used where a colour is needed (replaced by black) |
| 6 | unsupported_gradient_paint | A gradient used where a colour is needed (its first stop is used) |
| 7 | leading_trim | `leading-trim` / `text-edge` lines |
| 8 | plus_darker | Layer blend LINEAR_BURN (CSS `plus-darker`) |
| 9 | background_blend_mode_plus_lighter_darker (`{value}`) | Fill blend plus-lighter / plus-darker |
| 10–14 | swift_ui_separate_border_width, _blur_no_spread, _only_single_fill_for_shapes, _separate_corner_radius, _spacers_for_space_between | SwiftUI limitations |
| 15–17 | compose_separate_border_width, compose_shadow_incompatibility, compose_blur_tip | Compose limitations |
| 18 | display_p3_fallback | sRGB fallback lines of a P3 file |
| 19 | effects_in_svg | Effects on a vector (they are inside its SVG) |
| 20 | transform_included_in_svg | The vector or an ancestor is rotated or mirrored |
| 21 | swift_ui_background_blur | Background blur written as `.blur` |
| 22 | text_animation_composition | `animation:` lines of text animations |

### 4.2 Variables and styles in code

| Language | No code syntax set | With code syntax | Evidence |
|---|---|---|---|
| CSS | `var(--<cssName>, <fallback>)`. For a **style** (fill / text / effect): the same with the style's name. | `codeSyntax.WEB` written **verbatim**. If it contains `var(--x …)`, the panel marks only `--x` as the bound part. | 238204, 560811. CONFIRMED |
| SwiftUI | `Constants.<id>`. A section **"Variables"** is added: `struct Constants {` then one `static let <id>: <Type> = <value>` per variable (types CGFloat, Color, String, Font.Weight, or none for opacity), then `}`. | `codeSyntax.iOS` verbatim (no Constants entry). | 694547 `tF`, `tL`, `tJ`. CONFIRMED |
| Compose | `Variables.<id>`. A section **"Variables"**: `object Variables {` then `val <id>: <Type> = <value>` (types Dp, Sp, Color, Int, or none; Dp / Sp values get `.dp` / `.sp`), then `}`. | `codeSyntax.ANDROID` verbatim. | 694547 `j`, `B`, `C`. CONFIRMED |

**Name converters** (222911), applied to a variable's or style's full name:
- **CSS (`OX`).** Remove characters above U+007E, `'` and `"`, and turn line breaks into spaces. Trim, then replace each run of whitespace or `/` with **one `-`**. If the result is only `[-A-Za-z0-9_]`, keep it **with its case** (so "Colors/Primary 500" → `--Colors-Primary-500`). Otherwise split it into words, camel-case it, then write it as kebab-case (lower case, `-` before each capital and each digit run), and drop leading characters that are not letters, digits or `-`. An empty result becomes `unnamed`. CONFIRMED
- **Swift / Kotlin (`O$` / `LE`).** Same cleaning, then lodash `words`. The first word is kept as is; each later word gets an upper-case first letter; the words are joined. Leading characters that are not letters are dropped. An empty result becomes `unnamed`. "brand/primary 500" → `brandPrimary500`. CONFIRMED
- **Compose resources.** `R.drawable.<camelName>` (image), and `R.font.<snake_case family>` (lodash `snakeCase`, e.g. "Inter Tight" → `inter_tight`). CONFIRMED

**Markers (code panel only).** With `generateForCodePanel`, bound values are wrapped in comment markers (`/*BOUND_VAR_START_<id>*/…/*BOUND_VAR_END*/`, `/*BOUND_STYLE_START_<key>*/…`, `/*SUGGESTED_VAR_START_<n>*/…/*SUGGESTED_VAR_END*/`). The panel turns them into variable pills and suggestion tooltips, and strips them from copied text. CONFIRMED (610168, 238204, 7987)

**Suggested variables.** For **raw** values that equal a library variable (the node's `inferredVariables`), the panel offers that variable. The tooltip is `code_panel.suggested_vars_tooltip(_for / _value)`, and a "Suggested variables" section heads the list (`variables.suggested_variables.title`). Suggestions are only made for fields that actually appear in the output (fills → background, width / height, padding, gap, radius, strokes → border, opacity, font-family / font-size / line-height). CONFIRMED (694547 `et` / `na`, `tR` matchingVars)

---

## 5. CSS (WEB)

### 5.1 Number and colour formats

| Value kind | Rule | Example | Evidence |
|---|---|---|---|
| Length | Rounded to **3 decimals** (lodash round). `px` suffix, except 0, which is written `0` with no unit. | 12.3456 → `12.346px`, 0 → `0` | 576667 `RU`. CONFIRMED |
| Percent | Rounded to 3 decimals, then `%` | `125%` | 576667 `QE`. CONFIRMED |
| Opacity | `opacity` rounded to **4 decimals** (no trailing zeros) | 0.5 → `0.5` | 694547 `nk(opacity,4)`. CONFIRMED |
| Opaque colour | Uppercase hex `#RRGGBB`, shortened to `#RGB` when each pair repeats | `#FFF`, `#0D99FF` | 818410. CONFIRMED |
| Colour with alpha (colour alpha ≠ 1 or paint opacity ≠ 1) | `rgba(R, G, B, A)` with R / G / B = round(255·c) and A = alpha × opacity as **`toFixed(2)`**, so two digits are always written | `rgba(0, 0, 0, 0.25)`, `rgba(255, 255, 255, 0.50)` | 818410. CONFIRMED |
| Display P3 file | `color(display-p3 r g b)` with 4 decimals, or `… / a` with a as `toFixed(2)`, plus sRGB fallback lines | `color(display-p3 1 0.2 0)` | 408415. CONFIRMED |
| Colour-space source (gate `ce_tl_color_spaces`) | A colour picked in another space is written in that space (`QS` formatter) | — | 818410. CONFIRMED (format not read) |
| Linear gradient | `linear-gradient(<round(angle)>deg, <colour> <pos%>, …)`, with stop positions as `100·p` rounded to 2 decimals. 360° is written 0°. The angle is computed from the gradient handles against the box corners. | `linear-gradient(180deg, #FFF 0%, #000 100%)` | 348613 `W4`. CONFIRMED |
| Radial | `radial-gradient(<w%> <h%> at <x%> <y%>, stops)` (2 decimals) | `radial-gradient(50% 50% at 50% 50%, …)` | 348613 `Ey`. CONFIRMED |
| Angular / diamond | Separate formatters (1740 `p` / `X`), not read in detail | — | INFERRED |
| Solid in a multi-fill stack | Every solid **except the bottom one** is written as a two-stop gradient of itself, `linear-gradient(0deg, C 0%, C 100%)`. The list goes **top paint first**. | `background: linear-gradient(0deg, rgba(0, 0, 0, 0.20) 0%, rgba(0, 0, 0, 0.20) 100%), #FFF;` | 694547 `eX`, `e7` (reverse). CONFIRMED |
| Image fill | `url(<path-to-image>) lightgray <position> / <size> <repeat>`. FILL: `50% / cover no-repeat`. FIT: `50% / contain no-repeat`. TILE: `0% 0% / <100·s>px <100·s>px repeat` (s = scaling factor). CROP: size `<100/m00>% <100/m11>%`, position in px from the image transform, `no-repeat`. | `url(<path-to-image>) lightgray 50% / cover no-repeat` | 694547 `eK`. CONFIRMED |
| Video / pattern fill | Skipped | — | CONFIRMED |
| Blur | `blur(<radius/2>px)`. The halving is **not rounded**. With a bound variable it becomes `blur(calc(var(...) / 2))`. | radius 5 → `blur(2.5px)` | 694547 `ev`. CONFIRMED |
| Rotation | `rotate(<round3(−angle)>deg)`. A mirror adds `scaleX(-1)` / `scaleY(-1)` after it. | `rotate(-45deg)` | 694547 `eP`, `eN`. CONFIRMED |
| Aspect ratio (proportions locked) | Continued-fraction approximation, denominator ≤ max(50, height), tolerance 1e‑4, written `a/b` with no spaces; otherwise `w.toFixed(2)/h.toFixed(2)` | `aspect-ratio: 16/9` | 372608. CONFIRMED |

### 5.2 Units (rem)

- Only these properties are converted: width, height, left, top, right, bottom, padding, padding-left / right / bottom / top, gap, font-size, letter-spacing, line-height, min / max-width, min / max-height, row-gap, border-radius. Not converted: border width, shadows, blur, transform. CONFIRMED (694547 `tx`)
- The conversion replaces every number followed by `px` with `value / scaleFactor`, rounded to **5 decimals**, plus `rem`. The `/* … */` hint comment is converted too. CONFIRMED (`tT`, 653694 `hX`)
- **"Only apply rem on text"** (`customSettings.onlyText = "true"`, CSS only, a checkbox in the Unit scale modal) limits the conversion to font-size, letter-spacing and line-height. CONFIRMED
- The rem root is the language's `scaleFactor`. The help says 16 by default. In code, a missing scale factor counts as 1. The C++ preference store presumably seeds 16 when rem is chosen; this is open (§17).

### 5.3 Property order and grouping

Declarations are collected in a map. **Default values are removed.** The rest is sorted by one fixed list, then split into sections.

**Default values removed** (a declaration equal to its default is dropped, `eL`): width / height / min / max auto; `position: static`; flex-grow 0; flex-shrink 1; flex-basis auto; `box-sizing: border-box` (always set, so never printed); `align-self: center`; aspect-ratio auto; padding 0; **`flex-direction: row`**; **`justify-content: flex-start`**; `align-items: stretch`; `align-content: stretch`; gap / row-gap / column-gap 0; left / right / top / bottom auto; word-break normal; pointer-events auto; inset auto; border-radius 0; margin-bottom 0; text-indent 0; font-size 0; letter-spacing 0; text-transform none; text-align left; text-overflow clip; white-space normal; font-variant normal; text-decoration-line none; background-blend-mode normal; overflow visible; opacity 1; flex `0 1 auto`; flex-wrap nowrap; mix-blend-mode normal; transform-style flat; backface-visibility visible. CONFIRMED

Two consequences:
- A horizontal auto layout prints no `flex-direction`; only `column` is printed.
- `align-items` is printed for MIN (`flex-start`), CENTER and MAX. Nothing is ever `stretch` from auto layout, so `align-items` is always present on auto-layout frames.

**Sort order** (`ej`, CONFIRMED): box-sizing, display, position, left, right, top, bottom, inset, width, height, min-width, max-width, min-height, max-height, overflow, perspective, transform, transform-origin, transform-style, backface-visibility, -webkit-box-orient, -webkit-line-clamp, padding, padding-top, padding-bottom, padding-left, padding-right, border-radius, margin-bottom, border, border-top, border-right, border-bottom, border-left, border-width, border-color, border-style, box-shadow, opacity, background, background-clip, -webkit-background-clip, -webkit-text-fill-color, background-blend-mode, mix-blend-mode, flex-direction, justify-content, align-items, align-content, gap, row-gap, column-gap, flex, flex-grow, flex-shrink, flex-basis, align-self, flex-wrap, aspect-ratio, color, font-family, font-size, font-style, font-weight, line-height, font-variant, letter-spacing, text-align, text-decoration, text-decoration-line, text-decoration-style, text-decoration-skip-ink, text-decoration-color, text-decoration-thickness, text-underline-offset, text-underline-position, text-indent, text-transform, text-wrap-style, text-shadow, word-break, leading-trim, text-edge, font-kerning, font-variant-numeric, font-feature-settings, text-overflow, white-space, filter, backdrop-filter, pointer-events, content, grid-template-rows, grid-template-columns, grid-row, grid-column, grid-auto-flow, justify-self.

Properties missing from the list (`stroke`, `stroke-width`, `fill`, `-webkit-text-stroke-*`) get index −1 and so sort **first**, in insertion order (INFERRED from `indexOf`).

**Sections**, in this order (only non-empty ones are shown, CONFIRMED `tR`):

| # | Section | Properties |
|---|---|---|
| 1 | **Layout** | width, height, min / max-width, min / max-height, flex-grow, flex-shrink, align-self, flex, flex-wrap, display, padding (and sides), flex-direction, justify-content, align-items, align-content, gap, transform, transform-origin, transform-style, perspective, backface-visibility, row-gap, column-gap, -webkit-line-clamp, -webkit-box-orient, aspect-ratio, grid-* , justify-self |
| 2 | **Position** | left, right, top, bottom, and `position` **only when it is `absolute`**. `position: relative`, set on a parent of absolute children, is dropped here. |
| 3 | **Other** | Anything not in another group |
| 4 | **Typography** (text only) | First: color, text-align, text-wrap-style, leading-trim, text-edge, font-kerning, font-variant-numeric, font-feature-settings, text-overflow, white-space, overflow. Then, if there is an effect style and text shadows: a blank line, `/* <effect style> */`, then text-shadow. Then, if there is a text style: a blank line, `/* <text style> */`, then font-family, font-size, font-weight, font-style, font-variant, text-decoration-*, text-underline-*, letter-spacing, text-transform, line-height, -webkit-text-stroke-* (each group in the sort order above). |
| 5 | **Style** | background, background-blend-mode, opacity, mix-blend-mode, background-clip, -webkit-background-clip, -webkit-text-fill-color, border(-*) and border-radius, stroke, stroke-width, fill. Then, if there is an effect style: a blank line, `/* <effect style> */`, then box-shadow, filter, backdrop-filter. |
| 6+ | **`"<first 10 chars>..."`** (one per styled run) | For mixed text, each run whose style differs from the node's base gets its own section, named after its first 10 characters (+ "..." when longer). Its text style's name is a comment. Whitespace-only runs and duplicates are skipped. |
| last | **SVG** (language html) | Vectors and asset-like nodes: the node's SVG markup, one tag per line, indented by nesting. Hint 20 on the first line when transformed. Not for export-restricted files. |

`overflow: hidden` (from clip content on a frame) is collected but falls in the Typography-only group, so **it is not shown for frames**. INFERRED from `tR` grouping: the line is built, then dropped because L2 is empty for non-text.

Each line is printed `property: value;`. A hint of type *Comment* adds ` /* hint */` (line-height and the text-decoration thickness / offset values).

### 5.4 Per-node rules

**Size** (`e4.addSize`):
- `width` only when horizontal sizing is **FIXED**. A text with auto width (WIDTH_AND_HEIGHT) gets no width unless it is rotated.
- `height` only when vertical sizing is FIXED. A text with HEIGHT or WIDTH_AND_HEIGHT resize gets none.
- min / max sizes whenever they are set.

**Position.**
- Absolute (`shouldUseAbsolutePosition`): `position: absolute`. Then `left` when the constraint is left and its offset ≠ 0, `right` when right, `top` when top and ≠ 0, `bottom` when bottom. Hint 2 names the parent.
- A frame with absolute children gets `position: relative` (Layout) — which §5.3 then drops.

**Flex item** (parent auto layout):
- Fill on the primary axis → `flex: 1 0 0`.
- Otherwise `flex-shrink: 0`, but only when **both** the parent's primary size and the child's are FIXED.
- Fill on the counter axis → `align-self: stretch`.
- Grid parent: `grid-row` / `grid-column` as `span n` (auto-flow) or `<i+1> / span n`, plus `justify-self` / `align-self` (start / end / center / auto) from the child's grid alignment.

**Auto-layout container:**

| Property | Rule |
|---|---|
| display | `inline-flex` when the parent is not auto layout and the frame hugs along its main axis (vertical + counter AUTO, or horizontal + primary AUTO); otherwise `flex` |
| padding | Shorthand with 1 / 2 / 4 values (top-right-bottom-left reduction, `eS`). When **exactly one** side is non-zero: `padding-<side>` alone. |
| flex-direction | NONE / HORIZONTAL / GRID → row (dropped as default), VERTICAL → column |
| justify-content | MIN flex-start, CENTER center, MAX flex-end, SPACE_BETWEEN space-between, SPACE_AROUND space-around, SPACE_EVENLY space-evenly, BASELINE baseline |
| align-items | Same table from counterAxisAlignItems |
| align-content | `space-between` when counterAxisAlignContent is SPACE_BETWEEN. When wrapping and not every child fills: flex-start / center / flex-end from the counter alignment. Otherwise stretch (dropped). |
| flex-wrap | `wrap` when WRAP |
| gap | Primary alignment space-between / around / evenly: no `gap`. Only when wrapping, the counter spacing as `row-gap` (horizontal) or `column-gap` (vertical), unless align-content is space-between. Otherwise: no wrap, or both spacings equal → `gap: <itemSpacing>`. align-content space-between → only the main-axis gap as `column-gap` / `row-gap`. Otherwise two values, `gap: <row> <column>`. |
| Grid frame | `display: grid` (or `inline-grid` when hugging), `grid-template-rows / -columns` from the stored CSS sizing strings, row-gap / column-gap, `grid-auto-flow: row` for auto-flow, then padding |

**Strokes** (`e7`):
- One paint only; more paints raise hint 4.
- Equal sides → `border: <w> <solid|dashed> <colour>` (dashed when there is a dash pattern).
- Unequal sides → `border-top / -right / -bottom / -left` for each side > 0, or bound to a variable.
- **Stroke alignment is ignored in CSS.**
- Containers whose strokes are not included in layout raise hint 3.
- Vectors: `stroke-width` (only when > 0 or bound) and `stroke`. A vector's fill is written `fill:`, not `background:`.

**Corner radius:** `border-radius` with 1 / 2 / 4 values (TL TR BR BL), each bindable.

**Effects:**
- DROP_SHADOW and INNER_SHADOW → `box-shadow: x y blur spread colour [inset]`.
- A drop shadow on a vector or group → `filter: drop-shadow(x y blur colour)` instead.
- LAYER_BLUR → `filter: blur()`; BACKGROUND_BLUR → `backdrop-filter: blur()`.
- Noise, texture, glass and shader are skipped.
- The list is written **in reverse effect order**: each effect is prepended (`eC.concat`).
- Text: DROP_SHADOW → `text-shadow: x y blur colour`. INNER_SHADOW is skipped with a console warning.

**Blend:** a layer blend other than PASS_THROUGH → `mix-blend-mode`. NORMAL → normal; LINEAR_BURN → plus-darker (hint 8); LINEAR_DODGE → plus-lighter; the rest by their CSS names. Fill blends → `background-blend-mode` (hint 9 for plus-*).

**3D** (gate `vec_cartwheel_plugin_api`): `translateZ` / `rotateX` / `rotateY` / `rotateZ` in that order, `transform-origin` when it is not 50% 50%, `backface-visibility: hidden`, `perspective`, `transform-style: preserve-3d`. With preserve-3d the frame's opacity, blend and effects are removed.

**Text** (`ty`, `tA`, frame part of `tk`):

| Property | Rule |
|---|---|
| font-family | Quoted when it contains a space |
| font-weight | The numeric weight. Without one, from the style name: Thin 100, ExtraLight 200, Light 300, Regular 400, Medium 500, SemiBold 600, Bold 700, ExtraBold 800, Black 900, default 400 (spaces and "Italic" removed, lower-cased). |
| font-style | `italic` when the style name contains "Italic", otherwise `normal` (always printed) |
| line-height | PIXELS → `<px>px; /* <pct>% */`. PERCENT → `<pct>%; /* <px>px */`. AUTO → `normal`. |
| letter-spacing | PIXELS as is, PERCENT × font size / 100, in px. Negative values are kept. |
| text-transform / font-variant | UPPER uppercase, LOWER lowercase, TITLE capitalize. SMALL_CAPS → `font-variant: small-caps`, SMALL_CAPS_FORCED → `all-small-caps`. |
| decoration | `text-decoration-line: underline` or `line-through`. Underline adds style (solid / dotted / wavy), skip-ink (auto / none), thickness and offset (px or % with the other unit as a comment, or auto), colour, and **always** `text-underline-position: from-font`. |
| text-align | left (dropped) / center / right / justify |
| vertical align | A text whose vertical align is not TOP and whose height is not hug gets `display: flex; flex-direction: column; justify-content: flex-start / center / flex-end` |
| truncation | `TRUNCATE` resize → `text-overflow: ellipsis; overflow: hidden; white-space: nowrap`. Max lines → `display: -webkit-box; overflow: hidden; text-overflow: ellipsis; -webkit-box-orient: vertical; -webkit-line-clamp: n`. |
| text-wrap-style | BALANCE balance, PRETTY pretty |
| leading trim | CAP_HEIGHT → `leading-trim: both; text-edge: cap` (hint 7) |
| OpenType | LNUM / ONUM, TNUM / PNUM, FRAC, ORDN, ZERO → `font-variant-numeric`. KERN → `font-kerning: normal / none`. Every other feature → `font-feature-settings: 'xxxx' on/off, …`. |
| colour | The first visible fill (hint 4 when there are several). A gradient or image fill becomes `background` + `background-clip: text` + `-webkit-background-clip: text` + `-webkit-text-fill-color: transparent`. |
| text stroke | `-webkit-text-stroke-width` (2 decimals) and `-webkit-text-stroke-color` (the first solid; black with hint 5 if none) |

### 5.5 CSSBUILDER (internal)

A Figma-internal "sx" chain (`sx.flex.itemsCenter.add({ … }).$`) built from a JSON table of ~400 atomic rules (display, flex, padding scale pt/pb 6–36 …). It is not offered in the dropdown (the first-party list has only WEB, iOS and Android), and it is used for autocomplete in the VS Code extension. Not a Tailwind generator. CONFIRMED (`tO`, `nS` map)

**Tailwind.** It exists only in the Dev Mode **MCP server** (`get_design_context` default format `react/tailwind`, `useTailwind: true`), not in the Inspect code panel. CONFIRMED (2622)

---

## 6. SwiftUI (IOS)

| Topic | Rule | Evidence |
|---|---|---|
| Number scaling | `hX(v)`. With unit PIXEL or scale 1: v rounded to **5 decimals**. With SCALED: `v / scaleFactor`, 5 decimals. Written as a bare number (no unit). | 653694. CONFIRMED |
| Colour | `.black` when r, g, b are all within 1e‑5 of 0. `.white` when all are within 1e‑5 of 1. Otherwise `Color(red: R, green: G, blue: B)` with each `+toFixed(2)` (≤ 2 decimals, trailing zeros dropped). Opacity ≠ 1 or alpha ≠ 1 appends `.opacity(+(o·a).toFixed(2))`. | `t1`. CONFIRMED |
| Gradients | `LinearGradient(stops: [Gradient.Stop(color: C, location: 0.00), …], startPoint: UnitPoint(x: …, y: …), endPoint: …)`, with location `toFixed(2)` (always 2 digits) and points `+toFixed(2)`. `EllipticalGradient(stops:…, center:)`. `AngularGradient(stops:…, center:, angle: Angle(degrees: …))`. Wrapped in `.background(` … `)`. | `t3`, `t4`, `t6`. CONFIRMED |
| Image fill | `Image("PATH_TO_IMAGE")`. FIT: `.resizable()` and `.aspectRatio(contentMode: .fit)`. TILE: `.resizable(resizingMode: .tile)`. FILL / CROP: `.resizable()`, `.aspectRatio(contentMode: .fill)`, `.frame(width:, height:)`, `.clipped()`. Image opacity: `.opacity(…)`. | `t7`. CONFIRMED |

**View line:**
- Auto layout horizontal → `HStack(alignment: .top|.bottom|.center|.firstTextBaseline, spacing: N) { ... }`.
- Auto layout vertical → `VStack(alignment: .leading|.trailing|.center, spacing: N) { ... }`.
- Primary SPACE_BETWEEN / EVENLY / AROUND → a multi-line stack of `View()` and `Spacer()` lines under comments `// Space Between` (etc.), with hint 14.
- Non-auto-layout frame → `ZStack { ... }`.
- Shape → `Rectangle()` plus `.foregroundColor(.clear)`. It becomes `View()` when "hide colour" is on and the shape has effects.
- Vector → `Image("<layer name>")`.
- Text → optional `// <text style>`, then `Text("…")`.

The view line is the **section name**: HStack / VStack / ZStack / Rectangle / Text / Image. CONFIRMED (`ns`, `no`, `nl`, `nc`)

**Modifier order** (`tq`): view, font, kerning, underline, strikethrough, multilineTextAlignment, foregroundColor, fill, padding, frame, position, backgrounds, cornerRadius, shadows, borders, blur, transform, **opacity last**. Indent: **0** for stacks (modifiers start at column 0 after `{ ... }`), **1 level** (2 spaces) for Rectangle / Text / Image. CONFIRMED

**Modifiers:**
- **`.frame(…)`**:
  - Neither axis fills → `width: W` (FIXED) and / or `height: H`.
  - Either axis fills → FIXED axes as `minWidth: W, maxWidth: W` (same for height), fill axes as `maxWidth: .infinity` / `maxHeight: .infinity`.
  - `alignment:` is appended. For stacks it comes from tables over primary × counter alignment; for text, from horizontal × vertical alignment (`.topLeading`, `.leading`, `.bottomTrailing`, …).
- **Padding:**
  - All four equal → `.padding(N)`.
  - Otherwise leading = trailing → `.padding(.horizontal, N)`, else `.padding(.leading, N)` and `.padding(.trailing, N)`.
  - Then top = bottom → `.padding(.vertical, N)`, else `.top` / `.bottom`.
  - Zero values are skipped.
- **Position:** an absolute child gets `.position(x:<cx>, y:<cy>)` — the box **centre** — with no space after the colons.
- **Corner radius:** `.cornerRadius(<max radius>)`. Unequal corners raise hint 13.
- **Border:**
  - `.overlay(`
  - `RoundedRectangle(cornerRadius: R)`, or `Rectangle()` when there is no radius
  - `.inset(by: w/2)` for INSIDE, or `.inset(by: -w/2)` for OUTSIDE (nothing for CENTER)
  - `.stroke(C, lineWidth: W)`, or `style: StrokeStyle(lineWidth: W, dash: [a, b])`
  - `)`
  - The width used is the largest side; unequal sides raise hint 10.
- **Shadow:** `.shadow(color: C, radius: blur/2, x: X, y: Y)`. A spread raises hint 11. Inner shadow, glass, noise, texture and shader are skipped.
- **Blur:** `.blur(radius: r/2)`. Background blur is written the same way, with hint 21.
- **Rotation:** `.rotationEffect(Angle(degrees: +(-angle).toFixed(2)))`.
- **3D:** `.rotation3DEffect(.degrees(n), axis: (x:…, y:…, z:…), anchor: UnitPoint(…))` in Z, Y, X order. Anything unsupported → `// SwiftUI can't represent: …`.
- **Opacity:** `.opacity(<4-decimal value>)`.
- **Text:**
  - `.font(Font.custom("<family>", size: S))`, or `Font.system(size:)` when there is no family. A weight other than regular adds `.weight(.<w>)`, with weight names thin, ultralight, light, regular, medium, semibold, bold, heavy (ExtraBold), black. Italic adds `.italic()`. More than one part splits `.font(` over several lines.
  - `.kerning(N)` **only when letter spacing > 0**.
  - `.foregroundColor(C)`.
  - `.underline()`, or `.underline(true, pattern: .solid|.dot, color: C)`. `.strikethrough()`.
  - `.multilineTextAlignment(.center|.trailing)`.

The **Variables** section follows when constants were used (§4.2). CONFIRMED

**Unimplemented type:** "iOS codegen for nodes of type Unknown has not been implemented yet". CONFIRMED

## 7. UIKit (IOS_UIKIT, C++)

Generated by C++ (`FGDevHandoffBindings` → `generateIOSSwiftCodeForNode`) as plain lines. The first line is the "not yet supported" comment (§4). The building blocks, from the wasm format strings (CONFIRMED as strings, order INFERRED):
- `var view = UIView()` / `UILabel()`, `view.frame = CGRect(x:, y:, width:, height:)`, `view.translatesAutoresizingMaskIntoConstraints = false`, `parent.addSubview(view)`.
- Constraints: `view.<anchor>.constraint(equalToConstant: N).isActive = true`, `view.<anchor>.constraint(equalTo: parent.<anchor>, constant: N).isActive = true`.
- Colours: `UIColor(red: r, green: g, blue: b, alpha: a)`. Fonts: `UIFont(name: "…", size: N)`, or via `fontDescriptor` with number-spacing / number-case feature settings. `NSAttributedString.Key.kern / underlineStyle / strikethroughStyle / paragraphStyle` with `paragraphStyle.lineHeightMultiple = …`.
- Layers: separate `shadows` (clipsToBounds false) and `shapes` (clipsToBounds true) container views, and `stroke` (an inset UIView). `let layerN = CALayer()` / `CAGradientLayer()` with backgroundColor, colors / locations / startPoint / endPoint, `shadowPath = UIBezierPath(roundedRect:cornerRadius:)`, shadowColor / Opacity / Radius / Offset, cornerRadius, borderWidth / borderColor, compositingFilter, transform, and `UIImage(named:)?.cgImage` as contents.

## 8. Jetpack Compose (ANDROID)

| Topic | Rule | Evidence |
|---|---|---|
| Colour | `Color(0xAARRGGBB)`: each byte round(255·c), upper-case hex; alpha = colour alpha × paint opacity | `M2`. CONFIRMED |
| Numbers | `hX` as for SwiftUI (5 decimals, divided by the scale factor when SCALED). Text sizes use 2 decimals. Lengths always get **`.dp`** and text **`.sp`**, even when the unit is px (scaling only changes the number). | 694547 `K`, `ep`. CONFIRMED |
| Sections | **Modifier**: a first line `Modifier`, then one modifier per line indented 1 level. **Layout** (auto layout only): a `Row(` / `Column(` stub. **Text**. **Image**. **Variables**. | `C`, `ea`, `ep`, `en`. CONFIRMED |

**Modifier order** (`T`): offset, shadow, blur, borders, size, transform, backgrounds, **padding last**. Opacity is not in the list, so it sorts **first** (index −1). INFERRED from `indexOf`.

**Modifiers:**
- `.offset(x = X.dp, y = Y.dp)` for absolute children (relative x / y).
- `.shadow(elevation = <blur>.dp, spotColor = C, ambientColor = C)`. The elevation is the **unscaled** blur radius. Hint 16.
- `.blur(radius = R.dp)`, with hint 17.
- `.border(width = W.dp, color = C[, shape = …])`. Then CENTER adds `.padding(<w/2>.dp)`, OUTSIDE adds `.padding(<w>.dp)`, INSIDE adds nothing. Unequal sides raise hint 15.
- `.width(W.dp)` and `.height(H.dp)`: **always both**, whatever the sizing.
- `.background(color = C[, shape = RoundedCornerShape(…)])`, one per solid fill.
- Radius shapes: `RoundedCornerShape(size = R.dp)` when all corners are equal, otherwise `RoundedCornerShape(topStart =, topEnd =, bottomStart =, bottomEnd =)`.
- `.padding(start = L.dp, top = T.dp, end = R.dp, bottom = B.dp)`, with zero sides left out.
- `.alpha(<4-dec>f)`.
- `.graphicsLayer { rotationX / Y / Z = <2-dec>f, transformOrigin = TransformOrigin(x f, y f) }` for 3D. Anything unsupported → `// Compose can't represent: …`.

**Layout stub:**
- `Row(` / `horizontalArrangement = …,` / `verticalAlignment = Alignment.Top|CenterVertically|Bottom,` / `) {` / `// Child views.` / `}`.
- `Column(` with `verticalArrangement` and `horizontalAlignment = Alignment.Start|CenterHorizontally|End`.
- Arrangement: `Arrangement.spacedBy(<gap>.dp, Alignment.<start|centre|end>)`, or `Arrangement.SpaceBetween / SpaceAround / SpaceEvenly`.

CONFIRMED (R9 had the comment only)

**Text:**
- `Text(`, `text = "…",` (with `"` and `\n` escaped), then optionally an empty line and `// <text style>`.
- `style = TextStyle(` with these lines in order:
  - `fontSize = S.sp,`
  - `lineHeight = L.sp,` — PIXELS as is, PERCENT × size / 100; none for AUTO.
  - `fontFamily = FontFamily(Font(R.font.<snake>)),`
  - `fontWeight = FontWeight(<100–900>),`
  - `fontStyle = FontStyle.Italic,`
  - `color = C,`
  - `textAlign = TextAlign.Right|Center|Justify,`
  - `letterSpacing = X.sp,` — **only when > 0**.
  - `textDecoration = TextDecoration.LineThrough|Underline,`
- then `)` and `)`.

CONFIRMED

**Image:** `Image(` / `painter = painterResource(id = R.drawable.<camelName>),` / `contentDescription = "image description",` / `contentScale = ContentScale.Fit|Crop|FillBounds|None` / `)`. CONFIRMED

**Unimplemented type:** "Not implemented." CONFIRMED

## 9. Android XML (ANDROID_XML, C++)

From `generateAndroidCodeForNode`. The panel indents lines: a line starting with `<`, or ending with `>` but not `->`, gets level 0; every other line gets level 1. The first line is the "not yet supported" XML comment. CONFIRMED.

Building blocks seen in the wasm strings:
- `xmlns:android="http://schemas.android.com/apk/res/android"`, `xmlns:aapt`, `android:id="@+id/canvas"`, `<RelativeLayout`, `<TextView`, `android:%s="%s"`, `android:background="%s" />`.
- `layout_width / layout_height`, `layout_alignParentLeft / Right / Top / Bottom`, `layout_centerHorizontal / Vertical`, `layout_marginLeft / Right / Top / Bottom`.
- `elevation`, `translationX / Y`, `rotation`, `textSize`, `textColor`, `letterSpacing`, `lineSpacingExtra`, `textStyle`, `textAppearance`, with styles as `<style>` and `<item name="android:%s">%s</item>`.
- Vector drawables (`android:fillColor`, `android:strokeColor`, `<aapt:attr>`, `<gradient>`).
- Notes `fullscreen.android_code_gen.translation_y` and `…multiple_dropshadows_not_supported`.

Layout is absolute (RelativeLayout + margins). INFERRED

---

## 10. Code panel UI

| Item | Value | Evidence |
|---|---|---|
| Language dropdown | Header "first-party", then **CSS**, **iOS ▸** (SwiftUI, UIKit), **Android ▸** (Compose, XML). If codegen plugins are installed: a separator, a "third-party" header and the plugins (a plugin with several languages becomes a submenu). Then "Browse plugins" (opens the plugin browser at "recents_and_saved") or "Add" in admin contexts. Then a separator and "Development" (local plugins). Org plugin allowlists filter the list. | 108798. CONFIRMED |
| Label | "Code language: {codeLanguage}" (`code.language_named`) for the button's aria / label | 291897. CONFIRMED |
| Unit menu | `alternative_units.dimension_unit` with **px** (`pixel_unit`) and the scaled unit: **rem** (WEB), **pt** (IOS, UIKit), **dp** (Compose, XML; `sp` for text properties). Plugin languages declare their own `scaledUnit` / `defaultScaleFactor` in manifest `codegenPreferences` (`itemType "unit"`). Then "Unit settings…" (`unit_settings_menu_option`). Quick actions: "Use px" / "Use {scaledUnit}". | 59683, 994971, 4752. CONFIRMED |
| Unit scale modal | Title `unit_settings_modal_title`, with its own language dropdown (languages without alternative-unit support hidden). **iOS / Android:** a select with **3, 2, 1, 1/2, 1/3** (`1/3` and `1/2` labels). **CSS / plugins:** a number field "Inspection scale factor" (min 0.1, ≤ 2 decimals). Below it a description per platform (`description_scale_factor_web / _ios / _android / _third_party {unitName}`). CSS only: the checkbox "Only apply rem on text". Changes apply with a 250 ms debounce. | 994971. CONFIRMED |
| Panel values | Box model, list and asset sizes follow the unit. SCALED → value / scaleFactor (none when the factor is 0 or 1, and none for non-text values when "rem on text" is on). Asset sizes use `toLocaleString(maxFractionDigits 2)` and `W × H` with thin spaces. | 285217, 33524. CONFIRMED |
| Plugin settings | Codegen plugins' `select` preferences appear as submenus (the first option is the default); `action` items call `codegen.preferences` back. | 285217 `F`. CONFIRMED |
| Copy | Each section has a copy button (`inspect_panel.copy_section {sectionName}`). With **⇧** held it copies **all sections** (`copy_section_with_shift`); hovering with ⇧ highlights everything. Copy ignores selection markers. | 7987. CONFIRMED |
| Collapse | A section longer than **15 lines** collapses after line 15 with "Show {count} more" (`code.show_more`). Text-animation sections collapse after 6. In the fit-to-height view (playground / compare), visible lines = floor((height − 18) / 18), at 18 px per line. | 2276 / 2865 `collapseAfterIndex:15`, 1462, 2323. CONFIRMED |
| Pills | Instances inside code (Code Connect) show as pills ("Inspect nested component"), slots as slot pills, variables as variable pills | 7987. CONFIRMED |
| Plugin errors | `inspect_panel.code.error`, `error_this_plugin`, `error_details`, `error_link`. "Update" prompt for outdated codegen plugins (`code.update_prompt*`). "Generate code" button for plugins with auto-run off (`inspect_panel.auto_run`, `generate_code`). | keys. CONFIRMED |

---

## 11. Measurements and redlines

R9 (help): in Dev Mode, hovering another layer shows distances to the selection with no modifier (⌥ in Design). Saved measurements: ⇧M, drag between edges, double-click to edit the text, Delete to remove. Their model is in R9 / chapter 04.

What the code adds:

| Item | Value | Evidence |
|---|---|---|
| C++ behaviours | `DevHandoffMeasurementMouseBehavior` (hover distances and saved measurements), `DevHandoffStackMouseBehavior` (auto-layout padding and spacing overlays, tokens `fsDevHandoffAutolayoutPadding` / `fsDevHandoffAutolayoutSpacing`), `DevHandoffTLFCanvasHighlightBehavior` (top-level frame highlight), `DevHandoffNodeStatusMouseBehavior` (status labels on canvas), `DevHandoffAnnotationsMouseBehavior` / `DevHandoffEditorAnnotationsMouseBehavior` | wasm strings. CONFIRMED (names) |
| Colours | Theme tokens `bg / border / text / icon -fs-measure` (+ hover, secondary, tertiary, strong). Hex values are not in the JS (Open Q). The help's "red" is consistent with Figma's measure tokens. | 5741 token map; ch. 04. CONFIRMED (tokens) |
| Accessibility | Screen-reader messages while creating a measurement: started, side of node selected (top / bottom / left / right), created, "no options, cancelled" | `measurements.accessibility.*`. CONFIRMED |
| Saved model | `NodeChange.measurements` 384: `AnnotationMeasurement {id, fromNode, toNode, fromNodeSide (TOP 0, BOTTOM 1, LEFT 2, RIGHT 3), toSameSide, innerOffsetRelative, outerOffsetFixed, toNodeStablePath, freeText}` | schema. CONFIRMED |
| Removal | "Annotations removed" visual bell with a count (`visual_bell.annotations_removed_count`); `purge-unneeded-measurements` | wasm strings. CONFIRMED |

## 12. Annotations

R9 (help): Annotation tool ⇧T, text plus "+ Property", categories, a green dot in Dev Mode, View › Annotations. The code adds:

| Item | Value | Evidence |
|---|---|---|
| Shortcuts | **Y** and **⇧T** = annotate tool; **⇧Y** = show / hide annotations | wasm JSON. CONFIRMED |
| Presets | ACCESSIBILITY 1, BEHAVIOR 2, CONTENT 3, DEVELOPMENT 4, INTERACTION 5. **Behavior** is a fifth preset that R9 did not list. | schema; 923530. CONFIRMED |
| Preset colours | Accessibility → **pink**, Content → **orange**, Behavior → **blue**, Development → **green**, Interaction → **blue** | 923530 `u()`. CONFIRMED |
| Colour tokens | Each colour (green, pink, red, blue, yellow, orange, teal, violet) maps to `--color-bgannotation<colour>`; violet uses `bgannotationpurple`. Text / icon colour: `--color-textonlightannotation` for **yellow and orange**, `--color-textondarkannotation` for the rest. | 923530 `p`. CONFIRMED |
| Custom categories | Stored `{color, customColor, label}`. Edit window: add, remove (with a confirm dialog), reorder by drag or keyboard, errors for a duplicate label or an invalid colour / label. Categories are initialised on first use (`initialize-annotation-categories`) and saved with `update-annotation-categories` (undoable). | keys; 923530. CONFIRMED |
| Pinned properties | Label "Pin properties". Per-layer offers include alignment (9 positions plus baseline-left / centre / right), auto layout mode, auto spacing (around / between / evenly), text style, font size, text align, shadow, component, image, video. "All properties added" when nothing is left. | `annotations.*` keys. CONFIRMED |
| Actions | Copy link, delete, filter by category, hide annotations, more actions; a visibility disclaimer with "Learn more" | keys. CONFIRMED |

## 13. Ready for dev, statuses, notifications

R9 (help) covered the statuses, "Changed", the Ready-for-dev view (filters, sort, cards) and the focus view. The code adds:

| Item | Value | Evidence |
|---|---|---|
| Model | `SectionStatusInfo {status: NONE 0 / BUILD 1 ("Ready for dev") / COMPLETED 2, lastUpdateUnixTimestamp, description (the note), userId, prevStatus}` on node field 355; `EditInfo` 331 decides "Changed" | schema. CONFIRMED |
| Menu titles | "Design changed since ready" and "… since completed" (`status.menu_title_design_changed_since_ready / _completed`); "Start handoff" title; note field "Add a note" (`popover_title_add_a_note`, `menu_note_placeholder`, `menu_note_button`) | wasm and JS keys. CONFIRMED |
| Menu items | Mark as ready (first time / again / edited variants), Mark as completed, Remove status, Copy dev link, Copy focus link, Copy summary link, Open in Dev Mode, Show in focus view; an "offline" state | `status.*`. CONFIRMED |
| Toasts | Marked as ready (and plural), marked as completed (and plural), status removed (and plural) | `visual_bell.*`. CONFIRMED |
| Canvas tag | "Ready for development" tag (view-only variant), layers tag (collapsed aria) | `tag.*`. CONFIRMED |
| Notifications | "You will be notified about status changes" (`dev_mode.you_will_be_notified_about_status_changes`); `status_updates` | keys. CONFIRMED |
| Overview | Statuses can't be set on some layers (tooltips `layer_cannot_have_status`, `design_structure_prevents_status`). Upsells for marking completed / incomplete / ready on lower plans. | `overview_mode.tooltip.*`. CONFIRMED |
| C++ | `DevHandoffNodeStatusObserver`, `DevModeStatusesChanged`, `DevHandoffState.readySectionItems`, `REBUILD_DEV_HANDOFF_NODE_LISTS` | wasm. CONFIRMED (names) |

## 14. Compare changes, focus view, playground, Code Connect

| Feature | Code findings | Evidence |
|---|---|---|
| Compare changes | Entry points "Compare versions" and "Compare to main component" (`compare_changes.entrypoint.*`); from History: compare changes and compare selected items. A banner shows "added layer", "removed layer" or "no changes". The overlay marks layers **added / changed / removed**. Code diff lines are marked added / removed: lines carry `diff: ADDED / REMOVED` (422609 `j5`) and get a gutter of 8 px per indent + 24. Text content diffs mark where insertions and deletions start and end. C++ `CompareChangesBehavior`, editor mode `COMPARE_CHANGES`. Analytics: diffing, switch versions, no image. | keys; 7987; wasm. CONFIRMED |
| Focus view | `devModeFocusView`, `FocusModeBehavior`, `FocusModeReparentingObserver`. Resize handles labelled min / max width and height (`focus_view.resize_label_*`); resizing is disabled for hug elements. Modes (`focus_view.modes`), reset changes. | wasm; keys. CONFIRMED |
| Playground | "Explore component behavior", "Select parent instance". C++ keeps `interactivePlaygroundInitialPropsFailures` and `componentPropsForDevModeFocusedNode`. The scratch copy uses the code-section fit-to-height view (§10). | keys; wasm. CONFIRMED |
| Code Connect | Error pill (`code_connect.error_pill_text`), "Go to parent". Inspect shows the mapped snippet instead of codegen. Documentation-link names: see chapter 10. Pills for nested instances. | keys; 7987. CONFIRMED |
| Detached components | Inspect shows that a layer was a detached component, with "Unlink from main component" and a confirm dialog | `detached_component.*`. CONFIRMED |

## 15. Assets, export, dev resources, plugins

| Feature | Code findings | Evidence |
|---|---|---|
| Asset types | Bit flags **ICON 1, IMAGE 2, GIF 4, VIDEO 8, COMPONENT 16, ILLUSTRATION 32, MOTION 64** (ASSET_ALL_EXPORT = 14 = image + gif + video). Labels: Video, GIF, Animation, Image, Icon, Instance, Asset (illustration). | figma_app 33524; `ASSET_*` enums. CONFIRMED |
| Asset panel | Groups icons / illustrations / images / GIFs / videos / animations, each with a download menu and settings. Images: "Include source". States: "Preparing… {time}", "Nothing to export", "Too many image sources" (disabled). C++ `DevHandoffAssetManager`, `DevModeAssetPanelProperties`. | `assets.*` keys; wasm. CONFIRMED |
| Images | Inspect "Images" section: alt text, a "decorative" toggle, copy alt text, scale, opacity, download by type | `inspect_panel.images.*`. CONFIRMED |
| Dev resources | Add link: a URL without a scheme gets `http://` added. An invalid URL → toast "invalid link" (error, **2000 ms**); a duplicate → "duplicate link" (error, 2000 ms). Links are stored on the **server** per file and node (REST), not in the document. Third-party link previews come from integration plugins ("Connect to …", auth required). Component links are inherited from the main component and can't be edited on the instance. | 3167. CONFIRMED |
| Plugins in Dev Mode | Plugins tab with pinned plugins (pin / unpin), "Inspect plugins go here", new plugin, more plugins, plugin development hint, close plugin. Codegen plugins appear in the language dropdown (§10). Inspect-type plugins run per selection. | `inspect_panel.*`, `plugin_panel.*`. CONFIRMED |

---

## 16. UI strings

The build carries i18n keys, not English (see the chapter 09 note). English is given where R9 / help attests it; everything else is the key.

**Mode and panels:** `dev_handoff.inspect_mode.switched_to_inspect`, `…switched_to_design`, `…leave_dev_mode`; `fullscreen.toolbar.toolbelt_mode_segmented_control.switched_to_dev_mode / _draw / _design`; `dev_handoff.tab.inspect` ("Inspect"), `tab.plugins` ("Plugins"), `tab.comment`; `toolbar.inspect_aria_label`; `right_panel.accessible_label`.

**Code:**
- Languages and controls: `dev_handoff.code.lang_css` ("CSS"), `lang_ios` ("iOS"), `lang_swiftui` ("SwiftUI"), `lang_uikit` ("UIKit"), `lang_android` ("Android"), `lang_compose` ("Compose"), `lang_android_xml` ("XML"), `lang_figma`; `code.language`, `code.language_named`, `code.settings`, `code.settings.set_as_default`, `code.options`, `code.show_more`, `code.update_prompt*`, `code.unsupported`; `language_dropdown.first_party_header / third_party_header / preferences_header(_unit)`; `code_language.browse / add / development`.
- Panel: `inspect_panel.code.code` ("Code"), `dev_handoff.layer_properties_list` ("List"), `inspect_panel.copy`, `copy_section`, `copy_section_with_shift`; the hints `dev_handoff.code.hints.*` (§4.1).
- Units: `dev_handoff.alternative_units.dimension_unit`, `pixel_unit` ("px"), `rem_unit` ("rem"), `pt_unit` ("pt"), `dp_unit` ("dp"), `use_pixel_unit`, `use_scaled_unit`, `unit_settings_menu_option` ("Set unit scale…" per help), `unit_settings_modal_title` ("Unit scale"), `inspection_scale_factor`, `scale_factor.select_label`, `only_apply_rem_on_text`, `description_scale_factor_web / _ios / _android / _third_party`.
- Native generator lines (literal, not i18n): "Auto layout, grids, variables, and unit scale are not yet supported"; "// Child views."; "// Space Between", "// Space Evenly", "// Space Around", "// Alternating Views and Spacers"; "SwiftUI can't represent: …", "Compose can't represent: …"; "iOS codegen for nodes of type Unknown has not been implemented yet"; "Not implemented."; `contentDescription = "image description"`; `url(<path-to-image>)`; `Image("PATH_TO_IMAGE")`.

**Inspect:** `inspect_panel.node_type.*` (§3), `inspect_panel.properties.*` (width, height, fixed, hug, fill, padding.*, radius.*, border.*, gap, flow.horizontal / vertical / horizontal_wrap / grid, grid.*, rotation, opacity, layout, justify), `inspect_panel.typography*`, `inspect_panel.colors.*`, `inspect_panel.shadows.*`, `inspect_panel.images.*`, `inspect_panel.history.compare_changes` ("Compare changes"), `inspect_panel.component_information`, `dev_handoff.box_model.*`, `dev_handoff.selection_colors` ("Selection colors"), `dev_handoff.variables.details_*`, `variables.panel_display_figma_name / _code_syntax`.

**Annotations / measurements:** `dev_handoff.annotations.add_annotation`, `pin_properties_label`, `filter_by`, `edit_categories_option_label` ("Edit categories…"), `category_preset.development / interaction / accessibility / content / behavior` ("Development", "Interaction", "Accessibility", "Content"; "Behavior" not attested), `categories_edit_window.*`, `hide_annotations`; `dev_handoff.measurements.accessibility.*`; `dev_handoff.visual_bell.annotations_removed_count`.

**Status:** `dev_handoff.status.ready_for_dev` ("Ready for dev"), `status.completed` ("Completed"), `status.mark_as_ready` ("Mark as ready for dev"), `status.mark_as_completed` ("Mark as completed"), `status.remove` ("Remove status"), `status.show_in_focus` ("Show in focus view"), `status.copy_focus_link` ("Copy link to focus view"), `status.copy_dev_link`, `status.menu_title_design_changed_since_ready / _completed`, `status.popover_title_add_a_note`; `visual_bell.marked_as_ready(_multiple)`, `marked_as_completed(_multiple)`, `status_removed(_multiple)`; `tag.ready_for_development`.

**Compare / focus / playground / Code Connect:** `compare_changes.entrypoint.compare_versions / compare_main_component`, `compare_changes.banner.added_layer / removed_layer / no_changes`, `compare_changes.overlay.added / changed / removed`, `compare_changes.layers` ("Layers"); `focus.show_on_page`, `focus.remove_status`, `focus.copy_link`, `focus_view.resize_label_*`; `playground.explore_component_behavior`, `playground.select_parent_instance`; `code_connect.error_pill_text`, `code_connect.go_to_parent_button`.

**Assets / resources:** `dev_handoff.assets.*` (icon, icons, image, images, gif, video, animation, illustration, asset, instance, nothing_to_export, preparing, preparing_time, images_include_source, too_many_image_sources); `developer_related_links.*` (add_link_button, link_placeholder, invalid_link, duplicate_link_error, edit_link, delete_link, open_in_new_tab, copy_link, go_to_main_component, component_inherited_links_desc).

---

## 17. DesignerV2 today

The repo has the Dev Mode chrome in `src/renderer/src/editor/devmode/` (annotations, compare, ready for dev, playground, Code Connect, plugins, status tag) and the Inspect panel and generators in `src/viewer/inspect/`. `InspectPanel` is shared by the viewer and the editor's Dev Mode.

| Area | DesignerV2 | Figma | Verdict |
|---|---|---|---|
| CSS lengths | 2 decimals (`num`, `model.ts`) | 3 decimals (lodash round); 0 written as `0` with no unit | **differs** |
| rgba alpha | `num(a)` → "0.5" | `toFixed(2)` → "0.50" | **differs** |
| `flex-direction: row` | printed | dropped as a default | **differs** |
| Default filtering | ad hoc | a default table (§5.3) removes ~45 defaults | **differs** |
| Sections | Layout / Style / Typography | Layout / Position / Other / Typography / Style, plus text-run sections and SVG | **missing**: Position, Other, run sections, SVG |
| Typography order | colour, align, family, size, style, weight, line-height, letter-spacing… | colour, text-align, … then a blank line, `/* style */`, family, size, style, weight, line-height, variant, letter-spacing, decoration, transform | partly matches (no blank line; order of later props) |
| Multi-fill solids | every solid plain | upper solids as `linear-gradient(0deg, C 0%, C 100%)` | **differs** |
| Radial / angular CSS | fixed `50% 50% at 50% 50%` / conic | computed size and centre (§5.1) | **differs** |
| Box-shadow order | effect order | reverse effect order | **differs** |
| Text-only CSS | ✗ | truncation, line-clamp, vertical-align flex, wrap style, leading trim, OpenType, underline details, text stroke, gradient text | **missing** |
| `inline-flex`, `flex-shrink` rule, wrap gaps, grid | partial (`flex-shrink: 0` for any non-fill child) | rules of §5.4 | **differs / missing** |
| CSS variable names | strips invalid characters | kebab-case fallback; case kept when valid | **differs** (edge cases) |
| rem | `px / root` rounded to 3, all px | listed properties only, 5 decimals, optional text-only | **differs** |
| SwiftUI | `Color(red:…, opacity:)` with 2 decimals; `{ // Child views... }` | `.black` / `.white` shortcuts, `.opacity()` modifier, `{ ... }`, `Constants` struct, the frame rules, overlay borders, shadow radius / 2, kerning only > 0 | **differs** in many details |
| Compose | Modifier lines; Row / Column stub | `Modifier` header line, fixed order (padding last), `.alpha`, border padding, `Variables` object, `TextStyle` block | partly matches |
| UIKit / Android XML | ✗ | C++ generators | **missing** |
| Unit scale modal | rem root / scale number | 3 / 2 / 1 / ½ / ⅓ select for native; a number field (min 0.1) for CSS; rem on text only | **differs** |
| Hints | ✗ | 23 hints with tooltips | **missing** |
| Code collapse | ? | 15 lines, then "Show N more" | check |
| ⇧D, ⇧Y, Y / ⇧T, ⇧M, ←/→, ⌥8 / ⌥9 | ⇧D and ⇧T / ⇧M per R9; the rest unverified | §2 | check |
| Annotation preset colours | presets without colour (R9) | §12 mapping (Development green …), Behavior preset | **missing** |
| Dev resources | `DevResources.tsx` | `http://` prefix, duplicate / invalid toasts at 2000 ms, server-side storage | check |
| Statuses / EditInfo / measurements schema | in `schema/document.kiwi` | same | matches |

### As built (2026-10-18, wave 6)

Built from the table above in its order; the generators are `src/viewer/inspect/` (`css.ts`, `native.ts`, `nativeClassic.ts`, `code.ts` the section / line / hint shape, `codegen.ts` one entry point with the units, `CodeSections.tsx` the panel's view), shared by the viewer, the editor's Dev Mode, the playground, compare and Copy as code.

- **Numbers and colours (§5.1).** CSS lengths `round(v, 3)` + `px`, 0 as `0`; percentages 3 decimals; opacity 4; `rgba()` whenever the colour's alpha or the paint's opacity isn't 1, alpha `toFixed(2)` (`0.50`). The panel's own read-outs keep 2 decimals.
- **Names (§4.2).** `cssVariableName` is Figma's `OX` (case kept when only `[-A-Za-z0-9_]`, else camel → kebab, `unnamed`); `camelName` is `O$` (lodash `words` for ASCII); Web code syntax is written verbatim.
- **CSS (§5.3, §5.4).** Declarations in a map, the default table dropped, Figma's sort list, sections Layout / Position / Other / Typography (text only — a frame's `overflow` is dropped with it) / Style, then one section per text run styled apart (first 10 characters + "..."; blank runs and repeats skipped). A blank line and `/* text style */` before the font, `/* effect style */` before the shadows and blurs. Rules: size only on a fixed axis (an auto-width text only when rotated); `aspect-ratio` by continued fraction when the ratio is locked; an absolute child of an auto layout in Position (`left` / `top` when ≠ 0 on MIN, `right` / `bottom` on MAX, hint 2 naming the parent); flex items (`flex: 1 0 0`, `align-self: stretch`, `flex-shrink: 0` only for a fixed child of a fixed parent); containers (`inline-flex` when hugging the width outside auto layout, padding 1 / 2 / 4 values or one side alone, `justify-content` / `align-items` / `align-content`, wrap gaps per §5.4); strokes (one paint, hint 4; `border` or per side; vectors `stroke-width` / `stroke` and `fill`; gradients / images where a colour is needed → first stop / black, hints 6 / 5; hint 3 when an auto layout's strokes aren't in layout); radius 1 / 2 / 4 values; backgrounds top first with upper solids as `linear-gradient(0deg, C 0%, C 100%)`, linear angles from the handles in px, radial size and centre from the handles, image FILL / FIT / TILE / CROP; `mix-blend-mode` (LINEAR_BURN plus-darker, hint 8) and `background-blend-mode` (hint 9); effects in reverse order, a drop shadow on a vector or group as `filter: drop-shadow()`, blurs halved unrounded (`calc(var() / 2)` when bound), `text-shadow` for text; text: colour (gradient text with `background-clip`), alignment, vertical alignment as a flex column, truncation and line clamp, `text-wrap-style`, leading trim (hint 7), OpenType (`font-variant-numeric`, `font-kerning`, `font-feature-settings`), line height px `/* % */` or % `/* px */`, underline style / skip-ink / thickness / offset / colour / `from-font`, text stroke.
- **Units (§5.2, §10).** rem only on §5.2's properties, `/ factor` to 5 decimals, a line's comment too, "Only apply rem on text"; each language keeps its own scale factor; pt / dp divide by it (SwiftUI, Compose — Compose keeps `.dp` / `.sp`); UIKit and XML aren't scaled (their first line says so). Unit scale modal: its own language dropdown, CSS's "Inspection scale factor" (≥ 0.1, 2 decimals) with "Only apply rem on text", native 3 / 2 / 1 / 1/2 / 1/3, applied after 250 ms.
- **SwiftUI (§6).** One section named after the view (HStack / VStack / ZStack / Rectangle / Text / Image), `{ ... }`, modifiers in `tq` order at column 0 for stacks and one level in otherwise; `.black` / `.white` / `Color(red:green:blue:)` + `.opacity()`; `.font(` split over lines with `.weight()` / `.italic()`; kerning only > 0; `.frame` with min = max beside a filling axis and its alignment table; `.position(x:, y:)` centre; `.cornerRadius(max)` (hint 13); overlay border with inset by stroke alignment and dashes (hint 10); shadow radius / 2 (hint 11); blur / background blur (hint 21); gradients and image fills inside `.background(`; space-between stacks as views and spacers (hint 14); bound variables as `Constants.<name>` with a "Variables" section (`struct Constants`), iOS code syntax verbatim.
- **Compose (§8).** "Modifier" (`Modifier`, then alpha, offset, shadow (hint 16), blur (hint 17), border + its alignment padding (hint 15), width and height always, rotation, backgrounds, padding last), "Layout" (Row / Column stub with `spacedBy` / SpaceBetween… and alignment), "Text" (`TextStyle` block with the style comment), "Image" (vectors, image fills), "Variables" (`object Variables`, Dp / Sp / Color).
- **UIKit and Android XML (§7, §9)** in TypeScript (`nativeClassic.ts`), not C++: the "not yet supported" first line, UIView / UILabel with CALayers, attributed text and anchors; `<View` / `<TextView` in a RelativeLayout with margins, `@drawable` / `@style`, a `<style>` section; XML indented by §9's rule. Statement order is ours (§18 question 4).
- **Hints (§4.1).** 17 of the 23 are raised (all but 0, 1, 18, 19, 20, 22); the panel draws an info icon with the tooltip. Their English is ours (the build has only keys).
- **Panel (§10).** Each section has its own Copy; ⇧ copies every section and marks them all; a section over 15 lines collapses behind "Show {count} more". The language menu is CSS, iOS ▸ (SwiftUI, UIKit), Android ▸ (Compose, XML), then the plugins, then px / the scaled unit and "Set unit scale…"; its label is "Code language: {codeLanguage}". List view lists Position and Other too.
- **Copy as code ▸** (atlas 03): CSS, CSS (all layers), iOS, Android — Dev Mode's generators in px (`edit.copy-as-css`, `-css-recursive`, `-ios`, `-android`). "CSS (all layers)" heads each layer with `/* name */` (ours).
- **Annotation presets (§12).** Development green, Interaction blue, Accessibility pink, Content orange, Behavior blue (TS `PRESET_COLOR`, C++ `presetColorName`).

**Not done:** the SVG section of vectors and assets (needs the engine's SVG export in the panel); grid containers (`display: grid`, tracks, `grid-row` / `-column`); 3D transforms and mirroring (`scaleX(-1)`); Display P3 colours and their fallbacks (hint 18); hints 0, 1, 19, 20, 22; the code panel's variable / style markers, pills and suggested variables (§4.2); CSSBUILDER; "Set as default" and codegen plugins' select preferences; the Behavior preset is not among the four default categories (the owner's file lists four); the per-run style comment of run sections; the `Copy as code` upsell row; the rows of §17 marked "check" (shortcuts, dev resources toasts).

**Sweep (2026-10-18)** — branch `worktree-agent-a44e0af86efbcac0b`, read further from `5519.min.js` module 694547 and the fullscreen Wasm's format strings.

- **SVG section** (`css.ts svgSection`, `InspectPanel useVectorSvg`): a vector's SVG — the engine's SVG export, as Copy as SVG — a tag a line (`outerHTML` split, trimmed; a closing tag one level out, an opening one that doesn't close itself one level in), hint 20 on its first line when the layer or a parent is rotated or mirrored; none when the file blocks exports. A vector's `filter` / `box-shadow` lines carry hint 19 (`EffectsInSvg`).
- **Mirroring** (`model.ts rotationAndMirror`, Figma's): mirrored, `scaleY(-1)` when the layer without its Y flip has no rotation, else the rotation without the X flip and `scaleX(-1)`; `transform: rotate(…) scale…(-1)` (`e3`: the rotation only when ≠ 0).
- **Grid containers and items**: `display: grid` (`inline-grid` when either axis hugs), `grid-template-rows / -columns` (a flexible track Figma's `minmax(0,%dfr)` / `minmax(0,%.2ffr)`, every track 1fr `repeat(n,minmax(0,1fr))` — the format strings in the Wasm; a fixed track `<n>px` and a hugging one `auto` are ours, their strings aren't in the build's text), `row-gap`, `column-gap`, `grid-auto-flow: row` for automatic positioning, the padding; an item `grid-row` / `grid-column` (`span n` when the grid places its items, else `<i+1> / span n`) and `justify-self` / `align-self` (start / end / center) unless it fills.
- **Variable pills**: a bound variable in the code (CSS's `--name` inside `var()`, a code syntax's too; `Constants.<id>`, `Variables.<id>`) drawn as a pill; copies are the plain text (`code.ts variableParts`).

**Still not done:** 3D transforms (`transform3d`, gated, not in our document); Display P3 colours and their fallbacks (hint 18); hints 0, 1, 22; suggested variables (needs `inferredVariables`); CSSBUILDER; "Set as default" and codegen plugins' select preferences; the per-run style comment; the `Copy as code` upsell row; the rows marked "check".

**New open questions:** (9) the hints' English; (10) whether a child of a frame without auto layout gets `position: absolute` and offsets (`shouldUseAbsolutePosition`); (11) offsets for CENTER / STRETCH / SCALE constraints; (12) CROP's background position; (13) SwiftUI's exact lines for space around / evenly and its angular gradient angle; (14) Compose's `contentScale` for a vector; (15) the "CSS (all layers)" format.


**Chrome as Figma's (2026-10-19)** — the owner's "Dev Mode doesn't look like Figma's at all" (2026-10-18; `docs/research/figma/live/owner-2026-10-18/figma-devmode-inspect.webp`, `live/2026-10-18/devmode-inspect-right.txt`). Side by side after: `docs/research/figma/live/owner-2026-10-18/after/devmode-compare.png`. Branch `worktree-agent-ab028863a882da4f0`.

- **Left:** the navigation bar in Dev Mode (Main menu, File in Dev Mode's green, a line, Plugins → the right panel's Plugins tab); the editor's file header (name ▾ with Dev Mode's menu, the location "Drafts", Minimize UI); "Pages" with a search (no fold), rows 24 high, 8 apart; "Ready for development" always, with "</> Mark as ready for dev" (the selection's design → the status menu); Layers full-width, the selected row `--ds-color-devmode-selected` and the rows inside it `-secondary`; a frame is "#" with or without auto layout.
- **Canvas (engine, `engine_set_viewer_mode` flag 4, `Editor::devInspectOverlay`, `Overlay::DevInspect`):** the selection's design in a rounded box round it and its name (a 4 % wash, 8 % edge, 7.5 / 28 / 6 out), its outline 2 px; a selected auto-layout frame's paddings hatched blue and gaps pink (denser than Design's hover hatch: 10 % wash, 40 % stripes 1.5 px every 4.5), its flow layers dotted, a line through the vertical paddings and the gaps, a blue pill with each value; the size badge "W Fixed 678px / H Fixed 549px" in three columns (Fixed / Hug / Fill as the badge's own rule) 9 below the box. The rulers' band and edge labels in Dev Mode's green (`--ds-color-devmode-ruler-band`, `--ds-color-devmode-text`).
- **Right (320 wide, `--ds-size-dev-panel`, its own width `devRightWidth`):** the account, Present, Share in `bg-success`; Inspect | Plugins (⌥8 / ⌥9, `devTab`) with the zoom menu; the selection header (name; Copy link, `</>` → the status menu on a design, ⋯ → "Edited …", Copy layer name, Compare changes, Add a dev resource link; the type row "# Frame" with the status chip); **MCP** (Selection details, Session activity "Not sent", Estimated tokens = our MCP server's `get_design_context` answer ÷ 4 characters, the prompt "Implement this design from Wecra. @designer://open?…node-id=…&m=dev", Copy example prompt; "?" / "+" → Agent settings); **Code Connect** with "Not started" and its hint on any unmapped layer ("Learn more" → Figma's help); **Layer properties** (folds): the box model (Border box with the stroke on each side and the radius at each corner, Padding box — blue when padded —, the dashed size, ticks to the parent with value pills, "border-box"), List | Code and the language select, each code section a title bar with Copy and its lines numbered in a ring, CSS values in `--ds-color-code-value`; then Colors, Typography, Effects, Assets, Export. The old Width / Height / Left / Top grid is gone (the box model and List carry it).
- **Toolbar:** Move, Measurement, Annotation, Comment, a slot each, no Actions, the active one green, Dev Mode's `</>` green in the mode switch; the frame stepper "‹ 1 / 1 ›" above it (the page's designs, prev / next selects and zooms).

**Still differs:** Figma's eyedropper slot (it copies a colour in Dev Mode; ours fills — not offered); ← / → frame stepping keys; the box model's padding shows our values where the capture shows "-" (Figma's reason unknown); "Session activity" is always "Not sent" (our server doesn't report reads per layer); Figma's CSS for the capture's frame starts `display: inline-flex` without `width` (the generators are kept as they were); the rail's Plugins glyph is our puzzle piece, not Figma's.

**Padding and gap inspection as Figma's (2026-10-19)** — the owner's `docs/research/figma/live/owner-2026-10-19/figma-devmode-gap-hatch.webp` and `figma-devmode-padding-hatch.webp` (2000 × 1299 at 1.32×). Wecra shot in the same two states at the same scale and theme by `src/renderer/src/editor/tools/devinspect-shot.mjs` (a 2-column grid of cards with 24 gaps in a vertical auto layout; a card's "Text" auto layout padded 12 / 12 / 12 / 16); side by side: `owner-2026-10-19/after/devmode-gap-hatch.png`, `devmode-padding-hatch.png`. Measured by luma (the webp's chroma is subsampled, so thin stripes' colour reads shifted): the stripes are 6.55 device px apart along a row at 129 % and 178 % alike (screen-space, 4.96 CSS px at 1.32×), ~1.5 px across; Wecra's profile now matches within 2 luma levels (padding min / max 186 / 251 vs Figma 184 / 251; gap 198 / 251 vs 197 / 251).
- **Hatch:** paddings "/" in the selection blue — **blue even for a layer in a component** (the capture's purple selection has blue hatch and blue pills) —, a 3 % wash, stripes at 47 %; gaps "\" (the other way: both captures, and the 10-18 one, show it) in the spacing pink, 3 % / 37 % (was 10 % / 40 % "/" for both). The stripes' phase is the inspected frame's origin, so a gap's pieces and the paddings join (`Renderer::hatchQuad` `back` / `phase`).
- **Which frame:** the hovered layer (a Layers row or the canvas) when it is an auto layout, else the selection — the gap capture has Frame 4507 selected and its grid "Container" hovered in Layers, and shows the grid's 24 gaps (`Editor::devInspectSpacing`).
- **Grid and wrap gaps** (were skipped): a grid's row gaps run its whole width, its column gaps its whole height (drawn in a piece per row so the bands never overlap); a column gap's pill and line on each row's middle, a row gap's at the first column's middle (the capture: the row-gap pill over the left column only, the column-gap pill level with the second row's middle). A wrap: the gaps between a line's layers across that line, the gaps between lines across the content box, their pill at the first layer's middle (by analogy with the grid — no wrap capture).
- **Nested selection:** a layer inside the design gets its **name tag** above its top-left corner in its chrome colour (purple in a component / instance): 15 high, 6 above the layer, radius 2, 4 in, Figma's auto-layout glyph (two bars along the flow; a grid's four squares) and its name in white — matched to the capture's tag box within a device pixel; its outline 2 px like the design's. The dotted content boxes stay in the chrome colour (purple), the pills and lines blue.
- **Badge:** in the selection's chrome colour (purple there), the value column right-aligned ("H Hug … 70px" under "W 100% 410.66669px"); a layer stretched across its parent's flow reads **"100%"** (along the flow, "Fill" as before); values to 5 decimals with zeros trimmed (Figma prints a .fig's float32 410.666687 as "410.66669").
- **Checks:** native `devmode` "a grid's and a wrap's gaps, a hovered auto layout, a nested layer's tag and badge (owner 2026-10-19)"; `engine.wasm` rebuilt.
- **Still differs / unverified:** whether Figma keeps the selection's own spacing while another auto layout is hovered (we show the hovered one's only); the wrap rule (no capture); "Fill" vs a percentage along the flow (unread); where a grid's pills go when the first row / column is off screen (Figma may keep them in view — the capture can't tell); the Layers row's glyph for an auto-layout frame (Dev Mode's panel shows "#" for every frame by the 10-18 round; Figma's capture shows the auto-layout glyph there).

---

## 18. Open questions

1. **rem default root (16?)** — the scale factor the C++ preference store seeds when a user first picks rem. Probe: switch CSS to rem in a fresh profile and read `appModel.devHandoffPreferences.codeExtensionPreferences.WEB` in devtools.
2. **Measure colours (hex)** — `--color-bg-fs-measure`, `--color-text-fs-measure`, and the auto-layout padding / spacing overlays. Probe: `getComputedStyle(document.documentElement).getPropertyValue('--color-bg-fs-measure')` in light and dark themes.
3. **Hover-measurement labels** — whether they follow the unit setting (rem / pt / dp) and their rounding. Probe: set rem with scale 16 and hover-measure a 24 px gap.
4. **UIKit and XML statement order** — only the templates are known. Probe: generate both for a frame with a fill, a stroke, a radius, a shadow and a text child, and record the output.
5. **Angular / diamond CSS** — module 1740 (`conic-gradient` form?). Probe: a CSS snippet of an angular gradient rotated 30°.
6. **`overflow: hidden` on clipping frames** — is it really never printed? (§5.3 grouping says so.) Probe: a clipping auto-layout frame in Dev Mode.
7. **Asset auto-detection heuristic** (C++ `DevHandoffAssetManager`): what makes an ICON or ILLUSTRATION. Probe: compare frames of vectors at 16 / 24 / 48 / 200 px with and without "Automatically detect icons".
8. **Annotation colour hex values** (`--color-bgannotation*`). Probe: read the computed CSS variables.
