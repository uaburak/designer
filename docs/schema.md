# Document schema

The document contract of DesignerV2: what a file is made of, how a change is expressed, how ids and order work, and how all of it maps to disk and to Firestore. The single source of truth is **`schema/document.kiwi`**. Everything here explains that file; when the two disagree, the `.kiwi` file wins and this document is fixed.

Readers: the engine (`docs/engine.md`), storage and sync (`docs/data.md`), the panels, libraries and the preview viewer. They build against this without talking to each other, so every rule below is meant to be followed literally.

---

## 0. Decisions at a glance

| Topic | Decision |
|---|---|
| Basis | **Figma's own Kiwi schema, trimmed.** 183 definitions (87 enums, 11 structs, 85 messages). `NodeChange` keeps 194 of Figma's 610 fields. Every kept field name, number, type and enum value is Figma's; this was checked mechanically (1,307 checks, 0 mismatches, §1.1). |
| Own additions | Three fields: `NodeChange.clearedFields = 1000`, `NodeChange.librarySubscriptions = 1001`, `Message.derivedDataVersion = 100`, plus one message (`LibrarySubscription`). Everything else that DesignerV2 needs was already in Figma's schema. |
| One encoding | `Message { type: NODE_CHANGES, nodeChanges[], blobs[] }` is the snapshot, the journal frame, the undo batch, the clipboard payload, the preview snapshot and what the engine emits after every commit. |
| Data model | A flat map `GUID → NodeChange` (a sparse property bag). Tree and order are one property on the child, `parentIndex {guid, position}`. One top-level field = one property = one unit of last-writer-wins. |
| Change model | Present field = set. `clearedFields` = unset. `phase CREATED` = new node with its full state; `phase REMOVED` = delete, sent for every node of a removed subtree. Undo = the inverse NodeChanges. |
| Instances | Figma's encoding: `symbolData {symbolID, symbolOverrides[], uniformScaleFactor}` is **one property**; overrides are sparse NodeChanges addressed by a `guidPath` of `overrideKey`s; an empty path is the instance root. Sublayers are never stored. |
| References | Styles, variables, component properties and main components are referenced, never copied as the source of truth. The engine keeps a resolved copy in the node's own fields (system writes, `engine.md` §3.3) so readers without a resolver can draw the file. |
| Codegen | kiwi-schema **0.5.0** (npm) generates both sides: C++ tree codec, C++ visitor codec, TS types and codec. Verified to compile under `engine.md`'s flags and to be byte-identical native, wasm32 and JS (§2). The generator is `engine/tools/schemagen`. |
| IDs | `sessionID:localID`. Sessions per data.md §1; `0:0` DOCUMENT, `0:1` first page, `0:2` Internal Only Canvas. Derived sublayer ids `I<instance>;<key>;<key>`. |
| Order | Figma's base-95 fractional positions (ASCII 0x20–0x7E). One deterministic `keyBetween` with LOW/MID/HIGH bias, shared by C++ and TS; rebalance when a key would exceed 24 chars. |
| Storage | Snapshot = a `canvas.fig`-identical container (`fig-kiwi`, `DOCUMENT_FORMAT_VERSION = 1`); journal frames; Firestore `files/{fileKey}/nodes/{s:l}` with one field per top-level property; blobs and images in Storage by SHA-1. Byte layouts are owned by `docs/data.md` §5 and §12. |

---

## 1. The schema file

### 1.1 Basis and verification

Sources:
- `docs/research/figma/figma-schema.kiwi`: Figma's schema as extracted from real files (526 definitions, `NodeChange` fields up to 530).
- The schema embedded in `docs/research/figma/samples/sections.fig` (version 106, exported 2026-08-24; 637 definitions, `NodeChange` up to 610). It adds fields we keep: `textWrapStyle = 594`, `gridAutoTracks = 555`, `Paint.opacityVar = 38`, `ComponentPropDef.slotPropConfig = 12`, `ExpressionFunction.COMPOSE_COLOR = 20`, `StackJustify.SPACE_AROUND = 5`, `VariableScope.COLOR_OPACITY = 23`, `EasingType.HOLD/EASE_IN`. Added 2026-10-08 from the owner's file (version 106): `gridReflowEnabled = 556` (a grid's auto placement). Semantics found against Figma's own geometry: `StackJustify.SPACE_EVENLY` is Figma's "Space between" (`SPACE_BETWEEN` lays out the same; CSS space-evenly is `SPACE_EVENLY_CSS`); `stackCounterSpacing` NaN means "the same as `stackSpacing`" (as absent).
- The two Figma schemas never disagree on a field they share (checked: 0 conflicts). Figma does not renumber.

What was verified on 2026-10-06 (scratch tests, not in the repo):
1. `kiwi-schema` 0.5.0 `parseSchema` accepts `document.kiwi` (it enforces kiwi's rules, §1.2).
2. **Figma parity**: every non-own definition, field and enum value of ours matches Figma's by name, number, type and array-ness in one of the two Figma schemas. 1,307 checks, 0 mismatches. No own field uses a number that Figma uses.
3. **C++**: the generated tree codec and visitor codec compile together in one TU with `-std=c++20 -Wall -Wextra -Wpedantic -Werror -Wno-unused-parameter -fno-exceptions -fno-rtti` (Apple clang 21) and with emsdk 6.0.11. A test Message (a CREATED rectangle plus an update carrying `clearedFields`) encodes to the same 75 bytes natively and in wasm32.
4. **JS/TS**: the generated JS codec decodes those C++ bytes and re-encodes them byte-identically. The generated `.ts` types pass `tsc --strict`.
5. **Import**: Figma's 9,586-node "Simple Design System" file was decoded with its own embedded schema, projected onto ours **by field name only** (unknown fields and node types dropped), encoded with our codec and decoded again: 9,560 nodes round-trip (26 `BRUSH`/`CODE_LIBRARY` nodes dropped). The dropped fields are exactly the categories in §13. This is what "a `.fig` can be imported with minimal mapping" means in practice.

### 1.2 Editing rules

- **Never renumber, retype or reuse a field number. Never change a struct** (kiwi structs are fixed-layout; adding a field breaks every reader).
- Kiwi requires a message's field ids to be ≤ its field count. Figma numbers we do not keep are therefore declared as placeholders, `byte _rN = N [deprecated];`, in a "Reserved field numbers" block at the end of each message (953 in total, 807 of them in `NodeChange`). Deprecated fields are never written, are omitted from the TS types and the C++ accessors, and cost nothing at runtime.
- **Adopting a Figma field later**: replace its placeholder with Figma's exact declaration (same number, same type).
- **Own fields** use numbers from **1000** in `NodeChange` and from **100** in every other Figma-derived message; own enum values start at 100. Numbers below are Figma's, kept or reserved. Messages Figma does not have (`LibrarySubscription`) number from 1.
- `DOCUMENT_FORMAT_VERSION` is declared in the file header (`// DOCUMENT_FORMAT_VERSION = 1`). It is bumped only for a change that kiwi's additive evolution cannot express and that needs a migration (`data.md` §5.8). Adding fields or enum values never bumps it.
- After any edit: `npm run engine:gen` then `npm run check`.

### 1.3 Field tags

A field's trailing comment starts with zero or more tags, then free text. `@` never appears in free text. Grammar: `tag := "@" name [ "(" args ")" ]`.

| Tag | Meaning | Used by |
|---|---|---|
| `@derived` | Computed by the engine. Never in a change Message or the journal; only in snapshots that ask for it (preview/viewer snapshots). Readers ignore it if `Message.derivedDataVersion` differs from their engine's — except `0x46494701` (`FIGMA_DERIVED_DATA_VERSION`): Figma's own text layout and instance geometry kept by a `.fig` import, read as the engine's own. | `fillGeometry`, `strokeGeometry`, `derivedTextData`, `derivedSymbolData` |
| `@blob` | A `uint` index into the enclosing Message's `blobs`. Every `@blob` field's name ends in `Blob`, which is the rule `data.md` §5.5 uses; the generator asserts both agree. | `Path.commandsBlob`, `VectorData.vectorNetworkBlob`, `Glyph.commandsBlob`, `Image.dataBlob` |
| `@nooverride` | Must not appear in a `symbolOverrides` entry (the engine rejects it). Everything not tagged is overridable. | identity, tree, constraints, structure, definitions, publishing, page/document fields |
| `@own` | On an INSTANCE: the instance's own value. Never materialized from the main component's root and never in the root override entry (§5.2). | `parentIndex, transform, constraints, locked, stackChild*, stackPositioning, gridRow/ColumnAnchor/Span, gridChild*Align, scrollBehavior, prototypeStartingPoint, symbolData, componentPropAssignments` |
| `@default(v)` | What absence means when it is not the kiwi zero value (§3.4). `v` is `true`, `false`, a number, an enum value name, `identity`, or `{a, b, …}` for a struct in field order. | see §3.4 |
| `@bind(F[:c], …)` | The `VariableField`(s) that bind this field through `parameterConsumptionMap`; `:c` names the struct component (`WIDTH:x`, `FONT_STYLE:style`). | 33 fields, §6.3 |
| `@patch` | Only in change Messages; never stored on a node. | `clearedFields` |
| `@later` | Kept for parity; the v1 engine stores and round-trips it but does not implement it. | noise/texture/glass effect parameters, Motion easing values |
| `@ours` | Not in Figma's schema. | the additions listed in §0 |

### 1.4 The six roles of `NodeChange`

`NodeChange` is Figma's sparse "partial node" and appears in six places. The same field means the same thing in each.

| Role | Where | Required fields | Never present |
|---|---|---|---|
| Node record | a snapshot Message, `phase CREATED` | `guid`, `phase`, `type`, `parentIndex` (except `0:0`) | `clearedFields`, `guidPath` |
| Change | a change Message | `guid` (+ `phase` for create/remove) | `guidPath`, `@derived` |
| Override entry | `SymbolData.symbolOverrides[]` | `guidPath` | `guid`, `phase`, `type`, `parentIndex`, `@nooverride`, `@own` (root entry) |
| Text run style | `TextData.styleOverrideTable[]` | `styleID ≥ 1` | anything that is not a text-run field (§7) |
| Vector style | `VectorData.styleOverrideTable[]` | `styleID ≥ 1` | anything except `fillPaints` (regions), `strokeCap`, `strokeJoin`, `cornerRadius`, `cornerSmoothing`, `handleMirroring` (vertices) |
| Derived entry | `derivedSymbolData[]` | `guidPath` | anything except `size`, `transform`, `fillGeometry`, `strokeGeometry`, `derivedTextData`, `minSize`, `maxSize` |

---

## 2. Code generation

### 2.1 What kiwi ships (verified on npm and GitHub, 2026-10-06)

- npm **`kiwi-schema` 0.5.0** is the latest release (published 2023-08-11; repo `github.com/evanw/kiwi`, last commit 2023-09-03, MIT). It ships the `kiwic` CLI with `--cpp` (tree style), `--callback-cpp` (visitor style), `--ts`, `--js`, `--skew`, `--binary`, `--text`, and the same as a library API: `parseSchema`, `compileSchemaCPP`, `compileSchemaCallbackCPP`, `compileSchemaTypeScript`, `compileSchemaJS`, `compileSchema`, `encodeBinarySchema`, `decodeBinarySchema`, `prettyPrintSchema`, `ByteBuffer`.
- **The C++ runtime `kiwi.h` is not in the npm package.** It is the repository's root file `kiwi.h` (ByteBuffer, MemoryPool, String, Array, BinarySchema; 32- and 64-bit varints, kiwi's float encoding). Vendor it as `engine/third_party/kiwi/kiwi.h` with `LICENSE` (MIT) and `VERSION` (commit of 2023-09-03), following `engine.md` §1.1's third-party convention.
- Kiwi facts that shape the contract: `float` is 32-bit everywhere (as in Figma); `uint64` decodes to `BigInt` in JS (only `Message.sentTimestamp` uses it); a message field that is present-but-empty (`[]`, `{}`) is distinguishable from absent; the JS decoder **throws** on an unknown field id, while the C++ tree decoder can skip unknown fields when given the writer's `BinarySchema`; the C++ visitor decoder cannot skip.

