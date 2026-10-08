# Behaviour — Resize

Observed in Figma (web, Design mode) in the owner’s Drafts file "Untitled", page "Behaviour", on 2026-10-08, at a 1440×900 viewport (checked before each record).
State is recorded as `sel` (selected layer names), `panel` (first line of the Design panel), `focus` (the focused element; `(canvas-focus)` = Figma’s canvas keyboard input) and extra fields.
Keys marked "synthetic" were sent as JavaScript KeyboardEvents on the focused element. Clicks, drags and other keys were real input from the browser tool.

## Findings

- With **Lock aspect ratio** turned on (the panel toggle next to W/H), dragging the right edge resizes proportionally: 60×40 became 87×58.
- Modifier keys during resize could not be tested (no keys can be held mid-drag). The handle visuals are in the earlier screenshots.

## Log

### 1. Edge drag with Lock aspect ratio on — observed
- **Action:** X1 60×40 selected, Lock aspect ratio turned on in the panel; drag the right edge 30 screenshot px (54 CSS px = 27 units at 200%) to the right
- **Before:** sel=X1; focus=INPUT[Figma Design, 1 item selected](canvas-focus); panel=Rectangle
- **After:** sel=X1; focus=INPUT[Figma Design, 1 item selected](canvas-focus); panel=Rectangle
- **Notes:** size after=87x58 pos=500,141

### 2. ⇧ / ⌃ / ⌘ during resize (with and without Lock aspect ratio) — could not reproduce
- **Action:** hold modifiers while dragging a resize handle
- **Before:** —
- **After:** —
- **Notes:** Same reason. Only the plain edge drag with Lock aspect ratio on was observed.

### 3. Line endpoints and corner-radius handles on hover — observed (visual pass)
- **Action:** select a line / select a rectangle and hover
- **Before:** —
- **After:** —
- **Notes:** Covered visually in the earlier pass: img/canvas-arrow-line-selected.png (a line shows two square endpoint handles and no bounding box) and img/canvas-rect-selected-hover-radius-handles.png (four radius dots appear only after a click selection plus hover). No new behaviour was tested.
