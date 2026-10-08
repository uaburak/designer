# Behaviour — Number fields in the Design panel

Observed in Figma (web, Design mode) in the owner’s Drafts file "Untitled", page "Behaviour", on 2026-10-08, at a 1440×900 viewport (checked before each record).
State is recorded as `sel` (selected layer names), `panel` (first line of the Design panel), `focus` (the focused element; `(canvas-focus)` = Figma’s canvas keyboard input) and extra fields.
Keys marked "synthetic" were sent as JavaScript KeyboardEvents on the focused element. Clicks, drags and other keys were real input from the browser tool.

## Findings

- **Focus:**
  * Clicking a field selects all of its text.
  * **Enter commits and sends keyboard focus back to the canvas.** Focus does not stay in the field.
  * **Esc reverts the typed text and keeps focus in the field, with the text selected.** The display updated after about 0.5–0.8 s. A **second Esc** sends focus back to the canvas and keeps the selection.
- **Expressions:**
  * "500+10" gives 510, "x*2" doubles, and **"2^3" gives 8** (^ is a power).
  * **"+10" typed over the selected value gives 10.** A leading "+" alone is not relative.
  * **"Mixed+100"** (End, then type "+100" into a mixed field) **adds 100 to each layer separately** (10/620 → 110/720).
- **Keyboard:**
  * **Tab order follows the DOM:** X → Y → Rotation → Rotate 90° → Flip horizontal …. Each field selects all of its text on focus. ⇧Tab goes back.
  * **↑ / ↓ step by 1, and ⇧↑ / ⇧↓ by 10.** The step is computed from the text shown in the field (during fast repeats it used a stale value).
- **Special values:**
  * **Gap "Auto"** sets primaryAxisAlignItems to SPACE_BETWEEN (itemSpacing stays 10) and the field shows "Auto".
  * **"1,2,3,4" in the Horizontal padding field** set left=1 and right=2. Only the first two values were used; top and bottom stayed 12.
- **Scrubbing:** dragging the "X" label changes the value (-3 → 19 for a 90 CSS px drag; the ratio is not measured precisely). Afterwards the field has focus with its text selected.

## Log

### 1. Click into X field — observed
- **Action:** X1 selected, click the X input
- **Before:** sel=X1; focus=INPUT[Figma Design](canvas-focus); panel=Page
- **After:** sel=X1; focus=INPUT[X-position] value="500" sel=0-3; panel=Rectangle

### 2. Expression 500+10 Enter — observed
- **Action:** X1 selected, click X field, End, type "+10" (field shows "500+10"), Enter
- **Before:** sel=X1; focus=INPUT[Figma Design, 1 item selected](canvas-focus); panel=Rectangle
- **After:** sel=X1; focus=INPUT[Figma Design, 1 item selected](canvas-focus); panel=Rectangle
- **Notes:** X1:510,150 60x40 X2:620,170 60x40

### 3. Type +10 over selected value — observed
- **Action:** click X field (value 510 fully selected), type "+10" (replaces the text), Enter
- **Before:** sel=X1; focus=INPUT[Figma Design, 1 item selected](canvas-focus); panel=Rectangle
- **After:** sel=X1; focus=INPUT[Figma Design, 1 item selected](canvas-focus); panel=Rectangle
- **Notes:** X became 10: a leading + over a replaced value is NOT treated as relative

### 4. Click X field with mixed values — observed
- **Action:** X1 (x=10) + X2 (x=620) selected, click X field
- **Before:** sel=X1,X2; focus=INPUT[Figma Design, 1 item selected](canvas-focus); panel=Rectangle
- **After:** sel=X1,X2; focus=INPUT[X-position] value="Mixed" sel=0-5; panel=2 selected
- **Notes:** X1:10,150 60x40 X2:620,170 60x40

### 5. Mixed+100 — observed
- **Action:** mixed X field: End, type "+100" (field reads "Mixed+100"), Enter
- **Before:** sel=X1,X2; focus=INPUT[X-position] value="Mixed" sel=0-5; panel=2 selected
- **After:** sel=X1,X2; focus=INPUT[Figma Design, 2 items selected](canvas-focus); panel=2 selected
- **Notes:** X1:110,150 60x40 X2:720,170 60x40

