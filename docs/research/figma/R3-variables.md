# R3 — Figma variables, modes, collections and styles (as of 2026-10-06)

Research for turning DesignerV2 into a single-user 1:1 Figma desktop clone. Every claim below cites a page that was actually opened. Claims marked **[inference]** are deductions, not read text.

## 1. Summary

**What a variable is.** A variable is a named, typed value that can be bound to a layer property, to a style property or to another variable. Variables sit in **collections**. Each collection has 1..N **modes**, which are the table's columns, and each variable stores one value per mode in `valuesByMode`. Inside a collection, variables are organised into **groups**, and a group is encoded as a slash path in the variable name (e.g. `color/bg/primary`). Up to 5,000 variables fit in one collection.

**Types.** In 2026 there are **six** types: Color, Number (`FLOAT`), String, Boolean, plus **Timing** and **Easing**.
- Timing and Easing arrived with Figma Motion (Config 2026, June 2026).
- They were added to the Plugin API in Update 133 (Aug 2026).
- The REST types page still lists only the original four.

**Aliasing.**
- A variable value can be a `VARIABLE_ALIAS` to another variable of the same type, including one in another collection or a library.
- Cycles and self-aliases are invalid.
- The alias chain is resolved using **the consuming node's selected mode for each collection in the chain** (`resolveForConsumer`).
- Since **Sept 2026** ("Control opacity at scale"), a color value can be a `VariableComposedColor { color: RGB|Alias, opacity: number|Alias }`. This lets a color keep its alias to a base color while carrying its own opacity, and that opacity can itself be a number variable. A new `COLOR_OPACITY` scope supports this.

**Modes.**
- The **default mode** is the left-most column.
- Every node starts on **Auto**, meaning it inherits the mode of its parent container, up to the page and finally the collection default.
- You set a mode from **Apply variable mode**:
  - for a selected object, in the **Appearance** section;
  - for the page, in the **Page** section when nothing is selected.
- Explicit modes are stored per node as `explicitVariableModes: {collectionId: modeId}`, and that includes pages.

**Plan limits.**
- Starter cannot add modes. Pro allows 10 modes per collection and Org allows 20; both were raised at Schema 2025.
- Enterprise is described as "unlimited (via extended collections)", but the REST write API still validates a maximum of 40 modes per collection and 40 characters per mode name.

**Variable settings.** Each variable has:
- Name
- Description
- Values per mode
- **Scope**: which pickers show it, from a fixed enum per type. Booleans have no scopes.
- **Code syntax**: one string each for Web, Android and iOS, used in Dev Mode snippets.
- **Hide from publishing**

A whole collection is hidden from publishing by prefixing its name with `_` or `.`.

**Extended collections.**
- Announced at **Schema 2025**, not Config 2025, on 2025-10-28; they shipped in Nov 2025 for Enterprise only.
- An extended collection inherits the parent's variables, modes, names, scopes and order. It can only override **values**.
- Overrides show in blue and can be undone with "Reset change". A color and its opacity are overridden together.
- The API exposes `isExtension`, `parentVariableCollectionId`, `rootVariableCollectionId`, `variableOverrides[varId][extendedModeId]` and `modes[].parentModeId`. The REST API also has `inheritedVariableIds` and `localVariableIds`.

**Binding.** Bindings are stored in the node's `boundVariables`:
- A scalar field maps to one alias. The node fields are width/height, min/max size, padding, gaps, corner radii, stroke weights, opacity, `characters`, `visible` and grid gaps.
- Text fields are `fontFamily`, `fontStyle`, `fontWeight`, `fontSize`, `lineHeight`, `letterSpacing`, `paragraphSpacing` and `paragraphIndent`.
- `fills`, `strokes`, `effects`, `layoutGrids` and `textRangeFills` take arrays.
- `componentProperties` is a map.
- Paint-level and effect-level bindings live inside the paint or effect object, and the arrays are immutable.
- String, number and boolean variables can drive variant properties, so switching mode can swap the variant.

