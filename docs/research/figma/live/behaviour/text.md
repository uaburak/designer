# Behaviour — Text editing

Observed in Figma (web, Design mode) in the owner’s Drafts file "Untitled", page "Behaviour", on 2026-10-08, at a 1440×900 viewport (checked before each record).
State is recorded as `sel` (selected layer names), `panel` (first line of the Design panel), `focus` (the focused element; `(canvas-focus)` = Figma’s canvas keyboard input) and extra fields.
Keys marked "synthetic" were sent as JavaScript KeyboardEvents on the focused element. Clicks, drags and other keys were real input from the browser tool.

## Findings

- Double-clicking an unselected text layer enters edit mode in one step and selects the word under the cursor (blue highlight). Keyboard focus moves from the canvas focus input to a DIV (the hidden text editor).
- The first Esc leaves edit mode and keeps the text layer selected (handles shown). The second Esc deselects.

## Log

### 1. Double-click text — observed
- **Action:** double-click the Txt layer on canvas (nothing selected before)
- **Before:** focus=INPUT[Figma Design](canvas-focus); panel=Page
- **After:** sel=Txt; focus=DIV(canvas-focus); panel=Text

### 2. Esc while text editing — observed
- **Action:** press Esc while editing text
- **Before:** sel=Txt; focus=DIV(canvas-focus); panel=Text
- **After:** sel=Txt; focus=INPUT[Figma Design, 1 item selected](canvas-focus); panel=Text

### 3. Esc again after leaving text edit — observed
- **Action:** press Esc a second time
- **Before:** sel=Txt; focus=INPUT[Figma Design, 1 item selected](canvas-focus); panel=Text
- **After:** focus=INPUT[Figma Design](canvas-focus); panel=Page
