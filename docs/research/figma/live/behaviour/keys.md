# Behaviour — Shortcuts (opacity, ordering, zoom-to-frame, duplicate, view modes, paste)

Observed in Figma (web, Design mode) in the owner’s Drafts file "Untitled", page "Behaviour", on 2026-10-08, at a 1440×900 viewport (checked before each record).
State is recorded as `sel` (selected layer names), `panel` (first line of the Design panel), `focus` (the focused element; `(canvas-focus)` = Figma’s canvas keyboard input) and extra fields.
Keys marked "synthetic" were sent as JavaScript KeyboardEvents on the focused element. Clicks, drags and other keys were real input from the browser tool.

## Findings

- **Opacity digits:**
  * "5" gives 50% and **"0" gives 100%**.
  * Two digits typed within about **450–500 ms** combine: "4","5" gives 45%, **"0","5" gives 5%**, and "1","0" gives 10%. With a gap of 500 ms or more, the second key starts over: "4"…"5" gives 50%.
- **Layer order:** **] brings to front, [ sends to back, ⌘] moves forward one, ⌘[ moves backward one, and ⌥⌘] also went to the front** (index 2 → 10 → 0 → 1 → 0 → 10 of 11).
- **N / ⇧N:** **N zooms to the next top-level frame** (Parent → AL → SmallFrame, zoom about 213%–527%) **and ⇧N to the previous one.** The selection does not change.
- **⌘D:** **duplicates in place with the same name** (no "copy" suffix). **After the copy is moved (⇧↓ ×3 = 30 px), each further ⌘D repeats that offset** (y 30 → 60 → 90).
- **⇧⌘O** toggles **outline mode**: wireframe outlines and no fills, with a bottom toast "Outlines visible · Cancel".
- **⌃P** toggles **pixel preview**, with the toasts "Pixel preview enabled (1x)" and "Pixel preview disabled".
- **Pixel grid:** it **shows from 300% zoom upwards** (faint at 300%, clear at 400% and above) and is absent at 200%. The View menu’s shortcut is **⇧'** (not ⌘').
- **Not verified** with this tool: ⌥⌘A (select matching layers: the selection did not change) and all paste behaviour (⇧⌘R, ⇧⌘V, paste placement). Copy and paste never reached the page.

## Log

### 1. Opacity keys "5" — observed
- **Action:** S1 selected; press 5 (gap 0 ms, synthetic keys)
- **Before:** sel=S1; focus=DIV(canvas-focus); panel=Rectangle
- **After:** sel=S1; focus=DIV(canvas-focus); panel=Rectangle
- **Notes:** opacity=50%

### 2. Opacity keys "0" — observed
- **Action:** S1 selected; press 0 (gap 0 ms, synthetic keys)
- **Before:** sel=S1; focus=DIV(canvas-focus); panel=Rectangle
- **After:** sel=S1; focus=DIV(canvas-focus); panel=Rectangle
- **Notes:** opacity=100%

### 3. Opacity keys "4","5" quickly — observed
- **Action:** S1 selected; press 4 then 5 (gap 100 ms, synthetic keys)
- **Before:** sel=S1; focus=DIV(canvas-focus); panel=Rectangle
- **After:** sel=S1; focus=DIV(canvas-focus); panel=Rectangle
- **Notes:** opacity=45%

### 4. Opacity keys "4" then "5" after 1.5 s — observed
- **Action:** S1 selected; press 4 then 5 (gap 1500 ms, synthetic keys)
- **Before:** sel=S1; focus=DIV(canvas-focus); panel=Rectangle
- **After:** sel=S1; focus=DIV(canvas-focus); panel=Rectangle
- **Notes:** opacity=50%

### 5. Opacity keys "0","5" quickly — observed
- **Action:** S1 selected; press 0 then 5 (gap 100 ms, synthetic keys)
- **Before:** sel=S1; focus=DIV(canvas-focus); panel=Rectangle
- **After:** sel=S1; focus=DIV(canvas-focus); panel=Rectangle
- **Notes:** opacity=5%

### 6. Opacity keys "1","0" quickly — observed
- **Action:** S1 selected; press 1 then 0 (gap 100 ms, synthetic keys)
- **Before:** sel=S1; focus=DIV(canvas-focus); panel=Rectangle
- **After:** sel=S1; focus=DIV(canvas-focus); panel=Rectangle
- **Notes:** opacity=10%

