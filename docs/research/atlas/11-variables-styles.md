# 11 — Variables and styles

Figma Design desktop 126.9.13. Read on 2026-10-16 from the cached editor build (`~/.cache/figma-rea/figma/`, outside the
repo), following `~/.cache/figma-rea/BRIEF.md`. No Figma code is copied here; findings are behaviour, numbers, enums and
i18n keys, each with evidence `file @needle` (the minified chunks are single lines, so evidence is the searchable needle
rather than a byte offset) or a short quote. **CONFIRMED** = read directly in the build. **INFERRED** = deduced.

## 1. Scope and sources

**Scope.** Variable types, collections, modes and plan limits, default mode, explicit / Auto modes, aliases and
resolution, scopes (every enum value and which fields each unlocks), code syntax, hide from publishing, the Variables
view (table, columns, sizes, menus, search, filters, drag reorder, bulk edit, keyboard), binding (fields, picker,
detach), expressions, extended collections, styles (types, create / edit / detach / description / naming / folders /
reorder / list-grid), style vs variable, limits and errors, undo step names.

**Prior work (summarised, not repeated).** `docs/research/figma/R3-variables.md` (help + developer docs, rounds 3–6):
six types incl. Timing / Easing; `resolveForConsumer` alias semantics; composed colour (`COLOR_OPACITY`, Sept 2026);
plan mode limits from the pricing page; REST validation (5,000 variables, 40 modes, 40-char mode names, no `.{}` in
names); the Plugin `VariableScope` list; bindable fields; `boundVariables` shapes; extended collections (Enterprise,
overrides in blue, "Reset change"); prototype expressions and precedence; style types and the `styles` map keys;
hide-from-publishing via `_` / `.` prefixes; DTCG import / export format (round 6); visibility stored as
`IS_TRUTHY` expression and variant binding as `RESOLVE_VARIANT` (R3-50/51). Everything in R3 still stands; where this
chapter re-confirms it from the build it says so.

**Read in the build.**

| Source | What |
|---|---|
| `3187.min.js` (also duplicated in `5519`, `7362`) | the Variables view ("authoring modal"): table, sidebar, menus, mode limits, create / duplicate, import, naming helpers |
| `figma_app.min.js` | wasm-binding enums (scope, data type, field, expression), the scope UI lists and the field→scope maps, minimized-modal geometry, variable pills, library update bells |
| `2622 / 3362 / 4752 / 5741.min.js` | the same `variables.*` keys used by the properties panel and Dev Mode |
| `3653.min.js`, `9905.min.js` | create-variable inline form, create / edit style modal, responsive text-style variants (Sites) |
| `774.min.js` | "Selection colors" apply-style modal |
| `9800.min.js` | Dev Mode "Modes" subsection |
| `fullscreen__fullscreen-wasm__compiled_wasm.wasm` | `strings -n 6`, filtered for variable / mode / collection / scope / style → C++ assertion and error texts (one pass, 2,653 lines) |

## 2. Variable types and data types

### 2.1 User-visible variable types — CONFIRMED

| Type (resolved) | Label key | Create menu | Gate |
|---|---|---|---|
| COLOR | `variables.type.color` | 1st | — |
| FLOAT | `variables.type.number` | 2nd | — |
| STRING | `variables.type.string` | 3rd | — |
| BOOLEAN | `variables.type.boolean` | 4th | — |
| TIMING | `variables.type.timing` | after Boolean | feature flag `metronome` (Motion) |
| EASING | `variables.type.easing` | after Timing | `metronome` |
| PAINT | `variables.type.paint` | **first** when on | `ds_paint_variables` (paint variables: a whole Paint, e.g. a gradient, as a variable) |
| UNIT_NUMBER | `variables.type.unit_number` | last | `ce_tl_relative_unit_percent` (number with unit, %) |

Evidence: `3187.min.js: "ep=[f.rXF.COLOR,f.rXF.FLOAT,f.rXF.STRING,f.rXF.BOOLEAN,f.rXF.TIMING,f.rXF.EASING]"`;
create dropdown `"e(\"metronome\")&&(u=[...u,U.rXF.TIMING,U.rXF.EASING])"`, `"getFeatureGate(\"ds_paint_variables\")&&(u=[U.rXF.PAINT,...u])"`.
Type icon + label table `3187.min.js @530581 function k` (MAP, SYMBOL_ID, FONT_STYLE log "Unexpected variable type shown").
The create dropdown is a portal popover, `minWidth:130`, leaning right, arrow offset 15 — CONFIRMED (`3187 @"minWidth:130,children:u.map"`).

### 2.2 VariableDataType (internal value kinds) — CONFIRMED

`figma_app.min.js @"o_[o_.BOOLEAN=0]"`: BOOLEAN 0, FLOAT 1, STRING 2, COLOR 3, MAP 4, SYMBOL_ID 5, FONT_STYLE 6,
TEXT_DATA 7, IMAGE 8, LINK 9, JS_RUNTIME_ALIAS 10, SLOT_CONTENT_ID 11, KEYFRAME_TRACK_ID 12,
KEYFRAME_TRACK_PARAMETER_DATA 13, EASING 14, TIMING 15, VECTOR 16, COLOR_ARRAY 17, LINE 18, CIRCLE 19, ROTATION_3D 20,
CIRCLE_POINT 21, GRADIENT 22, COLOR_POINT 23, GRADIENT_PAINT 24, PAINT 25, LENGTH 26, TRANSITION_PARAMETER_DATA 27,
UNIT_NUMBER 28. (The value-tag enum next to it runs to 36 with ALIAS / EXPRESSION etc.) Only the first four plus
Timing / Easing / Paint / Unit number are user-creatable; the rest exist for component props, Motion and Sites.

