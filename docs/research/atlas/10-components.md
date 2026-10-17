# 10 — Components, variants, properties, instances

Figma Design desktop 126.9.13. Read on 2026-10-16 from the cached editor build (`~/.cache/figma-rea/figma/`, outside the
repo), following `~/.cache/figma-rea/BRIEF.md`. Figma's code is not copied here. The file records behaviour, numbers,
enums and strings, each with its evidence: `file @byte-offset` or a short quote. **CONFIRMED** means read directly in
the build. **INFERRED** means deduced from what was read.

## 1. Scope and sources

**Scope.** This chapter covers:

- Creating components: Create component, Create multiple components, Combine as variants, Add variant.
- Variant naming, parsing and errors.
- Component properties: types, defaults, validation, preferred values, the Properties panel.
- Instances: overrides, the reset kinds, Push changes, detach, Go to main component and Return to instance, the
  missing-variant panel, restoring a deleted main.
- Swapping: the instance swap picker, its sections and starting state, swapping by drag, and the context menu's
  variant swap.
- The Assets panel: tile layout, search, the details flyout, the context menu, inserting.
- The undo step names, and every error, visual bell and toast found.

Slots, interactive components and library publishing are summarised and linked here. They are covered in depth in
R4 §6, chapter 13 and chapter 12.

**Prior work. It is summarised in one line each and not repeated.**

- `docs/research/rea/components.md` (REA, 2026-10-15) covers the data model:
  - primary and nested instances, sublayer ids, `componentKey` 216 and `sharedSymbolVersion` 126;
  - implicit and explicit property definitions, variant property definitions, PROP_REF bindings, `visibleWhen` 14;
  - the 19 schema property types, NIVB, `overrideLevel` 321, the override stash 248;
  - the reset kinds 0–14, the Push changes enable rule, the library update rule;
  - exposed instances (5 rows, or 4 plus "Show N more"), slot settings validation, validation messages, default
    property names, detach and `detachedInfo`, soft delete;
  - the single-text rule on swap, and a 23-task integration plan.

  Its §2 statements are still valid. This chapter re-confirms some of them and does not repeat them.
- `docs/research/figma/R4-components.md` covers the help-site behaviour (2024–2026 changes, overrides, detach, variants,
  properties, slots, libraries, Plugin API, the UI3 colours) and the round-6 check of slots and the panels.
- `docs/research/figma/live/` holds DOM captures of the real app (dark theme, 1440×900):
  - `design/{component,component-set,variant,instance,variant-instance,nested-instance*,*-with-slot}.txt`;
  - `menus/context-{component,instance}.txt`;
  - `popovers/{instance-*,component-*}.txt`;
  - `left/rail-assets*.txt`.

  These captures are the source of the English strings quoted below.

**Build sources read for this chapter**

| Source | What it gave |
|---|---|
| `3187.min.js` @1631425–1716000 | The action table (`jsonName`, enable predicates) for every component action, and the predicates `ej` (create), `eU` (create multiple), `eB` (add variant) and `eG` (detach) @1133424–1134400. |
| `3187.min.js` @2068300 | The labels of the reset actions (action → i18n key). |
| `3187.min.js` @1200546 | The Restore component modal. |
| `3187.min.js` @4856500–4860000 | The context menu of an asset tile. |
| `figma_app.min.js` @6401500–6411800 | The selection-actions toolbar and the More actions menu: the component flyout, the reset items and their order. |
| `figma_app.min.js` @3968700–3970700 | The "Reset specific changes" submenu, per-assignment reset, "Restore variant", the "Update available" button. |
| `figma_app.min.js` @3755800 | The panels for a restorable component and a missing variant. |
| `figma_app.min.js` @3759700–3770500 | The instance swap picker: its sections, starting state, search and removed-component banner. |
| `figma_app.min.js` @3941900–3949300 | The "Components" panel section (Combine as variants) and the variant error panel. |
| `figma_app.min.js` @3952600–3956300 | Variant helpers: name serialisation, rename and delete property, closest-variant matching, the toggle value pairs. |
| `figma_app.min.js` @2952000–2958300 | Property defaults per type, field → type rules, NUMBER parsing, prop-type → variable-type map, property errors. |
| `figma_app.min.js` @2987799 | The default name of a variant property, and when a variant shows as a toggle in Dev Mode. |
| `figma_app.min.js` @3382593 | The tile layout of library grids (WIDE / SMALL / NORMAL) and the column rule. |
| `figma_app.min.js` @1177786 | Instance insertion (`INSERT_SHARED_COMPONENT`). |
| `figma_app.min.js` @2473600 | The drag ghost, and zoom-to-fit when a component is dropped. |
| `figma_app.min.js` @7409117 / @7439900 | The `ComponentPropType` enum (JS view) and the variant-error enum. |
| `1630.min.js` (140 KB) | The Assets panel: tiles, flyout, search results, settings menu, breadcrumbs, the asset search configuration @75665. |
| `3653.min.js` @289901 / @674415 | The tile-size calculator (min / max columns, aspect, max height) and the grid math. |
| `3653.min.js` @777300 | Display names of documentation links (Dev Mode inspect). |
| `5579.min.js` / `6353.min.js` / `7094.min.js` @200783 | The Return to instance visual bell. |
| `9905.min.js` @131300–135100 | The Properties panel: the overflow of rows ("Show N more"). |
| `library_search_worker.min.js` | The search worker: Fuse.js in a worker. |
| `fullscreen__fullscreen-wasm__compiled_wasm.wasm` | The shortcut JSON @47285292; all 221 `visual_bell.*` keys; about 1150 English assertion and error strings on components (`strings -n 6`, cited as "wasm str"). |

**There is no English locale in the build. The bundle carries i18n keys.** English text below comes from the live captures
(`live:`), from the existing `src/shared/i18n` entries, or from help pages already cited in R4. A key is shown
without English when no source attests it.

## 2. Actions, enable rules and shortcuts

All rows are CONFIRMED from the action table (`3187 @1631425…`) and the shortcut JSON (`wasm @47285292`). The
`allowedEditorTypes` set lists the editors *beyond* Design, so Design is always allowed.

