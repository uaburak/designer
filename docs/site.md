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

## 2. Pages (`site/src/`, a static Vite multi-page build, no framework; TypeScript + CSS)

| Path | Content |
|---|---|
| `/` | Hero ("Design, together. On your desktop." [draft copy]), a large hero animation, the Download button (picks Mac or Windows from the visitor's OS, with "Also for Windows / macOS"), three feature bands with their own animations, and a closing CTA |
| `/features` | The editor, one section with one animation each: frames and auto layout, the pen and vectors, components and variables, prototyping and presenting, Dev Mode, libraries |
| `/ai` | AI and Studio: AI tools (make / edit image, remove background, vectorize), agents on the canvas, Studio (the manager handing work to several agents; brand posts and stories) |
| `/download` | Both platforms' buttons, the version, its size and date (from `/api/releases`), system requirements (macOS 12+ Apple Silicon; Windows 10+ x64), and install notes |
| `/changelog` | Every release from `/api/releases`, its notes rendered from Markdown (escaped, a small renderer: headings, lists, bold, code, links) |

- **Animations are code**, not videos or screenshots: SVG and DOM animated with CSS and the Web Animations API, drawn in Wecra's UI3 look.
  - Examples: a cursor drawing a frame that snaps into auto layout; the pen drawing a path; a component's instances updating together; prototype noodles connecting frames and a phone playing the flow; an image being generated in place; the Studio manager handing tasks to three agents whose cards fill up; multiplayer cursors.
  - They start when scrolled into view (IntersectionObserver), pause off screen, and loop calmly.
  - Under `prefers-reduced-motion` they show their final frame still.
  - No animation library unless one is clearly needed. If it is, take one from npm, exact version, ≥ 2 weeks old, MIT.
- **The look:** Wecra's own site, in the app's spirit: Inter (or the font the app uses), the app's colour tokens adapted for a marketing page, light and dark (`prefers-color-scheme`), generous type, a 16 px side gutter on phones, no horizontal scroll at 360 px. The logo is `build/icon.png` (copied into the site's assets, sized for the web). A shared header (logo, Features, AI, Changelog, Download) and footer (© Wecra, Changelog, Download) on every page.
- **Speed:** each page's JS ≤ 50 KB gzipped; fonts self-hosted with `font-display: swap`; Lighthouse performance ≥ 95 on mobile; no third-party requests (no analytics, no CDNs).
- **English** copy. Short, confident and plain. No claims the app can't back up.

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
| site pages | `site/src/**`, `site/public/**`, `site/vite.config.ts`, `site/package.json` (its own deps) |
| channel | `site/worker/**`, `site/wrangler.jsonc`, `site/tsconfig*.json`, `scripts/release.sh`, `electron-builder.yml`, `src/main/updater.ts` (only if the generic feed needs a change), `docs/desktop.md` §12.6 (the release section) |

The worker serves the pages' build output (`site/dist`) as its assets. `site/package.json` was written by the main session (scripts: `dev`, `build` → `site/dist`, `preview`, `deploy`, `test`). Neither agent edits it: a dependency either agent needs goes in its report and the main session adds it.
