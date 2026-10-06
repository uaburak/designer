# R2-document — Figma document model, ids, ordering and persistence

Research date: 2026-10-06. Every statement below is tagged with the source it came from. "Observed" means I decoded real `.fig` files myself with a small Kiwi decoder (`scratchpad/research/figs/decode.mjs`) and looked at the data. "Inference" means I deduced it and did not read it anywhere.

Sample files decoded:
- `structure.fig` (version 48), `sections.fig` (version 106, `exported_at` 2026-08-24), `stacks_wrap.fig` (version 106, 2026-03-30) and `broken_images.fig` (version 20), from Sketch's fig2sketch test data (github.com/sketch-hq/fig2sketch/tests/data)
- Figma's own community file "Simple Design System" (version 101, 9,586 nodes), from Grida's test fixtures

## 1. Summary

A Figma file is a flat set of objects. Each object has a GUID `sessionID:localID`, a type, and a sparse map of properties. Parent and order are not a child list on the parent. They are one atomic property on the child, `parentIndex = {parent GUID, position}`, where `position` is a fractional-index string over printable ASCII. Sync is last-writer-wins per property, and the multiplayer server is the authority on order.

The same encoding is used both on the wire and on disk. A `.fig` file is a ZIP that holds:
- `canvas.fig`: an 8-byte prelude (`fig-kiwi`), a uint32 version, then length-prefixed chunks
  - chunk 0 is the Kiwi schema (raw deflate)
  - chunk 1 is one Kiwi `Message` of type `NODE_CHANGES` holding every node as a "CREATED" NodeChange, plus a `blobs` array of binary geometry (raw deflate in older files, zstd in newer ones)
- `meta.json`
- `thumbnail.png`
- `images/<sha1-of-bytes>`

Root and pages:
- The root is the DOCUMENT node `0:0`.
- Pages are CANVAS children of it.
- Every file also has a hidden CANVAS "Internal Only Canvas" (`internalOnly: true`). It holds the file's local styles, which are nodes with a `styleType`, and its local variable collections and variables (VARIABLE_SET / VARIABLE nodes). It is also where copies of library assets appear to live (inference, see §9).

Instances:
- An instance stores only `symbolData = {symbolID, symbolOverrides[]}`. Each override is a sparse NodeChange keyed by a `guidPath` into the component.
- It also stores a `derivedSymbolData` cache.
- It never stores child nodes.

Server storage and version history:
- Server side, files used to be saved as full binary checkpoints (every 30–60 s to S3). Since 2022 there is also a DynamoDB write-ahead journal of sequence-numbered changes.
- Version history adds a checkpoint every 30 minutes, plus named versions.
- "Save local copy" exports the `.fig` without history or comments.
- Offline edits are kept in IndexedDB and replayed on top of a fresh copy when the connection returns.

## 2. Scene graph = Map<ObjectID, Map<Property, Value>>

Source: Evan Wallace, *How Figma's multiplayer technology works* (2019-10-16), https://www.figma.com/blog/how-figmas-multiplayer-technology-works/
- A document is a tree of objects. Conceptually it is a two-level map `Map<ObjectID, Map<Property, Value>>`, or a database of `(ObjectID, Property, Value)` tuples. There is one root object, and its children are pages.
- Object IDs are made on the client. Every client gets a unique client ID, and that ID is part of every object ID it creates, so clients never collide and can create objects offline.
- The parent link is stored on the child, not as a children list on the parent. This keeps an object's identity when it is reparented.
- Order uses fractional indexing, a position in (0,1). The parent link and the position must be one property so that they change together.
- Conflicts are last-writer-wins per property, with the server deciding the order. Two concurrent text edits give "AB" or "BC", never "ABC": text is one property value with no character merge.
- Unacknowledged local changes win over incoming server values until the server acknowledges them, which prevents flicker.
- Reparent cycles: the server rejects any change that would create a cycle. Clients temporarily take such objects out of the tree.
- Deleting an object deletes all of its data on the server. Its old properties survive only in the client's undo buffer.
- Undo rule: undo a lot, copy, then redo back to the present, and the document must not change. An undo modifies redo history.
- The server runs one process per document. Offline clients can keep editing indefinitely. On reconnect they download a fresh copy, reapply their offline edits on top, and resume over a new WebSocket.
- The design is CRDT-inspired but not a true CRDT, because the central server gives authority. It was chosen because it is simpler than OT.

