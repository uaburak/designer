# R11 — Fonts in Figma: local fonts, Google Fonts, the font picker, missing fonts, Inter

Research for the fonts round (2026-10-08, branch `r5-fonts`). Each fact names its source; "measured" means checked
here against files (the owner's private `.fig` was read locally only — nothing derived from it is in the repo).

## 1. Where Figma's fonts come from

- **Local fonts** reach Figma through its font helper (FigmaAgent, a localhost HTTP/HTTPS server that only answers
  figma.com; the desktop app reads them itself). The web client reads the list from
  `http://127.0.0.1:44950/figma/font-files` and a file from `/figma/font-file?file=<path>` (forum report; the route
  names are documented by the community `figma-agent` reimplementation). The helper lists installed fonts with
  their metadata and rescans when fonts change. Sources: help.figma.com "Add a font to Figma Design"
  (articles/360039956894); forum "how to get list of system fonts while developing plugin" (archive-21/9372);
  docs.rs/crate/figma-agent 0.2.5.
- **Google Fonts are served by Figma**, always available: "a Google font, which is always available in Figma"
  (help.figma.com "Missing font alert in Figma Design", articles/360039956994). Figma updates its Google Fonts
  catalog irregularly (pimpmytype.com "Inter Font Update: Don't rely on Google Fonts for hosting"; forum
  "update google fonts to include google sans flex and other new fonts" 47634, Nov 2025: missing newer families).
- **Which bytes** (measured): the SHA-1 Figma stores for the font a text was laid out with
  (`derivedTextData.fontMetaData[].fontDigest`, schema `FontMetaData.fontDigest`) on the owner's file:
  - Outfit (all styles) `79d17fec…` = `google/fonts` repository `ofl/outfit/Outfit[wght].ttf` byte for byte. The
    file fonts.gstatic.com serves for the same family (`/s/outfit/v15/…ttf`, via `fonts.google.com/download/list`)
    is re-encoded: `b4f72c37…`, different bytes.
  - Roboto Mono `1f6afd30…` = the repository's `apache/robotomono/RobotoMono[wght].ttf` **before** its 2025-03-31
    v3.001 update (commit `ac8f68d4`) — Figma's catalog is a snapshot, behind the repository.
  - So Figma serves Google families as the repository's variable TTFs (one file per slant; every style a named
    instance). This app downloads the same files (§3).
- **Local beats Figma-served**: installing a family locally overrides the Google Fonts version in Figma
  ("install Inter v3 locally, which overrides the Google Fonts version in Figma", pimpmytype.com, same article).

## 2. Inter

- Measured: every Inter text in the owner's file (Regular, Medium, Semi Bold, Bold, Extra Bold) has digest
  `d483e2c7f8032c6638d047167efbeba0030f0649` and `fontLineHeight` 1.2102272510528564.
- That digest is **rsms/inter v3.19, `Inter Variable/Inter.ttf`** (release zip `Inter-3.19.zip`, 2021-06): axes
  `wght` and `slnt`, 18 named instances (Thin … Black, each with an Italic at slnt −10), UPM 2816, hhea 2728 / −680 /
  0 → (2728 + 680) / 2816 = 1.21022727. Not Google Fonts' Inter: the repository's 3.x file
  (`ofl/inter/Inter[slnt,wght].ttf` v3.019, commit `e3e05bbd`) hashes `f166102c…`, and Google moved to Inter 4.001
  (`Inter[opsz,wght].ttf`, `Inter-Italic[opsz,wght].ttf`) on 2024-05-28.
- Forum: "Currently, Figma supports Inter 3.0" (report-a-problem 40560, May 2025; no staff answer on 4.0); Nov 2025
  "The Inter font is also outdated" (47634).
- **Decision**: the bundled Inter is Figma's (`src/renderer/src/engine/fonts/Inter-3.19.ttf`, OFL) for documents;
  Google's Inter is hidden behind it, an installed Inter wins over both (§1). Inter 4.1 stays only for the engine's
  native tests.
