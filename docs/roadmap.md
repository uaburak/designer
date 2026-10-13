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

Migrations continue from **0010** (round 1) and **0011** (round 2); round 3 used **0012**, round 4 **0013** (`multiplayer.md` §15.14) and **0014** (4e, idle sessions), round 5 **0015** (§16.12).

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

### Round 3 — design systems at org scale (the owner's screenshot rows) — **contract written 2026-10-11**

Contracts: `docs/data.md` **§16** (libraries in organizations: identity by room key, D1 + one `LibraryObject` per library, scope team / org, approved / default / default modes, subscriptions, Inbox notices, extended collections and the mode cap, local files, routes, migration `0012_libraries.sql`, `src/shared/libraries/orgTypes.ts`) and **§17** (library analytics: editor events, per-file instance snapshots, client batching, ingestion, the daily Cron roll-up, routes, privacy); `docs/desktop.md` **§14.3** (shared fonts: `FontObject` per org, routes, main's fourth source, the upload flow, `src/shared/fonts/sharedTypes.ts`).

**Before the agents** (main session): commit `src/shared/libraries/orgTypes.ts` (data.md §16.12) and `src/shared/fonts/sharedTypes.ts` (desktop.md §14.3) verbatim; add `orgLibraries` / `analytics` to `StoreApi` with a `notImplemented` stub in both stores (as round 1 did), so 3c, 3e and 3f compile against them.

| Agent | Owns | Delivers |
|---|---|---|
| 3a server | `server/src/libraries/` (new), `server/src/analytics/` (new), `server/src/fonts/` (new), `server/migrations/0012_libraries.sql` (data.md §16.11 verbatim), `server/src/index.ts` (exports, `scheduled()`), `server/wrangler.jsonc` (bindings `LIBRARIES`, `FONTS`, tag `v4`, the cron), `server/src/api.ts` (dispatch lines; `libraryFileStatus` in the file trash / restore / delete paths; `syncLibraryScope` in `PATCH /files/:key`), `server/src/activity.ts` (retention moved to the cron), `server/src/notifications.ts` (`library_default_override`, the `{t: "library"}` / `{t: "fonts"}` inbox notices), `server/src/testing/` (in-memory `LibraryObject` / `FontObject`) | data.md §16.4–§16.7, §16.10–§16.13, §17.5–§17.6; desktop.md §14.3's routes. Tests on node:sqlite: publish (stale base, dedupe, missing payloads), diff / payloads with dependencies, access rules incl. guests and Limited folders, scope ↔ link, approval / default / default-mode resolution with overrides and drafts, subscriptions, notices, unpublish / trash / delete, ingestion rules (drafts, branches, days, rate limit), the roll-up's numbers and "File not visible", fonts (licence header, conflicts Skip / Replace, access, delete) |
| 3b store | `src/store/libraries/` (new: `router.ts`, `org.ts`, `usage.ts`, `analyticsQueue.ts`, `orgLibraries.ts`, `fake/` — a contract fake of 3a's routes), `src/store/local/libraries.ts` (the `moved.json` alias of §16.9 only), `src/shared/store/` (`repositories.ts` `StoreApi` wiring, `protocol.ts` methods and the `fonts` topic), `src/store/localStore.ts` + `src/store/server.ts` + `src/renderer/src/store/memory/` (wiring), `src/store/notifications/service.ts` (`onLibrary`, `onFonts` forwarding only) | data.md §16.3, §16.9, §17.4–§17.5's client: `LibraryRegistry` routed by key with the org registry (caches, offline manifests and payloads, publish in three steps, subscriptions into `enabledLibraries`), `orgLibraries`, `analytics` (queue, batching, instance snapshots), the local → org alias. Tested against the fake, then against 3a's handler once merged (as `src/store/org/fake/real.ts` does) |
| 3c editor | `src/renderer/src/editor/panels/libraries/`, `editor/libraries.ts`, `editor/libraryUsage.ts` (new), `editor/analytics/` (new: the Library analytics modal; `index.ts` exports `LibraryAnalyticsModal({store, libraryKey})` for Home), `editor/variables*.ts`, `editor/panels/variables/`, `editor/model/variables.ts` (`LIMITS`), `src/renderer/src/store/documentSource.ts` (the one hook line of §17.3), `editor/menus.ts` / `editor/commands.ts` (the file name menu's "Library analytics" item only) | `libraryKeyOfFile` everywhere "this file's library" is named; the Libraries modal for org files (approved check marks pinned first, the org's and teams' libraries, "Missing library"), the Publish dialog's "Allow any member of ‹org› to access the file", "Review library updates" / "Review unpublished changes" tooltips; default modes applied at first use (§16.5); usage events (§17.3); the Library analytics modal (Overview / Analytics, Type, Duration, the insertions graph with compare, Top teams, the table, usage views, Modes tab, Download CSV above five teams); extended-collection restrictions of §16.8 each tested; the mode cap at 1,000 and chains ≤ 16 |
| 3d fonts | `src/main/sharedFonts.ts` (new), `src/main/fonts.ts`, `src/main/ipc.ts` (font lines), `src/shared/ipc.ts` (`FontIndex.shared`, the four channels), `src/preload/` (only if the channels need listing), `src/renderer/src/engine/fonts.ts`, `editor/fontList.ts`, `editor/openFonts.ts`, `editor/panels/design/FontPicker.tsx` | desktop.md §14.3's main and editor parts: the shared source (list, cache, refresh, `s:` ids, `fonts:read`, cache eviction), the scope filter per open file, precedence, the "Used at ‹organization›" filter, the pick / upload / list / remove channels. Tested against a fake server in `src/main/` |
| 3e Admin resources | `src/renderer/src/admin/` | Admin › **Resources**: **Libraries** (every library the admin can reach, filters "Approved" / "Added by default", the **Manage this library** modal: "Set as approved library", "Enable this library by default" per scope and file type with the org-publish warning, "Manage default modes"; workspace admins' Admin › ‹workspace› › Libraries) through `store.orgLibraries`; **Fonts** (list, **Font** upload through `fonts:shared-pick` / `-upload` with the licence confirmation and Skip / Replace, remove) |
| 3f Home | `src/renderer/src/files/` | All teams (All workspaces) › **Libraries**: the org-wide analytics modal (`store.analytics.orgOverview`: totals, per-library rows with "Inserts last week", search); team › View settings › Shared › **View team's libraries** (Enabled by default All files / Design files, Default mode) and **View team's fonts** (upload with the checkbox, remove); "Library analytics" on a library's context menu, rendering 3c's `LibraryAnalyticsModal` (a stub until 3c merges; the main session swaps the import at the merge) |

Merge order: **3a** (deploy needs `db:migrate` 0012 and the `v4` Durable Object migration) → **3b** (switch its tests from the fake to 3a's handler) → **3d** → **3c** → **3e** → **3f** (wire `LibraryAnalyticsModal`). One migration (3a); no schema change (`schema/document.kiwi` untouched). Engine untouched: no engine builds this round.

Open questions for the owner (round 3):
1. **Org libraries in local files.** Figma offers org libraries only in the org's files (§16.2). Should the owner's local files be able to add them too (ours)? Default if unanswered: Figma's rule.
2. **Guests and organization fonts.** Figma serves org fonts to "members"; for guests it says nothing. Default: guests don't get org fonts (team fonts yes, when they're in the team).

### Round 4 — identity and security — **contract written 2026-10-11**

Contracts: `docs/multiplayer.md` **§15** (the facts read on help.figma.com §15.1, decisions §15.2, the SAML SP per org §15.3, sign-in routing and the loopback §15.4, SCIM 2.0 §15.5, `OrgSettings` and where each policy is enforced §15.6, domains and capture §15.7, sessions and the idle timeout §15.8, rooms and `resolveAccess` §15.9, the EU data region §15.10, activity actions §15.11, shared types §15.12, routes §15.13, migration `0013_identity.sql` §15.14); `docs/desktop.md` **§12.5** (MSI, deployment keys `DisableUpdater` / `AllowedOriginHosts` / `ProxyUrl`, `DesktopPolicy`) and **§18** (SSO through the loopback, the `designerv2://sign-in` deep link, the idle prompt, IPC).

**Before the agents** (main session, one commit):
- `src/shared/org/identity.ts` (§15.12 verbatim); `src/shared/org/types.ts` additions (§15.12's marked blocks); `src/shared/multiplayer/protocol.ts` additions (`welcome.policy`, `{t: "policy"}`, `CLOSE_MOVING`); `IdentityRepository` in `src/shared/org/repositories.ts` and `identity` on `StoreApi` with a `notImplemented` stub in both stores; `src/shared/desktopPolicy.ts` (desktop.md §12.5); `src/shared/ipc.ts` additions and roles (desktop.md §18.3) with `account:stay-signed-in` registered as a stub in `src/main/ipc.ts`; `ShareDialog.tsx`'s `WORDS` / `generatePassword` replaced by `generateLinkPassword` from identity.ts (one import).
- **`server/migrations/0013_identity.sql`** (§15.14 verbatim) — committed here so 4a and 4b both test against it; no agent edits `server/migrations/` this round.
- `server/src/org/http.ts` `ErrorCode` gains `| IdentityErrorCode`.
- **`server/src/auth/settingsHooks.ts`**, a stub both server agents compile against: `validateIdentitySettings(deps, orgId, patch: Partial<OrgSettings>): Promise<void>` (throws `HttpError`) and `onIdentitySettingsChanged(deps, orgId, before: OrgSettings, next: OrgSettings, actor: User, req: Request): Promise<void>` — empty bodies. 4b's `patchSettings` calls both for `authMethod`, `idleSessionTimeoutHours`, `domainCapture`; 4a fills them (the `tested_at` / verified-domain checks, capture of existing accounts, the sessions' reset, their log actions).
- `npm run check` green with the stubs.

| Agent | Owns | Delivers |
|---|---|---|
| 4a server identity | `server/src/auth/` (new: `saml/` — the SP over node-saml, metadata, AuthnRequest, ACS, the D1 `CacheProvider`, `saml.test.ts` with the spike's 29 cases moved over plus SHA-1 refused, unsolicited bounce, two concurrent posts of one Response; `sso.ts` + `pages.ts` — the login page, `/auth/sso`, Google's routing; `scim/` — Users, Groups, PatchOp, filters, errors, `scim.test.ts`; `domains.ts` — DNS-over-HTTPS; `capture.ts`; `idle.ts`; `identityRoutes.ts` — `admin/identity`, `admin/domains`; `settingsHooks.ts` filled), `server/wrangler.jsonc` (`nodejs_compat`), `server/package.json` + lock (`@node-saml/node-saml` 5.1.0 exact, `@xmldom/xmldom` ≥ 0.8.15, `xml-crypto` ≥ 6.3.3), `server/src/google.ts`, `server/src/db.ts` (account claim of `none:` accounts, sessions' new columns, auth codes' `auth`), `server/src/account.ts` (`GET /me` session, `/me/sessions/active`, `/me/sessions/current`), `server/src/api.ts` — **only** the dispatch lines for `/auth/*`, `/saml/*`, `/scim/*`, `/orgs/:org/admin/identity…` and `…/admin/domains…`, and the functions `login`, `callback`, `token`, `devSignIn`, `issueSession`, `authenticate` | §15.3–§15.5, §15.7, §15.8 on the server; the activity actions of §15.11 for SSO, SCIM, domains, sign-in and idle. Tests on node:sqlite: every SAML case (a test IdP signs in Node, as the spike), SSO routing (verified domain → tenant, unverified → refused, Google member of a SAML org → redirected with the app's state, guests never), account linking (`none:` claimed by Google, matched by SAML), JIT, SCIM (create / filter / PUT / PATCH in Okta's and Entra's shapes / deactivate / reactivate / DELETE / groups linked to a workspace, a billing group, a user group / renames), domains (DoH answers faked: found, split strings, absent, taken), capture, idle (limit computed, expiry → 401 + log, reset on change, background requests don't count) |
| 4b server policy and region | `server/src/policy/` (new: `sharing.ts` — `filePolicy` in the routes, the expiry clamp, revoke-link fan-out; `external.ts` — `homeOrgId`; `roomPolicy.ts` — `x-policy`, `POST /room/policy` fan-out; `region.ts` — the move job), `server/src/org/` (all: `patchSettings` with every new key, its validation and logging, calling 4a's hooks; workspace `sharing`; `AdminPerson.idp`; invites of emails on the org's domains as members; workspace admins answering guest requests; `loadAccessRows` → `homeOrgId`, `externalRestricted`, `policy`; data-region routes), `src/shared/org/access.ts` + `access.test.ts` (cases 23–30), `server/src/fileRoom.ts`, `server/src/roomBox.ts`, `src/shared/multiplayer/room.ts` (`welcome.policy`, the policy broadcast, `/room/freeze` · `dump` · `load` · `unfreeze`), `server/src/index.ts` (`Rooms` by `files.jurisdiction`), `server/src/libraries/` (`objectFetch` by `libraries.jurisdiction`; `LibraryObject` freeze / dump / load), `server/src/branches.ts` (a branch room in its main's jurisdiction), `server/src/activity.ts` (external views logged in the home org), `server/src/testing/`, `server/src/api.ts` — **only** the `/files` routes (`GET` policy, `PATCH` policy refusals, `POST /files` external refusal and jurisdiction), `embedRoute`, the socket upgrade's `x-policy` | §15.6, §15.9, §15.10 on the server. Tests: each policy row of §15.6 (public links off, passwords required, autogenerated only, expiry required and the clamp, FigJam, workspace overrides incl. drafts), the access cases 23–30, external restriction on every refused route, room policy on welcome and on change, jurisdiction routing (a fake namespace with `jurisdiction()`), a full move of a room and a library (freeze, dump / load, flip, delete; a failure unfreezes), the corrected external log events |
| 4c store | `src/store/org/identity.ts` (new), `src/store/org/fake/identity.ts` (a contract fake of 4a's and 4b's admin routes), `src/shared/store/protocol.ts` (the methods), `src/store/localStore.ts` + `src/store/server.ts` + `src/renderer/src/store/memory/` (wiring), `src/store/multiplayer/` (the file's `policy` with its share info, `welcome.policy` and `{t: "policy"}` forwarded to the editor, close 4012 reconnecting like 4003, `idle_timeout` 401s surfaced) | `IdentityRepository` over the routes; the editor's policy feed. Tested against the fake, then against 4a + 4b's handler once merged (as `src/store/org/fake/real.ts`) |
| 4d Admin settings | `src/renderer/src/admin/` | Admin › Settings in Figma's sections, every row live (none disabled any more): **Login and provisioning** — Authentication (the three options; "Members must log in with SAML SSO" disabled until tested), SAML SSO (Configure SAML: provider, metadata URL / XML / the three values; SP Entity ID, SP ACS URL, Tenant ID, start URL with Copy; Test — `designer.account.signIn({tenant})`; Refresh metadata; Remove), SCIM provisioning (Generate API token shown once, base URL, Revoke), Idle session timeout (Default 21 days / Custom timeout in hours or days, 12 h–14 d), Manage domains (+ Domain, the TXT record with Copy, Verify with the values found, Remove, the Domain capture banner and toggle, the outside-accounts list); **Access** — Guest access (Figma's three sentences); **Content** — Public sharing (Public link sharing, Require passwords, Require design file links to expire 1 h–31 d, Custom settings for workspaces › Add workspace), Password protection options (Autogenerated passwords only), FigJam open sessions, Content access › Access to external content (needs capture); **Communication** — Cursor chat; **Data** — Data storage localization (region, Change → confirm → the move with its progress); **Other** — Audio, Enterprise installer (Download disabled, desktop.md §12.5). People: the SCIM / JIT metadata columns. Check the live section names first (§15.1: "Login and provisioning" vs "Access › Authentication") |
| 4e clients | `src/renderer/src/editor/ShareDialog.tsx` (+ css), `src/renderer/src/editor/multiplayer/`, `src/renderer/src/account/` (new: `IdleWarning.tsx`), `src/renderer/src/files/` (sign-in error texts, the idle toast, `IdleWarning` mounted, "+ Create" hidden in other spaces when external content is restricted), `src/renderer/src/editor/EditorApp.tsx` (one line: `IdleWarning`), `src/renderer/src/settings/SecurityTab.tsx` (Sign out everywhere), `src/renderer/src/store/webAccount.ts` (the web app's idle timer and `tenant`) | Share dialog by `FilePolicy`: links off → only "Anyone at ‹org›" and invites; passwords required → the link options need a password; autogenerated only → no field, **Generate**; expiry required → the expiry picker with its maximum; guest confirmation (Cancel / Share) for outside emails under Allow, "admin approval is required" and "sharing with external users is disabled" notices; the view-only banner for the external cap; cursor chat and audio follow `policy` live (leave an ongoing call when audio turns off); the idle prompt (desktop.md §18.2) |
| 4f desktop | `electron-builder.yml`, `build/msi/` (new, only if a WiX fragment is needed), `package.json` (the `dist:msi` script line only), `src/main/policy.ts` (new), `src/main/net.ts` (new: `mainFetch` = `net.fetch` under a proxy), `src/main/index.ts` (policy before `ready`, proxy switches, the `sign-in` deep link, `DESIGNER_SERVER` vs `AllowedOriginHosts`), `src/main/storeHost.ts` (proxy env for the store), `src/main/account/` (`signIn` with `tenant`, `idle.ts`, the IPC handlers, `mainFetch`), `src/main/ipc.ts` (the account channels), `src/main/sharedFonts.ts` + `src/main/googleFonts.ts` (`mainFetch` only) | desktop.md §12.5 and §18: the MSI target (built on Windows, not on the Mac), deployment keys read from plist / registry with their precedence, the proxy everywhere it can reach, SSO deep link, the idle timer from input events with the prompt, notification and logout. Tests: `policy.test.ts` (plist JSON and `reg query` output parsed, precedence, `originAllowed`), `idle.test.ts` (fake clock: throttled posts, prompt at −60 s, stay, logout, a changed limit), `signIn.test.ts` (tenant, SSO errors) |

Merge order: (the main session's commit) → **4a** → **4b** (both touch `api.ts` in different functions; 4b rebases onto 4a) → **4c** (switch its tests from the fake to the real handler) → **4f** → **4e** → **4d**. Deploy: `npm --prefix server run db:migrate` (0013), then `npm --prefix server run deploy` (`nodejs_compat`; no new Durable Object class, no migration tag). Engine untouched; `schema/document.kiwi` untouched.

**Owner, 2026-10-11 (answers):** no real IdP for now (agents test with the test IdP in Node; Okta / Entra later, after the deploy); domain verification and capture wait for the app's final name and domain (faked DNS answers until then); the data region is changed by org admins themselves (Admin › Settings › Data storage localization), not read-only as in Figma. Open questions 1–3 of §15 take their defaults (the "Continue to DesignerV2" bounce, SAML for verified domains only, the login page).

**Can't be fully verified without accounts the owner creates** (the agents test with a test IdP in Node, faked DNS answers and faked namespaces):
- **SAML with a real IdP**: an Okta developer org (free, developer.okta.com), a Microsoft Entra tenant (free tier or the Microsoft 365 developer program), Google Workspace (paid). Each posts to our ACS, so the Worker must be deployed (or reachable through `wrangler dev --remote` / a tunnel). Their attribute names, which element they sign (Entra's "Sign SAML response" → `assertion_or_response`), AD FS's SHA-1 default (refused by us).
- **SCIM from a real IdP**: Okta's SCIM app wizard or Entra's provisioning ("Provision on demand") against the deployed `/scim/v2/<tenant>` — Entra's PATCH dialect is the risk.
- **Domain verification and capture**: a domain the owner controls (for example burakkoc.net) to add the TXT record; SAML needs people with emails on it.
- **The EU jurisdiction**: whether the Workers free plan allows `jurisdiction("eu")` Durable Objects is only known at the first deploy (§15.10).
- **The MSI**: built and installed on a Windows machine or a Windows CI runner only.
- **The proxy**: `NODE_USE_ENV_PROXY` in Electron 44's Node and the store's sockets through it, with a real proxy.

**Moved out of round 4**: Admin › Settings' Extensions (round 5, plugins) and AI (round 6) rows; MFA, multiple IdPs, IP allowlists (round 14, Governance+).

Open questions for the owner (round 4):
1. **IdP-initiated sign-in** (an Okta tile) bounces through the app: one extra click "Continue to DesignerV2" (§15.2 decision 3) because a code without the app's PKCE challenge could be stolen. Default: the bounce.
2. **SAML only on verified domains**: Figma also allows unverified domains by emailing a 6-digit code at each new device; we send no email. Default: verified domains only (adding email — Cloudflare Email Workers or a provider — would lift it).
3. **The login page**: "Log in" from the app now opens the server's page (Continue with Google / Use single sign-on), one click more than today's straight-to-Google, as Figma's desktop app does. Default: the page.
4. **Which IdP and which domain** to test with (above). Without them round 4 ships tested only against the test IdP.
5. **Data storage localization** is self-serve here (Figma: Support), and moving files freezes each one for seconds. Default: admins change it in Admin › Settings › Data.

### Round 5 — extensibility and Dev Mode — **contract written 2026-10-11**

**Contracts:**
- `docs/multiplayer.md` **§16**, REST API and webhooks:
  - facts §16.1, decisions §16.2;
  - tokens and scopes §16.3, rate limits §16.4;
  - client render jobs §16.6, every endpoint §16.7, POST variables §16.8;
  - Webhooks V2 §16.9, event sources §16.10, activity §16.11;
  - migration `0015_extensibility.sql` §16.12, shared types §16.13, layout and tests §16.14.
- **`docs/plugins.md`** (new): plugins and widgets — the QuickJS sandbox and the developer VM, the opaque-origin UI iframe, main's pieces, the manifest, the `figma.*` subset, the chrome, Dev Mode plugins, plugin data in the schema, private plugins and approval, widgets (later).
- `docs/editor.md` **"Dev Mode — round 5"**:
  - D-1 Code Connect: mappings, templates in the plugin VM, our CLI, Code Connect UI, MCP;
  - D-2 the component playground;
  - D-3 dev resources;
  - D-4 the ready-for-dev feed and notifications;
  - D-6 prototype-only access;
  - D-7 VS Code, skipped;
  - D-8 types.

**Decided (Figma's way where Figma documents one):**
- **Documents and renders**: the REST API reads and renders documents through connected clients — an editor, then a viewer, then the desktop app's hidden "render helper" — and caches by room state.
  - Server-side SVG / PDF stays behind `REST_SERVER_RENDER` (the Workers Paid plan), specified but not built.
  - There is no CPU rasterizer.
- **Tokens**: personal access tokens with Figma's scopes and `X-Figma-Token`, and plan access tokens for org routes. **No OAuth apps** this round.
- **Webhooks**: Figma's passcode, plus an HMAC signature header; retries on a `*/5` cron.
- **Plugins**: run in QuickJS compiled to Wasm on the editor's main thread (Figma's own approach). "Use developer VM" is a Worker with a synchronous bridge.
- **Widgets**: later.
- **VS Code extension**: skipped.

**Before the agents** (main session, one commit):
- `src/shared/rest/types.ts` (§16.13), `src/shared/plugins/types.ts` (plugins.md §10.4) and `src/shared/devmode/types.ts` (editor.md D-8), verbatim.
- The additions listed in §16.13:
  - `TOKEN_SCOPES` / `AccessTokenInfo`;
  - `ActivityAction`;
  - `OrgSettings` + defaults;
  - `NotificationKind`;
  - the room protocol messages.
- `FileAccess.prototypeOnly`, `OpenIntent.devMode`.
- `plugins` and `devMode` on `StoreApi`, with `notImplemented` stubs in both stores.
- IPC channels and roles in `src/shared/ipc.ts`: `plugins:*` (plugins.md §3.3) and `devmode:link-title`, registered as stubs in `src/main/ipc.ts`.
- Server stubs `server/src/webhooks/emit.ts` (`emitWebhook`) and `server/src/devmode/rest.ts` (`devModeRestRoute`).
- A client stub `src/renderer/src/editor/plugins/index.ts`, exporting:
  - `createSandbox(opts: {kind: "plugin" | "template"; code: string; api: Record<string, unknown>; memoryMb?: number; timeoutMs?: number}): Promise<Sandbox>`;
  - `interface Sandbox { call(fn: string, ...args: unknown[]): Promise<unknown>; dispose(): void }`.

  Until 5d fills it, the stub throws "Plugins aren't built yet". 5f's Code Connect templates use it.
- **`server/migrations/0015_extensibility.sql`** (§16.12, verbatim). No agent edits `server/migrations/` this round.
- `npm run check` green.

| Agent | Owns | Delivers |
|---|---|---|
| 5a REST server | `server/src/rest/` (new), `server/src/webhooks/` (new; fills `emit.ts`), `server/src/api.ts` — **only** the dispatch lines for `/v1/*`, `/v2/*`, `/orgs/:org/admin/plan-tokens…`, `PUT /files/:key/thumbnail`, `PUT /files/:key/rest-jobs/:id/parts/:name`, and `emitWebhook` in the file delete path; `server/src/account.ts` (token kinds), `server/src/fileRoom.ts`, `server/src/roomBox.ts`, `src/shared/multiplayer/room.ts` (render jobs, `hello.render`, the FILE_UPDATE alarm, the thumbnail, `rest-wanted`), `server/src/comments.ts` / `server/src/branches.ts` / `server/src/libraries/routes.ts` (one `emitWebhook` each; `library_assets.node_id` and dates), `server/src/index.ts`, `server/wrangler.jsonc` (the `*/5` cron), `server/src/testing/`, `src/shared/rest/variablesPost.ts` (`validateShape`) | §16.2–§16.14 on the server: auth with `X-Figma-Token`, scopes, tiers and rate limits with Figma's headers, signed blob URLs, every `/v1` and `/v2` route of §16.7 (dev resources and Code Connect through 5c's `devModeRestRoute`), render jobs with the client order and the 503, plan access tokens, Webhooks V2 with the payloads, retries and log. Tests as §16.14 |
| 5b REST clients | `src/renderer/src/editor/rest/` (new: `fileJson.ts`, `images.ts`, `variablesJson.ts`, `variablesPost.ts`, the job runner), `src/renderer/src/editor/EditorApp.tsx` (one line: the job runner), `src/store/multiplayer/` (`hello.render`, the job relay to the editor and part uploads, the thumbnail upload with snapshots), `src/main/restHelper.ts` (new), `src/main/index.ts` (one line), `src/renderer/src/settings/AccountTab.tsx` (the render helper switch) | §16.6's client side: Figma's REST JSON from the engine (compared with Figma's own output for the sample files where available), exports per id, local variables JSON, POST variables as one actor write, the hidden render helper (spare view, 5-minute discard). Tests: JSON shapes per node type, `geometry=paths`, `depth`, `ids`, versions, variables POST (tempIds, extended collections, the all-or-nothing rule); the helper with a fake inbox |
| 5c server Dev Mode and plugins | `server/src/devmode/` (new: `devResources.ts`, `codeConnect.ts`, `status.ts`, `prototype.ts`, `rest.ts`), `server/src/plugins/` (new: private plugins, chunks, approvals, requests), `server/src/notifications.ts` + `src/shared/notifications.ts` (the five new kinds, the hour folding, the Dev Mode preference), `server/src/org/` (`patchSettings` for the four plugin keys and their log actions; `Access` for the prototype level), `src/shared/org/access.ts` + `access.test.ts` (the `prototype` level, new cases), `server/src/api.ts` — **only** the dispatch lines for `/files/:key/dev-resources…`, `/files/:key/code-connect…`, `/files/:key/dev-status…`, `/files/:key/prototype-members…`, `/plugins…`, `/orgs/:org/plugins…`, `/orgs/:org/admin/plugins…`, and `protoOrgLinkAccess` in `PATCH /files/:key` | editor.md D-1 (storage, `/v1/code_connect`, the private routes), D-3, D-4 (report, viewers, notifications, `DEV_MODE_STATUS_UPDATE`), D-6 (prototype members, the access level, the room role); plugins.md §10. Tests on node:sqlite: limits and duplicates, component links on instances, seats, notifications folded and who gets them, approval and request flows with workspaces, guests refused, chunks and SHA-1, prototype-only access cases |
| 5d plugin host | `src/renderer/src/editor/plugins/` (fills `index.ts`), `src/shared/plugins/` (`manifest.ts`, `network.ts`), `editor/panels/ActionsPanel.tsx`, `editor/panels/LeftPanel.tsx` (the Tools tab's content only), `editor/menus.ts` / `editor/commands.ts` (Plugins, Development, the canvas Plugins ▸), `editor/EditorApp.tsx` (one line: the host), the Design panel header's relaunch buttons (one component in `editor/panels/design/`), `schema/document.kiwi` + `docs/schema.md` (§8), the engine's generated output and **the release wasm** (the round's only engine build), `package.json` + lock (`quickjs-emscripten-core`, `@jitl/quickjs-wasmfile-release-asyncify`, dev `@figma/plugin-typings`, exact) | plugins.md §2–§8: QuickJS runs with limits and Stop, the developer VM, the UI window and messaging, the §5 API on the editor (one undo step per run, `commitUndo`, `documentchange`, dynamic-page rules), the manifest, development plugins with hot reload, Actions › Plugins & widgets with parameters, the Tools tab, saved / recents, approval checks through `store.plugins.allowed`, plugin data. Tests: the §5 fixture plugins on the wasm engine (`plugins.wasm.test.ts`), the sandbox's escapes refused, manifest parsing, network rules |
| 5e plugin desktop | `src/main/plugins/` (new: `manifests.ts`, `watch.ts`, `protocol.ts`, `fetch.ts`, `storage.ts`, `templates/`), `src/main/devmodeLinks.ts` (new: `devmode:link-title`), `src/main/protocol.ts` (the editor CSP's `frame-src plugin:`), `src/main/index.ts` (scheme registration, one line), `src/main/ipc.ts` (the plugin and devmode channels), `src/preload/` (only if channels need listing), `vite.shared.ts` (the dev CSP's `frame-src`) | plugins.md §3.2–§3.3: the `plugin:` scheme with the per-run CSP and COEP `credentialless`, frame navigation rules, development manifests (import, list, remove, read with path checks; `build` never run), hot reload, `fetch` with the allowlist, `clientStorage` with 5 MB, New plugin… templates written to a chosen folder, Open console. Tests: path escapes, CSP strings from domains, fetch allowed / refused, storage size rule, watch debounce |
| 5f Dev Mode | `src/renderer/src/editor/devmode/` (Code Connect UI, Playground, ReadyForDev, the Plugins panel host), `editor/devStatus.ts` (the status report call), `src/viewer/` (Inspect: Code Connect snippets, dev resources, codegen languages; `DevSections.tsx`, `inspect/`), `tools/code-connect/` (new CLI), `src/shared/agents/tools.ts` + `editor/agents/mcpTools.ts` (`get_code_connect_map` only, and the snippet in `get_design_context`) | editor.md D-1 (snippets via `createSandbox` with Figma's template API, UI mappings, the CLI, MCP), D-2, D-3's UI, D-4's feed and viewed report, plugins.md §7 (codegen and inspect plugins in Dev Mode). Tests: templates on a fake sandbox (then the real one after 5d merges), nested and pill snippets, errors; the CLI against 5c's handler (publish / unpublish / parse / create, substitutions); the playground never writes the file; editor-shot `EDITOR_ONLY=devmode5` |
| 5g store | `src/store/devmode/` (new), `src/store/plugins/` (new), `src/shared/store/protocol.ts` (the methods), `src/store/localStore.ts` + `src/store/server.ts` + `src/renderer/src/store/memory/` (wiring) | `DevModeRepository` (server for shared files, `files/<key>/dev-resources.json` / `code-connect.json` for local ones, events `devmode`), `PluginsRepository` (saved / recents, private plugins cached under `Workspace/spaces/plugins/`, publish in three steps, `allowed` from the org cache, requests, admin calls). Tested against a contract fake, then against 5c's handler once merged |
| 5h chrome | `src/renderer/src/admin/` (Settings › Extensions; Settings › Plan access tokens; Resources › Plugins / Widgets with Approved, Requests, the review modal, Add plugin, Edit approvals), `src/renderer/src/settings/SecurityTab.tsx` (the new scopes in Generate new token) + `NotificationsTab.tsx` (Dev Mode), `src/renderer/src/notifications/` (rows for the five kinds), `src/renderer/src/editor/ShareDialog.tsx` (+ css) and `editor/SharePrototypeDialog.tsx` (new), `editor/EditorRoute.tsx` (prototype-only opens the presentation view only), the presentation view's "Share prototype" button | plugins.md §10's admin side; §16.3's token scopes and plan tokens; editor.md D-4's settings and rows, D-6's modal and gate. Tests: DOM tests on the fake stores; screenshots against Figma's captures where they exist |

**Merge order**:
1. The main session's commit.
2. **5a**.
3. **5c**: rebases onto 5a's `api.ts` lines and fills `devModeRestRoute`.
4. **5g**: switches its tests from the fake to the real handler.
5. **5e**.
6. **5d**: schema + release wasm.
7. **5b**.
8. **5f**: swaps the fake sandbox for 5d's.
9. **5h**.

`api.ts` is shared by 5a and 5c (different lines); `EditorApp.tsx` gets one line each from 5b and 5d; `src/main/index.ts` one line each from 5b and 5e.

**Deploy**: `npm --prefix server run db:migrate` (0015), then `npm --prefix server run deploy`. The new cron `*/5 * * * *` makes two of the free plan's five. There is no new Durable Object and no migration tag.

**Built already, not redone**: notifications (§12; old item 5d is now only round 5's five kinds, in 5c) and personal access tokens (§13; 5a adds scopes and plan tokens).

**Can't be fully verified here**:
- Figma's own `@figma/code-connect` CLI against our `/v1/code_connect` (5f reports what its request looks like).
- REST JSON parity with Figma for files the owner has in both apps: a `GET /v1/files` from Figma with the owner's own token.
- A Community plugin's source run unchanged: the owner picks two or three plugins he uses and downloads their code.
- The Workers Paid plan path (`REST_SERVER_RENDER`).

**Answered by the owner, 2026-10-11:** stay on the free Workers plan (client render-and-cache; server SVG / PDF stays behind `REST_SERVER_RENDER`, off); the render helper is on for files you own (a switch in Settings › Account); prototype-only viewers downloading the file's data is accepted.

**Open questions for the owner (round 5):**
1. **Workers Paid plan ($5/month)?** Server-rendered SVG / PDF needs it: no client online would be needed for those. Default: no, client render-and-cache only.
2. **Prototype-only viewers receive the whole file's data** (the player runs on it). They see only the prototype in the app, but the data is on their machine, as for "can view". Isolating it would need server decoding (question 1). Default: accept, as Figma's player also loads the file (unverified).
3. **The render helper opens your files in the background** when an API call arrives and nobody has the file open. The default is on for files you own; you can turn it off in Settings › Account. Should it be on by default?

### Round 6 — AI — **contract written 2026-10-12** (`docs/ai.md`)

**Contract:** `docs/ai.md` covers Figma's verified facts (§1), the decisions (§2), the actions (§3), the image tools (§4), Vectorize (§5), search (§6), usage and settings (§7), the shared types (§8) and the open questions (§10). Weave tools (old 6c) are **set aside** (owner, 2026-10-11).

**Before the agents** (main session, one commit):
- `src/shared/ai/types.ts` verbatim (§8), and the `TurnRequest` / `OrgSettings` additions.
- `ai` / `search` on `StoreApi`, with stubs in both stores.
- The `ai:*` and connector IPC channels, as stubs in main.
- The `editor/search/index.ts` and `editor/imageTools/worker.ts` stubs.
- `npm run check` green.
- No migration this round: `ai_usage_daily` came with 0015.

| Agent | Owns | Delivers |
|---|---|---|
| 6a actions | `src/renderer/src/editor/ai/` (new), `src/shared/ai/prompts.ts`, `schemas.ts`, `kits/` (new), `editor/panels/ActionsPanel.tsx` (+css, `actionsTab.ts`), `editor/panels/prototype/` (the Add interactions button + banner), `editor/menus.ts` / `editor/commands.ts` (Rename layers AI, AI balance entry), `editor/agents/turns.ts` (`writeAction` only), `editor/EditorApp.tsx` (one line) | §3: Rename layers, Rewrite this… / Shorten / Translate to…, Replace content (+ the duplicate banner), Add interactions with Preview / Keep it, First Draft with the four kits, themes and Make changes. Each one is one undo step, with cancel and errors. Tests: schemas, the builder, rename eligibility, apply on the wasm engine with fake runs |
| 6b images | `src/main/ai/images/` (OpenAI, Gemini, Antigravity image clients), `src/main/ai/models.ts` + `protocol.ts` (downloads, `aimodel:`), `src/main/protocol.ts` / `src/main/index.ts` (one line each), `src/renderer/src/editor/imageTools/` (the worker, the toolbar, Select area, Expand, the Vectorize UI, Make an image card), `editor/canvas/BottomToolbar.tsx` (one line), the fill picker's Make an image (one component in `panels/design/`), `package.json` + lock (`@huggingface/transformers`, `onnxruntime-web`, exact) | §2.4–2.6, §4. Tests: mask and composite maths, tiling, model checksums, fake HTTP for the APIs |
| ~~6c Weave tools~~ | — | set aside |
| 6d search | `src/store/search/` (new), `src/renderer/src/editor/search/` (fills the stub: indexer, query, view), `editor/panels/Assets.tsx` (Similar) | §6. Tests: the index format, cosine ranking with exact-first, incremental versions, deleted files |
| 6e engine Vectorize | `engine/src/trace/` (new), `engine/src/api/TraceApi.inc` + one line in `Api.cpp`, `engine/api/exports.txt`, `src/renderer/src/engine/EngineExports.ts` / `Engine.ts`, `engine/tests/unit/trace.test.cpp`, **the release wasm** (the round's only engine build) | §5. Tests as listed there |
| 6f AI host | `src/main/ai/run.ts` + `settings.ts`, `src/main/agents/providers/*` (`oneShot` plans), `src/main/agents/connectors.ts` (new) + `mcpServer.ts` (proxy) + `host.ts` (skills / connectors in turns), `src/shared/agents/tools.ts` (`get_skill`), `src/main/ipc.ts` (the ai / connector channels), `src/renderer/src/editor/panels/agents/` (the + menu, Skills, `/` commands, connectors, the consent card, the credits hover) | §2.1–2.3, §2.10–2.11. Tests: structured output and repair, cancel, the proxy and consent policies, skill parsing |
| 6g ledger and chrome | `src/store/ai/` (new: ledger, skills, daily reports), `src/shared/store/protocol.ts` + store wiring (`localStore.ts`, `server.ts`, `renderer/src/store/memory/`), `server/src/ai/` (new: `POST /me/ai-usage`) + `server/src/api.ts` (that dispatch line only) + `server/src/org/` (the two settings keys), `src/renderer/src/settings/` (Settings › AI), `src/renderer/src/admin/` (Settings › AI, the Dashboard's AI usage), the AI balance modal (`editor/ai/AiBalance.tsx` is 6a's folder: 6g ships it as `src/renderer/src/settings/AiBalance.tsx`) | §2.9, §2.12, §7. Tests: credits, balance and month reset, upserts are idempotent, `/v1/ai_usage/daily` returns the rows |

**Merge order**:
1. The main session's commit.
2. **6e**.
3. **6f**.
4. **6g**.
5. **6b**.
6. **6a**: swaps its fake runner for 6f's.
7. **6d**: uses 6b's worker.

**Deploy**: `npm --prefix server run deploy` (no migration).

**Open questions**: `docs/ai.md` §10.

### Round 7 — Draw complete — **contract written 2026-10-12** (`docs/draw.md`)

**Contract:** `docs/draw.md` covers:
- Figma's verified facts (§1) and what we already have (§2);
- the decisions (§3);
- the engine: schema, transform groups, dynamic strokes, text on a path, brushes, multi-edit, commands and export (§4);
- the chrome (§5), the brush assets (§6), the plugin API and REST (§7), and `.fig` fidelity (§8);
- the shared types (§9) and the open questions (§11).

Old **7c "editor types" is dropped**: Draw is a mode of a Design file, and the other products are set aside. `EditorType` / `pageType` stay reserved.

**Before the agents** (main session, one commit; it is the round's only schema editor):
- `schema/document.kiwi`: §4.1, with Figma's numbers:
  - `TEXT_PATH 41`, `TRANSFORM 48`;
  - `TextPathStart`, `TransformModifier` and its enums;
  - `rotationOrigin 424`, `vectorOperationVersion 425`, `textPathStart 432`, `transformModifiers 455`;
  - `Glyph.rotation 9`.
- Then `npm run engine:gen`, which regenerates the C++ and TS codecs (no wasm build).
- `src/shared/draw/types.ts` verbatim (§9).
- The `Engine.ts` stubs and `abi.ts` additions (CommandIds 310–321, tools BRUSH / TEXT_PATH, `DRAW_TOOL_SAMPLED`).
- The §9 icons.
- `npm run check` green.

| Agent | Owns | Delivers |
|---|---|---|
| 7a engine: model and render | `engine/src/geometry/` (new `DynamicStroke.*`, `Repeat.*`; `Brush.*`), `engine/src/text/` (new `TextPathLayout.*`), `engine/src/render/`, `engine/src/export/`, `engine/src/scene/`, `engine/src/layout/` (TRANSFORM bounds), `engine/src/hit/`, `engine/tests/unit/r7.draw.*` (model / render / export cases) | §4.2 evaluation, bounds, rendering and hit mapping; §4.3; §4.4 layout, glyph rotation and rendering; pattern strokes; §4.8 exports. Native tests only (`npm run engine:test`), **no wasm build** |
| 7b engine: tools and editing | `engine/src/editor/`, `engine/src/tools/`, `engine/src/api/DrawApi.inc` (new) + its one line in `Api.cpp`, `engine/api/exports.txt`, `src/renderer/src/engine/` (fills the stubs), `engine/tests/unit/r7.draw_edit.test.cpp`, `src/renderer/src/engine/__tests__/draw.wasm.test.ts`, **the release wasm** (the round's only wasm build) | §4.2 commands, §4.4 tools / start handle / CREATE_TEXT_PATH, §4.5 install / tool / Create brush / clipboard / sampling / preview, §4.6 multi-edit, §4.7. **Starts after 7a merges** (one engine builder at a time) |
| 7c Draw toolbar and tools chrome | `src/renderer/src/editor/draw/` except `draw/panels/` (new: `DrawToolSettings.tsx`, `BrushMenu.tsx`, `drawTools.ts`), `editor/canvas/BottomToolbar.tsx`, `editor/uiStore.ts` (`drawTools`), `editor/commands.ts`, `editor/menus.ts`, `editor/canvas/CanvasMenu.tsx`, `ds/components/EditorToolbar.tsx` (Draw's tool set; Text on path enabled), `ds/gallery/` (its demos) | §5.1, §5.2, §5.6, §5.7. Tests: the toolbar per mode, the settings sent to the engine (fake engine), the brush menu's sections |
| 7d Draw panels and layers | `src/renderer/src/editor/draw/panels/` (new: `TransformSection.tsx`, Draw's section list), `editor/panels/RightPanel.tsx`, `panels/design/DesignPanel.tsx`, `Stroke.tsx`, `Typography.tsx`, `Effects.tsx` / `Paints.tsx` (sliders and previews only), `editor/panels/Layers.tsx`, `ds/components/LayerRow.*` (the thumbnail slot), `ds/components/Slider.tsx` + css (new) | §5.3, §5.4, §5.5, §5.8, §5.9. Tests: sections per mode, Stroke kinds and their commands, the Repeat popover, Flip, thumbnail caching (fake engine) |
| 7e assets, plugin API, REST, `.fig` | `src/shared/draw/brushes/` (new), `scripts/brushes.mjs` (new), `src/renderer/src/editor/plugins/api/` + `plugins/runtime/figma.js`, `editor/rest/fileJson.ts`, `editor/devmode/` (TEXT_PATH / TRANSFORM inspection), `src/shared/fig/` tests (§8), `docs/plugins.md` (its Draw section) | §6, §7, §8. Tests: brush determinism / validity, the plugin surface on the wasm engine (after 7b), the `.fig` round trip |

**Merge order**:
1. The main session's commit.
2. **7a**.
3. **7e**: brush assets; its plugin wasm tests wait for 7b, so they are skipped until then.
4. **7b**: builds the release wasm.
5. **7c**.
6. **7d**: uses 7c's `BrushMenu`.
7. 7e's plugin wasm tests are switched on.

7c, 7d and 7e work in parallel against the stubs from the start. 7b starts when 7a is merged. No migration, no server change.

**Open questions**: `docs/draw.md` §11 (a Draw sample `.fig` and a signed-in capture; brush names; when brushes are installed; whether Text on path keeps the shape).

### Round 8 — Motion — **contract written 2026-10-12** (`docs/motion.md`)


**Owner, 2026-10-12: Round 8 (Motion) is skipped for now — the whole round is deferred.** The contract (docs/motion.md, with his answers in §12) stays ready for later; time-stamped comments (8g, migration 0017) are deferred with it. Nothing of Round 8 is started.

**Contract:** `docs/motion.md` covers:
- Figma's verified facts (§1: the help centre's Motion articles, the blog, the plugin API's Motion types, Figma's own motion skills) and what we already have (§2);
- the decisions (§3);
- the engine model: schema with Figma's numbers, where motion nodes live and how layers bind to them, timelines, track evaluation, fields and composition, presets, easing, interpolation, commands and routing, text, audio, the player, rendering, budgets (§4);
- the motion layer: evaluated values as preview writes, restored before every transaction and every document read (§5);
- the chrome: Motion mode, the timeline, the easing menu and editors, the canvas, the right panel, audio, variables, time-stamped comments, commands (§6);
- export: the Animated tab, MP4 / WebM (WebCodecs), GIF (`gifenc`), animated SVG, Lottie and dotLottie (§7);
- Dev Mode's Motion tab with CSS / React / JSON (§8); plugin API, REST, agents, `.fig` (§9);
- the shared types (§10), tests (§11) and the open questions (§12).

**Before the agents** (main session, one commit; it is the round's only schema editor):
- `schema/document.kiwi`: §4.1 with Figma's numbers:
  - KEYFRAME 56, KEYFRAME_TRACK 57, ANIMATION_PRESET_INSTANCE 58;
  - the enums and messages listed there, complete;
  - `NodeChange` 505–514, 521, 523, 535, 542–545, 552, 553, 566, 580, 582, 583, 586, 587, 591, 597–603, 605, 610;
  - `SpringParams.springType 4`, `VariableAnyValue` 19 / 20, `ComponentPropValue.easingData 5`, `Effect` 37–42 / 45–54, `PrototypeAction` 39–41;
  - the new values of `VariableDataType`, `VariableResolvedDataType`, `VariableField` (43–76), `StyleType ANIMATION 7`, `ConnectionType 10`, `ComponentPropType EASING 8`; EASING / TIMING lose `@later` (TIMING in ms).
- Then `npm run engine:gen` (C++ and TS codecs; no wasm build).
- `src/shared/motion/types.ts` verbatim (§10), `CommentAnchor.timeMs` in `src/shared/comments.ts`.
- The `Engine.ts` stubs, `abi.ts` (CommandIds 330–349, tool `ANCHOR_POINT`), the `MOTION_CHANGED` event in `codec.ts`.
- The chrome stubs `editor/motion/easing/EasingEditor.tsx` and `editor/motion/index.ts`.
- The §10 icons.
- `npm run check` green.

| Agent | Owns | Delivers |
|---|---|---|
| 8a engine: model, evaluator, render, player | `engine/src/motion/` (new: `Fields.h`, `Easing.*`, `Interpolate.*`, `Track.*`, `Presets.*`, `MotionIndex.*`, `MotionLayer.*`, `TextStagger.*`), `engine/src/proto/` (timelines in the player; `ease` moved to `motion::Easing`), `engine/src/render/` (motion world, path trim, per-element text runs, the Motion icon in frame titles, the motion path / anchor overlays' drawing), `engine/src/geometry/` (path trim), `engine/src/text/` (element grouping), `engine/src/hit/`, `engine/src/export/` (a frame at t, SVG `ids: "guid"`, shapes for Lottie), `engine/src/scene/` (`motionWorld`, the transaction-begin hook), `engine/tests/unit/r8.motion*.test.cpp`, the bench cases. Minimal touches in `engine/src/editor/` (the pipeline stage after bindings; `Editor::overlay` passes the motion overlays), listed in its as-built note | §4.1 defaults, §4.3–4.8, §4.10, §4.12–4.14, §5. Native tests only (`npm run engine:test`), **no wasm build**. As built written into §4 "For 8b": the internal APIs |
| 8b engine: editing and API | `engine/src/editor/` (commands 330–349, routing, ownership in delete / duplicate / clipboard / detach / flatten / libraries, auto-keyframe, the anchor tool, motion path gestures), `engine/src/tools/`, `engine/src/api/MotionApi.inc` (new) + its one line in `Api.cpp`, `engine/api/exports.txt`, `src/renderer/src/engine/` (fills the stubs), `engine/tests/unit/r8.motion_edit.test.cpp`, `src/renderer/src/engine/__tests__/motion.wasm.test.ts`, **the release wasm** (the round's only wasm build) | §4.2 ownership, §4.9, §4.11 commands, the bindings of §10. **Starts after 8a merges** (one engine builder at a time) |
| 8c Motion mode and the timeline | `src/renderer/src/editor/motion/` except `motion/easing/`, `motion/panels/` and `motion/export/` (new: `timeline/`, `clock.ts`, `audio/`, `MotionMode.tsx`), `ds/components/EditorToolbar.tsx` (Motion enabled, the Beta tag), `editor/canvas/BottomToolbar.tsx`, `editor/canvas/viewInsets.ts`, `editor/canvas/CanvasMenu.tsx`, `editor/EditorApp.tsx` (mounting the timeline: one line), `editor/uiStore.ts` (`motion`), `editor/commands.ts`, `editor/menus.ts`, `editor/images.ts` (`isAudioFile`), `ds/gallery/` (its demos) | §6.1, §6.2, §6.4 (the TS side), §6.6, §6.9; the read-only timeline 8f mounts. Tests: the clock, the timeline's hit maths, snapping and selection, routing calls (fake engine), audio scheduling (fake AudioContext) |
| 8d right panel, easing, variables | `editor/motion/easing/` (fills the stub: the menu, Custom bezier, Custom spring), `editor/motion/panels/` (new: `KeyframeDiamond.tsx`, `AnimationsSection.tsx`, `MotionTransformSection.tsx`, `AudioSection.tsx`), `editor/panels/RightPanel.tsx`, `panels/design/DesignPanel.tsx`, `Sizing.tsx`, `Layout.tsx`, `Paints.tsx`, `Stroke.tsx` (Path trim start / end), `Effects.tsx`, `ShaderSettings.tsx`, `Typography.tsx` (Text stagger), `Component.tsx` (read-only in Motion), `editor/panels/variables/` (Easing / Timing), `editor/panels/prototype/` (read-only "Control animation") | §6.3, §6.5, §6.7. Tests: diamond states, the Animations section's commands, the easing editors' values, the variable types (fake engine) |
| 8e export | `src/renderer/src/editor/motion/export/` (new: `frames.ts`, `video.ts`, `gif.ts`, `svg.ts`, `lottie/`, `zip.ts`, `audioMix.ts`), `panels/design/Export.tsx` + `Export.module.css` (the Animated tab), `editor/exportCore.ts`, `editor/exporting.ts`, `src/shared/exportFiles.ts` (the new MIME types), `package.json` + lock (`mp4-muxer`, `webm-muxer`, `gifenc`, exact versions) | §7. Tests as §11 (fake encoders; real GIF / SVG / Lottie / ZIP bytes) |
| 8f Dev Mode, plugin API, REST, agents, `.fig` | `src/viewer/inspect/motion*.ts(x)` (new: the tab, `cssMotion.ts`, `reactMotion.ts`), `src/viewer/InspectPanel.tsx` (the Motion tab), `editor/devmode/` (its wiring and the read-only timeline mount), `editor/plugins/api/` + `plugins/runtime/figma.js`, `editor/rest/fileJson.ts`, `src/shared/agents/tools.ts` + `src/main/agents/host.ts` (the motion tools), `src/shared/fig/` tests, `docs/plugins.md` (its Motion section) | §8, §9. Tests: code snapshots per format, the plugin surface on the wasm engine (after 8b), the `.fig` round trip |
| 8g time-stamped comments | `server/migrations/0017_comment_time.sql` (the round's only migration), `server/src/comments.ts` (+ test), `src/store/` (the local comments' `timeMs`), `src/renderer/src/editor/comments/` | §6.8. Tests: the route keeps and returns `time_ms`; pins filtered by the playhead |

**Merge order**:
1. The main session's commit.
2. **8a**.
3. **8g** (independent; any time after 1).
4. **8b**: builds the release wasm.
5. **8d**: the easing editor 8c uses.
6. **8c**.
7. **8e**.
8. **8f**: its plugin wasm tests are skipped until 8b, then switched on.

8c, 8d, 8e, 8f and 8g work in parallel against the stubs from the start. 8b starts when 8a is merged.

**Deploy**: migration 0017 and `npm --prefix server run deploy` — by the owner, at the end of all work.

**Open questions**: `docs/motion.md` §12 (a Motion sample `.fig` and a signed-in capture; base values vs t = 0 in Design; which frames play in Motion mode; scale vs size keys; time-stamped comments now or later).

**Owner, 2026-10-11: not now** — FigJam, Slides, Buzz, Sites + Make and Weave (rounds 9–13) and round 6c's Weave tools are set aside (round 6's contract: docs/ai.md); Draw (7) and Motion (8) stay. Round 7's old "editor types" item went with them (docs/draw.md, 2026-10-12). The schema numbers stay reserved (docs/schema.md §15).

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

### Round 14 — Governance+ (add-on, last) — **built 2026-10-12** (`docs/governance.md`; review fixes and the end-to-end run: handoff.md)

**Scope:**
- Identity: multiple IdPs, guest 2FA (our TOTP), guest expiration, the idle timeout down to 15 min.
- Network: IP allowlist and network access restrictions.
- Content: the org-wide export restriction (plus enforcing the file-level "Viewers can copy, share, and export" in clients, a base-plan fix), internal policies.
- APIs: Discovery and Developer logs.
- Encryption: key management.
- Not built: AI hosting controls, Support visibility.

**The contract is final (2026-10-12)**; the owner's answers are in `docs/governance.md` §8.

**Before the agents** (main session, one commit) — **done 2026-10-12**:
- `src/shared/org/governance.ts` (§6);
- the type additions listed in §6;
- `GovernanceRepository` with `StoreApi.governance` stubs;
- `server/migrations/0018_governance.sql` (§7 verbatim) — no agent edits migrations this round;
- `ErrorCode | GovernanceErrorCode`;
- server stubs:
  - `server/src/governance/gate.ts`: `orgGate(deps, user, orgId, req)` and `networkCheck(deps, user, req)`;
  - `server/src/discovery/record.ts`: `recordDiscovery(deps, events)` and `discoveryAlarm(room)`;
  - `server/src/rest/devlog.ts`: `logDeveloperCall(deps, entry)`;
  - `server/src/ekm/cipher.ts`: `RoomCipher` with a pass-through implementation;
- `npm run check` green.

| Agent | Owns | Delivers |
|---|---|---|
| 14a server identity | `server/src/auth/` (multiple IdPs in `saml/`, `identityRoutes.ts`, `domains.ts`, `scim/` per-IdP tokens, `sso.ts` + `pages.ts`: the 2FA challenge page and `network_restricted` at sign-in, `settingsHooks.ts` `validIdleHours`), `server/src/governance/twoFactor.ts` + `network.ts` (fills `networkCheck`), `server/src/account.ts` (`/me/two-factor…`), `server/src/db.ts` (codes' `mfa_pending`), `server/src/api.ts` — only `authenticate` (the network check) and the dispatch lines of `/auth/2fa` and `/me/two-factor` | §2.2 (sign-in side), §2.4, §2.8, §2.9; tests on node:sqlite: TOTP vectors (RFC 6238), replay of a step, recovery codes, rate limit, the challenge on Google and SAML, the IdP mapping and routing, unmapped domains, network shadow and enforce |
| 14b server org policy | `server/src/governance/` except 14a's two files (`gate.ts` filled, `ip.ts`, `policies.ts`, `guests.ts`, `routes.ts` with `admin/governance`, `ip-allowlist`, `network-ranges`, `policies`, `guests/expiration`), `server/src/org/` (settings keys, the gate in `Access.rowsFor`, guest expiry on join, People fields), `src/shared/org/access.ts` + test (`canExport` by `fileExporting`, expired guests), `server/src/policy/` (`fileExporting` in `filePolicy`, `discovery` in `x-policy`), `server/src/activity.ts`, `server/src/api.ts` — only the `/files` routes (gates, `export_restricted`) and the socket upgrade's gate, `server/src/index.ts` (one line in the daily cron: guest expiry) | §2.1, §2.3, §2.5–§2.7, §2.13, §3 |
| 14c server EKM | `server/src/ekm/` (new: managed wrapping under `EKM_ROOT_KEY`, `RoomCipher`, routes `admin/key-management…`; no KMS client), `server/src/roomBox.ts` + `server/src/fileRoom.ts` (encrypted tables, unwrap on wake, `key_unavailable`), `server/src/policy/dump.ts` only if the move needs it | §2.10; tests: round trip, a wrong or missing root key → 503, lazy encryption, encrypt-next, the region move of an encrypted room |
| 14d server Discovery and developer logs | `server/src/discovery/` (fills the stubs; `/v1/discovery` and signed files), `server/src/rest/` (`devlog.ts`, the routes, the log line in `restRoute`, `scopes.ts`), `server/src/rest/roomJobs.ts` (the `discovery_text` job), `src/shared/multiplayer/room.ts` (cursor chat capture), `server/src/comments.ts` + `server/src/devmode/devResources.ts` (one `recordDiscovery` call each), `server/src/index.ts` (one line: retention) | §2.11, §2.12 |
| 14e store | `src/store/org/governance.ts` (new) + wiring in `localStore.ts`, `server.ts`, `renderer/src/store/memory/`, `src/shared/store/protocol.ts`; `src/store/multiplayer/` (the new 403 codes and gates surfaced as events) | `GovernanceRepository` over 14a–14d's routes, tested against the real handler |
| 14f desktop main | `src/main/agents/mcpServer.ts` (MCP reports), `src/main/ai/` (AI prompt reports) | client-reported Discovery and developer-log events for org files |
| 14g clients | `src/renderer/src/settings/SecurityTab.tsx` (2FA), `src/renderer/src/account/` (`PolicyModal`, `TwoFactorRequired`, `IpBlocked`, `NetworkRestricted`, `GuestExpiryBanner`), `src/renderer/src/files/` (gates, banner), `src/renderer/src/editor/exporting.ts` + `commands.ts` + `objectCommands.ts` + `panels/design/Export.tsx` (`access.canExport`), `editor/ShareDialog.tsx` (the label), `editor/EditorApp.tsx` (one line), `editor/rest/discoveryText.ts` (the job), `package.json` + lock (`qrcode-generator` 1.4.4 exact) | §5 "Clients" |
| 14h Admin | `src/renderer/src/admin/` | §5 Admin sections, People, Developer logs |

**Merge order:** the main session's commit → **14a** → **14b** (both touch `api.ts` in different functions) → **14c** → **14d** (14c and 14d both touch the room; 14d rebases) → **14e** → **14f** → **14g** → **14h**.

**Deploy (owner, at the end):**
- `wrangler secret put EKM_ROOT_KEY` (32 random bytes, base64);
- migration 0018;
- `npm --prefix server run deploy`.

No new Durable Object class and no new cron. The engine and the schema are untouched.

**Owner's answers (2026-10-12):** free-tier and performance first, the main session decides — our TOTP for guest 2FA, **managed keys only** (no AWS KMS), Discovery off by default, self-serve network ranges and policies, IPv4 + IPv6 in the allowlist (`docs/governance.md` §8).

### Round 15 — Studio [ours] — **contract written 2026-10-13** (`docs/studio.md`)

The manager agent (default Claude Code Haiku 5.5) that hands one chat's work to several agents at once, the brand and product library, and social posts / stories with product pictures from Nano Banana (Gemini API, Gemini CLI or Antigravity), reviewed and fixed in a loop. Agents 15a manager, 15b library, 15c images run in parallel; merge order 15b, 15c, 15a (`docs/studio.md` §7).

## Legacy removed (2026-10-06)

As the owner decided, the whole site admin was deleted in the Phase 2 integration round, with no import of the old projects: the DOM editor, the CV, site publishing and the preview tab, the old Home, `lib/` (the site's Firebase) and `demo/`, the sign-in, the site's components and the iframe shell for browsers, and the dependencies only they used (Tailwind, gsap, prismjs, dompurify, tailwind-merge). The site's Firebase data is left untouched (burakkoc.net keeps working with its own web admin). The Firebase SDK stayed for a planned Firebase adapter, replaced by Cloudflare (2026-10-10) and removed from the code 2026-10-11 (the npm dependency can go). A converter for the old projects (`data.md` §11.3) is not planned unless the owner asks.
