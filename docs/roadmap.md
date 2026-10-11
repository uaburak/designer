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
2. Branching's three-way merge (round 2; `data.md` §15).
3. SAML in a Worker (spiked in round 1, built in round 4).
4. Server-side renders for the REST images endpoint (decided in round 1's spike).
5. The new editor types (rounds 9–13).

### Round 0 — contracts (main session, docs only) — **written 2026-10-11**
- `docs/multiplayer.md` **§14 "Organizations"** (§12 and §13 are notifications and settings), covering:
  - the hierarchy (orgs → workspaces → teams → folders, Figma's renamed projects → files) with members, guests and user groups;
  - roles at every level (Figma's names);
  - seats as caps;
  - `resolveAccess` as an algorithm with 22 cases;
  - migration `0010_orgs.sql` in full;
  - the store's two spaces and the `orgs` / `teams` / `projects` / `admin` repositories;
  - moving today's shared files into a team ("Create organization" › Import shared files);
  - every route with its shapes and error codes;
  - the activity log (Figma's ActivityLog shape and action names);
  - how rooms check roles (`/room/reauth`);
  - how notifications and sessions attach to orgs;
  - `src/shared/org/types.ts`.
- `docs/data.md` **§15 "Branches"**, covering:
  - the branch record, the base snapshot and GUID blocks;
  - the per-(GUID, field) diff with keyed fields;
  - the three-way merge rules (delete vs edit, moves, cycles, positions, overrides, variables, library copies);
  - Figma's `DiffChunk` grouping;
  - the flows (create, update from main, review, merge = one `merge` batch + a `merge` version, archive / restore);
  - `src/shared/merge/` and the `branches` repository;
  - shared branches (rooms, `0011_branches.sql`);
  - the test corpus.
- `docs/schema.md` **§15**: each product's Figma node types and fields with their numbers, by round. The numbers come from `docs/research/figma/figma-schema-106.kiwi`, Figma's version-106 schema dumped with field numbers.
- **Before round 1 starts**, the main session commits the contract's TypeScript verbatim:
  - `src/shared/org/types.ts` (§14.13 + §14.10's `ActivityLog`);
  - the repository interfaces of §14.6 in `src/shared/store/repositories.ts`, with a `notImplemented` stub in both stores.
  
  The parallel agents then compile against the same types. Round 2 does the same with `src/shared/merge/types.ts` and §15.6's `BranchesRepository`.

**Already built, not redone** (2026-10-11):
- **Notifications** (`docs/multiplayer.md` §12: migration 0008, `Inbox`, the bell). Old item 5d is reduced to email.
- **Sessions and personal access tokens** (§13: migration 0009 — a row per sign-in, `sid` in tokens, last active, Sign out per session, scoped tokens). They come off round 1's server list and round 4's client list.

Migrations continue from **0010** (round 1) and **0011** (round 2).

### Open questions for the owner (Phase 7)
**Answered by the owner, 2026-10-11:** (1) friends are **members** — an admin adds anyone as a member by hand, and "Import shared files" (§14.8) imports the people the owner shared with as members, not guests; (2) the default seat stays Figma's **View** (with "Ask to upgrade"); (3) org admins **edit everything implicitly** (keep §14.2 rule 4); (4) not asked — default: keep per-file sharing outside orgs (Figma keeps sharing drafts); (5) open; (6) **several orgs** — the org switcher in the account menu, "Create organization" as many times as wanted, the name asked at creation.

1. **Friends: members or guests?** By Figma's rule, people outside the org's email domains are guests, and the owner has no domain. §14.8 imports them as guests, and admins can add anyone as a member by hand (ours). Members see every Visible team and use shared fonts and org libraries; guests see only what they're invited to.
2. **Default seat.** Figma's default for new people is View (§14.3), with "Ask to upgrade". Should the owner's org default to Full, so friends can edit Design files at once?
3. **Admins edit everything implicitly** (§14.2 rule 4, unverified at Figma). Keep, or make org admins only *manage* permissions?
4. **Files outside any org.** Keep today's per-file sharing for people who never join an org (§14.1), or move every shared file into orgs and retire the legacy path once everyone has one?
5. **"Pick main" during conflict resolution** keeps the branch's other changes on the same layer (docs/data.md §15.4 rule 6). Figma's exact behaviour is unverified; worth one test in live Figma with the owner's Organization trial, if any.
6. **Org name, and one org or several.** "Create organization" makes as many as asked; the owner's own name for it is needed at the first run.

### Round 1 — the organization (risk 1)
| Agent | Owns | Delivers |
|---|---|---|
| 1a server org | `server/src/org/` (new: `db.ts`, `orgs.ts`, `teams.ts`, `projects.ts`, `groups.ts`, `admin.ts`, `reauth.ts`, `migrate.ts`), `server/src/activity.ts` (new), `server/migrations/0010_orgs.sql` (the text of `multiplayer.md` §14.5, verbatim), `src/shared/org/access.ts` (new; `resolveAccess` + its 22 cases), `server/src/api.ts` (dispatch lines; the files routes call `resolveAccess`; `POST /files` with `orgId` / `projectId`; trash / move / activity routes), `server/src/fileRoom.ts` (`/room/reauth` only), `server/src/notifications.ts` (§14.11's org kinds, `org_id` / `team_id` on rows, `{t: "org"}` inbox notices), `server/src/account.ts` (account deletion vs org drafts, §14.7; `last_active_at`) | §14.4–§14.12 on the server: orgs, workspaces, teams, folders, members, user groups, seats and seat requests, guest requests (stored), billing groups; the activity log written by every mutating route; "Create organization" with Import shared files (§14.8); link expiry; `viewers_can_copy` enforced (§14.12). Tests on node:sqlite: every route, the access cases, migration of shared files, reauth. *Sessions are not in this round: migration 0009 has them.* |
| 1b store spaces | `src/store/org/` (new), `src/shared/store/` (`repositories.ts`, `types.ts` — `FileMeta.space`, `Prefs.browse.space` —, `protocol.ts`, `client.ts`), `src/store/localStore.ts` (wiring), `src/store/multiplayer/` (share with a destination), `src/store/notifications/service.ts` (forwarding `{t: "org"}` notices only), `src/renderer/src/store/memory/` (the browser's MemoryStore wiring) | §14.6: the `orgs`, `teams`, `projects`, `admin` repositories over the server, the per-org cache (offline reads), org files as linked room copies, creating files in folders and drafts, moving a local file into a folder, topic `org`. Tested against a contract fake, then against 1a's handler once merged (as `service.test.ts` does) |
| 1c Home | `src/renderer/src/files/` | The org switcher (account menu; `Prefs.browse.space`); in an org: sidebar Drafts, Teams with their folders (nested, as Figma's file browser), team pages (Folders / Members, audience and visibility, join / request, leave, transfer, delete / restore), folder pages (Inherited / Limited, members, create file / folder), Move to… across spaces and within the org, the team's trash, user groups in the right sidebar of All teams, "Ask to upgrade", the seat-capped banner wording; the **Admin** entry for admins rendering `AdminApp` from `src/renderer/src/admin/index.ts` (the one import from 1d's folder) |
| 1d Admin app | `src/renderer/src/admin/` (new; `index.ts` exports `AdminApp({orgId, store})`; its fake `AdminRepository` in `admin/fake/`) | The Admin location against §14.6's `AdminRepository`: Dashboard; People (filters, bulk role / seat / workspace / billing group, remove, CSV) and User groups; seat and guest requests; Teams (incl. hidden and deleted, restore); Workspaces (admins, default teams, members, hidden); Billing groups; Activity (filters by event, person, team, dates; CSV; Figma's columns); Content › Unassigned drafts; Settings (team creation, group creation, guest membership, default seat, seat approval — the round-4 settings shown disabled) |
| 1e spikes | `server/spikes/` (new, not deployed) | (1) SAML ACS in a Worker: a vetted XML-signature library under `nodejs_compat`, checked against a real IdP (an Okta developer org or a local Keycloak), with signature-wrapping attacks tested; (2) the REST images decision — thumbnails, client render-and-cache, or a CPU raster path in the engine — as a written recommendation |

Round 1's main session, before the agents: commit `src/shared/org/types.ts` and the repository interfaces (Round 0's last item). After them: merge 1a first, then 1b (switching its tests from the fake to 1a's handler), then 1c and 1d. Deploy: `db:migrate` (0010), then deploy; there is no new Durable Object.

### Round 2 — branching and server version history (risk 2)
| Agent | Owns | Delivers |
|---|---|---|
| 2a merge core | `src/shared/merge/` (new), `src/store/branches/` (new), `src/shared/store/` (`BranchRecord`, `FileMeta.branch`, `VersionRecord.kind` + `BatchKind` additions, `BranchesRepository`, `stale` / `branch-cannot-publish` codes), `src/store/local/fileStore.ts` / `versions.ts` (the new kinds, GUID blocks, retention), `src/store/localStore.ts` + `src/renderer/src/store/memory/` (wiring) | `data.md` §15.2–§15.6: `diff` generalizing `restoreDiff`, `merge3` with conflicts and `DiffChunk`s, create / update from main / merge / archive / restore for local files, and for shared ones through 2c's routes; the corpus of §15.8 |
| 2b editor UI | `src/renderer/src/editor/branching/` (new), `editor/commands.ts` / `menus.ts` (branch items only) | Create branch…, the "‹file› / ‹branch›" title and the main-changed notice, View branches (Active / Archived / Yours), Request review / Add your review (Approve / Suggest changes, the In review, Changes suggested and Approved badges), Review and merge changes (per-chunk list, Compare changes' side by side / overlay through `branches.openSide`), Resolve conflicts (main left, branch right, a pick per chunk, Resolve all), Update from main with Apply changes; branch publishing disabled |
| 2c server | `server/src/branches.ts` (new), `server/src/fileRoom.ts` (base chunks, room versions, the session block), `server/migrations/0011_branches.sql` (the text of `data.md` §15.7), `server/src/api.ts` (dispatch line), `server/src/notifications.ts` (branch review kinds) | §15.7: branch rooms linked to main, access through main, reviews and reviewers, `/branches/…` routes; room version snapshots every 30 min of edits and on name / publish / merge (unlimited history for shared files); the activity log's branch events |
| 2d Home | `src/renderer/src/files/` | the branch icon on cards, branches under their main file (local and org spaces), version history for room files |

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
| 4c clients | `src/main/account/`, `src/renderer/src/editor/ShareDialog.tsx`, `editor/multiplayer/`, `src/renderer/src/files/account.ts` | SAML sign-in through the loopback, the idle prompt ("stay logged in" in the last minute; activity reported once a minute, `multiplayer.md` §14.11), Sign out everywhere in Settings › Security (the Sessions list is built, §13), link expiry picker, export / copy restrictions enforced in the editor, cursor chat / audio hidden by policy |
| 4d desktop | `electron-builder.yml`, `src/main/index.ts` (policy reading) | MSI target, deployment keys (`DisableUpdater`, `AllowedOriginHosts`, `ProxyUrl`) |

### Round 5 — extensibility and Dev Mode
| Agent | Owns | Delivers |
|---|---|---|
| 5a REST API | `server/src/rest/` | personal access tokens are built (`multiplayer.md` §13): add OAuth apps and org "plan access tokens", then `/v1/files`, teams / projects (`/v1/teams/:id/projects`, `/v1/projects/:id/files`), nodes, images (per round 1's decision), comments, versions, variables (local / published, POST), dev resources, library analytics, activity logs, AI usage; webhooks with signatures and retries |
| 5b plugin host | `src/renderer/src/editor/plugins/` (new), `src/shared/plugins/` (new), `editor/panels/ActionsPanel.tsx` | a sandboxed realm + iframe UI, a documented `figma.*` subset, development plugins from a manifest, private org plugins (registry via 5a's tables), admin-approved lists |
| 5c Dev Mode | `src/renderer/src/editor/devmode/`, `src/viewer/inspect/` | Code Connect (mappings, snippets with props, Code Connect UI, a `scripts/code-connect.mjs` CLI), dev resources, component playground, ready-for-dev feed, prototype-only links |
| 5d notifications | `server/src/notifications.ts` | **Built 2026-10-11** (`multiplayer.md` §12: the bell, the Inbox, comments / mentions / reactions / invites / requests); org kinds come with round 1 and branch reviews with round 2. What is left: ready-for-dev and library-update kinds (with 5c and round 3), optional email |

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
