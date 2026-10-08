# Live Figma captures (2026-10-08)

Reference captures of the real Figma web app (Design mode, UI3, dark theme), taken in the owner's own
Drafts file "Untitled" on a page named **Capture**. The fixtures were built with Figma's plugin API from
the devtools console (`window.figma` exists in the editor page). They are: a plain frame with a child,
vertical, horizontal and wrap auto layout, a 3×2 **grid** auto layout, group, section, rectangle,
ellipse, polygon, star, line, arrow, vector, boolean, text, image fill, the `Button` component (boolean,
text and instance-swap properties), the `Chip` component set (`State=Default/Hover/Pressed`), instances,
a nested instance inside `Card`, a fixed auto-layout parent with children, and a variable collection
`Tokens` (Light/Dark).

## How the captures were made

* **`*.txt` (DOM dumps).** These were recorded with the injected helpers in
  `scratchpad/figma-dump.js`. Each line has the shape
  `x,y wxh` (relative to the container) + text `"…" font-size/weight colour`, or
  `element [aria-label / tooltip]` with `bg=`, `r=` (radius) and CHECKED / SELECTED / DISABLED /
  EXPANDED. Colours are hex `#rrggbb[aa]`. A line starting with `@x,y wxh` is an open popup at its
  absolute position. The first line of every file says how the state was produced.
  * Every capture was taken at a **1440×900** viewport. Captures from the late batches check the size
    before and after and are stamped `[viewport 1440x900]`. For the rest, the browser tool reported
    the 1440×900 emulation as active.
  * Files with `RIGHT` / `LEFT` sections hold the full Design panel (`properties_panel--scrollOuterContainer`)
    and the full left panel. Rows above or below the scroll fold are included, and hidden dropdown
    options show up with negative y.
* **`img/` (screenshots).** The canvas is WebGL, so canvas visuals are screenshots.
  * Images named `canvas-*` were taken in the pane's natural size, with **View › Show/Hide UI** turned
    on and the Figma canvas zoomed in. That gives the highest resolution.
  * Images with `full-ui` or `1440` in the name show the full 1440×900 UI and are lower resolution.

## Key facts (what a clone must match)

### Design panel structure (UI3, panel width 240)

* **Nothing selected:** the panel shows Page (canvas colour `1E1E1E` with a 100% field and a visibility
  toggle), Styles, Export and **MCP** ("1 connection").
* **Header:** a type name with a dropdown (`Frame ▾` opens Frame Layout Options plus the device
  presets), then contextual icon buttons:
  * Create component
  * Union with a Boolean operations chevron
  * Edit object
  * Toggle ready for dev status (`</>`)
  * More actions
* **Section order by selection type:**
  * **Frame:** Position › Layout › Appearance › Fill › Stroke › Effects › Selection colors ›
    Layout guide › Export.
  * **Auto layout:** the same as Frame, with "Layout" replaced by **"Auto layout"**.
  * **Shapes:** Position › Layout › Appearance › Fill › Stroke › Effects › Export.
  * **Text:** adds **Typography** after Appearance.
  * **Component and component set:** start with **Properties**.
  * **Instance:** starts with the component name dropdown, a "From this file" row and its property
    controls (boolean toggle, text field, instance-swap button `◇ Star ▾`).
