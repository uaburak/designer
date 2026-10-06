# Subsystem: Inspector, variables, styles, components, libraries

Repo: `/Users/burak/Desktop/Burak/Code/DesignerV2` (read-only review). All paths below are relative to `src/renderer/src/` unless they start with `docs/` or `AGENTS.md`.

## 1. Summary: how it works today

There is exactly **one design system for the whole app**, the website's. It is not per file:

- **Variables** live in Firestore `design/variables` as `{ variables, deleted, rev }` (`lib/firestore.ts:261-279`, `:320-324`).
- **Text styles** live in `design/textStyles` as `{ styles, deleted, rev }` (`lib/firestore.ts:274-276`, `:325-329`).
- **Components and effect styles** live in `design/library` as a single JSON string holding a `StoredLibrary` `{ nodes, effectStyles, version, seeded, deleted }` (`lib/data.ts:70-79`, `lib/firestore.ts:277`, `:330-333`).

On top of what is stored there are hard-coded "starting" assets:

- 28 site tokens as variables (`components/project/designVariables.tsx:28-58`)
- 17 text styles, with Turkish names (`components/project/textStyles.ts:28-46`)
- about 40 site components with fixed `c-*` ids, built in code (`figma/library.ts:222-562`)

Starting variables and text styles are merged under the stored ones each time they are read (`withStartingVariables` `designVariables.tsx:61-65`, `withStartingTextStyles` `textStyles.ts:49-62`). They cannot be deleted, only reset (`figma/designSystem.ts:90-91`, `:113`). Starting components are upgraded by `LIBRARY_VERSION` plus a JSON "signature" diff (`systemLibrary.ts:37-57`, `library.ts:597-621`).

**Opening a project merges everything into one editable file.** `useEditSession` loads the project canvas and `loadDesign()` in parallel (`figma/session.ts:92`). It then:

1. Detaches whatever was deleted from the design system since the project was last saved (`detachDeleted`, `systemLibrary.ts:212-240`).
2. Injects the global component library into the project as a hidden page, `p-components` / "Components" (`withLibrary`, `systemLibrary.ts:62-65`; `library.ts:28`, `:35`). The library's `effectStyles` become `FigmaDocument.effectStyles`.

The resulting `EditState` (`designSystem.ts:15-22`) bundles:

- `file`: the project plus the injected library
- `variables`, `textStyles`: stored only, without the starting ones
- three tombstone lists: `deletedVariables`, `deletedTextStyles`, `deletedComponents`

One undo stack covers all of it (`designSystem.ts:8-14`, `session.ts:161`).

**Save splits the file back apart.** `splitLibrary` (`systemLibrary.ts:71-76`) separates the project from the library. `changedParts` compares by reference (`session.ts:59-66`). Each changed part goes to Firestore in one transaction, with optimistic `rev` checks (`session.ts:179-185`, `lib/firestore.ts:290-339`). The result: an edit to a library component, variable or text style made in project A reaches every project as soon as A is saved. There is no publish, version or review step. Published site pages freeze a copy of the variables and text styles plus the components they use (`figma/publish.ts:90-111`).

**Variables** (`types/design.ts:10-29`):

- Three kinds: `"color" | "number" | "weight"`.
- Each value is a `VariableValue = {value} | {alias}` (`design.ts:14`).
- Modes are fixed: a colour has `light` and an optional `dark`; numbers and weights have only `light` (`design.ts:21-24`).
- A "collection" is just an optional string tag on each variable (`design.ts:27-28`). The Variables window derives the collection list from those tags (`figma/VariablesTable.tsx:19-21`). A collection exists only while it holds a variable, so "Create collection" also creates a colour variable (`VariablesTable.tsx:24-32`).
- `token` ties a variable to a site CSS custom property (`design.ts:25-26`, `designVariables.tsx:91-94`).
- Resolution follows aliases with cycle detection (`resolvedValue`, `designVariables.tsx:75-82`; `boundValue` `:85-89`). The editor's arithmetic `numberOf` always resolves the **light** value (`figma/model.ts:1253-1269`).
- Drawing turns every bound value into `var(--token)` CSS (`cssValue`, `designVariables.tsx:101-108`). The variables themselves are injected as one stylesheet scoped to `[data-design-scope]`, with dark values under the site's `[data-theme="dark"]` (`designVariables.tsx:111-122`, `components/project/designSystem.tsx:26-30`).
- The active "mode" is the app's UI theme, passed in as `mode={theme}` (`figma/FigmaEditor.tsx:185`, `:2503`).

**Binding a node to a variable.** Every bindable field is itself typed `VariableValue`:

