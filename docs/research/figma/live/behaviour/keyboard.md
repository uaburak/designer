# Behaviour — Selection keys (Esc, Enter, ⇧Enter, \, Tab)

Observed in Figma (web, Design mode) in the owner’s Drafts file "Untitled", page "Behaviour", on 2026-10-08, at a 1440×900 viewport (checked before each record).
State is recorded as `sel` (selected layer names), `panel` (first line of the Design panel), `focus` (the focused element; `(canvas-focus)` = Figma’s canvas keyboard input) and extra fields.
Keys marked "synthetic" were sent as JavaScript KeyboardEvents on the focused element. Clicks, drags and other keys were real input from the browser tool.

## Findings

- **Esc clears the whole selection.** It does not climb to the parent: a child, a nested frame or a top-level layer all go to "nothing selected". A second Esc does nothing.
- **⇧Enter selects the parent**, one level per press (E → Inner → Parent). **\ does the same**: the JavaScript keydown worked; the tool’s real "backslash" key never reached the page.
- **Enter on a frame selects all its direct children, hidden and locked layers included** (5 items). A second Enter replaces every selected child that has children with those children (Inner → E) and keeps the leaves.
- **Enter on a rectangle or other shape enters vector edit mode.** The panel header turns to "Vector", the same as double-clicking the shape.
- **Tab moves to the next layer down the Layers list** (the next lower z-index sibling); **⇧Tab moves up**. Both **wrap around** and **do not skip hidden or locked layers**. Top-level layers behave the same way. The viewport auto-scrolls to the new selection.
- **Clicking selects by level.** A click on a child of a top-level frame selects that child. A click inside a nested frame selects the nested frame (the top-level frame’s direct child), not the deep leaf.

## Log

### 1. Esc on selected child — observed
- **Action:** click child A (inside top-level frame Parent) on canvas, press Esc
- **Before:** sel=A; focus=INPUT[Figma Design, 1 item selected](canvas-focus); panel=Rectangle
- **After:** focus=INPUT[Figma Design](canvas-focus); panel=Page

### 2. Esc twice — observed
- **Action:** after the first Esc, press Esc again
- **Before:** focus=INPUT[Figma Design](canvas-focus); panel=Page
- **After:** focus=INPUT[Figma Design](canvas-focus); panel=Page

### 3. Esc on nested selection — observed
- **Action:** click at E (inside Inner inside Parent) on canvas, press Esc
- **Before:** sel=Inner; focus=INPUT[Figma Design, 1 item selected](canvas-focus); panel=Frame
- **After:** focus=INPUT[Figma Design](canvas-focus); panel=Page

### 4. Esc on nested selection (2nd) — observed
- **Action:** press Esc again
- **Before:** focus=INPUT[Figma Design](canvas-focus); panel=Page
- **After:** focus=INPUT[Figma Design](canvas-focus); panel=Page

### 5. Shift+Enter — observed
- **Action:** E selected (via API, canvas focused), press ⇧Enter
- **Before:** sel=E; focus=INPUT[Figma Design](canvas-focus); panel=Page
- **After:** sel=Inner; focus=INPUT[Figma Design, 1 item selected](canvas-focus); panel=Frame

### 6. Shift+Enter again — observed
- **Action:** press ⇧Enter again
- **Before:** sel=Inner; focus=INPUT[Figma Design, 1 item selected](canvas-focus); panel=Frame
- **After:** sel=Parent; focus=INPUT[Figma Design, 1 item selected](canvas-focus); panel=Frame

### 7. Backslash — could not reproduce
- **Action:** E selected, press \
- **Before:** sel=E; focus=INPUT[Figma Design, 1 item selected](canvas-focus); panel=Frame
- **After:** sel=E; focus=INPUT[Figma Design, 1 item selected](canvas-focus); panel=Rectangle
- **Notes:** The browser tool’s real "backslash" key did not reach Figma (⌘\ failed the same way earlier). See the next entry: the same key sent as a JavaScript keydown worked.

### 8. Enter on frame — observed
- **Action:** Parent (frame with A, B_hidden, C_locked, D, Inner) selected, press Enter
- **Before:** sel=Parent; focus=INPUT[Figma Design, 1 item selected](canvas-focus); panel=Rectangle
- **After:** sel=A,B_hidden,C_locked,D,Inner; focus=INPUT[Figma Design, 5 items selected](canvas-focus); panel=5 selected

### 9. Enter twice — observed
- **Action:** press Enter again with that selection
- **Before:** sel=A,B_hidden,C_locked,D,Inner; focus=INPUT[Figma Design, 5 items selected](canvas-focus); panel=5 selected
- **After:** sel=A,B_hidden,C_locked,D,E; focus=INPUT[Figma Design, 5 items selected](canvas-focus); panel=5 selected

### 10. Backslash (synthetic) — observed
- **Action:** E selected; JS-dispatched keydown key="\\" code=Backslash on the canvas focus input
- **Before:** sel=E; focus=INPUT[Figma Design, 5 items selected](canvas-focus); panel=5 selected
- **After:** sel=Inner; focus=INPUT[Figma Design, 1 item selected](canvas-focus); panel=Frame

### 11. Tab #1 — observed
- **Action:** A selected (via API), press Tab repeatedly (siblings: A, B_hidden, C_locked, D, Inner in layer order bottom→top)
- **Before:** sel=A; focus=INPUT[Figma Design, 1 item selected](canvas-focus); panel=Frame
- **After:** sel=Inner; focus=INPUT[Figma Design, 1 item selected](canvas-focus); panel=Frame

