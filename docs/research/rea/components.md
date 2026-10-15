# REA — Components & instances: Figma vs Wecra (2026-10-15)

Scope: how Figma's shipped client (Wasm engine strings, the JS bundles' file reader and Plugin API shims, the embedded
Kiwi schema) models main components, sets, variants, properties, instances, overrides, swaps, resets, push, detach,
soft-delete and library copies. Each feature is mapped onto Wecra: the engine (`engine/src/editor/*`), the schema
(`schema/document.kiwi`, `docs/schema.md` §5 / §8), the TS side (`src/renderer/src/editor/*`, `src/shared/fig/*`)
and the plugin host. The result is an ordered integration plan.

Sources:
- **Static.** The REA working notes (`static-notes.md`, embedded schema `embedded-schema.txt`, Wasm string dumps) from
  this run's scratchpad. Bundle ids and offsets are quoted as the notes give them (e.g. `3187 @4362673`).
- **Live.** A Plugin API session on a scratch Figma file (probe nodes are still on its page "components"). The plan
  limit there allows only one variable mode, so the mode-based probes could not run.
- **Wecra live.** The designer MCP's `describe_schema ComponentPropDef` on the owner's open file (read only). It
  shows the five property types and no `visibleWhen`, which matches the schema.

Status words: **done** = Figma's behaviour and data shape; **partial** = the behaviour exists but rules or fields
are missing; **missing** = nothing yet; **different** = built on purpose with another shape. A *different* entry
matters mainly for `.fig` round trips and the Plugin API.

Earlier research this builds on: `docs/research/figma/R4-components.md` (R4), `R5-libraries.md`, `R3-variables.md`.

---

## 1. Summary table

| # | Feature | Status | Size | Priority |
|---|---|---|---|---|
| 1 | Single-text rule on swap / variant switch | missing | S | 1 |
| 2 | Property / component validation (names, '=' ',', type match, cycles, self-instance) | partial | M | 2 |
| 3 | Push changes to main — Figma's enable rule | partial | S | 3 |
| 4 | Reset categories; Plugin `removeOverrides` keeps property values | partial / different | M | 4 |
| 5 | Exposed nested instances: preconditions, connected copies, slot rule | partial | S | 5 |
| 6 | Default names for new properties (`name N+1`, per-type base) | different | S | 6 |
| 7 | Variant properties: backfill from layer names, '=' ',' rules, default value locked | partial | M | 7 |
| 8 | `.fig` export fidelity: `componentKey` 216 / `sharedSymbolVersion` 126, implicit defs (`parentPropDefId`), `componentPropRefs` 267 dual write, slot content placement | different | L | 8 |
| 9 | Override entries keyed by `(guidPath, overrideLevel 321)` | missing | M | 9 |
| 10 | Nested swap: persisted override transfer + `overrideStash` 248 | different | L | 10 |
| 11 | Detach: `assetRef` for library mains; Plugin `detachedInfo` | partial | S | 11 |
| 12 | Plugin API component surface (types, options, strict refs, `mainComponent` setter, `removeOverrides`, `stokeTopWeight`) | partial | M | 12 |
| 13 | `importComponentByKeyAsync` (moved keys, unpublished error, whole set) | missing | M | 13 |
| 14 | Slot settings validation (min ≤ max, 0 → no limit, default locked) | partial | S | 14 |
| 15 | NUMBER and IMAGE property types; `preferredValues.parameterValues` 3 | missing | L | 15 |
| 16 | Conditional property visibility `visibleWhen` 14 | missing | M | 16 |
| 17 | Library update rule (hash **and** `userFacingVersion` 399 differ) | different | S | 17 |
| 18 | NIVB: override transfer and warning when a mode re-picks a variant | partial | S | 18 |
| 19 | Dangling instances detached (missing symbol) | missing | S | 19 |
| 20 | Slot primary instances (`slotBackingLayerId`), one content id per instance | missing | L | 20 |
| 21 | Partial component sets on paste, backfilled later (`partialPasteAnnotation` 581) | different | XL | 21 |
| 22 | Materializer: invisible descendants deferred | partial | M | 22 |
| 23 | `nestedInstanceResizeEnabled` 394 / `simplifyInstancePanels` 284 kept for round trips | missing | S | 23 |
| — | Primary / nested instance model, structural writes refused | done | — | — |
| — | Sublayer ids `I<inst>;<key>…`, guid as missing key | done | — | — |
| — | Unified parameter bindings (PROP_REF in `parameterConsumptionMap`) | done (export: see 8) | — | — |
| — | Variant property bound to variables (RESOLVE_VARIANT) | done (see 18) | — | — |
| — | `derivedSymbolData` (size, transform, derived text per path; layout version kept) | done | — | — |
| — | Soft-deleted mains, Restore component | done | — | — |
| — | Default variant (top-left; library sets copied whole) | done | — | — |
| — | Per-asset library payloads, per-component update | done (rule: see 17) | — | — |

---

## 2. Features

### 2.1 Primary instance / nested instance / sublayer model — done

