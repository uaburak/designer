# Performance round 16 — large files feel like Figma (2026-10-10)

The owner's report: stutter when moving component variants, slow opening, on files with many frames, images,
components / variants and nested auto layout. This round measured first, fixed the largest measured costs, and
measured again with the same build of the bench.

## How it was measured

- `scripts/engine-bench.mjs` on the owner's M-series Mac (16 GB), headless Chrome on the real GPU, 1440 × 900 CSS
  @2×, WebGPU (the app's backend; its frames have no GPU timer — one WebGL run below gives GPU times). One run at a
  time, ≤ 170 s each, memory checked before each (`memory_pressure` ≥ 25 % free); the browser closed after each.
- **The synthetic document grew what the owner's files have** (this round): 4 component sets of 24 variants
  (Size × State; each variant a hugging horizontal auto layout around an icon, a vertical auto-layout label of two
  texts and a nested Button instance), variant instances in every third card (1 080 of them at 20k), and every other
  screen a vertical auto-layout list (cards in flow, each card itself auto layout: nested flows). 20k → 20 719 stored
  nodes, 36 127 in the engine with instance sublayers; 5k → 5 653 / 9 721. No private file was used.
- **New scenarios** (`--only`): `variantMain` (a variant dragged inside its set — nothing selected first, so the press
  picks the variant, as a click does — and the whole set dragged), `flowDrag` (the live reorder of 3419a9e /
  bee477a: a card dragged down its vertical list through ~4 swaps; a card's first layer across its card — nested auto
  layout; each layer selected first), `selectMany` (every card of the lists selected and cleared, alternating; ⌘A and
  none). `--open` now lists every canvas render over 8 ms after the load with what it drew (content-cache regions,
  tiles).
- **Before** = the tree at `bee477a` (HEAD's sources and its committed wasm, the new bench copied in); **after** =
  this round. "Editor" runs are the real editor (`?editor`: panels, Layers, rulers) around the engine, driven by DOM
  events; it runs on Vite's dev server, so React is the development build (the shipped app's panels are faster;
  the before/after difference is what counts). Columns: *frame* = animation-frame interval, *input* = the pointer
  event's own handling, *+micro* = input plus the panels' synchronous re-render after it, *long* = long tasks (ms).
- Profiles: `--profile` with a scratch wasm linked `--profiling-funcs` (the release objects re-linked), which names the
  C++ frames.

## What the profiles showed

1. **Moving a variant (or its set) re-derived instances on every frame.** `Editor::markInstanceDirty` marked every
   instance depending on a changed source — and a main's root is a source of its instances, a component set of all
   its variants' instances (for its properties). A move writes the transform: every frame of the drag materialized
   the instances again (`flushInstances → finishLayouts → Layout::run`), and each `COMPONENTS_CHANGED` re-ran the
   Design panel's component reads (`PropertiesSection`: `usedPropertyIds` and `nestedInstancesOf` walk the
   subtree). Dragging the set: 16.9 ms of input and 34 ms with the panels per frame at 20k (30 fps), 54 instances
   re-derived per frame.
2. **Selecting many layers** spent its time in the Design panel: Selection colors read the whole selected subtree as
   JSON (`readInsideGroups`: 6 000+ rows written and decoded, to find out it is past its 5 000-row limit); the
   variable-mode rows asked the engine about every selected layer with a full `readNode` each, though no collection
   existed; More actions asked 8 commands whether they can run on every render.
3. **Opening**: every TEXT node was shaped twice (`Layout::natural → measureText → layoutText`, then
   `RenderTree::bound → textLayout → layoutText`: 175 + 160 ms at 20k), because any change to a text — the size the
   layout wrote after measuring — dropped its layout. After the first frame, ~22 whole-page redraws of ~17 ms came
   from the image write-back (`images.ts`: ThumbHash / tier fields written onto the paints, 50 paints a slice, each
   slice a system change spread over the page).
