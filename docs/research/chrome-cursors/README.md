# Figma's canvas cursors

Captured 2026-10-23 from Figma desktop's cached web editor. `src/renderer/src/engine/cursors.ts` draws from this.

## Where the art is

Figma's canvas cursors are not CSS assets or images in the JS bundle. They are compiled resources inside the
fullscreen wasm (`static.figma.com/fullscreen/<build>/fullscreen-wasm/compiled_wasm.wasm.br`). The copy used here
comes from `~/Library/Application Support/Figma/DesktopProfile/v43/Cache`.

The wasm keeps 116 `cursor-*.svg` resources: a legacy set and a `-ui3` set. Each has an entry in a resource table that
is sorted by name. An entry is five u32s:

- the name's address;
- width and height;
- the data's address;
- the data's length, in words.

The data is the SVG compiled to a list of path commands. Each u32 opcode is one of:

| Opcode | Meaning |
|---|---|
| 0 | begin path |
| 1 | M x y |
| 2 | L x y |
| 3 | C x1 y1 x2 y2 x y |
| 4 | Z |
| 5 | fill RGBA |
| 6 | stroke RGBA width |

Every cursor is a white path (its edge) under a black one.

wasm-opt drops runs of zeros between data segments, so the resources are read from a rebuilt memory image.

The code that makes each cursor passes five constants in this order: the name, a 32 × 32 box, and the hot spot. So
the hot spots are Figma's own:

| Cursors | Hot spot |
|---|---|
| Arrow-based cursors | (4, 4) |
| Crosshair, hands, magnifiers, paint bucket, move | (16, 16) |
| Dropper, pencil, eraser, highlighter, stamp, comment pin | (8, 24) |
| Brush | (6, 6) |
| Link | (11, 8) |
| Shape builder | (5, 4) |

Resize, rotate, padding, scale and magic-handle are built by other code, which turns them to the handle's angle.
Wecra turns them about the box's middle (16, 16). The rotate picture as drawn is the top-right corner's.

`extract-figma-cursors.py` (this folder) reproduces the SVGs and hot spots from a `compiled_wasm.wasm`.

## In the repo

| Path | What it holds |
|---|---|
| `src/renderer/src/engine/cursorArt/svg/` | The UI3 set, plus the cursors that have no UI3 variant (brush, text-curve, vector-lasso, cut, shape builder, add-spec, link, megaphone, black-var-width). Decoded, not redrawn. |
| `src/renderer/src/engine/cursorArt/hotspots.json` | The hot spots. |
| `src/renderer/src/engine/cursorArt/figmaCursors.generated.ts` | Written by `npm run cursors`. |

Each `CursorKind` maps to one picture:

| Cursor kind | Picture |
|---|---|
| DEFAULT and SCALE | black-ui3 (Figma has no picture of its own for the Scale tool away from a handle) |
| HAND | hand-new-ui3 |
| GRABBING | hand-press-ui3 |
| CROSSHAIR (every drawing tool) | crosshair-ui3 |
| PEN | pen-ui3 |
| PEN_ADD | pen-insert-ui3 |
| PEN_REMOVE | pen-remove-ui3 |
| PEN_CLOSE | pen-snap-ui3 |
| MOVE_DUPLICATE | duplicate-ui3 |
| ZOOM_IN | zoom-in-ui3 |
| ZOOM_OUT | zoom-out-ui3 |
| EYEDROPPER | dropper-ui3 |
| NOT_ALLOWED | not-allowed-ui3 |
| COMMENT | comments-next-pin-ui3 |
| PENCIL | pencil-ui3 |
| BEND | bend-ui3 |
| PAINT_BUCKET | paint-bucket-ui3 |
| CUT | cut-open |
| LASSO | vector-lasso |
| BRUSH | brush |
| TEXT_PATH | text-curve |
| RESIZE | resize-ui3 |
| ROTATE | rotate-ui3 |
| SPACING | resize-padding-ui3 |

IBEAM stays the system I-beam, because Figma has no I-beam picture.

The other pictures have no engine event yet:

- snap, break and convert in vector edit;
- deep-parent;
- guide-delete;
- position-absolutely;
- edit-radius, edit-corners and edit-ratio;
- the Scale tool's resize-scale on handles;
- move-h and move-v;
- the Draw tools.

They are in the table for when the engine sends them.

Figma's art is for this personal app only. Do not redistribute it.