**Figma.** A primary instance is a real INSTANCE node, on the canvas or directly inside a main component. Only a
primary instance carries `symbolData.symbolID`, and that id cannot be dropped. A nested instance is a derived
sublayer whose backing symbol is `overriddenSymbolID ?? symbolData.symbolID`. Only the materializer may write
structural fields. Moving a node into or out of an instance is refused. Evidence: Wasm strings "Cannot drop
symbolID of primary instance!", "overriddenSymbolID is only meaningful on nested instances", "Attempting to
imperatively update a structural field outside of the materializer" and "Cannot move node. New parent is an
instance or is inside of an instance"; 3187 @4362673 `backingSymbolId`.

**Wecra.** The same model. Sublayers are derived rows that are never stored (`engine/src/editor/Instances.cpp:1-15`,
`docs/schema.md` §5.2). A nested swap writes `overriddenSymbolID` (`ComponentCommands.cpp:1379`). Creating a layer
in an instance or moving one there is dropped (`Editor.cpp:287-292`), and so are writes to an instance's
non-overridable fields (`Editor.cpp:294-300`).

**Plan.** None.

### 2.2 Sublayer ids and missing override keys — done (repair missing)

**Figma.** A sublayer's id is `I<instanceId>;<overrideKey>` with one more `;<key>` per nested level. A node without
an `overrideKey` uses its own guid as its key. Missing keys are repaired (`FGRepairMissingOverrideKeys`, flag
`ds_auto_repair_override_keys`). Publishing without explicit keys is logged, not blocked. The live probe confirmed
the ids: `I1:16;1:10` and `I1:26;1:24;1:10`.

**Wecra.** The same rule (`docs/schema.md` §5.1, `base/DerivedIds.h`). Nothing repairs *conflicting* keys: two
nodes that share one effective key in one SYMBOL subtree, which Figma reports as "conflicting override keys
detected!".

**Plan.** A load-time check that clears the later duplicate's `overrideKey` (a SYSTEM change) and a native test. Size S;
it is folded into task 2.

### 2.3 Asset key / version of a SYMBOL — different

**Figma.** A SYMBOL stores its asset key in `NodeChange.componentKey` **216** and its content version in
`sharedSymbolVersion` **126**. State groups, styles and variables use `key` 319 / `version` 171. Figma's reader
resolves `key ?? componentKey` and `version ?? sharedSymbolVersion`. Library selectors read
`stateGroupKey` / `sharedStateGroupVersion` for sets and `componentKey` / `sharedSymbolVersion` for symbols
(figma_app). The live probe showed that both variant and set keys are 40-hex strings; the fields themselves could
not be read through the Plugin API.

**Wecra.** Every asset kind uses `key` 319 / `version` 171 (`schema/document.kiwi:2068-2069`). 216 and 126 are
placeholders (`document.kiwi:2124`, `:2132`). The import maps `componentKey` → `key` and `sharedSymbolVersion` →
`version` (`src/shared/fig/convert.ts:337-347`, `docs/schema.md` §8.2 "Answer to data.md §9.4"). The export
(`src/shared/fig/figmaExport.ts`) does not reverse the mapping, so a `.fig` written by Wecra puts a SYMBOL's key in
the wrong field for Figma.

**Plan.** Covered by task 8. Map back at export: for a SYMBOL, `key` → `componentKey` 216, and on a library copy
`version` → `sharedSymbolVersion` 126. Keep the internal model as it is: the store, the library registry and hashing
all read `key` (`data.md` §9). Adopting 216 / 126 in the schema itself is optional and only worth doing if a later
round needs it.

### 2.4 Explicit vs implicit property definitions — different

**Figma.** The product component (a loose SYMBOL or the state group) owns the explicit `ComponentPropDef`s. Each
variant carries implicit defs whose `parentPropDefId` (5) points at the explicit one, and assignments resolve
through `implicitToExplicitDefIDs`. Evidence: Wasm "Product component should not have an implicit def" and "Implicit
def not found on state". Live: reading a variant's `componentPropertyDefinitions` returned the set's defs and did
not throw, and the property id (`Lbl#1:0`) is shared by every variant's bound layer.

**Wecra.** Defs live only on the set; variants carry none (`docs/schema.md` §5.5). The import drops implicit defs
and maps `parentPropDefId` to the set's def id (`convert.ts:372-382`). `ComponentPropDef` keeps 5, 7 and 10 as
placeholders (`document.kiwi:1555`). The export writes no implicit defs, so a Figma that expects "Implicit def not
found on state" may fail when it opens a Wecra `.fig`.

**Plan.** Task 8: the export writes, on each variant, one implicit def per explicit def. It needs a fresh id,
`parentPropDefId`, the same name, type and default, and `sortPosition`, and the variant's own assignments and refs
are remapped to the implicit ids. This needs Figma's exact implicit-def contents from a sample `.fig` (open item
O1). Keep the internal one-def model.

### 2.5 Variant properties as real defs — partial

**Figma.** VARIANT defs on the state group, `variantPropSpecs [{propDefId, value}]` on variants, and
`stateGroupPropertyValueOrders`. The engine backfills defs from layer names (`backfillVariantPropDefs`, migrations
`variant_props_96` and `variant_props_redo`). Variant names and values cannot contain '=' or ','. A variant's
default value cannot be changed. A variant property can only be added to a set. Live checks:
- `addComponentProperty('V,1'|'V=1','VARIANT',…)` on a set throws "Component property name cannot have '=' or ','".
- VARIANT on a loose component throws "Can only add variant property to a component set".
- TEXT names and values **accept** '=' and ','.