Source: Evan Wallace, *Realtime editing of ordered sequences* (2017-03-06), https://www.figma.com/blog/realtime-editing-of-ordered-sequences/
- Positions are arbitrary-precision fractions, not doubles. They are stored as strings in base 95 (the printable ASCII range) with the leading "0." left off.
- When two concurrent inserts get the same position, the server gives the second one a unique position.
- Known costs: positions grow longer, and concurrent inserts can interleave.

Observed in real files:
- `ParentIndex` is a Kiwi `struct { GUID guid; string position; }`. `GUID` is `struct { uint sessionID; uint localID; }`.
- The root is `0:0` "Document". Pages are `0:1`… and the internal canvas is usually `0:2`.
- In the Simple Design System file:
  - 191 distinct sessionIDs (up to 9765); localIDs up to 54,770
  - Position characters span ASCII 32–126 exactly (95 symbols, which confirms base 95)
  - The longest position is 79 characters, and 1,526 of 9,585 positions are longer than 10 characters. Most of the long ones are variables appended at the end of the internal canvas, e.g. `"~~~~…~|"`. This shows the length growth the 2017 post warns about.
- Typical sibling positions are one or two characters: `"!"`, `"\""`, `"#"`, `"!O"`, `"Qd&"`.
- Children sort ascending by `position` (fig2sketch does `sort(key=position)`).
- The Plugin API documents `children` as "sorted back-to-front": index 0 is the bottom layer. Evan's own parser sorts descending, which gives the layers-panel order (top first) (inference).

## 3. IDs as you see them in the APIs
- Plugin API: `node.id` is a string like `1:3`. Figma URLs use `1-3`, and the APIs need the colon form. https://developers.figma.com/docs/plugins/api/properties/nodes-id/
- REST: `id` is "A string uniquely identifying this node within the document". https://developers.figma.com/docs/rest-api/files/
- Instance sublayers get synthetic ids such as `I360:21745;1269:159559`: the instance GUID, then the path of GUIDs inside the component. This comes from community forum posts, not official docs. In the file, overrides are addressed by `guidPath` (a list of GUIDs), which matches (observed).
- Variables (REST): `VariableID:2:3`, collections `VariableCollectionId:1:2`, modes `1:0`, extended modes `VariableCollectionId:1:2/3:4`. A published variable has a stable `id` and `key` in its source file, plus a `subscribed_id` for subscribers that changes every time it is modified and published. https://developers.figma.com/docs/rest-api/variables-endpoints/
- Library assets have a `key`, the stable cross-file identity. In the file, style nodes carry `key` (40 hex characters) and `version` (e.g. `"3324:5"`) (observed). REST `Component`/`Style` = `{key, file_key, node_id, …}`. https://developers.figma.com/docs/rest-api/component-types/

## 4. Persistence on Figma's servers
- *Making multiplayer more reliable* (Darren Tsung, 2022-10-20), https://www.figma.com/blog/making-multiplayer-more-reliable/
  - Before 2022, every 30–60 s "the entire file is encoded into a binary format, compressed, and uploaded to S3" (a checkpoint).
  - Since then there is also a DynamoDB journal: each change gets a per-file incrementing sequence number. Recovery loads the last checkpoint and replays the journal entries after it.
  - 95% of edits are saved within 600 ms. The journal handles more than 2.2 billion changes a day.
- *Speeding up file load times, one page at a time* (2024-05-22), https://www.figma.com/blog/speeding-up-file-load-times-one-page-at-a-time/
  - Dynamic page loading. The server keeps the whole file plus QueryGraph, an in-memory graph of read and write dependencies (an instance depends on its component through `componentID`, text on its styles and variables, and auto layout on its siblings).
  - The server sends each client only its subscribed subset.
  - Instance sublayers are "fully derivable from the instance's backing component and any overrides", so they are materialized lazily.