- `Paint.color` (`model.ts:28-36`)
- `StrokeStyle.color` and `weight` (`model.ts:91-102`)
- `cornerRadius` and `corners` (`model.ts:282-289`)
- `itemSpacing`, `counterSpacing` and the four paddings (`model.ts:333-355`)
- text `fontSize`, `fontWeight`, `lineHeight`, `letterSpacing` (`model.ts:303-308`)
- `widthVar` / `heightVar` (`model.ts:266-268`)

Effects, opacity, visibility and characters cannot be bound: `Effect.color` is a plain string (`model.ts:105-107`).

**Text styles** (`design.ts:40-64`): a `TextStyle` holds `fontSize`, `fontWeight`, `lineHeight` and `letterSpacing` (each a `VariableValue`), **plus a colour**, plus site-only fields `small` (phone sizes below 640px) and `tag` (h1–p, for SEO). A text node points to one by `textStyle?: string` (`model.ts:313-314`). The style is drawn by a CSS rule on `[data-text-style=id]` (`textStyles.ts:91-108`), and `textCss` skips the node's own typography when a style is set (`figma/css.ts:261-268`).

**Effect styles** (`EffectStyle {id, name, effects}`, `model.ts:56-61`) are stored inside `design/library`. Applying one copies `effects` into the node and records `effectStyle: id` (`FigmaEditor.tsx:1170-1173`). The node keeps that copy: editing the style later would not update the node (no `effectStyle` lookup in `css.ts:69-83`), and the Inspector has no way to edit a style anyway.

**There are no colour (paint) styles.** The Inspector's "Color styles" list is the colour variables (`Inspector.tsx:2247-2248`), and "Create color style" creates a colour variable (`FigmaEditor.tsx:1189-1195`). There are no grid styles.

**Components:**

- `type: "component"` frames, grouped into sets: a `componentSet` whose `component` children carry `variant: [{property, value}]` (`model.ts:366-367`, `variantProperties` `:897-910`).
- Properties: `ComponentProperty` of type `boolean | text | instanceSwap`, with a default `value` and `preferred` (`model.ts:168-178`), stored on the component or its set (`propertyHolder` `:913-917`).
- Layers bind to properties through `visibleProp`, `charactersProp` and `mainProp` (`model.ts:270`, `:316`, `:381`).
- An instance is a `FrameNode` with `type: "instance"`, a bare `mainId`, its own `props` / `propsEn` / `propsI18n`, and `overrides` keyed by **layer name path** ("Card›Title", `model.ts:372-389`, `:986-1001`).
- `resolveInstance` (`model.ts:1008-1102`) finds the main component with `findComponent(nodes, id)` over the whole open file. `libraryOf` is the current page, then the project page, then the other pages, including the injected library page (`model.ts:603-607`). It then applies property values and overrides by name path.
- An instance knows nothing of a file or library key. It resolves across projects only because the library page is merged into every open file. When the main is not found, the instance draws a dashed box in the editor and nothing on the site (`NodeView.tsx:374-383`). The Inspector shows "No main component" (`Inspector.tsx:1609`). A found main is always labelled "From this file", even when it comes from the site library.

Components made in a project (`createComponent`, `FigmaEditor.tsx:734-747`) stay on the project's own pages and are saved with the project, so they are local to it. The Assets tab lists project-local and site-library components together under "Local components" (`FigmaEditor.tsx:2085`, `:2298-2319`).

**Deletion uses tombstones.** Deleting a variable:

- freezes every alias of it to its light value in the open file, the other variables and the text styles (`designSystem.ts:88-102`, `withoutVariables` `systemLibrary.ts:160-185`, `frozenValues` `:190-193`)
- appends a tombstone (`keptTombstones`, capped at `TOMBSTONES_KEPT = 100`, `systemLibrary.ts:22`, `:149-152`)

Deleting a text style copies its typography into the texts that use it (`withoutTextStyles` `systemLibrary.ts:196-204`). Deleting a component turns its instances into frames (`withDetached` `:124-128`, `detachedFrame` `:100-106`). Projects that were not open apply the same changes the next time they are opened (`detachDeleted`).

**The Inspector** (`figma/Inspector.tsx`, 2369 lines) is one React component, `Inspector` (`:2201-2367`). It is driven by an `EditorOps` interface of about 70 callbacks (`:22-116`) that `FigmaEditor` implements.

- **Nothing selected:**
  - "Page" section: canvas colour, an "Open variables" icon, the site "Language" row
  - "Styles" section: a text-style tree, colour variables as "Color styles", "All variables (N)…" and effect styles
  - Export of the site page frame (`:2233-2259`)
- **A selection:** the header (`:2308-2328`), then:
  - Embed (site only)
  - Instance, Current variant or Properties
  - Position (`:534-570`)
  - Layout or Auto layout (`:615-835`), or Multi Layout (`:577-613`)
  - Appearance (`:932-991`)
  - Typography (`:1196-1297`)
  - Fill (`:1052-1068`)
  - Stroke (`:1070-1105`)
  - Effects (`:1107-1146`)
  - Selection colors (`:2061-2088`)
  - "Layout grid" (`:1856-1885`)
  - Link (site only, `:2025-2036`)
  - Export (`:2038-2058`)
