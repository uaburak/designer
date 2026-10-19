# Live Figma measurements, 2026-10-18 (web, UI3, dark, 1440×900)

Taken in the owner's own draft "Untitled" (page "Capture") with the same method as 2026-10-08 (`../figma-dump.js`): fixtures built with `window.figma`, then the DOM of each panel / menu / popover read with injected helpers (positions, sizes, type, colours, radii, shadows, aria labels, states) and the icons' SVG source copied as Figma ships them. The canvas is WebGL, so canvas visuals come from the owner's captures in `../owner-2026-10-18/`.

- `slider.txt` — Figma's slider (track #444, filled #0C8CE9, 12-px white thumb with its shadows, joined to its value field).
- `effects-glass-popover.txt` — the Design panel with a Glass effect and the Glass settings popover (Light dial, Refraction / Depth / Dispersion / Frost / Splay rows).
- `effects-add-menu.txt` — what "+" in Effects does (adds an Inner shadow row and opens its type menu), the menu's rows and every effect icon.
- `boolean-menu.txt` — the header's Boolean operations split button, its menu, and the Union / Subtract / Intersect / Exclude / Flatten / Edit object icons.
- `devmode-inspect-right.txt` — Dev Mode's 320-px Inspect panel chrome (the draft is on a Free plan, so Figma shows its upgrade overlay over a placeholder panel; content from `../owner-2026-10-18/figma-devmode-inspect.webp`).
- `motion.txt` — Motion mode: the right panel's joined fields with their keyframe cells, the diamond icons, the timeline header / layer rows / playhead, and its icons.

Second pass, 2026-10-19 (same method; the rest of the editor and Home):

- `toolbar.txt` — the bottom toolbar (tool groups, chevrons, Comment, Actions, the Draw / Design / Motion / Dev Mode switch), the five tool menus and the left navigation rail, with every icon.
- `menus.txt` — the shared menu chrome (surface, rows, separators, shortcuts, submenu arrow), the main menu and all its submenus' items, the canvas context menu on a shape, and the Manage libraries dialog.
- `left-panel.txt` — file header, Pages, Layers (indent, icons, hover lock / eye, selection) and the Assets tab.
- `variables.txt` + `variables-view.jpg` — local variables are now a full-window view from the rail (collections, groups, the table and its value cells) and the Edit variable popover.
- `prototype.txt` + `prototype-panel-interaction.png` — the Prototype tab and the Interaction popover (trigger, action, destination, animation, easing, duration, preview).
- `comments.txt` — comment mode, the Comments panel and the new-comment pin and composer (nothing was posted).
- `home.txt` + `home-recents.jpg` — Home: sidebar, header pill buttons, Community banner, tabs and filters, file cards.
- `settings.txt` — the account dropdown and the Settings dialog's Account tab (no screenshot: it shows personal details).
- `property-rows-copy.txt` — selecting Fill / Stroke / Effect rows in the Design panel, ⌘C / ⌘V / Delete on them, and the clipboard Message Figma writes (NODE_CHANGES with pasteAssetType STYLE_PROPERTIES_FILL / STROKE / EFFECT).
- `motion-easing.txt` — Motion: a keyframe segment's easing as a right-panel page (preset select, Curve | Spring, the 208-px graph, Bezier / Bounce field, Flip curve) and the Presets popover beside the panel.
