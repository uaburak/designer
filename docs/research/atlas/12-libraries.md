# 12 — Libraries: publish, enable, update, swap, analytics

Figma Design desktop 126.9.13, read on 2026-10-16 from the cached editor build (`~/.cache/figma-rea/figma/`, outside
the repo), following `~/.cache/figma-rea/BRIEF.md`. Figma's code is not copied here. This file records behaviour,
numbers, enums, data shapes and i18n keys, each with its evidence. **CONFIRMED** means read directly in the build.
**INFERRED** means deduced from what was read.

## 1. Scope and sources

**Scope.** This chapter covers the whole library cycle:

- publishing: the publish modal, change detection, descriptions, hidden assets, errors, limits and version keys;
- enabling libraries in a file, and team, org, workspace and drafts defaults;
- the Libraries modal: tabs, search, sizes and counts;
- the update flow: notification, the Updates tab, per-asset and "Update all", and the review modal with before/after;
- what an update does to instances;
- Swap library and missing libraries;
- library analytics;
- how library assets are keyed;
- copying and moving assets between files;
- the Assets panel library sections, linked to chapter 10;
- every message and error found.

**Prior work. It is summarised here and not repeated.**

- `docs/research/figma/R5-libraries.md` (help site) covers:
  - publishable kinds and plan gating ("Drafts cannot publish");
  - the publish modal summary, the per-publish description and per-asset deselect;
  - the Libraries modal and Recommended tab, removing a library;
  - the blue update dot, Update selected / Update all, side-by-side and overlay compare;
  - restoring a deleted main;
  - "Move to this file" vs "Publish as a copy" (help 4404848314647).

  All of it is confirmed or refined below.
- `docs/research/figma/R22-library-analytics.md` (help site and REST) covers:
  - analytics access and modal structure;
  - the Overview and Analytics tabs, the Type and Duration filters;
  - the insertions graph legend, Compare with, Top teams, CSV and tables;
  - usage views, approved libraries and default modes.

  §8 below corrects two of its "unverified" points: the Top teams count and the CSV rule.
- `docs/research/rea/components.md`:
  - §2.3 asset keys: `componentKey` 216 / `sharedSymbolVersion` 126 vs `key` 319 / `version` 171;
  - §2.15 the update rule (hash **and** userFacingVersion 399), per-component canvas blob transport;
  - §2.16 partial sets on paste (581).

  §9 below adds the multi-version case and the moved-item fake versions.
- `docs/research/atlas/10-components.md`:
  - §6.6 the "Update available" instance dropdown;
  - §7 the swap picker;
  - the Assets panel (header, cards, breadcrumbs, tile sizes, the Fuse.js search worker).

  This chapter does not repeat the Assets panel; see §12.
- `docs/research/atlas/11-variables-styles.md`:
  - mode limits per plan (1 / 10 / 20 / 40), 5,000 variables per collection;
  - hiding variables from publishing.

**Build sources read.** The minified chunks were reprinted with esbuild into the scratchpad to read them. "fmt L" below
is a line in that reprint (`esbuild <chunk>.min.js`, default options). Quoted snippets can be found in the minified file
with `rg`.

| Source | What it gave |
|---|---|
| `figma_app.min.js` module 57205 (fmt L20469–20660) | The publish pipeline: START_PUBLISH, savepoint, ordered updates, presigned params upload, `POST /api/publish`, progress, timing logs |
| `figma_app.min.js` module 620674 (fmt L51748) | Asset record schemas (component, state group, style), duration enum, Libraries modal tab enum, publish status helpers |
| `2108.min.js` module 186023 (fmt L21957) | `getPendingLibraryUpdates`: what goes into publish vs unpublish |
| `2108.min.js` module 630276 | Update detection selectors (versions, moved items, current page vs all pages) |
| `4752` / `5519.min.js` (enum literals) | Status `NEW / CURRENT / CHANGED / DELETED / NOT_STAGED`; publish progress `NONE / ASSEMBLING_COMPONENTS / UPLOADING`; mode `LIBRARY / HUBFILE` |
| `7621.min.js` module 589642 (fmt L4100–4460) | The Publishing modal UI: sections, row heights, Shift-range select, ⌘/Ctrl+Enter, upsell, empty search |
| `3187.min.js` fmt L12943–12995 | Publish toasts and errors (module 475331) |
| `3187.min.js` fmt L13045–13062 | Update progress toasts (module 585204) |
| `3187.min.js` fmt L74320–74335 | Hide/Show when publishing (`toggle-publishability`) |
| `3187.min.js` fmt L74950–75100 | Replace-libraries (Swap library) view, remove-library confirm, library file footer |
| `3187.min.js` fmt L75165–75182 | Libraries modal entry points and sizes |
| `3187.min.js` fmt L77290–77640 | Updates tab, checkpoints, tab strip, tab orders, search |
| `3187.min.js` fmt L78410–78690 | Publish footer, scope dropdown, item rows, invalid reasons |
| `3187.min.js` fmt L78980–79200 | Swap matching (module 339377 / 175076) and the Review updates modal (849630) |
| `3187.min.js` fmt L73100–73345 | Analytics transforms, graph geometry, top teams, CSV |
| `figma_app.min.js` module 289644 (fmt L63899) | update hooks, Update all order, notification delay |
| `figma_app.min.js` fmt L19383–19700 | `update-shared-symbol` / `update-shared-state-group`, batch size |
| `figma_app.min.js` module 229472 | String helpers: the swap name match |
| `2108.min.js` fmt L23655–23770 | `/api/dsa/*` analytics client |
| `2108.min.js` fmt L11495–11530 | Usage action recording |
| `2108.min.js` fmt L18505–18550 | Pasting from unadded libraries / unpublished variables |
| `fullscreen__fullscreen-wasm__compiled_wasm.wasm` (`strings -n 8`) | C++ file names, undo step names, denial reasons, limits |

## 2. Data model of a library asset

### 2.1 Asset kinds (CONFIRMED, figma_app 57205 switch on the asset type)

The publishable asset types are:

- `COMPONENT`, `STATE_GROUP` (component set), `STYLE`;
- `VARIABLE_SET` (collection), `VARIABLE`, `VARIABLE_OVERRIDE`;
- `MODULE` (templates / slides);
- `RESPONSIVE_SET` (Sites blocks);
- `CODE_LIBRARY`, `CODE_FILE`, `CODE_COMPONENT`;
- `KEYFRAME_TRACK`, `ANIMATION_PRESET`, `CONSTRAINED_TEMPLATE`, `MANAGED_STRING`, `CUSTOM_EFFECT`.

Only the first group matters for Figma Design. The publish log counts buffers per kind:
`numComponentBuffers`, `numStateGroupBuffers`, `numStyleBuffers`, `numVariableSetBuffers`, … each also with an
`Unpublished` suffix.

### 2.2 Records the client keeps (CONFIRMED, figma_app 620674 zod schemas)

| Record | Fields |
|---|---|
| any library item | `type, node_id, name, library_key, isLocal?, thumbnail_url?, id?, unpublished_at?, checkpoint_id?, canvas_url?, updated_at?, description?, description_rt?, meta.style_thumbnail?, team_id?, hub_file_id?` (+ search scores) |
| COMPONENT | `containing_frame?, publishing_client_version?, component_key?, min_node_width?, min_node_height?, content_hash?, userFacingVersion, destination_key?, sort_position?, has_video?, is_template?` |
| STATE_GROUP | `containing_frame, fill_color?, default_state_key, destination_key?, version, userFacingVersion, is_template?`; the published form adds `key, min_node_width, min_node_height` |
| STYLE | `key, style_type, sort_position?, is_soft_deleted?, content_hash?, userFacingVersion, destination_key?` |
| variable override | `name, codeSyntax, node_id, version, userFacingVersion, variableSetId, overriddenVariableID, rootVariableKey, overrideValues`; local or subscribed, never publishable |

**Key and version per kind.** A component is keyed by `component_key` and versioned by `content_hash`. A state
group or style is keyed by `key` and versioned by `version` (state group) or `content_hash` (style). A variable set or
variable is keyed by `key` and versioned by `version`. Every kind also carries **`userFacingVersion`** (UFV).
`destination_key` is the key an asset was moved to (§10.3).

