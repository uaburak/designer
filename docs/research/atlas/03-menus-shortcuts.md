# 03 — Menus, keyboard shortcuts, Quick actions

Figma Design desktop 126.9.13, read from the cached editor build. Figma's code is not copied here, only the behaviour, values and data shapes, each with its evidence. The chrome around the menus (sizes, colours, the menu component itself) is chapter 02. This chapter covers what the menus and keys contain and how they decide.

## 1. Scope and sources

What it covers: the main menu tree (the Figma-logo menu, mirrored into the desktop OS menu bar), every right-click menu, the complete shortcut table (action id → keys on Mac and on Windows, per edit mode, platform, editor, preference and keyboard layout), the Keyboard shortcuts panel, keyboard-layout handling, and Quick actions (Actions…, ⌘K / ⌘/ / ⌘P): sources, ranking, frecency, recents.

| Source | What it gave | Where |
|---|---|---|
| `fullscreen__fullscreen-wasm__compiled_wasm.wasm` | **The shortcut table itself.** One JSON document embedded in the C++ binary, `{"$schema":"./keyboard-shortcuts.schema.json", …}`, 63 956 bytes, **260 action ids, 1 183 bindings**. | byte offset **47 251 835** |
| `858.min.js` (= `7621.min.js`) | The main-menu builder (`GetFullscreenMenuItems`): every submenu and item, with its flags, property and check | ~66 000–114 500 |
| `3653.min.js` (= `1540.min.js`, byte-identical) | `SelectionContextMenu` (the layer, multi-selection, text-edit, ruler/guide, select-layer and Layers-panel menus), the canvas menu, the comment-pin, gradient-stop, Dev Mode code / overview and page-link menus; the Keyboard shortcuts panel (tabs, columns, pseudo-shortcuts, animations, Layout tab); the Quick actions UI and its search index; the ranking weights | ~493 000–560 000; ~600 000–648 000 |
| `7314.min.js` (also 9712, 5750, 7290) | The pages-list menu (one page, several pages, a divider) and the File ▸ New items | around `action:"page-rename"` |
| `7362.min.js` (also 3187, 5519) | The TypeScript action registry (840 entries `{jsonName, isEdit, allowedEditorTypes, allowedTopLevelModes, enabled, handler}`) with the enable predicates; the search-only Quick-action list; the frecency scorer | around `jsonName:"set-tool-default"`; module `355212` |
| `figma_app.min.js` | Keyboard-layout preference (storage, reload, names), the frecency store, the text ⇄ shortcut parser | module with `keyboardLayoutPreference` |
| `3187.min.js` module `459081` | OS input-source ids → Figma layout enum, and the web `getLayoutMap` fingerprints | `com.apple.keylayout…` |
| Figma desktop `app.asar` `main.js` (unpacked by another chapter into the shared scratchpad) | The native OS menu bar's own items and accelerators | `desktop.menu.*` |
| Repo `docs/research/figma/live/menus/*.txt` (owner's live captures, English) | The English labels and the shortcut glyphs as Figma shows them | 22 files |
| Repo `docs/research/shortcuts-panel/README.md` | The panel's measured geometry (summarised in §8, not redone) | — |

Rule used below. **CONFIRMED** = read directly in the build or the live captures. **INFERRED** = deduced. The JS bundle carries i18n keys, not English (see §10). English is given only where a live capture or the repo attests it.

## 2. How actions, menus and keys fit together

| Fact | Value | Evidence | |
|---|---|---|---|
| One id names an action everywhere: menu item (`action:`), shortcut JSON key, Quick-actions entry, analytics | e.g. `flip-horizontal` in the menu, the JSON, the popularity list and the panel | 858, wasm JSON, 3653 | CONFIRMED |
| Label of an action | i18n key `fullscreen_actions.<action-id>` (e.g. `fullscreen_actions.set-tool-frame`), overridden per item by `displayText` | 7362: `"set-tool-frame":(0,r.t)("fullscreen_actions.set-tool-frame")` | CONFIRMED |
| Items without an engine action | `name:` + `callback:` (e.g. `save-as`, `duplicate-file`, `back-to-files`, `sign-out`) | 858 | CONFIRMED |
| Shortcut shown in a menu | Not stored on the item: looked up from the engine's live table `appModel.keyboardShortcuts` (mirrored from C++); the one shown is the first binding that applies (INFERRED from the live captures, e.g. Flatten ⌥⇧F). An item may force `shortcutText` (e.g. `"⌘C"`, `"⌘V"`, `"⌘D"`, `"⌘⇧U"`, `"⌫"`) | 3653 `shortcutText:\`${L}C\``; `oE.c1(appModel.keyboardShortcuts,n)` | CONFIRMED |
| Key handling | C++ owns it: JS hands each keydown/keyup to `handleKeyboardShortcut` with `key`, `code`, `layout` and `shouldUseLayoutAndCode` (true unless the layout is UNKNOWN) | figma_app: `shouldUseLayoutAndCode:i!==l.aT.UNKNOWN,layout:i` | CONFIRMED |
| Modifier bit mask (shortcut parser) | Alt **256**, Meta **512**, Shift **1024**, Control **2048**, RightAlt **4096** (all = 7936). Text form `Mod+Mod+Key`, `None` = no key | figma_app `getKeyboardShortcutFromText` | CONFIRMED |
| Display order of modifiers | Control, Alt, Shift, Meta, RightAlt, then the key → on Mac ⌃ ⌥ ⇧ ⌘ | figma_app `getTextFromKeyboardShortcut` | CONFIRMED |
| Per-item check mark | `property` + `propertyValue` (an observable preference, checked when equal) or `checked` | 858, `492777` helpers | CONFIRMED |

### 2.1 Menu item schema

Item kinds: **separator** `{separator:true}`, **header** `{header:true,name}`, **render** (a custom React row with `optionHeight`), **submenu** (`children` or `childDropdown`), **action** (`action` or `callback`). Module `492777` tells them apart.

| Field | Meaning |
|---|---|
| `action` / `name` | action id (runs the engine action) / a menu-only id with `callback(name,args,dispatch,event)` |
| `flags` | visibility filter, every flag must hold (vocabulary below). `!x` negates |
| `featureFlags` | gates that must be on (e.g. `sites`, `metronome`, `bake_canvas`, `dse_library_pg_thumbnails`) |
| `platforms` | `mac`, `windows`, `!ipad` |
| `displayText`, `displayTextIcon`, `sideText`, `rightIcon` | label overrides and decorations |
| `displayForQuickCommand` | a different label in Quick actions (e.g. View ▸ Rulers is "show-rulers" there) |
| `hideForQuickCommand`, `searchOnly`, `searchSynonyms`, `isLowPriorityMatch`, `hideCheckForQuickCommand` | Quick-actions behaviour (§9) |
| `property`/`propertyValue`, `checked` | the check mark |
| `disabled`, `disabledAndForceVisible` | greyed. In canvas menus a disabled item is **removed** (`removeDisabledItems:!0`) unless force-visible (export blocked by approvals) |
| `flattenIfSingleChild` | a submenu with one child shows the child inline (the Slots submenu in the canvas menu) |
| `supportMiddleClick` | middle click opens in a new tab (Back to files, New file) |
| `autoHeightSubmenu`, `preventDismissOnSelected`, `loadingIndicatorString` | rendering details ("Duplicating", "Deleting" on page actions) |

`flags` vocabulary (CONFIRMED in 858/3653): `edit` (the user can edit) / `!edit`, `view_restricted` (allowed to view-only users too), editor types `design`, `whiteboard` (FigJam), `dev_handoff` (Dev Mode), `slides`, `cooper` (Buzz), `sites`, `figmake` (Make), `figspec`, `illustration` (Draw), states `recovery`, `integration` (embedded hosts), `limited_dev_mode`, `rfd_view` (ready-for-dev view), `desktop` (desktop app only), `desktop_os_menu` (only in the native OS menu bar, never in the in-app menu).

## 3. The main menu (Figma logo ▸)

Built by `GetFullscreenMenuItems` (858). The in-app menu filters with `isDesktopMenu:false`, so `desktop_os_menu` items are absent there (CONFIRMED 3653 `filterOptions`). The same tree feeds the desktop OS menu bar and Quick actions. Shortcuts are U.S. layout, default preferences (full table §6). Window keys are only given where they are not simply ⌘→Ctrl.

**Top level** (Design editor, edit access; CONFIRMED 858 + live `main-menu.txt`):

| # | Item | id | Shortcut | Notes |
|---|---|---|---|---|
| 1 | Back to files | `back-to-files` (callback) | — | when `shouldShowBackToFiles`. ⌘-click or middle-click opens the project in a new tab. Followed by a separator |
| 2 | Actions… | `toggle-menu` | ⌘K (also ⌘/, ⌘P) | label `fullscreen_actions.toggle-actions-menu` in UI3, else `toggle-menu`. `hideForQuickCommand`. Flags `!figmake !rfd_view !figspec` |
| 3 | File ▸ | `file-menu` | | |
| 4 | Edit ▸ | `edit-menu` | | three variants, see §3.2 |
| 5 | View ▸ | `view-menu` | | |
| 6 | Object ▸ | `object-menu` | | `!dev_handoff` |
| 7 | Text ▸ | `text-menu` | | `edit` |
| 8 | Arrange ▸ | `arrange-menu` | | `edit` |
| 9 | Vector ▸ | `vector-menu` | | `edit design/slides` |
| — | separator | | | |
| 10 | Plugins ▸ | (module 381085 `qz`, "filemenu") | | when the user can view plugins |
| 11 | Widgets ▸ | (module 194524 `Vd`) | | not read-only |
| 12 | Preferences ▸ | `preferences-menu` | | |
| 13 | Libraries | — | ⌥2 (`toggle-publish`) shown in View ▸ Panels | live shows it here; its builder entry was not found in 858 (open question 1) |
| 14 | `open-preferences-modal` | | | flags `design slides edit cooper !rfd_view` (a separate preferences dialog; label not attested) |
| — | separator | | | |
| 15 | Open in desktop app | `open-in-desktop-app` | — | `!desktop`, mac/windows only (browser only) |
| 16 | AI balance ▸ | `ai-balance` | — | when `showAiBalance`, a custom rendered row |
| 17 | Help and account ▸ | `figma-account-menu` | | |

### 3.1 File ▸ (CONFIRMED 858 + 7314 + live `main-file.txt`)

| Item (English, live) | id | Mac | Win | Flags / condition |
|---|---|---|---|---|
| New Design file / New ▸ (FigJam board, Slides, Site, Buzz, Make, Spec, Weave…) | `new-design`, `new-whiteboard`, `new-slides`, `new-site`, `new-buzz`, `new-rev`, `new-spec`, `new-weave` (in `file-new-menu`) | — | — | the current editor's type sorted first and labelled "New …" at the top; the others in the "New" submenu (`fullscreen_actions.creation_submenu.*`). Each disabled when the drafts folder cannot create that type. Synonyms: FigJam "figjam", Site "sites","website" |
| New from Sketch file… | `new-from-sketch` | — | — | Design only |
| — | | | | |
| Place image/video… | `place` | ⇧⌘K | Ctrl+Shift+K | `edit design/slides/cooper/sites` |
| Import… | `import` | — | — | FigJam only (`edit whiteboard`) |
| — | | | | |
| Duplicate | `duplicate-file` | — | — | `!integration !figspec`, gate `uxp_make_a_copy`. Make files: submenu "backend only / entire CMS" |
| Save local copy… | `save-as` | — | — | `view_restricted !recovery !figspec`. Not in integration hosts. With variable collections, asks first |
| Save to version history… | `create-savepoint` | ⌥⌘S | Ctrl+Alt+S | `edit !integration !recovery` |
| Show version history | `toggle-version-history` | — | — | `edit …`, check on `topLevelMode` |
| — | | | | |
| Export… | `export-selected-exportables` | ⇧⌘E | Ctrl+Shift+E | `view_restricted design dev_handoff slides !cooper !recovery !limited_dev_mode !rfd_view` |
| Export (FigJam) | `export-selection-or-current-page` | ⇧⌘E | Ctrl+Shift+E | FigJam |
| Copy to Figma Slides | `copy-to-figma-slides` | — | — | `design edit`, when the slide-conversion entry point is on |
| Export frames to PDF… | `export-all-frames-to-pdf` | — | — | `view_restricted design dev_handoff …` |
| Export slides to… | `export-slides-to` | — | — | Slides (synonyms "export to pptx / pdf") |
| — | | | | |
| Branching items (Create branch…, Merge…) | from `ti.m(...)` / `ti.t(...)` with `EDITOR_MENU` | — | — | live: "Create branch…" |

### 3.2 Edit ▸

Three variants, chosen by flags (CONFIRMED 858).

**Editable file** (`edit !dev_handoff !figmake !rfd_view !figspec`; live `main-edit.txt`):

| Item | id | Mac | Win |
|---|---|---|---|
| Undo | `undo` | ⌘Z | Ctrl+Z |
| Redo | `redo` | ⇧⌘Z | Ctrl+Shift+Z, Ctrl+Y |
| — | | | |
| Cut / Copy (OS menu only) | `cut`, `copy` (`desktop_os_menu`) | ⌘X / ⌘C | |
| Copy as ▸ | `copy-as-menu` | | |
| · Copy as text | `copy-text` | — | — |
| · Copy as CSS | `copy-as-css` | — | — |
| · Copy as CSS (all layers) | `copy-as-css-recursive` | — | — |
| · Copy as SVG | `copy-as-svg` | — | — |
| · Copy as animated SVG | `copy-as-animated-svg` | — | — |
| · Copy as PNG | `copy-as-png` | ⇧⌘C | Ctrl+Shift+C |
| Paste (OS menu only) | `paste` | ⌘V | |
| Paste over selection | `paste-over-selection` | ⇧⌘V | Ctrl+Shift+V |
| Paste to replace | `paste-to-replace` | ⇧⌘R (not in Safari), ⌥⇧⌘V | Ctrl+Shift+R, Ctrl+Shift+Alt+V |
| Duplicate | `duplicate-in-place` | ⌘D | Ctrl+D |
| Delete | `delete-selection` | ⌫ / ⌦ | Backspace / Delete |
| — | | | |
| Find | `canvas-search` | ⌘F | Ctrl+F |
| Find next | `canvas-search-next` | ⇧⌘F | Ctrl+Shift+F |
| Find previous | `canvas-search-prev` | ⇧⌘D | Ctrl+Shift+D |
| Find and replace… | `canvas-search-replace` | — | — |
| — | | | |
| Set default properties | `set-default-style` | — | — |
| Copy properties | `copy-properties` | ⌥⌘C | Ctrl+Alt+C |
| Paste properties | `paste-properties` | ⌥⌘V | Ctrl+Alt+V |
| — | | | |
| Pick color | `toggle-dropper` | ⌃C (Mac), I | I |
| — | | | |
| Select all | `select-all` | ⌘A | Ctrl+A |
| Select matching layers | `select-matching` | ⌥⌘A | Ctrl+Alt+A |
| Select none | `deselect-all` | ⎋ (shown; `escape` action) | Esc |
| Select inverse | `select-inverse` | ⇧⌘A | Ctrl+Shift+A |
| Select all with ▸ | `select-all-with-menu-options` | | |
| · same properties / fill / stroke / effect / text / font / instance / variant | `select-same-style`, `-fill`, `-stroke`, `-effect`, `-text`, `-font`, `-instance`, `-variant` | — | — |

**View-only** (`!edit !dev_handoff`): Undo / Redo only in `recovery` mode, Find / next / previous, Pick color, Copy properties (`view_restricted`), Select all / none / inverse, Select matching, Select all with ▸ (the same eight).

**Dev Mode** (`!edit dev_handoff`): OS Copy / Paste / Cut, Copy as ▸ (Copy as text, SVG, animated SVG, PNG, `copy-layer-name`), Find ×3, Select all, Select none.

### 3.3 View ▸ (CONFIRMED 858 + live `main-view.txt`, `main-view-panels.txt`)

| Item (live) | id | Mac | Win | Check property / flags |
|---|---|---|---|---|
| Pixel grid | `toggle-grid` | ⇧' (⌘' too) | Shift+', Ctrl+' | `renderGrid`; design/sites/dev |
| Layout guides | `toggle-shown-layout-grids` | ⇧G (⌃G, ⌃⇧4) | Shift+G, Ctrl+Shift+4 | `showFrameGrids` (edit) / `showFrameGridsViewOnly` (view) |
| Rulers | `toggle-rulers` | ⇧R | Shift+R | `renderRulers`. Quick-action label "show-rulers" |
| Show slices | `toggle-show-slices` | — | — | `showSlices` (design) |
| Comments | `toggle-show-comments` | ⇧C | Shift+C | `showComments`. Synonym "hide comments". Hidden from Quick actions on iPad |
| Annotations | `toggle-show-annotations` | ⇧Y | Shift+Y | `design dev_handoff !illustration` |
| Outlines ▸ | `outline-mode` | | | |
| · Outlines | `toggle-outlines` | ⇧⌘O (old-shortcuts pref: ⇧O); also ⌘Y, ⌃⇧3 | Ctrl+Shift+O | `showOutlines` |
| · Show hidden layers | `toggle-outline-mode-hidden-layers` | — | — | `showOutlineHiddenLayers` |
| · Show object bounds | `toggle-outline-mode-object-bounds` | — | — | `showOutlineObjectBounds` |
| Pixel preview | `toggle-pixel-preview` | ⇧⌘P (⌃P, ⌥⌘Y) | Ctrl+Shift+P, Ctrl+Alt+Y | `activeCanvasPixelPreview` |
| Mask outlines | `toggle-show-masks` | — | — | `showMasks` |
| Frame outlines | `toggle-show-artboard-outlines` | — | — | `showArtboardOutlines` |
| Memory usage | `toggle-memory-usage-indicator` | — | — | design/sites |
| Pick color (Dev Mode only) | `toggle-dropper` | | | `dev_handoff` |
| — | | | | |
| Additional labels | `toggle-show-property-labels` (callback) | — | — | `showPropertyLabels` |
| Minimize left navigation bar | `toggle-navbar` | — | — | gate `minimize_left_navigation_bar` |
| Minimize UI | `toggle-sidebar` (label `fullscreen_actions.minimize-ui`) | ⇧⌘\ (also ⇧\, ⇧.) | Ctrl+Shift+\ | `leftPanelCollapsed`. Synonym "expand UI" |
| Show/Hide UI | `toggle-ui` | ⌘\ (⌘.) | Ctrl+\ | `showUi` |
| Multiplayer cursors | `toggle-multiplayer-cursors` | ⌥⌘\ | Ctrl+Alt+\ | check = `hideMultiplayerCursors` false |
| Switch to Design / Draw / Dev Mode | `enter-design-mode` (dev/Draw), `enter-draw-mode` (gate `ce_il_root`, Draw access), `enter-inspect-mode` | ⇧D for design ⇄ Dev Mode | Shift+D | `enter-inspect-mode` disabled when Dev Mode is not allowed. Synonyms "mode","open" |
| Panels ▸ | `panels-menu` | | | `design view_restricted !dev_handoff` |
| · Open layers panel | `toggle-layers` | ⌥1 | Alt+1 | |
| · Libraries | `toggle-publish` | ⌥2 | Alt+2 | |
| · Open design panel | `show-design-panel` | ⌥8 | Alt+8 | `!illustration` |
| · Open prototype panel | `show-prototype-panel` | ⌥9 | Alt+9 | `!illustration` |
| · Open inspect panel | `show-inspect-panel` | — | — | `!edit` |
| · Toggle variables | `toggle-variables` | — | — | |
| — | | | | |
| Zoom in | `zoom-in` | ⌘+ (=, ⇧=, ⌘=, Num +) | Ctrl++ | disabled at the max zoom (`canZoomIn`) |
| Zoom out | `zoom-out` | ⌘– (−, Num −) | Ctrl+- | disabled at the min zoom |
| Zoom to 100% | `zoom-reset` | ⌘0, ⇧0 (or 0, see §6.3) | Ctrl+0 | |
| Zoom to fit | `zoom-to-fit` | ⇧1 / ⇧9 (or 1 / 9) | | |
| Zoom to selection | `zoom-to-selection` | ⇧2 (or 2) | | |
| — | | | | |
| Previous page / Next page | `page-previous` / `page-next` | Page Up / Page Down (panel draws 🌐↑ / 🌐↓) | | design, FigJam, Dev Mode |
| Zoom to previous / next frame | `previous-artboard` / `next-artboard` | ⇧N / N | | design, Dev Mode |
| Find previous / next frame | `previous-artboard-same-zoom` / `next-artboard-same-zoom` | Home / End | | |
| — | | | | |
| Interface scale ▸, Enter full screen, Always show tabs when presenting | `interface-scale-menu`, `toggle-full-screen`, `always-show-tabs-when-presenting` | see §3.10 | | `desktop_os_menu` only |