4. **Images arriving** drew the whole page and dropped every tile, whichever image it was (one raster per arrival).
   On this synthetic the warm full raster is ~17 ms, so it barely shows; on pages with many images (the owner's) each
   arrival was a full raster.
5. Pan, zoom, hover and the live reorder were already at 60 fps with sub-millisecond engine work; nothing there was
   worth changing (the Design panel re-renders its Position fields on each drag frame, as Figma's do).

## What changed

- **Engine — instances** (`editor/Instances.cpp markInstanceDirty`): a main's own place (its `kOwnFields`:
  transform, parent / position, lock, constraints, auto-layout child fields) is never what an instance takes; a
  component set is a source only for its properties and its name. Such changes re-derive nothing.
  `components.test.cpp` "dragging a main (a variant in its set) re-derives none of its instances" (a variant, an
  auto-layout variant with a nested instance, the set dragged, its look changed; a size or a rename still reaches
  the instances).
- **Engine — text** (`editor/Editor.cpp noteChange`, `TextEditing.cpp`): a text's cached layout survives a move,
  resize (the cache already compares the box), rename, reorder, opacity, effects; `measureText` in the box the text
  is drawn in keeps its layout as the drawn one (`keepTextLayout`). `text.edit.test.cpp` "text layouts: …".
- **Engine — images** (`render/Renderer.cpp`, `render/ImageCache.cpp`): `setPaint` notes which layers drew which
  image; the registry logs which images came since a generation; an arrival or failure damages only those layers
  (content cache and tiles), else everything as before. On a slow page, arrivals within 200 ms of a whole redraw they
  caused wait for one batch. `render.cache.test.cpp` "content cache: an image arriving draws again where its layers
  are; on a slow page arrivals come in batches".
- **Engine — reads**: `engine_read_nodes` takes `{"limit": n}`; Selection colors asks for one row past its limit.
- **Panels**: `PropertiesSection` keyed by the owner's id (a drag re-reads the selected node each frame; its subtree
  walks no longer run), its variant / nested-instance reads memoized, Create property's menu built on open;
  `ModeRows` returns at once without collections and stops at the first layer without an explicit mode, reading only
  `parentIndex`; More actions' items built when its menu opens (`MenuButton` takes `entries` as a function).
- **Images write-back**: 250 paints a slice (was 50): a page of 1 100 such paints writes in 5 slices, not 22.

## Before → after

### Editor, 20k synthetic (WebGPU, dev React)

| scenario | frame med / p95 | input med / p95 | +micro med / p95 | long tasks | instances re-derived |
|---|---|---|---|---|---|
| drag a variant in its set | 16.7 / 33.3 → 16.7 / 16.7 | 4.6 / 8.1 → 0.2 / 0.4 | 8.8 / 22.3 → 3.9 / 11.3 | 98 → 0 | `COMPONENTS` ×45 → 0 |
| drag the component set | 33.3 / 50.0 → 16.7 / 16.7 | 16.9 / 19.8 → 0.2 / 0.2 | 34.3 / 43.2 → 3.2 / 10.2 | 0 → 0 | ×53 → 0 |
| select 600 cards / none | 66.7 / 100 → 33.3 / 50.0 | 0.4 / 0.4 → 0.4 / 0.5 | 73.5 / 87.9 → 34.7 / 49.6 | 869 → 132 | |
| select all (⌘A) / none | 150 / 167 → 16.7 / 33.3 | 0.1 / 0.2 → 0.1 / 0.2 | 141 / 171 → 24.9 / 32.1 | 793 → 0 | |
| click to select (alternating) | 16.7 / 50.0 → 16.7 / 16.7 | 0.4 / 2.5 → 0.3 / 1.3 | | 65 → 0 | |
| flow: card down its list (live reorder) | 16.7 / 16.7 → 16.7 / 16.7 | 0.5 / 0.6 → 0.5 / 0.8 | 4.3 / 13.7 → 5.0 / 15.1 | 0 → 0 | |
| flow: nested, across a card | 16.7 / 16.7 → 16.7 / 16.7 | 0.5 / 0.5 → 0.5 / 0.6 | 2.6 / 6.5 → 3.1 / 7.9 | 0 → 0 | |
| drag variant instance (auto layout) | 16.7 / 16.7 → 16.7 / 16.7 | 0.2 / 0.4 → 0.2 / 0.3 | 4.9 / 15.8 → 3.8 / 12.5 | 0 → 0 | |
| click variant instance (auto) | 16.7 / 33.3 → 16.7 / 33.3 | 0.2 / 0.3 → 0.2 / 0.3 | 11.5 / 30.4 → 9.6 / 27.7 | 0 → 0 | |
| hover across the page (fit) / at 100 % | 16.7 / 16.7 both | 0.2 / 0.5 → 0.2 / 0.6; 0.2 / 0.3 → 0.1 / 0.2 | | 0 | |

(The flow rows are within run-to-run noise: that path was already fast. "click instance (auto layout)" showed one
60 ms long task in the after run, none before — nothing this round touches runs on that click; taken as noise.)

### Editor, 5k synthetic