### 7. Opacity two-digit buffer timing — observed
- **Action:** S1 selected; press "4", wait 300 ms, press "5"
- **Before:** sel=S1; focus=DIV(canvas-focus); panel=Rectangle
- **After:** sel=S1; focus=DIV(canvas-focus); panel=Rectangle
- **Notes:** opacity=45%

### 8. Opacity two-digit buffer timing — observed
- **Action:** S1 selected; press "4", wait 500 ms, press "5"
- **Before:** sel=S1; focus=DIV(canvas-focus); panel=Rectangle
- **After:** sel=S1; focus=DIV(canvas-focus); panel=Rectangle
- **Notes:** opacity=50%

### 9. Opacity two-digit buffer timing — observed
- **Action:** S1 selected; press "4", wait 700 ms, press "5"
- **Before:** sel=S1; focus=DIV(canvas-focus); panel=Rectangle
- **After:** sel=S1; focus=DIV(canvas-focus); panel=Rectangle
- **Notes:** opacity=50%

### 10. Opacity two-digit buffer timing — observed
- **Action:** S1 selected; press "4", wait 900 ms, press "5"
- **Before:** sel=S1; focus=DIV(canvas-focus); panel=Rectangle
- **After:** sel=S1; focus=DIV(canvas-focus); panel=Rectangle
- **Notes:** opacity=50%

### 11. Opacity two-digit buffer timing — observed
- **Action:** S1 selected; press "4", wait 1200 ms, press "5"
- **Before:** sel=S1; focus=DIV(canvas-focus); panel=Rectangle
- **After:** sel=S1; focus=DIV(canvas-focus); panel=Rectangle
- **Notes:** opacity=50%

### 12. ] [ layer order — observed
- **Action:** S1 selected (page children: 11); press ], then [, then ⌘], then ⌘[, then ⌥⌘]
- **Before:** sel=S1; focus=DIV(canvas-focus); panel=Rectangle
- **After:** sel=S1; focus=DIV(canvas-focus); panel=Rectangle
- **Notes:** index sequence 2 -> 10 -> 0 -> 1 -> 0 -> 10

### 13. Opacity two-digit buffer timing — observed
- **Action:** S1 selected; press "4", wait 400 ms, press "5"
- **Before:** sel=S1; focus=DIV(canvas-focus); panel=Rectangle
- **After:** sel=S1; focus=DIV(canvas-focus); panel=Rectangle
- **Notes:** opacity=45%

### 14. Opacity two-digit buffer timing — observed
- **Action:** S1 selected; press "4", wait 450 ms, press "5"
- **Before:** sel=S1; focus=DIV(canvas-focus); panel=Rectangle
- **After:** sel=S1; focus=DIV(canvas-focus); panel=Rectangle
- **Notes:** opacity=45%

### 15. N (zoom to next/previous frame) — observed
- **Action:** nothing selected at first; press N
- **Before:** focus=DIV(canvas-focus); panel=Page; view=center=451,600 zoom=0.60
- **After:** focus=DIV(canvas-focus); panel=Page; view=center=200,164 zoom=2.13

### 16. N (zoom to next/previous frame) — observed
- **Action:** nothing selected at first; press N
- **Before:** focus=DIV(canvas-focus); panel=Page; view=center=200,164 zoom=2.13
- **After:** focus=DIV(canvas-focus); panel=Page; view=center=582,298 zoom=5.19

### 17. N (zoom to next/previous frame) — observed
- **Action:** nothing selected at first; press N
- **Before:** focus=DIV(canvas-focus); panel=Page; view=center=582,298 zoom=5.19
- **After:** focus=DIV(canvas-focus); panel=Page; view=center=675,531 zoom=5.27

### 18. ⇧N (zoom to next/previous frame) — observed
- **Action:** nothing selected at first; press ⇧N
- **Before:** focus=DIV(canvas-focus); panel=Page; view=center=675,531 zoom=5.27
- **After:** focus=DIV(canvas-focus); panel=Page; view=center=582,298 zoom=5.19

### 19. ⌥⌘A select matching layers — could not reproduce
- **Action:** S1 selected (S1,S2,S3 identical 60×60 grey rectangles with different names); ⌥⌘A as a synthetic key event and as a real key press
- **Before:** sel=S1
- **After:** sel=S1
- **Notes:** Selection did not change either way. Edit menu lists "Select matching layers ⌥⌘A". Not verified whether the shortcut is blocked in the browser or whether names must match.