- The Prototype tab is `PrototypeSection` (`:1673-1853`).

## 2. Files read

| File | Lines | Role |
|---|---|---|
| figma/Inspector.tsx | 2369 | Properties panel (Design and Prototype tabs), style lists, text-style editor window, property windows |
| figma/designSystem.ts | 135 | `EditState` + `designSystemOf`: variable / text-style / component CRUD over the global system, with tombstones |
| figma/systemLibrary.ts | 243 | Global library seeding and migration, `withLibrary` / `splitLibrary`, detach-on-delete, tombstones |
| figma/library.ts | 630 | Hard-coded starting site components (c-*), `LIBRARY_VERSION`, signatures, `uniqueNames`, `withFreeIds` |
| figma/VariablesTable.tsx | 162 | Variables modal: collections (string tags), groups, Light/Dark table |
| figma/overview.ts | 250 | Site Overview instance (project title/cover fields): fixed parts, guards |
| types/design.ts | 115 | `DesignVariable`, `VariableValue`, `TextStyle`, `BlendMode`, interaction enums |
| components/project/designVariables.tsx | 143 | Starting variables, resolution, CSS generation, React context |
| components/project/textStyles.ts | 113 | Starting text styles, merge, CSS generation, context |
| components/project/designSystem.tsx | 30 | Provider and the `<style>` injecting variables, text styles and motion CSS |
| components/project/interactions.ts | 166 | Prototype enums/labels, spring-to-CSS easing, `MOTION_CSS` |
| components/project/RichText.tsx | 66 | Site copy markdown (bold/links): unrelated to Figma |
| home/Library.tsx | 185 | Home "Library" view: read-only gallery of the global library |
| figma/__tests__/system.test.ts | 157 | Tests for library seeding, split, overview, tombstones, `designSystemOf`, publish |
| figma/model.ts (parts) | 1447 | Paint, Stroke, Effect, EffectStyle, nodes, `ComponentProperty`, overrides, `resolveInstance`, `libraryOf`, `numberOf` |
| figma/session.ts | 286 | Load: merge design into file. Save: split and transaction. Publish. |
| lib/firestore.ts, lib/data.ts (parts) | 441 / — | `design/*` storage, `StoredLibrary`, `SaveRequest`, `saveAll` |
| figma/FigmaEditor.tsx (parts) | 2527 | The `EditorOps` implementations for styles, components and instances |
| figma/publish.ts | 111 | Freezes the page, used components and the design system for the site |
| figma/popover.tsx, ColorPicker.tsx, css.ts (parts) | — | `VariablePicker`, Libraries tab, how bindings are drawn |

## 3. Data shapes (file:line)

- `VariableKind = "color" | "number" | "weight"` (types/design.ts:11)
- `VariableValue = {value: string|number} | {alias: string}` (types/design.ts:14)
- `DesignVariable {id, name, kind, light, dark?, token?, collection?}` (types/design.ts:16-29)
- `Typography {fontSize, fontWeight, lineHeight, color, letterSpacing?}` (types/design.ts:41-52)
- `TextStyle extends Typography {id, name, description?, small?, tag?}` (types/design.ts:54-64)
- `EffectStyle {id, name, effects}` (model.ts:57-61); `FigmaDocument.effectStyles` (model.ts:583-584)
- `Paint {type?, color: VariableValue, opacity?, visible?, gradient?, image?}` (model.ts:28-36); `StrokeStyle {color, opacity?, visible?, weight: VariableValue, align, sides?, dashed?}` (model.ts:91-102)
- `Effect`, a union of shadow and blur, with `color: string` that cannot be bound (model.ts:105-107)
- `ComponentProperty {id, name, type: boolean|text|instanceSwap, value, preferred?}` (model.ts:168-178)
- `FrameNode` component fields: `variant`, `properties`, `mainId`, `props`, `propsEn`, `propsI18n`, `mainProp`, `overrides`, `effectStyle` (model.ts:364-389); `NodeOverride` (model.ts:392-416); `OVERRIDABLE` (model.ts:419)
- `TextNode.textStyle` and `charactersProp` (model.ts:313-316); `BaseNode.widthVar`, `heightVar`, `visibleProp`, `fixed` (model.ts:266-274)
- `StoredLibrary {nodes, effectStyles, version, seeded, deleted}`; `DeletedComponent {id, node}`; `StoredDesign`; `SaveRequest` (lib/data.ts:64-106)
- `EditState {file, variables, deletedVariables, textStyles, deletedTextStyles, deletedComponents}` and the `DesignSystem` ops (figma/designSystem.ts:15-45)
- `EditorOps`, about 70 members (figma/Inspector.tsx:22-116)
- `OverviewParts` (figma/overview.ts:57-68), `FixedPart` (model.ts:280)

