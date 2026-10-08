# Behaviour — Layers panel

Observed in Figma (web, Design mode) in the owner’s Drafts file "Untitled", page "Behaviour", on 2026-10-08, at a 1440×900 viewport (checked before each record).
State is recorded as `sel` (selected layer names), `panel` (first line of the Design panel), `focus` (the focused element; `(canvas-focus)` = Figma’s canvas keyboard input) and extra fields.
Keys marked "synthetic" were sent as JavaScript KeyboardEvents on the focused element. Clicks, drags and other keys were real input from the browser tool.

## Findings

- **Order of children:** an **auto-layout frame lists its children in flow order, first child at the top** (AL1, AL2, AL3). A **plain frame lists its last child (highest z) at the top**.
- **Keyboard focus:** clicking a row keeps keyboard focus on the canvas focus input, so **Enter after a row click behaves like Enter on the canvas** (a rectangle entered vector edit mode). It is not rename.
- **Rename:**
  * **Double-clicking the name text** opens an inline rename with the whole name selected. Double-clicking empty row space does not rename.
  * Esc cancels the rename.
  * **⌘R with 3 layers selected** opens a **"Rename 3 layers"** dialog: Preview list, a Match (optional) field, a Rename-to field, Current name / Number ↑ / Number ↓ buttons, "Start ascending from", Learn more, and Cancel / Rename.
- **Chevrons and row icons:**
  * **Chevrons are always drawn** (fill white at 40%), not only on hover.
  * Hovering a row shows lock and eye toggles on the right. A hidden row keeps its closed-eye icon and dimmed text.
  * **⌥-click on a chevron expands or collapses recursively.** Nested frames open or close too.
  * **⌥L collapses every layer.**
- **Drag across the eye icons:** pressing on one row’s eye and dragging over the next rows **hides every row it crosses** (S3, S2 and S1 all hidden).

## Log

### 1. Order of auto-layout children in Layers — observed
- **Action:** expand AL (horizontal auto layout, children AL1,AL2,AL3 in flow order = index 0,1,2) and Parent (plain frame, children A..Inner index 0..4) and read row y positions
- **Before:** —
- **After:** AL_rows=AL1@y378 AL2@y410 AL3@y442; Parent_rows=Inner@y698 D@y762 C_locked@y794 B_hidden@y826 A@y858
- **Notes:** AL index order AL1,AL2,AL3; Parent index order A,B_hidden,C_locked,D,Inner

### 2. Enter on a selected layer row — observed
- **Action:** click the X1 row in Layers, press Enter
- **Before:** sel=X1; focus=INPUT[Figma Design, 1 item selected](canvas-focus); panel=Rectangle
- **After:** sel=X1; focus=INPUT[Figma Design, 1 item selected](canvas-focus); panel=Vector

### 3. Double-click a layer name — observed
- **Action:** double-click directly on the text "S1" in its Layers row
- **Before:** focus=INPUT[Figma Design](canvas-focus); panel=Page
- **After:** sel=S1; focus=INPUT value="S1" sel=0-2; panel=Rectangle

### 4. Esc in layer rename — observed
- **Action:** press Esc in the rename field
- **Before:** sel=S1; focus=INPUT value="S1" sel=0-2; panel=Rectangle
- **After:** sel=S1; focus=INPUT[Figma Design, 1 item selected](canvas-focus); panel=Rectangle
- **Notes:** name now: S1

### 5. ⌘R with several layers selected — observed
- **Action:** S1,S2,S3 selected (API), press ⌘R
- **Before:** sel=S1,S2,S3; focus=INPUT[Figma Design, 1 item selected](canvas-focus); panel=Rectangle
- **After:** sel=S1,S2,S3; focus=INPUT value="" sel=0-0; panel=3 selected
- **Notes:** popup text: Rename 3 layers | Preview | S3 | S2 | S1 | Current name | Number ↑ | Number ↓ | Start ascending from | Learn more | Cancel | Rename

### 6. Chevron visibility — observed
- **Action:** read the Parent row chevron fill: idle, with the row hovered, with the chevron hovered
- **Before:** fill=rgba(255,255,255,0.4)
- **After:** fill_rowHover=rgba(255, 255, 255, 0.4); fill_chevronHover=rgba(255, 255, 255, 0.4)
- **Notes:** chevrons are always rendered (not hover-only)

### 7. ⌥-click a chevron — observed
- **Action:** Parent expanded (Inner expanded too); ⌥-click the Parent chevron
- **Before:** focus=INPUT[Figma Design](canvas-focus); panel=Page; rows=Parent,A,B_hidden,C_locked,D,Inner,E,AL,AL1,AL2,AL3
- **After:** focus=INPUT[Figma Design](canvas-focus); panel=Page; rows=Parent,AL,AL1,AL2,AL3

### 8. ⌥-click a collapsed chevron — observed
- **Action:** Parent collapsed; ⌥-click its chevron again
- **Before:** focus=INPUT[Figma Design](canvas-focus); panel=Page; rows=Parent,AL,AL1,AL2,AL3
- **After:** focus=INPUT[Figma Design](canvas-focus); panel=Page; rows=Parent,A,B_hidden,C_locked,D,Inner,E,AL,AL1,AL2,AL3

### 9. ⌥L — observed
- **Action:** nothing selected, Parent/Inner/AL expanded; press ⌥L (synthetic key event on the canvas focus input)
- **Before:** focus=INPUT[Figma Design](canvas-focus); panel=Page; rows=Parent,A,B_hidden,C_locked,D,Inner,E,AL,AL1,AL2,AL3
- **After:** focus=INPUT[Figma Design](canvas-focus); panel=Page; rows=Parent,AL

### 10. Drag across eye icons — observed
- **Action:** hover the S3 row, press on its eye icon and drag down over the S2 and S1 eye icons, release
- **Before:** focus=INPUT[Figma Design](canvas-focus); panel=Page; vis=S1:vis S2:vis S3:vis
- **After:** focus=INPUT[Figma Design](canvas-focus); panel=Page; vis=S1:HIDDEN S2:HIDDEN S3:HIDDEN

### 11. How a selected instance row and a selected component row look — observed (visual pass)
- **Action:** select an instance / main component and read the Layers row
- **Before:** —
- **After:** —
- **Notes:** Covered by the LEFT sections of design/instance.txt and design/component.txt: the selected row bg is #394360 and component and instance rows use purple text and icons. Not re-tested here.