### 20. ⌘D twice after moving (offset memory) — observed
- **Action:** S1 selected at 500,0; ⌘D, then ⇧↓ ×3 (moves the copy 30 px down), then ⌘D, then ⌘D again
- **Before:** sel=S1; focus=DIV(canvas-focus); panel=Rectangle; pos=S1@500,0
- **After:** sel=S1; focus=DIV(canvas-focus); panel=Rectangle; pos=S1@500,90
- **Notes:** after ⌘D: S1@500,0 | after ⇧↓×3: S1@500,30 | after 2nd ⌘D: S1@500,60 | after 3rd ⌘D: S1@500,90

### 21. ⇧⌘R paste to replace — could not reproduce
- **Action:** copy X1 with a real ⌘C, then select S2 and press ⇧⌘R / ⇧⌘V, or press ⌘V with nothing selected
- **Before:** —
- **After:** —
- **Notes:** No paste happened at all. A plain ⌘V after ⌘C did not add a layer either: the browser tool’s key events do not reach the system clipboard path (copy/paste events), so all paste behaviour is unverified.

### 22. ⇧⌘V paste over selection — could not reproduce
- **Action:** copy X1 with a real ⌘C, then select S2 and press ⇧⌘R / ⇧⌘V, or press ⌘V with nothing selected
- **Before:** —
- **After:** —
- **Notes:** No paste happened at all. A plain ⌘V after ⌘C did not add a layer either: the browser tool’s key events do not reach the system clipboard path (copy/paste events), so all paste behaviour is unverified.

### 23. Paste placement when the source frame is off-screen — could not reproduce
- **Action:** copy X1 with a real ⌘C, then select S2 and press ⇧⌘R / ⇧⌘V, or press ⌘V with nothing selected
- **Before:** —
- **After:** —
- **Notes:** No paste happened at all. A plain ⌘V after ⌘C did not add a layer either: the browser tool’s key events do not reach the system clipboard path (copy/paste events), so all paste behaviour is unverified.

### 24. Pixel grid visibility by zoom (⇧' toggles, per View menu) — observed (threshold); toggle unconfirmed
- **Action:** nothing selected; zoom the canvas to 200%, 300%, 400%, 500% and 800% at the corner of S1 and look at the canvas; at 800% press ⇧' (synthetic) and look again, then press it again
- **Before:** —
- **After:** —
- **Notes:** The pixel grid (thin lines on every canvas pixel) shows at 300% (faint), 400%, 500% and 800%. It does not show at 200%. The View menu lists the shortcut as "Pixel grid ⇧'", not ⌘'. After the synthetic ⇧' the grid looked fainter but not clearly gone, so the toggle itself is unconfirmed at this screenshot resolution. Images: behaviour/img/pixel-grid-*.png

### 25. ⇧⌘O outlines — observed
- **Action:** nothing selected; press ⇧⌘O (synthetic)
- **Before:** focus=DIV(canvas-focus); panel=Page; tool=Move,Move
- **After:** focus=DIV(canvas-focus); panel=Page; tool=Move,Move
- **Notes:** The canvas switches to outline (wireframe) mode: every layer is drawn as a 1 px light outline with no fills, and text is drawn in outline/grey. A toast at the bottom reads: Screenreader support for the board is currently disabled. To enable it via Accessibility settings, press ⌘K, type Accessibility Settings, and press Enter. To see available keyboard shortcuts, enter ⌃⇧Question mark . ||  ||  ||  ||  || . Image: behaviour/img/outlines-shift-cmd-o.jpg

### 26. ⇧⌘O again — observed
- **Action:** press ⇧⌘O again
- **Before:** focus=DIV(canvas-focus); panel=Page
- **After:** focus=DIV(canvas-focus); panel=Page
- **Notes:** outline mode off (verified by screenshot afterwards)

### 27. ⌃P — observed
- **Action:** nothing selected; press ⌃P (synthetic)
- **Before:** focus=DIV(canvas-focus); panel=Page; tool=Move,Move
- **After:** focus=DIV(canvas-focus); panel=Page; tool=Move,Move
- **Notes:** First ⌃P: toast "Pixel preview enabled (1x)". Further presses: Pixel preview disabled -> Pixel preview enabled (1x) -> Pixel preview disabled. The active tool stayed Move.
