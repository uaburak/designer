# 15 — Export, import and the clipboard

Figma Design desktop 126.9.13, read statically on 2026-10-16 from the cached editor build (`~/.cache/figma-rea/figma/`, outside the repo), following `~/.cache/figma-rea/BRIEF.md`. Figma's code is not copied here. This file records behaviour, numbers, enums and strings, each with its evidence.

Status tags:
- **CONFIRMED**: read directly in the build, or in a live capture of Figma in `docs/research/figma/live/`.
- **INFERRED**: deduced from what was read. Where an inference rests on Figma's help site or on general knowledge of Figma's output rather than the build, the finding says so.

Evidence formats: `chunk @byte-offset` or `chunk: "snippet"` for the JavaScript chunks; `wasm: "string"` for a string in `fullscreen__fullscreen-wasm__compiled_wasm.wasm` (`strings -n 6`); `worker @offset` for `fullscreen__import__import.worker.js`; `live: file` for a capture under `docs/research/figma/live/`.

## 1. Scope and sources

**Covered:** the Export section of the Design panel and its settings popover; the Export modal (⇧⌘E); Export frames to PDF; the export pipeline (jobs, file names, archives, limits, warnings); what the SVG and PDF writers produce; Copy as … (PNG, SVG, text, code, link); Copy / Paste properties; the paste commands and where pasted layers land; what a paste turns into by clipboard content (Figma layers, SVG, images, HTML tables, plain text, URLs, Mermaid); the clipboard's data format; placing images (drag-drop, Place image/video ⇧⌘K and "Place all"); importing files (.fig / .jam / .deck / .site / .buzz / .make, Sketch, PDF, images) and the `.fig` archive format.

**Not covered here (linked):** image decode limits and downscale rules (chapter 07 §8.6 and `docs/research/rea/canvas.md` §2.5); effect SVG filter ids (chapter 08 §8); scatter-brush SVG (`docs/research/rea/vector.md`); video / GIF / Lottie / animated-SVG export and the plan limit (`docs/research/rea/motion.md` §2.25); Copy as code's CSS / iOS / Android generators (chapter 14); library references on paste (chapter 12 "Pasted variables", "Unadded libraries"); partial component sets on paste (`docs/research/rea/components.md` §2.16).

**Sources read:**

| Source | What it holds | Where |
|---|---|---|
| `4989.min.js` (`3508`, `2631` are copies) | ExportPanel / ExportList: the "+" default (`t9`), auto suffix (`t7`), constraint presets, the format select, the format-switch rules (`nS`), export button labels, static / animated tabs, Lottie lint | @45 000–82 000; `t7` @48 019, presets @70 514, format select @72 022, `nS` @73 809, `onClickExport` @57 751 |
| `7621.min.js` (`858` is a copy) | ExportSettings popover (240 px): suffix, colour profile, quality, frame rate, loop, image resampling, contents only, bounding box, SVG options; the quality ↔ number module 275602 | @277 718 (quality), @280 958 (popover), frame rates @286 856 |
| `figma_app.min.js` / `2108.min.js` | Export constraint parser / formatter (MAX_SCALE, MAX_SIZE); clipboard read / write (`(figma)` / `(figmeta)`); copy-properties encoding; image upload during import | parser @1 693 977 (`2108` @384 274); clipboard @7 069 042 and module 443816 @2 057 902; upload @2 091 593 |
| `2108.min.js` | The download / archive session (single file vs ZIP, unique names) | @904 921 |
| `1540.min.js` (`3653`) | ExportPicker (⇧⌘E modal); the Copy/Paste as submenu | @445 124; @547 235 |
| `3187.min.js` (`5519`, `7362`) | Export frames to PDF modal; embedded current kiwi schema (ExportSettings, Message); `7362` holds the clipboard host methods (readClipboardData, spreadsheet detection, Copy as PNG write) | modal @1 259 516; schema @12 785 876; `7362` @1 324 972, @1 329 031 |
| `5519.min.js` | File import queue: extension → format classification, team limits | @2 568 460 |
| `fullscreen__import__import.worker.js` (3.3 MB) | `.fig` archive reader / writer, defaults filled on import, Sketch (`MS*`) converter, zip.js, zstd | `On` @3 188 470, defaults `Rn` @3 188 644, reader `Hn` @3 193 863 |
| wasm strings | Shortcut table (JSON), FGSvgExport / FGPdfExport / FGExporter / FGCopyPaste / FGPaster file names, SVG format strings, PDF object keys, export-handler warnings, paste modes and toasts | — |
| Repo | `live/menus/main-file.txt`, `main-edit.txt`, `context-*.txt`, `live/popovers/export-*.txt`, `live/design/*.txt` | — |

## 2. Data model

| Item | Value | Status / evidence |
|---|---|---|
| `ExportSettings` | `suffix 1, imageType 2, constraint 3, svgDataName 4, svgIDMode 5, svgOutlineText 6, contentsOnly 7, svgForceStrokeMasks 8, useAbsoluteBounds 9, colorProfile 10, quality 11, useBicubicSampler 12, frameRate 13, loopCount 14, backgroundType 15, duration 16, svgAnimated 17, pdfPrint 18` | CONFIRMED, `3187 @12 785 876` schema text |
| `ImageType` | PNG 0, JPEG 1, SVG 2, PDF 3, MP4 4, GIF 5, WEBM 6, LOTTIE 7, DOTLOTTIE 8 | CONFIRMED, schema |
| `ExportConstraintType` | CONTENT_SCALE 0, CONTENT_WIDTH 1, CONTENT_HEIGHT 2 (`ExportConstraint {type, value}`) | CONFIRMED, schema |
| `ExportColorProfile` | DOCUMENT 0, SRGB 1, DISPLAY_P3_V4 2, CMYK 3 | CONFIRMED, schema |
| `ExportSVGIDMode` | IF_NEEDED 0, ALWAYS 1 | CONFIRMED, schema |
| `ExportBackgroundType` | SOLID 0, TRANSPARENT 1, GRID 2 (video export background) | CONFIRMED, schema |
| Node fields | `exportSettings` (array), `exportContentsOnly`, `exportBackgroundDisabled`, `exportTextAsSVGText`, `inheritExportStyleID` | CONFIRMED, wasm strings |
| Clipboard Message fields | `pasteID 12`, `pasteOffset 13`, `pasteFileKey 14`, `pasteIsPartiallyOutsideEnclosingFrame 19`, `pastePageId 20`, `isCut 21`, `pasteBranchSourceFileKey 26`, `pasteEditorType 27`, `publishedAssetGuids 29`, `clipboardSelectionRegions 33`, `pasteAssetType 41`, `originFileKey 47` | CONFIRMED, `3187` `message Message{…}` |

