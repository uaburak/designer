# R18 — Figma's Enterprise plan, feature by feature, and what each takes for us (researched 2026-10-11)

The owner wants every feature of Figma's Enterprise plan in DesignerV2 (their screenshot of figma.com/pricing's comparison table: Weave tools, Shared fonts, Branching and merging, In-app library analytics, Organization-wide design systems, Multi-brand design systems; sections Figma Make, Figma Motion (Beta)). This page lists **every** row of the pricing page's "Compare all features" table that Enterprise includes, plus the admin and security features documented on help.figma.com, says exactly what Figma does (with the source), what DesignerV2 already has (file paths), what it would take, how big it is, what it depends on, and whether it means anything for a personal app shared with a few friends. The owner still wants all of it: nothing is dropped, the last column only marks it. The build plan is `docs/roadmap.md` "Phase 7 — Enterprise".

Legend:
- **Plans**: S / P / O / E = Starter / Professional / Organization / Enterprise. "E" alone = Enterprise only. **G+** = the Governance+ add-on (Enterprise and Figma for Government only, paid separately — *not* part of base Enterprise; listed so nothing is missed, built last).
- **Ours**: ✅ built · ◐ partial · ✗ absent. Paths are from the repo root.
- **Size** (one agent-round each unless noted): S ≤ 1 day of one agent · M one agent-round · L 2–3 agent-rounds or several agents · XL a phase of its own.
- **Personal**: ★ useful for the owner and friends · ◇ parity only (meaningful for a company, not for a few people; built because the owner wants it) · ○ useful later / with more people.
- **(unverified)** = not stated on an official page we opened; **(3rd party)** = secondary source only.

## Sources

How the facts were gathered (2026-10-11): the pricing page's HTML was downloaded and its comparison table read from the cells' "Included" / "Not included" icons and text, plus the page's embedded data (`featureComparisonV2Lego`), which also holds the Dev-seat and Collab-seat versions of the table; help.figma.com articles were read through WebFetch; recent products from figma.com/blog. The repository was searched for every feature.

- Pricing, "Compare all features" — https://www.figma.com/pricing/
- Plan comparison (Organization vs Enterprise) — https://help.figma.com/hc/en-us/articles/360040328273
- Guide to managing a Figma organization — https://help.figma.com/hc/en-us/articles/360039829474
- Privacy and security in organizations — https://help.figma.com/hc/en-us/articles/360040056294
- Governance+ (Enterprise) — https://help.figma.com/hc/en-us/articles/31825370509591 ; Figma for Government — https://help.figma.com/hc/en-us/articles/22932461365015
- AI credits: how they work — https://help.figma.com/hc/en-us/articles/33459875669015 ; Manage AI credits — https://help.figma.com/hc/en-us/articles/35865276858647 ; AI credit updates FAQ (the "2× / 1.6×" banner) — https://help.figma.com/hc/en-us/articles/42614902212887
- Per-feature articles are cited where each feature is described.

Our own documents this rests on: `docs/multiplayer.md` (accounts, rooms, sharing, comments, previews on Cloudflare), `docs/data.md` (workspace, versions §6, libraries §9), `docs/editor.md`, `docs/engine-build.md`, `docs/home.md`, `schema/document.kiwi` vs Figma's full `docs/research/figma/figma-schema.kiwi`.

## 0. The plan itself (seen on the pricing page)

| | Starter | Professional | Organization | Enterprise |
|---|---|---|---|---|
| Full seat | free | $16/mo (annual) | $55/mo (annual) | $90/mo (annual, "Contact sales") |
| Dev seat | — | $12 | $25 | $35 |
| Collab seat | — | $3 | $5 | $5 |
| AI credits, Full seat | 150/day, ≤ 500/mo | 3,000/mo | 3,500/mo | 4,250/mo |
| AI credits, other seats | 150/day, ≤ 500/mo | 500/mo | 500/mo | 500/mo |
| Card's "why" | — | Unlimited files and projects; team-wide libraries; advanced Dev Mode and MCP | Publish resources across teams; shared libraries and fonts; centralized admin | **Custom team workspaces; design system theming and APIs; SCIM seat management** |

- What a seat opens (pricing FAQ): **Full** = Design, Make, Draw, Sites, Dev Mode, FigJam, Slides, Buzz; **Dev** = Dev Mode, FigJam, Slides, Buzz + view/comment in Design; **Collab** = FigJam, Slides, Buzz + view/comment, basic Dev Mode inspection. Viewers are free on paid plans. Motion beta and Sites beta: Full seats; Buzz beta: all seats.
- Monthly Professional prices are filled in by script; outside sites say $20 / $15 / $5 (3rd party).
- **Add-ons**: "AI credits" (a shared monthly subscription pool and/or pay-as-you-go, admin spending limit; per-billing-group allocation on E; usage history on O/E; AI Usage API on E) and **"Governance+"** ("Only available on Enterprise plan").
- **The banner** in the owner's screenshot: from 2026-08-25 the AI add-ons give "2x more credits on the Professional plan, and 1.6x more credits on the Organization and Enterprise plans" at the same price (help 42614902212887). The live page now shows "New — AI add-ons are now available for all plans." The same FAQ says the **Figma agent and Weave tools became generally available on 2026-10-06** and use credits since.
- **For us** there is no billing: seats become *roles* (who may edit what), credits become a *usage meter* over the owner's own model providers (`src/main/agents/providers`). Seat types still matter as permissions (a "Collab" friend can comment, not edit Design) — see A-6.

The table's sections: Figma Design, Figma Make, Figma Motion (Beta), Figma Draw, Figma Sites (Beta), Dev Mode, FigJam, Figma Slides, Figma Buzz (Beta), Figma agent, Platform, Admin, Extensibility, Security. Every row Enterprise has is below, grouped as the task asks: **Part 1 Figma Design and Dev Mode**, **Part 2 platform, admin and security**, **Part 3 AI**, **Part 4 whole products**.

---

## Part 1 — Figma Design, Dev Mode, extensibility

### 1.1 Figma Design rows that every plan has (S P O E all ✓)

Already ours, listed so the inventory is complete: Components, Figma Editor, Auto layout, Advanced drawing tools (smart selection, vector networks, arc), Styles, Interactive prototypes, Advanced animations (Smart animate, springs), Transitions, Overlays, Video in prototypes (round 6), Responsive prototyping viewer, Inspect in design files, Variables. Two rows are not ours:

