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

## 2. Pages — v2 (owner, 2026-10-14: "the animation ideas are right but it feels amateur")

v1 (SVG scenes drawn after the app) is replaced. The owner's four rules:

1. **Light by default**, with a theme toggle in the header (light ↔ dark). The choice is kept in `localStorage`, and the first visit is always light.
2. **Every section is full screen** (100svh), and its scene fills it. (Owner, 2026-10-14, replacing the first wording.)
   - **Only the home hero is interactive**: the live engine editor. Every other scene is a **watch-only animation**: no drag, click or typing, nothing that yields to the visitor; it plays (and loops) while it is in view, and starts over when it comes back. Its container is inert; the section's text says what it shows.
   - **The hero grows with the scroll.** It starts as a framed window under the headline; as the visitor scrolls it scales up until it fills the viewport, then **stays pinned full screen** for about 170vh (a tall track with a sticky viewport) so the visitor can use it, and then scrolls away normally. It is driven by the scroll position (a rAF scroll handler writing transforms only: `site/src/scripts/heroScroll.ts`). The header steps aside while it is pinned.
   - While pinned and full screen the visitor can select, move, resize and draw a frame. The wheel still scrolls the page, also over the canvas; ⌘ / Ctrl + wheel (and a pinch) zoom the canvas. Before it is full screen it takes no input. On a touch phone the canvas loads and takes touches only after "Tap to edit", so the page keeps scrolling.
   - Scroll moves between sections; snapping is gentle (`scroll-snap-type: y proximity`, with a snap point where the hero is full screen), never hijacked.
3. **AI is told in depth** on its own page, one full-screen section each:
   - the AI actions (Rename layers, Rewrite / Shorten / Translate, Replace content, Add interactions, First Draft);
   - the image tools (Make an image, Edit with prompt, Remove background, Boost resolution, Expand, Erase, Isolate, Vectorize — and which run locally on the visitor's machine);
   - visual search;
   - Agents and MCP (Claude Code, Codex, Antigravity, Cursor, or a local model such as Ollama / LM Studio, working on the canvas with real tool names; Skills; connectors with consent);
   - Studio (the manager handing a request to several agents at once; brands and products; posts and stories from product photos; the review and fix loop);
   - credits and privacy (your own providers and keys, local models, nothing sent to us).
   Read `docs/ai.md` and `docs/studio.md` so every claim is true.
4. **The app is drawn with the app's own code, 1:1.**
   - The site's scenes are React, built from `src/renderer/src/ds`: its components (Button, PanelSection, PropertyGrid, LayerRow, NumericInput, SegmentedControl, Menu, Rail, the toolbar, the icons) and its tokens (`tokens.css` and `global.css` in the scene scope), imported through a Vite alias. Do not copy them.
   - Where the app's real panels can render with fake data, use them.
   - **The canvas is the real engine** wherever a scene shows a canvas worth touching, as `?engine`'s Playground does (`src/renderer/src/engine/EngineCanvas.tsx`, `loadEngine.ts`, `sampleDocument.ts`): the hero is a real, editable canvas. The engine (~1.7 MB gzipped) loads after the first paint, with the scene's still frame shown until it is ready. Where a live engine is too heavy (several on one page, phones), draw that part with the same components over a canvas snapshot, and say so in the code.
   - The site's own text, headings and marketing layout stay the site's, with a quiet, premium feel: large type, plenty of space, restrained colour from the tokens. It must not read like a template.

Pages: `/` (hero = the real editor, then full-screen sections: design, prototype, Dev Mode, libraries and multiplayer, AI teaser, download), `/features/`, `/ai/`, `/download/`, `/changelog/`, `404`. The shared header (logo, Features, AI, Changelog, theme toggle, Download) and footer stay.

Budgets: the page shell ≤ 150 KB gzipped of JS (React and the ds included), and the engine loaded only on demand. No third-party requests. `prefers-reduced-motion`: the scenes stay on their first frame, no snapping, and the hero goes from framed to full screen without the in-between. Phones: the hero works with touch, and no horizontal scroll at 360 px.

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
