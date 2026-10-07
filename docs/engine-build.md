# Engine: build, run, test, API (milestones E0 + E1 + E2 + E3 + E4 + E5, E6 components, E6 variables + styles)

## E6 variables, modes + styles API — names (published first; stable)

Local variables, modes and styles only (libraries come next round). Everything is in the document as scene nodes on the internal canvas `0:2` (docs/schema.md §6), undoable, and round-trips through `encodeDocument`.

**Node fields** (`NodeFields`, schema names; GUIDs inside these structures are `{sessionID, localID}` objects on output, `"s:l"` strings are read too):
- Collection = `VARIABLE_SET` under `0:2`: `name`, `variableSetModes: [{id, name, sortPosition}]` (the default mode is the first by `sortPosition`), `sortPosition`, `isPublishable` (absent = true; a name starting with `_` or `.` also hides it), `key`, `description`.
- Variable = `VARIABLE` under `0:2`: `name` (slash path = groups), `variableSetID: {guid}`, `variableResolvedType: "BOOLEAN" | "FLOAT" | "STRING" | "COLOR" | "EASING" | "TIMING"`, `variableDataValues: {entries: [{modeID, variableData}]}`, `variableScopes: VariableScope[]` (absent = `["ALL_SCOPES"]`, `[]` = no picker), `codeSyntax: {entries: [{platform: "WEB" | "ANDROID" | "iOS", value}]}`, `description`, `isPublishable` (false = Hide from publishing), `sortPosition` (order in its collection), `key`, `isSoftDeleted` (deleted but still referenced).
- `VariableData = {dataType, resolvedDataType, value: {boolValue | floatValue | textValue | colorValue | alias: {guid} | expressionValue: {expressionFunction: "COMPOSE_COLOR", expressionArguments: [color, opacity]} | fontStyleValue: {asString?, asFloat?} | propRefValue: {defId}}}` (docs/schema.md §6.2).
- Bindings: `parameterConsumptionMap.entries [{variableField, variableData}]` (ALIAS, COMPOSE_COLOR, FONT_STYLE; PROP_REF are component properties), `Paint.colorVar` / `Paint.opacityVar` / `Paint.stopsVar [{color, colorVar, position}]`, `Effect.colorVar / radiusVar / spreadVar / xVar / yVar`, `LayoutGrid.numSectionsVar / offsetVar / sectionSizeVar / gutterSizeVar`. The bound field itself always holds the resolved value (written by the engine in the same commit).
- Explicit modes ("Apply variable mode"): `variableModeBySetMap: {entries: [{variableSetID: {guid}, variableModeID}]}` on any node, pages included; no entry = Auto.
- Style = a node under `0:2` with `styleType: "FILL" | "TEXT" | "EFFECT" | "GRID"` (FILL / EFFECT / GRID: a ROUNDED_RECTANGLE holding `fillPaints` / `effects` / `layoutGrids`; TEXT: a TEXT node holding the font fields, `textData.characters "Ag"`), `name` (slash path = folders), `description`, `sortPosition`, `key`, `isPublishable`. Consumers: `styleIdForFill`, `styleIdForStrokeFill`, `styleIdForText`, `styleIdForEffect`, `styleIdForGrid` = `{guid}`; the consumer's own fields hold the style's values (written by the engine).

