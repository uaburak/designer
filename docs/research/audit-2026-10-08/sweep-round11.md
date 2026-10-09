# Visual-parity sweep, round 11 (after the round 11 merges, against real Figma)

Measured on `main` at `ae98a76` on 2026-10-09, after the round 11 merges (r11-design-panel, r11-menus-left-toolbar, r11-canvas-chrome, r11-features). Read-only sweep: no repo edits except this file.

**Truth:** `docs/research/figma/live/` (DOM dumps in design/, popovers/, grid/, menus/, left/, toolbar/; canvas screenshots in img/). Live wins over everything; where live has no data a point is marked **unverified**.

## Method

- Server: `vite --config vite.web.config.ts --mode demo --port 5791` (the owner's dev app on 5173 untouched, stopped only my own server at the end); headless Chrome for Testing 1440 x 900 (DPR 1, SwiftShader; DPR 1.5 for the canvas shots), dark theme, one browser at a time, every run under 180 s and closed in `finally`; `memory_pressure` was 47-53 % free before each run. `?editor&doc=capture` for every state below; `?editor&doc=components` once as a smoke check (opens on "Sign in", Assets "4 components", no console error; `doc=capture` Assets "5 components", no console error).
- Design panel, resting: `live/tools/panel.mjs` for 30 selection states (page, frame, auto layout in four flavours, grid, grid child, AL child and parent, rectangle, ellipse, polygon, star, line, arrow, vector, boolean, group, text, section, image fill, component, set, variant, Button instance, Chip instance, Card instance, nested instance `I8:62;8:51`, mixed, two shapes). Interactive (14): Add stroke, then + Drop shadow, then + Add export settings, then Individual corners (the live captures are cumulative on one Rect), Individual padding, Constraints (collapsed, expanded), Add layout guide, text edit caret and last-4-characters selection (double click on canvas), vector edit and vertex selected, Auto layout settings of the grid, grid dimensions picker, grid row track selected by its canvas pill.
- Popovers: `live/tools/popover.mjs` (all 54 cases), plus layer / background blur Progressive, layout guide Columns (and Rows), stroke Style and Width profile lists, font picker search (the cases the tool has not got).
- Menus / toolbar: a driver that opens every main-menu submenu (File, Edit, View, View > Panels, Object, Text, Arrange, Vector, Plugins, Widgets, Preferences, Help), the nine context menus (right click on canvas layers, AL_vertical's title, Layers row, Pages row, empty canvas), the six bottom-toolbar dropdowns, the Actions palette (container `@456,478`), the bottom toolbar, the vector edit toolbar and its More menu.
- Left side: whole-window dump for Assets (3 depths), Tools, Variables (empty on `doc=capture`, collections on `doc=variables`); left panel region (shifted to live's `@57,65`) for Layers hover / selected + hover, Pages add, Find and its filter menu.
- Canvas: `setCamera` + `setSelection` + hover at DPR 1.5 for 27 states, composed beside `live/img/*` (forms and presence, not the last pixel); the grid row-track pill by real mouse (hover, click the grabber, click the chevron).
- Diff: a new filtered diff `diff2` (texts matched by string and nearest position, +-2 px, font, colour; controls matched by aria label, +-2 px on y / height, right edge or left edge for inputs because ours' inputs omit the prefix; DISABLED compared; live's duplicate lines, visually hidden accessibility copies of aria labels, wrapper `div` / `label` rows and `option` rows at negative y ignored; swatch lists ignored). Counts are lower than round 10's (stricter wrapper filtering): compare per state, not to the old numbers. Appendix A-C hold every state.

**Caveats**
- Many live captures were taken after earlier edits in the same live file: the Rect already carries a stroke and a Drop shadow in `rectangle-with-export` / `individual-corners` (I replayed that order), `autolayout-individual-padding` has the panel 4 px higher (91 DIFF lines are that shift), `frame-child-constraints` was taken after the Constraints toggle (34), `frame-with-layout-guide` has a Columns guide where ours draws the default Grid guide (76). Fixture, not UI.
- Fixture values that differ by construction: component fills (`FFB200 / E6E6E6 / 99E5E5` live vs `FFC700 / E5F4FF / BDE3FF / 80CAFF` ours), the live file's `Page 1` with a component (first Assets card "6 components" vs ours "5"), `Hello Figma text` vs `Hello, Capture`, the live Variables collection `Tokens` (Light / Dark, `label`, `isOn`, `bg`, `md`) which no fixture has (`doc=variables` is `Primitives` / `Theme`), the Page panel's `Apply variable mode` (needs a collection; verified in r8).
- The Electron app was not run in this sweep (machine rules). Round 11 verified the file commands there (`docs/editor.md` "Electron app (R29)", 9bcd71d); I rely on that.
- The font picker's list is empty but for `Inter` in the headless web build (no font index): the desktop path lists installed + Google families (round 5), unverified here.
- The live `behaviour/*.md` notes are about interactions; not re-measured.

## Summary

- **Round 10's list is closed almost entirely.** Of the 30 items R1-R30 of its "Re-check on ba7ed56": **21 CLOSED**, **4 PARTLY** (R6 Type settings: `No truncation`; R10 list menus: the child Width menu; R17 glyph metrics: +-1 px left; R18 Flatten: main component left), **5 unchanged or unverifiable** (R15 font list needs the desktop build, R21 Shape builder / Variable width, R28, R29 covered by round 11's own Electron run, R30 wontfix); no regression of a closed item found.
- Resting Design panel: **identical** to live (+-2 px, no extra / missing control except dumper naming) in all 30 states; the three real differences of round 10 (instance Flow row, mixed W / H, text edit header) are closed. Interactive states: identical (the diff counts are the live file's earlier edits).
- 54 popover cases + 3 extra + the Create slot property form + both shader browsers: **all open at live's place and size to +-1 px** except the child Width menu (4 px high), the Grid Auto layout settings popover (5 px high), the Background blur (live captured Progressive: the same size 240 x 156 when switched), and the font picker's list (web build).
- Menus: every item present with live's wording, every size within +-1 px; the Object submenu now 186 x 1050 as live (not clamped); View 3 px low.
- Canvas: the component set's `3 Variants` pill with `+`, `❖ Chip` title and gap boxes, the text hover baseline underline, no title over a selected instance and the small centre dots are in and match live's shots.
- **What is still different, in order of size:** (1) **Grid gap hover has no pink gap bars** (N1, med: live `grid-selected-hover-gap-1440.jpg`; the engine skips gaps for grids), (2) **the grid pill opens a track-size popover** where live selects the track and the chevron opens a 156 x 72 menu (N2, low-med), (3) the **right panel's tab row** sits 4 px lower than live and the content 1 px higher (N3, low, systematic: the cause of the recurring "1 px higher" popovers), (4) small popover / menu details (N4-N14), (5) features live has that we do not build (Motion mode, Draw tools, AI, plugins).

## Round 10 re-check (R1-R30)

| # | Item | Now | Evidence (live -> ours) |
|---|---|---|---|
| R1 | Instance of a non-auto-layout component (Chip instance): Flow row | **CLOSED** | `variant-instance`: `Dimensions` at live's y, no `Use auto layout`, no Flow; only the fixture fill differs |
| R2 | Instance of an auto layout component: Flow radios, Wrap | **CLOSED** | `instance`, `nested-instance`, `nested-instance-parent`: the four radios and `Wrap` DISABLED, Horizontal checked, as `instance.txt` (16,430 / 208,430) |
| R3 | Mixed selection with a frame: W / H | **CLOSED** | `mixed-multi`: `Width` / `Height` `=Mixed` DISABLED at (40,354) / (136,354), as live |
| R4 | Text edit header | **CLOSED** | `text-editing-caret` / `-partial`: Create link 152, Apply variable 180, Create component 208, no More actions; live's aria label is `text-edit-hyperlink`, its visible text `Create link` |
| R5 | Auto layout settings: `Between` dim, Inside stroke | **CLOSED** | `Included` (121,178) white and `Between` (121,274) #ffffff66 in both; popover 240 x 345 at (960,480) vs (960,481) |
| R6 | Type settings | **PARTLY** | boxes, `Underline details`, Details rows (every row at live's y, no 17 px shift) closed; `No truncation`: live DISABLED, ours enabled; unsupported-feature names #ffffff66 / #ffffffb2 differ in 4 rows (font dependent: Hanging punctuation, r curves into round neighbors, r with curved tail, Fraction numerators) |
| R7 | Layout guide Columns settings | **CLOSED** | 240 x 256 at (960,628) both, fields as live, `Width` disabled shows `Auto` |
| R8 | Fill picker Gradient stop row | **CLOSED** | stop colour 58 x 24 at 93, opacity 32 x 24 at 152, Delete at 208, `Paint type` 96 x 32 at (16,89); only the default stops differ (N9) |
| R9 | Fill picker details (%, Libraries tab, Select source, Stroke `Solid` x) | **CLOSED** | no `%` colour diff, Libraries tab 240 x 203, Stroke settings `Solid` at 129 |
| R10 | Panel-anchored list menus (S11) | **PARTLY** | width (1138,399) 166 x 129, height (1234,399) 166 x 129, gap (1244,473) 156 x 64: identical; the child Width menu (1142,375) vs live (1142,379): 4 px high (N4) |
| R11 | Typography styles popover y | **CLOSED** | (984,427) 216 x 165 both |
| R12 | Font size list | **CLOSED** | 96 x 437 at (1312,454) vs (1312,455) |
| R13 | Create slot property form | **CLOSED** | 304 x 626 at (896,120) vs (896,121): Name, Description editor + toolbar, Settings, Preferred instances, `Create property`; the rich-text toggles are labelled `Bold` ... (live `Bold   ⌘B`) |
| R14 | Shader fills / effects | **CLOSED** except AI | both browsers 240 x 510 at (719,307) / (959,374), every row at live's y (rows `Created by you` 95 ... first tile row 389), tiles enabled and drawn (engine `Custom` program); `Create with agents` stays disabled (AI) |
| R15 | Font picker | **UNVERIFIED on desktop** | web build: `Inter` only; the status line `1,816 results found` and the list around the current family (`Ingrid Darling`, ... `Inter` at y=265) need the font index |
| R16 | Object submenu | **CLOSED** | 186 x 1050 at (210,6) vs 185 x 1050 |
| R17 | Key glyph metrics | **PARTLY** | Edit 190 = 190, Vector 198 = 198, Preferences 235 = 235; File 199 vs 198, View 202 vs 201, instance menu 204 vs 203, Shape tools 197 vs 196, Creation tools 143 vs 142: +-1 px (N8) |
| R18 | Flatten | **PARTLY** | enabled on an instance and on shapes as live; **disabled on a main component** where live is enabled (N7) |
| R19 | Toolbar dropdown lit row (M7) | **CLOSED** | Move, Region, Shape, Creation, Comment menus 0 diffs (`F`, `R`, `P`, `C` keys lit as live) |
| R20 | Actions palette | **CLOSED** except AI | container 529 x 354 at (456,478), search 431 x 32, tabs, `Recents` header at 86, both status lines at live's place; live's AI rows (Translate to..., Image editing, Design tools, Riffing and writing) stay out |
| R21 | Vector edit More menu | **UNCHANGED** (low, hard) | 190 x 48 at (870,736) vs 189 at (869,736); `Shape builder` M and `Variable width` ⇧W disabled |
| R22 | Variables empty state | **CLOSED** | title `Variables` (322,16), `No variables created in this file`, copy + `Learn more →`, `Create` / `Import`, left panel `Collections` only; `Collections` is #ffffff (live #ffffffb2), `→` 4 px right (N10) |
| R23 | Variables selected highlight, settings glyph, Tools `Filter by price and type` | **CLOSED** | selected collection row highlighted, no glyph per row; `Source` / `Category` still disabled (N11) |
| R24 | Component set selected | **CLOSED** | purple `3 Variants` pill with the `+` under it, `❖ Chip` title, pink gap boxes (`canvas-component-set-selected`) |
| R25 | Hovered text baseline underline | **CLOSED** | 2 px blue line under the baseline, kept when selected |
| R26 | Selected top-level instance title | **CLOSED** | no title over the selected Button instance; main component keeps `❖ Button` + `</>` |
| R27 | Selection centre marks | **CLOSED** | tiny light dots in a group (`canvas-group-selected`) |
| R28 | Gradient type / swatch set menus, unselected frame hover, arrow blue line at DPR 2 | **UNVERIFIED** | no live capture / needs a GPU shot |
| R29 | Figma menu items disabled on `?editor` | **UNVERIFIED here** | round 11's own Electron run (9bcd71d) covers them |
| R30 | MCP / AI items | **WONTFIX** | unchanged |

## New and remaining differences

| # | Severity | Difference |
|---|---|---|
| N1 | **med** | **Grid gap hover**: with the grid frame selected, live draws pink gap bars between the tracks (every column gap in every row: `img/grid-selected-hover-gap-1440.jpg`; README "Gaps: hovering a gap shows pink gap bars"); ours draws nothing when the pointer is over a gap (verified headless at gap 1 of `AL_grid`). `engine/src/tools/Gestures.cpp` (~l.846) builds gap bands only `&& !grid`; the grid's column / row gaps have no bars, no badge and no drag. Round 10 listed "gap hover" closed for auto layout only. |
| N2 | low-med | **Grid track pill**: live: clicking the pill only **selects the track** (empty cells light blue, dashed frame, Grid panel), the chevron then opens a **156 x 72 menu** `Fixed height (84)` / `Hug contents` / `✓ Fill container (1fr)` at (419,549) (`grid/row-track-menu.txt`, `img/canvas-grid-row-track-menu.jpg`). Ours: the click selects the track and **also opens a 200 x 40 "Row size" popover** (`1fr` input + `Fill conta…` dropdown, text cut) at (541,527); the chevron opens the same popover, no menu. The cells light blue and the dashed outline match. The 156 x 72 list exists only in the Grid panel. Files: `engine/src/render/Overlay.cpp` pills, `panels/design/Grid.tsx`. |
| N3 | low (systematic) | **Right panel top**: live's tab row (`Design` 53 x 24 tab at (1208,48), `Prototype` button at (1265,48), zoom button 62 x 24 at (1370,48) with its text 12 px in) sits 4 px higher than ours (tablist at (1208,52), zoom 57 x 24 at (1375,52), text 8 px in), and live's panel body starts at y=81 where ours starts at 80. Net effect: **every Design popover opens 1 px higher** than live (blend, boolean, constraint, instance, component, slot, export format, frame presets ... all `y-1`; the `@960,531 -> 530` family). Also live's avatar button is a 50 x 24 pill (`Multiplayer tools` at (1212,12)), ours a 48 x 32 button at (1212,8). Files: the right panel shell (`panels/Panels.module.css`, properties header). |
| N4 | low | Popover places: the **child Width menu** opens at (1142,375), live (1142,379); the **Grid Auto layout settings popover** at (960,480), live (960,485) (the Auto layout one is 1 px: N3). |
| N5 | low | **Stroke settings, Width profile**: live draws a 62 x 4 profile image (`img [Uniform]` at (105,130)) in the 96 x 24 button; ours writes the text `Uniform` at (104,125). |
| N6 | **CLOSED (misread, re-check round 12)** | **Type settings** `No truncation`: live's `=DISABLED` is the radio input's **value** (`TextTruncation.DISABLED`; its sibling reads `=ENDING`), not a disabled state. Ours has `No truncation` CHECKED and `Truncation enabled` enabled, as live. Only the font-dependent feature colours of R6 remain. |
| N7 | low | **Context menus**: (a) `Flatten` on a main component: live enabled, ours disabled; (b) a right click **over an instance's nested layer** (the Icon or Label of `Button instance`): ours opens a 200 x 677 menu for the nested layer (`Select layer`, `Bring to front`, `Group selection`, `Reset instance`... disabled, no `Detach instance`) while live's instance menu (203 x 749) has `Select layer` **and** every instance command enabled; where live's click landed is **unverified**; (c) in headless runs a freshly opened menu may open its `Move to page` submenu (200 x 40 at (1202,424)) because the pointer sits on that row: pointer artefact, as in round 10. |
| N8 | low | **Menu geometry** (all +-1 or the window clamp): File 199 vs 198 wide, View 202 vs 201 and **3 px lower** (210,108) vs (210,105) with its Panels submenu (416,557) vs (416,554) (live's bottom margin is 8 px, ours 5), Shape tools 197 vs 196, Creation tools 143 vs 142, Vector edit More 190 x 48 at (870,736) vs 189 at (869,736), **vector edit toolbar 531 x 40 at (454,792) vs 529 x 40 at (455,792)**. |
| N9 | low | **Fill picker**: Gradient default stops: live shows `D9D9D9` 100 % -> `737373` 100 % for a `D9D9D9` solid, ours `D9D9D9` 100 % -> `D9D9D9` 0 % (live's value may come from earlier edits in that file: **unverified**); Image tab: `Make an image` at (80,.) #ffffff66 (disabled, AI) vs live (90,.) white. |
| N10 | low | **Variables**: `Collections` heading #ffffff vs live #ffffffb2; `Learn more →` arrow 4 px right (991 vs 987). The mode columns (`Light` / `Dark`) cannot be compared (no fixture with `Tokens`). |
| N11 | low | **Tools** panel: `Source` and `Category` filters are #ffffff66 (disabled) in ours, enabled in live (the panel's content is intentionally "No tools"). |
| N12 | low | Live shows `Motion (Beta)` as an enabled mode in the Toolbelt (`motion_beta_special_tooltip` input at (461,10)); ours' `Motion` radio is DISABLED. |
| N13 | low | Layers panel: row glyph boxes are 16 x 16 in ours, live's svgs measure 16 x 10 / 10 x 10 (an svg's own box, not visible); the `Layers` header text sits at y=123 in the hover capture (live 127) and at live's y in the Pages-add capture: it follows the `Collapse layers` button, which ours shows only when a row is expanded (live's hover capture had expanded rows): state-dependent, **unverified** for a collapsed list. |
| N14 | low | Live-only dumper naming: `[text-edit-hyperlink]`, `[mask-selection]`, `[align-left]` (inputs in live, radios / buttons in ours), `[Toggle layer locking]` (inputs). Not UI. |

## Design panel, by state

Appendix A lists every state. All 30 resting states and the 12 interactive ones are identical within +-2 px apart from:

- **[CLOSED]** instance / variant instance / nested instance Flow rows, mixed W / H, text edit header (see R1-R4).
- **[CLOSED, fixture]** `autolayout-individual-padding` (91, every row 4 px lower in live), `frame-child-constraints` (34, taken after the toggle), `frame-with-layout-guide` (76, Columns guide), `component-set` (live lists two selection colours, ours three), `rectangle-individual-corners` (live had no export row yet).
- **[WONTFIX]** page with nothing selected: `MCP` section, `Figma MCP in Claude`, `Set up agents for Figma MCP`; `Apply variable mode` needs a collection.
- `component` / `component-set` / `variant`: the name is an input in ours too (`=Button`), its text is not a text node (dumper).
- **Grid panel** (track selected): identical (`Grid`, Columns, Rows, `Fill` + value + sizing chevron, `Remove`); the pill we clicked selected row 1 where live had row 2 (state).

## Popovers and menus opened from the Design panel

Appendix B has every case. Placement and size, live -> ours (only the entries that differ beyond the N3 1 px):

| Popover | Live | Ours | Status |
|---|---|---|---|
| Child Width menu | (1142,379) 162 x 129 | (1142,375) | **[OPEN]** low (N4) |
| Grid Auto layout settings | (960,485) 240 x 249 | (960,480) | **[OPEN]** low (N4) |
| Stroke settings | width profile = image | text `Uniform` | **[OPEN]** low (N5) |
| Type settings | `No truncation` DISABLED | enabled | **[OPEN]** low (N6) |
| Fill picker Gradient | stops `D9D9D9` -> `737373` | `D9D9D9` -> `D9D9D9` 0 % | **UNVERIFIED** (N9) |
| Background blur | captured in Progressive (240 x 156) | Uniform 124 high by default, Progressive 156 identical | **[CLOSED]** (state) |
| Effects / Fill Shader browsers | `Create with agents` enabled | disabled | AI, stays |
| Create slot property | 304 x 626 | 304 x 626 | **[CLOSED]** |
| Layout guide Columns | 240 x 256 | 240 x 256 | **[CLOSED]** |
| Gradient type menu, swatch set menu | no menu in live's captures | 112 x 112 at (967,392), 224 x 40 at (967,724) | **UNVERIFIED** |
| Font picker | 1,816 Google families | `Inter` (web build) | desktop **UNVERIFIED** |
| Everything else (fill picker tabs, blend, boolean, constraints, sizing / gap menus, frame presets, strokes, effects, export, layout guides, instance, swap, variant, component configuration, create property, font size / style / filter, Text styles) | | identical +-1 | **[CLOSED]** |

## Menus

Appendix C has every dump. All main-menu submenus and all nine context menus list every item with live's wording; the only differences are the colours of rows that are disabled in ours and enabled in live (intended exclusions: `Send to Figma Make`, `Find similar designs`, `Add motion`, `Rename layers`, `Open in desktop app`, `Manage plugins…`, `Manage widgets…`, `Select all widgets`, `Color profile…`, `Keyboard layout…`, `Accessibility settings…`, `Permissions and helpers…`, `Open font settings`, `Account settings`, `Log out`, `Text on path`, `Copy link to page`; states: `Outline stroke`, `Zoom to selection`) and N7 / N8. The File items enabled on `?editor` are listed disabled (no file source) as before: `New Design`, `Duplicate`, `Save local copy…`, `Save to version history…`, `Show version history`, `Create branch…`; the Electron run covers them (R29).

## Left side

- **[CLOSED]** rail, Assets (card 74 x ..., tiles at (73,125) / (185,125) / (73,257), names, `Press Enter or Space to insert.`, Resize handle), Pages add and inline rename (rows at 44 / 76 / 108, handle 142, Layers at 145), Find (`Find…` field, Settings, Close, `20 results`, scope button, rows, filter menu), Layers rows (hover bg #383838, lock / eye at 184 / 208, selected #394360).
- **[CLOSED]** Variables empty state and table structure (Collections, Groups, `All`, `Create variable`, Name / Value columns, mode columns follow the fixture).
- **[WONTFIX]** Tools promo, `Suggested`, plugin rows, `More actions for ...` (ours: "No tools", plugins and shaders aren't part of this app); N11.
- N3 (tab row), N13.

## Canvas (screenshots vs `live/img/canvas-*`)

- **[CLOSED]** rect (handles, `120 × 90` pill, 4 radius rings on hover), ellipse arc handle, star (3), polygon (2), group / multi-selection (small centre dots, one box), section label, hover outline, auto layout selected (title, gap badge `10`, padding badge `16`), main component (purple title, `</>`, pill), **instance selected (no title)**, **component set (`3 Variants` pill, `+`, `❖ Chip`, pink gap boxes)**, **text hover baseline underline**, text edit box and partial selection, grid frame (cells, mid-edge bars), column / row pill hover (`||| 1fr ▾` and `☰ 1fr ▾`), selected track (light blue cells, dashed frame), vector edit (vertices, secondary toolbar).
- **[OPEN]** *(med)* **grid gap hover** (N1). *(low-med)* **track pill popover** (N2).
- **[UNVERIFIED]** arrow / line blue selection line over the black stroke (needs a GPU shot at DPR 2), unselected frame hover, layout guide Columns on canvas (live's capture used Columns, ours' default guide is a Grid), the unselected instance's title (live has no capture).
- **[WONTFIX]** the AI sparkle button next to a selected object.

## Anything live shows that ours lacks entirely

1. **Grid gap bars** on hover (N1), and the gap-drag that goes with them (**unverified**: not captured live).
2. **The 156 x 72 canvas track-size menu** (N2) as a menu.
3. **Motion (Beta)** mode of the Toolbelt (N12).
4. **Figma Draw**: Shape builder, Variable width, the Draw toolbelt's own toolbar and panel.
5. **AI**: Make an image, Remove background, Boost resolution, Edit image with prompt, Rename layers, Replace content, Add interactions, Shorten..., Visual search, `Create with agents`, Make, MCP section / `Figma MCP in Claude`: intended exclusions.
6. **Plugins, widgets, Community**: Tools `Suggested` list, `More actions for ...`, `Manage plugins…` / `Manage widgets…`, `Open in desktop app`: intended exclusions.
7. **Slot layers** (wrapping a frame into a slot; `component-with-slot`, `instance-with-slot`): the live capture never created one; ours has the property form, a layer is **unverified**.
8. Live's **shader tile thumbnails and parameters** (no live data: unverified).

## Re-check on main df3055f (round 12 start, 2026-10-09)

`git diff ae98a76 HEAD` is this file alone: no code changed since the sweep, so every number above stands. Re-measured headless (vite demo on 5801, Chrome 1440 x 900 dark, `live/tools/popover.mjs` cases + a DOM probe) and by code reading:

- **OPEN, re-measured:** N3 (tabs at y=52 vs live 48, Zoom 57 x 24 at (1375,52) vs live 62 x 24 at (1370,48); popovers one px high: blend (1315,471) vs 472, auto layout settings (960,480) vs 481), N4 (child Width menu (1142,375) vs (1142,379)), N5 (`Width profile` is a text Select `Uniform`, live a 62 x 4 image at (105,130)), N11 (`LeftPanel.tsx` l.104-105 `disabled`), N12 (`Motion` radio `aria-disabled=true`), N9 (gradient stops `D9D9D9` / `D9D9D9` 0 %, live `D9D9D9` / `737373`: unverified origin).
- **OPEN, by code:** N1 (`Gestures.cpp` ~l.846 `&& !grid`), N2 (`GridGestures.cpp` l.194 `ev.edit` -> `gridTrackEditor` popover in `Grid.tsx`), N7a (`VectorCommands.cpp` `flattenable()` has no COMPONENT), N8, N10, N14, R6 colours, R15, R17, R21.
- **CLOSED:** N6 (misread of a radio value), plus everything the table marks CLOSED.
- **Shape builder (M) and Variable width (shift+W)** are in scope now (owner): both are listed disabled in `BottomToolbar.tsx` l.167-168; the engine keeps `variableWidthPoints` (schema 447) but never draws them. Sources (help.figma.com, live has only the menu rows): *Create custom shapes with the shape builder tool* (31616004109847): select layers, Enter, pick Shape builder; hovering shows the regions where the shapes overlap, click-drag across regions merges them into one layer, a single click extracts a region to its own layer, Option/Alt-click removes a region; destructive (unlike boolean operations), undo restores. *Apply and adjust stroke properties* (360049283914) and *Edit vector layers*: Variable width tool changes thickness at any point of the path; hover the stroke, click to add width points, drag to adjust; not on dynamic or dashed strokes nor on branching vector networks (Split vector first); Width profile presets are the alternative. Anything beyond that (Shift behaviour, fills / names of results, handle looks, profile preset list) is **unverified**.

## Fix groups (open items)

Disjoint file sets, to run in parallel. Live wins; where live has no data (help.figma.com), mark the point **unverified** in the docs.

1. **canvas-grid** (engine C++, medium): N1 (gap bands and bars for a grid: column and row gaps, pink bars as the auto layout's, the value badge; the drag that edits `gridColumnGap` / `gridRowGap` as live: **unverified**), N2 (the pill click only selects; the chevron opens the 156 x 72 menu `Fixed height (n)` / `Hug contents` / `Fill container (1fr)`). Files: `engine/src/tools/Gestures.cpp`, `engine/src/render/Overlay.cpp`, `engine/tests`, `src/renderer/src/editor/panels/design/Grid.tsx`. Shots: `live/img/grid-selected-hover-gap-1440.jpg`, `canvas-grid-row-track-menu.jpg`.
2. **panel-chrome** (no engine, low): N3 (tab row to y=48, body to y=81, zoom button 62 x 24 with 12 px padding, avatar pill 50 x 24), N4 (child Width menu y, grid settings popover y), N5, N6, N10, N11, N14.
3. **menus** (no engine, low): N7 (Flatten on a main component), N8 (window clamp margin 8 px, widths).
4. **optional**: N9 (gradient default only when live data shows it is Figma's default), N12 (Motion), R21 / Draw tools stay.

## Appendix A: Design panel, live vs ours (filtered; swatch lists and wrapper rows ignored)

Resting states (`missing` / `diff` / `extra`): arrow 0/0/0, autolayout-child 0/0/2, autolayout-grid 1/1/3, autolayout-horizontal 0/0/4, autolayout-parent-fixed 0/0/4, autolayout-vertical 0/0/4, autolayout-wrap 0/0/4, boolean 0/0/0, component-set 3/5/10, component 2/0/5, ellipse 0/0/0, frame 0/0/1, grid-child 6/0/10, group 0/0/1, image-fill 0/1/1, instance 3/0/4, line 0/0/0, mixed-multi 7/1/4, multi-two-shapes 0/0/0, nested-instance-parent 3/0/5, nested-instance 5/0/2, page-nothing-selected 3/0/0, polygon 0/0/0, rectangle 0/0/0, section 0/0/0, star 0/0/0, text 8/1/5, variant-instance 2/0/1, variant 2/0/4, vector 0/0/0. The `extra` entries are ours' labelled controls the live dump does not label (`Width sizing`, `Alignment` radiogroup, `Layout` radiogroup, `Color opacity` ...); the `missing` ones are live's input-in-listbox rows (`Font size: 24 px`), hidden labels and the fixture fills.

Interactive states: rectangle-with-stroke 0/0/0, rectangle-with-effect 0/0/1, rectangle-with-export 0/0/1, rectangle-individual-corners 0/1/11, autolayout-individual-padding 0/91/9 (live panel 4 px high), frame-child-constraints 5/34/3, frame-child-constraints-expanded 2/0/7, frame-with-layout-guide 0/76/6, text-editing-caret 8/1/5, text-editing-partial 8/1/5, vector-edit-mode 3/0/1, vector-edit-point-selected 3/0/1 (X / Y enabled as live), grid-autolayout-settings (block y 485 vs 480), grid-dimensions-picker 0/0/2 (210 x 204 at (1204,427) both), row-track-selected-panel (identical but row 1 vs 2 selected).

## Appendix B: popovers (live -> ours, place and size; missing / diff / extra)

fill-picker-solid @959,347 240x537 both (13/16/8: the swatch rows) · -pattern @959,347 240x522 (6/0/6) · -image @959,307 240x577 (5/1/10) · -video @959,307 240x353 (4/0/3) · -custom @959,307 240x353 + @719,307 240x510 (4/1/4) · -gradient_linear @959,307 240x297 + @719,307 (7/1/11) · -gradient-type-menu (EXTRA @967,392 112x112) · -color-format-menu @967,672 87x136 (13/16/8) · -swatch-set-menu (EXTRA @967,724 224x40) · -libraries-tab @959,307 240x203 (2/0/2) · fill-styles-variables @960,531 -> 530 (2/0/2) · blend-mode-menu @1315,472 118x555 -> (1315,471) 117 · boolean-operations-menu @1253,129 -> 128 · constraint-horizontal / -vertical -> y-1, 125 / 135 wide · autolayout-advanced-settings @960,481 -> 480 240x345 · width / height / gap menus identical · autolayout-child-width-menu @1142,379 -> 375 · frame-presets-menu @1208,125 -> 124 222x1887 · stroke-advanced-settings @960,660 240x224 identical (7/0/3: hidden labels, Uniform image) · stroke-individual / -position menus -> y-1 · effect-settings-drop-shadow / inner-shadow / layer-blur / texture / glass / noise identical · effect-settings-background-blur (Progressive 240x156; ours Progressive 156 identical, Uniform 124) · effect-type-menu @967,449 147x207 identical · effect-styles @984,719 216x165 identical · export-advanced-settings @960,700 240x184 identical · export-format-menu @1290,764 -> 765 · layout-guide-settings-grid @960,756 240x128, layout-guide-type-menu @968,792 110x88, layout-guide-settings-columns @960,628 240x256, layout-guide-styles @984,719: identical · font-picker @960,415 240x469 and filter menu @960,488 240x229: identical (list: web build) · font-size-menu @1312,455 -> 454 96x437 · font-weight-menu @1208,575 -> 574 · type-settings @960,378 240x506 (12/1/11) · type-settings-details (41/4/41: hidden labels and radiogroups; rows at live's y) · type-settings-variable (1/0/3) · typography-styles @984,427 216x165 identical · instance-more-actions @1211,129 -> 128 · instance-header-swap @1160,117 -> 116 · instance-swap-property-picker @1160,237 -> 236 · instance-variant-dropdown @1304,141 -> 140 · component-create-property-menu @1277,161 -> (1276,160) · component-configuration @880,81 -> 80 320x317 · component-create-slot-property @896,121 -> 120 304x626 · effects-add-shader-effects @959,374 240x510 identical.

## Appendix C: menus and toolbar (live popup coordinates vs ours; context menus open where they are clicked, so only their size is comparable)

Context: component 200x677 / 200x677, empty canvas 200x218 / 200x218, frame (AL_vertical's title) 200x749 / 200x749, instance 203x749 / 204x749 (click on a bare corner: no nested layer), layer row 200x677 / 200x677, multi 200x677 / 200x677, page row 200x187 / 200x187, shape 200x653 / 200x653, text 200x653 / 200x653. Main: Figma menu 194x444 at (12,44) identical; File 198 -> 199 x 324; Edit 190 x 581; View 201 -> 202 x 787 at (210,105) -> (210,108); View > Panels 174 x 136 at (416,554) -> (416,557); Object 185 -> 186 x 1050 at (210,6); Text 199 x 379; Arrange 220 x 533; Vector 198 x 160; Plugins 181 x 122; Widgets 152 x 64; Preferences 235 x 763; Help 178 x 249: all at live's place except View. Toolbar: bottom toolbar 529 x 48 at (456,840); Move tools 151 x 72 at (497,764); Region 150 x 72 at (554,764); Shape 196 -> 197 x 168 at (611,668); Creation 142 -> 143 x 48 at (668,788); Type 142 x 48 at (725,788); Comment 186 x 72 at (782,764); Actions 529 x 354 at (456,478); vector edit toolbar 529 -> 531 x 40 at (455 -> 454,792); vector More 189 -> 190 x 48 at (869 -> 870,736).
