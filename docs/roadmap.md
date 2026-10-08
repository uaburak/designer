# Roadmap

A single-user Figma desktop clone (it began as burakkoc.net's site admin; that code is gone). Each phase ends with `npm run check` and `npm run engine:test` green and the result visible in `npm run dev:demo`. Engine milestones (E0–E9) are defined in `engine.md` §13; the parity items (P0/P1/P2) come from `research/figma/R7-editor.md`.

## Phase 1 — Foundations (done, 2026-10-06)

Four workstreams, each owning its own folders:

| Workstream | Owns | Delivers |
|---|---|---|
| Design system | `src/renderer/src/ds/` | Tokens (light/dark, generated CSS), theme, ~35 UI3 components, icons, the `?gallery` page |
| Engine E0–E1 | `engine/`, `src/renderer/src/engine/` | CMake/Emscripten build, scene graph + patches + undo, our WebGL2 renderer (rects, rounded rects, ellipses, frames with clipping, overlays), camera, hit-testing, selection, move/resize, V/F/R/O/H tools, flat C ABI + TS wrapper, `?engine` playground, native tests |
| Desktop | `src/main/`, `src/preload/`, `src/shared/` (ipc, tabs, desktop), `src/renderer/src/app/` | BaseWindow + a WebContentsView per tab bar / Home / file, TabManager in main, typed IPC, native dialogs, crash recovery — **done** (`desktop-impl.md`) |
| Data | `src/store/`, `src/shared/{schema,store,fig}/`, `src/renderer/src/store/`, `engine/tools/schemagen/` | Generated Kiwi codecs, `.fig` container, the store (workspace, snapshot + journal, recovery, versions, blobs, libraries), repositories + a disabled Firestore adapter, MessagePort RPC |

## Phase 2 — The new editor tab (integration round done, 2026-10-06)

Done in the integration round (`desktop-impl.md` Status): the store's utility process started by main, a MessagePort per Home/editor view, `file` tabs (one per `fileKey`, kept in the session, retitled and closed by the store's events), Home on the store as the only Home, autosave with the flush handshake (no Save, no dirty dot; thumbnails written before a tab closes), Figma's menu bar from one registry with enablement from the views, cross-origin isolation, and the removal of every piece of the site admin. The editor's own progress on the items below is in `editor.md`.

- Start the store from main and hand each view its port; a new tab kind for engine files; Home lists the workspace (Drafts, folders, Recents, Starred, Trash; create, rename, move, duplicate, trash/restore/delete forever).
- The editor chrome from the design system: left panel (file menu, Pages, Layers from the engine), right panel (Design/Prototype tabs, zoom, the Page section and the Styles list with nothing selected, Position/Layout/Appearance/Fill/Stroke/Export for a selection), the bottom toolbar, rulers.
- Autosave through the journal (no Save, no dirty dot — as Figma), version history window, ⇧⌘T, copy/paste in our clipboard format.
- P0 parity: tools V/K/F/R/O/L/H, selection rules (click, ⇧, ⌘ deep select, Enter/⇧Enter, Tab, marquee, Esc), transforms (⇧ proportional, ⌥ from centre), nudging, zoom (⇧1, ⇧2, ⌘±, Z), group/frame selection/lock/hide/rename/duplicate.

## Phase 3 — Engine depth

- **E2 auto layout**: horizontal/vertical/wrap/grid, hug/fill/fixed, min/max, absolute position, constraints, sections, groups; the Auto layout section and its on-canvas handles.
- **E3 text**: fonts from the system (fonts utility process), HarfBuzz shaping, line breaking, text editing with IME, text properties, text styles.
- **E4 vectors**: vector networks, pen/pencil, polygon/star, booleans (live), flatten, masks, the full stroker.
- **E5 paints and effects**: gradients with handles, images (fill/fit/crop/tile), shadows, blurs, blend modes, tile rendering for big files.

## Phase 4 — Design systems, Figma's way

- **E6**: components, component sets and variants, component properties (boolean, text, instance swap, variant, slot), overrides by stable keys, detach/reset/push/go to main.
- Variables: collections, modes, aliases, scopes, code syntax, the Local variables window, mode per frame/page; styles (color, text, effect, layout guide) bound to variables.
- Libraries: publish (change list, descriptions, hide when publishing), the Libraries modal, the Assets tab, update badge and Review (side by side / overlay, update selected / all), Move to this file / Publish as a copy, deleted-asset restore.

## Phase 5 — Out of the file

- **E7**: export (PNG/JPG/SVG/PDF), copy as PNG/SVG, thumbnails.
- Developer previews: read-only snapshot + web viewer (same Wasm renderer) with Dev-Mode-like Inspect; Firebase Hosting/Storage once the owner's new Firebase config is in place, a self-contained HTML file before that.
- The Firebase adapter (`data.md` §12): sync with per-property last-writer-wins.
- `.fig` import (Figma's own files) and the one-shot converter for the old site projects (`data.md` §11.3). *Fidelity round 2026-10-08 (branch `fig-import-fidelity`):* `scripts/fig-fidelity.mjs` against Figma's own thumbnails and stored geometry; Figma's override paths, derived data kept, slots, GRID, space between, NaN gaps, Display P3 — `data-impl.md` "Import fidelity" has the numbers and what's left.
- **E8** prototyping and presentation view; **E9** WebGPU backend.

## Legacy removed (2026-10-06)

As the owner decided, the whole site admin was deleted in the Phase 2 integration round, with no import of the old projects: the DOM editor, the CV, site publishing and the preview tab, the old Home, `lib/` (the site's Firebase) and `demo/`, the sign-in, the site's components and the iframe shell for browsers, and the dependencies only they used (Tailwind, gsap, prismjs, dompurify, tailwind-merge). The site's Firebase data is left untouched (burakkoc.net keeps working with its own web admin). The Firebase SDK stays, as a dependency, for the optional Firebase adapter (`data.md` §12). A converter for the old projects (`data.md` §11.3) is not planned unless the owner asks.
