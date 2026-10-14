# Wecra UI — polish log (2026-10-15)

Compared every screen (`node tools/ui-kit/shots.mjs` → `out/polish/<id>.png`: the app's capture above, the file
below) and every text layer's place against the capture (`node tools/ui-kit/diff.mjs`, `--components` against the
Gallery cells). Fixes are in `tools/ui-kit/polish.mjs` (one named fix each, in place, by id, guarded); a few one-offs
were made by hand through the same MCP calls and are listed here.

## Everywhere (component level unless noted)

- **Per-side borders invisible** (`sideStrokes`): 330 layers with a border on some sides only (panel and section
  dividers, rail / left / right panel edges, list headers, title bars) had strokeWeight 0, which the renderer skips.
  Now 1 px. Every editor screen got its panel dividers back.
- **Inset borders invisible** (`insetBorders`): 97 `box-shadow: inset 0 0 0 1px` borders had become spread-only inner
  shadows the renderer leaves out (Select, secondary Button, TextInput, SegmentedControl, Checkbox, FileCard, …):
  now an inside stroke of that weight, bound to its colour variable (border/border, app/border-translucent, …).
- **Layer rows at the wrong depth** (`layerRowsLayout` + `layerRows`): the Gallery's depth-1/2 rows stood for the
  screens' depth-0 rows, 24 px too far in, and an instance can't move its layers. Each 32-px LayerRow variant's box is
  now the app's flex row (padding-left = inset + depth × 24, glyph + 8, name fills, selection background and
  lock / eye cells absolute); each screen row sets its depth as the box's left padding (101 rows).
- **Field texts 4 px high** (`fieldTexts`): input values (NumericInput, ColorInput, SearchField, ColorPicker) centre
  their line; the X / Y / W / H labels are their 24 × 24 span with the letter centred.
- **Colour fields** (`colorInputs`): the opacity part kept to the right edge (it stayed at the Gallery's 184-px place
  in the 156-px paint rows, "100 %" 28 px too far right).
- **Swatches**: the 1-px translucent ring (`.swatch::after`) added to the Swatch mains — light colours (F5F5F5, FFFFFF)
  show their square again.
- **Avatar under its chevron**: the account MenuButton's avatar is above the chevron pill again ("BK" was cut).
- **Truncated labels** (`hugTruncation`): browser-hugged boxes (fractional widths) are 1 px wider, so "Desktop",
  "Present in this tab", menu items no longer end in "…".
- **Dialog / popover colours** (`onWarning`): texts and icons in Settings, Share, Actions, the colour picker, Tabs
  and Select were bound to text/icon *on warning* (black in Dark too); now text/text, text-secondary, -tertiary,
  icon/icon, icon-secondary, -tertiary.

## Per screen

- **Home — grid / list / folder / trash / team menu / sort menu, Settings dialog** (`sidebarTree`): Trash came before
  the folder tree; it is after it again, and Client work / Personal are 20 px in under All folders (chevron shows).
  Grid: both file cards show the capture's thumbnails (`pictures`).
- **Editor — page, frame, shape, prototype, assets, agents, tools, brands, draw, dev; all menus and popovers**: panel
  dividers, layer row depths, field texts, paint rows, swatches, avatar (above).
- **Editor — brands**: EmptyState "panel" variant is now a vertical auto layout like the others (the description
  wraps at the panel's width, the button 12 px below it — a 4-px spacer).
- **Editor — dev**: Compare changes button full width; layout box dashed; code blocks in Menlo (monospace) with the
  copy button at the right edge (CodeBlock main); "Export Desktop" space; "640 × 420" spacing.
- **Editor — draw**: layer thumbnails are the capture's pictures (Ring and Outside stroke showed Rotated's).
- **Settings dialog**: "Enable libraries for all files…" space.
- **Share dialog**: title colour.

## Left as is

- Icon colours on some instances show the default colour (folders black instead of blue/green, star black instead of
  yellow, some secondary icons dark): the known 1.3.1 bug (b), colour overrides lost when the Icons mode switches —
  being fixed in the engine.
- 1–3 px: section titles 1 px low (title span padding), Breadcrumb "/" 3 px, KeyCap glyphs in the shortcuts panel
  a few px off-centre, TextArea / Tooltip multi-line metrics.
- Home grid: the first card uses the "hover" variant (blue outline) — part of the atomic restructure.