### 3.4 Object ▸ (CONFIRMED 858 + live `main-object.txt`). Flags `!dev_handoff !figmake !rfd_view !figspec`

| Item | id | Mac | Win | Notes |
|---|---|---|---|---|
| Create webpage | `create-webpage` | — | | Sites |
| Frame selection | `frame-selection` | ⌥⌘G | Ctrl+Alt+G | design |
| Group selection | `group-selection` | ⌘G | Ctrl+G | |
| Ungroup selection | `ungroup-selection` | ⌘⌫ (also ⇧⌘G) | Ctrl+Backspace, Ctrl+Shift+G | |
| — | | | | |
| Wrap in new section | `create-section-from-selection` | ⌘S | Ctrl+S | `!slides !cooper` |
| Convert to section | `replace-selected-frame-with-section` | — | | |
| Convert to frame | `convert-selected-nodes-to-frame` | — | | |
| — | | | | |
| Set as thumbnail / Restore default thumbnail | file-thumbnail item (name from the thumbnail manager) | — | | `edit` |
| Set as page thumbnail | page-thumbnail item | — | | gate `dse_library_pg_thumbnails` |
| — | | | | |
| Use as mask / Remove mask | `mask-selection` (Quick-actions label flips to `remove-mask` when the selection is a mask) | ⌃⌘M | Ctrl+Alt+M | |
| Create Make from design | `create-make-from-design` | — | | gate `bake_canvas` |
| — | | | | |
| Add auto layout | `stack-selection` | ⇧A | Shift+A | |
| More layout options ▸ | (module tL) | | | live: label only |
| Create component | `create-symbol` | ⌥⌘K | Ctrl+Alt+K | |
| Edit code / Create code layer / Native code layer / Restore design / Copy out design | `edit-code`, `create-code-layer-from-design`, `create-native-code-layer`, `restore-design-in-place-from-code`, `copy-out-design-from-code` | — | | Sites / gated |
| Slots ▸ | `slots-menu`: `convert-to-slot` (⇧⌘S), `convert-selected-nodes-to-frame`, `group-selection-into-slot`, —, `reset-slot-assignment` | | | |
| Reset instance | `reset-symbol` | — | | |
| Detach instance | `detach-instance` | ⌥⌘B | Ctrl+Alt+B | |
| Main component ▸ | `main-component`: `find-symbol` (Go to main component, ⌃⌥⌘K / Ctrl+Alt+Shift+K), `push-changes-to-main`, `restore-symbol-or-state-group` | | | design/sites |
| — | | | | |
| Bring to front | `bring-to-front` | ] (also ⌥⌘]) | ], Ctrl+Shift+] | |
| Bring forward | `bring-forward` | ⌘] (⌥⌘↑) | Ctrl+], Ctrl+Alt+Up | |
| Send backward | `send-backward` | ⌘[ (⌥⌘↓) | Ctrl+[, Ctrl+Alt+Down | |
| Send to back | `send-to-back` | [ (also ⌥⌘[) | [, Ctrl+Shift+[ | |
| — | | | | |
| Flip horizontal | `flip-horizontal` | ⇧H | Shift+H | |
| Flip vertical | `flip-vertical` | ⇧V | Shift+V | |
| Rotate 180˚ | `rotate-180` | — | | |
| Rotate 90˚ left | `rotate-90-counterclockwise` | — (⌥⌘← when the rotation pref is on, open question 4) | | |
| Rotate 90˚ right | `rotate-90-clockwise` | — | | |
| — | | | | |
| Flatten | `flatten-selection` | ⌥⇧F (also ⌘E) | Alt+Shift+F, Ctrl+E | |
| Outline stroke | `outline-stroke` | ⌥⌘O (old pref: ⇧⌘O) | Ctrl+Alt+O | |
| Boolean groups ▸ | `boolean-menu`: Union `live-boolean-union` ⌥⇧U, Subtract `-subtract` ⌥⇧S, Intersect `-intersect` ⌥⇧I, Exclude `-xor` ⌥⇧E | | Alt+Shift+… | |
| — | | | | |
| Show/Hide selection | `toggle-shown-for-selected-nodes` | ⇧⌘H | Ctrl+Shift+H | |
| Lock/Unlock selection | `toggle-locked-for-selected-nodes` | ⇧⌘L | Ctrl+Shift+L | |
| Unlock all | `unlock-all` | ⌥⇧⌘L | Ctrl+Shift+Alt+L | FigJam only in the menu, any editor via the key |
| Hide other layers | `hide-sibling-layers` | — | | design |
| Collapse layers | `collapse-layers` | ⌥L | Alt+L | |
| — | | | | |
| Remove fill | `remove-fill` | ⌥/ | Alt+/ | |
| Remove stroke | `remove-stroke` | ⇧/ | Shift+/ | |
| Swap fill and stroke | `swap-fill-and-stroke` | ⇧X | Shift+X | |
| Remove interactions | `remove-interactions-on-selection` | — | | design |
| Delete contents | `delete-contents` | — | | |

With gate `dsm_object_menu_redesign` the mask item and "Create Make" move under the thumbnail block (CONFIRMED 858 conditional).

### 3.5 Text ▸ (`edit`; CONFIRMED 858 + live `main-text.txt`)

| Item | id | Mac | Win |
|---|---|---|---|
| Bold | `toggle-bold` | ⌘B | Ctrl+B |
| Italic | `text-toggle-italic` | ⌘I | Ctrl+I |
| Underline | `text-toggle-underline` | ⌘U | Ctrl+U |
| Strikethrough | `text-toggle-strikethrough` | ⇧⌘X | Ctrl+Shift+X |
| Create link | `text-edit-hyperlink` | ⇧⌘U | Ctrl+Shift+U |
| — | | | |
| Bulleted list | `text-toggle-unordered-list` | ⇧⌘8 | Ctrl+Shift+8 |
| Numbered list | `text-toggle-ordered-list` | ⇧⌘7 | Ctrl+Shift+7 |
| — | | | |
| Alignment ▸ `text-align-menu` | left `text-align-left` ⌥⌘L · center `-center` ⌥⌘T · right `-right` ⌥⌘R · justified `-justified` ⌥⌘J · — · top / middle / bottom `text-align-top/-middle/-bottom` (no keys) | | Ctrl+Alt+L/T/R/J |
| Adjust ▸ `text-adjust-menu` | indent `text-indent-list` (⇥ / ⌘] in text) · dedent `text-dedent-list` (⇧⇥ / ⌘[) · font size + `text-font-size-increase` ⇧⌘> · − ⇧⌘< · weight + `text-bold-increase` ⌥⌘> · − ⌥⌘< · line height + `text-line-height-increase` ⌥⇧> · − ⌥⇧< · letter spacing + `text-letter-spacing-increase` ⌥> · − ⌥< | | Ctrl+… / Alt+… |
| Case ▸ `text-case-menu` | `text-original-case`, `text-upper-case`, `text-lower-case` | | |
| Text direction ▸ `text-directionality-menu` | `text-set-directionality-ltr`, `-rtl` | | |
| — | | | |
| Spell check ▸ `spell-check-menu` | enable / language items (module tu) | | |
| Show text suggestions | `toggle-text-suggestions-preference` | | AI gate `aip_magnolia` |
| Plugin text-review items | (381085 `dL`) | | |

### 3.6 Arrange ▸ (`edit`; CONFIRMED 858 + live `main-arrange.txt`)

| Item | id | Mac | Win |
|---|---|---|---|
| Round to pixel | `round-to-pixels` | — | — |
| — | | | |
| Align left | `align-left` | ⌥A (⌃⌘←) | Alt+A |
| Align horizontal centers | `align-horizontal-center` | ⌥H (⌃⌥⌘← / →) | Alt+H, Ctrl+Alt+Shift+Left/Right |
| Align right | `align-right` | ⌥D (⌃⌘→) | Alt+D |
| Align top | `align-top` | ⌥W (⌃⌘↑) | Alt+W |
| Align vertical centers | `align-vertical-center` | ⌥V (⌃⌥⌘↑ / ↓) | Alt+V, Ctrl+Alt+Shift+Up/Down (ChromeOS: Shift+Home/End) |
| Align bottom | `align-bottom` | ⌥S (⌃⌘↓) | Alt+S |
| — | | | |
| Tidy up | `tidy-up` | ⌃⌥T | Ctrl+Alt+Shift+T |
| — | | | |
| Pack horizontal / Pack vertical | `pack-horizontal` / `pack-vertical` | — | — |
| — | | | |
| Distribute horizontal spacing | `distribute-horizontal-spacing` | ⌃⌥H (⌃⌥⌘H) | Alt+Shift+H, Ctrl+Alt+Shift+H |
| Distribute vertical spacing | `distribute-vertical-spacing` | ⌃⌥V (⌃⌥⌘V) | Alt+Shift+V |
| — | | | |
| Distribute left / horizontal centers / right / top / vertical centers / bottom | `distribute-left`, `-horizontal-center`, `-right`, `-top`, `-vertical-center`, `-bottom` | — | — |

### 3.7 Vector ▸ (`edit design slides`)

Join selection `join-selection` ⌘J · Smooth join selection `smooth-join-selection` ⇧⌘J (Mac only) · Delete and heal selection `delete-and-heal-selection` ⇧⌫ · Split vector `break-vector-network-into-paths` · Simplify vector `set-tool-simplify-vector` (synonyms simplify, vector simplify, path simplify, smooth) · Offset vector `set-tool-offset-path` (synonyms offset, path offset, vector offset). CONFIRMED 858 + live `main-vector.txt`.

### 3.8 Plugins ▸, Widgets ▸

Built by modules 381085 / 194524 from the saved, recent, development and organisation extensions (not expanded in this chapter, see 17). Live: Plugins = Run last plugin `plugins-run-last` ⌥⌘P / Ctrl+Alt+P · — · Saved plugins ▸ · — · Manage plugins…. Widgets = Manage widgets… · Select all widgets. Quick actions do not recurse into `plugins-menu` / `widgets-menu`. Their items are indexed as `plugins-menu-item` by `extensionSearchString` (CONFIRMED 3653 `addFigmaMenuItemsToSearchMap`).

### 3.9 Preferences ▸ (CONFIRMED 858 + live `main-preferences.txt`)

| Item (live) | id | Check property | Flags |
|---|---|---|---|
| (Dev Mode) Code language ▸ / Unit ▸ | `dev-handoff-code-settings-language`, `-unit` | | `dev_handoff !limited_dev_mode` |
| Snap to geometry | `toggle-snapping-to-geometry` | `snapToGeometry` | edit design |
| Snap to objects | `toggle-snapping-to-objects` | `snapToObjects` | edit design |
| Snap to pixel grid | `toggle-snapping-to-pixels` | `snapToPixelGrid` | ⇧⌘' / Ctrl+Shift+' |
| Snap to dots | `toggle-snapping-to-dots` | `snapToDotGrid` | FigJam |
| — | | | |
| Keep tool selected after use | `toggle-sticky-tools` | `stickyTools` | design, dev. Hidden from Quick actions |
| (Windows) Disable pinch-zoom fix | `disable-pinch-zoom-fix` | `disablePinchZoomFix` | `platforms:["windows"]` |
| Highlight layers on hover | `toggle-layer-hover` | `layerHover` | |
| Rename duplicated layers | `toggle-copy-renaming` | `copyRenaming` | edit design |
| Show dimensions on objects | `toggle-annotations` | `renderAnnotations` | design |
| Hide canvas UI during changes | `toggle-viewport-overlay-hiding` | `temporarilyHideViewportOverlay` | design |
| Use smart quotes/symbols | `toggle-smart-text-substitution` | `smartQuotes` | edit design |
| Flip objects while resizing | `toggle-flip-during-resize` | `flipDuringResize` | edit design |
| (Sites) Set constraints automatically | `set-constraints-automatically-toggle` | | |
| — | | | |
| Keyboard zooms into selection | `toggle-keyboard-zoom-to-selection` | `keyboardZoomToSelection` | |
| Invert zoom direction | `toggle-invert-zoom` | `invertZoom` | |
| Ctrl+click opens right click menus | `toggle-ctrl-click-context-menu` | `ctrlClickContextMenu` | |
| — | | | |
| Use number keys for opacity | `toggle-use-numbers-for-opacity` | `editorState().useNumbersForOpacity` | edit design slides cooper |
| Use old shortcuts for outlines | `toggle-use-old-outline-shortcuts` | `useOldOutlineShortcuts` | design dev |
| Use ⌘⌥↑/↓ to rotate layers (Win: Ctrl+Alt+↑/↓) | `toggle-rotation-shortcuts` | `enableRotationShortcuts` | label built with the platform's keys |
| Play audio notifications in AI chat | `toggle-ai-sound-notification` | `aiSoundNotificationsEnabled` | |
| Open links in desktop app | `open-links-in-desktop-app` (callback) | auto-open | mac/windows |
| Show text suggestions / Show tool suggestions / Show Agents on canvas | `toggle-text-suggestions-preference`, `toggle-suggested-ai-actions-preference`, `toggle-show-chat-on-canvas` | `wantsTextSuggestions`, `wantsSuggestedAiActions`, `showChatOnCanvas` | AI gates |
| Use scroll wheel zoom / Right-click and drag to pan | from module e8 `Sd()` | | live only |
| — | | | |
| Theme ▸ | `theme-menu-option`: `theme-light-mode`, `theme-dark-mode`, `theme-system` (synonyms "theme", "dark mode" / "light mode") | | |
| Color profile… | (module tp `r()`) | | |
| Keyboard layout… | `keyboard-layout-menu-option` → opens the shortcuts panel on its Layout tab | | |
| Accessibility settings… | `accessibility-settings` | | |
| Permissions and helpers… | `browser-permissions` | | `!desktop` |
| Nudge amount… | `show-nudge-amount-picker` | | edit design sites slides cooper |

### 3.10 Help and account ▸ (`figma-account-menu`; CONFIRMED 858 + live `main-help.txt`)

Help page `open-help` · Keyboard shortcuts `open-shortcuts` ⌃⇧? (keys ⌃⇧/, both platforms Control) · Support forum `open-support-forum` · Video tutorials `open-tutorials` · Release notes `open-release-notes` (opens `/releases`) · Open font settings `open-font-settings` (`!desktop !integration design`) · — · Troubleshooting ▸ (`desktop_os_menu`) · — · Legal summary `open-legal-summary` (`/legal`) · Account settings `open-account-settings` · Log out `sign-out` (hidden from Quick actions).

### 3.11 The native OS menu bar (desktop; CONFIRMED asar `main.js`)

The app menu has its own items around the mirrored fullscreen menus (`desktop.menu.file_menu` … `help_menu`, `window_menu`). They are rebuilt from the view's `updateFullscreenMenuState` (INFERRED from `eA.eD.updateFullscreenMenuState`, debounced **250 ms** for plugin/widget data, CONFIRMED). Its own accelerators:

| Item | Accelerator |
|---|---|
| New tab / New Design file | CmdOrCtrl+T, CmdOrCtrl+N |
| New window | CmdOrCtrl+Shift+N |
| New FigJam file | CmdOrCtrl+Alt+N |
| Open file browser | CmdOrCtrl+O |
| Close tab | CmdOrCtrl+W |
| Close window | CmdOrCtrl+Shift+W (CmdOrCtrl+W when no tab) |
| Reopen closed tab | CmdOrCtrl+Shift+T |
| Select previous / next tab | Ctrl+Shift+Tab / Ctrl+Tab, plus hidden CmdOrCtrl+Shift+{ / } |
| Interface scale: reset / larger / smaller | Shift+CmdOrCtrl+Alt+0 / = / − |
| Minimize | CmdOrCtrl+M |
| Toggle developer tools | CmdOrCtrl+Alt+I (internal: Shift+CmdOrCtrl+Alt+I) |
| Copy link (`copy-link`, desktop only) | ⌘L / Ctrl+L (in the editor's JSON, `desktop` condition) |

Other `desktop.menu.*` keys: about, check_for_updates, color_space_menu (managed / sRGB / unmanaged), disable_hardware_acceleration, graphics_backend, prefer_high_performance_gpu, enable_haptic_feedback, show_figma_in_menu_bar / system_tray, recently_closed_tabs, reload_all_tabs, troubleshooting_menu (save debug info, network log, performance log, reset Figma and restart), open_file_url_from_clipboard, import_from_csv, export_as, export_slides_to_pdf.

## 4. Right-click menus

All canvas menus are the `dN.Q` dropdown with `showPoint:false`, anchored at a 10 × 10 rect `{left: x+100, top: y}` from the click, `removeDisabledItems:true` (disabled entries vanish). Selection menus use `recordingKey "layerMenu"`, the empty canvas `"canvasMenu"`, pages `"pageMenu"`. CONFIRMED 3653. Context menus open on right-click, or on Ctrl+click when the preference `ctrlClickContextMenu` is on (§3.9).

### 4.1 Empty canvas (nothing selected) — `pw` (CONFIRMED 3653 + live `context-empty-canvas.txt`)

Order: [iPad: Add comment, —] · **Paste here** `paste-here` (`edit`; not in Safari unless the clipboard can be read; FigJam labels it "Paste" ⌘V) · Unlock all (FigJam) · — · [FigJam: Cursor chat, —] · [Slides: Rewrite text] · **Show/Hide UI** `toggle-ui` ⌘\ · **Show/Hide comments** `toggle-show-comments` (label `fullscreen.context_menu.show_hide_comments`) ⇧C · — · **Cursor chat** `start-chat` / (disabled during a vote or when cursor chat is off) · **Actions…** `toggle-menu` ⌘K · **Plugins ▸** · **Widgets ▸** (not Dev Mode, not read-only) · Publish template (org) · [prototype canvas edit UI and no selection: —, Remove all interactions on page `remove-interactions-on-page`].

### 4.2 Selection menu (`SelectionContextMenu.contextMenu()`), one order for every selection type

Rows appear or vanish by flags and enabled state. CONFIRMED 3653. The per-type differences below are checked against the live captures `context-shape / text / frame / component / instance / multi`.

| # | Block | Items (id → label, key) |
|---|---|---|
| 1 | Text review | spelling suggestions, when spell check or a text-review plugin is on |
| 2 | Table cells (FigJam / Slides tables) | move row up/down, move column left/right · add column before/after · add row above/below · delete contents (⌫ shown), delete column, delete row · merge / split cells |
| 3 | iPad | Add comment |
| 4 | Copy / paste (Design, Draw, Sites, Slides, Buzz, Make) | **Copy** `copy` ⌘C (when the async clipboard can write) · **Paste here** `paste-here` (not in the Layers panel, slide carousel or Buzz carousel) · **Paste to replace** `paste-to-replace` ⇧⌘R (text edit mode: "Paste and match style" ⇧⌘V) · **Copy/Paste as ▸** `copy-paste-menu` (`edit`; view-only gets **Copy as ▸** `copy-as-menu`): Copy as text `copy-text`, Copy hyperlink / email / phone (the link under the cursor), Copy link `copy-link` ("Copy link to slide" on a slide), **Copy as code ▸** `copy-as-code` {CSS, CSS (all layers), iOS `copy-as-ios`, Android `copy-as-android`, and a Dev Mode upsell row when the plan lacks it}, Copy as SVG, Copy as animated SVG (gate `metronome`), Copy as PNG ⇧⌘C (each SVG/PNG row disabled-but-visible when export approvals block it), —, Copy properties ⌥⌘C, Paste properties ⌥⌘V, Paste animation (`metronome`) · Copy unlinked code layers · Duplicate (Slides/Buzz only, ⌘D) · Create link (text edit mode) · **Send to Figma Make** (`send-to-make-from-design`) or Create Make (`bake_canvas`) · Copy roundtrip diff (gate) · **Find similar designs** `find-inspiration` (`edit !slides !cooper`, AI search permission) · Check designs `detect-violations` · **Add motion ▸** (`metronome`; position, scale, rotation, opacity, More ▸ {corner radius, fill, stroke paint, stroke weight, drop shadow}, —, Apply animation style) · Inspect fragment (gate) |
| 5 | Delete | Delete `delete-selection` (FigJam / Slides only) |
| 6 | Slides / Buzz blocks | New slide, Create row, Select all slides, Skip / Unskip slide(s), thumbnail |
| 7 | FigJam export | copy-original-link, copy link, Copy as PNG, Export selection (`fullscreen.context_menu.export_selection`), Convert rich link to text, Export video |
| 8 | Navigation | **Select layer ▸** `select-node-menu` (when more than one layer lies under the cursor. Each row `select-node` "Select ‹name›", hovering highlights it. Not in the Layers panel) · **Move to page ▸** `page-move-to-menu` (`edit`, the file has ≥ 2 pages; every other page, dividers as separators; enabled when there is a page to move to and the selection holds a non-connector) |
| 9 | Order | Bring to front `bring-to-front` ] · Bring forward (FigJam/Slides only) · Send backward (FigJam/Slides only) · Send to back `send-to-back` [ |
| 10 | — | |
| 11 | Structure | Create webpage, Set as homepage (Sites) · **Convert to section** `replace-selected-frame-with-section` · **Convert to frame** `convert-selected-nodes-to-frame` (unless only slots) · **Group selection** ⌘G · **Frame selection** ⌥⌘G · **Wrap in new section** `create-section-from-selection` ⌘S · **Ungroup** `ungroup-selection` ⌘⌫ · **Rename** ⌘R (Layers panel only) · **Rename layers** `auto-rename-layers` (Layers panel + AI permission, "AI" badge) · **Flatten** ⌥⇧F · Split vector (Draw) · Separate / Combine text path · Wrap with transform (Draw) · **Outline stroke** ⌥⌘O · **Use as mask / Remove mask** ⌃⌘M · Create brush ▸ (Draw: stretch, scatter) · Set as primary breakpoint · Set as favicon / Clear favicon (Sites) · **Set as thumbnail / Restore default thumbnail** · Set page thumbnail (gate) |
| 12 | — | |
| 13 | Layout and components | **Add auto layout** `stack-selection` ⇧A or **Remove auto layout** `unstack-selection` ⌥⇧A (when the properties panel would offer removal) · **More layout options ▸** (multi-stack ⌃⇧A / Ctrl+Shift+Alt+A, remove all auto layout, resize to fit ⌥⇧⌘R) · **Create component** `create-symbol` ⌥⌘K · Change tag ▸ (Sites) · code-layer items (Sites) · Slots ▸ (`flattenIfSingleChild`) · Swap component ▸ / Swap variant ▸ (`swap-to-related-symbol` / `-state`, lazily built child dropdown) · **Reset instance** `reset-symbol` · reset overrides (Sites) · **Detach instance** ⌥⌘B · **Main component actions**, see below · Add annotation / Remove annotations (Design, Dev Mode) · [non-Design: Plugins, Widgets] · Publish to Community · FigJam "remove plugin actions" ▸ |
| 14 | — | |
| 15 | Visibility | **Show/Hide** ⇧⌘H (`fullscreen.context_menu.show_hide`) · **Lock/Unlock** ⇧⌘L (`…lock_unlock`) · Unlock all (FigJam) |
| 16 | — | |
| 17 | Flip | **Flip horizontal** ⇧H · **Flip vertical** ⇧V |
| 18 | — | Design / Draw: **Plugins ▸ · Widgets ▸** here (other editors earlier) |
| 19 | Misc | Set image as profile picture (FigJam) · prototype UI visible: —, Remove interactions, Add / Delete starting point · Slides object animation · internal debug items |

Main component actions (`getMainComponentActionsMenu`, CONFIRMED): count the enabled ones among Go to main component (`find-symbol`, not for default-library components), Push changes to main, Restore main component, Add variant, Publish. **0** → no row. **1** → that row inline (Go to main component ⌃⌥⌘K, Add variant, or Publish). **≥ 2** → "Main component ▸" with all five. The live instance capture shows "Go to main component ⌃⌥⌘K" inline.

Per type (live, CONFIRMED): shape and text show the same list (Find similar designs, Add motion, …, Add auto layout, Create component). A frame adds Convert to section, Ungroup, Set as thumbnail, Remove auto layout ⌥⇧A, More layout options. A component (main) has no Add motion, has Set as thumbnail and Main component ▸, no Create component. An instance shows Select layer, Reset instance, Detach instance ⌥⌘B, Go to main component ⌃⌥⌘K, and Add auto layout (it wraps). A multi-selection has no Find similar designs, adds Wrap in new section ⌘S and More layout options.

### 4.3 Other context menus (CONFIRMED 3653 / 7314 unless noted)

| Where | Items |
|---|---|
| **Text edit mode** (right-click inside text being edited) | spelling suggestions, Spell check ▸, text-review plugins · — · table cell block · — · the copy/paste block of §4.2 #4 · FigJam export block |
| **Layers panel row** (`isObjectsPanelMenu`) | §4.2 without Paste here and without Select layer; with Rename ⌘R and Rename layers (AI). Action source `"panel"` (live `context-layer-row.txt`) |
| **Select-layer menu** (`isSelectLayerMenu`) | only the list of layers under the cursor (when > 1) |
| **Ruler** | Remove all vertical / horizontal guides (`remove-vertical-guides` / `remove-horizontal-guides`, by the ruler's axis) · — · Hide rulers `toggle-rulers` ⇧R (`fullscreen.ruler_guide_context_menu.hide_rulers`) · [Buzz: Ruler unit ▸ pixels / inches] |
| **Guide** | Remove guide `remove-guide` |
| **Ruler and guide** | Remove guide, then the ruler items |
| **Page row, one page** (`pageMenu`) | Copy link to page `page-copy-link` · — · Rename page `page-rename` (`fullscreen_actions.pages-rename`, count 1) · Duplicate page `page-duplicate` (on Starter drafts at the page limit: an upgrade dialog instead) · Change status ▸ (gate `page_status`, Design, the main file of a branch set: None, each status with its emoji, —, Manage statuses) · — · Move up / Move down / Move to top / Move to bottom (`page-move-up`, `-down`, `-to-top`, `-to-bottom`, only the moves that are possible, hover previews the target) · — · Delete page `page-delete` (**disabled when it is the only page**) · [FigJam: —, Create Slides outline]. Live: "Copy link to page │ Rename page, Duplicate page │ Move up │ Delete page" |
| **Page rows, several** | Rename N pages `batch-page-rename` · — · moves · Delete pages (disabled when every page is selected) |
| **Divider row** | Duplicate divider · Add title (when the name is only dashes) · Delete divider |
| **Page row, read-only / K-12 student** | Copy link to page only |
| **Comment pin** | (comment thread) Resolve, Mark as read / unread, Copy link, — · Hide comments `toggle-show-comments`. Menu rect 224 × 129 |
| **Gradient stop** (in the gradient editor) | Redistribute stops · — · Delete stop |
| **Dev Mode code / layer** | Expand element · — · Add annotation · — · Copy ⌘C, Copy as text, Copy as SVG, Copy as animated SVG, Copy as PNG, Copy layer name, Copy link. Overview: Copy summary link |
| **Annotations button** | header "N annotations", View annotations (Design → Dev Mode), upsell row |
| **Ready-for-dev status** | Open in Dev Mode / Enter focus view, Copy link, Check designs, Mark as ready / completed, Remove status, note field |

## 5. When items are enabled (the predicates)

Design-editor enablement lives in C++ (`appModel` `actionEnabled[...]`, read in JS for a fixed list: `add-variant, combine-text-path-layers, delete-current-table-column, delete-current-table-row, delete-table-contents, destroy-all-auto-layout, find-symbol, publish-selection, push-changes-to-main, rename-selection, resize-to-fit, restore-symbol-or-state-group, run-multi-stack-auto-layout, select-node-menu, swap-to-related-state, swap-to-related-symbol`, CONFIRMED 3653 `pE`). The C++ predicates were not read. The **TypeScript action registry** in 7362 is the port used for FigJam / Slides / Buzz / Sites / Dev Mode (840 entries, `allowedEditorTypes` never includes DESIGN). Its predicates are the best available statement of the rules, so they are INFERRED to match Design's:

| Action | Enabled when (TS registry; `dsel` = directly selected counts, `rsel` = recursive) |
|---|---|
| top-level modes | `K` = layout mode only (580 actions), `z` = every mode (215), `Y` = layout + Dev Mode (24) |
| `undo` / `redo` | active canvas and undo allowed and something to undo (`canUndo`); the shortcut is inert in BRANCHING edit mode |
| `delete-selection` | something selected (or a guide), not in COMMENTS mode |
| `select-all`, `select-inverse`, `unlock-all` | always |
| `group-selection` | layout mode, ≥ 1 node, no state (variant) and no repeater children; FigJam needs ≥ 2 nodes all parented to canvas or section |
| `ungroup-selection` | a group-type node selected (more nodes than components), no primary instances, no instance sublayers, no immutable frames |
| `frame-selection` | layout mode, ≥ 1 node, no variant state, no section, no repeater child |
| `flatten-selection`, `outline-stroke` | more nodes than specs, ≥ 1 geometry node, no instance sublayers, no immutable frames, widgets, embeds or JSX, layout edit mode |
| `mask-selection` | no specs, ≥ 1 node, single selection must be maskable, no slot, no instance sublayers, … |
| `live-boolean-*` | ≥ 1 geometry node, no instance sublayers, no section, no immutable frames, widgets, embeds |
| `create-symbol` | shape-edit mode, no variant states, perf gate `canCreateSymbolFromDirectlySelectedNodes`, no repeaters, (Design) no code instances/layers |
| `detach-instance` | shape-edit mode and an instance outside a repeater (or a code instance that isn't layer- or main-like) |
| `flip-*` | no specs, not recording, no instance sublayers, widgets, slides, sections, webpages, breakpoints, responsive sets; not "unflippable" |
| `align-*` | not recording, ≥ 1 node, not a lone auto-layout container whose children are not absolute; vector/text modes have their own rules |
| `distribute-*` | not recording; vector mode: ≥ 1 node; else layout mode … |
| `tidy-up` | not recording, active canvas, a grid or list arrangement detected (`arrangeAsGridAxisDetected` / `ListAxisDetected`), not a lone auto-layout container |
| `bring-forward` etc. | ≥ 1 node, no table sublayer, layout mode, not only slides, no breakpoints or repeater children |
| `rename-selection` | ≥ 1 node, not slides, not a Sites homepage |
| `zoom-in` / `zoom-out` | `canZoomIn` / `canZoomOut` |
| `copy-as-png` | no spec nodes and perf gate `shouldEnableCopyAsPng` |
| `page-delete` | `canDeletePage` (more than one page). The page menu also disables it locally |
| `page-move-to-menu` | `documentRootChildCount > 1` and a non-connector selected |
| `swap-fill-and-stroke` | ≥ 1 geometry node or frame, no widget, webpage or responsive set |

## 6. The shortcut table

### 6.1 Format (CONFIRMED wasm @47 251 835)

`{ "<action-id>": [ { "editModes": [...], "shortcuts": [ "Key" | ["Key", cond, cond, …, {"display": "Shown"}] ] }, … ] }`

- **editModes**: `GLOBAL` with exclusions, the most common being `!TEXT` (inert while typing; 150 entries), `!VECTOR`, `!SLIDE_LAYOUT`, `!BRANCHING`, or positive modes `TEXT`, `VECTOR`, `WHITEBOARD_LAYOUT`, `SLIDE_LAYOUT`, `DEV_HANDOFF`. One action can have several entries (e.g. `zoom-in` with modifiers works in text; bare `=` does not).
- **Key names**: `Meta`, `Control`, `Alt`, `Shift`, then a key such as `A`, `=`, `Num +`, `Num 0`, `Backspace`, `Delete`, `Enter`, `Tab`, `Escape`, `Space`, `Left/Right/Up/Down`, `Home`, `End`, `Page Up`, `Page Down`, `F6`, or a layout character (`Ä`, `Ñ`, `§`, `¥`, `₩` …).
- **Conditions** (all must hold; counts across 1 183 bindings): platform `mac` (411) / `!mac` (384), `chromeos`, `safari`, `desktop`, `ipad`, `meet-device`; editor `figjam`, `design`, `slides`, `dev_handoff`, `illustration`, `buzz`, `sites`, `zoom`, `handoff_extension` (VS Code), `mcp_app`, `slides:slides` / `slides:design` (Slides' sub-mode); `pref:use-numbers-for-opacity`, `pref:use-old-outline-shortcuts`; `flag:<gate>`; `lab:<labs toggle>`; `layout:<id>` (keyboard layout, §7); `selection-only-slides-or-assets`.
- **display**: what the menu/panel shows when it differs from the keys (140 bindings, e.g. `Meta+Shift+=` shown as `Meta++`, `Shift+,` shown as `<`).
- Order matters: the **first applicable** binding is the one displayed (e.g. Flatten shows ⌥⇧F, not ⌘E; live confirms).

### 6.2 Every action (U.S. QWERTY / generic layout; Mac glyphs ⌃⌥⇧⌘, Windows as Ctrl/Alt/Shift; "Win" = the Windows key)

`[…]` lists the conditions (editor names joined by `/` = any of them, `!x` = not x). Edit-mode column: `—` = GLOBAL without exclusions. Rows whose only bindings are layout-specific (e.g. `toggle-ui`'s bare key, which exists only for non-U.S. layouts) show `—`. Their keys are in §7.3. CONFIRMED for every row (generated from the embedded JSON).

| Action id | Edit modes | Mac | Windows |
|---|---|---|---|
| `delete-selection` | !TEXT | ⌫, ⌦ | Backspace, Delete |
| `zoom-in` | — | ⇧⌘=(shows ⌘+), ⌘=, ⌘+, ⌘Num + | Ctrl+Shift+=(shows Ctrl++), Ctrl+=, Ctrl++, Ctrl+Num + |
| `zoom-in` | !TEXT | ⇧=(shows +), =(shows +), Num +, + | Shift+=(shows +), =(shows +), Num +, + |
| `zoom-out` | — | ⌘-, ⇧⌘-, ⌘Num - | Ctrl+-, Ctrl+Shift+-, Ctrl+Num - |
| `zoom-out` | !TEXT | -, ⇧-, Num - | -, Shift+-, Num - |
| `zoom-reset` | — | ⌘0 | Ctrl+0 |
| `zoom-reset` | !TEXT | 0 [!pref:use-numbers-for-opacity], ⇧0 [pref:use-numbers-for-opacity] | 0 [!pref:use-numbers-for-opacity], Shift+0 [pref:use-numbers-for-opacity] |
| `zoom-to-fit` | !TEXT | 1 [!pref:use-numbers-for-opacity], 9 [!pref:use-numbers-for-opacity], ⇧1 [pref:use-numbers-for-opacity], ⇧9 [pref:use-numbers-for-opacity] | 1 [!pref:use-numbers-for-opacity], 9 [!pref:use-numbers-for-opacity], Shift+1 [pref:use-numbers-for-opacity], Shift+9 [pref:use-numbers-for-opacity] |
| `zoom-to-selection` | !TEXT | 2 [!pref:use-numbers-for-opacity], ⇧2 [pref:use-numbers-for-opacity] | 2 [!pref:use-numbers-for-opacity], Shift+2 [pref:use-numbers-for-opacity] |
| `focus-previous-area` | — | ⇧F6 [figjam/design/slides/dev_handoff/illustration/buzz] | Ctrl+Shift+F6 [figjam/design/slides/dev_handoff/illustration/buzz] |
| `focus-next-area` | — | F6 [figjam/design/slides/dev_handoff/illustration/buzz] | Ctrl+F6 [figjam/design/slides/dev_handoff/illustration/buzz] |
| `set-opacity-0` | !TEXT | 0 [pref:use-numbers-for-opacity], Num 0 [pref:use-numbers-for-opacity], ⇧0 [!pref:use-numbers-for-opacity], ⇧Num 0 [!pref:use-numbers-for-opacity] | 0 [pref:use-numbers-for-opacity], Num 0 [pref:use-numbers-for-opacity], Shift+0 [!pref:use-numbers-for-opacity], Shift+Num 0 [!pref:use-numbers-for-opacity] |
| `set-opacity-1` | !TEXT | 1 [pref:use-numbers-for-opacity], Num 1 [pref:use-numbers-for-opacity], ⇧1 [!pref:use-numbers-for-opacity], ⇧Num 1 [!pref:use-numbers-for-opacity] | 1 [pref:use-numbers-for-opacity], Num 1 [pref:use-numbers-for-opacity], Shift+1 [!pref:use-numbers-for-opacity], Shift+Num 1 [!pref:use-numbers-for-opacity] |
| `set-opacity-2` | !TEXT | 2 [pref:use-numbers-for-opacity], Num 2 [pref:use-numbers-for-opacity], ⇧2 [!pref:use-numbers-for-opacity], ⇧Num 2 [!pref:use-numbers-for-opacity] | 2 [pref:use-numbers-for-opacity], Num 2 [pref:use-numbers-for-opacity], Shift+2 [!pref:use-numbers-for-opacity], Shift+Num 2 [!pref:use-numbers-for-opacity] |
| `set-opacity-3` | !TEXT | 3 [pref:use-numbers-for-opacity], Num 3 [pref:use-numbers-for-opacity], ⇧3 [!pref:use-numbers-for-opacity], ⇧Num 3 [!pref:use-numbers-for-opacity] | 3 [pref:use-numbers-for-opacity], Num 3 [pref:use-numbers-for-opacity], Shift+3 [!pref:use-numbers-for-opacity], Shift+Num 3 [!pref:use-numbers-for-opacity] |
| `set-opacity-4` | !TEXT | 4 [pref:use-numbers-for-opacity], Num 4 [pref:use-numbers-for-opacity], ⇧4 [!pref:use-numbers-for-opacity], ⇧Num 4 [!pref:use-numbers-for-opacity] | 4 [pref:use-numbers-for-opacity], Num 4 [pref:use-numbers-for-opacity], Shift+4 [!pref:use-numbers-for-opacity], Shift+Num 4 [!pref:use-numbers-for-opacity] |
| `set-opacity-5` | !TEXT | 5 [pref:use-numbers-for-opacity], Num 5 [pref:use-numbers-for-opacity], ⇧5 [!pref:use-numbers-for-opacity], ⇧Num 5 [!pref:use-numbers-for-opacity] | 5 [pref:use-numbers-for-opacity], Num 5 [pref:use-numbers-for-opacity], Shift+5 [!pref:use-numbers-for-opacity], Shift+Num 5 [!pref:use-numbers-for-opacity] |
| `set-opacity-6` | !TEXT | 6 [pref:use-numbers-for-opacity], Num 6 [pref:use-numbers-for-opacity], ⇧6 [!pref:use-numbers-for-opacity], ⇧Num 6 [!pref:use-numbers-for-opacity] | 6 [pref:use-numbers-for-opacity], Num 6 [pref:use-numbers-for-opacity], Shift+6 [!pref:use-numbers-for-opacity], Shift+Num 6 [!pref:use-numbers-for-opacity] |
| `set-opacity-7` | !TEXT | 7 [pref:use-numbers-for-opacity], Num 7 [pref:use-numbers-for-opacity], ⇧7 [!pref:use-numbers-for-opacity], ⇧Num 7 [!pref:use-numbers-for-opacity] | 7 [pref:use-numbers-for-opacity], Num 7 [pref:use-numbers-for-opacity], Shift+7 [!pref:use-numbers-for-opacity], Shift+Num 7 [!pref:use-numbers-for-opacity] |
| `set-opacity-8` | !TEXT | 8 [pref:use-numbers-for-opacity], Num 8 [pref:use-numbers-for-opacity], ⇧8 [!pref:use-numbers-for-opacity], ⇧Num 8 [!pref:use-numbers-for-opacity] | 8 [pref:use-numbers-for-opacity], Num 8 [pref:use-numbers-for-opacity], Shift+8 [!pref:use-numbers-for-opacity], Shift+Num 8 [!pref:use-numbers-for-opacity] |
| `set-opacity-9` | !TEXT | 9 [pref:use-numbers-for-opacity], Num 9 [pref:use-numbers-for-opacity], ⇧9 [!pref:use-numbers-for-opacity], ⇧Num 9 [!pref:use-numbers-for-opacity] | 9 [pref:use-numbers-for-opacity], Num 9 [pref:use-numbers-for-opacity], Shift+9 [!pref:use-numbers-for-opacity], Shift+Num 9 [!pref:use-numbers-for-opacity] |
| `debug-toggle-whiteboard-mode` | — | ⌃⌥⌘T [flag:switch_canvas_mode] | Ctrl+Win+Alt+T [flag:switch_canvas_mode] |
| `debug-toggle-sites-mode` | — | ⌃⌥⌘W [flag:switch_canvas_mode flag:sites] | Ctrl+Win+Alt+W [flag:switch_canvas_mode flag:sites] |
| `debug-toggle-figmake-mode` | — | ⌃⌥⌘B [flag:switch_canvas_mode] | Ctrl+Win+Alt+B [flag:switch_canvas_mode] |
| `debug-toggle-slides-mode` | — | ⌃⌥⌘S [flag:switch_canvas_mode] | Ctrl+Win+Alt+S [flag:switch_canvas_mode] |
| `debug-set-slides-grid-mode` | — | ⌃⌥⌘G [slides; flag:switch_canvas_mode] | Ctrl+Win+Alt+G [slides; flag:switch_canvas_mode] |
| `mode-quick-toggle-next` | !SLIDE_LAYOUT !TEXT | ⌥⇥ [!mcp_app flag:mode_quick_toggle] | Alt+` [!mcp_app flag:mode_quick_toggle] |
| `mode-quick-toggle-previous` | !SLIDE_LAYOUT !TEXT | ⌥⇧⇥ [!mcp_app flag:mode_quick_toggle] | Alt+Shift+` [!mcp_app flag:mode_quick_toggle] |
| `create-section-from-selection` | — | ⌘S | Ctrl+S |
| `create-savepoint` | — | ⌥⌘S | Ctrl+Alt+S |
| `export-selected-exportables` | — | ⇧⌘E [!figjam !sites !buzz !mcp_app] | Ctrl+Shift+E [!figjam !sites !buzz !mcp_app] |
| `export-buzz-assets` | — | ⇧⌘E [buzz] | Ctrl+Shift+E [buzz] |
| `export-selection-or-current-page` | — | ⇧⌘E [figjam] | Ctrl+Shift+E [figjam] |
| `paste-over-selection` | — | ⇧⌘V | Ctrl+Shift+V |
| `paste-to-replace` | — | ⇧⌘R [!safari], ⌥⇧⌘V | Ctrl+Shift+R, Ctrl+Alt+Shift+V |
| `duplicate-in-place` | — | ⌘D | Ctrl+D |
| `quick-create` | — | ⌘↩ [figjam] | Ctrl+Enter [figjam] |
| `quick-create-diagram-sibling` | — | ⇧⌘↩ [figjam] | Ctrl+Shift+Enter [figjam] |
| `flip-horizontal` | !TEXT | ⇧H | Shift+H |
| `flip-vertical` | !TEXT | ⇧V | Shift+V |
| `copy-properties` | — | ⌥⌘C | Ctrl+Alt+C |
| `paste-properties` | — | ⌥⌘V | Ctrl+Alt+V |
| `copy-as-png` | !TEXT | ⇧⌘C | Ctrl+Shift+C |
| `copy-link` | !TEXT | ⌘L [desktop] | Ctrl+L [desktop] |
| `remove-fill` | !TEXT | ⌥/ | Alt+/ |
| `remove-stroke` | !TEXT | ⇧/ [!figjam] | Shift+/ [!figjam] |
| `swap-fill-and-stroke` | !TEXT | ⇧X | Shift+X |
| `redo` | — | ⇧⌘Z | Ctrl+Y, Ctrl+Shift+Z |
| `undo` | !BRANCHING | ⌘Z | Ctrl+Z |
| `group-selection` | !TEXT | ⌘G | Ctrl+G |
| `frame-selection` | !TEXT | ⌥⌘G | Ctrl+Alt+G |
| `stack-selection` | !TEXT | ⇧A | Shift+A |
| `unstack-selection` | !TEXT | ⌥⇧A | Alt+Shift+A |
| `run-multi-stack-auto-layout` | !TEXT | ⌃⇧A | Ctrl+Alt+Shift+A |
| `ungroup-selection` | !TEXT | ⌘⌫, ⇧⌘G | Ctrl+Backspace, Ctrl+Shift+G |
| `move-text-selection-end` | TEXT | ⌃E | — |
| `move-text-selection-start` | TEXT | ⌃A | — |
| `extend-text-selection-end` | TEXT | ⌃⇧E | — |
| `extend-text-selection-start` | TEXT | ⌃⇧A | — |
| `move-text-selection-forward` | TEXT | →, ⌃F | Right |
| `move-text-selection-backward` | TEXT | ←, ⌃B | Left |
| `extend-text-selection-forward` | TEXT | ⇧→, ⌃⇧→, ⌃⇧F | Shift+Right, Ctrl+Shift+Right |
| `extend-text-selection-backward` | TEXT | ⇧←, ⌃⇧←, ⌃⇧B | Shift+Left, Ctrl+Shift+Left |
| `unlock-all` | !TEXT | ⌥⇧⌘L | Ctrl+Alt+Shift+L |
| `select-child` | !TEXT | ↩ | Enter |
| `select-parent` | !TEXT | \, ⇧↩ | \, Shift+Enter |
| `select-next-sibling` | !TEXT | ⇥ [!figjam] | Tab [!figjam] |
| `select-previous-sibling` | !TEXT | ⇧⇥ [!figjam] | Shift+Tab [!figjam] |
| `select-next-node` | !TEXT | ⇥ [figjam] | Tab [figjam] |
| `select-previous-node` | !TEXT | ⇧⇥ [figjam] | Shift+Tab [figjam] |
| `select-all` | — | ⌘A | Ctrl+A |
| `select-inverse` | !TEXT | ⇧⌘A | Ctrl+Shift+A |
| `set-tool-keyboard-select` | !TEXT | ⌥Space [design/illustration/dev_handoff/figjam/slides] | Ctrl+Space [design/illustration/dev_handoff/figjam/slides] |
| `join-selection` | !TEXT | ⌘J | Ctrl+J |
| `smooth-join-selection` | !TEXT | ⇧⌘J | — |
| `delete-and-heal-selection` | !TEXT | ⇧⌫ [!figjam], ⇧⌦ [!figjam] | Shift+Backspace [!figjam], Shift+Delete [!figjam] |
| `flatten-selection` | !TEXT | ⌥⇧F, ⌘E | Alt+Shift+F, Ctrl+E |
| `outline-stroke` | !TEXT | ⇧⌘O [pref:use-old-outline-shortcuts], ⌥⌘O [!pref:use-old-outline-shortcuts] | Ctrl+Shift+O [pref:use-old-outline-shortcuts], Ctrl+Alt+O [!pref:use-old-outline-shortcuts] |
| `bring-forward` | !TEXT !VECTOR | ⌘] [!selection-only-slides-or-assets], ⌥⌘↑ [!selection-only-slides-or-assets] | Ctrl+] [!selection-only-slides-or-assets], Ctrl+Alt+Up [!selection-only-slides-or-assets] |
| `send-backward` | !TEXT !VECTOR | ⌘[ [!selection-only-slides-or-assets], ⌥⌘↓ [!selection-only-slides-or-assets] | Ctrl+[ [!selection-only-slides-or-assets], Ctrl+Alt+Down [!selection-only-slides-or-assets] |
| `bring-to-front` | !TEXT | ], ⌥⌘] | ], Ctrl+Shift+] |
| `send-to-back` | !TEXT | [, ⌥⌘[ | [, Ctrl+Shift+[ |
| `text-dedent-list` | TEXT | ⌘[, ⌥⌘[, ⌃⌘[, ⇧⌘[, ⇧⇥ | Ctrl+[, Ctrl+Alt+[, Ctrl+Shift+[, Shift+Tab |
| `text-indent-list` | TEXT | ⌘], ⌥⌘], ⌃⌘], ⇧⌘], ⇥ | Ctrl+], Ctrl+Alt+], Ctrl+Shift+], Tab |
| `mask-selection` | !TEXT | ⌃⌘M | Ctrl+Alt+M |
| `rename-selection` | — | ⌘R [!safari], ⇧⌘R [safari] | Ctrl+R |
| `resize-to-fit` | !TEXT | ⌥⇧⌘R | Ctrl+Alt+Shift+R |
| `canvas-search` | — | ⌘F | Ctrl+F |
| `canvas-search-next` | — | ⇧⌘F | Ctrl+Shift+F |
| `canvas-search-prev` | — | ⇧⌘D | Ctrl+Shift+D |
| `toggle-shown-for-selected-nodes` | !TEXT | ⇧⌘H [!figjam] | Ctrl+Shift+H [!figjam] |
| `toggle-shown-layout-grids` | !TEXT | ⇧G, ⌃G, ⌃⇧4 | Shift+G, Ctrl+Shift+4 |
| `toggle-show-annotations` | !TEXT | ⇧Y [!figjam !handoff_extension !slides !sites !illustration] | Shift+Y [!figjam !handoff_extension !slides !sites !illustration] |
| `toggle-locked-for-selected-nodes` | !TEXT | ⇧⌘L | Ctrl+Shift+L |
| `toggle-rulers` | !TEXT | ⇧R | Shift+R |
| `collapse-layers` | !TEXT | ⌥L | Alt+L |
| `toggle-bold` | — | ⌘B | Ctrl+B |
| `text-toggle-italic` | — | ⌘I | Ctrl+I |
| `text-toggle-underline` | — | ⌘U | Ctrl+U |
| `text-edit-hyperlink` | — | ⇧⌘U [!sites] | Ctrl+Shift+U [!sites] |
| `focus-link-panel` | — | ⇧⌘U [sites] | Ctrl+Shift+U [sites] |
| `text-toggle-strikethrough` | — | ⇧⌘X | Ctrl+Shift+X |
| `text-delete-selection-or-end` | TEXT | ⌃K | — |
| `text-delete-selection-or-next-character` | TEXT | ⌃D | — |
| `toggle-grid` | !TEXT | ⇧' | Shift+' |
| `toggle-grid` | — | ⌘' | Ctrl+' |
| `toggle-menu` | !BRANCHING | ⌘K [!mcp_app], ⌘/ [!mcp_app], ⌘P [!mcp_app !handoff_extension] | Ctrl+K [!mcp_app], Ctrl+/ [!mcp_app], Ctrl+P [!mcp_app !handoff_extension] |
| `toggle-outlines` | !TEXT | ⇧O [pref:use-old-outline-shortcuts], ⇧⌘O [!pref:use-old-outline-shortcuts] | Shift+O [pref:use-old-outline-shortcuts], Ctrl+Shift+O [!pref:use-old-outline-shortcuts] |
| `toggle-outlines` | — | ⌘Y, ⌃⇧3 | Ctrl+Shift+3 |
| `toggle-preferences` | — | ⌘, | — |
| `toggle-snapping-to-pixels` | — | ⇧⌘' | Ctrl+Shift+' |
| `toggle-sidebar` | — | ⇧⌘\ [!layout:portuguese] | Ctrl+Shift+\ |
| `toggle-sidebar` | !TEXT | ⇧\, ⇧. [!slides !buzz] | Shift+\, Shift+. [!slides !buzz] |
| `toggle-ui` | !TEXT | — | — |
| `toggle-ui` | — | ⌘\, ⌘. [!layout:hiragana_kana] | Ctrl+\ |
| `toggle-multiplayer-cursors` | — | ⌥⌘\ | Ctrl+Alt+\ |
| `toggle-show-comments` | !TEXT | ⇧C [!ipad] | Shift+C [!ipad] |
| `toggle-show-feature-flag-bisector` | !TEXT | ⌃⌥⌘X [flag:internal_only_debug_tools] | Ctrl+Win+Alt+X [flag:internal_only_debug_tools] |
| `toggle-layers` | !TEXT | ⌥1 [!chromeos !sites], ⌥⇧1 [chromeos !sites] | Alt+1 [!chromeos !sites], Alt+Shift+1 [chromeos !sites] |
| `toggle-publish` | !TEXT | ⌥2 [!chromeos !sites], ⌥⇧2 [chromeos !sites] | Alt+2 [!chromeos !sites], Alt+Shift+2 [chromeos !sites] |
| `toggle-library` | !TEXT | ⌥⌘O [pref:use-old-outline-shortcuts], ⌥3 [!chromeos !sites], ⌥⇧3 [chromeos !sites] | Ctrl+Alt+O [pref:use-old-outline-shortcuts], Alt+3 [!chromeos !sites], Alt+Shift+3 [chromeos !sites] |
| `toggle-section-visibility` | !TEXT | ⇧⌘H [figjam] | Ctrl+Shift+H [figjam] |
| `component-insert` | !TEXT | ⇧I [!figjam !slides !sites !buzz] | Shift+I [!figjam !slides !sites !buzz] |
| `browse-all-resources-modal` | !TEXT | ⇧I [figjam/slides] | Shift+I [figjam/slides] |
| `toggle-pixel-preview` | — | ⇧⌘P [!handoff_extension], ⌃P, ⌥⌘Y | Ctrl+Shift+P [!handoff_extension], Ctrl+Alt+Y |
| `place` | — | ⇧⌘K | Ctrl+Shift+K |
| `create-symbol` | — | ⌥⌘K | Ctrl+Alt+K |
| `detach-instance` | — | ⌥⌘B | Ctrl+Alt+B |
| `find-symbol` | — | ⌃⌥⌘K | Ctrl+Alt+Shift+K |
| `convert-to-slot` | !TEXT | ⇧⌘S | Ctrl+Shift+S |
| `create-slide` | !TEXT | ⇧S [slides] | Shift+S [slides] |
| `toggle-animate-info` | !TEXT !VECTOR | ⇧E [slides] | Shift+E [slides] |
| `toggle-grid-focus-view` | !TEXT | ⇧. [slides/buzz] | Shift+. [slides/buzz] |
| `reorder-forward` | !TEXT | ⌘] [selection-only-slides-or-assets] | Ctrl+] [selection-only-slides-or-assets] |
| `reorder-backward` | !TEXT | ⌘[ [selection-only-slides-or-assets] | Ctrl+[ [selection-only-slides-or-assets] |
| `escape` | — | ⎋ | Escape |
| `toggle-edit-mode` | — | ⌘↩ [!figjam !flag:ai_assistant] | Ctrl+Enter [!figjam !flag:ai_assistant] |
| `toggle-dropper` | — | ⌃C | — |
| `toggle-dropper` | !TEXT | I | I |
| `start-chat` | !TEXT | / | / |
| `start-ai-assistant` | !TEXT | ⌘↩ [!figjam flag:ai_assistant] | Ctrl+Enter [!figjam flag:ai_assistant] |
| `open-shortcuts` | — | ⌃⇧/(shows ⌃⇧?) [!layout:german !layout:norwegian] | Ctrl+Shift+/(shows Ctrl+Shift+?) [!layout:german !layout:norwegian] |
| `toggle-recording-interactions` | — | ⌃⌥⌘R | Ctrl+Win+Alt+R |
| `toggle-perf-hud` | — | ⌃⌥⌘0 | Ctrl+Alt+Shift+0 |
| `toggle-fake-mp-activity` | — | ⌃⌥⌘m | Ctrl+Alt+Shift+m |
| `toggle-allow-time-sliced-edit-rendering-optimization` | — | ⌃⌥⌘y [figjam] | Ctrl+Alt+Shift+y [figjam] |
| `previous-artboard` | !TEXT | ⇧N [!figjam !slides] | Shift+N [!figjam !slides] |
| `next-artboard` | !TEXT | N [!figjam !slides] | N [!figjam !slides] |
| `previous-artboard-same-zoom` | !TEXT | Home [!figjam !slides] | Home [!figjam !slides] |
| `next-artboard-same-zoom` | !TEXT | End [!figjam !slides] | End [!figjam !slides] |
| `page-previous` | !TEXT | Page Up | Page Up |
| `page-next` | !TEXT | Page Down | Page Down |
| `text-align-left` | — | ⌥⌘L | Ctrl+Alt+L |
| `text-align-right` | — | ⌥⌘R | Ctrl+Alt+R |
| `text-align-center` | — | ⌥⌘T | Ctrl+Alt+T |
| `text-align-justified` | — | ⌥⌘J | Ctrl+Alt+J |
| `text-style-title` | — | ⌥⌘1 [figjam] | Ctrl+Alt+1 [figjam] |
| `text-style-h1` | — | ⌥⌘2 [figjam] | Ctrl+Alt+2 [figjam] |
| `text-style-h2` | — | ⌥⌘3 [figjam] | Ctrl+Alt+3 [figjam] |
| `text-style-h3` | — | ⌥⌘4 [figjam] | Ctrl+Alt+4 [figjam] |
| `text-style-normal` | — | ⌥⌘0 [figjam], ⌥⌘5 [figjam] | Ctrl+Alt+0 [figjam], Ctrl+Alt+5 [figjam] |
| `text-font-size-decrease` | — | ⇧⌘,(shows ⇧⌘<) [!figjam] | Ctrl+Shift+,(shows Ctrl+Shift+<) [!figjam] |
| `text-font-size-increase` | — | ⇧⌘.(shows ⇧⌘>) [!figjam] | Ctrl+Shift+.(shows Ctrl+Shift+>) [!figjam] |
| `text-letter-spacing-decrease` | — | ⌥,(shows ⌥<) | Alt+,(shows Alt+<) |
| `text-letter-spacing-increase` | — | ⌥.(shows ⌥>) | Alt+.(shows Alt+>) |
| `text-line-height-decrease` | — | ⌥⇧,(shows ⌥⇧<) | Alt+Shift+,(shows Alt+Shift+<) |
| `text-line-height-increase` | — | ⌥⇧.(shows ⌥⇧>) | Alt+Shift+.(shows Alt+Shift+>) |
| `text-bold-decrease` | — | ⌥⌘,(shows ⌥⌘<) | Ctrl+Alt+,(shows Ctrl+Alt+<) |
| `text-bold-increase` | — | ⌥⌘.(shows ⌥⌘>) | Ctrl+Alt+.(shows Ctrl+Alt+>) |
| `text-toggle-unordered-list` | — | ⇧⌘8 | Ctrl+Shift+8 |
| `text-toggle-ordered-list` | — | ⇧⌘7 | Ctrl+Shift+7 |
| `align-left` | !TEXT | ⌥A, ⌃⌘← | Alt+A |
| `align-right` | !TEXT | ⌥D, ⌃⌘→ | Alt+D |
| `align-top` | !TEXT | ⌥W, ⌃⌘↑ | Alt+W |
| `align-bottom` | !TEXT | ⌥S, ⌃⌘↓ | Alt+S |
| `align-horizontal-center` | !TEXT | ⌥H, ⌃⌥⌘←, ⌃⌥⌘→ | Alt+H, Ctrl+Alt+Shift+Left, Ctrl+Alt+Shift+Right |
| `align-vertical-center` | !TEXT | ⌥V, ⌃⌥⌘↑, ⌃⌥⌘↓, ⇧Home [chromeos], ⇧End [chromeos] | Alt+V, Ctrl+Alt+Shift+Up [!chromeos], Ctrl+Alt+Shift+Down [!chromeos], Shift+Home [chromeos], Shift+End [chromeos] |
| `tidy-up` | !TEXT | ⌃⌥T | Ctrl+Alt+Shift+T |
| `distribute-horizontal-spacing` | !TEXT | ⌃⌥H, ⌃⌥⌘H | Alt+Shift+H, Ctrl+Alt+Shift+H |
| `distribute-vertical-spacing` | !TEXT | ⌃⌥V, ⌃⌥⌘V | Alt+Shift+V |
| `show-rotation-origin` | !TEXT | ⌥R | Alt+R |
| `plugins-run-last` | — | ⌥⌘P | Ctrl+Alt+P |
| `dev-handoff-focus-next` | !TEXT | → [dev_handoff] | Right [dev_handoff] |
| `dev-handoff-focus-previous` | !TEXT | ← [dev_handoff] | Left [dev_handoff] |
| `dev-handoff-extension-open-command-palette` | DEV_HANDOFF | ⇧⌘P [handoff_extension] | Ctrl+Shift+P [handoff_extension] |
| `dev-handoff-extension-open-file-search` | DEV_HANDOFF | ⌘P [handoff_extension] | Ctrl+P [handoff_extension] |
| `dev-handoff-extension-close-window` | DEV_HANDOFF | ⌘W [handoff_extension] | Ctrl+W [handoff_extension] |
| `dev-handoff-extension-quit-app` | DEV_HANDOFF | ⌘Q [handoff_extension] | — |
| `show-design-panel` | !TEXT | ⌥8 [!dev_handoff] | Alt+8 [!dev_handoff] |
| `show-prototype-panel` | !TEXT | ⌥9 [!dev_handoff !illustration] | Alt+9 [!dev_handoff !illustration] |
| `show-dev-mode-inspect-panel` | — | ⌥8 [dev_handoff] | Alt+8 [dev_handoff] |
| `show-dev-mode-plugins-panel` | — | ⌥9 [dev_handoff] | Alt+9 [dev_handoff] |
| `toggle-prototyping-info` | !TEXT !VECTOR | ⇧E [!figjam !slides !illustration] | Shift+E [!figjam !slides !illustration] |
| `enter-design-mode` | !TEXT | ⇧D [dev_handoff; !handoff_extension !mcp_app !slides !buzz] | Shift+D [dev_handoff; !handoff_extension !mcp_app !slides !buzz] |
| `enter-inspect-mode` | !TEXT | ⇧D [!dev_handoff !figjam !zoom !sites !slides !buzz] | Shift+D [!dev_handoff !figjam !zoom !sites !slides !buzz] |
| `enter-slides-design-mode` | !TEXT | ⇧D [slides:slides !buzz] | Shift+D [slides:slides !buzz] |
| `enter-slides-mode` | !TEXT | ⇧D [slides:design !buzz] | Shift+D [slides:design !buzz] |
| `toggle-buzz-tool-mode` | !TEXT | ⇧D [buzz] | Shift+D [buzz] |
| `toggle-recording` | !TEXT | ⇧K [design; flag:metronome] | Shift+K [design; flag:metronome] |
| `set-tool-frame` | !TEXT | F [!figjam], A | F [!figjam], A |
| `set-tool-section` | !TEXT | ⇧S [!slides] | Shift+S [!slides] |
| `set-tool-sticky` | !TEXT | S [figjam], S [design; lab:collab-tool-shortcuts-in-design] | S [figjam], S [design; lab:collab-tool-shortcuts-in-design] |
| `set-tool-slice` | !TEXT | S [!figjam !design], S [design; !lab:collab-tool-shortcuts-in-design] | S [!figjam !design], S [design; !lab:collab-tool-shortcuts-in-design] |
| `set-tool-line` | !TEXT !VECTOR | L [!figjam] | L [!figjam] |
| `set-tool-arrow` | !TEXT | ⇧L [!figjam] | Shift+L [!figjam] |
| `set-tool-pen` | !TEXT | P [!figjam] | P [!figjam] |
| `set-tool-pencil` | !TEXT | M [figjam], P [figjam], ⇧P | M [figjam], P [figjam], Shift+P |
| `set-tool-eraser` | !TEXT | ⇧⌫ [figjam], ⇧⌦ [figjam] | Shift+Backspace [figjam], Shift+Delete [figjam] |
| `set-tool-highlighter` | !TEXT !VECTOR | ⇧M [figjam] | Shift+M [figjam] |
| `set-tool-code-block` | !TEXT | ` [figjam/slides], ⇧⌘. [figjam/slides; !layout:unknown !layout:us_qwerty !layout:dvorak] | ` [figjam/slides], Ctrl+Shift+. [figjam/slides; !layout:unknown !layout:us_qwerty !layout:dvorak] |
| `set-tool-brush` | !TEXT !VECTOR | B [illustration] | B [illustration] |
| `set-tool-cut` | VECTOR | X | X |
| `set-tool-paint-bucket` | VECTOR | ⇧B | Shift+B |
| `set-tool-vector-eraser` | VECTOR | ⇧E | Shift+E |
| `set-tool-vector-eraser` | !TEXT !VECTOR | ⇧E [illustration] | Shift+E [illustration] |
| `set-tool-shape-builder` | !TEXT | M [!figjam !slides] | M [!figjam !slides] |
| `set-tool-var-width-point` | !TEXT | ⇧W | Shift+W |
| `set-tool-shape-whiteboard-square` | !TEXT | R [figjam], R [slides:slides] | R [figjam], R [slides:slides] |
| `set-tool-rectangle` | !TEXT | R [!figjam !slides], R [slides:design], ⌥⇧R [slides:slides] | R [!figjam !slides], R [slides:design], Alt+Shift+R [slides:slides] |
| `set-tool-shape-whiteboard-ellipse` | !TEXT | O [figjam], O [slides:slides] | O [figjam], O [slides:slides] |
| `set-tool-ellipse` | !TEXT | O [!figjam !slides], O [slides:design] | O [!figjam !slides], O [slides:design] |
| `set-tool-scale` | !TEXT | K | K |
| `set-tool-type` | !TEXT | T | T |
| `set-tool-default` | !TEXT | V [!figjam !dev_handoff] | V [!figjam !dev_handoff] |
| `set-tool-default-figjam` | !TEXT | V [figjam] | V [figjam] |
| `set-tool-default-dev-handoff` | DEV_HANDOFF | V [dev_handoff] | V [dev_handoff] |
| `set-tool-comments` | !TEXT | C [!ipad !meet-device] | C [!ipad !meet-device] |
| `set-tool-connector-elbowed` | !TEXT !VECTOR | X [figjam/slides], ⇧L [figjam] | X [figjam/slides], Shift+L [figjam] |
| `set-tool-connector-straight` | !TEXT !VECTOR | L [figjam] | L [figjam] |
| `set-tool-hand` | !TEXT | H | H |
| `set-tool-washi-tape` | !TEXT | W [figjam] | W [figjam] |
| `set-tool-table` | !TEXT | ⇧T [figjam/slides] | Shift+T [figjam/slides] |
| `set-tool-spec` | !TEXT !VECTOR | D [design/illustration/figjam; flag:fspc_0] | D [design/illustration/figjam; flag:fspc_0] |
| `set-tool-annotate` | !TEXT | Y [!figjam !handoff_extension !slides !sites], ⇧T [!figjam !handoff_extension !slides !sites] | Y [!figjam !handoff_extension !slides !sites], Shift+T [!figjam !handoff_extension !slides !sites] |
| `set-tool-measure` | !TEXT !VECTOR | ⇧M [!figjam !handoff_extension !sites] | Shift+M [!figjam !handoff_extension !sites] |
| `set-tool-sites-responsive-set` | !TEXT | W [sites; flag:sites] | W [sites; flag:sites] |
| `set-tool-code-component` | !TEXT | B [sites], B [design; flag:bake_canvas !lab:collab-tool-shortcuts-in-design] | B [sites], B [design; flag:bake_canvas !lab:collab-tool-shortcuts-in-design] |
| `debug-selection` | — | ⌃⌥⌘I | Ctrl+Win+Alt+I |
| `debug-toggle-figma-scope` | — | ⌃⌥⌘F [flag:internal_only_debug_tools] | Ctrl+Win+Alt+F [flag:internal_only_debug_tools] |
| `present-as-prototype` | — | ⌥⌘↩ [!slides !sites] | Ctrl+Alt+Enter [!slides !sites] |
| `present-sites-full-preview` | — | ⌥⌘↩ [sites] | Ctrl+Alt+Enter [sites] |
| `present-slides-audience-view` | — | ⌥⌘↩ [slides] | Ctrl+Alt+Enter [slides] |
| `present-slides-presenter-view` | — | ⌥⇧⌘↩ [slides] | Ctrl+Alt+Shift+Enter [slides] |
| `focus-mode-component-set-toggle` | !TEXT !VECTOR | Q [design/sites] | Q [design/sites] |
| `select-matching` | !TEXT | ⌥⌘A | Ctrl+Alt+A |
| `live-boolean-union` | !TEXT | ⌥⇧U [!figjam !slides:slides !dev_handoff] | Alt+Shift+U [!figjam !slides:slides !dev_handoff] |
| `live-boolean-subtract` | !TEXT | ⌥⇧S [!figjam !slides:slides !dev_handoff] | Alt+Shift+S [!figjam !slides:slides !dev_handoff] |
| `live-boolean-intersect` | !TEXT | ⌥⇧I [!figjam !slides:slides !dev_handoff] | Alt+Shift+I [!figjam !slides:slides !dev_handoff] |
| `live-boolean-xor` | !TEXT | ⌥⇧E [!figjam !slides:slides !dev_handoff] | Alt+Shift+E [!figjam !slides:slides !dev_handoff] |
| `set-sites-view-file` | !TEXT | ⌥1 [sites; !chromeos], ⌥⇧1 [sites; chromeos] | Alt+1 [sites; !chromeos], Alt+Shift+1 [sites; chromeos] |
| `set-sites-view-code` | !TEXT | ⌥2 [sites; !chromeos], ⌥⇧2 [sites; chromeos] | Alt+2 [sites; !chromeos], Alt+Shift+2 [sites; chromeos] |
| `set-sites-view-cms` | !TEXT | ⌥3 [sites; !chromeos], ⌥⇧3 [sites; chromeos] | Alt+3 [sites; !chromeos], Alt+Shift+3 [sites; chromeos] |
| `set-sites-inserts-overlay` | !TEXT | ⇧I [sites] | Shift+I [sites] |
| `set-buzz-inserts-panel` | !TEXT | ⇧I [buzz] | Shift+I [buzz] |
| `select-current-table-cell` | WHITEBOARD_LAYOUT SLIDE_LAYOUT TEXT | ⌥⌘Space [figjam/slides] | Ctrl+Alt+Space [figjam/slides] |
| `add-table-row-above` | WHITEBOARD_LAYOUT SLIDE_LAYOUT | ⌥⇧↩ [figjam/slides] | Alt+Shift+Enter [figjam/slides] |
| `add-table-row-below` | WHITEBOARD_LAYOUT SLIDE_LAYOUT | ⌥↩ [figjam/slides] | Alt+Enter [figjam/slides] |
| `add-table-column-before` | WHITEBOARD_LAYOUT SLIDE_LAYOUT | ⌥[ [figjam/slides] | Alt+[ [figjam/slides] |
| `add-table-column-after` | WHITEBOARD_LAYOUT SLIDE_LAYOUT | ⌥] [figjam/slides] | Alt+] [figjam/slides] |
| `resize-table-row-increase` | WHITEBOARD_LAYOUT SLIDE_LAYOUT | ⌥↓ [figjam] | Alt+Down [figjam] |
| `resize-table-row-decrease` | WHITEBOARD_LAYOUT SLIDE_LAYOUT | ⌥↑ [figjam] | Alt+Up [figjam] |
| `resize-table-row-increase-large` | WHITEBOARD_LAYOUT SLIDE_LAYOUT | ⌥⇧↓ [figjam] | Alt+Shift+Down [figjam] |
| `resize-table-row-decrease-large` | WHITEBOARD_LAYOUT SLIDE_LAYOUT | ⌥⇧↑ [figjam] | Alt+Shift+Up [figjam] |
| `resize-table-column-increase` | WHITEBOARD_LAYOUT SLIDE_LAYOUT | ⌥→ [figjam] | Alt+Right [figjam] |
| `resize-table-column-decrease` | WHITEBOARD_LAYOUT SLIDE_LAYOUT | ⌥← [figjam] | Alt+Left [figjam] |
| `resize-table-column-increase-large` | WHITEBOARD_LAYOUT SLIDE_LAYOUT | ⌥⇧→ [figjam] | Alt+Shift+Right [figjam] |
| `resize-table-column-decrease-large` | WHITEBOARD_LAYOUT SLIDE_LAYOUT | ⌥⇧← [figjam] | Alt+Shift+Left [figjam] |
| `merge-selected-table-cells` | WHITEBOARD_LAYOUT | ⌥M [figjam] | Alt+M [figjam] |
| `split-selected-table-cells` | WHITEBOARD_LAYOUT | ⌥⇧M [figjam] | Alt+Shift+M [figjam] |

### 6.3 Behaviours encoded in the table (CONFIRMED unless marked)

| Topic | Rule |
|---|---|
| Number keys | Pref **Use number keys for opacity** off: 0 = zoom 100 %, 1 or 9 = zoom to fit, 2 = zoom to selection, ⇧0…⇧9 = opacity 0–90 %. Pref on: the digits (and Num 0–9) set opacity, zooms move to ⇧0 / ⇧1 / ⇧9 / ⇧2. The live menus show ⇧1 for Zoom to fit, so the owner's default was **on** (INFERRED: default on). The panel shows `set-opacity-00` as "0 0" (or ⇧0 0 with the pref off). Digit → value per chapter 07 §(opacity) |
| Old outline shortcuts | Pref on: Outlines = ⇧O, Outline stroke = ⇧⌘O, Libraries also on ⌥⌘O. Off (default): Outlines ⇧⌘O, Outline stroke ⌥⌘O |
| Rotation shortcuts | Pref "Use ⌘⌥↑/↓ to rotate layers" exists. The key is not in this JSON (handled in C++, open question 4) |
| Text-edit-only keys | Mac Emacs-style keys in TEXT: ⌃A / ⌃E line start / end, ⌃⇧A / ⌃⇧E extend, ⌃F / ⌃B forward / back, ⌃K delete to end, ⌃D delete next char |
| Tab / ⇧Tab | Design: next / previous sibling. FigJam: next / previous node in reading order. In TEXT on a list: indent / dedent |
| Enter / ⇧Enter / \\ | select child / select parent (\\ also parent) |
| Space | not in the table: hold Space + drag = pan (panel pseudo-shortcut) |
| Arrows / ⇧arrows (nudge) | not in the table (C++). Default small nudge **1**, big **10** (chapter 02 §number fields; Preferences ▸ Nudge amount…) |
| Escape | `escape` = ⎋, shown as Select none's key |
| ⌘\\ family | ⌘\\ Show/Hide UI · ⇧⌘\\ Minimize UI (⇧\\ and ⇧. too) · ⌥⌘\\ multiplayer cursors |
| F6 | ⇧F6 / F6 (Win: Ctrl+F6) move keyboard focus between UI areas (all editors) |
| Mode switch | ⇧D: Design ⇄ Dev Mode (Slides: Slides ⇄ Design; Buzz: tool mode). ⌥Tab / ⌥⇧Tab (Win Alt+\`) quick mode toggle (gate `mode_quick_toggle`) |
| Presentation | ⌥⌘↩ present (Win Ctrl+Alt+Enter), Slides presenter view ⌥⇧⌘↩ |
| Panels | ⌥1 Layers, ⌥2 Assets/Libraries, ⌥3 library (old: ⌥⌘O), ⌥8 Design (Dev Mode: Inspect), ⌥9 Prototype (Dev Mode: Plugins). ChromeOS adds ⇧ |
| Prototyping | ⇧E show prototyping info (`toggle-prototyping-info`), ⌥⌘↩ present |
| Comments | C comment tool, ⇧C show/hide comments |
| Dev Mode | V default tool, ← / → previous / next focusable, ⇧M measure, Y or ⇧T annotate, ⇧D back to Design |
| AI | ⌘↩ (`start-ai-assistant`, gate `ai_assistant`) else `toggle-edit-mode` (Enter edit mode on the selection) |
| Debug | ⌃⌥⌘I selection debug, ⌃⌥⌘0 perf HUD, ⌃⌥⌘R record interactions, ⌃⌥⌘T/W/B/S/G editor switches (internal gates) |

### 6.4 Pseudo-shortcuts (shown in the panel, handled by the gesture code; CONFIRMED 3653 `keybindingsForShortcut`)

| Id | Keys (Mac; Windows uses Ctrl / Alt / Shift words) |
|---|---|
| `copy` / `cut` / `paste` | ⌘C / ⌘X / ⌘V |
| `deselect-all` | ⎋ |
| `pan` | Space + drag |
| `measure-to-selection` | ⌥ (while pointing) |
| `duplicate` | ⌥ (while moving) |
| `deep-select` | ⌘ + click |
| `deep-select-rectangle` | ⌘ + drag |
| `center-resize-drag` | ⌥ (while resizing) |
| `resize-proportionally` | ⇧ (while resizing) |
| `ignore-constraints` | ⌘ (while resizing) |
| `move-while-resizing` | Space |
| `crop-image` | ⌥ + double-click |
| `request-edit-mode` ("edit shape or image") | ↩ |
| `swap-instance` | ⌥ (while inserting a component) |
| `bend-tool` | ⌘ (Mac only) |
| `straight-connector` | ⇧ + drag (FigJam) |
| `edit-text` | ↩ |
| `stamp-or-reaction-wheel` | E (FigJam) |
| `motion-*` (Timeline tab) | toggle playback Space · auto-keyframe = `toggle-recording` ⇧K · snap while scrubbing ⇧ · zoom to selection Z · jump between keyframes J / K · move playhead , / . (big ⇧) · to start ⇧⌘, · to end ⇧⌘. · bypass grid/snap ⌃ + drag · nudge ← → (big ⇧) · resize ⌘← → (big ⇧⌘) |
| Paired rows | "align-left-right", "align-top-bottom", "align-centers", "distribute-spacing", "bold-and-italic" (⌘B and I), "bulleted-and-numbered-list", "text-*-adjust" (font size / weight / line height / letter spacing), "text-indent-and-dedent-list": each shows two actions joined by `whiteboard.keyboard_shortcuts.and` |

On ChromeOS the Alt glyph becomes the localised "Search" key.

## 7. Keyboard layouts

### 7.1 The layouts (CONFIRMED figma_app `keyboard_settings.*`, enum `aT`)

`US_QWERTY` (U.S. QWERTY), `DVORAK` (U.S. Dvorak), `GERMAN` (German QWERTZ), `FRENCH_AZERTY`, `HIRAGANA_KANA` (Japanese Kana), `UK_MAC`, `UK_PC`, `SWEDISH`, `DANISH`, `NORWEGIAN`, `ITALIAN`, `SPANISH`, `FINNISH`, `SPANISH_LATAM` (Spanish Latin America), `CHINESE`, `PORTUGUESE`, `KOREAN`, `UNKNOWN` ("default / unknown", sorted last). 18 values. The shortcut JSON has bindings for **16** of them. **Finnish and Chinese have no `layout:` bindings** (CONFIRMED by count), so INFERRED: they get only the untagged ones (open question 3).

### 7.2 Choosing and detecting (CONFIRMED)

| Step | Rule |
|---|---|
| Stored preference | localStorage `keyboardLayoutPreference` (enum name), broadcast to other tabs (same key), and on manual change `PUT /api/user {keyboard_preference, keyboard_preference_method:"manual"}`. Applied with `reloadShortcuts(layout)` in the engine |
| First run | no local value → the user record's `keyboard_layout` → else UNKNOWN |
| Desktop detection | `getKeyboardLayout()` from the desktop shell, the OS input-source id matched by **prefix** against a table: `com.apple.keylayout.German` / `ABC-QWERTZ` / `German-DIN-2137` / Windows KLID `00000407` → German; French, ABC-AZERTY, French-numerical, French-PC, `0000040C` → AZERTY; Swedish(-Pro) `0000041D`; Finnish `0000040B`; Norwegian `00000414`; Danish `00000406`; Italian(-Pro) `00000410`; Spanish(-ISO) `0000040A`; LatinAmerican `0000080A`; Kotoeri, Google Japanese IM, `00000411` → Kana; `com.apple.keylayout.US`, `00000409` → U.S.; `00000809` → UK PC; British, **Canadian** → UK Mac; Baidu, SCIM ITABC / Shuangpin, `00000804`, `00000404` → Chinese; Portuguese `00000816`; Korean IM `00000412` |
| Web detection | only in a secure, top-level context with `navigator.keyboard.getLayoutMap()`. The map is fingerprinted against named samples (e.g. "English (UK Windows)": Backslash → `#`; German: Minus → `ß`, Quote → `ä`; French: KeyQ → `a`; Japanese: IntlYen → `¥`; Dvorak …) |
| Mismatch | if the detected layout ≠ the preference, the editor raises a callback → toast "New ‹layout› keyboard shortcuts are available" / "…are now available" with "Update keyboard shortcuts" / "Enable and show new shortcuts" (`keyboard_settings.*` keys). INFERRED: it only offers, never switches silently |
| Event matching | the engine receives both `key` and `code`, plus the layout. INFERRED: tagged bindings match the produced character (`Ä`), untagged ones the U.S. physical key |
| "International shortcuts" setting | **not present** in this build: no key, flag or menu item. Layout selection replaces it (CONFIRMED by absence across the chunks; INFERRED meaning) |

### 7.3 Per-layout bindings (every `layout:`-tagged binding other than unknown / U.S.; "(mac)" / "(win)" = platform-only, "⇒" = displayed as)

Pattern: the U.S. bracket/slash/backslash/quote keys move to each layout's own character in that position, e.g. German ⌘Ä bring forward, ⌘Ö send backward, bare Ä / Ö front / back, ⌘, Actions, ^ Show/Hide UI, # select parent. Some layouts change modifiers: Swedish letter-spacing is ⇧⌥, line height ⌘⇧⌥. CONFIRMED.

| Action | Layout-specific keys |
|---|---|
| `zoom-in` | dvorak: Meta+Shift+= (mac) ⇒ Meta++, Control+Shift+= (win) ⇒ Control++, Meta+= (mac), Control+= (win), Shift+= ⇒ +, = ⇒ +; french_azerty: Meta+Shift+= (mac) ⇒ Meta++, Control+Shift+= (win) ⇒ Control++, Meta+= (mac), Control+= (win), Shift+= ⇒ +, = ⇒ +; uk_mac: Meta+Shift+= (mac) ⇒ Meta++, Control+Shift+= (win) ⇒ Control++, Meta+= (mac), Control+= (win); uk_pc: Meta+Shift+= (mac) ⇒ Meta++, Control+Shift+= (win) ⇒ Control++, Meta+= (mac), Control+= (win); korean: Meta+Shift+= (mac) ⇒ Meta++, Control+Shift+= (win) ⇒ Control++, Meta+= (mac), Control+= (win), Shift+= ⇒ +, = ⇒ +; hiragana_kana: Meta+; (mac) ⇒ Meta++, Control+; (win) ⇒ Control++, Meta+^ (mac), Control+^ (win), ; ⇒ +, ^ |
| `remove-fill` | dvorak: Alt+/; hiragana_kana: Alt+/; uk_mac: Alt+/; uk_pc: Alt+/; korean: Alt+/; german: Alt+,; danish: Alt+,; norwegian: Alt+,; italian: Alt+,; spanish: Alt+,; spanish_latam: Alt+,; portuguese: Alt+,; french_azerty: Alt+:; swedish: Alt+Å |
| `remove-stroke` | dvorak: Shift+/; hiragana_kana: Shift+/; uk_mac: Shift+/; uk_pc: Shift+/; korean: Shift+/; german: Shift+,; danish: Shift+,; norwegian: Shift+,; italian: Shift+,; spanish: Shift+,; spanish_latam: Shift+,; portuguese: Shift+,; french_azerty: Shift+:; swedish: Shift+Å |
| `select-parent` | dvorak: \; uk_mac: \; portuguese: \ (mac), ~ (win); korean: \; uk_pc: #; german: #; french_azerty: `; spanish: `; spanish_latam: ´; hiragana_kana: ¥; swedish: '; danish: '; norwegian: @ (mac), ' (win); italian: Ù |
| `bring-forward` | german: Meta+Ä (mac), Control+Ä (win); swedish: Meta+Ä (mac), Control+Ä (win); danish: Meta+Ø (mac), Control+Ø (win); norwegian: Meta+Æ (mac), Control+Æ (win); italian: Meta+À (mac), Control+À (win); spanish: Meta+Ç (mac), Control+Ç (win); spanish_latam: Meta+} (mac), Control+} (win); portuguese: Meta+~ (mac), Control+º (win); french_azerty: Meta+$ (mac), Control+$ (win) |
| `send-backward` | german: Meta+Ö (mac), Control+Ö (win); swedish: Meta+Ö (mac), Control+Ö (win); danish: Meta+Æ (mac), Control+Æ (win); norwegian: Meta+Ø (mac), Control+Ø (win); italian: Meta+Ò (mac), Control+Ò (win); spanish: Meta+Ñ (mac), Control+Ñ (win); spanish_latam: Meta+{ (mac), Control+{ (win); portuguese: Meta+Ç (mac), Control+Ç (win); french_azerty: Meta+^ (mac), Control+^ (win) |
| `bring-to-front` | german: Ä, Meta+Alt+Ä (mac), Control+Alt+Ä (win); swedish: Ä, Meta+Alt+Ä (mac), Control+Alt+Ä (win); danish: Ø, Meta+Alt+Ø (mac), Control+Alt+Ø (win); norwegian: Æ, Meta+Alt+Æ (mac), Control+Alt+Æ (win); italian: À, Meta+Alt+À (mac), Control+Alt+À (win); spanish: Ç, Meta+Alt+Ç (mac), Control+Alt+Ç (win); spanish_latam: }, Meta+Alt+} (mac), Control+Alt+} (win); portuguese: ~ (mac), º (win), Meta+Alt+~ (mac), Control+Alt+º (win); french_azerty: $ |
| `send-to-back` | german: Ö, Meta+Alt+Ö (mac), Control+Alt+Ö (win); swedish: Ö, Meta+Alt+Ö (mac), Control+Alt+Ö (win); danish: Æ, Meta+Alt+Æ (mac), Control+Alt+Æ (win); norwegian: Ø, Meta+Alt+Ø (mac), Control+Alt+Ø (win); italian: Ò, Meta+Alt+Ò (mac), Control+Alt+Ò (win); spanish: Ñ, Meta+Alt+Ñ (mac), Control+Alt+Ñ (win); spanish_latam: {, Meta+Alt+{ (mac), Control+Alt+{ (win); portuguese: Ç, Meta+Alt+Ç (mac), Control+Alt+Ç (win); french_azerty: ^ |
| `text-dedent-list` | german: Meta+Ö (mac), Control+Ö (win); swedish: Meta+Ö (mac), Control+Ö (win); danish: Meta+Æ (mac), Control+Æ (win); norwegian: Meta+Ø (mac), Control+Ø (win); italian: Meta+Ò (mac), Control+Ò (win); spanish: Meta+Ñ (mac), Control+Ñ (win); spanish_latam: Meta+{ (mac), Control+{ (win); french_azerty: Meta+^ (mac), Control+^ (win); portuguese: Meta+Ç (mac), Control+Ç (win) |
| `text-indent-list` | german: Meta+Ä (mac), Control+Ä (win); swedish: Meta+Ä (mac), Control+Ä (win); danish: Meta+Ø (mac), Control+Ø (win); norwegian: Meta+Æ (mac), Control+Æ (win); italian: Meta+À (mac), Control+À (win); spanish: Meta+Ç (mac), Control+Ç (win); spanish_latam: Meta+} (mac), Control+} (win); french_azerty: Meta+$ (mac), Control+$ (win); portuguese: Meta+~ (mac), Control+º (win) |
| `toggle-grid` | hiragana_kana: Shift+¥; german: Shift+#; norwegian: Shift+@ (mac), Shift+' (win); italian: Shift+Ù; spanish: Shift+`; spanish_latam: Shift+´; portuguese: Shift+\ (mac), Shift+~ (win); dvorak: Shift+', Meta+' (mac), Control+' (win); korean: Shift+'; uk_mac: Shift+'; uk_pc: Shift+'; swedish: Shift+'; danish: Shift+'; french_azerty: Meta+` (mac), Control+` (win) |
| `toggle-menu` | dvorak: Meta+K (mac), Control+K (win), Meta+/ (mac), Control+/ (win); hiragana_kana: Meta+K (mac), Control+K (win), Meta+/ (mac), Control+/ (win); uk_mac: Meta+K (mac), Control+K (win), Meta+/ (mac), Control+/ (win); uk_pc: Meta+K (mac), Control+K (win), Meta+/ (mac), Control+/ (win); korean: Meta+K (mac), Control+K (win), Meta+/ (mac), Control+/ (win); german: Meta+, (mac), Control+, (win); danish: Meta+, (mac), Control+, (win); norwegian: Meta+, (mac), Control+, (win); italian: Meta+, (mac), Control+, (win); spanish: Meta+, (mac), Control+, (win); spanish_latam: Meta+, (mac), Control+, (win); portuguese: Meta+, (mac), Control+, (win); french_azerty: Meta+: (mac), Control+: (win); swedish: Meta+Å (mac), Control+Å (win) |
| `toggle-snapping-to-pixels` | german: Meta+Shift+# (mac), Control+Shift+# (win); norwegian: Meta+Shift+@ (mac), Control+Shift+' (win); italian: Meta+Shift+Ù (mac), Control+Shift+Ù (win); french_azerty: Meta+Shift+` (mac), Control+Shift+` (win); spanish: Meta+Shift+` (mac), Control+Shift+` (win); spanish_latam: Meta+Shift+´ (mac), Control+Shift+´ (win); hiragana_kana: Meta+Shift+¥ (mac), Control+Shift+¥ (win); portuguese: Meta+Shift+\ (mac), Control+Shift+~ (win); dvorak: Meta+Shift+' (mac), Control+Shift+' (win); uk_mac: Meta+Shift+' (mac), Control+Shift+' (win); uk_pc: Meta+Shift+' (mac), Control+Shift+' (win); swedish: Meta+Shift+' (mac), Control+Shift+' (win); danish: Meta+Shift+' (mac), Control+Shift+' (win); korean: Meta+Shift+' (mac), Control+Shift+' (win) |
| `toggle-sidebar` | german: Meta+Shift+^ (mac), Control+Shift+^ (win); french_azerty: Meta+Shift+@ (mac), Control+Shift+@ (win); hiragana_kana: Meta+Shift+@ (mac), Meta+Shift+2 (mac), Control+Shift+@ (win); spanish: Meta+Shift+º (mac), Control+Shift+º (win); spanish_latam: Meta+Shift+\| (mac), Control+Shift+\| (win); uk_mac: Meta+Shift+§ (mac), Control+Shift+§ (win); swedish: Meta+Shift+§ (mac), Control+Shift+§ (win); portuguese: Meta+Shift+§ (mac), Control+Shift+\ (win); danish: Meta+Shift+$ (mac), Control+Shift+$ (win); norwegian: Meta+Shift+' (mac), Control+Shift+\| (win); uk_pc: Meta+Shift+` (mac), Control+Shift+` (win); dvorak: Shift+\, Shift+. |
| `toggle-ui` | german: ^, Meta+^ (mac), Control+^ (win); hiragana_kana: @, Meta+@ (mac), Control+@ (win); french_azerty: @, Meta+@ (mac), Control+@ (win); uk_mac: §; swedish: §, Meta+§ (mac), Control+§ (win); portuguese: § (mac), \ (win), Meta+§ (mac), Control+\ (win); danish: $, Meta+$ (mac), Control+$ (win); norwegian: ' (mac), \| (win), Meta+' (mac), Control+\| (win); italian: \; spanish: º, Meta+º (mac), Control+º (win); spanish_latam: \|, Meta+\| (mac), Control+\| (win); uk_pc: `; korean: ₩ |
| `toggle-multiplayer-cursors` | uk_mac: Meta+Alt+§ (mac), Control+Alt+§ (win); swedish: Meta+Alt+§ (mac), Control+Alt+§ (win); portuguese: Meta+Alt+§ (mac), Control+Alt+\ (win); danish: Meta+Alt+$ (mac), Control+Alt+$ (win); norwegian: Meta+Alt+' (mac), Control+Alt+\| (win); uk_pc: Meta+Alt+` (mac), Control+Alt+` (win); german: Meta+Alt+^ (mac), Control+Alt+^ (win); spanish: Meta+Alt+º (mac), Control+Alt+º (win); spanish_latam: Meta+Alt+\| (mac), Control+Alt+\| (win); french_azerty: Meta+Alt+@ (mac), Control+Alt+@ (win); hiragana_kana: Meta+Alt+@ (mac), Control+Alt+@ (win) |
| `start-chat` | dvorak: /; hiragana_kana: /; uk_mac: /; uk_pc: /; korean: /; german: ,; danish: ,; norwegian: ,; italian: ,; spanish: ,; spanish_latam: ,; portuguese: ,; french_azerty: :; swedish: Å |
| `open-shortcuts` | german: Control+Shift+,; norwegian: Control+Shift+, |
| `text-font-size-decrease` | dvorak: Meta+Shift+, (mac) ⇒ Meta+Shift+<, Control+Shift+, (win) ⇒ Control+Shift+<; hiragana_kana: Meta+Shift+, (mac) ⇒ Meta+Shift+<, Control+Shift+, (win) ⇒ Control+Shift+<; uk_mac: Meta+Shift+, (mac) ⇒ Meta+Shift+<, Control+Shift+, (win) ⇒ Control+Shift+<; uk_pc: Meta+Shift+, (mac) ⇒ Meta+Shift+<, Control+Shift+, (win) ⇒ Control+Shift+<; korean: Meta+Shift+, (mac) ⇒ Meta+Shift+<, Control+Shift+, (win) ⇒ Control+Shift+<; german: Meta+Shift+ẞ (mac), Control+Shift+ẞ (win); danish: Meta+Shift+Å (mac), Control+Shift+Å (win); norwegian: Meta+Shift+Å (mac), Control+Shift+Å (win); italian: Meta+Shift+' (mac), Control+Shift+' (win); spanish: Meta+Shift+' (mac), Control+Shift+' (win); spanish_latam: Meta+Shift+' (mac), Control+Shift+' (win); portuguese: Meta+Shift+º (mac), Control+Shift+' (win); french_azerty: Meta+Shift+, (mac), Control+Shift+, (win); swedish: Meta+Shift+, (mac), Control+Shift+, (win) |
| `text-font-size-increase` | dvorak: Meta+Shift+. (mac) ⇒ Meta+Shift+>, Control+Shift+. (win) ⇒ Control+Shift+>; hiragana_kana: Meta+Shift+. (mac) ⇒ Meta+Shift+>, Control+Shift+. (win) ⇒ Control+Shift+>; uk_mac: Meta+Shift+. (mac) ⇒ Meta+Shift+>, Control+Shift+. (win) ⇒ Control+Shift+>; uk_pc: Meta+Shift+. (mac) ⇒ Meta+Shift+>, Control+Shift+. (win) ⇒ Control+Shift+>; korean: Meta+Shift+. (mac) ⇒ Meta+Shift+>, Control+Shift+. (win) ⇒ Control+Shift+>; german: Meta+Shift+´ (mac), Control+Shift+´ (win); danish: Meta+Shift+¨ (mac), Control+Shift+¨ (win); norwegian: Meta+Shift+¨ (mac), Control+Shift+¨ (win); italian: Meta+Shift+Ì (mac), Control+Shift+Ì (win); spanish: Meta+Shift+¡ (mac), Control+Shift+¡ (win); spanish_latam: Meta+Shift+¿ (mac), Control+Shift+¿ (win); portuguese: Meta+Shift+´ (mac), Control+Shift+« (win); french_azerty: Meta+Shift+; (mac), Control+Shift+; (win); swedish: Meta+Shift+. (mac), Control+Shift+. (win) |
| `text-letter-spacing-decrease` | dvorak: Alt+, (mac) ⇒ Alt+<, Alt+, (win) ⇒ Alt+<; uk_mac: Alt+, (mac) ⇒ Alt+<, Alt+, (win) ⇒ Alt+<; uk_pc: Alt+, (mac) ⇒ Alt+<, Alt+, (win) ⇒ Alt+<; korean: Alt+, (mac) ⇒ Alt+<, Alt+, (win) ⇒ Alt+<; german: Alt+ẞ; danish: Alt+Å; swedish: Shift+Alt+,; norwegian: Shift+Alt+Å; italian: Alt+'; spanish: Alt+'; spanish_latam: Alt+'; portuguese: Alt+º (mac), Alt+' (win); french_azerty: Alt+,; hiragana_kana: Meta+, (mac) ⇒ Meta+<, Control+, (win) ⇒ Control+< |
| `text-letter-spacing-increase` | dvorak: Alt+. (mac) ⇒ Alt+>, Alt+. (win) ⇒ Alt+>; uk_mac: Alt+. (mac) ⇒ Alt+>, Alt+. (win) ⇒ Alt+>; uk_pc: Alt+. (mac) ⇒ Alt+>, Alt+. (win) ⇒ Alt+>; korean: Alt+. (mac) ⇒ Alt+>, Alt+. (win) ⇒ Alt+>; german: Alt+´; danish: Alt+¨; swedish: Shift+Alt+.; norwegian: Shift+Alt+¨; italian: Alt+Ì; spanish: Alt+¡; spanish_latam: Alt+¿; portuguese: Alt+´ (mac), Alt+« (win); french_azerty: Alt+;; hiragana_kana: Meta+. (mac) ⇒ Meta+>, Control+. (win) ⇒ Control+> |
| `text-line-height-decrease` | dvorak: Alt+Shift+, (mac) ⇒ Alt+Shift+<, Alt+Shift+, (win) ⇒ Alt+Shift+<; uk_mac: Alt+Shift+, (mac) ⇒ Alt+Shift+<, Alt+Shift+, (win) ⇒ Alt+Shift+<; uk_pc: Alt+Shift+, (mac) ⇒ Alt+Shift+<, Alt+Shift+, (win) ⇒ Alt+Shift+<; korean: Alt+Shift+, (mac) ⇒ Alt+Shift+<, Alt+Shift+, (win) ⇒ Alt+Shift+<; german: Shift+Alt+ẞ; danish: Shift+Alt+Å; swedish: Meta+Shift+Alt+,; norwegian: Meta+Shift+Alt+Å; italian: Shift+Alt+'; spanish: Shift+Alt+'; spanish_latam: Shift+Alt+'; portuguese: Shift+Alt+º (mac), Shift+Alt+' (win); french_azerty: Shift+Alt+,; hiragana_kana: Meta+Shift+Alt+, (mac) ⇒ Meta+Shift+Alt+<, Control+Shift+Alt+, (win) ⇒ Control+Shift+Alt+< |
| `text-line-height-increase` | dvorak: Alt+Shift+. (mac) ⇒ Alt+Shift+>, Alt+Shift+. (win) ⇒ Alt+Shift+>; uk_mac: Alt+Shift+. (mac) ⇒ Alt+Shift+>, Alt+Shift+. (win) ⇒ Alt+Shift+>; uk_pc: Alt+Shift+. (mac) ⇒ Alt+Shift+>, Alt+Shift+. (win) ⇒ Alt+Shift+>; korean: Alt+Shift+. (mac) ⇒ Alt+Shift+>, Alt+Shift+. (win) ⇒ Alt+Shift+>; german: Shift+Alt+´; danish: Shift+Alt+¨; swedish: Meta+Shift+Alt+.; norwegian: Meta+Shift+Alt+¨; italian: Shift+Alt+Ì; spanish: Shift+Alt+¡; spanish_latam: Shift+Alt+¿; portuguese: Shift+Alt+´ (mac), Shift+Alt+« (win); french_azerty: Shift+Alt+;; hiragana_kana: Meta+Shift+Alt+. (mac) ⇒ Meta+Shift+Alt+>, Control+Shift+Alt+. (win) ⇒ Control+Shift+Alt+> |
| `text-bold-decrease` | dvorak: Meta+Alt+, (mac) ⇒ Meta+Alt+<, Control+Alt+, (win) ⇒ Control+Alt+<; hiragana_kana: Meta+Alt+, (mac) ⇒ Meta+Alt+<, Control+Alt+, (win) ⇒ Control+Alt+<; uk_mac: Meta+Alt+, (mac) ⇒ Meta+Alt+<, Control+Alt+, (win) ⇒ Control+Alt+<; uk_pc: Meta+Alt+, (mac) ⇒ Meta+Alt+<, Control+Alt+, (win) ⇒ Control+Alt+<; korean: Meta+Alt+, (mac) ⇒ Meta+Alt+<, Control+Alt+, (win) ⇒ Control+Alt+<; german: Meta+Alt+ẞ (mac), Control+Alt+ẞ (win); danish: Meta+Alt+Å (mac), Control+Alt+Å (win); norwegian: Meta+Alt+Å (mac), Control+Alt+Å (win); italian: Meta+Alt+' (mac), Control+Alt+' (win); spanish: Meta+Alt+' (mac), Control+Alt+' (win); spanish_latam: Meta+Alt+' (mac), Control+Alt+' (win); portuguese: Meta+Alt+º (mac), Control+Alt+' (win); french_azerty: Meta+Alt+, (mac), Control+Alt+, (win); swedish: Meta+Alt+, (mac), Control+Alt+, (win) |
| `text-bold-increase` | dvorak: Meta+Alt+. (mac) ⇒ Meta+Alt+>, Control+Alt+. (win) ⇒ Control+Alt+>; hiragana_kana: Meta+Alt+. (mac) ⇒ Meta+Alt+>, Control+Alt+. (win) ⇒ Control+Alt+>; uk_mac: Meta+Alt+. (mac) ⇒ Meta+Alt+>, Control+Alt+. (win) ⇒ Control+Alt+>; uk_pc: Meta+Alt+. (mac) ⇒ Meta+Alt+>, Control+Alt+. (win) ⇒ Control+Alt+>; korean: Meta+Alt+. (mac) ⇒ Meta+Alt+>, Control+Alt+. (win) ⇒ Control+Alt+>; german: Meta+Alt+´ (mac), Control+Alt+´ (win); danish: Meta+Alt+¨ (mac), Control+Alt+¨ (win); norwegian: Meta+Alt+¨ (mac), Control+Alt+¨ (win); italian: Meta+Alt+Ì (mac), Control+Alt+Ì (win); spanish: Meta+Alt+¡ (mac), Control+Alt+¡ (win); spanish_latam: Meta+Alt+¿ (mac), Control+Alt+¿ (win); portuguese: Meta+Alt+´ (mac), Control+Alt+« (win); french_azerty: Meta+Alt+; (mac), Control+Alt+; (win); swedish: Meta+Alt+. (mac), Control+Alt+. (win) |
| `set-tool-code-block` | dvorak: `; french_azerty: Shift+Meta+: (mac), Shift+Control+: (win); hiragana_kana: Meta+Alt+¥ (mac), Control+Alt+¥ (win) |

## 8. The Keyboard shortcuts panel

Opened by `open-shortcuts` (⌃⇧? on both platforms), Help ▸ Keyboard shortcuts, or `toggle-keyboard-shortcuts`. Geometry measured live is in `docs/research/shortcuts-panel/README.md`: docked at the bottom, full width, **240** high (theme token `keyboardShortcutsPaneHeight:"240px"`, z-index `keyboardShortcutsPanelZ: 9`, key-cap font features `'case','ss02','tnum','liga','calt'`, CONFIRMED figma_app), 3 columns of 300, key caps 26 high.

| Fact | Value | Evidence |
|---|---|---|
| Tabs (Design), in order | Essential · Timeline (gate `metronome`, only with the motion timeline) · Tools · View · Zoom · Text · Shape · Selection · Cursor · Edit · Transform · Arrange · Components (only when the file subscribes to libraries) · [spacer] · Layout · [Custom, internal flag] | 3653 `fU`, `hc` |
| Other editors | Dev Mode: Tools, View, Copy, … (opens on **View**); FigJam: Tools … Accessibility, Advanced (opens on **Tools**); Slides opens on **Essential** | `ho()` |
| Essential | caption "Essential keyboard shortcuts". Three numbered items: Show/Hide UI (description), Insert component ⇧I (or Pick color I when no libraries), Actions ⌘K, each with two lines of usage text | 3653 |
| Tools column 1 | Move V, Frame F (desc), Pen P, Pencil ⇧P (`set-tool-pencil-desc`) | |
| Tools column 2 | Text T, Rectangle R, Ellipse O, Line L, Arrow ⇧L | |
| Tools column 3 | Comment C, Annotate Y (Design), Pick color I, Slice S | |
| View | Show/Hide UI, Multiplayer cursors · Rulers, Outlines, Pixel preview, Layout guides, Pixel grid · Layers ⌥1, Assets ⌥2 (`toggle-publish-desc`), Library ⌥3, Design ⌥8, Prototype ⌥9 | |
| Zoom | Pan, Zoom in, Zoom out, Zoom to 100% · Zoom to fit, Zoom to selection, Next frame, Previous frame · Previous page, Next page, Find previous/next frame | |
| Text | Bold and italic, Underline, Create link, Strikethrough, Bulleted/numbered list · align left/center/right/justified · font size, weight, letter spacing, line height adjust | |
| Shape | Pen, Pencil, *while editing a shape:* Paint bucket, Bend · Remove fill, Remove stroke, Swap, Outline stroke, Flatten · *after selecting points:* Join, Smooth join, Delete and heal | |
| Selection | Select all, Select inverse, Select none, Deep select · Select child, parent, next, previous sibling, Select matching · Group, Ungroup, Frame selection, Show/Hide, Lock/Unlock | |
| Cursor | *while pointing:* Measure ⌥ · *while moving:* Duplicate ⌥ · *while clicking:* Deep select ⌘ · *while dragging to select:* Deep select rectangle · *while resizing:* Center ⌥, Proportional ⇧, Ignore constraints ⌘ | |
| Edit | Copy, Cut, Paste, Paste to replace, Paste over selection · Duplicate ⌘D, Rename ⌘R, Export ⇧⌘E (`export-selected-exportables-desc`), Find ⌘F · Copy as PNG, Copy properties, Paste properties | |
| Transform | Flip H, Flip V, Use as mask · Edit shape or image ↩, Place image ⇧⌘K · Opacity 0 % ("0 0"), 10 %, 50 %, 100 % | |
| Arrange | Bring forward, Send backward, Bring to front, Send to back · Align left/right, top/bottom, centers, Distribute spacing, Tidy up · Add auto layout, Remove auto layout, Multi-stack auto layout | |
| Components | Assets (`toggle-publish-desc`), Library, Create component, Detach instance, Convert to slot ⇧⌘S · Insert component ⇧I, *while inserting a component:* Swap instance ⌥ | |
| Layout tab | "Keyboard layout:" select (dark menu), a **Detected** group (desktop detection, §7.2) then **Other layouts** sorted by name with Unknown last. Selecting **previews** the drawn keyboard immediately and saves (`rd`). Below: "Figma keyboard shortcuts won't automatically change if you change your system keyboard layout" (hidden for Unknown), "Request a new layout or learn more" → help article 5665442977431 | 3653 `hr`, `hi`, `ha` |
| Used shortcuts | per-user counter `usedKeyboardShortcuts[action]`. A row lights when used ≥ 1 (pairs: the min of both counts). A tab is **complete** when all its rows are lit | 3653 `shortcutUsedCount` |
| Completion animation | when a newly used shortcut completes a tab: after **1 500 ms** the tab switches to the completed state and the key animates, ending at **6 000 ms**. Each key's delay = **110 ms × abs(position − completed key's position) + 100 ms**. When every tab is complete: random delays of 0 … −2 000 ms (a looping "replay" button appears) | 3653 `calculateAnimationDelays`, timers |
| Close | ✕ (`general.close`) or the same key. Closing clears the remembered tab | |
| Custom tab | internal only ("Internal only - #feat-custom-keyboard-shortcuts"): add a shortcut by picking an action in an autocomplete then pressing keys. Stored in `customKeyboardShortcuts`. Lists FULLSCREEN and non-fullscreen action types | 3653 |

## 9. Quick actions (Actions…)

| Fact | Value | Evidence |
|---|---|---|
| Open | `toggle-menu`: ⌘K, ⌘/, ⌘P (not in the VS Code extension: ⌘P is file search there); Win Ctrl+K / Ctrl+/ / Ctrl+P. Not in BRANCHING mode. Also the main menu's Actions…, the canvas menu, the toolbar | wasm JSON |
| Modules (tabs) | **All**, **Assets**, **Extensions** ("Plugins & widgets"; filters: all, plugins, widgets, from org, development). Enum `Jc = {all, extensions, assets}` | figma_app |
| Sources indexed | every main-menu item that is an action and not `hideForQuickCommand`, recursing into submenus **except** Plugins / Widgets (those come as `plugins-menu-item` entries keyed by `extensionSearchString`) + the **172 search-only items** (`searchOnly:true`, e.g. every `set-tool-*`, `select-parent/child/next/previous-sibling`, `resize-to-fit`, `aspect-ratio-lock/unlock`, `destroy-all-auto-layout`, `set-selection-hug/fill-*`, `create-multiple-symbols`, `publish-selection`, `component-insert`, `unhide-all`, `toggle-library`, `crop-image`, `reset-transform`, `copy-link`, `set-opacity-0/1/5`, `select-all-hidden-layers-within-selection`, `select-all-text`, `convert-to-raster`, `toggle-frame-clipping` …) | 3653 `addFigmaMenuItemsToSearchMap`; 7362 |
| Index key | an item's display text (INFERRED: the `displayForQuickCommand` label when set). The query string adds `queryString` aliases | 3653 `x()` |
| Empty query | shows **Recents**: the last **3** commands run from Quick actions (most recent first, deduplicated, dropped when no longer in the index; plugins keep their run args) | `addToRecentlyUsedCommands`: `r.length>=3&&r.pop()` |
| Click in the empty field with no results | lists **every** action, sorted by the popularity list (§9.2) | `onClick` → `searchIndex.list()` |
| Typing | fuzzy matcher on the display text + substring matcher on the display text (VISIBLE) and on each `searchSynonyms` (HIDDEN). Kept when either score > 0. Results sorted by the weighted score, then enabled first, disabled after (disabled kept, greyed) | `_searchByFuzzyMatchAndSubstringMatch`, `sortedByEnabledSearchResults` |
| No match | "No matches" (`fullscreen_actions.no_matches`) | |
| Input | max **150** characters, `dir=auto`, no spellcheck, placeholder key `quick-actions-modal-placeholder` | `maxLength:150` |
| Keys | ↵ run · ⎋ close · ↓ / ↑ move (wraps; Mac also ⌃N / ⌃P) · ⇥ opens the parameter entry of a plugin / parameter action · ⌘R / ⌘S / ⌘D / ⌘E / ⌘F / ⌘O typed while held are added to the query as letters (they never trigger browser shortcuts) | `onKeyDown` |
| After running | a checkable item (a toggle without `hideCheckForQuickCommand`) keeps the palette open **300 ms** (the check flips visibly), then closes; others close at once | `delayedCloseTimerID … 300` |
| Telemetry | session id, query id, `qaVersion`, result count, position | |

### 9.1 Ranking (CONFIRMED 3653 module 426349)

Score = Σ weight × normalised factor (weights must sum to 1):

| Factor | Weight | Normalised value |
|---|---|---|
| String match | **0.4** | max(fuzzy, synonym). Fuzzy = matchScore / (the text's own perfect score, cached, LRU **1 000**). Synonym/substring = score / `perfectScore()`. Items marked `isLowPriorityMatch` get 0 fuzzy |
| isEnabled | **0.3** | 1 when enabled (a menu item counts as enabled when it has a `name`, the engine reports the action enabled, or `quickAction.alwaysEnabled`) |
| Action frecency | **0.2** | f / (f + **1 000**) |
| isAI | **0.1** | 1 for AI actions |

Fuzzy-only path (legacy): results with fuzzy score < **1** dropped.

### 9.2 Frecency and popularity (CONFIRMED figma_app module 127059, 7362/3187 module 355212)

| Fact | Value |
|---|---|
| Store | `frecencyHistory` (user-scoped persisted atom, write debounce **1 000 ms**), shape `{numItems, userIds: {<userId>: {<editorType>: {actions, queries}}}}`. Also synced to the server (`actionsHistory.frecencyHistory`, validated JSON) |
| Cap | **5 000** entries in total, then pruned |
| Per action | `{timestamps (max 10, newest first), count}` |
| Key | the item's display text cut to **20** characters. Plugins by `extensionSearchString`. "go-to-page" by name |
| Timestamp bucket | < 0.5 h → **100** · < 4 h → **70** · < 1 day → **50** · < 7 days → **30** · < 30 days → **20** · < 90 days → **10** · older → **0** |
| Action score | count × mean(bucket of its timestamps) |
| Popularity list (for the unsearched "all" list only) | 320 ids, score = 320 − index. First 80: 1. `ungroup-selection`, 2. `group-selection`, 3. `create-section-from-selection`, 4. `replace-selected-frame-with-section`, 5. `convert-selected-nodes-to-frame`, 6. `bring-to-front`, 7. `send-to-back`, 8. `create-webpage`, 9. `detach-instance`, 10. `frame-selection`, 11. `create-symbol`, 12. `edit-code`, 13. `create-code-layer-from-design`, 14. `create-make-from-design`, 15. `restore-design-in-place-from-code`, 16. `copy-out-design-from-code`, 17. `flip-horizontal`, 18. `find-symbol`, 19. `publish-selection`, 20. `publish-changes-to-library`, 21. `copy-text`, 22. `mask-selection`, 23. `place`, 24. `send-backward`, 25. `paste-properties`, 26. `toggle-locked-for-selected-nodes`, 27. `copy-as-svg`, 28. `bring-forward`, 29. `flatten-selection`, 30. `outline-stroke`, 31. `toggle-ui`, 32. `copy-properties`, 33. `copy-as-png`, 34. `stack-selection`, 35. `run-multi-stack-auto-layout`, 36. `rename-selection`, 37. `flip-vertical`, 38. `find-inspiration`, 39. `inspect-fragment`, 40. `reset-symbol`, 41. `reset-fauxverride`, 42. `toggle-variables`, 43. `detach-deleted-variables`, 44. `reset-variable-modes`, 45. `export-all-frames-to-pdf`, 46. `export-slides-to-pdf`, 47. `export-selected-exportables`, 48. `export-selected-video`, 49. `export-selection-or-current-page`, 50. `enter-inspect-mode`, 51. `enter-design-mode`, 52. `enter-slides-mode`, 53. `enter-slides-design-mode`, 54. `unstack-selection`, 55. `open-preferences-modal`, 56. `copy-as-css`, 57. `copy-as-css-recursive`, 58. `toggle-shown-for-selected-nodes`, 59. `toggle-shown-layout-grids`, 60. `toggle-rulers`, 61. `toggle-stack-shadows`, 62. `toggle-dynamic-insertion-points`, 63. `toggle-auto-fill-full-width-children`, 64. `toggle-version-history`, 65. `publish-template`, 66. `convert-to-raster`, 67. `create-savepoint`, 68. `restore-symbol-or-state-group`, 69. `toggle-snapping-to-pixels`, 70. `open-account-settings`, 71. `toggle-menu`, 72. `push-changes-to-main`, 73. `show-nudge-amount-picker`, 74. `redo`, 75. `duplicate-in-place`, 76. `toggle-outlines`, 77. `toggle-outline-mode-hidden-layers`, 78. `toggle-outline-mode-object-bounds`, 79. `toggle-grid`, 80. `toggle-pixel-preview` |

## 10. UI strings

The build holds i18n keys. English below is attested by the live captures (`docs/research/figma/live/menus/*.txt`, "live") or the repo's i18n (`src/shared/i18n`, "repo"). Keys follow `fullscreen_actions.<action-id>` unless listed.

- Main menu (live): Back to files · Actions… ⌘K · File · Edit · View · Object · Text · Arrange · Vector · Plugins · Widgets · Preferences · Libraries · Open in desktop app · Help and account.
- File (live): New Design · New · Place image/video… · Duplicate · Save local copy… · Save to version history… · Show version history · Export… · Export frames to PDF… · Create branch….
- Edit (live): Undo · Redo · Copy as · Paste over selection · Paste to replace · Duplicate · Delete · Find · Find next · Find previous · Find and replace… · Set default properties · Copy properties · Paste properties · Pick color · Select all · Select matching layers · Select none · Select inverse · Select all with.
- View (live): Pixel grid · Layout guides · Rulers · Show slices · Comments · Annotations · Outlines · Pixel preview · Mask outlines · Frame outlines · Memory usage · Additional labels · Minimize left navigation bar · Minimize UI · Show/Hide UI · Multiplayer cursors · Switch to Draw · Switch to Dev Mode · Panels · Zoom in · Zoom out · Zoom to 100% · Zoom to fit · Zoom to selection · Previous page · Next page · Zoom to previous frame · Zoom to next frame · Find previous frame · Find next frame. Panels: Open layers panel · Libraries · Open design panel · Open prototype panel · Toggle variables.
- Object (live): Frame selection · Group selection · Ungroup selection · Wrap in new section · Convert to section · Convert to frame · Restore default thumbnail · Use as mask · Add auto layout · More layout options · Create component · Slots · Reset instance · Detach instance · Main component · Bring to front · Bring forward · Send backward · Send to back · Flip horizontal · Flip vertical · Rotate 180˚ · Rotate 90˚ left · Rotate 90˚ right · Flatten · Outline stroke · Boolean groups · Show/Hide selection · Lock/Unlock selection · Hide other layers · Collapse layers · Remove fill · Remove stroke · Swap fill and stroke · Remove interactions · Delete contents.
- Text (live): Bold · Italic · Underline · Strikethrough · Create link · Bulleted list · Numbered list · Alignment · Adjust · Case · Text direction · Spell check · Show text suggestions.
- Arrange (live): Round to pixel · Align left · Align horizontal centers · Align right · Align top · Align vertical centers · Align bottom · Tidy up · Pack horizontal · Pack vertical · Distribute horizontal spacing · Distribute vertical spacing · Distribute left · Distribute horizontal centers · Distribute right · Distribute top · Distribute vertical centers · Distribute bottom.
- Vector (live): Join selection · Smooth join selection · Delete and heal selection · Split vector · Simplify vector · Offset vector.
- Plugins / Widgets (live): Run last plugin · Saved plugins · Manage plugins… · Manage widgets… · Select all widgets.
- Preferences (live): Snap to geometry · Snap to objects · Snap to pixel grid · Keep tool selected after use · Highlight layers on hover · Rename duplicated layers · Show dimensions on objects · Hide canvas UI during changes · Use smart quotes/symbols · Flip objects while resizing · Keyboard zooms into selection · Invert zoom direction · Ctrl+click opens right click menus · Use number keys for opacity · Use old shortcuts for outlines · Use ⌘⌥↑/↓ to rotate layers · Play audio notifications in AI chat · Open links in desktop app · Show text suggestions · Show tool suggestions · Show Agents on canvas · Use scroll wheel zoom · Right-click and drag to pan · Theme · Color profile… · Keyboard layout… · Accessibility settings… · Permissions and helpers… · Nudge amount….
- Help and account (live): Help page · Keyboard shortcuts · Support forum · Video tutorials · Release notes · Open font settings · Legal summary · Account settings · Log out.
- Context menus (live): Paste here · Show/Hide UI · Show/Hide comments · Cursor chat · Actions… · Copy · Paste to replace · Copy/Paste as · Send to Figma Make · Find similar designs · Add motion · Select layer · Move to page · Group selection · Frame selection · Convert to section · Wrap in new section · Ungroup · Rename · Rename layers (AI badge) · Flatten · Outline stroke · Set as thumbnail · Use as mask · Add auto layout · Remove auto layout · More layout options · Create component · Reset instance · Detach instance · Go to main component · Main component · Show/Hide · Lock/Unlock · Flip horizontal · Flip vertical. Page row: Copy link to page · Rename page · Duplicate page · Move up · Delete page.
- Context-menu keys (`fullscreen.context_menu.*`): `show_hide`, `lock_unlock`, `show_hide_comments`, `hide_comments`, `ungroup`, `rename`, `flatten`, `auto_rename_layers`, `copy_link`, `export_selection`, `export_selected_video`, `wrap_with_transform`, `add_motion` (+ `.position`, `.scale`, `.rotation`, `.opacity`, `.more`, `.corner_radius`, `.fill`, `.stroke_paint`, `.stroke_weight`, `.drop_shadow`, `.apply_animation_style`). `fullscreen.ruler_guide_context_menu.hide_rulers`. `fullscreen_actions.`: `paste-here`, `paste`, `paste-and-match-style`, `paste-to-replace`, `select-node` ("Select {name}"), `page-move-to` ("{name}"), `pages-rename` / `pages-delete` ({pageCount}), `divider-duplicate`, `divider-delete`, `page-divider-add-title`, `change_status`, `page_status.none`, `page_status.manage_statuses`, `copy-hyperlink`, `copy-email`, `copy-phone`, `copy_link_to_slide`, `set_as_thumbnail` / `restore_default_thumbnail` / `set_as_file_thumbnail` / `restore_default_file_thumbnail`, `set_as_favicon` / `clear_favicon`, `split_vector`, `toggle-actions-menu`, `toggle-menu`, `minimize-ui`, `expand-ui`, `no_matches`, `creation_submenu.new-*`. `common.moveUp` / `moveDown` / `moveToTop` / `moveToBottom`.
- Shortcuts panel: `whiteboard.keyboard_shortcuts.tab.{essential, tools, view, zoom, text, shape, selection, cursor, copy, edit, transform, arrange, components, accessibility, advanced, layout}`, `motion.constants.timeline_label`, `keyboard_settings.custom_tab`, `whiteboard.keyboard_shortcuts.essential_keyboard_shortcuts`, `fullscreen.keyboard_shortcuts_panel.{toggle_ui, component_insert, toggle_dropper, toggle_menu}_description`, `whiteboard.keyboard_shortcuts.and`, key labels `whiteboard.keyboard_shortcuts.key_label.{alt, backspace, click, ctrl, dbl_click, delete, down, drag, end, enter, esc, home, left, page_down, page_up, pg_dn, pg_up, right, search, shift, space, tab, up, win, f6}`, tooltips `…tooltip.{backspace, command, control, option_alt, shift}`, `…{edit, delete, restore}.shortcut`. Live English (README): "Essential keyboard shortcuts", "While pointing…", "Keyboard layout:", "Learn more".
- Layout: `keyboard_settings.{keyboard_layout, keyboard_layout_panel_selector, detected, other_layouts, figma_keyboard_shortcuts_won_t_automatically_change_if_you_change_your_system_keyboard_layout, request_a_new_layout_or_learn_more, new_keyboard_name_keyboard_shortcuts_are_available, new_keyboard_name_keyboard_shortcuts_are_now_available, update_keyboard_shortcuts, enable_and_show_new_shortcuts, custom_keyboard_shortcuts(.add, .press_key)}` and the layout names `keyboard_settings.{us_qwerty, us_dvorak, german_qwertz, french_azerty, japanese_kana, uk_mac, uk_pc, swedish, danish, norwegian, italian, spanish, finnish, spanish_latin_america, chinese, portuguese, korean, default_unknown}`. Repo English (`src/shared/shortcuts.ts`): Generic, Chinese, Danish, Finnish, French AZERTY, German QWERTZ, Italian, Japanese (Kana), Korean, Norwegian, Portuguese, Spanish, Spanish (Latin America), Swedish, U.K. (Mac), U.K. (PC), U.S. Dvorak, U.S. QWERTY.
- Quick actions: `qa.search_or_ask_agent`, `qa.go_back`, `qa.plugins`, `qa.plugins_widgets`, `qa.ai`, `qa.learn_more`, `qa.copy_link`, `qa.extensions.{run, plugin, widget, open_in_community, request_approval, approval_pending, update_payment, locate_local_version, tooltip_actions}`, `qa.postscript.{add, ask_agent, more, open, open_chat, run, search, toggle}`, `qa.accessibility_status.{all_tab, assets_tab, extensions_tab(.include_widgets)}.no_results`, `qa.accessibility_status.has_results`, `qa.input.{description, add_context}`, `qa.toast.suggestion`. Live English (repo ActionsPanel): All · Assets · Plugins & widgets · Recents.
- Native menu (`desktop.menu.*`): file_menu, edit_menu, view_menu, object_menu, text_menu, arrange_menu, vector_menu, plugins_menu, widgets_menu, window_menu, help_menu, new_tab, new_window, close_tab, close_window, reopen_closed_tab, recently_closed_tabs, select_next_tab, select_previous_tab, interface_scale_menu / make_larger / make_smaller / reset_to_default / percent, toggle_full_screen, always_show_tabs_when_presenting, troubleshooting_menu, … (English for "New Design File", "New FigJam File" is hard-coded in main.js).

## 11. DesignerV2 today

| Area | Repo | Status |
|---|---|---|
| Command registry | `src/renderer/src/editor/commands.ts` (own ids `area.verb`, e.g. `object.bring-to-front`; ~70+ commands with keys), `src/shared/commands.ts` (menu-bar registry), `src/main/menu.ts` | **Differs**: ids are not Figma's action ids, so the shortcut JSON, popularity list and frecency keys cannot be reused 1:1. A `figmaAction` alias per command would let §6.2 be imported as data |
| Main / context menus | `src/renderer/src/editor/menus.ts` follows the live captures item by item (main tree, context menus by type, page row) | **Matches** the live captures. **Missing** the Edit menu's view-only and Dev Mode variants, Select layer ▸ rules (> 1 layer under the cursor), the "0 / 1 / ≥ 2" Main-component collapse rule, removal (vs greying) of disabled rows in canvas menus |
| Shortcuts | Bindings hand-written per command | **Differs** in places: Actions only ⌘K (Figma also ⌘/ and ⌘P); Zoom to fit only ⇧1 (Figma also ⇧9, and bare 1/9/2/0 when number-keys-for-opacity is off); no `!TEXT` / edit-mode table; Emacs text keys, F6 focus cycling, ⌃G / ⌃⇧4 grid aliases, ⌘Y / ⌃⇧3 outline aliases not checked |
| Keyboard layouts | `src/renderer/src/editor/shortcuts/layouts.ts` maps by **character** ("Figma's own per-layout remaps aren't public") + Turkish F/Q additions | **Differs**: Figma's per-layout remaps are now known (§7.3: e.g. German ⌘Ä / ⌘Ö for forward/backward, ⌘, for Actions, ^ for Show/Hide UI; Swedish letter-spacing ⇧⌥). Detection by OS input-source id prefix (§7.2) is not done the same way |
| Shortcuts panel | `src/renderer/src/editor/shortcuts/*` (tabs, used-shortcut lighting, Layout tab) | **Matches** in structure. Check: Timeline tab (gated), Components tab only with subscribed libraries, completion animation timings (1 500 / 6 000 ms, 110 ms × distance + 100), opening tab per editor |
| Quick actions | `src/renderer/src/editor/panels/ActionsPanel.tsx`: prefix 3 / word 2 / substring 1 score, sections, Recents max 3 in localStorage | **Partly matches**: recents = 3 ✓. **Missing**: fuzzy matching, synonyms, the 0.4 / 0.3 / 0.2 / 0.1 weighted rank, frecency (10 timestamps, buckets 100…0, cap 5 000), the popularity order for the unsearched list, disabled-after-enabled ordering, the 172 search-only actions, ⌃N/⌃P, Tab to parameters, 300 ms close on toggles, 150-char input limit |
| Native menu bar | `src/main/menu.ts` | interface scale (⇧⌥⌘ = / − / 0) and tab keys (⌃Tab, ⇧⌘[ / ]) worth comparing with §3.11 |

## 12. Open questions

1. **Libraries** in the main menu (live, after Preferences): its builder was not in 858's `GetFullscreenMenuItems`. Probe: search the other chunks for the item that opens the library modal from the main menu, or click it live and read `recordingKey`.
2. Enable predicates for the **Design** editor live in C++. The TS registry (§5) is INFERRED to match. Probe: in live Figma, check edge cases (Flatten with an instance sublayer, Tidy up on a lone auto-layout frame, Group on a variant).
3. **Finnish / Chinese** layouts have no tagged bindings: do they fall back to U.S. physical keys? Probe: pick Finnish in the Layout tab and press ⌥/ (remove fill) on a Finnish keyboard.
4. The rotation-shortcut keys (⌘⌥↑/↓ when the preference is on) and the arrow nudge are handled in C++, not in the JSON. Probe: the wasm strings around `enableRotationShortcuts`, or live press.
5. Default of **Use number keys for opacity** (INFERRED on, from the live ⇧1). Probe: a fresh account's Preferences menu.
6. Desktop-detection mismatch toast: when it fires (once per layout change? per session?) and what its buttons do. Probe: switch the macOS input source to German with Figma open.
7. The fuzzy matcher's scoring (class `Ax`) and the substring matcher's `perfectScore` were not read in detail. Probe: read module `614859` / `448234` in 3653.
8. Plugins / Widgets submenus (modules 381085 / 194524): exact sections and ordering. Belongs with chapter 17.
