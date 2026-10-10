# Behaviour — dragging a layer inside an auto-layout frame

Source: the owner's screen recording of live Figma (desktop app, Design mode), 2026-10-10, 58.2 s, 1108 × 1194 px at
≈ 47 fps (the screen itself updates at ≈ 40–60 Hz: some recorded frames repeat). Frames were read with AVFoundation
(`AVAssetImageGenerator`, zero tolerance) every 100 ms over each drag and every recorded frame around each swap and
drop; positions below are video pixels measured by scanning one row or column for the rectangles' colours (the
recording's scale: a 44 px layer is 78 video px, ≈ 1.77 video px per design px). Key frames are in `img/`
(`autolayout-drag-*.png`, half size).

The file: **Frame 406**, a vertical auto-layout frame, `260 × 449 Hug`, holding four rectangles `181 Fill × 44` —
green, blue, red, grey in flow order. 0–7 s: drags at 100 % zoom; 7–11 s: the gap dragged to 10; 11–21 s: drags
zoomed in; 21–31 s: padding hover and the frame rotated; 31–50 s: drags in the frame rotated by −90° (the flow runs
left → right on screen: blue, grey, red, green); 50–58 s: idle. Not in the recording: a drag out of the frame, a
wrapping frame, ⌘ / ⌥ / Space during the drag, Esc, several layers at once, a drag into the frame from outside.

## Findings

1. **The press** selects the layer as a click does: its outline, four handles, the size label (`181 Fill × 44`) and
   its parent's box dashed (`01-pressed`).
2. **The dragged layer follows the pointer 1 : 1 on both axes** (the grab offset kept; it drifts across the flow as
   the hand does — 6–8 px in these drags), **fully opaque** (its pixels equal its resting colour: `37,249,0` both
   ways), no shadow, no placeholder of its own, and **drawn above every sibling** whatever its place in the flow
   (green, the first child, covers blue and red: `02`, `04`).
3. **While its place in the flow hasn't changed it keeps the selection chrome** — outline, handles, size label, the
   parent's dashed box — even overlapping a neighbour for seconds (40.7–43.5 s: blue, the first child, dragged left
   into the padding, then right over green up to green's centre; `09`). The siblings don't move.
4. **The swap rule: the dragged layer takes a neighbour's place when its leading edge (the side it moves towards)
   passes that neighbour's centre** — not the pointer, not the dragged layer's centre. Measured on every swap:

   | t (s) | dragged | leading edge before → after | neighbour's centre | neighbour starts moving |
   |---|---|---|---|---|
   | 3.225 → 3.242 | green ↓ | bottom 480 → 514 | blue 494 | 3.242 |
   | 3.767 → 3.783 | green ↓ | bottom 638 → 684 | red 669 | 3.783 |
   | 14.808 → 14.825 | blue ↓ | bottom 472 → 510 | green 481 | 14.825 |
   | 35.142 → 35.167 | green ← | left 678 → 664 | red 672.5 | 35.167 |
   | 36.742 → 36.783 | blue → | right 661 → 695 | grey 672 | ≈ 36.77 |
   | 37.092 → 37.108 | blue → | right 800 → 891 | red 804.5 | 37.108 |

   The pointer-based rule fails on the 35 s drag (the pointer, 50 px inside the layer, passed red's centre 40 ms
   earlier with nothing moving) and the centre-based one on all of them. One swap per neighbour passed: a fast drag
   over two neighbours swaps twice (38.0–38.2 s).
5. **The siblings slide to their new places in ≈ 120 ms, easing out.** Progress of each sliding sibling per recorded
   frame (fraction of its 132–177 px trip): red at 37.1 s — 0.15, 0.33, 0.52, 0.77, 0.95, 1 at 17, 33, 58, 83, 100,
   125 ms; red at 3.8 s — 0.23, 0.42, 0.72, 0.85, 0.98, 1; blue at 3.24 s — 0.29, 0.52, 0.80, 0.99, 1; grey at
   36.8 s — 0.5, 0.67, 0.9, 1; green at 14.85 s — 0.42, 0.84, 1. Fitting all five (start time free within the frame
   before motion) best matches CSS `ease-out` (`cubic-bezier(0, 0, 0.58, 1)`) over 120 ms (squared error 0.032;
   ease-out-quad 130 ms 0.036, ease-out-cubic 170 ms 0.054, linear 90 ms 0.060). Each slide runs on its own timer
   from the moment of its swap; the dragged layer itself never animates.