### 2.2 The generator

There is one generator for this schema: **`engine/tools/schemagen`** (`engine.md` §1.1 and §1.6; Node 24 TypeScript, erasable syntax). It uses the kiwi-schema 0.5.0 library API, not the CLI, and does exactly this:

| Output | Call | Contents |
|---|---|---|
| `${build}/generated/schema/document.kiwi.h` | `compileSchemaCPP({...schema, package: "schema"})` | `namespace schema`: one class per message/struct with optional accessors (`nullptr` = absent), `encode`, `decode(bb, pool, const BinarySchema*)`; implementation behind `#define IMPLEMENT_SCHEMA_H` |
| `${build}/generated/schema/document.stream.h` | `compileSchemaCallbackCPP({...schema, package: "schema_stream"})` | `schema_stream::Visitor`, `schema_stream::Writer`, `schema_stream::parseMessage(bb, visitor)` |
| `${build}/generated/schema/node_fields.h` | own code, from the tags | `enum class NodeField : uint16_t` (value = field id), `kNodeFields[]` `{id, name, kiwiType, isArray, flags}` with flags `DERIVED, BLOB, NOOVERRIDE, OWN, PATCH, LATER, OURS`, `kBindings[]` `{VariableField, NodeField, component}`, typed `constexpr` defaults `kDefault_<Message>_<field>`, `kBlobFields[]` `{message, field}`, `kDocumentFormatVersion` |
| `src/shared/schema/document.generated.ts` | `compileSchemaTypeScript(schema)` + `compileSchemaJS(schema)` + own code | the TS interfaces and string-literal enums; `export const codec: Schema` (the JS codec, wrapped as an ES module importing `ByteBuffer` from `kiwi-schema`, under `// @ts-nocheck`); `NODE_FIELDS`, `BINDINGS`, `DEFAULTS`, `BLOB_FIELDS` (same content as `node_fields.h`); `SCHEMA_BINARY: Uint8Array` (`encodeBinarySchema`, 30,280 bytes, 13,035 deflated); `DOCUMENT_FORMAT_VERSION` |

Rules:
- C++ is generated at build time by a CMake custom command (`engine/cmake/Generators.cmake`) that `DEPENDS` on `schema/document.kiwi`, and is never committed. The TS file is committed so `npm run typecheck` works without emsdk (`engine.md` §1.6). This answers `engine.md` §14 Q1 point 4: **`src/shared/schema/document.generated.ts` is the one TS codec** for renderer, main and store.
- The schema file has no `package` line; the generator chooses the C++ namespaces (above). This keeps `document.kiwi` concatenable with `engine/api/engine-api.kiwi` (`engine.md` §10.1).
- Exactly one C++ TU (`engine/src/schema/KiwiImpl.cpp`) defines `IMPLEMENT_KIWI_H` and `IMPLEMENT_SCHEMA_H` before including `kiwi.h` and both headers. Both headers can be included together (verified).
- Engine-only metadata (facet, dirty mask, C++ storage type) stays in `engine/tools/schemagen/fieldmeta.ts` (`engine.md` §2.3), which **reads** the schema tags instead of restating them: `DERIVED_CACHE` = `@derived`, `OVERRIDABLE` = not `@nooverride`, `BINDABLE` = `@bind`.
- Generated files are excluded from ESLint (`**/*.generated.ts`).
- `package.json`: `kiwi-schema` pinned exactly to `0.5.0` in **dependencies** (the TS codec needs `ByteBuffer` at runtime in renderer, main and store), not only devDependencies.

Commands:
- `npm run engine:gen` writes the TS output; `npm run engine:gen -- --check` regenerates into a temp dir and fails if anything differs (`engine.md` §1.6). `npm run check` already runs it first.
- `npm run engine:build:*` regenerates the C++ through CMake.
- Equivalent CLI, for reading generated code by hand: `npx kiwic --schema schema/document.kiwi --cpp /tmp/document.kiwi.h --callback-cpp /tmp/document.stream.h --ts /tmp/document.ts --js /tmp/document.js` (no namespace, CommonJS JS; not used by the build).

