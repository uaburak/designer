# R9 — Dev Mode (Inspect), for the developer preview viewer

Research for `docs/data.md` §13 (2026-10-08, help.figma.com and Figma's forum). What is verified is marked with its source. **[unverified]** marks points no public page settles; they need a screenshot session in real Figma.

## Layout

- **Toggle.** Dev Mode is switched on from the toolbar or with ⇧D.
- **Left sidebar** ([Navigate designs in Dev Mode](https://help.figma.com/hc/en-us/articles/15023152204951-Navigate-designs-in-Dev-Mode)):
  - search, the pages list and the layers;
  - selecting a top-level frame makes the panel that frame's layers, and ← / → step through frames;
  - a "Ready for dev" view lists designs with a status ("Ready for dev", "Completed", "Changed"; [statuses](https://help.figma.com/hc/en-us/articles/26781702258583-Dev-Mode-statuses-and-notifications), [Ready for dev view](https://help.figma.com/hc/en-us/articles/23918228264855-Dev-Mode-ready-for-dev-view)).
- **Right sidebar, "Inspect" tab** (next to "Plugins"). The order with a layer selected, from the [Guide to Dev Mode](https://help.figma.com/hc/en-us/articles/15023124644247-Guide-to-Dev-Mode-in-Figma) items A–J:
  1. the layer's name and type, and when it was last updated;
  2. Compare changes;
  3. dev resources;
  4. component information: main component, variant and properties;
  5. component playground;
  6. Code Connect;
  7. layer properties: a box model for non-text layers or a typography preview for text, then code snippets grouped as layout, style and typography. A "Code" / "List" toggle switches between snippets and properties;
  8. styles and variables: "Selection colors", and variable details showing the name, collection, mode, value and alias chain;
  9. "Assets";
  10. "Export".
- **Code section** ([Use code snippets in Dev Mode](https://help.figma.com/hc/en-us/articles/15023202277399-Use-code-snippets-in-Dev-Mode)):
  - a language dropdown at the top right: CSS (px, rem), SwiftUI or UIKit (px, pt), Compose or XML (px, dp, sp);
  - "Copy" at each snippet's top right; ⇧-click copies all of them.
- **Nothing selected:** the language and unit defaults, and a "Variables" section with "Open variables table" ([Variables in Dev Mode](https://help.figma.com/hc/en-us/articles/27882809912471-Variables-in-Dev-Mode)).

## Measurements

- In Dev Mode, hovering a layer around the selection shows the distances or padding between the two, **with no modifier** ([Guide to inspecting](https://help.figma.com/hc/en-us/articles/22012921621015-Guide-to-inspecting)). Design mode needs ⌥ ([Measure distances](https://help.figma.com/hc/en-us/articles/360039956974-Measure-distances-between-layers)).
- Colours **[unverified]**: red lines with a red value label. Our viewer uses `--figma-color-bg-danger` (#F24822).

## CSS output

- Typography, verified from a real snippet [on the forum](https://forum.figma.com/ask-the-community-7/dev-mode-doesn-t-show-different-font-variants-extended-condensed-etc-41950):
  ```
  color: var(--rgb-353132, #231F20);
  font-family: "New Science";
  font-size: 24px;
  font-style: normal;
  font-weight: 700;
  line-height: 30px; /* 125% */
  ```
- Variables are written `var(--Name, fallback)`. A variable's Web code syntax replaces the generated name.
- Colours are uppercase hex, shortened when they can be (`#FFF`), and `rgba()` with alpha **[alpha form unverified]**.
- A text style's name is a comment above the typography.
- A frame's property order **[unverified, from memory]**: display, width, padding, flex-direction, align-items, gap, border-radius, border, background, box-shadow.
- SwiftUI and Compose **[unverified]**:
  - SwiftUI writes a `VStack(alignment:spacing:) { // Child views... }` stub, then `.padding`, `.frame`, `.background(Color(red:green:blue:))` and `.cornerRadius`.
  - Compose writes `Column(verticalArrangement = Arrangement.spacedBy(…), …, modifier = Modifier…) { // Child views. }`. The `// Child views.` comment is confirmed on the forum.

## Export

- The "Export" section adds settings with "+". Each has a scale (0.5x–4x, 512w, 512h) and a format (PNG, JPG, SVG, PDF), followed by "Export ‹layer›".
- "Assets" lists detected icons and images, each with "Source image file" or "Layer export".

## Round 5 check (2026-10-08, help.figma.com article text)

Articles: 15023124644247 Guide to Dev Mode (DMG), 15023202277399 code snippets (SNIP), 26781702258583 statuses (STAT), 20774752502935 annotations (ANN), 15023193382935 Compare changes (CMP), 22012921621015 Guide to inspecting (INSP).

- **Code / List** (DMG): "Use the toggle in the layer properties section to swap between Code (default) and List." List "displays a list of properties that are set for the layer and the corresponding values… You can click on the values to copy them".
- **Languages and units** (SNIP, DMG): "CSS (Web)", "SwiftUI or UIKit (iOS)", "Compose or XML (Android)". Units sit "under Settings in the dropdown menu" at its bottom: CSS "px" / "rem" ("1rem = 16px by default"), iOS "px" ("Canvas pixels") / "pt" ("Resolution-independent points"), Android "px" ("Physical screen pixels") / "dp" / "sp". "Set unit scale…" (from Inspect settings) opens a "Unit scale" modal: the root font size for rem, the scale factor for points / dp / sp. Which values Figma converts inside native snippets is unverified.
- **Assets** (DMG, INSP): "Dev Mode can automatically detect icons and present them as downloadable assets… in the Inspect tab above the export settings" (View › "Automatically detect icons"); images download as "Source image file" ("the original image… when it was first imported") or "Layer export" ("at its current layer size"); formats PNG, JPEG, SVG, PDF. The detection heuristic isn't published.
- **Statuses** (STAT): "Ready for dev" and "Completed" (Organization / Enterprise), plus an automatic "Changed"; set from Design or Dev Mode on a section, frame or component ("next to the label, click Mark as ready for dev"; components: above their top-right corner); the status menu has "Remove status", "Mark as completed", "Done with changes". Schema: `sectionStatusInfo.status` BUILD / COMPLETED.
- **Annotations** (ANN): Design's toolbar "Annotation" (⇧T) and "Measurement" (⇧M); a note with "+ Property"; categories "Development", "Interaction", "Accessibility", "Content" ("Edit categories…"); "In Dev Mode, annotations appear on the canvas as a green dot"; View › "Annotations" hides them.
- **Compare changes** (CMP): on a top-level frame or component in Inspect; a modal with version history, Layers (Edited / Added / Deleted), Side by side, Overlay, Compare code, Compare properties.

## Round 6 — annotations, measurements, Compare changes, statuses, Dev Mode in the editor (2026-10-08)

Sources: help.figma.com articles 20774752502935 (Annotate designs, ANN), 360041064174 (toolbar, TB), 22012921621015 (INSP), 15023193382935 (Compare changes, CMP), 26781702258583 (statuses, STAT), 23918228264855 (ready for dev view, RDV), 23919923330455 (focus view, FOC), 9771500257687 (sections, SEC), 15023124644247 (DMG); the plugin API at developers.figma.com (API); Figma's forum (FORUM, not authoritative). Encodings read from the owner's private file are marked FILE (structure only, nothing of its content committed).

### Annotations
- **Tool.** "Click **Annotation** in the toolbar or use the keyboard shortcut Shift T", in Design or Dev Mode (ANN). The toolbar's "Comment tools" menu holds Comment, Annotation and Measurement (TB). Select the layer, then "Write a note in the text field, or click **+ Property**" — text and properties in one note (ANN). The editor is an "annotation menu with options to add text, property, and category" (ANN, image alt text).
- **Pinned properties** stay live (the layer's current values) (ANN). The API's list (API AnnotationProperty): width, height, maxWidth, minWidth, maxHeight, minHeight, fills, strokes, effects, strokeWeight, cornerRadius, textStyleId, textAlignHorizontal, fontFamily, fontStyle, fontSize, fontWeight, lineHeight, letterSpacing, itemSpacing, padding, layoutMode, alignItems, opacity, mainComponent, the grid fields — the kiwi `AnnotationPropertyType` in the same order. Which are offered per layer type is **[unverified]** (ours: text → typography; auto layout → spacing, padding, layout; instances → main component; grids → grid fields; every layer → size, fills, strokes, effects, radius, opacity).
- **Markdown** (API "working with rich text"): paragraphs, `1.` / `-` / `*` lists, `##` headings (only H2), `**` / `__` bold, `*` / `_` italic, `~~`, `[text](url)`, inline code and code blocks.
- **Schema.** `Annotation {label 1, properties 2, labelV2 3, categoryId 4}`; the API exposes `label` (plain) and `labelMarkdown`. Which kiwi field holds the markdown is **[unverified]**: ours writes the markdown to `labelV2` and the plain text to `label`, and reads `labelV2`, else `label` (HTML from older files is shown as text).
- **Categories** (ANN): Development, Interaction, Accessibility, Content by default; "Edit categories…" in the category dropdown ("select a color and type in a name"); presets can be edited or deleted; per file. Colours (API AnnotationCategoryColor): yellow, orange, red, pink, violet, blue, teal, green. FILE: the DOCUMENT node holds `annotationCategories {version: 3, items: [{id: 2:0, preset: DEVELOPMENT}, {2:1 INTERACTION}, {2:2 ACCESSIBILITY}, {2:3 CONTENT}]}` — presets carry no colour or label in the file. The preset colours are **[unverified]**. "Filter by" (an annotation's right-click menu) picks one category or "All categories" (ANN).
- **Canvas.** "In Dev Mode, annotations appear on the canvas as a green dot", "Click an annotation to reveal its contents" (INSP). Labels are placed automatically and can't be dragged; several on one area "stack and bundle together" (FORUM, 2025–2026). The Design-mode card's look (leader line, colours, side) is **[unverified]**.
- **Show / hide**: View → Annotations (ANN); "All annotations … are visible in Dev Mode by default". ⇧Y toggles them per a user report (FORUM, unverified). Delete: click it, then Delete / Backspace (ANN). Instances don't inherit their main's annotations (FORUM).

### Measurements
- "Click **Measurement** in the toolbar or use the keyboard shortcut Shift M", hover a layer to see its start points, drag to the layer where it should end; "Click and drag the measurement so it doesn't cover the design"; "double-click on the measurement to customize its text"; Delete / Backspace removes it (ANN). Different from ⌥ hover measuring, which isn't saved (INSP).
- API (Measurement, MeasurementSide, MeasurementOffset): `{id, start: {node, side}, end: {node, side}, offset, freeText}`; sides TOP / RIGHT / BOTTOM / LEFT, both ends on one axis; offset `{type: INNER, relative: −1…1}` (along the edge from the start node's centre) or `{type: OUTER, fixed ≠ 0}` (outside the edge, the sign picks the side). Kept by the page (`page.getMeasurements()`). Kiwi: `AnnotationMeasurement {id, fromNode, toNode, fromNodeSide, toSameSide, innerOffsetRelative, outerOffsetFixed, toNodeStablePath, freeText}` in `NodeChange.measurements` (384) — ours on the CANVAS node, as the API's page methods suggest. The measurement colour is **[unverified]**.

### Compare changes (CMP)
- "Compare changes" in Inspect on a top-level frame or component; ⇧-click two components to compare them. A frame is compared with its version history; a detached component or an overridden instance with its main.
- The modal: (A) version history (saved and autosaved versions; a click compares one with the current), (B) "Layers" tagged "Edited", "Added", "Deleted" (a click zooms to it), (C) "Side by side" with zoom buttons, (D) "Overlay" (the current version over the chosen one, a transparency slider), (E) "Compare code" for an edited layer (language and units), (F) "Compare properties" (each property's previous and current value). From focus view's version history: "…" → "Compare to latest version".

### Statuses, ready for dev view, focus view
- STAT: "Ready for dev" on sections, frames and components; "Completed" (Organization / Enterprise); "Changed" is set automatically when a Ready or Completed design is modified and can't be set by hand. "Mark as ready for dev" sits next to the name label (components: above their top-right corner); clicking the status offers "Remove status" / "Mark as completed"; a Changed design: optionally a reason, then "Done with changes" (back to Ready). Not "Changed": library updates of instances, value changes of bound variables / styles, temporary changes.
- FILE: Figma keeps `editInfo {userId, lastEditedAt, createdAt}` (NodeChange 331, unix seconds) on edited nodes and their ancestors up to the page (every top-level node's `lastEditedAt` ≥ its descendants'; texts carry none), and `sectionStatusInfo.lastUpdateUnixTimestamp` when the status was set — a Ready design whose `lastEditedAt` is later shows "Changed". Ours does the same.
- RDV: "Ready for dev" in the left sidebar with a count (only when a design has a status); filters All / Ready / Completed; sort Recent activity / Pages / Name (A-Z); cards with the status top-right; a card opens focus view.
- FOC: "Show in focus view" / "Open in focus view"; upper left "See all ready for dev", upper right "Inspect on page", Mark as completed; the right panel has Inspect and the design's version history; the status menu has Show in focus view, "Copy link to focus view", Mark as completed, Remove status.
- The colours of the Ready / Changed labels are **[unverified]**.

### Dev Mode in the editor (DMG, TB)
- "Click the Dev Mode toggle in the toolbar or use the keyboard shortcut Shift D"; the toggle sits after the tools (TB). Left panel: designs marked ready with edit dates, then the layers; right panel: Inspect and Plugins tabs (Compare changes, Code / List, Assets, Export). Shortcuts listed for Dev Mode: ⇧D, ⇧T Annotate, ⇧M Measure, C Comment, ⌥ measure.