## 4. Key mechanisms

1. **Global storage and transactions.** `loadDesign` reads the three `design/*` documents (`lib/firestore.ts:265-280`). `saveAll` writes each changed part in one `runTransaction`, checking `rev` per part (`:299-336`). The library is a single JSON blob held to the 1 MB document limit (`:293-297`).
2. **The library merged into every file.** On load: `currentLibrary` (`systemLibrary.ts:37-57`), then `detachDeleted`, then `withLibrary` and `withOverview` (`session.ts:96-113`). On save: `splitLibrary` (`session.ts:179-183`). Dirty tracking by reference: `projectChanged` / `libraryChanged` (`systemLibrary.ts:79-95`, `session.ts:59-66`).
3. **Starting-asset migration.** `seededLibrary` stores each starting component's signature (`systemLibrary.ts:25-28`). On a version bump, a component still matching its seeded signature is replaced, an edited one is kept, and new ones are added unless deleted (`:40-56`). `signature` strips layer ids and placement (`library.ts:603-621`); `withFreeIds` avoids id clashes (`:624-630`).
4. **Variable resolution.** `modeValue` / `resolvedValue` / `boundValue` (`designVariables.tsx:70-89`). CSS output: `cssValue` returns `var(--token)` (`:101-108`); `variablesCss` writes the light rule and a dark rule under `[data-theme="dark"]` (`:111-122`). The editor resolves through `numberOf`, light only (`model.ts:1254-1269`).
5. **Binding UI.**
   - `BoundNumber` shows a chip with the resolved number, a hexagon that opens `VariablePicker`, and a detach button that freezes the current value (`Inspector.tsx:146-194`; `popover.tsx:62-125`).
   - `PaintRow` shows a variable pill or a hex field; `ColorPicker` has "Custom" and "Libraries" tabs (`Inspector.tsx:197-263`; `ColorPicker.tsx:157-176`).
   - Gap and padding are bindable (`Inspector.tsx:765-807`). W/H bind through the sizing menu's "Apply variable…" (`:651-653`). Corner radius is bindable (`:974`, `:993-1014`).
   - The Fill/Stroke "Styles and variables" button applies to the first paint only (`:1021-1045`, `:1056`, `:1074-1075`).
6. **Text style application.** Typography → Text styles menu, or a Select (`Inspector.tsx:1232`, `:1263`). Changing any typography value while a style is applied detaches it, keeping the style's values (`:1199-1206`). The "Edit text style" window (`:422-487`) edits the global style through `ops.setTextStyle`, which becomes `system.setTextStyle` (`FigmaEditor.tsx:1187`, `designSystem.ts:105`). `createTextStyle` builds a style from a text node, colour taken from its first fill (`FigmaEditor.tsx:1176-1186`).
7. **Effect styles.** Create from a node's effects, apply (copy), detach, remove: `FigmaEditor.tsx:1159-1175`; UI at `Inspector.tsx:1114-1132`, `:2250-2255`.
8. **Instance resolution and overrides.**
   - `resolveInstance` (`model.ts:1008-1102`); `layerAt` for composite ids "instanceId/Name›Path" (`:1147-1165`).
   - When the instance itself is selected, Inspector edits are split: OVERRIDABLE keys become the override `"${id}/"`, the rest patch the instance (`Inspector.tsx:2266-2280`).
   - Instance panel: variant selects, property toggles and text fields, instance swap selects, reset, detach, go to main (`Inspector.tsx:1582-1647`).
   - Push to main / swap / detach / go to main (`FigmaEditor.tsx:960-1029`, `:760-769`).
9. **Component authoring.**
   - Properties window: add Variant/Boolean/Instance swap/Text, rename, defaults (`Inspector.tsx:1420-1580`).
   - Current variant editing and a conflict warning (`:1326-1399`).
   - Bind a layer's visibility, text or instance to a property (`:936-945`, `:1207-1221`, `:1589-1599`).
   - Model helpers: `applyPropertyValue` / `pruneBindings` (`model.ts:950-971`). Renaming a layer migrates override keys (`model.ts:1173-1221`). `uniqueNames` enforces unique sibling names because overrides are keyed by name (`library.ts:564-583`).
10. **Deletion and tombstones.** `designSystemOf.removeVariable` / `removeTextStyle` / `deleteComponent` (`designSystem.ts:88-133`) in one undo step. Projects not open catch up through `detachDeleted` at load (`systemLibrary.ts:212-240`, `session.ts:99-105`).
11. **Styles list (nothing selected).** `TextStyleTree` / `ColorStyleTree` build nested groups from "/" in names (`Inspector.tsx:346-393`, `:490-525`). The trees start fully collapsed (`:347-348`).
12. **Home Library view.** `LibraryView` calls `loadDesign` once and renders a component card for each holder (scaled `NodeView`), colour swatches and text-style rows (`home/Library.tsx:26-149`). The Overview is filtered out (`:89-90`).