`--check` also runs these schema checks and fails on any violation:
1. `parseSchema` succeeds (kiwi's own rules).
2. Figma parity (§1.1 point 2) against `docs/research/figma/figma-schema.kiwi` and the schema chunk of `docs/research/figma/samples/sections.fig` (chunk 0, raw deflate).
3. Own numbering (§1.2): own fields ≥ 1000 in `NodeChange`, ≥ 100 elsewhere; every own field or definition carries `@ours`.
4. Tags: known names only; `@bind` names exist in `VariableField` and `:c` names a component of the field's struct; `@default` parses for the field's type; `@blob` only on `uint` fields named `*Blob`; `@derived`, `@own`, `@patch` only on `NodeChange`.

### 2.3 Which codec to use where

| Job | Codec | Why |
|---|---|---|
| Engine: change Messages in and out, clipboard, undo inverses | C++ tree (`schema::Message`) | small; random access to optional fields; can skip unknown fields with a `BinarySchema` |
| Engine: loading a snapshot | C++ visitor (`schema_stream::parseMessage`) straight into `NodeTable`/facets | a tree-decoded `schema::NodeChange` is 916 bytes in wasm32 (1,408 native), too much for 100k nodes |
| Engine: writing a snapshot | C++ visitor `schema_stream::Writer` driven by the encoder, or own encoder in `scene/Encode` | streaming, no intermediate objects |
| Store/sync/main, panels | `codec` from `document.generated.ts` | same bytes as C++ |
| Data written by a newer schema | C++ tree decoder with the embedded `BinarySchema`; in TS, `compileSchema(decodeBinarySchema(embedded))` in the store process only (`new Function` is not allowed by the renderer CSP) | forward compatibility (`data.md` §5.8) |

---

## 3. Node model

### 3.1 Document layout

- **`0:0` DOCUMENT** is the root. It has no `parentIndex`. Document-level fields: `documentColorProfile` (new files `SRGB`), `thumbnailInfo` ("Set as thumbnail"), `annotationCategories` (Dev Mode), `librarySubscriptions` (libraries enabled in this file, §8).
- **Pages** are CANVAS children of `0:0`, ordered by `parentIndex.position`. A new file contains exactly three nodes:

  | GUID | Node | Fields |
  |---|---|---|
  | `0:0` | DOCUMENT "Document" | `documentColorProfile: SRGB` |
  | `0:1` | CANVAS "Page 1", position `"!"` | `backgroundColor {0.9607843, 0.9607843, 0.9607843, 1}` (#F5F5F5, Figma's default), `backgroundOpacity 1`, `backgroundEnabled true` |
  | `0:2` | CANVAS "Internal Only Canvas", position `"~"` | `internalOnly true`, `visible false` |

- **The Internal Only Canvas `0:2`** (Figma's name and layout, observed in every sample) holds what is not on a page: local styles, variable collections and variables, read-only library copies, and soft-deleted main components. The UI never lists or draws it. Its children are ordered by `parentIndex.position` like any other, but the UI orders styles, collections and variables by their `sortPosition` (§10.5).
- Page dividers are CANVAS nodes named `---` with `isPageDivider true`.

### 3.2 Node kinds

| UI name | `type` | Distinguishing fields |
|---|---|---|
| Page | CANVAS | child of `0:0`; `backgroundColor/Opacity/Enabled`, `guides`, `prototypeDevice`, `prototypeBackgroundColor`, `variableModeBySetMap` |
| Frame | FRAME | `frameMaskDisabled` (true = Clip content off), auto layout and grid fields, `layoutGrids` |
| Group | FRAME | `resizeToFit true`, no paints or effects of its own (Figma's encoding, verified in `structure.fig`). DesignerV2 never writes `GROUP`; it is import-only. Answers `engine.md` §14 Q1 point 2. |
| Section | SECTION | `sectionContentsHidden`, `sectionStatusInfo` (Dev Mode "Ready for dev") |
| Component | SYMBOL | `componentPropDefs` (standalone component), `key`, `isSymbolPublishable`, `description`, `symbolLinks` |
| Component set | FRAME | `isStateGroup true`, `componentPropDefs` (all of the set's properties), `stateGroupPropertyValueOrders`, dashed purple stroke written as ordinary `strokePaints`/`dashPattern`; children are SYMBOL variants |
| Variant | SYMBOL child of a component set | `variantPropSpecs [{propDefId, value}]`; name `Prop=Value, Prop2=Value` |
| Instance | INSTANCE | `symbolData`, `componentPropAssignments`, `derivedSymbolData` (§5) |
| Slot | FRAME inside a component | `isSlot true` (§5.6) |
| Slot content | FRAME child of an INSTANCE | `isSlotContent true` (§5.6) |
| Rectangle | ROUNDED_RECTANGLE | corner fields. `RECTANGLE` is import-only (mapped to ROUNDED_RECTANGLE). |
| Ellipse | ELLIPSE | `arcData` (radians; `innerRadius` 0..1) |
| Line | LINE | `size.y = 0`; strokes; caps |
| Polygon / Star | REGULAR_POLYGON / STAR | `count`; STAR `starInnerScale` |
| Vector | VECTOR | `vectorData {vectorNetworkBlob, normalizedSize, styleOverrideTable}`, `handleMirroring` |
| Boolean | BOOLEAN_OPERATION | `booleanOperation`; its children are the operands |
| Text | TEXT | `textData` and the text fields (§7) |
| Slice | SLICE | `exportSettings` |
| Color / Effect / Layout guide style | ROUNDED_RECTANGLE under `0:2` | `styleType FILL / EFFECT / GRID` + `fillPaints` / `effects` / `layoutGrids` |
| Text style | TEXT under `0:2` | `styleType TEXT` + font fields; `textData.characters "Ag"` |
| Collection | VARIABLE_SET under `0:2` | `variableSetModes`, `sortPosition` |
| Variable | VARIABLE under `0:2` | `variableSetID`, `variableResolvedType`, `variableDataValues`, `variableScopes`, `codeSyntax`, `sortPosition` |

**Type conversions** keep the GUID (so prototype links and references survive) and are written as an update carrying the new `type`. Only these exist: FRAME → SYMBOL (Create component), INSTANCE → FRAME (Detach instance, §5.7), any shape or BOOLEAN_OPERATION or TEXT → VECTOR (Flatten, Outline stroke, Outline text when it keeps one node). Everything else is REMOVED + CREATED.

### 3.3 Geometry conventions

- `transform` is the 2×3 matrix `[m00 m01 m02; m10 m11 m12]` **relative to the direct parent**, groups and boolean operations included (verified in `structure.fig`). `size` is the unrotated box. Rotation and flips live only in `transform`.
- All numbers are kiwi `float` (32-bit), as in Figma. Panels round for display.
- `Color` components are 0..1, gamma-encoded in the document's color profile (sRGB or Display P3), not linear.
- Child order: ascending `position` = back to front (index 0 is the bottom layer, as in Figma's API). The layers panel shows the reverse.
- **Layout results are stored.** For real nodes, the engine writes the laid-out `size` and `transform` (auto layout, grid, hug, fill, text auto-resize, groups) into the same commit that caused them (`engine.md` §3.3–3.4). Loading trusts the stored geometry. Only instance sublayers' layout is `@derived`.

### 3.4 Absence and defaults

A field that is absent means its kiwi zero value (`false`, `0`, `""`, empty, the enum's 0 value, no message), except where `@default` says otherwise. Tools that create nodes write Figma's per-tool defaults explicitly in the CREATED change (a new text layer writes `textAutoResize WIDTH_AND_HEIGHT`, a new frame writes its white fill, and so on); `@default` is only the meaning of absence.

| Field | Absence means | Why |
|---|---|---|
| `visible` | `true` | |
| `opacity` | `1` | |
| `transform` | identity | |
| `miterLimit` | `4` | |
| `stackPrimarySizing` | `RESIZE_TO_FIT_WITH_IMPLICIT_SIZE` (Hug) | Figma files write `FIXED` explicitly and omit Hug (1,073 vs 1,753 in the SDS file) |
| `stackChildAlignSelf` | `AUTO` (follow the parent's counter alignment) | only `STRETCH` is ever written in Figma files |
| `fontName` | `{Inter, Regular, Inter-Regular}` | Figma's default text |
| `fontSize` | `12` | |
| `lineHeight` | `{100, PERCENT}` = Auto | §7 |
| `letterSpacing` | `{0, PERCENT}` | |
| `isPublishable`, `isSymbolPublishable` | `true` | false = "Hide when publishing" |
| `backgroundOpacity` | `1` | |
| `Paint.opacity` / `.visible` / `.blendMode` / `.transform` / `.scale` | `1` / `true` / `NORMAL` / identity / `1` | |
| `Effect.visible` / `.blendMode` | `true` / `NORMAL` | |
| `LayoutGrid.visible` | `true` | |
| `ExportSettings.constraint` | `{CONTENT_SCALE, 1}` | |
| `SymbolData.uniformScaleFactor` | `1` | |
| `variableScopes` | `[ALL_SCOPES]` | an explicitly **empty** list means "shown in no picker" (SDS hides its primitives this way) |
| `variableModeBySetMap` entry for a collection | Auto (inherit) | §6.4 |

Other conventions: `minSize`/`maxSize` axis value `0` means no limit on that axis. Figma's "none" GUID sentinel `4294967295:4294967295` (seen on `overrideKey`) is never written by DesignerV2; absence means none, and import converts the sentinel to absence.

### 3.5 References are authoritative

Four kinds of reference, one rule: **the reference is the truth; the node's own field holds the resolved value as a cache** that the engine keeps current with system writes in the same commit (`engine.md` §3.3 step 3), so a viewer, the store or an exporter can read a file without resolving anything.

| Reference | Authoritative | Resolved copy | Detach writes |
|---|---|---|---|
| Color/effect/grid/text style | `styleIdFor{Fill,StrokeFill,Effect,Grid,Text}` | `fillPaints`, `strokePaints`, `effects`, `layoutGrids`, text fields (§6.5) | clear the `styleIdFor*`; the copy stays |
| Variable | `parameterConsumptionMap` entry, `Paint.colorVar/opacityVar/stopsVar`, `Effect.*Var`, `LayoutGrid.*Var` | the bound field (`stackSpacing`, `Paint.color`, …) | clear the binding; the copy stays |
| Component property | `PROP_REF` entry in a sublayer's `parameterConsumptionMap` (§5.5) | materialized sublayer (derived, not stored) | n/a |
| Main component | `symbolData.symbolID` | INSTANCE root fields (materialized) and `derivedSymbolData` | Detach instance (§5.7) |

---

## 4. Changes: the property-patch model

### 4.1 Message kinds

| Kind | `sessionID` | `nodeChanges` | `blobs` | Extra |
|---|---|---|---|---|
| Snapshot (file, version, compaction output) | 0 | every live node, `phase CREATED`, DOCUMENT first, then parents before children (pre-order, children by position) | every geometry blob referenced, dense | no `@derived` |
| Preview/viewer snapshot | 0 | as a snapshot | as a snapshot | `@derived` included; `derivedDataVersion` set |
| Change (one committed transaction) | the session | the changed nodes only (§4.2) | blobs referenced by this Message | `sentTimestamp` optional |
| Clipboard | the session | the copied nodes as CREATED, with their source GUIDs, plus the main components and styles/variables they reference from `0:2` | geometry blobs, and every image inline (`Image.dataBlob`) so the payload is self-contained | `pasteID`, `pasteFileKey`, `pasteOffset`, `pastePageId`, `isCut`, `clipboardSelectionRegions` |

`ackID` is 0 in every DesignerV2 Message; the journal sequence lives in the frame header (`data.md` §5.2).

### 4.2 A NodeChange inside a change Message

1. **Update** (`phase` absent). The node must exist. Every field present replaces the node's value for that top-level field **wholesale** (arrays and messages included: `fillPaints`, `textData`, `symbolData` are each one value). Every id in `clearedFields` makes that field absent. A field must not be both set and cleared in one NodeChange. `clearedFields` must not contain `guid`, `phase`, `parentIndex`, `type`, `guidPath`, or `clearedFields`.
2. **Create** (`phase CREATED`). The NodeChange carries the node's complete state; absent fields are absent (§3.4). `type` and `parentIndex` are required (except `0:0`). A producer never emits CREATED for a live GUID; a consumer that sees one treats it as REMOVED followed by CREATED (full replace).
3. **Remove** (`phase REMOVED`). Only `guid` and `phase`. A REMOVED for an unknown GUID is ignored. **Removing a subtree sends a REMOVED for every node in it**, children first (`engine.md` §9.1); nobody infers descendants. This makes journal frames, Firestore deletes and tombstones explicit.
4. **Order inside a Message**: CREATED parents come before their children, REMOVED children before their parents. Consumers still apply a Message as one unit and resolve hierarchy at the end of it (orphans are parked, `engine.md` §2.4).
5. **Never in a change Message**: `@derived` fields, sublayers of instances (they are not nodes), `guidPath` at top level.

`clearedFields` is per NodeChange, so it also works inside override entries during editing in memory, but **persisted** `symbolOverrides` entries never carry it: an override edit rewrites the whole `symbolData` (§5.2).

### 4.3 Apply algorithm (engine `scene/Apply`, store `merge.ts`)

```
apply(message):
  for nc in message.nodeChanges (in order):
    if nc.phase == REMOVED:  delete node nc.guid if present
    elif nc.phase == CREATED: if present, delete it; create node from nc (all carried fields)
    else:                    if node absent: report and skip
                             for each carried field f (not guid/phase/clearedFields): node[f] = nc[f]
                             for each id in nc.clearedFields: delete node[id]
  rebase @blob indices of carried values into the receiver's blob table (dedupe by SHA-1)
  resolve hierarchy (parents, order, cycles, orphans)
```

This is exactly the "generic merge" of `data.md` §5.5: the store can compact, diff, restore and sync without the engine, because nothing in a change depends on deeper merge rules.

### 4.4 Undo

- The engine records, for the first write of each `(node, field)` in a transaction, the previous value or "was absent" (`engine.md` §9.1).
- The **inverse** of an update sets each written field back to its old value, or lists it in `clearedFields` if it was absent; a field that was cleared gets its old value back. The inverse of CREATED is REMOVED; the inverse of REMOVED is CREATED with the node's full previous state (all non-derived fields). Inverses are emitted in reverse order, so re-created parents come before their children.
- An undo applies the inverse as a new transaction whose own inverse is the redo batch. Its forward Message is an ordinary change for storage (`kind = undo`). Undo modifies history; it never rewinds the journal.
- System writes (layout, resolved copies) recorded during the transaction are part of its inverse, so undo restores geometry exactly.

### 4.5 Journal, snapshot, engine stream

- **Engine → host**: after each commit the engine emits `DOCUMENT_CHANGED {bytes, kind, label}` where `bytes` is one change Message (`engine.md` §9.1). The store appends it as one journal frame (`data.md` §5.4). Panels do not decode it to render; they read resolved values through the engine API.
- **Host → engine**: `engine_load(snapshot Message)` then `engine_apply_changes(frame Message)` for each journal frame in order (`data.md` §5.6), and later for remote changes (`APPLY_REMOTE`, not undoable).
- **Compaction** = the apply algorithm over snapshot + frames, emitted as a new snapshot (`data.md` §5.5).
- Patches never travel TS → engine as raw NodeChanges; panels call typed engine functions (`engine.md` §10), and the engine produces the NodeChanges.

### 4.6 Validation (engine rejects a user transaction, parks incoming changes)

- A node cannot become its own ancestor. CANVAS only under DOCUMENT; DOCUMENT has no parent; VARIABLE and VARIABLE_SET only under a CANVAS with `internalOnly`; style nodes only under `internalOnly` (`engine.md` §2.4).
- `symbolOverrides` entries contain no `@nooverride` field; the root entry (empty path) contains no `@own` field.
- `parameterConsumptionMap` has at most one entry per `VariableField` (a field is bound to at most one parameter, Figma's 2025 rule).
- A VARIABLE's `variableDataValues` has one entry per mode of its collection; a missing entry falls back to the default mode's value.
- An alias never forms a cycle and never points at itself.

---

## 5. Components and instances

### 5.1 `overrideKey` and `guidPath`

- Every node inside a SYMBOL subtree has an **effective override key** = `overrideKey` if set, else its own `guid`. Effective keys are unique within one SYMBOL subtree (not globally).
- **Copying a whole component subtree keeps the effective keys**: duplicate component, paste, library copies, Move to this file (`engine.md` §2.5). Variants made by duplication therefore share keys, which is what lets overrides survive a variant switch. Copying nodes *into* an existing component keeps the key unless it already exists in that subtree; then the copy gets none (its own GUID becomes its key).
- A **`guidPath`** is the list of effective keys from an instance down to a sublayer, crossing nested instances: `[A]` is the component's node A; `[A, B]` is node B inside the nested instance A. **An empty path (`guids` absent or `[]`) is the instance root itself.** (Figma writes the root as `[symbolID]`; import maps it to the empty path.) Frames between are **not** in the path: a text inside a frame of the component is `[text]`, as Figma writes it (the engine wrote tree paths `[frame, text]` until 2026-10-08; it normalizes them at load). `derivedSymbolData` entries use the same paths (Figma's list starts with the root as `[symbolID]`, and lists only the sublayers whose geometry differs from the main's).
- **Derived sublayer ids** (string form for TS keys, selection, `engine.md` §2.5): `"I" + instance GUID + (";" + key)*`, e.g. `I12:34;5:6;7:8`. A real node is `"12:34"`. Derived ids are never stored in a document.

### 5.2 The INSTANCE node

- `symbolData` is **one property**: `{symbolID, symbolOverrides[], uniformScaleFactor}`. An override edit, a reset, a swap or a variant switch rewrites the whole value. This answers `engine.md` §14 Q1 point 3 and `data.md` open question 1: overrides are coarse for LWW, as in Figma; finer LWW, if ever needed, is a Firestore field-codec change (§11.2), not a schema change.
- `symbolID` is the main component: a local SYMBOL or a library copy under `0:2` (always by GUID in the same file).
- `symbolOverrides[]` holds one sparse NodeChange per overridden node, keyed by `guidPath`, holding only the overridden fields. **The root's overrides are the entry with the empty path** (a resize writes `size` and the sizing mode there; a rename writes `name` there).
- **The INSTANCE node's own fields are the materialized effective values of the root** (resolved copy, §3.5), written by the engine as system writes, plus its `@own` fields, which are only ever the instance's: position (`parentIndex`, `transform`), constraints, `locked`, its child-in-parent layout (`stackChild*`, `stackPositioning`, grid placement), `scrollBehavior`, `prototypeStartingPoint`, `symbolData`, `componentPropAssignments`.
- **Sublayers are never stored.** The engine materializes them (Materializer, `engine.md` §3.3) and caches their layout and geometry in `derivedSymbolData` (`@derived`, one entry per path, root excluded).
- **Reset all changes** = `symbolOverrides` reduced to nothing and `componentPropAssignments` cleared; the engine then re-materializes the root fields. **Reset › property** removes that field from the entries that hold it.

### 5.3 Precedence

For a sublayer at path P of instance I, the effective value of field f is the first of:
1. a `PROP_REF` binding of f in the main's node, resolved through the instance's `componentPropAssignments` (or the def's default) — bound fields are never overridden directly; editing them writes the assignment;
2. `I.symbolData.symbolOverrides[P].f` (usage-site overrides win, Figma's rule);
3. for P inside a nested instance N (P = [N, …rest]), N's own overrides in the component definition for `rest`;
4. the main component node's own value;
5. the default (§3.4);
then variables bound on the result are resolved for the sublayer's modes (§6.4).

### 5.4 What can be overridden

Everything not tagged `@nooverride`. Observed in Figma's SDS file overrides: `size`, `name`, `visible`, `opacity`, `fillPaints`, `strokePaints`, `strokeCap`, `effects`, text fields and `textData`, `styleIdForText`/`styleIdForEffect`, variable bindings, `variableModeBySetMap`, `componentPropAssignments` (nested instance properties), `overriddenSymbolID` (nested instance swap), `prototypeInteractions`, `annotations`, corner radii, `minSize`/`maxSize`, `stackPrimarySizing`, `stackCounterSizing`, alignments, `stackChildPrimaryGrow`, `stackChildAlignSelf`, `stackPositioning`, `proportionsConstrained`, `textAutoResize`. Not overridable (structure): `transform`, constraints, `stackMode`, `stackWrap`, grid tracks and placement, `vectorData`, `booleanOperation`, `mask`, `resizeToFit`, and all definition, publishing and page fields.

### 5.5 Component properties

- **Definitions** live in `componentPropDefs` of a standalone SYMBOL, or of the **component set FRAME** for a set (all of the set's properties, VARIANT ones included). Variant SYMBOLs carry no defs of their own. Types: `BOOL`, `TEXT`, `INSTANCE_SWAP`, `VARIANT`, `SLOT`. `initialValue` is the default; `preferredValues.instanceSwapValues` list preferred components by key; `slotPropConfig` holds slot settings. The API name of a non-variant property is `name + "#" + id` (Figma's `#id` suffix).
- **Bindings** of a sublayer field to a property are **`PROP_REF` entries** in that sublayer's `parameterConsumptionMap`: `{variableField: VISIBLE | TEXT_DATA | OVERRIDDEN_SYMBOL_ID | SLOT_CONTENT_ID, variableData: {dataType: PROP_REF, resolvedDataType: BOOLEAN | TEXT_DATA | SYMBOL_ID | SLOT_CONTENT_ID, value: {propRefValue: {defId}}}}`. This is Figma's 2025 unified parameter store (observed in SDS: 1,785 such entries). Figma's older duplicate `componentPropRefs` is not kept; import converts it.
- **Assignments** on an instance: `componentPropAssignments [{defID, value | varValue}]`; for a nested instance they are an override (`componentPropAssignments` in its entry). `varValue` binds the property value to a variable.
- **Variants**: a variant SYMBOL's `variantPropSpecs` give its value for each VARIANT def; `stateGroupPropertyValueOrders` give the value order in the UI; the default variant is the top-left one (computed, not stored). An instance points at one variant (`symbolID`); switching variant rewrites `symbolID` and keeps overrides whose paths exist in the target (shared keys, §5.1), then falls back to Figma's name-and-hierarchy heuristic (`docs/research/figma/R4-components.md` §3).
- **Exposed nested instances**: `propsAreBubbled true` on the nested INSTANCE node inside the component.

### 5.6 Slots (decided here; Figma's file encoding of slots is unverified)

- The slot is a FRAME inside the component with `isSlot true` and a `PROP_REF` entry `SLOT_CONTENT_ID → {defId}` of a `SLOT` def.
- By default an instance shows the main's slot children (derived).
- When the user edits a slot in an instance, the engine creates a **real** FRAME with `isSlotContent true`, `parentIndex.guid` = the top-level INSTANCE, holding real children (copies of the defaults plus the user's layers), and writes the assignment `{defID, value: {guidValue: <that frame>}}` (an override entry for a nested instance's slot). The slot sublayer renders those children. "Reset slot" clears the assignment and removes the content frame and its subtree.
- An INSTANCE therefore may have real children, but only `isSlotContent` frames, and they are drawn only inside their slot.
- **Figma's own encoding (verified 2026-10-08 on a private file with 806 slot fields):** the slot layer in the main carries only the `PROP_REF SLOT_CONTENT_ID` binding (no `isSlot`); the instance's assignment is `{defID, value: {}, varValue: {dataType: SLOT_CONTENT_ID, resolvedDataType: SLOT_CONTENT_ID, value: {slotContentIdValue: {guid: <content>}}}}` (`VariableAnyValue.slotContentIdValue = 18`, kept since round 4); the content FRAME (`isSlotContent`) sits under the **Internal Only Canvas `0:2`**, not under the instance. Its bound values are resolved — and stored by Figma — in the modes of the slot that shows it (the instance's slot row and up), which the engine follows (engine.md §3.4 as built, round 4). The engine reads both forms and writes its own (above): a `.fig` import moves the content frame under its instance (keeping `varValue` and adding `guidValue`), and a load moves Figma-form content still under the internal canvas the same way (`adoptSlotContent`); the content is drawn in its slot and resolved in that slot's modes.

### 5.7 Detach, delete, restore

- **Detach instance**: the INSTANCE node becomes a FRAME (same GUID, `type` update), `symbolData`/`componentPropAssignments`/`derivedSymbolData` cleared, every effective field written explicitly, `detachedSymbolId {guid: main}` set, and each sublayer CREATED as a real node with a new GUID. Detaching a nested instance detaches its ancestors first (Figma's rule). A `.fig` names a library main it was detached from by key, `detachedSymbolId {assetRef: {key, version}}`; that form is kept as it is.
- **Deleting a main component that has instances** moves it under `0:2` with `isSoftDeleted true` and `ancestorPathBeforeDeletion` = its former ancestors. Instances keep working. **Restore component** moves it back. When the file is next opened for editing, the engine removes soft-deleted components that no instance uses (a `SYSTEM` change) — components only, and never one that was published (the next publish lists it as Removed, §8.1): soft-deleted variables, collections and styles stay (Figma's `deletedButReferenced`: aliases, bindings and explicit modes still name them).

---

## 6. Variables, modes, styles

### 6.1 Collections, modes, variables

- A collection is a VARIABLE_SET under `0:2`: `name`, `variableSetModes [{id, name, sortPosition}]` (≥ 1; **the default mode is the first by `sortPosition`**), `sortPosition` (order in the collection list), `isPublishable` (a name starting with `_` or `.` also hides it), `key`, `description`.
- A variable is a VARIABLE under `0:2`: `name` (slash path = groups), `variableSetID {guid}`, `variableResolvedType` (`BOOLEAN`, `FLOAT`, `STRING`, `COLOR`; `EASING`/`TIMING` are `@later`), `variableDataValues [{modeID, variableData}]`, `variableScopes`, `codeSyntax [{platform: WEB|ANDROID|iOS, value}]`, `description`, `isPublishable` (false = Hide from publishing), `sortPosition` (order within the collection), `key`.
- A deleted variable that is still referenced stays with `isSoftDeleted true` (REST's `deletedButReferenced`).
- Limits are enforced by the UI, not the schema: 5,000 variables per collection, 40 modes, mode names ≤ 40 chars (`R3` §2).

### 6.2 Values (`VariableData {value, dataType, resolvedDataType}`)

| Value | `dataType` | `value` |
|---|---|---|
| literal | `BOOLEAN`, `FLOAT`, `STRING`, `COLOR` | `boolValue`, `floatValue`, `textValue`, `colorValue` |
| alias | `ALIAS` | `alias {guid}` (a VARIABLE in this file, local or library copy); `resolvedDataType` = the target's type |
| composed color ("Control opacity at scale", 2026-09) | `EXPRESSION`, resolved `COLOR` | `expressionValue {COMPOSE_COLOR, [color (COLOR literal or alias), opacity (FLOAT literal or alias)]}`. Inferred from Figma's Aug-2026 schema (`ExpressionFunction.COMPOSE_COLOR = 20`); see Open questions. |
| font style | `FONT_STYLE` | `fontStyleValue {asString (STRING alias) \| asFloat (FLOAT alias, weight) \| asVariations}`; used for the `FONT_STYLE` binding (observed in SDS) |
| prototype expression | `EXPRESSION` | `expressionValue {function, arguments[]}`: `+ − × ÷`, comparisons, `AND OR NOT`, `STRINGIFY`, `TERNARY`, `NEGATE`, … (the engine evaluates them in bindings too) |
| a boolean bound to visibility | `EXPRESSION`, resolved `BOOLEAN` | `expressionValue {IS_TRUTHY, [alias]}` — how Figma's files hold **every** boolean bound to `VISIBLE` (125 of 125 in the owner's file; none as a bare alias); the engine writes the same and still reads a bare alias |
| a variant bound to variables | `EXPRESSION`, resolved `SYMBOL_ID` | `expressionValue {RESOLVE_VARIANT, [{dataType MAP, resolvedDataType MAP, value: {mapValue: {values: [{key: property name, guidKey: the VARIANT ComponentPropDef id, value: alias to a STRING / FLOAT / BOOLEAN variable}]}}}]}` on the `VARIANT_PROPERTIES` entry (Figma's files, 21 in the owner's file, on the instance node and in override entries) |
| component property reference | `PROP_REF` | `propRefValue {defId}` (§5.5) |
| property values | `TEXT_DATA`, `SYMBOL_ID` | `textDataValue`, `symbolIdValue` (in `ComponentPropAssignment.varValue`, `ComponentPropDef.varValue`) |

### 6.3 Bindings

- Node fields: `parameterConsumptionMap.entries [{variableField, variableData}]`, one entry per `VariableField`. The 33 bindable fields and their `VariableField` are the `@bind` tags (`WIDTH:x`/`HEIGHT:y` on `size`, `MIN_*`/`MAX_*` on `minSize`/`maxSize`, `FONT_FAMILY:family`/`FONT_STYLE:style` on `fontName`, paddings, gaps, radii, stroke weights, `OPACITY`, `VISIBLE`, `TEXT_DATA`, typography, `HYPERLINK`, `OVERRIDDEN_SYMBOL_ID`).
- Paint level: `Paint.colorVar` (alias or COMPOSE_COLOR), `Paint.opacityVar`, `Paint.stopsVar[]`. Effect level: `Effect.colorVar/radiusVar/spreadVar/xVar/yVar`. Layout guides: `LayoutGrid.*Var`. Text ranges: entries inside `styleOverrideTable` runs. Component property values: `ComponentPropAssignment.varValue`.
- `VARIANT_PROPERTIES` is a node-field entry of an INSTANCE (or an override entry of a nested one): RESOLVE_VARIANT above. Its resolved value is the instance's `symbolData.symbolID` (a nested one: the derived row's main) — the variant whose values for the bound properties equal the variables' values in the instance's modes (numbers as text, booleans as `true` / `false`, case-insensitive when nothing matches exactly), keeping the most of the other values; none matching keeps the current variant. A variant picked by hand detaches that property's entry.
- `SLOT_CONTENT_ID` is bound through component property assignments. A component property **default** bound to a variable is `ComponentPropDef.varValue` = an alias (BOOL: a BOOLEAN variable, TEXT: a STRING one — Figma's "Apply variable" in the property's settings); an assignment's `varValue` alias likewise (resolved, not offered in the UI: Figma says boolean variables can't be applied to boolean properties of instances). Every other `varValue` (Figma mirrors each value there) is kept as it came.
- `GRID_ROW_GAP` / `GRID_COLUMN_GAP` write `gridRowGap` / `gridColumnGap` (unmodelled fields the grid layout reads).

### 6.4 Explicit modes and resolution

- `variableModeBySetMap.entries [{variableSetID {guid}, variableModeID}]` on any node, pages included. No entry for a collection = **Auto**.
- The mode of collection C for node n is the nearest ancestor-or-self (page included, then the instance chain for derived nodes) with an entry for C, else C's default mode. An alias resolves with the consumer's mode **for each collection along the chain** (Figma's `resolveForConsumer`), depth ≤ 16; a cycle or a missing target is unresolved, and the field keeps its stored (last resolved) value.
- The prototype action "Set variable mode" changes runtime state in the player only; it never writes the document.
- **One mode value per collection** (Figma): a node's entry for an extended collection's mode is its **root** collection's entry with `variableSetExtensionID` = the extended collection and `variableModeID` = that collection's mode (§6.6).

### 6.6 Extended collections (Figma's "Extend collection", R3-32/33)

- An extended collection is a VARIABLE_SET whose `variableSetModes` each carry `parentVariableSetId` (the collection it extends) and `parentModeId` (that collection's mode it inherits; its own `id` is fresh). It has no variables of its own: it inherits its parent's (and so its root's) variables, names, scopes and order; its modes follow the parent's (a mode added to the parent appears in it, renames follow; a mode whose parent mode is gone stays, Figma's `removeMode` rule).
- Its values: one **VARIABLE_OVERRIDE** node per overridden variable, a **child of the extended collection** (so it travels in the collection's library payload and versionHash): `overriddenVariableId` (the root collection's variable), `variableSetID` (the extended collection), `variableResolvedType`, `variableDataValues` (entries for the extended collection's modes it overrides only).
- Resolution of variable V of root collection R for a node whose entry for R names extension E and mode m: E's override of V for m, else E's parent's for m's `parentModeId`, up the chain to V's own value (a missing parent mode: the default).
- Inferred, not read from a Figma file (no sample has one): that Figma's VARIABLE_OVERRIDE uses these two fields (`backingVariableId` 378, `backingVariableSetId` 377, `rootVariableKey` 386, `inheritedVariableIds` 517 and `isCollectionExtendable` 385 also exist in Figma's schema and are not kept); that the override sits under its collection.

### 6.5 Styles

- Style nodes live under `0:2` with `styleType`, `name` (slash path = folders), `description`, `sortPosition`, `key`, `isPublishable`. Styles may contain variable bindings; styles never reference styles.
- A consumer references a style with `styleIdForFill` (→ `fillPaints`), `styleIdForStrokeFill` (→ `strokePaints`), `styleIdForEffect` (→ `effects`), `styleIdForGrid` (→ `layoutGrids`), `styleIdForText` (→ the text-style fields: `fontName, fontSize, lineHeight, letterSpacing, paragraphSpacing, paragraphIndent, listSpacing, textCase, textDecoration*, leadingTrim, hangingPunctuation, hangingList, fontVariations, toggledOn/OffOTFeatures, fontVariant*, semanticWeight, semanticItalic`; never fills, alignment, resizing or truncation). A text run may set `isOverrideOverTextStyle true` to deviate from the node's text style.
- `StyleId` and the other `*Id` messages also have `assetRef {key, version}`. **DesignerV2 always references by `guid`** (library styles are local copies, §8.2); `assetRef` exists only so a `.fig` can be imported, and import resolves it to the local copy.

---

## 7. Text

- `textData` is one property: `characters`, `characterStyleIDs` (one style id per **UTF-16 code unit**; a shorter array means the rest are 0), `styleOverrideTable` (runs keyed by `styleID ≥ 1`), `lines` (one `TextLineData` per paragraph: list type, indentation, `listStartOffset`, direction). Paragraphs are separated by `\n`; U+2028 is a line break inside a paragraph. Typing replaces `textData` (one write per committed typing burst, `engine.md` §9.4).
- Node-level text fields are the base style (style id 0). Run fields allowed in `styleOverrideTable`: `fontName, fontSize, lineHeight, letterSpacing, textCase, textDecoration, textDecorationStyle, textDecorationFillPaints, textDecorationSkipInk, textUnderlineOffset, textDecorationThickness, fillPaints, styleIdForFill, styleIdForText, isOverrideOverTextStyle, hyperlink, fontVariations, toggledOnOTFeatures, toggledOffOTFeatures, fontVariant*, semanticWeight, semanticItalic, parameterConsumptionMap`.
- `lineHeight`: `{100, PERCENT}` = Auto (the font's own line height), `{k, RAW}` = k × font size (the UI shows 140% for RAW 1.4), `{v, PIXELS}` = v px. `letterSpacing`: `PERCENT` of the font size or `PIXELS`. (Inferred from SDS, which writes RAW 1.4 / 1.2 for its % styles and PERCENT 100 for Auto.)
- `derivedTextData` (`@derived`) is the layout result: baselines, glyphs (outline blob per glyph, in em units), decorations, font digests, truncation. It is what lets the preview viewer draw text without the fonts (`data.md` §13). `TextData.lines` is **source**, not layout.
- `autoRename true` keeps the layer name equal to the characters until the user renames it.
- Text-on-path (`TEXT_PATH`, `textPathStart`) is not in v1.

---

## 8. Library and publishing metadata

### 8.1 Local assets (in the library file)

Assets: SYMBOL, component set FRAME, style nodes, VARIABLE_SET, VARIABLE.
- `key`: 40 lowercase hex chars (160 random bits), stable for the asset's life. The engine writes it when the asset is created; assets imported from a `.fig` may lack one and get it at first publish or first reference (`data.md` §9.1). Duplicated assets get a new key. `InstanceSwapPreferredValue.key` and library diffs use it.
- `isPublishable` (styles, sets, collections, variables) / `isSymbolPublishable` (SYMBOL): false = Hide when publishing. Names starting with `.` or `_` are also hidden (Figma's rule, applied by the library code).
- `publishedVersion`: the asset's `versionHash` (40-hex SHA-1 of its canonical payload, `data.md` §9.1) at its last publish. The Publish dialog's "Modified" = current hash ≠ `publishedVersion`; "Removed" = a soft-deleted asset that has a `publishedVersion`.
- `description`, `symbolLinks` (documentation links), `libraryMoveInfo {oldKey, pasteFileKey}` on a pasted copy of a published component (Move to this file).

### 8.2 Library copies (in a consuming file)

- The file's enabled libraries: `DOCUMENT.librarySubscriptions [{libraryKey (the library's FileKey), name}]`. Removing a library removes its entry; used copies stay.
- A copy lives under `0:2` (a component set is copied whole), is read-only in the UI, and carries:
  - `sourceLibraryKey` = the library's FileKey;
  - `key` = the source asset's key;
  - `publishID` = the asset's GUID in the library file;
  - `version` = the `versionHash` it was copied at (all asset kinds; Figma's `sharedSymbolVersion` is mapped to `version`);
  - on every node of a copied component subtree, `overrideKey` = the library node's effective key (§5.1).
- Instances, aliases and style references point at copies by GUID. An update replaces the copy's nodes, matching them by `overrideKey`, in one undo batch; an update is available when the library's current `versionHash` for `key` ≠ `version`.

**Answer to `data.md` §9.4 "Needs from document contract"** (it asked for Figma's `sharedSymbolReference`, `sharedStyleReference`, `componentKey`): the schema keeps one uniform set for every asset kind instead. Mapping: `fileKey → sourceLibraryKey`, `symbolID → publishID`, `componentKey`/`styleKey → key`, `versionHash → version`, `libraryGUIDToSubscribingGUID →` the per-node `overrideKey` (a copy node's key is the library node's key, so the mapping is persistent and per node, which also suits per-property LWW). The store reads `(key, version)` of every node with `sourceLibraryKey`.

---

## 9. IDs

| Id | Format | Rules |
|---|---|---|
| GUID | `{sessionID: uint32, localID: uint32}`; string `"s:l"` (decimal), URL `s-l` | `sessionID` per edit session, allocated by the store (`data.md` §1: `(deviceOrdinal << 20) \| n`, persisted before the session starts). The engine allocates `localID` from 1 and is the **only** GUID allocator in an editor; TS asks the engine. |
| Reserved | `sessionID < 2^20` | `0:0` DOCUMENT, `0:1` first page, `0:2` Internal Only Canvas, pages made by Home, and GUIDs kept from a `.fig` import (`data.md` §11.1 remaps imported sessions ≥ 2^20). |
| Non-node GUIDs | same allocator | mode ids, `ComponentPropDef.id`, `Guide.guid`, `PrototypeInteraction.id`, grid track ids, annotation and category ids. They only need to be unique within the file. |
| Override key | a GUID (§5.1) | unique within one SYMBOL subtree |
| Derived node id | `"I12:34;5:6;7:8"` | §5.1; never stored |
| Path key (Firestore, maps) | keys joined by `;`, e.g. `"5:6;7:8"`; `""` = root | |
| Asset key | 40 lowercase hex | §8.1 |
| FileKey | 22 chars base62 | store (`data.md` §1); used in `sourceLibraryKey`, `pasteFileKey`, `LibrarySubscription.libraryKey`, `LibraryMoveInfo.pasteFileKey` |
| Image hash | 20-byte SHA-1 of the file bytes; hex lowercase in paths | §11.3 |

---

## 10. Fractional indexing

### 10.1 Alphabet and meaning

A position is a non-empty string over the 95 printable ASCII characters `0x20` (`' '` = digit 0) to `0x7E` (`'~'` = digit 94): the base-95 digits of a fraction in (0, 1), leading `0.` omitted (Figma's format, R2 §2). A position never ends with digit 0 (`' '`), so every fraction has one spelling. Order is plain byte-wise string comparison, which equals numeric order; ties (only possible after import or merge) are broken by GUID, `sessionID` then `localID`.

### 10.2 Reference algorithm

The engine's `base/FractionalIndex` and the TS twin must produce identical keys (`engine.md` §2.4); this is the reference.

```ts
const D = (s: string, i: number) => s.charCodeAt(i) - 32;
const C = (d: number) => String.fromCharCode(d + 32);
export type Bias = "LOW" | "MID" | "HIGH";

/** Shortest key k with lo < k < hi. lo = "" means 0; hi = null means 1. */
export function keyBetween(lo: string, hi: string | null, bias: Bias = "MID"): string {
  let out = "";
  for (let i = 0; ; i++) {
    const dl = i < lo.length ? D(lo, i) : 0;
    const dh = hi === null ? 95 : i < hi.length ? D(hi, i) : 0;
    if (dl === dh) {
      if (hi !== null && i >= lo.length && i >= hi.length) throw new Error("keyBetween: lo == hi");
      out += C(dl);
      continue;
    }
    if (dl > dh) throw new Error("keyBetween: lo > hi");
    if (dh - dl >= 2) return out + C(bias === "LOW" ? dl + 1 : bias === "HIGH" ? dh - 1 : (dl + dh) >> 1);
    out += C(dl);   // no digit fits here: keep lo's digit; everything after it is below hi
    hi = null;
  }
}

/** n keys strictly between lo and hi, ascending. */
export function keysBetween(lo: string, hi: string | null, n: number): string[] {
  if (n <= 0) return [];
  if (hi === null) { const r: string[] = []; let k = lo; for (let i = 0; i < n; i++) r.push(k = keyBetween(k, null, "LOW")); return r; }
  if (lo === "") { const r: string[] = []; let k = hi; for (let i = 0; i < n; i++) r.unshift(k = keyBetween("", k, "HIGH")); return r; }
  const left = (n - 1) >> 1, m = keyBetween(lo, hi, "MID");
  return [...keysBetween(lo, m, left), m, ...keysBetween(m, hi, n - 1 - left)];
}

/** Evenly spaced keys for n siblings, used by rebalancing. Integer arithmetic, exact below 2^53. */
export function rebalancedKeys(n: number): string[] {
  let L = 1; while (95 ** L < n + 1) L++;
  const P = 95 ** L, keys: string[] = [];
  for (let i = 1; i <= n; i++) {
    let v = Math.floor((i * P) / (n + 1)), k = "";
    for (let j = 0; j < L; j++) { k = C(v % 95) + k; v = Math.floor(v / 95); }
    keys.push(k.replace(/ +$/, ""));
  }
  return keys;
}
```

Which bias: **append** (after the last sibling) `keyBetween(last, null, "LOW")`; **prepend** `keyBetween("", first, "HIGH")`; **between two siblings** `"MID"`; **first child of an empty parent** `keyBetween("", null, "LOW")` = `"!"` (as Figma). Several nodes at once (paste, multi-move): `keysBetween`.

Test vectors (`engine/tests/data/fractional-index-vectors.txt` must contain at least these):

| Call | Result |
|---|---|
| `keyBetween("", null, LOW)` | `!` |
| `keyBetween("!", null, LOW)` | `"` |
| `keyBetween("~", null, LOW)` | `~!` |
| `keyBetween("", "!", HIGH)` | `␠~` (space, tilde) |
| `keyBetween("!", "#", MID)` | `"` |
| `keyBetween("!", "\"", MID)` | `!O` |
| `keyBetween("!", "!O", MID)` | `!7` |
| `rebalancedKeys(2)` | `?`, `_` |
| `rebalancedKeys(95)` first three | `␠~`, `!}`, `"\|` |

Measured: 3,000 consecutive appends reach 32 chars (one char per 94 appends); 20,000 random inserts stay ≤ 7 chars; inserting repeatedly into the same gap reaches 25 chars after 139 inserts.

### 10.3 Rebalancing

When a key the engine is about to write would be **longer than 24 characters**, it instead rewrites the `parentIndex` of every sibling in that list with `rebalancedKeys(n)` (order unchanged), **inside the same transaction**, so the writes join its change Message and undo batch. Rebalancing never happens on its own. Import and repair may also rebalance, as `SYSTEM` changes.

### 10.4 Pages

New pages are inserted among all children of `0:0`, the internal canvas (`"~"`) included, e.g. after the last page: `keyBetween(lastPage, "~", MID)`. Never use `keyBetween(x, null)` under `0:0`.

### 10.5 Other ordered lists using the same algorithm

`VariableSetMode.sortPosition` (mode columns), `NodeChange.sortPosition` (styles, collections, variables in their lists), `ComponentPropDef.sortPosition`, `PrototypeStartingPoint.position` (flows), `GUIDPositionMap` entries (grid tracks).

---

## 11. Storage mapping

### 11.1 Local files

The byte layouts are owned by `docs/data.md` §5; the schema-side rules are:
- **Snapshot** = Figma's `canvas.fig` layout: prelude `fig-kiwi`, `u32 DOCUMENT_FORMAT_VERSION` (= 1, §1.2), chunk 0 = raw-deflated `SCHEMA_BINARY` of the writer, chunk 1 = zstd (or raw deflate) of a snapshot Message (§4.1). Because the schema travels with the data, any later build can read it.
- **Journal frame** payload = one change Message, exactly as the engine emitted it. The frame header (not the Message) carries seq, session, batch, clock, kind and label.
- **Save Local Copy** = a ZIP with stored entries `canvas.fig` (the snapshot bytes), `meta.json`, `thumbnail.png`, `images/<sha1 hex>` (`data.md` §11.2), Figma's `.fig` layout.
- **Import** of Figma's `.fig`: decode with the file's own schema, then project by name exactly as tested (§1.1 point 5), plus these mappings: `componentPropRefs` → `PROP_REF` entries; `variableConsumptionMap` → used only when `parameterConsumptionMap` is absent; root override entries `[symbolID]` → empty path; variant-level `ComponentPropDef.parentPropDefId` → the set's def id in `PROP_REF`s and assignments; `sharedSymbolVersion` → `version` on copies; `symbolDescription`/`styleDescription` → `description`; `inherit*StyleID` (GUID) → `styleIdFor* {guid}`; `assetRef` references → the local copy's GUID; GUID sentinel `4294967295:4294967295` → absent; node types `GROUP` → FRAME + `resizeToFit`, `RECTANGLE` → ROUNDED_RECTANGLE; derived data dropped (recomputed); unknown node types dropped and counted.

### 11.2 Firestore and Storage

The codec and sync rules are owned by `docs/data.md` §12.4–12.5. The schema guarantees they rely on:
- `files/{fileKey}/nodes/{s:l}`: one document per node, **one field per top-level NodeChange field** (the field name is the schema name), because a top-level field is the unit of change (§4.2). `guid` is the document id; `phase` is never stored.
- An update sets the carried fields; `clearedFields` become `deleteField()`; REMOVED becomes a tombstone (`_del`); CREATED sets the whole document.
- `symbolData` is one field, so override LWW is per instance. If finer LWW is ever wanted, the codec can store `symbolOverrides` as a map keyed by the path key (§9) without changing the schema.
- `@derived` fields never reach Firestore. `@blob` fields and `byte[]` use the codec's `{"$b"}`/`{"$blob": sha1}` form; blobs and images go to Storage `blobs/{sha1}`.
- Size: with geometry in blobs, a node document stays far below 1 MiB except for very long `textData`; the codec spills (`data.md` §12.4).

### 11.3 Binary formats inside blobs (Figma's, verified on `structure.fig`)

- **Path commands** (`commandsBlob`): a sequence of `u8 opcode` followed by little-endian `f32` coordinates: `0` close (0 floats), `1` moveTo (2), `2` lineTo (2), `3` quadTo (4), `4` cubicTo (6). Coordinates are in the node's local space (glyphs: em units).
- **Vector network** (`vectorNetworkBlob`), all little-endian, coordinates in `normalizedSize` space:
  ```
  u32 vertexCount, u32 segmentCount, u32 regionCount
  vertex  × vertexCount:  u32 styleID, f32 x, f32 y                                     (12 bytes)
  segment × segmentCount: u32 styleID, u32 startVertex, f32 tangentStartX, f32 tangentStartY,
                          u32 endVertex, f32 tangentEndX, f32 tangentEndY               (28 bytes)
  region  × regionCount:  u32 (styleID << 1 | windingBit; 1 = NONZERO, 0 = ODD), u32 loopCount,
                          then per loop: u32 n, u32 segmentIndex × n
  ```
  `styleID` 0 = the node's own style; others key `VectorData.styleOverrideTable`.
- **Images** are not blobs: a paint stores `image.hash`, the 20-byte SHA-1 of the image file's bytes (PNG, JPEG, GIF, WebP); the bytes live in the content-addressed store (`blobs/<sha1>`, `data.md` §10) and in exports as `images/<hex>`. A hash that does not match its bytes on import is recomputed (`data.md` §11.1). `Image.dataBlob` is used only in clipboard Messages.

---

## 12. Prototyping

- `prototypeInteractions [{id, event, actions[], isDeleted}]` on any layer. `event`: trigger (`ON_CLICK`, `ON_HOVER`, `ON_PRESS`, `DRAG`, `AFTER_TIMEOUT` with `transitionTimeout`, `MOUSE_ENTER/LEAVE/DOWN/UP`, `ON_KEY_DOWN` with `keyTrigger`). Actions run top to bottom.
- Each `PrototypeAction` uses `connectionType`: `INTERNAL_NODE` with `navigationType` (`NAVIGATE`, `OVERLAY`, `SWAP`, `SWAP_STATE` = Change to, `SCROLL_TO`) and `transitionNodeID`; `URL` (`connectionURL`, `openUrlInNewTab`); `BACK`; `CLOSE`; `SET_VARIABLE` (`targetVariable {id}`, `targetVariableData`); `SET_VARIABLE_MODE` (`targetVariableSetID`, `targetVariableModeID`); `CONDITIONAL` (`conditionalActions [{condition, actions}]`, the last without a condition is Else). An expression's `variable:mode` is `VAR_MODE_LOOKUP` [ALIAS the variable, STRING the mode's id "s:l"] (the argument encoding is ours — Figma's isn't published). Animation: `transitionType`, `transitionDuration` (s), `easingType`, `easingFunction` (cubic or spring parameters), `transitionShouldSmartAnimate`, `transitionPreserveScroll`, `transitionResetScrollPosition`, `transitionResetInteractiveComponents`.
- As built (E8, docs/engine-build.md): the engine keeps all of these as unmodelled fields (kiwi bytes in `NodeProps::extra`) and reads them on demand (`engine/src/proto/Prototype`); panels read and write them as JSON with their schema names. `transitionDuration` and `transitionTimeout` are seconds.
- Video (round 6, Figma's numbers): triggers `ON_MEDIA_HIT` (12, `PrototypeEvent.mediaHitTime` 7, seconds) and `ON_MEDIA_END` (13) on a layer with a VIDEO fill; `connectionType UPDATE_MEDIA_RUNTIME` (6) with the video in `transitionNodeID` and `mediaAction` (16: `PLAY`, `PAUSE`, `TOGGLE_PLAY_PAUSE`, `MUTE`, `UNMUTE`, `TOGGLE_MUTE_UNMUTE`, `SKIP_FORWARD`, `SKIP_BACKWARD`, `SKIP_TO`; `SET_PLAYBACK_RATE` and `mediaPlaybackRate` 36 dropped), `mediaSkipToTime` (21) and `mediaSkipByAmount` (22) in seconds; `transitionResetVideoPosition` (17) = "Reset video state". Prototype › Video is the layer's `videoPlayback` (300: `autoplay`, `mediaLoop`, `muted`; `showControls`, `startTimeMs`, `endTimeMs` kept, unused); a video is a `Paint` of type `VIDEO` (7) whose `video.hash` (18) is the video file — a blob of the file's image store, counted as a reference like `Image.hash` (`imageHashes`, `messageImageHashes`) — and whose `image` is its poster frame.
- Flows: `prototypeStartingPoint {name, description, position}` on top-level frames. Page: `prototypeDevice`, `prototypeBackgroundColor`. Overlay settings on the destination frame: `overlayPositionType`, `overlayRelativePosition`, `overlayBackgroundInteraction`, `overlayBackgroundAppearance`. Scrolling: `scrollDirection` on frames, `scrollBehavior` on children.

---

## 13. What was dropped from Figma's schema

Dropped fields keep their numbers reserved (§1.2); dropped enum values are listed in comments next to their enum.

| Category | Examples |
|---|---|
| Multiplayer and server | `MessageType` other than `NODE_CHANGES`; `UserChange`, cursors, `SceneGraphQuery`, `DiffPayload`, broadcasts; `*Tag` fields (`guidTag`, `nameTag`…); `editInfo`, `userFacingVersion`, `overrideLevel`, `MultiplayerFieldVersion`, `editScopeInfo`; `Message.localUndoStack`, `stableSessionID`, `originFileKey` |
| FigJam, Slides, Buzz, Sites, Make, code, CMS, AI | node types STICKY…ANIMATION_PRESET_INSTANCE (§`NodeType` comment); connectors, tables, widgets, stamps, slide themes, responsive sets, code components/libraries, CMS bindings, managed strings, chat/AI threads, cookie banners, behaviors, keyframes/timelines, illustration modifiers (BRUSH nodes and brush strokes are kept since the text round: `BRUSH = 46` and the brush fields, drawn by the engine) |
| Plugins (plugin-free) | `pluginData`, `pluginRelaunchData`, `WidgetMetadata` |
| Legacy duplicates of kept concepts | `variableConsumptionMap` (→ `parameterConsumptionMap`), `componentPropRefs` (→ `PROP_REF`), `inherit*StyleID` (→ `styleIdFor*`), `symbolDescription`/`styleDescription` (→ `description`), `sharedSymbolReference`/`sharedStyleReference`/`componentKey`/`sharedSymbolVersion` (→ §8.2), `stackJustify/stackAlign/stackWidth/stackHeight/stackPadding` (→ current `stack*`), `textTracking` (→ `letterSpacing`), `maskIsOutline` (→ `maskType`), `RECTANGLE`/`GROUP` writing, `rectangleCornerToolIndependent`, `containerSupportsFillStrokeAndCorners` |
| Layout/derived version stamps | `textUserLayoutVersion`, `textExplicitLayoutVersion`, `textBidiVersion`, `fontVersion`, `layoutVersion`, `derivedSymbolDataLayoutVersion` (one `Message.derivedDataVersion` instead); text layout inside `TextData` (moved to `derivedTextData`, as Figma's newer files do) |
| Not in v1 Design scope | PATTERN, NOISE, EMOJI paints (VIDEO = 7 is kept since the text round: its poster frame draws); animated images; variable-width strokes (`variableWidthPoints` kept, not drawn); TEXT_PATH; transform groups; Motion fields beyond the `@later` easing values; accessibility/HTML tags; `exportBackgroundDisabled`; `targetAspectRatio`; `stackChildMargin*`; image `altText` |

---

## 14. Deltas against `docs/engine.md` and `docs/data.md`

These documents were written in parallel against an assumed schema. Where they differ, this schema decides; the other documents should be updated:

| Topic | They assume | Schema |
|---|---|---|
| Clearing a field | `clearedFields` | `clearedFields = 1000` (same name) |
| Groups | FRAME + `resizeToFit` | same |
| Instance overrides | one `symbolData` property? | **yes**, coarse (§5.2) |
| TS codec | `src/shared/schema/document.generated.ts` | same; it also carries the field registry and `SCHEMA_BINARY` (§2.2) |
| Property bindings in components | `componentPropRefs` (engine.md §2.2 Symbol facet, §3.3 step 2) | `PROP_REF` entries in `parameterConsumptionMap` (§5.5) |
| Library copy fields | `sharedSymbolReference`, `sharedStyleReference`, `componentKey` (engine.md §2.2, data.md §9.4) | `key`, `sourceLibraryKey`, `publishID`, `version`, per-node `overrideKey` (§8.2) |
| Variable bindings | `parameterConsumptionMap` and `variableConsumptionMap` (engine.md §2.2 Binding facet) | `parameterConsumptionMap` only |
| Style references | `styleIdFor*` and `inheritFillStyleID…` | `styleIdFor*` only |
| `textPathStart` | in the Vector facet | not in v1 |
| `TextData` layout parts | `glyphs, baselines, layoutSize, lines` are DERIVED_CACHE (engine.md §2.3) | layout lives only in `derivedTextData`; **`TextData.lines` is source** (paragraph list/indent data) and must be stored |
| `backgroundColor` | in the Frame facet | CANVAS only; frame backgrounds are `fillPaints` |
| CREATED for a live GUID | merged over the existing node (data.md §5.5) | full replace (§4.2.2); never emitted by the engine |
| Root overrides | `size` overridable "on the instance root only" | root overrides in the empty-path entry; root fields are materialized copies (§5.2) |

---

## Open questions

1. **Text index unit.** `characterStyleIDs` is taken to be per UTF-16 code unit (the Plugin API's range indices). No sample has non-BMP text with style runs; verify with a Figma file containing emoji plus styled runs.
2. **Line height encoding.** `{100, PERCENT}` = Auto and `{k, RAW}` = k × font size are inferred from SDS. Verify with a file whose text uses Auto, 150% and 24 px.
3. **Composed color variables.** A color variable whose value is "alias + opacity" is assumed to be `EXPRESSION COMPOSE_COLOR` (Aug-2026 schema). Verify with a file saved after 2026-09-03.
4. **Slots.** The `isSlotContent` content frame under the INSTANCE (§5.6) is our design built from Figma's field names (`isSlot`, `isSlotContent`, `SLOT_CONTENT_ID`, `slotPropConfig`). Verify against a real file that uses slots before import of such files is promised.
5. **`bordersTakeSpace`** is assumed to be "Strokes included in layout"; **`maxSize` 0 = no limit** is assumed. Verify both with a small Figma file.
6. **Override limits.** `stackMode`, `stackWrap`, grid tracks and grid placement are `@nooverride`; confirm in Figma's UI that they cannot be changed on an instance sublayer.
7. **`DOCUMENT_FORMAT_VERSION` in a `fig-kiwi` header** (`data.md` Q2): our exports carry version 1. Whether real Figma opens a Save Local Copy of ours is untested; if it requires a modern version number (Figma's are 20–106), exports could write Figma's number while our snapshots keep ours.
8. **Persisting derived data in the main document** (`engine.md` Q5): the schema allows `@derived` in any snapshot via `derivedDataVersion`; whether disk snapshots include it (faster first paint) is the engine's and the store's call.
