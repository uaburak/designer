# Figma Atlas — Figma Design from A to Z

Started 2026-10-16. Goal: one detailed report of everything Figma Design does, down to the numbers (defaults, durations, easings, limits, steps, sizes, strings, shortcuts, edge cases), read with REA from Figma desktop 126.9.13's cached editor build. The extracted build lives outside the repo at `~/.cache/figma-rea/figma/`; the brief every chapter follows is `~/.cache/figma-rea/BRIEF.md`. Figma's code is never copied here. Only behaviour, numbers and data shapes are written down, each with its evidence.

Scope: Figma Design and Dev Mode. FigJam, Slides, Buzz, Sites, Make and Weave are out of scope (owner's decision of 2026-10-11).

All 22 chapters were written on 2026-10-16 (about 1.2 MB, 12,500 lines). Each chapter has the same shape: scope and sources, the body with every value in tables and its evidence (`file @offset` or a short snippet, marked CONFIRMED / INFERRED), the area's UI strings (the build carries i18n keys, so English text is given only where it is attested), "DesignerV2 today" (matches / differs / missing) and "Open questions" with the live probe that would settle each.

| # | Chapter | Done |
|---|---|---|
| 01 | [App shell, Home and file browser](01-app-shell-home.md) | ✅ |
| 02 | [Editor chrome (UI3): toolbar, panels, layers, pages](02-editor-chrome.md) | ✅ |
| 03 | [Menus, keyboard shortcuts, quick actions](03-menus-shortcuts.md) | ✅ |
| 04 | [Canvas, viewport, selection, snapping, measurement](04-canvas-selection.md) | ✅ |
| 05 | [Shapes, vector, pen, Draw](05-shapes-vector.md) | ✅ |
| 06 | [Text and typography](06-text-typography.md) | ✅ |
| 07 | [Paints, colour, gradients, images, blend modes](07-paints-color.md) | ✅ |
| 08 | [Effects](08-effects.md) | ✅ |
| 09 | [Layout: auto layout, grid, constraints, layout guides](09-layout.md) | ✅ |
| 10 | [Components, variants, properties, instances](10-components.md) | ✅ |
| 11 | [Variables, modes, styles](11-variables-styles.md) | ✅ |
| 12 | [Libraries: publish, update, analytics](12-libraries.md) | ✅ |
| 13 | [Prototyping and presentation](13-prototyping.md) | ✅ |
| 14 | [Dev Mode](14-dev-mode.md) | ✅ |
| 15 | [Export, import, clipboard](15-export-import.md) | ✅ |
| 16 | [Comments, version history, branching](16-comments-versions.md) | ✅ |
| 17 | [Plugins, widgets, Plugin API](17-plugins.md) | ✅ |
| 18 | [Figma AI and Actions](18-ai.md) | ✅ |
| 19 | [Multiplayer, sharing, permissions](19-multiplayer.md) | ✅ |
| 20 | [Rendering and performance internals](20-rendering.md) | ✅ |
| 21 | [Settings, accessibility, localisation](21-settings.md) | ✅ |
| 22 | [Undo, autosave, offline, the .fig file](22-undo-file.md) | ✅ |

## Biggest gaps found, by chapter

What DesignerV2 does not do yet, as each chapter's author ranked it. The chapter's "DesignerV2 today" section has the full list.

- **01 App shell**: pinned tabs, tab groups, split tabs, the closed-tabs dropdown (100 kept); ⌘T new-tab page; tab discarding (15 live at start, 48 h idle); per-view sort and filters; moment-style relative times refreshed every 30 s / 30 min / 6 h; Figma's grid sizes (minmax 264 px, gap 32, radius 6).
- **02 Editor chrome**: panels up to 500 px; tooltips after 1000 ms; a FIFO toast queue (3 / 6 / 10 s, halved per waiting toast, repeat badge); scrubbing at 0.5 × multiplier with vertical precision bands; `%` and `x` in field maths; layers-panel drag expand (1000 ms), sticky parents, 3 px drag start; divider pages; zoom menu items; image crop mode.
- **03 Menus and shortcuts**: Figma's full table (260 actions, 1,183 bindings) and its per-layout bindings for 16 keyboard layouts; Quick actions' weighted score (text 0.4, enabled 0.3, frecency 0.2, AI 0.1); context menus drop disabled rows; the keyboard-shortcuts panel's timing.
- **04 Canvas**: zoom steps to the next power of two, min zoom 1/64; zoom to fit / selection paddings 25 / 40 px with no 100 % cap; implied frame-margin snapping; ruler units; Outlines sub-options; ⌥Space keyboard select; pan bound ±131,072.
- **05 Shapes and vector**: the Arc row (Start / Sweep / Ratio); boolean version upgrade; paint bucket chip; star ratio ≥ 0.1 %; polygon 3–60; section paste fallback.
- **06 Text**: `textUserLayoutVersion`-dependent line-height rounding; bidi / RTL and emoji images; optical size and variable-axis steps; underline limits; font picker ranking and Figma's popular list; Noto fallback fonts.
- **07 Paints and colour**: hex input of 1–8 digits and 148 CSS names; scroll to change hue / alpha; gradient stop gestures and the interpolation menu; eyedropper modes; Selection colors collapsing rules; mask types; the colour-profile Convert / Assign dialog; more image formats and GIF playback.
- **08 Effects**: per-type counts (8 shadows, 1 blur …); progressive blur's canvas handles; spread rules and field limits; type change keeping fields; glass angle −180…180 with 45° snapping.
- **09 Layout**: `stackLayoutVersion` (Legacy / Updated) and its six rule changes; SCALE from the constraint widget; Suggest auto layout and its grid / wrap inference; panel typing rules; layout guide defaults.
- **10 Components**: Return to instance (2 min memory, ⌃⌥⌘K); Figma's 12 reset kinds in order; the Assets panel's layouts and fuzzy search; four variant error kinds; NUMBER properties; swap picker order.
- **11 Variables and styles**: modes by plan (1 / 10 / 20 / 40); "Name 2" naming; 24 scopes; table actions and column sizes; more bindable fields and their warnings.
- **12 Libraries**: Swap library; updates flagged only when hash and version both differ; Updates grouped by publish; the review modal; publish modal sections and checks.
- **13 Prototyping**: hint timing and colour (0.7 s, #30C2FF); Slide's ¼ move and fade; velocity-based drag release; iOS / Android scroll physics; ordered action queue; per-trigger panel rules; After delay up to 20 s; 1/30 s frame-clock cap; spring durations as settle times.
- **14 Dev Mode**: CSS number formatting (3 decimals, `0` unitless, two-digit alpha); default-declaration filtering and section split; fill / shadow ordering in CSS; SwiftUI / Compose details; UIKit and XML; code hints; annotation presets.
- **15 Export**: JPG / PDF quality values; the "+" and suffix rules; scale 1024 and size 32768 limits; ZIP naming; Copy / Paste properties through the clipboard; table and URL paste; tagged PDFs with TrueType fonts; `data-figma-*` SVG attributes.
- **16 Comments and versions**: pin clustering and multi-avatar pins; attachments and rich text (2,000 characters); sort / filter rules; version history as a side panel with autosave groups; branching's saved versions, force / undo merge and per-property changes.
- **17 Plugins**: missing members per node type (§13.3 lists them); `allowedDomains` and CSP rules; `notify` timing and exact messages; plugin window positions and running toast; widgets.
- **18 Figma AI**: image tools keep the original paint; Boost / Vectorize limits; streamed text tools with one undo step and 28 languages; Rename and Add interactions rules; credits and availability.
- **19 Multiplayer**: the seven colours; facepile formula; cursor chat 50 characters, fade 5–8 s, idle hide 60 s; spotlight timing (4000 ms); server signals; access levels 30 / 100 / 300 / 900 / 999.
- **20 Rendering**: heap limits (2 / 3 / 4 GiB) and the 90 % warning, out-of-memory recovery mode; WebGL / WebGPU context-loss recovery; adapter order and blocklists; 256 / 512 px tiles; export memory routing; frame telemetry.
- **21 Settings**: where each preference lives (local, account-roaming); the Accessibility dialog (seven switches); reduced motion; the desktop app's interface scale and troubleshooting menu; nudge dialog rules; language and token options.
- **22 Undo and file**: `undoBatchPageIds` 46; commit modes instead of time windows; the save-status rules (10 s offline, 30 s unconfirmed, 60 s toast); IndexedDB offline backup; Save Local Copy's partial-file flow. The build's embedded schema is the same as the owner's latest Save Local Copy (version 106; Figma reads up to 110).

## Using it

Before building or fixing an area, read its chapter first. The values to copy are in its tables, and the open questions say what still needs a live probe in Figma (devtools console or the Plugin API, as `docs/research/figma/live/` did). The extracted build stays at `~/.cache/figma-rea/` for follow-up reads; when Figma updates, a new extraction can be compared with this one.
