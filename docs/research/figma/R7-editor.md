# R7-editor — Figma Design editor parity checklist (single user)

Sources opened: help.figma.com (select layers, auto layout guide, grid flow, boolean ops, shape tools, adjust rotation/dimensions, version history, keyboard accessibility), developers.figma.com textTruncation, nobledesktop shortcut list (third party), forum threads (measurement).

## P0 (MVP)
- Tools: V move, K scale, F frame, S section (Noble lists S=slice; in UI3 slice moved — verify), R rect, O ellipse, L line, Shift+L arrow, P pen, T text, H hand, C comment. Shape modifiers: Shift = proportional/perfect, Opt = from center.
- Selection: click; Shift+click add/remove; Cmd-click deep select; double-click / Enter = child; Shift+Enter = parent; Tab / Shift+Tab = next/prev sibling; marquee; Esc deselect; Opt+Cmd+A select matching layers; Edit > Select all with same fill/stroke/effect/font; invert selection.
- Transforms: drag edges/corners, Shift proportional & rotation 15° snaps, Opt from center, Ctrl temporarily disables snapping/aspect lock; rotation -180..180 around centre; aspect-ratio lock; flip Shift+H/Shift+V (inference, unverified source).
- Nudge arrows (1px), Shift+arrows (10px default; configurable) — inference.
- Snapping/smart guides, Opt-hover measurement (Opt+Cmd for nested/locked).
- Groups (Cmd+G), frame selection (Opt+Cmd+G), ungroup, lock Cmd+Shift+L, hide Cmd+Shift+H, rename Cmd+R, duplicate Cmd+D.
- Auto layout: Shift+A add, Opt+Shift+A remove; flows vertical/horizontal/grid; wrap; gap fixed or auto (space between/around/evenly — 2025 change); padding; 9-way alignment + text baseline; hug/fill/fixed; min/max; ignore auto layout (absolute); nesting; constraints in normal frames.
- Boolean: Union/Subtract/Intersect/Exclude = Opt+Shift+U/S/I/E, non-destructive; Flatten Cmd+E.
- Masks Ctrl+Cmd+M (bottom layer is mask).
- Text: auto width/auto height/fixed; truncation ENDING + maxLines.
- Fills/strokes/effects/blend modes, images (fill/fit/crop/tile), export settings (Cmd+Shift+E).
- Layers panel (drag reorder, rename, lock/hide, collapse), pages panel.
- Zoom: Shift+1 fit, Shift+2 selection, 100% (Shift+0 in current Figma; older lists say Cmd+0 — verify), Cmd +/-; Space/H pan; Z zoom tool.
- Undo/redo; copy/paste; paste properties Opt+Cmd+C/V.
- Shortcuts panel Ctrl+Shift+?.

## P1
- Grid auto layout flow (Config 2025, now GA): tracks fixed/fr/hug, spans, min/max, auto rows, gap variables.
- Pen/vector networks; shape tools polygon/star params; rulers Shift+R + guides; layout guides (grids); constraints.
- Version history: autosave checkpoint every 30 min, named versions, restore non-destructive, duplicate.
- Prototype mode + presentation view.
- Text lists, OpenType features, paragraph spacing.
- Keyboard accessibility (Opt+Space box select).
## P2 / scope notes
- Comments (low value single-user), Dev Mode (out of scope), plugins (later), UI3 toolbar bottom-centre (Config 2024).