### 6. Expression 110*2 — observed
- **Action:** X1 x=110: click X field, End, type "*2", Enter
- **Before:** sel=X1; focus=INPUT[Figma Design, 2 items selected](canvas-focus); panel=2 selected
- **After:** sel=X1; focus=INPUT[Figma Design, 2 items selected](canvas-focus); panel=2 selected
- **Notes:** X1:220,150 60x40 X2:720,170 60x40

### 7. Expression 2^3 — observed
- **Action:** click X field (value selected), type "2^3", Enter
- **Before:** sel=X1; focus=INPUT[Figma Design, 2 items selected](canvas-focus); panel=2 selected
- **After:** sel=X1; focus=INPUT[Figma Design, 1 item selected](canvas-focus); panel=Rectangle
- **Notes:** X1:8,150 60x40 X2:720,170 60x40

### 8. Esc in field — observed
- **Action:** click X field, type "777", Esc
- **Before:** sel=X1; focus=INPUT[Figma Design, 1 item selected](canvas-focus); panel=Rectangle
- **After:** sel=X1; focus=INPUT[X-position] value="8" sel=0-1; panel=Rectangle
- **Notes:** Re-read 800 ms later: value reverted to the committed 8, all text selected, focus stays in the field (the first read 350 ms after Esc still showed a stale "220").

### 9. Second Esc in field — observed
- **Action:** after Esc reverted the field, press Esc again (synthetic key event on the input)
- **Before:** sel=X1; focus=INPUT[X-position] value="8" sel=0-1; panel=Rectangle
- **After:** sel=X1; focus=INPUT[Figma Design, 1 item selected](canvas-focus); panel=Rectangle

### 10. Tab order through the panel — observed
- **Action:** X1 selected, click X field, press Tab 4 times then ⇧Tab once (values typed: none)
- **Before:** focus=INPUT[X-position] value="8" sel=0-1
- **After:** focus=INPUT[X-position] value="8" sel=0-1 -> INPUT[Y-position] value="150" sel=0-3 -> INPUT[Rotation] value="0°" sel=0-2 -> BUTTON[Rotate 90˚ right] -> BUTTON[Flip horizontal] -> S-TAB: BUTTON[Rotate 90˚ right]

### 11. Arrow keys in X field — observed
- **Action:** X1 selected, X field focused (synthetic key events on the input): ArrowUp, ⇧ArrowUp, ArrowDown, ⇧ArrowDown
- **Before:** sel=X1; focus=INPUT[X-position] value="8" sel=0-1; panel=Rectangle
- **After:** sel=X1; focus=INPUT[X-position] value="7" sel=0-1; panel=Rectangle
- **Notes:** Up: 8->9 field=8; ShiftUp: 9->18; Down: 18->7; ShiftDown: 7->-3 focus=INPUT[X-position] value="7" sel=0-1

### 12. Gap field accepts "Auto" — observed
- **Action:** AL (horizontal auto layout, gap 10) selected; focus the gap field, set text "Auto", Enter (value set via native setter + input event, Enter as key event)
- **Before:** sel=AL; focus=INPUT[Figma Design, 1 item selected](canvas-focus); panel=Frame
- **After:** sel=AL; focus=INPUT[Figma Design, 1 item selected](canvas-focus); panel=Frame
- **Notes:** after: primaryAxisAlignItems=SPACE_BETWEEN itemSpacing=10 field=Auto

### 13. Padding "1,2,3,4" — observed
- **Action:** AL selected; type "1,2,3,4" into the Horizontal padding field, Enter
- **Before:** sel=AL; focus=INPUT[Figma Design, 1 item selected](canvas-focus); panel=Frame
- **After:** sel=AL; focus=INPUT[Figma Design, 1 item selected](canvas-focus); panel=Frame
- **Notes:** padding T,R,B,L before=12,12,12,12 after=12,2,12,1

### 14. Scrub X by dragging the label — observed
- **Action:** X1 selected (x=-3); drag the "X" label in the X field 50 screenshot px = 90 CSS px to the right
- **Before:** sel=X1; focus=INPUT[Figma Design, 1 item selected](canvas-focus); panel=Rectangle
- **After:** sel=X1; focus=INPUT[X-position] value="19" sel=0-2; panel=Rectangle
- **Notes:** after: X1:19,150 60x40 X2:720,170 60x40

### 15. ⌥-hover over a number field (distance/scrub cursor) — could not reproduce
- **Action:** hold ⌥ while hovering the X field
- **Before:** —
- **After:** —
- **Notes:** The browser tool cannot keep a modifier held during a hover.
