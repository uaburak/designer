# Visual-parity sweep, round 9 (Design side vs real Figma)

Measured on `main` at `fa2ba58` on 2026-10-09, after the round 9 merges (r9-menus-left-toolbar: Figma main menu, Preferences, menu labels, page-row menu, context-menu geometry, toolbar dropdowns, Actions panel, Assets / Tools / Variables panels, labelled layer icons; and r9-header-components). Read-only sweep: no repo edits except this file.

**Truth:** `docs/research/figma/live/` (DOM dumps in design/, popovers/, grid/, menus/, left/, toolbar/; canvas screenshots in img/). Live wins over everything; where live has no data a point is marked **unverified**.

## Method

- Server: `vite --config vite.web.config.ts --mode demo --port 5591`; headless Chrome for Testing 1440x900 (DPR 1, SwiftShader), dark theme, one browser at a time, closed in `finally`. `?editor&doc=capture` (which now contains the live capture's components, instances, set and Card too, guids 8:x) for every state below; no `doc=components` was needed.
- Design panel: `live/tools/panel.mjs` for the 30 selection states, a second driver for the interactive ones (Add stroke / Add effect / Add export settings / Individual corners / Individual padding / Constraints / Add layout guide / grid picker / grid settings / row track panel / row track menu / shader browser / text edit). Popovers: `live/tools/popover.mjs` (all 47 cases + the 6 header / component cases it already carries). Menus: a driver that right-clicks the capture's layers on canvas, the Layers row and the Pages row, opens the Figma menu and hovers each submenu, opens each toolbar dropdown and the Actions panel, and dumps every open `[role=menu]` / popover with `dumpPopups.js`. Left side: a whole-window dump (absolute x,y like the live left files) for Assets (3 depths), Tools, Variables (empty and `doc=variables`), Find, Layers hover, Pages add. Canvas: engine `setCamera` + `setSelection` + mouse hover, screenshots next to `live/img/canvas-*.png`.
- Diff: `compare.mjs` / `compare-popups.mjs` were too noisy (wrapper divs, duplicated hidden text, radio `value=`), so a second diff was layered on the same dumps: texts matched by string and nearest position (±2 px, font, colour), controls matched by aria-label or geometry (±2 px, size, DISABLED), live-only hidden accessibility text (11px/450 or 400 duplicates of aria labels, clipped radio labels, `Autofill available…`) filtered, radio/checkbox `value=` and CHECKED-vs-EXPANDED wording ignored (it is the dumpers, not the UI).
- Raw numbers per state are in Appendix A (Design), B (popovers), C (menus).

**Caveats**
- Many live captures were taken after earlier edits in the same live file: the Rect already carries a stroke and a Drop shadow (rectangle-with-export, individual-corners), the file has a "Page 1" page and a `Tokens` collection, `Delete page` is enabled, `Undo` is enabled. Those differences are fixture, not UI, and are listed as such.
- Live menus are not clipped by the window (blend mode menu 555 tall, Object submenu 1050, frame presets 1887); ours clamp to the viewport and scroll. Not counted as a difference beyond the note.
- Our `7:66` Vector still has no vector network, so it draws nothing; vector edit mode, its panel and the toolbar's More menu could be entered but not compared pixel for pixel.
- No slot fixture exists in ours: `component-with-slot`, `instance-with-slot`, `component-create-slot-property` were not reproduced (the Create property menu does list Slot).
- Headless DPR 1: the selection box's bottom and right edges draw a lighter 1 px line than the top and left ones at 300 % zoom; at DPR 2 all four edges are the same blue. Treated as a capture artefact (unverified on a GPU).
- The live `behaviour/*.md` notes are about interactions, not layouts; they were not re-measured. One check against them: the pixel grid appears at 300 % and above in both (`behaviour/keys.md` §24).

## Re-check on main c8bbc9f (2026-10-09)

`main` has only the docs commit on top of the measured `fa2ba58`, so this re-check re-ran the tools (`popover.mjs` 47 + 6 cases, a menus driver, a whole-panel dump for 14 selection states, left side, GPU-backed canvas shots at DPR 2) and compared against the live files again. Result: **all numbers of this sweep reproduce** (every popup position and size in Appendix B and C is the same to the pixel) with these corrections:

- **Shape handles (arc, star, polygon) and the 2 px path outline: CLOSED.** They are drawn, but while the pointer is over the shape (like live's rectangle radius handles); the sweep measured without hover. Checked on GPU (Metal, DPR 2) and SwiftShader (DPR 1).
- Page-row menu (`Move up`), `Move to page`, `Delete page`: CLOSED, a fixture difference (one-page capture file; live has `Page 1` first).
- MCP section, AI sparkle, Tools promo / suggested plugins: **WONTFIX** (no agents, MCP, plugins in this app).
- S9 split into stubbed commands (real gaps) and state differences; S10 refined (disabled-row and hovered-row shortcut colours); font filter, Actions palette and vector edit re-measured (see their entries); "unselected frame hover" is unverified (no live capture).
- Confirmed OPEN with their numbers: S5 (Alignment 44 vs 46 wide), S8 (Boolean menu 150x136 vs 151x120, rows at y=13 vs 6), nested instance (live disables X, Y, Rotation, Rotate 90, Flip, Flow group, Wrap, Ignore auto layout, Lock aspect ratio, the Align row; ours enables Rotate 90, Flow Horizontal, Lock aspect ratio, Ignore auto layout), Align buttons on Frame / Group / Boolean (live enabled, ours disabled), Ellipse Corner radius / Line Height / text Width and Height (live DISABLED, ours enabled), grid child `Column span` / `Row span` (ours one `Span` caption), Selection colors (live 4 rows, ours 3 + link), fill picker y 347 vs 307 for Libraries / Gradient / Video / Shader / Custom, Shader tab content, individual strokes 117x177 at y=715 vs 117x159 at y=539, effects / typography styles y (664 / 586 vs 719 / 427), Assets component grid (ours a list of icon + name rows), page rows 240x32 `option` vs 224x24 buttons, frame title right-click (ours opens the 200x218 canvas menu), the vector edit toolbar and panel.
- Groups for the next fix round are at the end of the file ("Fix groups").

## Summary

- Round 8 ended with **49 OPEN** entries. Re-measured here: **34 CLOSED**, **7 partly closed** (what is left is listed), **8 still OPEN** (one of them, Tools, is intended). The resting Design panel is within 1 px of live for rectangle, ellipse, polygon, star, vector, section, image fill, multi-selection and (with fixture offsets) every other state; menus, popovers and toolbar dropdowns now open at live's coordinates and widths (main menu 194x444 at (12,44), submenus 4 px right, canvas menus 200 wide, Move / Region / Shape / Creation / Type / Comment tools identical to the pixel, Actions palette 529x354 at (456,478), Figma menu items, Preferences 29 items at 235x763, Help 178x249).
- What is still different, in order of size: (1) the **canvas handles** for ellipse arc, star and polygon are not drawn and the path outline is 1 px where live draws 2 px; (2) **vector edit mode** (toolbar and panel); (3) **menu vertical padding** and placement of panel-anchored menus (8 px padding top and bottom where live has none, so every row sits 7 px lower, menus 16 px taller, and several menus open 9-190 px away from live's anchor); (4) **enabled / disabled states**: dozens of rows live shows enabled that ours greys (Open in desktop app, New Design, Duplicate, Save local copy…, Comments, Zoom to selection…, Send to Figma Make, Move to page…) and Align buttons / ellipse radius / text W-H / nested-instance fields that live disables or enables differently; (5) the **Actions palette's default content** (Recents, Image editing, Design tools, AI), the **Assets component grid**, **MCP** section, rename rows in the layer context menu.

## Systematic differences

| # | Severity | Difference |
|---|---|---|
| S1 **[CLOSED]** | high | Menu typography and geometry (r8). Still closed: 11px/450 text, content-fitted widths, text at x=32 / x=16, 200-wide canvas menus. |
| S2 **[CLOSED]** | high | Popover placement for the Design panel's big popovers: auto layout, grid, stroke, effect, type, font, fill pickers dock at x=959/960 with the live y (stroke settings (960,660) both, effect (960,660), font picker (960,415), type settings (960,378), advanced auto layout (960,484) vs live 481). |
| S3 **[PARTLY]** | low | Row text weight: panel rows are now 11/400 where live is (effect row, grid sizes). Left: effect / texture / noise / pattern popovers label `X` and `Y` at 11/400 where live is 11/450; Find's "This page" and parent names 11/450 vs live 11/400. |
| S5 **[OPEN]** | low | 9px/500 captions are 2-4 px narrower in ours (Alignment 44 vs 46, Position 35 vs 37, Rotation 36 vs 38, Dimensions 51 vs 53, Corner radius 59 vs 62, Start point 45 vs 49, Letter spacing, Line height). Same face; a letter-spacing difference. |
| **S8 [NEW]** | med | **Menu vertical padding in `role=menu` popups opened from the Design panel** (Boolean operations, Create property, Instance more actions, Individual strokes, Blend mode, Font style, Grid row track menu). Ours: 8 px padding top and bottom, rows 101-205 wide at x=8; live: rows start at y=0 and are full width (first text at y=6, ours 13; selected row `0,y,W,24`), so ours is 16 px taller (Boolean 136 vs 120, Create property 223 vs 207, Instance more actions 325 vs 309, Individual strokes 177 vs 159, row track menu 88 vs 72) and every row sits 7 px lower; blend / font style rows are 7-17 px lower. The listbox-style menus (constraints, sizing, gap, stroke position, effect type, variant dropdown, all toolbar and context menus) already have live's heights. Files: `ds/components/Menu.tsx`, `panels/design/Header.tsx`. |
| **S9 [OPEN, re-checked: split below]** | med | **Re-check 2026-10-09:** the commands that are stubs (`later(...)` in `editor/commands.ts`, always disabled) and live has enabled: Duplicate, Save local copy…, Create branch…, Move to project…, Comments, Mask outlines, Frame outlines, Memory usage, Minimize left navigation bar, Multiplayer cursors, Switch to Draw, Find previous / next frame, Convert to section, Convert to frame, Set as thumbnail, More layout options, Hide other layers, Copy / Paste properties, Set default properties, Distribute (6), Pack horizontal / vertical, Round to pixel, Join / Smooth join selection, Split / Simplify / Offset vector, Show/Hide comments, Cursor chat, Spell check and text direction; plus the no-agents/account stubs that stay disabled on purpose (Open in desktop app, Send to Figma Make, Find similar designs, Add motion, Manage plugins / widgets, Select all widgets, Color profile, Keyboard layout, Accessibility, Permissions and helpers, Open font settings, Account settings, Log out). **State, not UI** (live was captured with a selection / history / two pages): Undo, Find next / previous (need an active search), Zoom to selection (needs a selection; the engine command exists), Move to page (one-page fixture), Outline stroke and Flatten (the live Rect already had a stroke), New Design / Save to version history… / Show version history (depend on the document source). Original text:  **Disabled where live is enabled** (menus, see "Enabled / disabled" under Menus). Open in desktop app (all 13 submenu dumps), File: New Design, Duplicate, Save local copy…, Save to version history…, Show version history, Create branch…; Edit: Undo (fixture: live has history), Find next / previous; View: Comments, Mask outlines, Frame outlines, Memory usage, Minimize left navigation bar, Multiplayer cursors, Switch to Draw, Zoom to selection, Find previous / next frame; Plugins: Manage plugins…; Widgets: Manage widgets…, Select all widgets; Preferences: Color profile…, Keyboard layout…, Accessibility settings…, Permissions and helpers…; Help: Open font settings, Account settings, Log out; context menus: Send to Figma Make, Find similar designs, Add motion, Move to page, Convert to section, Outline stroke, Set as thumbnail, More layout options, Flatten (instance), Show/Hide comments, Cursor chat; Type tools: Text on path. Many are intentionally not part of this app (plugins, widgets, account, Make); the others (Find next, View toggles, Zoom to selection, Move to page, Outline stroke, Flatten, Duplicate, Save local copy) are features the app can do. |
| **S10 [OPEN, refined]** | low | Shortcut glyph colour. Re-checked: live uses #ffffff66 for the shortcuts of **disabled** rows (main-arrange 9, main-object 16, main-edit 7, main-text 7) and #ffffffcc for the shortcut of the **highlighted / hovered** row (Union in the Boolean menu, the selected tool in the toolbar menus); everything else #ffffffb2. Ours draws #ffffffb2 everywhere in `role=menu` menus (the Actions palette already dims disabled rows: #ffffff66). So it is a disabled / hover state colour, not a menu-wide one. `ds/components/Menu.module.css`. |

## Design panel, by state

The 30 selection states and 12 interactive states are summarised in Appendix A. Rectangle, ellipse, polygon, star, vector, section, multi-two-shapes, rectangle-with-stroke are identical within ±2 px (the only entry is the S5 caption width, plus "Ellipse: Corner radius field DISABLED in live").

**Header actions**
- **[CLOSED]** layer in frame / auto layout / grid: `Select matching layers` (124), `Create component` (152), `Use as mask` (180), `More actions` (208), no Boolean group: matches.
- **[CLOSED]** component, set, variant header (name input, Add variant, Component configuration, More actions, Multi-edit variants, Select matching layers): matches; `Component configuration` popover identical (320x317 at (880,81)).
- **[WONTFIX]** *(MCP / agents: not part of this app)* Page with nothing selected: live has an **MCP** section ("MCP" 11px/550 at (16,181), "1 connection" chip at (49,181), `[Set up agents for Figma MCP]` at (208,175)) and `[Apply variable mode]` at (208,8) (the capture file has the `Tokens` collection); ours has neither (the `capture` fixture has no collections; `[Apply variable mode]` was verified in r8 on `doc=variables`). `[Apply variable mode]` is **[CLOSED]** (needs a variable collection; the capture fixture has none, `doc=variables` verified in r8).

**Component panel** — all **[CLOSED]**: Properties rows (`Show icon ・ True`), Create property menu content and order (Variant, Text, Boolean, Instance swap, Slot), Variant panel (`Current variant`, Select component, `Edit property name for State` rows), Instance header with `From this file` row and apply buttons, instance swap picker (identical), instance variant dropdown (107x88 at (1304,141), identical), header swap menu (identical). Residual: ours `[Instance menu]` is a 70x24 button holding the name where live shows plain text beside it; `[State values]` 24x24 at (176,76) on a variant (live has none).
- **[OPEN]** *(med)* **Nested instance** (the Button inside Card instance): live disables X, Y, Rotation, Rotate 90, Flow (Freeform, Vertical, Horizontal, Grid, Wrap), Ignore auto layout and Lock aspect ratio; ours leaves them enabled (and shows Horizontal checked where live disables the whole Flow group). Live's `Advanced auto layout settings` listboxes (88x32 at (16,474) / (112,474)) are not in ours.

**Position / Layout**
- **[CLOSED]** Constraints: toggle `#32394d`, rows at (16,207)/(16,239), widget; ours dropdowns are 88x24 comboboxes where live's are 88x24 buttons (identical visually).
- **[OPEN]** *(low)* Align buttons: live leaves them enabled for a single **Frame, Group, Boolean** (and enables `toggle-ready-for-dev-status` for Group); ours disables them for every single selection except the multi-selection. Rectangles, ellipse etc. are disabled in both.
- **[OPEN]** *(low)* Fields live disables, ours enables: Ellipse **Corner radius** (136,409), Line / Arrow **Height** and rotation buttons, text with auto width **Width / Height** and, while editing text, Rotate 90 / Flip H / Flip V.
- **[OPEN]** *(low)* Grid child: live has two captions **Column span** (16,340) and **Row span** (112,340); ours one **Span** (16,338).
- **[CLOSED]** Width / Height sizing menus (ours 168x129 at (1136,392) vs live 166x129 at (1138,399)), gap menu, advanced auto layout settings (identical contents, 240x345 at (960,484) vs (960,481)) except: live shows Inside stroke **Included**, ours **Excluded** for the capture's AL_horizontal / AL_grid (live default; the live frames were created by the plugin API, so unverified for new frames), and `Align text baseline` is a hidden label in ours.
- Fields: ours W / H inputs for `Fill` / `Hug` are 15-22 px wide inside the 88x24 box where live's input is 48x24; visually equal.

**Appearance / Fill / Stroke / Effects / Export**
- **[CLOSED]** Individual corners (rows at y=441 / 473, no captions, `Corner smoothing` at (208,473)); image-fill row; Line / Arrow `Start point` / `End point` captions and dropdowns; stroke default Inside; effects row (11/400, x=41); export row (`Export constraints…`, `Select an option`, `Export file type`, Preview).
- **[OPEN]** *(low)* **Selection colors** (mixed-multi, component set): live lists every colour (4 rows: D9D9D9, 000000, 3380FF, FFFFFF); ours lists three (3380FF, D9D9D9, 000000) then a "See all 4 colors" link, in a different order. (r8 had this closed for three colours.)
- **[OPEN]** *(low)* Layout guide row with a guide: live shows the type as a 124x24 button with a hidden `Layout guide type` label at (48,854); ours a 124x24 button (matches) and `Hide layout guide` where live's input is `Toggle visibility`.

**Text**: text panel matches except the items in "Position / Layout" above. Text edit mode: ours enters edit with Enter and selects the whole text; live is captured with a caret at the end after a double click (not comparable). The font picker (240x469 at (960,415), "Fonts", `Search fonts` = Inter, `Clear search`, rows 240x28) is identical.

## Popovers and menus opened from the Design panel

Appendix B has every case. Placement and size, live → ours:

| Popover | Live | Ours | Status |
|---|---|---|---|
| Fill picker Solid / Pattern / Image / Libraries / Gradient / Video | 240x537 (959,347) / 240x522 (959,347) / 240x577 (959,307) / 240x203 (959,307) / 240x297 (959,307) / 240x353 (959,307) | same sizes at x=960; Solid (347), Pattern (347), Image (307) match | **[PARTLY]** *(low)* Libraries, Gradient and Video open at y=347, 40 px below live's 307 (live: top = 307 for the taller / non-colour pickers, 347 for Solid and Pattern). Swatch order follows the document (fixture). |
| Fill picker **Shader** tab | 240x353 at (959,307): Fill row with Blend mode (208,48), Rotate 90º, image controls, Upload; second popover Shader fills 240x510 at (719,307) | 240x537 at (960,347) still shows the colour picker area (Hex, Sample color, Check color contrast); shader browser 240x510 at (720,347) | **[OPEN]** *(med)* the Shader tab keeps the colour UI where live shows the image-like Fill panel (353 tall). |
| Gradient type menu / colour format menu / swatch-set menu | 240x297 + shader browser (719,307) / 87x136 at (967,672) / swatch set 224x40 popover | gradient menu 112x112 at (968,432) (no second popover); format menu 87x136 at (968,712); swatch set 208x24 popover | **[OPEN]** *(low)* gradient menu has a different shape (live's capture also had the shader browser open, so only placement is comparable). |
| Stroke settings / position / individual strokes | 240x224 (960,660) / 105x88 (1208,678) / 117x159 (1315,539) | 240x224 (960,660) / 105x88 (1208,677) / 117x177 (1315,715) | settings **[CLOSED]**, position **[CLOSED]**; individual strokes **[OPEN]** *(low)*: 18 px taller (S8 + separator) and opens below the trigger where live flips above (715 vs 539). Stroke settings (240x224 at (960,660), identical rows): `Miter angle` field 104x24 at x=120 vs live 110x24 at x=113; `Dynamic` / `Brush` are #ffffffb2 in live and #ffffff66 in ours (ours disables them). |
| Effect settings (Drop shadow, Inner shadow, Noise, Texture, Layer blur, Background blur, Glass) | 240x224 (959,660) etc. | 240x224 (960,660) etc. | **[PARTLY]** *(low)* popover size and rows match; fields: Blur radius / Spread / Radius / Density are 136x24 at x=88 in ours, 110x24 at x=113 in live (live labels sit inside 136x24 label boxes); Glass Angle 72x24 at (152,57) vs live 64x15 at (159,62), Intensity 72x24 at (152,88) vs 63x24 at (160,88); `Noise type` hidden label; X / Y labels 400 vs 450. Background blur: live capture is the Progressive state (Start / End rows, 156 tall); ours is Uniform (124): state, not UI. |
| Effect type menu | 147x207 at (967,449) | 147x207 at (968,449) | **[CLOSED]** (ours text 11/450 at x=44, "Shader" after a separator). |
| Shader effects browser | 240x510 at (959,374) | 240x510 at (960,374) | **[CLOSED]**; `Create with agents` is disabled in ours (live enabled). |
| Blend mode menu | 118x555 at (1315,472) | 117x429 at (1315,463) | **[CLOSED]** except S8 (rows 7-17 px lower; live not clipped). |
| Boolean operations menu | 151x120 at (1253,129) | 150x136 at (1254,120) | **[OPEN]** *(low)* S8: 16 px taller, rows 7 px lower, 9 px higher, shortcuts #ffffffb2 vs #ffffffcc. |
| Constraint menus / width / height / child width / gap menus | 126x136, 136x136 at (1208,280/312) / 166x129 / 162x129 / 156x64 at (1244,473) | identical sizes (±2) at the same x; y 1-9 px higher | **[CLOSED]**; selected row is `CHECKED` vs live `SELECTED` (dumper). |
| Auto layout settings / grid settings | 240x345 (960,481) / 240x249 (960,485) | 240x345 (960,484) / 240x249 | **[CLOSED]** (Included vs Excluded, see above). |
| Grid dimensions picker | 210x204 at (1204,427) | 210x204 at (1204,427) | **[CLOSED]**: `Number of columns` / `Number of rows` fields at (8,8) / (117,8), cells with `n × m` tooltips, `Grid dimensions` caption; ours adds a 194x24 `Open grid settings` button at (8,174). |
| Grid row track menu | 156x72 at (419,549): `Fixed height (84)`, `Hug contents`, `Fill container (1fr)` text at x=52 | 140x88 at (1292,383): `Fixed height`, `Hug contents`, `Fill container (1fr)` text at x=32 | **[OPEN]** *(low)* the value is missing from "Fixed height (84)", text x=32 vs 52, 16 px taller (S8), anchored beside the panel button, not at the canvas pill. Row-track **panel** (Columns / Rows lists, Track sizing, `1fr`, Add / Remove) matches within ±2 px; ours adds `[Column n sizing]` 24x24 buttons at (176,y). |
| Frame presets menu | 222x1887 at (1208,125): flat list, no group headings | 222x776 at (1208,116), scrolls, with headings "Frame Layout Options", "Phone Presets", "Tablet Presets", "Desktop Presets" | **[OPEN]** *(low)* ours adds headings live does not show; the rows are 7 px lower (S8); live is not clipped. |
| Font picker / font style / font size | 240x469 (960,415) / 167x313 (1208,575) / 96x437 (1312,455) | 240x469 (960,415) / 168x506 (1208,386) / 96x400 (1312,448) | picker **[CLOSED]**; font style **[CLOSED]** (order, `Variable font axes…`) but ours is not clipped and opens at y=386; font size **[CLOSED]** except 37 px less list shown. |
| Font filter | 240x229 at (960,488): All fonts / In this file / (sep) Popular fonts, Google fonts, Variable fonts / (sep) Uploaded by you, Installed by you | 240x160: All fonts, In this file (37), Installed by you (85), Google fonts (109), Variable fonts (133) | **[OPEN]** *(low)* re-measured: ours 240x160 at (960,488) with All fonts, In this file, `Popular`, Installed by you, Google fonts, Variable fonts at x=32; live 240x229: All fonts, In this file, (sep) `Popular fonts`, Google fonts, Variable fonts, (sep) `Uploaded by you`, Installed by you. Wording of the one label, order, separators and `Uploaded by you` differ. `editor/fontList.ts`, `editor/panels/design/FontPicker.tsx`. |
| Type settings (Basics / Details / Variable) | 240x506 at (960,378) | same size at (960,378) | **[CLOSED]**; Details: OpenType feature labels the font does not have are dimmed #ffffff66 in live (Hanging punctuation, Case-sensitive forms, Slashed zero, Rare ligatures, Open digits, Alternate one, Open four…) and #ffffffb2 in ours (font-dependent, low); live tab "selected" label is 11/550 (ours 450 on the unselected tabs, 550 on the selected one: dumper noise); Variable tab: the axes are in a different order and pitch (live Slant at y=194 then Weight at y=259; ours Weight at 193, Slant at 225), value fields 64x24 at x=160 vs live 72x24 at x=151, and ours adds a `Preview` text. |
| Layout guide settings / type menu / styles | 240x128 (960,756) / 110x88 (968,792) / 216x165 (984,719) | 240x128 (960,756) / 110x88 (968,758) / 216x165 (984,719) | **[CLOSED]** except `Layout guide type` 11/550 title and the Width `Apply variable` 20x22 button inside the field, not drawn. |
| Effect styles / Typography styles | 216x165 at (984,719) / (984,427) | 216x165 at (984,664) / (984,586) | **[OPEN]** *(low)* size matches, y differs by 55 / 159 (live pins the popover's bottom at 884; ours anchors to the trigger); live search is `EXPANDED`. |
| Export format menu / advanced | 92x112 at (1290,764) / 240x184 at (960,700) | 92x112 at (1290,733) / 240x184 | **[CLOSED]** (y differs by the anchor row). |
| Instance more actions / swap menu / swap property picker / variant dropdown | 221x309 (1211,129) / 240x441 / 240x441 / 107x88 (1304,141) | 221x325 (1211,120) / identical / identical / identical | **[CLOSED]**; more actions: 16 px taller (S8). |
| Create property menu | 156x207 at (1277,161) | 156x223 at (1276,152) | **[CLOSED]** except S8. |
| Component configuration | 320x317 at (880,81) | identical | **[CLOSED]** |

## Menus

Popup coordinates and widths, live → ours (Appendix C): every dump of the Figma menu and submenus opens at the live coordinate (`main-menu` 194x444 at (12,44); File 198x324 at (210,126); Edit 190 vs 189; View 201x787 at (210,105) vs (210,108); Object 185x1050 vs 185x889 (clamped); Text 199x379; Arrange 220x533; Vector 198 vs 195; Plugins 181x122; Widgets 152x64; Preferences 235x763; Help 178x249; View > Panels 174x136 at (416,554) vs (415,557)); every item text is present with the live wording, nothing is missing or extra.
- **[CLOSED]** Main menu (width, "Actions…" enabled with the icon at x=40, Open in desktop app listed), Preferences (29 items, one `Use ⌘⌥↑/↓ to rotate layers` 4 px narrower), Help submenu, Object submenu (Reset instance, Delete contents present), File "New" group, Edit ⎋, View labels (`Switch to Dev Mode`), Text, Vector, Arrange, Plugins, Widgets.
- **[CLOSED]** Context menu geometry: canvas menu 200x218 at the click, shape / text 200x653, multi 200x677, frame 200x749 (all identical in height to live), item text at x=16, shortcuts one 12px glyph per key.
- **[OPEN]** *(low)* Context menu rows that differ from live:
  - Main component: ours adds a disabled `Convert to section`.
  - Instance: ours adds `Convert to section` and `Set as thumbnail` (disabled) and shows `Remove auto layout` where live shows `Add auto layout`; live has a `Select layer` row (16,199) ours lacks; width 201 vs 203.
  - Layers panel row: live has `Rename` (⌘R) and `Rename layers` (AI tag) rows (677 tall); ours has neither (653), and starts with `Paste here` where live starts with `Copy`.
  - Frame: all rows present; frame **title label** right-click opens the canvas menu in ours (live: the frame's menu); a right-click on the frame's padding opens the frame menu (unverified for a real mouse, the click was synthetic at the label).
- **[CLOSED]** *(fixture)* Page-row menu: live 200x187 (Copy link to page, Rename page, Duplicate page, Move up, Delete page); ours 200x146 without `Move up`. `Move up` is shown only when the page is not first (`editor/menus.ts` `at > 0`); the capture fixture has one page where live's file has `Page 1` before `Capture`. Same cause for `Move to page` and `Delete page` being disabled in ours. Fix is in `CAPTURE_DOCUMENT` (add the empty first page `Page 1`), not in the UI. `Copy link to page` stays disabled (no links in a local app; low, intended).
- **[CLOSED]** Bottom toolbar: all six dropdowns identical (Move tools 151x72 at (497,764), Region 150x72 at (554,764), Shape 196x168 at (611,668), Creation 142x48 at (668,788), Type 142x48 at (725,788), Comment 186x72 at (782,764)); tool group geometry matches (456,840 529x48).
- **[OPEN]** *(med)* Actions palette (live 529x354 at (456,478); re-measured ours 529x282 at (456,550): same bottom edge 832, but content-fitted where live is a fixed 354, with the search 431x32 and All / Assets / Plugins & widgets tabs inside it): geometry matches except the height, but the default content is not live's: live lists **Recents** (Translate to…, Lorem Ipsum — by ‹div›RIOTS, Rewrite this…), **Image editing** (Make an image, Remove background, Boost resolution, Edit image with prompt), **Design tools** (Rename layers, Replace content, Add interactions), **Riffing and writing** (Shorten…) and a `Visual search (AI beta)` button at (491,12); ours lists File, Edit… commands from the main menu (Back to files, Place image/video…, Export…). Most of live's list is AI; Recents is not.
- **[OPEN]** *(med)* Vector edit mode toolbar: live opens a **secondary toolbar above** the bottom toolbar (529x40 at (455,792)): `Move` (selected), `Lasso`, `Paint`, `Bend`, `Cut`, `Erase`, `More ▾`, ✕, with labels; ours replaces the bottom toolbar with a short bar (Move, Lasso, Pen, Bend, Paint bucket, Done). The Design panel in vector edit is "Vector path" with Points, Corner radius and mirroring in ours vs "Vector" with Alignment, Position, Mirroring, Corner radius, Fill and Stroke in live. Re-checked 2026-10-09 with a real path (a three-point path drawn with the Pen on `doc=capture`, because the capture fixture's `7:66` Vector has no vector network and draws nothing: **the fixture needs a real path**, e.g. the live triangle at (900,300) 80x90): ours replaces the bottom toolbar by a 269x48 bar at (586,840) with icon-only Move, Lasso, Pen, Bend, Paint bucket and a blue `Done`; live has the 529x40 secondary toolbar at (455,792) *above* the bottom toolbar (`live/toolbar/vector-edit-toolbar.txt`: Move 60x24 selected, Lasso 62, | Paint 58, Bend 59, Cut 50, Erase 61, | More 55 (opens `Vector editing tools` 189x48 at (869,736): Shape builder `M`, Variable width `⇧W`), | Close 24x24; labels 11/400). Panel: ours with a point selected shows the title `Vector path`, then **Point** (Point position, Corner radius and mirroring, Mirroring), Position, Layout, Appearance, Fill, Stroke; live (`live/design/vector-edit-mode.txt`) shows `Vector` with Alignment, Position X/Y (disabled), **Mirroring** (3 icon radios: No mirroring, Mirror angle, Mirror angle and length), Corner radius, then Fill and Stroke only (no Layout / Appearance / Effects / Export). Point-selected state: `live/design/vector-edit-point-selected.txt`.

## Left side

- **[CLOSED]** Rail: `[Main menu]` 32x32 at (12,8) with the menu at x=12; item positions and 9px/450 labels equal live.
- **[PARTLY]** Assets: header, `[Libraries]` (261,12), search 156x16, `Libraries and settings`, `All libraries`, the "Created in this file" card (bg #ffffff1a), `Add more libraries` all match. The first card says "5 components" where live says "6" (fixture). Inside the card, live shows the components as a **2-column grid of thumbnail cards** (Button, Card, Chip, Heart, Star with names under them, "Includes 3 variants" and `Press Enter or Space to insert` hints) under a `[Back]` row "Created in this file / Capture"; ours shows a **list** of icon + name rows. **[OPEN]** *(med)*. Also missing: the left panel's vertical `[Resize handle]` slider at (295,0) 8x900 (live), and live marks the rail button `EXPANDED`.
- **[WONTFIX]** *(intended)* Tools: live shows a promo card ("More AI image tools to explore", Learn more / Got it), `Suggested` plugins and shaders (ASCII art generator, Glowing particles, Motion Frame Scaler, Nebula, Glyphs…); ours says "No tools — Plugins, widgets and shaders aren't part of this app." Header (Tools + Create), search, Source / Category filters (79x24 and 91x24 in live) are present.
- **[CLOSED]** Variables full view: file name header, Collections with Options + Create, Groups with its header and counts, Create variable row, empty state. Residual (low): ours shows a settings glyph at the right of every row; the capture's `Tokens` has Light / Dark columns (fixture).
- **[CLOSED]** Pages (add new page, inline rename `[Page name]`, Find, Add); **[OPEN]** *(low)* page rows are 240x32 `option` rows in ours vs 224x24 buttons at x=8 with 8 px gap in live.
- **[CLOSED]** Find: `Search scope set to This page`, results with name + parent, filter menu. **[OPEN]** *(low)* result parent names 10/450 vs live 10/400; the filter popover could not be opened by label this time (the `Filter` button is not named).
- **[CLOSED]** Layers: glyphs are named (`img [Rectangle]`, `[Auto layout]`…, 27 in the dump); row hover; selected + hover. `[Collapse layers]` shows when a layer is expanded.

## Canvas (screenshots vs `live/img/canvas-*`)

- **[CLOSED]** **Shape handles** (re-checked 2026-10-09, see "Re-check on main c8bbc9f"): the original entry was a measurement error. The ellipse arc handle, the star handles (top, first inner corner, right tip) and the polygon handles (top, bottom-right) are drawn, and the path outline is 2 px, **while the pointer is over the shape** (exactly like live's rectangle radius handles: `canvas-rect-selected.png` at rest has the 1 px outline and no handles, `canvas-rect-selected-hover-radius-handles.png` has 2 px and the rings). The sweep had moved the pointer away after `setSelection`. Verified with GPU-backed headless (`--enable-gpu --use-angle=metal`, DPR 2) and with SwiftShader DPR 1: identical. Code: `engine/src/render/Overlay.cpp` (shapeHandles ring loop), `engine/src/tools/Gestures.cpp` (`shapeHandles`, `kArcInset`), native tests `engine/tests/unit/r9.overlays.test.cpp`.
- **[CLOSED]** Selected auto layout: title in selection blue, `</>` icon at the top-right, padding / gap bars. Hover gap: pink badge (ours 28x16, live ≈33x21 at the same zoom **[OPEN]** *(low)*); padding hover bar.
- **[CLOSED]** Selected grid frame: every cell outlined, mid-edge padding bars, `</>` icon, compact pills, hover pill `||| 1fr ▾`. **[OPEN]** *(low)* the hovered column's outline is a thin dark line in ours; live draws a 2 px blue outline around the hovered column.
- **[CLOSED]** Section label (grey pill, 550 text), rect selected (handles, `120 × 90` pill), layout guide columns (pink columns, same alpha), component / instance / frame titles.
- **[WONTFIX]** AI sparkle button beside a selection (AI feature; no agents in this app). **[UNVERIFIED]** *(low)* "unselected-frame hover shows the blue title + `</>` in live": no live capture shows it (`canvas-hover-outline-nothing-selected.png` hovers a *child*, the title stays grey); ours hovers the frame with a 2 px blue outline and a grey title. Needs a live capture of a hovered top-level frame before anything is changed.
- **Unchanged**: pixel grid from 300 % zoom, hover outline, text edit box.

## Anything live shows that ours lacks entirely

1. **MCP section** on the Page panel and its `Set up agents for Figma MCP` button: **WONTFIX** (no agents / MCP in this app).
2. ~~Shape handles: arc / star / polygon~~ **CLOSED** (drawn on hover; see Canvas).
3. **Vector edit** secondary toolbar and the Vector panel (med); also our Vector 7:66 has no path.
4. **Actions palette default content** (Recents and AI sections) and the visual search button (med).
5. **Assets component grid** with thumbnails (med) and the left panel's resize handle (low).
6. **Layer context menu**: `Rename`, `Rename layers` (AI); instance: `Select layer`; page row: `Move up` (low).
7. **Nested-instance disabled fields** (med), Align buttons enabled on frame / group / boolean (low), disabled ellipse radius / text W-H (low).
8. Slot states (not reproducible: no fixture).
9. Plugins / widgets lists, Make, Dev Mode annotation tools: intended exclusions.

## Round 8 re-check (every OPEN entry)

| r8 entry | Now | Evidence |
|---|---|---|
| S3 text weight | PARTLY | panel rows 11/400; popover X / Y 400 vs 450 |
| S5 caption width | OPEN | 2-4 px narrower |
| Header: nested layer | CLOSED | `autolayout-child`, `grid-child`, `frame-child-constraints` have the four live buttons |
| Header: component / set / variant | CLOSED | `component`, `component-set`, `variant` |
| Header: page MCP, Apply variable mode | OPEN | MCP missing |
| Component Properties | CLOSED | `component` 14 entries, all value / fixture |
| Variant panel | CLOSED | `variant` |
| Instance header | CLOSED | `instance`, `variant-instance` |
| Nested instance | OPEN | live disables position / flow / wrap / lock |
| Constraints | CLOSED | `frame-child-constraints-expanded` |
| Individual corners | CLOSED | rows at 441 / 473 |
| Line / Arrow stroke | CLOSED | `arrow`, `line` |
| Rectangle stroke default | CLOSED | Add stroke gives Inside |
| Effects row | CLOSED | `rectangle-with-effect` |
| Export row | CLOSED | `rectangle-with-export` (offsets are fixture) |
| Effect settings | PARTLY | field geometry, Glass, X / Y |
| Effect type menu | CLOSED | (968,449) 147x207 |
| Shader effects browser | CLOSED | (960,374) 240x510 |
| Boolean ops menu | OPEN | S8 |
| Grid dimensions picker | CLOSED | (1204,427) 210x204 |
| Frame presets | OPEN | headings, names, height |
| Instance swap picker | CLOSED | identical |
| Instance more actions | CLOSED | content; 16 px taller |
| Create property menu | CLOSED | content and order; 16 px taller |
| Component configuration | CLOSED | identical |
| Layout guide styles | PARTLY | layout guide styles at (984,719); effect / typography styles y |
| Export format / advanced | CLOSED | opens; y by the anchor |
| Main menu | CLOSED | (12,44) 194x444 |
| Preferences | CLOSED | 29 items, 235x763 |
| Help | CLOSED | 178x249 |
| File / Edit / View / Text / Vector / Arrange submenus | CLOSED | all labels; widths ±3 |
| Object submenu | CLOSED | labels; clamped to the window |
| Multi-selection context menu | CLOSED | same rows (200x677) |
| Page-row menu | CLOSED (fixture) | one-page fixture |
| Context menu geometry | CLOSED | 200 wide, x=16 |
| Bottom toolbar | CLOSED | all six menus identical |
| Actions panel | PARTLY | opens at (456,478) 529x354; default content differs |
| Rail main-menu button | CLOSED | 32x32 at (12,8) |
| Assets | PARTLY | grid view missing |
| Tools | OPEN (intended) | "No tools" |
| Variables | CLOSED | structure matches |
| Find | CLOSED | residual 450 vs 400 |
| Layers icons | CLOSED | 27 named glyphs |
| Arc / star / polygon handles, path outline | OPEN | not drawn |
| AI sparkle | OPEN | not drawn |
| Auto-layout selected (`</>`) | CLOSED | `</>`, bars |
| Grid selected | CLOSED | cells, pills; hover outline colour open |
| Auto-layout hover | PARTLY | badge size |
| Section label | CLOSED | |

(49 rows: 34 CLOSED, 7 PARTLY, 8 OPEN. The residuals of the PARTLY rows are described in the sections above.)

## Appendix A: Design panel, live vs ours (counts after filtering; the large ones are live captures taken after earlier edits, which shift every row below the edit: individual-padding, frame-with-layout-guide, mixed-multi, variant-instance, component-set, frame-child-constraints)

| Design state | missing | diff | extra |
|---|---|---|---|
| arrow | 0 | 2 | 0 |
| autolayout-child | 0 | 4 | 2 |
| autolayout-grid | 1 | 2 | 2 |
| autolayout-horizontal | 2 | 0 | 2 |
| autolayout-individual-padding | 8 | 90 | 8 |
| autolayout-parent-fixed | 2 | 6 | 2 |
| autolayout-vertical | 2 | 0 | 2 |
| autolayout-wrap | 3 | 1 | 2 |
| boolean | 0 | 6 | 0 |
| component-set | 7 | 15 | 25 |
| component-with-slot | not reproduced | | |
| component | 4 | 7 | 3 |
| ellipse | 0 | 1 | 0 |
| frame-child-constraints-expanded | 2 | 1 | 6 |
| frame-child-constraints | 10 | 35 | 3 |
| frame-with-layout-guide | 10 | 73 | 7 |
| frame | 1 | 6 | 0 |
| grid-child | 8 | 11 | 3 |
| group | 0 | 7 | 0 |
| image-fill | 0 | 1 | 2 |
| instance-with-slot | not reproduced | | |
| instance | 5 | 12 | 4 |
| line | 0 | 2 | 0 |
| mixed-multi | 22 | 43 | 7 |
| multi-two-shapes | 0 | 0 | 0 |
| nested-instance-parent | 4 | 12 | 4 |
| nested-instance | 9 | 19 | 6 |
| page-nothing-selected | 4 | 0 | 0 |
| polygon | 0 | 0 | 0 |
| rectangle-individual-corners | 16 | 8 | 0 |
| rectangle-with-effect | 0 | 0 | 1 |
| rectangle-with-export | 16 | 16 | 3 |
| rectangle-with-stroke | 0 | 0 | 0 |
| rectangle | 0 | 0 | 0 |
| section | 0 | 0 | 0 |
| star | 0 | 0 | 0 |
| text-editing-caret | 10 | 15 | 1 |
| text-editing-partial | not reproduced | | |
| text | 10 | 12 | 0 |
| variant-instance | 6 | 31 | 11 |
| variant | 2 | 6 | 3 |
| vector-edit-mode | not reproduced | | |
| vector-edit-point-selected | not reproduced | | |
| vector | 0 | 0 | 0 |

## Appendix B: popovers opened from the Design panel (live vs ours, popup coordinates and entry counts)

Counts are lines of the filtered diff: `missing` = live text / control not found in ours, `diff` = found but position / size / font / colour / state differs (the popup box itself counts once), `extra` = ours with no live match (this includes the wrapper rows `option` / `menuitem` that live's dump does not list, so large `extra` numbers are mostly structure).

| Popover | popups live → ours | missing | diff | extra |
|---|---|---|---|---|
| autolayout-advanced-settings | @960,481 240x345 → @960,484 240x345 | 2 | 4 | 1 |
| autolayout-child-width-menu | @1142,379 162x129 → @1140,368 164x129 | 0 | 2 | 0 |
| blend-mode-menu | @1315,472 118x555 → @1315,463 117x429 | 1 | 20 | 19 |
| boolean-operations-menu | @1253,129 151x120 → @1254,120 150x136 | 0 | 11 | 5 |
| component-configuration | @880,81 320x317 → @880,80 320x317 | 0 | 0 | 0 |
| component-create-property-menu | @1277,161 156x207 → @1276,152 156x223 | 0 | 9 | 6 |
| constraint-horizontal-menu | @1208,280 126x136 → @1208,279 125x136 | 0 | 0 | 5 |
| constraint-vertical-menu | @1208,312 136x136 → @1208,311 135x136 | 0 | 0 | 5 |
| effect-settings-background-blur | @959,660 240x156 → @960,660 240x124 | 4 | 5 | 2 |
| effect-settings-drop-shadow | @959,660 240x224 → @960,660 240x224 | 0 | 4 | 0 |
| effect-settings-glass | @959,571 240x313 → @960,571 240x313 | 0 | 2 | 0 |
| effect-settings-inner-shadow | @959,660 240x224 → @960,660 240x224 | 0 | 4 | 0 |
| effect-settings-layer-blur | @959,660 240x124 → @960,660 240x124 | 0 | 3 | 0 |
| effect-settings-noise | @959,660 240x224 → @960,660 240x224 | 1 | 6 | 0 |
| effect-settings-texture | @959,660 240x213 → @960,660 240x213 | 1 | 3 | 0 |
| effect-styles | @984,719 216x165 → @984,664 216x165 | 0 | 2 | 1 |
| effect-type-menu | @959,660 240x224|@967,449 147x207 → @960,660 240x224|@968,449 147x207 | 0 | 5 | 15 |
| export-advanced-settings | @960,700 240x184 → @960,700 240x184 | 1 | 0 | 0 |
| export-format-menu | @1290,764 92x112 → @1290,733 92x112 | 1 | 1 | 4 |
| fill-picker-color-format-menu | @959,307 240x537|@967,672 87x136 → @960,347 240x537|@968,712 87x136 | 12 | 23 | 8 |
| fill-picker-custom | @959,307 240x353|@719,307 240x510 → @960,347 240x537|@720,347 240x510 | 11 | 26 | 40 |
| fill-picker-gradient-type-menu | @959,307 240x297|@719,307 240x510 → @960,347 240x297|@968,432 112x112 | 28 | 17 | 12 |
| fill-picker-gradient_linear | @959,307 240x297|@719,307 240x510 → @960,347 240x297 | 29 | 16 | 4 |
| fill-picker-image | @959,307 240x577 → @960,307 240x577 | 6 | 9 | 8 |
| fill-picker-libraries-tab | @959,307 240x203 → @960,347 240x203 | 5 | 4 | 1 |
| fill-picker-pattern | @959,347 240x522 → @960,347 240x522 | 6 | 14 | 1 |
| fill-picker-solid | @959,347 240x537 → @960,347 240x537 | 11 | 20 | 3 |
| fill-picker-swatch-set-menu | @959,307 240x537 → @960,347 240x537|@968,764 224x40 | 11 | 22 | 6 |
| fill-picker-video | @959,307 240x353 → @960,347 240x353 | 5 | 9 | 0 |
| fill-styles-variables | @960,531 240x203 → @960,538 240x203 | 5 | 4 | 1 |
| font-picker-filter-menu | @960,415 240x469|@960,488 240x229 → @960,415 240x469|@960,488 240x160 | 31 | 7 | 9 |
| font-picker | @960,415 240x469 → @960,415 240x469 | 28 | 1 | 2 |
| font-size-menu | @1312,455 96x437 → @1312,448 96x400 | 0 | 2 | 0 |
| font-weight-menu | @1208,575 167x313 → @1208,386 168x506 | 1 | 2 | 19 |
| frame-presets-menu | @1208,125 222x1887 → @1208,116 222x776 | 5 | 276 | 86 |
| gap-menu | @1244,473 156x64 → @1244,466 156x64 | 0 | 2 | 0 |
| height-sizing-menu | @1234,399 166x129 → @1232,392 168x129 | 0 | 2 | 0 |
| instance-header-swap-menu | @1160,117 240x441 → @1160,116 240x441 | 0 | 0 | 5 |
| instance-more-actions-menu | @1211,129 221x309 → @1211,120 221x325 | 0 | 20 | 11 |
| instance-swap-property-picker | @1160,237 240x441 → @1160,236 240x441 | 0 | 0 | 3 |
| instance-variant-dropdown | @1304,141 107x88 → @1304,140 107x88 | 1 | 0 | 3 |
| layout-guide-settings-grid | @960,756 240x128 → @960,756 240x128 | 3 | 1 | 1 |
| layout-guide-styles | @984,719 216x165 → @984,719 216x165 | 0 | 1 | 1 |
| layout-guide-type-menu | @960,756 240x128|@968,792 110x88 → @960,756 240x128|@968,758 110x88 | 3 | 2 | 4 |
| stroke-advanced-settings | @960,660 240x224 → @960,660 240x224 | 5 | 9 | 3 |
| stroke-individual-strokes-menu | @1315,539 117x159 → @1315,715 117x177 | 1 | 7 | 6 |
| stroke-position-menu | @1208,678 105x88 → @1208,677 105x88 | 1 | 0 | 3 |
| type-settings-details | @960,378 240x506 → @960,378 240x506 | 39 | 95 | 21 |
| type-settings-variable | @960,378 240x506 → @960,378 240x506 | 6 | 5 | 5 |
| type-settings | @960,378 240x506 → @960,378 240x506 | 11 | 22 | 5 |
| typography-styles | @984,427 216x165 → @984,586 216x165 | 0 | 2 | 1 |
| width-sizing-menu | @1138,399 166x129 → @1136,392 168x129 | 0 | 2 | 0 |

## Appendix C: menus and toolbar (live popup coordinates vs ours; text and state differences only, row geometry is not counted)

| Menu | live popup(s) → ours | missing text | extra text | enabled live / disabled ours | position-only text diffs |
|---|---|---|---|---|---|
| actions-panel | @456,478 529x354 → same | 17 | 372 | 0 | 0 |
| comment-tools-menu | @782,764 186x72 → same | 0 | 0 | 0 | 0 |
| context-component | @455,155 200x677 → @706,191 200x701 | 0 | 1 | 7 | 42 |
| context-empty-canvas | @1013,614 200x218 → same | 0 | 0 | 2 | 0 |
| context-frame | @617,35 200x749 → @707,143 200x749 | 0 | 0 | 8 | 2 |
| context-instance | @436,83 203x749 → @706,119 201x773 | 2 | 4 | 6 | 39 |
| context-layer-row | @185,155 200x677 → @177,239 200x653 | 5 | 1 | 5 | 52 |
| context-multi | @493,155 200x677 → @749,215 200x677 | 0 | 0 | 5 | 1 |
| context-page-row | @131,146 200x187 → @181,121 200x146 | 1 | 0 | 2 | 1 |
| context-shape | @358,179 200x653 → @749,239 200x653 | 0 | 0 | 5 | 1 |
| context-text | @387,179 200x653 → @749,239 200x653 | 0 | 0 | 5 | 1 |
| creation-tools-menu | @668,788 142x48 → same | 0 | 0 | 0 | 0 |
| main-arrange | @12,44 194x444|@210,246 220x533 → same | 0 | 0 | 1 | 0 |
| main-edit | @12,44 194x444|@210,150 190x581 → @12,44 194x444|@210,150 189x581 | 0 | 0 | 4 | 0 |
| main-file | @12,44 194x444|@210,126 198x324 → same | 0 | 0 | 7 | 0 |
| main-help | @12,44 194x444|@210,448 178x249 → same | 0 | 0 | 4 | 0 |
| main-menu | @12,44 194x444 → same | 0 | 0 | 1 | 0 |
| main-object | @12,44 194x444|@210,6 185x1050 → @12,44 194x444|@210,6 185x889 | 0 | 0 | 2 | 0 |
| main-plugins | @12,44 194x444|@210,311 181x122 → same | 0 | 0 | 2 | 0 |
| main-preferences | @12,44 194x444|@210,132 235x763 → same | 0 | 0 | 5 | 0 |
| main-text | @12,44 194x444|@210,222 199x379 → same | 0 | 0 | 1 | 0 |
| main-vector | @12,44 194x444|@210,270 198x160 → @12,44 194x444|@210,270 195x160 | 0 | 0 | 1 | 0 |
| main-view-panels | @12,44 194x444|@210,105 201x787 → @12,44 194x444|@210,108 201x787 | 0 | 0 | 11 | 0 |
| main-view | @12,44 194x444|@210,105 201x787 → @12,44 194x444|@210,108 201x787 | 0 | 0 | 11 | 0 |
| main-widgets | @12,44 194x444|@210,335 152x64 → same | 0 | 0 | 3 | 0 |
| move-tools-menu | @497,764 151x72 → same | 0 | 0 | 0 | 0 |
| region-tools-menu | @554,764 150x72 → same | 0 | 0 | 0 | 0 |
| shape-tools-menu | @611,668 196x168 → same | 0 | 0 | 0 | 0 |
| type-tools-menu | @725,788 142x48 → same | 0 | 0 | 1 | 0 |


## Fix groups (open items after the 2026-10-09 re-check)

Disjoint file sets so they can run in parallel.

1. **menus-commands** (no engine): S8 menu padding (`ds/components/Menu.tsx` / `.module.css`, role=menu popovers opened from `panels/design/Header.tsx`); S10 shortcut colours; the stubbed commands in `editor/commands.ts` that live enables (Duplicate, Save local copy, Comments toggles, View toggles, Find previous / next frame, Distribute / Pack, Copy / Paste properties, Convert to section, Set as thumbnail, More layout options, Join / Split / Simplify / Offset), context-menu rows (Layers row `Rename` ⌘R, instance `Select layer`, `Convert to section` placement, frame title right-click, main component), Actions palette Recents (`panels/ActionsPanel.tsx`, fixed 354 height), vector edit secondary toolbar (`canvas/BottomToolbar.tsx`), page rows / Assets grid / Find colours (left side). Engine only for the stubs that need real operations (join, split, simplify, offset, distribute, pack, convert to section: `engine/src/editor`, API in `src/renderer/src/engine`).
2. **design-panel-popovers** (no engine): everything under `panels/design/*` and `ds/` popover placement: nested-instance disabled fields, Align buttons on Frame / Group / Boolean, Ellipse radius / Line height / text W-H disabled, grid child captions, Selection colors list, fill picker y and Shader tab, gradient type menu, individual strokes placement, styles popovers y, font filter, font style / frame presets, effect / stroke field geometry, S3 / S5, vector edit Design panel (Alignment, Mirroring radios, Fill, Stroke).
3. **canvas-chrome** (engine C++): the remaining low items only: gap badge size, hovered grid column 2 px outline (`engine/src/render/Overlay.cpp`, `engine/src/tools/GridGestures.cpp`), a real vector path in the capture fixture and vector edit mode canvas (points, handles), which needs `CAPTURE_DOCUMENT` (`src/renderer/src/editor/fixtures.ts`) to get a vector network and a first page `Page 1`.