Kiwi conversion of a literal: BOOLEAN→`boolValue`, FLOAT→`floatValue`, COLOR→`colorValue`, STRING→`textValue`, alias →
`alias` (local `guid` or library `assetRef.key`) — CONFIRMED (`figma_app @"dataType:\"BOOLEAN\",resolvedDataType"`).

### 2.3 Defaults by component-property type — CONFIRMED

When a variable is created from a component-property field (`figma_app @"let em={[N.J0O.BOOL]"`): BOOL → BOOLEAN,
scope ALL_SCOPES; TEXT → requested STRING, stored as TEXT_DATA, scope **TEXT_CONTENT**; NUMBER → FLOAT ALL_SCOPES (TIMING
when the field is a timing); EASING, COLOR, PAINT → ALL_SCOPES.

## 3. Collections and modes

### 3.1 Limits — CONFIRMED

| Limit | Value | Evidence |
|---|---|---|
| Modes per collection, Starter | **1** | `3187.min.js: "u={starter:1,pro:10,org:20,enterprise:40}"` |
| Pro | 10 | same |
| Organization | 20 | same |
| Enterprise | **40** (not "unlimited") | same; flag `ds_100_modes` raises every plan to 100 |
| Variables per collection | 5,000 | `3187: "es.length+e.length>5e3"`; wasm "cannot create more than %lu variables in a single collection" |
| Mode name length | 40 chars (input `maxLength:40`) | `3187 @"isShowingGuids:w,maxLength:40"` |
| Extended-collection chain | ≤ 10 sets | wasm "Cannot create a variable set extension chain longer than 10 sets" |
| Modes in a collection | ≥ 1 | wasm "Cannot delete the only mode in a Variable Set", "Could not delete last mode in collection" |

Plan resolution: enterprise if the org is Enterprise, org if any org, pro if the team is paid, else starter
(`3187 @"(0,s.kA)(n)?\"enterprise\":n?\"org\""`). Upsell path Starter→Pro, Pro→Org, Org→Enterprise; no upsell for
Enterprise. INFERRED: R3's "Enterprise unlimited" is marketing for extended collections; the per-collection cap is 40.

**Over-limit behaviour — CONFIRMED.** Mode columns at index ≥ limit render `disabled` and are not draggable
(`"disabled:t>=ev"`, `"isDraggable:t<ev&&…"`). At the limit the "+" button shows tooltip
`variables.authoring_modal.reached_hard_mode_limit {modeLimit}` (disabled) when no upgrade exists, otherwise opens the
upsell. Wasm: "cannot modify modes beyond limit of %zu", "Cannot set default mode when there are more modes than
allowed", "Limited to %zu modes only". A mode can be deleted only if more than one exists and (for extensions) it is
not an inherited mode (`"canDelete:T.modes.length>1&&(!K||T.modes.indexOf(e)>q-1)"`).

### 3.2 Default mode — CONFIRMED