* **Section contents:**
  * **Position:** Alignment (6 buttons in 2 groups, plus a distribute button for multi-selection), X/Y
    fields, then Rotation with rotate-90 and flip H/V buttons.
    * A child inside a plain frame gets a **Constraints** toggle at the end of the X/Y row. It expands
      an inline row with two dropdowns (Left/Right/Left + Right/Center/Scale and
      Top/Bottom/Top + Bottom/Center/Scale) and the constraint widget.
    * An auto-layout child gets an "absolute position" icon there instead, and X/Y are disabled.
  * **Layout / Auto layout:**
    * **Flow:** a 4-way segmented control (Freeform, Vertical, Horizontal, Grid), plus a separate
      Wrap toggle for horizontal.
    * **Resizing / Dimensions:** W and H fields, each with a hover chevron menu (Fixed width (n),
      Hug contents, Fill container for children, Add min width…, Add max width…), plus
      Lock aspect ratio.
    * **Alignment:** a 9-dot grid.
    * **Gap:** a chevron menu with the value or Auto.
    * **Padding:** H and V fields, with Individual padding for 4 fields.
    * Clip content.
    * Rectangles also get a "Layout" section showing Flow and Dimensions.
  * **Grid auto layout panel:**
    * Grid: a 3 × 2 preview button that opens the **grid dimensions picker**. This is a 12-column
      matrix of cells with a hover tooltip such as "4 × 3", plus Columns/Rows inputs and an
      "Open grid settings" button.
    * Gap: separate column and row gap fields.
    * The Auto layout settings popover holds Inside stroke Included/Excluded, Layout **"Updated"**
      (a layout-version setting) and a Preview.
    * A grid child shows **Column span** and **Row span** in Layout.
  * **Appearance:** Opacity, Corner radius with an individual-corners toggle, a visibility eye and the
    blend mode menu (Pass through, Normal, Darken…Luminosity, grouped like Figma's 6 groups).

### Popovers

* **Fill picker:**
  * Tabs: **Custom / Libraries**, with + and ✕.
  * Paint types (radio buttons with tooltips): **Solid, Gradient, Pattern, Image, Video, Shader**.
    The Shader tab shows "Shader fills (Beta)": Moving gradient, Mesh gradient, Nebula, Water
    caustic and more, plus "Create new" with AI.
  * Gradient shows a type dropdown ("Linear"), the gradient bar and a Stops list. The dropdown's options were not captured: `fill-picker-gradient-type-menu.txt` caught the Shader tab instead.
  * The Hex/format menu and the swatches "On this page" are also in the picker.
* **Stroke:**
  * The advanced settings popover offers **Stroke Type Basic / Dynamic / Brush**, a width profile,
    Join (Miter/Bevel/Round) and Miter angle.
  * The position menu offers Center/Inside/Outside.
  * The individual strokes menu offers All/Top/Bottom/Left/Right/Custom.
* **Effects:**
  * **The Effects "+" now opens a "Shader effects (Beta)" browser.** It lists about 25 shader presets
    and "Create new" with AI. It does not add a Drop shadow directly.
  * Clicking an existing effect row opens its settings. The type dropdown offers **Inner shadow, Drop
    shadow, Layer blur, Background blur, Noise, Texture, Glass, Shader**.
  * The blurs have Uniform/Progressive.
  * Noise has Mono/Duo/Multi.
  * Glass has Light, Refraction, Depth, Dispersion, Frost and Splay.
* **Typography:**
  * The type settings popover has tabs **Basics / Details / Variable**, with a preview.
  * The font picker has search and a filter: All fonts, In this file, Popular fonts, Google fonts,
    Variable fonts, Uploaded by you, Installed by you.
  * The font size menu offers 10…128.
* **Export:** formats PNG/JPEG/SVG/PDF. Advanced settings: Suffix, Color profile, Image resampling,
  Ignore overlapping layers.
* **Layout guide:** types Grid/Columns/Rows. Columns has Count, Color, Type (Stretch), Width, Margin and
  Gutter.
* **Components:**
  * The Create property menu offers Variant, Text, Boolean, Instance swap, **Slot**, and "Expose
    properties from: Nested instances".
  * The Slot popover has Name, Description, Minimum/Maximum layers, Only allow preferred instances,
    "By default, display empty slot", "By default, fill items on slot's counter axis" and Preferred
    instances.
  * Component configuration holds a Description (rich text) and a Link.

### Grid on canvas (see `img/canvas-grid-*`)

* **Selected grid frame:** light-blue cell outlines, mid-edge padding bars, frame label and `</>` at the
  top right, size label below.
* **Track pills:**
  * Hovering a column shows a compact pill above that column. Hovering a row shows a vertical pill left
    of that row.
  * Hovering the pill expands it to `||| 1fr ▾` (or `☰ 1fr ▾` for rows) and outlines the track in blue.
  * Clicking the pill **selects the track**: its empty cells fill light blue and the frame outline
    turns dashed.
  * The pill's chevron opens **Fixed height (84) / Hug contents / ✓ Fill container (1fr)**.
* **While a track is selected, the Design panel is replaced by a "Grid" panel:** Columns and Rows lists
  with an index, a sizing type (`Fill`), a value (`1fr`), + and remove buttons, and ✕ to close
  (`grid/row-track-selected-panel.txt`).
* **Gaps:** hovering a gap shows pink gap bars between tracks.

### Other canvas visuals

* **Selection:**
  * Selection colour is blue.
  * Handles are white squares with a blue border.
  * The size label is a blue pill below the selection, e.g. `120 × 90`, `232 Hug × 72 Hug` or
    `120 × 0` for lines.
* **Hover:** with nothing selected, the hovered layer gets a 2 px blue outline. **A hovered text layer
  shows a baseline underline.**
* **Corner and shape handles:**
  * Rectangle corner-radius handles appear only after a click selection and hover: 4 hollow circles
    inset from the corners.
  * The ellipse has one arc handle on its right edge.
  * The star has three handles: corner radius, ratio and count.
  * The polygon has two handles: radius and count.
* **AI sparkle:** a sparkle (AI) button floats at the top-right outside the selected object.
* **Auto layout selected:**
  * Padding bars are blue. Hovering one shows a blue value badge, e.g. "16".
  * Gap bars are pink. Hovering one shows a pink badge, e.g. "10".
  * When a child is selected, the parent shows a dashed blue outline.
* **Components:**
  * Components and instances use purple: purple outline, handles and size label.
  * The main component's label reads `❖ Button` in purple.
  * A component set shows a "3 Variants" label and a purple "+" add-variant button below.
* **Section:** the label is a grey pill at the top-left.
* **Multi-select and groups:**
  * A multi-selection shows one bounding box, outlines on each item and small center dots.
  * Groups show a plain box.
  * Evenly spaced multi-selections get smart-selection pink handles.
* **Rotation:** the bounding box and size label rotate with the shape.
* **Text editing:** a blue 1 px box with no handles. The selection highlight is a translucent blue.
* **Vector edit mode:** a secondary toolbar sits above the bottom toolbar: **Move, Lasso, Paint, Bend,
  Cut, Erase, More ▾, ✕**. The panel shrinks to Vector › Alignment › Position › Mirroring ›
  Corner radius › Fill › Stroke.

### Left side, toolbar and menus

* **Left rail:** File, Agents, Assets, Tools and Variables.
  * **Assets:** a library list ("Created in this file", per-page component grids, "Add more libraries").
  * **Tools:** a search, Source/Category filters, a Weave promo and suggested plugins.
  * **Variables** opens a **full-window Variables view** (URL `view=variables`) that replaces the
    canvas: Collections, Groups, and a table with mode columns.
* **Layers rows:**
  * Each row's icon has an aria-label (Frame, Auto layout, Component, Variant, Instance, Text, Section,
    Group, Rectangle, Union, Ellipse, Vector, Line, Star, Polygon).
  * Hover background is `#383838`, with lock and eye toggles appearing on the right.
  * The selected row is `#394360` (children `#32394d`), and a selected component row has purple text.