## 3. The Export section (Design panel)

### 3.1 Rows and adding

| Item | Value | Status / evidence |
|---|---|---|
| Header | "Export" with "+" (tooltip `section_exports.tooltip_addExportSettings`, live: [Add export settings]); a click on the header adds when empty | CONFIRMED, `4989`; live `design/rectangle-with-stroke.txt` |
| Default of a new row | PNG, scale 1, suffix "", `contentsOnly true`, `useAbsoluteBounds false`, `useBicubicSampler true`, `colorProfile DOCUMENT` | CONFIRMED, `4989 @48 019` (`t9`) |
| Next "+" | If no row is 1x (or any non-scale row exists, counted as "has 1x"), add 1x. If a 1x exists and no 2x: add **2x "@2x"**. If 1x and 2x exist and no 3x: add **3x "@3x"**. If 1x, 2x and 3x all exist: add **1x ""** again. There is no automatic 4x. | CONFIRMED, `4989 @48 019` |
| Auto suffix function | 2 → "@2x", 3 → "@3x", 4 → "@4x", anything else → "" | CONFIRMED, `4989: "2===e?"@2x":3===e?"@3x":4===e?"@4x":"""` |
| Animated default (Motion) | MP4, scale 1, quality 1, frameRate 30, duration 0, plus the static defaults | CONFIRMED, `t9(…, true)` |
| Row anatomy | constraint combo (left), format select (width fill), "Advanced export settings" button (sliders icon; tooltip `export_panel.export_settings`), remove "−" (`tooltip_remove`) | CONFIRMED, `4989 @70 514–73 800`; live `popovers/export-advanced-settings.txt` header |
| Remove | Removes that index and closes its popover; an empty list also resets `exportBackgroundDisabled` to false | CONFIRMED, `4989` (`onExportChange`) |
| Mixed | Several layers with different settings → "Click + to replace mixed export settings" (`click_plus_to_replace_mixed_export_settings`); "+" writes the shared settings or one default to every layer | CONFIRMED (key, `addProperty`) |
| Nothing selected | The page's own export settings are shown; Export then opens the Export modal (⇧⌘E) instead of exporting | CONFIRMED, `4989 @57 751` ("Export Picker Opened", from "export-panel") |
| Disabled | When the file forbids export: title `export_disabled` with an icon and `this_file_s_editor_has_disabled_exporting_copying_and_sharing.seat_rename` | CONFIRMED, `4989` |

### 3.2 The constraint (scale / size) field

| Item | Value | Status / evidence |
|---|---|---|
| Presets (chevron menu) | **0.5x, 0.75x, 1x, 1.5x, 2x, 3x, 4x, 512w, 512h** | CONFIRMED, `4989 @70 514` |
| Parse | lower-cased; contains "w" → width, else contains "h" → height, else scale; the letters x / w / h are stripped and the rest parsed as a number expression | CONFIRMED, `figma_app @1 693 977` |
| Format | value rounded to 2 decimals, then `2x` / `512w` / `512h` | CONFIRMED |
| Clamp | scale ≤ **1024**, width / height ≤ **32768**; ≤ 0 becomes **1** | CONFIRMED, `MAX_SCALE=1024, MAX_SIZE=32768` |
| Nudge | ↑ / ↓ by **0.5**, with ⇧ by **1** | CONFIRMED, `getNudgeAmount(e){return e?1:.5}` |
| Disabled | for SVG and PDF (scale is forced to 1) | CONFIRMED, `disabled:"SVG"===…||"PDF"===…` |
| Keyboard hint | aria-description `split_input_description` with "⌘↓" (mac) / "⌃↓" | CONFIRMED |
| Suffix follows scale | When the current suffix is non-empty and equals the auto suffix of the old value, changing the constraint rewrites the suffix to the new value's auto suffix (2x "@2x" → 3x "@3x"; → 1.5x ""). A typed suffix is kept. | CONFIRMED, `4989` (`onConstraintChange`) |

### 3.3 Formats and switching

| Item | Value | Status / evidence |
|---|---|---|
| Format menu | **PNG, JPEG, SVG, PDF**; with Motion (`metronome`) and video allowed also MP4, GIF, "WebM"; the menu shows "JPEG" (live) | CONFIRMED, `4989 @72 022`; live `popovers/export-format-menu.txt` |
| → PNG | keeps contentsOnly, colour profile, bounds, sampler, suffix, constraint | CONFIRMED, `nS @73 809` |
| → JPEG | as PNG plus `quality 1` (High) | CONFIRMED |
| → PDF | constraint reset to 1x, `quality 0.76` (Medium), auto suffix reset (an auto "@2x" becomes "") | CONFIRMED |
| → SVG | constraint 1x, auto suffix reset, `svgIDMode IF_NEEDED`, `svgOutlineText true`, `svgForceStrokeMasks false` (Simplify stroke on), `svgAnimated false` | CONFIRMED |
| → MP4 / WebM | quality 1, frame rate = the format's default, duration kept | CONFIRMED |
| → GIF | frame rate default, `loopCount 0` (forever) | CONFIRMED |
| → Lottie / dotLottie | constraint 1x, auto suffix reset | CONFIRMED |

### 3.4 Export button, preview, extras

| Item | Value | Status / evidence |
|---|---|---|
| Label, nothing selected | `export_title` with the file name ("Export ‹file›") | CONFIRMED, `4989` |
| Label, one layer | `export_title` with the layer name ("Export ‹name›"); in the standalone panel just "Export" | CONFIRMED |
| Label, several | `export_this_props_num_selected_layers` ("Export N layers", INFERRED wording) | CONFIRMED (key) |
| Busy | `export_generating_name` while AI "Rename layers" runs before export | CONFIRMED |
| Rename layers | An AI checkbox "Rename layers" (`auto_rename_layers.rename_layers`) under the button when the selection has unnamed layers; remembered per node while the panel lives | CONFIRMED |
| Preview | A collapsible thumbnail of the first setting's output (uses its `useAbsoluteBounds`, `useBicubicSampler` and colour profile) | CONFIRMED, `_previewThumbnail` |
| Static / Animated tabs | With Motion and an exportable timeline: a segmented "Static" / "Animated" row (`export_section.tab_*`); Animated shows a motion card (format, size, frame rate, duration, loop, file size in KB / MB, lint "N issues to review") | CONFIRMED; details in `rea/motion.md` §2.25 |
| What gets downloaded | If any setting has `contentsOnly false` (overlapping layers included), the whole page's images are fetched first; else only the selected nodes' | CONFIRMED, `includeOutsideContents` in `onClickExport` |

## 4. Export settings popover ("Advanced export settings")

