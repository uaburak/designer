# 09 — Layout: auto layout, grid, constraints, layout guides

Figma Design desktop 126.9.13, read 2026-10-16 from the cached editor build (`~/.cache/figma-rea/figma/`, outside the
repo) under `~/.cache/figma-rea/BRIEF.md`. Figma's code is not copied here. This file records behaviour, numbers,
enums and strings, each with its evidence.

## 1. Scope and sources

**Scope.** This chapter covers:

- Auto layout: flows, wrap, gaps, padding, alignment, sizing, min / max, absolute children, stacking order, strokes,
  baseline, and the layout version ("Legacy" / "Updated").
- Grid auto layout.
- Constraints.
- Layout guides (layout grids).
- Add auto layout (⇧A), Suggest auto layout (⌃⇧A), Remove auto layout, Resize to fit and Clip content.
- The panel UI, its menus, shortcuts and toasts.

Slides' and Buzz's *canvas grid* (`FGCanvasGrid*`, `CanvasGridRow`) is out of scope. It appears only where it shares
code.

**Sources read**

| Source | What it gave |
|---|---|
| `5581.min.js` (245 KB) | The UI3 auto-layout section: the alignment 9-grid (`alignment_view_v4_ui3`) @141225, the gap and counter-gap fields @127952, the grid picker @156393 / @160816, the **Auto layout settings** popover (`stack_layout_details_modal`) @185532–@191659, and the grid span fields. |
| `figma_app.min.js` (8.2 MB) | The layout-version hooks (`apr26LayoutShiftsForNode`) @3916366, the Object menu's layout block @1340681, the number formatters (Auto parsing) @1687393, the constraint selector @4017216 and the constraint labels, the min / max state and the child margins. |
| `2622.min.js` @635675 | The padding atoms (field ↔ side mapping), gap / counter-gap null rules, and the same layout-shift helpers. |
| `3653.min.js` @792159 | The layout guides panel ("GridsPanel"): defaults, add / remove. |
| `4989.min.js` @103595 | The layout guide settings popover: the Count "Auto" formatter and field minimums. |
| `fullscreen__fullscreen-wasm__compiled_wasm.wasm` | The shortcut table (JSON in the binary) @47263070 for `stack-selection`. The `strings -n 6` dump gave class and file names, enums, error strings and visual-bell keys (cited below as `wasm str #N`, the line in that dump). |
| Repo, live dumps | `docs/research/figma/live/design/autolayout-*.txt`, `popovers/autolayout-advanced-settings.txt`, `popovers/{gap,width-sizing,height-sizing,layout-guide-*}-menu.txt`, `grid/*.txt`, `behaviour/{autolayout-drag,spacing-handles}.md`. These are live Figma captures of the same version line; this chapter reuses them for English strings and pixel positions. |
| Repo, prior research | `docs/research/figma/R9-grid-auto-layout.md` (grid), `docs/research/rea/canvas.md` §2.1 (Plugin API setter rules) and §2.3 (layout invariant enforcers). They are summarised here, not repeated. |
| help.figma.com | Article 42031586813719 (the April 2026 layout version) and article 360040451373 ("Guide to auto layout": keyboard). Fetched 2026-10-16 because the build ships no English dictionary (only i18n keys). |

No English locale file is in the build: the i18n keys are present, the English text is fetched at run time. English
labels below come from the live captures or from help.figma.com. Labels known only by their key are written as the key.

## 2. Data model (the document fields)

All of these are CONFIRMED by the property names used in `5581` / `2622` / `figma_app` and the wasm field strings.
Kiwi numbers are in `schema/document.kiwi`.

