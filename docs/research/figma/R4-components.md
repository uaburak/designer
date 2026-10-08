# R4 — Figma components, instances, variants, properties (verified 2026-10-06)

Scope: how Figma Design (as of Oct 2026) models and presents main components, instances, component sets/variants,
component properties (boolean, text, instance swap, variant, slot), exposed nested instances, preferred values,
overrides, detach/swap/reset/push, "Go to main component", library components in consuming files, copy/paste
across files, Plugin + REST API representations, internal .fig representation, and the UI3 look.

Every source below was opened during this research (help-center articles were read in full through Zendesk's public
article JSON; `updated_at` dates are given). "Inference" marks conclusions I drew, not text I read.

---

## 1. What changed 2024-2026 (read first)

| When | Change | Source |
|---|---|---|
| 2024 (UI3) | Component/instance properties shown at the **top** of the right panel, above Position (users complained) | forum.figma.com/t/.../83425 (Aug 2024) |
| 2025-07-29 | Component properties and variables moved onto one **unified parameter architecture** (one typespace, one binding store; a layer property can be bound to at most one parameter) | figma.com/blog/a-tale-of-two-parameter-architectures |
| Oct 2025 | **Slots** announced at Schema 2025 | figma.com/blog/supercharge-your-design-system-with-slots |
| 2026-03-05 | Slots **open beta** | same blog post (dated 2026-03-05) |
| 2026-03-17 | Engineering post: instance runtime "Instance Updater" (2016) replaced by **Materializer** (derived subtrees, push-based invalidation); slots built on it | figma.com/blog/how-we-rebuilt-the-foundations-of-component-instances |
| 2026-03-23 | **Simplified instances deprecated**: all component properties and hidden layers shown by default | help 5579474826519 |
| 2026-06-10 | Slots **GA**; Plugin API gains `SlotNode` (`type: 'SLOT'`), `SlotSettings`, `createSlot()`, `resetSlot()`, `limitViolations`, `'SLOT'` property type | developers.figma.com/docs/plugins/updates/2026/06/10/update |
| 2026 | Help article "Apply overrides to instances" renamed **"Apply changes to instances"** (UI wording: "changes", "Reset all changes", "Push changes to main component") | help 360039150733 (updated 2026-09-30) |

---

## 2. Main components and instances

- Main component defines the properties; an instance is a reusable copy linked to it and receives its updates
  (help 360038662654 "Guide to components in Figma", updated 2026-10-02).
- Visual identity: main components have a **purple bounding box** and a **four-diamonds icon** in Layers; instances a
  purple bounding box and an **outlined diamond icon** (help 39635555294743 "Components collection: Components fundamentals").
- Create: right-sidebar "Create component", right-click "Create component", **⌥⌘K / Ctrl+Alt+K**; "Create multiple
  components" makes one per frame/group/boolean/path. Figma "will nest the layers within a special component frame".
  Component configuration holds description + documentation link (help 360038663154).
- Delete: **deleting a main component does not remove its instances**. From an orphaned instance you can
  **Restore component** (in the library file) or **Go to main component in library → Restore** (help 360038663154).
- Within one file, edits to the main component apply immediately; for a published component other files only get
  them after **publish** and **accept** (help 360038665934 "Edit main components").
- "Go to main component": **⌃⌥⌘K** (Win Ctrl+Alt+Shift+K), right-click, or the instance section of the Design tab;
  it opens the library file at the main component and offers **Return to instance** (help 360038665934, 360039150173).
- Insert instances: Assets tab (⌥2), component details modal (preview, set properties incl. exposed nested ones and
  variable modes, "Insert instance"), Shift+I quick insert, duplicate (⌘D), ⌥-drag, copy/paste (help 360039150173).

## 3. Overrides ("changes" in 2026 UI wording)

Allowed on an instance (help 360039150733, updated 2026-09-30):
- text properties (font, weight, size, line height, letter spacing, resizing), fill & stroke (type/value/opacity),
  shadows/blurs, layout guides, **swap nested instances**, export settings, layer name. (Size is also changeable —
  components fundamentals article.)