| scenario | frame p95 | input med / p95 | +micro med / p95 | long |
|---|---|---|---|---|
| drag a variant in its set | 16.7 → 16.7 | 0.5 / 0.8 → 0.2 / 0.3 | 5.1 / 15.1 → 4.4 / 12.3 | 0 → 0 |
| drag the component set | 33.3 → 16.7 | 3.8 / 4.5 → 0.1 / 0.2 | 20.0 / 26.9 → 3.3 / 10.3 | 0 → 0 |
| select 403 cards / none | 83.3 → 50.0 | | 58.7 / 77.5 → 34.6 / 53.7 | 701 → 166 |
| select all (⌘A) / none | 50.0 → 33.3 | | 43.8 / 55.6 → 25.1 / 34.1 | 169 → 0 |

### Opening, 20k synthetic (`--open --no-strict`: the real EditorApp; times from page start on the dev server)

| | before | after |
|---|---|---|
| first canvas frame (CPU of that render) | 1617 ms (172 ms) | 1241 ms (61 ms) |
| chrome painted | 1814 ms | 1385 ms |
| images settled / frame painted | 2896 / 2926 ms | 1717 / 1755 ms |
| canvas renders > 8 ms after the load | 36, 765 ms in all (22 whole redraws for the write-back) | 15, 280 ms (5) |
| long tasks | 6, 987 ms | 5, 738 ms |
| wasm memory at the end | 238.8 MB | 198.9 MB |

`engine_load` itself is unchanged (326 → 275 ms, noise between runs: the page's derivation moved nothing); what
moved is the first frame (texts no longer shaped twice) and the redraws after it.

### Engine alone, 20k synthetic (no panels)

| scenario | CPU med / p95 before → after (WebGPU) | GPU med / p95 before → after (WebGL run) |
|---|---|---|
| rest (fit, redraw) | 0.4 / 0.7 → 0.5 / 0.6 | 1.4 / 2.5 → 3.0 / 3.0 |
| slow pan (fit) | 0.6 / 1.6 → 0.6 / 1.8 | 3.4 / 9.3 → 3.1 / 5.2 |
| fast pan (fit) | 0.8 / 3.4 → 0.8 / 4.4 | 3.3 / 6.9 → 4.3 / 8.2 |
| pinch zoom fit → 8× → fit | 1.0 / 4.3 → 1.1 / 4.3 | 3.5 / 8.2 → 1.9 / 8.6 |
| 100 % on the densest frame, pan | 0.2 / 0.5 → 0.3 / 1.3 | 2.8 / 5.4 → 4.5 / 5.1 |
| hover across the page (fit) | 0.5 / 1.9 → 0.5 / 1.6 | 3.1 / 3.1 → 2.2 / 3.2 |
| load: `engine_load` / first frame (fit) | 290 / 39.4 → 262 / 35.1 ms | |

All at 16.7 ms frames before and after (60 fps); differences are noise. Peak GPU process 0.83 → 0.89 GB (noise).

## Pixels

`npm run engine:shot` (WebGL, SwiftShader): 148 / 148 checks, and all 151 screenshots equal to `bee477a`'s pixel for
pixel (≤ 2 per channel). One check read the stats of the last frame, which after an image arrival is now a part of the
sheet; it reads them from a whole frame (a zoom step and back). `editor-shot` sections `components`, `components15`,
`aldrag`, `paints`: every check passes; their screenshots equal `bee477a`'s (one menu shot differed by a submenu's
hover timing in one run and was equal in the next).

## Regression guards

Engine tests (in `npm run engine:test`): the variant / set drag re-derives nothing, a text's layout survives a move
and a resize (one shaping), an image arrival damages only its layers and batches on a slow page. The bench scenarios
above are the timing gate (`variantMain`, `flowDrag`, `selectMany`, `--open`'s heavy renders); timings were left out
of the tests, being machine-dependent.

## Open

- Selection colors still reads the selected subtree as JSON (≈ 15 ms for 4 000 rows in dev): an engine-side summary
  (unique colours with their uses) would make large selections cheap.
- The Design panel re-renders whole on every drag frame (Position changes, legitimately; Icon and IconButton
  re-render too): memoizing sections that don't depend on geometry would trim ~1 ms a frame in production.
- Idle tile prefetch at rest on a slow page draws 12 ms (+ one tile) per quiet frame; WebGL's pinch zoom out still
  has one ~16 ms CPU frame (WebGPU 4 ms).
- The owner's real files were not measured this round (none on this machine); the synthetic grew their shapes.
