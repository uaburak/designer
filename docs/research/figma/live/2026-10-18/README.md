# Live Figma measurements, 2026-10-18 (web, UI3, dark, 1440×900)

Taken in the owner's own draft "Untitled" (page "Capture") with the same method as 2026-10-08 (`../figma-dump.js`): fixtures built with `window.figma`, then the DOM of each panel / menu / popover read with injected helpers (positions, sizes, type, colours, radii, shadows, aria labels, states) and the icons' SVG source copied as Figma ships them. The canvas is WebGL, so canvas visuals come from the owner's captures in `../owner-2026-10-18/`.

- `slider.txt` — Figma's slider (track #444, filled #0C8CE9, 12-px white thumb with its shadows, joined to its value field).
- `effects-glass-popover.txt` — the Design panel with a Glass effect and the Glass settings popover (Light dial, Refraction / Depth / Dispersion / Frost / Splay rows).
- `effects-add-menu.txt` — what "+" in Effects does (adds an Inner shadow row and opens its type menu), the menu's rows and every effect icon.
- `boolean-menu.txt` — the header's Boolean operations split button, its menu, and the Union / Subtract / Intersect / Exclude / Flatten / Edit object icons.
- `devmode-inspect-right.txt` — Dev Mode's 320-px Inspect panel chrome (the draft is on a Free plan, so Figma shows its upgrade overlay over a placeholder panel; content from `../owner-2026-10-18/figma-devmode-inspect.webp`).
- `motion.txt` — Motion mode: the right panel's joined fields with their keyframe cells, the diamond icons, the timeline header / layer rows / playhead, and its icons.