| Action (`jsonName`) | English (live) | Shortcut (mac / other) | Enabled when |
|---|---|---|---|
| `create-symbol` | Create component | ⌥⌘K / Ctrl+Alt+K | Shape edit mode. No variant (state) in the selection. The engine gate `canCreateSymbolFromDirectlySelectedNodes` holds. No repeater in the recursive selection. In Design, no code instance or code layer is selected. |
| `create-multiple-symbols` | Create multiple components | — | Shape edit mode, and the engine gate `canCreateMultipleSymbolsFromDirectlySelectedNodes`. |
| `create-multiple-symbols-and-state-group` | (key only: "Create component set") | — | Same gate as create multiple. |
| `create-state-group` | Combine as variants | — | Shape edit mode. 1 or more nodes, all of them components (symbolCount = nodeCount), and none of them a variant (stateCount 0). |
| `add-variant` | Add variant | — | A single node, which is a loose component or a component set. |
| `detach-instance` | Detach instance | ⌥⌘B / Ctrl+Alt+B | Shape edit mode. More instances are selected than instances inside repeaters, or a "layer-like" code instance is selected. |
| `find-symbol` | Go to main component | ⌃⌥⌘K / Ctrl+Alt+Shift+K | Not blocked. The selection is not empty and the selected instances share one main that is not soft-deleted (`hasNonSoftDeletedCommonSymbolBackingInstances`). |
| `push-changes-to-main` | Push changes to main component | — | One **primary** instance that is not from a library, and either it has property assignments or `hasOverrideOnNonLayoutNonNameField` (also in REA §2.14). |
| `reset-symbol` | Reset instance (live: context menu; panel: "Reset all changes") | — | `hasResettableInstance`. |
| `reset-*` (12 kinds, §6.2) | Reset size, Reset name, … | — | Each item shows only when its kind has an override (`isAvailable: b(kind)`). |
| `restore-symbol-or-state-group` | Restore component | — | `canRestoreSymbolOrStateGroup`. |
| `swap-to-related-symbol` / `swap-to-related-state` | (context-menu swap) | — | The selected instances share a backing symbol or state group. |
| `select-same-instance` | (Select › Same instance) | — | A single selected node that is or lies inside an instance, in selection mode. |
| `select-same-variant` | (Select › Same variant) | — | A single selected instance of a variant. |
| `component-insert` | (quick insert modal) | ⇧I | The `TOGGLE_COMPONENT_INSERT_MODAL` code. Off in FigJam, Slides, Sites and Buzz. |
| `convert-to-slot` | Convert to slot | ⌘⇧S / Ctrl+Shift+S | `canConvertSelectedNodesToSlot`, and create actions not blocked. Not in text edit. |
| `group-selection-into-slot` | Wrap in new slot | — | `canGroupSelectedNodesIntoSlot`. |
| `reset-slot-assignment` | Reset slot | — | `singleNodeSlotAssignmentIsResettable`. |
| `main-component` | Main component ▸ (context submenu, live) | — | Always (`MASTER_COMPONENT_MENU`). |
| `toggle-layers` | Layers tab | ⌥1 | — |
| `toggle-publish` | Assets tab (INFERRED: "publish" is the old internal name of Assets, R4: Assets is ⌥2) | ⌥2 | — |
| `toggle-library` | Libraries (INFERRED) | ⌥3, or ⌥⌘O with the "old outline shortcuts" preference | — |
| `focus-mode-component-set-toggle` | — | Q | **Sites only** (allowed editor types = {SITES}). Out of scope. |

**Debug and internal actions.** Their `allowedEditorTypes` set is empty, which leaves only Design. They are reachable
from Quick actions, the debug menus or the action API:

- `regenerate-all-instances`, `regenerate-selected-instances`, `detach-all-instances`, `repair-selected-instances`;
- `repair-state-group-versions`, `find-shared-instances-need-relinking`, `relink-instances-to-local-component`;
- `calculate-deleted-components-published-version`, `clear-component-props-data-for-selection`,
  `regenerate-component-props`, `prune-invalid-component-prop-refs`;
- `restore-soft-deleted-selection`, `reset-variable-modes`, `remove-detached-symbol-id`;
- `republish-selected-components`, `republish-auto-layout-components`;
- `simplify-selected-instance-panels` (Sites only).

CONFIRMED `3187 @1631425…`.

**The selection toolbar's component flyout.** On a selection it offers the `component_actions` flyout, with the
tooltip key `fullscreen.selection_actions.tooltip_component_actions`. Its items are Create component, Create multiple
components and Create component set, in that order (`figma_app @6405400`). CONFIRMED.

**Order of the instance block in that toolbar.** Restore variant, then Push changes to main component, then Detach
instance, then Reset instance, then the code and responsive-container reset entries, then the "Reset specific changes"
submenu. Before them come Add variant, Component configuration and the property-binding button
(`figma_app @6408000` `O=[ei,d,…]`, `w=[l,V]`, `N=[G,H,z,K,e]`). CONFIRMED. The live More actions menu of an instance
shows a subset: Toggle ready for dev status / Create component / Detach instance / Reset instance / Reset name / mask
and boolean items (`live: popovers/instance-more-actions-menu.txt`).

## 3. Creating components and component sets

### 3.1 Refusals while creating (wasm)

| Situation | What Figma does | Evidence |
|---|---|---|
| The selection mixes kinds that cannot become one component | Visual bell `cannot_create_symbol_from_non_matching_selection`. | wasm str (visual_bell list) |
| The selection holds a node named like a component path | `please_remove_component_symbol_name_from_this_selection`. INFERRED meaning. | wasm str |
| The result would contain an instance of itself | `components_can_t_contain_instances_of_themselves`. | wasm str |
| The create fails | Logged "Could not create component". The engine's own failure string is "Cannot create component from node". | wasm str |
| Created inside a Slides slide or a Sites webpage | `slides_you_cant_include_this_within_a_component`, `sites_you_cant_create_component_inside_webpage`. | wasm str |
| Reparenting under a main would nest a component in a component | "Cannot move node. Reparenting would create a component inside a component". There are sibling messages for a component cycle, a set cycle, a template, a webpage and responsive sets. | wasm str |
| Something other than a component is moved into a set | "A COMPONENT_SET node cannot have children of type other than COMPONENT". | wasm str |
| A component is ungrouped | "Components cannot be ungrouped" / "Instances cannot be ungrouped". | wasm str |
| Paste or insert would create a cycle | "Cannot insert instance under parent that would create a cycle." Visual bell `some_components_were_reparented_to_avoid_a_dependency_cycle`. | wasm str |
| A create inside an instance's focus | `can_t_create_nodes_focused_on_instance`. | wasm str |

### 3.2 Combine as variants

- **The panel button.** With 2 or more components selected (`m._7(state) > 1`), the Design panel shows a
  **"Components"** section (`create_state_group_panel`). It holds one button, **Combine as variants**
  (`states_panel.combine_as_variants`), which runs `create-state-group` (`figma_app @3941900`). With a single
  component the section is not shown. CONFIRMED. English from R4 / live.
- **Naming.** C++ parses the slash names into `Property 1=…, Property 2=…`; R4 §5 has the help text. The JS serialises
  a variant name from its values in **property sort order** as `Prop=Value, Prop2=Value2`, joined with `", "` (the
  helper `h` @3952900). CONFIRMED.
- **Logging.** The selection-to-set path logs the analytics event "Creating Variant Component" `{type:"Merge"}`.
  CONFIRMED.
- **Layout.** No layout default for the new set (padding, gap, stroke) is in JS. The engine (FGStateGroupTool) creates
  the set. See the open questions.

### 3.3 Add variant

`add-variant` (§2) runs from:

- the component header (live: `[Add variant]` 24×24 at x 152);
- the purple "+" under a set on the canvas (live README: "3 Variants" label and "+"; wasm key
  `fullscreen.canvas.add_variant`).

On a loose component it turns that component into a set first. REA §2.5 holds the rule. Wecra's engine writes
"Property 1=Default" for this case, which is what Figma's JS writes when a property is deleted (§4.1). Where the new
variant is placed is decided in C++ and is not settled (open questions).

## 4. Variants

### 4.1 Names, renames and deletes (CONFIRMED, `figma_app @3952900–3955300`)

