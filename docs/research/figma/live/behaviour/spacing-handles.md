# Behaviour — auto layout's padding and gap handles on the canvas, and the `</>` button

Sources: the owner's phone video of live Figma (desktop app, Design mode, 2026-10-10, 34.7 s, 2160 × 3840 portrait at
25 fps, filmed off the screen), read with AVFoundation (`AVAssetImageGenerator`, zero tolerance) every 1 s for the
overview, every 200 ms through each hover and drag and every 40 ms (each recorded frame) round the release at 15.5 s;
the owner's screenshots 47.png (the `</>` hovered, its tooltip), 48.png (bottom padding hovered), 49.png (a gap
hovered), 2× Retina, sampled pixel by pixel; help.figma.com "Explore auto layout properties" (keyboard shortcuts "From
the canvas"). Scale in the video: the 16 px badge is ≈ 94 video px tall, so ≈ 5.9 video px per CSS px (the canvas at
≈ 370 %). Key frames (cropped, 600 px) are in `img/spacing/`.

The file: **Frame 4883**, a vertical auto-layout frame `82 × 99 Hug` (later 103), two grey rectangles Fill × 64, padding
18 left / right, 16 / 17 top / bottom, gap 10.

## Findings

1. **Handles only while the pointer is over the selected frame** (16–19 s: the pointer off the frame, no bars; back
   on it, all of them). A bar in the middle of each padding — top and bottom ones run across, left and right ones down
   — in the selection blue, and a pink one in the middle of each gap (`01`, 49.png). Measured on 49.png at 2×: 12 px
   long, **1 px across, on a 0.5 px white rim** (the pixels round the pink line are white, `fffeff`, on all four
   sides).
2. **The padding or gap under the pointer is hatched** — anywhere in it, not only on its bar (`02`, `04`): a light wash
   of its colour and thin "/" stripes (rising to the right on screen). Sampled on 48 / 49.png against their own badge
   colours: wash ≈ 5–6 %, stripes ≈ 25–30 % at their middle, ≈ 1 px across, **6.5 px apart along a row** (13 device
   px), both colours alike. The hatch comes and goes from one recorded frame to the next (15.48 → 15.52 → 15.64 s): no
   fade. On a layer: no hatch. A turned frame's padding is hatched too (`11`).
3. **The value shows only when the pointer is on the bar** — then the cursor changes and a badge of the bar's colour
   hangs **right of and above the pointer**: its left ≈ 10 px right of the pointer's hot spot, its bottom ≈ 10 px above
   it (measured on 7 frames, hover and drag, 9–11 px either way). In the hatch off the bar the arrow stays and no badge
   shows (`02`: the pointer ~17 px from the bar). The same rule for gaps (`05`).
4. **The cursor over a bar and while dragging it**: a thin black double arrow along the drag with a short bar across
   its middle, white edged (`01`: left / right paddings and the gaps of a column frame… the gap cursor in `05` is the
   up-down one). Not the resize double arrow.
5. **Dragging a padding** (4.4–6.2 s, 13.4–15.4 s): the value follows the pointer 1 : 1 in design px (18 → 36 over
   18 px of pointer travel at 370 %); **every other bar and the hatch go**, the dragged padding is outlined 1 px in its
   colour (the frame's edge and a line at the content's edge, `03`); the badge rides with the pointer. A Fixed-width
   frame keeps its width, its Fill layers narrow. The size badge keeps reading `82 × 99 Hug`. The release brings the
   hover back (hatch, bars).
6. **Dragging a gap** (7.8–11 s): the gap's middle stays under the pointer (the gap grows twice the pointer's travel
   for the first gap in a Hug frame: 10 → 26 over ≈ 7 px), the gap is outlined 1 px pink (no hatch), the others gone;
   **negative values** (2 → −3 → −4 → −16): the layers overlap and the outline is the overlap; 0 is a single line
   (`06`, `07`). The size badge follows (`82 × 91 Hug` …).
7. **Modifiers** (not in the video; help.figma.com "From the canvas"): while dragging on-canvas handles ⌥ sets the
   opposite padding too, ⌥⇧ all four, ⇧ moves in big-nudge steps; ⌥-click a padding area to type the value of the
   opposite sides, ⌥⇧-click for all sides. A click on a handle types its value (help.figma.com and third-party
   guides; the video has no click).
8. **The `</>` button** (17–25 s, 47.png): a selected top-level frame's `</>` fills on hover — a **16 × 16 rounded
   square (radius ≈ 4) of the selection blue behind the white glyph** (`08`; 47.png: x 370–386.5 at 2×, its right edge
   ≈ 1 px past the frame's, centred on the glyph); after a delay a dark tooltip **"Mark as ready for dev"** under it,
   its arrow up at the button (47.png: 132 × 24, Inter 11 white on `#1e1e1e`, 8 px in from each end, the arrow's tip on
   the button's bottom edge). It doesn't show within the ~1 s of hover in the video, so the delay is at least the
   app's tooltip delay (we use 500 ms). A click marks the frame ready for dev: the button turns **green** (white
   glyph), and hovered shows **"•••"**; a click on it opens **Open in Dev Mode / Copy link / — / Remove status**
   (`09`); Remove status brings the plain `</>` back. No "Ready for dev" chip after the name in Design mode.
9. **A turned frame** (26–34 s): the name along its top edge, the `</>` at the right end of that edge turned with it
   (`10`), the W × H badge along the bottom edge; the padding / gap bars and hatch turned with the frame (`11`). The
   hatch's stripes look steeper than 45° on the turned frame in the video — the phone's angle makes it unclear whether
   they turn with the frame; we keep them fixed on screen.

## Not seen (unverified)

- Which handles show at small zoom: nothing in the video zooms out. We show none on a frame smaller than 24 px on screen.
- The handle's exact hit area (the pointer on the bar takes it, ~17 px away doesn't): 4 px past its ends, 5 px either
  side.
- Typing a value: no click on a bar in the video; the field opens where the badge is.
- The tooltip's delay, the "•••" button's own tooltip, Copy link (we have no links before multiplayer: off).
- An Auto (space between) gap's badge: "Auto" (the Design panel's wording).
