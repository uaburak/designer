# Behaviour — Minimize UI

Observed in Figma (web, Design mode) in the owner’s Drafts file "Untitled", page "Behaviour", on 2026-10-08, at a 1440×900 viewport (checked before each record).
State is recorded as `sel` (selected layer names), `panel` (first line of the Design panel), `focus` (the focused element; `(canvas-focus)` = Figma’s canvas keyboard input) and extra fields.
Keys marked "synthetic" were sent as JavaScript KeyboardEvents on the focused element. Clicks, drags and other keys were real input from the browser tool.

## Findings

- **View › Minimize UI** is listed as ⇧⌘\. The synthetic shortcut did nothing, so the menu item was used.
- Minimized, the canvas becomes full width. The panels collapse into two floating pills: top-left [logo · file name · sidebar toggle] and top-right [avatar · zoom · play · Share]. The bottom toolbar stays.
- **Selecting a layer while minimized shows a floating Design panel** (a rounded card at the right that holds the header too) over the canvas. **Deselecting hides it again.** The canvas never resizes.

## Log

### 1. Minimize UI — observed
- **Action:** View › Minimize UI (⇧⌘\ per the menu; the synthetic shortcut did nothing, so the menu item was used)
- **Before:** panel=Page
- **After:** focus=INPUT[Figma Design](canvas-focus)
- **Notes:** Canvas becomes full width (canvas rect x=0, w=1440). Left and right panels are replaced by floating pills: top-left [logo · "Untitled" · sidebar toggle], top-right [avatar · 250% ▾ · play ▾ · Share]. The bottom toolbar stays. Image: behaviour/img/minimize-ui-nothing-selected.jpg

### 2. Selecting while minimized — observed
- **Action:** UI minimized; click S2 on canvas
- **Before:** focus=INPUT[Figma Design](canvas-focus)
- **After:** sel=S2; focus=INPUT[Figma Design, 1 item selected](canvas-focus); panel=Rectangle
- **Notes:** canvas rect after: 0,1440 — A floating Design panel (a rounded card that also holds the top-right header: avatar, play, Share, Design/Prototype tabs, zoom) appears over the right edge of the canvas. The canvas stays full width. Image: behaviour/img/minimize-ui-with-selection-floating-panel.jpg

### 3. Deselect while minimized — observed
- **Action:** UI minimized, S2 selected; press Esc
- **Before:** sel=S2; focus=INPUT[Figma Design, 1 item selected](canvas-focus); panel=Rectangle
- **After:** focus=INPUT[Figma Design](canvas-focus)
- **Notes:** right panel container after: none