| Operation | Rule |
|---|---|
| Serialise a variant name | `Prop=Value` pairs in the set's `propertySortOrder`, joined by `", "`. |
| Rename a property | The new name is cleaned first: every `,` and `=` is removed, then the name is trimmed. An empty cleaned name, a name equal to the old one, or an old name not in the sort order is ignored. Otherwise each variant's values are re-keyed and its name rewritten. Variant-def backfill is **deferred** during the batch (`setDeferVariantPropDefBackfill(true)` … `false`), then the batch commits. Undo step names: `rename-variant-prop` / `rename-variant-property`. |
| Delete a property | The pairs are removed from every variant. A name left empty becomes **`Property 1=Default`**. Analytics: "Deleting Property from Variant Component". Undo step names: `delete-variant-prop(s)`. |
| Default value of a new variant property | The key `states_panel.default_property_value`. INFERRED English: "Default", since the delete path hard-codes "Default" (@2952900). |
| Default name of a new variant property | The key `component_properties.variant_property_default_name`, made unique against the existing names (`c.g(name, existing)` @2987799). R4 has the English "Property 1, 2, …" (INFERRED as the key's value). |
| Value order | `reorder-variant-prop-values`, `reorder-variant-props`. Live: Values are dragged by handles. |

### 4.2 Variant errors (CONFIRMED, enum `figma_app @7439900`, panel @3947000)

| Error | Value | Set-level message (key) | Variant-level message (key) | Action link |
|---|---|---|---|---|
| NONE | 0 | — | — | — |
| TOO_MANY_STATES_ERROR | 1 | `components_with_more_than_1000_variants_may_experience_performance_issues`. The limit is **1000** variants. | — | — |
| MISSING_PROPERTIES_ERROR | 2 | `some_variants_are_missing_properties` | `variants_are_missing_one_or_more_properties {variants}` | `select_invalid_variants` |
| DUPLICATE_STATE_ERROR | 3 | `some_variants_have_the_same_property_values_applied` | `the_properties_and_values_of_variant_are_conflicting {variants}` | `select_conflicting_variants` |
| PARSE_ERROR | 4 | `some_layers_have_invalid_names`, followed by a bold `prop_value_prop_value` (INFERRED: "Property=Value, Property=Value") | `layer_has_invalid_name {layers}` | `select_invalid_variants` |
| BACKFILL_FAILED_ERROR | 5 | `variants_backfill_failed_message` / `_no_access_message`, with "contact support" | — | Retry (state `"retry"`) |
| BACKFILL_KILLSWITCH_DISABLED_ERROR | 6 | `variants_backfill_killswitch_disabled_message` (a separate panel) | — | — |

- **Precedence.** The worst (highest) error over the selected variants wins (`g()` takes the max).
- **The selection link.** It clears the selection and then selects the offending variants.
- **Selection modes.** STATE_GROUP 0, STATE 1, STATE_INSTANCE 2, STATE_OR_STATE_INSTANCE_SUBLAYER 3,
  NON_STATE_COMPONENTS 4, NONE 5 (`@7440161`).

### 4.3 Which variant a property change picks (CONFIRMED, `figma_app @3955600` `T()`, used by the context menu's swap @2662197)

The variant property swap in the instance context menu sends one `{property, value}`. For each selected instance it
takes that instance's current values, sets the new value, and then picks a variant as follows:

1. Keep the variants whose values match the requested pairs, **as a prefix in request order**. With one pair, this
   means the variants that have that value.
2. If none match, nothing happens (null).
3. Among the matches, take the variant that **differs from the current values in the fewest properties**. A mixed
   value is not counted. The first such variant in set order wins a tie.

Instances are grouped by target and swapped in one `swap-related-symbol` step. Analytics: "Swapping A Variant"
`{source:"context_menu"}`. This settles R4 open question 2 ("a combination no variant has"): the nearest existing
variant is chosen, and if no variant has the requested value, nothing changes.

### 4.4 Variant shown as a toggle (CONFIRMED, `figma_app @3956161`)

The value pairs are **yes/no, true/false, on/off**, compared case-insensitively. The Dev Mode inspect property list
shows a two-valued variant property whose values are such a pair with the BOOL type (a toggle) instead of VARIANT
(@2987799). The design panel's toggle rendering uses the same list (R4 §15 says only True/False takes a boolean
variable).

### 4.5 The variant panels (live)

- **Set selected** (`live: design/component-set.txt`):
  - header: name, Multi-edit variants (checkbox), Add variant, Component configuration, More actions;
  - Properties: a variant row ("State · Default, Hover, Pressed");
  - a "Create property" button.
- **Variant selected** (`live: design/variant.txt`): "Current variant", with Select component and the
  `[Edit property name for State]` / `[Edit property value for State]` dropdown. The dropdown lists the values and
  ends with "Rename…".
- **Toolbar "Restore variant".** It is offered when the selection is a variant whose main is a deleted state
  (`SYMBOL_AS_STATE`, `figma_app @3970210`).

## 5. Component properties

### 5.1 Types (JS enum, `figma_app @7409117`)

BOOL 1, TEXT 2, INSTANCE_SWAP 3, VARIANT 4, NUMBER 5, IMAGE 6, SLOT 7, EASING 8, COLOR 9, VECTOR 10, CIRCLE 11,
COLOR_POINT 12, LINE 13, CIRCLE_POINT 14, GRADIENT 15, PAINT 16, NODE 17. This is the client's own numbering. The kiwi
numbering is in REA §2.8. CONFIRMED.

The Create property menu offers (live, `component-create-property-menu.txt`): **Variant, Text, Boolean, Instance
swap, Slot**, then "Expose properties from" › **Nested instances**. NUMBER and IMAGE are in the code but not in that
menu in this build. The NUMBER keys exist: `number_property_default_name`, `component_properties.number`. INFERRED:
NUMBER and IMAGE are behind a flag, or are offered only from a field's "Apply property" button (see 5.3).

### 5.2 Defaults, binding fields and value rules (CONFIRMED, `figma_app @2952000–2958300`)

| Type | Default value of a new property | Binds to field(s) | Variable type for "Apply variable" | Scope |
|---|---|---|---|---|
| BOOL | `true` | VISIBLE | BOOLEAN | all scopes |
| TEXT | `""` | TEXT_DATA | STRING | TEXT_CONTENT |
| INSTANCE_SWAP | `null` (must be chosen) | OVERRIDDEN_SYMBOL_ID | — | — |
| VARIANT | `states_panel.default_property_value` ("Default", INFERRED) | — | (STRING via RESOLVE_VARIANT, REA §2.9) | — |
| NUMBER | `"0"` | TEXT_DATA (a number can drive a text layer) | FLOAT (TIMING when the field is a timing) | all scopes |
| IMAGE | `""` | (image paint) | — | — |
| SLOT | — | SLOT_CONTENT_ID | — | — |
| COLOR / PAINT | white `{1,1,1,1}` / a white SOLID paint, opacity 1, NORMAL blend | FILL / STROKE paint data | COLOR / PAINT | all scopes |
| EASING, VECTOR, CIRCLE, LINE, CIRCLE_POINT, COLOR_POINT, GRADIENT | an easing preset, `{x:0,y:0}`, `{x,y,radius:0}`, `{x,y,x2,y2}`, `{x,y,radius,angle}`, `{x,y,color black}`, default stops | motion and shader parameters | EASING / … | — |

**Field → allowed property types** when you click "Apply / Create property" on a layer field:

| Field | Allowed types | First choice |
|---|---|---|
| VISIBLE | BOOL | BOOL |
| TEXT_DATA | TEXT, NUMBER | TEXT |
| OVERRIDDEN_SYMBOL_ID | INSTANCE_SWAP | INSTANCE_SWAP |
| SLOT_CONTENT_ID | SLOT | SLOT |

Any other field throws "Unsupported parameter field".

**NUMBER values.**

- Accepted text matches an optional sign followed by digits with an optional decimal part, or a decimal starting with
  ".". The value must also be finite and not blank.
- The value is stored rounded to **2 decimals**.
- It is shown with the trailing zeros and any trailing "." removed. "1.50" shows as "1.5"; NaN shows as "0".

CONFIRMED (`el`, `ec`, `eu` @2957000).

**Validity check used by the panel.**

- INSTANCE_SWAP needs a value.
- TEXT needs a non-empty value.
- NUMBER needs a parsable value.
- Everything else is valid.

The source writes the TEXT/VARIANT case as one `case A||B`, which in practice matches TEXT only, so an empty VARIANT
value passes this check. The engine's "Component property default value cannot be empty" then catches it.
CONFIRMED (code reading). It is noted here because a clone must not copy the slip.

**Boolean display.** The Boolean selector shows the keys `boolean_true` / `boolean_false`. Live: "True" / "False" (in
`design/component.txt`, "Show icon · True").

### 5.3 The "Apply / Create property" button on a layer field (CONFIRMED, `figma_app @2968900`)

- **Label.** If the main already has properties of the field's first-choice type, the label is
  `apply_component_property {propType}`. Otherwise it is `create_component_property_of_type {propType}`. `propType`
  is the lower-cased type name.
