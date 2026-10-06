# Editor interactions and editor state — DesignerV2 (read-only map)

All paths are relative to `src/renderer/src/` unless they start with `src/`. Line numbers are from the files as read on 2026-10-06.

## 1. Files and roles

| File | Lines | Role |
|---|---|---|
| figma/FigmaEditor.tsx | 2527 | The editor shell for one open file: holds all UI/editor state, every command (edit ops, clipboard, menus, keys), the left/right sidebars, toolbar, overlays. One React component plus `ViewedCanvas`. |
| figma/Canvas.tsx | 1594 | The canvas: DOM world under a CSS transform, the overlay ("lines") layer, all pointer gestures (pan, move, resize, draw, marquee, layout handles), wheel zoom, snapping, measurement, rulers, prototype noodles host. |
| figma/view.ts | 69 | `CanvasTool`, `CanvasView`, zoom math (`zoomAround`, `fitView`), and an external `ViewStore`. |
| figma/useView.ts | 5 | `useSyncExternalStore` over a `ViewStore`. |
| figma/picking.ts | 75 | Hit path from DOM (`pathAt`), Figma-style depth picking (`pickFrom`), text glyph hit/underline helpers. |
| figma/dom.ts | 37 | `domRect` (a node's rect read from the canvas DOM), `rectOf`, `isTyping`, `IS_MAC`. |
| figma/Layers.tsx | 335 | Layers tree (UI3 rows), selection gestures, rename, lock/hide, drag reorder. |
| figma/Rulers.tsx | 89 | Two `<canvas>` rulers with tick steps and selection span. |
| figma/Noodles.tsx | 192 | Prototype connections (SVG curves), connect handle, retarget, flow-start badges. |
| figma/Player.tsx | 270 | Present mode: renders frames with the site's `PageView`, navigation stack, transitions incl. Smart animate. |
| figma/FindPanel.tsx | 312 | Find / Replace in names and text, this page / all pages, kind filters. |
| figma/ImagesPanel.tsx | 311 | Firebase Storage bucket browser (used / all / unused), upload, delete, put to use. |
| figma/popover.tsx | 125 | `usePopover`, `popoverStyle`, `VariablePicker` (site variables). |
| figma/chrome.tsx | 122 | NavTab, SaveButton, SaveProblem, PublishButton, AccountButton, ModeTab, Tool, ZoomPercent. |
| figma/ui.tsx | 464 | UI3 primitives: Section, PropRow, IconButton, NumericInput (scrub + arithmetic), Switch, TextInput, Select, ChevronMenu, Checkbox, Tab, Chit, ColorInput, CollapseHeader, BrandButton, EDITOR_CSS. |
| figma/ColorPicker.tsx | 340 | UI3 colour picker (HSV square, hue/alpha, eyedropper, hex, gradient/image fill, document colours, Libraries = site variables). |
| figma/SettingsWindow.tsx | 62 | Modal with 3 mouse settings. |
| figma/VersionsWindow.tsx | 68 | Modal listing Firestore project versions, restore. |
| figma/settings.ts | 45 | `useEditorSettings` (localStorage). |
| components/admin/ContextMenu.tsx | 227 | UI3 dark context menu with submenus, keyboard nav, `keys()` shortcut formatter. |
| components/admin/useUndo.ts | 75 | Generic snapshot undo with time coalescing (used by figma/session.ts and the CV editor). |
| components/admin/figmaIcons.tsx | 175 | `FigmaIcon`/`fi` + ~84 hand-made/kit icons. |
| components/admin/figmaKitIcons.ts | 137 | ~121 UI3 kit icons as path data. |
| components/admin/JsonEditor.tsx | 156 | JSON textarea editor — used only by `cv/CVEditor.tsx:16,954`. |

Context read outside scope to explain state/undo: `figma/session.ts` (state + undo + save), `tab/EditorTab.tsx` (mounts the editor), `figma/model.ts` (tree helpers), `src/main/menu.ts` (app menu).

## 2. Where editor state lives

### 2.1 Document state (outside the editor)
- `useEditSession` (figma/session.ts:79) owns `edit: { state: EditState; currentPage?: string }` (session.ts:81). `EditState` = `{ file, variables, deletedVariables, textStyles, deletedTextStyles, deletedComponents }` (figma/designSystem.ts:15-22). Variables / text styles / library components are the site's shared design system, carried in the same undoable state.
- The editor receives `doc` = `{...state.file, currentPage}` (session.ts:157) and writes through `onDoc(update)` (session.ts:144-156). `onDoc` strips `currentPage` (page navigation is not an undo step) and silently refuses any change that breaks the site's Overview (`keepsOverview`, session.ts:152; `update` does the same at 139).
- `FigmaDocument` (figma/model.ts:569-591): `nodes` = the FIRST page's top-level nodes, `pageId` = the site page frame, `pages?: DocumentPage[]` = every other page (model.ts:424-429), `currentPage`, `effectStyles`, `languages`, `libraryVersion`, `fromLegacy`. The Components page is a page with id `p-components` (figma/library.ts:28).
- Scene nodes are plain immutable objects (`SceneNode = FrameNode | ShapeNode | TextNode`, model.ts:421; types `frame|rectangle|ellipse|line|text|component|componentSet|instance`, model.ts:16). No group, vector, boolean, section, polygon/star types. Tree helpers rebuild arrays along the path (`updateNode` model.ts:761, `insertNode` 798, `removeNodes` 786); lookups use a WeakMap index per array (model.ts:731-758).

### 2.2 Editor-local state (FigmaEditor.tsx, ~26 `useState` + ~11 `useRef`)
- Selection: `selection: string[]` (191), validated into `selected` (500) — ids are node ids or composite ids `instanceId/name›path` for layers inside instances (504-516, Layers.tsx:254).
- Text editing: `editing: string | null` (225) + `editingCtx` (1388-1408).
- Tool: `tool: CanvasTool` (216); `CanvasTool = move|hand|frame|rectangle|ellipse|line|text` (view.ts:7).
- Views: two `ViewStore`s, canvas `{x:120,y:80,zoom:0.5}` and page (212-215) — external stores so wheel ticks re-render only the canvas (view.ts:42-69, `ViewedCanvas` 2522-2525).
- Modes: `pickedMode` canvas/page/code persisted in localStorage (145-151, 193-196, 208); component isolation `{id,page}` (204-207).
- Panels: leftTab/rightTab (217, 223), expanded rows `open: Set` (224), Find `query` (282), `menu` (226), `minimized` Hide UI (227, 254-264), `panelWidths` persisted (250-253, 265-280), `previewing` (228), `reactionOpen` (230), `variablesOpen` (231), `previewWidth` (233), `notice` toast (235-240), `versionsOpen` (241), `settingsOpen` (244), `imagesOpened` (246), `layoutFocus` (248), `renamingPage` (373), `rulers` (1873), `langPicked` (187).
- Refs: `clipboard` (283), `propsClipboard` (1852), `zoomActions` (284), `libraryReturn` (222), `viewBefore` (404), `editedPage` (357-360), `latest` snapshot (526-529), `actions` (1875-1878), `placeRef`/`putImageRef` (1809, 1845).
- Per-user preferences: `figma-editor-mode`, `figma-panel-widths`, `figma-editor-settings` in localStorage (151, 164, settings.ts:18).

### 2.3 Canvas-local state (Canvas.tsx, ~14 `useState`)
`space` (175), `dragging` kind (176), layout handle hover/drag/edit (178-180), `marquee` (181), `drawRect` (182), `guides` (183), `drop` (185), `size` (186), `pageHeight` (197), `shown` overlay geometry (212), `alt` (216), `copying` (227); refs `ghosts`, `hovered`, `latest`, `remeasure`, `rightPress`, `zoomSettle`.

## 3. How FigmaEditor.tsx is split (one 2.5k-line component)

| Lines | Responsibility |
|---|---|
| 1-100 | imports (model helpers, site libs) |
| 102-171 | helpers/constants: `pictureIn`, Overview predicates, `EditorMode`, preview widths, `CLIPBOARD_MARK`, embed kinds, `TEXT_ONLY/GEOMETRY_ONLY/FRAME_ONLY` |
| 173-529 | state; derived `doc` for current page / isolation (289-294); `isRoot`/`stays`/`removable`/`fromIndex` (297-309); `createsCycle` (318-353); `setNodes` page router (362-371); pages + switchPage (372-400); isolation (402-447); `openNode` (453-466); `setMode` (468-479); page add/rename/remove (480-497); selection (499-518) |
| 531-855 | edit commands: patch, override, typeInInstance, delete, duplicate, copy, paste, pasteFrom, group/frame/auto, ungroup, createComponent(s), detach, addVariant, combineAsVariants |
| 856-1230 | `ops: EditorOps` (~375 lines) for the Inspector: patchMany, align, setAutoLayout, overrides, swap, selectMatching, variants/properties, languages, reactions, background, fitToContent, distribute, tidy, effect/text/colour styles, export, lockProportions, mask, replaceColor… |
| 1232-1287 | Present target; noodle callbacks connect/retarget/openConnection |
| 1289-1409 | canvas callbacks: onMove, onReparent, onReorder, onResize, onDraw, onDoubleClick; text editing ctx; RenderContext |
| 1411-1444 | layers tree move, z-order reorder |
| 1446-1657 | menus: instanceActions, nodeMenu (context menu), shellMenu (main menu), zoomMenu, headerMenu |
| 1659-1872 | pasteAt, pasteToReplace, copyAs, moveToPage, maskWith, addMotion, autoLayout, flip, image placing, putImage, copy/paste properties |
| 1873-2082 | rulers flag, `actions` ref, clipboard events, ⌘S, the keyboard handler (~165 lines) |
| 2084-2152 | Assets: insertInstance, insertEmbed; layer list; Find pages |
| 2155-2519 | JSX: nav bar, left sidebar (Find, Pages, Layers, Assets, Images), canvas column (isolation bar, Hide-UI bars, notices, canvas, Code placeholder, toolbar), right sidebar (account, present, save/publish, Design/Prototype, Inspector), modals, Player |

Canvas.tsx split: props (41-94) → Page Editor view math (96-115) → `Measure` (128-150) → `World` memo (160-169) → state/refs (171-241) → coordinate helpers (243-279) → zoom-settle will-change (281-298) → overlay measurement rAF loop (300-423) → wheel (425-489) → page keys (491-506) → zoom actions (508-551) → space=hand (553-566) → `follow` drag helper (568-602) → pan / right-button pan (616-657) → snap targets, frameUnder, indexIn, `startMove` (659-874) → `startResize` (876-944) → `startDraw` (946-987) → `startMarquee` (989-1039) → pointer/dblclick/label handlers (1041-1089) → noodle target finder (1091-1118) → derived overlay + layout handles + scrollbar (1119-1307) → JSX (1309-1589).

## 4. Mechanisms

### 4.1 Rendering model the interactions sit on
- Nodes are DOM elements (`NodeView`) inside `World` (Canvas.tsx:160-169) under `translate()` + `scale()` (1358-1359). Each element has `data-node-id` (and `data-node-type`).
- Overlay lines are drawn in screen space from DOM measurements: a perpetual rAF loop (322-423) that re-measures when `remeasure` is flagged (every render, pointermove, wheel, keydown, pointerup: 302-320) or every 250 ms, collects selection boxes, hover box, text underlines, parent outline, frame labels, measurement, copy-origin boxes, auto-layout kid rects, noodle links/flows, and `setShown` only if `JSON.stringify` differs (415-419).
- Zoom crispness hack: `will-change: transform` while zoom changes, removed 150 ms later (285-298). Zoom is read back from a 1000px probe span (152-153, 272-279; dom.ts:13-15).

### 4.2 Tools
- Union `move|hand|frame|rectangle|ellipse|line|text` (view.ts:7); draw tools set (Canvas.tsx:39).
- Toolbar (FigmaEditor.tsx:2430-2459): Move/Hand split button, Frame, Rectangle/Ellipse/Line split + Place image, Text, Create component, Present, then Page Editor widths and the Canvas/Page/Code view tabs.
- Drawing (`startDraw` Canvas.tsx:946-987): into the innermost unlocked frame/component under the press (`frameUnder` 675-697); ⇧ squares / snaps line angle to 45° (961-969); a click (<3 screen px) makes 100×100 (976, 983); into auto layout at the pointer's flow index (978). `onDraw` builds the node (FigmaEditor.tsx:1346-1369): line from signed vector → length + rotation (1350-1356); text by click = auto-width, by drag = fixed width/auto height (1349); returns to Move (1366) and text enters editing (1368).
- Hand: `H`, Space held (Canvas.tsx:553-566), middle button (1045), optional right-button drag (628-657).
- Not present: pen/pencil/vector, polygon/star/arrow, section, slice, comment, scale (K), eyedropper tool, zoom tool.

### 4.3 Selection model
- Click picking: `pathAt` walks DOM ancestors with `data-node-id`, drops a text hit outside its glyph rects, truncates at the first locked node (picking.ts:34-46). `pickFrom` (picking.ts:54-68): ⌘/Ctrl = innermost; otherwise the innermost layer whose parent is "open" (selected or an ancestor of a selected layer); default = a top-level frame's direct child (`path[1]`).
- Press on a top-level frame's own empty area (not its children) or empty canvas → marquee; a click there selects the frame / clears (Canvas.tsx:1051-1054, 1026-1033).
- ⇧-click toggles (Canvas.tsx:1055-1058; frame labels 1081-1085) without starting a drag.
- Double-click: acts on what the second press picked (1065-1075) → `onDoubleClick` (FigmaEditor.tsx:1370-1385): text → edit; layer in instance → select (edit if text); otherwise select.
- Keys: Esc (tool→Move, end isolation, select parent, else clear) 1959-1967; Enter (frame → its LAST child, text → edit) 1968-1978; ⇧Enter parent 1970-1973; Tab/⇧Tab next/prev sibling 1980-1987; ⌘A siblings of first selected (or top level) 2021-2025; ⌥⌘A select matching (same name+type, incl. inside instances) 1002-1022.
- Marquee (`startMarquee` 990-1039): live selection while dragging; skips hidden/locked; a top-level container only partly covered "opens" and contributes its children; started inside a top-level frame it selects that frame's direct children; ⇧ additive.
- Layers: click, ⌘/Ctrl toggle, ⇧ range over visible rows (Layers.tsx:315-329); press on empty panel clears (318).
- Context menu "Select layer" submenu with ancestor chain (FigmaEditor.tsx:1573); Inspector header menu of ancestors (1651-1657).
- Feedback: hover 2px box (Canvas.tsx:1403-1405), text hover/selection = glyph underline (341-357, 1399-1402), faint parent outline (1396-1398), purple for components/instances (picking.ts:71-75, Canvas.tsx:1135-1136), dashed multi-selection bounds (1414-1416), W×H badge (1566-1569), "N Variants" + Add-variant button for a set (1545-1565), top-level frame name labels that select/drag (1380-1395, 1078-1089), `data-layer-selected` attribute on selected elements (219-225).

### 4.4 Transforms
- Move (`startMove` 716-874): 3px threshold (778); preview by setting `style.translate` on elements (730-737) — the model is written once on release; ⇧ axis lock (801); ⌥ at any time switches to copy-drag with cloned DOM ghosts (725-769, 804) → `onMove(..., copy)` / `onReparent(..., copy)`; single-node drag finds a drop frame under the pointer, draws its box and an insertion line for auto layout (807-828); on release: reorder within same auto-layout parent (851-859), plain move (861), or reparent with coordinates relative to the target's own box (863-865). Multi-selection always moves within own parents (867-871). Locked or the Page Editor's page cannot move (721). FigmaEditor: `onMove` (1290-1306), `onReparent` keeps fill sizing only inside auto layout and refuses cycles / Overview moves / leaving isolation (1307-1320), `onReorder` (1321-1328).
- Resize (`startResize` 876-944): single selection only (`resizable`, 1137), 8 handles (37-38, 1519-1528). Pointer delta is projected into the node's own (rotated, flipped) axes (883-907); ⌥ from centre, ⇧ on corners or `lockAspect` keep ratio (908-920); min 1px (0 for line height) (921-922). Preview written into element style; model once on release (895-897, 939-942). `onResize` (FigmaEditor.tsx:1329-1345): in auto layout only w/h; resets Fill/Hug to Fixed on changed axes; text switches textAutoResize.
- Rotate: no canvas handle; only Inspector field / Rotate 90° (Inspector.tsx:560-563). Flip ⇧H/⇧V (FigmaEditor.tsx:1765-1769, 2047).
- Arrows nudge 1 / ⇧10 on topmost unlocked selected (1989-1998).
- Auto layout padding/gap handles on canvas: hover strips, drag (⌥ = both sides, ⇧⌥ = all), click to type (Canvas.tsx:1138-1262, 1433-1518), preview in DOM style, model once.

### 4.5 Snapping, smart guides, measurement
- Snapping only for a single moved node, only to other TOP-LEVEL nodes' left/centre/right and top/middle/bottom (snapTargets 660-672, 770-772), threshold 6 screen px (783), disabled while ⌥ (782). Guides are full-viewport 1px magenta lines (1426-1432). No snapping for resize, draw, multi-selection, siblings inside frames, spacing/equal gaps, layout grids, or pixel grid beyond `Math.round`.
- Measurement (`Measure` 128-150): red outline + gap lines with labels between two non-overlapping boxes; shown for ⌥ + one selected + hover (363) and during copy-drag ghost vs original (358-362). No distances to parent edges.
- Rulers (Rulers.tsx): canvas-2D ticks with step from [1..5000] ≥ 60px (14-15), selection span shaded and its ends labelled (32-71). No draggable guides.
- Pixel grid at ≥800% (Canvas.tsx:1346-1356). Zoom range 0.02–256 (view.ts:23-25).

### 4.6 Undo / redo
- `useUndo` (components/admin/useUndo.ts:11-73): keeps `past/future` arrays of whole `EditState` snapshots (structural sharing from immutable updates). A new step starts only if > `pause` (600 ms) since the last change (33-39); `limit` 20 (14). Change detection is shallow per key of the state object (31-32). Undo/redo call `restore` (52, 65) which replaces `edit.state` (session.ts:161).
- Consequences: edits are grouped by time, not by gesture/transaction; selection, current page and view are not part of history; design-system changes (variables, text styles, shared components) are undone together with file edits.
- Keys: ⌘Z / ⇧⌘Z / ⌘Y in the editor key handler, working even over dialogs (FigmaEditor.tsx:1925-1926); not while typing in a field (1921 → native field undo). Menu items Undo/Redo in context and main menus (1525-1526, 1624-1625). The Electron Edit menu uses roles only (src/main/menu.ts:56-69).

### 4.7 Clipboard
- Internal `clipboard` ref + system clipboard as `text/plain` `"figma-layers:" + JSON` (FigmaEditor.tsx:157, 626-635). Copy/cut/paste are driven by document `copy`/`cut`/`paste` events gated by `ours()` (not typing, no preview, no dialog/menu open, no DOM text selection) (1879-1904).
- `pasteFrom` (658-678): our JSON → layers; an image file → uploaded to Storage then placed (669-670, 1789-1798); plain text → new text node. `paste` (647-656) targets the selected frame/component, else the selection's parent, else the insert root; keeps original x/y. `copyOf` turns a main component into an instance (641-646). Paste here at pointer (1661-1677), Paste to replace ⇧⌘R (1679-1693), Copy as CSS/SVG/PNG (1694-1708), Copy/Paste properties ⌥⌘C/⌥⌘V (1852-1872). ⌘D duplicate (596-623; a variant duplicates as a new variant; a main component as an instance below).

### 4.8 Layers panel (Layers.tsx)
- Rows front-first (reverse of children) (263), 24px indent per level (138), instance children resolved from the main with overrides and shown purple with composite ids (252-257).
- Expand/collapse; ⌥-click chevron expands/collapses the whole subtree (284-296); Collapse all button (FigmaEditor.tsx:2257).
- Rename: double-click row (125) or ⌘R via a custom DOM event (58-63, FigmaEditor.tsx:2051); not for fixed/Overview layers or instance children (103, 125). Variant rows rename as `Prop=Value, ...` with validation (FigmaEditor.tsx:1460-1467).
- Lock/eye toggles on hover, pinned when set (165-174); hide inside an instance writes a visibility override (FigmaEditor.tsx:2278-2288); lock not offered inside instances (166).
- Drag reorder: single row, 4px threshold, drop before (<30%), after (>70% or non-frame), inside (frames) (217-249) → `moveInTree` (FigmaEditor.tsx:1412-1433) with cycle check and "front first" index flip (1428-1430).
- Hover row outlines the canvas node via `data-layer-hover` (53-56, 122-123); double-click icon zooms to layer (149; FigmaEditor.tsx:2276); selected row scrolled into view (FigmaEditor.tsx:520-524).

### 4.9 Pages
- Page list = first page (`id ""`, `file.nodes`) + `file.pages`, Components page hidden from the list and exposed as the "Components" nav tab (FigmaEditor.tsx:372, 219-220, 2228). Add (480-487), rename by double-click/context (488-492, 2234-2239), delete via context menu, first page undeletable, no confirm (493-497, 2235). Switch clears selection/editing/isolation (385-390); only the Components page remembers the previous view (391-398). Move to page (1710-1726). Per-page background (1118-1122). No page reorder, duplicate or per-page view/selection memory.

### 4.10 Prototype noodles and Player
- Prototype tab turns on noodle collection in the overlay loop (Canvas.tsx:396-414) and renders `Noodles` (1529-1543).
- Noodles.tsx: bezier from facing sides with arrowhead (30-59); click curve or label opens the interaction (120, 144-154); drag an end to retarget or drop off to delete (125, 85-105); `+` handle on selection's right edge to create (177-189); flow-start badges with play (158-175).
- Connect semantics (FigmaEditor.tsx:1256-1273): to another variant of the same set → `change` + smart animate; to a top-level frame → `navigate` instant; first connection on the page sets `flowStart: "Flow 1"` on the source's top-level frame. Valid targets: variants of the same set or top-level frames other than the source's (Canvas.tsx:1098-1118). Context menu "Add motion" adds click/hover/press → next variant (FigmaEditor.tsx:1746-1756).
- Player.tsx: stack navigation (85-102), actions navigate/back/scroll/url (104-124), transitions dissolve/move-in/out/push/slide-in/out/smart animate (layer matching by name path, Web Animations) (127-210); Esc closes, R restarts, flow dropdown (212-264). Frames are drawn with the site's `PageView` (7, 251).

### 4.11 Keyboard shortcuts implemented
Editor handler FigmaEditor.tsx:1918-2082 (window keydown; skipped while typing, in Present, or when a menu is open; after undo/redo, skipped when a dialog is open):
- ⌘Z undo, ⇧⌘Z / ⌘Y redo (1925-1926); ⌘S save (capture listener, 1906-1917).
- Blocks browser ⌘R, ⌘[, ⌘], ⌘←/→, ⌥←/→ defaults (1928-1929).
- Esc, Enter, ⇧Enter, Tab, ⇧Tab, Backspace/Delete, arrows ±1 / ⇧ ±10 (1959-1998).
- ⌘+ / ⌘- zoom ×2 / ÷2 (2001); ⇧0 100%, ⇧1 fit all, ⇧2 fit selection (2002-2008); ⌘\ Hide UI (2009); ⇧R rulers (2010).
- ⌘D duplicate (2013); ⌥⌘C / ⌥⌘V copy/paste properties (2014-2015); ⌘, settings (2018); ⌘F find (2020); ⌘A select siblings (2021-2025); ⌘C/⌘X/⌘V via clipboard events (1879-1904).
- ⌥A/⌥D/⌥W/⌥S/⌥H/⌥V align left/right/top/bottom/h-centre/v-centre (2028-2031).
- ⌥⌘G frame selection, ⇧⌘G ungroup, ⌘G group, ⌥⌘K create component / add variant, ⌥⌘A select matching, ⇧⌘K place image, ⇧⌘R paste to replace, ⌘⌫ ungroup (2034-2041).
- ^⌘M (Mac) / Ctrl+Alt+M use as mask (2043); ^⌥T tidy, ^⌥V / ^⌥H distribute (2045).
- ] / [ bring to front / send to back (2046); ⌘] / ⌘[ forward/backward, ⌥⌘] / ⌥⌘[ front/back (2052).
- ⇧H / ⇧V flip (2047); ⌥⌘B detach (2048); ⇧⌘H hide/show (2049); ⇧⌘L lock (2050); ⌘R rename (2051); ⇧A add/toggle auto layout, ⌥⇧A remove (2053).
- Text: ⇧⌘< > size, ⌥⌘< > weight, ⌥⇧< > line height, ⌥< > letter spacing, ⌘B bold toggle (2056-2066).
- 1–9 → 10–90% opacity, 0 → 100% (2069-2073).
- Tools: V move, H hand, F/A frame, R rectangle, O ellipse, L line, T text (2076-2078).
Elsewhere: Space hand (Canvas.tsx:559), ⌥ measure/copy (228-236, 766-769), Esc ends a drag (591-596), PgUp/PgDn/Home/End scroll in Page Editor (491-506); Layers ⌥-click chevron; ContextMenu ↑↓→←, Enter/Space, Esc (ContextMenu.tsx:116-127); Player Esc, R (Player.tsx:213-224); NumericInput ↑↓ ±1/⇧±10, Enter/Esc (ui.tsx:160-171); app menu ⌘1–9 tabs, ⌘N, ⌘W, ⇧⌘T (src/main/menu.ts:15-52).

## 5. Site coupling in this subsystem (drop or replace for a pure clone)
- Props: `slug`, `title`, `system: DesignSystem` (site variables/text styles/library), `session: EditSession` (Firestore save/publish/versions) (FigmaEditor.tsx:173-183).
- Publish / site: `isPublished`, `SITE_URL`, View on site, Preview the saved draft, Unpublish (184, 1615-1635, 2471-2486); `PublishButton`, `SaveProblem` rev conflicts (chrome.tsx:42-76); "burakkoc.net" subtitle (FigmaEditor.tsx:2183).
- Page Editor mode (site page frame at site width, Desktop/Tablet/Phone preview, `Set as site page`, "No page frame") (145-154, 208-209, 297-303, 1605, 2423-2451; Canvas.tsx:96-115, 188-211, 462-466, 491-506, 1281-1307, 1363-1372, 1575-1586); Code mode placeholder (2415-2422).
- Overview fixed layers / `stays` / `fromIndex` / `isPageOverview` / Overview reset confirms (125-127, 306-309, 946, 957, 1309, 1323, 1418, 1438; session.ts:139,152 refusal).
- Languages tr/en/... with `typeInInstance`, words patches (186-189, 549-574, 1077-1104, 1388-1401); FindPanel language words (FindPanel.tsx:65-66, 145-169).
- Site library: Components page = every project's library, `system.deleteComponent` with "the site's components" confirms (219-222, 374-400, 429-439, 580-590); component isolation mode (204-208, 402-447).
- Embeds (site code blocks) in Assets (160, 2111-2140, 2320-2329); `inPageColumn` (2106, 2131).
- Firebase Storage: `uploadMedia` (22, 1204, 1792), ImagesPanel entirely (ImagesPanel.tsx:5-6, 39-46, 136-168), export/copy notices about bucket CORS (1201, 1706).
- Firestore versions (VersionsWindow.tsx:3, 21, 32), `designerTab` save bridge (tab/EditorTab.tsx:37-46).
- Account (Firebase user) (FigmaEditor.tsx:190, 2468; chrome.tsx:79-88).
- Shared design system ops: text styles/colour variables created on the site system (1176-1195); VariablePicker/ColorPicker Libraries list site variables with light/dark ThemeMode (popover.tsx:2-4, 62-123; ColorPicker.tsx:157-177); image alt text tr/en (ColorPicker.tsx:223-225).
- Player renders with the site's `PageView`, `DesignSystemStyle`, `--bg-1` (Player.tsx:3, 7, 240-251).
- JsonEditor is the CV editor's (cv/CVEditor.tsx:16, 954).

## 6. Parity list vs Figma's editor

Legend: Have / Partial / Missing / Different.

| Area | Figma | DesignerV2 | Status |
|---|---|---|---|
| Rendering | GPU canvas, scene graph | DOM + CSS transform, overlay from DOM measurement (Canvas.tsx:160-169, 322-423) | Different |
| Tools: move/hand/frame/rect/ellipse/line/text | yes | yes (view.ts:7) | Have |
| Pen, pencil, vector edit, boolean ops, flatten | yes | none | Missing |
| Polygon, star, arrow, section, slice, comment, scale (K) | yes | none | Missing |
| Draw ⇧ square / ⌥ from centre | both | ⇧ only (Canvas.tsx:961-969) | Partial |
| Click to create default size | 100×100 | 100×100 (Canvas.tsx:983) | Have |
| Click selection depth | top-level child, deeper inside selection, ⌘ deep | same (picking.ts:54-68) | Have |
| Enter = select children | all children | last child only (FigmaEditor.tsx:1975) | Different |
| ⇧Enter / Esc / Tab | parent / up / next sibling | same (1959-1987) | Have |
| ⇧-click then drag group | yes | ⇧-click only toggles (Canvas.tsx:1055-1058) | Partial |
| Marquee | yes | yes, live, additive (990-1039) | Have |
| Multi-selection box with handles, resize, rotate | yes | dashed bounds, no handles (1414-1416, 1137) | Missing |
| Rotation handles, rotated selection box | yes | none; AABB boxes (272-279) | Missing |
| Resize past zero flips | yes | clamps at 1px (921) | Missing |
| Constraints (left/right/scale…) | yes | none (no constraint field anywhere in figma/) | Missing |
| Real groups (auto-fit) | yes | groups are fill-less frames (694-697) | Different |
| Move into frame / out, auto-layout reorder | yes | single node only (807, 842) | Partial |
| ⌥-drag duplicate | yes | yes, with ghosts and measurement (725-769) | Have |
| Smart guides: edges/centres | all nearby layers | top-level only, single move (660-672) | Partial |
| Spacing / equal-gap guides, resize snapping | yes | none | Missing |
| ⌥ measurement | to hovered and parent edges | to hovered only (363) | Partial |
| Rulers + draggable guides | yes | rulers only (Rulers.tsx) | Partial |
| Pixel grid ≥800%, zoom 0.02–256 | yes | yes (Canvas.tsx:1346; view.ts:23-24) | Have |
| Auto layout padding/gap handles | yes | yes (1138-1518) | Have |
| Undo depth / grouping | deep, per action | 20 steps, 600 ms coalescing (useUndo.ts:14,33-39) | Partial |
| Undo restores selection | yes | no | Missing |
| Clipboard interop (Figma HTML, SVG paste) | yes | own JSON text marker (157, 626-635) | Different |
| Paste over selection ⇧⌘V | yes | no (Paste to replace ⇧⌘R exists) | Partial |
| Copy as CSS/SVG/PNG, copy/paste properties | yes | yes (1694-1708, 1852-1872) | Have |
| Layers: rename, lock, hide, ⌥ expand, ⇧ range | yes | yes (Layers.tsx) | Have |
| Layers: multi-row drag, virtualization | yes | single row; full re-render (217-249, 262-310) | Missing |
| Pages: add/rename/delete | yes | yes (480-497) | Have |
| Pages: reorder, duplicate, dividers, per-page view memory | yes | none (only Components page view) | Missing |
| Find / Replace | yes | yes, incl. kinds and scope (FindPanel.tsx) | Have |
| Context menu | full | broad UI3 menu (1510-1614; ContextMenu.tsx) | Have |
| Main menu bar (File/Edit/View/Object/Text/Arrange…) | yes | site menu (1615-1635) + Electron roles (menu.ts) | Different |
| Quick actions ⌘/ , plugins, Dev Mode | yes | none; Code = "Coming soon" (2415-2422) | Missing |
| Outline mode ⌘Y | yes | ⌘Y = redo (FigmaEditor.tsx:1926) | Different |
| Next/previous frame N / ⇧N | yes | none | Missing |
| Opacity digits incl. two-digit entry | yes | single digit (2069-2073) | Partial |
| Prototype noodles create/retarget/delete | yes | yes (Noodles.tsx) | Have |
| Prototype targets: overlays, any frame, scroll-to | yes | top-level frames / same-set variants (Canvas.tsx:1098-1118) | Partial |
| Present: flows, restart | yes | yes, in-page dialog (Player.tsx) | Partial |
| Present: overlays, device frames, separate window | yes | none | Missing |
| Text editing rich ranges | yes | plaintext contentEditable (NodeView.tsx:167) | Missing |
| Colour picker: models, gradient kinds, on-canvas handles | yes | Hex only label, linear only, no canvas handles (ColorPicker.tsx:247, 105, 201-213) | Partial |
| Preferences | many (nudge, snapping…) | 3 mouse toggles (settings.ts:7-16) | Partial |
| Version history | side panel, named versions | modal over Firestore saves (VersionsWindow.tsx) | Different |
| Destructive confirmations | in-app modals | `window.confirm` (436, 584, 946, 957, 1089, 1621) | Different |

## 7. Problems (bugs, perf ceilings, debt)
1. God component: FigmaEditor.tsx holds ~26 state hooks, every command, three menus, the keyboard map and all panel JSX; `ops` (857-1230) and all closures are rebuilt each render, forcing an `actions` ref (1875-1878) and `latest` refs (526-529) to avoid stale closures.
2. Model operations read geometry from the DOM: `domRect`/`rectOf` (dom.ts:6-26) used by group/frame (686-688), ungroup (722-723), align across parents (875), remove auto layout (921-928), lock proportions (1210), paste here (1663-1671), place image (1779-1782), insert instance (2087-2093), export (1197), plus Canvas `ownBox`/`canvasRect`. The Code view keeps the canvas mounted just so these still work (2380). Incompatible with a WASM/WebGL renderer without a layout engine in the core.
3. Overlay loop cost: rAF tick re-measures via getBoundingClientRect for the selection, every top-level frame label, auto-layout kids and every prototype reaction, then `JSON.stringify` the whole result (Canvas.tsx:322-423, 416); any pointermove/keydown/wheel flags a full re-measure (309-313).
4. Hover picking on every pointermove: `pathAt` + `pickFrom` with Range.getClientRects on text glyphs (Canvas.tsx:1322-1327; picking.ts:10-31) and `pickFrom` re-walks ancestors of each selected element with querySelector (picking.ts:58-65).
5. Every model edit re-renders the World; gestures work around it by previewing in element styles and committing on release (move 730-737, resize 895-897, layout handles 1198-1256). Inspector scrubbing commits on every step (ui.tsx:137-140) → full document update per pixel.
6. Undo is time-coalesced snapshots, limit 20, no transactions, no selection/page restore; restoring can put nodes on a page that is not shown; edits refused by `keepsOverview` are silent no-ops (useUndo.ts:14, 33-39; session.ts:139, 152, 161).
7. Keyboard: one 165-line handler with order-dependent `if`s (1918-2082) re-subscribed whenever `setSelection` identity changes (deps 2082; `setSelection` depends on `nodes`, 518 → every edit). Shortcut labels in menus are duplicated by hand (1550-1612) and the Electron menu exposes no editor commands (src/main/menu.ts:56-69; `designerTab.command` is a no-op, tab/EditorTab.tsx:41).
8. Enter selects only the last child (1975) — not Figma's "select children".
9. Arrow nudge on an auto-layout child edits x/y that layout ignores (1989-1998) instead of reordering.
10. Multi-selection cannot be resized/rotated and never reparents on drag (Canvas.tsx:770, 807, 842, 1137).
11. Snapping/guides limited to top-level targets for single moves; guides are full-viewport lines (660-672, 782-800, 1426-1432).
12. Selection boxes, handles and the W×H label use axis-aligned DOM bounds — wrong for rotated layers (Canvas.tsx:272-279, 336, 1566-1569).
13. No constraints and groups are frames, so frame resize never repositions/scales children, and groups don't hug content (694-697).
14. Esc or window blur during a drag commits the gesture at its last position instead of reverting (Canvas.tsx:580-596 with `end(e ?? last ...)`, move end at 840-871).
15. Clipboard format is a private JSON-in-text marker (157, 631-633): pasting into other apps yields JSON; nothing from Figma/SVG pastes as layers; pasted images are uploaded to the site bucket (669-670).
16. Global DOM queries assume one canvas per document (`[data-figma-canvas]` in dom.ts:7, FigmaEditor.tsx:1197, 1663, 1779, 2087, 2133; Layers.tsx:53-63).
17. Page model asymmetry: first page lives in `file.nodes` with id "", others in `file.pages`, requiring special cases in `doc` (289-294), `setNodes` (362-371), `setBackground` (1118-1122), `moveToPage` (1715-1723), `removePage` (494), Find (2145-2148).
18. Selection validity only checks the root of composite ids (500) — a stale `instance/path` id can survive edits to the main component.
19. Layers tree renders the entire expanded tree recursively each render, resolving every instance (Layers.tsx:252, 262-310); no virtualization. Find walks every page per keystroke (FindPanel.tsx:111-125).
20. `window.confirm` dialogs for destructive actions (436, 584, 946, 957, 1089, 1621) and page delete without confirm (2235).
21. Effect styles are per-file (`file.effectStyles`, 1159-1175) while text styles/colour variables are site-wide (1176-1195) — inconsistent with Figma's local styles per file.

## 8. Worth keeping in a Figma clone
- `ContextMenu` + `keys()` (components/admin/ContextMenu.tsx): renderer-agnostic UI3 menu with submenus and keyboard navigation.
- UI3 primitives in figma/ui.tsx: NumericInput (scrub, arrow step, arithmetic `evaluate`, tested by figma/__tests__/evaluate.test.ts), ColorInput, ChevronMenu, Switch, Tab, CollapseHeader, EDITOR_CSS tooltips.
- Icon sets (figmaIcons.tsx ~84 + figmaKitIcons.ts ~121 UI3 kit glyphs).
- `view.ts` ViewStore + `zoomAround`/`fitView` (pure, renderer-independent) and the pattern of keeping the camera out of React state.
- Layers.tsx tree UX (rows, composite ids for instance children, before/after/inside drop, ⇧ range, ⌥ subtree toggle, rename) — React panel that only needs a scene-graph read API.
- `pickFrom` selection-depth rules (picking.ts:54-68) as the spec for a core hit-test.
- FindPanel (minus language specifics), Rulers (canvas-2D), Noodles curve geometry and interaction model, Player transition/Smart-animate matching logic (needs a non-site renderer).
- Command algorithms in FigmaEditor worth porting into a core command layer: auto-layout inference on ⇧A (698-709, 932-938), combine as variants with slash names (820-854), add variant (771-812), duplicate-as-variant (606-614), createsCycle (318-353), distribute/tidy (1133-1158), mask (1728-1744), select matching (1002-1022), paste to replace, copy/paste properties.
- The keyboard map (section 4.11) as the seed list for a command registry.
- ColorPicker HSV/hue/alpha/eyedropper/document colours (minus site Libraries and alt text).