Width **240** (live 240 × 184 for a PNG), title "Export", close ×, opens at the row (`cn(row, 240)`). Rows in order:

| Row | Shown for | Values | Default | Status / evidence |
|---|---|---|---|---|
| Suffix | all | text, placeholder "None" | "" | CONFIRMED, `7621`; live |
| Color profile | all | **"Same as file"** = DOCUMENT (shown "sRGB (same as file)" or "Display P3 (same as file)"), "sRGB", "Display P3" (DISPLAY_P3_V4). CMYK only in Buzz print | DOCUMENT | CONFIRMED, `7621 @280 958` (`L=["DOCUMENT","SRGB","DISPLAY_P3_V4"]`, `F=["CMYK"]`); live |
| Quality | JPEG, PDF, MP4, WebM | High, Medium, Low (in that order) | JPEG High, PDF Medium | CONFIRMED |
| Frame rate | GIF, MP4, WebM | GIF **8, 12, 15, 24, 30** fps; MP4 / WebM **12, 24, 25, 30, 60** fps; with the timeline-frame-rate gate a first option "Timeline" (0) | 30 | CONFIRMED, `7621 @286 856` |
| Loop forever | GIF | checkbox, `loopCount 0` when on | on | CONFIRMED |
| Image resampling | every format but SVG | "Detailed" (bicubic) / "Standard" | Detailed | CONFIRMED, live label "Image resampling", value "Detailed"; key `export_settings_image_sampling.bicubic / .standard` |
| Ignore overlapping layers | every format but PDF | checkbox = `contentsOnly` | on | CONFIRMED; live |
| Include bounding box | when the engine says the selection has text-node export options | `useAbsoluteBounds` | off | CONFIRMED (`shouldShowTextNodeExportOptions`) |
| Include "id" attribute | SVG | `svgIDMode ALWAYS` / `IF_NEEDED`; tooltip `export_layer_names_using_id_attributes` | off | CONFIRMED |
| Outline text | SVG, when the selection has text | `svgOutlineText`; tooltip `export_text_as_outlined_path_element` | on | CONFIRMED |
| Simplify stroke | SVG, when a stroke is maskable as SVG (`isStrokeMaskableAsSVG`) | inverse of `svgForceStrokeMasks`; tooltip `export_stroke_as_inlined_path_element` | on | CONFIRMED |

**Quality levels ↔ stored number** (`7621 @277 718`, CONFIRMED):

| Level | JPEG | PDF | MP4 / WebM |
|---|---|---|---|
| Low | 0.75 | 0.5 | 0.4 |
| Medium | 0.8 | 0.76 | 0.7 |
| High | 1 | 1 | 1 |

A stored number is shown as the level it equals within 1e-6 (else High); video thresholds are ≤ 0.4 Low, ≤ 0.7 Medium, else High. PNG has no quality (−1).

## 5. The Export modal (File › Export… ⇧⌘E)

| Item | Value | Status / evidence |
|---|---|---|
| Shortcut | ⇧⌘E / Ctrl+Shift+E (`export-selected-exportables`; not in FigJam, Sites, Buzz) | CONFIRMED, wasm shortcut JSON; live `menus/main-file.txt` "Export… ⇧⌘E" |
| Window | Draggable by its header, title "Export", width **318**, opens at x = window width − 318, y = toolbar bottom + 12 | CONFIRMED, `1540 @445 124` |
| Content | Every exportable item: the selection's layers with export settings, else the page's (one row per layer × setting) | CONFIRMED (`exportableItems`); scope INFERRED |
| Header | checkbox "‹n› of ‹m› selected" (mixed when partly checked; toggles all) and "Export" (secondary, autofocus, disabled at 0 checked) | CONFIRMED |
| Row | hidden label "Select for export", checkbox, a **32 × 32** thumbnail (click pans to the layer; tooltip = output file name), name, an optional warning line (icon + text + tooltip), right column "‹constraint› ‹TYPE›" and the estimated size | CONFIRMED |
| Empty | `no_selected_layers_with_export` | CONFIRMED |
| Progress | "Preparing / exporting ‹x› of ‹y›" with Cancel, then "Exporting…", "Downloading…" or "Downloading ‹x› of ‹y›" with Cancel | CONFIRMED (keys) |
| Scheduling | thumbnails and exports run as jobs, at most **6 ms** of work per animation frame | CONFIRMED, `msPerTick:6` |
| Footer | AI "Auto rename layers" (Cancel while running) | CONFIRMED |
| After | the modal closes, toast cleared, event `export_completed` | CONFIRMED |

## 6. Export frames to PDF (File menu)

| Item | Value | Status / evidence |
|---|---|---|
| Entry | File › "Export frames to PDF…" (`export-all-frames-to-pdf`) | CONFIRMED, live `menus/main-file.txt` |
| Modal | width "lg", title "Export frames to PDF", Color profile (default DOCUMENT) and Quality (default **0.76** = Medium) | CONFIRMED, `3187 @1 259 516` |
| Buttons | Export / "Exporting to PDF…" (`exporting_to_pdf`); on failure `unable_to_export` | CONFIRMED (keys) |
| Content | Every top-level frame of the current page, one PDF page each | CONFIRMED (wasm "Found no top-level frames to export to PDF") |
| Errors | "Found no content exportable to PDF. This can happen when all top level frames are invisible, or empty and without background…"; "Failed to export an object that needed to be rasterized to PDF… insufficient VRAM… or an image has not yet loaded"; toast `cant_export_empty_or_hidden_layers_to_pdf`, `exporting_slices_to_pdf_is_currently_unsupported`, `there_are_no_top_level_frames_on_the_current_page_to_export` | CONFIRMED, wasm |
| Page order | not read from the build | Open question 3 |

## 7. The export pipeline

