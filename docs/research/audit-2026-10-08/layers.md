# Audit: left panel vs Figma 2026 (2026-10-08). Probe scripts/shots in this folder (shots/, img/).
Sources: help 360039831974 (left sidebar 2026, minimize-ui.gif light theme, 0.825 img px per CSS px), 360040449873 (select, multi-select GIF), Lock, Visibility, pages, Find and replace articles; UI3 forum.
LIVE FIGMA (wins over this audit): /Users/burak/Desktop/Burak/Code/DesignerV2/docs/research/figma/live/. Already captured facts (1440x900, left panel container x=57 width 240; rows relative to panel): "Pages" header title 16,14 11px/550; Find 24x24 at 180,8; Add new page at 208,8; page row "Page 1" text at 16,50 11px/550 (current page bold); Resize handle slider 0,78 240x8 between Pages and Layers; "Layers" title at 16,95; layer rows pitch 32 (texts at y 135,167,199,231), type icon 16x16 at x=28 (rect icon 16x10, ellipse 16x10), name at x=52 11px/400; component name colour rgb(209,168,255); selected row width 224 (x 65 → 8 inset), height 32 container; hover row actions "Toggle layer locking" 24x24 at 184 and "Toggle layer visibility" 24x24 at 208. Rail (56 wide): Main menu 32x32 at 12,8; File, Agents, Assets, Tools (56x56 buttons at y 56,112,168,224), Variables at y 296; labels 9px/450 under icons.
HIGH
1 Row pitch 32 with 24 inset highlight (ours ROW=24 Layers.tsx:35, ds/tokens.ts:264 layer-row 24, extra padding-top 8 Panels.module.css:66). VirtualList rowHeight 32; design-system §4.17.
2 Row geometry: take exact x positions from live (icon x=28, name x=52 at depth 0); indent per level (measure live with nested layers); chevron in gutter, hover-only; --drop-indent (LayerRow.tsx:85). Ours indent 16 (LayerRow.tsx:98), chevron 12, icon 28, gap 4 (LayerRow.module.css:46).
3 Left rail = Figma 2026 nav bar: Figma menu, sep, File, Agents, Assets (⊕), Tools (toolbox), sep, Variables (hexagon); bottom notifications (offline, missing fonts "A?", library updates book with blue dot) only when needed; labels under icons (View toggle). Ours Rail.tsx:31-46: book icon for Assets, toast-only Insert/Resources, gear Settings (Theme → main menu > Preferences), no Variables tab. Agents/Tools may be placeholders (personal use) but present; Variables tab opens local variables.
4 Pages header magnifier / ⌘F = Find panel (results current page/all pages, type filters, up/down nav, Replace/Replace all text, Esc/✕). Ours: page-name filter (Pages.tsx:81-105), edit.find placeholder (commands.ts:268).
5 BUG: clicking a page row blocks global shortcuts (keyboard.ts:24 treats [role=listbox] Pages list Pages.tsx:110 as overlay).
6 "Collapse layers" icon in Layers header (appears when something expanded; collapses all but selection branch) + ⌥L.
MEDIUM
7 Selected component/instance rows: blue selection; only name purple, icon pale purple; hover lock/eye purple. Ours purple fill (Layers.tsx:114-121, 245; LayerRow.module.css:26-27), children of selected frame tinted purple.
8 Icon colours: unselected child icons secondary; selected + top-level frames primary (LayerRow.module.css:46).
9 Chevrons hover-only (LayerRow.tsx:99-105; PanelSection).
10 Icons: Image, GIF/video, Slot, Mask (16.image, 16.mask, 16.slot, 16.play exist; layerIcon Layers.tsx:38-79; DETAIL_FIELDS layerTree.ts:47 needs fill type, isMask, slot).
11 Current page name bold 550 (LayerRow.module.css:66).
12 Pages area resizable via divider (live: 8px "Resize handle" slider) (Panels.module.css:60 max-height 40vh).
13 New page opens rename (Pages.tsx:20-22).
14 Drag across eye/lock toggles many (LayerRow.tsx:115-122).
15 Enter on row selects children (ours renames LayerRow.tsx:88-93); rename = ⌘R / dbl-click.
16 ⌘R with multiple → bulk "Rename layers" dialog (prefix/suffix/match/$nn) (commands.ts:363-371).
17 Minimize UI: selection while minimized shows right panel as floating card; shortcut ⌘⇧\ in 2026 help (ours ⇧\ commands.ts:276) — verify live.
18 Assets tab: "Search all libraries", sliders "Libraries and settings", "All libraries" cards drill-in (Assets.tsx:135-160).
19 Auto-layout children listed in flow order (first on top; Canvas stacking default) — ours always top layer first (layerTree.ts:259-275); verify live.
LOW
20 Page divider: "–" at start of an empty page; click on divider shouldn't open (LayerRow.tsx:154, Pages.tsx:117). 21 Duplicate page name "Copy of …" (engine Commands.cpp:1056). 22 remove page menu "Go to page" (Pages.tsx:47). 23 lock/eye positions per live. 24 no focus ring on rows. 25 "Highlight layers on hover" preference. 26 Layers header collapsible (verify). 27 drag auto-scroll near edges (Layers.tsx:146-178). 28 file-name menu: rename, version history, color profile, move (ours lacks Color profile, has "Back to files").
UNVERIFIED (check live): absolute child icon; dimming under hidden/locked parent; hover-expand while dragging; drop line / drop-into look; panel min/max width (ours 240–480); collapsed Pages header.
MATCHING: header 64, section headers 40, page rows 32/24 inset 8, 11px text, top-level frames bold, file name 13/550, ⇧/⌘ multi-select, ⌥-click subtree, reveal/scroll to selection, Tab while renaming, drag reorder/reparent line + inside ring, hidden rows dimmed + persistent closed eye, persistent lock, purple instance names, ⌥1/⌥2 (⌥3 Libraries missing).