**Binding targets** (`BindingTarget`, a string, in commands and reads): a node field by its `VariableField` name — `WIDTH`, `HEIGHT`, `MIN_WIDTH`, `MAX_WIDTH`, `MIN_HEIGHT`, `MAX_HEIGHT`, `OPACITY`, `VISIBLE`, `CORNER_RADIUS`, `RECTANGLE_TOP_LEFT_CORNER_RADIUS` (… `TOP_RIGHT`, `BOTTOM_LEFT`, `BOTTOM_RIGHT`), `STROKE_WEIGHT`, `BORDER_TOP_WEIGHT` (… `BOTTOM`, `LEFT`, `RIGHT`), `STACK_SPACING`, `STACK_COUNTER_SPACING`, `STACK_PADDING_LEFT` (… `TOP`, `RIGHT`, `BOTTOM`), `TEXT_DATA`, `FONT_FAMILY`, `FONT_STYLE`, `FONT_SIZE`, `LINE_HEIGHT`, `LETTER_SPACING`, `PARAGRAPH_SPACING`, `PARAGRAPH_INDENT`, `GRID_ROW_GAP`, `GRID_COLUMN_GAP` — or a list member: `fillPaints[i].color`, `fillPaints[i].opacity`, `fillPaints[i].stops[j].color`, the same for `strokePaints`, `effects[i].color | radius | spread | x | y`, `layoutGrids[i].numSections | offset | sectionSize | gutterSize`. Units: numbers are px, except `OPACITY` and paint `opacity`, which take a percentage 0–100 (clamped, Figma's rule); `LINE_HEIGHT` keeps the node's units (Auto becomes PIXELS); `FONT_STYLE` takes a STRING (style name) or a FLOAT (weight) variable.

**Values** (`VariableValue`, Figma's plugin shapes): `boolean | number | string | RGBA {r, g, b, a} | VariableAlias {type: "VARIABLE_ALIAS", id} | ComposedColor {color: RGBA | VariableAlias, opacity: number | VariableAlias}` (composed colour = "Control opacity at scale"; `opacity` in % 0–100). `ResolvedVariableValue = boolean | number | string | RGBA` (EASING: the raw data). Aliases are type-checked (same resolved type; a composed colour's colour is a COLOR, its opacity a FLOAT), may cross collections, and are refused when they would form a cycle (`E_INVALID`).

**Commands** (`abi.ts CommandId`; `engine.command(name, args)`; `args` values may be any JSON now — `CommandArgValue` widened; `refs` default to the selection; each command is one undo step with the label given):
- Collections: `CREATE_VARIABLE_COLLECTION` 140 `{name?}` ("Collection", one mode "Mode 1"), `RENAME_VARIABLE_COLLECTION` 141 `{collection, name}`, `DELETE_VARIABLE_COLLECTION` 142 `{collection}` (its variables too), `MOVE_VARIABLE_COLLECTION` 143 `{collection, index}`, `DUPLICATE_VARIABLE_COLLECTION` 144 `{collection}`.
- Modes: `ADD_VARIABLE_MODE` 145 `{collection, name?}` ("Mode N"; values copied from the default mode), `RENAME_VARIABLE_MODE` 146 `{collection, mode, name}`, `DELETE_VARIABLE_MODE` 147 `{collection, mode}` (never the last), `MOVE_VARIABLE_MODE` 148 `{collection, mode, index}` (index 0 = "Set as default"), `DUPLICATE_VARIABLE_MODE` 149 `{collection, mode}`.
- Variables: `CREATE_VARIABLE` 150 `{collection, type: "COLOR" | "FLOAT" | "STRING" | "BOOLEAN", name?, value?, group?}` (default names "Color", "Number", "String", "Boolean" + " 2"…; defaults white / 0 / "" / false in every mode), `RENAME_VARIABLE` 151 `{variable, name}` (unique in its collection, no `.` `{` `}`), `DELETE_VARIABLES` 152 `{variables}` (soft-deleted while something references them), `MOVE_VARIABLES` 153 `{variables, index, group?}` (index in the collection's order, counted without them; `group` re-paths them, "" = top level), `DUPLICATE_VARIABLES` 154 `{variables}`, `SET_VARIABLE_VALUE` 155 `{variable, mode?, value: VariableValue}` (mode absent = the default mode), `SET_VARIABLE_SCOPES` 156 `{variables, scopes}`, `SET_VARIABLE_CODE_SYNTAX` 157 `{variable, platform, value}` ("" removes), `SET_VARIABLE_DESCRIPTION` 158 `{variable, description}`, `SET_VARIABLE_HIDDEN` 159 `{variables, hidden}` (Hide from publishing).
- Groups (slash names): `GROUP_VARIABLES` 160 `{variables, name}` ("New group with selection"), `RENAME_VARIABLE_GROUP` 161 `{collection, group, name}`, `UNGROUP_VARIABLES` 162 `{collection, group}`, `DELETE_VARIABLE_GROUP` 163 `{collection, group}`, `DUPLICATE_VARIABLE_GROUP` 164 `{collection, group}`.
- Use: `BIND_VARIABLE` 165 `{refs?, target: BindingTarget, variable}` (`variable` "" / null = detach), `DETACH_VARIABLE` 166 `{refs?, target}` (the field keeps its resolved value), `SET_VARIABLE_MODE` 167 `{refs?, page?, collection, mode}` (`mode` "" = Auto; `page` or a page id in `refs` sets the page's mode).
- Styles: `CREATE_STYLE` 170 `{type: "FILL" | "TEXT" | "EFFECT" | "GRID", name?, from?: Guid, apply?: boolean, target?: "FILL" | "STROKE"}` (values taken from `from` — its fills, or strokes with `target: "STROKE"`, text, effects, layout guides — else Figma's defaults; `apply` also applies it to `from`), `DELETE_STYLE` 171 `{style}` (users keep the values, detached), `APPLY_STYLE` 172 `{refs?, style, target?: "FILL" | "STROKE"}`, `DETACH_STYLE` 173 `{refs?, target: "FILL" | "STROKE" | "TEXT" | "EFFECT" | "GRID"}`, `MOVE_STYLE` 174 `{style, index}` (among its type), `GROUP_STYLES` 175 `{styles, name}` ("Add new folder"), `RENAME_STYLE_GROUP` 176 `{type, group, name}`, `UNGROUP_STYLES` 177 `{type, group}`. Editing a style's values, name or description is `engine.setProps([style], {fillPaints | effects | layoutGrids | font fields | name | description | isPublishable})`: one undo step, every user updates in the same commit.
- Edits that override a bound value detach it, as in Figma: a typed / dragged value of a bound node field drops that binding, a changed paint colour or opacity drops its `colorVar` / `opacityVar`, and changed fills / strokes / effects / layout guides / text-style fields detach their style.

**Clearing fields**: an update (`setProps`, `applyChanges`) may set any field to `null` to clear it — modelled or not (`{styleIdForFill: null}`, `{exportSettings: null}`; TS type `NodeFieldsPatch`); `clearedFields: [kiwi ids]` clears modelled fields (`styleIdForFill` 332, `styleIdForStrokeFill` 333, `styleIdForText` 334, `styleIdForEffect` 335, `styleIdForGrid` 336, `variableModeBySetMap` 316, `variableScopes` 353, …). (`styleIdFor*: {}` also reads as absent.)

**Scrubs**: every variable / style command works inside `txnBegin` … `txnCommit` (e.g. a colour drag in the variables table): applied live (users re-resolved at each call), one undo step at the commit, labelled by `txnBegin`.

**Created ids**: `engine.runCommand(name, args): {status, created: Guid[]}` — the same as `command`, plus what it created (collections, variables, modes' ids, styles; C ABI: `engine_command` leaves `{"created": […]}` in the result slot).

**Reads** (`Engine.ts`; C ABI in parentheses, JSON results):
- `variableCollections(): VariableCollectionInfo[]` (`engine_variable_collections(h)`) = `{id, name, modes: [{modeId, name}], defaultModeId, variableIds: Guid[], hiddenFromPublishing, key, description}` in the panel's order.
- `variables(collection?: Guid): VariableInfo[]` (`engine_variables(h, collPtr, collLen)`; live ones, in order) and `variable(id): VariableInfo | null` (`engine_variable(h, idPtr, idLen)`; deleted ones too) = `{id, name, collectionId, resolvedType, valuesByMode: Record<modeId, VariableValue>, resolvedValuesByMode: Record<modeId, ResolvedVariableValue | null>, scopes: VariableScope[], codeSyntax: {WEB?, ANDROID?, iOS?}, description, hiddenFromPublishing, key, deletedButReferenced}`.
- `resolveVariable(id, consumer?: Guid): ResolvedVariableValue | null` (`engine_resolve_variable`; Figma's `resolveForConsumer`; no consumer = the default modes).
- `boundVariables(ref): BoundVariable[]` (`engine_bound_variables`) = `[{target, variable: Guid | null, value: VariableValue, resolved: ResolvedVariableValue | null}]` (`variable`: the alias, or a composed colour's colour alias).
- `resolvedValue(ref, target): ResolvedVariableValue | null` (`engine_resolved_value`).
- `variableModes(ref): VariableModeInfo[]` (`engine_variable_modes`; a layer or a page) = `[{collectionId, explicitModeId: Guid | null, resolvedModeId}]` for every collection.
- `styles(type?: StyleType): StyleInfo[]` (`engine_styles(h, type)`) = `{id, name, styleType, description, key, hiddenFromPublishing, usageCount, fillPaints? | effects? | layoutGrids? | text?: {fontName, fontSize, lineHeight, letterSpacing, paragraphSpacing, paragraphIndent, textCase, textDecoration}, boundVariables: BoundVariable[]}` in the panel's order; `styleUsage(id): number` (`engine_style_usage`).

**Events**: `VARIABLES_CHANGED {collections: Guid[], variables: Guid[]}` and `STYLES_CHANGED {styles: Guid[]}` (a style or its usage changed) after any commit, undo, redo, remote change or load that touched them; `NODES_CHANGED` sets `BINDINGS` (128) for nodes whose bindings, styles or modes changed (their re-resolved fields also set their own groups).

**Instances**: a sublayer's bindings and modes are overridable (`setProps` / `BIND_VARIABLE` / `SET_VARIABLE_MODE` on an `I…` ref write the override; on an instance, its root override). An override entry's `parameterConsumptionMap` is **sparse, per field** (as Figma's files store it: 18 of 38 bound instances in a real file carry root overrides holding only the changed fields): its entries replace the main's for their `variableField`, and an entry **without `variableData`** removes that field's binding there (our encoding of "detached on this instance"; Figma's is unverified). An instance root's bindings are its main root's, plus its own component-property (PROP_REF) entries, plus its root override.

## Status (2026-10-07): E6 variables, modes and styles

Everything in the API above is in. Green: `npm run engine:test` (201 doctest cases, ASan/UBSan; new `tests/unit/variables.test.cpp`, 22 cases incl. the C ABI), `npm run check` (`engine.wasm.test.ts` drives variables, modes, styles and a 10k-layer mode switch through the real Wasm), `npm run engine:shot` (52 checks; the new ones alone: `SHOT_ONLY=vars`). Release wasm: 2102 KB (was 1972 KB; +127 KB of code — see "size" below).

Screenshots: `50-variables-modes` (a Light and a Dark frame holding the same bound content: surface / card / text colours, corner radius, auto-layout padding, a text bound to a STRING, a colour style holding a composed colour = an alias into another collection at an opacity variable, and an instance of a bound component in each frame — the Dark one resolves padding 32, radius 24, the accent at 40 %), `51-mode-switch` (the Light frame switched to Dark, and a primitive's value edit reaching both accents through the alias chain, the style and the instances).

### How it works (decisions)
- **Data** (`scene/Node.h`, `scene/CodecJson`): `VariableData` is typed (literals, alias by GUID or by assetRef key, COMPOSE_COLOR and other expressions, font styles, PROP_REF; anything else — Figma's MAP / RESOLVE_VARIANT — kept whole); `Paint.colorVar/opacityVar/stopsVar`, `Effect.*Var`, `LayoutGrid.*Var` are typed; 17 new node fields (`variableModeBySetMap`, the five `styleIdFor*`, `styleType`, `sortPosition`, `description`, `key`, `isPublishable`, `variableSetModes`, `variableSetID`, `variableResolvedType`, `variableDataValues`, `variableScopes` (absent ≠ empty), `codeSyntax`). Figma's "none" GUID (`4294967295:4294967295`) reads as absent.
- **Resolution** (`editor/Variables.cpp`): styles are copied into their users first (FILL → fills or strokes, EFFECT, GRID, TEXT → the eight typography fields plus the style's typography bindings), then every binding resolves for the node's modes: the nearest explicit mode for each collection walking up through frames, sections, pages and — for sublayers — the instance chain; a mode the collection no longer has counts as Auto; an alias chain uses the consumer's mode of each collection it crosses, depth ≤ 16; a missing entry falls back to the default mode's value; a type mismatch, a cycle or a missing target leaves the field's stored value. Resolved values are system writes in the same transaction (one `DOCUMENT_CHANGED`, one undo step). Library references by key (imported `.fig`) resolve through a key → asset index.
- **Units** (Figma's, R3-49 and inference): a number bound to layer or paint opacity is a percentage (clamped); a composed colour's opacity likewise; layout-guide counts are rounded; `LINE_HEIGHT` keeps RAW (the UI's %) or becomes PIXELS from Auto; `FONT_STYLE` from a FLOAT weight maps to Figma's named weights (Thin … Black, Italic kept).
- **Dependencies** (Materializer spirit): each consumer records the variables, collections and styles its resolution read (missing ones too); a value, mode-list or style change re-resolves exactly those consumers; an explicit mode, a move or a creation re-resolves the subtree (an instance whose sublayers are bound re-materializes). Instance sublayers resolve while materializing (before their layout, so bound sizes / paddings lay out right).
- **Detach on edit** (Figma): `write()` turns a user's edit of a bound value into a detach — the binding goes, a changed paint colour / opacity drops its `colorVar` / `opacityVar`, changed fills / strokes / effects / guides / typography drop the style; on sublayers the same happens in the override.
- **Deletes**: a variable still used (by a layer, a style or another variable's alias) is soft-deleted (`isSoftDeleted`, Figma's deletedButReferenced) and keeps resolving; a collection with such variables too. A deleted style detaches its users (and override entries naming it).
- **Defaults** (unverified against Figma, kept in one place in `VariableCommands.cpp`): collection "Collection" with "Mode 1"; new modes "Mode N" with the default mode's values; variables "Color" / "Number" / "String" / "Boolean" (+ " 2"…) = white / 0 / "" / false; copies "… copy"; styles "Color style" / "Text style" / "Effect style" / "Layout guide style"; a new effect style = drop shadow black 25 % y 4 blur 4; a new layout guide style = a 10 px grid, red 10 %; undo labels "Create collection", "Add mode", "Create variable", "Edit variable", "Apply variable", "Detach variable", "Apply variable mode", "Create style", "Apply style", "Detach style", "Delete style", "Set as default"….
- **Limits** (Figma's REST rules): 40 modes, mode names ≤ 40 characters, 5,000 variables per collection, variable names unique in their collection without `.` `{` `}`; scopes normalized (ALL_SCOPES alone; ALL_FILLS drops the fill kinds; the plugin API's `STROKE_COLOR` / `FONT_WEIGHT` read as `STROKE` / `FONT_STYLE`).
- **Performance**: a mode switch over 10,000 bound layers: 21 ms native release, 48 ms warm in the Wasm including the 10k-change `DOCUMENT_CHANGED` and `NODES_CHANGED` marshalling (target < 50 ms); a value edit 14 ms native. Found on the way: `write()` built three large `NodeChange`s per call, the undo batch relocated them as it grew, `ChangeSet::build` moved each — now built lazily / in place (`UndoBatch::inverse` is a deque).
- **Size**: inlining `NodeProps` / `Paint` construction and destruction at every write site cost ~240 KB of Wasm; their special members are now out of line and never inlined (`Node.cpp`), which more than paid for this round.
- **Samples**: `docs/research/figma/samples/*.fig` carry **no** variables or styles (checked: only DOCUMENT/CANVAS/FRAME/SYMBOL/INSTANCE/…); the encoding was checked against a real 9k-node Figma file of the owner's instead (25 collections, 324 variables, 37 styles: `assetRef`-keyed references, `variableSetModes`, `variableDataValues`, `codeSyntax`, `variableScopes`, `FONT_STYLE` bindings, style nodes with `styleType`, sparse override maps) — the tests reproduce those shapes, the file itself isn't in the repo.

### Not done / next
- Libraries (published keys, library copies, updates; next round). Copy/paste between files doesn't carry the variables / styles a selection references yet (schema.md §4.1).
- Variable-driven variants (`VARIANT_PROPERTIES` / RESOLVE_VARIANT), `GRID_ROW_GAP` / `GRID_COLUMN_GAP` (grid layout isn't modelled), `HYPERLINK`, `FONT_VARIATIONS`, per-run text bindings and per-range text styles are kept as data, not applied. Timing / Easing values are data (`@later`). Extended collections are not modelled.
- Figma's `variableConsumptionMap` (the legacy twin it still writes) is kept as an unknown field, not read.
- Soft-deleted variables nobody uses any more are not collected on load (components' are).

**Ids.** An instance's sublayers are derived (never stored). Their refs are Figma's strings `"I<instance>;<key>;<key>…"` (keys = `overrideKey ?? guid` of the main's nodes, crossing nested instances: docs/schema.md §5.1), e.g. `"I1:38;1:42"`. Every API that takes or returns a ref (`getSelection`, `setSelection`, `readNodes` incl. `childIds`, `setProps`, `setHover`, `hitTest`, events, `startTextEdit`, `textLayout`, `componentInfo`, commands' `ref` args) accepts them. A real INSTANCE's `childIds` are its derived sublayers. Derived nodes never appear in `DOCUMENT_CHANGED`, `encodeDocument` or the clipboard's ids.

**Node fields** (`NodeFields`, schema names; GUIDs inside these structures are `{sessionID, localID}` objects on output, `"s:l"` strings are read too):
`overrideKey`, `symbolData {symbolID, symbolOverrides: [{guidPath: {guids: Guid[]}, …overridden fields}], uniformScaleFactor}` (the root's entry has an empty/absent `guids`), `overriddenSymbolID` (in override entries), `componentPropDefs [{id, name, type: "BOOL" | "TEXT" | "INSTANCE_SWAP" | "VARIANT" | "SLOT", initialValue {boolValue | textValue {characters} | guidValue}, sortPosition, preferredValues {instanceSwapValues [{type: "COMPONENT" | "STATE_GROUP", key}]}, description, slotPropConfig, varValue}]`, `componentPropAssignments [{defID, value}]`, `parameterConsumptionMap {entries: [{variableField, variableData: {dataType: "PROP_REF", resolvedDataType, value: {propRefValue: {defId}}}}]}`, `isStateGroup`, `variantPropSpecs [{propDefId, value}]`, `stateGroupPropertyValueOrders [{property, values}]`, `propsAreBubbled`, `isSlot`, `isSlotContent`, `detachedSymbolId {guid}`, `isSoftDeleted`, `ancestorPathBeforeDeletion: Guid[]`. `derivedSymbolData` is derived: dropped on read, never written. Preferred-value `key` for local components = the main's GUID string `"s:l"`.
- An INSTANCE's own fields are its root's effective values (written by the engine). `setProps` on an instance or a sublayer writes **overrides** (Figma's whitelist: name, visible, locked, opacity, blend mode, size, fills, strokes and stroke settings, corner radii/smoothing, effects, layout guides, text content and every text style field, auto-layout sizing/alignment/spacing/padding, min/max, exportSettings, componentPropAssignments, overriddenSymbolID); fields bound to a component property write the instance's property value instead; structural fields (transform/position, parent, constraints, stackMode, vectorData…) are refused on sublayers. Layers can't be added, removed or reordered inside an instance (⌫ on a sublayer hides it, as Figma).

**Commands** (`abi.ts CommandId`; `engine.command(name, args)`; args values may be strings, numbers, booleans or string arrays; `ref` defaults to the selection; undo labels are Figma's):
`CREATE_COMPONENT` 120 (⌥⌘K; args `{mode?: "SINGLE" | "MULTIPLE" | "SET"}`, default SINGLE for one layer, MULTIPLE for several: "Create component", "Create multiple components", "Create component set"), `COMBINE_AS_VARIANTS` 121, `ADD_VARIANT` 122, `DETACH_INSTANCE` 123 (⌥⌘B), `RESET_OVERRIDES` 124 (args `{ref?, field?}`: Reset all changes, or Reset › one property by its schema field name, e.g. `"fillPaints"`), `PUSH_CHANGES_TO_MAIN` 125, `GO_TO_MAIN_COMPONENT` 126 (⌃⌥⌘K: selects the main, switches page, zooms to it; then `INSTANCE_NAVIGATION`), `RETURN_TO_INSTANCE` 127, `SWAP_INSTANCE` 128 (args `{main: Guid, ref?}`), `SET_COMPONENT_PROPERTY` 129 (args `{ref?, prop: defId | name, value: boolean | string | Guid}`; VARIANT: the value name; INSTANCE_SWAP: a main's GUID), `ADD_COMPONENT_PROPERTY` 130 (args `{ref?, name, type, defaultValue?, bind?: Guid[], preferredValues?: Guid[]}` on a main or set), `EDIT_COMPONENT_PROPERTY` 131 (args `{ref?, prop, name?, defaultValue?, preferredValues?, oldValue?, newValue?}`; VARIANT values renamed with oldValue → newValue), `DELETE_COMPONENT_PROPERTY` 132 (args `{ref?, prop}`), `BIND_COMPONENT_PROPERTY` 133 (args `{refs?: Guid[], field: "VISIBLE" | "TEXT_DATA" | "OVERRIDDEN_SYMBOL_ID", prop}`; prop `""` unbinds), `RESTORE_COMPONENT` 134 (args `{ref?}`: an instance whose main was deleted), `SET_EXPOSED_INSTANCE` 135 (args `{ref?, exposed: boolean}`: a nested instance inside a main), `RESET_SLOT` 136 (args `{ref?}`), `INSERT_INSTANCE` 137 (args `{main, x?, y?, parent?}`: an instance of a main — a set: its default variant — centred at the page point, else the view's centre; into `parent`, else the frame under the point, else the page; selected; "Insert instance"), `SET_VARIANT_PROPERTIES` 138 (args `{ref?, values: {[property]: value}}`: a variant's own values in its set; renames it). `RESET_OVERRIDES` also takes `fields: string[]`. `BIND_COMPONENT_PROPERTY` takes `"SLOT_CONTENT_ID"` (and marks the frame `isSlot`). `commandState` gives CMD_ENABLED for each. `engine.command` args are typed `CommandArgValue` (number | string | boolean | string[] | Record<string, string>). Shortcuts: ⌥⌘K, ⌥⌘B in `shortcuts.ts`; ⌃⌥⌘K stays in the editor's registry. `src/shared/commands.ts` gains `object.create-multiple-components`, `object.combine-as-variants`, `object.add-variant`, `object.detach-instance`, `object.go-to-main-component`, `object.push-changes`, `object.reset-all-changes`, `object.restore-component`, `view.layers` (⌥1), `view.assets` (⌥2).
- Copy/paste, ⌘D and ⌥-drag of a main component make **instances** in the same file (R4 §2); of a component set, a new set; ⌘D of a variant inside its set, a new variant. Deleting a main that has instances moves it to the internal canvas (`isSoftDeleted`); instances keep rendering; `RESTORE_COMPONENT` puts it back.

**Reads.** `engine.componentInfo(ref): ComponentInfo | null` (C ABI `engine_component_info(h, refPtr, refLen)`):
`{ref, kind: "COMPONENT" | "VARIANT" | "COMPONENT_SET" | "INSTANCE" | "NESTED_INSTANCE" | "INSTANCE_SUBLAYER" | "COMPONENT_SUBLAYER" | "NONE", main: {ref, name, page, set, softDeleted} | null, instance: Guid | null (the top-level instance holding a sublayer), path: Guid[], overrides: [{ref, fields: string[]}], properties: ComponentProperty[], exposedInstances: [{ref, name, properties}], variantProperties: Record<string, string> | null, canPush, canReset, canDetach, isExposed, mainDeleted, instanceCount}`;
`ComponentProperty = {id: Guid, name, apiName ("Name#id"; VARIANT: the name), type, defaultValue, value, overridden: boolean, preferredValues: Guid[], variantOptions: string[], boundLayers: Guid[]}` (values: boolean for BOOL, string for TEXT and VARIANT, a Guid for INSTANCE_SWAP / SLOT, null when none).
**Thumbnails**: `engine.renderNodeThumbnailPixels({node, maxSize}) → Pixels | null` (one node's subtree alone, transparent around it; C ABI `engine_render_node_thumbnail(h, refPtr, refLen, maxSize, flags)`, same result layout as `engine_render_thumbnail`). `engine_ref_id(ptr, len)` resolves a derived ref to its localID in session `0xFFFFFFFE` (Engine.ts uses it for the calls taking `(sessionID, localID)`).
**Events**: `COMPONENTS_CHANGED {refs: Guid[]}` (instances re-derived and the mains they come from, after any change that reached them), `INSTANCE_NAVIGATION {main: Guid | null, returnTo: Guid | null}` (after GO_TO_MAIN_COMPONENT / RETURN_TO_INSTANCE); `NODES_CHANGED` includes derived refs (group COMPONENT = 64 for component fields). `engine.returnToInstance` holds the last `returnTo`.
**Canvas**: components, sets and instances select and hover in the component purple (`#9747FF` light, `#8A38F5` dark); a set is a FRAME with its dashed purple stroke; click picks an instance whole, double-click / Enter / ⌘-click go inside; text editing inside an instance writes overrides.

## Status (2026-10-07): E6 components and instances

Everything in the E6 API above is in. Green: `npm run engine:test` (179 doctest cases, ASan/UBSan; new `tests/unit/components.test.cpp`, 19 cases), `npm run check` (55 files / 488 tests; `engine.wasm.test.ts` drives components through the real Wasm), `npm run engine:shot` (44 checks; the E6 ones alone: `SHOT_ONLY=e6`), the editor's `EDITOR_ONLY=components node src/renderer/src/editor/tools/editor-shot.mjs` (24/24). Release wasm: 1972 KB (was 1.72 MB).

Screenshots: `40-instance-selected` (structure.fig: Figma's own instances — "XYZ" text override, red fill override — the instance picked whole, purple box), `41-component-set-instance` (Create component + Add variant: a set with Figma's dashed purple stroke, an inserted instance with a text override, selected in purple).

### How it works (decisions)
- **Derived rows** (`editor/Instances.cpp`): each real INSTANCE is materialized into rows of the same `Document` (ids in session `0xFFFFFFFE`, interned per path in `base/DerivedIds`, printed `I<instance>;<key>…`), so drawing, hit-testing, layout, text and geometry need no instance code. Rows are written directly (never in a transaction's message, undo or `encodeDocument`); the instance's root fields are system writes in the transaction. One expansion per top-level instance: the main's subtree, then override entries by path (usage site over each nested instance's own, `OverrideStack`), then PROP_REF bindings (VISIBLE / TEXT_DATA / OVERRIDDEN_SYMBOL_ID / SLOT_CONTENT_ID) from the level's assignments or the defaults; nested instances recurse into their (swapped) main, depth ≤ 16, cycle-guarded.
- **Dependencies** (Materializer spirit): every real node read while deriving (mains, their nodes, sets, nested mains, missing mains) points back to the instance (`sourceDeps_`); `noteChange` marks those instances (and any instance whose non-own fields changed) dirty; `flushLayout` alternates layout and re-derivation until both settle, in every transaction kind (undo, redo, remote, load: re-derived in the same commit; a cancelled gesture re-derives in a SYSTEM step).
- **Instance layout**: stage A lays the subtree out alone (hug sizes, auto-resize texts measured, groups fitted, no constraints); that geometry is the blueprint `LayoutHost::base` answers for derived rows, and `resizedInTxn` answers the main's sizes for the instance and its frames, so constraints map main size → instance size and re-running layout never drifts. (Layout fix found on the way: `base` ignores a txn-start transform when the node changed parent in the transaction.)
- **Edits**: `write()` routes derived ids — layout/materializer writes apply directly; user edits become override entries on the top-level instance (Figma's whitelist), or property values when the field is bound (on the instance, or an override entry of the nested level); text in instances keeps its layer name. Edits of an instance's own root fields record its root override; non-overridable fields are refused. Layers can't be created in / moved into instances; ⌫ hides; group/duplicate/align/booleans/vector edit refuse derived selections. A layer dropped / drawn / pasted into an instance's slot creates its content frame (`isSlotContent`, real, under the instance) with copies of the slot's default content: the whole slot diverges; the materializer keeps the content frame over the slot; RESET_SLOT drops it.
- **Commands** (`editor/ComponentCommands.cpp`): a frame converts to a component in place (`type` now emitted in DOCUMENT_CHANGED: ChangeSet no longer drops F_TYPE), anything else is wrapped; Combine as variants names properties from `Prop=Value` names or slash names (Variant, Property 2…; R4), a set is a FRAME with `isStateGroup`, 20 px padding, a 1 px dashed (10/5) `#9747FF` inside stroke, radius 5; property def ids count down from `0x7fffffff` in the session (as the editor's `nextDefId`). Variant switch / swap remap overrides by key, then by layer names along the path; a variant switch keeps a changed field only where both variants started equal (text and names travel by name). Detach rebuilds the derived subtree as real nodes (nested instances stay instances with their composed overrides; `detachedSymbolId`); a nested target detaches its ancestors first. Push applies entries to the main's nodes (into nested instances' overrides past a nested boundary). Deleting a main (or set) with instances moves it to the internal canvas (`isSoftDeleted`, `ancestorPathBeforeDeletion`); unused soft-deleted mains are removed on load (SYSTEM).
- **Copy rules** (R4 §2/§8): ⌘C/⌘V, ⌘D and ⌥-drag of a main make instances of it when it is in this file; a set copies as a new set; ⌘D of a variant adds a variant; copies of whole components keep `overrideKey`s, other copies get none. Instances of variants are named after their set.
- **Canvas**: hover / selection / handles / badge / titles of components, sets and instances in `OverlayStyle::component` (light `#9747FF`, dark `#8A38F5`, from the chrome palette); dashed frame strokes go through the stroker. Picking takes a top-level instance whole; inside after it is selected or with a double-click / Enter / ⌘.

### Not done / next
- Libraries (published keys, library copies on the internal canvas, updates) and variables are the next rounds; `preferredValues` keys are local GUIDs for now. `uniformScaleFactor` (scale tool) is kept but not applied.
- Performance targets (1k instances re-derived in < 30 ms) are unmeasured; every re-derivation rebuilds the whole instance and re-shapes its texts.
- A diverged slot's content draws above the instance's other layers (a real child of the instance). Slot settings (min/max, preferred-only) are data only.
- Name-match heuristics for swaps follow R4's text; Figma's exact hierarchy similarity rule is unverified. "Add variant" places the copy below the variant it comes from.
- Main components inside other files pasted as instances (cross-file, library) are not handled: a main from another file pastes as a new main.

## E4 + E5 API — final names (all implemented; status below)

**Wire format additions** (`codec.ts`, `scene/CodecJson`):
- `Message.blobs?: string[]` — the Message's blobs as **base64** strings; blob-index fields (`vectorData.vectorNetworkBlob`, `fillGeometry[i].commandsBlob`, `strokeGeometry[i].commandsBlob`, `Image.dataBlob`) index into it, exactly as kiwi's `Message.blobs`. Every Message the engine emits (DOCUMENT_CHANGED, `encodeDocument`, `encodeSelection`, `readNodes`) carries the blobs its changes use; every Message it reads may carry them. `src/renderer/src/store/engineMessage.ts` converts base64 ⇄ `Uint8Array` (and `byte[]` fields ⇄ `number[]`).
- `byte[]` fields (`Image.hash`, `Paint.thumbHash`) travel as arrays of numbers (0–255), as the editor already writes them; the engine also reads a 40-digit hex string for `hash`.

**Node fields** (`NodeFields`; all schema names, absent = the schema's absence value):
`blendMode` (BlendMode; PASS_THROUGH for containers, NORMAL for leaves), `mask`, `maskType` ("ALPHA" | "OUTLINE" = Figma's "Vector" mask | "LUMINANCE"), `strokeCap` ("NONE" | "ROUND" | "SQUARE" | "ARROW_LINES" | "ARROW_EQUILATERAL" | "DIAMOND_FILLED" | "TRIANGLE_FILLED" | "CIRCLE_FILLED"), `strokeJoin` ("MITER" | "BEVEL" | "ROUND"), `miterLimit` (absent 4), `dashPattern: number[]`, `borderTopWeight` / `borderRightWeight` / `borderBottomWeight` / `borderLeftWeight` + `borderStrokeWeightsIndependent`, `cornerSmoothing` (0–1; iOS = 0.6), `effects: Effect[]`, `count` (polygon/star points), `starInnerScale` (star "Ratio"), `arcData {startingAngle, endingAngle, innerRadius}` (radians, 0–1), `vectorData {vectorNetworkBlob, normalizedSize, styleOverrideTable?}`, `handleMirroring` ("NONE" | "ANGLE" | "ANGLE_AND_LENGTH"), `booleanOperation` ("UNION" | "INTERSECT" | "SUBTRACT" | "XOR"), `fillGeometry` / `strokeGeometry` (read-only, derived: `[{windingRule, commandsBlob, styleID}]`).
- `Paint` (every field kept; drawn: all types): `type` SOLID / GRADIENT_LINEAR / GRADIENT_RADIAL / GRADIENT_ANGULAR / GRADIENT_DIAMOND / IMAGE, `color`, `opacity`, `visible`, `blendMode`, `stops [{color, position}]`, `transform` (Figma's gradient/image matrix: node unit square → paint space), `image {hash, name?}`, `imageScaleMode` ("STRETCH" = Crop, "FIT", "FILL", "TILE"), `rotation` (degrees, multiples of 90), `scale` (TILE), `paintFilter {exposure, contrast, vibrance (= Saturation), temperature, tint, highlights, shadows}` (−1…1), `originalImageWidth/Height`.
- `Effect`: `type` ("DROP_SHADOW" | "INNER_SHADOW" | "FOREGROUND_BLUR" (= Layer blur) | "BACKGROUND_BLUR"), `color`, `offset`, `radius`, `spread`, `visible`, `blendMode`, `showShadowBehindNode`; other fields kept.

**Tools** (`setTool`): `LINE` (L), `ARROW` (⇧L), `POLYGON`, `STAR`, `PEN` (P), `PENCIL` (⇧P) answer OK. After a shape is drawn the tool goes back to MOVE; the Pen stays in vector edit mode until Esc / Enter.

**Commands** (`abi.ts CommandId`, `engine.command(name, args)`; undo labels are Figma's):
`BOOLEAN_UNION` 100 ("Union selection"), `BOOLEAN_SUBTRACT` 101, `BOOLEAN_INTERSECT` 102, `BOOLEAN_EXCLUDE` 103, `FLATTEN` 104 ("Flatten selection", ⌘E), `OUTLINE_STROKE` 105 (⌥⌘O), `USE_AS_MASK` 106 (⌃⌘M; toggles; `CMD_CHECKED` when the selection is a mask), `PLACE_IMAGES` 107 (args `{hash, width, height, name?, x?, y?}`: a rectangle of that size filled with the image, Fill mode, at the page point or the view's centre, inside the selected frame), `VECTOR_SET_MIRRORING` 110 (args `{mirroring: "NONE" | "ANGLE" | "ANGLE_AND_LENGTH"}`: the selected vertices in vector edit mode), `VECTOR_DELETE_AND_HEAL` 111.

**Vector edit mode** (`Engine.ts`): `startVectorEdit(ref)` → Status (VECTOR, LINE, shapes and booleans can be edited; a non-VECTOR becomes a VECTOR at its first edit, same GUID), `endVectorEdit()`, `vectorEdit` (the last `VECTOR_EDIT` event while active, else null), `setVectorEditTool("MOVE" | "PEN" | "BEND")`. Double-click or Enter on a vector enters it; Esc / Enter leaves (Esc first leaves the Pen for MOVE). Keys while editing: ⌫/⌦ delete the selected vertices/segments (healing a vertex between two segments), arrows nudge vertices, ⌘A selects every vertex, ⌘ held = bend tool, ⌥ on a handle breaks mirroring, ⇧ on a click adds to the selection. One undo step per edit operation.
- Event `VECTOR_EDIT {active, ref, tool: "MOVE" | "PEN" | "BEND" | "LASSO" | "PAINT_BUCKET", selectedVertices: number[], selectedSegments: number[], vertexCount, segmentCount, mirroring: "NONE" | "ANGLE" | "ANGLE_AND_LENGTH" | "MIXED" | null, points: [{index, x, y, cornerRadius, mirroring}]}` whenever editing starts, ends, or its selection / tool / network changes. While the Pen draws, `TOOL_CHANGED` says PEN; Move / Bend / Lasso / Paint bucket show as MOVE.

- **Points section** (the editor's request): `VECTOR_EDIT` also carries `points: [{index, x, y, cornerRadius, mirroring}]` for the selected vertices — `x`/`y` in the node's parent's space (the same space as the layer's X / Y), `cornerRadius` the vertex's own (absent override = the node's `cornerRadius`). Writes: command `VECTOR_SET_POINTS` 112 with args `{x?, y?, cornerRadius?}` — `x`/`y` move the selected points so their bounds' top-left lands there (one point: that point), `cornerRadius` sets each selected vertex's radius (a per-vertex style in `vectorData.styleOverrideTable`). One undo step each.
- **Start / end caps** (Figma's Start point / End point for open paths and lines): `engine.endCaps(ref)` → `{start: StrokeCap, end: StrokeCap} | null` (null: the node has no open path); command `SET_END_CAPS` 113 with args `{start?: StrokeCap, end?: StrokeCap}` on the selected VECTOR / LINE nodes (per-vertex `strokeCap` styles on each open chain's first / last vertex; a LINE gets a two-vertex network). `strokeCap` on the node still sets both. C ABI `engine_end_caps(h, s, l)`.
- **Vector edit tools**: `setVectorEditTool("MOVE" | "PEN" | "BEND" | "LASSO" | "PAINT_BUCKET")` — LASSO (Q) selects the vertices inside a freehand loop; PAINT_BUCKET (B) toggles the fill of the closed area under a click (adds / removes a network region).
- **Layout guides**: `layoutGrids: LayoutGrid[]` is typed (`{type: "MIN" | "CENTER" | "STRETCH" | "MAX", axis: "X" | "Y", visible, numSections, offset, sectionSize, gutterSize, color, pattern: "STRIPES" | "GRID"}`, other fields kept) and drawn on frames (columns / rows / grid, Figma's colours as given), toggled with the frame's own visibility.

**Gradient (paint) edit mode**: `startPaintEdit(ref, {paints: "FILL" | "STROKE", index})` → Status (a gradient paint: on-canvas handles — start, end, width — and the stops on the line; dragging a stop moves it, a click on the line adds one, ⌫ deletes the selected stop), `endPaintEdit()`, `setPaintEditStop(index)` (the panel's stop selection), `paintEdit` (the last `PAINT_EDIT` while active). Event `PAINT_EDIT {active, ref, paints, index, stop}`. Each drag is one undo step.

**Images**: event `REQUEST_IMAGE {hash}` (hash = 40 hex digits, once per hash, again after a GPU eviction). `engine.setImageSource(load: (hash) => Promise<Uint8Array | null>)` — Engine.ts then answers every request itself (decodes with `createImageBitmap`, uploads with `texImage2D(ImageBitmap)` through an EM_JS helper, mipmapped); without a source the event is still emitted. `engine.addImageBytes(hash, bytes)` → Promise<Status>, `engine.addImage(hash, bitmap)` → Status, `engine.imageFailed(hash)` (drawn as Figma's grey placeholder). While an image loads its paint draws as `#E6E6E6`.

**C ABI** (exports.txt, EngineExports.ts): `engine_image_add_bitmap(hashPtr, bitmapId, w, h)`, `engine_image_add_rgba(hashPtr, w, h, ptr, len)` (headless / Node), `engine_image_failed(hashPtr)` (hashPtr: 40 hex digits), `engine_vector_edit(h, s, l)`, `engine_vector_edit_end(h)`, `engine_vector_edit_tool(h, tool)` (MOVE 0, PEN 1, BEND 2, LASSO 3, PAINT_BUCKET 4), `engine_end_caps(h, s, l)`, `engine_paint_edit(h, s, l, paints, index)` (paints: 0 fills, 1 strokes), `engine_paint_edit_end(h)`, `engine_paint_edit_stop(h, index)`. `engine_stats` adds `glyphs`, `paths`, `layers`, `curveTexels`, `images`, `imageBytes`. ABI version stays 1 (additions only).

**Engine.ts** (besides the above): `vectorEdit` / `paintEdit` (the last VECTOR_EDIT / PAINT_EDIT while active), `endCaps(ref)`, `imagesSettled()` (every REQUEST_IMAGE answered), `addImageRgba(hash, w, h, rgba)`. `shortcuts.ts` adds L, ⇧L, P, ⇧P, ⌥⇧U/S/I/E, ⌘E, ⌥⌘O (⌃⌘M stays in the editor's registry: `Shortcut` has no ⌃). `cursors.ts` draws the pen nib (PEN, PEN_ADD, PEN_REMOVE, PEN_CLOSE). `CanvasController` counts clicks itself (Chromium's pointer events have no `detail`), so double-clicks reach the engine.

## Status (2026-10-07): E4 vectors + E5 paints, effects, images

Everything in the API above is in, tested natively and in the browser. Green: `npm run engine:test` (160 doctest cases, 75,173 assertions, ASan/UBSan), `npm run check` (types, lint, 53 test files / 461 tests, including the real Wasm in Node), `npm run engine:shot` (32 checks, all ok; the E4/E5 ones alone: `SHOT_ONLY=e4 npm run engine:shot`). The committed **release** wasm: 1.72 MB (616 KB gzip; was 1.28 MB / 470 KB): Clipper2, the geometry, the stroker and the new renderer.

Screenshots (`npm run engine:shot -- <dir>`, headless Chromium, SwiftShader): `30-structure-fig` (structure.fig: the Sketch logo's 8 vectors, both images, the group's drop shadow — as Figma's own thumbnail of the file shows them), `31-e4-sheet` (shapes, strokes, gradients, image modes, effects, blend modes, masks), `32-star-close` (a star at ~1000 %: crisp), `33-pen`, `34-vector-edit`, `35-boolean`, `36-gradient-handles`.

### How it works (decisions)
- **Data** (`scene/Node.h`, `scene/CodecJson`): the field mask is 128 bits now (74 properties). Paints are fully typed (gradients, images, filters; other members kept in `Paint::extra`), as are effects, vector data (`Bytes` = shared immutable blob bytes), arcs, stroke caps / joins / dashes, per-side weights, corner smoothing, masks, blend modes, layout guides. A Message's blobs travel as base64 (`codec::BlobsIn` / `BlobsOut`); `fillGeometry` / `strokeGeometry` are derived and dropped on read (the engine computes them).
- **Geometry** (`geometry/`): `Path` (Figma's commandsBlob both ways, bounds, flattening, cubics → quadratics within a tolerance), `VectorNetwork` (the blob both ways, byte for byte; regions → fills, chains → strokes, per-vertex corner radius, from a path), `Shapes` (Figma's radius clamp, the squircle for corner smoothing — the published Figma construction, arcs / pies / donuts, polygons and stars stretched to their box, rounded corners), `Stroker` (polyline stroking where every segment, join and cap is its own positively wound piece unioned by NONZERO: robust on any input; miter limit, round / bevel joins, caps, arrowheads, dashes by arc length), `Boolean`, `NodeGeometry` (the per-node cache: what a node's fills and strokes cover, keyed by its inputs; booleans computed live from their operands; text from its glyph outlines).
- **Booleans: Clipper2** (2.0.1, Boost licence, vendored in `third_party/clipper2`, only `clipper.engine.cpp` compiled, `USINGZ`) on the flattened operands, with **curve recovery**: every flattened point carries its source curve and parameter in Clipper's Z, intersections get the parameters on both curves (Z callback), and runs along one source curve are turned back into that curve's exact Bézier section. Booleans keep their curves (two circles union to arcs of the original cubics) and Clipper does the hard part (overlaps, touching edges, self-intersections). This replaces engine.md's planned paper.js port (§12, §14 Q4).
- **Paths on the GPU: curve coverage, not stencil-then-cover.** E3's glyph method extended to every path (`render/CurveCache`, `gfx/gl/Shaders.h kPath*`): a path's quadratics in one RGBA32F texture with horizontal and vertical **bands** (each band's curves sorted for early exit, so thousands of curves stay cheap), one instanced quad per path, per-pixel coverage from a ray along +x and one along +y, **NONZERO or ODD**, and an optional second path multiplied in or out (INSIDE / OUTSIDE strokes = the 2×-weight outline × the fill's coverage). Anti-aliased analytically: no MSAA, no stencil, crisp at every zoom (the approximation level follows the zoom by powers of two). `render/CurveCoverage.h` is the same math in C++ for the tests. Decided over engine.md §6.3's stencil + Loop-Blinn + MSAA (the canvas has no MSAA; §14 Q3 is moot).
- **Paints**: one instance layout for shapes, paths and glyphs (`render/DrawInstance.h`, 7 vec4s) with the paint's matrix (local → paint space); gradients from a ramp atlas (256 premultiplied texels per stop list, interpolated premultiplied, dithered); LINEAR `t = x`, RADIAL `2|p − ½|`, ANGULAR `atan2` from +x clockwise, DIAMOND `2(|x − ½| + |y − ½|)` in Figma's gradient space; images by `imageScaleMode` (FILL cover, FIT contain, STRETCH = Crop through `Paint.transform`, TILE at `scale`, `rotation` in 90° steps) with the adjustments as shader math (curves unverified against Figma). A paint with its own blend mode goes through a layer.
- **Images** (`render/ImageCache`): the module-wide registry (bitmap ids or RGBA) + per-renderer mipmapped textures, 512 MB budget, least recently drawn out (re-uploaded from the registry). REQUEST_IMAGE once per hash. While loading, Figma's grey `#E6E6E6`.
- **Layers and effects** (`render/Renderer.cpp`): a node needing one (opacity on a container or on several paints, a blend mode, layer blur, shadows the analytic path can't do) is recorded into a layer — its own target from a pool, sized to its device bounds — run before its parent's pass, post-processed and composited (`kComposite*`: opacity, all 18 blend modes from the backdrop via copyTexSubImage, alpha / luminance masks, drop shadows knocked out by the node, inner shadows). **Shadows**: rectangles and frames with an opaque fill (and clipped children) use Evan Wallace's analytic blurred rounded rectangle (drop and inner, spread, per-corner radius); anything else (ellipses, vectors, text, groups — structure.fig's "Group 2") renders its alpha, dilates / erodes by the spread, blurs (σ = radius / 2, separable Gaussian, halving the image while σ > 8 texels) and composites. **Layer blur** blurs the layer; **background blur** copies the backdrop, blurs it and paints it into the node's shape before its fills. **Masks** (a child with `mask`): the mask and the layers above it each into a layer, composited by the mask's alpha or luminance (OUTLINE: its geometry, opaque). Shadow offsets don't turn with the node (as Figma). The canvas is RGBA now (`alpha: true`): WebGL2 refuses to copy an RGB framebuffer into an RGBA8 texture.
- **Frame titles** read the page colour's luminance: white at 70 % on dark pages (Figma's secondary text on dark), black at 50 % on light ones (`Renderer::titleColor`).
- **Editing** (`editor/VectorEditing.cpp`, `VectorCommands.cpp`, `PaintEditing.cpp`): the shape tools (L / ⇧L / polygon / star: Figma's defaults — lines a 1 px black centre stroke, polygons 3 points, stars 5 at 38.2 %, ⇧ at 45°); the Pen (a click a point, a drag its mirrored handles, back on the first point a closed filled loop, a click on a segment splits it, each point one undo step, Esc ends the path, then the Pen, then the mode); the Pencil (simplified within a screen pixel, Catmull-Rom curves, 2 px round strokes); vector edit mode (vertices, segments, handles with the vertex's mirroring — ⌥ breaks it —, ⌘ / BEND to bend a segment or toggle a point sharp ↔ smooth, marquee and lasso, paint bucket, ⌫ delete-and-heal, arrows nudge, ⌘A, the box refitted after every edit, a shape becoming a VECTOR at its first edit); booleans (the style from the topmost layer, the bottom one for Subtract — unverified against Figma), Flatten (into the topmost layer's GUID), Outline stroke (a filled shape keeps its fill and gets a new vector for its stroke; otherwise it becomes the outline; the outline is polylines at 0.02 px), Use as mask (several: grouped with the bottom one as mask), Place image; gradient handles (start / end, or centre / end / width; the width handle stays square to the axis; stops on the line; a click adds one in the colour there; ⇧ snaps to 10 %).

### Not done / next
- **Tiles** (engine.md §6.9, part of E5's plan) and the 100k-node performance targets: still direct mode, every layer re-rendered each frame.
- On-canvas arc handles for ellipses, image crop handles, per-paint blend modes on strokes, progressive blur / noise / glass / texture effects, effect blend modes other than NORMAL, `thumbHash` placeholders, colour management (Display P3).
- Outline stroke and Flatten keep no curves for stroke outlines (polylines); Figma's arrowhead sizes, image adjustment curves, boolean styling and the luminance threshold for titles are unverified against Figma.
- The editor's `editor-shot` "L + drag draws a line" check drags at canvas y ≈ −80 (off the canvas: the camera moved earlier in that run) — the check should zoom to fit first; the engine's line tool itself is tested (`editor.vector.test.cpp`, `engine.wasm.test.ts`).
- ImageBitmaps handed to the engine are kept for the session (`Module.engineBitmaps`): no release yet.

## Status (2026-10-07): E3 text

E3 is in: fonts, HarfBuzz shaping, line breaking, text layout with every TextData field the schema keeps, glyph drawing, the Text tool and in-engine editing with IME, overlay text (size badge, frame titles, measurement numbers), text in auto layout (Hug, Fill, Align text baseline). Plus the editor's three requests: min/max relayout, unknown node types and fields round-trip, layout on load.
- `npm run engine:test`: 139 doctest cases, 74,788 assertions (ASan/UBSan). New: `text.layout.test.cpp` (shaping vs Figma's numbers, line heights, breaking, alignment, truncation, case, decorations, runs, missing fonts, caret queries, the glyph-coverage math, structure.fig's text against Figma's own derived layout), `text.edit.test.cpp` (tool, typing, keys, mouse, IME, undo, runs, auto-resize, unknown types, min/max, load relayout, baseline), `text.render.test.cpp`.
- `npm run engine:shot`: 16/16, with the text checks (T + click + typing through the hidden field, ⌥⇧← word selection, Esc, a typography sheet, truncation, missing font). Screenshots: `/tmp/designer-work/engine-e3/` (`09-typing`, `10-text-selection`, `11-typography`, `12-text-1600`, `13-badge-titles`, `21-editor-typing`, `22-editor-text-selected`).
- `npm run check`: green except `editor/__tests__/editor.wasm.test.ts` "names layers by the file's own type where the engine reads NONE", which asserts the old bug (`readNode("1:2").type` is now `"VECTOR"`, not `"NONE"`): the editor owns that test and should flip the expectation (and can drop `noteSourceTypes`).
- Committed **release** wasm: 1249 KB (470 KB gzip; was 457 KB raw): HarfBuzz is most of the growth.

### What is vendored (engine/third_party, built by `cmake/ThirdParty.cmake`, no warnings/sanitizers)
- **HarfBuzz 14.6.0** (MIT): `src/harfbuzz.cc` amalgamation, only the files it includes kept, configured by `harfbuzz/hb-config-override.h` (no threads, env, files, serializers, hinting, math, vertical; AAT and variations kept). `-Os` in the Wasm.
- **libunibreak 8.0** (zlib): UAX #14 line breaks, UAX #29 word/grapheme breaks.
- Case mapping is **not** utf8proc (350 KB of tables): `engine/tools/gen-casemap.py` generates `src/text/CaseMap.generated.h` (Unicode 15 simple mappings as delta ranges, 9 KB) and general categories come from HarfBuzz's UCD. Turkish i/İ follow the Unicode default mapping (İ → i, ı → I; not locale-sensitive).
- **Inter 4.1** (OFL): `src/renderer/src/engine/fonts/InterVariable.ttf` + `InterVariable-Italic.ttf` (+ `Inter-LICENSE.txt`), imported with Vite `?url` (works in the app, the playground and builds). Not in `public/fonts/` as desktop.md §14 says: the engine folder is the one place every entry point shares.

### How it works (decisions)
- **Fonts** (`text/Fonts.*`): a module-wide `FontRegistry`. A `FontName` nobody answered is requested once (`REQUEST_FONT`); TS answers `engine_font_add_take` (bytes, engine owns them) + `engine_font_bind(family, style, faceId)` (the engine picks the variable font's named instance by the style name, spaces/case ignored, else the `wght`/`ital` axes the style words imply), or `engine_font_missing`. Metrics from HarfBuzz (`hhea`/`OS/2` as HarfBuzz chooses), outlines from `hb_font_draw_glyph` as quadratics in em (cubics split, ≤ 0.0004 em error).
- **Missing / loading fonts**: the text draws with Inter at its own size and keeps its characters; `missingFont` / `pendingFont` in `engine.textLayout(ref)`. Auto-resize writes are suppressed while the font is missing (Figma); a text measured while its font loaded is measured again when it arrives (one SYSTEM change). Editing a text whose font is missing is refused (`startTextEdit` → `E_UNSUPPORTED`; the panel should say Figma's "Missing fonts").
- **Fallback**: `engine_set_fallback_fonts` (TS sends `FALLBACK_FAMILIES` once: PingFang SC, Hiragino Sans, Apple SD Gothic Neo, Geeza Pro, Arial Hebrew, Thonburi, Kohinoor Devanagari, Noto Sans, Arial Unicode MS, Apple Symbols); each is requested the first time a character isn't in the text's font. Emoji (sbix) and bidi are E3.2: RTL runs shape right-to-left but runs aren't reordered.
- **Layout** (`text/TextLayout.*`): runs split by style, font coverage and script; HarfBuzz per run with the paragraph as context; greedy line filling at libunibreak's opportunities, words wider than the line broken at clusters, trailing spaces hang; letter spacing after every cluster except a line's last; line height = the line's tallest run's (Auto = round(fontLineHeight × size): 15/17/19/29 for Inter 12/14/16/24, as Figma), CSS half-leading baselines; paragraph spacing and indent; LEFT/CENTER/RIGHT/JUSTIFIED; vertical alignment in fixed boxes; ENDING truncation by maxLines or the box height with "…"; underline/strikethrough from the font's post/OS2 metrics; textCase before shaping (characters unchanged). Cached per node by the editor (`Editor::textLayout`), dropped when the node changes or a font arrives.
- **Figma check**: structure.fig's "ABC" (Inter Regular 12): our glyph x 0 / 8.28 / 16.13 vs Figma 0 / 8.11 / 15.91, baseline 11.865 vs 11.864, line height 15 = 15 (Figma used Inter 3.x; we bundle 4.1, hence the 0.2 px). The acceptance tolerance (≤ 0.5 px) holds and is tested.
- **Drawing** (`render/GlyphCache.*`, `render/TextRender.cpp`, `gfx::ShaderId::Glyph`): every glyph's quadratic curves live in one RGBA32F texture (two texels per curve); a glyph is one instanced quad over its bounds and the fragment shader computes coverage from the curves directly — a ray along +x and one along +y per pixel, roots classified by the endpoints' sides (Lengyel, JCGT 2017), each crossing's distance into the pixel as coverage, the two rays blended by proximity. It is resolution-independent (crisp from 2 % to 25,600 %), needs no MSAA, stencil or atlas, and draws inside clip stencils like shapes. **This replaces engine.md §6.3/§7.5's stencil-then-cover + MaskAtlas for glyphs** (the default framebuffer has no MSAA, so stencil-then-cover would be aliased); `render/GlyphCoverage.h` is the same math in C++ for the native tests. Fills: each run's solid fills in order (gradients/images are E5), node opacity, decorations as shapes.
- **Editing** (`editor/TextEditing.cpp`): a session = the edited node + anchor/focus in UTF-16 units. Each edit commits at once (storage gets it) and merges into the session's undo step, so a session (create + type) is **one undo step**; a text the session created and left empty is deleted and leaves no step. Keys: ←/→ grapheme, ⌥ word, ⌘ line start/end, ↑/↓ by line keeping x, ⌥↑/↓ paragraph, ⌘↑/↓ text start/end, ⇧ extends, Home/End, ⌫/⌦ (⌥ word, ⌘ line), Enter new paragraph, ⇧Enter U+2028, Tab, ⌘A, ⌘Z/⇧⌘Z (end the session, then undo/redo), ⌘B/⌘I (Bold/Italic style names), ⌘U, ⇧⌘X, Esc / ⌘Enter / a click outside end it (the text stays selected). Mouse: click, ⇧-click, drag, double-click word, triple-click paragraph. Entering: the Text tool on a text, a double-click on a text, Enter on a selected text (all selected), `engine.startTextEdit`. The caret blinks every 530 ms (`engine_next_frame_delay` returns 265 while editing).
- **Text tool** (T): a click makes auto-width text with the first line's middle on the pointer; a drag makes an auto-height box of the dragged width; both in the innermost frame under the pointer, Figma's defaults (Inter Regular 12, Auto, 0 %, black fill, autoRename), the tool back to Move. A layer is named after its characters while `autoRename`.
- **Resizing text**: a hand resize or a typed width makes auto width → auto height; a new height makes it a fixed box (Figma). An auto-width text grows from the side its alignment holds (centre, right).
- **Auto layout**: an auto-resizing text hugs its laid-out size; Fill along a horizontal flow / stretch across a vertical one wraps it at the given width (its height follows); **Align text baseline** (`stackCounterAlignItems: BASELINE`, horizontal) lines up first baselines (an auto-layout child's first child's baseline, else the bottom).
- **Overlay text**: size badge "W × H" (Inter Medium 11, white, on the selection colour, 4 px inset), measurement pills' numbers, frame titles above top-level frames (Inter Regular 11, baseline 10 px above, `#898989` on a dark page / black 50 % on a light one, the selection colour when selected, cut with "…" at the frame's width), the text selection highlight (selection colour at 30 %) and caret (1 px, 2 px from 200 %).

### Editor requests, done
1. **min/max alone relayouts**: a `minSize`/`maxSize` write marks the node; a layout root that isn't auto layout is clamped to its limits.
2. **Unknown types and fields round-trip**: `NodeType` knows every schema type (BOOLEAN_OPERATION, VECTOR, STAR, LINE, REGULAR_POLYGON, SLICE, VARIABLE, VARIABLE_SET); every NodeChange field the engine doesn't model is kept as encoded JSON (`NodeProps::extra`, `F_EXTRA`): CREATED replaces it, CHANGED merges key by key (undo restores the old values), duplicate/paste/undo/encode carry it. Non-SOLID paints are kept as they came too (`PaintType::OTHER`). Not drawn yet (E4/E5).
3. **Layout on load**: `engine_load` lays out every auto-layout frame and group; what moved is one `DOCUMENT_CHANGED` of kind SYSTEM (not an undo step). Texts keep their stored size until their font is there.

### API (final names)

**Node fields** (`codec.ts` `NodeFields`; `engine.setProps` / `readNodes`; absent = the default): `textData` {`characters`, `characterStyleIDs?` (per UTF-16 unit), `styleOverrideTable?` [{`styleID`, `fontName?`, `fontSize?`, `lineHeight?`, `letterSpacing?`, `textCase?`, `textDecoration?`, `fillPaints?`, other fields kept}], `lines?`}, `fontName` {family, style, postscript} (Inter Regular), `fontSize` (12), `lineHeight` {value, units} ({100, PERCENT} = Auto; RAW k = k × size, the UI's k·100 %; PIXELS), `letterSpacing` ({0, PERCENT}; PERCENT of size or PIXELS), `paragraphSpacing`, `paragraphIndent`, `textAlignHorizontal` LEFT/CENTER/RIGHT/JUSTIFIED, `textAlignVertical` TOP/CENTER/BOTTOM, `textAutoResize` NONE (Fixed size)/WIDTH_AND_HEIGHT (Auto width)/HEIGHT (Auto height), `textTruncation` DISABLED/ENDING, `maxLines`, `textCase` ORIGINAL/UPPER/LOWER/TITLE (SMALL_CAPS kept, drawn as ORIGINAL), `textDecoration` NONE/UNDERLINE/STRIKETHROUGH, `autoRename`. `NodeType` adds TEXT and the other schema types. `Paint.type` may be any schema paint type.
- `setProps` on a TEXT node with run fields (`fontName`, `fontSize`, `lineHeight`, `letterSpacing`, `textCase`, `textDecoration`, `fillPaints`): while that text is being edited with a non-empty selection, they go to the selected range (styleOverrideTable); otherwise to the node, and those fields are removed from every run (the whole layer takes the value), as Figma's panel does.

**Engine.ts**: `startTextEdit(ref, { selectAll? })` → Status (`E_UNSUPPORTED`: its font is missing), `endTextEdit()`, `textInput(text)`, `textComposition(text, selStart, selEnd)`, `textCompositionEnd(text)`, `textSelection()` → string, `textLayout(ref)` → `TextLayoutInfo | null` ({layoutSize, baselines[], glyphs[], decorations[], truncationStartIndex, truncatedHeight, logicalIndexToCharacterOffsetMap, **missingFont**, pendingFont}), `textEdit` (the last TEXT_EDIT event while active, else null), `pump()`. `setTool("TEXT")` answers OK now; `shortcuts.ts` maps T.

**Events** (`codec.ts`): `TEXT_EDIT` {active, ref, caretRectCss {x, y, width, height}, selStart, selEnd} whenever editing starts, ends, or the caret/selection/text changes; `REQUEST_FONT` {family, style} (Engine.ts answers it itself; listeners may watch). `NODES_CHANGED` sets the TEXT group (8) for text fields.

**Fonts** (`src/renderer/src/engine/fonts.ts`, one `fonts` service per process, attached by `Engine.create`): `fonts.list()` (every face: bundled Inter + the desktop's), `fonts.families()` → [{family, styles[]}] for the font pickers, `fonts.settled()`, `fonts.setSource(source)` (tests), `fonts.refresh()`; `matchFace`, `styleWeight`, `BUNDLED_FACES`, `FALLBACK_FAMILIES`. Request flow: engine `REQUEST_FONT` → `fonts.request` → match (family, style name, PostScript name, nearest weight with the same slant) → bytes (bundled URL, or `designer.fonts.read(id)`) → `engine_font_add_take` once per file → `engine_font_bind` → every live Engine `pump()`s (relaid text, a frame). No match → `engine_font_missing`.

**Desktop** (additive): `fonts:list` → `FontIndex {version, faces: FontFaceInfo[]}` and `fonts:read {id}` → `Uint8Array` (editor role; `src/shared/ipc.ts`), `EditorApi.fonts {list, read}` (`src/preload/editor.ts`), `src/main/fonts.ts`: scans the system/user font folders (macOS: /System/Library/Fonts, AssetsV2 font assets, /Library/Fonts, ~/Library/Fonts), parses `name`/`OS/2`/`fvar` (one face per variable-font named instance; hidden "." faces skipped), caches `userData/cache/fonts-v1.json` by path+mtime+size. Deviations from desktop.md §14: in main (not a fonts utility process), bytes over IPC (not `app://…/_font/<id>`), no `fs.watch`.

**CanvasController**: while TEXT_EDIT is active, a hidden `<textarea>` at the caret holds the focus: keys go to `engine.key` first; `beforeinput` insertText → `textInput`; composition events → `textComposition*`; copy/cut/paste on it → `textSelection` / `textInput`. The editor's keyboard layer already ignores text fields, so nothing else is needed there.

**C ABI** (in `exports.txt`, `EngineExports.ts`, `USED_EXPORTS`): `engine_font_add_take(ptr, len, faceIndex)`, `engine_font_bind(famPtr, famLen, stylePtr, styleLen, faceId)`, `engine_font_missing(famPtr, famLen, stylePtr, styleLen)`, `engine_set_fallback_fonts(jsonPtr, len)`, `engine_text_edit(h, s, l, flags)` (1 = select all), `engine_text_edit_end(h)`, `engine_text_input(h, ptr, len)`, `engine_text_composition(h, ptr, len, selStart, selEnd)`, `engine_text_composition_end(h, ptr, len)`, `engine_text_selection(h)`, `engine_text_layout(h, s, l)`. ABI version unchanged (1): only additions.

### Not done / next
- E3.2: bidi (SheenBidi) and RTL reordering, emoji (sbix PNG glyphs), lists (`lines`), OpenType feature fields (`fontVariant*` are kept in `extra` but not applied), SMALL_CAPS, variable axes beyond named instances (`fontVariations`), `leadingTrim`, `textDecorationStyle`/offset/thickness, hyperlinks.
- `derivedTextData` is not written into the document (it's `engine_text_layout`'s shape); `ENCODE_BAKE_TEXT` comes with E7.
- The IME composition isn't underlined on the canvas; styles at the caret (`styleAtCaret`) aren't in TEXT_EDIT yet — the panel can read the run under `selStart` from `textData`.
- Fonts: no `fonts:changed` watch; the fonts utility process; the Google Fonts source.
- Glyph rendering has no gamma/contrast tweak for small text yet (§14 Q2) and no atlas cache for very large documents of small text; profile before adding one.

---

## Status at handoff (2026-10-06), round 2

Round 2 is finished, except GRID and the kiwi boundary (see "Not started"). Everything below is green:
- `npm run engine:test`: 109 doctest cases, 72,470 assertions, ASan/UBSan.
- `npm run lint`; `npm test` (49 files, 407 tests across the tree; the engine's own: 3 files, 14 tests); `npm run typecheck` is clean in the engine's folders. The last run showed errors only in the desktop agent's in-progress folders (`app/`, `main.tsx`).
- `npm run engine:shot`: 9/9 browser checks.

The committed **release** wasm in `src/renderer/src/engine/wasm/` matches the source (engine.wasm 457 KB).

### API the editor uses (final names; `engineCompat.ts` detects these)

- **`Engine.ts`, new this round:**
  - `command(name: CommandName, args?: Record<string, number | string>): number`. Page commands take `{ page: "s:l" }`; the engine also accepts `engineCompat.pageArgs`'s numeric form `{ page: localID, pageSession: sessionID }` and `{ sessionID, localID }`. Without `page`, the current page.
  - `moveNodes(refs: readonly Guid[], parent: Guid, index: number): number`. `index` is in the parent's paint order (0 = bottom), counted without the moved layers. They keep their relative order and their place on the page. Pages move under the document `"0:0"`. Returns how many moved; 0 means refused (a cycle, a page under a layer, a layer under the document).
  - `encodeSelection(): Message | null`. The selected subtrees as CREATED with their source ids, parents first, plus `pastePageId` and `clipboardSelectionRegions: [{ parent, nodes, enclosingFrameOffset }]` (docs/schema.md §4.1). `null` when nothing is selected.
  - `paste(message: Message, options?: { inPlace?: boolean }): number`. Fresh ids, selects what was pasted, returns how many top-level layers that was (negative = a `Status`). Rules are in docs/engine.md §8.6.
  - `renderThumbnailPixels(options: { page?: Guid; maxSize: number }): Pixels | null`. `Pixels` = `{ width, height, pixels }`, straight RGBA8, rows top to bottom.
  - `renderThumbnail(options: { page?: Guid; maxSize: number; type?: string }): Promise<Blob | null>`. A PNG by default, encoded through an `OffscreenCanvas` (else a DOM canvas).
  - Both render the page's content (the union of its visible layers' render bounds) fitted into maxSize × maxSize in the content's own aspect. The page colour is behind it and there are no overlays. The current page is used when `page` is absent. They return null for an empty or missing page, or when the GPU can't make the target.
- **`CONTEXT_MENU` event** (`engine.on("CONTEXT_MENU", …)`), typed in `codec.ts` as `{ type: "CONTEXT_MENU"; targetKind: "CANVAS" | "SELECTION"; x; y; hits: Guid[][] }`.
  - It fires on a right-click, or on a ⌃-click when ⌃ isn't the command key (a Mac).
  - First the engine selects what a left click would pick, unless that is already selected; on empty canvas the selection stays.
  - `hits` lists every layer under the point, topmost first. Each is a path innermost first: the layer, then its parents up to the page's child. A frame isn't listed again on its own when its child is listed. This is the data for "Select layer ▸".
  - It comes after `SELECTION_CHANGED` in the same drain.
- **`abi.ts`**: every `CommandId` is implemented now: SELECT_INVERSE 16 (Figma's Select inverse, ⇧⌘A: the selection's siblings, visible and unlocked, instead of it; with nothing selected, the page's layers), GROUP 60, UNGROUP 61, FRAME_SELECTION 62, DUPLICATE 63, FLIP_HORIZONTAL 64, FLIP_VERTICAL 65, ALIGN_LEFT 70, ALIGN_HORIZONTAL_CENTER 71, ALIGN_RIGHT 72, ALIGN_TOP 73, ALIGN_VERTICAL_CENTER 74, ALIGN_BOTTOM 75, DISTRIBUTE_HORIZONTAL 76, DISTRIBUTE_VERTICAL 77, ADD_AUTO_LAYOUT 80, REMOVE_AUTO_LAYOUT 81, CREATE_PAGE 90, DELETE_PAGE 91, DUPLICATE_PAGE 92. New flag: `PASTE_IN_PLACE = 1`.
  - Undo labels are Figma's: "Group selection", "Ungroup selection", "Frame selection", "Duplicate", "Flip horizontal", "Align left" … "Distribute horizontal spacing", "Add auto layout", "Remove auto layout", "Add page", "Delete page", "Duplicate page", "Move layers", "Move page", "Paste", "Reorder".
  - `commandState`: UNGROUP needs a selected group or frame with children. ALIGN_* needs two movable layers, or one inside a frame. DISTRIBUTE_* needs three. REMOVE_AUTO_LAYOUT needs a selected auto-layout frame. DELETE_PAGE needs more than one page (otherwise the command returns `E_INVALID`). The rest need a selection; CREATE_PAGE is always enabled.
- **`codec.ts`**: `NodeFields` now types the auto-layout and constraint fields the engine keeps (`stackMode`, `stackSpacing`, `stackHorizontalPadding` = left, `stackVerticalPadding` = top, `stackPaddingRight`, `stackPaddingBottom`, `stackPrimarySizing`, `stackCounterSizing`, `stackPrimaryAlignItems`, `stackCounterAlignItems`, `stackCounterAlignContent`, `stackWrap`, `stackCounterSpacing`, `stackReverseZIndex`, `bordersTakeSpace`, `stackChildPrimaryGrow`, `stackChildAlignSelf`, `stackPositioning`, `minSize`/`maxSize` `{ value }`, `horizontalConstraint`, `verticalConstraint`, `proportionsConstrained`). `NodeType` adds SYMBOL, INSTANCE and SECTION. `Message` adds `pastePageId?` and `clipboardSelectionRegions?`.
- **`shortcuts.ts`** adds ⇧⌘A, ⌘G, ⇧⌘G, ⌥⌘G, ⌘D, ⇧H, ⇧V, ⌥A/⌥H/⌥D/⌥W/⌥V/⌥S, ⇧A and ⌥⇧A. Distribute (⌃⌥H / ⌃⌥V) is left to the editor's registry, because `Shortcut` has no ⌃ field.
- **C ABI**: `engine_move_nodes(h, refs, refsLen, parentSessionID, parentLocalID, index)`, `engine_encode_selection(h, flags)` (`E_NOT_FOUND` when nothing is selected), `engine_paste(h, msg, len, flags)`, `engine_render_thumbnail(h, pageSessionID, pageLocalID, maxSize, flags)`, and `engine_command` args with `page`.
  - `engine_render_thumbnail`: page `0xffffffff:0xffffffff` = the current page. The result is u32 width, u32 height (little endian), then the RGBA8. It returns `E_NOT_FOUND` for an empty or missing page and `E_UNSUPPORTED` when there is no target. These are in `exports.txt`, `EngineExports.ts` and `USED_EXPORTS`.

### Round 2 follow-ups (the editor's requests): done and verified

- **Flips** answer `Status.OK` through `engine.command` with the committed release wasm. `engine.wasm.test.ts` checks it ("round 2 follow-ups"). An `E_UNSUPPORTED` the editor saw came from an older wasm.
- **SELECT_INVERSE** (16): implemented, and tested natively and in the wasm test.
- **CONTEXT_MENU**: `hit/HitTest` gained `hitPaths` (every layer under a point); `Editor::contextMenu` emits the event.
  - Because ⌃-click is the context menu, ⌃ turns snapping off only once a drag has started, as in Figma.
- **Thumbnails**: `gfx::Device` gained offscreen targets: `createTarget`, `destroyTarget`, `readPixels`, and `PassDesc::target`.
  - On WebGL2 a target is a framebuffer with an RGBA8 and a DEPTH24_STENCIL8 renderbuffer; readback flips the rows to top-down.
  - `NullDevice` records targets and reads back the pass's clear colour.
  - `Renderer::render` takes a target. `engine_render_thumbnail` draws the page with no overlays into a target sized to the fitted content, reads it back, un-premultiplies, and frees the target. The canvas is never touched, so there is no flicker and it works in a hidden tab.
  - The PNG encoding is TS's job (an `OffscreenCanvas`).
  - Checked in headless Chrome: a 480 × 285 PNG of the sample page, the right way up, with the selection not drawn.
  - The design is recorded in docs/engine.md §8.6.

### Round 2: done and verified

- **Model, spatial index, layout**: as described at the previous handoff. That covers 23 auto-layout and constraint fields, the per-page AABB tree, and auto layout with wrap, Hug/Fill/Fixed, min/max, constraints, group fitting and empty-group deletion. All of it is unchanged and still green.
- **Structural commands** (`editor/Commands.cpp`):
  - Group and frame selection wrap at the topmost selected layer's place and keep every layer where it is on the page. They work across parents. A group is FRAME + `resizeToFit` with no fill. Frame selection is a white frame that doesn't clip.
  - Ungroup sends the children to the group's place.
  - Duplicate, flip (about the selection box's own axes), align, distribute, add/remove auto layout (inferred, docs/engine.md §8.6), and pages (create, duplicate, delete; never the last one).
  - `moveNodes`, `copySelection` and `paste`.
  - Arrow keys reorder auto-layout children.
  - Tests: `tests/unit/editor.commands.test.cpp` (12 cases), plus one case in `api.test.cpp` and one in `engine.wasm.test.ts`.
- **Gestures on world transforms** (`tools/Gestures.cpp`):
  - Every move step computes local = inverse(the current parent's world) × the desired world. Layout runs (`flushLayout`) at the end of every move, resize, rotate and draw step, so groups follow live and panels see real numbers.
  - Drag-to-reparent is live: `dropTargetAt` finds the topmost frame under the pointer; ⌘ keeps the parent; a group's layers stay in the group.
  - ⌥-drag duplicates (`setDuplicating`). It toggles mid-drag, the cursor is `MOVE_DUPLICATE`, the drag is one undo step, and Esc leaves nothing behind.
  - Auto layout: reorder by drag with the insertion indicator (`updateInsertion`, which handles wrapped rows), dropping placed at the insertion index (`finishMove`), and dragging out of the flow. A layer dragged inside its own frame keeps its slot (`LayoutHost::placedByGesture`). Newcomers take no space (`excludedFromFlow`).
  - Resizing an auto-layout child fixes the axes it changed (Fill → Fixed, STRETCH → AUTO). Resizing a hugging auto-layout frame sets that axis to FIXED.
  - Tests: `tests/unit/editor.move.test.cpp` (12 cases).
- **Snapping and measurement**:
  - `prepareSnapping` takes the drop parent's children in and around the view plus the parent frame.
  - Move uses `snapBox`: edges, centres and equal spacing. Resize (when the box isn't rotated) and draw (both corners) use `snapPoint`. The threshold is 6 CSS px ÷ zoom. ⌃ or ⌘ turns snapping off. Pixel rounding applies otherwise.
  - ⌥ measurement (`updateMeasure`) measures to the hovered layer, or to the parent frame when hovering the selection or nothing.
  - Auto-layout padding and gap bands on hover (`updateAutoLayoutBands`), for a selected auto-layout frame that isn't rotated.
- **Overlay drawing** (`render/Overlay.cpp`, `OverlayStyle.h`):
  - guides: 1 px `#F24822`;
  - spacings and measures: a line, end ticks, and a red pill sized for its number (the text comes with E3);
  - ⌥ extension lines are dashed, and the measured layer is outlined in red;
  - the insertion line is 2 px in the selection colour;
  - bands are `#FF24BD` at 15%.

  All are pixel-snapped. Test: `render.batching.test.cpp`, last case. Seen in headless Chrome screenshots.
- **Figma golden layout** (§4.7): `node engine/tools/fixtures.mjs [--check]` converts `docs/research/figma/samples/*.fig.json` into `engine/tests/data/figma/*.json`. `tests/unit/layout.figma_golden.test.cpp` scrambles every auto-layout frame and group (flow children to the origin, Hug axes collapsed, group boxes moved off their contents), re-runs layout, and requires every node of `stacks_wrap`, `structure` and `sections` back at Figma's size and transform within 0.01. All three pass.
- **Kiwi**:
  - `kiwi.h` is vendored at `engine/third_party/kiwi/` (MIT, evanw/kiwi `master` @ 2023-09-03, `LICENSE.md` alongside).
  - `engine/cmake/Generators.cmake` runs `schemagen.ts --cpp <build>` as a CMake custom command (it depends on `schema/document.kiwi` and `schemagen.ts`), so nothing generated is committed.
  - `engine/src/schema/KiwiImpl.cpp` is the one TU with `IMPLEMENT_KIWI_H` + `IMPLEMENT_SCHEMA_H`. It includes `node_fields.h` (which brings `document.kiwi.h`) and `document.stream.h`. `document.kiwi.h`'s implementation block isn't include-guarded, so including it twice fails.
  - It is compiled and tested in the **native** build only (`eng_schema`). `tests/unit/scene.kiwi.test.cpp` covers a tree-codec round trip, a byte-identical re-encode through `schema_stream::parseMessage` + `Writer`, and that the engine's `kiwiFieldId` values match `kNodeFields`.

### Not started

- **GRID layout** (§4.3) and BASELINE alignment (which needs text).
- **Kiwi at the TS↔C++ boundary.** `scene/CodecJson` and `codec.ts` still speak JSON, and the Wasm doesn't link `eng_schema` yet.
- **Smaller canvas gaps:**
  - double-click into layers;
  - frame titles and every overlay number (both need E3 text);
  - snapping to page guides and layout grids;
  - ⌥⌘ measurement to locked layers;
  - smart duplicate (repeating the last ⌘D offset).

### Known behaviour (not breakage)

- **`stackCounterSpacing` absent means "the same as `stackSpacing`"**, as Figma's own layout does in `stacks_wrap.fig`, which the golden test now confirms. docs/schema.md §3.4 says absence means 0; the schema owner should align it.
- **The Wasm grew from 312 KB to 457 KB** (release, −O3 + LTO) with this round's code. Watch it; `-Os` for cold code or splitting the gesture lambdas are the levers.
- **Every layout result is a system write in the open transaction**, so a drag inside a group emits the group's refit as part of its one `DOCUMENT_CHANGED`.

### Next steps, in order

1. **Kiwi boundary.**
   - Link `eng_schema` into the Wasm.
   - Replace `scene/CodecJson` with `schema::Message` decode/encode, and use `schema_stream::parseMessage` for `engine_load`.
   - On the TS side, `codec.ts` re-exports the generated types and encodes with `codec` from `src/shared/schema/document.generated.ts`.
   - The ABI stays the same (bytes in, bytes out). The clipboard Message then becomes the fig-kiwi archive of desktop.md §13.
2. **GRID** (§4.3): `gridColumns`/`gridRows` (GUIDPositionMap), track sizing, anchors and spans, gaps, and auto placement. Add the fields to `Node.h` and the codec first.
3. **E3 text.** HarfBuzz shaping, line breaking, glyph rendering, and editing with IME. After that: the overlay numbers (badge, spacing and measure pills), frame titles, and BASELINE alignment.

---


The canvas engine is C++20 compiled to WebAssembly with Emscripten. It owns the scene graph, the transactions and undo, hit-testing and picking, the tools and gestures, the camera, and its own WebGL2 renderer (no Skia, CanvasKit or DOM). React and TS panels sit around it. `docs/engine.md` is the architecture contract, and `schema/document.kiwi` with `docs/schema.md` define the data. This page covers what exists today and how to work with it.

## Quick start

| | |
|---|---|
| `npm run engine:build` | release Wasm → `src/renderer/src/engine/wasm/engine.{mjs,wasm}` (−O3, LTO) |
| `npm run engine:build:debug` | the same with assertions, `-O1 -g` and `engine.wasm.map` |
| `npm run engine:test` | native doctest suite with ASan + UBSan |
| `npm run engine:watch` | rebuilds `wasm-debug` whenever `engine/src`, `engine/api`, `engine/cmake` or `schema/` change |
| `npm run engine:dev` | the playground alone, at http://localhost:5299 (Vite, no shell, no Firebase) |
| `npm run engine:shot -- <dir>` | headless Chromium: loads the playground, runs a set of gestures, checks the results, saves PNGs |
| `?engine` in the app | the same playground inside the desktop app or `npm run web` |
| `npm test` | includes `src/renderer/src/engine/__tests__`: the ABI twins, plus the real Wasm driven through the TS facade in Node |

`engine/tools/build.mjs <preset> [--test]` sets up the toolchain itself:
- Emscripten: `$EMSDK` or `~/emsdk`. It sets `EMSDK`, `EM_CONFIG` and `PATH` and does not source `emsdk_env.sh`. It warns if the active version differs from `engine/EMSDK_VERSION` (6.0.11).
- CMake and Ninja: taken from `~/Library/Python/3.9/bin` when they are not already on `PATH`.
- Python for `emcc`: `EMSDK_PYTHON`, otherwise `uv python find 3.12`.

Presets live in `engine/CMakePresets.json`: `wasm-release`, `wasm-debug` and `native-test`. Build trees go in `engine/build/`, which is gitignored.

**The Wasm output is committed** (`src/renderer/src/engine/wasm/`, about 240 KB of wasm, about 95 KB gzipped, plus 30 KB of glue). `docs/engine.md` §1.6 wants it gitignored and rebuilt by `predev`/`prebuild` hooks, but those hooks are not wired yet. Until they are, committing the output means `npm run dev`, `npm run build` and `npm run typecheck` work without emsdk. When the hooks land, add `src/renderer/src/engine/wasm/engine.*` to `.gitignore` and keep `engine.d.mts`. **Rebuild `wasm-release` before committing**: a debug build overwrites the same files.

## Layout

```
engine/
  CMakeLists.txt, CMakePresets.json, EMSDK_VERSION
  cmake/Flags.cmake          C++20, -fno-exceptions -fno-rtti, -Wall -Wextra -Wpedantic -Werror, sanitizers
  cmake/Emscripten.cmake     link flags (MODULARIZE + EXPORT_ES6, ENVIRONMENT=web, ALLOW_MEMORY_GROWTH,
                             MAXIMUM_MEMORY=4GB, WebGL 2 only, FILESYSTEM=0, STRICT, explicit exports)
  cmake/Generators.cmake     schemagen --cpp at build time → <build>/generated/schema/*.h; eng_schema (native)
  api/exports.txt            EXPORTED_FUNCTIONS (hand-kept until apigen)
  tools/build.mjs, watch.mjs
  tools/fixtures.mjs         Figma samples → tests/data/figma/*.json (--check)
  src/base/                  Guid, FractionalIndex (docs/schema.md §10), Json (interim encoding)
  src/math/Math.h            Vec2, Mat2x3, Rect, SDFs (rounded box with per-corner radii, ellipse)
  src/scene/                 Node (types, fields, defaults), Document (flat GUID table, derived children,
                             world transforms, bounds), ChangeSet (forward Message per commit), CodecJson
  src/editor/                Editor (transactions, selection, keys, camera), Commands (structural commands,
                             moveNodes, copy/paste), Snapping (snapper, ⌥ measurement), Undo, Selection,
                             Keys.h (keyCode table), Commands.h (command ids)
  src/layout/Layout.cpp      auto layout, constraints, group fitting
  src/schema/KiwiImpl.cpp    the one TU with the kiwi runtime + generated codecs (native only for now)
  src/tools/Gestures.cpp     pan, press/click, move (reparent, ⌥-duplicate, auto-layout insertion, snapping),
                             resize, rotate, draw, marquee, hover (⌥ measurement, auto-layout bands), cursors
  src/hit/                   HitTest (geometry), Picking (picking.ts rules), Marquee
  src/geometry/              Path (commandsBlob), VectorNetwork (vectorNetworkBlob), Shapes, Stroker, Boolean (Clipper2 +
                             curve recovery), NodeGeometry (the per-node path cache)
  src/editor/VectorEditing   vector edit mode, Pen, Pencil; VectorCommands (booleans, Flatten, Outline stroke, masks,
                             Place image); PaintEditing (gradient handles)
  src/render/                Renderer (scene → instances, layers, effects, composites), Overlay, OverlayStyle, Camera,
                             DrawInstance, CurveCache (+ CurveCoverage.h), ImageCache
  src/gfx/                   Device.h (explicit-argument interface), gl/ (WebGL2), null/ (records, for tests)
  src/api/Api.cpp            the C ABI
  tests/                     doctest: unit/*.test.cpp, data/fractional-index-vectors.txt, data/figma/*.json
  third_party/doctest/       doctest 2.4.11 (MIT)
  third_party/kiwi/          kiwi.h (MIT, evanw/kiwi)
  third_party/clipper2/      Clipper2 2.0.1 (Boost licence): polygon clipping for booleans
src/renderer/src/engine/
  wasm/engine.mjs + .wasm    build output; engine.d.mts types it
  EngineExports.ts           typed C ABI + marshalling (stand-in for EngineExports.generated.ts)
  codec.ts                   the TS twin of CodecJson: payload types and encode/decode
  abi.ts, keyCodes.ts        ABI numbers (tools, commands, flags, statuses), KeyboardEvent.code table
  loadEngine.ts, Engine.ts   module loader, facade (event pump, frame loop)
  EngineStore.ts, hooks.ts   external store + useSyncExternalStore hooks
  CanvasController.ts        DOM → engine wiring; cursors.ts, shortcuts.ts
  EngineCanvas.tsx, Playground.tsx, sampleDocument.ts, dev/ (standalone Vite entry)
scripts/engine-dev.mjs, scripts/engine-shot.mjs
```

## What works (E0 + E1; E2 is in the status section)

**Scene graph.** A flat table of nodes keyed by GUID (`"s:l"`). Each node has these typed properties, named as in the schema:
- `type`, `name`, `visible`, `locked`, `opacity`
- `transform` (2×3, relative to the parent), `size`
- `fillPaints` and `strokePaints` (solid colours, list-shaped), `strokeWeight`, `strokeAlign`
- the four `rectangle*CornerRadius` fields plus `cornerRadius`
- `frameMaskDisabled`, `resizeToFit`
- `parentIndex {guid, position}`
- on CANVAS only: `backgroundColor`, `backgroundEnabled`, `internalOnly`

Rules:
- Children are derived by sorting `position`, ties broken by GUID.
- Node types: DOCUMENT, CANVAS, FRAME, ROUNDED_RECTANGLE, ELLIPSE. RECTANGLE and GROUP are accepted on import. A group is FRAME + `resizeToFit`.
- A change is a node id plus the fields it touches. `apply()` returns the inverse.
- CREATED for a live GUID replaces the node.
- Cycles are refused.
- An orphan waits until its parent arrives.

**Transactions and undo** (docs/engine.md §9). Every edit runs inside a transaction (USER, GESTURE, UNDO, REDO, REMOTE or LOAD):
- Writing an equal value does nothing.
- A committed USER, GESTURE, UNDO or REDO transaction emits exactly one `DOCUMENT_CHANGED` Message. That Message holds one NodeChange per node with only its changed fields; creations carry their full state and removals come children first.
- A gesture is one undo step: inverses fold, so the first value wins. Key-repeat nudges merge into one step.
- Undo and redo restore the selection.
- Esc, blur and pointer-cancel roll the gesture back exactly and emit nothing.
- Panel scrubs use `txnBegin`/`txnCommit`.
- When a key would grow past 24 characters, the siblings are rebalanced inside the same transaction (§10.3).
- The undo stack is capped at 1,000 steps.

**Renderer** (ours, over `gfx::Device`):
- Shapes are instanced SDF quads with analytic AA: rect, rounded rect with per-corner radii, ellipse. Fill and stroke (inside, centre or outside) are drawn in one pass, premultiplied, with opacity.
- Geometry is composed in doubles on the CPU, camera included, so the GPU only sees screen-space floats.
- Frame clipping uses scissor when the frame is axis-aligned and square, and stencil (nested) when it is rounded or rotated.
- Render on demand: nothing runs while idle.
- DPR uses the canvas's real backing size.
- Strokes draw over a frame's content.
- Off-screen nodes are culled.
- The page colour is used, or the theme's when the page uses Figma's default `#F5F5F5`. Dark is `#1E1E1E`.
- 10,000 rects are drawn in one draw call.

**Overlays** (§6.11):
- Hover outline is 2 px and follows the shape.
- Selection box is 1 px and drawn along the rotated box. Multi-selection shows each layer's box plus the combined box.
- 8×8 white handles with the selection-colour border. They are hidden when the box is under 24 px on screen.
- The size badge is a 16 px pill placed 6 px below the box. Its `W × H` text comes with E3.
- Marquee is a 10% fill with a 1 px border.
- The selection colour is `#0D99FF` in light and `#0C8CE9` in dark (§6.11).
- 1 px lines snap to device pixels.

**Camera:**
- The wheel pans; ⇧ pans sideways.
- Pinch, or ctrl/⌘ + wheel, zooms around the pointer by `exp(−dy·0.01)`.
- Space-drag, middle-drag and the H tool pan.
- Zoom range is 0.02–256.
- Zoom to fit (⇧1), to the selection (⇧2), 100% (⇧0 / ⌘0), ⌘+ and ⌘−. These commands land the page on whole device pixels.

**Hit-testing and picking** (§8.2, ported from `picking.ts`):
- Geometry-accurate for rounded rects and ellipses.
- A stroke counts within max(half its width, 4 CSS px).
- A frame is hit by its box only when it shows a fill or stroke, or is top-level.
- A group is hit only through its children.
- Clipped children outside their frame don't hit.
- Hidden nodes are skipped, and the path is cut at the first locked node.
- Picking: a top-level frame's child first. A selected layer opens to its children, and siblings of the selection are picked at their own level. ⌘ picks the innermost layer.
- Click, ⇧-click (toggle) and marquee: live, ⇧ additive. A partly covered frame contributes its children, and a marquee started on a frame's background works among that frame's children.

**Gestures and tools:**
- Move: 3 px threshold, ⇧ locks the axis, whole pixels.
- Resize from 4 corners plus edge zones: ⇧ keeps the ratio, ⌥ resizes from the centre, dragging past zero flips the node (negative scale). Several layers scale as one box, and a group resizes its children.
- Rotate from 16 px zones outside the corners; ⇧ snaps to 15°.
- Draw with F/A (frame), R (rectangle) and O (ellipse): ⇧ makes a square, ⌥ draws from the centre, and a click makes a 100×100 shape inside the innermost frame under the press. Figma's defaults apply: a frame gets a white fill and the name "Frame N"; rectangles and ellipses get `#D9D9D9` and the names "Rectangle N" / "Ellipse N"; all get a 1 px inside stroke weight. After drawing, the tool goes back to Move.
- Keys the engine handles itself: arrows (nudge, ⇧ ×10), Esc (cancel, then parent, then deselect), Enter (children), ⇧Enter (parent), Tab / ⇧Tab (siblings), Space.
- Every other key goes to TS's shortcut table (`shortcuts.ts`): V F A R O H, ⌘Z, ⇧⌘Z, ⌘Y, ⌫, ⌘A, ⇧0/1/2, ⌘0, ⌘+, ⌘−, ⌘], ⌘[, ⌥⌘], ⌥⌘[, ⇧⌘L, ⇧⌘H.

## The C ABI

Calls are flat `extern "C"` functions; there is no embind. The ABI version is 1, and `api/exports.txt` lists everything. In wasm32, pointers and handles are u32; natively they are `uintptr_t`, so the native tests can call the same functions. Payloads are UTF-8 JSON in the shapes of `schema/document.kiwi` (see below).

| Function | Notes |
|---|---|
| `engine_abi_version`, `engine_alloc/free`, `engine_result_ptr/len`, `engine_events_flag_ptr`, `engine_last_error` | Module. Results go to one result slot, valid until the next result. The events flag is a u32 in memory, non-zero while events are queued. |
| `engine_create(selector, opts, len)` / `engine_destroy` | `"#engine-canvas"`, or 0 for headless. `opts` is `{sessionID, theme}`. |
| `engine_load(h, msg)`, `engine_apply_changes(h, msg, flags)`, `engine_encode_document`, `engine_pages`, `engine_set_current_page` | A Message is `{type, sessionID, nodeChanges}`. Flags: `APPLY_USER` 1, `APPLY_REMOTE` 2, `APPLY_LOAD` 4. |
| `engine_set_viewport(h, cssW, cssH, dpr, pxW, pxH)`, `engine_set_camera`, `engine_get_camera`, `engine_set_theme` | The engine sets the canvas's backing size. |
| `engine_pointer(h, type, x, y, button, buttons, mods, pressure, clicks, pointerType, t)` | Type: DOWN 0, MOVE 1, UP 2, CANCEL 3, ENTER 4, LEAVE 5. Returns HANDLED 1 \| CAPTURE 2. |
| `engine_wheel(h, x, y, dx, dy, deltaMode, mods, flags)` | `PINCH` = 1 |
| `engine_key(h, type, keyCode, codepoint, mods, repeat)`, `engine_modifiers`, `engine_blur` | `keyCode` is the index into `Keys.h` / `keyCodes.ts`. Returns HANDLED 1. |
| `engine_set_tool(h, tool)`, `engine_set_hover(h, refs)` | Tools follow §8.4's order. |
| `engine_tick`, `engine_render`, `engine_needs_frame`, `engine_next_frame_delay`, `engine_gl_context_lost/restored` | Render on demand. |
| `engine_get_selection`, `engine_set_selection`, `engine_read_nodes(h, refs, flags)`, `engine_hit_test` | `INCLUDE_CHILD_IDS` = 1 |
| `engine_set_props(h, refs, change, flags)`, `engine_txn_begin/commit/cancel`, `engine_command(h, id, args)`, `engine_command_state` | Commands are in `Commands.h` / `abi.ts`. Args: `{dx, dy}` (NUDGE), `{page: "s:l"}` (DELETE_PAGE, DUPLICATE_PAGE). |
| `engine_move_nodes(h, refs, parentSessionID, parentLocalID, index)` | The Layers panel's drag. Returns how many moved. |
| `engine_encode_selection(h, flags)`, `engine_paste(h, msg, flags)` | The clipboard Message (docs/schema.md §4.1). `PASTE_IN_PLACE` = 1. Paste returns how many top-level layers it pasted. |
| `engine_has_events`, `engine_take_events`, `engine_stats` | Events: `{events:[…]}` |

Mods are bit flags: SHIFT 1, ALT 2, CTRL 4, META 8, PRIMARY 16 (⌘ on a Mac, Ctrl elsewhere). Status codes follow §10.3: OK 0, E_HANDLE −1, E_DECODE −2, E_INVALID −3, E_NOT_FOUND −5, E_BUSY −7, E_UNSUPPORTED −8.

Events follow §10.4: `DOCUMENT_CHANGED {kind, label, message}`, `NODES_CHANGED {refs, fieldGroupMask}` (live, for panels), `STRUCTURE_CHANGED`, `PAGES_CHANGED`, `CURRENT_PAGE_CHANGED`, `SELECTION_CHANGED {pageId, refs}`, `CAMERA_CHANGED`, `TOOL_CHANGED`, `CURSOR {kind, angleDeg}`, `HOVER_CHANGED`, `UNDO_STATE`.

## The TS API

```ts
const engine = await Engine.create(canvas, { sessionID, theme: "DARK" }); // canvas null = headless
engine.load(message);                         // or loadDocument()
engine.applyChanges(message, "user" | "remote" | "load");
engine.pointer(...) / wheel(...) / key("down", e.code, e.key, mods, e.repeat) / modifiers() / blur();
engine.setTool("RECTANGLE"); engine.undo(); engine.redo(); engine.command("ZOOM_TO_FIT");
engine.getSelection(); engine.setSelection(["1:5"]); engine.readNode("1:5", { childIds: true });
engine.setProps(["1:5"], { opacity: 0.5 }); engine.txnBegin("Opacity"); …; engine.txnCommit();
engine.onDocumentChanged((changes, e) => persist(e.message));   // one Message per commit
engine.onSelectionChanged((s) => …); engine.onCursor((kind, angle) => …); engine.on("CAMERA_CHANGED", …);
engine.encodeDocument(); engine.hitTest(x, y); engine.stats(); engine.destroy();
engine.command("GROUP"); engine.command("DELETE_PAGE", { page: "0:3" });
engine.moveNodes(["1:5"], "1:1", 0);                            // Layers drag: paint order, counted without them
const clip = engine.encodeSelection(); engine.paste(clip!, { inPlace: true });
```

- **Event pump.** After every call, the facade reads the events flag from memory. If it is set, the facade drains the queue and dispatches the events synchronously after the engine has returned. A handler may call the engine again: its events are queued behind the current ones.
- **Frames.** Any call that leaves the engine wanting a frame schedules one `requestAnimationFrame`, which runs tick and then render.
- **`CanvasController`** (used by `EngineCanvas`) forwards pointer events (with pointer capture), wheel events (`passive: false`, `ctrlKey` → PINCH), keys (the engine first, then `shortcuts.ts`), focus and blur. It sizes the canvas with `ResizeObserver` (device-pixel-content-box when it is consistent), sets cursors (angle → CSS resize cursor; an SVG rotate cursor) and handles WebGL context loss.
- **`EngineStore` + `hooks.ts`** expose `useSelection`, `useTool`, `useUndoState`, `useHover`, `useCurrentPage`, `useCamera` and `useNode(store, id)` through `useSyncExternalStore`. Each snapshot is immutable per topic, and a node is re-read only after a change touches it.

## The wire encoding (interim) and the switch to kiwi

The payloads are JSON, but they use the schema's field names and meanings:
- Absent fields mean the absence value (§3.4).
- A CREATED change carries only the fields that differ from absence, plus `type` and `parentIndex`.
- `clearedFields` (kiwi field ids) is read on updates.
- Cleared fields are read as their defaults, and the engine's inverse writes the default value back rather than `clearedFields`, because the interim node model doesn't track absence separately.

Exactly two modules know the encoding: `engine/src/scene/CodecJson.{h,cpp}` and `src/renderer/src/engine/codec.ts`. When `engine/tools/schemagen` emits the kiwi codecs:
1. Replace those two modules with the generated codecs.
2. Swap the `Message`/`NodeChange` types in `codec.ts` for the generated ones.
3. Change the C++ `Field` bitmask to kiwi field ids. `kiwiFieldId()` and `fieldsOfKiwiId()` already map them.

The ABI does not change.

## Deviations from docs/engine.md (interim, on purpose)

**Scene and transactions**
- The node store is one struct per node with a field bitmask. §2.2's SoA `NodeTable` with facets, interned strings and opaque-field round-trip is not built yet. Coordinates are doubles in the engine and floats on the wire and GPU.
- Undo inverses are field values, not kiwi bytes.
- The spatial index is one AABB tree per page (§8.1). Culling still walks the tree.
- No render tree or tiles: the renderer draws directly from the scene.
- (Round 2) Groups now store their box, kept by layout (see the status section).
- Group opacity multiplies down instead of compositing a layer (E5).

**Graphics**
- `gfx::Device` is a subset of §6.1: buffers, pipelines over one built-in shader, and one pass on the default framebuffer. There are no textures, targets, MSAA or readback yet. Shaders are hand-written GLSL ES 3.00 (`gfx/gl/Shaders.h`); shadergen and naga come later.
- The WebGL context has `stencil: true`, because clip masks use the default framebuffer until the engine has its own targets. §6.1 asks for `stencil: false` once those exist.

**Bindings and build**
- The bindings, export list, key-code table and command ids are kept by hand. Vitest checks that the TS and C++ copies agree.
- Payloads are JSON, not kiwi (see above).
- Not yet in the ABI: `engine_layer_rows`, `engine_read_derived`, `engine_set_geometry`, `engine_find`, `engine_export`. Copy is `engine_encode_selection` (not §10.7's `engine_copy`).
- Tests are named `tests/unit/<area>.test.cpp`. There is no `wasm-node` preset: the vitest integration test runs the web build in Node with `document`/`window` stubs.

**Editing**
- Missing: double-click into layers, frame titles and overlay numbers (they need text), and snapping to guides and layout grids. The E2 decisions taken while building are in docs/engine.md §8.6.

## Next

- **E2 remainder:** GRID (§4.3).
- **E3:** text — HarfBuzz, line breaking, glyphs (path renderer, MaskAtlas), editing with IME. This also unlocks the size-badge text, frame titles and measurement labels.
- **Alongside:**
  - the generated kiwi codec at the boundary (schemagen's C++ compiles and is tested natively), and apigen;
  - the NodeTable with facets;
  - `engine_layer_rows` for the Layers panel;
  - the 100k-rect performance target;
  - golden-image tests (`engine:golden`);
  - `predev`/`prebuild` hooks, after which the Wasm output can be gitignored.