* **Pages:** "+" adds "Page N" in inline rename. **Find** replaces the whole left panel with a search
  view. Its filter offers Find/Replace, All/Text/Frame-Group/Component/Instance/Image/Shape/Other,
  Match case and Whole words.
* **Bottom toolbar dropdowns:**

  | Dropdown | Tools and shortcuts |
  |---|---|
  | Move tools | Move V, Hand H, Scale K |
  | Region tools | Frame F, Section ⇧S, Slice S |
  | Shape tools | Rectangle R, Line L, Arrow ⇧L, Ellipse O, Polygon, Star, Image/video… ⇧⌘K |
  | Creation tools | Pen P, Pencil ⇧P |
  | Type tools | Text T, Text on path |
  | Comment tools | Comment C, Annotation Y, Measurement ⇧M |

  * Actions opens a command palette: All/Assets/Plugins & widgets, recents and AI actions.
  * The mode switch on the right is **Draw / Design / Motion (Beta) / Dev Mode**.
* **Menus:**
  * Menu text is 11 px with weight 450. The highlight is `#0c8ce9` with radius 5.
  * Check marks sit in a 32 px left gutter, and shortcuts are right-aligned at 70% white.
  * The main menu has View › Panels and View › Additional labels submenus. View also has Minimize UI
    ⇧⌘\ and Show/Hide UI ⌘\.

## Gaps (not captured)

* **States that need a held drag:** marquee, smart guides while dragging, the drop indicator into auto
  layout, and track-pill dragging. The browser tool's drag is atomic, so the state between press and
  release can't be shown.
* **The ⌥-hover red distance measurement:** the tool can't hold a modifier during a hover.
* **Missing tooltips:** tool tooltips (the shortcuts are in the dropdown dumps instead) and the
  rotation cursor (an OS cursor).
* **Image fill:** the image fill was set via the API, so no file picker was needed. The "Image" paint
  tab is captured without uploading anything.
* **Slots:**
  * A Slot *property* was created on `Card` (`design/component-with-slot.txt`).
  * A slot *layer* (wrapping a frame into a slot) was not created.
* **Grid panel dropdowns:** the panel's own sizing-type and value dropdowns were not captured. Escape
  closes the track selection.
* **Popover reachability:** the Effects "+" goes to the shader browser, so the drop-shadow row was added
  through the API.

## Files

* `design/` — Design panel per selection:
  * Shapes and containers: page-nothing-selected, frame, frame-child-constraints(+-expanded),
    group, section, rectangle, ellipse, polygon, star, line, arrow, vector, boolean, text,
    image-fill.
  * Auto layout: autolayout-vertical, -horizontal, -wrap, -grid, grid-child,
    autolayout-individual-padding, autolayout-child, autolayout-parent-fixed.
  * Components: component, component-set, variant, instance, variant-instance,
    nested-instance(-parent), component-with-slot, instance-with-slot.
  * Multi-selection: mixed-multi, multi-two-shapes.
  * Edit modes: text-editing-caret, text-editing-partial, vector-edit-mode,
    vector-edit-point-selected.
  * Variants of a rectangle and frame: rectangle-with-stroke, -with-effect, -with-export,
    -individual-corners, frame-with-layout-guide.