**Wecra.**
- The data model is Figma's (`document.kiwi:2050-2053`).
- Combine as variants parses names (`ComponentCommands.cpp:57`, `:779`), and `renameVariants` rewrites names from
  specs (`:206-228`).
- Missing:
  - Renaming a variant layer by hand (`Size=Large` → `Size=Huge`) does not update `variantPropSpecs`, so the next
    `renameVariants` restores the old name.
  - No '=' or ',' check on VARIANT names or values. `parseVariantName` splits on them, so such a value corrupts the
    set.
  - On a lone component, ADD_COMPONENT_PROPERTY with VARIANT *makes it a set* (`:1523-1546`). That is the UI's
    behaviour (R4 §5). The Plugin API must throw instead.

**Plan.** Task 7.

### 2.6 Unified parameter bindings — done (export: task 8)

**Figma.** Bindings are written twice: as the legacy `componentPropRefs` 267
`{nodeField, defID, zombieFallbackName, componentPropNodeField, isDeleted}` and as `parameterConsumptionMap`
PROP_REF entries (migration `parameter_consumption_map_dual_writes`). The file reader treats a FRAME as a slot when
it has a SLOT_CONTENT_ID (40) entry.

**Wecra.** Writes PROP_REF only (`ComponentCommands.cpp:78`, `:1746-1777`), and the import converts
`componentPropRefs` (`convert.ts:299-317`, `CodecJson.cpp:1380`). It also sets `isSlot` 463, which Figma's own
files leave out (`docs/schema.md` §5.6).

**Plan.** Task 8: the export also writes `componentPropRefs` with `componentPropNodeField` from the PROP_REF's
field. Keep `isSlot` internally, and decide from a sample whether the export drops it (open item O2).

### 2.7 Conditional property visibility (`visibleWhen`) — missing

**Figma.** `ComponentPropDef.visibleWhen` **14**: a list of `ComponentPropVisibilityClause {siblingPropDefMatches
[ComponentPropSiblingMatch {propName 1, anyOf [ComponentPropVisibilityValue {stringValue 1, floatValue 2, boolValue
3}] 2}] 1}`. Inference: every match in a clause must hold, and the property shows when any clause holds. Confidence
is medium; no UI was found.

**Wecra.** `ComponentPropDef` stops at 12 (`document.kiwi:1545-1556`), and the live `describe_schema` confirms it.

**Plan.** Task 16 (schema, a pure evaluation, and the panel hides the row). Check the UI first, since it may be
flag-gated (open item O3).

### 2.8 Property types beyond Design's five — missing

**Figma.** The schema lists 19 `ComponentPropType` values (BOOL 0 … NODE 18) and `ComponentPropValue` fields up to
`paintValue` 14. `preferredValues.stringValues` is deprecated in favour of `parameterValues` (3, `VariableData[]`).
Live: the Plugin enum accepts BOOLEAN, TEXT, INSTANCE_SWAP, IMAGE, SLOT, **NUMBER** and VARIANT, and rejects COLOR.
IMAGE refused `''` and a fake hash with "Property value is incompatible with component property type". COLOR and
PAINT are flag-gated (`ds_color_props`, `ds_paint_props`).

**Wecra.** BOOL, TEXT, INSTANCE_SWAP, VARIANT and SLOT (`document.kiwi:1529-1536`; NUMBER 5 and IMAGE 6 are listed
as dropped). `floatValue` 4 exists for shader parameters only.

**Plan.** Task 15: NUMBER and IMAGE only. COLOR and PAINT wait until Figma ships them unflagged.

### 2.9 Variant property bound to a variable (NIVB) — partial

**Figma.** `VARIANT_PROPERTIES` (22) is an EXPRESSION `RESOLVE_VARIANT` over a name → alias map, and each variable
must resolve to STRING. A mode change re-resolves nested instances' OSIDs with a dedicated override transfer
(`FGOverrideTransferForNivb`). Overrides that cannot be transferred are dropped with the warning "(W01) NIVB:
Overrides are being dropped". The live probe could not run (plan limit of one mode).

**Wecra.** Built in round 5 (`Instances.cpp:536-546`, `VariableCommands.cpp:1303-1340`). Overrides made under
another variant follow by name and hierarchy at derive time (`carryNestedOverrides`, `Instances.cpp:194-236`).
Missing: the STRING-only check (a FLOAT or BOOLEAN alias is accepted, `VariableMapValue` comment
`document.kiwi:1339`) and the dropped-override warning.

