# Behaviour — Canvas: frame titles, clicks, marquee, drag-to-nest

Observed in Figma (web, Design mode) in the owner’s Drafts file "Untitled", page "Behaviour", on 2026-10-08, at a 1440×900 viewport (checked before each record).
State is recorded as `sel` (selected layer names), `panel` (first line of the Design panel), `focus` (the focused element; `(canvas-focus)` = Figma’s canvas keyboard input) and extra fields.
Keys marked "synthetic" were sent as JavaScript KeyboardEvents on the focused element. Clicks, drags and other keys were real input from the browser tool.

## Findings

- **Frame title:**
  * **A click** on a top-level frame’s name label selects the frame.
  * **A press-drag** on the label moves the frame. A 54,18 CSS px drag at 100% landed it at 50,20 (it snapped).
  * **A double-click** opens an inline rename input over the label with the name fully selected. Esc cancels.
  * Hovering the label showed no visible outline in the screenshot.
- **Clicking a frame’s empty background:**
  * **A top-level frame with children** behaves like empty canvas: nothing is selected.
  * **A nested frame** gets selected.
- **Marquee:**
  * **Pressing on a top-level frame’s empty background and dragging starts a marquee, not a move.** It selected the direct child it touched (Inner), and the frame stayed put.
  * **A marquee from outside, partly over a top-level frame,** selects the frame’s children that it covers (A), not the frame.
- **Drag-to-nest:** when a layer bigger than the target frame (500×350 onto 150×150) is dropped with the cursor over the frame, it is **nested into that frame** and clipped. Nesting follows the cursor, not the size.
- **Modifiers during drags** (⌘ marquee, ⌘ / Space / ⌃ while dragging) could not be verified: the browser tool cannot press or hold keys in the middle of a drag.

## Log

### 1. Click frame title — observed
- **Action:** nothing selected; click the "Parent" frame label on canvas
- **Before:** focus=INPUT[Figma Design](canvas-focus); panel=Page
- **After:** sel=Parent; focus=INPUT[Figma Design, 1 item selected](canvas-focus); panel=Frame

### 2. Second press on the frame title soon after a click (acts as double-click) — observed
- **Action:** click the "Parent" label, then immediately press-drag it (left_click_drag right after the click)
- **Before:** sel=Parent; focus=INPUT[Figma Design, 1 item selected](canvas-focus); panel=Frame
- **After:** sel=Parent; focus=INPUT value="Parent" sel=0-6; panel=Frame
- **Notes:** Frame did not move (still 0,0); an inline rename INPUT opened over the label with the name "Parent" fully selected (sel 0-6) → double-click on the frame title renames inline.

### 3. Esc in frame-title rename — observed
- **Action:** Esc while the inline rename input is open
- **Before:** sel=Parent; focus=INPUT value="Parent" sel=0-6; panel=Frame
- **After:** sel=Parent; focus=INPUT[Figma Design, 1 item selected](canvas-focus); panel=Frame
- **Notes:** name=Parent

### 4. Drag frame title — observed
- **Action:** nothing selected; press on the "Parent" label and drag 30,10 screenshot px (54,18 CSS px at 100%). (Tool warned "page navigated during drag" = the URL node-id changed on selection.)
- **Before:** focus=INPUT[Figma Design](canvas-focus); panel=Page
- **After:** sel=Parent; focus=INPUT[Figma Design, 1 item selected](canvas-focus); panel=Frame
- **Notes:** Parent position after: 50,20

### 5. Click empty background of a top-level frame with children — observed
- **Action:** nothing selected; click an empty spot inside Parent (not on a child)
- **Before:** focus=INPUT[Figma Design](canvas-focus); panel=Page
- **After:** focus=INPUT[Figma Design](canvas-focus); panel=Page

### 6. Click empty background of a nested frame — observed
- **Action:** Parent selected; click an empty spot inside the nested frame Inner
- **Before:** focus=INPUT[Figma Design](canvas-focus); panel=Page
- **After:** sel=Inner; focus=INPUT[Figma Design, 1 item selected](canvas-focus); panel=Frame

### 7. Drag starting on empty frame background — observed
- **Action:** nothing selected; press on an empty spot inside Parent (top-level frame with children) and drag up-right across D and Inner
- **Before:** focus=INPUT[Figma Design](canvas-focus); panel=Page
- **After:** sel=Inner; focus=INPUT[Figma Design, 1 item selected](canvas-focus); panel=Frame
- **Notes:** Parent pos after: 0,0

### 8. Marquee from outside, partially over a top-level frame — observed
- **Action:** nothing selected; drag a marquee from empty canvas (-60,-40) to (120,100) in canvas units: it covers the top-left part of Parent including all of child A
- **Before:** focus=INPUT[Figma Design](canvas-focus); panel=Page
- **After:** sel=A; focus=INPUT[Figma Design, 1 item selected](canvas-focus); panel=Rectangle

### 9. ⌘-marquee (nested) — could not reproduce
- **Action:** nothing selected; ⌘ + drag a marquee starting inside Parent over Inner/E (computer left_click_drag with modifiers=cmd)
- **Before:** focus=INPUT[Figma Design](canvas-focus); panel=Page
- **After:** sel=Inner; focus=INPUT[Figma Design, 1 item selected](canvas-focus); panel=Frame
- **Notes:** INCONCLUSIVE: result was Inner, the same as without ⌘ — the tool may not hold ⌘ during the drag.

### 10. Drop a layer larger than the frame under the cursor — observed
- **Action:** nothing selected; press on Big (500×350 rectangle) and drag until the cursor is over the centre of SmallFrame (150×150 empty frame), release
- **Before:** focus=INPUT[Figma Design](canvas-focus); panel=Page
- **After:** sel=Big; focus=INPUT[Figma Design, 1 item selected](canvas-focus); panel=Rectangle
- **Notes:** Big.parent=SmallFrame pos=-175,-100

### 11. ⌘ while dragging onto a frame — could not reproduce
- **Action:** nothing selected; ⌘ + press X2 and drag the cursor onto the centre of SmallFrame, release (computer left_click_drag modifiers=cmd; it is not verifiable that ⌘ was held for the whole drag)
- **Before:** focus=INPUT[Figma Design](canvas-focus); panel=Page
- **After:** sel=X2; focus=INPUT[Figma Design, 1 item selected](canvas-focus); panel=Rectangle
- **Notes:** X2.parent=SmallFrame pos=45,55 — same result as a plain drag (nests by cursor), so whether ⌘ changes nesting could not be verified.

### 12. Space while dragging (move the drag origin) — could not reproduce
- **Action:** press Space during a move drag
- **Before:** —
- **After:** —
- **Notes:** The browser tool’s drag is a single press-move-release with no way to press a key in the middle.

### 13. ⌃ while dragging (snapping off) — could not reproduce
- **Action:** hold ⌃ during a move drag
- **Before:** —
- **After:** —
- **Notes:** Same reason: no key presses possible mid-drag.