## 5. Inspector vs Figma UI3 properties panel

| UI3 section | Here | Gaps |
|---|---|---|
| Header (layer type, component actions) | Kind label or (main) component name; Create component, Select all variants, Select set, Add variant, Add property, mask, More (`Inspector.tsx:2283-2328`) | No Frame/Group/Section type switch: the model has no group, section, vector, polygon, star or boolean nodes (`model.ts:16`) |
| Instance / component properties | `InstanceSection`, `CurrentVariantSection`, `PropertiesSection` (`:1338-1647`) | Always "From this file", no library name (`:1609`). `preferred` can be read but not edited (`:1601`). No exposed nested instances. No component description or links. |
| Position | Alignment, X/Y, rotation, rotate 90 / flip (`:534-570`) | **No constraints** (no field in `BaseNode`, `model.ts:226-277`) |
| Layout / Auto layout | Freeform/Vertical/Horizontal/Grid, W/H with sizing menu, min/max, alignment grid, gap (Auto), padding, advanced menu, Clip content (`:615-835`) | Site-only "On narrow screens" select (`:817-832`). Ignore-auto-layout is the Position absolute toggle (`:541`). |
| Appearance | Opacity, corner radius / independent corners, blend mode, visibility, boolean binding (`:932-991`) | No corner smoothing. **No variable mode control**: the mode is the app theme (`FigmaEditor.tsx:2503`). Opacity cannot be bound. |
| Typography | Text style select, weight (only 300–700, `:1197`), size, line height, letter spacing, align, auto-resize, type settings menu (`:1196-1297`) | No font family (shown as a fixed "Inter", `:471`, `:1263`). No paragraph spacing UI (field exists, `model.ts:324-325`). No mixed-range styles. A raw textarea edits the characters (`:1257-1259`), which Figma does not have. The site-only "On the site" tag menu (`:1235`). |
| Fill | Multiple paints; solid, linear gradient or image; variable pill; Libraries button (`:1052-1068`) | New fills default to the site variables `bg-5` / `text-title` (`:1060`). No paint styles. No paint blend mode. Gradient is linear only (`model.ts:33`). |
| Stroke | Per paint: colour, position, weight, solid/dashed, sides (`:1070-1105`) | Position and weight live on each paint, not the node (`model.ts:91-102`). No caps, joins or dash pattern. Default `border-hover` alias (`:1079`). |
| Effects | Shadows and blurs, effect-style menu (`:1107-1146`) | Styles are copied, not linked. No style edit or rename. Shadow colour cannot be bound (the picker gets `variables={[]}`, `:1184`). |
| Layout guide | Titled "Layout grid" (`:1861`): columns, rows or grid; count, gutter, margin, colour (`:1856-1885`) | No grid styles. No alignment (stretch/center/min) for columns and rows. |
| Selection colors | Only shown with two or more colours (`:2071`); variable entries read-only (`:2076-2080`) | |
| Export | 1–4x, PNG/JPG/SVG, export button (`:2038-2058`) | No PDF, suffix or preview |
| Site-only | Embed (`:1928-2022`), Link (`:2025-2036`) | Drop |
| Nothing selected | Page: background, "Open variables" icon, Language row. Styles: text, colour (= variables), effect. Export of `pageId` (`:2233-2259`) | UI3 lists local variables and local styles as their own sections. Here "Color styles" are variables, there are no grid styles, no style context menu (edit, duplicate, delete, move to group), and "Create effect style" is disabled. |

## 6. Coupling to burakkoc.net / Firebase / the site (to drop or replace)