- *Incremental frame loading* (2024-01-23), https://www.figma.com/blog/incremental-frame-loading/: a query/subscribe protocol for parts of a document. The Kiwi `MessageType` enum has `SCENE_GRAPH_QUERY` and `SCENE_GRAPH_REPLY`.
- *How we rebuilt the foundations of component instances* (Naomi Jung, 2026-03-17), https://www.figma.com/blog/how-we-rebuilt-the-foundations-of-component-instances/
  - "Materializer" is a generic, push-invalidated system for derived subtrees (instances, rich text, slots), with automatic dependency tracking.

## 5. The .fig file format (Save local copy)
Official sources: help.figma.com/hc/en-us/articles/8403626871063
- Local copies can be saved as `.fig`, `.jam`, `.deck`, `.buzz`, `.site` and `.make`.
- Version history and comments are not included.
- Re-importing breaks component links to the original libraries.
- The formats are "proprietary and may change".

Evan Wallace's parser (madebyevan.com/figma/fig-file-parser/, source `parser.js`) and fig2sketch (`src/figformat/*.py`) show the following, and I confirmed all of it on the sample files:
- **Container.** The file is usually a ZIP whose entries are stored uncompressed: `canvas.fig`, `thumbnail.png`, `meta.json`, `images/` and `images/<hash>`. A bare `canvas.fig` is also accepted. `meta.json` holds `client_meta` (background color, thumbnail size, render coordinates), `file_name`, `developer_related_links` and, in newer files, `exported_at`.
- **Header.** The first 8 bytes are `fig-kiwi` (Design) or `fig-jam.` (FigJam); `fig-deck` is for Slides according to Grida. Then comes a little-endian uint32 version (20, 48, 101 and 106 in my samples; fig2sketch accepts 15–70 and warns above that). After that, length-prefixed chunks (uint32 LE length each).
- **Compression.** Each chunk is either raw deflate or zstd, told apart by the zstd magic `28 b5 2f fd`. In the 2026 files, chunk 0 (the schema) is deflate and chunk 1 (the data) is zstd. In the older files both are deflate.
- **Schema.** Chunk 0 is a binary Kiwi schema, so the file describes itself. Even files with the same version 106 had different schemas: 558 and 637 definitions, with a NodeChange of 563 and 610 fields. Kiwi (github.com/evanw/kiwi) is a protobuf-like format: `message` fields are optional and identified by id, `struct` fields are fixed and in order, and it uses varints. It is backwards compatible, and forwards compatible when the schema travels with the data.
- **Data.** Chunk 1 decodes as `Message { type: NODE_CHANGES, sessionID: 0, ackID: 0, nodeChanges: NodeChange[], blobs: Blob[] }`. This is the same `Message` type used by the multiplayer protocol, whose `MessageType` includes JOIN_START, NODE_CHANGES, USER_CHANGES, SIGNAL, SCENE_GRAPH_QUERY/REPLY, DIFF, STREAM_START… (schema in grida `.ref/figma/fig.kiwi`, committed 2025-12-04). So a `.fig` is a serialized "everything was created" multiplayer message (inference, high confidence).
- **NodeChange.** It starts `guid, guidTag, phase (CREATED|REMOVED), phaseTag, parentIndex, parentIndexTag, type, typeTag, name, …`. It has around 530–610 optional fields. Notable ones:
  - `size` (Vector), `transform` (2×3 Matrix m00…m12), `visible`, `locked`, `opacity`, `blendMode`, `mask`
  - `fillPaints`, `strokePaints`, `effects`, `strokeWeight`/`strokeAlign`/…, the `rectangle*CornerRadius` fields, `cornerSmoothing`
  - `horizontalConstraint`/`verticalConstraint`
  - Auto layout under the internal names `stackMode` (NONE/HORIZONTAL/VERTICAL/GRID), `stackSpacing`, `stackPrimarySizing`, `stackChildPrimaryGrow`, `stackPositioning`
  - Grid: `gridRows`/`gridColumns`, which are `GUIDPositionMap` (each track has its own GUID plus a fractional position), `gridRowGap`, `gridRowSpan`, `gridChildHorizontalAlign`
  - `layoutGrids`, `exportSettings`, `prototypeInteractions`, `pluginData {pluginID,key,value}`
  - `symbolData`, `derivedSymbolData`, `componentPropDefs`/`componentPropRefs`/`componentPropAssignments`
  - `variableData`, `variableDataValues`, `variableSetModes`, `variableSetID`, `parameterConsumptionMap` (the variable bindings)
  - `styleType`, `key`, `version`, `sortPosition`, `internalOnly`, `isPageDivider`, `documentColorProfile`
  - `editInfo {userId, createdAt, lastEditedAt}` (present in 2026 files but not in the 2023 sample)