| Item | Value | Status / evidence |
|---|---|---|
| File name | the layer name + suffix + extension; "/" in the name makes folders | CONFIRMED (archive treats "/" as a folder path); naming INFERRED from help + repo |
| One file | A session with a single file and no "/" downloads that file directly, unzipped | CONFIRMED, `2108 @904 921` (`pendingFile` path) |
| Several files | A ZIP built with zip.js (`application/zip`, per-file compression level, web workers unless `zipjs_disable_workers`) | CONFIRMED |
| Duplicate names in a ZIP | the first keeps its name; the next get **base + 1 + ext**, base + 2 + ext … ("Frame1.png", "Frame2.png") — no space | CONFIRMED, `_uniqueArchiveFilename` |
| ZIP name | passed from the engine (`outputFilename`); value not seen | Open question 2 |
| Export warnings (modal rows) | `export_handler.origin_not_aligned_to_pixels`, `origin_snapped(_tooltip)`, `dimensions_exceeded_maximum(_tooltip)`, `dimensions_exceeded_and_origin_snapped` | CONFIRMED, wasm |
| Maximum size | a runtime value: the engine clamps to a maximum dimension and warns; "Maximum supported image dimension is %u pixels" | CONFIRMED (strings); number: Open question 1 |
| Threaded export | render-worker export with an admission step and a synchronous fallback: "Render worker export failed, falling back to synchronous export", "Adaptive memory policy routed export to synchronous execution" (gates `fullscreen_use_threaded_exporter`, `fullscreen_threaded_export_*`) | CONFIRMED, wasm |
| Failures | toast `visual_bell.export_failed`; "Cannot export node that doesn't exist"; "Image resource has no data for render worker export - image may still be loading" | CONFIRMED, wasm |
| Telemetry | `png_export_attempted`, `jpeg_export_attempted`, `pdf_export_attempted`, `svg_export_event`, `export_frames_to_pdf_attempted / _succeeded` | CONFIRMED, wasm |
| Plugin / AI metadata export | scale must be in **0.01 … 4**; a max size needs width and height > 0, and both or neither | CONFIRMED, wasm "expected export scale in range .01 ... 4 in image metadata export" |

## 8. SVG output

What the writer emits, from its format strings and attribute names (wasm, `fullscreen/lib/editor/export/FGSvgExport.cpp`). Structure details marked INFERRED match Figma's well-known SVG output and the strings found.

| Element | Output | Status / evidence |
|---|---|---|
| Root | `<svg width height viewBox fill="none" xmlns="http://www.w3.org/2000/svg">`; a variant with `xmlns:xlink` and `width="%g" height="%g"` exists | CONFIRMED strings (`viewBox`, `xmlns`, the xlink root); the `fill="none"` root INFERRED |
| Ids | `paint%d_%s_%s` (gradients: index, kind, node id), `clip%d_%s`, `mask%d_%s`, `filter%d_%s_%s`, `pattern%d_%s`, `image%d_%s`, `stroke%d_%s`, `bgblur_%d_%s_clip_path`, effect results `effect%d_dropShadow_%s` / `_innerShadow_` / `_foregroundBlur_` / `_noise_` / `_texture_` | CONFIRMED, wasm |
| Node id in ids | `%s` = the node GUID as "session_local" (e.g. `clip0_12_34`) | INFERRED |
| Layer names | with "Include id attribute" every element gets `id` = layer name; otherwise only where needed (IF_NEEDED); `data-name` exists for names that are not valid ids | CONFIRMED (enum, `data-name` string); usage INFERRED |
| Linear / radial gradients | `<linearGradient>` / `<radialGradient>` with `gradientUnits="userSpaceOnUse"`, `gradientTransform`, `<stop stop-color offset>`, `stop-opacity` | CONFIRMED strings |
| Angular / diamond gradients | a `<foreignObject>` holding an XHTML div with `background:conic-gradient(from 90deg,…)`, clipped to the shape; marked `data-figma-gradient-fill` / `data-figma-gradient-stroke` so re-import restores the paint | CONFIRMED strings; layout INFERRED |
| Images | `<pattern>` (`patternContentUnits`) + `<use xlink:href="#image…" transform>` + `<image … xlink:href="data:image/png;base64,…">` | CONFIRMED strings |
| Clip content | `<clipPath>` with the frame's shape, `clip-path="url(#…)"` on a `<g>` | CONFIRMED strings |
| Masks | `<mask … style="mask-type:alpha|luminance" maskUnits="userSpaceOnUse">` | CONFIRMED strings (`mask-type`, `maskUnits`, `luminance`, `alpha`) |
| Shadows | `<filter … filterUnits="userSpaceOnUse" color-interpolation-filters="sRGB">`, `<feFlood flood-opacity="0" result="BackgroundImageFix"/>`, `SourceAlpha` → `hardAlpha` (`values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 127 0"`), `feOffset`, `feGaussianBlur stdDeviation` (= radius / 2), `feComposite in2="hardAlpha" operator="out"` (drop) or `arithmetic k2="-1" k3="1"` (inner), colour `feColorMatrix`, `feBlend mode result=effectN_…` | CONFIRMED strings; σ = r/2 in `rea/effects.md` |
| Layer blur | `feGaussianBlur` | CONFIRMED |
| Background blur | a `<foreignObject>` with `style="backdrop-filter:blur(…);clip-path:url(#bgblur_…_clip_path);height:100%;width:100%"` and `data-figma-bg-blur-radius` | CONFIRMED strings |
| Noise / texture | `feTurbulence type="fractalNoise" baseFrequency numOctaves="3" seed`, `feDisplacementMap`, `feComponentTransfer` / `feFuncA type="table"` / `type="discrete"` | CONFIRMED strings |
| Glass | no SVG filter (dropped) | CONFIRMED, chapter 08 |
| Blend modes | `style="mix-blend-mode:%s"`; `isolation` | CONFIRMED strings |
| Strokes | inside / outside strokes become masks unless "Simplify stroke" can inline them as a path (`svgForceStrokeMasks`) | CONFIRMED (field + tooltip "inlined path element") |
| Text | outlined to paths by default; with Outline text off: `<text>` / `<tspan>` with `xml:space="preserve"`, `font-family`, `font-weight`, `font-style`, `letter-spacing`, `fill` | CONFIRMED strings; hyperlinks on a text path "not yet implemented" |
| Transforms | `matrix(%g %g %g %g %g %g)`, `rotate(%g)`, `scale(%g %g)` | CONFIRMED |
| Scatter brushes | one definition + `<use>` per instance, `data-figma-scatter(-ref)` | CONFIRMED, `rea/vector.md` |
| Animated SVG | SMIL `<animate attributeName="d" … calcMode="spline" repeatCount="indefinite">` | CONFIRMED, `rea/motion.md` |
| Copy as SVG | the same writer to the clipboard as text; toast `visual_bell.copied_as_svg` | CONFIRMED |

## 9. PDF output

