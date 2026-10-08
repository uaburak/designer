# R9 — Grid auto layout (Figma's "grid" flow)

Researched 2026-10-08 for round 5 (layout + GRID editing). Sources: help article "Use the grid auto layout flow"
(help.figma.com/hc/en-us/articles/31289469907863), "Guide to auto layout" (…/360040451373), Plugin API reference and
Update 120 (developers.figma.com, 2025-11-06), forum post "Do more with grid" (forum.figma.com, 2026-05-22). Short
quoted strings are verbatim; longer sentences are paraphrases. What couldn't be verified is listed at the end.

## Design panel (Auto layout section)
- Flow: "Vertical", "Horizontal", "Grid" ("Wrap" only for horizontal / vertical). Grid has no wrap; items sit in cells
  and may span.
- Rows × columns: the **grid picker** — two fields "Number of columns" and "Number of rows" plus a visual selector.
  "Number of rows" defaults to `auto` (rows come and go with the content; empty rows are removed). Math works in the
  fields. Lowering a count keeps the objects and moves them to the nearest cells.
- Gaps: "Gap between rows", "Gap between columns" (no "Auto" gap in a grid). Bindable to variables (plugin API
  `gridRowGap` / `gridColumnGap`; kiwi `GRID_ROW_GAP` / `GRID_COLUMN_GAP`).
- Padding and container sizing as for the other flows (Fixed / Hug / Fill). A grid made in Figma Design: the
  container and every row and column Hug (Update 120); a plugin's new grid: FIXED with FLEX tracks.
- "Toggle automatic positioning" (on by default): items fill empty cells in layer order, left to right, top to bottom;
  content shifts to fill gaps when items are deleted. Off: items keep their cells, empty cells stay. Turning it back on
  sets "Number of rows" to Auto.

## Tracks
- On canvas: hover the grid's top / left edge — "the blue pill" per track; its label shows the size ("1fr", "120",
  "Hug"). Click the label to edit; "Use the dropdowns to select a resizing option" (Fixed / Fill container in fr / Hug
  contents) or type a value; "Auto" or "A" = Fill 1fr. Dragging a track edge makes it Fixed.
- Select several tracks with ⌘ / ⇧. Reorder: "Click and hold the grabber icon next to the label" and drag (a blue
  line shows the drop; tracks a spanning item covers move with it). Delete: select the label, ⌫ (its contents go;
  spanning items shrink).
- fr: a track's share is its fr over the axis's total. FLEX tracks are invalid on an axis whose container hugs.

## Items
- Create objects directly in a cell; drag layers into a cell or between cells; arrow keys reorder; ⌘D duplicates.
  Two items spanning the same number of cells swap when dragged by their pink circles.
- Span: the item must be "Fill container"; drag its edge handles (small circles) to a cell edge, or the fields
  "Column span" / "Row span".
- Alignment within the cell: the Position section's align buttons, each item to its own cell. `gridChildHorizontalAlign`
  / `gridChildVerticalAlign`: MIN / CENTER / MAX / AUTO ("the default alignment").

## Plugin API (the model's rules)
- `layoutMode: 'GRID'`; `gridRowCount` / `gridColumnCount` ≥ 1 (new tracks FLEX; shrinking past children throws);
  `gridAutoTracks: 'NONE' | 'ROWS'`; `gridItemsPositioning: 'MANUAL' | 'ROW_AUTO_FLOW'` (row-major like CSS);
  `gridRowSizes` / `gridColumnSizes: {type: 'FLEX' | 'FIXED' | 'HUG', value?}` (HUG = `fit-content(100%)`);
  `gridRowSpan` / `gridColumnSpan` (overlap or overflow throws); `setGridChildPosition(row, col)`, `appendChildAt`,
  `reorderRows` / `reorderColumns({fromIndices, insertionIndex})`.

## Not verified
Exact flow-button tooltips, the track dropdown's item wording, an on-canvas "+" for tracks (none documented), a maximum
track count, a "Grid settings" popover.

## As Figma lays its files out (measured on a large private file, round 5)
- Items that fill a row's height (`stackChildAlignSelf: STRETCH`) don't size a Hug row; a Hug row nothing sizes takes
  the free height, and a frame whose Hug rows nothing sizes keeps its height. Items that fill a column's width still
  size a Hug column (component sets' variant grids).

## Round 6 — on-canvas editing (re-checked 2026-10-08)
Sources: H = help "Use the grid auto layout flow" (help.figma.com/hc/en-us/articles/31289469907863); F1 = forum Config
2025 grid thread (staff replies); F2 = forum "Grid update: hug and fractional units" (2025-12-03); F3 = forum "Do more
with grid" (2026-05-22, GA); Plugin API `GridTrackSize`, `gridAutoTracks`, `gridRowCount`, `gridItemsPositioning`,
`reorderRows` / `reorderColumns`, Updates 120 and 127.
- **Pills**: with the grid selected, hover its top / left side "until the blue pill appears"; the pill's label shows
  the size or resizing property. "Select the label", then type a value or "Use the dropdowns to select a resizing
  option" (Fixed / Fill container / Hug contents); "Auto" / "A" = Fill 1fr. Enter on a selected track edits its size
  (forum). Exact dropdown wording, Esc: unverified.
- **Resize**: "manually resize tracks by clicking and dragging their edges" → that track turns Fixed on its axis.
  Which edge, snapping, minimum: undocumented (built: the trailing edge between two tracks, whole px, ≥ 1 px).
- **Reorder** (GA 2026-05-22): "Click and hold the grabber icon next to the label" and drag; a blue line marks the
  drop; objects spanning into the track move with it (API: spanned tracks join the move).
- **Several tracks**: ⌘ / Ctrl adds a track, ⇧ selects a range; then one value for all, on canvas or in the panel's
  track list. Delete / Backspace on a selected label deletes the track(s) and their contents; items spanning it shrink.
  No documented "+" or insert-before / after (a Feb 2026 forum post says inserting mid-grid isn't possible).
- **Span handles**: the item must be Fill container; "small circles on the sides, top, and bottom" — resize to a
  cell edge (snaps; that axis becomes Fill). Two items spanning the same number of cells swap when their "pink
  circles" are dragged.
- **Grid picker**: clicking the rows × columns control opens "Number of columns", "Number of rows" and "the
  interactive selector" (hover a cell to preview, click to set). Its size is undocumented (a user: "a max of 12
  columns"; built 12 × 12, unverified).
- **Auto rows**: "By default, Number of rows is set to auto"; empty rows go, rows come with content
  (`gridAutoTracks: 'ROWS'`; setting a row count in that mode throws in the API). Turning automatic positioning back on
  sets it to Auto.
- Keys: arrows reorder items, ⌘D duplicates, ⌘ / ⇧ click selects tracks, ⌫ deletes the selected tracks.