- **Blobs.** Geometry is stored as binary blobs and referenced by index:
  - `vectorData.vectorNetworkBlob`: uint32 counts of vertices, segments and regions; each vertex is styleID plus float32 x,y; segments have tangents; regions have winding rule and loops
  - `fillGeometry[]`/`strokeGeometry[]`: `commandsBlob`, path opcodes 0=Z 1=M 2=L 3=Q 4=C over float32
  - glyph outlines
  - The Simple Design System file has 52,350 commandsBlob references and 2,113 vectorNetworkBlob references.
- **Derived data is persisted.** Files store render caches that could be recomputed:
  - `fillGeometry`/`strokeGeometry`
  - text layout (`textData.baselines`, `glyphs`, `layoutSize`; newer files also have `derivedTextData`)
  - `derivedSymbolData`, per instance sublayer: size, transform, geometry and text layout keyed by `guidPath`. All 1,685 instances in the Simple Design System file have it.
- **Images.**
  - A paint's `image.hash` is 20 bytes, and the file lives at `images/<hex(hash)>`. I checked that the name is the SHA-1 of the file's bytes: 3/3 in `structure.fig` and 26/26 in the Simple Design System file. In `broken_images.fig` the bytes were deliberately corrupted, so they don't match.
  - `Paint` also has `imageThumbnail`, `thumbHash`, `originalImageWidth`/`Height`, `imageScaleMode`, and `colorVar`/`imageVar` for variable bindings.
  - Plugin API: `Image.hash` is "A unique hash of the contents of the image file". Images are PNG/JPEG/GIF up to 4096×4096. https://developers.figma.com/docs/plugins/api/Image/
  - REST: paints expose `imageRef`, and `GET /v1/files/:key/images` maps imageRef to a download URL that expires within 14 days. https://developers.figma.com/docs/rest-api/file-endpoints/
- **Rich text** is `textData {characters, characterStyleIDs[], styleOverrideTable: NodeChange[]}`: a string, a style id per character, and a table of sparse property bags. Overrides everywhere reuse NodeChange as a sparse "partial node": `symbolOverrides`, `styleOverrideTable`, `derivedSymbolData`.