* `popovers/` — every Design-panel popover and menu listed above (56 files).
* `grid/` — grid-dimensions-picker, grid-autolayout-settings, row-track-menu (canvas pill menu),
  row-track-selected-panel (the Grid panel).
* `menus/` — main menu plus every submenu (file, edit, view, view-panels, object, text, arrange,
  vector, plugins, widgets, preferences, help). Context menus: empty canvas, frame, shape, text,
  instance, component, multi-selection, layer row, page row.
* `left/` — layers row hover and selected, pages add/rename, find and its filter menu, rail Assets
  (3 levels), Tools, and Variables (empty and with a table).
* `toolbar/` — the bottom toolbar, each tool dropdown, the Actions panel, and the vector-edit toolbar
  with its More menu.
* `img/` — 46 screenshots, mainly canvas states (`canvas-*`, `grid-*`), plus menus, left rail and
  panel views.

## Behaviour (`behaviour/`)

Interaction tests run on the page **Behaviour** in Untitled at a 1440×900 viewport. There is one file per area, and each holds the findings followed by a log of every action with its before/after state and its status. Screenshots are in `behaviour/img/`.

| Area | File | Observed | Could not reproduce / to do |
|---|---|---|---|
| Selection keys | `keyboard.md` | Esc clears the selection (it does not select the parent). ⇧Enter and \ select the parent. Enter on a frame selects all children (hidden and locked too), and Enter again goes one level deeper. Enter on a shape opens vector edit. Tab and ⇧Tab walk siblings in Layers order, wrap, and do not skip hidden or locked layers. | The tool's real "\\" key does not reach the page (the JavaScript keydown works) |
| Text | `text.md` | Double-click on text edits immediately and selects the word. The first Esc leaves edit mode and keeps the layer selected; the second Esc deselects. | — |
| Number fields | `fields.md` | Click selects all. Enter commits and returns focus to the canvas. Esc reverts and stays in the field, and a second Esc returns focus to the canvas. `500+10`, `*2` and `2^3` work. `+10` typed alone is absolute. `Mixed+100` is applied to each layer. Tab follows DOM order. ↑ steps by 1 and ⇧↑ by 10. Gap "Auto" gives Space between. In the H-padding field, `1,2,3,4` sets left=1 and right=2. Dragging the label scrubs. | ⌥-hover over a field |
| Canvas | `canvas.md` | Frame title: click selects, drag moves, double-click renames. Clicking the empty background of a top-level frame acts like empty canvas; a nested frame gets selected. A drag from a frame's background is a marquee. A marquee that covers part of a frame selects its children. A larger layer dropped onto a frame nests by cursor position. | ⌘-marquee (nested); ⌘, Space and ⌃ while dragging |
| Resize | `resize.md` | With Lock aspect ratio on, an edge drag scales proportionally. Line and radius handles are covered by the visual pass. | ⇧, ⌃ and ⌘ during resize |
| Layers | `layers.md` | Auto-layout children are listed in flow order (first on top). Enter after a row click equals canvas Enter. Double-clicking the name renames. ⌘R opens "Rename N layers". Chevrons are always visible. ⌥-click on a chevron is recursive. ⌥L collapses all. Dragging across eye icons hides every crossed row. | — |
| Shortcuts | `keys.md` | Opacity digits with a two-digit buffer of about 450–500 ms (0 = 100%, 0 then 5 = 5%). ] / [ send to front and back, ⌘] / ⌘[ move one step. N and ⇧N zoom to the next and previous frame. ⌘D repeats the last offset. ⇧⌘O outline mode. ⌃P pixel preview. The pixel grid shows from 300%, and its shortcut is ⇧'. | ⌥⌘A select matching; ⇧⌘R, ⇧⌘V and paste placement (the clipboard is not reachable from the tool); confirming that the ⇧' toggle works |
| Smart selection | `smart-selection.md` | Equally spaced layers get dots, a Spacing field and pink gap handles. Dragging one gap handle sets every gap. | Dragging the center dots (reordering) |
| Pages | `pages.md` | "+" opens inline rename. A page named "---" is a divider. | Duplicate page naming |
| Minimize UI | `ui.md` | Minimized: full-width canvas and floating pills. A selection shows a floating Design panel, which hides again on deselect. | The ⇧⌘\ shortcut itself (only the menu item was used) |

**Tool limits:** modifiers can't be held through a drag or hover, the clipboard isn't reachable, and right-click menus sometimes fail to open. Any item that needs one of these is marked "could not reproduce".