**Plan.** Task 18: refuse non-STRING aliases in the bind command (Figma's message) and keep the derive path.

### 2.10 Override entries carry `overrideLevel` — missing

**Figma.** `symbolOverrides` and `derivedSymbolData` entries are keyed by `(guidPath, overrideLevel 321)`. Figma's
debug tool labels them `[path] (level N)`, and the engine has `symbolOverrideLevels()` and
`remapOverridesForInheritanceLevel`. Inference: the level is the nesting layer of the component that wrote the
entry. Confidence is medium.

**Wecra.**
- 321 is a placeholder (`document.kiwi:2143`), and the import drops it.
- Entries are keyed by path alone (`writeOverride`, `Instances.cpp:1142-1172`).
- A nested instance's own overrides live on the real INSTANCE inside the main and are composed at derive time
  (`composedOverrides`, `Instances.cpp:1260-1304`), so Wecra never needs a level internally.
- An imported entry with level ≠ 0 merges with the level-0 entry of the same path, which can apply the wrong value.

**Plan.** Task 9: adopt `int overrideLevel = 321` (`@nooverride`, `@patch`-free). The import keeps it, and the
engine reads `(path, level)` with level 0 winning (the usage site, to be checked on a sample). Wecra never writes
level ≠ 0 itself.

### 2.11 Swap / variant-switch override transfer and the single-text rule — partial

**Figma.** `FGOverrideTransferrer` matches by layer names and hierarchy. Overrides on inner swaps are hoisted or
remapped, and DSD overrides are transferred separately. Single-text rule: when a text override did not transfer,
and the old instance and the new backing symbol each contain exactly one text node, the text goes to that node; a
hoisted text override is excluded. Live: swapping A (one text "Label" set to "Hello") for B (one text "Title") gave
`Title:Hello`. With B2 (two texts) nothing was transferred.

**Wecra.** `remapOverrides` matches by key, then by names along the path (`ComponentCommands.cpp:1296-1365`). A
variant switch keeps only the fields where both variants started the same. There is **no single-text rule**: A →
B above loses "Hello".

**Plan.** Task 1.

### 2.12 Override stash on nested swaps — different

**Figma.** A nested swap stashes the swapped-out component's overrides in `overrideStash` **248**
`[InstanceOverrideStash {overridePathOfSwappedInstance 1, componentKey 2, overrides 3}]`; V2 (250) is deprecated.
The stored override paths are rewritten to the new component's layers. Live: a red fill on X stayed red after the
swap to Y (`fills` on `…;1:63`) and after the swap back (`…;1:61`), and the swap added a `name` override on the
nested instance.

**Wecra.** A nested swap writes only `overriddenSymbolID` (`ComponentCommands.cpp:1375-1381`). The overrides stay
stored under the old keys, are carried by name at derive time (`carryNestedOverrides`), and apply again when you
swap back. The visible result is close to Figma's, but the stored data differs: the paths are not rewritten, there
is no stash, and the Plugin `overrides` list differs.

**Plan.** Task 10 (low priority; it matters for `.fig` and plugins).

### 2.13 Reset categories — partial / different

**Figma.** Reset kinds `OVERRIDES_FOR_LAYER_AND_SUBLAYERS 0, EXPORTS 1, EFFECTS 2, LAYER 3 ("others"), VISIBLE 4,
NAME 5, FILL 6, STROKE 7, TEXT 8, TEXT_STYLE 9, SIZE 10, OVERRIDDEN_SYMBOL 11, PROTOTYPE_INTERACTIONS 12, OVERLAY
13, SLOT_ASSIGNMENT 14`, plus `reset-variable-modes`. "Reset all changes" is `reset-symbol` (label key
`reset-instance`), enabled by `hasResettableInstance`. Plugin `removeOverrides()` and its deprecated alias
`resetOverrides()` call `resetOverrides(ALL)`, and `MATERIALIZED_SUBLAYERS_ONLY` also exists. Live:
`removeOverrides()` cleared overrides, the name, the fill and the nested swap, but **kept the property assignments**.

**Wecra.**
- The UI groups are Wecra's own (`src/renderer/src/editor/model/components.ts:393-409`): Fill, Stroke, Effects,
  Text, Text style, Layer name, Visibility, Opacity, Size, Corner radius, Auto layout, Layout guide, Export,
  Instance, Properties.
- Figma's Opacity, Corner radius, Auto layout and Layout guide fall under LAYER ("others").
- Missing groups: Prototype interactions, Overlay, Slot assignment, Variable modes.
- The engine's reset-all also clears `componentPropAssignments` (`ComponentCommands.cpp:1167-1169`). The plugin
  host's `resetOverrides` uses it (`host.ts:566-569`), and `removeOverrides` does not exist (`figma.js:271`).

**Plan.** Task 4. Whether the UI's "Reset all changes" keeps property values is still unverified (open item O4).
Until that is checked, keep the UI as built and change only the Plugin path.

### 2.14 Push changes to main component — enable rule — partial

**Figma.** Enabled for a single selected **primary** instance that is not a library instance and has property
assignments **or** an override on a field other than layout or name (3187 @1643531). An instance inside a main
component is primary too.

**Wecra.** `canPush` = has overrides and is not inside a main, not deleted, not remote and not copied
(`ComponentCommands.cpp:517-518`). The panel hides the item when only the name changed (`Component.tsx:164`), but the
engine's state and the menu item still allow it. Layout-only changes are allowed, assignments alone do not enable
it, and an instance inside a main cannot push. `pushChangesToMain` never pushes the top-level instance's own
property values (`:1205-1261`).

**Plan.** Task 3.

### 2.15 Library update detection and copy transport — done / different

**Figma.** An update is offered only when the published content hash ≠ the used `sharedSymbolVersion` **and** the
published `userFacingVersion` (399) ≠ the used one, case-insensitive. Assets of the current file are skipped. Each
component is fetched as its own canvas blob (`/api/file_proxy/component/<key>/canvas?ver=…&fv=…`), and
`updateSharedSymbol` / `updateSharedStateGroup` update one asset or set.

**Wecra.** Payloads are per asset version (`libraries/<lib>/assets/<key>/<versionHash>.kiwi`, `data.md` §9). The
transport is the same in spirit. An update needs only `versionHash ≠ version` (`docs/schema.md` §8.2); there is no
`userFacingVersion`.

**Plan.** Task 17: adopt `string userFacingVersion = 399` and Figma's two-part rule. Where Figma sets UFV is open
(O5); until then the field stays absent and the rule falls back to the hash alone.

### 2.16 Partial component sets on paste — different

**Figma.** A paste may bring a partial state group (`partialPasteAnnotation` 581 `{isPartial, annotatedAt,
errorState, upserted}`), backfilled later from the library. `importComponentByKeyAsync` still imports whole sets.

**Wecra.** A set is always copied whole (`docs/schema.md` §8.2, `Libraries.cpp` header). That is simpler and
correct for one person's local files.

**Plan.** Task 21, deferred until multiplayer: a partial set only pays off with large shared libraries. Adopt 581
as a kept field (round trip) in task 23 now.

### 2.17 Exposed nested instances — partial

**Figma.** `propsAreBubbled` 305. Refused unless the node is a primary instance inside a component or set **and**
has exposed nested instances or property-bound children. Instances in slots cannot be exposed. Toggling one toggles
all its connected instances (the same nested instance in every variant,
`setPropsAreBubbledForAllConnectedInstances`). The panel lists up to 5 rows (otherwise 4 plus "show N more"), with
slot sublayers disabled. Live: both preconditions and the connected flip were confirmed.

**Wecra.** `setExposedInstance` writes one node, with only the inside-a-component check
(`ComponentCommands.cpp:1930-1940`). The engine itself does materialize exposed values (`Instances.cpp:563-571`).

**Plan.** Task 5.

### 2.18 Slot settings and content — partial

**Figma.**
- `SlotPropConfig {stretchChildOnInsert 1, displayByDefault 2, minChildren 3, maxChildren 4,
  allowPreferredValuesOnly 5}`.
- The Plugin API's `displayEmptyByDefault` is renamed `displayByDefault`; `min ≤ max` is required; `null` and `0`
  mean no limit.
- A slot ref may go only on a non-GRID FRAME that passes `canBeSlot()`.
- A slot's default value is fixed, and slot values cannot be edited directly.
- Live: `{0,0}` read back as `null` / `null`, min 5 with max 3 threw, and an empty `{}` gave the defaults.
- Content: a FRAME `isSlotContent`, assigned through the SLOT assignment's `varValue` SLOT_CONTENT_ID. Instances
  placed into a slot become slot primary instances (`slotBackingLayerId`), and a content id backs only one primary
  instance.

**Wecra.**
- Schema and panel are complete (`document.kiwi:1580-1586`, `SlotProperty.tsx`).
- GRID frames are refused (`SlotCommands.cpp:19`).
- The content frame lives under the instance, and Figma's form is read and adopted (`docs/schema.md` §5.6,
  `Instances.cpp:626`).
