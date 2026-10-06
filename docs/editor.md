# The editor (Figma UI3 chrome around the engine)

`src/renderer/src/editor/` is the new file editor: Figma's UI3 chrome (rail, left panel with Pages and Layers, rulers, the engine canvas, the right Design panel, the bottom toolbar, menus) built from the design system (`src/renderer/src/ds/`) around the C++/Wasm engine (`src/renderer/src/engine/`). Contracts it follows: `docs/engine.md` §10 (binding), `docs/design-system.md` + `docs/design-system-usage.md` (look), `docs/schema.md` (field names), `docs/desktop.md` §13 (clipboard), `docs/research/figma/R7-editor.md` (behaviour), `docs/research/visual-diff.md` (measured metrics).

**Import rule (owner, 2026-10-06):** the editor imports only `src/renderer/src/ds/`, `src/renderer/src/engine/` and `src/shared/` (types). Nothing from the legacy folders (`figma/`, `cv/`, `home/`, `lib/`, `demo/`, `components/`, `context/`, `types/`, `tab/`), which are deleted in the next integration round. Theme: `ds/theme.ts` (`useThemeRoot`, `useTheme`), never `context/ThemeContext`.

---

## Status at handoff (2026-10-06)

The session was stopped early (owner's pause). **The foundation is written and tested; no UI is mounted yet.** `?editor` does not exist yet — opening it falls through to the normal shell. No screenshots were taken.

### Done (compiles, lints, tested)

| File | What it is | Tests |
|---|---|---|
| `editor/documentSource.ts` | The `DocumentSource` interface (below), `memoryDocumentSource(doc, {fileName, location, sessionID})` (keeps the snapshot and applies every change, exposes `snapshot()` and `changes`), `applyMessage` (schema.md §4.3 apply algorithm), `orderParentsFirst` | `__tests__/model.test.ts` |
| `editor/engineCompat.ts` | The adapter for engine features still landing: `hasCommand`, `runCommand`, `commandState` (feature-detect the name in `CommandId`), `pageArgs(guid)`, `canMoveNodes`/`moveNodes`, `canCopy`/`encodeSelection`, `canPaste`/`paste` (feature-detect the method on `Engine`), `supportsField(engine, field)` (does the engine keep a NodeChange field — read once from `readNode("0:0")`'s keys) | — |
| `editor/model/layerTree.ts` | Pure Layers logic: `treeFromNodes`, `visibleRows` (top layer first, indent per depth), `ancestorsOf`, `normalizeSelection`, `rangeSelection` (⇧-click), `toggleSelection` (⌘-click), `revealed` (expand ancestors of a canvas selection), `withSubtree` (⌥-click expand/collapse all), `selectionRuns` (LayerRow `run`), `dropZone`/`dropTarget` (before/after/inside → `{parent, index}` in paint order counted without the dragged layers, the `Engine.moveNodes` convention), `draggedLayers` | `__tests__/layerTree.test.ts` (14) |
| `editor/model/mixed.ts` | `mixed`, `mixedNumber` (panel precision), `sameData`, `mixedPaints` (→ `MIXED` from `ds/types`) | model.test.ts |
| `editor/model/geometry.ts` | Panel transform math: `rotationOf` (Figma: atan2(−m10, m00), CCW positive), `rotateBy`/`rotateTo`/`rotateAbout` (about the centre), `flip` (local) and `mirrorAbout` (canvas axes, Figma's flip), `boundsOf`, `unionBoxes`, `panelPosition`/`withPanelPosition` (X/Y from the nearest non-group ancestor), `multiply`, `invert` | model.test.ts |
| `editor/model/color.ts` | `colorToHex`, `hexToColor`, `toPercent`, `solidPaint`, `sameColor`, `luminance` | model.test.ts |
| `editor/model/clipboard.ts` | Clipboard formats (desktop.md §13): `encodeClipboard` → `application/x-designerv2-kiwi` (base64 Message), `text/html` envelope `(designerv2)…(/designerv2)`, `text/plain` (layer names); `decodeClipboard` (our type → HTML envelope → envelope in plain text); `plainTextOf`, base64 helpers | model.test.ts |
| `editor/model/rulers.ts` | `rulerStep(zoom)` (50 at 100%), `rulerTicks`, `toScreen`/`toValue` (screen = (origin + value)·zoom + camera offset), `rulerLabel`, `labelAlpha` (labels fade near the selection's edge labels: hidden < 44px, full at 84px — fitted to screenshot 3) | model.test.ts |
| `editor/uiStore.ts` | `Store<T>` (tiny external store) + `useStoreSlice`; `UIState` (fileName, railTab, leftWidth, rightWidth, rightTab, uiHidden ⌘\, uiMinimized ⇧\, rulers ⇧R, renaming, expanded, anchor, pageSearch, shortcutsOpen, propertyLabels) | — |
| `editor/controller.ts` | `EditorController`: engine + `EngineStore` + source + `ui` store; `getTree`/`subscribeTree` (Layers tree read level by level with `readNodes(…, {childIds})`, cached per page/structure/layout version); `setProps(refs, fields, label)` and `batch(label, fn)` (one undo step); `edit(label, info, write)` + `cancelEdit()` (DS `ChangeInfo` → one open `txnBegin` during a scrub, `txnCommit` on the final value, `txnCancel` on Esc); `setTool` (only tools the engine implements, probed once); `engineKey`; `EditorContext`/`useEditor` | — |
| `editor/hooks.ts` | `useUI(select)`, `useLayerTree()`, `usePages()` (re-read on pages or structure — renames are structure changes), `useNodes(refs)` (stable array), `useTopics(store, topics)` | — |
| `editor/commands.ts` | The command registry (~90 commands, Figma labels and keys): tools, Edit, View, Object, Arrange, Text (disabled until E3), File, help. `comboText` (DS `keys()` formatting), `matchesCombo`, `commandForKey`, `runEditorCommand`, `shortcutOf`, `isEnabled`. Engine commands go through engineCompat; `native` commands (⌘C ⌘X ⌘V ⇧⌘V) leave the key to the browser | — |
| `editor/actions.ts` | TS-side edits until the engine has commands: `flipSelection` (FLIP_* when present, else mirror about the selection's centre per parent), `rotateSelection` (Rotate 90°/180°), `zoomTo(ed, zoom)` (about the viewport centre); geometry reads: `groupChain`, `worldTransform`, `pageBounds`, `topLevelOf` | — |
| `editor/clipboardIO.ts` | DOM `copy`/`cut`/`paste` listeners (`attachClipboard`), `copyFromMenu` (execCommand, else async API with HTML + text), `pasteFromMenu` (execCommand, else `navigator.clipboard.read()` HTML, else the last copy in this tab); paste modes: normal, `inPlace` (⇧⌘V), `point` ("Paste here": paste, then move to the point, one undo step) | — |
| `editor/keyboard.ts` | The shortcut layer (`attachKeyboard(ed, canvas)`): keys on the canvas already went to the engine (CanvasController, created with `shortcuts: []`); keys elsewhere (Layers, body) go to `engine.key` first; then the registry. Skips fields, overlays, controls' own Enter/Space, anything `defaultPrevented`. `isEditable` | — |

### Partial

- `editor/EditorApp.module.css` — the layout's CSS (editor root, left/right panel shells, canvas area, help-button position, loading/error status). **No `EditorApp.tsx` uses it yet.**

### Not started

In this order of dependency (see "Next steps"):
- `editor/EditorApp.tsx` (default export, `{ source: DocumentSource }`) — mounts the engine (own mount, not `EngineCanvas`, because the shortcut table must be empty): `source.load()` → `Engine.create(canvas, {sessionID, theme})` → `engine.load(doc)` → `new EngineStore` → `new EditorController` → `new CanvasController(canvas, engine, { shortcuts: [] }).attach()` → `engine.onDocumentChanged((_, e) => source.onChanges(e.message))` → `attachKeyboard` → `attachClipboard` → `ZOOM_TO_FIT`; theme sync (`useThemeRoot()`, `engine.setTheme`); ⌘-wheel `preventDefault` on window (as Playground); `TooltipManager` + `ToastHost`; desktop hooks when `window.designer` exists (`tab.onRequest`: "is-dirty" → false, "save" → `source.flush()`; `menu.onCommand` for `edit.undo/redo/delete/select-all`; `tab.report({title})`).
- `editor/EditorRoute.tsx` + the `?editor` line in `src/renderer/src/main.tsx` (add `"./editor/EditorRoute.tsx"` to the `import.meta.glob` list and `if (params.has("editor")) return lazyOptional("./editor/EditorRoute.tsx");`). The route renders `<EditorApp source={memoryDocumentSource(SAMPLE_DOCUMENT, …)}/>`; `&doc=reference` should load a fixture matching the owner's screenshots (file "burakkoc" in "Drafts", pages Page 10 / New Page / burakkoc.net ( new ) / OXTV / Page 7 / theStudio / CV / Logolar, page colour 232323, one frame "Frame 1" 437×305 at (−34, 3), white fill).
- Rail + main menu, left panel (file header with menu and rename, Pages section, Layers panel), Assets placeholder, rulers, bottom toolbar, right panel (header, tabs, zoom menu) and every Design-panel section, canvas context menu, shortcuts dialog (⌃⇧?), minimized/hidden UI, the visual check script and screenshots.

### Engine APIs

- **Called directly** (exist today): `Engine.create/load/destroy/on/onDocumentChanged/readNodes/readNode({childIds})/setProps/txnBegin/txnCommit/txnCancel/command/commandState/undo/redo/getCamera/setCamera/setTool/pages/setCurrentPage/key/setTheme`, `EngineStore` (+ its topics), `CanvasController` + `modifiersOf`, `CommandId`/`TOOLS`/`Status`/`KEY_HANDLED`/`CMD_*` from `abi.ts`. Commands in `abi.ts` today: UNDO, REDO, SELECT_ALL/NONE/CHILDREN/PARENT/NEXT_SIBLING/PREV_SIBLING, DELETE, NUDGE, BRING_FORWARD, SEND_BACKWARD, BRING_TO_FRONT, SEND_TO_BACK, TOGGLE_LOCK, TOGGLE_VISIBLE, ZOOM_IN/OUT/TO_100/TO_FIT/TO_SELECTION.
- **Through `editor/engineCompat.ts`** (missing from the TS facade at handoff): commands GROUP, UNGROUP, FRAME_SELECTION, DUPLICATE, FLIP_HORIZONTAL, FLIP_VERTICAL, ALIGN_LEFT/HORIZONTAL_CENTER/RIGHT/TOP/VERTICAL_CENTER/BOTTOM, DISTRIBUTE_HORIZONTAL/VERTICAL, ADD_AUTO_LAYOUT, REMOVE_AUTO_LAYOUT, CREATE_PAGE, DELETE_PAGE, DUPLICATE_PAGE (and SELECT_INVERSE, not planned yet); methods `moveNodes`, `encodeSelection`, `paste`; field support (`supportsField`: stack*, effects, layoutGrids, exportSettings, proportionsConstrained, backgroundOpacity, blendMode…).
  - **At handoff the engine agent had added these ids to `engine/src/editor/Commands.h`** (GROUP 60, UNGROUP 61, FRAME_SELECTION 62, DUPLICATE 63, FLIP_HORIZONTAL 64, FLIP_VERTICAL 65, ALIGN_LEFT 70 … ALIGN_BOTTOM 75, DISTRIBUTE_HORIZONTAL 76, DISTRIBUTE_VERTICAL 77, ADD_AUTO_LAYOUT 80, REMOVE_AUTO_LAYOUT 81, CREATE_PAGE 90, DELETE_PAGE 91 `args {page}` (current page when absent), DUPLICATE_PAGE 92 `args {page}`) **but not yet to `abi.ts`**. Once `abi.ts` has them: replace `runCommand(engine, "X")` with `engine.command("X")` in `commands.ts`/`actions.ts`, and drop them from `PendingCommand`. Check how `{page}` is encoded (args are numbers today: `pageArgs()` sends `page`=localID, `pageSession`/`sessionID`/`localID` — adjust to the engine's choice).
- **Not available yet, so not used:** `engine_layer_rows` (the tree is built in TS), `engine_read_derived` (X/Y/rotation computed in TS: `panelPosition`, `rotationOf`), `engine_set_geometry` (W/H/rotation written as `size`/`transform`; W/H of groups can't scale children yet), `CONTEXT_MENU` event (the editor listens to `contextmenu` on the canvas; for an unselected hit it should send a synthetic left click so the engine's picking selects it), `engine_hit_test` returns one hit path (innermost first), not every overlapping layer.

### DS components still awaited

- **ColorPicker** (the fill/stroke swatch's popover): leave a clearly marked placeholder (`onSwatchClick` → nothing or a "Color picker comes with the design system" toast) until `ds/index.ts` exports it.
- **AlignmentMatrix** (3×3 auto-layout alignment): placeholder until exported.
- **The exact UI3 bottom Toolbar**: until it lands, compose the existing `Toolbar`/`ToolbarGroup`/`ToolButton`/`ToolbarDivider`/`HelpButton`.
- Re-check `ds/index.ts` first thing: the DS agent was adding all three at handoff.

### Known breakage

- `npm test`: 1 failure, **not in the editor** — `src/renderer/src/engine/__tests__/abi.test.ts › commands: abi.ts = Commands.h` (the engine agent's in-progress change: `Commands.h` updated, `abi.ts` not yet). Editor tests: 30/30 pass. `npm run typecheck` and `npm run lint`: clean.

### Next steps, in order

1. Re-read `ds/index.ts`, `engine/abi.ts`, `engine/Engine.ts`; switch engineCompat calls to direct ones where names now exist.
2. `EditorApp.tsx` + `EditorRoute.tsx` + the `?editor` route (above), with the reference fixture. Verify the engine loads in `npm run web:demo` → http://localhost:5199/?editor.
3. Layout shell per the metrics below: rail (Main menu → DS `ContextMenu` with Back to files, Quick actions…, File/Edit/View/Object/Text/Arrange submenus built from `commands.ts`), left panel 240 (DS `ResizeHandle`), canvas area, right panel 240, `HelpButton` (in `.help`), toolbar (offset `(rightWidth − (48 + leftWidth)) / 2` to centre on the window).
4. Left panel: file header (name + chevron menu: Rename via `source.rename`, Duplicate/Move/Version history/Delete disabled; "Minimize UI" icon), Pages (DS `PageRow`; search; + = CREATE_PAGE; double-click rename via `setProps([page], {name})`; context menu Rename/Duplicate/Delete; drag reorder = `moveNodes([page], "0:0", index)`), Layers (DS `VirtualList` + `LayerRow` with `model/layerTree.ts`; icons by type/auto layout; hover ↔ `engine.setHover` / `useHover`; click/⇧/⌘ selection; double-click and ⌘R rename; lock/eye via setProps `locked`/`visible`; drag with `dropTarget` → `moveNodes`; `revealed` on canvas selection + `scrollToIndex`).
5. Rulers: two 2D canvases redrawn on `store.subscribe("camera")` + selection + node changes + theme; colours from `canvasChrome.ruler*` (ds/tokens.ts), metrics from `canvasChromeMetrics.ruler`; origin = the selection's top-level frame corner (else 0); band + blue edge labels + `labelAlpha` fading.
6. Right panel: header (Avatar + chevron, Present ▸ menu, Share), `Tabs` Design/Prototype, zoom `MenuButton` (Zoom in/out/to fit/to selection/50%/100%/200%, Property labels). Design panel by selection: nothing → Page (CANVAS `backgroundColor`, show the effective colour — the engine draws `#1E1E1E` for the default `#F5F5F5` in dark), Styles (header + "+" only when there are no local styles), Export; selection → header (Frame ▾ presets / Rectangle / Ellipse / Group / Mixed), Position, Layout / Auto layout, Appearance, Fill, Stroke, Effects, Layout guide, Export — every edit via `ed.setProps`/`ed.edit` (scrubs) with `mixed*` for multi-selection and `onStep` deltas.
7. Bottom toolbar (tools the engine has enabled, the rest disabled), canvas context menu (Copy, Paste here, Copy/Paste as ▸, Bring to front…, Group/Frame selection/Ungroup, Show/Hide, Lock/Unlock, Flip, Add auto layout, Select layer ▸ from `hitTest`), shortcuts dialog, ⌘\ / ⇧\.
8. Visual check: a playwright-core script (like `scripts/engine-shot.mjs`: its own Vite server, SwiftShader Chromium, `page.emulateMedia({colorScheme})`) shooting nothing-selected / frame-selected / auto-layout states, light and dark, at 1512×945 into the session scratchpad `…/scratchpad/editor/`; compare region by region with the references (`…/images/1–4.webp`, 1 CSS px = 1.3228 image px).

---

## Structure

```
editor/
  EditorApp.tsx        (to write) the root: engine mount, layout, overlays
  EditorRoute.tsx      (to write) ?editor: EditorApp on memoryDocumentSource
  documentSource.ts    DocumentSource, memoryDocumentSource, applyMessage
  engineCompat.ts      feature-detected engine calls (shrinks as the engine grows)
  controller.ts        EditorController, EditorContext, readTree
  uiStore.ts           Store<T>, UIState
  hooks.ts             useUI, useLayerTree, usePages, useNodes, useTopics
  commands.ts          the command registry (menus, shortcuts, buttons)
  keyboard.ts          the shortcut layer
  clipboardIO.ts       DOM clipboard events
  actions.ts           TS edits (flip/rotate fallbacks, zoom), geometry reads
  model/               pure logic: layerTree, mixed, geometry, color, clipboard, rulers
  __tests__/           vitest for model/ and documentSource
```

## The DocumentSource interface

```ts
export interface DocumentSource {
  /** The file's name, as the left panel's header shows it ("burakkoc"). */
  readonly fileName: string;
  /** Where the file lives, under its name ("Drafts", a project's name). */
  readonly location: string;
  /** The session new nodes are created in (allocated by storage, docs/data.md §1); default 1. */
  readonly sessionID?: number;
  /** The document to open: a snapshot Message (DOCUMENT first, parents before children). */
  load(): Promise<Message>;
  /** One committed change (a NODE_CHANGES Message carrying only the touched fields), in commit order. */
  onChanges(changes: Message): void;
  /** Resolves once every change handed to `onChanges` is stored. */
  flush(): Promise<void>;
  /** The file was renamed from the file menu; absent: the name can't be changed here. */
  rename?(name: string): void | Promise<void>;
}
```

`memoryDocumentSource(doc, { fileName?, location?, sessionID? })` adds `snapshot(): Message` and `changes: readonly Message[]`. The store integration supplies its own source; nothing else in the editor changes.

## How panels bind to the engine

- **Reads**: `useSelection(store)` (engine/hooks) for the refs, `useNodes(refs)` for their fields (re-read only after NODES_CHANGED/DOCUMENT_CHANGED touched them, so canvas drags update the panel live), `useLayerTree()` for Layers, `usePages()`, `useCamera`/`store.subscribe("camera")` (rulers and the zoom %, imperatively — never React state per frame), `useHover`, `useTool`, `useUndoState`.
- **Writes**: always `setProps` (generic setter), as one labelled undo step (`ed.setProps(refs, fields, label)` / `ed.batch`). Gestures from DS fields (`ChangeInfo.final === false` while scrubbing) go through `ed.edit(label, info, write)`: one open transaction, committed with the final value; `onCancel` → `ed.cancelEdit()`. Multi-selection edits that differ per node (X, rotation, `onStep` deltas) write each node inside one `batch`.
- **Mixed**: derived in TS from every selected node (`model/mixed.ts`).
- **Fields the engine doesn't keep yet**: `supportsField()` — the control shows disabled instead of writing into the void (`engine_set_props` answers E_INVALID when no known field is left).

## Keyboard

`CanvasController` gets `shortcuts: []`; `keyboard.ts` is the only table. Order: field / menu / dialog → engine (`engine.key`, which handles Space, Esc, arrows, Enter, ⇧Enter, Tab, ⇧Tab) → `commands.ts`. ⌘C ⌘X ⌘V ⇧⌘V are not prevented, so the browser (and the app menu's Edit roles) fire DOM clipboard events; ⇧⌘V sets `pendingPaste = {mode: "inPlace"}` first.

## Measured layout (references `images/1–4.webp`, 1 CSS px = 1.3228 image px)

- Rail 48 (Figma menu, separator, File, Assets, +, briefcase, separator, settings); left panel 240: header 64 (name 13/22 550 + chevron, "Drafts" below; Minimize-UI icon right), Pages header 40 (search, +), page rows 32 pitch with a 24 highlight inset 8, Layers header 40, layer list starts 8 below the header, rows 24.
- Rulers 20 (top and left, over the canvas); at 100% a label every 50; with a frame selected the ruler's 0 moves to its corner, the band is drawn in `rulerSelectionBand`, edge labels in `rulerSelectionText` outside the band, neighbouring labels faded/hidden.
- Right panel 240: header 48 (avatar + chevron at 16; Present ▸ + chevron; Share 55×32 ending 8 from the edge), tabs row 32 (Design active, Prototype; "100% ⌄" right), divider at 80. Sections: header 40 (title at 16, actions in the 24 column 8 from the right), fields 88/88 + 24 action column; fill rows: field 156, then eye and minus (24 each, 4 apart).
- Toolbar 48, radius 13, 12 from the bottom, centred on the window; help button 32, centred with the toolbar (20 from the bottom), 24 from the right edge of the window (over the right panel).

## Gaps (by design, until the engine or DS has them)

Text (E3: frame titles and the size badge's text on canvas, the Text menu), effects/layout guides/export storage until the engine keeps those fields, image paste, components (E6), prototype tab content, Quick actions (⌘K), group resize from the panel, constraints UI, the pages-panel height splitter.