| Item | Value | Status / evidence |
|---|---|---|
| Version | `%PDF-1.7` | CONFIRMED, wasm |
| Writer | Figma's own (`FGPdfExport.cpp`): vector paths, Shading / Pattern (TilingType) objects, ExtGState transparency groups, SMask, `FlateDecode` | CONFIRMED (object keys in wasm) |
| Fonts | embedded as **TrueType** or **Type3**, CID with `/Registry (FigmaPDF)` `/Ordering (FigmaPDF)`, `ToUnicode` maps (selectable text) | CONFIRMED strings |
| Accessibility | tagged: `StructTreeRoot`, `StructElem`, `ParentTree`, `MarkInfo /Marked`, `ActualText`, `BDC`/`BMC` marked content, `ViewerPreferences /DisplayDocTitle`, XMP `pdfuaid:part 1` (PDF/UA-1) | CONFIRMED strings |
| Links | `Annot` / `Annots` with `Rect` (prototype / hyperlinks) | CONFIRMED keys; behaviour INFERRED |
| Rasterised parts | what PDF can't express is rasterised (e.g. background blur, custom effects, patterns that need masks) at export; failure messages above | CONFIRMED strings ("Unexpected unrasterized subtree exporting PDF") |
| Colour | DeviceRGB / DeviceGray / DeviceCMYK (CMYK for Buzz print); gate `ce_pdf_srgb_use_standard` | CONFIRMED |
| Quality | applies to the JPEG images inside (0.5 / 0.76 / 1) | INFERRED |
| Producer | `/Producer` key present; the value was not found | Open question 4 |

## 10. Copy as …, copy link, properties