| Field (node) | Values | Meaning / UI |
|---|---|---|
| `stackMode` | `NONE`, `HORIZONTAL`, `VERTICAL`, `GRID` | Flow: Freeform / Horizontal / Vertical / Grid (live: inputs `=NONE [Freeform]` … `=GRID [Grid]`). |
| `stackWrap` | `NO_WRAP`, `WRAP` | The "Wrap" toggle. It applies to H / V only (`"WRAP"===o.stackWrap`). |
| `stackSpacing` | float, may be negative | Gap. The panel shows null (Auto) when `stackPrimaryAlignItems` ∈ {SPACE_EVENLY, SPACE_BETWEEN, SPACE_EVENLY_CSS, SPACE_AROUND} (`2622 @635675`, function `S`). |
| `stackCounterSpacing` | float ≥ 0 | Gap between wrapped lines. Null (Auto) when `stackCounterAlignContent` = SPACE_BETWEEN. |
| `stackCounterAlignContent` | `AUTO`, `SPACE_BETWEEN` | Typing "Auto" in the counter gap field sets SPACE_BETWEEN; a number sets AUTO (`5581 @127952`). |
| `stackCounterSpacingSynced` | bool | When it is on and you switch the counter gap from Auto to a value, the counter spacing is seeded from the primary gap (`et&&Z(Y…)`). INFERRED: the counter gap follows the primary gap until it is edited. |
| `stackPrimaryAlignItems` | `MIN`, `CENTER`, `MAX`, `SPACE_EVENLY`, `SPACE_BETWEEN`, `SPACE_EVENLY_CSS`, `SPACE_AROUND` | Justify. The UI's "Between" writes the value the version-aware helper picks (`S5(e, …)`). canvas.md §2.1 found that Plugin API SPACE_BETWEEN is stored as kiwi SPACE_EVENLY. |
| `stackCounterAlignItems` | `MIN`, `CENTER`, `MAX`, `BASELINE` | Counter alignment. BASELINE applies to HORIZONTAL only. |
| `stackChildAlignSelf` | `AUTO`, `STRETCH` (+ the align values) | A child's counter "Fill" is STRETCH. |
| `stackChildPrimaryGrow` | 0 / 1 | A child's primary "Fill". |
| `stackPrimarySizing` / `stackCounterSizing` | `FIXED`, `RESIZE_TO_FIT`, `RESIZE_TO_FIT_WITH_IMPLICIT_SIZE` | Hug = RESIZE_TO_FIT(_WITH_IMPLICIT_SIZE). wasm: `StackLayoutSize::{FIXED, HUG_CONTENT, FILL_CONTAINER}` (#31626, #32034, #33023) is the derived per-axis size kind. |
| `stackHorizontalPadding` / `stackVerticalPadding` / `stackPaddingRight` / `stackPaddingBottom` | float ≥ 0 | **Left = stackHorizontalPadding, Top = stackVerticalPadding**, Right / Bottom are their own fields (`2622 @635675`, padding atoms). Kiwi fields 'stackPaddingLeft/Top' are what the plugin layer calls them. |
| `stackChildMarginTop/Right/Bottom/Left` | float | Child margins (keys `all_margins`, `independent_margins`, `margin_*`). INFERRED: Sites / responsive only; there is no Design-mode UI in the live captures. |
| `stackPositioning` | `AUTO`, `ABSOLUTE` | "Ignore auto layout" (formerly "Absolute position"). |
| `stackReverseZIndex` | bool | Canvas stacking: true = "First on top", false = "Last on top" (default). |
| `bordersTakeSpace` | bool | Settings row label "Inside stroke" (Updated version) or "Strokes" (key `borders_take_space`); options **Included / Excluded**. |
| `stackLayoutVersion` | 0 legacy, 1 Updated ("apr26") | Set by the Layout dropdown (`n=+!!t`, `figma_app @3916366`). |
| `minWidth`, `maxWidth`, `minHeight`, `maxHeight` | float or null | The "Add min width…" etc. menu items. |
| `gridRowCount`, `gridColumnCount`, `gridRowGap`, `gridColumnGap`, `gridRowsSizing`, `gridColumnsSizing`, `gridAutoTracks` (`NONE` / `ROWS`), `gridReflowEnabled`, `gridRowSpan`, `gridColumnSpan`, `gridRowAnchorIndex`, `gridColumnAnchorIndex`, `gridChildHorizontalAlign`, `gridChildVerticalAlign` (`MIN` / `CENTER` / `MAX` / `AUTO`) | — | Grid (see §6). |
| `horizontalConstraint` / `verticalConstraint` | `MIN`, `CENTER`, `MAX`, `STRETCH`, `SCALE` | Constraints (§7). |
| `layoutGrids[]` `{pattern GRID/STRIPES, axis X/Y, type MIN/CENTER/STRETCH/MAX, numSections, offset, sectionSize, gutterSize, color, visible}` | — | Layout guides (§8). |
| `frameMaskDisabled` | bool | "Clip content" is checked when this is false. |

## 3. Auto layout — the algorithm

### 3.1 Passes and invariants (wasm class / string evidence)

- **Engine files:** `FGStacking.cpp` (stack layout), `FGStackFacet.cpp` (node-side state), `FGGridLayout.cpp`,
  `FGGridContentSizing.cpp`, `FGGridResizing.cpp`, `FGGridReflowUtils.cpp`, `FGGridCache.cpp` (`grid-sizing-cache`,
  `grid-reflow-cache`), `FGConstraints.cpp` and `FGStackingInvariantEnforcer.cpp` (wasm str #19814–20265). CONFIRMED.
- **Pass structure.** INFERRED from names:
  - `StackContentSizing` carries `rows` (wrap lines). Its errors: "Expected StackContentSizing to have at least one
    row." and "Expected StackContentSizing.rows[rowAtCounterOffsetIndex] to exist" (#34497, #13530).
  - Sizing is a content-measure pass (hug), then a placement pass per row.
  - `expected basis size for autolayout frame` (#26233) shows a flex-basis step before Fill distribution.
- **When layout runs.** These ordered invariant passes trigger it: `enforce-stack-layout-invariants` (with a LOG_ONLY
  mode), `enforce-groups-and-stacks-layout` / `-remote` / `-fixed`, `layout-invalidator`, `layout-dirty-text(-remote)`
  and `grid-reflow-invariant-effect`. canvas.md §2.3 covers them.
  - After undo / redo, fields are marked dirty again: "Marking field dirty for stack invariant enforcement while
    undoing/redoing" (#23981–23983).
- **Loop guards** (CONFIRMED strings):
  - "Skipping auto layout to avoid likely multiplayer oscillation" (#21443);
  - the analytics key `cutoff_constraint_enforcer_oscillations` (#16316);
  - "Already mid-iteration: recursive triggers to updaters are not supported".
- **Dirty sets:** `dirty_nodes_inside_auto_layout`, `autolayout_nodes_dirty_after_layout` and
  `dirty_nodes_auto_layout_enabled` (#13416–13418, #29920).
- **Exact numeric rounding of positions and sizes:** not settled statically (see Open questions). Hints:
  - the panel formats numbers with `toFixed(2)` and drops trailing zeros (`figma_app @1687393`, class `h`);
  - the layout grid shader carries both `Rounded` and `Unrounded` section sizes (`layoutGridCutoffStrideRoundedUnrounded`,
    #11249). Layout guides therefore snap to whole pixels when drawn, while their unrounded size is kept.
  - Auto-layout positions are fractional in files; INFERRED from the B2C measurements in round 5.

### 3.2 The two layout versions (CONFIRMED, help.figma.com 42031586813719 + `figma_app @3916366`)

`stackLayoutVersion` 1 ("apr26", label **Updated**) changes six things. When a frame is upgraded or downgraded, Figma
counts which of the six would move something and lists them. The six keys:

- `containerMinSizeGrowth`
- `containerCenterBorderShift`
- `fillChildrenResize`
- `outsideBorderChildrenShift`
- `spaceBetweenSingleChildShift`
- `spaceBetweenNegativeGapClamp`

The count comes from `apr26LayoutShiftsForNode` / `apr26LayoutShiftsForDowngradeNode`, and the analytics event is
`text_and_layout.stack_layout_version_upgraded {scope, targetVersion, count, alignmentMigratedStacks}`.

| # | Updated (v1) rule | Legacy (v0) | Key |
|---|---|---|---|
| 1 | Padding always applies: the frame can't be narrower or shorter than its total padding (plus the inside stroke when strokes are included). **max width is ignored** for that. Example: padding 30 per side in a 50-wide frame renders 60 wide. | The frame can be smaller than its padding. | `container_min_size_growth` |
| 2 | Only **inside** strokes take space ("Included" by default, like CSS borders). Outside and center strokes still paint but never enter layout math. | Center strokes counted by half, outside strokes fully, when "included". | `container_center_border_shift`, `outside_border_children_shift` |
| 3 | The stroke setting affects only its own frame, not how child strokes are measured. | It cascaded to children. | (part of 2) |
| 4 | Fill children share space by **content box** (border-box model): a child with a thicker stroke or padding gets slightly more, so the inner content matches. Use grid `fr` for an exact equal split. | Divided by total size. | `fill_children_resize` |
| 5 | Auto gap ("Between") never drops below 0. Children that don't fit collapse to the start instead of overlapping. A typed negative gap still overlaps. | The gap could go negative (overlap). | `space_between_negative_gap_clamp` |
| 6 | A **single child** with "Between" goes to the **start** (left / top). With Around or Evenly it stays centred. | A single child was centred. | `space_between_single_child_shift` |

**Rollout** (help article):

- New frames default to Updated from July 2026.
- In January 2027 the legacy option becomes an "Update" button (`new_stack_layout.upgrade`) and new frames can't be set
  to legacy.
- The version can't be overridden on instances; components must be upgraded and republished (action
  `republish-auto-layout-components`, "Republish Auto Layout components", wasm #15542).
- Bulk actions in the Actions menu: "Update layout version for selection" / "Update layout version for page"
  (`upgrade-stack-layout-version`, `upgrade-stack-layout-version-for-page`).

**Panel.**

- The Layout row exists only behind the feature gate `tl_flexbox_downgrade_toggle`. It is a dropdown with **Updated /
  Legacy** (`new_stack_layout.new` / `.legacy`). A warning icon opens a popover
  (`legacy_stack_layout_in_selection.warning_with_learn_more`) when the selection holds legacy stacks.
- Without the gate the row is a plain "Update" button with a description (`legacy_stack_layout_in_selection.description`).
- The live capture shows "Layout: Updated" with a "More info" button.
- The editability check skips instance sublayers in slots and immutable frames (`2622`, function `o`). CONFIRMED.

### 3.3 Primary axis

- **Gap field.**
  - No minimum: negative gaps are allowed (the formatter `lW({big, small, relativeUnitsEnabled})` gets no `min`).
  - Typing any prefix of "auto" ("a", "au" …, case-insensitive) gives Auto. `figma_app @1687393`: the input is lowercased
    and checked with `"auto".startsWith(input)`; empty input counts only when `allowEmpty`.
  - Arrow keys nudge by 1, ⇧ by 10. These are the user's nudge preferences; the defaults are
    `smallNudgeAmount ?? 1`, `bigNudgeAmount ?? 10`.
  - Math expressions are accepted, and Arabic-Indic digits are normalised.
  - With relative units on (feature `FW()`), the gap also takes `%` (UNIT_NUMBER: PIXELS / PERCENT / AUTO). CONFIRMED.
- **Auto spacing mode.** It is set in the settings popover and only active when the gap is Auto (tooltip key
  `only_applicable_when_gap_is_auto`). Options, in order:
  - **Between** → `SPACE_BETWEEN`, which the helper maps to the version-appropriate stored value;
  - **Evenly** → `SPACE_EVENLY_CSS`;
  - **Around** → `SPACE_AROUND`.

  Live captures show "Auto spacing: Between". It is applied through `setDistributeOnSelectedStacks` and logged as
  "Autolayout spacing mode changed". CONFIRMED (`5581 @185532`).
- **Toggling Auto from the alignment box** (double-click or X). When turned on, the gap mode becomes the chosen
  distribute mode. When turned off, the primary alignment goes back to the remembered packed value, **default CENTER**
  (`L(e,"CENTER",…)` with a ref cache). CONFIRMED (`figma_app`, hook `R`).
- **Binding a variable** to the gap while it is Between switches it to PACKED first (`K.s$(PACKED, …)`). CONFIRMED.

### 3.4 Counter axis and wrap

- The counter gap (between lines) has **min 0** and `allowEmpty`. "Auto" sets `stackCounterAlignContent = SPACE_BETWEEN`.
  Binding a variable while it is SPACE_BETWEEN resets it to AUTO. CONFIRMED (`5581 @127952`).
- The two gap fields are labelled "Horizontal gap between objects" / "Vertical gap between objects" (live). The keys are
  `gap_columns_horizontal` / `gap_rows_vertical` and the tooltip `section_autoLayout.tooltip_mixedGap`.
- Wrap moves a child to a new row when it no longer fits (rows = `StackContentSizing.rows`). With wrap, the alignment
  icons draw **5 bars** instead of 3 (`l&&!e?5:3`). CONFIRMED UI.
- The overlay command `UIRenderWrappingIndicatorCommand` (#28560) draws a wrap indicator on the canvas. INFERRED from
  its name.
- A wrap drag-reorder failure is logged as "Could not find a valid candidate position for wrap stack reorder."

### 3.5 Alignment 9-grid (CONFIRMED, `5581 @141225`)

- **Cell values:** TOP_LEFT, TOP_CENTER, TOP_RIGHT, LEFT, CENTER, RIGHT, BOTTOM_LEFT, BOTTOM_CENTER, BOTTOM_RIGHT.
- **Cell → (primary, counter)** depends on the flow. Function `ej` gives primary, `eC` gives counter:

| Cell | Horizontal (primary = x) | Vertical (primary = y) |
|---|---|---|
| TOP_LEFT | MIN, MIN | MIN, MIN |
| TOP_CENTER | CENTER, MIN | MIN, CENTER |
| TOP_RIGHT | MAX, MIN | MIN, MAX |
| LEFT | MIN, CENTER | CENTER, MIN |
| CENTER | CENTER, CENTER | CENTER, CENTER |
| RIGHT | MAX, CENTER | CENTER, MAX |
| BOTTOM_LEFT | MIN, MAX | MAX, MIN |
| BOTTOM_CENTER | CENTER, MAX | MAX, CENTER |
| BOTTOM_RIGHT | MAX, MAX | MAX, MAX |

- **With Auto gap** ("distributed") the box collapses to 3 cells: SPACE_BETWEEN_MIN / _CENTER / _MAX. Tooltips: Align
  top / center / bottom (H) or Align left / center / right (V). The pointer column (H) or row (V) is picked as
  `floor(dx / width × 3)`.
- **With BASELINE** there are 3 cells (MIN_BASELINE, CENTER_BASELINE, MAX_BASELINE). Tooltips: "Align left baseline",
  "Align center baseline", "Align right baseline". With Auto gap too there is 1 cell, "Align text baseline". The
  indicator shows the letter "A" (three of them when distributed). A centred bar button is "Remove baseline alignment"
  (`remove_baseline_align`).
- Cells show tooltips on hover. The bottom row's tooltips sit *below* the box (`below:!0`). Hovering previews the
  alignment on the canvas.
- Keyboard while the box is focused (help 360040451373):
  - arrows set the alignment;
  - **W / A / S / D** align to an edge;
  - **B** toggles baseline;
  - **X** toggles the Between gap.
- Live geometry: the box is 88 × 56 (UI3), cells 29 × 15–16, dots 2 × 2 `#ffffff66`, indicator bars 2 px wide
  `#7cc4f8`.

### 3.6 Text baseline

- The setting is labelled "Align text baseline" (Disabled / Enabled segmented control) and is disabled unless HORIZONTAL.
  Its tooltip key is `only_applicable_for_horizontal_layout`. CONFIRMED (`5581`, `n_`).
- Turning it on sets `stackCounterAlignItems = BASELINE`. Children align their **first baselines** (wasm
  `baselinePosition`, "baseline does not have an endCharacter").
- A non-text child's baseline: INFERRED from CSS. A frame uses its first text descendant's baseline, otherwise its
  bottom edge. Not settled; see Open questions.

### 3.7 Sizing: Hug / Fill / Fixed, min / max

- **Width and height dropdowns** (live):
  - "Fixed width (232)" / "Hug contents" / "Fill container" (children only);
  - a separator;
  - "Add min width…" / "Add max width…" (height alike).
  - Once set: `minmax.*_value`, "Remove min width" etc., "Remove min and max" (`remove_min_and_max`), and
    `apply_current_width` / `apply_current_height`. INFERRED: these set the min / max to the current size.
- **Field text.** The value shows as "Hug", "Fill" or a number. The field reads "Hug (232)" while hugging. Fill can show
  a fraction or percent: `al.fill_with_value`, `al.percent`, `canvas.auto_layout_fill_fractional`.
- **Canvas size badge.** It shows the kind next to the number ("181 Fill × 44", "260 × 449 Hug"). Keys
  `fullscreen.canvas.auto_layout_{fill,hug}{,_with_value_v2}`.
- **Rules** (wasm error strings, CONFIRMED):
  - "HUG can only be set on auto-layout frames or text children of auto-layout frames";
  - "FILL can only be set on children of auto-layout frames";
  - "FILL cannot be set on absolute positioned auto-layout children";
  - "FILL cannot be set on canvas grid children";
  - "FILL cannot be set on this node".
- **Disabled sizing tooltips:** `sizing_disabled.no_fill_component`, `sizing_disabled.select_all_fill`.
- **Canvas shortcuts** (help): **double-click an edge handle = Hug** on that axis; **⌥ double-click = Fill
  container**.
- **Object menu actions** (search-only in Actions): "Set hug width" / "Set hug height" / "Set fill width" / "Set fill
  height" (`set-selection-{hug,fill}-{horizontal,vertical}`). Toasts:
  - `visual_bell.width_set_to_hug` / `height_set_to_hug`;
  - `width_set_to_fixed` / `height_set_to_fixed` / `width_height_set_to_fixed`;
  - `unset_hug_horizontal` / `_vertical` / `_both_dimensions`.
- **Min / max toasts:** `updated_{min,max}_{width,height}`, `{min,max}_{width,height}_removed`,
  `min_max_width_removed`, `min_max_width_height_removed` and the others in that family.
- **Fill distribution** is flex-like: grow 0 / 1 only (canvas.md §2.1), and a CSS-style freeze at min / max (INFERRED,
  matching what we measured). Updated v1 divides by the content box (§3.2 row 4).
- **Lock aspect ratio** (`targetAspectRatio`) sits next to W / H in the same row.

### 3.8 Padding

- **Two fields:** "Horizontal padding" (left + right) and "Vertical padding" (top + bottom). "Individual padding" splits
  them into four: Left, Top, Right, Bottom (keys `left_padding`, …). Keys `all_paddings` / `independent_paddings`.
  CONFIRMED live.
- Padding fields take a **comma list**: an array formatter splits on "," and spaces, and the expressions go element-wise
  (`figma_app @1687393`, class `y`). For example "8, 16" sets both sides of a pair. INFERRED: the pair order is
  [left, right] / [top, bottom], from the atoms in `2622`.
- **⌘ / Ctrl-click a padding field** edits all sides (help).
- **On the canvas** (live behaviour `spacing-handles.md`):
  - padding and gap handle bars, with hatching on hover;
  - dragging follows the pointer 1:1;
  - ⌥ sets the opposite side too, ⌥⇧ all four sides, ⇧ uses big-nudge steps;
  - ⌥-click / ⌥⇧-click a padding area types the opposite / all sides;
  - the cursors are `cursor-resize-padding(-bounded)(-ui3).svg` (wasm #23442–23519).

### 3.9 Absolute children, stacking order, strokes, clip

- **Ignore auto layout** (`stackPositioning = ABSOLUTE`) is a toggle in the child's Position section (live "Ignore auto
  layout"). The child keeps constraints and loses resizing options.
- Drag into a frame holding **Ctrl (mac) / S (win)** to drop it absolute. Toasts:
  `visual_bell.drag_and_drop_absolute_stack_insertion(_windows)` and `paste_absolute_position`.
- `restore-autolayout-position` (Actions) puts an absolute child back into the flow. INFERRED from its name.
- **Canvas stacking:** "Last on top" (default) / "First on top" (`stackReverseZIndex`). Logged as "Enable / Disable
  reverse zIndex". CONFIRMED (`5581 @187101`).
- **Strokes:** see §3.2. The popover row is "Inside stroke: Included / Excluded" under Updated (live), and the key
  `borders_take_space` under Legacy. Error: "Autolayout/borders-take-space: could not calculate finite network
  geometry for node" (#27401, vector strokes).
- **Clip content** is a checkbox under Padding (live, checked by default on a new frame).

### 3.10 Auto layout settings popover (CONFIRMED order, `5581` `nd` + live `autolayout-advanced-settings.txt`)

- The popover is 240 × 345 with radius 13. The title is "Auto layout settings" and a 120-tall **Preview** pane shows the
  hovered option.
- Hovering or focusing an option previews it (`updatePreview({setting, enabled})`). The setting names are
  `bordersTakeSpace(Apr26)`, `reverseStackingOrder`, `alignToBaseline`, `justifyContent` and `stackLayoutApr26`.
- Rows (label column 16 px, 112-wide dropdowns at x 112, rows 32 apart):
  1. Inside stroke / Strokes — Included | Excluded (every flow, grid too).
  2. Canvas stacking — Last on top | First on top (H / V only).
  3. Align text baseline — Disabled | Enabled (H / V; disabled unless Horizontal).
  4. Auto spacing — Between | Evenly | Around (H / V; disabled unless the gap is Auto).
  5. Layout — Updated | Legacy, with "More info" (gated) or the Update button.
- A mixed selection shows a disabled "Mixed" first option and a separator in each dropdown.

## 4. Add auto layout (⇧A), Suggest (⌃⇧A), Remove (⌥⇧A)

| Action id | Keys (mac / win) | Evidence |
|---|---|---|
| `stack-selection` "Add auto layout" | ⇧A / Shift+A (edit modes GLOBAL, !TEXT) | wasm @47263070 |
| `unstack-selection` "Remove auto layout" | ⌥⇧A / Shift+Alt+A | same table |
| `run-multi-stack-auto-layout` "Suggest auto layout" | ⌃⇧A / Ctrl+Shift+Alt+A | same table; help confirms the Windows Alt |
| `destroy-all-auto-layout` | no key (Object › auto layout submenu) | `figma_app @1340681` |
| `resize-to-fit` "Resize to fit" | ⇧⌥⌘R / Ctrl+Shift+Alt+R | shortcut table |
| `frame-selection` "Frame selection" | ⌥⌘G / Ctrl+Alt+G | table |
| `toggle-shown-layout-grids` "Layout guides" | ⇧G, ⌃G (mac), ⌃⇧4 | table (three bindings) |

- **Object menu block** (`figma_app @1340681`):
  - a submenu "multi-stack-selection-submenu" holding Suggest auto layout and `destroy-all-auto-layout` (key
    `fullscreen_actions.destroy-all-auto-layout`);
  - a separator, then Resize to fit;
  - a separator, then Set hug width / height and Set fill width / height;
  - a separator, then Lock / Unlock aspect ratio.
- **Destroy-all toasts:** `destroy-all-auto-layout-result-visual-bell-toast(-zero)`.
- **Suggest result:** `stack_panel.msal_crated_frames_count` (sic, "crated"), "N frames created". INFERRED.
- **Partial result:** `visual_bell.auto_layout_added_partial` appears when only part of the selection could get auto
  layout. CONFIRMED key.
- **Inference.** It is C++ (`InferredAutoLayoutManager`, `inferredAutoLayoutResult`, `InferredAutoLayoutResultProperties`,
  wasm #19421, #14581, #17145); the heuristics are not readable as strings.
  - The result shape (the Plugin API `inferredAutoLayout`, `3187`) has the full field set: layoutMode, the sizing
    modes, the alignments, the four paddings, itemSpacing, strokesIncludedInLayout, layoutWrap, counterAxisAlignContent
    and counterAxisSpacing. A group's inferred result is `fromGroupNode`.
  - **The inference can produce wrap and counter spacing** (INFERRED from the shape). The help says Figma "will try to
    determine" the flow: vertical, horizontal **or grid**.
- Dev Mode reads `inferredAutoLayoutResult.stackMode` for non-auto-layout frames (`3187`), so code export treats a plain
  frame as a flex box when it can be inferred. CONFIRMED.
- **Toggle in the panel.** The section header's "+" is "Use auto layout" (`use_auto_layout`). When the frame has auto
  layout it is a checked toggle, "Remove auto layout" (live: `=checked [Remove auto layout]`, tooltip "Toggle auto
  layout").
- `canChangeLayoutCategoryToStack` / `ToGrid` (#22929, #28859) decide whether a flow button is enabled. Freeform is
  disabled for repeaters (`freeform_disabled_for_repeater`), and grid is refused on slots ("Unexpectedly encountered a
  slot node with grid layout", `grid.disabled_for_slots`).

## 5. Auto-layout panel UI (Design panel, UI3; live geometry from `autolayout-horizontal.txt`)

Section title "Auto layout" (or "Layout" for a plain frame), at y 260.

| Row | Controls (x, w) | Notes |
|---|---|---|
| Flow | segmented 184 × 24: Freeform / Vertical / Horizontal / Grid (46 each); Wrap toggle at 208 | Wrap is hidden for Grid and Freeform |
| Resizing | W 88 × 24 at 16 ("Hug contents"), H at 112; Lock aspect ratio at 208 | labels "W" / "H" |
| Alignment + Gap | 9-grid 88 × 56 at 16; Gap 88 × 24 at 112 (icon = flow direction); "Auto layout settings" button at 208 | a counter-gap field appears under the gap when wrapping |
| Padding | Horizontal padding 88 × 24 at 16, Vertical at 112; "Individual padding" at 208 | four fields when split |
| Clip content | checkbox 16 × 16 at 16 | |

The labels are 9 px / 500 at `#ffffffb2`, the values 11 px / 450 `#ffffff`, the fields `#383838` with r 5.

Grid flow replaces Alignment / Gap / Padding with:

- **Grid** — a picker button "C × R" with "Toggle automatic positioning";
- **Gap** — two fields, "Gap between columns" (top) and "Gap between rows" (bottom), each **min 0**, px / %;
- Padding, Clip content.

A child of a grid gets "Column span" / "Row span" fields: min 1, max = count − anchor index (`5581` `nf`).

## 6. Grid auto layout

Reused from R9; new numbers below.

- **Counts.** "Number of columns" and "Number of rows" each go **1 … 100** (`tf.e({min:1,max:100})`). Rows also take
  **Auto** (`gridAutoTracks = ROWS`, `set-grid-auto-rows-enabled`). CONFIRMED (`5581 @156393`).
- **Picker.**
  - The visual picker is **12 columns × 8 rows** (`--cols:12, --rows:8`). Labels read "C × R" ("1 × 1" … "12 × 8").
  - Hover previews, click commits.
  - **Esc reverts** to the counts held when the picker opened (`grid-panel-revert-on-escape`); Enter closes.
  - The "Open grid settings" button selects column track 0 and enters the track menu (`setGridTrackSelection([{index:0,
    axis:X}])`). CONFIRMED (`5581 @160816`).
- **Automatic positioning.** "Toggle automatic positioning" = `gridReflowEnabled` (`set-grid-reflow-enabled`). A
  mixed selection shows Mixed.
- **Tracks.**
  - Sizing is `GridTrackSize {type FLEX/FIXED/HUG, value}`.
  - Errors: "Track size value must be non-negative", "invalid denominator for grid flex sizing", "Missing track size
    for grid track during sizing computation".
  - The live row-track menu has: "Fill container (1fr)", "Fixed height (84)", "Hug contents".
  - Toasts: `visual_bell.set_grid_{row,column}_to_{fill,fixed}`.
  - The track panel (live) has "Columns" / "Rows" lists, items "Grid column 1 of 3, not selected", buttons "Add
    column" / "Add row" / "Remove column N of M", and the fields "Column width" / "Row height" under "Track sizing".
  - Delete keys: `delete_n_columns` / `delete_n_rows`. Errors: "Tried to delete grid tracks on multiple axes at once",
    "Attempted to delete invalid grid track".
- **Spans.** Errors: "Row span must be at least 1", "Row span exceeds grid row count" (column alike), "Child spans
  outside of grid", "No available space found for child in grid", "Cannot place child at this position because it is
  out of bounds of the grid". When a span grows, `setSpanAndUpdateChildPositions` pushes the other items.
- **Reflow.**
  - `visual_bell.grid_layout.moved_objects_to_new_row` appears when a change pushed items into a new row.
  - `isOnlyImplicitlySizedChildInHugTrack` covers the Hug-row rule in R9 (a Hug track sized only by stretch children).
- Large grids skip cell outlines and drop targets ("grid cell outlines: large grid", "grid cell drop targets: large
  grid"). The threshold is not visible in the strings.
- canvas.md §2.1: GRID makes both alignments MIN and creates a 2 × 2 grid; HUG on a grid turns FLEX tracks into HUG.

## 7. Constraints

- **Values and labels** (`figma_app`, class `ed`):

| Value | Horizontal label | Vertical label |
|---|---|---|
| MIN | Left | Top |
| MAX | Right | Bottom |
| STRETCH | Left & right (dropdown shortens it: `left_and_right_truncated`) | Top & bottom |
| CENTER | Center | Center |
| SCALE | Scale | Scale |

- **Constraint widget** (`figma_app @4017216`). Clicking an outer side sets that side. **⇧ or ⌘ click** (and every
  click in the compact widget) toggles:
  - current == this side → **SCALE**;
  - current == the opposite side → **STRETCH**;
  - current STRETCH → the opposite side (this side is removed).

  When stretch / scale is disabled for that axis (`disable{Horizontal,Vertical}StretchScaleConstraints`), the plain
  side is set. Clicking the centre line sets CENTER; a second click while already CENTER gives SCALE (fragment
  `"CENTER"===l?"SCALE":"CENTER"`). CONFIRMED (partly from fragments).
- **Panel.** The "Constraints" section has a widget plus "Horizontal constraints" / "Vertical constraints" dropdowns
  (live). Tooltip keys: `constraints.horizontal.tooltip`.
- **On resize** (`FGConstraints.cpp`):
  - Children are re-placed from the parent's *starting* bounds.
  - **⌘ while resizing = ignore constraints** (`fullscreen_actions.ignore_constraints`, `_frames_only`).
  - The wasm keeps "TODO: handle resize horizontal SCALE constraint" / "… move SCALE constraint" (#14122–14124), so one
    path (INFERRED: the multi-edit or immutable-frame helper) does not scale.
  - Toasts: `visual_bell.{horizontal,vertical}_constraint_set_to_center`. INFERRED: shown when a layer centred in a
    frame gets CENTER on insertion.
  - `getNodeInsertionAlignmentFromConstraintType` maps a new node's constraint to its insertion alignment.
- **Constraint defaults** for a new child: MIN / MIN. CONFIRMED (Sketch import writes MIN / MIN, `3187`); the live
  panel shows "Left" / "Top".
- In an auto-layout frame only absolute children show constraints (`someNodesAreConstraintItems`,
  `nodesAreAllNotInStacksOrAbsolutePositioned`).

## 8. Layout guides (layout grids)

- **Defaults** (CONFIRMED, `3653 @792159`, `er`, and `figma_app` `rU`):

| Field | Default |
|---|---|
| pattern | GRID (the "+" adds a Grid) |
| sectionSize (grid size) | **the user's big nudge amount** (default 10) |
| type (alignment) | STRETCH |
| numSections (count) | 5 |
| gutterSize | 20 |
| offset (margin) | 0 |
| colour | r 1 g 0 b 0 **a 0.1** (FF0000 at 10 %) |
| visible | true |

- **Choosing Columns or Rows** keeps the defaults and sets `pattern STRIPES`, `axis X` (Columns) or `Y` (Rows).
- **Count Auto** = `0x7fffffff` (2147483647): the field shows "Auto" and parses "Auto" (`4989 @103595`). The Count
  field min is 0. Counts are capped at `0x7fffffff` (`Math.min(count, F)`).
- **Settings popover** "Layout guide settings" (live `layout-guide-settings-*.txt`):
  - Type (Grid / Columns / Rows), plus Size and Color for Grid;
  - Count, Color, Type (Stretch / Left / Center / Right, or Top / Center / Bottom for Rows), Width (Auto unless not
    Stretch), Margin (Stretch) or Offset (other types), and Gutter.
- **Row summary text:** "Grid 10px"; "5 columns (Stretch)" via `columns_formatter` / `rows_formatter`.
- **Visibility.**
  - Adding a guide turns the editor preference `showFrameGrids` on, so new guides are visible (`onGridsChange`).
  - Toggling uses ⇧G / ⌃G / ⌃⇧4, with toasts `visual_bell.render_grid_visible` / `_hidden`.
  - A frame-only hide button is shown (`show_frame_grids_hide_button`).
- **Styles.** Guide styles exist (style type GRID, "Layout guide styles", "No layout guide styles.", "Browse
  libraries…", "Create style"). Count, gutter, offset and section size can be bound to variables (`numSectionsVar`,
  `gutterSizeVar`, …).
- **Rendering:** the dedicated shader `LAYOUT_GRID_VERTEX` / `_FRAGMENT` with rounded and unrounded section sizes
  (pixel-snapped stripes). Snapping uses `cacheTemporarySnapTargetsForLayoutGrids`.
- **Snap to pixel grid:** `toggle-snapping-to-pixels` (⌘⇧' on US, layout-dependent).

## 9. Resize to fit, frames, misc

- **Resize to fit** (⇧⌥⌘R) fits a frame to its children. It is in the Object menu and in the Layout header actions for
  a plain frame.
- **Frame selection** (⌥⌘G) wraps the selection in a frame.
- **Tidy up** (⌃⌥T) and the distribute spacing commands (⌃⌥H / ⌃⌥V) are covered in chapter 04.
- **Dragging inside auto layout:** see `behaviour/autolayout-drag.md`. In short, a sibling swaps in when the dragged
  layer's leading edge passes the sibling's centre, and siblings slide for 120 ms with ease-out.

## 10. UI strings (English known from live captures or help)

Auto layout · Layout · Toggle auto layout · Remove auto layout · Flow · Freeform · Vertical · Horizontal · Grid · Wrap
· Resizing · W · H · Hug contents · Hug · Hug (232) · Fixed width (232) · Fixed height (72) · Fill container · Add min
width… · Add max width… · Add min height… · Add max height… · Remove min and max · Lock aspect ratio · Alignment · Align
top left · Align top center · Align top right · Align left · Align center · Align right · Align bottom left · Align
bottom center · Align bottom right · Align top · Align bottom · Align text baseline · Gap · Auto · Horizontal gap
between objects · Vertical gap between objects · Auto layout settings · Padding · Horizontal padding · Vertical padding
· Individual padding · Clip content · Preview · Inside stroke · Included · Excluded · Canvas stacking · Last on top ·
First on top · Disabled · Enabled · Auto spacing · Between · Evenly · Around · Only applicable for Auto gap · Updated
· Legacy · More info · Ignore auto layout · Grid dimensions · Open grid settings · Number of columns · Number of rows ·
Toggle automatic positioning · Gap between columns · Gap between rows · Column span · Row span · Columns · Rows · Track
sizing · Column width · Row height · Add column · Add row · Remove column N of M · Grid column N of M, not selected ·
Fill container (1fr) · Constraints · Horizontal constraints · Vertical constraints · Left · Right · Top · Bottom ·
Center · Scale · Left & right · Top & bottom · Layout guide · Add layout guide · Layout guide settings · Layout guide
type · Columns · Rows · Size · Count · Type · Stretch · Width · Margin · Offset · Gutter · Color · Grid 10px · Layout
guide styles · No layout guide styles. · Browse libraries… · Create style · Add auto layout · Remove auto layout ·
Suggest auto layout · Resize to fit · Frame selection · Update layout version for selection · Update layout version for
page.

Known only by key (English not in the build): `stack_panel.apr26_shift.*` (six change descriptions),
`legacy_stack_layout_in_selection.{warning,description,learn_more}`, `new_auto_layout_version_available`,
`tooltip_old_version(_components|_instance|_instance_overrides)`, `msal_crated_frames_count`,
`destroy-all-auto-layout(-result-visual-bell-toast(-zero))`, `auto_layout_added_partial`, the min / max toasts
(§3.7), `grid_layout.moved_objects_to_new_row`, `set_grid_{row,column}_to_{fill,fixed}`,
`{horizontal,vertical}_constraint_set_to_center`, `drag_and_drop_absolute_stack_insertion`, `paste_absolute_position`,
`no_auto_layout_components_found`, `render_grid_{visible,hidden}`.

## 11. DesignerV2 today

| Area | Status | Where |
|---|---|---|
| H / V / wrap / gaps / Auto / Between, Evenly, Around / padding / Hug-Fill-Fixed / min-max / baseline / absolute / reverse z | matches (engine) | `engine/src/layout/Layout.cpp:300-460` |
| Layout version (`stackLayoutVersion` 574) | **differs.** The schema has it, but the engine ignores it and runs a mix. Our Between clamps a negative gap (v1) but **centres a lone child** (v0). A center stroke counts half (`Layout.cpp:81`, v0). There is no padding minimum (`clampSize`, v0), and Fill is not split by content box (v0). The panel shows a fixed "Updated" (`Layout.tsx:675`). | `Layout.cpp`, `panels/design/Layout.tsx` |
| Add auto layout ⇧A | **partial.** A lone frame gets inferred direction (centre spread), mean gap ≥ 0, counter alignment and padding from content. Anything else is wrapped. Grid and wrap are never inferred, and negative spacing is clamped to 0. | `engine/src/editor/Commands.cpp:974-1062` |
| Suggest auto layout ⌃⇧A, Destroy all auto layout | missing (the shortcut is registered as "later") | `editor/commands.ts:580` |
| Grid flow | matches R9 / round 6. Check: counts 1–100, the picker's Esc revert, Open grid settings. | `GridLayout.cpp`, `panels/design/Grid.tsx` |
| Constraint widget | **differs.** ⇧-click gives STRETCH and toggles back, but never **SCALE** (same side ⇧-click, or a second centre click); ⌘-click is not treated as ⇧. | `editor/model/constraints.ts:67-75` |
| Layout guides | rendered and edited; check the defaults (size = big nudge, count 5, gutter 20, red 10 %), Count "Auto" = 2147483647, and the "adding turns guides on" rule | `Renderer.cpp:1432` |
| Alignment box keys W/A/S/D/B/X, double-click toggle with remembered CENTER | to check (not found by grep) | `panels/design/Layout.tsx` |
| Padding comma list ("8, 16"), "a" = Auto prefix parsing | to check | panel number fields |
| Child margins (`stackChildMargin*`) | missing (Sites only; low priority) | — |
| Layout after undo / remote | differs (canvas.md §2.3) | `Editor.cpp:400` |

## 12. Open questions (with the live probe that settles each)

1. **Rounding.** Does auto layout round child positions or sizes to whole pixels (or 1/2 or 1/4)? Probe: a horizontal
   AL frame of width 100 with 3 Fill children, gap 0. Read the children's x / width in the panel and via
   `figma.currentPage.selection[0].children.map(c => [c.x, c.width])`.
2. **⇧A inference heuristics.** Direction threshold, gap statistic (mean, median or minimum), negative overlaps, when
   wrap or grid is chosen, padding on a wrapped group. Probe: 6 layer arrangements (row, column, 2 × 3 grid, overlapping
   row, uneven gaps 8 / 12 / 40, ragged). Press ⇧A on each and dump `layoutMode`, `itemSpacing`, the paddings,
   `layoutWrap` and the grid counts. Also read `inferredAutoLayout` on the same frames before ⇧A.
3. **Suggest auto layout:** what it wraps (nested groups?) and its toast text. Probe: ⌃⇧A on a page with loose rows;
   read the toast and the layers.
4. **Baseline of a non-text child** in Align text baseline. Probe: a horizontal frame with text + rectangle + nested
   frame containing text, baseline on. Measure the y values.
5. **The six apr26 descriptions' English** and when the upgrade dialog lists them. Probe: open the Layout dropdown on a
   legacy frame with a lone Between child and switch to Updated; capture the dialog text.
6. **Layout guide colour default** for Columns / Rows: the code gives the same red 10 % as Grid. The help site shows
   pink. Probe: add Columns and read the hex.
7. **Large grid threshold** for the hidden cell outlines and drop targets. Probe: grids of 10 × 10, 20 × 20 and
   50 × 50; watch the outlines on hover.
8. **The `⇧G` binding** in `toggle-shown-layout-grids` alongside ⌃G: is it active in Design mode, or flag-gated? Probe:
   press ⇧G with a frame that has guides.