- Missing:
  - the min ≤ max check;
  - normalizing 0 to "no limit" on the Plugin path;
  - `slotBackingLayerId` and slot primary instances (layers in Wecra's slot content are plain real nodes);
  - moving content back under `0:2` at export.

**Plan.** Task 14 (validation), task 8 (export placement), task 20 (primary instances, deferred).

### 2.19 Property validation rules — partial

**Figma.**
- A name or default cannot be empty. The live check showed that an empty *default* is accepted for TEXT and SLOT,
  so the rule bites on names, and on defaults only where the type requires a value.
- Variant names and values cannot contain '=' or ','.
- The default's type must match the property type.
- An instance-swap default must be a SYMBOL that creates no cycle, and attaching a ref must not create one.
- Refs only go on sublayers of a main, never on instance or slot sublayers.
- A component cannot contain an instance of itself (`visual_bell.components_can_t_contain_instances_of_themselves`).
- Reparenting must not create a set cycle.
- Publish errors: `UNUSED_DEF_ERROR`, `CONFLICTING_NAMES_ERROR`, `CONFLICTING_NAMES_WITH_VARIANT_ERROR`.

**Wecra.**
- An empty name becomes a default name (`ComponentCommands.cpp:1559-1570`). `editComponentProperty` ignores an empty
  name (`:1627`).
- An instance-swap default is not checked to be a SYMBOL.
- Self-containment is not refused at edit time. The materializer stops the expansion at a repeated main or at depth
  16 (`Instances.cpp:580-585`), so a main containing its own instance silently draws empty.
- `bindComponentProperty` refuses derived ids (`:1756`), so the sublayer rule holds.
- No publish-time check for unused defs or conflicting names.

**Plan.** Task 2.

### 2.20 Default names for new properties — different

**Figma.** If `name` or any `name N` exists, the new name is `name ` + (max(N, 1) + 1); otherwise it is `name`.
That gives Slot, Slot 2, Slot 3. A boolean's base is the selected layer's name (`boolean_property_default_name
{selectedNodeName}`). NUMBER, SLOT and INSTANCE_SWAP have their own bases; other types use the type name.

**Wecra.** "Property 1", "Property 2", … taking the first free slot, in both the engine (`ComponentCommands.cpp:1560`)
and TS (`model/components.ts:297-300`).

**Plan.** Task 6.

### 2.21 Detach — partial

**Figma.** The instance becomes a frame with `detachedSymbolId` 342 `SymbolId {guid | assetRef {key, version}}`;
`assetRef` is used for library mains. Plugin `detachedInfo`: null on INSTANCE or SYMBOL;
`{type:'library', componentKey}` when a key exists, else `{type:'local', componentId}`. A nested detach detaches its
ancestors (`parent_num_instances_detached`).

**Wecra.** Ancestors are detached first, as in Figma (`ComponentCommands.cpp:1083-1125`). It always writes
`AssetId::of(main)`, a guid (`:1044`), even when the main is a library copy whose guid means nothing outside this
file. `assetRef` is kept on import (`docs/schema.md` §5.7). There is no `detachedInfo`.

**Plan.** Task 11.

### 2.22 Soft-deleted mains and dangling instances — done / missing

**Figma.** Mains are soft-deleted (`isSoftDeleted` 330, `ancestorPathBeforeDeletion` 235) and restorable.
Instances of soft-deleted symbols stay linked. Instances whose symbol cannot be found are detached (on reconnect,
on branch merge, or by an explicit action).

**Wecra.** Soft delete and restore are done (`ComponentCommands.cpp:1849-1928`, `docs/schema.md` §5.7). An
instance whose main is missing shows "Missing component" (`Component.tsx:142`) and stays an instance with no
sublayers.

**Plan.** Task 19: Figma's explicit action, and an automatic detach on branch merge (Phase 7 branching) using
`detachOne`'s path with stored derived data.

### 2.23 `defaultVariant`, `derivedSymbolData`, materializer — done / partial

- **Default variant.** Figma uses the library's `default_state_key` for published sets and
  `getDefaultStateForLocalStateGroup` for local ones. Wecra uses the top-left variant (`ComponentCommands.cpp:231`).
  Library sets are copied whole, so the copy's top-left is the library's. **Done.**
- **`derivedSymbolData`.** Size, transform and derived text per `guidPath`, with `derivedSymbolDataLayoutVersion`
  196 kept. Wecra's ENCODE_DERIVED writes the same (`docs/engine.md` §3.4 "derived data stored"). **Done**; level is
  task 9.
- **Materializer.** Figma derives lazily per page, defers invisible descendants
  ("force-materialize-invisible-children") and uses push invalidation over node, field and override dependencies.
  Wecra derives per page (`engine.md` §3.4 round 2 / round 4) with push dependencies (`Instances.cpp:8-11`).
  Invisible subtrees are always expanded. **Partial** (task 22, performance only).

### 2.24 Plugin API surface — partial

**Figma.**
- `addComponentProperty` types and options: `{preferredValues [{type, key}], description, slotSettings}`.
- `componentPropertyReferences` is strict: only `visible`, `characters`, `mainComponent` and `slotContentId`.
- `setProperties` takes a boolean, a string or a VariableAlias.
- The `overrides` getter renames `strokeTopWeight` to `stokeTopWeight` (sic).
- `swapComponent` rejects anything that is not a SYMBOL.
- The `mainComponent` setter calls `replaceSymbolBackingInstance`, a different path from swap.
- `removeOverrides`, with `resetOverrides` as its alias.
- `detachedInfo`, `importComponentByKeyAsync`.

**Wecra.**
- `src/renderer/src/editor/plugins/runtime/figma.js:208-271` and `host.ts:516-569`.
- `addComponentProperty` drops the options (`host.ts:519`).
- `mainComponent` is read-only (`figma.js:265`).
- Only `resetOverrides` exists, and it clears assignments.
- There is no `removeOverrides` and no `detachedInfo`.
- `importComponentByKeyAsync` rejects (`host.ts:668`).

**Plan.** Tasks 12 and 13.

### 2.25 `nestedInstanceResizeEnabled` / `simplifyInstancePanels` — missing (round trip only)

394 and 284 are placeholders in Wecra (`document.kiwi:2139`, `:2150`). Figma never reads 394 outside its field
tables, and 284 belongs to a feature deprecated in 2026. **Plan:** task 23 adopts both, and 581, as kept `@later`
fields, so that a `.fig` round trip keeps them.

---

## 3. Integration plan (ordered)

Every engine task ends with a native case in `engine/tests/unit/components.test.cpp`, or `libraries.test.cpp`
where noted, and `npm run engine:build` (the Wasm is committed). Schema tasks run `npm run engine:gen -- --check`,
which checks Figma parity, and update `docs/schema.md`. New UI text goes through `t()` with its Turkish entry.

1. **Single-text rule** (S). In `Editor::remapOverrides` (`ComponentCommands.cpp:1296`), after the per-entry pass:
   - Trigger: some override carrying `F_TEXT_DATA` did not transfer, the old main has exactly one TEXT node in its
     derived tree, and so does the new one (count through nested instances, as Figma's "in the instance" and "in the
     new backing symbol" wording implies).
   - Then move the text fields to that node's path, but only when the override was not carried by a name match.
   - Apply it on swap, on a variant switch, and in `carryNestedOverrides`.
   - Tests: Label → Title keeps "Hello"; with two texts nothing moves.
2. **Validation** (M). Engine-side refusals, returned as `E_INVALID` with a message key the TS toast shows in
   Figma's wording:
   - empty names;
   - '=' or ',' in VARIANT names or values (in add, edit, `setVariantProperties` and the rename backfill);
   - a default whose kind does not match the type;
   - an INSTANCE_SWAP default or preferred value that is not a SYMBOL or set, or that would cycle;
   - a component containing an instance of itself, transitively, refused on create, paste, insert, reparent and swap
     (`components_can_t_contain_instances_of_themselves`, shown as a visual bell);
   - reparenting that creates a set cycle;
   - conflicting `overrideKey`s repaired at load (§2.2).
   - Publish dialog: list unused defs and conflicting names as Figma's three publish errors (`data.md` §9 publish
     check).
3. **Push enable rule** (S). In `computeComponentInfo` (`:517`), `canPush` = a single primary instance (top-level,
   **or** directly inside a main), not remote or copied, and either `componentPropAssignments` non-empty or an
   override touching a field outside {`name`} ∪ layout fields (the stack/size group; take the exact set from Figma's
   `hasOverrideOnNonLayoutNonNameField` once a sample shows it, open item O6). `pushChangesToMain` also pushes the
   instance's own assignments: bound layers' values become the defs' defaults. Drop the panel-side name filter
   (`Component.tsx:164`); the engine answers.
4. **Reset categories** (M). Replace `RESET_GROUPS` with Figma's 15 kinds plus Variable modes. Labels come from
   Figma's `reset-*` actions; "Layer" covers opacity, corners, auto layout, layout guides and "others". Add the
   missing groups: prototype interactions, overlay, slot assignment (= Reset slot) and variable modes
   (`variableModeBySetMap`). Engine: `RESET_OVERRIDES {kind}` in place of field lists, keeping `fields` for
   compatibility. Plugin: `removeOverrides()`, with `resetOverrides` as its alias, resets overrides only and keeps
   assignments (live-verified). Wait for O4 before changing the UI's reset-all.
5. **Exposed instances** (S). `setExposedInstance`:
   - Refuse unless the node is a primary instance in a component or set **and** has exposed nested instances or
     property-bound children; refuse an instance in a slot (Figma's four messages).
   - Write `propsAreBubbled` on every *connected* instance: the instance at the same effective `overrideKey` in every
     variant of the set, in one transaction.
   - Panel: 5 rows, else 4 plus "Show N more"; slot sublayers disabled unless already exposed.
6. **Default property names** (S). In one shared helper (engine `addComponentProperty` and
   `model/components.ts newPropertyName`), Figma's `name N+1` rule with per-type bases. Boolean: the selected layer's
   name, or a fallback when several layers are selected. Text: "Text". Instance swap, Slot and Number: Figma's own
   strings (take them from the figma_app i18n table, open item O7). Variant: "Property".
7. **Variant backfill** (M). A user rename of a variant SYMBOL inside a set (a `F_NAME` write that is not from
   `renameVariants`) is parsed:
   - Valid pairs update `variantPropSpecs` and `stateGroupPropertyValueOrders`, and add a VARIANT def for a new
     property name, like `backfillVariantPropDefs`.
   - Invalid names are kept, and the variant shows as conflicting (Figma's "conflicting variants" yellow state).
   - Lock a variant's default value (EDIT refuses `defaultValue` on VARIANT and SLOT).
   - The Plugin path refuses VARIANT on a loose component. The UI keeps converting it to a set.
8. **`.fig` export fidelity** (L). In `figmaExport.ts toFigmaMessage`:
   - SYMBOL `key` → `componentKey` 216 and, on a library copy, `version` → `sharedSymbolVersion` 126. Sets keep 319
     / 171.
   - One implicit def per explicit def on each variant (`parentPropDefId` 5), with variant-level refs and
     assignments remapped.
   - `componentPropRefs` 267 dual write from PROP_REF entries. This needs `ComponentPropRef` and
     `ComponentPropNodeField` in the schema (Figma's numbers, `@later`).
   - Slot content frames moved under `0:2`, with the assignment's `varValue` SLOT_CONTENT_ID as Figma writes it.
   - Root override path `[]` → `[symbolID]`.
   - Tests: `figmaExport.test.ts`, and the round trip export → `convert.ts` → identical model. Settle O1 / O2 with
     the owner's `sections.fig` first.
9. **`overrideLevel`** (M). Schema: `int overrideLevel = 321` (replaces `_r321`). Kept by import and codec; the
   engine's override stack keys `(path, level)` with level 0 first (`Instances.cpp:98-157`). Wecra writes 0 only.
   Native test from a sample with a level-1 entry (open item O8: find one in the owner's file).
10. **Nested swap transfer + stash** (L). Schema: `InstanceOverrideStash {GUIDPath overridePathOfSwappedInstance 1,
    string componentKey 2, NodeChange[] overrides 3}` and `NodeChange.overrideStash = 248`, `@nooverride` on the
    primary instance. A nested swap in `swapInstance` (derived ref):
    - Rewrite the stored overrides under that path through `remapOverrides(old, new)`, as `carryNestedOverrides`
      does at derive time.
    - Stash the old component's untransferred overrides, keyed by `(path, old key)`, and restore them on a swap back.
    - The derive-time carry stays as a fallback for files written before.
    - NODE_CHANGES: still one `symbolData` value plus the new 248 field on the same instance.
11. **Detach identity** (S). In `detachOne` (`:1044`), when `libraryRootOf(main)` is set, write
    `detachedSymbolId {assetRef {key, version}}`. Plugin `detachedInfo` follows Figma's rule (null on INSTANCE or
    SYMBOL, library when an `assetRef` or key exists, local otherwise).
12. **Plugin API** (M). In `figma.js` / `host.ts`:
    - `addComponentProperty` options: `preferredValues` by key, `description`, `slotSettings` with Figma's
      validation and renames (`displayEmptyByDefault` → `displayByDefault`, 0 → null on read).
    - BOOLEAN ↔ BOOL; VARIANT through the set-only path.
    - Strict `componentPropertyReferences` keys.
    - `setProperties` with a VariableAlias → `varValue`.
    - The `overrides` getter with the `stokeTopWeight` quirk.
    - `swapComponent` refuses a non-SYMBOL; a component set is not accepted (Figma throws).
    - A writable `mainComponent` (replace backing instance: no override transfer, overrides cleared; check the exact
      semantics in a probe first, open item O9).
    - Tests: the plugins Wasm fixture suite.
13. **`importComponentByKeyAsync`** (M). Store: resolve the key through `moved.json` (Figma's
    `movedLibraryItems.subscribed`), throw "Cannot import component with key "…" since it is unpublished" for
    local-only keys, fetch the payload (`getPayloads`), import through `importLibrary`, and return the copy, or the
    variant with that key inside the whole set. `importComponentSetByKeyAsync` follows the same path.
14. **Slot settings validation** (S). Engine and panel refuse `min > max` with Figma's message, and treat 0 / null as
    no limit. SLOT defaults cannot be edited.
15. **NUMBER and IMAGE properties** (L). Schema:
    - `ComponentPropType NUMBER = 5, IMAGE = 6`.
    - `ComponentPropValue` keeps `floatValue` 4. IMAGE's value field needs to be identified from a sample (open item
      O10).
    - `ComponentPropPreferredValues.parameterValues = 3` (`VariableData[]`); `stringValues` gets its deprecated tag.

    Bindings: NUMBER to numeric fields through PROP_REF (`VariableField`s as Figma uses them), IMAGE to an image
    paint. The panel gets the rows and the create menu; the materializer resolves them in `applyBindings`.
16. **`visibleWhen`** (M). Schema: `ComponentPropDef.colorArrayConfig = 13` stays a placeholder,
    `ComponentPropVisibilityClause[] visibleWhen = 14`, and the three messages with Figma's numbers. Engine: a pure
    `propVisible(def, assignments)` (OR over clauses, AND over matches) used by `propertiesOf`. The panel hides rows.
    UI to author it only after O3.
17. **Library update rule** (S). Adopt `string userFacingVersion = 399`. The updates diff (`data.md` §9 / §16)
    offers an update only when the hash differs **and**, when both sides have a UFV, the UFVs differ
    (case-insensitive). Skip assets of the current file. Test in `libraries.test.ts`.
18. **NIVB checks** (S). The bind command refuses a non-STRING variable ("…does not resolve to a string"). When a
    mode change re-picks a variant and `carryNestedOverrides` drops overrides, log Figma's W01 warning to the engine
    trace.
19. **Dangling instances** (S). A command "Detach instances of missing components" for instances whose
    `symbolID` / `overriddenSymbolID` is gone. It detaches from the stored `derivedSymbolData` when present, otherwise
    makes an empty frame. Branch merge (Phase 7 round 2) calls it.
20. **Slot primary instances** (L, deferred). `slotBackingLayerId` and "one content id per primary instance". Plan
    it with multiplayer (Phase 6), where per-node LWW on slot content matters.
21. **Partial sets on paste** (XL, deferred). Keep whole-set copies. Revisit when org libraries have large sets
    (`docs/data.md` §16).
22. **Invisible descendants deferred** (M, performance). In `expandChildren`, do not expand a hidden subtree's
    nested instances until a read, an override write or a visibility change needs them. Measure with
    `scripts/engine-bench.mjs` first.
23. **Kept fields** (S). Adopt `nestedInstanceResizeEnabled 394`, `simplifyInstancePanels 284` and
    `PartialPasteAnnotation partialPasteAnnotation 581` as `@later` (stored and round-tripped, not used).

Tasks 1, 3, 5, 6, 11 and 14 are independent small engine and panel items, which fit one round. Tasks 2, 4 and 7
come next. Tasks 8, 9, 10, 15 and 16 touch the schema and should be batched into one schema round with a single
Wasm build.

## 4. Open items (verify before building)

- **O1** — Figma's exact implicit-def contents on variants (id allocation, which fields are copied); read from
  `docs/research/figma/samples/sections.fig` or the owner's export.
- **O2** — Does Figma ever write `isSlot` 463 itself? (The owner's private file had 806 slot fields without it.)
- **O3** — Where `visibleWhen` is authored in the UI, and whether it is flag-gated.
- **O4** — Does the UI's "Reset all changes" (`reset-symbol`) reset property values? The Plugin path does not.
- **O5** — Where and when Figma sets `userFacingVersion` (publish dialog? version names?).
- **O6** — The exact field set behind `hasOverrideOnNonLayoutNonNameField`.
- **O7** — Figma's default base names for Number, Slot and Instance swap properties (figma_app i18n strings).
- **O8** — A sample override entry with `overrideLevel` ≠ 0, and what level 0 means.
- **O9** — `mainComponent =` (`replaceSymbolBackingInstance`) vs `swapComponent`: which overrides survive.
- **O10** — IMAGE property value encoding (`ComponentPropValue` field) and acceptance with a real image hash. The
  live probe had no `createImageAsync`.