- **When it shows.** There is a containing product component, the selection has no instance sublayers, and the
  selection does not include the component itself **when the field is VISIBLE**. It also shows when a property already
  binds the selection.

Consequence: a Boolean cannot be applied to the main component's own top-level visibility. A Text or Instance swap
property can be applied to a nested layer.

**Slots block this button.** The tooltip `slots_disable_prop_binding_tooltip` shows when the selection is inside a
slot. Wasm messages: "Cannot set component property references on slot sublayer" and "Cannot set component property
references on instance sublayer".

### 5.4 Engine validation messages (wasm, CONFIRMED English, user-visible through plugins and the panel)

- **Names and values**
  - Component property definition name cannot be empty
  - Component property default value cannot be empty
  - Component property name cannot have '=' or ','
  - Variant property name cannot have '=' or ','
  - Component property default value cannot have '=' or ','
  - Component property default value must be a string
  - Node already has a variant property with name …
  - Invalid component property name
  - Invalid variant property name
  - Not a valid component property type
  - Property value is incompatible with component property type
  - componentPropType does not match type of defaultValue
- **Where a property can go**
  - Can only add variant property to a component set
  - Can only set variant property on a component set
  - Unable to set a property that does not exist on component set
  - Can only set component property references on symbol sublayer
  - prop defs can only be edited when selecting a single symbol node
  - Can't add slot prop def to multiple product components at once
  - Cannot change defaultValue of a variant property
  - Cannot change defaultValue of a slot component property
  - Slot component property values cannot be edited
- **Instance swap defaults**
  - Default value for instance swap must be a symbol
  - Default backing symbol ID for instance prop will create cycle
  - Value for instance swap component property is invalid
  - Instance swap preferred value missing valid type
  - Invalid preferred value for component property type
- **Exposing nested instances**
  - Can only expose primary instances.
  - Can only expose instances that have exposed nested instances or children with component property references.
  - Instance must be contained within a component or component set to be exposed.
  - Cannot expose instances within slots.
- **Overrides and fonts**
  - This property cannot be overridden in an instance
  - Unable to update this text property because the component uses a font that isn't available.
- **Variants**
  - Unable to find a variant with those property values. This is the Plugin path `setProperties` with a combination no
    variant has. The UI path picks the nearest variant (§4.3).

### 5.5 Property errors shown in the Properties panel (CONFIRMED @2953800)

| Def error (enum `uXg`) | Text key |
|---|---|
| CONFLICTING_NAMES_ERROR, CONFLICTING_NAMES_WITH_VARIANT_ERROR | `component_properties.error_conflicting_name`. A variant row is flagged when its name clashes with a typed property (@2987900). |
| UNUSED_DEF_ERROR | `component_properties.error_unused_property` |
| (none) with unpublished preferred values | `component_properties.has_unpublished_preferred_values` |

Preferred-values loading failure: `cant_show_values` with a "Try again" link (`try_again` / `trying`), in `2622
@1167194`.

### 5.6 The Properties panel (CONFIRMED / live)

- **Row overflow.** With overflow hiding on (UI3), more than **5** rows (variant plus typed) show **4** rows and a
  button `show_more_property_rows {count}`, where count = total − 4. Variant rows take the first slots
  (`9905 @131300`). The same 5 / 4 rule holds for the nested-instance rows (REA §2.17).
- **Section order.** Variant properties always sit above the others (R4). The engine stores `sortPosition`. Reorder
  is the undo step `reorder-prop-defs`.
- **Live geometry (`design/component.txt`).**
  - Header row at y 12: the name input 136×24, then Add variant, Component configuration and More actions at x 152,
    180, 208, each 24×24, radius 5.
  - "Properties" label at 11 px / 550 / `#ffffffb2`.
  - Create property button at x 208.
  - Each property row is 208×24 on `#383838` with radius 5: a type icon (24×24), the name at 11 px / 400 white, a "・"
    separator, and the default value at 70 % white. The rows sit at y 76, 108 and 140, a **32 px pitch**.
- **Component configuration popover** (live): Description, a rich-text field with the placeholder "How to use this
  component" (Bold ⌘B, Italic ⌘I, Strikethrough ⌘⇧X, Header 1, Bulleted list, Ordered list, Link ⌘⇧U, Code ⌘⇧C, Code
  block ⌘⇧⌥C), and a "Link to documentation" field. The links are stored through `setSymbolLinks`, which takes an
  array of `{uri, displayName?}` (wasm: "setSymbolLinks passed a link without a uri").
- **How a documentation link is shown** (Dev Mode, `3653 @777300`). When it has no display name, the host gives one:
  github.com → GitHub, figma.com → Figma, zeplin.io → Zeplin, atlassian.com → Jira, asana.com → Asana. The button reads
  `view_in_display_name {displayName}`, or `view_documentation` for an unknown host. It opens in a new tab. When there
  are no links, the URLs inside the description are used. CONFIRMED.

### 5.7 Undo step names (CONFIRMED, `l7.user("…")` in figma_app / 3187 / 9905)

- **Definitions:** add-prop-def, component-prop-def, delete-prop-def(s), edit-prop-def-name,
  edit-prop-def-description, edit-prop-default-value, edit-prop-def-slot-prop-config, reorder-prop-defs.
- **Bindings:** add-prop-ref, delete-prop-ref.
- **Preferred values:** add-preferred-prop-values, remove-preferred-prop-value(s), toggle-preferred-prop-value,
  slot-insert-preferred-value.
- **Variant properties:** add-variant-property, delete-variant-prop(s), edit-variant-prop-name,
  rename-variant-prop(-value), reorder-variant-prop(s|-values), change-variant-prop, set-variant-variable-binding,
  clear-variant-variable-binding.
- **Instance values:** component-prop-assignment, set-instance-prop-assignment, set-text-prop-assignment,
  set-number-prop-assignment, toggle-bool-prop-assignment, reset-prop-assignments.
- **Instances and mains:** swap-instance, swap-related-symbol, replace-symbol-backing-instances, reset-variant,
  restore-component, insert-component, insert-state-group, set-symbol-links, update-shared-symbol,
  update-shared-state-group.

Each user edit is one step. The action ids in §2 are steps of their own.

## 6. Instances

### 6.1 What an instance can and cannot change

Covered by R4 §3 and REA §2.1. The engine refuses a write to a field that cannot be overridden: "This property cannot
be overridden in an instance: <field>" (wasm). Structural moves are refused with "Cannot move node. Node is inside of
an instance" or "…New parent is an instance or is inside of an instance".

### 6.2 Resets (CONFIRMED)

- **Reset all.** `reset-symbol`, labelled `fullscreen_actions.reset-instance`. Live: "Reset instance" in the context
  menu and More actions. The panel says "Reset all changes" (help).
- **"Reset specific changes"** is a submenu (`fullscreen.properties_panel.layer_header.reset_specific_changes`) that
  lists only the kinds that are overridden. Its fixed order (`figma_app @6411748`):

  | # | Action | Label key | Kind |
  |---|---|---|---|
  | 1 | reset-exports | `instance_panel.reset_exports` | EXPORTS 1 |
  | 2 | reset-effects | `reset_effects` | EFFECTS 2 |
  | 3 | reset-layer | `reset_others` | LAYER 3 |
  | 4 | reset-visible | `reset_visibility` | VISIBLE 4 |
  | 5 | reset-name | `reset_name` (live: "Reset name") | NAME 5 |
  | 6 | reset-fill | `reset_fill` | FILL 6 |
  | 7 | reset-stroke | `reset_stroke` | STROKE 7 |
  | 8 | reset-text | `reset_text` | TEXT 8 |
  | 9 | reset-text-style | `reset_text_style` | TEXT_STYLE 9 |
  | 10 | reset-size | `reset_size` | SIZE 10 |
  | 11 | reset-prototype-interactions | `reset_interactions` | PROTOTYPE_INTERACTIONS 12 |
  | 12 | reset-overlay | `reset_overlay` | OVERLAY 13 |

  After these comes **one entry per overridden property assignment**: `reset_property_assignment_v2 {assignmentName}`,
  with the property type's icon. It runs `resetComponentPropAssignmentForInstances(instanceGUIDs, defId)` as the step
  `reset-prop-assignments` (`figma_app @3969779`).