Default = the collection's `defaultModeID`; setting it is undo step `set-variable-set-mode-as-default`. Only local
collections (wasm "Can only modify the default mode of local variable collections"). When a library update changes a
subscribed collection's default, a toast `variables.authoring_modal.default_mode_changed` appears
(`3187 @"type:\"default-mode-changed\""`). Reordering modes keeps their ids (wasm "Reordering modes should not change
mode IDs"). Enterprise "team default mode" exists: undo `set-default-mode-from-workspace-team`.

### 3.3 Names — CONFIRMED

- New collection: `variables.variable_collection_default_name`, made unique (§3.4). From an import / first variable in a
  file with none: `variables.authoring_modal.default_collection_name` with origin `AUTOMATIC_FIRST_COLLECTION`.
- New extension: `"<parent name> (<variables.variable_collection_extension_default_name_suffix>)"`, made unique
  (`3187 @"variable_collection_extension_default_name_suffix"`).
- Wasm validation messages: "invalid variable collection name", "invalid variable collection extension name",
  "invalid variable name", "duplicate variable name", "Invalid name: collides with an existing variable in variable
  collection"; visual bells `variables.variable_name_invalid_chars`, `variables.variable_name_duplicate_name`.
  The invalid character set lives in C++ (`isValidVariableName`), not readable as a string — REST says `.`, `{`, `}`.

### 3.4 Unique-name rule — CONFIRMED (`3187 @245774`)

`unique(base, names)`: if `base` is free, use it; else find every `"base N"` (N digits), take max(N, 1) and return
`"base (max+1)"` — so the second "Color" is **"Color 2"**. A companion strips a trailing `" N"` before duplicating.
New variable name = type label made unique inside the target group (`3187 @411322 function _`); duplicate variable =
`unique(stripNumber(name), names)` → "Color 3", **not** "Color copy". Duplicated group name: trailing digits stripped,
then unique among sibling groups, with a trailing `/`.

### 3.5 Group path normalisation — CONFIRMED (`3187 @594157`)

On rename a name is normalised: runs of `/` collapse to one, each segment is trimmed, rejoined with `/`
(`"e.replace(/(\\/)\\1+/g,\"$1\").split(\"/\").map(e=>e.trim()).join(\"/\")"`). Path helpers: segments = split on `/`,
drop empties, trim; group = all but the last; leaf = last. Group tree built from names; groups sorted by the first
variable's `sortPosition` (fractional index); `"All"` root row.

### 3.6 Explicit modes and Auto — CONFIRMED / INFERRED

- Undo step `set-explicit-variable-mode`; analytics `variables.explicit_mode_changed`.
- The selector's options: Auto, Auto with name — `variables.mode_properties_panel.select.option.auto_with_name
  {modeName}` where the name is `"Collection · Mode"` when options span more than one collection, else the mode name —
  plus Mixed and Deleted (`9800 @"auto_with_name"`).
- Sections: `variables.mode_properties_panel.assets_created_in_file.subheading`, `…used_variables.subheading` — local
  collections first, then library collections used by the selection (INFERRED from the key names).
- Wasm resolution notes: "ReactiveModeConsumptions: both forwarded modes and parent have modes, dropping parent" (an
  instance's explicit mode wins over the parent's), "One mode value per collection" for extensions
  (`VariableModeData{variableModeId, variableSetExtensionId}`), "Failed to copy modes during page creation" (a new page
  copies the current page's explicit modes — INFERRED).
- Incompatible modes after a library update: bell `variables.visual_bell.variables_incompatible_modes_needs_updates
  {modeName}` with button `variables.modes.option.review_updates`, else `…_no_updates`.

## 4. Aliases and resolution — CONFIRMED (wasm)

- Same-type only: "Var Mode Lookup: Referenced variable has a different type", "Attempting to resolve variable with
  mismatched type".
- Cycles rejected: "Cannot set a variable to alias itself", "Cannot set variable to an alias that would create a
  cycle", "Variable alias chain has a cycle"; for extension overrides "…override to an alias that would create a cycle"
  → bell `variables.visual_bell.variable_override_infinite_loop`, and "Cannot set a variable override to alias its
  overridden variable" → `…variable_override_self_referential` (`figma_app @"setVariableOverrideForMode"`).
- Deleted variables still referenced stay as soft-deleted ("Can only restore local variables", `isDeleted` on pills;
  name fallback `variables.missing_name`; `variables.variable_was_deleted`).
- Value-cell context menu: "Create alias" / "Clear alias" (`clear-variable-alias`); hover action "Detach alias"
  (`variables.authoring_modal.table.detach_alias`); extensions: "Clear override" (`clear-variable-override-alias`).
- Alias depth limit: not found as a string — open question (DesignerV2 uses 16).

## 5. Scopes

### 5.1 Enum — CONFIRMED (`figma_app @"om[om.ALL_SCOPES=0]"`)

ALL_SCOPES 0, TEXT_CONTENT 1, CORNER_RADIUS 2, WIDTH_HEIGHT 3, GAP 4, ALL_FILLS 5, FRAME_FILL 6, SHAPE_FILL 7,
TEXT_FILL 8, STROKE 9 (Plugin API "STROKE_COLOR"), STROKE_FLOAT 10, EFFECT_FLOAT 11, EFFECT_COLOR 12, OPACITY 13,
FONT_STYLE 14, FONT_FAMILY 15, FONT_SIZE 16, LINE_HEIGHT 17, LETTER_SPACING 18, PARAGRAPH_SPACING 19,
PARAGRAPH_INDENT 20, **FONT_VARIATIONS 21**, **TRANSFORM 22**, COLOR_OPACITY 23.

Validation (wasm): "If ALL_SCOPES is set, other scopes cannot be set", "If ALL_FILLS is set, other fill scopes cannot be
set", "Duplicate scopes", "Invalid scope for this variable type", "Cannot set scopes on this variable type"
(Boolean / Timing / Easing). A missing scope list means `[ALL_SCOPES]` (`figma_app: "e?e.map(…):[d.j0r.ALL_SCOPES]"`).

### 5.2 The Scoping UI per type — CONFIRMED (`figma_app @529417`)

Number (FLOAT), in order:

| # | Scope | Label key | Note |
|---|---|---|---|
| 1 | ALL_SCOPES | `variables.scopes.all_properties` | |
| 2 | CORNER_RADIUS | `…corner_radius` | |
| 3 | WIDTH_HEIGHT | `…width_height` | |
| 4 | GAP | `…gap` | sub-label `variables.scopes.auto_layout` |
| 5 | **TEXT_CONTENT** | `…text_content` | numbers can feed text content |
| 6 | STROKE_FLOAT | `…stroke` | |
| 7 | OPACITY | `…layer_opacity` | |
| 8 | COLOR_OPACITY | `…color_opacity` | only with gate `ds_color_opacity_variables` |
| 9 | EFFECT_FLOAT | `…effects` | |
| — | label | `fullscreen.type_panel.typography` | section header "Typography" |
| 10 | FONT_STYLE | `…font_weight` | |
| 11 | FONT_SIZE | `…font_size` | |
| 12 | LINE_HEIGHT | `…line_height` | |
| 13 | LETTER_SPACING | `…letter_spacing` | |
| 14 | PARAGRAPH_SPACING | `…paragraph_spacing` | |
| 15 | PARAGRAPH_INDENT | `…paragraph_indent` | |

Color: ALL_SCOPES; ALL_FILLS (`…all_fills`); FRAME_FILL / SHAPE_FILL / TEXT_FILL **indented** under it, each with a Dev
Mode label variant (`…frame_fill_dev_mode` …); STROKE (`…stroke`); EFFECT_COLOR (`…effects`).
String: ALL_SCOPES; TEXT_CONTENT; FONT_FAMILY; FONT_STYLE labelled `…font_weight_or_style`.
Boolean, Timing, Easing: no list. Header keys per type: `variables.scopes.{number,color,string}_scoping_header`.
Summary text: empty list → `…no_supported_properties`; contains ALL → `…all_properties_label`; otherwise labels joined
pairwise with `…scope_list {scope1, scope2}`.

### 5.3 Which field needs which scope — CONFIRMED (`figma_app @"let P={CORNER_RADIUS"`)

| Field(s) | Scope required |
|---|---|
| CORNER_RADIUS, RECTANGLE_{TL,TR,BL,BR}_CORNER_RADIUS | CORNER_RADIUS |
| STACK_SPACING, STACK_COUNTER_SPACING, STACK_PADDING_{L,T,R,B}, STACK_CHILD_MARGIN_{T,R,B,L}, GRID_ROW_GAP, GRID_COLUMN_GAP | GAP |
| WIDTH, HEIGHT, MIN/MAX_WIDTH, MIN/MAX_HEIGHT | WIDTH_HEIGHT |
| TEXT_DATA | TEXT_CONTENT |
| STROKE_WEIGHT, BORDER_{TOP,BOTTOM,LEFT,RIGHT}_WEIGHT | STROKE_FLOAT |
| OPACITY | OPACITY |
| FONT_FAMILY / FONT_STYLE / LETTER_SPACING / LINE_HEIGHT / PARAGRAPH_SPACING / PARAGRAPH_INDENT | same-named scope |
| FONT_SIZE, FONT_VARIATIONS | **PARAGRAPH_SPACING** (as written in the map; see Open questions) |
| X_POSITION, Y_POSITION, ROTATION | TRANSFORM |
| VISIBLE, VARIANT_PROPERTIES, OVERRIDDEN_SYMBOL_ID, HYPERLINK, SLOT_CONTENT_ID, all MOTION_* / 3D / path-trim / easing / timeline fields | none (any variable of the type) |

Paints: a FILL is scoped by the **node type** — FRAME, SECTION, SYMBOL, INSTANCE → FRAME_FILL; VECTOR, BRUSH, STAR,
LINE, ELLIPSE, RECTANGLE, REGULAR_POLYGON, ROUNDED_RECTANGLE, VECTOR_OPERATION → SHAPE_FILL; TEXT, TEXT_PATH →
TEXT_FILL; everything else null. STROKE / STROKE_PRESET → STROKE; EFFECT → EFFECT_COLOR. Filter rule
(`function U`): types other than FLOAT / COLOR / STRING always pass; else pass if any variable scope is requested, is
ALL_SCOPES, or is ALL_FILLS while any requested scope is a fill scope. Composed-colour opacity requests
{COLOR_OPACITY}.

## 6. Bindable fields (VariableField enum) — CONFIRMED (`figma_app @"STACK_SPACING=5"`)

MISSING 0, CORNER_RADIUS 1, PARAGRAPH_SPACING 2, PARAGRAPH_INDENT 3, STROKE_WEIGHT 4, STACK_SPACING 5,
STACK_PADDING_LEFT 6, _TOP 7, _RIGHT 8, _BOTTOM 9, VISIBLE 10, TEXT_DATA 11, WIDTH 12, HEIGHT 13,
RECTANGLE_TOP_LEFT_CORNER_RADIUS 14, …_TOP_RIGHT 15, …_BOTTOM_LEFT 16, …_BOTTOM_RIGHT 17, BORDER_TOP_WEIGHT 18,
BORDER_BOTTOM_WEIGHT 19, BORDER_LEFT_WEIGHT 20, BORDER_RIGHT_WEIGHT 21, VARIANT_PROPERTIES 22, STACK_COUNTER_SPACING 23,
MIN_WIDTH 24, MAX_WIDTH 25, MIN_HEIGHT 26, MAX_HEIGHT 27, FONT_FAMILY 28, FONT_STYLE 29, FONT_VARIATIONS 30,
OPACITY 31, FONT_SIZE 32, LETTER_SPACING 34, LINE_HEIGHT 36, OVERRIDDEN_SYMBOL_ID 37, CMS_SERIALIZED_RICH_TEXT_DATA 38,
HYPERLINK 39, SLOT_CONTENT_ID 40, GRID_ROW_GAP 41, GRID_COLUMN_GAP 42, RELATIVE_X_POSITION 43, RELATIVE_Y_POSITION 44,
RELATIVE_ROTATION 45, MOTION_TRANSLATION_X 46 … MOTION_SHEAR 51, SCROLL_OFFSET_X 52, _Y 53, PATH_TRIM_START 54,
PATH_TRIM_END 55, DISSOLVE_PROGRESS 56, EASING_DATA 57, MEDIA_CURRENT_TIME 58, TRANSFORM_3D_* 59–63,
POLYGON_COUNT 64, ARC_DATA_STARTING_ANGLE 65, _ENDING_ANGLE 66, _INNER_RADIUS 67, KEYFRAME_VALUE 68,
MOTION_TRANSLATION_XY 69, MOTION_SCALE_XY 70, SCENE_3D_PERSPECTIVE 71, STAR_INNER_SCALE 72, MOTION_TRANSFORM_ORIGIN_* 73–75,
TRANSFORM_3D_ROTATION_XYZ 77, STACK_CHILD_MARGIN_TOP 78 … _LEFT 81, TIMELINE_DURATION 82.

New since R3 (beyond the Plugin API list): **X / Y / rotation** (TRANSFORM scope), **child margins**, **polygon count,
star inner scale, arc angles / inner radius**, path trim, font variations, hyperlink, scroll offsets. Wasm: "variable
field '%s' is not supported on text substrings" (some text fields are whole-node only).

**Field validation warnings — CONFIRMED** (`3187 @"variables.invalid.less_than_min_height"`): a bound value that breaks
a constraint shows `variables.invalid.{less_than_min_width, less_than_min_height, greater_than_max_width,
greater_than_max_height, less_than_one, negative, negative_or_zero}`. Opacity binding states CLAMPED_HIGH / CLAMPED_LOW /
INERT with `variables.opacity.{clamped_high_warning, clamped_low_warning, inert_warning}`; the input then uses the
"warning" style, an override uses "override", else "primary"; the tooltip otherwise is name + description + value
joined by blank lines.

## 7. The binding picker ("Apply variable") — CONFIRMED

- Entry: field button tooltips `fullscreen.properties_panel.apply_variable`, `…apply_variable_hotkey` (`=`), create
  buttons `variables.binding_ui.create_variable_button_tooltip`, `…create_style_or_variable_button_tooltip` (paints:
  styles and variables in one picker), `…create_variable_property_button_tooltip` (component property).
- Library selector (`variables.binding_ui.variable_set`): **All libraries**, separator, **Created in this file**
  (`…set_labels.assets_created_in_file`; `…variables_created_in_file`), separator, one entry per library.
- Layout toggle: list / grid, **only for COLOR**; grid is disabled when the selection uses more than one mode
  (`…grid_view_unavailable_multiple_modes`, enum MIXED_MODES 0). Tooltips `…show_as_grid_tooltip`, `…show_as_list_tooltip`.
- Search `…search_placeholder`; empty states `…no_variables_empty_state`, `…no_colors_empty_state`,
  `…no_variables_props_empty_state`, `…no_search_results`; error `…error_state`; text `…missing_font_family`,
  `…missing_font_style`.
- Tabs when Sites CMS is present: `…variable_library_tab_name` vs `…variable_dakota_tab_name` (disabled for instance
  sublayers).
- Bound field = pill (`variable_pill_*` aria keys); detach button `variables.binding_ui.detach_variable_tooltip`
  (detach writes the resolved value — INFERRED from undo names; there is no separate "detach-variable" step, the field
  write itself is the step).
- Inline "create variable" from a field: name + value + collection select (collections minus extensions), Create button
  disabled with tooltip `variables.create_modal.invalid_variable_name` until `isValidVariableName(name, collection)`
  (`9905 @"isValidVariableName"`); padding 16, row spacing 8.

## 8. The Variables view (authoring modal)

### 8.1 Geometry — CONFIRMED

| Item | Value | Evidence |
|---|---|---|
| Minimized window default width | 642 px (+ sidebar width when the sidebar is open) | `figma_app: "z=642+(t??0)"` |
| Minimized default height | 380 px | `"(0,E.Wz)(N,380)"` |
| Default position | top-right, 8 px in from the canvas edge and 8 px down | `"t+(0,f.jz)(\"8px\"),(0,f.jz)(\"8px\")"` |
| Min size | 400 × 180 (with variables) / 400 × 300 (empty) | `"minWidth:400,minHeight:e?180:300"` |
| Max size | window − 2 × 8 px each way | `"maxWidth:t-2*k"`, `k=8px` |
| Sidebar width | 240 px (INFERRED: helper returns `"240px"`) | `3187 @411322 function f` |
| Name column | default 200 px; drag-resize clamped 50…500; double-click resets | `3187: "qE)(n.current+e.delta.x,50,500)"`, `"onDoubleClick:p"` |
| Row heights (virtualised estimate) | group header 56, variable 41 | `3187: "\"group\"===t.type?56:41"`; `P=41px` |
| Edit variable panel | width 280 px; tabs **Details / Scoping** | `3187 @"variables.edit_modal.title"` |
| Session size / position | remembered per session | `setSessionWidth/Height/Position` |

Full-page vs minimized: `variables.authoring_modal.toggle_fullscreen_mode_{expand,minimize}`.

### 8.2 Sidebar

- Collections list with per-row variable count (`…sidebar.collections.variable_count {count}`), drag reorder
  (`reorder-variable-collections`). The collections header menu: **All collections** / **Created in this file**
  (checkable — library collections are listed too, read-only), separator, **Sort A to Z** (`sort-variable-collections`).
- Groups tree (`…sidebar.groups`), "Collapse groups" (`…sidebar.collapse_groups`), drag groups to reorder / nest
  (`move-variable-groups`, `move-variable-groups-to-group`); bells `variables.visual_bell.{expand,collapse}_variable_group`.
- Errors: `…sidebar.cant_load_collection`, `…corrupt_library_collection`, `…corrupt_local_collection`,
  `…contact_support`.
- Collection menu: Rename collection, Delete collection, Create collection (overflow), Export modes, Extend collection.

### 8.3 Table

- Header: Name (`…table.name_header`) + one column per mode + "+" (`…new_mode_tooltip`). Mode header menu:
  Rename mode, Duplicate mode, Set as default, Move left, Move right, Import mode, Export mode, Delete mode.
- Row context menu order (`3187 @"sidebar-collection-list-edit-variable"`): value options (Create alias / Clear alias),
  **Copy**, **Paste**, **New group with selection** (`…context_menu.create_group`), **Edit variable(s)**
  (`…context_menu.edit {count}`), separator, **Move to top / Move up / Move down / Move to bottom** (gate
  `ds_variables_context_menu_reorder`), **Duplicate** (`{count}`), separator, **Delete** / Delete (multiple).
- Group menu: Ungroup, Duplicate group(s), Delete group(s).
- Keyboard: **⇧Enter** duplicates the selected variables; **⌘A** selects every variable in view (unless typing in an
  input) — `3187 @"i?.key===\"Enter\"&&i.shiftKey"`.
- Create: "+ Create variable" (`…create_variable_button_label`, `…table.create_variable`) → type menu; the new variable
  is inserted after the selected row inside its group (system step `reorder-new-variable`) and opens in rename.
- Bulk edit: multi-select → Edit variables (scopes, hide from publishing, code syntax apply to all).
- Search + filters: `…filters.{all, colors, numbers, strings, booleans, timing, easing}`, type filter label
  `…filters.type`, extension filters `…filters.extended_collection_filter`, `…filters.overridden_in_extended_collection`;
  advanced search `…search.advanced`, `…search.advanced.highlight_overrides`. Empty states `…no_variables_match_search`
  (+ Clear search), `…no_variables_match_filters` (+ Clear filters), `…no_variables_in_collection`,
  `…no_variables_created_in_file`, `…empty_state_text(_read_only)`.
- Easing cells open settings (`…table.open_easing_settings`; bezier / spring, `variables.create_modal.easing_*`).
- Inaccessible library variable: `…table.inaccessible_variable_tooltip`. Read-only view copies name / value
  (`variables.read_only_modal.copy_variable_{name,value}_tooltip`).

### 8.4 Edit variable panel — CONFIRMED

Title `variables.edit_modal.title`; tabs Details (`…tabs.details`) and Scoping (`…tabs.scoping`). Details: Name
(`…input_label.name`, placeholder), token name (`…input_label.token_name`), Description (+ placeholder), per-mode values
(`…mode_section_header`), Code syntax "Add code syntax" with platforms Web / Android / iOS (`…platforms.*`) and per
platform "Remove code syntax for …"; Hide from publishing checkbox. Undo steps: `rename-variable(s)`,
`edit-variable-description`, `edit-variable-scopes`, `edit-variable-code-syntax`, `delete-variable-code-syntax`.

### 8.5 Import (DTCG) — CONFIRMED keys

`…import_variables`, `…importing_variables`, `…import_variables_success_with_count`,
`…import_variables_success_and_errors_with_count`, `…import_variables_errors(_with_count)`, `…errors_check_file`,
`…import_variables_updated`, `…import_variables_overridden`, `…import_variables_error`. Undo steps `import-modes`
("create-variables-from-design-tokens") and `import-mode-from-design-tokens` ("overwrite-variables-with-design-tokens").
Format already in R3 §Round 6.

## 9. Expressions — CONFIRMED (`figma_app @"iN.ADDITION=0"`)

ADDITION 0, SUBTRACTION 1, RESOLVE_VARIANT 2, MULTIPLY 3, DIVIDE 4, EQUALS 5, NOT_EQUAL 6, LESS_THAN 7,
LESS_THAN_OR_EQUAL 8, GREATER_THAN 9, GREATER_THAN_OR_EQUAL 10, AND 11, OR 12, NOT 13, STRINGIFY 14, TERNARY 15,
VAR_MODE_LOOKUP 16, NEGATE 17, IS_TRUTHY 18, KEYFRAME 19, COMPOSE_COLOR 20, PAINT_TO_COLOR 21, RESOLVE_LENGTH 22,
TRANSITION 23. Rules (wasm): "COMPOSE_COLOR requires at least one variable alias", "COMPOSE_COLOR arguments must be
values or variables, not expressions"; "Decoded variable alias or expression without a resolvedDataType set".
Prototype expression syntax and precedence: R3-34.

## 10. Extended collections — CONFIRMED (wasm + JS)

Gate: Enterprise (`allowExtendedSets`). Create: `create-variable-set-extension`. Cannot create variables in an
extension, cannot override in the set that defines the variable, overrides only on local extensions, chain ≤ 10, cycles
rejected ("Cycle in variable set extensions"). Values resolve up the chain: the extension's override for its mode, else
the parent's (wasm "Could not look up parent mode while backtracking along an extension chain"). Table: override chip in
blue, "Clear override" (`…table.clear_override`), filter "Overridden". R3-32/55 detail stands.

## 11. Styles

### 11.1 Types — CONFIRMED

JS style types FILL, TEXT, EFFECT, GRID, ANIMATION (`3653 @"\"ANIMATION\"===e"`). Labels: Color / Text / Effect /
Guide / Motion (`design_systems.create_style.{color,text,effect,guide,motion}`; dropdown `design_systems.styles.dropdown.
{fill,text,effect,guide,motion}`); kinds shown as `…styles.{color,text,effect,guide,motion,stroke}_style`. Wasm: "Cannot
set style of a different type", "refusing to create style with missing font".

### 11.2 Create / edit — CONFIRMED

Create-style modal (`design_systems.create_style.*`): title, Name (placeholder per type `placeholder_name_{color,text,
effect,guide,motion}`), Description (one-row expandable textarea, placeholder), "Show more options" / "Hide options",
type-specific body (fill paint list / layout guides / type panel / effects / animation), Create style, Cancel,
"Use style"; error `an_error_occurred_while_creating_the_style`. Editing the description is undo step
`set-style-description` (written on blur). Edit panel titles `design_systems.styles.edit_{color,text,effect,guide,motion}_style`
and view-only `…view_*_style` (library styles).

Selection-colors apply-style modal: width 400, title `color_conflict` when several paints differ, body
`conflict {conflictNodesCount}`, error `error_applying_style`; step `apply-style-to-selection-paints`.

### 11.3 Local styles list, picker — CONFIRMED keys

`design_systems.styles.local_styles`, `…tooltips.create`, `…tooltips.create_style_from_section`, `…tooltips.library`,
`…tooltips.show_as_grid / show_as_list`, `…toggle_folder`, `…group_selection` (new folder from selection), `…no_styles_match`,
`…no_specified_style`, `…custom`, `…buttons.browse`, `…properties`, `…go_to_style_definition`, `…update_available(s)`,
`…review_updates`, `…update_selected_style`, `…detach_style`, `…copy_styles`, `…paste_styles`, `…duplicate_styles`,
`…delete_styles`, `…delete_num_styles`, `…export_style`, `…clear_overrides_over_text_style`, `…style_name_tooltip`.
Undo steps: `apply-style`, `apply-style-to-selection`, `apply-style-to-nodes`, `apply-paint-to-style`, `rename-style`,
`reorder-styles`, `duplicate-styles`, `copy-styles`, `cut-styles`, `paste-styles`, `delete-style(s)`, `detach-style`,
`create-soft-deleted-style`, `create-new-style-from-eyedropper`, `update-shared-style`. Folders are slash paths (same
helpers as §3.5 — INFERRED for styles).

### 11.4 Sites-only: responsive text style variants — CONFIRMED

A text style can carry variants by **min-width breakpoint** (`create-responsive-text-style-variant`): each variant
stores font size, line height, letter spacing, paragraph spacing; ranges are labelled "a - (b−1)" and the last "n+"
(`3653 @"responsiveTextStyleVariants"`). Keys `sites.panel.responsive_text_style.*`. Not part of Figma Design proper.

### 11.5 Style vs variable — INFERRED

Styles can hold variable bindings (a style's paint / text fields bind like a node's; the create modal's fill list uses
`variableBindingSurfaceId:"STYLE_AUTHORING_MODAL"`), variables cannot reference styles. The selection-to-library tooling
rejects mixed input: wasm "Selection must only contain variables-related assets or styles". Whether binding a variable to
a styled paint detaches the style was not readable statically.

## 12. Library and swap

Steps `upsert-shared-variable(-set)`, `update-shared-variable-set`, `upsert-entire-variable-set`; swap library counts
swapped variables (`variables.visual_bell.variable_swap_count`), swap by name across same resolve type only (wasm
"Cannot swap variables with different resolve types", `swapVariableSetVariablesByName`). Branch diff keys
`variables.diff.*`, `variables.branching.{code_syntax,hide_from_publishing,show_when_publishing,override_indicator}`.

## 13. Undo steps (all variable ones found) — CONFIRMED

create-variable, create-variable-set, create-variable-set-extension, create-variable-group, add-variable-set-mode,
duplicate-variable-set-mode, rename-variable-set-mode, delete-variable-set-mode, reorder-mode,
set-variable-set-mode-as-default, rename-variable, rename-variables, rename-variable-set, duplicate-variables,
delete-variables, delete-variable-set, reorder-variables, reorder-new-variable (system), reorder-variable-collections,
sort-variable-collections, move-variable-to-group, move-variable-groups, move-variable-groups-to-group, ungroup-variables,
copy-variables, paste-variables-into-collection, clear-variable-alias, clear-variable-override-alias,
edit-variable-description, edit-variable-scopes, edit-variable-code-syntax, delete-variable-code-syntax,
set-explicit-variable-mode, set-variant-variable-binding, clear-variant-variable-binding, import-modes,
import-mode-from-design-tokens. Every authoring step is `user` (one undo entry) followed by a commit.

## 14. UI strings (i18n keys)

English is not in the cache. Attested English (help pages via R3, DesignerV2 `src/shared/i18n`): "Create variable",
"Create collection", "Rename collection", "Delete collection", "New variable mode", "Set as default", "Duplicate mode",
"Move column left/right", "Import mode", "Export mode", "Export modes", "Extend collection", "Reset change",
"New group with selection", "Ungroup", "Duplicate group", "Delete group", "Edit variable(s)", "Create alias",
"Detach alias", "Reorder collections", "Sort A to Z", "Minimize", "Expand", "Apply variable mode", "Auto",
"Hide from publishing", "Code syntax", "Show in all supported properties", "Collapse groups", "Scoping".
Keys found (variables.*: 247 unique in `3187 + figma_app + 2622 + 4752`), grouped:

- `variables.authoring_modal.*`: title, create, create_variable_button_label, edit_variable_button_tooltip,
  new_mode_tooltip, reached_hard_mode_limit, default_mode_changed, default_collection_name, breadcrumbs.{go_to_collection,
  more_collections}, context_menu.{clear_alias, create_alias, create_group, delete, delete_multiple, duplicate, edit,
  reorder.move_{to_top,up,down,to_bottom}}, group_context_menu.{ungroup, duplicate_group(s), delete_group(s)},
  mode_context_menu.{rename_mode, duplicate_mode, set_as_default, move_left, move_right, import_mode, export_mode,
  delete_mode}, overflow_dropdown.{create,rename,delete}_collection, sidebar.{collections, groups, collapse_groups,
  variable_count, context_menu.export_modes, context_menu.extend_collection, collections.context_menu.{all_collections,
  created_in_this_file, sort, collections_options}, cant_load_collection, corrupt_*_collection, contact_support},
  table.{name_header, all, create_variable, detach_alias, clear_override, open_easing_settings,
  inaccessible_variable_tooltip}, filters.*, search.*, empty / no-match states, import_* (§8.5),
  toggle_fullscreen_mode_{expand,minimize}.
- `variables.edit_modal.*`: title, tabs.{details,scoping}, input_label.{name,token_name,description,
  description_placeholder}, input_placeholder.name, mode_section_header, add_code_syntax, platforms.{web,android,ios},
  remove_code_syntax_for_{web,android,ios}, hide_from_publishing.
- `variables.scopes.*` (§5.2), `variables.type.*` (§2.1), `variables.binding_ui.*` (§7), `variables.invalid.*`,
  `variables.opacity.*` (§6), `variables.visual_bell.*` (§3–4, 12), `variables.create_modal.{invalid_variable_name,
  name_label, value_label, create_button, create_file_variable, create_component_property, easing_bezier, easing_spring,
  easing_type_legend}`, `variables.mode_properties_panel.*` (§3.6), `variables.values.boolean.{true,false}`,
  `variables.variable_limit_in_collection_reached {variableLimit}`, `variables.variable_name_invalid_chars`,
  `variables.variable_name_duplicate_name`, `variables.missing_name`, `variables.variable_was_deleted`.
- `properties.dropdown.apply_variable_mode`, `fullscreen.properties_panel.apply_variable(_ellipses|_hotkey)`,
  `proto.action_set_variable_mode`, `proto.set_variable_mode.{collection,mode}_label`.
- Styles: `design_systems.create_style.*` (29 keys), `design_systems.styles.*` (52 keys) — §11.

## 15. DesignerV2 today

Read: `engine/src/editor/{Variables,VariableCommands}.cpp`, `src/renderer/src/editor/{variables.ts,model/variables.ts,
model/styles.ts}`, `src/renderer/src/editor/panels/variables/*`, `panels/design/Styles.tsx`.

**Matches.** 5,000 variables / collection, mode names ≤ 40, cannot delete the last mode; scope semantics (ALL_SCOPES,
ALL_FILLS covering the three fills, booleans unscoped); alias resolution in the consumer's mode per collection;
COMPOSE_COLOR, IS_TRUTHY, VAR_MODE_LOOKUP present in schema / engine; extended collections with overrides and Reset;
Reorder collections + Sort A to Z; Collapse groups; Name column 200; Edit variable popover 280 wide; picker grid view;
DTCG import / export; Timing / Easing types in the model.

**Differs.**
- Mode limit is a flat 40 (`kMaxModes`); Figma is per plan (1 / 10 / 20 / 40) with over-limit columns disabled.
  Fine for a single Enterprise-like user, but the disabled-column behaviour after a downgrade / library import is absent.
- Duplicate naming: DesignerV2 writes "`<name> copy`" (variables, collections); Figma strips a trailing number and
  uses the "Name 2 / Name 3" rule (§3.4). New collection names are uniquified the same way in Figma.
- Number scopes: DesignerV2 lacks **TEXT_CONTENT** for numbers, the "Typography" label, the GAP sub-label
  "Auto layout", the "Show in all" row's position, and gated COLOR_OPACITY; Figma places Text content 4th.
- Edit variable panel: Figma splits into **Details | Scoping tabs**; DesignerV2 is one scrolling form.
- Name column resize clamp 50–500 and double-click reset — check DesignerV2 (it uses a fixed 200 / 280 grid).
- Minimized modal geometry (642 × 380, min 400 × 180/300, 8 px inset, top-right) — DesignerV2 follows the 2026
  rail view; the minimized window sizes are not modelled.

**Missing.**
- Row menu **Move to top / Move up / Move down / Move to bottom** and the menu order of §8.3.
- Table keyboard: **⇧Enter** duplicate and **⌘A** select-all (no handler found in `LocalVariables.tsx`).
- Scopes FONT_VARIATIONS and TRANSFORM, and bindable fields X / Y / rotation, child margins, polygon count, star inner
  scale, arc data (engine binds only the classic Plugin-API fields).
- Field validation warnings (`variables.invalid.*`) and opacity clamp / inert warnings on bound fields.
- Extension chain limit 10; collections sidebar "All collections / Created in this file" toggle with library
  collections read-only; default-mode-changed toast; incompatible-modes bell.
- Paint variables (gated in Figma), unit-number variables (gated).

## 16. Open questions

1. **FONT_SIZE → PARAGRAPH_SPACING** in the field→scope map: a quirk of the analytics map or the real picker filter?
   Probe: in Figma, scope a number variable to Font size only and open the font-size picker; then to Paragraph spacing
   only.
2. The exact invalid-character set behind `variables.variable_name_invalid_chars` (C++). Probe: type `.`, `{`, `}`, `$`,
   `/` at the ends, leading spaces into a variable name.
3. English text of `variables.variable_collection_default_name` and of the extension suffix. Probe: create a collection
   and an extension in the live app, or fetch the English bundle.
4. Alias chain depth limit (none found). Probe: plugin script chaining 100 aliases.
5. Binding a variable to a paint that comes from a colour style: does the style detach? Probe: apply style, then bind a
   colour variable via the same fill row; read `fillStyleId` afterwards.
6. The 240 px sidebar width is inferred from a helper; confirm with a DOM capture of the minimized modal.
7. Whether "Move to top…" (`ds_variables_context_menu_reorder`) is on for the owner's account. Probe: right-click a row.