6. **The slot travels; the frame keeps its size.** The space the dragged layer takes stays in the flow at its
   current place (a gap of its size between the siblings), so the Hug frame doesn't change (`260 × 449` throughout).
   **No insertion line**: the open gap is the indicator.
7. **The chrome goes at the first swap and stays gone until the drop** — outline, handles, size label and the
   parent's dashed box (`03`); back at its original place it doesn't return (44.5–47.5 s: blue to green's place and
   back). **The last child is the exception: its chrome goes on the first move**, before any swap (35.06 s and
   37.96 s, both the last of four; `06`) — every other drag of the recording (first, second and third children)
   kept it until the swap. (A quirk of Figma's, reproduced as seen.)
8. **The drop is instant**: the layer jumps from under the pointer into its slot in one frame (37.392 → 37.417 s,
   121 px; 38.933 → 38.950 s, 122 px; `05`, `08`), selected again with its chrome; siblings already at rest stay.
   The frame shows its hover outline while the pointer is over it.
9. **A rotated frame** reorders the same way in its own axes (31–50 s, rotated −90°: the vertical flow runs across
   the screen; the swap rule and the slides follow the frame's axis, the size label stays `181 Fill × 44`).
10. **Timing**: the drag starts with the first move (no hold delay: 2.94 s, 35.04 s); siblings at rest don't move
    while the pointer is still.

## Key frames

| file | t | shows |
|---|---|---|
| `autolayout-drag-01-pressed.png` | 2.88 s | green pressed: outline, handles, `181 Fill × 44`, Frame 406's dashed box |
| `autolayout-drag-02-moving-chrome-kept.png` | 3.10 s | green dragged over blue (bottom edge past blue's top, not its centre): chrome kept, blue still |
| `autolayout-drag-03-first-swap-chrome-hidden.png` | 3.30 s | the first swap: blue slid up, the chrome gone, green on top |
| `autolayout-drag-04-sibling-sliding.png` | 3.81 s | red half-way up (green's edge passed its centre), green drawn above it |
| `autolayout-drag-05-drop-instant.png` | 6.28 s | dropped: green in its slot at once, selected |
| `autolayout-drag-06-last-child-chrome-hidden-at-once.png` | 35.06 s | the last child's first move: chrome gone, nothing swapped |
| `autolayout-drag-07-rotated-sibling-sliding.png` | 36.83 s | rotated frame: grey sliding left behind blue |
| `autolayout-drag-08-rotated-drop.png` | 37.42 s | rotated frame: blue dropped at the end, selected; the frame's hover outline |
| `autolayout-drag-09-overlap-before-centre-no-swap.png` | 42.00 s | blue over half of green, its edge short of green's centre: no swap, chrome kept |

## Ours before this round (2026-10-10)

`tools/Gestures.cpp dragMove` / `updateInsertion` (engine.md §8.6 "Dragging inside auto layout"): the dragged layer
followed the pointer in its own paint order (under later siblings), the siblings never moved, a 2 px insertion line
marked the place found from the **pointer** against the siblings' centres, the outline and size label stayed (no
handles) through the whole drag, and the layer was placed on drop.

## As built (round 15, `r15-autolayout-drag`)

See docs/engine.md §8.6 "Dragging inside auto layout": the layer is reordered in the document as it crosses each
neighbour's centre with its leading edge (`layout/Reorder.h`), the frame lays out only its own flow on a swap, the
siblings' moves are drawn as 120 ms ease-out slides (their transforms written along the way, the end state laid out
exactly), the dragged layer draws above its siblings, the chrome follows finding 7, the drop places it at once; one
undo step. Unverified (not in the recording): wrapping frames (the row under the dragged layer's centre, then the
same edge rule in that row), a drag out of the frame (the siblings slide shut), a drag in from elsewhere and ⌥
copies (the insertion line, no space until the drop), several layers (as before), Esc (everything back at once).