**Subscription status** of an asset (CONFIRMED): `LOCAL`, `SUBSCRIBED_WITH_LIBRARY`, `SUBSCRIBED_WITHOUT_LIBRARY`.
"Without library" means the library is not enabled in the file, for example after a paste.

**Publish status of a local asset** (`E8`, CONFIRMED):

| Status | Meaning | Publish modal label key |
|---|---|---|
| `NEW` | never published | `publishing_modal.added` |
| `CHANGED` | differs from the last publish | `publishing_modal.modified` |
| `CURRENT` | same as published | `publishing_modal.no_changes` |
| `DELETED` | published, now gone | `publishing_modal.removed` |
| `NOT_STAGED` | private or never staged | (empty) |

**Is a file a library?** It is when `library_publish_status === "published"` and at least one of these counts is
above 0: `num_components`, `num_styles`, `num_variable_collections`, `num_variables`, `num_module_assets`,
`num_library_assets` (CONFIRMED, 620674 `z()/K()`).

### 2.3 Keys in the document (summary, links)

- A SYMBOL stores its key in `componentKey` 216 and its version in `sharedSymbolVersion` 126. Other kinds use `key`
  319 / `version` 171. The reader resolves `key ?? componentKey`. Both keys are 40-hex strings. See REA
  components §2.3.
- A library copy also has `publishID` 215 (the guid in the library) and `sourceLibraryKey` 395. A pasted or moved
  copy has `libraryMoveInfo` 256 / `libraryMoveHistory`. Wasm strings: `publishID`, `sourceLibraryKey`,
  `library-move-info`, `library-move-history`, `keyForPublish`, `publishedVersion`.
- A local asset's `publishedVersion` 218 is its hash at the last publish. The wasm step
  "Resetting publish version for component %s" resets it, and `clearPublishedVersion` refuses non-symbol and
  non-state-group nodes.
- The wasm asserts "Main component referenced by publish ID does not have expected component key!" and "Main
  component referenced by publish ID is not symbol type!". So a copy is resolved by `publishID` first, then checked
  against its key (CONFIRMED, strings).
- Other key families: `LibraryKey(%s)` and `[PlatformShapeLibraryRef assetType=%s assetKey=%s assetVersion=%s
  libraryKey=%s …]`. A **library key** is distinct from the file key, and every API takes `libraryKey`. A file
  becomes a library under its `library_key`.

## 3. Publishing

### 3.1 Opening the modal

- **Entry points** (`RR` enum, CONFIRMED 7621 module 695720):
  `asset_panel_library_context_menu`, `component_publish_error_notification`, `filename_view_dropdown`,
  `fullscreen_move_components_prompt`, `fullscreen_other`, `library_modal_overview`, `library_modal_file_view`,
  `library_modal_upsell_ui3`, `properties_panel`, `publish_upsell_modal`, `unpublished_preferred_values_warning`.
- **Opened with** `{initiallyCheckedItemIDs, timedOut}`. When `timedOut` is true, the modal shows the banner
  `publishing_modal.publishing_took_too_long`.
