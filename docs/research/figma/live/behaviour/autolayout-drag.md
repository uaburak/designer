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
same edge rule in that row), a drag out of the frame, a drag in from elsewhere and ⌥ copies, several layers, Esc —
the first three seen in round 2 (below), which changed the drag out (no slides).

## Round 2 — out, in, ⌥-copies (2026-10-10)

Source: the owner's second recording of live Figma (desktop app), 58.9 s, 2140 × 1682 px (a Retina screen: 2 video
px per CSS px), ≈ 55 fps, read the same way (AVFoundation, zero tolerance: contact sheets every 200 ms, every recorded
frame around each event, pixels probed along rows and columns). The file: **Frame 4883**, a vertical auto-layout
frame, Hug, clipping its content, zoomed in (≈ 3.7 CSS px per design px), holding two, then three, then four `54 × 27`
rectangles (grey `D9D9D9`, one filled `E30613` at 30 s, one `F5F5F5`); a red "Button" instance below it on the page.
The cursor tells an ⌥-drag (the duplicate arrow) from a move. Key frames: `img/autolayout-drag-r2-*.png` (half size,
the canvas only).

Timeline: 2.0–8.5 s ⌥-copy of the first layer — inside its frame, out to the right, back; 9–13.4 s ⌥-copy again, out
left and back, dropped between the two (three layers now); 15.5–16.2 s ⌥-copy of the first out to the left, dropped on
the page; 17.2–19.8 s that copy dragged in from the page, dropped at the end; 20.9–22.0 s the third dragged out, dropped
on the page; 22.6–23.0 s dragged back in, dropped in the middle; 24.1–25.0 s dragged out again; 29–31 s the first one's
fill set to red; 34.0–34.4 s red dragged out to the left; 35.5–36.0 s dragged back in from the page; 37.0–40.5 s an
⌥-copy of red dropped at the end (four layers). Not in the recording: several layers at once, Esc, a wrapping frame,
⇧ / ⌘ / Space during a drag, a drag from one auto-layout frame straight into another.

### Findings

11. **⌥-drag copies: the original stays in its place, the copy is a ghost.** Over an auto-layout frame (its own
    included) the copy is drawn at **30 % opacity** (probed: `E30613` over `F5F5F5` → `239,174,175`, over white
    `247,180,184`, over `D9D9D9` `220,155,159`: α ≈ 0.30 in every channel) over everything, **not clipped** by the frame
    (`r2-01`, `r2-06`), the frame's other layers don't move (no slot opens, the Hug frame keeps its size), and a
    **2 px insertion line** in the selection blue marks where it will go — across the frame's content box, half-way
    between the two layers around it (above the first when it goes first). Its chrome (outline, handles, size label)
    is gone. Off the frame, on the page, the copy is **opaque** with the smart guides and their distance pills (red),
    still without its chrome (`r2-02`); back over the frame it is a ghost again. Dropped: in at the line at once, the
    frame grows, the copy selected (13.4 s, 40.5 s).
12. **Over a target auto-layout frame**: the frame is outlined **2 px** in the selection blue (probed: 4 device px) and
    each layer of its flow **1 px**, faint (`r2-03`, `r2-06`). The line is the only indicator of the place.
13. **A layer dragged in from the page** (a move, not a copy: 17.2 s, 22.6 s, 35.5 s) is the same ghost: 30 %, over
    everything, the line, the frame and its layers outlined, nothing moving until the drop (`r2-03`, `r2-06`); the drop
    is instant (19.8 s, 23.0 s, 36.0 s).
14. **Dragged out of its own frame**: while the pointer is inside the frame the layer is still its child — it keeps
    its slot (the gap stays), it is **clipped by the frame** where it pokes out, and its chrome stays (34.0–34.27 s,
    `r2-04`: outline and `54 Fill × 27` drawn past the frame's edge, the red only inside it). **The frame the pointer
    is over decides**: the first frame with the pointer off the frame (34.29 s, 24.50 s, 21.02 s) the layer is the
    page's — drawn whole and opaque over it, without chrome — and **the others close up at once and the Hug frame
    shrinks at once**: no slide (34.27 → 34.29 s, one recorded frame, `r2-05`; the 21.0 s and 24.5 s frames show
    Figma's canvas re-rendering, then the closed state).
15. **Out of auto layout it keeps its size, fixed**: on the page the panel shows `W 54` (no Fill), and dragged back in
    it is `54 × 27`, not `54 Fill × 27` (`r2-07`, 36.1 s; 19.8 s).
16. **No hold delay, no animation on the drop** for any of these; the frame shows its hover outline after a drop while
    the pointer is over it (as round 1).

Live Figma in the built-in browser could not be used this round: the tab was signed out (a view-only file with
"Sign up to comment, edit…"), so nothing could be dragged there. Several layers at once, Esc, wrapping frames and the
modifiers stay unverified; their behaviour below is inferred.

### As built (round 15, round 2: `r15-autolayout-drag-2`)

See docs/engine.md §8.6. Verified on the recording: findings 11–16 (the 30 % ghost drawn over everything and
unclipped — `Overlay::ghosts`, `Renderer::drawGhosts`; the frame 2 px and its flow's layers 1 px at 37 % — `dropFrame`;
the 2 px line; no chrome while out or a ghost; out of the frame the others close up and the frame hugs at once, no
slides; Fill / stretch dropped when it lands outside auto layout). Inferred: a layer that left its frame and comes back
in the same drag is a layer from elsewhere (the line, no slot); several layers of one flow move as one block by the
owner's rule ("the same logic as one"): one slot, in their order, the block's leading edge against the neighbours'
centres (a selection with others between it comes together at its first swap); Esc puts everything back (copies gone);
⇧ keeps the axis, Space keeps the parent, ⌘ nests (as any move).