- **Toolbar icons.** All the reset kinds share one icon family (`figma_app @2241678`).
- **Hoisting.** Every reset item is `preventHoisting`, so it never gets promoted to the toolbar's top level.
- **Variable modes.** "Reset variable modes" is a separate action and is not in this submenu.

### 6.3 Detach

Detaching a nested instance detaches its ancestors and rings the bell `parent_num_instances_detached` (REA §2.21,
wasm). Detaching a component with styles from an unavailable library rings `styles_detached`. When the main cannot
be found, the instance is detached automatically on reconnect or branch merge ("Detached dangling instances during
reconnect", "Detaching an instance during branching because its symbol can't be found"). A read-only file refuses
with "Cannot run detachInstance in a read only document or mode".

### 6.4 Go to main component and Return to instance (CONFIRMED, `5579 / 6353 / 7094 @200783`)

- **Going.**
  - A local main is selected on its page.
  - A library main opens the library file with the URL parameter **`main-component=1`** next to `node-id`
    (`figma_app @2486047`).
  - The panel's button reads `go_to_main_component`, or `go_to_main_component_nin_library` for a library main.
  - The instance panel shows `from_this_file` or the library name; for Community libraries, `open_community_page` /
    `view_library_in_community`.
- **Remembering.** Figma keeps `{mainComponentGUID, instanceGUIDs}`. For a main from another library it uses the
  main's `publishID`.
- **The bell.** While the selection is that main, or a node inside it, a **visual bell** shows with the icon
  RETURN_TO_INSTANCE and a button **"Return to instance"** (`design_systems.actions.return_to_instance`).
  - When the selection leaves the main, the bell is cleared and the memory is kept for **120 000 ms (2 min)**. If you
    come back within that time, the bell shows again.
  - Dismissing the bell forgets the memory.
- **Keyboard.** While the bell is up, **⌃⌥⌘K / Ctrl+Alt+Shift+K** (the Go to main component shortcut) returns to the
  instance.
- **Variants.** There is also `design_systems.actions.return_to_variant`, which returns to a variant.

### 6.5 Missing main, missing variant, restore

- **A soft-deleted local main.** The instance panel shows only a full-width **Restore component** button
  (`instance_panel.restore_component`). It is shown when the restore type is STATE_GROUP or SYMBOL_AS_NON_STATE and
  runs `restore-symbol-or-state-group` (`figma_app @3756256`).
- **A deleted variant** (DELETED_LOCAL_STATE / DELETED_SUBSCRIBED_STATE):
  - a panel titled `missing_variant_title`;
  - the body `the_selected_variant_is_missing_in_the_component`;
  - a secondary full-width button **Reset to default** (`reset_to_default`). It re-inserts the set's default state
    (for a library set, the subscribed set's `default_state_key`) as the step `reset-variant`, logged "Reset Variant
    Button".

  CONFIRMED.
- **Restore component modal** (`3187 @1200546`). It opens when you edit a deleted main.
  - Title `restore_component_modal.restore_component`.
  - If the main was moved: "this_component_was_moved {otherFile}" (otherFile = the file name in bold, or
    `another_file`), then `accept_component_updates` and `restoring_will_allow`.
  - Otherwise: `restore_the_main_component_to_continue_making_edits_to_it`.
  - Buttons: Cancel and Restore. Restore runs the step `restore-component`.
- **Visual bells** `main_component_deleted` and `main_component_moved`; syncing messages
  `unsaved_changes.syncing.the_main_component_has_been_deleted` / `…moved_to_moved_to_file`.
- **Wasm:** "Invalid canvas provided when restoring soft deleted component"; `create-and-register-soft-deleted-symbol-or-state-group`.

### 6.6 Library updates on an instance

An instance whose library main has a newer version shows an **"Update available"** dropdown button in the selection
toolbar (`instance_panel.update_available`). Its items are `update_selected` / `update_object_selected` and
`review_update` (`figma_app @3749137–3751700`). Updating one asset uses `update-shared-symbol` /
`update-shared-state-group`. Rule details are in REA §2.15 and chapter 12.

## 7. Swapping instances

### 7.1 The instance swap picker (CONFIRMED, `figma_app @3759700–3770500`)

- **Kinds** (`H.Zl`): INSTANCE_SWAP_PICKER (the header's "Swap instance", live) and PREFERRED_VALUES_PICKER (the
  preferred-values editor). A RESOURCE_INSERT_MODAL variant serves the insert modal.
- **Sections** (`H.iN`):
  - PREFERRED → `instance_swap_picker.preferred`;
  - RECENT → `recently_used`, or `all_libraries` while searching (or `universal_insert.recents` in the insert modal);
  - FILE (one library) → `created_in_this_file` for the open file, otherwise the library's name.
- **Starting section.**
  1. **Preferred**, when the property has preferred values.
  2. Otherwise **the library of the component behind the current selection**, when it has items and either the picker
     is a swap or preferred picker, or that library is not the open file.
  3. Otherwise **Recently used**.

  Live: a local instance opens on "Created in this file".
- **The "component removed" banner.** In a swap picker with no current component and no query typed yet, while
  instances are selected, a banner shows `component_removed_title`, or `component_removed_from_file_title` when the
  component was removed from the file, with `component_removed_body`.
- **Filtering.** A FILE section shows only that library's items: local items for the open file, published items for
  another library. Preferred shows only the preferred node ids. Recent shows everything.
- **Search.** The asset search runs with `preferLocal: true`, scoped to LOCAL, FILE or ALL to match the section. Results
  of type MODULE are dropped, and results are de-duplicated by name. Placeholders: `search_preferred`, `search`, and
  `search_all_libraries`.
- **Footer and settings.** `browse_libraries` opens the Libraries modal (entry point INSTANCE_SWAP_BROWSE_LIBRARIES_LINK).
  Settings has `show_as_grid` / `show_as_list` and `show_subfolders`. The layout is persisted per picker kind
  (`FULLSCREEN_SET_INSTANCE_SWAP_PICKER_LIST_LAYOUT`, `…PREFERRED_VALUES_PICKER_LIST_LAYOUT`, `figma_app @1150729`).
- **Preferred values picker.** Shift-click selects a range of leaves (the toggle source SHIFT_RANGE_SELECT), and
  `select_all_instances` selects all.
- **Live size** (from R4 and the repo's measurement): 240×441, header "Swap instance" / "Choose instance".
- **Analytics.** "Component Insert Panel Insert Instance" `{type, fromSearch, altKey, viewMode, dropdownType}`.
  `altKey` is the ⌥ modifier at insert, which swaps instead of inserting (INFERRED from the field and from help).

### 7.2 Other swap paths

- **Context menu variant swap:** §4.3.
- **⌥-drag from Assets onto an instance:** C++ `swapInstanceForDrop`, state `SWAPPING_FROM_LIBRARY_DRAG_AND_DROP`
  (wasm str). Help: only text overrides are kept (R4 §3).
- **Plugin `mainComponent =`** uses `replace-symbol-backing-instances`, a different step from `swap-instance` (REA O9).
- **Override transfer** (single-text rule, hoisting through inner swaps):
  - wasm: "Hoisting overrides on inner swap", "Remapping overrides through (un)transferred inner swap";
  - the two "Single text rule did not apply…" messages;
  - REA §2.11–2.12 has the details.

## 8. The Assets panel (left rail › Assets)

### 8.1 Structure (live and `1630`)

- **Header:** "Assets", the Libraries button, Search (`Search all libraries` / `Search in this library`), and
  "Libraries and settings".
- **Library list:** "All libraries"; each library card shows the name and `num_components {numComponents}` (live: "6
  components"); then "Add more libraries".
- **Inside a library:** a breadcrumb (Back, "Created in this file" / "/" / page), then pages and frames as folders,
  then component tiles.
- **Settings dropdown** (`1630 @102779`):
  - Libraries: All libraries, Recents (when enabled), the open file, enabled libraries with an "approved" badge, and
    presets;
  - `toggle_view` › Grid / List;
  - `view_toggle_show_folders` (a checkbox).
- **Empty and upsell states:** `empty_state_title_ui3` / `_subtitle_ui3` / `_cta_ui3`, `library_upsell_*`,
  `publish_library`.

### 8.2 Tile layout (CONFIRMED, `figma_app @3382593`, `3653 @289901`, `@674415`)

**Choosing the layout from the items' sizes** (`PI`):

- WIDE, when every item is at least 3× wider than tall.
- Else SMALL, when every item is ≤ 64 px in both directions. The Assets panel's component grid calls this with SMALL
  disabled, so it falls to NORMAL.
- Else NORMAL. An item with no size forces NORMAL.

**Grid math.** The space is the sidebar width − 32 (2 × 16 gutters), and the gap is 16.

- columns = clamp(⌊(space + 16) / (minSize + 16)⌋, min, max)
- tile width = ⌊(space − (columns − 1)·16) / columns⌋
- tile height = min(maxHeight, ⌊width / aspect⌋)

| Layout | min columns | max columns | aspect (w/h) | max height / min size | At the default 240 px panel |
|---|---|---|---|---|---|
| NORMAL | 2 | 3 | 1 | 115 | 2 columns, **96 × 96** |
| SMALL | 3 | 5 | 1 | 72 | 3 columns, 58 × 58 |
| WIDE | 1 | 1 | 3.25 | none (min size = space) | 1 column, 208 × 64 |
| Examples / templates | 1 | — | 1.5 | 200 (min 200) | 1 column, 208 × 138 |
| Sites blocks | 1–2 | 2 | best aspect ≥ 0.7 (0.85 when all full-page) | — (min 144) | — |
| **List view** | 1 | 1 | — | — | **40 × 40** thumb |

With a wider panel the NORMAL grid reaches 3 columns at a sidebar of 32 + 3·115 + 2·16 = **409 px**.

The library browser grids (Libraries modal) use fixed sizes instead: SMALL thumbs of 60, wide columns of 60, NORMAL
⌊width / 100⌋ columns. WIDE uses 1, 2 or 3 columns at container widths of ≤ 60, ≤ 450 and above. The gaps there are 8,
or 4 for the THIN_2/3_COL layouts.

### 8.3 Search (CONFIRMED with the noted caveat)

- **The worker.** Library search runs in `library_search_worker` (Fuse.js). It answers INIT, SEARCH and ADD messages;
  without a worker it runs on the main thread. Queries are trimmed.
- **Asset search options** (`1630 @75665`):
  - keys `name` (weight 0.6), `containingFrame.name` (0.1), `containingFrame.pageName` (0.1), `description` (0.05);
  - **threshold 0.3**, `tokenize: true`, sorted by score.

  INFERRED: this is the in-file / subscribed asset search. Server search ("search all libraries") adds more results.
- **Results.**
  - Under the matches: `more_results_in_all_libraries {results}` as a blue link, or `showing_results_from_all_libraries`
    when expanded. The row is 40 px high (`nY`). A spinner shows while more results load.
  - No results: `no_results_for_query` / `no_results_for_query_in_library`.
  - The search field's hint: "Search keywords and filter results by specific libraries, templates, and components." (a
    hard-coded English string, `1630 @76755`).
- **Visual search** (`visual_search.*`): Select layer, or drag or upload an image. It searches by image.

### 8.4 Tiles, the details flyout and the context menu

- **Tile hints (live):** "Press Enter or Space to insert. Press Command+Enter to view details."
  (`asset_tile_sr_hint_mac`; a non-mac variant exists). A set's tile shows "Includes N variants" with the count
  (`variant_count`; live "3").
- **Component details flyout** (`ComponentFlyoutModal`, `1630 @12393`):
  - an update banner (`update_banner`, dismissable);
  - the name (14 px, ellipsis, with a tooltip when truncated);
  - `variant_count {numVariants}` when > 1;
  - the description (rich or plain), collapsed after **6 lines** with Show more / Show less;
  - `updated_at {updatedAt}` with the avatar and handle;
  - a playground of properties and variable modes (`playground.*`: change background, reset properties,
    unable-to-load states);
  - the **Insert instance** button (`insert_instance`).

  Clicks marked `data-does-not-dismiss-component-flyout` keep it open.
- **Context menu of a tile** (`3187 @4858700`):
  - for a local component: "Hide when publishing" (the publishable toggle);
  - **Go to main component** (`go_to_main`). A local main jumps on the canvas (the page is switched if needed). A team
    library main opens its link in a new tab;
  - **View details** (`view_details`), which opens the flyout and is disabled while it is already open.

  Default-published (preset) libraries have no menu.

### 8.5 Inserting an instance (CONFIRMED, `figma_app @1177786`, `@2473600`)

- **Click or Enter.** The instance is inserted at the **centre of the viewport**: the drop position defaults to
  (width / 2, height / 2) converted to canvas space. The instance is selected (`selectAfterInsert` defaults to true),
  the step is committed, and the tool returns to Move (`set-tool-default`).
- **Drag.**
  - The ghost follows the pointer, anchored at the grabbed percentage of the thumb.
  - A list-row drag is capped at **100 × 100**.
  - When the component is larger than the view, entering the canvas zooms out to
    `min(viewW / w × 0.5, viewH / h × 0.5)` (only when that is smaller than the current zoom). The grab point then
    resets to the centre (0.5, 0.5).
  - The drop sets `percentOffset` so the component lands where it was dropped. `ignoreAutoLayout` exists for a drop
    that must not join an auto-layout parent.
- **After insert.**
  - Every insert is added to the user's recents (`storeInRecentsKey`).
  - A set inserts its **default variant**: the local default state, or the library's `default_state_key`.
  - An onboarding tip may show, with its kind chosen by whether the component is from a library and has properties.
- **⇧I** opens the quick insert modal (`component-insert`) with the same picker in RESOURCE_INSERT_MODAL mode.

## 9. Slots, interactive components, libraries (pointers)

- **Slots.** R4 §6 and §15, and REA §2.18, give the behaviour. The build adds these keys:
  - `slot_restrictions.{banner_below_min, banner_above_max, banner_non_preferred, banner_*_and_non_preferred,
    pill_label, popover_title, popover_issue_count, row_min, row_max, row_preferred_only, min_exceeds_max_error,
    no_limit, slot_layer_count, non_preferred_layer_count, view_layers}`;
  - `slot_fill_config.{counter_axis_label, disabled_tooltip, info_tooltip}`.

  Live tooltips: "Slot must have auto layout", which disables the counter-axis fill option, and "If a slot follows a
  horizontal flow (x-axis), items will stretch along its height (y-axis)." The wasm message "Can only return slot
  counts for symbols or state groups" goes with them. Undo step: `edit-prop-def-slot-prop-config`.
- **Interactive components** (variant-to-variant "Change to" interactions) are in chapter 13. Reset kinds 12
  (interactions) and 13 (overlay) above cover their overrides.
- **Publishing.** Hide when publishing, the `.` / `_` prefixes (`hiddenFromPublishing`, wasm), keys and versions are
  in chapter 12 and REA §2.15. Wasm: "Shared symbol should have explicit override keys. Publish not blocked."

## 10. Visual bells and toasts (component area, wasm keys)

- **Creating and structure:** `cannot_create_symbol_from_non_matching_selection`,
  `please_remove_component_symbol_name_from_this_selection`, `components_can_t_contain_instances_of_themselves`,
  `some_components_were_reparented_to_avoid_a_dependency_cycle`, `can_t_create_nodes_focused_on_instance`,
  `no_components_are_selected`, `select_single_state_group`, `no_matching_layers_component_set` (Select matching
  layers inside a set).
- **Instances:** `parent_num_instances_detached`, `repaired_instance_overrides`, `styles_detached`.
- **Main component:** `main_component_deleted`, `main_component_moved`.
- **Repair and debug:** `component_prop_refs_have_been_pruned`, `no_component_prop_refs_to_prune`,
  `component_props_have_been_regenerated`, `component_props_in_selection_have_been_cleared`, `property_defaults_updated`,
  `mapped_state_groups`, `updated_num_state_groups_repaired_state_group_s`, `relinked_duplicate_subscribed_assets`,
  `repair_keyless_state_groups_*` (JS), `symbol_observer_is_not_running`.
- **Publishing:** `components_are_either_private_or_already_published`.
- **Other:** `copied_properties`, `copy_link_to_instance` (JS), `component_panel.changes_pushed_to_main_component` (the
  Push confirmation, JS), the Return to instance bell (§6.4).

## 11. UI strings

English is given where attested: **live** = `docs/research/figma/live/`, **R4** = help text quoted there, **repo** =
an existing `src/shared/i18n` entry. Otherwise only the key is shown.

**Actions and menus**

- Create component ⌥⌘K (live)
- Create multiple components (R4)
- `create-multiple-symbols-and-state-group` (key only)
- Combine as variants (live / R4)
- Add variant (live)
- Detach instance ⌥⌘B (live)
- Go to main component ⌃⌥⌘K (live)
- Reset instance (live)
- Reset name (live)
- Reset all changes (R4)
- `fullscreen.properties_panel.layer_header.reset_specific_changes`
- `instance_panel.reset_{size, exports, effects, others, visibility, name, fill, stroke, text, text_style,
  interactions, overlay}`
- `reset_property_assignment_v2 {assignmentName}`
- Push changes to main component (R4)
- Restore component (R4)
- `instance_panel.restore_variant`
- Main component ▸ (live, context menu)
- Select matching layers (live)
- Multi-edit variants (live)
- Component configuration (live)
- More actions (live)
- Convert to slot ⌘⇧S (R4)
- Wrap in new slot (R4)
- Reset slot (R4)
- Delete contents (R4)
- Return to instance (repo; key `design_systems.actions.return_to_instance`)
- `design_systems.actions.return_to_variant`

**Properties**

- Properties (live)
- Create property (live)
- Variant / Text / Boolean / Instance swap / Slot (live)
- Expose properties from › Nested instances (live)
- True / False (live)
- `component_properties.{apply_component_property, create_component_property_of_type} {propType}`
- `boolean_property_default_name {selectedNodeName}` / `_fallback`
- `instance_swap_property_default_name`, `number_property_default_name`, `slot_property_default_name`,
  `variant_property_default_name`
- `error_conflicting_name`, `error_unused_property`, `has_unpublished_preferred_values`
- `cant_show_values`, `try_again`, `trying`
- `show_more_property_rows {count}`, `show_more_nested_instances_rows`
- `slots_disable_prop_binding_tooltip`
- `preferred_instances`, `select_preferred_values`
- `choose_default_instance_value(_cycle)`
- Description / "How to use this component" / Link to documentation (live)
- `component_panel.view_in_display_name {displayName}` / `view_documentation`

**Variants**

- Current variant (live)
- Select component (live)
- Rename… (live)
- `states_panel.default_property_value`
- The §4.2 error keys
- `states_panel.components` ("Components" section)

**Instance panel**

- Swap instance (live)
- Choose instance (live)
- Search in this library (live)
- Created in this file (live)
- `instance_swap_picker.{preferred, recently_used, all_libraries, browse_libraries, search, search_preferred,
  search_all_libraries, show_as_grid, show_as_list, show_subfolders, no_components, no_results,
  component_removed_title, component_removed_from_file_title, component_removed_body, select_all_instances}`
- `instance_panel.{update_available, update_selected, update_object_selected, review_update,
  missing_variant_title, the_selected_variant_is_missing_in_the_component, reset_to_default, go_to_main_component,
  go_to_main_component_nin_library, from_this_file}`

**Restore modal**

- `restore_component_modal.{restore_component, this_component_was_moved {otherFile}, another_file,
  accept_component_updates, restoring_will_allow, restore_the_main_component_to_continue_making_edits_to_it, cancel,
  restore}`

**Assets**

- Assets (live)
- All libraries (live)
- Created in this file (live)
- "N components" (live)
- Add more libraries (live)
- Search all libraries (live)
- Libraries and settings (live)
- Back (live)
- "Press Enter or Space to insert. Press Command+Enter to view details." (live)
- "Includes N variants" (live)
- `assets_panel.{insert_instance, view_details, go_to_main, variant_count, updated_at, show_more, show_less,
  more_results_in_all_libraries, showing_results_from_all_libraries, no_results_for_query(_in_library), toggle_view,
  view_toggle_grid, view_toggle_list, view_toggle_show_folders, update_banner, hidden}`
- "Search keywords and filter results by specific libraries, templates, and components." (hard-coded English in
  1630)

## 12. DesignerV2 today

| Area | Status | Where |
|---|---|---|
| Action set and shortcuts (⌥⌘K, ⌥⌘B, ⌃⌥⌘K, ⌘⇧S) | matches | `src/renderer/src/editor/commands.ts` |
| **Return to instance**: Figma uses a visual bell, the ⌃⌥⌘K shortcut to return, a 2 min memory, and reappears when you re-enter the main | differs: a pill with Dismiss, no shortcut, no memory | `canvas/ReturnToInstance.tsx`, `commands.ts:620` |
| **"Reset specific changes"**: Figma's 12 kinds in its order, then one "Reset {property}" per assignment | differs (Wecra's own groups) | `model/components.ts RESET_GROUPS` (REA task 4) |
| Closest variant on a property change | matches in effect: Wecra maximises equal values, Figma minimises differing ones | `model/components.ts:234 variantFor` |
| Variant toggle pairs (yes/no, true/false, on/off) | matches | `model/components.ts:664 variantToggle` |
| Rename property cleaning (strip `,` `=`, trim, ignore empty) | partly (REA task 7: no '=' / ',' check) | `components.ts:945` |
| Delete last property → "Property 1=Default" | matches (engine writes it) | `ComponentCommands.cpp:997, :1877` |
| Variant errors: 4 kinds and the 1000-variant warning | partial: one "conflicting" warning, no missing-properties / parse split, no 1000 limit | `panels/design/Component.tsx:595` |
| NUMBER property (2-decimal rule, binds to text) and IMAGE | missing | REA task 15 |
| Property defaults per type (BOOL true, TEXT "", NUMBER "0") | matches for the five built types | — |
| Properties panel overflow (5 → 4 + "Show N more") | missing (no "Show N more" in the properties section) | `panels/design/Component.tsx` |
| Apply-property button rule (no Boolean on the main itself, none on instance sublayers) | partial | `ComponentCommands.cpp:1756` |
| Restore component modal (moved vs deleted texts) | partial: Restore exists, no moved-to-file variant | `components.ts`, `commands.ts:614` |
| Missing variant panel + Reset to default | missing ("Reset to default" exists only for other uses) | — |
| Swap picker: sections Preferred / Recently used / library, starting-section rule, removed banner, per-kind list layout | partial: Preferred first and library browse; **no Recently used**, no removed banner | `panels/design/ComponentPicker.tsx` |
| Assets tile layout: NORMAL 96 × 96 at 240 px | matches at 240 px; fixed `TILE`, no WIDE / SMALL layouts, no 2–3 column growth with panel width | `panels/Assets.tsx:33` |
| Assets search | differs: substring AND over name/page/frame/description, no fuzzy score or weights | `model/components.ts:590 searchAssets` |
| Details flyout (⌘Enter, description 6 lines, variant count, Insert instance, playground) | missing (the hint is read out, "view details half isn't built") | `panels/Assets.tsx:181` |
| Tile context menu: Hide when publishing / Go to main / View details | partial (Hide when publishing, Go to main) | `panels/Assets.tsx` |
| Insert at viewport centre; drag inserts at the drop point | matches | `components.ts:1170` |
| Drag-in zoom-to-fit (×0.5) for large components | missing | — |
| Recents of inserted components | missing | — |
| Documentation link display names (GitHub / Figma / Zeplin / Jira / Asana) | missing | devmode inspect |
| Visual bells (§10) | partial (cycle and self-instance messages exist) | — |

### As built (2026-10-18, wave 2)

Branch "components" (atlas integration wave 2). Built in the list's order:

- **Return to instance** as Figma's visual bell (§6.4): the pill is gone; Go to main component remembers
  `{main, instances}` (every selected instance sharing one main — the engine's `GO_TO_MAIN_COMPONENT {ref: Guid[]}`
  and its enable rule now take several, layers inside instances counting as their instance; `RETURN_TO_INSTANCE`
  selects them all and zooms to them). A toast with the instance icon and "Return to instance" stays up while exactly
  one node is selected and it is the main or inside it; ⌃⌥⌘K or ⌃⌥⇧K returns while it is up (a capture listener, as
  Figma's); leaving the main takes it down and keeps the memory 120 000 ms, coming back shows it again; its × forgets.
  `editor/components.ts watchReturnToInstance`; the DS toast gained `icon` and `onDismiss` (a small hook in
  `ds/components/Toast.tsx`, with `currentToast()` for tests).
- **Reset kinds**: batch B's kinds were already Figma's order. "Reset ▸" now lists only Figma's twelve, then one
  **"Reset {property}"** per changed property value with the type's glyph (engine `RESET_OVERRIDES {kind:
  PROPERTY_ASSIGNMENTS, prop}` drops only that assignment, at the instance's own level). The nested swap and Variable
  modes left the submenu; "Reset variable modes" is its own command (`object.reset-variable-modes`).
- **Assets**: Figma's tile layouts and grid math (`model/components.ts tileLayoutOf / tileGrid`: WIDE when every item
  is 3× wider than tall, NORMAL otherwise — SMALL off as in Figma's Assets grid; columns from the panel's width, so
  three 115 tiles from 409 px); the list view's 40 × 40 thumbnails; Figma's search — **Fuse.js 3.6.1** (added as a
  dev dependency; the version Figma's worker bundles) with its keys and weights (name 0.6, frame 0.1, page 0.1,
  description 0.05), threshold 0.3, `tokenize`, best first — results listed in score order, not regrouped; the
  **details flyout** (⌘Enter / Ctrl+Enter on a tile, and "View details" in the tile menu, now on library tiles too):
  the name, "N variants", the description folded after six lines with Show more / Show less, Insert instance; inserts
  join the file's recents; a drag of a component larger than the view zooms out to min(view / size) × 0.5 on
  entering the canvas.
- **Variant errors**: the engine reads every variant's values from its name (`Editor::variantErrors`) — PARSE,
  DUPLICATE_STATE, MISSING_PROPERTIES, and TOO_MANY_STATES past 1000 variants when none has one; componentInfo gives
  `variantError` and `errorVariants` (replacing batch B's `variantConflict` / `conflictingVariants`). The Design panel
  shows Figma's set-level text with "Select invalid variants" / "Select conflicting variants", or the selected
  variants' text counted by how many are selected; an invalid name shows the format in bold.
- **NUMBER properties**: schema `ComponentPropType.NUMBER = 5` (Figma's number; `schemagen --check` 0 problems), the
  value in `ComponentPropValue.floatValue` 4 (now modelled in C++ and in both codecs, and read from a `varValue`
  FLOAT); Figma's value rule (sign, digits, optional decimals or ".5"; not blank; 2 decimals) and its display (no
  trailing zeros, NaN → 0) in `propNumber` / `formatPropNumber` and their TS twins; it binds `TEXT_DATA`, so a bound
  text layer shows the number; default 0, base name "Number"; its default takes a FLOAT variable. The panel has its row
  (a number field), its summary and its settings; the plugin API's `addComponentProperty(…, "NUMBER", …)` works. As in
  Figma's build, **Create property doesn't offer it** (§5.1).
- **Swap picker**: Figma's sections in the library field — Preferred (when the property has preferred values),
  Recently used, Created in this file — opening on Preferred, else the library when it has components, else Recently
  used; the search runs in the section's scope with Figma's placeholders and one result per name. Recently used is
  the file's recents (`editor/recentComponents.ts`, localStorage, 20 kept — Figma's count is unverified). The slot
  picker's own Preferred / All filter went (the sections replace it).
- **Also**: the instance panel's rows fold as Figma's — more than five show four and "Show N more" (the property
  rows and the nested instances); a deleted main's instance shows only a full-width **Restore component**, and an
  instance of a deleted variant of a set that is still there shows Figma's **missing variant** panel with **Reset to
  default** (the set's default variant; componentInfo `main.missingVariantSet`).

Checks: `engine:test` 775 / 775 (five new cases in `components.test.cpp`), wasm rebuilt; typecheck and eslint clean;
vitest on `editor/`, `ds/`, `shared/i18n`.

**English not attested** (written from the keys, to check in the live app): the variant error texts and links, "Show
{n} more", "Missing variant" / "The selected variant is missing in the component", "Search preferred", the non-mac
tile hint. **Not done:** the removed-component banner in the swap picker (its English is unattested); library sections
in the swap picker (it lists this file's components only); the flyout's playground, update banner and author line;
documentation link display names (Dev Mode's area); the Restore modal's moved-to-file text; Apply-property button
rules; IMAGE properties (O10); the NUMBER property's place in the UI (open question 6).

## 13. Open questions

1. **Combine as variants layout.** The set's padding, gap, stroke (dashed purple width and dash) and corner radius,
   and how the variants are arranged. Probe: in the live app, combine 3 rectangles-as-components and read the set with
   the Plugin API (`paddingLeft`, `itemSpacing`, `strokes`, `dashPattern`, `cornerRadius`, child x / y).
2. **Add variant placement.** Is the new variant placed to the right of or below the last one, with what gap, and does
   the set grow to fit? Probe: click "+" under a 1-row and a 2-row set and read the positions.
3. **Contents of the "Main component ▸" context submenu.** It is built in C++. Probe: open it on a main in the live app
   and dump the menu.
4. **English text of the default property names** (`*_property_default_name`, `default_property_value`). Probe: create
   one property of each type in the live app and read the names.
5. **Whether the Assets panel search uses the Fuse settings in §8.3 in Design** or only for Sites (`nU` is near Sites
   code). Probe: search "btn" against "Button" with a description-only hit and look at the order.
6. **NUMBER and IMAGE availability.** Is there a flag, and an entry point other than the Text field's "Apply
   property"? Probe: select a text layer in a main and open the property button's menu.
7. **The ⌥-drag swap rule** (only text overrides kept) as implemented in `swapInstanceForDrop`. Probe: ⌥-drag a
   component onto an instance with fill and text overrides.
8. **`toggle-publish` (⌥2) and `toggle-library` (⌥3) labels.** Probe: press each key in the live app.