- **Gating** (CONFIRMED, module 332655):
  - A Starter team file gets the upsell: `upsell.move_file_publish.*` ("Move file to team/pro team/project to
    publish"), with the Cancel and Move actions.
  - A file in a branch shows `libraries_modal.you_can_t_publish_from_branches` and
    `merge_into_main_file_to_publish`.
  - The Publish button tooltip when publishing is disabled is `libraries_modal.publishing_disabled_tooltip`.

### 3.2 Layout (CONFIRMED, 7621 fmt L4399–4460, 3187 fmt L78410–78460)

**Modal**

- Width `lg`, `data-testid="publishing-modal"`.
- Title `publishing_modal.modal_header`, or `modal_header_community_library` in HUBFILE mode.
- While move validation loads, the body is a spinner under the same title.

**Body, top to bottom**

1. A search field (recordingKey `publishingModalSearchBar`, UI3 icon, small font, transparent background).
2. The **description** textarea (placeholder `publishing_modal.description_placeholder`, `dir=auto`). It is shown
   only while the search is empty. It is pre-filled from the last unsent description (`savedPublishDescription`,
   cleared after a successful publish by `SAVE_PUBLISH_DESCRIPTION("")`).
3. A virtualised list. The viewport is the container height − 200 px.
   - **Section headers are 32 px**: `invalid_components_with_count`, `changes_header_with_count`,
     `unchanged_header_with_count`, `hidden_header_with_count`.
   - **Rows are 46 px.**
   - The hidden section's sub-caption `these_wont_be_published` is **22 px**.
   - Group headers inside "Changes", in order: `variable_collections`, "Site blocks", "Code components" (both
     untranslated), `styles`, `components`, then `page_thumbnails` (flag `dse_library_pg_thumbnails`).
   - The empty search result is `empty_search_result {assetQuery}`.
4. Banners:
   - the plan upsell `standard_upsell {numComponents, teamUpsellLink}` / `starter_library_upsell`, with the links
     `upgrade_team` → `/files/upgrade-team/<id>` or `create_a_professional_team` → `/files/create-team`;
   - `move_components_warning` with the link `read_the_help_article` (help 4404848314647);
   - `publishing_took_too_long`;
   - `example_conversion_warning`;
   - the code-asset banners.
5. A variable-collection drill-down: a row's "See variables" (tooltip `see_variables`) replaces the list with the
   collection's variables. Rows carry `list_item_changed_variable_count`, `hidden_variable_count_*`.

**Footer**

- In an org: a **"Publish to" dropdown** (`publish_to_label`) with the options, in order:
  - ORG `everyone_at_org {orgName}`;
  - WORKSPACE `everyone_at_workspace {workspaceName}` (or `everyone_at_this_file_s_workspace`), only when the file
    has a workspace;
  - TEAM `everyone_at_team {teamName}` (or `org_access_false_without_team_access`).
- The default scope is ORG when the file is shared with the org, else TEAM. After the first publish it comes from the
  stored `libraryPublishScope.publishScopeType`. A mismatch is logged.
- While assembling, the dropdown is replaced by a progress ring (path fill `#4B4B4B`) and
  `assembling_components_styles_and_variables`.
- A warning banner (`warning-tertiary`, padding 8) appears when the scope widens the file's audience:
  `warning_banner.file_setting_change`, `…file_setting_change_workspace_audience`, `…with_hidden_team_name`, or
  `…hidden_team_name`, each with a bold `anyone_in_org_or_workspace {audienceName}`.
- The buttons are Cancel (`publishing_modal.cancel`) and Publish (`publish_button_text`).
- **Publish is disabled when** any of these holds:
  - there are no new items and 0 modified;
  - a publish is running;
  - nothing is checked;
  - the file is a branch;
  - denormalized publish info is still loading;
  - the checked set has an invalid reason.

### 3.3 Interaction (CONFIRMED, 7621 fmt L4300–4398)

- **Default checked set:** every modified, well-formed item, or the `initiallyCheckedItemIDs` that are in it. After
  the library state changes, the selection stays "all" if it was all. Otherwise it keeps only the still-present items.
- **Shift+click range:** with Shift held (tracked by keydown/keyup on the document), clicking a row sets every row
  between it and the last-clicked row to the clicked row's new state.
- **Header checkbox:** shows checked, unchecked or mixed. With a search active it toggles only the matching rows and
  keeps the others.
- **⌘+Enter (macOS) / Ctrl+Enter** publishes when the button is enabled.
- **Mode limit:** each checked collection's mode count is checked against the plan's `modeLimit` (hook
  `z("publishing")`). If over the limit, the mode upsell CTA opens (when available) and publishing stops. Otherwise it
  is logged as blocked.
- **Move options on a row:** a "Move to this file" / "Publish as a copy" menu
  (`move_to_this_file` / `publish_as_copy`). `MOVE` is disabled when the move is not valid.
  - `publishType ∈ {MOVE, USER_SELECTED_COPY, FORCED_COPY}`.
  - Tooltips: `publish_as_move_info_{component|style} {fileName}`, `publish_destination_as_copy_info`,
    `publish_source_{component|style}_as_copy_info` (fallback `filename_fallback`).
  - A moved style shows `moved_to_this_file` as plain text.
- **Before sending:** for moved items kept as copies, Figma calls `generatePublishableCopy(nodeId)` and swaps the
  checked id for the new copy.

### 3.4 Hidden assets (Hide when publishing, private names)

- **Menu toggle** (CONFIRMED, 3187 fmt L74320): `hide_when_publishing` / `show_when_publishing` in the Assets panel
  tile context menu. It flips `isPublishable` (state group) or `isSymbolPublishable` (loose component) as the undo
  step **`toggle-publishability`**.
- **Variables and collections:** `hiddenFromPublishing`, a Plugin API property (3187 fmt L51954) and a DTCG key
  `com.figma.hiddenFromPublishing`.
- **`_` / `.` prefix:** INFERRED. The rule is not in the JS. The JS only reads `isPublishable` /
  `isSymbolPublishable`, which the wasm computes (`is-publishable`, `is-symbol-publishable`, `isPublishable`). The
  help site and R3/R4 state that a leading `_` or `.` hides the asset.
- **The "Hidden" section** lists unpublishable items under `hidden_header_with_count`, collapsed by default. Each row
  has an `include_in_publish` checkbox.

### 3.5 Invalid assets (CONFIRMED, 3187 fmt L78640–78672)

| Source | Enum value | Key shown |
|---|---|---|
| state group | `MISSING_PROPERTIES_ERROR` | `missing_properties` |
| state group | `DUPLICATE_STATE_ERROR` | `conflicting_property_values` |
| state group | `PARSE_ERROR` | `corrupt_layer_names` |
| component / set props | `CONFLICTING_NAMES_ERROR`, `CONFLICTING_NAMES_WITH_VARIANT_ERROR` | `conflicting_property_names` |
| component / set props | `UNUSED_DEF_ERROR` | `unused_def_error` |
| variable set | `TOO_MANY_VARIABLES_ERROR` | `too_many_variables_error` (wasm: max **5000** variables per collection) |
| variable set | `TOO_MANY_MODES_ERROR` | `too_many_modes_error` |
| any | `INVALID_EXAMPLE` | `asset_cannot_be_published` |
| any | `DESCENDANT_CODE_INSTANCE_OR_CODE_LAYER` | `publishing_modal.tooltip.asset_cant_be_published_because_it_contains_code` |
| any | `DESCENDANT_CODE_EMBED` | `…_contains_code_embeds` |

- Erroneous items get their own collapsible section (`invalid_components_with_count`) and cannot be checked.
- A state group whose state is movable but the group is not shows the warning
  `unmovable_state_group_with_movable_state`.
- The wasm logs "Shared symbol should have explicit override keys. Publish not blocked."

### 3.6 Change detection: what is published (CONFIRMED, 2108 module 186023 `getPendingLibraryUpdates`)

**Inputs.** The local components, state groups, styles, variable sets, variables and other library assets, filtered
to the checked items. Components and state groups count only when the user may publish them: the team has pro
features, the file is an org draft, or this is a Community publish.

**Unpublish all** (Remove library). Every item that is not `NOT_STAGED` and not `NEW` goes to *unpublish*, except
variants, which leave with their set.

**Otherwise, in this order:**

1. **Library assets.**
   - `DELETED` → unpublish.
   - Publishable status (`NEW`/`CHANGED`) → publish.
2. **State groups.**
   - Not publishable status:
     - `DELETED` → unpublish the set and each staged variant that has a `component_key`.
   - Publishable status:
     - a set in error is skipped;
     - otherwise publish each variant, then the set.
3. **Loose components** (not in a set).
   - `NOT_STAGED` → skipped.
   - `DELETED` with a key → unpublish.
   - Otherwise → publish.
4. **Variable sets.**
   - `NOT_STAGED` → skipped.
   - `DELETED` with a key → unpublish.
   - Otherwise: each of its variables that is not `NOT_STAGED` or `CURRENT` (deleted with key → unpublish, else
     publish), then the set itself.
5. **Styles.** `DELETED` with a key → unpublish, else publish.
6. **Other assets** (templates, …): the same rule as 1.

**Already-current items.** An item that is `CURRENT` and has no move remapping is skipped. Its move info is cleared
(`clearLibraryMoveInfo`) unless `forcePublish` is set.

### 3.7 The publish pipeline (CONFIRMED, figma_app module 57205)

**Steps**

1. **Guards.**
   - A publish already in progress (state ≠ NONE) → no-op.
   - No file → `NoFile`.
   - An empty checked set → `NoItemsToPublish`.
   - Both end silently.
2. **Start.** `START_PUBLISH({unpublishAll})`. `has_published_library_items = true`. The timer `publish.start` starts.
3. **Prepare thumbnails.** Text styles get `prepNodeForAssetThumbnailRendering`. Then the client **yields 10 times**
   to the event loop.
4. **Create a savepoint** (a version-history entry). The title is `publish_actions.savepoint_for_publish`, or
   `…_unpublish`, or the `_slides` variants. The body is the **publish description**.
   - Fails offline → `Offline`.
   - Fails online → error "create_savepoint".
5. **Order the updates.** Variable sets (publish), variable sets (unpublish), variables (unpublish), state groups
   (publish, unpublish), loose components (publish, unpublish), styles (publish, unpublish), then modules, responsive
   sets and code components when enabled.
6. **Log.** The slot counts per component are logged.
7. **Build the params.** `{updates:[{publishType, assetType, guids}], moveRemappings, clientProtocolVersion,
   themeMetaData, s3ThumbnailBufferPaths:[], styleMetaByNodeId:{}}`. If every thumbnail failed: error.
8. **Upload the params.**
   - `POST /api/publish_params/upload` (presigned post) → upload the JSON.
   - A non-S3 response → `NonS3PresignedPost`, which shows the network-compatibility bell.
9. **Publish.** `POST /api/publish/<fileKey>` with `{fileKey, checkpointKey, paramsPath, publishToCommunity,
   publishScope}` → `library_publish_id`.
10. **Upload state.** `PUBLISH_PROGRESS{state: UPLOADING, progress 0, libraryPublishId, savepoint, …}`. The modal
    closes as soon as the state is UPLOADING. The server finishes the publish.
11. **Finish.** The last progress message ends with `PUBLISH_REQUEST_FINISHED`. The `MOVE_COMPONENTS_PROMPT`
    notification is dequeued. Timings are logged: `{publishType}.success.totalDurationMs`,
    `uploadBuffersDurationMs`, `clientPreWorkDurationMs`, `createSavePointDurationMs`.

**Progress states:** `NONE → ASSEMBLING_COMPONENTS → UPLOADING → NONE`. Cancel while assembling aborts.

### 3.8 Publish toasts and errors (CONFIRMED, 3187 module 475331)

All of these are visual bells of type `library-publish`.

| Case | Message key | Button |
|---|---|---|
| in progress | `publish_actions.publishing_library` / `unpublishing_library` (progress icon) | — |
| success | `publish_success` / `unpublish_success` (check icon) | — |
| offline | `cant_publish` / `cant_unpublish` | `retry` → reopens the modal |
| generic | `publish_error.generic` | `retry` |
| partial | `publish_error {numSkipped}` / `unpublish_error {numSkipped}` | `retry` |
| timeout | reopens the modal with `timedOut` (banner `publishing_took_too_long`) | — |
| HTTP 424 | `validations_failed` | `validations_contact` → mailto support |
| HTTP 413 | `publish_failed {reason = payload_too_large}` | — |
| other HTTP | `publish_failed {reason = reload}` | — |
| server reason | `publish_failed {reason}` | — |
| non-S3 | `check_network_compatibility.error_bell.library_publish.message` | — |

### 3.9 Unpublishing (Remove library) (CONFIRMED, 3187 fmt L75040–75060)

- The library file view footer shows `unpublish` (secondary).
- The confirm dialog is 400 px wide: title `remove_library_modal_title`, body
  `this_action_will_remove_all_of_the_components_in_this_file_from_the_library`, confirm `remove_library`.
- Community libraries add `internal_community_library_unpublish` and `internal_community_unpublish_warning`.
- Confirming runs the publish with `unpublishAll`.

### 3.10 Limits

| Limit | Value | Evidence |
|---|---|---|
| Variables per collection | 5000 | wasm "maximum number of variables (5000)" |
| Modes per collection at publish | plan `modeLimit` (1/10/20/40, ch. 11) | 7621 `z("publishing")` |
| Mode name | 40 chars | 3187 `maxLength: 40` (variables table) |
| Payload | HTTP 413 → `payload_too_large` | 3187 fmt L12985 |
| Yields before savepoint | 10 | figma_app 57205 |

## 4. Enabling libraries and defaults

### 4.1 Subscription endpoints (CONFIRMED, 3187 fmt L62960–62990)

| Level | Endpoint |
|---|---|
| file | `/api/library_file_subscriptions/<file>/<library>` |
| user drafts default | `/api/library_user_subscriptions/<library>` |
| team default | `/api/library_team_subscriptions/<library>` |
| workspace default | `/api/library_workspace_subscriptions/<library>` |
| org default | `/api/library_org_subscriptions/<library>` |

The file subscription payload is `{file_key, library_key, is_subscribed}`.

### 4.2 Why a library is enabled

The **subscription type** is one of `COMMUNITY, USER, FILE, TEAM, ORGANIZATION, WORKSPACE`. The library header
shows its origin (CONFIRMED, 3187 fmt L76310):

- USER → `added_via_draft_defaults`;
- FILE → `added_by_file_editor`;
- TEAM, ORG or WORKSPACE → `added_by_admin {groupName}`;
- COMMUNITY → nothing.

### 4.3 Other rules

- **Toggle labels** in team/drafts defaults:
  - `enabled_by_default`;
  - `enabling_a_team_library_will_make_it_show_up_in_all_team_files`;
  - `enabling_a_file_will_make_its_styles_available_in_all_personal_drafts`.
- **Who can change team defaults.** Others see `only_team_admins_can_enable_libraries_for_the_team` and the admins:
  `admin_list_1`, `_2`, `_3`, or `admin_list_many {adminHandle1, adminHandle2, numAdditionalAdmins = n−2}` when
  there are 4 or more.
- **Overriding an admin default** asks for confirmation: `confirm_override.{title, description_org,
  description_workspace, button_confirm, button_cancel}`.
- **Connected projects.** External-team strings: `add_to_connected_project_toggle.*`,
  `available_to_external_teams_in_connected_project`, `when_you_add_a_library_to_a_connected_project_…`.
- **Default variable modes** per workspace: `/api/variable_set_default_modes[_v2]/<folderId>`. In the library view,
  a "default_mode_dropdown" appears for org libraries with `bigma_enabled`.

## 5. The Libraries modal

### 5.1 Shell (CONFIRMED, 3187 fmt L75180 and L77580–77640)

- **Width** `min(760, innerWidth)`, or `min(950, …)` with the code-context feature.
- **Height** `min(640, 0.8 × innerHeight)`.
- Resizable only under the flag `library_modal_resizing`.
- **Tab content width** `min(560, 0.76 × innerWidth)`.
- Sidebar tab strip (vertical): a **search bar** first (autofocus, select on focus), a divider, then the tabs.

### 5.2 Tabs

**Tab order** (CONFIRMED, module 831623). There are four variants, depending on code connect and guidelines:

- base: `thisFile, updates, codeConnect, recommended, teams, org, storybooks, uiKits`;
- with code connect: `thisFile, codeConnect, updates, …`;
- with guidelines: `thisFile, codeConnect, guidelines, updates, …` or `thisFile, updates, codeConnect,
  guidelines, …`.

A divider and the heading `browse_libraries` follow "Updates".

**When each tab shows:**

| Tab | Shown when |
|---|---|
| This file, Updates, Teams, Search | always |
| Recommended | Pro access |
| Your organization | org access |
| UI kits | when available |
| Code connect | when enabled |
| Storybooks | flag |

- Teams is labelled `your_teams` in an org, else `teams`.
- **Legacy tab enum:** `LIBRARIES 0, FONTS 1, UPDATES 2, TEAM_LIBRARIES 3, RECOMMENDED 4`. It maps to `updates`,
  `teams`, `recommended`, else `thisFile`.

### 5.3 Search and keyboard

- Typing switches to the internal `search` tab. Clearing returns to the last non-search tab.
- **`/`** focuses the search (no modifiers, not in a text field). Tab from the modal focuses it too.
- Search results: `search_query_best_matches`, `displaying_results_for`, `no_results_for`, `filtered_by`,
  `show_enabled_libraries_filter`, `show_libraries_in_this_file`.

### 5.4 Tab contents

- **This file.**
  - The current file's own library: header `current_file`.
  - `current_file_has_x_changes {x_changes}` or `current_file_is_published`, with "Publish changes" and Unpublish.
  - `libraries_added_to_this_file`, with an empty state.
  - `used_in_this_file_header`, for libraries used but not added.
  - `libraries_available_in_this_file`.
  - The **View missing libraries** button.
- **Teams.** One row per team (drafts row `draft_libraries`). Each shows **3 library cards** and `see_more`.
- **UI kits.** `ui_kits_description`; three skeleton cards while loading. Preset libraries carry tooltips with
  licences: `preset_libraries.tooltip.{apple, google, figma}` + `_license_link`.
- **Library file view.**
  - Header: back button, file name (`header_label {fileName}`), workspace / team path, and an Add/Remove toggle or
    "Current file".
  - Body: a component grid with **`maxShownItems` 28**, variable collections, styles.
  - Footer: `num_assets_used_in_this_file {assetsCountString, usedInThisFileString}`, the Swap library button, and
    the code-connect button.
  - `skip_to_footer_actions` for keyboard users.
- **Entry points** (CONFIRMED, `r6` enum): "Asset panel button", "Assets panel > Add more libraries", "Assets panel >
  Browse libraries", "Actions > Browse libraries", "Layers tab button", "Toolbar button", "Quick action", "Team
  settings > View team libraries / fonts", "Variable modes > Dropdown > Accept/Review updates", "Instance swap >
  Browse libraries link", "Styles modal > Team library button", "Updates toast", "Paste Unadded Libraries", "Review
  instance modal > Update all / Update instance", "Review styles modal > Update", …

## 6. The update flow

### 6.1 When an asset counts as outdated (CONFIRMED, 2108 module 630276 `U()`)

Figma collects the **set of `{version, userFacingVersion}` pairs in use** for each asset key in the file.

- **Two or more distinct versions in use → always outdated.**
- **Exactly one → outdated only if** `published.version ≠ used.version` **and** `published.UFV ≠ used.UFV`. The
  comparison is case-insensitive. A version match with a UFV mismatch is reported to Sentry as an inconsistency.
- **Assets of the open file are skipped.**
- **Moved assets.** An asset whose key moved (`destination_key`) is tracked under its new key with the fake versions
  `FAKE_VERSION_FOR_MOVED_ITEM` / `FAKE_USER_FACING_VERSION_FOR_MOVED_ITEM`, so it always shows as an update.
- **What each update carries:**
  - `oldSubscribedKeysToUpdate`: old keys that now map to this asset;
  - `localIdsToUpdate`: local mains that were moved into the library;
  - `includesMoveUpdatesOnAnyPage` / `…OnCurrentPage`.
- **Variants are grouped under their set:** `newStateKeyToOutdatedItems`.
- **Variable sets** are outdated when a used variable's version differs. An extended collection is outdated when the
  set of inherited variable ids differs.

### 6.2 Notification

- The update notification is logged as displayed **1000 ms after** the file opens
  (`design_systems_analytics.update_notification_displayed {onFileOpen, hasChangesToPull}`), and as undisplayed when
  the badge clears (CONFIRMED, figma_app 289644 `W()`).
- It shows as the Libraries button's blue dot and the tooltip "Review library updates" (R22). Entry point
  "Updates toast".
- The dismissed state is `SET_LIBRARY_UPDATES_BANNER_DISMISSED`.

### 6.3 The Updates tab (CONFIRMED, 3187 fmt L77360–77470)

- **Scope.** The current page by default (`initialUpdatesModalScope ?? CURRENT`). The footer toggle
  `show_updates_for_all_pages` switches to ALL; its tab-change event is
  `library_preferences_modal.updates_modal_tab_changed {tab: all|current}`.
- **Switching to ALL** first loads all pages (`LIBRARY_UPDATES`). The list appears one animation frame plus **250 ms**
  later.
- **Descriptions.** They are fetched with `POST /api/publish_metadata {component_keys, state_group_keys, style_keys,
  variable_set_keys, library_asset_keys_with_library_keys}`. The reply is checkpoint metadata keyed by checkpoint id.
  On failure the bell is `couldn_t_load_update_descriptions_please_try_again_later`.
- **Grouping.** Updates are grouped **by publish (checkpoint)**, newest `publishDate` first.
  - Each group header: `updates_from {fileName}`, a help tooltip when it comes from the open file, the publish
    description, and an approval badge.
  - Inside, the order is components, state groups, styles, variable sets, code components.
- **Rows.**
  - A 64×64 thumbnail and the name (middle-truncated).
  - `moved_from {movedFromFileName}`: "this file" when a local main moved into the library.
  - `num_outdated_instances` (all-pages scope only).
  - An **Update** button (aria `update_instances_of_component {componentName}`).
  - Clicking a component or style row opens its review modal (aria `review_updates_for_component`). Variable sets and
    modules have no individual review.
- **Empty states.**
  - `no_updates_available` + `updates_to_components_or_styles`.
  - On the current page: `no_updates_available_page` + `maybe_updates_other_pages`, with a `show_all_updates` /
    `view_all_pages` button.
- **Loading.**
  - Three shimmer lines.
  - **5 placeholder rows**. Row *i* has opacity `1 − 0.2·i` and transition delay `1.5·i` s.
  - A spinner with `updates_taking_longer_than_expected`.
- **Error.** `couldn_t_load_update_descriptions_error`, when the list is empty but should not be.

### 6.4 Updating (CONFIRMED, figma_app 289644 and fmt L19620–19700)

- **Before updating, consumers are downloaded:**
  - `downloadAllSubscribedInstancesForUpdate(componentKeys + old keys, stateGroupKeys, localIds)`;
  - `downloadAllSubscribedStyleConsumersForUpdate`, `…VariableSetConsumersForUpdate`,
    `…CodeInstancesForUpdate`.
  - In an incremental session these wait for a scene-graph query.
- **Undo steps** (one per asset, user steps), each followed by a commit:
  - `update-shared-symbol` → `updateSharedSymbol(componentKey, libraryKey, oldKeys, localIds, instanceIds, canvas,
    startTime, scene)`;
  - `update-shared-state-group` (with `newStateKeyToOutdatedItems`);
  - `update-shared-style`, `update-selected-shared-style-consumers`;
  - `update-shared-variable-set`, `update-shared-library-asset`.
  - The wasm also keeps `update-shared-symbol-version-for-undo` and `update-shared-state-group-version-for-undo`.
- **Batching:** **5** assets per batch. The progress bell advances after each batch.
- **Progress bells** (type `library-update`):
  - `update_actions.updating_assets` with progress;
  - `update_success` (check);
  - `update_failure` (exclamation).
- **Errors.** A thrown error shows "An error occurred while updating the instances of this component." (hard-coded
  English).
- **Moved assets.** After updating them, the libraries they now live in are enabled for the file (INFERRED from
  `t1(…)` called with the library keys of move updates).
- **Update all.**
  - The order is **components → state groups → styles → variable sets → other library assets**.
  - It closes the modal first.
  - It logs `library.update_all.{attempt, success, failure}`.
  - If any collection's default mode changed, the bell is `variables.authoring_modal.default_mode_changed`.
- **Variables.** Only variables whose used version differs are re-pointed (`libraryVariableIdsForUpdate`).

### 6.5 The Review updates modal (CONFIRMED, 3187 fmt L79100–79200; module 112072)

- **Window.**
  - A draggable window, title `updates.review_updates`.
  - Default **800 × 580**, minimum **600 × 580**, maximum 100vw × 100vh.
  - Initial position x = (innerWidth − 800)/2, y = toolbar height + 12.
  - Clicking outside does not close it.
- **Header.** Back (`back_to_all_updates`, returns to the Updates tab with the same scope), the asset name
  (`instanceName` / `styleName`), and a hidden-instance icon (`this_instance_is_hidden`).
- **Previews.**
  - The before image is rendered from the current instance and the after image from the updated copy, at **2×**,
    uncompressed. A missing image shows `preview_unavailable`.
  - View modes: **Side by side** (Current | Updated) or **Overlay**, with an overlay opacity slider that starts at
    **0.5**.
  - Once updated, a single "Updated" image.
  - **Zoom presets: 25, 50, 100, 150, 200, 300, 400 %**; it does not zoom on the pointer.
- **Footer.**
  - With more than 1 instance: ◀ / ▶ (`previous_instance` / `next_instance`),
    `instanceIndexOfTotal {overallItemIndex}/{totalNumItems}`, and `go_to_current_instance`.
  - **← / →** navigate. ↑ / ↓ are swallowed.
  - Instance buttons:
    - `update_instance` (primary if it is the only one, else secondary);
    - `update_all` (primary, when there is more than 1 instance and not yet updated);
    - after updating, a disabled `updated` with a check, then `libraries_modal.next_component`.
  - Style buttons: `update_style`, plus `update_all` when the style has several versions in use.

### 6.6 What an update does to instances

- **CONFIRMED, behaviour visible in the build.** Each update swaps the backing SYMBOL / state group copy for the new
  version and re-derives instances. Only the listed `instanceIdsToUpdate` are updated when given; otherwise all.
- **Variants** are matched by state key (`newStateKeyToOutdatedItems`). A whole set is re-upserted
  (`upsert-shared-state-group`).
- **INFERRED, from REA components §2.2 / §2.13 and wasm strings** "Component customizations: ignored stale override
  paths" and "NIVB: Overrides are being dropped":
  - overrides are kept by `overrideKey` path;
  - an override whose path no longer exists in the new main is dropped;
  - properties not overridden follow the new main;
  - the stash (248) keeps overrides across swaps.

## 7. Swap library and missing libraries

### 7.1 Swap library (CONFIRMED, 3187 fmt L74950–75060 and L78980–79090)

- **Opening.** "Swap library" in a library's file view footer opens the replace-libraries view.
  - Left column: the used assets of the source library (`used_component` / `used_style` / `used_variable_set`).
  - Right column: their matches in a chosen target (`new_component` / `new_style` / `new_variable_set`).
  - Each row has a `swap_asset` checkbox. `none_found` appears when nothing matches.
  - Variable collections get a dropdown of the target's collections.
  - A missing source library shows `plural.missing_library` with count 1 as its name.
- **Matching rule.**
  - **Names are equal after removing all whitespace.** The match is case-sensitive (figma_app 229472 `Qp`).
  - **Styles** must also have the same `style_type`.
  - **Components** are searched among components first, then among state groups. **State groups** are searched among
    state groups first, then components.
  - **Variables** are matched by name inside the mapped collection (`swapVariableSetVariablesByName`).
  - Assets that are variables, sets, modules, or already unmapped are skipped. A style with 0 usages is skipped.
- **Option.** A checkbox, **on by default**: `swap_default_styles_in_instances`,
  `swap_default_collections_in_instances`, or `swap_default_styles_and_collections_in_instances`, with "Learn more"
  (help 4404856784663#overrides). It sets `createOverridesOnSwap`.
- **Run.**
  - The undo step is `replace-libraries`.
  - Progress counts instances + style usages + collections. It logs "Swap library starting/finished".
  - When done: a commit, then the bell `variables.visual_bell.variable_swap_count {count}` if variables were swapped.
  - The target library is **enabled for the file** if it was not already.
  - A Community target first goes through an insert/EULA flow (source `LIBRARY_SWAP`).

### 7.2 Missing libraries

- `GET /api/design_systems/missing_libraries` feeds:
  - "View missing libraries" (`view_missing_libraries`);
  - a header `header_label_missing` with a warning icon;
  - `plural.missing_library {missingLibCount}`, `plural.includes_missing_library`.
- Each missing library can be swapped like any other (§7.1).

## 8. Library analytics (DSA)

### 8.1 Endpoints (CONFIRMED, 2108 fmt L23655–23770)

The v2 endpoints are keyed by `libraryKey`; the legacy ones by `libraryFileKey`.

| Data | Endpoint |
|---|---|
| weekly insertions | `/api/dsa/v2/library/<lk>/weekly_insertions` |
| team usage | `…/team_usage` |
| per component usages / actions | `…/published_components_usages`, `…/published_components_actions` (`start_ts`, `end_ts`) |
| overview | `…/overview` |
| styles | `…/styles/overview`, `…/styles/<key>/details` |
| variables | `…/variables/overview`, `…/variables/<key>/details` |
| per asset | `/api/dsa/component/<key>[/file_usage]`, `/api/dsa/state_group/<key>[/components]` |
| org | `/api/dsa/libraries`, `/api/dsa/num_teams`, `/api/dsa/migration_status/<org>` |

Recording uses `POST /api/dsa/record/{component|style|variable}/action {action, action_source, fileKey, components |
styles | variables: [{key, count}]}`.

### 8.2 Recording usage (CONFIRMED, 2108 fmt L11495)

- Actions are recorded only for signed-in users in Design files. Slides and Make are excluded.
- Component batches hold at most **5000** keys per request.
- The action names come from the wasm (`trackComponentAction(e,t,n)`). Insert and detach are INFERRED from the
  `num_insertions` / `num_detachments` columns.

### 8.3 Shapes and math (CONFIRMED, 3187 fmt L73110–73345)

- **Durations:** `"30" | "60" | "90" | "365"`, mapped to the columns `insertions_30/60/90/year` and
  `detachments_30/…`.
- **Rows.**
  - Component/style row: `{key, name, num_existing_instances (usages), num_insertions, num_detachments, thumbnail_url,
    style_type}`.
  - Variable row: `{…, variableCollectionKey, collectionName, resolvedType}`.
  - Mode row: `{id, name, num_existing_instances, collectionKey, collectionName}`.
  - File usage: `{fileName, fileKey, teamName, numInstances, lastModified}`.
- **Top teams.**
  - Each team row: `{team_id, team_name, num_insertions, percent_insertions = round(100·n/total)%}`.
  - Teams with 0 insertions are dropped. Sorted by insertions, descending.
  - **Shown as two columns of 3: the top 6.** This corrects R22's "five".
- **CSV.**
  - The header is `dsa_csv_team_id, dsa_csv_team_name, dsa_csv_num_insertions, dsa_csv_percent_insertions`, with
    CRLF rows, as a `data:text/plain` link.
  - File name `dsa_csv_team_file_name {libraryName, assetType}`.
  - The link shows **whenever the team list is non-empty**, next to `plural.num_teams_total`. This corrects R22's
    "more than five".
- **Graph.**
  - Weekly points; each week is anchored to its **Saturday**. A zero point for today is prepended when the latest week
    is not today.
  - Weeks shown = ⌈days/7⌉.
  - SVG viewBox 100 × **120**; the plot uses 119 px of it.
  - Y tick interval: start at 10 and step 20. While max > 4·step: use step; if max > 5·step use 2.5·step; if
    max > 15·step use 5·step; then step ×10.
  - Ticks = ⌊max/interval⌋ + 1.
  - X labels every 1 week (≤ 60 days), 3 (> 60), or 6 (> 120), formatted "MMM D".
  - Primary series `--color-text-brand` (#0D99FF) with a 10% area fill. Comparison series `--color-text` (black).
    Stroke 2.
  - The incomplete week is dashed. Dots are small for 365 days.
  - Tooltip `dsa_graph_tooltip_v2`, aria `dsa_graph_aria_label {numInsertions, dateString}`.
- **States:** `dsa_empty_{components,styles,variables}`, `no_usage_recorded`, `dsa_undergoing_migration_*`,
  `loading_library_activity`, `loading_dsa_message_all_assets`.

## 9. Asset keys and versions (summary)

- **Two versions per asset:** a content version (`content_hash` / `version`) and a **userFacingVersion**. The update
  rule needs both to differ (§6.1).
- The server hands out keys and versions. The client never derives a key; it reads `componentKey`/`key` from the
  node. A local asset only knows its key after its first publish (INFERRED: `old_key` and `isLocal` fields).
- **The update unit is a key.**
  - Old keys (`oldSubscribedKeysToUpdate`) and local ids collapse into the new key after a move.
  - `REPLACE_USED_LIVEGRAPH_UNNATURAL_KEY_TO_NATURAL_KEY` and `REPLACE_USED_LIVEGRAPH_DESTINATION_ASSET_KEY_TO_LEGACY_SOURCE_ASSET`
    show that the server keeps both directions.
- **Copy transport.** Each asset is fetched as a canvas blob (`Eo.getCanvas({canvas_url})`). Copies are upserted
  with `upsertSharedSymbol(key, contentHash, libraryKey, …)` / `upsertSharedStateGroup` / `upsertSharedModule`
  (system steps `upsert-shared-*`), then inserted as `insert-component` / `insert-state-group`.

## 10. Copying and moving between files

### 10.1 Pasting library assets

- Pasted instances of published components arrive as library copies (`SUBSCRIBED_WITHOUT_LIBRARY` when the library
  is not enabled).
- Wasm: "paste failed to subscribe symbols", "failed to copy subscribed symbol to target when pasting".

### 10.2 Unpublished or unadded libraries (CONFIRMED, 2108 fmt L18505)

- **Pasted variables.** They are checked with `POST /api/variables/publish_state?keysAndLibrary=key|lib,…` in
  **batches of 25**.
- **Unpublished variables** →
  - `proto.paste_unpublished_variable_localize` with `…_localize_cta` (make them local, then the bell
    `proto.unpublished_variables_localized {numberOfVariables}`);
  - or `proto.paste_unpublished_variable` → help 14506821864087.
- **Unadded libraries** (the Cooper editor path) → `proto.paste_unadded_libraries` with primary
  `…_add_cta` (enable each) and secondary `…_manage_cta` (opens the Libraries modal, entry "Paste Unadded
  Libraries").

### 10.3 Moving (CONFIRMED, 3187 fmt L18150)

- **Prompt.** Pasting a published main from another file posts `POST /api/design_systems/move_validity
  {style_moves, component_moves, state_group_moves, dst_file_key}`.
  - For valid moves, a front-of-queue notification appears: `MOVE_COMPONENTS_PROMPT` with
    `updates.to_move_pasted_{styles|components}_to_this_file_publish_a_library_update`.
  - Accepting opens the publish modal with those items checked (entry `fullscreen_move_components_prompt`).
- **When it is offered.** Only when the file is not a draft, and (for components) the team has pro features.
- **Choice.** In the modal, each moved item is MOVE or COPY (§3.3).
- **Consumers.** They see the update as `moved_from {file}` and accept it like any update (§6).
- **Undo.** None. Help: moves can't be undone (R5).

## 11. The update state machine at a glance

```
local asset: NEW → (publish) → CURRENT → (edit) → CHANGED → (publish) → CURRENT
                                     └→ (delete) → DELETED → (publish) → unpublished
consumer copy: version v1 ─ library publishes v2 ─→ outdated (if v and UFV both differ, or several versions in use)
             → Update / Update all / Review → version v2 (undo: update-shared-*)
```

## 12. The Assets panel library sections (link)

These are covered in chapter 10 §8:

- "All libraries";
- cards with `num_components`;
- "Add more libraries";
- breadcrumbs;
- `Search all libraries` / `Search in this library`;
- "Libraries and settings";
- the tile context menu with go to main, view details, and Hide/Show when publishing (`library-item-tile-context-menu-for-assets-panel`).

The updates dot sits on the panel's Libraries button (live capture `left/rail-assets.txt`: a 24×24 "Libraries"
button at 261,12 in a 240-wide panel).

## 13. UI strings

The build carries i18n keys only. English is given where it is attested. **[L]** = live capture
(`docs/research/figma/live/left/rail-assets.txt`, `popovers/fill-picker-libraries-tab.txt`). **[H]** = help site via
R5/R22. **[B]** = an untranslated literal in the build.

**Attested English**

- "Assets", "Libraries", "Search all libraries", "Search in this library", "Libraries and settings", "All libraries",
  "Created in this file", "6 components", "Add more libraries" [L]
- "Hide when publishing", "Update all", "Update selected instance", "Allow any member of ‹org› to access the file",
  "Review library updates", "Review unpublished changes", "Library analytics", "Overview", "Analytics", "Download
  CSV", "Top teams", "Compare with" [H]
- "Site blocks", "Code components" (publish modal group headers), "An error occurred while updating the instances of
  this component.", "DSAnalytics Download CSV" (link inner text) [B]

**Keys (English not attested in the cache)**

- `design_systems.publishing_modal.*`:
  - modal_header, modal_header_community_library, description_placeholder, search_placeholder;
  - changes_header_with_count, unchanged_header_with_count, hidden_header_with_count, invalid_components_with_count,
    marked_for_publish_header_with_count;
  - these_wont_be_published, include_in_publish;
  - added, modified, removed, no_changes, reordered;
  - components, styles, variable_collections, page_thumbnails;
  - hide_when_publishing, show_when_publishing;
  - move_to_this_file, moved_to_this_file, publish_as_copy, publish_as_move_info_{component,style},
    publish_destination_as_copy_info, publish_source_{component,style}_as_copy_info, filename_fallback,
    move_components_warning, read_the_help_article;
  - missing_properties, conflicting_property_values, corrupt_layer_names, conflicting_property_names,
    unused_def_error, too_many_variables_error, too_many_modes_error, asset_cannot_be_published;
  - publishing_took_too_long, example_conversion_warning, unmovable_state_group_with_movable_state;
  - standard_upsell, starter_library_upsell, upgrade_team, create_a_professional_team;
  - publish_to_label, everyone_at_{org,team,workspace,this_file_s_workspace}, org_access_false_without_team_access;
  - warning_banner.*;
  - assembling_components_styles_and_variables;
  - cancel, publish_button_text, back, select_component, empty_search_result;
  - see_variables, list_item_changed_variable_count, hidden_variable_count_*, count, count_with_total,
    multiple_paste, multiple_paste_style, publish_to_community.
- `design_systems.publish_actions.*`: publishing_library, unpublishing_library, publish_success, unpublish_success,
  cant_publish, cant_unpublish, retry, publish_error, unpublish_error, publish_failed, unpublish_failed,
  payload_too_large, reload, validations_failed, validations_contact, savepoint_for_publish[_slides],
  savepoint_for_unpublish[_slides]; `design_systems.publish_error.generic`.
- `design_systems.updates.*`:
  - review_updates, review_updates_for_component;
  - update, update_all, update_instance, update_style, updated;
  - current, preview_unavailable, back_to_all_updates, previous_instance, next_instance, go_to_current_instance,
    instanceName, styleName, instanceIndexOfTotal, this_instance_is_hidden;
  - updates_from, moved_from, this_file, num_outdated_instances, update_instances_of_component;
  - no_updates_available, no_updates_available_page, maybe_updates_other_pages, updates_to_components_or_styles,
    show_all_updates, view_all_pages, show_updates_for_all_pages;
  - updates_taking_longer_than_expected, couldn_t_load_update_descriptions_error,
    couldn_t_load_update_descriptions_please_try_again_later;
  - to_move_pasted_{components,styles}_to_this_file_publish_a_library_update;
  - publish, published.
- `design_systems.update_actions.*`: updating_assets, update_success, update_failure.
- `design_systems.libraries_modal.*`:
  - Tabs and navigation: this_file, updates, browse_libraries, recommended, teams, your_teams, your_organization,
    ui_kits, ui_kits_description.
  - Library state: current_file, current_file_has_x_changes, x_changes, current_file_is_published,
    publish_changes, unpublish, remove_library, remove_library_modal_title,
    this_action_will_remove_all_of_the_components_in_this_file_from_the_library.
  - Sections: libraries_added_to_this_file, libraries_available_in_this_file, used_in_this_file_header,
    num_assets_used_in_this_file, used_in_this_file.
  - Swap library: swap_library, swap_asset, used_component, new_component, used_style, new_style,
    used_variable_set, new_variable_set, none_found, swap_default_{styles,collections,styles_and_collections}_in_instances.
  - Missing libraries: view_missing_libraries, header_label, header_label_missing, plural.missing_library.
  - Enabling: add_to_file, remove, enabled_by_default, added_by_admin, added_by_file_editor,
    added_via_draft_defaults, only_team_admins_can_enable_libraries_for_the_team, admin_list_{1,2,3,many},
    confirm_override.*.
  - Teams and branches: draft_libraries, see_more, you_can_t_publish_from_branches,
    merge_into_main_file_to_publish, publishing_disabled_tooltip.
  - Analytics: 30_days, 60_days, 90_days, year, overview, analytics, type, duration, compare_with, top_teams,
    download_csv, dsa_csv_*, plural.num_teams_total, component_insertions, style_insertions, variable_insertions,
    component_statistics, style_statistics, inserts_last_duration, detaches_last_duration, instances_all_time,
    total_*, teams_with_libraries, activity_this_week, used_by, used_in, last_modified, table_sort_hint,
    no_usage_recorded, dsa_empty_*, dsa_graph_aria_label, dsa_graph_tooltip_v2.
  - Plurals: plural.num_component, plural.num_style.
- Other namespaces: `proto.paste_unadded_libraries[_add_cta|_manage_cta]`, `proto.paste_unpublished_variable[_cta]`,
  `proto.paste_unpublished_variable_localize[_cta]`, `proto.unpublished_variables_localized`,
  `variables.visual_bell.variable_swap_count`, `variables.authoring_modal.default_mode_changed`,
  `upsell.move_file_publish.*`, `check_network_compatibility.error_bell.library_publish.message`.

## 14. DesignerV2 today

Evidence from a survey of `src/renderer/src/editor/panels/libraries/{PublishDialog,LibrariesDialog}.tsx`,
`editor/libraries.ts`, `engine/src/editor/Libraries.cpp`, `editor/analytics/` and `docs/data.md` §9/§16/§17.

**Matches**

- Per-asset checkboxes and select-all.
- The description field and its use in version history.
- New / Modified / Removed labels.
- Hide when publishing in the Assets context menu.
- The `_`/`.` private rule (`Libraries.cpp:36`).
- Invalid component errors (unused def, conflicting names).
- Move to this file / Publish as copy, with "Moved to" rows.
- The org-scope option.
- Publish progress and toasts.
- Enable/disable a library in the file.
- Workspace and org default libraries.
- 40-hex keys, `publishedVersion`, `publishID`, `sourceLibraryKey`.
- The blue dot and the "Review library updates" tooltip.
- Per-asset Update, Update all, Restore.
- Side-by-side / Overlay review.
- Overrides kept by overrideKey.
- Analytics durations, tabs, graph, compare, tables and modes.

**Differs**

- **The update rule.** DesignerV2 uses the hash only. Figma needs hash **and** UFV to differ, and treats a file with
  several versions in use as always outdated (§6.1).
- **Update grouping.** DesignerV2 groups by library. Figma groups by publish (checkpoint) with that publish's
  description, newest first.
- **Update all order.** DesignerV2 goes moved → modified per library. Figma goes components → sets → styles →
  variables → other, in batches of 5, with a progress bell.
- **Top teams.** DesignerV2 shows 5 and Figma 6. DesignerV2's CSV only appears above 5 teams; Figma's appears whenever
  the list is non-empty.
- **The update toast.** DesignerV2 shows it immediately for 8 s. Figma logs the notification 1 s after open and has
  no timed toast in this path.
- **Modal sizes.** DesignerV2 uses one fixed "large". Figma's Libraries modal is min(760, w) × min(640, 0.8h); its
  review window is 800×580 (min 600×580) and draggable.

**Missing**

- Publish modal:
  - search;
  - Shift-range select;
  - ⌘/Ctrl+Enter;
  - Unchanged / Hidden / Invalid sections with 32/46 px rows;
  - mode-limit check at publish;
  - an "unpublish library" confirm in the UI;
  - the publish-scope dropdown with workspace;
  - the audience warning banner.
- Libraries modal: the Recommended, Teams (3 cards + See more), UI kits and org tabs, `/` to search, and the
  "added by admin / draft defaults / file editor" origin labels.
- Updates tab: the current page / all pages scope, the per-row outdated instance counts, the loading skeleton.
- Review modal: zoom presets (25–400 %), per-instance navigation (◀ ▶, ← →, "Go to current instance"), Update
  instance vs Update all, and the style-version review.
- **Swap library** entirely: the name match ignoring whitespace, the style_type check, the component↔set fallback,
  the variable-by-name swap, the "Swap default styles/collections in instances" option, and auto-enabling the target.
- A dedicated **missing libraries** view.
- **The paste prompt** for unadded libraries and unpublished variables (localize).
- The move-validity check after paste (DesignerV2 offers "Publish…" itself).

### As built (2026-10-18, wave 5)

Built from the lists above, in their order. Code: `src/shared/store/libraryRules.ts`, the three registries
(`src/store/local/libraries.ts`, `src/renderer/src/store/memory/memoryLibraries.ts`, `src/store/libraries/org.ts`)
and `server/src/libraries/libraryBox.ts`; `src/renderer/src/editor/libraries.ts`; the chrome in
`editor/panels/libraries/{LibrariesDialog,PublishDialog}.tsx` and `editor/panels/design/ComponentPicker.tsx`.

- **The update rule (§6.1).** Manifests carry Figma's `userFacingVersion` (`LibraryAsset.userFacingVersion`): the
  store stamps it at publish (`stampUserFacingVersions`: an asset whose content the previous version had keeps that
  version's; a new or changed one gets this version's number as text; the server re-stamps on commit). `diffAgainst`
  now flags an asset used at two or more versions always, and one used at a single version only when its hash **and**
  its user-facing version (looked up in the library's history, `diffWithHistory`, case-insensitive) both differ from
  the latest. Manifests written before have none: their assets count as different, as before. Which edits Figma lets
  through without a new user-facing version stays open (§15): here every content change is one.
- **Updates grouped by publish (§6.3).** The diff names the publishes the updated content comes from
  (`LibraryDiff.publishes`: version, date, description); the Updates tab shows one group per publish, newest first —
  "Updates from ‹file›", the date, the description — each in Figma's order (components, sets, styles, variable
  collections); moved and removed assets in a group of their own. Rows: a 64 thumbnail, "Moved from ‹file›", the
  outdated-instance count in the all-pages scope, an Update button.
- **Scope (§6.3).** The current page by default, "Show updates for all pages" switches (the list one frame + 250 ms
  later): a component's update is on the page when an instance there uses one of its copies, nested instances too;
  styles and variables are listed on every page (which layers of a page use them isn't read). Empty states for the
  page ("No updates available on this page", View all pages) and the file. Loading: five placeholder rows (opacity
  1 − 0.2·i, shimmer 1.5·i s later), "Updates are taking longer than expected" after 5 s (our timer).
- **Update all (§6.4).** Closes the modal, then Figma's order (components → sets → styles → variables → other), the
  payloads fetched five assets at a time with the progress bell ("Updating assets… n/N"), then "Updated N assets" or
  "An error occurred while updating the instances of this component.". Still one undo step "Update library assets"
  (docs/data.md §9.4's contract; Figma makes one per asset).
- **The review window (§6.5).** Its own draggable window, 800 × 580 (min 600 × 580), 12 under the toolbar, centred;
  a click outside doesn't close it; Back returns to the Updates tab with its scope. Side by side / Overlay with an
  opacity slider (0.5), zoom presets 25–400 %, ◀ ▶ (← →; ↑ ↓ swallowed), "i/N", Go to current instance; Update
  instance (primary when it is the only one — then the copy is updated in place; one of several gets a copy of its
  own), Update all, then a disabled "Updated" and Next component. Styles: Update style.
- **The Libraries modal (§5).** min(760, w) × min(640, 0.8h); a sidebar — search first ("/" focuses it), This file,
  Updates (count), Browse libraries: Teams ("Your teams" in an org; three cards per team and See more), the
  organization. A library's view: `maxShownItems` 28 then "See all", its origin ("Added by ‹group› admin", "Added by
  a file editor" from the org listing's `via`), the footer's "N assets used in this file" and Swap library. Search
  lists every library by name.
- **Swap library (§7.1).** `swapPlan` / `swapLibrary`: the used components, sets, styles (used by a layer) and
  collections of the library, one row per asset; matched by name with every whitespace removed (case kept), styles of
  the same type, a component among components then sets (and back), a collection by name with a dropdown of the
  target's; a collection's variables by name. The copies are replaced in place by the target's latest version (the
  engine's redirect, as Move to this file's): users stay linked, overrides kept by key; a component matched to a set
  (or back) has its instances swapped onto the variant of the same name. One undo step "Swap library"; the target is
  added to the file; "Swapped N variables". "Swap default styles and collections in instances" (on): off leaves the
  styles and collections the library's unswapped components use inside them (a copy replaced in place can't tell an
  instance's default from a direct use).
- **Missing libraries (§7.2).** "This file uses N missing libraries" with View missing libraries: each library a copy
  here comes from that is no longer published or readable, its count, Swap library.
- **The publish modal (§3.2–§3.5, §3.9).** A search (the description only while it is empty); Invalid (property
  errors; a collection over 40 modes — the Enterprise limit, atlas 11 — or 5,000 variables; can't be checked),
  Changes (variable collections, styles, components; the header checkbox toggles only the rows a search shows),
  Unchanged and Hidden (collapsed; "These won't be published"; Include in publish takes Hide when publishing off; a
  `_` / `.` name can't be included) — 32 px headers, 46 px rows, a 22 px caption; ⇧-click ranges (Shift tracked on
  the document); ⌘Enter / Ctrl+Enter publishes; "Assembling components, styles and variables…" while publishing; in
  an org, "Publish to" (Everyone at ‹org› / Everyone on this file's team) and the warning when it widens who sees
  the file. Unpublish in This file with the 400-wide "Remove library" confirm (`LibraryAccess.unpublish`).
- **Analytics (§8.3).** Top teams: six (two columns of three), teams without insertions dropped; Download CSV as
  soon as one is listed.
- **The swap picker (atlas 10 §7.1).** Each added library is a section of its own (its published components by name;
  a pick brings the copy in, then the swap), and "Browse libraries" under the list opens the Libraries modal.

**Not done:** the Recommended, UI kits and Storybooks tabs, code connect; the workspace option of Publish to (no
workspaces in our org model) and the team's name in it; the virtualised publish list and its variable-collection
drill-down; publish toasts per failure kind (§3.8) and the timed-out reopen; the paste prompts for unadded libraries
and unpublished variables (§10.2) and the move-validity check (§10.3); per-asset undo steps for Update all; per-page
style and variable scope; the style-version review (a style used at several versions); Community targets of Swap
library; the update toast's timing (§15: left as it was, an 8 s toast — Figma's is unknown). Open questions in §15
stand; "Whether Swap library swaps nested instances" is answered here by construction (a copy replaced in place
changes every use, nested ones included), not by a probe.

**Sweep (2026-10-18).**
- **Publish failures** (§3.8): Retry on the toasts of failures retrying can help (offline, a generic error) — not on a
  draft or a branch, a seat, a conflict, a payload too large or a permission (`PublishDialog.tsx publishRetryable`); a
  payload too large has its own text (Figma's `publish_failed {reason: payload_too_large}`; English ours).
- **Paste prompt for unadded libraries** (§10.2): a paste from another file whose copies come from published libraries
  this file hasn't added names them, with Add library / Add libraries (Figma's add CTA enables each; its manage CTA,
  the Libraries modal, has no second button in our bell; English ours) — `libraries.ts unaddedLibraries`.

Still not done: the Recommended, UI kits and Storybooks tabs (no community data here); the unpublished-variables
prompt (it needs the server's publish-state check, Phase 6); the move-validity check; per-asset undo steps; per-page
style and variable scope; the style-version review; Community targets of Swap library; the update toast's timing.

## 15. Open questions

| Question | Live probe that settles it |
|---|---|
| English texts of the keys above | Open each dialog in Figma 126 (dark, 1440×900) and capture with `live/figma-dump.js`: publish modal (with changes, hidden, invalid), Libraries modal tabs, Updates tab, Review modal, Swap library view |
| Exact `_`/`.` rule: only the first character? Does a hidden parent frame hide children? Do set variants inherit? | Publish a file with `_Button`, `.Icon`, a frame `_Private/Card`, and a set whose variant starts with `_`; read the publish modal's Hidden section |
| Where the server sets `userFacingVersion` vs `content_hash` (which edits bump only one) | Publish, make a no-visual edit (rename a layer, edit a description), publish again, and check the consumer for an update; read `/api/design_systems/v2/library/<lk>/published_components` |
| Which update notification is shown on file open (toast vs dot only) and for how long | Open a consumer file after a publish; screen-record the first 5 s |
| `trackComponentAction` action names (insert / detach / …) | Watch `POST /api/dsa/record/component/action` in DevTools while inserting and detaching |
| Override preservation edge cases: a text override when the main's text layer is replaced; a nested instance swapped in the main | Update a consumer after such edits and diff `symbolOverrides` in a .fig export |
| Whether Swap library swaps nested instances inside other library components | Swap a library in a file whose instances contain nested instances from the same library |
| Plan values of `modeLimit` at publish (same as authoring?) | Publish a 5-mode collection from a Professional team |
