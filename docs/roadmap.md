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
- Developer previews: read-only snapshot + web viewer (same Wasm renderer) with Dev-Mode-like Inspect, or a self-contained HTML file. **Built (2026-10-08, branch `dev-previews`; `data.md` §13.1)**: Share dialog, store packaging, HTML export through main's Save dialog, the `src/viewer` single-page build. **Published on Cloudflare (2026-10-11; `multiplayer.md` §9)**: the Worker stores previews (a Durable Object each) and serves the viewer at `/p/<id>`; publishing needs the account.
- ~~The Firebase adapter~~ — replaced by Phase 6 on Cloudflare; its code removed 2026-10-11.
- `.fig` import (Figma's own files) and the one-shot converter for the old site projects (`data.md` §11.3). *Fidelity round 2026-10-08 (branch `fig-import-fidelity`):* `scripts/fig-fidelity.mjs` against Figma's own thumbnails and stored geometry; Figma's override paths, derived data kept, slots, GRID, space between, NaN gaps, Display P3 — `data-impl.md` "Import fidelity" has the numbers and what's left.
- **E8** prototyping and presentation view — built 2026-10-08 (branch `e8-prototype`; docs/engine-build.md "E8 prototyping", docs/editor.md); **E9** WebGPU backend — built 2026-10-08 (branch `r5-webgpu`; docs/engine.md §6.1 "As built (E9)", docs/engine-build.md "E9 WebGPU", research/figma/R10-webgpu.md).

## Phase 6 — Multiplayer (last; owner's decision 2026-10-08)

**On Cloudflare (owner, 2026-10-10)** — Workers + a Durable Object per file + D1 + R2, Google sign-in; contract and progress in `docs/multiplayer.md` (it replaces the Firebase adapter of Phase 5 for sync).

Built only after everything else, Figma's way (R1/R2 research; Figma's "How Figma's multiplayer technology works"): one authoritative server process per file, clients send kiwi `NODE_CHANGES` with only the touched fields, the server orders them and resolves conflicts **per property, last writer (as the server receives it) wins**; clients apply their own changes optimistically and roll a property back if the server's value differs; undo/redo per user, only one's own changes; presence (cursors, selections, names, avatars, follow / spotlight) on a separate ephemeral channel; sharing and permissions (view / edit) with accounts.

**Readiness rules that hold now** (nothing may break them):
- Every document change is a kiwi `NODE_CHANGES` Message carrying only the touched fields, with the session that made it (`sessionID`) — files, journal, undo, clipboard, library payloads and the engine stream all use it (already true).
- Node identity is `GUID {sessionID, localID}`, so two sessions never mint the same id; fractional `parentIndex.position` strings for ordering (no index-based moves).
- The engine applies remote changes without disturbing local undo (`APPLY_REMOTE`), and undo batches record only the local session's changes.
- **Actors are the session seam (round 17, docs/engine.md §9.5)**: the engine keeps one undo history per actor and runs an actor's writes with its own selection and page, the user's untouched; every commit makes the other histories yield the fields it wrote (per property, last writer wins), and an actor's undo skips fields changed since. Agent chat turns use it today; a multiplayer session becomes one more actor (its server-ordered changes committed as that actor so local histories yield), with no new undo model.
- Per-property values only — no whole-node replace in a change (REMOVED + CREATED is a real delete/create, never an edit).
- The store's write path stays behind repositories so a server-backed adapter can take the place of the local one; per-property LWW is the room's rule (docs/multiplayer.md).
- Derived data never travels in change messages (`@derived` only in snapshots).

## Phase 7 — Enterprise (proposed 2026-10-11; research `research/figma/R18-enterprise.md`)

The owner wants every feature of Figma's Enterprise plan. R18 lists them all: the pricing table's rows plus the help.figma.com admin and security articles. For each one it gives what we already have, what it takes, its size, and whether it means anything for a personal app with a few friends. Every feature is kept; ◇ marks parity-only ones. Governance+ is a paid add-on, not part of base Enterprise; it is listed and built last. There is no billing here: seats are permissions, and AI credits are a usage meter over the owner's own providers.