- `AGENTS.md`: the editor is a copy of the web admin's; model changes must be mirrored into `burakkoc.net/Web/portfolio/src/figma`.
- `lib/firestore.ts:34-36`, `:261-279`, `:290-339`: storage in `design/variables`, `design/textStyles`, `design/library`, and the cross-part transaction. `lib/data.ts:62-106`: `StoredLibrary`, `StoredDesign`, `SaveRequest`.
- `figma/session.ts:92-118`: load merges design into the file. `:169-207`: save splits it out. `:217-232`: publish to the site with frozen variables and styles. `:77`: project fields come from the Overview.
- `figma/systemLibrary.ts` (entire file): the global library, seeding/migration (`:25-57`), merge and split (`:61-95`), tombstone catch-up (`:206-240`).
- `figma/library.ts` (entire file): the site's starting components (Turkish copy, the 940px `CONTENT` column `:39`, `TEMPLATE_OVERVIEW` `:31-34`, `LIBRARY_VERSION` history `:21-26`, `:36`, the Overview component `:519-537`, `narrow: "stack-sm"` `:327`, `:395`, `:434`).
- `figma/designSystem.ts:8-22`, `:58-59`, `:123-133`: the edit state mixes one file with the global system; starting-asset checks; deleting from the global library.
- `figma/overview.ts` (entire file): the project's Overview instance as project metadata, `fixed` parts and guards (`model.ts:273-280`).
- `figma/publish.ts` (entire file): the published site page.
- `types/design.ts:3-8`, `:21-26` (light/dark are the site themes; `token` names a site CSS variable), `:60-63`, `:66-67` (`small` for below 640px, `tag` for SEO).
- `components/project/designVariables.tsx:28-58` (site tokens, Turkish names), `:111-122` (`[data-design-scope]`, `[data-theme="dark"]`), `:141-143`.
- `components/project/textStyles.ts:28-46` (starting styles), `:52-58` (flat-name migration), `:91-108` (CSS with the 639px media query).
- `components/project/designSystem.tsx:7-30`: CSS injection for the site page and canvas.
- `components/project/RichText.tsx` (entire file): site markdown.
- `components/project/interactions.ts:161-166`: `MOTION_CSS` for the site.
- Inspector:
  - EmbedSection (`:1888-2022`), LinkSection (`:2024-2036`)
  - "On narrow screens" (`:817-832`); "On the site" tag (`:466`, `:1234-1235`, `TAG_LABEL` `:2197`)
  - LanguageRow / AddLanguageWindow (`:2092-2180`, `:2242`); language-aware text and props (`:1257-1259`, `:1639-1641`)
  - default aliases `text-title`, `bg-5`, `border-hover` (`:1060`, `:1079`)
  - page-frame export via `ops.pageId` (`:2235`, `:2257`); `EditorOps.upload` and `pageId` (`:108-111`)
- `FigmaEditor.tsx:429-439`: confirm dialog wording "Delete … from the site's components". `:2320-2329`: Embeds in Assets.
- `home/Library.tsx:13-18`, `:26-65`, `:89-90`, `:98-100`: the single site library and its "reaches a published page" text.

## 7. Gaps against how Figma behaves

1. **No per-file assets.** Variables, text styles, effect styles and library components are global (`design/*`). Only components drawn on a project's own pages are file-local (`FigmaEditor.tsx:734-747`), and Assets lists both kinds under "Local components" (`:2298`).
2. **No library lifecycle.** Nothing publishes a file as a library, enables or subscribes to libraries per file, versions a library, or offers "Updates available → Review → Accept". Edits reach every project on Save. Deletions catch up through tombstones capped at 100 (`systemLibrary.ts:22`).
3. **Variables are not Figma's.**
   - Kinds are color/number/weight instead of COLOR/FLOAT/STRING/BOOLEAN with scopes (`design.ts:11`).
   - Modes are fixed light/dark, and colours only (`design.ts:21-24`; `VariablesTable.tsx:106-107`, `:130-131`).
   - Collections are string tags that cannot be empty (`VariablesTable.tsx:20-32`).
   - No description, code syntax, hide-from-publishing or scopes. The table cannot set an alias (`:122-124`).
   - No mode set per frame or page; the mode follows the app's UI theme (`FigmaEditor.tsx:2503`).
4. **Text styles are not Figma's.** They carry a colour (`design.ts:48-49`), have no font family or style, no paragraph spacing, and no case or decoration (case and decoration are per node, `model.ts:318-319`). They add the site-only `small` and `tag`.
5. **No colour (paint) styles.** Colour variables stand in for them (`Inspector.tsx:2247-2249`, `FigmaEditor.tsx:1189-1195`). **No grid styles.**
6. **Effect styles are not linked.** Applying copies the effects (`FigmaEditor.tsx:1170-1173`). There is no edit or rename, and a removed style leaves dangling `effectStyle` ids (`:1175`).
7. **No mixed styling inside one text**: a `TextNode` has a single typography (`model.ts:296-326`).
8. **Instances reference mains by bare id** (`model.ts:372-373`), with no library or file key, and **overrides are keyed by layer name path** (`model.ts:383-386`). Figma keys overrides by stable layer ids.
9. **Inspector gaps**: no constraints; no group/section/vector nodes; no corner smoothing; stroke weight and position per paint; no paint blend modes; only linear gradients; weights limited to 300–700 and no font family; no PDF export or suffix; section titled "Layout grid"; the instance panel never names its source library.
10. **The Home "Library" view is a read-only gallery** of the one global library (`home/Library.tsx`). Figma's equivalent is the per-file Libraries modal: enable or disable team libraries, and review updates.

## 8. Problems (bugs, performance ceilings, architectural debt)

1. **Text style colour is ignored when the text has a fill.**
   - `textCss` puts the fill colour inline (`css.ts:274-275`).
   - The style's colour comes from a stylesheet rule (`textStyles.ts:105`), which inline style always beats.
   - Text built from a style always gets that colour as a fill (`library.ts:121`), and `createTextStyle` leaves the fill in place (`FigmaEditor.tsx:1183-1184`).
   - Result: editing a style's colour has no visible effect on those texts.