**Menus** (CONFIRMED, `1540 @547 235`; live `menus/main-edit.txt`, `context-frame.txt`):
- Edit menu: Undo ⌘Z, Redo ⇧⌘Z, — Copy as ▸, Paste over selection ⇧⌘V, Paste to replace ⇧⌘R, Duplicate ⌘D, Delete ⌫ … — Copy properties ⌥⌘C, Paste properties ⌥⌘V.
- Layer context menu: Copy, Paste here, Paste to replace, "Copy/Paste as ▸".
- Empty canvas context menu: "Paste here".
- "Copy/Paste as" submenu order: **Copy as text**, (Copy hyperlink, when the selection holds one), **Copy link** (when sharable), **Copy as code ▸** (CSS, CSS (all layers) = `copy-as-css-recursive`, iOS, Android; plus a Dev Mode upsell row when Dev Mode isn't available), **Copy as SVG**, (Copy as animated SVG, Motion), **Copy as PNG**, —, **Copy properties**, **Paste properties**, (Paste animation, Motion). Export items are hidden without export rights and disabled while approvals block export.

**Shortcuts** (wasm shortcut JSON, CONFIRMED):

| Command | mac | other |
|---|---|---|
| copy-as-png | ⇧⌘C (not in text edit) | Ctrl+Shift+C |
| copy-link | ⌘L (desktop app only, not in text edit) | Ctrl+L |
| copy-properties | ⌥⌘C | Ctrl+Alt+C |
| paste-properties | ⌥⌘V | Ctrl+Alt+V |
| paste-over-selection | ⇧⌘V | Ctrl+Shift+V |
| paste-to-replace | ⇧⌘R (not in Safari), also ⇧⌥⌘V | Ctrl+Shift+R, Ctrl+Shift+Alt+V |
| place (image / video) | ⇧⌘K | Ctrl+Shift+K |
| duplicate-in-place | ⌘D | Ctrl+D |
| export-selected-exportables | ⇧⌘E | Ctrl+Shift+E |

**Copy as PNG** (CONFIRMED, `7362`): the engine renders the selection (`exportSelectionAsPngBufferAsync`) and the PNG is written with the async Clipboard API as `image/png` plus the custom `web image/png` type. Success toast `visual_bell.copied_as_png`. If the browser refuses the write (NotAllowedError / SecurityError — the render took too long to count as a user gesture) the toast becomes `copy_as_png_export_completed` with a button `copy_as_png_copy_to_clipboard` that retries the write once; other errors give `copy_as_png_failed` with "Retry". The scale (Figma's help says 2x) was not read from the build: Open question 5.

**Copy properties / Paste properties** (CONFIRMED, `figma_app` module 443816): the copied properties are a `STYLE`-type Message with one CREATED node at GUID 0:0 holding the copied fields and `pasteFileKey`, encoded by the engine (`encodeStylePropertiesClipboard`) and written into the system clipboard's `text/html` inside the same `(figma)` markers (§11). Paste properties applies them through `PropertiesPaste`; toast `visual_bell.copied_properties`. Which fields are copied: Open question 6.

**Copy as text**: the text layers' characters (`copy-text`). **Copy layer name** exists as an action (`copy-layer-name`).

## 11. The clipboard format

| Item | Value | Status / evidence |
|---|---|---|
| Flavours written on ⌘C | `text/html` and `text/plain` in one ClipboardItem (or in the DOM copy event's DataTransfer) | CONFIRMED, `figma_app @7 069 042` |
| HTML shape | `<meta charset="utf-8"><div><span data-metadata="<!--(figmeta)` BASE64-JSON `(/figmeta)-->"></span><span data-buffer="<!--(figma)` BASE64-BYTES `(/figma)-->"></span></div>` followed by `<span style="white-space:pre-wrap;">` + the plain text, HTML-escaped, newlines as `<br>` | CONFIRMED |
| Metadata JSON | base64 of UTF-8 JSON: `fileKey`, `pasteID`, `dataType` ("scene"), `editorType`, `selectedNodeData` ("guid\|nodeTypeNumber" joined by ",") | CONFIRMED (readers of `fileKey`, `editorType`, `selectedNodeData`); `pasteID` / `dataType` per repo `figmaClipboard.ts` |
| Buffer | base64 (1024-byte chunks through `btoa`) of a fig-kiwi archive (§14.2) holding a `Message` | CONFIRMED (`H9` → `btoa`) |
| Reading | markers searched raw first, then HTML-escaped (`&lt;!--(figma)`), because some apps re-escape the HTML | CONFIRMED |
| Text-only Figma copy | when every `selectedNodeData` entry is TEXT (or sticky / shape-with-text / code block), a paste into a text field takes the plain text | CONFIRMED (`h(e)` in 443816) |
| Other markers | `(figh2d)` … `(/figh2d)` (HTML-to-design payload) | CONFIRMED |
| Cross-file | the engine compares `pasteFileKey` with the open file: `COPY_PASTE_SAME_FILE` / `COPY_PASTE_DIFFERENT_FILE` / `COPY_PASTE_FROM_FIGMA`; a newer buffer is migrated ("Migrating paste buffer to higher version"); an incompatible one gives `can_t_paste_this_data_between_different_file_versions_please_refresh_file_and_retry` | CONFIRMED, wasm |
| Images in a copy | referenced by hash, not embedded; a cross-file paste downloads them (`imageDownloadedForPaste`); failure toasts `images_could_not_be_pasted_from_source_file`, `videos_could_not_be_pasted_from_source_file` | CONFIRMED, wasm |
| Pasted image files | read from `navigator.clipboard` as `image/png` (preferring `web image/png`), wrapped as a File named **"image.png"** | CONFIRMED, `7362 @1 324 972` |
| Permission | a denied clipboard read is reported (`clipboard_permission_denied`) | CONFIRMED |

## 12. Paste

### 12.1 What a paste becomes

The engine's paste handlers (wasm `handle-paste-*`, `FGCopyPaste.cpp`, `FGPaster.cpp`), CONFIRMED by name; order INFERRED from the JS readers:

| Clipboard holds | Result |
|---|---|
| Figma `(figma)` buffer | the layers (`handle-paste-scenegraph`); style properties (`handle-paste-style`) |
| SVG markup (`image/svg+xml` or text) | editable layers (`handle-paste-svg`, file key `PASTE_FROM_SVG_FAKE_FILE_KEY`) |
| Illustrator copy | vectors on desktop (PDF / SVG flavours); on the web: toast `illustrator_web_paste_unsupported` |
| HTML table from Google Sheets (`google-sheets-html-origin`) or Excel (`content=Excel.Sheet`), or HTML that is only one table | a table / grid (`handle-paste-spreadsheet`, `table_from_spreadsheet_paste_created`, `grid_from_spreadsheet_paste_created`) |
| Mermaid text | a diagram (`pasteMermaidAsDiagram`; toasts success / failure) — FigJam-oriented |
| Image files / PNG | image layers (`handle-paste-files`) |
| A URL on selected text | a hyperlink (`url_pasted_on_selected_text`, `paste_hyperlink_into_text_range`); an e-mail likewise |
| Plain text | a new text layer (`handle-paste-text`), or inserted into the text being edited |
| HTML-to-design `(figh2d)` | layers (`handle-paste-h2d`) |
| Page nodes | refused: `paste_page_node_not_supported` |
| Sections where not allowed | pasted as a group, toast `sections_aren_t_quite_ready_for_figma_just_yet_we_pasted_your_section_as_a_group` |
| FigJam ↔ Design | refused: `can_t_paste_between_fig_jam_and_editor_files` |

### 12.2 Paste commands and placement

| Command | Behaviour | Status / evidence |
|---|---|---|
| Paste ⌘V | Into the one selected frame when the copied content fits (kept at its relative position per axis, else centred); next to a selected layer; else at the copied page position, or centred in the view when that is out of view; then the view is brought to the pasted layers. **No offset** is added when pasting at the same place. | Rules from help.figma.com "Copy and paste objects", as summarised in `docs/engine.md` (Paste); INFERRED, not read in the binary |
| Paste here (context menu) | at the pointer (`PASTE_HERE`, `paste_at_mouse`) | CONFIRMED (strings) |
| Paste over selection ⇧⌘V | a sibling above the selection at the selection's top-left (`PASTE_OVER_SELECTION`) | CONFIRMED (mode); placement from help |
| Paste to replace ⇧⌘R | a copy at each selected layer's place (parent, order, position, constraints), the layer removed (`pasteAndReplace`, `inPasteToReplace`) | CONFIRMED (mode); details from help |
| Absolute position in auto layout | a paste into an auto-layout frame of a layer copied as absolute keeps it absolute and shows `visual_bell.paste_absolute_position` | CONFIRMED (string, `pasteAbsolutePosition`) |
| After paste | pasted nodes are resized / repaired (`resize-pasted-nodes`, `repair-and-insert-pasted-nodes`, `repair-hyperlinks-on-paste`, `tidy-after-paste`) | CONFIRMED (names) |
| Instances | components copied with the layers; cross-file instances of library components subscribe to the library ("paste failed to subscribe symbols"); a cycle refused (chapter 10) | CONFIRMED |
| Paste and match style | `paste_and_match_style` (text) | CONFIRMED (key) |

## 13. Placing images

| Item | Value | Status / evidence |
|---|---|---|
| Place image/video… ⇧⌘K | File menu "Place image/video…"; a file picker; the chosen files load into the image tool | CONFIRMED, live `main-file.txt`; shortcut JSON |
| Placing several | The toolbar shows a secondary bar: "Click or drag to place" (`click_or_drag_to_place`), button **"Place all"** (`place_all_images`), and a discard button (`discard_all_images`). Each click places the next image at its natural size; a drag sets the size; "Place all" places the rest at once (`place-all-images`). | CONFIRMED, `figma_app @3 205 585` |
| Drag-drop | dropped files load asynchronously (`dropped-file-async-load-file`); several image files are laid out in a grid (`dropped-files-place-in-grid`); a drop onto a shape fills it | CONFIRMED (names); fill-on-drop INFERRED |
| Unsupported drops | PSD: `dropped_file.psd_import_is_not_supported`; PDF on the canvas (design): `pdf_import_is_not_supported`; others `file_format_not_recognized_or_failed_to_convert`, `files_failed_to_import` | CONFIRMED, wasm |
| Size limits and downscale | decode cap 4096 × 4096 with the half-area exception; toast `bindings.image_resized_message` with "Learn more"; GIFs get `gif_converted…` | CONFIRMED; rules in chapter 07 §8.6 |
| MIME types | png, jpeg, gif, webp, avif, tiff, bmp, heic, svg+xml, jp2, vnd.ms-photo; video mp4, quicktime, webm | CONFIRMED, wasm |

## 14. Importing files

### 14.1 The import queue (Home / Drafts, or File › Import)

| Item | Value | Status / evidence |
|---|---|---|
| Classification by extension | `.pdf .svg .sketch .zip .jamboard` (and `.md` behind a gate) by name; `.gif .png .jpg .jpeg` → "img"; `.fig .jam .deck .site .buzz .make` → first 20 bytes read: a ZIP → "fig-zip", else "fig-kiwi" | CONFIRMED, `5519 @2 568 460` |
| Destination | the chosen folder, else the open folder, else Drafts; team file limits per editor type ("‹team› is at the Figma file limit", FigJam / Slides / Buzz / Make variants); no permission → "Go to drafts" | CONFIRMED |
| Sketch | a dropped single `.sketch` file on the editor goes back to Files and imports into Drafts; `accept:".sketch"` picker | CONFIRMED |
| SVG from the file browser | refused: "To import an SVG, drag it directly into an open Figma file" (`to_import_an_svg_drag_it_directly_into_an_open_figma_file`) | CONFIRMED |
| PDF | > **50 MB** refused (`your_pdf_is_larger_than_50mb`); a confirmation step and a PDF type (Miro / Mural / Lucid / Jamboard / unknown, FigJam) | CONFIRMED |
| Images in an import | uploaded in batches of **5** to `/api/upnode/image?purpose=canvas&sha1=…`, **3** attempts with back-off 1 s × 2ⁿ plus jitter (doubled on 429 / 503); HTTP 413 counts as oversized, 400 as invalid → warnings `oversized_files_images_exceeded_max_size`, `import_invalid_images`; on failure the half-made file is deleted | CONFIRMED, `figma_app @2 091 593` |
| Other errors | `could_not_convert_file`, `file_timed_out`, `file_contains_text_either_too_big_or_too_small`, `internal_error_please_try_again_later`, `oops_this_service_is_temporarily_unavailable` | CONFIRMED (keys) |

### 14.2 The `.fig` archive (import worker)

| Item | Value | Status / evidence |
|---|---|---|
| Magic (8 bytes) | `fig-kiwi` (design), `fig-jam.` (FigJam), `fig-deck` (Slides), `fig-site` (obfuscated in code), `fig-buzz`, `fig-make` | CONFIRMED, worker @3 188 470 |
| Layout | magic, u32 LE version, u32 schema length + compressed schema, u32 message length + compressed message, then chunks (u32 length, 8-byte tag): a tag equal to the PNG signature is the **thumbnail** (at most one); unknown tags skipped | CONFIRMED, worker @3 193 863 |
| Version | files with version > **110** are refused ("Unrecognized file version"); the writer stamps its own version | CONFIRMED (`bn=110`) |
| Compression | zstd when the data starts with `28 B5 2F FD`, else deflate (raw) | CONFIRMED |
| ZIP form | `canvas.fig`, `meta.json`, `thumbnail.png`, `images/` (by hash), plus `code_connect.json`, `make_repos.json`, `make_binary_files/`; a Sketch archive has `document.json` and `previews/preview.png` | CONFIRMED, worker strings |
| Checks | message type must be NODE_CHANGES; every node needs a GUID; `parentIndex.position` must be printable ASCII; strings are cut at the first NUL; an optional round-trip check lists discarded fields ("⚠️ This file could not be fully imported…") | CONFIRMED |
| Defaults filled for missing fields | name "Object", visible, opacity 1, identity transform, constraints MIN, blend PASS_THROUGH, size 100 × 100, `exportSettings []`, `exportContentsOnly true`; GROUP → FRAME with `resizeToFit`; frames get background paints from the legacy fields; shapes get fill #DADADA (218/255) and text black; text defaults Roboto Regular 12, line height 100 %, letter spacing 0 px, LEFT / TOP, auto-resize NONE; strokes CENTER, MITER, miter 4 | CONFIRMED, worker @3 188 644 |
| Sketch converter | in the worker (`MSImmutable*` classes: artboards, groups, shapes, text with NSAttributedString, symbols, shared styles, images) | CONFIRMED |

## 15. UI strings

English text is given where attested (live captures, repo i18n, Figma's help); otherwise the i18n key only.

Export section and popover (live-attested English in quotes):
- "Export", [Add export settings], "Export file type", "Advanced export settings", "PNG", "JPEG", "SVG", "PDF", "Suffix", "None", "Color profile", "sRGB (same as file)", "Image resampling", "Detailed", "Ignore overlapping layers" (live).
- Keys: `fullscreen.properties_panel.export`, `export_title`, `export_this_props_num_selected_layers`, `export_generating_name`, `export_disabled`, `this_file_s_editor_has_disabled_exporting_copying_and_sharing.seat_rename`, `click_plus_to_replace_mixed_export_settings`, `section_exports.tooltip_addExportSettings`, `export_settings.constraints.aria_label`, `split_input_description`, `export_settings_image_file_type`, `export_panel.export_settings`, `tooltip_remove`, `export_suffix_label`, `export_suffix_placeholder.none`, `export_settings_color_profile` (`.document`, `.srgb`, `.p3`, `.display_p3`, `.cmyk`), `export_settings_quality` (`.high`, `.medium`, `.low`), `export_settings_frame_rate` (`.fps`, `.timeline`), `export_settings_loop_forever`, `export_settings_image_sampling` (`.bicubic`, `.standard`), `ignore_overlapping_layers`, `include_bounding_box`, `include_id_attribute`, `export_layer_names_using_id_attributes`, `outline_text`, `export_text_as_outlined_path_element`, `simplify_stroke`, `export_stroke_as_inlined_path_element`, `fill.include_the_canvas_or_group_background_in_exports`, `export_section.*` (tab_static, tab_animated, tab_legend, export_frame, export_named_frame, format_label, size_label, dimensions_*, duration_label, loop_label, file_size_*, mixed_value, video_dimensions_too_small, format_lottie, update_desktop_lottie), `export_lint.*`, `fullscreen.export_panel.*` (upgrade banners).

Export modal and PDF:
- "Export…", "Export frames to PDF…" (live menu).
- Keys: `fullscreen.export.export`, `select_for_export`, `num_selected_of_total_selected`, `view_selection_on_canvas`, `no_selected_layers_with_export`, `preparing_exporting_progress_of_exporting_total`, `exporting`, `downloading`, `downloading_progress`, `cancel`, `export_frames_to_pdf`, `export_to_pdf`, `exporting_to_pdf`, `export_file_type`, `unable_to_export`, `source`, `layer_export`; `fullscreen.export_handler.*` (origin_not_aligned_to_pixels, origin_snapped, origin_snapped_tooltip, dimensions_exceeded_maximum, dimensions_exceeded_maximum_tooltip, dimensions_exceeded_and_origin_snapped); `visual_bell.exporting`, `export_failed`, `cant_export_empty_or_hidden_layers_to_pdf`, `exporting_slices_to_pdf_is_currently_unsupported`, `there_are_no_top_level_frames_on_the_current_page_to_export`, `user_cannot_export_file`.
- Wasm English (verbatim): "Found no top-level frames to export to PDF. This is an error; please contact support."; "Found no content exportable to PDF…"; "Failed to export an object that needed to be rasterized to PDF…"; "Maximum supported image dimension is %u pixels".

Clipboard:
- "Copy", "Paste here", "Paste to replace", "Copy/Paste as", "Copy as", "Paste over selection", "Copy properties", "Paste properties" (live menus).
- Keys: `fullscreen_actions.copy-as-png`, `copy-as-svg`, `copy-as-code`, `copy-as-css`, `copy-as-css-recursive`, `copy-as-ios`, `copy-as-android`, `copy-as-animated-svg`, `copy-text`, `copy-link`, `copy-hyperlink`, `copy-properties`, `paste-properties`, `paste-over-selection`, `paste-to-replace`, `paste-here`, `paste-and-match-style`, `paste-animation`, `copied_to_clipboard`; `visual_bell.copied_as_png`, `copy_as_png_export_completed`, `copy_as_png_copy_to_clipboard`, `copy_as_png_failed`, `copy_as_png.retry`, `copied_as_svg`, `copied_properties`, `copy_failed`, `copy_as_file_type_failed_try_again`, `text_copy_restricted`, `user_cannot_copy_file`, `paste_from_clipboard_failed`, `paste_absolute_position`, `paste_page_node_not_supported`, `can_t_paste_between_fig_jam_and_editor_files`, `can_t_paste_this_data_between_different_file_versions_please_refresh_file_and_retry`, `images_could_not_be_pasted_from_source_file`, `videos_could_not_be_pasted_from_source_file`, `illustrator_web_paste_unsupported`, `sections_aren_t_quite_ready_for_figma_just_yet_we_pasted_your_section_as_a_group`, `code_node_paste_unsupported`.

Placing and importing:
- "Place image/video…" ⇧⌘K (live menu).
- Keys: `fullscreen_actions.place`, `place_image`, `place_image_or_video`, `place_all_images`, `discard_all_images`, `click_or_drag_to_place`, `bindings.image_resized_message`, `bindings.image_resized_message_learn_more`; `fullscreen.dropped_file.*`; `fullscreen.file_import.*` (listed in §14.1).

## 16. DesignerV2 today

Compared with `src/renderer/src/editor/model/exports.ts`, `panels/design/Export.tsx`, `src/shared/exportFiles.ts`, `engine/src/export/SvgWriter.cpp`, `PdfWriter.cpp`, `src/shared/fig/figmaClipboard.ts`, `model/clipboard.ts`, `docs/editor.md` (E7), `docs/desktop.md` §13, `docs/engine.md` (Paste).

**Matches**
- Export section layout, presets 0.5x…4x / 512w / 512h, the w / h / x parsing, SVG/PDF scale forced to 1, the popover's rows and labels (Suffix "None", "sRGB (same as file)", "Detailed", Ignore overlapping layers, SVG's three checkboxes and defaults), the export modal (checkbox, thumbnail, name, settings, size), Export frames to PDF, single file vs ZIP, "/" folders.
- SVG writer ids (`paintN_linear…`, `clipN…`), the shadow filter chain with `BackgroundImageFix` / `hardAlpha`, background blur and angular / diamond gradients through `foreignObject`, `mask-type`, `mix-blend-mode`, σ = r/2.
- The clipboard envelope (`(figmeta)` / `(figma)` spans, fig-kiwi archive), reading Figma's own copies, cross-file paste, the paste modes (in place, at point, over selection, replace) and their shortcuts, SVG / Illustrator vector paste, plain text → text layer.
- `.fig` import (header, zstd / deflate, ZIP form).

**Differs**
- **Quality numbers**: ours Low 0.6 / Medium 0.8 / High 0.92, default JPG 0.92, PDF 0.8. Figma: JPEG 0.75 / 0.8 / 1 (default High = 1), PDF 0.5 / 0.76 / 1 (default Medium = 0.76).
- **"+" sequence**: ours adds 1x, 2x, 3x, then **4x "@4x"**; Figma never adds 4x automatically (after 1x/2x/3x it adds 1x "").
- **Suffix on format change**: ours keeps "@2x" when switching to SVG / PDF ("the suffix stays, as in Figma"); Figma resets an auto suffix to "" when the format forces 1x. Figma also rewrites an auto suffix when the scale changes (2x→3x: "@2x"→"@3x"); check ours.
- **Constraint clamps**: ours scale ≤ 100 and size ≤ 16384; Figma scale ≤ 1024, size ≤ 32768, ≤ 0 → 1; nudge 0.5 / ⇧ 1.
- **Duplicate file names**: ours "Frame 1 2.png"; Figma "Frame 11.png", "Frame 12.png" (base + number, no space, starting at 1).
- PDF writer: ours Type3 fonts and `/Producer (DesignerV2)`; Figma embeds TrueType where it can (CID, FigmaPDF registry, ToUnicode) and tags the PDF (PDF/UA).
- Angular-gradient ids: ours `paintN_angular…_clip_path`; Figma's exact id kind token is not read (Open question 7), and Figma adds `data-figma-gradient-fill` / `-stroke` and `data-figma-bg-blur-radius` for round trips.

**Missing**
- Colour profile and image resampling are stored but not applied (E7 notes); Figma converts to sRGB / Display P3 and resamples bicubic vs standard.
- Export warnings in the modal (origin not on pixels / snapped, dimension over the maximum) and the size estimate rules.
- "Include bounding box" only for text-node selections; "Outline text" only when text is present; "Simplify stroke" only when a stroke is maskable.
- Copy as code submenu (CSS, CSS (all layers), iOS, Android) — ours is one item; Copy as animated SVG; Paste animation.
- Copy as PNG's retry path when the browser refuses the late clipboard write; the `web image/png` flavour.
- Copy / Paste properties through the system clipboard (STYLE Message), so they work across files.
- Spreadsheet paste → table, URL-on-text → hyperlink, Mermaid paste.
- "Place all" / discard bar for multi-image placement; grid layout for multi-file drops.
- Import-time image upload batching, oversized / invalid image warnings; the 50 MB PDF import limit; the full set of missing-field defaults of Figma's importer (verify against `src/shared/fig/convert.ts`).
- Tagged / accessible PDF (structure tree, ActualText).

## 17. Open questions

1. **Maximum export dimension** (the `%u` in "Maximum supported image dimension is %u pixels" and the `dimensions_exceeded_maximum` clamp). Probe: export a 1x frame of 20 000 × 20 000 px in live Figma; read the modal's warning and the PNG's size.
2. **ZIP file name** for multi-file exports. Probe: export two layers in the desktop app and read the saved name.
3. **Page order in Export frames to PDF** (canvas order vs reading order vs layers order). Probe: three frames placed out of layer order, export, read page order.
4. **PDF `/Producer` and `/Title`**. Probe: export a PDF and run `qpdf --show-object=trailer` / `pdfinfo`.
5. **Copy as PNG scale** (help says 2x; the engine call takes no scale). Probe: copy a 100 × 100 frame, paste into Preview, read the pixel size.
6. **Fields copied by Copy properties** (fills, strokes, effects, corner radius, opacity, layout, text style?). Probe: copy properties from a fully styled frame and paste on a plain rectangle and a text layer.
7. **The kind token in SVG ids** (`paint%d_%s_%s` and `filter%d_%s_%s`: "linear" / "radial" / "angular"? "d" / "i" / "f" / "b"?). Probe: Copy as SVG of a rectangle with every gradient type and two effects; read the ids.
8. **Paste placement edge rules** (half-a-view threshold, view pan / zoom after paste) are from help text, not the binary. Probe: the cases listed in `docs/engine.md` (Paste) in live Figma.
9. **Text paste defaults** (font, size, auto-resize of the new text layer). Probe: paste plain text on an empty canvas and read the Design panel.
10. **Multi-file drop grid** (columns, gap). Probe: drop 5 images of different sizes on the canvas, read positions.