- **Parity** (r5-text's `text.parity.test.cpp`, `DESIGNER_TEXT_PARITY`, the owner's 2,571 Inter texts / 29,508
  glyphs, local data only): Inter 4.1 → mean |Δx| 0.356 px, 20,284 glyphs > 0.1 px, 7,907 > 0.5 px, auto-width
  mean |Δw| 0.208 px (473 > 0.1 px); **Inter 3.19 → mean |Δx| 0.025 px, 799 > 0.1 px, 380 > 0.5 px, |Δw| 0.024 px
  (46 > 0.1 px)**; baselines and line counts equal in both. The rest is 56 texts: "Contrast: 4.3:1 ✕" (✕ comes from
  a fallback face the harness doesn't load) and centred auto-width labels like "Black/10" shifted by exactly 1 px
  (advances equal to 1e-4; our ⌈width⌉ lands one pixel over Figma's — Figma quantizes positions to 1/256 px and the
  sum stays ≤ 51, ours is 51.0034): text-layout work, not the font. **Closed in round 6**: Figma shapes at 1024 units per em, rounding each glyph's advance and its kerning apart from font units (docs/engine-build.md "Round 6"); with it every auto-width box of the file equals Figma's and Inter's mean |Δx| is 0.0022 px.

## 3. The Google Fonts catalog without an API key

- `https://fonts.google.com/metadata/fonts` (JSON behind a `)]}'` guard): 1,950 families (2026-10-08), each with
  `family`, `category` (Sans Serif / Serif / Display / Handwriting / Monospace), `popularity` (rank), `axes`
  (`tag`, `min`, `max`, `defaultValue`) and `fonts` keyed `"400"`, `"700i"` … (weights 1–1000). No file URLs.
- A family's files: `raw.githubusercontent.com/google/fonts/main/<ofl|apache|ufl>/<dir>/METADATA.pb` (protobuf text:
  `fonts { style, weight, filename }`; a variable family lists one entry per file), the folder being the name lower
  case with letters and digits only. Fallback: `fonts.google.com/download/list?family=<name>` (`manifest.fileRefs`
  with gstatic URLs; variable files named `<X>-VariableFont_<axes>.ttf`, statics under `static/`).
- Style names: Google's named instances are Thin, ExtraLight, Light, Regular, Medium, SemiBold, Bold, ExtraBold,
  Black, "<W> Italic" ("Italic" for 400) — what Figma shows for Google families (the owner's file names
  "Outfit SemiBold", "Outfit ExtraBold").
- Previews: `fonts.googleapis.com/css2?family=<name>&text=<name>` answers (to a non-browser user agent) a TrueType
  subset of just those letters (≈2 KB) — what fonts.google.com itself uses for its family list.

## 4. The font picker (UI3)

- help.figma.com "Browse and apply fonts" (articles/360041308034): click the font name in the Text (Typography)
  section → the picker; **search** by name; the filter, default **"All fonts"**: "All fonts" (installed, shared and
  Figma-provided), "In this file", "Popular" ("commonly used fonts curated by Figma"), "Used at <organization>"
  (shared fonts; organizations only), "Installed by you", "Google fonts", "Variable fonts" (at least one axis).
  "Figma will remember the last font filter used per session." Hovering a font previews it on the selected text
  layers; a click selects it.
- On-canvas preview while hovering / moving with ↑ ↓ shipped Nov 2023 (forum "Launched: Preview font families on
  page when cycling through with the arrow keys", 34224 / 46227).
- Font names are drawn in their own typeface, with a loading skeleton until the preview arrives (forum "no font name
  preview available" 42311, Jun–Jul 2025: in the browser some users saw "only the loading skeleton"; staff: names
  "are displaying as expected").
- **No "Recently used" section**: requests for one are open (forum 8266 / 47502, 2022 → 2026; Adobe's menu cited as
  the model). Not built, as Figma doesn't have it.
- Not verified (no reference screenshot): the picker's exact size, row height (32 here), whether the filter is a
  dropdown under the search (built so) and the styles submenu's form (built as a chevron on hover opening the
  family's styles beside the list).

## 5. Missing fonts

- help.figma.com "Missing font alert in Figma Design": a missing font icon in the **left sidebar** when the file uses a
  font you don't have (not installed, a missing style, conflicting versions); in the right sidebar the icon next
  to the font name of a selected text. The icon opens the **"Missing fonts"** modal: the missing fonts and styles and
  the affected layers; under **"Replacement"** a family and a style dropdown per font (only fonts you have);
  **"Replace fonts"** updates every text object in the file, for all collaborators.
- Built: the left panel header's icon (Figma's own missing-font glyph isn't in the icon set: `24.warning` stands
  in), the field's icon, the dialog with layer counts, Replace fonts as one engine command (one undo step) that
  rewrites node fonts, style runs, text styles and instance overrides.
