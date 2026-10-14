# get.wecra.app: the download site and the update channel (contract, written 2026-10-14)

The owner wants:
- a site that presents Wecra over a few pages, with **animations instead of screenshots** and a Download button that always gives the newest version;
- installed copies updating **from Cloudflare instead of GitHub**, so the repository can go private.

The site and the update feed read the same files, so a release updates both with no edit to the site.

## 1. Pieces

- **R2 bucket `wecra-releases`** (new, Standard storage, not public). Its keys:
  - `updates/latest-mac.yml`, `updates/latest.yml`: electron-builder's feeds.
  - `updates/<file>`: the DMG, the zips, the Windows installer and the blockmaps.
  - `releases.json`: the list the site reads (§3).
- **A Worker `wecra-site`** (`site/`, its own `wrangler.jsonc`, custom domain `get.wecra.app`). It holds the static pages (assets binding) and these routes:
  - `GET /updates/<file>`: the R2 object, streamed, with `Content-Length`, `ETag` and Range support (electron-updater's differential download uses Range). The yml files are sent `Cache-Control: no-cache`; the versioned files `public, max-age=31536000, immutable`.
  - `GET /download/mac` (Apple Silicon DMG) and `GET /download/windows` (the Setup .exe): a 302 to `/updates/<newest file>`, read from `releases.json`; a 404 page when there is none yet.
  - `GET /api/releases`: `releases.json`, `Cache-Control: max-age=60`.
  - Everything else is a static page.
- **The app** (`electron-builder.yml`): `publish` becomes `provider: generic`, `url: https://get.wecra.app/updates`.
- **`scripts/release.sh`**:
  - It keeps building, signing and notarizing as today.
  - It uploads the files to R2 with `npx wrangler r2 object put wecra-releases/updates/<file> --file … --remote` (yml files last, so the feed never points at a missing file) and rewrites `releases.json` (newest first, with the notes' Markdown).
  - **Transition:** while `MIRROR_GITHUB=1` (the default until the owner turns it off), it also prints the `gh release create` as today. Installed copies of 1.1.x still read GitHub, so the first R2 release must also be on GitHub; they update to it and from then on read R2. Only then may the repository go private (§4).

## 2. Pages — v3 (owner, 2026-10-14: "start over, minimal, like figma.com, but with our animations")

v1 (SVG scenes) and v2 (full-screen app windows) are both rejected. v3 starts over from **figma.com's art direction**, studied on 2026-10-14. We follow the direction but copy none of its assets, fonts or text:
- **White page, black text, almost no chrome.** A thin header: logo, three links, a black "Download" button (radius 8, padding 12×22, 16–18 px). No gradients on text, no shadows anywhere, no borders around sections, no cards with outlines.
- **Type does the work.**
  - Body face: Inter at **weight 400** for headings too, with tight tracking. Sizes: hero 56–72 px / −1.25 px tracking, line-height 1.0; section headings 44 px / −0.66 px; sub-headings 30 px / −0.66 px; body 16–18 px.
  - Small labels, eyebrows and captions are in a **monospace** face, 13–14 px, +0.5 px tracking (self-host JetBrains Mono or IBM Plex Mono, OFL; include the licence).
- **Layout:** a 12-column grid with max width ~1312 px and 80 px vertical section padding. Sections are about one viewport tall but not forced. Headline left-aligned with a short line under it, then the visual. Generous whitespace.
- **Visuals are colour fields with the product inside.**
  - Each feature gets a large rounded tile (radius 16–24) filled with **one flat, soft colour** (lavender, lime, coral, sky, sand: pick 5–6 from the app's palette, flat and never a gradient).
  - On it sits a **collage of real app UI** built with the app's own `ds` components (panels, layer rows, property fields, toolbar, comment bubbles, cursors, AI prompt card, Studio task cards), cropped, overlapping and slightly offset, **without window chrome** (no title bars or traffic lights).
  - The collage **animates**: pieces slide in and settle, values change, cursors move, a frame gets drawn, an image fills in, tasks tick off. Slow, smooth and loop-free where possible (play once on enter, then idle micro-motion).
- **Motion is tasteful:** transform and opacity only, 400–700 ms ease-out, staggered, in on scroll. Text fades up slightly. Nothing bounces, nothing is gimmicky. Under `prefers-reduced-motion`, everything shows its end state.
- **Interactivity is minimal:** one place only, a "Try it" tile on `/` where the live engine canvas (`EngineCanvas` with `sampleDocument`, as v2 built it) can be touched. It loads on demand when the tile nears the viewport, with no pinning and no scroll hijack. Everything else is watch-only.
- **Light only by default.** Keep the small theme toggle (dark is the app's dark tokens); tiles keep their colours in both themes.
- **Pages:** `/` (hero headline + one big collage tile; a row of 3 small feature tiles; Design; Prototype; Dev Mode; AI and Studio; Try it; a download band; footer), `/features/`, `/ai/` (as in v2's list: actions, image tools, visual search, agents and MCP, Studio, credits and privacy, each one tile and a short text), `/download/`, `/changelog/`, `404`.
- **Footer:** columns of mono labels with links, like figma.com's footer structure, and the © line.
- **Budgets** as before (≤ 150 KB of JS per page shell; the engine on demand; no third-party requests). Phones: tiles stack, collages scale, and there is no horizontal scroll at 360 px.

### 2.1 v4 — the scenes cleaned up (owner, 2026-10-14: "sweet but busy: things don't fit their tiles, the flow doesn't follow, it clicks but you can't tell where, colours change through UI the app doesn't have, the outline drawing looks fake — minimal and clear")

Rules every scene follows (they decide over §2 where they differ):
- **Fits its tile.** Every piece, popover, label and cursor stays inside the stage with ≥ 24 px of margin; nothing sits at a negative position or past the stage's size. The stage fits its tile (`stage.ts`: contain on tiles ≥ 640 px, the old cover-and-crop only on phones). A square tile gets a composition made for a square, not a wide one cut down.
- **One idea per scene, at most 3 steps.** Fewer pieces (one panel, not three), one cursor unless the scene is about people working together. The section's text names the idea; the scene shows exactly that.
- **A click is legible.** The cursor goes to the control, rests (~250 ms), the control shows its hover, the press shrinks the arrow, and the result appears *at that control*: a Select opens its real list (the ds `Select` with `static`, or the Menu panel) over the field, the cursor moves onto the option, the option highlights, then the list closes with the new value. Nothing changes somewhere the cursor isn't.
- **Only the app's own UI.** A colour changes through what the app does: the swatch is clicked and the ds `ColorPicker` (`static`) opens beside the panel, a swatch from "On this page" or a library colour is picked; or the change is left out. No invented controls, chips or overlays.
- **Nothing drawn for show.** A selection appears at once (Figma's does; kit `Selection` has no draw-in). Shapes are drawn only when a cursor drags them (the frame tool, the pen, the prototype connection), and grow with the cursor. No ring on clicks, no bounce, no spring pops.
- **Calm pace.** A beat (≥ 600 ms) between steps so each can be read; cursors move only to do something, and rest when the scene is done (no idle wandering, no endless replays). Under reduced motion the end state shows.

The hero (v7, owner 2026-10-14): the first screen is the editor — the navigation bar and Layers on the left, the Design panel on the right, the bottom toolbar — and its frame holds the page's own poster, real DOM laid out at the page's width (the frame is that page-top at a smaller scale): a card with a soft gradient and a static grain, eleven small vector shapes each with its own grainy gradient (circles, a star, a pentagon, a triangle, a diamond, a rounded square, a pill, a ring, a wave and a squiggle; `scenes/hero/shapes.ts`, generated with the markup), the h1 "Design, together, on your desktop.", Try it (→ #try) and a download link. Burak draws the frame and the card, sets its fill through the Fill row and the app's ColorPicker (opened briefly in the Design panel's own place, never over the canvas) and adds Effects › Noise; Kamila, Yasin, Özge, Görkem and Ece join a beat apart and work at once under their own tool cursors — the headline typed, shapes dragged out with the shape tools, placed anchor by anchor or pulled into curves with the pen, Try it drawn and labelled, a shape nudged — each doing a second and third thing rather than standing idle, all listed in Layers; Oğuz goes round with the comment tool and pins teasing, censored Turkish comments on others' work (one gets an answer), which leave with the editor. Burak then asks the agent "Make the shapes react to the cursor" (no agent cursor; its steps tick in the chat), and from then on the shapes are physical: a small fixed-step 2D sim (discs, damping, low restitution, a weak spring home) where cursors push them — the teammates', who keep playing with their shapes after the build, then the visitor's own mouse (light touch-drag on phones) — and they collide with each other, the poster's edges and the text. It is scroll-linked both ways (this overrides §2's "no pinning, no scroll hijack" for the hero only: a sticky stage and native scroll, nothing intercepted): the build (~18 s) plays by itself, scrolling nudges it gently on or back (the build part of the track adds about 0.3 s per 100 px, and the build never runs faster than 3× real time); once it's done the panels slide out, the frame grows to the page (its transform goes to none) and the toolbar morphs into the dock — one shared surface whose width and look change while the toolbar's items leave from the edges and the dock's arrive from the centre, nothing scaled — and scrolling back undoes all of it. Phones: no panels or toolbar; the poster is built and opened the same way. Reduced motion: no animation or physics, the poster as the page's top.

There is no site header (owner, 2026-10-14): on every page the dock — fixed at the bottom centre — is the navigation: the logo (→ /), Features, AI, Changelog, the theme toggle and Download; on phones the logo, a menu, the toggle and Download. It steps aside while the download band or the footer is in view. The page's headline and Download follow the scene.

Working together (v4, a new section on `/` and on `/features/`): teams and the shared workspace — a team with projects, sharing a file (invite, can edit / can view), people in the file (avatars, cursors, following), comments, and the organisation's controls (roles, SSO and 2FA, admin). Shown with the app's own Share dialog and Home's team sidebar.

### 2.2 v6 layout: sections as poster cards (owner, 2026-10-14: "the rest of the site should be in the same layout as this hero")

Every section on every page is a card of the hero poster's family (it decides over §2's centred 1312 px wrap, flat tiles and words-under-tiles):
- **Frame.** `main.sheets` is a column of cards, nearly full-bleed: the poster's gutter from the viewport (20 px; 12 px on phones), its radius (28 px; 20 px), the same 20 px (12 px) between cards. No max width, no shadows, no outlines. The footer is a black card on the same gutter.
- **Surface.** `.sheet` with `data-tone` (lavender, mint, coral, sky, sand; none = the poster's own fields): three soft radial fields over a linear gradient, and the poster's static grain over it (`--site-grain`, the same SVG noise tile). Dark theme: the same fields, darker, the grain as an overlay. `data-tone="plain"` (the canvas's grey, no grain) holds text to read: the changelog, the install steps.
- **Words.** Inside the card like the poster's text block: a mono eyebrow, the heading a step under the poster's h1 (`.sheet-title`, 36–64 px; page tops and the download band use the poster's own scale, `.sheet-display`), and on the other side the lede, a fine line and one action (a mono link, or the black button).
- **Arrangements.** `.sheet-stack`: the scene across the card (its box keeps the scene's aspect, 1312/640 or 1312/680; 1:1 on phones) with the words under it, or over it (`data-copy="top"`), alternating. `.sheet-split` (the AI page's 860×560 scenes): words in 5 columns, the scene in 7, sides alternating (`data-flip`); stacked under 1000 px. `.sheet-row` of `.sheet-small` cards: three (or two) in a row, the scene on top and the words inside under it; stacked under 1000 px. `.sheet-top`: the other pages' first card, the poster without its art (h1 bottom-left, lede beside it). The download band is a poster of its own: the big heading bottom-left and Download under it. The live canvas (Try it) sits in its card as an inset window with its own corners.
- The scene's box is still `.tile` (transparent inside a card) so the kit's `stageBox` fits each stage into it; the cards, not the tiles, rise in on enter (`common.ts`).

## 3. `releases.json`

```json
{ "releases": [ { "version": "1.2.0", "date": "2026-10-20", "notes": "## New\n- …",
  "files": { "mac": { "name": "Wecra-1.2.0.dmg", "size": 123456789 }, "windows": { "name": "Wecra-Setup-1.2.0.exe", "size": 98765432 } } } ] }
```

Newest first. `windows` is absent for a Mac-only release; `/download/windows` then takes the newest release that has one.

## 4. Order (the owner's friend must not have to reinstall)

1. Build the site and the channel, deploy the site Worker and create the bucket. The owner runs the commands; the main session gives them.
2. Release 1.1.3 (or the next version) with the generic feed, to R2 **and** GitHub.
3. Installed copies update to it from GitHub, and from then on they read `get.wecra.app/updates`.
4. The owner turns `MIRROR_GITHUB` off and makes the repository private.

## 5. Ownership

| Agent | Owns |
|---|---|
| site pages | `site/src/**`, `site/public/**`, `site/vite.config.ts` (and the dependencies listed in its report, which the main session adds to `site/package.json`) |
| channel | `site/worker/**`, `site/wrangler.jsonc`, `site/tsconfig*.json`, `scripts/release.sh`, `electron-builder.yml`, `src/main/updater.ts` (only if the generic feed needs a change), `docs/desktop.md` §12.6 (the release section) |

The worker serves the pages' build output (`site/dist`) as its assets. `site/package.json` was written by the main session (scripts: `dev`, `build` → `site/dist`, `preview`, `deploy`, `test`). Neither agent edits it: a dependency either agent needs goes in its report and the main session adds it.