## 6. Node types
- **Plugin API: 38 node interfaces** (https://developers.figma.com/docs/plugins/api/nodes/):
  - BooleanOperation, CodeBlock, Component, ComponentSet, Connector, Document, Ellipse, Embed, Frame, Group
  - Highlight, Instance, InteractiveSlideElement, Line, LinkUnfurl, Media, Page, Polygon, Rectangle, Removed
  - Section, ShapeWithText, Slice, SlideGrid, Slide, SlideRow, Slot, Stamp, Star, Sticky
  - TableCell, Table, Text, TextPath, TransformGroup, Vector, WashiTape, Widget
- **REST: 25 node types** (https://developers.figma.com/docs/rest-api/file-node-types/):
  - DOCUMENT, CANVAS, FRAME, GROUP, TRANSFORM_GROUP, SECTION, VECTOR, BOOLEAN_OPERATION, STAR, LINE, ELLIPSE, REGULAR_POLYGON, RECTANGLE
  - TABLE, TABLE_CELL, TEXT, TEXT_PATH, SLICE, COMPONENT, COMPONENT_SET, INSTANCE, STICKY, SHAPE_WITH_TEXT, CONNECTOR, WASHI_TAPE
- **Internal Kiwi `NodeType`: 59 values** (0–58), as of the Dec 2025 schema dump:
  - The internal names differ from the APIs: `SYMBOL` is a component, `ROUNDED_RECTANGLE` is what the API calls RECTANGLE, `CANVAS` is a page. A component set is a FRAME with `isStateGroup`.
  - Internal-only types: `VARIABLE`, `VARIABLE_SET`, `VARIABLE_OVERRIDE`, `SECTION_OVERLAY`, `ASSISTED_LAYOUT`, `MODULE`, `RESPONSIVE_SET`, `CODE_COMPONENT`/`CODE_INSTANCE`/`CODE_LIBRARY`/`CODE_FILE`/`CODE_LAYER`, `BRUSH`, `MANAGED_STRING`, `TRANSFORM`, `CMS_RICH_TEXT`, `REPEATER`, `JSX`, `EMBEDDED_PROTOTYPE`, `REACT_FIBER`, `RESPONSIVE_NODE_SET`, `WEBPAGE`, `KEYFRAME`, `KEYFRAME_TRACK`, `ANIMATION_PRESET_INSTANCE`
- **Document and pages** (https://developers.figma.com/docs/plugins/api/DocumentNode/, …/PageNode/, …/rest-api/files/):
  - There is one DocumentNode. Its children are always pages.
  - It has `documentColorProfile` (LEGACY/SRGB/DISPLAY_P3).
  - Every page keeps its own selection, plus guides, flowStartingPoints, backgroundColor and prototype settings.
  - With dynamic page loading, PageNodes always exist but their content is loaded on demand (`loadAsync`).
- **Observed pages:**
  - Page dividers are CANVAS nodes named "---" with `isPageDivider`.
  - The Internal Only Canvas sorts among the pages by position but is never shown.

## 7. Property groups (REST global and per-type; Plugin mixins)
- **Global** (every node): `id`, `name`, `visible`, `type`, `rotation`, `pluginData`, `sharedPluginData`, `componentPropertyReferences`, `boundVariables` (field → VariableAlias, or an array for fills/strokes/effects/layoutGrids/componentProperties/textRangeFills) and `explicitVariableModes` (collection id → mode id). https://developers.figma.com/docs/rest-api/files/
- **Geometry and paint:**
  - Fills and strokes are `Paint[]`: SOLID, GRADIENT_LINEAR/RADIAL/ANGULAR/DIAMOND, IMAGE, EMOJI, VIDEO, PATTERN.
  - Stroke settings: `strokeWeight`, `strokeAlign`, `strokeDashes`, `strokeJoin`, `strokeMiterAngle`, plus `complexStrokeProperties`/`variableWidthPoints`.
  - Corners: `cornerRadius`, `rectangleCornerRadii`, `cornerSmoothing`.
  - Effects: INNER_SHADOW, DROP_SHADOW, LAYER_BLUR, BACKGROUND_BLUR, TEXTURE, NOISE, with progressive blur in beta.
  - https://developers.figma.com/docs/rest-api/file-property-types/
- **Constraints:** `constraints {vertical: TOP|BOTTOM|CENTER|TOP_BOTTOM|SCALE, horizontal: LEFT|RIGHT|CENTER|LEFT_RIGHT|SCALE}`.
- **Auto layout:**
  - `layoutMode` NONE|HORIZONTAL|VERTICAL|GRID
  - Sizing: `layoutSizingHorizontal/Vertical` FIXED|HUG|FILL, `primaryAxisSizingMode`/`counterAxisSizingMode`
  - `layoutWrap`, `layoutPositioning` AUTO|ABSOLUTE, `itemReverseZIndex`, `strokesIncludedInLayout`
  - Grid: `gridRowCount`/`gridColumnCount`, `gridRowGap`/`gridColumnGap`, `gridColumnsSizing`/`gridRowsSizing` (CSS grid-template strings in REST), `gridAutoTracks`
  - Plugin API child placement: `gridRowSpan`/`gridColumnSpan`, `gridRowAnchorIndex`/`gridColumnAnchorIndex`, `gridChildHorizontalAlign`/`Vertical`, `gridItemsPositioning`
  - https://developers.figma.com/docs/plugins/api/properties/nodes-layoutmode/
- **Components:**
  - A component or set has `componentPropertyDefinitions` (BOOLEAN, TEXT, INSTANCE_SWAP, VARIANT, and SLOT since 2026).
  - An instance has `componentProperties`, `overrides: {id, overriddenFields[]}[]` (direct only), `exposedInstances`, `mainComponent` (possibly remote and read-only), and `scaleFactor`.
  - In the file:
    - `componentPropDefs {id GUID, name, initialValue, sortPosition, type, …}`
    - `componentPropRefs {defID, nodeField}` on sublayers
    - `componentPropAssignments {defID, value}` on instances
- **Variables:**
  - `Variable {id, name, key, variableCollectionId, resolvedType, valuesByMode, scopes, codeSyntax, hiddenFromPublishing, remote}`
  - `VariableCollection {id, name, key, modes[{modeId,name}], defaultModeId, variableIds, isExtension}`
  - In the file, a VARIABLE node has `variableSetID`, `variableResolvedType` and `variableDataValues.entries[{modeID, variableData}]`. A VARIABLE_SET has `variableSetModes[{id,name,sortPosition}]`.
  - Bindings are stored on the consumer as `parameterConsumptionMap.entries[{variableField: e.g. STACK_SPACING, variableData: {alias: {guid}}}]` and as `Paint.colorVar` (observed).
- **Styles** (`BaseStyle` = PaintStyle | TextStyle | EffectStyle | GridStyle | CustomAnimationStyle, the last added 2026-09-30):
  - REST `Style.node_id` is "ID of the style node within the figma file", so styles are nodes.
  - In the file they are ROUNDED_RECTANGLE or TEXT nodes with `styleType` FILL|TEXT|EFFECT|GRID…, `key` and `version`, under the Internal Only Canvas.
  - Consumers point at them with `styleIdFor{Fill,StrokeFill,Text,Effect,Grid} = {guid | assetRef{key,version}}`.

## 8. Version history, autosave, offline
- Figma "records a new checkpoint every 30 minutes and keeps the current version up to date". Autosaves are grouped in the UI.
- Named versions come from "Save to Version History" (⌥⌘S). Restoring creates checkpoints. A version can be duplicated into a new file.
- Starter teams see only 30 days of history; paid plans see all of it.
- https://help.figma.com/hc/en-us/articles/360038006754
- REST `Version {id, created_at, label, description, user}`. https://developers.figma.com/docs/rest-api/version-history-types/
- Publishing a library prompts for a description, which shows up in version history. https://help.figma.com/hc/en-us/articles/360025508373-Publish-a-library
- **Offline:**
  - What works offline: one new file, the current page and any pages that were already loaded, existing components, and export to .fig.
  - Changes are "saved locally to your browser's IndexedDB". An "unsynced changes" icon shows on affected files, and they sync on reconnect.
  - Unsynced work is lost if the cache is cleared, in private mode, or when storage runs out.
  - https://help.figma.com/hc/en-us/articles/360040328553

## 9. Libraries and cross-file assets
- You can publish components, styles and variables. Assets can be hidden from publishing. This needs a paid plan and a file in a project. https://help.figma.com/hc/en-us/articles/360025508373-Publish-a-library
- Subscribers do not update automatically. They review the changes (side by side or overlay) and accept them per asset or with "Update all". Updates apply on every page. https://help.figma.com/hc/en-us/articles/360039234193
- The file schema has the reference types:
  - `SharedSymbolReference {fileKey, symbolID, versionHash, componentKey, libraryGUIDToSubscribingGUID[], …}`
  - `SharedStyleReference {styleKey, versionHash}`
  - `AssetRef {key, version}` inside `StyleId`/`VariableID`/`SymbolId`/`VariableSetID`
- Inference (medium): a subscriber holds a local, read-only, versioned copy of each library asset it uses, mapped from the library's GUIDs to new local GUIDs. The copy probably lives under the Internal Only Canvas. Grida's code says clipboard component definitions sit under an internal-only canvas, and the REST API distinguishes "local" from "remote" variables and their `subscribed_id`.

## 10. What changed 2024–2026 (flagged)
- **2024-05:** dynamic page loading was rolled out. Plugins need `documentAccess: "dynamic-page"` and `loadAsync`.
- **2025-05-07 (Config 2025):** grid became an auto layout flow (`layoutMode: GRID`). Later additions:
  - HUG tracks and flexible fr-like units (2025-11-06)
  - automatic rows, automatic positioning and track reordering (2026-05-22)
- **2025-11-20:** extended variable collections. 2026-01-14: `rootVariableCollectionId`.
- **2026-01-26:** text on path (TEXT_PATH), transform groups (TRANSFORM_GROUP) and variable-width strokes.
- **2026-03-05:** slots went into beta. They became generally available on 2026-06-10, adding SlotNode, SLOT component properties and SlotSettings.
- **2026-03-17:** the instance engine was rebuilt on "Materializer".
- **2026-06 to 09:**
  - Motion and shaders
  - EASING/TIMING variable types
  - `textWrapStyle`
  - SPACE_EVENLY/SPACE_AROUND alignment
  - variable fonts (`variationSettings`)
  - composed color variables (`VariableComposedColor`, `COLOR_OPACITY` scope)
  - CustomAnimationStyle (2026-09-30)
- **File format:** version 106 by 2026, zstd data chunk, `editInfo` on nodes, `originFileKey` on the message, and many new internal node types (CODE_*, RESPONSIVE_*, KEYFRAME*, …).
- Sources: https://developers.figma.com/docs/plugins/updates/ and …/updates/page/2/, https://www.figma.com/blog/config-2025-recap/

## 11. Recommendations for a single-user, local-first clone that can later map to Firestore with per-property LWW
(Everything in this section is my inference, built on the facts above.)
1. **Model nodes the way Figma does.**
   - A flat table `nodes(id) → sparse property map`. Start with `type`, plus `parentIndex = {parentId, position}` stored as one property, never a children array.
   - Keep page = CANVAS under a single DOCUMENT `0:0`.
   - Add a hidden "internal" canvas for styles, variables and imported library copies. Alternatively, keep them in their own tables but with the same node-like id and property shape.
2. **IDs: `sessionID:localID`.**
   - Keep a per-file `nextSessionID` counter. Every editor session (tab open) claims a new sessionID and counts localIDs from 1.
   - Single-user: a local counter is enough. Later, the server can hand out sessionIDs on join, the way Figma does, so ids stay unique without coordination.
   - Reserve `0:*` for the document, pages and the internal canvas.
   - For Firestore doc ids, avoid strictly sequential ids at high write rates (hotspotting). `"{sessionID}:{localID}"` inside a per-file subcollection is fine at single-user rates.
3. **Ordering.**
   - Use fractional-index strings. For example, rocicorp `fractional-indexing` (base 62, keeps appends short), or Figma's base 95 over ASCII 32–126 if you want .fig parity.
   - The child decides its parent and position atomically.
   - Single user means no collisions. For the future multi-writer case, add jitter, or let the server rewrite duplicates (Figma's method).
   - Rebalance very long keys from time to time.
4. **Per-property LWW.**
   - Persist edits as an append-only op log of `{seq, nodeId, prop, value | DELETE, ts, sessionID}` (Figma's journal), plus periodic snapshots (Figma's checkpoint).
   - Mapping to Firestore:
     - each node is a document `files/{fileId}/nodes/{nodeId}` with one field per property
     - each edit is a field-mask `update()`, so concurrent edits to different properties merge and the same property is last-writer-wins
     - `parentIndex` is a single map field
     - deletion deletes the document
   - Keep heavy or derived values out of the per-property docs (Firestore's 1 MiB per document limit):
     - vector networks, path geometry and glyph caches go in blobs or Storage, referenced by hash
     - text stays a single `characters` property, as in Figma, plus a style-run table
5. **Instances.**
   - Persist only `componentId` and sparse `overrides` keyed by guidPath, plus component-property assignments.
   - Derive the sublayers at runtime.
   - Optionally cache derived geometry and layout (like `derivedSymbolData`), but treat the cache as rebuildable and never as a source of truth.
   - Synthetic ids for instance sublayers: `I<instanceId>;<guid>;<guid>`.
6. **Images** are content-addressed: SHA-1 of the bytes as the key, stored once per file (`images/<sha1>`) or in a global blob store. Paints reference the hash.
7. **Local assets live in the file.**
   - Styles, variables (collections, modes and variables, with modes as GUIDs and `valuesByMode`) and components belong to the file.
   - Publishing creates a library version: snapshot each published asset, give it a stable `key` (content-independent, e.g. a random 160-bit hex) and a `version`.
   - Subscribing files store read-only copies tagged `{libraryFileId, key, version}`. A "library updates available" diff is then a plain version comparison, and accepting is an explicit action.
8. **Version history** means snapshots (autosave every 30 minutes of activity, plus named versions with label and description) on top of the op log. Restore writes a new head; it does not rewind.
   - Save local copy / import can reuse the same snapshot encoding.
   - Real `.fig` import and export (Kiwi + zstd/deflate + ZIP) is possible because the schema is embedded in each file, but it is unstable and proprietary.
9. **Avoid** today's DesignerV2 pattern: a whole document as one JSON text in a single Firestore doc (`projects/{slug}/content/canvas`) with nested `children` arrays. It cannot do per-property LWW and runs into the 1 MiB limit.

## 12. Open questions
- What do the `*Tag` fields (`guidTag`, `phaseTag`, `parentIndexTag`, `nameTag`…) mean? They might be per-property version stamps.
- Where exactly do library copies live in a subscriber file, and how are `versionHash` and `key` computed?
- How does Figma rebalance or shorten long positions, if it does?
- What exactly decides the autosave checkpoint (30 minutes of wall time, or of activity)?
- Is the internal `stackMode: GRID` / `gridRows` GUIDPositionMap model stable after the 2026 grid changes?
- How are slots (SlotNode) persisted in the file?

## Sources (all opened)
- https://www.figma.com/blog/how-figmas-multiplayer-technology-works/
- https://www.figma.com/blog/realtime-editing-of-ordered-sequences/
- https://www.figma.com/blog/multiplayer-editing-in-figma/
- https://www.figma.com/blog/making-multiplayer-more-reliable/
- https://www.figma.com/blog/speeding-up-file-load-times-one-page-at-a-time/
- https://www.figma.com/blog/incremental-frame-loading/
- https://www.figma.com/blog/how-we-rebuilt-the-foundations-of-component-instances/
- https://www.figma.com/blog/config-2025-recap/
- https://help.figma.com/hc/en-us/articles/8403626871063-Save-a-local-copy-of-files
- https://help.figma.com/hc/en-us/articles/360038006754
- https://help.figma.com/hc/en-us/articles/360040328553
- https://help.figma.com/hc/en-us/articles/360025508373-Publish-a-library
- https://help.figma.com/hc/en-us/articles/360039234193-Review-and-accept-library-updates
- https://help.figma.com/hc/en-us/articles/31289469907863
- https://developers.figma.com/docs/plugins/api/nodes/ (+ DocumentNode, PageNode, InstanceNode, ComponentNode, SlotNode, TransformGroupNode, TextPathNode, Variable, VariableCollection, BaseStyle, Image, properties/nodes-id, properties/nodes-children, properties/nodes-layoutmode)
- https://developers.figma.com/docs/plugins/accessing-document/
- https://developers.figma.com/docs/plugins/working-with-images/
- https://developers.figma.com/docs/plugins/updates/ and /updates/page/2/ and /updates/2026/06/10/update/
- https://developers.figma.com/docs/rest-api/files/ , /file-node-types/ , /file-property-types/ , /file-endpoints/ , /component-types/ , /version-history-types/ , /variables-endpoints/ , /variables-types/
- https://madebyevan.com/figma/fig-file-parser/ (parser.js, script.js)
- https://github.com/evanw/kiwi (README)
- https://github.com/sketch-hq/fig2sketch (src/figformat/decodefig.py, fig2tree.py, kiwi.py; tests/data/*.fig)
- https://github.com/gridaco/grida (.ref/figma/fig.kiwi; packages/grida-canvas-io-figma/fig-kiwi/README.md; lib.ts), https://grida.co/docs/wg/feat-fig/
- https://forum.figma.com/t/cant-get-node-with-prefix-i/58062
- https://github.com/rocicorp/fractional-indexing
- https://firebase.google.com/docs/firestore/quotas , /best-practices , /manage-data/add-data