### 12. Tab #2 — observed
- **Action:** A selected (via API), press Tab repeatedly (siblings: A, B_hidden, C_locked, D, Inner in layer order bottom→top)
- **Before:** sel=Inner; focus=INPUT[Figma Design, 1 item selected](canvas-focus); panel=Frame
- **After:** sel=D; focus=INPUT[Figma Design, 1 item selected](canvas-focus); panel=Rectangle

### 13. Tab #3 — observed
- **Action:** A selected (via API), press Tab repeatedly (siblings: A, B_hidden, C_locked, D, Inner in layer order bottom→top)
- **Before:** sel=D; focus=INPUT[Figma Design, 1 item selected](canvas-focus); panel=Rectangle
- **After:** sel=C_locked; focus=INPUT[Figma Design, 1 item selected](canvas-focus); panel=Rectangle

### 14. Tab #4 — observed
- **Action:** A selected (via API), press Tab repeatedly (siblings: A, B_hidden, C_locked, D, Inner in layer order bottom→top)
- **Before:** sel=C_locked; focus=INPUT[Figma Design, 1 item selected](canvas-focus); panel=Rectangle
- **After:** sel=B_hidden; focus=INPUT[Figma Design, 1 item selected](canvas-focus); panel=Rectangle

### 15. Tab #5 — observed
- **Action:** A selected (via API), press Tab repeatedly (siblings: A, B_hidden, C_locked, D, Inner in layer order bottom→top)
- **Before:** sel=B_hidden; focus=INPUT[Figma Design, 1 item selected](canvas-focus); panel=Rectangle
- **After:** sel=A; focus=INPUT[Figma Design, 1 item selected](canvas-focus); panel=Rectangle

### 16. Tab #6 — observed
- **Action:** A selected (via API), press Tab repeatedly (siblings: A, B_hidden, C_locked, D, Inner in layer order bottom→top)
- **Before:** sel=A; focus=INPUT[Figma Design, 1 item selected](canvas-focus); panel=Rectangle
- **After:** sel=Inner; focus=INPUT[Figma Design, 1 item selected](canvas-focus); panel=Frame

### 17. Shift+Tab #1 — observed
- **Action:** A selected, press ⇧Tab repeatedly
- **Before:** sel=A; focus=INPUT[Figma Design, 1 item selected](canvas-focus); panel=Frame
- **After:** sel=B_hidden; focus=INPUT[Figma Design, 1 item selected](canvas-focus); panel=Rectangle

### 18. Shift+Tab #2 — observed
- **Action:** A selected, press ⇧Tab repeatedly
- **Before:** sel=B_hidden; focus=INPUT[Figma Design, 1 item selected](canvas-focus); panel=Rectangle
- **After:** sel=C_locked; focus=INPUT[Figma Design, 1 item selected](canvas-focus); panel=Rectangle

### 19. Shift+Tab #3 — observed
- **Action:** A selected, press ⇧Tab repeatedly
- **Before:** sel=C_locked; focus=INPUT[Figma Design, 1 item selected](canvas-focus); panel=Rectangle
- **After:** sel=D; focus=INPUT[Figma Design, 1 item selected](canvas-focus); panel=Rectangle

### 20. Shift+Tab #4 — observed
- **Action:** A selected, press ⇧Tab repeatedly
- **Before:** sel=D; focus=INPUT[Figma Design, 1 item selected](canvas-focus); panel=Rectangle
- **After:** sel=Inner; focus=INPUT[Figma Design, 1 item selected](canvas-focus); panel=Frame

### 21. Shift+Tab #5 — observed
- **Action:** A selected, press ⇧Tab repeatedly
- **Before:** sel=Inner; focus=INPUT[Figma Design, 1 item selected](canvas-focus); panel=Frame
- **After:** sel=A; focus=INPUT[Figma Design, 1 item selected](canvas-focus); panel=Rectangle

### 22. Shift+Tab #6 — observed
- **Action:** A selected, press ⇧Tab repeatedly
- **Before:** sel=A; focus=INPUT[Figma Design, 1 item selected](canvas-focus); panel=Rectangle
- **After:** sel=B_hidden; focus=INPUT[Figma Design, 1 item selected](canvas-focus); panel=Rectangle

### 23. Tab top-level #1 — observed
- **Action:** top-level Txt selected, press Tab repeatedly (page children order: Parent,Txt,S1,S2,S3,X1,X2,AL,Big,SmallFrame,Ln)
- **Before:** sel=Txt; focus=INPUT[Figma Design, 1 item selected](canvas-focus); panel=Rectangle
- **After:** sel=Parent; focus=INPUT[Figma Design, 1 item selected](canvas-focus); panel=Frame

### 24. Tab top-level #2 — observed
- **Action:** top-level Txt selected, press Tab repeatedly (page children order: Parent,Txt,S1,S2,S3,X1,X2,AL,Big,SmallFrame,Ln)
- **Before:** sel=Parent; focus=INPUT[Figma Design, 1 item selected](canvas-focus); panel=Frame
- **After:** sel=Ln; focus=INPUT[Figma Design, 1 item selected](canvas-focus); panel=Line

### 25. Tab top-level #3 — observed
- **Action:** top-level Txt selected, press Tab repeatedly (page children order: Parent,Txt,S1,S2,S3,X1,X2,AL,Big,SmallFrame,Ln)
- **Before:** sel=Ln; focus=INPUT[Figma Design, 1 item selected](canvas-focus); panel=Line
- **After:** sel=SmallFrame; focus=INPUT[Figma Design, 1 item selected](canvas-focus); panel=Frame