Not allowed (must detach or edit the main component):
- z-order of layers, **position of layers incl. auto-layout children**, constraints, bounds of text layers; you also
  cannot add/remove layers (components fundamentals). Exception since 2026: **slots** (section 6).

Preservation when switching variant / swapping instance (help 360039150733):
1. layer names of current and target must match;
2. for variants, Figma also checks the overridden property **originally matched between the two variants**
   (fill #1BC47D→#F531B3 survives Default→Hover because both started #1BC47D; not to a variant with #FFFFFF);
3. text is looser: kept if the text layer name is the same and the hierarchy is similar.
- When swapping by Assets-panel ⌥-drag, **only text overrides** are preserved (help 360039150413).

Reset: select instance (or a layer in it) → **More actions** next to the component name → **Reset › Reset [property]**
or **Reset all changes**; menu lists only changed properties (help 360039150733).

Push: **Push changes to main component** only when the main is in the same file, not for components nested in
another component, and only with the instance itself selected (help 360039150733, 360038665934).

Breaking library changes = those that "reset, invalidate, or alter existing overrides": removing/renaming a property,
restructuring variants, renaming layers users overrode (help 39747637290263, Components collection: Tips).

Internal model (third-party reverse engineering, consistent with the above):
- Instance = `INSTANCE` node with `symbolData { symbolID → SYMBOL.guid, symbolOverrides[], uniformScaleFactor }`.
- Each node inside a component has an `overrideKey` GUID (stable identity, ≠ node guid); overrides are NodeChange
  patches addressed by `guidPath` = list of overrideKeys from instance root, crossing nested-instance boundaries
  (`[A,B]` = node B inside nested instance A). Usage-site overrides beat overrides baked into nested instances of
  the component. `derivedSymbolData` caches resolved sizes/transforms per guidPath (grida.co fig.kiwi glossary).
- Nested swap is the override field `overriddenSymbolID`; property values are `componentPropAssignments`
  `{defID, value}`; property bindings in the component are `componentPropRefs { defID, componentPropNodeField:
  VISIBLE | TEXT_DATA | OVERRIDDEN_SYMBOL_ID | INHERIT_FILL_STYLE_ID | SLOT_CONTENT_ID }` (fig2sketch instance.py;
  open-pencil fig.kiwi schema).
- Inference: name-matching is a *heuristic* used only when the target component changes (swap/variant switch);
  steady-state overrides survive main-component edits because they are keyed by overrideKey, not by name.

## 4. Detach

- Detach (⌥⌘B / Ctrl+Alt+B, right-click, or instance menu) turns the instance into a regular **frame**, keeps layers
  and properties, removes the link (help 360038665754). Cannot be reconnected later (help 39635555294743).
- Plugin API `detachInstance()` returns the FrameNode; on a nested instance it **also detaches all ancestor instances**.
  Detached frames keep `detachedInfo` = `{type:'local', componentId}` or `{type:'library', componentKey}` even if the
  component is deleted (developers.figma.com DetachedInfo).

## 5. Variants and component sets

- A component set is a container of variants that "can only contain components" (no text/annotations/nested
  frames). Default style: **dashed purple stroke, no fill** (help 360056440594 "Create and use variants").
- Variant layer-name syntax `Property1=value, Property2=value`; every variant must be a **unique combination**
  (else "conflict" error; malformed names → "corrupted variant" error).
- **Combine as variants**: slash names `Button/Primary/Large` become properties named **Variant, Property 2,
  Property 3…** to be renamed.
- **Top-left variant is the default**; represents the set in Assets; `ComponentSetNode.defaultVariant` = top-left-most
  spatially (help 360056440594; Plugin API ComponentSetNode).
- "When you add an instance with variants to a file, **Figma will import every variant in that component set**."
- Variant properties always sit above other property types in the panel; deleting the only variant property deletes
  the whole set (help 5579474826519). A set with no children deletes itself (Plugin API).
- Interactive components: prototype interactions between variants of the same set ("Change to"), carried by every
  instance (help 360061175334).
- Internally there is **no COMPONENT_SET node type**: a set is a `FRAME` with `isStateGroup` + `componentPropDefs`
  containing `SYMBOL` children with `variantPropSpecs` (grida glossary).

## 6. Component properties (help 5579474826519, updated 2026-09-29; 8883757553943)

| Type | Binds to | Notes |
|---|---|---|
| Boolean | a nested layer's **visibility only** | default true/false; can bind a boolean variable |
| Text | a text layer's characters | no rich text in the panel (lists/superscript lost if edited from panel) |
| Instance swap | a nested instance's main component | default = any local or library component; **preferred instances** |
| Variant | component sets only | values = variant names; default = top-left variant |
| Slot (2026) | a nested frame (not the top-level layer) | freeform content area; see below |

- Created from the **Properties** section of the right sidebar (+ menu → type → modal → Create property) or directly
  from a nested layer ("Apply variable/property" icon). An applied property shows as a **purple pill**.
- Changing a default updates only instances that have no override for that property.
- **Expose nested instances**: Properties + → "Nested instances" under "Expose properties from"; only offered if the
  component already exposes one or has nested instances with properties. Top-level instance then shows the nested
  instances' properties; hovering a row highlights the layer in **light purple**.
- Instance panel: dropdowns for variants (no icon), dropdowns with an instance icon for swaps, toggles, text fields.
- **Simplified instances** (hide nested layers/properties) were **deprecated starting 2026-03-23**.

### Slots (help 38231200344599, updated 2026-10-05; blog 2026-03-05; plugin update 2026-06-10)
- Create: **Convert to slot** (⌘⇧S / Ctrl+Shift+S) on a nested frame, **Wrap in new slot** for non-frames/multi-select,
  or create a Slot property first and assign it. Works across variants with multi-edit. Not on the top-level layer.
- Settings: name, description, **min/max layer counts**, **preferred instances**, **Only allow preferred instances**,
  **display empty slots by default**, **fill items on counter-axis**. Limits are guidance: going past them shows a
  warning and an orange label, never blocks.
- In instances: add any layers (tools, duplicate, drag from canvas/Assets, "Add instances" popup filtered to
  preferred). The slot layer itself accepts fill/stroke/opacity/effects/name/export overrides, **not** position,
  auto-layout flow or constraints. **Reset slot**, **Delete contents**; overridden slot shows **[Modified]**.
- Component properties cannot be applied to layers inside a slot (instances placed into a slot keep their own).
- Removing the slot property from the main resets instances' slot content (destructive).
- Slot highlight colour is **pink** (hover box; tokens `--figma-color-border-slot #ff24bd`).
- Figma staff (forum, Mar 2026): any edit inside an instance's slot makes the **whole slot diverge** — it stops
  receiving default-content changes from the main ("expected behavior").

## 7. Libraries, keys, and library components inside a consuming file

- Publishing needs a paid plan, at least one component/style/variable, and a file outside drafts; you can uncheck
  assets or **Hide when publishing**; a component whose name starts with "." is hidden (help 360025508373, 360039238193).
- Consumers get a blue badge on the Libraries icon; **review** (side-by-side / overlay) and **Update** per instance or
  **Update all** — updates are pulled, not pushed (help 360039234193).
- Unpublishing: "Team members can still use instances from an unpublished library. They will no longer receive any
  updates" (help 360039236853). Swap libraries matches assets **by name** incl. sets and variants (help 4404856784663).
- **Every component has a unique id** that links instances; cut/paste to another file makes a **new component with a
  new id**; the publish dialog then offers **Move to this file** (keeps instance links) or **Publish as copy**
  (help 4404848314647). Schema: `LibraryMoveInfo {oldKey, pasteFileKey}`.
- Representation of library components in a consuming file:
  - Plugin API: "some component nodes reflect components in the team library that are used within this file. Those
    components are **read-only**" — `remote: true`; `key` exists on local and published components, but only
    published ones can be imported (`importComponentByKeyAsync`, `importComponentSetByKeyAsync`).
  - REST `GET /v1/files/:key` returns `components` / `componentSets` maps (by node id) for **local and subscribed**
    components with `key, name, description, componentSetId, documentationLinks, remote`.
  - .fig files: a page with `internalOnly = true` ("Internal Only Canvas") holds the SYMBOLs of library components
    used in the file; clipboard payloads carry the referenced SYMBOL there too (fig2sketch convert.py; grida).
    Schema: `SharedSymbolReference {fileKey, symbolID, versionHash, componentKey, guidPathMappings,
    libraryGUIDToSubscribingGUID…}`, plus node fields `componentKey`, `sourceLibraryKey`, `publishID`,
    `sharedSymbolVersion`, `isSymbolPublishable`, `publishedVersion` (open-pencil fig.kiwi). Component `key` is a
    40-hex hash (grida).
  - Inference: so yes — a consuming file keeps its **own read-only copy** of each used library main component (whole
    set for variants) keyed by component key + version; that copy is what renders instances, what "Review update"
    diffs against, and why instances survive unpublishing / lost access.

## 8. Copy / paste across files

- "Component instances and published main components can be copied and pasted across files" (help 360039150173).
- A published main component copied from its library file pastes as an **instance**; an **unpublished** main
  component pastes as a new **main component**; component sets (variant sets) always paste as main components
  (Figma support answer, forum, 2022-10-05).
- Copy/paste of main components between files keeps component-instance links only within one file (help 4404848314647).

## 9. Plugin API (developers.figma.com)

- `ComponentNode` (`'COMPONENT'`): `createInstance()`, `createSlot()`, `getInstancesAsync()`, `clone()` (new
  component, no instances), `description`, `descriptionMarkdown`, `documentationLinks`, `remote`, `key`,
  `getPublishStatusAsync()`, `componentPropertyDefinitions`, `add/edit/deleteComponentProperty`, `variantProperties`
  (for variants).
- `ComponentSetNode` (`'COMPONENT_SET'`): `defaultVariant`, `componentPropertyDefinitions`; children are all components.
- `InstanceNode` (`'INSTANCE'`): `mainComponent` / `getMainComponentAsync()` ("could be a remote, read-only
  component"; setting it on a nested instance clears all overrides), `swapComponent()` (keeps overrides with the
  editor heuristics), `setProperties()` (not SLOT), `componentProperties`, `detachInstance()`, `scaleFactor`,
  `exposedInstances`, `isExposedInstance`, `overrides: {id, overriddenFields: NodeChangeProperty[]}[]` (direct only),
  `removeOverrides()` (`resetOverrides` deprecated).
- Sublayers: `componentPropertyReferences { visible | characters | mainComponent | slotContentId }`.
- Property names for BOOLEAN/TEXT/INSTANCE_SWAP carry a `#id` suffix (`ButtonText#0:1`); renaming changes the id;
  VARIANT names have none. INSTANCE_SWAP `defaultValue` is a component node id; `preferredValues` are
  `{type:'COMPONENT'|'COMPONENT_SET', key}`. Property values/defaults can be bound to variables (`VariableAlias`).
- `SlotNode` (`'SLOT'`): `resetSlot()`, `limitViolations` (`BELOW_MIN | ABOVE_MAX | HAS_NON_PREFERRED`), `clone()`
  returns a FrameNode. `SlotSettings {stretchChildOnInsert, displayEmptyByDefault, minChildren, maxChildren,
  allowPreferredValuesOnly}`.

## 10. REST API

- `INSTANCE`: `componentId` (→ file `components` table), `isExposedInstance`, `exposedInstances`, `componentProperties`,
  `overrides [{id, overriddenFields}]`. `COMPONENT`/`COMPONENT_SET`: `componentPropertyDefinitions`.
  Every node: `componentPropertyReferences`.
- `ComponentPropertyType` documented as BOOLEAN, INSTANCE_SWAP, TEXT, VARIANT (no SLOT in the REST docs as of today).
- Published library metadata (`/v1/components/:key`, team/file component endpoints): `key, file_key, node_id,
  thumbnail_url, name, description, created_at, updated_at, user, containing_frame{…, containingComponentSet}`.

## 11. Engineering background

- 2016 "Instance Updater" resolved instance properties/structure itself (incl. its own auto-layout and variable work);
  replaced (shipped by March 2026) by **Materializer**: generic derived-subtree engine; feature code supplies a
  *blueprint* (for instances: what properties inherit, which overrides apply, which children exist); push-based
  invalidation with automatic dependency recording; unified runtime ordering (layout, variables, instances);
  ~40-50% faster variable-mode changes in large files. Slots built on it (figma.com blog 2026-03-17).
- Component properties (scoped parameters, on the component) and variables (global, library-level) share one typespace
  and one binding store since 2025 (figma.com blog 2025-07-29). The .fig schema's `ComponentPropType` already lists
  NUMBER, COLOR, IMAGE, EASING, … beyond the five public types (open-pencil fig.kiwi) — inference: used by
  Sites/Motion/code components, not exposed in Design.

## 12. UI3 look

- Component colour tokens (light theme): `--figma-color-bg-component #9747ff`, `-hover #8638e5`,
  `-tertiary #f1e5ff`; `--figma-color-text-component #8638e5`; `--figma-color-icon-component #8638e5`;
  `--figma-color-border-component #e4ccff`; role "-component" = purple for component layer names and component
  features (variants); "-slot" = pink (`--figma-color-border-slot #ff24bd`, `--figma-color-bg-slot rgba(255,36,189,.25)`)
  (developers.figma.com/docs/plugins/css-variables).
- Design tab sections include **Component properties** and **Instance** (help 360039832014). With a component/instance
  selected, the properties block sits at the top of the panel, above Position (forum, 2024). Instance header: the
  component name opens the **Instance menu** (swap, search, libraries, grid/list); "More actions" next to it has Reset /
  Push changes / Detach; a Go-to-main-component affordance lives in the instance section.

## 13. Implications for a single-user local clone

1. Node types: COMPONENT, COMPONENT_SET (or a FRAME flagged as state group), INSTANCE, SLOT. Instances store only
   `mainComponentId` + overrides + property assignments; their children are *derived* (materialized) from the main,
   never stored as independent truth.
2. Give every node inside a component a stable `overrideKey`; address overrides by a path of overrideKeys
   (crossing nested instances). Store overrides as `{path, field} -> value` — maps 1:1 to per-property LWW later.
   Use layer-name (+hierarchy) matching only as the heuristic when swapping / switching variants.
   (Today's DesignerV2 keys overrides by layer *name path* — that must change.)
3. Whitelist overridable fields (text style fields, fills, strokes, effects, layout guides, export settings, name,
   visibility, size, nested swap) and block structural edits (add/remove/reorder/position/constraints) outside slots.
4. Properties: BOOLEAN→visible, TEXT→characters, INSTANCE_SWAP→nested mainComponent (default by id, preferred by key),
   VARIANT encoded in variant names, SLOT→slotContentId with SlotSettings; `Name#id` ids; values bindable to variables
   through one shared binding store (one parameter per field).
5. Reactive derivation (Materializer-style): dependency graph from main components/variables to derived instance
   subtrees, invalidate per property, recompute in one ordered pass with layout and variables.
6. Libraries: publishing snapshots a file's components (and their dependencies) under stable keys + version; a
   consuming file stores a read-only copy (whole component set for variants) on a hidden internal page; instances
   point at the local copy; updates are offered (badge, review, update instance / all), never auto-applied.
   Unpublish/lost source → instances keep working from the copy.
7. Actions to implement with Figma wording: Create component (⌥⌘K), Create multiple components, Combine as variants,
   Add variant, Detach instance (⌥⌘B), Go to main component (⌃⌥⌘K) + Return to instance, Reset › Reset [property] /
   Reset all changes, Push changes to main component, Restore component, Swap instance (Instance menu, ⌥-drag, Shift+I),
   Expose nested instances, Convert to slot (⌘⇧S), Wrap in new slot, Reset slot, Delete contents, Hide when publishing.
8. Paste rules: instance and published main → instance in target file; unpublished main / component set → new main
   with new id; cut+paste of a published main → offer "Move to this file" on next publish.
9. Colours: component purple #9747ff (bg) / #8638e5 (text, icons); component-set dashed purple stroke; slot pink #ff24bd.

## 14. Open questions

- Exact behaviour when pasting an *instance* of an unpublished local component into another file.
- How a variant switch resolves a property combination that no variant has.
- Whether a deleted local main component is kept hidden in the file (internal canvas) to back "Restore component".
- REST API support for SLOT (not documented as of 2026-10-06).
- Semantics of schema fields `overrideStash`, `propsAreBubbled`, `overrideLevel`, `isUnflattened`.
- Precise UI3 instance-section layout (needs a screenshot pass of the real app).

## 15. Round 6 check (2026-10-08): slots UI and the component / instance panels
Sources: help "Create and use slots" (38231200344599), "Slots fundamentals" (39745565646871), "Explore component
properties" (5579474826519), "Create and use variants" (360056440594), "Apply changes to instances" (360039150733),
"Swap instances" (360039150413), "Edit instances with component properties" (8883757553943), "Hide when publishing"
(360039238193); Plugin API `SlotNode`, `SlotSettings`, `ComponentPropertyDefinitions`, update 2026-06-10; forum.
- **Convert to slot**: a nested frame of a main — canvas menu, ⌘⇧S, or the right panel's button; not the top-level
  layer, not shapes, not grid frames (API throws). **Wrap in new slot** (canvas menu) for texts, groups, instances and
  multi-selections: "create a new slot and place your selection into it" (built as Figma's wrap in frame: a frame
  around the selection's bounds, then converted). Default property name: unverified (built: "Slot", then "Slot 2"…).
  A Slot property can also be created first (Create property → Slot) and bound later.
- **Slot property settings** in order: name, **description** (slots only — no other property type has one), Minimum
  layers / Maximum layers (either or both; null = unset; min ≤ max), Select preferred instances, Only allow preferred
  instances (with "View layers"), By default, display empty slots, By default, fill items on slot's counter-axis
  (`stretchChildOnInsert`: inserted items Fill the counter axis).
- **Limits** are guidance ("designed to guide your team, not restrict them"): `limitViolations` BELOW_MIN /
  ABOVE_MAX (exclusive) / HAS_NON_PREFERRED. Selecting the slot or its instance shows a **Limits** label in the right
  panel; its details list each guideline with a green check or an orange warning; going over a limit shows a toast at
  the bottom and the label turns orange (toast text unverified).
- **On an instance**: content by drawing, duplicating, dragging, or **Add instances** — a "+" over the slot on the
  canvas and on hover of the slot property's row; the popup lists components and libraries, filtered to **Preferred**
  first when the slot has preferred instances. More actions: **Reset slot**, **Delete contents**. A slot accepts fill,
  stroke, opacity, effects, name, export overrides; not position, flow or constraints. Pink hover box; an empty slot
  stays pink with "display empty slots".
- **Variant values**: the property's edit popover has **Values** — edit in place; "Hover over a value to reveal
  handles. Click and drag." (manual order = `variantOptions` order). Default variant = the top-left one.
- **Variant toggle**: a two-value variant property shows as a toggle when its values are True/False, Yes/No or On/Off
  (forum; staff 2024) — only True/False takes boolean variables.
- **Simplified instances** were removed (deprecated 2026-03-23): every property shows; no "Simplify instance".
- Create component property modal: Name, Value (Boolean true/false, Text string, Instance swap picker), Apply
  variable, Preferred instances (Instance swap, Slot), "Create property". "Expose properties from" → Nested instances.
- Hide when publishing: an Assets panel menu item (and "." / "_" prefixes), not a panel control.
