# Keyboard shortcuts panel — live Figma vs ours

`live-*.webp`: the owner's screenshots of Figma desktop (2026-10-10, dark, a 1512 × 982 window; 1 CSS px = 1.3228
image px). `ours-*.png`: editor-shot's `EDITOR_ONLY=shortcuts` at 1512 × 982 (`src/renderer/src/editor/tools/editorShotShortcuts.mjs`).

Measured from the live screenshots (pixel scans), as built (`src/renderer/src/editor/shortcuts/`, tokens `--ds-size-shortcuts-*`, `--ds-size-keyboard-key*`):

- Docked along the window's bottom, full width, **240** high, a 1px `#444` line on top, background `#1e1e1e` (Figma's
  menu colour). The side panels end over it, the bottom toolbar sits **12** over it, the "?" is hidden. Ours keeps the
  canvas full size under it (the owner's rule since 577afdb); the visible part (`.view`) ends at the panel.
- Tab row 38 + a 1px `#383838` line: 13px labels, 16 padding, no gap, the chosen tab a card (1px `#383838` sides) open
  into the content; Layout at the right end of the columns; ✕ 19 from the window's right edge. A tab whose every
  shortcut has been used is blue (live: Cursor).
- Three **300** columns **48** apart, centred; rows **37** apart, the first 26 under the tab row; 13px labels in the
  secondary text colour (`#ffffffb2`), headings "While pointing…" in the text colour, hints "While editing a shape…" in
  the tertiary one.
- Key caps **26** high, ≥ 26 wide, 1px border in the secondary text colour, 4 apart, Apple's order ⌃ ⌥ ⇧ ⌘, the key
  last; words as caps ("↩ Enter", "⇥ Tab", "⎋ Esc", "Space", "click", "drag", "Home", "End"), Page Up / Down as 🌐 ↑ /
  ↓; "and" between two keys sharing their modifiers ("⌘ B and I").
- A shortcut used: the label and icon `#7cc4f8` (dark text-brand), the caps filled with it, the glyph `#1e1e1e`.
- Essential: "Essential keyboard shortcuts", three items — a 24 circle with the number, the name and its caps, two lines
  of description (16 line height).
- Layout: "Keyboard layout:" + a 179-wide select (Chinese … U.S. QWERTY, then ✓ Generic), "Learn more" at the bottom;
  the keyboard at the columns' right — keys 26 × 25, 32 apart across, 33 down; ⌫ / ⇥ 55, ⇪ 67, ↩ 45, ⇧ 80 / 63, space 308.

Ours beyond live's list: **Turkish F** and **Turkish Q (Mac)** (the owner's Turkish MacBook), drawn as an ISO
keyboard (`ours-layout-tr-dark.png`: ⇥ 42, a tall ↩ 39 over 31, ⇪ 50, the left ⇧ 50 and < beside it; the rows stay
471). Their characters are macOS's own, not from memory: `keylayouts.swift` runs UCKeyTranslate on the "Turkish Q"
(`com.apple.keylayout.Turkish-QWERTY-PC`) and "Turkish F" (`com.apple.keylayout.Turkish-Standard`) input sources with
this Mac's keyboard type (92, ISO) → `keylayouts-tr.json` (each key alone, with ⇧, with ⌘; British as a check — § left
of 1, ` right of ⇧, as a U.K. MacBook prints them). ⌘ types what the key types alone, so on macOS ⌘I is the key that
types i (İ's), and ours follows. ("Turkish Q – Legacy" and "Turkish F – Legacy" are left out.)

Unverified: the panel in Figma's light theme (ours stays dark, as Figma's menus); Figma's own per-layout remaps (ours
follow the characters — `layouts.ts`); what counts as "used" for the Cursor rows (ours: the pointer's modifiers on the
canvas, `usage.ts`).