**Already ours.** These need no round beyond small checks:
- extended collections / multi-brand (round 5; lift the 40-mode cap to Enterprise's "unlimited")
- annotations, Compare changes, advanced inspection, asset export
- multiplayer, comments, spotlight, observation, audio, cursor chat, embeds
- file passwords, transfer of ownership
- MCP server, the agents chat

**How the rounds run** (as before, `handoff.md` "Starting the next session"):
- The main session writes the round's contract first, docs only.
- Agents then work in parallel with **disjoint folder ownership**. Each is told exactly which folders and files it may edit, and never runs `git add` or commits.
- Each agent ends with `npm run check`, plus `npm run engine:test` when it touches `engine/` and `npm --prefix server test` when it touches `server/`, and with screenshots.
- The main session verifies each branch and merges them one at a time.
- At most one agent per round edits `schema/document.kiwi`. It uses Figma's numbers and checks for collisions with `@ours` fields first.
- At most one agent per round edits `server/migrations/`.
- The 16 GB rule holds: no two engine builds at once.

**Biggest risks, in the order they are tackled:**
1. The content model moving to the server (round 1).
2. Branching's three-way merge (round 2).
3. SAML in a Worker (spiked in round 1, built in round 4).
4. Server-side renders for the REST images endpoint (decided in round 1's spike).
5. The new editor types (rounds 9–13).

### Round 0 — contracts (main session, docs only)
- `docs/multiplayer.md` §12 "Organizations":
  - The hierarchy: orgs → workspaces → teams → projects → files, with members and guests.
  - Seats (Full / Dev / Collab / View) work as caps on permissions.
  - Permission resolution: file ∪ project ∪ team ∪ org admin, capped by seat and by external-content rules.
  - Two **spaces** behind the store's repositories: `local`, as today, and `org:<id>`, backed by rooms.
  - Migration of today's shared files into a default team.
  - Admin API routes and payloads, and the activity-log event names.
- `docs/data.md` "Branches":
  - Branch metadata and the branch point.
  - The three-way diff over NODE_CHANGES. A conflict is the same GUID+field changed on both sides, or a delete on one side and an edit on the other; conflicts are grouped by top-level layer.
  - A merge is one batch plus a version of `kind: "merge"`.
- `docs/schema.md`: the plan for bringing back each product's part of Figma's schema (EditorType / `pageType 397`, node types 17–58). Numbers are reserved now; the round that needs a field adds it.

### Round 1 — the organization (risk 1)
| Agent | Owns | Delivers |
|---|---|---|
| 1a server org | `server/src/org/`, `server/src/activity.ts`, `server/migrations/0008+`, `server/src/api.ts` (dispatch lines only) | orgs / workspaces / teams / projects / members / user groups / seats in D1; role resolution used by every route and the room; activity log written by every mutating route; `sessions` table (session ids in tokens, last active); link expiry; `viewers_can_copy` enforced on snapshot / export routes; tests on node:sqlite |
| 1b store spaces | `src/store/` (new `org/`), `src/shared/store/`, `src/shared/multiplayer/` | `teams` / `projects` / `org` repositories; org spaces room-backed with an offline cache; moving a local file into a team project; tested against a contract fake, then against 1a's handler once merged |
| 1c Home | `src/renderer/src/files/` | org switcher, Teams and their projects in the sidebar, team pages (Projects / Members), project pages, create team / project, private projects, move across spaces, transfer team / project |
| 1d Admin app | `src/renderer/src/admin/` (new) | the Admin location: Dashboard, People (filters, bulk actions, CSV), Teams, Workspaces, Billing groups, Activity (filters, CSV), Settings skeleton — against the contract with a fake API |
| 1e spikes | `server/spikes/` (new, not deployed) | (1) SAML ACS in a Worker: a vetted XML-signature library under `nodejs_compat`, checked against a real IdP (an Okta developer org or a local Keycloak), with signature-wrapping attacks tested; (2) the REST images decision — thumbnails, client render-and-cache, or a CPU raster path in the engine — as a written recommendation |

### Round 2 — branching and server version history (risk 2)
| Agent | Owns | Delivers |
|---|---|---|
| 2a merge core | `src/shared/merge/` (new), `src/store/branches/` (new) | `diff(a, b)` generalizing `files.restoreDiff`, three-way merge with conflicts, Update from main, merge batch + version; a corpus of merge tests (reparenting, overrides, variables, library copies, the 32k-layer file) |
| 2b editor UI | `src/renderer/src/editor/branching/` (new), `editor/commands.ts` / `menus.ts` (branch items only) | Create branch, branch banner, View branches (Active / Archived), Request review, Review and merge changes (per-layer list with Compare changes' views), Resolve conflicts (main or branch per item) |
| 2c server | `server/src/branches.ts`, `server/src/fileRoom.ts`, `server/migrations/` | branch rooms linked to main, review requests and reviewers, version snapshots in the room every 30 min of edits and on name / publish / merge (unlimited history for shared files) |
| 2d Home | `src/renderer/src/files/` | branch icon on cards, branches under their main file, version history for room files |

### Round 3 — design systems at org scale (the owner's screenshot rows)
| Agent | Owns | Delivers |
|---|---|---|
| 3a server | `server/src/libraries/`, `server/src/fonts.ts`, `server/src/analytics.ts`, `server/migrations/` | libraries per team / org / workspace (a Durable Object per library for payloads), subscriptions and update notices, approved / default flags per editor type, default modes per workspace; shared fonts (org / team); analytics event ingestion + daily roll-up (Cron Trigger) |
| 3b store | `src/store/` (libraries for org spaces, analytics batching) | the server-backed `libraries` repository behind the same interface; usage events and per-file instance counts uploaded |
| 3c editor | `src/renderer/src/editor/panels/libraries/`, `editor/libraries.ts`, `editor/variables*.ts`, `editor/panels/variables/` | Libraries modal scopes ("Approved", org, team), Library analytics modal (Overview / Analytics, ranges, compare, CSV), usage events from inserts / detaches / applies; extended-collection restrictions checked against R18 D-5; mode cap lifted |
| 3d fonts | `src/main/fonts*.ts`, `src/main/sharedFonts.ts` (new), `editor/fontList.ts`, `editor/openFonts.ts` | the shared-fonts source next to system and Google fonts (cached like Google fonts, `fonts:changed`), the picker's shared-fonts filter |
| 3e Admin resources | `src/renderer/src/admin/` | Resources: Libraries (approve, enable by default), Fonts (upload, Skip / Replace, licence confirmation), the org-level library analytics page |

### Round 4 — identity and security
| Agent | Owns | Delivers |
|---|---|---|
| 4a server identity | `server/src/auth/` (SAML, SCIM, domains), `server/migrations/`, `server/wrangler.jsonc` | SAML SP per org (from the round 1 spike), "Any method / Google required / SAML required", JIT; SCIM 2.0 Users / Groups / seats; domain verification over DNS-over-HTTPS and domain capture; guest membership Allow / Approval / Block; external content controls; password required; idle session timeout; org switches (cursor chat, audio, public links, open sessions); EU jurisdiction for an org's Durable Objects |
| 4b Admin settings | `src/renderer/src/admin/` | Settings: Login and provisioning, Guest access, Sharing and publishing (with per-workspace overrides), Team management, Extensions, AI, Data storage localization |
| 4c clients | `src/main/account/`, `src/renderer/src/editor/ShareDialog.tsx`, `editor/multiplayer/`, `src/renderer/src/files/account.ts` | SAML sign-in through the loopback, the idle prompt ("stay logged in" in the last minute), Sessions list + Sign out everywhere, link expiry picker, export / copy restrictions enforced in the editor, cursor chat / audio hidden by policy |
| 4d desktop | `electron-builder.yml`, `src/main/index.ts` (policy reading) | MSI target, deployment keys (`DisableUpdater`, `AllowedOriginHosts`, `ProxyUrl`) |

### Round 5 — extensibility and Dev Mode
| Agent | Owns | Delivers |
|---|---|---|
| 5a REST API | `server/src/rest/` | tokens with scopes, `/v1/files`, nodes, images (per round 1's decision), comments, versions, variables (local / published, POST), dev resources, library analytics, activity logs, AI usage; webhooks with signatures and retries |
| 5b plugin host | `src/renderer/src/editor/plugins/` (new), `src/shared/plugins/` (new), `editor/panels/ActionsPanel.tsx` | a sandboxed realm + iframe UI, a documented `figma.*` subset, development plugins from a manifest, private org plugins (registry via 5a's tables), admin-approved lists |
| 5c Dev Mode | `src/renderer/src/editor/devmode/`, `src/viewer/inspect/` | Code Connect (mappings, snippets with props, Code Connect UI, a `scripts/code-connect.mjs` CLI), dev resources, component playground, ready-for-dev feed, prototype-only links |
| 5d notifications | `server/src/notifications.ts`, `src/renderer/src/files/` (bell), `src/store/notifications/` (new) | the inbox (comments, mentions, ready for dev, library updates, review requests), the room's notice, optional email |

### Round 6 — AI
| Agent | Owns | Delivers |
|---|---|---|
| 6a actions | `src/renderer/src/editor/agents/`, `editor/panels/agents/` | one-shot AI actions in the Actions panel (Rename layers, Rewrite / translate / shorten, Replace content, Add interactions, First Draft with bundled UI kits), Skills, connectors passed to the providers, the usage ledger shown as credits |
| 6b images | `src/main/agents/` (image providers), `engine/src/` (vectorize only) | image edit / remove background (a local model where possible) / boost / expand / isolate / erase; Vectorize image (a tracer in the engine) |
| 6c Weave tools | `src/renderer/src/editor/weave/` (new) | Tools › Weave: built-in tools as small graphs run by our providers, the settings modal, runs |
| 6d search | `src/store/search/` (new), `editor/panels/Assets.tsx` | visual search over thumbnails (embeddings), text tools |

### Round 7 — Draw complete, and editor types (P-0)
| Agent | Owns | Delivers |
|---|---|---|
| 7a engine Draw | `engine/`, `schema/document.kiwi` | TEXT_PATH (text on a path), TRANSFORM (repeat / radial), pattern fill, dynamic strokes (frequency, wiggle), custom brushes, multi-edit |
| 7b Draw chrome | `src/renderer/src/editor/draw/` (new), `editor/tools/` | Draw mode's toolbar, illustration sidebar, thumbnail layers (per `research/figma/live/draw/`) |
| 7c editor types | `src/shared/store/`, `src/store/`, `src/shared/fig/`, `src/renderer/src/files/` | `FileMeta.editorType` (Figma's EditorType), the + Create menu, icons, filters, templates shelf, `.jam` / `.deck` / `.buzz` / `.site` / `.make` import as their editor types |

### Round 8 — Motion
- **Engine** (`engine/`; schema KEYFRAME / KEYFRAME_TRACK / ANIMATION_PRESET_INSTANCE and their fields): the animation evaluator (time → derived overrides, never journaled), auto-keyframing.
- **Editor** (`src/renderer/src/editor/motion/`): Motion mode, timeline, presets, easing editor, motion variables, animated components.
- **Export** (`editor/exportCore.ts`, `src/shared/exportFiles.ts`): MP4 / WebM through WebCodecs, GIF, animated SVG.
- **Dev Mode** (`editor/devmode/`): the Motion tab.

### Rounds 9–13 — the other products (each split into engine / chrome / server, as above)
- **9 FigJam**:
  - Stickies, shapes with text, connectors with routing, sections, tables (CSV), code blocks, stamps, washi tape, marker.
  - Timer, music, voting, open sessions (24-hour link editors).
  - Palettes and templates; FigJam AI through the agents.
- **10 Slides**:
  - Slide grid / rows / slides, single-slide view and notes, Design mode, templates.
  - Presenter view (a second window), transitions and object animations.
  - Live interactions (server state), embedded prototypes, YouTube embeds.
  - PDF and PowerPoint export / import.
- **11 Buzz**: templates with locked fields (Figma's field, from `figma-schema.kiwi`), Table view, bulk create from CSV / XLSX, template publishing through round 3's libraries.
- **12 Sites and Make**, on one runtime:
  - Sites: breakpoints with cascading overrides, CMS (D1), HTML / CSS generation from the document (seeded by Dev Mode's CSS), site hosting on the Worker with passwords and custom domains.
  - Make: code files; in-view bundling (esbuild-wasm) or a main-process project, decided in this round's own contract step; preview sandbox; chat through the agents; publish; Supabase; Make kits; Copy as design layers.
  - Sites' code layers run on the same runtime.
- **13 Weave**: the node-graph canvas, model nodes through the owner's providers, the Figma node, publishing workflows as Weave tools.

### Round 14 — Governance+ (add-on, last)
- Identity: multiple IdPs, guest 2FA (TOTP), guest expiry, extended idle timeout (15 min).
- Network: IP allowlist and network restrictions.
- Content: the org-wide export restriction, internal policies.
- APIs: Discovery and developer logs.
- Encryption: key management for stored snapshots and media.

## Legacy removed (2026-10-06)

As the owner decided, the whole site admin was deleted in the Phase 2 integration round, with no import of the old projects: the DOM editor, the CV, site publishing and the preview tab, the old Home, `lib/` (the site's Firebase) and `demo/`, the sign-in, the site's components and the iframe shell for browsers, and the dependencies only they used (Tailwind, gsap, prismjs, dompurify, tailwind-merge). The site's Firebase data is left untouched (burakkoc.net keeps working with its own web admin). The Firebase SDK stayed for a planned Firebase adapter, replaced by Cloudflare (2026-10-10) and removed from the code 2026-10-11 (the npm dependency can go). A converter for the old projects (`data.md` §11.3) is not planned unless the owner asks.