2. **Effect styles are snapshots.** Changing a style could never propagate. Removing one does not clean up the nodes that use it. Removals are not tombstoned, so other projects keep dangling ids (`FigmaEditor.tsx:1170-1175`; `detachDeleted` ignores effect styles, `systemLibrary.ts:212-240`).
3. **The tombstone cap can lose data.**
   - After more than 100 deletions (`systemLibrary.ts:22`, `:149-152`), a project that was not open meanwhile finds dangling `mainId`s and aliases.
   - Instances then draw nothing on the site (`NodeView.tsx:380`) and aliases resolve to null (`designVariables.tsx:101-104`).
   - `frozenValues` keeps only the light value (`systemLibrary.ts:189-193`), so a colour's dark value is lost on delete.
4. **The variable mode is tied to the UI theme** (`FigmaEditor.tsx:2503`). `numberOf` always resolves light (`model.ts:1253`), so arithmetic ignores the mode.
5. **The Variables table overwrites aliases.** Editing a value writes `{value}` over an alias without warning (`VariablesTable.tsx:122-124`). Dark is not editable for numbers (`:130-131`). "Toggle sidebar" has no handler (`:58`).
6. **Multi-step operations create several undo steps.**
   - `renameCollection` calls `setVariable` once per variable (`VariablesTable.tsx:33-37`).
   - `createColorStyle` is `addVariable` plus `setVariable` (`FigmaEditor.tsx:1189-1195`).
   - `createTextStyle` is `addTextStyle`, `setTextStyle` and `patch` (`:1176-1186`).
   - Each `update` is one undo step (`designSystem.ts:72-79`).
7. **One undo stack mixes the file and the global design system** (`designSystem.ts:13-14`, `session.ts:161`). The save conflict is per part (`lib/firestore.ts:308-311`), so two open projects editing the library conflict on the whole `design/library` blob.
8. **The library is one JSON blob under 1 MB** (`lib/firestore.ts:293-297`, `:332`). Every save rewrites the whole library, and growth is capped.
9. **Name-path override keys are fragile.** They require unique sibling names (`library.ts:564-568`) and an O(file) key migration on every rename (`model.ts:1173-1221`).
10. **Lookups depend on the open page.** `libraryOf` puts the current page first (`model.ts:603-607`) and `getNode` takes the first match, so a duplicated id resolves differently depending on which page is open.
11. **Possible crash in Home Library.** `Library.tsx:131-132` passes `byId.get(alias)!` into `resolvedValue`. If a text style's alias is broken, `modeValue(undefined)` throws.
12. **Hard-coded site ids in the Inspector.** Default fill and stroke aliases (`Inspector.tsx:1060`, `:1079`) draw nothing when those variables do not exist (`colorCss` returns null).
13. **Inspector architecture.**
    - 2369 lines in one file, with an `EditorOps` interface of about 70 callbacks (`Inspector.tsx:22-116`), all rebuilt on every edit.
    - Mixed values are computed only for X/Y/rotation/W/H/fills/strokes/effects (`:528-532`, `:2296-2299`); every other field shows the first node's value but writes to all selected nodes (`:2219-2221`).
    - Sections look up by walking the whole tree on each render: `findNode`, `componentAround`, `resolveInstance` (`:2228`, `:937`, `:2266`).
14. **The VariablePicker is styled with site tokens** (`--bg-1`, `--text-title`, `popover.tsx:84-114`) instead of the `--f-*` editor tokens.
15. **The instance source label is wrong.** "From this file" is shown even for site-library components (`Inspector.tsx:1609`).
16. **Weight is a variable kind of its own** (`design.ts:11`), where Figma uses a FLOAT with a font-weight scope. Binding pickers filter by kind (`Inspector.tsx:170`).

## 9. Reusable for a Figma clone

