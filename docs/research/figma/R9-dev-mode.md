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