**Prototyping.** Actions are **Set variable**, **Set variable mode** (which changes the current page's mode) and **Conditional** (if/else). Any number of actions can sit on one trigger, and they run top to bottom. Expressions support:
- arithmetic `+ - * /`;
- string concatenation with `+`;
- comparisons `== != > < >= <=`;
- `and`, `or`, `not`/`!`.

Precedence follows the usual math rules, then comparisons, then `and`, then `or`.

**Styles.** The style types are:
- **Color** (paint): solid, gradient, image, pattern and shader fills, possibly several paints;
- **Text**;
- **Effect**: several effects, including texture, noise and shader;
- **Layout guide**: formerly "grid";
- **Animation**: 2026, Motion only.

In the API they are `PAINT`, `TEXT`, `EFFECT`, `GRID` and `ANIMATION`; REST uses `FILL`, `TEXT`, `EFFECT`, `GRID`. Nodes reference styles through a `styles` map whose keys are fill, stroke, effect, grid, text and background. A text style excludes color, alignment and resizing.

Styles can contain variable bindings: the help pages name text and color styles, and the Plugin API exposes `boundVariables` on all four classic style types. Neither styles nor variables can be applied to a style. Styles have no modes or scopes. Folders come from slash names, and "Add new folder" renames styles to e.g. `Brand / Blog / Fuchsia`.

**Local vs library.**
- A file publishes its components, styles and variables (Assets tab → Libraries → Publish). The publish dialog lists Created, Modified and Removed items.
- Consumers "Add to file" a library, then review and accept updates.
- Library assets are referenced by a stable **key**, and remote copies have `remote: true`.
- Removing a library leaves the used assets on the canvas.
- "Swap library" re-points styles, components and variables by matching names.
- Deleted variables that are still referenced persist as `deletedButReferenced`.

**UI.** The **Variables view** has a collections sidebar, a group tree with "All variables", and a table whose columns are Name plus one column per mode. A "New variable mode" button sits right of the mode headers, and there is "+ Create variable" with a type dropdown, search and a type filter.
- In **2026** its entry point moved from the right panel to a **new left navigation bar**, which has the Figma menu, File, Agents, Assets, Tools and Variables. The view is now edge to edge.
- With nothing selected, the right panel shows **Page** (canvas background and Apply variable mode), the local **Styles** list grouped as Text, Color, Effect and Layout guide, and **Export**. Before 2026 a **Local variables** section with "Open variables" sat between Page and Styles.

**Internals.**
- The `.fig` Kiwi schema stores variables as scene-graph nodes:
  - `VARIABLE_SET` for a collection;
  - `VARIABLE` with `variableSetID`, `variableResolvedType` and `variableDataValues.entries[{modeID, variableData}]`;
  - `VARIABLE_OVERRIDE`.
- Aliases point at `assetRef.key`. Paints carry `colorVar`.
- Figma's 2025 "unified parameter architecture" stores one binding per layer property, tracks usage per property, invalidates per property and resolves alias chains transitively.

## 2. Claims

| ID | Claim | Source | Kind | Conf. |
|---|---|---|---|---|
| R3-01 | Six variable types: Color, Number, String, Boolean, Timing (ms), Easing (curves/springs). | [Overview of variables, collections, and modes](https://help.figma.com/hc/en-us/articles/14506821864087-Overview-of-variables-collections-and-modes) | help | high |
| R3-02 | Timing/Easing came with Figma Motion (announced Config 2026, 2026-06-24, open beta); modes switch animations at page level. | [Introducing Figma Motion](https://www.figma.com/blog/introducing-figma-motion/) | blog | high |
| R3-03 | Plugin API Update 133 (2026-08-05) added `"EASING"`/`"TIMING"`; easing values are `MotionEasing`, timing values are numbers in **seconds** (UI shows ms). | [Version 1, Update 133](https://developers.figma.com/docs/plugins/updates/2026/08/05/version-1-update-133/) | dev docs | high |
| R3-04 | `VariableResolvedDataType = "BOOLEAN" \| "COLOR" \| "EASING" \| "FLOAT" \| "STRING" \| "TIMING"`; `VariableValue = string \| number \| boolean \| RGB \| RGBA \| MotionEasing \| VariableAlias \| VariableComposedColor`. | [VariableResolvedDataType](https://developers.figma.com/docs/plugins/api/VariableResolvedDataType/), [VariableValue](https://developers.figma.com/docs/plugins/api/VariableValue/) | dev docs | high |
| R3-05 | Collections group variables+modes; groups organize inside; max 5,000 variables per collection. A mode is "a list of values... storing one value per variable". | [Overview](https://help.figma.com/hc/en-us/articles/14506821864087-Overview-of-variables-collections-and-modes) | help | high |
| R3-06 | Modes per collection: Professional 10, Organization 20, Enterprise "Unlimited modes (via extended collections)"; Starter cannot create modes (only Education/Pro/Org/Ent). Raised at Schema 2025 (blog 2025-10-28). | [Pricing](https://www.figma.com/pricing/), [Modes for variables](https://help.figma.com/hc/en-us/articles/15343816063383-Modes-for-variables), [Schema 2025 recap](https://www.figma.com/blog/schema-2025-design-systems-recap/) | official | high |
| R3-07 | REST write validation: max 5000 variables/collection, max 40 modes/collection, mode name ≤40 chars, request ≤4MB, names cannot contain `.{}`, no self-alias or alias cycles, cannot create variables/modes in extended collections or extend remote collections. | [Variables endpoints](https://developers.figma.com/docs/rest-api/variables-endpoints/) | dev docs | high |
| R3-08 | Any variable can alias another variable **of the same type**. | [Overview](https://help.figma.com/hc/en-us/articles/14506821864087-Overview-of-variables-collections-and-modes) | help | high |
| R3-09 | `resolveForConsumer`: resolution depends on the consuming node's selected mode; if a value is an alias, "the resolved value is determined using the selected modes of each collection in the alias chain"; cannot be statically resolved with multiple modes. | [resolveForConsumer](https://developers.figma.com/docs/plugins/api/properties/Variable-resolveforconsumer/) | dev docs | high |
| R3-10 | Default mode = left-most column; change via right-click "Set as default" or drag; add via "New variable mode" right of column headers; Move column left/right; Duplicate. | [Modes for variables](https://help.figma.com/hc/en-us/articles/15343816063383-Modes-for-variables) | help | high |
| R3-11 | Objects are **Auto** by default ("take on the mode of their parent container"); set via Appearance section → Apply variable mode; for pages, deselect all → Page section → Apply variable mode. | [Modes for variables](https://help.figma.com/hc/en-us/articles/15343816063383) | help | high |
| R3-12 | Plugin: `setExplicitVariableModeForCollection(collection, modeId)` exists on most node types incl. PageNode, SectionNode, FrameNode, GroupNode, InstanceNode, TextNode; `resolvedVariableModes: {[collectionId]: modeId}` = explicit + ancestors' explicit modes (not on PageNode). REST nodes carry `explicitVariableModes` (collection ID → mode ID). | [setExplicitVariableModeForCollection](https://developers.figma.com/docs/plugins/api/properties/ExplicitVariableModesMixin-setexplicitvariablemodeforcollection/), [resolvedVariableModes](https://developers.figma.com/docs/plugins/api/properties/nodes-resolvedvariablemodes/), [REST files](https://developers.figma.com/docs/rest-api/files/) | dev docs | high |
| R3-13 | String/number/boolean variables bound to variant properties make instances switch variant when the mode changes. | [Modes for variables](https://help.figma.com/hc/en-us/articles/15343816063383) | help | high |
| R3-14 | Enterprise can set a team default mode for a library collection with ≥2 modes. | [Modes for variables](https://help.figma.com/hc/en-us/articles/15343816063383) | help | medium |
| R3-15 | Native import/export of modes in DTCG JSON: right-click mode → Export mode; right-click collection → Export modes; import requires DTCG format (announced Schema 2025, "November"). | [Modes for variables](https://help.figma.com/hc/en-us/articles/15343816063383-Modes-for-variables), [Schema 2025 recap](https://www.figma.com/blog/schema-2025-design-systems-recap/) | help | high |
| R3-16 | VariableScope enum: ALL_SCOPES, TEXT_CONTENT, CORNER_RADIUS, WIDTH_HEIGHT, GAP, ALL_FILLS, FRAME_FILL, SHAPE_FILL, TEXT_FILL, STROKE_COLOR, EFFECT_COLOR, STROKE_FLOAT, EFFECT_FLOAT, OPACITY, COLOR_OPACITY, FONT_FAMILY, FONT_STYLE, FONT_WEIGHT, FONT_SIZE, LINE_HEIGHT, LETTER_SPACING, PARAGRAPH_SPACING, PARAGRAPH_INDENT. ALL_SCOPES and ALL_FILLS exclude other (fill) scopes; scopes per type (FLOAT/COLOR/STRING). | [VariableScope](https://developers.figma.com/docs/plugins/api/VariableScope/) | dev docs | high |
| R3-17 | Scope UI: checkboxes per property, "Show in all" for all supported properties. | [Create and manage variables and collections](https://help.figma.com/hc/en-us/articles/15145852043927-Create-and-manage-variables-and-collections) | help | high |
| R3-18 | Edit variable modal: Name, Description, Values, Scope, Code syntax (≤3: Web, Android, iOS), Hide from publishing. Snippets: CSS, SwiftUI, Compose. | [Create and manage variables](https://help.figma.com/hc/en-us/articles/15145852043927) | help | high |
| R3-19 | Hide from publishing: per-variable checkbox; whole collection hidden by `_` or `.` name prefix. `hiddenFromPublishing` can only be true for local variables. | [Hide styles, components, and variables when publishing](https://help.figma.com/hc/en-us/articles/360039238193-Hide-styles-components-and-variables-when-publishing), [Variable.hiddenFromPublishing](https://developers.figma.com/docs/plugins/api/properties/Variable-hiddenfrompublishing) | help/dev | high |
| R3-20 | Groups: select variables → right-click → "New group with selection"; groups drag-reorderable and nestable; group = slash path in the variable name (no separate group API). | [Create and manage](https://help.figma.com/hc/en-us/articles/15145852043927), [forum thread](https://forum.figma.com/ask-the-community-7/is-there-a-way-to-create-a-variable-group-in-a-variable-collection-using-the-api-11038) | help + third-party | medium |
| R3-21 | Variables view (2026): entry point moved to the **Variables tab of the new left navigation bar**; full-window by default, "Minimize" to a resizable panel; collections sidebar, groups, table with modes as columns; "+ Create variable" with type dropdown; "Create collection"; "Reorder collections"/"Sort A to Z"; search by name/value/group, type filters; Shift+Enter duplicates; copy/paste variables across collections and files. | [Create and manage variables](https://help.figma.com/hc/en-us/articles/15145852043927) | help | high |
| R3-22 | New navigation bar tabs: Figma menu, File (pages+layers), Agents, Assets, Tools, Variables; "moved from the Properties panel (right sidebar)"; slow phased rollout (staff, 2026-01-28 and 2026-04-14). | [Explore the navigation bar](https://help.figma.com/hc/en-us/articles/360039831974-Explore-the-navigation-bar-and-left-sidebar), [forum 50019](https://forum.figma.com/report-a-problem-6/local-variables-tab-is-missing-from-properties-panel-50019), [forum 52976](https://forum.figma.com/ask-the-community-7/variables-unavailable-52976) | help + forum | high |
| R3-23 | Right panel, nothing selected: change canvas background, export page, local styles and variables; styles grouped by type text/color/effect/layout guides; historically the Variables section sat between Page and Styles. | [FD4B Navigate](https://help.figma.com/hc/en-us/articles/30925881896727-FD4B-Navigate-Figma-Design-files), [Manage and share styles](https://help.figma.com/hc/en-us/articles/360039820134-Manage-and-share-styles), [forum 52976](https://forum.figma.com/ask-the-community-7/variables-unavailable-52976) | help + forum | medium |
| R3-24 | Bindable properties (help): Color → solid fills, gradient stops, strokes, shadow colors, color styles; Number → size/min/max, radius, gap, padding, opacity, stroke weight, effects, layout guide values, typography; String → text content, font family, weight/style; Boolean → visibility; Timing/Easing → Motion presets. Press `=` in a field to open the picker. | [Apply variables to designs](https://help.figma.com/hc/en-us/articles/15343107263511-Apply-variables-to-designs) | help | high |
| R3-25 | `VariableBindableNodeField` = height, width, characters, itemSpacing, padding×4, visible, cornerRadius + 4 corners, min/max width/height, counterAxisSpacing, strokeWeight + 4 sides, opacity, gridRowGap, gridColumnGap. `VariableBindableTextField` = fontFamily, fontSize, fontStyle, fontWeight, letterSpacing, lineHeight, paragraphSpacing, paragraphIndent. Paint field = `'color'`. | [VariableBindableNodeField](https://developers.figma.com/docs/plugins/api/VariableBindableNodeField/), [TextField](https://developers.figma.com/docs/plugins/api/VariableBindableTextField/), [PaintField](https://developers.figma.com/docs/plugins/api/VariableBindablePaintField/) | dev docs | high |
| R3-26 | `boundVariables` shape: scalar fields → one `VariableAlias`; text fields → `VariableAlias[]` (ranges); `fills`, `strokes`, `effects`, `layoutGrids`, `textRangeFills` → arrays; `componentProperties` → map. `VariableAlias = {type:"VARIABLE_ALIAS", id}`. | [boundVariables](https://developers.figma.com/docs/plugins/api/properties/nodes-boundvariables/), [property types](https://developers.figma.com/docs/rest-api/file-property-types/) | dev docs | high |
| R3-27 | Fills/strokes/effects/grids must be bound via immutable arrays (`setBoundVariableForPaint/Effect/LayoutGrid`); text ranges via `setRangeBoundVariable`. | [Working with variables](https://developers.figma.com/docs/plugins/working-with-variables/), [figma.variables](https://developers.figma.com/docs/plugins/api/figma-variables/) | dev docs | high |
| R3-28 | "Control opacity at scale" (2026-09-03): alias a color and set opacity on top without detaching; opacity can be a number variable. Plugin Update 139 (2026-09-17): `VariableComposedColor` + `COLOR_OPACITY` scope. REST: `{color: Color \| VariableAlias, opacity: Number \| VariableAlias}`, at least one must be an alias. | [Update 139](https://developers.figma.com/docs/plugins/updates/2026/09/17/version-1-update-139/), [REST variable types](https://developers.figma.com/docs/rest-api/variables-types/), [release-note mirror](https://traceary.com/figma/2026-09-03-control-opacity-at-scale) | dev docs | high |
| R3-29 | Plugin `Variable`: id, name, description, hiddenFromPublishing, remote, variableCollectionId, key, resolvedType, valuesByMode (not alias-resolved), scopes, codeSyntax; methods setValueForMode, resolveForConsumer, set/removeVariableCodeSyntax, remove, getPublishStatusAsync, valuesByModeForCollectionAsync, removeOverrideForMode. | [Variable](https://developers.figma.com/docs/plugins/api/Variable/) | dev docs | high |
| R3-30 | Plugin `VariableCollection`: id, name, hiddenFromPublishing, remote, isExtension, modes[{modeId,name}], variableIds, defaultModeId, key; addMode (limited by plan), removeMode, renameMode, extend(name) (Enterprise), remove. | [VariableCollection](https://developers.figma.com/docs/plugins/api/VariableCollection/) | dev docs | high |
| R3-31 | REST Variable adds `deletedButReferenced` ("deleted in the editor, but the document may still contain references"); REST collection `modes` includes `parentModeId` for extended modes; plus `inheritedVariableIds`, `localVariableIds`, `variableOverrides`. | [REST variable types](https://developers.figma.com/docs/rest-api/variables-types/) | dev docs | high |
| R3-32 | Extended collections: Enterprise; can-edit users; "Extend collection"; only values can be overridden; cannot add variables/modes or change description/scope; inherits non-overridden updates; overrides highlighted blue; "Reset change"; color+opacity overridden together; accepting library updates removes previously set modes. | [Extend a variable collection](https://help.figma.com/hc/en-us/articles/36346281624471-Extend-a-variable-collection) | help | high |
| R3-33 | `ExtendedVariableCollection`: parentVariableCollectionId, rootVariableCollectionId (chain C→B→A), variableOverrides `{[variableId]: {[extendedModeId]: VariableValue}}`, modes with parentModeId, removeOverridesForVariable. | [ExtendedVariableCollection](https://developers.figma.com/docs/plugins/api/ExtendedVariableCollection/) | dev docs | high |
| R3-34 | Prototyping: Set variable (strings in quotes, numbers, true/false, hex colors); expressions — math `+ - * /`, string `+`, comparisons `== != > < >= <=`, logical `and`/`or`/`!`/`not`; precedence parens → `* /` → `+ -`; boolean: parens → comparisons → and → or. Used in Set variable and Conditional. | [Use variables in prototypes](https://help.figma.com/hc/en-us/articles/14506587589399-Use-variables-in-prototypes), [Use expressions](https://help.figma.com/hc/en-us/articles/15253194385943-Use-expressions-in-prototypes) | help | high |
| R3-35 | Multiple actions: unlimited per trigger, run top to bottom; Conditional = If (boolean expression) / Else, each holding one or more actions. | [Multiple actions and conditionals](https://help.figma.com/hc/en-us/articles/15253220891799-Multiple-actions-and-conditionals) | help | high |
| R3-36 | Set variable mode action changes the current page's mode; Auto objects follow; explicitly set modes keep themselves and their children. | [Variable modes in prototypes](https://help.figma.com/hc/en-us/articles/15253268379799-Variable-modes-in-prototypes) | help | high |
| R3-37 | Anyone with can-edit can create variables; prototype variables and publishing variables need Education or paid plans. | [Guide to variables](https://help.figma.com/hc/en-us/articles/15339657135383-Guide-to-variables-in-Figma) | help | high |
| R3-38 | Style types: Color (fill, stroke, image, gradient incl. angle, pattern, shader fill), Text, Effect (drop/inner shadow, layer/background blur, texture, noise, shader; multiple), Layout guide (rows, columns, uniform grid), Animation (Motion-only, 2026). | [Styles guide](https://help.figma.com/hc/en-us/articles/360039238753), [Create and edit styles](https://help.figma.com/hc/en-us/articles/360038746534-Create-color-text-effect-and-layout-guide-styles) | help | high |
| R3-39 | Style API: PAINT/TEXT/EFFECT/GRID/ANIMATION; PaintStyle, TextStyle, EffectStyle, GridStyle each have `boundVariables`; BaseStyle has id, name, description, descriptionMarkdown, documentationLinks, remote, key. REST: styleType FILL/TEXT/EFFECT/GRID; node `styles` map keys fill, stroke, effect, grid, text, background. | [PaintStyle](https://developers.figma.com/docs/plugins/api/PaintStyle/), [TextStyle](https://developers.figma.com/docs/plugins/api/TextStyle/), [EffectStyle](https://developers.figma.com/docs/plugins/api/EffectStyle/), [GridStyle](https://developers.figma.com/docs/plugins/api/GridStyle/), [REST property types](https://developers.figma.com/docs/rest-api/file-property-types/) | dev docs | high |
| R3-40 | Text styles include font family/weight/size, line height, letter spacing, paragraph spacing/indent, decoration, case, lists, OpenType; exclude alignment, color/fill, resizing. | [Create and apply text styles](https://help.figma.com/hc/en-us/articles/360039957034-Create-and-apply-text-styles) | help | high |
| R3-41 | Variables can be applied to styles and other variables, styles cannot be applied to either; scoping only for variables; styles hold composite values. Styles are like CSS classes, variables like CSS custom properties (2023 blog). | [Difference between variables and styles](https://help.figma.com/hc/en-us/articles/15871097384471-The-difference-between-variables-and-styles), [All your questions about variables](https://www.figma.com/blog/all-your-questions-about-variables-answered/) | help + blog | high |
| R3-42 | Style management: "+" next to Local styles; or "Apply styles or variables" → "New style or variable"; folders via slash names or "Add new folder" (renames to `Brand / Blog / Fuchsia`); drag to reorder; delete detaches but keeps properties; list/grid view in picker. | [Create and edit styles](https://help.figma.com/hc/en-us/articles/360038746534), [Manage and share styles](https://help.figma.com/hc/en-us/articles/360039820134-Manage-and-share-styles) | help | high |
| R3-43 | Publishing: needs ≥1 component/style/variable; paid plans; Assets tab → Libraries → Publish; changes listed as Created/Modified/Removed; consumers review & accept; "Add to file"; removing a library keeps used assets on canvas. | [Publish a library](https://help.figma.com/hc/en-us/articles/360025508373-Publish-a-library), [Add or remove a library](https://help.figma.com/hc/en-us/articles/1500008731201-Enable-or-disable-a-library-in-a-design-file) | help | high |
| R3-44 | Swap library replaces styles, instances and variables with name-matched assets from another library; unmatched stay linked. | [Swap libraries](https://help.figma.com/hc/en-us/articles/4404856784663-Swap-style-and-component-libraries) | help | high |
| R3-45 | Library API: `teamLibrary.getAvailableLibraryVariableCollectionsAsync()`, `getVariablesInLibraryCollectionAsync(key)`, `variables.importVariableByKeyAsync(key)` (published only); libraries can't be enabled via API. | [teamLibrary](https://developers.figma.com/docs/plugins/api/figma-teamlibrary/), [figma.variables](https://developers.figma.com/docs/plugins/api/figma-variables/) | dev docs | high |
| R3-46 | REST: GET `/v1/files/:key/variables/local` (local + remote used), GET `/published`, POST bulk with CREATE/UPDATE/DELETE on variableCollections, variableModes, variables, variableModeValues, temp IDs; dev docs say Enterprise only, pricing says Org+Enterprise (conflict). | [Variables endpoints](https://developers.figma.com/docs/rest-api/variables-endpoints/), [Pricing](https://www.figma.com/pricing/) | dev docs | medium |
| R3-47 | `.fig` Kiwi: node types VARIABLE, VARIABLE_SET, VARIABLE_OVERRIDE; VARIABLE has key (40-hex), name (e.g. "🎨/red/500"), variableResolvedType, variableDataValues.entries[{modeID, variableData}], variableSetID; aliases via assetRef.key; Paint has `colorVar`. Node fields `variableConsumptionMap`/`parameterConsumptionMap`; values may be Expression/PropRefValue. | [Grida fig.kiwi glossary](https://grida.co/docs/wg/feat-fig/glossary/fig.kiwi), [open-pencil PR 795](https://github.com/open-pencil/open-pencil/pull/795) | third-party | medium |
| R3-48 | Engineering (2025-07-29): component properties and variables unified into one parameter system — one binding storage, ≤1 parameter per layer property, property-level usage tracking/invalidation, transitive alias resolution. Schema 2025: mode switching 30–60% faster. | [A Tale of Two Parameter Architectures](https://www.figma.com/blog/a-tale-of-two-parameter-architectures/), [Schema 2025 recap](https://www.figma.com/blog/schema-2025-design-systems-recap/) | eng blog | high |
| R3-49 | Number bound to opacity >100 clamps to 100, negative → 0%; row/column counts must be whole. | [Overview](https://help.figma.com/hc/en-us/articles/14506821864087) | help | medium |

## 3. Implications for a single-user local clone

1. **Model variables and collections as scene-graph nodes**, like Figma's `VARIABLE_SET` and `VARIABLE` nodes, in the same per-file document as pages. The per-property LWW schema then covers them for free, and a later Firestore mapping stays 1:1. The fields are:
   - Collection: `{id, key, name, modes:[{modeId,name,parentModeId?}], defaultModeId (= first mode), hiddenFromPublishing, isExtension?, parentCollectionId?, variableOverrides?}`.
   - Variable: `{id, key, name (slash path = group), collectionId, resolvedType, valuesByMode, scopes[], codeSyntax{WEB,ANDROID,iOS}, description, hiddenFromPublishing, deletedButReferenced}`.
2. **Variable values are a tagged union**: literal, `{type:'VARIABLE_ALIAS', id}`, or composed color `{color, opacity}`. Reject self-references and cycles on write. Soft-delete variables that are still referenced, as `deletedButReferenced` does.
3. **Bindings live on nodes**:
   - `boundVariables`: scalar fields get one alias; fills, strokes, effects and layoutGrids get arrays, with the binding inside each paint, effect or grid item; text ranges get arrays; component properties get a map.
   - `explicitVariableModes: {collectionId: modeId}` on any node, **including pages**. No entry means Auto.
4. **The resolver** walks ancestors to find the mode for each collection, falling back to the collection's default. When it follows an alias, it switches to the consumer's mode for *that alias's collection*. Values are cached per property with dependency tracking, so a mode switch or edit re-resolves only the dependent properties (Figma's 2025 architecture).
5. **Implement styles as separate nodes** (`PAINT`, `TEXT`, `EFFECT`, `GRID`), which may contain bound variables. Nodes reference them through a `styles` map with the keys fill, stroke, effect, grid, text and background. A text style never carries fill.
6. **Libraries without a server**:
   - "Publish" snapshots the non-hidden variables, styles and components, with stable keys and a version, into a local library registry.
   - Consumer files "Add to file", copy the used assets as `remote: true` entries keyed by `key`, and "Review updates" to accept a diff.
   - Removing a library keeps the remote copies.
   - Collections whose names start with `_` or `.`, and variables marked hidden, are skipped.
7. **Plan limits**: as the single user, adopt Enterprise behaviour, but keep Figma's hard caps (5,000 variables per collection, ≤40 modes, mode names ≤40 chars). Extended collections can come in a later phase.
8. **UI targets**:
   - **(a) Variables view** as a full-window table: collections sidebar plus group tree with "All variables"; columns are Name plus one per mode; "New variable mode" (+) after the last column; "+ Create variable" with a type menu; search and type filter; right-click menus such as "Set as default", "Duplicate mode", "New group with selection", "Edit variable"…
   - **(b) Edit variable panel** with Name, Description, per-mode Values, Scope checkboxes with "Show in all", Code syntax and Hide from publishing.
   - **(c) Right panel with nothing selected**: Page (background and Apply variable mode), Styles (Text, Color, Effect, Layout guide, each with + and folders) and Export.
   - **(d) Selected layer**: "Apply variable mode" in Appearance, an "Apply variable" button on each bindable field, `=` to open the picker, and "Detach variable".
   - Decide whether to copy the 2026 left-nav "Variables" tab or the pre-2026 right-panel "Local variables" section.
9. **Prototyping**: Set variable, Set variable mode (page level) and Conditional with an expression parser that follows Figma's precedence. Variables change in the player's runtime state, not in the document.
10. **Types**: ship Color, Number, String and Boolean first. Timing and Easing only matter once a Motion timeline exists.
11. **Import/export** variables per mode as DTCG JSON, as Figma does natively.

## 4. Open questions

- How does `.fig` store explicit modes on nodes (field name unverified)? Is the page-level mode a page field?
- Are hidden-from-publishing variables that published variables alias still shipped to consumers so the aliases resolve? Forum reports are inconclusive.
- Do variable values changed in a prototype persist across navigation, and do they reset on restart? This is not documented.
- What are the exact current (2026) section names and order in the right panel with nothing selected, now that Variables moved to the left nav? Does the Page section list library collections for Apply variable mode?
- Does the Variables view show subscribed library collections read-only?
- Is there a maximum number of collections per file, or a maximum extension depth?
- REST variables API: Enterprise only (dev docs) or Organization+ (pricing page)?
- Is Enterprise's mode limit per collection still 40 (REST validation) or truly unlimited?
- How do text styles with bound number variables resolve in the style picker preview, given they depend on the consumer's mode?

## 5. Round 5 additions (2026-10-08)

Read during round 5 (help articles through Zendesk's public JSON; Figma's file encodings from the owner's private file, counts only, nothing of its content committed).

| ID | Claim | Source | Kind | Conf. |
|---|---|---|---|---|
| R3-50 | Every boolean bound to visibility is stored as `EXPRESSION IS_TRUTHY [alias]` (resolved BOOLEAN), never a bare alias: 125 `VISIBLE` expression entries, 0 aliases, besides 404 `PROP_REF`. | owner's .fig (kiwi) | file | high |
| R3-51 | A variant property bound to a variable: the instance's `VARIANT_PROPERTIES` entry = `EXPRESSION RESOLVE_VARIANT [MAP]` (resolved `SYMBOL_ID`); the MAP's values `{key: property name, guidKey: the set's VARIANT ComponentPropDef id, value: ALIAS (STRING)}`. Written on the instance node and in the usage site's override entries (21 entries). `symbolData.symbolID` holds the resolved variant. | owner's .fig | file | high |
| R3-52 | "Boolean, number, and string variables can be assigned to component instances with variant properties"; on an instance, hover the variant property → "Assign variable"; "the instance will switch to a different variant whenever the mode switches"; also on nested instances. "Currently, boolean variables cannot be applied to boolean properties" (workaround: a true / false variant property). | [Modes for variables](https://help.figma.com/hc/en-us/articles/15343816063383) | help | high |
| R3-53 | Component property defaults: a boolean property's default can "Apply variable" (a boolean variable), a text property's a string variable — in the Create / Edit component property modal. | [Create and use component properties](https://help.figma.com/hc/en-us/articles/5579474826519) | help | high |
| R3-54 | Mode context menu wording: "Duplicate mode", "Set as default", "Move column right", "Move column left", "Import mode", "Export mode"; collection: "Export modes". | [Modes for variables](https://help.figma.com/hc/en-us/articles/15343816063383) | help | high |
| R3-55 | Extended collections: "Extend collection" (right-click the parent); overrides in blue; "Reset change"; can't add variables or modes or change description / scope; colour and opacity overridden together; accepting library updates removes previously set modes (reapply with the extension). | [Extend a variable collection](https://help.figma.com/hc/en-us/articles/36346281624471) | help | high |
| R3-56 | REST: extended collections' modes have encoded ids `VariableCollectionId:1:2/3:4`; `parentModeId`; `inheritedVariableIds` / `localVariableIds`; only local collections can be extended through REST, "you can still modify local extensions of subscribed collections". Plugin API `ExtendedVariableCollection.removeMode` only once its parent mode is deleted. | [REST variable types](https://developers.figma.com/docs/rest-api/variables-types), [ExtendedVariableCollection](https://developers.figma.com/docs/plugins/api/ExtendedVariableCollection/) | dev docs | high |
| R3-57 | One mode value per collection: a component pinning a parent collection's mode overrides an extended collection's mode in its instances (Figma staff reply, 2026). | [forum 57108](https://forum.figma.com/report-a-problem-6/extended-collections-collection-variant-and-mode-share-one-value-57108) | forum | medium |
| R3-58 | Variables view (2026): "Reorder collections" (popup, drag or "Sort A to Z"); groups: "Ungroup", "Duplicate group", "Delete group", drag to nest; multi-select → "Edit variables" (scope, hide from publishing); Copy / Paste across collections and files; value context menu "Create alias", hover "Detach alias"; search by name, value or group; type filter. | [Create and manage variables and collections](https://help.figma.com/hc/en-us/articles/15145852043927) | help | high |
| R3-59 | Timing / Easing variables drive Motion; prototype transitions' duration / easing can't be bound to variables (feature requests open: forum 52118 Mar 2026, 32147). | [forum 52118](https://forum.figma.com/suggest-a-feature-11/variables-for-animation-properties-52118), [Transition API](https://developers.figma.com/docs/plugins/api/Transition) | forum + dev docs | medium |
| R3-60 | Figma's schema has `VARIABLE_OVERRIDE`, `VariableSetMode.parentVariableSetId / parentModeId`, `VariableModeBySetMapEntry.variableSetExtensionID`, NodeChange `backingVariableSetId`, `backingVariableId` (variable or override id), `overriddenVariableId`, `rootVariableKey`, `inheritedVariableIds`, `isCollectionExtendable` (13 of 24 collections in the owner's file `true`). Which of them Figma's VARIABLE_OVERRIDE uses is unverified (no file with an extension). | docs/research/figma/figma-schema.kiwi | schema | medium |