- **The `VariableValue` union** (`design.ts:14`) as the per-field binding shape. Extend it to `{alias, libraryKey?}` and per-mode values.
- **Alias resolution with cycle detection** (`designVariables.tsx:75-89`) as the specification for the core resolver.
- **The component property and variant model**: `ComponentProperty`, `variant`, `variantProperties`, `pickVariable`, `applyPropertyValue`, `pruneBindings`, `propertyValues` (`model.ts:160-180`, `:891-984`). It is close to Figma's own semantics.
- **The `resolveInstance` algorithm** (`model.ts:1008-1102`) as a reference for instance resolution in the C++ scene graph, with keys switched from name paths to ids.
- **The detach semantics** in `detachedFrame` / `withDetached` / `mapNodes` (`systemLibrary.ts:99-128`). Also `withoutVariables` / `frozenValues` / `withoutTextStyles` for "delete local asset, keep the values" (`:160-204`), if made mode-aware.
- **Inspector React pieces**, since the target keeps React panels:
  - `BoundNumber` (`Inspector.tsx:146-194`), `PaintRow` (`:197-263`)
  - `AlignGrid` (`:846-873`), `GridBox` (`:880-930`)
  - `PositionSection` (`:534-570`), `LayoutSection` once site options are removed (`:615-835`)
  - `AppearanceSection` (`:932-991`)
  - `PropertiesSection`, `InstanceSection`, `CurrentVariantSection` (`:1326-1647`)
  - `EffectPopover` (`:1153-1194`), `PrototypeSection` (`:1673-1853`)
  - `TextStyleTree` / `ColorStyleTree` grouping (`:346-525`)
  - `TextStyleEditor`, without colour and tag (`:422-487`)
- **`VariablePicker`** (`popover.tsx:62-125`) and the ColorPicker Libraries tab's grouping by collection and group (`ColorPicker.tsx:157-177`).
- **The VariablesTable layout** (`VariablesTable.tsx:51-160`), as a starting point for a real collections × modes grid.
- **The spring and bezier easing math** (`interactions.ts:104-159`) for the prototype player.
- **Unit tests for the detach and freeze semantics** (`system.test.ts:66-123`), to port.

## 10. What must change for Figma semantics (target model)

### 10.1 Per-file assets

Each file owns:

- `variableCollections[] {id, key, name, modes[{modeId, name}], defaultModeId, hiddenFromPublishing}`
- `variables[] {id, key, collectionId, name, resolvedType: COLOR|FLOAT|STRING|BOOLEAN, valuesByMode: {[modeId]: value | {type: "VARIABLE_ALIAS", id}}, scopes[], description, codeSyntax, hiddenFromPublishing}`
- `styles[] {id, key, type: PAINT|TEXT|EFFECT|GRID, name, description, ...props, boundVariables}`. Text styles have no colour; paint styles hold `Paint[]`.
- components and component sets as nodes, each carrying a stable publish `key`

Delete `design/*`, `STARTING_*`, `library.ts`, `systemLibrary.ts` (merge/split/seed/tombstones), `overview.ts` and `publish.ts`.

### 10.2 Node bindings

- A per-property `boundVariables` map, such as `fills[i].color`, `strokes[i].color`, `strokeWeight`, `itemSpacing`, `padding*`, `cornerRadius*`, `width`, `height`, `opacity`, `visible`, `characters`, font fields and effect fields.
- Style references: `fillStyleId`, `strokeStyleId`, `textStyleId`, `effectStyleId`, `gridStyleId`. Style-driven properties are resolved live, never copied as today (`FigmaEditor.tsx:1172`).
- `explicitVariableModes: {[collectionId]: modeId}` on frames, sections and pages. The resolver walks ancestors. This replaces `mode={theme}`.

### 10.3 Cross-file references

Every reference to an asset from another file carries `{libraryFileKey, assetKey, version}`. The consuming file stores an **imported snapshot** of each library asset it uses:

- for a component: its subtree
- for a style or variable: its value

so it renders without the library loaded. This replaces bare `mainId` lookup through `libraryOf` (`model.ts:603-607`).

### 10.4 Publishing

A library file has a published snapshot: assets by key, with versions and a changelog. Publish computes a diff of local assets against the last published state (added, changed, removed) and shows a publish dialog.

### 10.5 Subscribing and updates

- A file keeps `subscriptions[{libraryFileKey, enabled}]`.
- An "Updates" review lists imported assets whose published version is newer, and the user accepts all or some.
- Accepting swaps the snapshot and re-resolves instances, keeping overrides by stable ids.
- Removed assets stay as the consumer's cached copy, marked "missing from library", instead of a 100-entry tombstone list.

### 10.6 Overrides by id

Key instance overrides by stable layer-id paths, not by names (`model.ts:383-386`). This removes `uniqueNames` and the rename migration.

### 10.7 Undo and storage

- One undo stack per file (each tab is its own WebContents).
- A local scene-graph store with a property-level schema, so it can later map to Firestore documents per node and property with LWW.
- No cross-document transaction coupling the file to a global library.

### 10.8 Inspector

- Replace `EditorOps` with a command and query bridge to the Wasm core: one selection-properties query returning resolved and mixed values plus bindings.
- Add Constraints; variable modes in Appearance; real paint and grid styles; style context menus; an instance header showing the source library.
- Remove Embed, Link, narrow, tag and Language.
- Rename "Layout grid" to "Layout guide".
- Move stroke weight and position to the node.

### 10.9 Home

Replace `home/Library.tsx` with:

- Figma's file browser, where library files are ordinary files with a "Published library" badge
- a per-file Libraries modal: the enabled libraries list, Updates and Publish tabs