| Row | Figma | Ours | Work | Size | Personal |
|---|---|---|---|---|---|
| UI Kits | Figma's own UI kits (iOS, Material, Simple Design System…) offered as libraries in every file | ✗ (`LibrariesDialog.tsx` lists only the workspace's libraries) | Bundle a few kits as read-only libraries in the registry (import their `.fig`s from the Community with the owner's own download; licence permitting) | S | ★ |
| Community templates | Templates from the Figma Community | ✗ | Out of scope as a *community*; a local "Templates" shelf in Home (files marked as template, "Use template" duplicates) covers it — and is also what Slides/Buzz/FigJam custom templates need (Part 4) | S–M | ○ |

### 1.2 Rows from Professional up (– P O E)

| Row | Figma | Ours | Work | Size | Personal |
|---|---|---|---|---|---|
| Annotations (and measurements) | Annotation tool, categories, measurements | ✅ round 6 (`editor/devmode/`, engine annotations) | — | — | ★ |
| Team libraries | Publish a library to a team | ◐ libraries publish to the **local workspace** (`src/store/local/libraries.ts`, `docs/data.md` §9); not to a team on the server, not visible to friends | Libraries on the server (C-1) | L | ★ |
| Multiple actions / Advanced prototyping / Conditional logic / Expressions | Several actions per interaction, variables in prototypes, if/else, expressions | ✅ (E8, round 5; `engine/src/proto/`) | — | — | ★ |
| Prototype sharing permissions | Share a prototype without giving access to the design file (help https://help.figma.com/hc/en-us/articles/360040531773) | ◐ "Copy prototype link" (`m=proto`) exists but opens the file for members only; no prototype-only access | A `prototype_only` access flag on links / members; the room serves the snapshot read-only to the player (`src/viewer` already presents); editor refuses design view | M | ★ |
| Design productivity tools (AI), Image editing (AI), Weave tools | see Part 3 | | | | |

### 1.3 Organization and Enterprise rows (– – O E, and E)

The owner's screenshot rows.

#### D-1 Branching and merging (– – O E)

- **Figma** (https://help.figma.com/hc/en-us/articles/360063144053 , merge https://help.figma.com/hc/en-us/articles/5691189138839): a Full-seat person with view or edit access to a main file chooses **Create branch** in the file-name menu; the branch is a separate copy (designs, prototypes, libraries) linked to its main. When main changes, the branch shows a notice: take **all** updates or postpone (no picking); overlapping edits become conflicts, resolvable then or at merge. **Request review** (description, reviewers, comments; Approve / Request changes). **Review and merge changes** shows each changed layer with a diff; **Resolve conflicts** picks main or branch per item. A merge writes a version-history checkpoint on main and archives the branch (archived merged branches cannot be restored; undo = restore the earlier version). **View branches**: Active / Archived tabs, archive by hand, reopen archived. Viewers can branch only if "viewers can copy" is on; merging is blocked under the memory-limit banner. Library files can be branched; publishing happens from main.
- **Ours**: ◐ stub — File › "Create branch…" makes a plain copy named "‹file› / ‹branch›" (`src/renderer/src/editor/commands.ts` ~731, `objectCommands.ts` ~206); review and merge not built (`docs/editor.md` round-10 table). Figma's schema has `pasteBranchSourceFileKey` and a `BRANCHING` enum value (`docs/research/figma/figma-schema.kiwi` ~3723, ~3765); ours has neither.
- **Work**:
  - **Model**: a branch is a file with `{mainFileKey, branchPointSeq, branchPointVersionId, status: active|archived|merged}`; the branch point is a version of main (the store already keeps snapshots per version, `src/store/local/versions.ts`).
  - **Three-way diff** over our own change format: base = main at the branch point, ours = branch head, theirs = main head. GUIDs are stable across the copy (no remapping, as `createSharedFile` already does), so diff is per (GUID, field): `files.restoreDiff` (data.md §6) already computes a version→head NODE_CHANGES diff — generalize it to `diff(a, b)` and run it twice. A conflict = the same (GUID, field) changed on both sides to different values, or a node deleted on one side and edited on the other. Figma presents conflicts per *layer* (top-level frame / component), so group by top-level ancestor.
  - **Merge** = one NODE_CHANGES batch applied to main as a SYSTEM-labelled undoable step + a version entry `kind: "merge"` ("Merged ‹branch›"); "Update from main" = the reverse into the branch.
  - **Engine**: nothing new to apply (APPLY_EXACT exists); a *diff viewer* for the review — Compare changes (round 6, `editor/devmode/CompareChanges.tsx`: Side by side / Overlay / Compare properties) already does a two-document comparison: reuse it for each changed layer.
  - **Store / server**: local branches in the workspace; for shared files a branch is its own room linked to the main room; review requests and reviewers in D1; activity-log events (Branches group).
  - **UI**: file-name menu items (Create branch, View branches, Review and merge changes, Request review), the branch banner in the header ("Branch of ‹main›"), the merge modal with its change list and conflict resolver, Home's branch icon on file cards.
- **Size**: L–XL (the diff/merge core L, UI M, server M). **Deps**: version snapshots ✅; Compare changes ✅; for shared branches the org/team model (A-1). **Personal**: ★ (the owner experimenting on a library without breaking friends' files is exactly its use).

#### C-1 Libraries on the server (needed by Team libraries, D-3, D-4, Buzz/Slides templates)

- **Figma**: a library is published from a file in a team project to that team (P) or the org (O E); every member of the scope sees it in the Libraries modal and gets update notices; payloads are served by Figma, not copied between users' disks.
- **Ours**: the library registry and asset payloads live in the local workspace (`libraries/<lib>/…`, `src/store/local/libraries.ts`, `docs/data.md` §9.2) behind the `libraries` repository; friends who open a shared file that uses the owner's library get the copies already inside the file (consumers keep read-only copies, §9.4) but cannot enable the library themselves or receive updates. `docs/multiplayer.md` never mentions libraries.
- **Work**: a server-backed `libraries` repository for org spaces (same interfaces: `previewPublish`, `publish`, `list`, `getVersion`, `getPayloads`): D1 `libraries`, `library_versions`, payloads and thumbnails as blobs (a `LibraryObject` Durable Object per library, 1 MB chunks, as previews do — `server/src/previewObject.ts` is the template); scope (team / org / workspace) and subscriptions (which files enable which library — D1 `library_subscriptions`) so update badges reach consumers via the room's notice channel; Publish from a shared file publishes to its team.
- **Size**: L. **Deps**: A-1. **Personal**: ★ (the owner's design system, used by friends' files).

#### D-2 Shared fonts (– – O E)

- **Figma** (https://help.figma.com/hc/en-us/articles/360039956774): org admins upload .TTF/.OTF (no web fonts) in Admin › Resources › Fonts; team admins upload team fonts (team menu › View settings › View team's fonts). On a duplicate family name: Skip or Replace. The uploader confirms they hold the licence. Every editor in the org gets them in the font picker, without installing; they aren't served to people outside the org.
- **Ours**: ✗ — system fonts (`src/main/fonts.ts`, fonts utility process) and the Google Fonts catalog downloaded on first use (`src/main/googleFonts.ts`, docs/desktop.md §14.1); nothing uploaded or shared. Friends opening the owner's file with a font they don't have see it as missing (Missing fonts dialog exists).
- **Work**: server: font blobs per org/team (a Durable Object or R2 bucket — the free plan's R2 10 GB is plenty; rooms already store blobs in SQLite chunks), D1 `fonts(org_id, team_id, family, style, sha1, uploaded_by)`, routes list / upload / delete gated by role; main: a third font source next to system and Google in the font list and the byte provider (same cache folder as Google fonts, `fonts:changed` event); font picker: an "Organization fonts" / "Team fonts" filter (Figma's picker has "Shared fonts" — check live wording before building); Admin › Resources › Fonts UI.
- **Size**: M. **Deps**: org/team model (A-1), Admin app (A-4). **Personal**: ★ (friends get the owner's licensed fonts in shared files).

#### D-3 In-app library analytics (– – O E) and the Library Analytics API (E)

- **Figma** (https://help.figma.com/hc/en-us/articles/360039238353 ; API https://developers.figma.com/docs/rest-api/library-analytics-intro): an org-wide view (file browser › Libraries: totals of teams, libraries, components, styles, variables) and per library (file-name menu › **Library analytics**): **Overview** tab (teams using it, insertions, detaches over time, compare two libraries) and **Analytics** tab (Type: components / styles / variables; per asset: instances, inserts, detaches, drill down to teams and files; variables have a Modes tab). Ranges 30 / 60 / 90 days / 1 year, updated daily, CSV export above 5 teams. Drafts of other users and nested instances aren't counted. Guests can't see it. API (E): scope `library_analytics:read`, action and usage data per library.
- **Ours**: ✗ — the registry knows counts per library and per-version change lists (`src/store/local/libraries.ts`), nothing about use.
- **Work**: *events* — the engine already knows when an instance of a library component is inserted (Assets drag, paste, swap), detached (`DETACH`), a style/variable applied/bound/unbound; emit `libraryUsage {assetKey, kind: insert|detach|apply|unbind, fileKey}` from the editor's commands to the store; the store batches them into the server (`POST /analytics/events`, D1 table rolled up daily by a Cron Trigger into `library_usage_daily`); *usage snapshot* — instance counts per asset per file, computed by the store when a file is saved (scan for `symbolData.symbolID` with a library key) — or from the engine's asset index (`componentInfo`), uploaded per file; UI: the Library analytics modal (charts as plain SVG components in ds, with the `--figma-color-*` tokens), org-level Libraries page in Home; API route.
- **Size**: L. **Deps**: server-side libraries (C-1), org model (A-1), REST API (E-1) for the API. **Personal**: ◇ (a handful of files: the numbers will be tiny, but they work).

#### D-4 Organization-wide design systems (– – O E), Approved libraries (– – O E), Default libraries by workspace (E)

- **Figma** (https://help.figma.com/hc/en-us/articles/21310245473815 , https://help.figma.com/hc/en-us/articles/360052679454): libraries published to the whole org (all teams) rather than one team; admins **Approve** a library (a check mark, pinned at the top of library lists) and **Enable by default** — separately for Design, FigJam, Slides and Buzz files; enabling by default at org level publishes it to the org. Team admins enable libraries for their teams. **E**: workspace-level default libraries and default variable modes; admins can mark skills, templates, libraries and Make kits "Recommended".
- **Ours**: ◐ one workspace-wide list `Workspace.defaultLibraries` (`src/shared/store/types.ts`), local only; no approval, no scopes.
- **Work**: library scope on the server (team / org / workspace), approval and default flags per scope and per editor type, the Libraries modal's sections ("Approved", "This organization", "‹team›"), default variable modes per workspace (applied when a library collection is first used in a file of that workspace).
- **Size**: M (after C-1). **Deps**: C-1, A-1. **Personal**: ○.

#### D-5 Multi-brand design systems — extended collections (E) and Variable modes "Unlimited (via extended collections)" (E; P 10, O 20)

- **Figma** (https://help.figma.com/hc/en-us/articles/36346281624471): right-click a collection › **Extend collection**; the extension inherits all modes and variables (names, settings, order) and keeps receiving the parent's changes for values it hasn't overridden; only **values** can be overridden (blue cells, **Reset change**; colour and opacity override together); no new variables or modes, no renames, descriptions or scopes in an extension. Library collections can be extended (Plugin API `extendLibraryCollectionByKeyAsync`, Update 121, 2025-11-20; non-Enterprise plans throw "Cannot create extended collections outside of enterprise plan"). Migration from per-brand modes: export each brand mode as JSON, delete it, extend the parent per brand, **Import mode** into each extension (on main, not a branch); consumers re-apply modes after publishing.
- **Ours**: ✅ round 5 — Extend collection, `VARIABLE_OVERRIDE = 35`, overrides per mode, modes following the parent, publish / consume / local extensions of library collections, blue overrides and "Reset change" in the Local variables window (`src/renderer/src/editor/variables.ts`, `docs/schema.md` §6.2–6.6; handoff "Round 5 — variables and components"). Mode limit: `LIMITS.modes = 40` per collection (`editor/model/variables.ts` ~398) — Figma's Enterprise says unlimited.
- **Work**: verify against the article's restrictions list (no add/rename in an extension — check each menu disables), the migration path (Import mode into an extension — DTCG import exists, `variablesIO.ts`), lift the 40-mode limit to "unlimited" as Enterprise (keep a soft cap for performance), plan gates none (we are "Enterprise").
- **Size**: S. **Deps**: none. **Personal**: ★ (already used).

### 1.4 Dev Mode rows

| Row (plans) | Figma | Ours | Work | Size | Personal |
|---|---|---|---|---|---|
| View annotations and measurements (– P O E) | | ✅ round 6 | — | — | ★ |
| Code Connect (– "UI kits only" O E) | Map published components to code (CLI in the repo, or **Code Connect UI**: library in Dev Mode › file-name menu › connect components to code, file paths, GitHub for autocomplete); mappings feed Dev Mode snippets and the MCP server — https://help.figma.com/hc/en-us/articles/23920389749655 , https://developers.figma.com/docs/code-connect | ✗ | Store mappings per library asset (`codeConnect {path, snippet template, props map}` on the library record, or Figma's `@figma/code-connect` files parsed); Dev Mode's code panel shows the mapped snippet with the instance's props substituted; Code Connect UI in Dev Mode; MCP `get_code_connect_map`; a small CLI `scripts/code-connect.mjs` that parses `*.figma.tsx` and publishes through the REST API | L | ★ (the owner's dev friends) |
| Advanced inspection (– P O E) | Units, copy properties | ✅ (viewer + Dev Mode; rem/pt/dp/sp) | — | — | ★ |
| Improved handoff (– "Ready for dev on canvas only" O E) | Ready-for-dev **feed** (a list of every frame marked ready across the file), focus view, statuses, **notifications** of changes | ◐ statuses, focus view, "Changed" (round 6); no feed, no notifications | Ready-for-dev view (left panel in Dev Mode listing ready frames, filters by page, status, date); notifications need the notification inbox (A-7, "Notification inbox") | M | ★ |
| Compare changes (– P O E) | | ✅ round 6 | — | — | ★ |
| Component playground (– P O E) | In Dev Mode, an instance's properties can be tried (variant / boolean / text / instance swap) without editing the file | ✗ | Dev Mode inspector: a playground card rendering a scratch instance in an offscreen engine page (viewer engine already runs read-only; a temporary instance in a sandbox page not journaled) | M | ★ |
| Dev resources (– P O E) | Links (Storybook, GitHub, Jira…) attached to nodes, shown in Dev Mode | ✗ (Figma stores them outside the document: REST `dev_resources`) | Server table `dev_resources(file_key, node_id, name, url)` (local files: store JSON next to comments), Dev Mode section "Dev resources" + "+ Add" | S–M | ★ |
| Asset export (– P O E) | | ✅ (E7, viewer) | — | — | ★ |
| Plugins (– "Community only" O E) | Dev Mode plugins | ✗ — see E-2 | | | |
| VS Code extension (– P O E) | Figma for VS Code: browse files, inspect, comments, Code Connect in the editor | ✗ | A VS Code extension (webview loading `src/viewer` against the REST API / the local MCP) — separate package `tools/vscode/` | L | ○ |

### 1.5 Extensibility rows

| Row (plans) | Figma | Ours | Work | Size | Personal |
|---|---|---|---|---|---|
| REST APIs (S P O E; rate limits by seat/plan) | `api.figma.com/v1`: files, nodes, images (render), comments, users, versions, projects, components/styles (published), webhooks, dev resources | ✗ public API; the Worker has a private JSON API only (`server/src/api.ts`) | E-1 below | L | ★ |
| Plugins and widgets (S P O E) | Plugin API (sandboxed JS + iframe UI), widgets (FigJam / Design) | ✗ by design so far: menu items disabled (`commands.ts` ~733), Actions panel says "Plugins and widgets aren't part of this app" (`panels/ActionsPanel.tsx`) | E-2 below | XL | ○ |
| Third-party integrations (S P O E) | Slack, Notion, Jira, Google Workspace, Microsoft Teams | ✗ | Link unfurling needs public pages (`/f/<key>` exists; add Open Graph tags + thumbnails); a Slack app for comment notifications is optional | M | ○ |
| Live embeds (S P O E) | Embeds | ✅ (`/embed/<key>`, multiplayer.md §8) | — | — | ★ |
| Featured MCP connectors (S P O E) / Custom MCP connectors (– P O E) | MCP servers usable by the Figma agent and Make (Notion, Slack, GitHub, Atlassian…) | ◐ our agents are the CLIs (Claude Code, Codex…) which have their own MCP config; our app *is* an MCP server (`src/main/agents/mcpServer.ts`), not a client | An MCP client list in Agent settings passed through to the providers (each CLI's `--mcp-config` / config file) | S–M | ★ |
| Figma MCP server (S 20 calls/mo … E 600/day, 20/min) | Remote `https://mcp.figma.com/mcp` (write to canvas) and the desktop server | ✅ local Streamable HTTP server with write tools (`src/main/agents/mcpServer.ts`, `src/shared/agents/tools.ts`; R12) — no remote one | A remote MCP endpoint on the Worker for shared files (tools read the room's snapshot; writes as a room session) | M | ○ |
| Webhooks (– P O E) | Webhooks V2: FILE_UPDATE, FILE_VERSION_UPDATE, FILE_DELETE, LIBRARY_PUBLISH, FILE_COMMENT, DEV_MODE_STATUS_UPDATE, per team/project/file | ✗ | D1 `webhooks`, a Queue/`ctx.waitUntil` sender with HMAC signature and retries, events raised by the room/API | M | ○ |
| Private plugins and widgets; Plugin management (– – O E) | see E-2, B-7 | ✗ | | | ◇ |
| REST API with Dev Mode, REST API for variables, Library Analytics API, AI Usage Analytics API, Activity logs API, Plugin and widget analytics (E) | Enterprise-only endpoints | ✗ | E-1 (variables GET/POST `/v1/files/:key/variables/local|published`, dev resources, library analytics, activity logs, AI usage) | M each, after E-1 | ◇ |

#### E-1 A public REST API

- **Figma**: `https://api.figma.com/v1/…`, personal access tokens and OAuth apps with scopes (`file_content:read`, `file_variables:read|write`, `library_analytics:read`, `org:activity_log_read`, …); JSON documents of the file (Figma's REST node shape, which our agents' `nodeSpec.ts` already mirrors), image renders, comments (our comments already use Figma's REST `Comment` shape, `src/shared/comments.ts`).
- **Ours**: ✗. The pieces exist: the room's snapshot (kiwi) on the server, the viewer's engine that can render it, the comments routes.
- **Work**: `server/src/rest/` — tokens (D1 `api_tokens`, scopes, expiry; UI in account settings), `GET /v1/files/:key` (kiwi → Figma's REST JSON: decode in the Worker with the generated TS codec `src/shared/schema` — needs derived geometry for absolute boxes: the snapshot carries derived data when the client uploaded one with `derived: true`), `GET /v1/images/:key` (renders need the engine: run `engine.wasm` headless in a Worker is possible in principle — Wasm + no WebGL: our PNG export uses the GL path; *risk*: a CPU raster path or rendering on a client and caching; first version: return the stored thumbnails / ask an online editor of the file to render), comments, versions, variables (local/published), webhooks.
- **Size**: L (+ M per Enterprise endpoint group). **Deps**: files on the server (A-1). **Personal**: ★ for the dev friends.

#### E-2 Plugins and widgets (and private ones, plugin management)

- **Figma**: the Plugin API (`figma.*`) runs plugin code in a sandboxed JS realm on the main thread with access to the document, and its UI in an iframe that talks by `postMessage`; manifests, network access declarations, permissions; widgets are synced-state components (FigJam mostly). Private org plugins (O E): any member publishes internally without review; Plugin management (O E, https://help.figma.com/hc/en-us/articles/4404228724759): "Only admin-approved plugins/widgets", requests, "Try it out", per-workspace approval (E), Usage tab.
- **Ours**: ✗. Our agent tools already speak the Plugin API's property names (`editor/agents/nodeSpec.ts`), and `engine_*` exposes every edit.
- **Work**: a plugin host in the editor view: a QuickJS-in-Wasm realm (as Figma's original approach) or a sandboxed iframe with a synchronous-looking API over our flat engine API; implement `figma.*` incrementally (nodes, properties, `createX`, selection, viewport, `ui.postMessage`, `clientStorage` via store, `notify`); manifest loading from a folder (development plugins: Plugins › Development › Import plugin from manifest…, as Figma); the Actions panel's Plugins tab; private plugins = a server registry (D1 + blobs) scoped to the org; management settings. Running *Community* plugins requires their code: allowed for plugins the owner downloads/develops locally; no Community store.
- **Size**: XL (the API surface is large; the realm is M). **Deps**: E-1 optional; org model for private/managed. **Personal**: ○ (great for the owner's own automation, but the in-app agents already cover much of it).

---

## Part 2 — Platform, admin and security

### 2.1 What every Enterprise admin feature stands on: the organization

Every admin row assumes Figma's content model, which we don't have yet: an **organization** owns **workspaces** (E) which group **teams**; a team has **projects** (folders) of **files**; each person has **drafts**; **the org owns everything, drafts included** (centralized content management, O E: files survive a member's removal; drafts of removed members go to a folder admins reassign — https://help.figma.com/hc/en-us/articles/4420549259799). Members are on the org's domains; **guests** are everyone else, invited to specific resources only (https://help.figma.com/hc/en-us/articles/4420557314967). Seats (Full / Dev / Collab / View) decide what each person may do.

Ours today (`src/shared/store/types.ts`, `docs/data.md` §2–4, `docs/home.md`, `docs/multiplayer.md` §3): one local **workspace** (Drafts, nested folders, Recents, Starred, Trash; `teamName` "‹Owner›'s team"); a file becomes *shared* per file (D1 `files`, `members` owner/editor/viewer, link access, password, transfer); "Shared files" in Home. No orgs, teams, projects on the server, no team membership, no seats.

#### A-1 Organization, workspaces, teams, projects on the server (the foundation)

- **Figma rows**: Unlimited teams (– – O E), Custom workspaces (E), Centralized administration (– – O E), Centralized content management (– – O E), Workspace administration (E), Team creation controls (E: "Anyone" / "Admins only", https://help.figma.com/hc/en-us/articles/10386065399319), Default teams (E: people land in their workspace's default teams), Private folders (– P O E), Team and project transfer (– P O E), user groups (O E, https://help.figma.com/hc/en-us/articles/38020006913943 — share to a group, @mention a group).
- **Work**:
  - **Server (D1)**: `orgs`, `org_members (org, user, role: admin|member|guest, seat: full|dev|collab|view, billing_group?, workspace?)`, `workspaces`, `teams (org, workspace, name, visibility)`, `team_members (role: owner|admin|editor|viewer)`, `projects (team, name, private)`, `project_members`, `user_groups`, files gain `project_id` and `org_id`; permission resolution = max(file member, project member, team member, org admin) with Figma's rules (help "File and folder permissions" https://help.figma.com/hc/en-us/articles/35361119554711). Migrations from 0008.
  - **Content ownership**: a file created in a team project lives on the server from birth (a room), not local-first-then-shared — so a cloud file is the norm in teams and a local file the norm in "Local drafts" (keep today's behaviour as the owner's offline space). This is the **biggest architectural change** of the phase: today the workspace on disk is the source of truth and sharing is per file (data.md §0). Proposal: the store keeps two *spaces* behind the same repositories — `local` (as now) and `org:<id>` (server-backed: listing from the API, files as rooms with a local cache = today's shared-file copy). Home switches between them as Figma switches teams/orgs.
  - **Store**: `teams`, `projects` repositories (`src/shared/store/repositories.ts`), cached for offline; moving a local file into a team project = share it into that project (exists: `POST /files` + snapshot upload).
  - **Home**: Figma's file browser for orgs — the org switcher (account menu), sidebar Teams with their projects, "Drafts" per person, team pages (Projects / Members tabs), project pages, Move to project across spaces, team creation, transfer.
- **Size**: XL (server L, store L, Home L). **Deps**: accounts ✅. **Personal**: ★ — the owner's "team" with friends as members is the natural shape for shared work; workspaces/billing groups ◇.

#### A-2 Roles and seats

- **Figma**: seat types Full / Dev / Collab / View (https://help.figma.com/hc/en-us/articles/360039960434), upgrade requests and their approval settings per seat type ("Manually approve seats" / "Manually approve, unless seat is available" (default) / "Auto-approve seats"; https://help.figma.com/hc/en-us/articles/4414038570007), Dashboard of requests; roles org admin, workspace admin (E), billing group admin (E), team admin (https://help.figma.com/hc/en-us/articles/4420557724439).
- **Ours**: per-file owner/editor/viewer; "Ask to edit" (access requests, migration 0004) is the per-file analogue.
- **Work**: seat on `org_members`; enforcement — a View/Collab seat cannot edit Design files even when invited "can edit" (the server's role resolution caps by seat; the editor opens read-only with the banner that exists); Dev seat: Dev Mode only in Design files; upgrade request flow (reuse access_requests); billing groups (E, https://help.figma.com/hc/en-us/articles/19100486415255) as a grouping with no money.
- **Size**: M. **Deps**: A-1. **Personal**: ◇ (friends get Full or Collab; no money).

#### A-3 Admin app (Admin in the file browser)

- **Figma**: sidebar "Admin" with tabs Dashboard, People (+ User groups), Teams, Workspaces (E), Billing groups (E), Resources (libraries, fonts, plugins, templates…), Activity, Settings (Login and provisioning, External/Guest access, Content › Sharing and publishing, Team management, Extensions, Resources, AI, Data storage localization, Other), Billing. People tab (https://help.figma.com/hc/en-us/articles/4420842863255): name, email, seat, AI-credit access, billing group, last active, SCIM metadata; filters; bulk actions; CSV export.
- **Ours**: ✗ (`StoreAdmin` in `src/store/localStore.ts` is store maintenance; the editor's "Account settings" / "Permissions" are disabled, docs/editor.md).
- **Work**: a new Home location `admin` rendered by `src/renderer/src/admin/` (its own folder, ds components; tables, filters, CSV export through main's Save dialog), against `server/src/admin/*` routes. Billing tab: plan "Enterprise", seats counted, no payment.
- **Size**: L. **Deps**: A-1, A-2. **Personal**: ◇ (but it's where every setting below lives).

#### A-4 Activity logs (– – O E) and the Activity Logs API (E)

- **Figma** (https://help.figma.com/hc/en-us/articles/360040449533 ; API https://developers.figma.com/docs/rest-api/activity-logs , action types https://developers.figma.com/docs/rest-api/activity-logs-action-types/): Admin › Activity, filters (member email, date range, event type, team), CSV; event groups Members, Files, Branches, Sites and web apps, Projects, Teams, Organizations, Seat changes, External access, Workspaces, Billing groups, SCIM groups, Libraries, Users, Community, Plugins, Widgets, SSO, Authentications, Audio, Integrations, Webhooks, Domain management, GitHub; not retroactive. API `GET /v1/activity_logs`, scope `org:activity_log_read`, events {actor, entity, action, context (org, IP)} — e.g. `fig_file_view`, `fig_file_export`, `fig_file_link_access_change`, `fig_file_set_password`, `user_sign_in`, `user_idle_session_timeout`, `org_domain_add`, `plugin_approvelist_add`, `org_library_approve` (names as summarized by the fetch tool — spot-check before use). Retention one year (forum only, unverified).
- **Ours**: ✗ (no audit table; versions and `members.invited_by` are the nearest).
- **Work**: D1 `activity_log(id, org, at, actor, ip, action, entity_type, entity_id, context json)`; one `logActivity()` call in every mutating route (auth, files, members, link settings, previews, comments delete, admin settings) and in the room for file views/exports (the client reports exports: the server can't see a local export — mark them client-reported); Admin › Activity UI; API route; retention cron.
- **Size**: M. **Deps**: A-1 for org scoping (the table can start per-user before that). **Personal**: ◇ (it is also a nice "who opened my file" for the owner — ○).

#### A-5 Security rows (– – O E)

| Row | Figma | Ours | Work | Size | Personal |
|---|---|---|---|---|---|
| **SSO (SAML, enforce SSO, SCIM provisioning)** | Admin › Settings › Login and provisioning › Authentication: "Any method" (default: Google, SAML, email/password) / "Google account required" / "SAML SSO required"; SAML with Okta, OneLogin, Entra ID, Google Workspace or custom, JIT provisioning, a Tenant ID; guests can't use SAML (https://help.figma.com/hc/en-us/articles/360052497994 , https://help.figma.com/hc/en-us/articles/360040532333 , Google SSO https://help.figma.com/hc/en-us/articles/360040047614) | ◐ Google OAuth only, on the Worker (`server/src/google.ts`, multiplayer.md §2) | SAML SP on the Worker: `/saml/:tenant/login` (AuthnRequest, HTTP-Redirect), `/saml/:tenant/acs` (POST binding: parse the Response, verify the XML signature — exclusive C14N + RSA-SHA256 with WebCrypto, check Audience, Destination, NotOnOrAfter, InResponseTo; replay cache in D1), metadata XML, IdP config per org (entity id, SSO URL, certificate); then the same loopback/PKCE hand-off to the app as Google. **Risk**: XML signature verification in Workers (no DOM; needs a pure-JS XML parser + C14N; Node SAML libraries rely on `xml-crypto`/`node:crypto` — check `nodejs_compat`), and signature-wrapping attacks — use a vetted library, test against a real IdP (Okta developer org, Google Workspace SAML app, or a local Keycloak). Enforcement setting per org | L | ◇ |
| SCIM provisioning (O E) and **Role assignment via SCIM** (E) | SCIM 2.0 at `https://www.figma.com/scim/v2/<tenantID>`, a bearer token from Settings, push create/update/deactivate, attributes givenName, familyName, displayName, title + enterprise (employeeNumber, costCenter, organization, division, department, manager); deactivation removes from the org; seat types via SCIM (E, needs SAML+SCIM; bypasses approval) — https://help.figma.com/hc/en-us/articles/360048514653 , https://help.figma.com/hc/en-us/articles/360048787534 , groups https://help.figma.com/hc/en-us/articles/38020006913943 , API https://developers.figma.com/docs/rest-api/scim | ✗ | `server/src/scim/`: `/scim/v2/:tenant/Users` and `/Groups` (RFC 7643/7644: list with `filter=userName eq`, get, POST, PUT, PATCH ops, DELETE→deactivate), ServiceProviderConfig, Schemas, ResourceTypes; seat as a custom extension attribute (Figma's exact attribute name unverified — pick ours, document it); token per org (per IdP with G+) | M | ◇ |
| **Domain capture** | Add domains, verify by DNS TXT, each subdomain separately; with capture, sign-ups and existing accounts on the domain join the org; "Manage domain" lists outside accounts (https://help.figma.com/hc/en-us/articles/360045953273 , https://help.figma.com/hc/en-us/articles/27503664218391) | ✗ | D1 `org_domains(domain, token, verified_at)`; verification through DNS-over-HTTPS (`cloudflare-dns.com/dns-query?type=TXT`) from the Worker; on sign-in (Google `hd`/email domain) auto-join | S–M | ◇ (the owner has no domain of their own for friends' Gmail accounts — meaningful only with a custom domain) |
| **Activity logs** | A-4 | | | | |
| **Link access controls** | Admin › Settings › Content › Sharing and publishing: disable public links (files, prototypes, boards → org or invited only), disable FigJam open sessions; default per-file link "Anyone at organization with link, can view" (https://help.figma.com/hc/en-us/articles/5726756336791) | ◐ per-file link access none/viewer/editor + password (migrations 0003, 0005) | Org setting checked by `/files/:key` link resolution and the Share dialog (options hidden); link audience "Anyone at ‹org›" | S | ◇ |
| **Plugin and widget management** | see E-2 | ✗ | | M | ◇ |
| Password protection (– P O E) | Files and open sessions (https://help.figma.com/hc/en-us/articles/5726720100247) | ✅ files (multiplayer.md §8); open sessions with FigJam | — | — | ★ |

#### A-6 Security rows (E only)

| Row | Figma | Ours | Work | Size | Personal |
|---|---|---|---|---|---|
| **Guest access controls** | Admin › Settings › Access › Guest access › Guest membership: **Allow** (default; a confirmation before inviting outside emails) / **Require admin approval** (first invite only; to the workspace admin or org admin) / **Block** (https://help.figma.com/hc/en-us/articles/4410793238167 , requests https://help.figma.com/hc/en-us/articles/4420542281495) | ✗ (no member/guest distinction) | `org_members.role = guest`; the invite route checks the org policy, queues approvals (reuse access_requests), refuses when blocked; Share dialog confirmation | S–M | ◇ (friends are guests in the owner's org — ○) |
| **Password protection required** | Removes "Anyone with the link" without a password; applies to published Sites and Make apps; option "Autogenerated passwords only" (four random words) | ◐ passwords exist (Generate = four words, as Figma) | Org setting enforced in `PUT link settings` and the dialog | S | ◇ |
| **External content controls** | Settings › Content › Content access › Access to external content: needs domain capture; restricted members cannot create files outside the org, edit their own outside files, edit or comment on outside files shared with them, or accept outside invites; links and open sessions become view-only (https://help.figma.com/hc/en-us/articles/12080587805719) | ✗ | Role resolution caps a member's role on files of *other* orgs to viewer when their org restricts; the app hides "create" in other spaces | S–M | ◇ |
| **Idle session timeout** | Default 21 days of inactivity; custom 12 h – 14 d (G+: down to 15 min); members only; logs out on every platform; a stay-logged-in prompt in the last minute; shortest wins across orgs; changing resets counters; logged (https://help.figma.com/hc/en-us/articles/14376092335127) | ✗ (30-day session tokens, `tv` version; `POST /auth/signout-everywhere` exists, no client calls it) | `sessions` table (id, user, device, last_active_at, ip, user agent) — tokens carry a session id; the app pings activity (input events throttled to 1/min); the Worker refuses a session idle past the org's limit; the app shows the one-minute prompt; also gives a "Sessions" list in account settings with Sign out everywhere | M | ◇ (sign-out-everywhere UI ★) |
| **Expiring public links** | "Require design-file links to expire": a maximum 1 h – 31 d, expired links revert to private; also disables public links in FigJam | ✗ (previews expire; files don't) | `files.link_expires_at`; the dialog's expiry picker; refused after expiry; org maximum | S | ★ (useful for previews to friends) |
| **Localized file hosting (EU)** | Regions EU, Australia, India, Brazil (US, Japan, Canada listed); file content at rest (shapes, frames, components, images, video) in Design, FigJam, Slides, Draw, Buzz, Make; not comments, names, fonts, thumbnails…; via Support (https://help.figma.com/hc/en-us/articles/15643274574871) | ◐ D1 is in EEUR (`docs/multiplayer.md` §7); Durable Objects placed near first use | Cloudflare **Durable Objects jurisdictions** (`namespace.jurisdiction("eu")`) for an org's rooms and previews; D1 has location hints / jurisdiction (verify current D1 jurisdiction support before relying on it); an org setting "Data storage localization" read-only as Figma | S–M | ◇ |
| Disable cursor chat (E) / enable-disable audio (O E) | Org switches (https://help.figma.com/hc/en-us/articles/14564080039447 , https://help.figma.com/hc/en-us/articles/4420953557399) | ✗ switch (both features ✅) | Org settings delivered with the room's `welcome`; the editor hides the features | S | ◇ |
| Inspect panel administration (E, Admin row) | Admin control over what the Inspect panel shows to viewers (exact options unverified) | ✗ | After reading the live Admin settings; likely toggles for code/inspect for view-only people | S | ◇ |
| Microsoft MSI installer (E) | MSI for managed Windows deployment (https://help.figma.com/hc/en-us/articles/14172933259287) | ◐ NSIS + zip (`npm run dist:win`, desktop.md §12.4) | electron-builder `msi` target | S | ◇ |
| Desktop deployment keys (any plan) | macOS plist / Windows registry: `DisableUpdater`, `AllowedOriginHosts`, `ProxyUrl` (https://help.figma.com/hc/en-us/articles/17719332934167) | ✗ | Read them in main at start | S | ◇ |

#### A-7 Platform rows (S P O E and – P O E) not yet covered

| Row | Figma | Ours | Work | Size | Personal |
|---|---|---|---|---|---|
| Multiplayer, Unlimited viewers, Comments, Spotlight, Observation mode, Shareable links, Cursor chat, Audio conversations | | ✅ (multiplayer.md §4–§11; audio without a TURN relay) | TURN relay (Cloudflare Calls/Realtime TURN) for strict NATs | S | ★ |
| Exports (PNG, JPG, PDF, **CSV**) | CSV = FigJam tables / Slides? (CSV export is from FigJam tables and Buzz bulk data; unverified which) | ✅ PNG/JPG/SVG/PDF (E7) | CSV comes with FigJam tables (Part 4) | S | ○ |
| Unlimited file storage | | ✅ local; server on the free plan's limits (multiplayer.md §1) | Watch D1 5 GB / DO storage | — | ★ |
| File import (.sketch, PNG, JPG) | | ◐ `.fig` and images; no `.sketch` | A Sketch importer (`.sketch` = zip of JSON pages + images → NODE_CHANGES; `src/store/import/sketch.ts`) | M | ○ |
| **Version history** (S: 30 days; P O E: unlimited; checkpoints every 30 min — https://help.figma.com/hc/en-us/articles/360038006754) | | ◐ local files: named/restore/publish/import kept forever, autosaves thinned after 30 days (data.md §6) — Figma's paid plans keep the full history; **shared files have no server-side history** (the room keeps a snapshot + ~5,000 frames, multiplayer.md §6) | (1) drop the thinning for "unlimited" (keep a size budget setting) — S; (2) server versions for room files: the room writes a version snapshot every 30 minutes of edits and on name/publish/merge (`versions` table + chunks in the DO), Version history reads it — M | M | ★ |
| Private folders (– P O E) | A project only its members see | ✗ (folders are local) | `projects.private` (A-1) | S | ○ |
| Team and project transfer (– P O E) | Move a team or project to another org/team | ◐ file transfer of ownership ✅ | Routes after A-1 | S | ◇ |
| Notification inbox (all plans; implied by "Improved handoff", comments) | Bell with comment/mention/ready-for-dev/library update notifications, email | ✗ (multiplayer.md §10 "Not built: notifications") | `notifications` table, the room's notice, Home's bell, optional email (Cloudflare Email Workers send-only, or none) | M | ★ |

#### A-8 Governance+ (add-on; Enterprise or Figma for Government; https://help.figma.com/hc/en-us/articles/31825370509591)

Not part of base Enterprise; listed so the inventory is whole; built last, all ◇:

- **Multiple identity providers** — each domain → one IdP, an IdP serves several domains, SCIM token per IdP. (S after SAML)
- **Enforced 2FA for guests** — "2FA for Guests" toggle, count of guests who would be blocked, "Blocked" badge, `2FA_enabled` CSV column. Needs our own 2FA (TOTP) for email accounts — we have Google only, so: rely on Google's 2-Step and read it? (Google's ID token has no 2FA claim — `amr` is not given for consumer accounts: unverifiable) → TOTP on our side. (M)
- **Guest access expiration** — default duration in days for new guests, per-guest/bulk, banner 2 weeks before, automatic removal. (S)
- **Network access restrictions** (block non-org accounts on the corporate network, by IP ranges; via Support) and **IP allowlist** (members only; IPv4 + CIDR, no IPv6; admins and guests exempt). Worker sees `CF-Connecting-IP`. (S each)
- **Org-wide file exporting restriction** — "Allow exporting by all viewers" / "Prevent exporting by guest viewers" / "Prevent exporting for all viewers"; editors still export. Today `viewers_can_copy` is stored but **not enforced** anywhere (`server/src/api.ts` ~161, ShareDialog) — enforcing it is a P-plan fix (help https://help.figma.com/hc/en-us/articles/360040045574: blocks copy, duplicate, export, Save local copy for viewers) and comes first (S).
- **Enterprise Key Management** — customer AWS KMS key encrypts file checkpoints and uploaded media. Ours: envelope encryption of DO-stored snapshots/blobs with a key from the org's KMS — or Cloudflare's own? (L, ◇◇)
- **Discovery API** (eDiscovery: text in files, comments, cursor chat, AI prompts; hourly JSON, 30 days) and **Developer Logs API** (REST/MCP call logs). (M)
- **Extended idle timeout** (down to 15 min), **Internal policies** (a modal people must accept), **Figma Support visibility** toggle, **AI hosting controls**. (S each; Support visibility meaningless for us)

---

## Part 3 — AI

Figma's AI (help "AI tools" https://help.figma.com/hc/en-us/articles/23870272542231). Ours: the **Agents** tab (round 13–17): chats run the owner's CLI agents (Claude Code, Codex, Cursor, Antigravity) through `src/main/agents/` against our MCP tools; image generation through Antigravity's `generate_image` + `place_image`; per-chat actors with their own undo (round 17). Figma's model providers and credits do not apply: we map each Figma AI feature to a prompt + tools run by the owner's provider, and the "credits" rows to a usage meter (`editor/agents/usage.ts` already reads the CLIs' plan limits).

| Figma feature (plans) | Figma | Ours | Work | Size | Personal |
|---|---|---|---|---|---|
| **Figma agent** (all plans, Full seat to edit; GA 2026-10-06; https://help.figma.com/hc/en-us/articles/37998629035799): on-canvas chat, generate/remix, automate, feedback; **Skills**; **Connectors**; **Add images and files**; **Add motion tools**; **Generative plugins** ("describe a tool and the agent builds it"); **Create shader effects and fills** | | ◐ chat ✅, images ✅, attachments ✅ (`src/main/agents/attachments.ts`), shader paints/effects ✅ (r11-features) but not by prompt-tuned tools; no skills, no generative plugins, no motion | Skills = saved instruction sets per user/org passed to the provider (Agent settings list, `/skill` in the composer); generative plugins need E-2; motion needs Motion (Part 4) | M | ★ |
| Design productivity tools (AI) (– P O E): **Rename layers**, **Add interactions** (make prototype), **Replace content**, **Rewrite / translate / shorten text**, **First Draft** (prompt → wireframe from 4 built-in libraries) | https://help.figma.com/hc/en-us/articles/24004711129879 , /24004778051479 , /23796390206743 , /24004868368919 , /23955143044247 | ◐ bulk rename (non-AI, `panels/RenameLayers.tsx`); Figma's AI rename disabled; the rest ✗ as menu actions (an agent chat can do them) | Each as a one-shot "action" in the Actions panel (⌘K) that starts a hidden agent turn with a fixed prompt and the selection, its result one undo step (the turn's actor); First Draft needs bundled UI kits (1.1) | M | ★ |
| **Image editing (AI)** (– P O E): make/edit image, **remove background**, **boost resolution**, **expand image**, **isolate object**, **erase object** (https://help.figma.com/hc/en-us/articles/24004542669463); **Vectorize image** (https://help.figma.com/hc/en-us/articles/38031452710807) | | ◐ generate/place ✅ via Antigravity | Image actions on a selected image fill calling an image model (the provider list gains image endpoints: Gemini/OpenAI image edit; background removal can run locally with an ONNX/Wasm model — no account needed); vectorize = potrace-like tracing in the engine (C++ — a classical tracer is deterministic and offline) | M–L | ★ |
| **Visual search (AI)**, Text tools (AI) (– P O E) | Search by screenshot/selection/text across team, org, Community (https://help.figma.com/hc/en-us/articles/24037716110615) | ✗ (the button is shown, not built) | Embeddings of thumbnails/frames (a local CLIP-like model in Wasm or a provider's embedding API), an index in the store per space, the search UI in Assets/Find | L | ○ |
| **Weave tools** (– P O E; GA 2026-10-06; not with G+; https://help.figma.com/hc/en-us/articles/40779260614935): Tools in the nav rail › filter "Weave" › a tool's settings modal (reference image, prompt, dropdowns) › number of runs › Generate; built-in Generate mockup, Transfer style, Replace background, Change lighting, Text to vector illustration, Apply color palette + Community tools; "Open in Weave"; 13–110 credits per run | | ✗ (the rail has a Tools tab, r7-left-panel) | A Weave tool = a saved small node graph (prompt template + model calls + image ops) run by our providers; built-ins re-created; "Open in Weave" opens our Weave canvas (Part 4 W) | M (after image tools) | ★ |
| FigJam AI (Summarize, Generate, Sort — all plans), Slides AI (tone, presenter notes, outline from FigJam), Make, Buzz AI | | ✗ | With each product (Part 4) | — | |
| **AI Credits** row; AI credits add-on; AI usage history (O E); **AI Usage Analytics API** (E); admin AI on/off per org/workspace (https://help.figma.com/hc/en-us/articles/17725942479127); content training off on O/E | | ◐ usage ring from the CLIs' own limits (`agents/usage.ts`) | A usage ledger per action (provider-reported tokens/images → "credits" by a fixed table so the numbers read like Figma's), Admin › AI (on/off, per-person cap), usage history page, API route | S–M | ◇ |

---

## Part 4 — Whole products

Figma's schema already names all of them: `EditorType { DESIGN, WHITEBOARD (FigJam), SLIDES, DEV_HANDOFF, SITES, COOPER (Buzz), ILLUSTRATION (Draw), FIGMAKE (Make) }` (`figma-schema.kiwi` ~1834, `NodeChange.pageType = 397`) and the node types STICKY 17, SHAPE_WITH_TEXT 18, CONNECTOR 19, CODE_BLOCK 20, WIDGET 21, STAMP 22, MEDIA 23, HIGHLIGHT 24, SECTION_OVERLAY 26, WASHI_TAPE 27, TABLE 29, TABLE_CELL 30, SLIDE 32, ASSISTED_LAYOUT 33, INTERACTIVE_SLIDE_ELEMENT 34, MODULE 36, SLIDE_GRID 37, SLIDE_ROW 38, RESPONSIVE_SET 39, CODE_COMPONENT 40, TEXT_PATH 41, CODE_INSTANCE 42, CODE_LIBRARY 43, CODE_FILE 44, CODE_LAYER 45, MANAGED_STRING 47, TRANSFORM 48, CMS_RICH_TEXT 49, REPEATER 50, JSX 51, EMBEDDED_PROTOTYPE 52, REACT_FIBER 53, RESPONSIVE_NODE_SET 54, WEBPAGE 55, KEYFRAME 56, KEYFRAME_TRACK 57, ANIMATION_PRESET_INSTANCE 58 — all **dropped** from `schema/document.kiwi` (comment at ~81–87), plus `CMSSelector`, `KeyframeValueData`, `AnimationPresets`, `SpringParams`, `motionTransform 523`, `codeFilePath 472`, `importedCodeFiles 467`… The rule "Figma's names and field numbers" means each product starts by bringing its part of Figma's schema back. Ours today: `FileMeta.editorType: "design"` only (`src/shared/store/types.ts` ~48); Home's filter notes FigJam/Slides don't exist (`files/model.ts` ~246); `.fig` import refuses FigJam/Slides files (`src/shared/fig/importFig.ts`).

Common pieces every product needs (P-0): `editorType` in `FileMeta` and Home's "+ Create" menu (Design, FigJam, Slides, Buzz, Sites, Make), file icons and filters, the editor view choosing its chrome by editor type, `.fig`/`.jam`/`.deck`/`.buzz`/`.site`/`.make` import (Figma exports these as fig-kiwi with `pageType`), templates shelf. **Size** M.

### Draw (S P O E — all rows on every plan; https://help.figma.com/hc/en-us/articles/31440394517143 , tools https://help.figma.com/hc/en-us/articles/31440438150935)

Design/Draw toggle in a Design file's toolbar; Pen, **Pencil**, **Brush** (stretch / scatter); simplified illustration sidebar with sliders; big-thumbnail Layers. Rows: Draw tools; Enhanced vector editing (**shape builder**, **multi-edit** vector modes, **lasso**); **Custom brushes**; Visual effects (**noise**, **texture**, **progressive blur**, **pattern fill**); More stroke mechanics (**variable width**, **frequency**, **wiggle**); **Text on a path**; **Transforms** (repeat and radial).

Ours ◐: brushes drawn (BRUSH 46, stretch/scatter, `engine/src/geometry/Brush.*`), variable width + width profiles + shape builder (r12-vector-draw), lasso in vector edit (r8), noise/texture/progressive blur/glass (r7-render), "Switch to Draw" opens the design editor with the Pencil; research `docs/research/figma/live/draw/behaviour.md`. Missing: Draw's own mode chrome (toolbar, sidebar, layers thumbnails), custom brush creation, pattern fill, frequency/wiggle (dynamic strokes), multi-edit, **text on a path** (TEXT_PATH 41 + `textPathStart`… fields; engine text layout along a curve), **Transforms** (TRANSFORM 48: repeat / radial as live modifiers — a non-destructive node evaluated in derived data). **Size** L. **Personal** ★. (Figma Draw isn't Enterprise-gated; it's in the table and in Full seats.)

### Motion (Beta) (S P O E rows; Dev Mode handoff, hi-res export and published motion systems – P O E; launched 2026-06-24 at Config 2026)

- **Figma** (blog https://www.figma.com/blog/introducing-figma-motion/ ; help https://help.figma.com/hc/en-us/articles/41405906446999 — not opened, unverified details): a **Motion mode** on a frame (next to Design, Draw, Dev) with a **timeline** under the canvas; layer bars dragged to retime, scrub; independent keyframes for position, scale, rotation, opacity and any shader property; **auto-keyframing** at the playhead; default 2000 ms; loop / once / ping-pong; time-stamped comments; **animation presets** (fade, move, scale) stacked or sequenced; **animated components** (instances inherit motion); **motion variables** (easing and timing variables with modes); agent "Add motion tools"; export **MP4, GIF, WebM, animated SVG** (> 30 fps or 1080p needs P+); **Dev Mode Motion tab** (timing, easing, keyframes; CSS, JSON, React, motion.dev); MCP. 3D transforms "coming soon" (conflicting 3rd-party claim).
- **Ours**: ✗ (Smart animate and springs in the player ✅, `engine/src/proto/`); research capture `docs/research/figma/live/motion/behaviour.md`; editor.md lists "N12 Motion" as not done.
- **Work**: schema: KEYFRAME 56, KEYFRAME_TRACK 57, ANIMATION_PRESET_INSTANCE 58, `keyframeValue 507`, `keyframeOperation 509`, `animationPresets 521`, `motionTransform 523`, the KeyframeTrack* messages, EasingData/SpringParams (exist partly for prototypes); engine: an animation evaluator (time → per-node property overrides applied as a derived layer over the document, never journaled; the player's Smart-animate interpolators reused), the renderer at time t, auto-keyframe recording in the edit path; UI: Motion mode, timeline panel (tracks, bars, keyframes, playhead, easing editor), presets; export: frames rendered offscreen (E7's PNG path) encoded by **WebCodecs** (`VideoEncoder` → MP4/WebM via a muxer such as mp4-muxer/webm-muxer), GIF via a quantizer, animated SVG via SMIL/CSS keyframes; Dev Mode Motion tab; motion variables (variables of type float/easing — easing variables need a new resolved type: check Figma's schema `VariableResolvedDataType`).
- **Size**: XL. **Deps**: variables ✅, export ✅, presentation ✅. **Personal**: ★.

### FigJam (whiteboard; S P O E with Voting and Open sessions – P O E, Custom color palettes and Custom templates – – O E, Advanced shapes – P O E)

- **Figma**: stickies, shapes with text and connectors ("Diagramming tools"), sections, tables, code blocks, stamps/stickers/emotes, washi tape, highlighter/marker, **Timer** (one per file, ≤ 99:59, https://help.figma.com/hc/en-us/articles/8538436879767), **Music player**, **Voting** (paid; host sets votes per person, stamp tool, private until the end, https://help.figma.com/hc/en-us/articles/9359912208663), **Open sessions** (anyone with the link edits for 24 h, login needed per the table), Advanced shapes (1,500+, AWS/GCP/Azure/Kubernetes), widgets, templates, AI (Generate boards/diagrams 2–24 credits, Sort and Summarize stickies; https://help.figma.com/hc/en-us/articles/16822138920343), custom color palettes and custom templates (O E).
- **Ours**: ✗ (node types dropped; `.jam` import refused).
- **Work**: schema back (17–30, `ShapeWithTextType`, connector fields, sticky fields, table fields); engine: sticky rendering (fixed sizes, auto font size), shape-with-text (≈ 30 `ShapeWithTextType` outlines), **connector routing** (elbowed / straight / curved, magnets on shapes, re-route on move — the hard part), tables (rows/columns, cell text), code blocks (syntax highlighting via a small tokenizer, e.g. Prism grammars ported or highlight.js in the view and baked to text runs), stamps, washi tape, marker strokes; FigJam's own chrome (bottom toolbar of stickies/shapes/stamps, the top bar, the colour palettes); timer, music (shared state on the room: a tiny "board state" channel like presence but stored), voting sessions (server state), open sessions (24-h link editor role, A-1 link scopes); templates; AI via agents.
- **Size**: XL. **Deps**: P-0; multiplayer ✅ for timers/voting. **Personal**: ★ (planning with friends).

### Slides (S P O E; Custom templates – 5 ∞ ∞; Image editing AI – P O E)

- **Figma** (https://help.figma.com/hc/en-us/articles/24170630629911 and linked pages): **grid view** (rows of slides), single-slide view with presenter notes, **Design mode** (auto layout, layers, full properties; Full seat, beta), templates (mix layouts, styles become deck-wide), **Present** / **Present + Notes** (presenter window + audience window), notes editable while presenting, Spotlight, offline presentations, YouTube embeds, **live interactions** (polls, alignment scales, voting — results live and kept; viewers need an account), embedded Design **prototypes**, **transitions** (slide / object / deck), **PowerPoint import/export**, PDF export, Design libraries, AI (tone, presenter notes, outline from FigJam).
- **Ours**: ✗ (presentation player ✅ for prototypes, `src/renderer/src/present/`).
- **Work**: schema SLIDE_GRID 37 / SLIDE_ROW 38 / SLIDE 32 / INTERACTIVE_SLIDE_ELEMENT 34 / MODULE 36 / ASSISTED_LAYOUT 33 + slide fields; engine: the grid layout (rows of 1920×1080 slides), slide numbering, object animations (`objectAnimations 426`, OBJECT_ANIMATION) and transitions in a slides player (extend `engine/src/proto/` or a sibling); UI: Slides chrome, grid view, notes, presenter view (a second window via main), live interactions (server state on the room, results stored), YouTube embed (MEDIA/EMBED node drawn as a poster, played in the DOM over the canvas when presenting); **PPTX** import/export (OOXML: a large but well-specified format — export first: shapes, text, images; import: a subset) — risk M–L.
- **Size**: XL. **Deps**: P-0, presentation ✅, export ✅. **Personal**: ★.

### Sites (Beta; S P O E; Video, Password protection, Publishing – P O E)

- **Figma** (https://help.figma.com/hc/en-us/articles/31242797809815 ; custom domain https://help.figma.com/hc/en-us/articles/31414274019863 ; CMS https://help.figma.com/hc/en-us/articles/36165345510551 ; settings/SEO https://help.figma.com/hc/en-us/articles/31242875661591 ; admin https://help.figma.com/hc/en-us/articles/31242876956183): webpages with **breakpoints** (desktop/tablet/mobile/custom; edits on the primary breakpoint cascade, secondary stay local; mobile-first by making a small one primary), **blocks and embeds**, **interactions** (animations, hover, scroll effects), **code layers** (React written by hand or AI), **CMS** (collections with Title, Slug, plain/rich text, link, image, date fields; CMS pages = templates with a URL per item), site settings (titles, meta description, social image, favicon, password), publishing to a `figma.site` subdomain or a custom domain (SSL automatic); org admins can turn web publishing off, E can require passwords.
- **Ours**: ✗ — but the viewer (`src/viewer`) already renders files on the Worker and previews are published there (`/p/<id>`, multiplayer.md §9).
- **Work**: schema WEBPAGE 55, RESPONSIVE_SET 39 / RESPONSIVE_NODE_SET 54, CMS_RICH_TEXT 49, REPEATER 50, CMSSelector / ConsumptionMap / RichTextStyleMap, code layer types (40–45, 51, 53); engine: breakpoint sets (a node per breakpoint with overrides cascading from the primary — close to how instances override mains: reuse the override machinery), repeaters bound to CMS items; **publishing = HTML/CSS generation** from the document (auto layout → flexbox/grid, constraints → absolute/percent, text → HTML with web fonts, images → optimized assets, interactions → CSS/JS) — the Dev Mode CSS generator (`src/viewer/inspect/css.ts`) is the seed; a site host on the Worker (`/s/<site>` + custom domains through Cloudflare for SaaS custom hostnames — needs a zone; risk), CMS on D1, password pages; code layers depend on the Make runtime.
- **Size**: XL. **Deps**: P-0, Make runtime for code layers, Worker hosting. **Personal**: ★ (the owner began with a portfolio site — burakkoc.net — this is that use).

### Make (S P O E core; Library styling context, connectors, Copy as design layers, templates, password, Make kits – P O E; Publish custom connectors – – O E)

- **Figma** (category https://help.figma.com/hc/en-us/categories/31304285531543 ; create https://help.figma.com/hc/en-us/articles/31304485164695 ; plan mode https://help.figma.com/hc/en-us/articles/40830441709719 ; connectors https://help.figma.com/hc/en-us/articles/36343926263703 ; Make kits https://help.figma.com/hc/en-us/articles/39241689698839): a chat that writes a **React + Vite** app with a live preview beside a code editor; **Plan mode** (`/plan`); attach frames/components ("Bring your designs"), images, files; **Supabase** backend (auth, data, storage, private APIs); **Publish** to a URL; Make on mobile; library styling context; MCP connectors; **Copy as design layers** (the preview → editable layers); templates; password; **Make kits** (npm packages, library variables/styles, guidelines; Settings › Create a kit › Publish kit; org approval and default).
- **Ours**: ✗ — but the agents (Claude Code / Codex CLIs) already write code and run tools; our MCP has `get_design`/node specs; Copy as design layers ≈ our SVG/HTML import paths (`src/shared/vectorImport/`).
- **Work**: a Make file kind: a virtual file system (CODE_FILE 44 nodes or a separate blob tree — Figma stores code files as nodes: `codeFilePath 472`, `CODE_LIBRARY`), an in-view bundler (**esbuild-wasm** in a worker + an npm CDN resolver such as esm.sh) and a sandboxed preview iframe (cross-origin, our `app://` protocol gives an isolated origin), Monaco/CodeMirror editor; the chat = an agent turn whose tools are file read/write + "run preview" (the CLIs can also work in a real temp folder with `vite` — simpler and closer to their strengths: **decide**: in-view bundling (works on the web app, Figma's way) vs a main-process temp project (desktop only)); publishing to the Worker (static assets per app under `/m/<id>`, Workers Static Assets or a DO); Supabase via the user's own project keys; Make kits = packages + library context bundled as a prompt attachment; Copy as design layers = render the preview DOM to NODE_CHANGES (HTML → layers converter: reads computed styles and boxes in the iframe — L).
- **Size**: XL. **Deps**: P-0, agents ✅, Worker hosting (shared with Sites). **Personal**: ★.

### Buzz (Beta; S P O E templates and free-form; Brand template publishing, Focused editing, Image editing AI – P O E)

- **Figma** (https://help.figma.com/hc/en-us/articles/31271566667543 ; bulk create https://help.figma.com/hc/articles/31271824185623 ; templated assets https://help.figma.com/hc/en-us/articles/31271689852823 ; publish templates https://help.figma.com/hc/articles/31271693614487 ; localize https://help.figma.com/hc/en-us/articles/33153574454935): brand and marketing assets (social, ads, events); + Create › Buzz; templates built in Buzz or copied from Design; published from Share; **assets with guidelines** (pink outline + lock: only fields the author unlocked editable, in **Table view**; Text/Images/Shapes/Inserts tools disabled) vs **free-form** (blue outline, all tools; Full seats get Design tools); **Bulk create** from CSV/XLSX (header row, map text and image layers to columns, one asset per row; images only in XLSX; localization).
- **Ours**: ✗.
- **Work**: editor type COOPER; Buzz chrome (asset grid, Table view = a spreadsheet of the unlocked fields of every asset), template locks (a per-node "editable in Buzz" flag — find Figma's field in `figma-schema.kiwi` before inventing one), bulk create (CSV parser; XLSX via a small zip+XML reader; images from cells), template publishing through libraries (C-1).
- **Size**: L. **Deps**: P-0, C-1 for team templates. **Personal**: ○.

### Weave (standalone product, separate billing; "Weave tools" in Design are – P O E)

- **Figma** (FAQ https://help.figma.com/hc/en-us/articles/35965787376919 ; blog https://www.figma.com/blog/welcome-weavy-to-figma/ , https://www.figma.com/blog/connecting-figma-and-weave/): Figma bought Weavy (October 2025), relaunched as **Figma Weave** (around April 2026 — 3rd party date) at weave.figma.com: a **node-based canvas** for AI media workflows (images, video, audio, 3D) chaining many models (reported: Sora, Veo, Seedance, FLUX.2, Ideogram, Nano Banana, Seedream) with editing nodes (lighting, colour, masking, layer edits); a **Figma node** (paste a frame, wire inputs to layers, push back with Connect / pull updates); separate Weave credits. Weave tools in Design = published Weave workflows (Part 3).
- **Ours**: ✗.
- **Work**: a node-graph editor (its own view type; DOM/SVG nodes and wires are fine here — it is chrome, not design objects — or the engine's canvas if the owner prefers Figma's way; Weave's original UI is a React flow canvas (3rd party, unverified)); node kinds = model calls through the owner's providers (image gen/edit endpoints; video models only where the owner has API access), image ops done locally (crop, mask, colour, compose), a Figma node bound to a frame via our MCP/engine; workflows saved as files (`editorType: "weave"` — ours, not in Figma's EditorType); publishing a workflow as a Weave tool.
- **Size**: L–XL. **Deps**: image providers (Part 3). **Personal**: ○ (depends on which model APIs the owner pays for).

---

## Part 5 — Dependencies and risks

```
A-1 org/teams/projects on the server ──┬─> A-2 seats/roles ─> A-3 Admin app ─> A-5/A-6 security settings, A-8 G+
                                       ├─> A-4 activity log (can start per user before A-1)
                                       ├─> C-1 server libraries ─> D-4 org-wide DS / approved / default ─> D-3 analytics (+API)
                                       ├─> D-2 shared fonts
                                       └─> E-1 REST API ─> Enterprise endpoints, webhooks, Code Connect CLI, VS Code
version snapshots ✅ + Compare changes ✅ ─> D-1 branching (local first; shared branches after A-1)
P-0 editor types ─> FigJam · Slides · Buzz · Sites (+ Make runtime for code layers) · Make · Motion (mode, no new file type) · Weave
image providers ─> AI image tools ─> Weave tools ─> Weave
E-2 plugin host ─> private plugins, plugin management, generative plugins, widgets (FigJam)
```

Biggest risks, first:
1. **The content model moves to the server (A-1).** Today the local workspace is the truth and sharing is per file; Enterprise assumes the org owns every file. Doing it without breaking offline-first, the journal, Home and the 1,200+ tests is the phase's main risk. Mitigation: two spaces behind the same repositories (local stays as is; org spaces are room-backed), contract written first (`docs/multiplayer.md` §14 "Organizations", written 2026-10-11), migration of existing shared files into a default team.
2. **Branching's three-way merge (D-1)** on per-property changes: correctness of conflicts on reparenting (parentIndex), component/instance overrides, variables and library copies; rich test corpus needed (the owner's 32k-layer file as a stress case).
3. **New editor types (FigJam, Slides, Sites, Make, Buzz)** each need a chrome and engine pieces: connector routing, slide grid, breakpoint cascade, HTML generation, an in-view bundler. Each is XL; their schema parts must come back with Figma's numbers (field-number collisions with ours: check `@ours` fields before re-adding).
4. **SAML in a Worker** (XML signature verification, signature wrapping) — security-critical; use a vetted library and a real IdP test.
5. **Server-side rendering for the REST images endpoint** — our renderer needs WebGL2/WebGPU; a Worker has neither. Options: thumbnails only, client-side render-and-cache, or a CPU raster backend in the engine (XL). Decide before promising `GET /v1/images`.
6. **Free-plan limits** (multiplayer.md §1): analytics events, activity logs and site hosting raise request counts; batch events, roll up daily, consider the Workers paid plan ($5) if Sites/Make apps are public.
7. **Video encoding for Motion** — WebCodecs H.264 availability in Electron's Chromium (proprietary codecs: Electron ships them; the web app on Chromium yes, Firefox partial).
8. **Plugin API surface (E-2)** — open-ended; must be scoped to a documented subset.

## Part 6 — Unverifiable or conflicting (2026-10-11)

- Professional monthly prices (filled in by script; 3rd party $20/$15/$5); AI add-on prices and pay-as-you-go rates (shown only in Admin).
- The pricing page no longer shows the owner's "2x / 1.6x" banner; its content is help 42614902212887.
- Motion's help article (41405906446999) was not opened; 3D transforms' status conflicts between sources; Motion's export formats and plan split are from the pricing table (verified) and the blog.
- Weave: relaunch date (April 2026) secondary only; "free during beta" vs credits (the credits FAQ says GA and charged from 2026-10-06 — trust that).
- Sites: built-in analytics settings, custom-domain limits after 2025, CMS per-item SEO (forum: not supported).
- Buzz: GA date and post-beta seat terms ("Content" seat mentioned by Buzz help, absent from the pricing page).
- FigJam AI plan gating: the pricing table says all plans, older help says paid seats.
- Admin: a "license admin" role (not a Figma term as far as found), session listing/revocation for admins, legal hold / retention policies / file labels, managed-device restrictions, a private Community profile, the default of "who can create teams", SCIM seat attribute names, exact activity-log action names, "Inspect panel administration" options, Dev Mode / MCP admin toggles.
- Organization-level team visibility (open / closed / secret): the help article 360040452973 now 404s.
- Code layers in Figma Design (Config 2026) — waitlist, not confirmed GA.
