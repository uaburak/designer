# Behaviour — Smart selection

Observed in Figma (web, Design mode) in the owner’s Drafts file "Untitled", page "Behaviour", on 2026-10-08, at a 1440×900 viewport (checked before each record).
State is recorded as `sel` (selected layer names), `panel` (first line of the Design panel), `focus` (the focused element; `(canvas-focus)` = Figma’s canvas keyboard input) and extra fields.
Keys marked "synthetic" were sent as JavaScript KeyboardEvents on the focused element. Clicks, drags and other keys were real input from the browser tool.

## Findings

- Selecting 3 equally spaced rectangles shows small center dots on each. The Layout section gets a **"Spacing" field (20)**. Hovering a gap shows pink gap bars and a value badge.
- **Dragging the pink handle in one gap changes every gap equally** (20 → 42: S2 to 602, S3 to 704). S1 stays where it is.

## Log

### 1. Drag the spacing handle — observed
- **Action:** S1,S2,S3 selected (60 wide, 20 apart at x=500/580/660, zoom 250%); hover the pink handle in the gap between S1 and S2, drag it 15 screenshot px (27 CSS px) to the right
- **Before:** sel=S1,S2,S3; focus=DIV(canvas-focus); panel=3 selected; pos=S1@500 S2@580 S3@660
- **After:** sel=S1,S2,S3; focus=DIV(canvas-focus); panel=3 selected
- **Notes:** positions after: S1@500 S2@602 S3@704
