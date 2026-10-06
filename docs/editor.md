# The editor (Figma UI3 chrome around the engine)

`src/renderer/src/editor/` is the new file editor: Figma's UI3 chrome (rail, left panel with Pages and Layers, rulers, the engine canvas, the right Design panel, the bottom toolbar, menus) built from the design system (`src/renderer/src/ds/`) around the C++/Wasm engine (`src/renderer/src/engine/`). Contracts it follows: `docs/engine.md` §10 (binding), `docs/design-system.md` + `docs/design-system-usage.md` (look), `docs/schema.md` (field names), `docs/desktop.md` §13 (clipboard), `docs/research/figma/R7-editor.md` (behaviour), `docs/research/visual-diff.md` (measured metrics).

**Import rule (owner, 2026-10-06):** the editor imports only `src/renderer/src/ds/`, `src/renderer/src/engine/` and `src/shared/` (types). Nothing from the legacy folders (`figma/`, `cv/`, `home/`, `lib/`, `demo/`, `components/`, `context/`, `types/`, `tab/`), which are deleted in the next integration round. Theme: `ds/theme.ts` (`useThemeRoot`, `useTheme`), never `context/ThemeContext`.

---

## Status at handoff (2026-10-06, round 2)

The editor UI is built and runs end to end in a browser: `npx vite --config vite.web.config.ts --mode demo --port 5202`, then `http://localhost:5202/?editor` (the engine's sample), `?editor&doc=reference` (the owner's file "burakkoc" as in the reference screenshots), `?editor&doc=empty`, or `?editor&file=<fileKey>` (a file on the store: the desktop's editor tabs; in a browser the dev store's demo files). `npm run typecheck`, `npm run lint` and `npm test` are green for the whole repo at handoff (the editor's: 43 tests; after the round-2 follow-ups `main.tsx`/app may be red while the desktop agent removes legacy code — not the editor).

### Done (built, looked at in screenshots, driven with playwright)

- **Mount** (`EditorApp.tsx`, named + default export, `{ source, onBackToFiles?, onReady?, initialView? }`; public entry `editor/index.ts`): `source.load()` → `Engine.create` → `engine.load` → `EngineStore` → `EditorController` → `CanvasController({ shortcuts: [] })` → every commit to `source.onChanges(message, { kind, label })` → `onExternalChanges` applied as "remote", `onMetaChanged` → the header's name → keyboard, clipboard, canvas menu, desktop hooks, persistence → the file's saved camera/page (else zoom to fit, or `initialView`). The `<canvas>` is one element from the first render on (the panels are placeholders until the engine is up). Theme through `ds/theme.ts` (`useThemeRoot`, `engine.setTheme`). `TooltipManager` + `ToastHost` mounted. ⌘-wheel never zooms the page.
- **Route** (`EditorRoute.tsx`): memory sources for the sample / `doc=reference` / `doc=empty` (`fixtures.ts`); `&file=` opens the store's source (`openDocument` from `@/store`), once per file per page (StrictMode-safe, refcounted), closed after the last mount goes. `&rulers=0`. `window.__designerEditor` for scripts.
- **Layout shell**: rail 48 (Figma main menu, File, Assets, Insert, Resources, Settings), left panel 240 (resizable), canvas, right panel 240 (resizable, `data-panel="right"` for the colour picker), help button (24 from the window's right, centred with the toolbar), toolbar centred on the window (clamped inside the canvas when the panels are wide).
- **Main menu** (`menus.ts`, built from `commands.ts` when it opens, enablement and checks live): Back to files, Actions…, File / Edit / View / Object / Text / Arrange submenus, Preferences (Theme), Help and account.
- **Left panel** (`panels/LeftPanel.tsx`, `Pages.tsx`, `Layers.tsx`): file header (name ▾ → file menu incl. Rename — inline field, `source.rename` —, Save to version history, Show version history, Back to files; location; Minimize UI). Pages: PageRow list, current highlighted, click to switch, double-click rename, context menu (Rename / Duplicate / Delete / Go to page — CREATE/DUPLICATE/DELETE_PAGE with `{ page: "s:l" }`), search, "+", drag to reorder (`engine.moveNodes(…, "0:0", i)`). Layers: VirtualList + LayerRow, top first, type / auto-layout glyphs, strong top-level frames, click / ⇧ range / ⌘ toggle, selection runs, selected-ancestor fill, hover ↔ canvas outline, double-click / ⌘R / Enter rename with Tab to the next row, lock / eye, chevrons (⌥ opens every level), drag reorder/reparent with the drop indicator (`dropTarget` → `engine.moveNodes`), reveal + scroll to a canvas selection, right click → the canvas menu. Assets tab: search + empty state.
- **Rulers** (`canvas/Rulers.tsx`): two 2D canvases redrawn on camera / selection / page / node changes / theme / resize (never React state per frame); colours `canvasChrome.ruler*`, metrics `canvasChromeMetrics.ruler`; labels every `rulerStep(zoom)` centred on 4px ticks; 0 at the selection's top-level frame corner; selection band with blue edge labels, neighbours faded (`labelAlpha`); ⇧R.
- **Right panel** (`panels/RightPanel.tsx`): header 48 (avatar ▾ with Theme, Present ▸ ▾, Share), Design / Prototype tabs, zoom menu ("87% ⌄": zoom in/out/fit/selection/50/100/200, view toggles, Property labels). **Design panel** (`panels/design/`): nothing selected → Page (colour + opacity + eye; the engine's dark default shown as #1E1E1E), Styles, Export; a selection → type header (Frame ▾ with presets / Rectangle / Ellipse / Group / Mixed), Position (6 align buttons, X / Y, rotation + rotate 90° / flip H / flip V), Layout or Auto layout (+ / − ; direction, AlignmentMatrix, gap, horizontal / vertical padding; W / H, Constrain proportions when the engine keeps it, Clip content), Appearance (opacity, corner radius, individual corners, visibility, blend mode), Fill and Stroke (rows top first: ColorInput, eye, minus; "+"; "Click + to replace mixed fills"; stroke position + weight; the DS **ColorPicker**, SOLID only), Effects, Layout guide (frames), Export. Every edit is one undo step; scrubs/picker drags are one open transaction (`ed.edit`), Esc cancels; Mixed fields step each layer (`onStep`); Property labels.
- **Bottom toolbar** (`canvas/BottomToolbar.tsx`): DS `EditorToolbar`; the engine's tool drives the active slot, slots remember their last tool (by click or key); tools the engine doesn't implement are passed as `disabledTools`; modes Draw / Motion / Dev Mode disabled.
- **Canvas context menu** (`canvas/CanvasMenu.tsx`): built from the engine's `CONTEXT_MENU` event (the engine selects what a left click would pick first, also on ⌃-click); Copy, Paste here (at the point), Paste over selection, Copy/Paste as ▸, arrange, Group / Frame selection / Ungroup, Show/Hide, Lock/Unlock, Flip, Add auto layout, Duplicate, Delete, Select layer ▸ (the event's `hits`, flattened, innermost first); empty canvas: Paste here, Show/Hide UI, Rulers, Select all.
- **Shortcuts dialog** (`ShortcutsDialog.tsx`, ⌃⇧? and the help button): the registry's keys by group + the engine's canvas keys. **⌘\\** hides all UI, **⇧\\** minimizes it into two floating cards (`panels/Minimized.tsx`).
- **Version history** (`VersionDialogs.tsx`): ⌥⌘S "Save to version history" (title, description) and "Show version history" (newest first, Restore = `restoreVersion` applied as one "Restore version" edit); enabled when the source has them.
- **Persistence** (`persistence.ts`): restores `source.uiState` (page, camera, selection, panel widths) on open and writes it as it changes; saves a thumbnail of the first page (the engine's offscreen `renderThumbnailPixels`, the content's own aspect, no overlays, within 800 × 600 PNG) 4 s after the last change and on close — the pixels are taken synchronously, so the close-time one is read before the engine goes.
- **Desktop hooks** (`desktop.ts`, only when `window.designer.role === "editor"`): `tab.onFlush` → `source.flush()`; `menu.onCommand` → `runEditorCommand` with the editor's own ids (`edit.*` natively in a focused text field; `file.save` flushes); `menu.setState` patches of every registry command's enabled / checked, at most once a frame after selection / undo / tool / pages / structure / node / UI changes; `tab.report({ title, status })` with the file's name, again on rename; a file trashed or deleted elsewhere closes its tab. "Back to files" = `onBackToFiles`, else `nav.goHome()`.
- **Engine API**: every command (incl. FLIP_*, SELECT_INVERSE ⇧⌘A, page commands with `{ page: "s:l" }`) and `moveNodes` / `encodeSelection` / `paste` / `renderThumbnailPixels` / the `CONTEXT_MENU` event are called directly; `engineCompat.ts` is field detection only (`supportsField`). The TS flip fallback is gone.
- **Registry ↔ app menu**: every id the desktop's menu bar places exists in `commands.ts` (incl. `file.save-version`, `file.export-frames-to-pdf`, `edit.copy-as-text`, `vector.*` with Figma's keys, disabled until implemented); the main menu has a Vector submenu.
- **Tests**: `__tests__/editor.wasm.test.ts` (the real engine headless: Layers tree, reference fixture, labelled edit = one undo step reaching the source, scrub = one step, Esc rollback, registry commands, flip, menus, moveNodes with the panel's drop target, copy/paste, page commands, menu-state patches, select inverse, CONTEXT_MENU → the menu, tool/glyph/type helpers) + the earlier model tests.

### Visual / end-to-end check

`node src/renderer/src/editor/tools/editor-shot.mjs [outDir]` (own Vite server, or `EDITOR_URL=http://localhost:5202`; playwright-core, SwiftShader, 1512 × 945, dark and light). Checks (all ok at handoff): click selects Frame 1; ⇧A auto layout; ⇧\\ / ⌘\\ / ⌃⇧?; F + drag frame; R + drag rectangle inside it; Layers rows; Esc → parent → nothing; ⌘Z / ⇧⌘Z; Layers click selects; double-click rename; X field moves; Delete; the source got every change; a store file opens, ⌥⌘S version listed, thumbnail saved, the change and the camera survive a reload. Screenshots in `/tmp/designer-work/editor/`:

- `01-nothing-{dark,light}.png` (reference file, nothing selected), `02-frame-selected-*`, `03-auto-layout-*`, `04-sample-rectangle-*`, `05-context-menu-*`, `06-main-menu-*` (Object submenu), `07-zoom-menu-*`
- dark only: `08-minimized`, `09-hidden`, `10-shortcuts`, `11-drawn-frame`, `12-drawn-rectangle`, `13-after-edits`, `14-store-file`, `15-version-history`

Compared with the measurements in `docs/research/visual-diff.md` (no reference images available): rail 48, panels 240, header 64, section headers 40, page pitch 32 / highlight 24 inset 8, layer rows 24, right header 48 + tabs 32 (line at 80), Share ending 8 from the edge, toolbar centred on the window 12 from the bottom, help 24 from the right — match.

### Partial / placeholders

- Prototype tab: an empty state. Assets: search + empty state. Insert / Resources rail items, Actions (⌘K), Present, Share: toasts.
- Effects / Layout guide / Export "+" stay disabled until `supportsField` sees `effects` / `layoutGrids` / `exportSettings`; blend mode likewise.
- W / H are disabled for groups (the engine refits groups to their children); no Hug / Fill / Fixed sizing menus, no min / max, no constraints UI, no auto-layout advanced menu.
- ColorPicker limited to SOLID (the engine's `Paint` type); no "On this page" colours yet.
- Frame titles and the size badge's number on the canvas wait for E3 text (the badge draws empty).
- Versions: no view-only "open version", rename or duplicate-from-version UI.

### Needed from other workstreams

- **DS**: the disabled modes don't look disabled in the light theme.
- **Engine**: nothing blocking; E3 text (frame titles, the size badge's number), E4 vectors/booleans for the Vector menu, effects / layout guides / export fields.

### Next steps

1. Viewing a reference screenshot again (when the owner re-shares them) and tuning pixel details with `tools/editor-shot.mjs`.
2. Sizing menus (Hug / Fill / Fixed), min / max, constraints, auto-layout advanced settings once the engine's E2 fields are all in the facade's types.
3. Effects / layout guides / export rows when the engine keeps those fields; gradients and images in the picker with E5.
4. Text (E3): the Text section, frame titles, the size badge.

---

## Structure

```
editor/
  index.ts             public entry: EditorApp, DocumentSource, memoryDocumentSource
  EditorApp.tsx        the root: engine mount, layout, overlays
  EditorRoute.tsx      ?editor: memory sample / &doc=reference|empty / &file=<fileKey> (store)
  fixtures.ts          the reference and empty documents
  documentSource.ts    DocumentSource, memoryDocumentSource, applyMessage
  engineCompat.ts      field detection (supportsField)
  controller.ts        EditorController, EditorContext, readTree
  uiStore.ts           Store<T>, UIState
  hooks.ts             useUI, useLayerTree, usePages, useNodes, useTopics
  commands.ts          the command registry (menus, shortcuts, buttons, the app menu)
  menus.ts             main menu and canvas menu entries from the registry
  keyboard.ts          the shortcut layer
  clipboardIO.ts       DOM clipboard events
  actions.ts           TS edits (flip fallback, rotate, zoom), geometry reads
  desktop.ts           window.designer hooks: flush, menu commands and state, tab title
  persistence.ts       UI state per file, thumbnails
  ShortcutsDialog.tsx  VersionDialogs.tsx
  panels/              Rail, LeftPanel, Pages, Layers, RightPanel, Minimized, design/ (DesignPanel, Sections, Paints, shared)
  canvas/              Rulers, BottomToolbar, CanvasMenu
  tools/editor-shot.mjs  the visual + end-to-end check (playwright-core)
  model/               pure logic: layerTree, mixed, geometry, color, clipboard, rulers
  __tests__/           vitest: model, layerTree, the editor on the headless engine
```

## The DocumentSource interface

```ts
export interface DocumentSource {
  readonly fileName: string;          // the left panel's header ("burakkoc")
  readonly location: string;          // "Drafts", a folder's name
  readonly sessionID?: number;        // new nodes' session (storage allocates it); default 1
  load(): Promise<Message>;           // a snapshot Message (DOCUMENT first, parents before children)
  onChanges(changes: Message, info?: { kind?: "USER" | "UNDO" | "REDO" | "SYSTEM"; label?: string }): void;
  flush(): Promise<void>;             // every change handed to onChanges is stored
  rename?(name: string): void | Promise<void>;
  // Optional (round 2; the store's source has them all):
  onExternalChanges?(listener: (changes: Message) => void): () => void;   // applied as "remote"
  onMetaChanged?(listener: (meta: { fileName; location; trashed?; deleted? }) => void): () => void;
  close?(): Promise<void>;
  readonly uiState?: EditorUiState | null;        // page, camera + selection per page, panel widths
  setUiState?(patch: Partial<EditorUiState>): void;
  saveThumbnail?(png: Uint8Array, size: { width: number; height: number }): Promise<void>;
  listVersions?(): Promise<VersionInfo[]>;
  saveVersion?(input?: { title?: string; description?: string }): Promise<VersionInfo>;
  restoreVersion?(id: string, apply: (diff: Message) => void | Promise<void>): Promise<VersionInfo>;
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
