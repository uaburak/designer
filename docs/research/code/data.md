# Persistence, session, Home, site coupling — DesignerV2 (read-only map)

Scope read in full: `src/renderer/src/lib/*`, `src/renderer/src/demo/*`, `src/renderer/src/figma/{session,publish,site,account,draft}.ts`, `src/renderer/src/home/*`, plus the glue they need (`types/project.ts`, `types/cv.ts`, `figma/{overview,systemLibrary,designSystem}.ts`, `components/admin/useUndo.ts`, `app/{Shell,ShellApp,tabs,bridge}.tsx|ts`, `tab/*`, `vite.shared.ts`, `src/shared/*`). CV skimmed only for site-specific inventory. All paths below are relative to `/Users/burak/Desktop/Burak/Code/DesignerV2/src/renderer/src/` unless they start with `src/`, `docs/` or `vite`.

---

## 1. How it works today (summary)

**One data API, two backends, chosen at build time.** Every caller imports `@/lib/firestore`, `@/lib/storage`, `@/lib/auth`. `vite.shared.ts:14-23` aliases those three to `demo/firestore.ts`, `demo/storage.ts`, `demo/auth.ts` when built with `--mode demo`. The demo functions are typed `typeof Real.fn` (e.g. `demo/firestore.ts:98,110,199`), so the signatures cannot drift. What both sides share without Firebase lives in `lib/data.ts` (limits, error classes, stored shapes, `errorText`).

**The unit of storage is a "project" keyed by its site slug**, not a file id. A project = metadata doc + one JSON text holding the whole Figma document + up to 20 version snapshots. The JSON-text-in-a-field design is forced by Firestore: no map nesting deeper than 20 (`lib/firestore.ts:52-57`) and 1 MiB per document (`lib/data.ts:16-19`, checked by `sized()` `lib/data.ts:56-60`). So a file must serialise to < 1,000,000 bytes or Save refuses (`TooLargeError`), warning from 700 KB.

**Variables, text styles and components are global, not per file.** They live in three singleton docs `design/variables`, `design/textStyles`, `design/library` (`lib/firestore.ts:259-280`). On open, the session merges the global library into the file as a hidden "Components" page (`figma/systemLibrary.ts:62-65`, `withLibrary`) and splits it out again on save (`splitLibrary`, `systemLibrary.ts:71-76`). Deletions in the global design system are kept as tombstones (max 100, `systemLibrary.ts:22,149-152`) so that files opened later get their uses auto-detached (`detachDeleted`, `systemLibrary.ts:212-240`).

**Session (`figma/session.ts`)** — `useEditSession(slug)` loads project + design in parallel (`:90-127`), upgrades the doc, detaches deleted things, injects the global library and the site "Overview" (`:99-113`), and records that as the `saved` baseline. Edits are immutable `EditState` replacements (`designSystem.ts:15-22`); `changedParts` compares the four parts by reference (`session.ts:59-66`) to compute `dirty`. There is **no autosave** (`:27-30`); `save()` builds a `SaveRequest` with only the changed parts and each part's `rev` (`:169-207`) and calls `saveAll`, which runs one Firestore transaction with optimistic concurrency per part (`lib/firestore.ts:290-339`). A rev mismatch is a `ConflictError` that the UI offers to "Overwrite" (`force`) or "Reload" (`figma/chrome.tsx:42-62`). Undo/redo is a 20-step in-memory snapshot stack of the whole `EditState`, coalescing edits within 600 ms (`components/admin/useUndo.ts:11-73`). Publish (`session.ts:217-232`) saves first, then freezes the site page (`figma/publish.ts:90-111`) into `published/{slug}`. Versions: list/restore the last 20 saves; restoring is an ordinary undoable edit (`session.ts:245-255`).

**Images/uploads** — the one immediate write. `uploadMedia` (`lib/storage.ts:57-61`) checks type/size (`lib/media.ts:15-23`, 25 MB, only "files the site can show"), downsizes to ≤2560 px WebP q0.85 unless already small (`media.ts:30-51`), and uploads to `media/YYYY/MM/<ms>-<slug-name>.<ext>` (`media.ts:57-62`) with a one-year immutable cache header (`storage.ts:17,32`). The node stores the full tokenised download URL in `Paint.image.url` (`figma/model.ts:35`). A localStorage-backed bucket-listing cache (`storage.ts:112-228`) feeds the editor's Images panel; "Find unused" regex-scans every stored JSON for Storage URLs (`lib/firestore.ts:349-365`).

**Auth** — Google sign-in via a loopback server in the system browser (`src/main/signIn.ts`), then `signInWithCredential` (`lib/auth.ts:29-39`); Firebase persists the session in IndexedDB (`lib/firebase.ts:26-32`). The gate admits only `ADMIN_EMAILS` (`lib/auth.ts:11-13`, `app/ShellApp.tsx:21-33`).

**Home (`home/*`)** — a Figma-styled file browser over `listProjects()`: sidebar (account menu, search, Recents, Published, a fake "burakkoc.net / Admin" team with Drafts, All projects, Library, CV, Trash, then Starred), header (back/forward, breadcrumb, Create split button, View site), view title menu, filter and sort pills, grid/list toggle, multi-select with ⌘/⇧-click, ⌘A, Esc, ⌫, Enter, context menu, toast with Undo, drag-to-reorder in "Site order", dialogs for New project / Duplicate / Delete forever / Unpublish. Recents, starred and view prefs are per computer in localStorage (`home/prefs.ts`).

---

## 2. The stored schema actually used

### 2.1 Firestore (real backend, `lib/firestore.ts`)

| Path | Fields (as written) | Written by |
|---|---|---|
| `projects/{slug}` | `slug,title,titleEn,category,year,description,descriptionEn,coverImage,company` (all strings, `""` when unset — `fieldsData` `:80-92`), `order:number`, `rev:number`, `published:bool`, `changedSincePublish:bool`, `createdAt,updatedAt,publishedAt,trashedAt: Timestamp|null` | create `:180`; save `:315` (update: fields + `rev`, `changedSincePublish:true`, `updatedAt`); trash `:216`; restore `:222`; reorder `:229`; publish `:377`; unpublish `:386` |
| `projects/{slug}/content/canvas` | `{ json: string }` — `JSON.stringify(FigmaDocument)` without the library page (`CANVAS_FIELD` `:57`) | create `:181`; save `:316` |
| `projects/{slug}/versions/{autoId}` | `{ json, rev, title, savedAt }` (full copy of the canvas JSON) | save `:317`; pruned to 20 after save, outside the tx, best effort `:251-257,337` |
| `published/{slug}` | summary fields + `order`, `images[]` (≤12), `publishedAt` + `json` = `{doc, variables, textStyles}` | publish `:370-379` (batch) |
| `publishedIndex/{slug}` | the same summary without `json` | publish `:376`; reorder merges `order` `:230` |
| `design/variables` | `{ variables: DesignVariable[], deleted: DesignVariable[], rev, updatedAt }` (native Firestore arrays/maps) | save `:322` |
| `design/textStyles` | `{ styles: TextStyle[], deleted: TextStyle[], rev, updatedAt }` | save `:327` |
| `design/library` | `{ json: string(StoredLibrary), rev, updatedAt }` | save `:332` |
| `cv/main` | `CVData` fields + `updatedAt` | `saveCVData` `:439-441` (plain `setDoc`, no rev) |

Reads: `listProjects` reads the whole `projects` collection (`:158-161`); `loadProjectForEdit` reads meta + canvas (`:164-169`) and throws `StoredDataError` on a broken JSON rather than returning empty (`:120-130`) — "never overwrite what wasn't read". `loadDesign` reads all three design docs (`:265-280`).

Transactions / concurrency:
- `saveAll` (`:290-339`): one `runTransaction`; reads only the parts in the request; `check()` compares stored `rev` with the rev the session loaded (`:308-311`); writes meta, canvas, a new version doc and the design parts; returns new revs and "large" warnings.
- `createProject` (`:172-184`): computes `order` from a full collection read **outside** the tx (`:175-176`), then tx-checks the slug is free (`SlugTakenError`).
- Everything else (trash, restore, reorder, publish, unpublish, delete) is a `writeBatch` or `updateDoc` with **no rev check and no rev bump** (`:196-233,370-388`).

### 2.2 Storage (real backend)
- Paths: `media/YYYY/MM/<epoch-ms>-<name≤40>.<ext>` (`lib/media.ts:57-62`); CV uploads under `cv/<folder>/…` (`cv/CVEditor.tsx:180`).
- References: full `https://firebasestorage.googleapis.com/v0/b/<bucket>/o/<path>?alt=media&token=…` URLs inside the node JSON; `storagePathOf` parses them back (`lib/storage.ts:78-88`); `publicUrl` builds a tokenless URL (`:75`).
- Listing: REST `?prefix=` with the Firebase ID token, 1000 per page (`:96-110`), cached in memory + localStorage for 24 h with an add/remove journal to patch in-flight lists (`:121-228`), cross-tab via `storage` events (`:174-182`).
- Deleting a project never deletes its images (`lib/firestore.ts:195`, dialog text `home/dialogs.tsx:169`); unused images are found/deleted manually from the Images panel (`figma/ImagesPanel.tsx:136-170`).

### 2.3 Demo backend (IndexedDB) — the natural seed for local-first
- `demo/db.ts`: one DB `designer-demo`, one object store `kv` (`:6-19`), helpers `get/set/del/keys(prefix)` each in its own IDB transaction (`:21-37`), `later()` fake latency (`:40`).
- Keys (`demo/firestore.ts:32-42`): `project:{slug}` → `{meta: ProjectMeta}`; `canvas:{slug}` → JSON string; `versions:{slug}` → array of `{id,savedAt,rev,title,json}` (≤20, newest first, `:231`); `published:{slug}` → JSON string; `design:variables|textStyles` → `{data:{list,deleted}, rev}`; `design:library` → `{data: JSON string, rev}`; `cv`; `seeded` flag.
- Seeding: six sample projects once, each a `newDocument` + global library + Overview (`:46-87`).
- `saveAll` (`:199-248`) mimics the real one: reads all parts, checks revs, then writes with **separate** `db.set` calls (`:226-246`) — not atomic and the check-then-write is racy across tabs.
- `demo/storage.ts`: each upload is converted to a base64 **data URL**, stored under `file:{path}` and returned as the image URL (`:36-43`); all files are loaded into a Map at module load (`:15-23`); `storagePathOf` is a linear scan comparing data URLs (`:52-55`).
- `demo/auth.ts`: a fake always-admin user; "signed out" is a localStorage flag (`:13-53`).

### 2.4 Per-computer state (localStorage)
- `designer-recents` (last 50 `{slug, at}`), `designer-starred` (slugs), `designer-browse` (`layout, sort, filter, starredOpen`) — `home/prefs.ts:65-95`.
- `designer-home-view` — `home/Home.tsx:43,56-63,121-125`.
- `designer-tabs` (open tabs by `kind`+`slug`) — `app/tabs.ts:100-129`.
- `storage-list:<prefix>` bucket listing cache — `lib/storage.ts:123`.
- `designer-theme` — per `docs/architecture.md`.

---

## 3. Key types (file:line)
- `ProjectFields` `types/project.ts:9-21`; `ProjectMeta` `:29-44`; `ProjectSummary` `:47-52`; `PublishedPage` `:60-65`; `ProjectVersion` `:68-73`.
- `StoredLibrary` `lib/data.ts:71-79`; `StoredDesign` `:82-94`; `DeletedComponent` `:65-68`; `SaveRequest` `:99-106`; `SaveResult` `:109-116`; errors `SlugTakenError/ConflictError/TooLargeError/StoredDataError` `:24-50`.
- `EditState` `figma/designSystem.ts:15-22`; `DesignSystem` ops `:25-45`.
- `LoadStatus/SaveState/PublishState` `figma/session.ts:42-49`; `EditSession` `:286`.
- `FigmaDocument` `figma/model.ts:569-591` (note `pageId` = "the project's page on the site", first page in `nodes`, other pages in `pages[]`, `languages`, `libraryVersion`, `fromLegacy`).
- `DesignVariable` `types/design.ts:16-29` (fixed `light`/`dark` modes, `token` = site CSS var); `TextStyle` `:54-64` (`tag` for site HTML, `small` = site breakpoint).
- `CVData` `types/cv.ts:31-43`.
- `Opened/Browse/Sort/Filter` `home/prefs.ts:59-92`; `ViewKind` `home/Sidebar.tsx:16`; `Tab/TabsState/TabKind` `app/tabs.ts:11-38`; `TabReport/ShellBridge/TabBridge` `app/bridge.ts:10-35`; `AuthState` `lib/auth.ts:15`; `KeptFiles` `lib/storage.ts:125-129`.

---

## 4. Key mechanisms (with refs)
1. Backend swap by Vite alias + `typeof Real` typing — `vite.shared.ts:14-23`, `demo/firestore.ts:1,98-279`, `demo/storage.ts:1,33-77`, `demo/auth.ts:3,44-53`.
2. Load pipeline — `session.ts:90-127`: `loadProjectForEdit` + `loadDesign` → `currentLibrary` (auto-upgrades untouched seeded components by signature, `systemLibrary.ts:37-57`) → `upgradeDocument` → `detachDeleted` → `withLibrary` → `withOverview` → baseline `saved`.
3. Dirty by reference — `session.ts:59-66,129-131`; `projectChanged`/`libraryChanged` `systemLibrary.ts:79-95`; `sameFile` ignores `currentPage` (`session.ts:69-74`) so page switching is not an edit.
4. Edit guard — `update`/`onDoc` silently drop any change that breaks the site Overview (`session.ts:134-156`, `overview.ts:137-144`).
5. Save — `session.ts:169-207` → `saveAll` tx with per-part revs (`lib/firestore.ts:290-339`); a version doc is written in the same tx; prune afterwards. Save state UI `figma/chrome.tsx:29-62`; "saved" fades after 2 s (`session.ts:210-214`).
6. Conflict handling — `ConflictError(part)` → banner with Overwrite (`save(true)` → `force`) / Reload (`chrome.tsx:42-62`).
7. Undo — `useUndo` snapshot stack, 20 steps, 600 ms coalescing, reference-compared keys (`useUndo.ts:11-73`); the whole design system shares the file's undo stack (`designSystem.ts:8-14`).
8. Versions — `listVersions/loadVersion` (`lib/firestore.ts:236-248`); restore re-runs detach/library/overview on the old doc and applies it as an edit (`session.ts:246-255`); UI `figma/VersionsWindow.tsx`.
9. Publish — `publishedPage` keeps only the page frame + transitively used components + current variables/text styles + summary (`figma/publish.ts:24-44,90-111`); `publishProject` batch-writes `published`, `publishedIndex`, flips project flags (`lib/firestore.ts:370-379`). Home can publish the *saved* draft with no editor open via `savedPage` (`figma/draft.ts:16-26`, `home/actions.ts:5-7`).
10. Shell ↔ tab — tabs are same-origin iframes; tab reports `title/dirty/status/savedAt` (`app/bridge.ts:10-27`, `tab/EditorTab.tsx:21-46`); shell asks `isDirty/save` before closing a tab, the window or signing out (`app/Shell.tsx:80-118,184-209`); a tab save bumps `savedAt` so Home re-lists (`Shell.tsx:127-130`, `Home.tsx:95-97`).
11. Home listing — re-read on visible, on every tab save, on every window focus (`Home.tsx:81-103`); view derivation, filter and sort in one memo (`Home.tsx:145-190`); optimistic local patches then reload (`Home.tsx:198-246`); reorder optimistic with rollback (`Home.tsx:249-266`).
12. Home selection/keys — `press` (`Home.tsx:269-293`), keyboard (`:334-364`), context menu builder (`:295-331`), header menus (`:367-387`), drag reorder (`:390-405`).
13. Prefs store — generic `store<T>()` with `useSyncExternalStore`, same-page CustomEvent and cross-page `storage` event (`home/prefs.ts:12-53`).
14. Uploads — `checkUpload` → `webSized` → `mediaPath` → `uploadFile` (resumable, progress, cache header) → `rememberUrl` + `touchFiles` (`lib/storage.ts:26-61`, `lib/media.ts`).
15. Auth — `useAuth` via `onAuthStateChanged` (`lib/auth.ts:18-22`); desktop credential handoff (`:29-39`, `src/main/signIn.ts`); admin gate `app/ShellApp.tsx:21-33,99-110`.

---

## 5. Home vs Figma's file browser

| Area | DesignerV2 today | Figma |
|---|---|---|
| Hierarchy | Flat list of "projects" keyed by slug; one fake team "burakkoc.net · Admin" (`Sidebar.tsx:96-101`) | Account/org → Teams → Projects (folders) → Files; Drafts = personal files outside projects |
| Sidebar | Account, Search, Recents, Published, Drafts(=unpublished), All projects, Library, CV, Trash, Starred (`Sidebar.tsx:55-125`) | Account/team switcher, Search, Recents, Community, team section with Drafts/All projects/Trash, Starred files & projects |
| "Drafts" | Projects not on the site (`Home.tsx:163-165`) | Personal files not in a team project |
| Create | One "Create" split button → "New project…" modal asking Title + Slug (`Home.tsx:438-459`, `dialogs.tsx:64-102`) | One-click new Design / FigJam / Slides (and newer Sites/Buzz/Make) file named "Untitled", opens immediately; Import (.fig etc.) |
| File kinds | Always `FileKind kind="design"` (`FileCard.tsx:115`) | Design / FigJam / Slides / … with type icons and a type filter |
| Filters | All / Published / Drafts / Changed since published (`Home.tsx:45`) | File-type filter |
| Sort | Last modified / Last opened / Date created / Alphabetical / **Site order** + drag reorder (`Home.tsx:46,249-266,389-405`) | Last viewed / Last modified / Alphabetical / Date created; no manual order |
| Thumbnails | Overview cover image or a hashed gradient labelled "burakkoc.net" (`FileCard.tsx:14-38`) | Rendered thumbnail of the file (first frame or "Set as thumbnail") |
| Card meta | "Edited X ago", "· Open", Live/Changed badge (`FileCard.tsx:74,114-124,42-55`) | "Edited X ago", file type, team/project |
| List view | Columns Name / Site / Last edited / Created (`Home.tsx:519-529`, `FileCard.tsx:129-173`) | Name / Last viewed or modified / Owner / location |
| Context menu | Open, View on site, Copy link (site URL), star, Remove from recents, Publish / Update on site / Unpublish…, Duplicate…, Move to trash; in Trash: Restore, Delete forever (`Home.tsx:295-331`) | Open, Open in new tab, Copy link, Share, Duplicate, Rename, Move to project…, Add to starred, Delete; Trash: Restore, Delete forever |
| Rename | Not on Home (title only via the in-file Overview) | Rename inline from Home |
| Trash | `trashedAt`, also unpublishes; manual empty; no auto-expiry (`lib/firestore.ts:212-223`, `Home.tsx:384`) | Deleted files, auto-purged after 30 days |
| Recents / Starred | localStorage per computer (`prefs.ts:65-77`) | Per account |
| Search | Client-side substring over title/slug/category/year/company (`Home.tsx:169-173`) | Server search across files/projects/teams |
| Library | Home "Library" view of the single global design system (`home/Library.tsx`) | Per-file libraries published from files; Libraries modal, enable per file/team, update review |
| Community/Resources/Import/notifications | none | present |
| Selection | ⌘/⇧-click, ⌘A, Esc, ⌫, Enter (`Home.tsx:269-364`); no marquee | similar keyboard model plus drag-select and drag-to-move into projects |
| Header | Back/Forward, breadcrumb "burakkoc.net / View", Create, View site (`Home.tsx:426-461`) | Breadcrumb/title, create buttons, share/notifications |

---

## 6. Everything site-specific that a pure Figma clone drops or replaces

### Data / backend
- `src/shared/firebaseConfig.ts:6-14` — burakkoc-a15d3 Firebase project config.
- `lib/firebase.ts:1-36` — Firebase app/Firestore/Storage/Auth singletons.
- `lib/firestore.ts` whole file: collections `projects/published/publishedIndex/design/cv` (`:45-50`), `listPublished/loadPublished` (`:137-149`), slug-keyed project CRUD (`:153-257`), global design (`:259-280`), `saveAll` (`:290-339`), `referencedUrls` scanning Firebase URLs (`:349-365`), publish/unpublish (`:370-388`), CV (`:390-441`).
- `lib/data.ts` — Firestore 1 MB limits (`:16-19`), `SlugTakenError` (`:24-28`), `errorText` mentioning admin/rules (`:121-128`), `DEFAULT_CV_DATA` re-export (`:4`).
- `lib/storage.ts` whole file (Firebase Storage upload/list/delete, bucket REST API, URL cache).
- `lib/media.ts:12-23,56-62` — "files the site can show" policy and the shared `media/` folder naming.
- `lib/auth.ts:11-13` hard-coded `ADMIN_EMAILS`; Google/Firebase sign-in (`:24-44`); `src/main/signIn.ts` (191 lines); `app/ShellApp.tsx:21-110` gate, SignIn, NotAdmin copy ("burakkoc.net's design tool").
- `src/main/index.ts:277-280` — CORS header injection for `firebasestorage.googleapis.com`; CSP open to `https:`/`wss:` for Firebase (`:35-47`).
- `demo/*` — the sample projects are site projects with categories/years/published flags (`demo/firestore.ts:48-55`); publish/CV/published emulation (`:98-106,263-279`).

### Site model inside the file
- `figma/overview.ts` whole file — the mandatory "Overview" instance (title, category·year, description, cover) as first child of the site page, undeletable/unmovable (`fixedIds` `:118-129`, `keepsOverview` `:137-144`), and the source of project fields (`overviewFields` `:234-249`). Used by session (`session.ts:19,77,107,139,152,224,253`), dialogs (`home/dialogs.tsx:6,78-79,116`), demo seed (`demo/firestore.ts:8,69`), editor ("Set as site page" `figma/FigmaEditor.tsx:1605`, `fixedIds` `:306`).
- `FigmaDocument.pageId` "the project's page on the site" (`figma/model.ts:573-574`), `fromLegacy` (`:589-590`).
- `figma/systemLibrary.ts` — the single global library injected into every file (`withLibrary/splitLibrary`), seeded starting library and tombstone auto-detach; filter of `c-overview` in Home Library (`home/Library.tsx:89-90`).
- Starting variables bound to site CSS tokens (`DesignVariable.token`, `types/design.ts:25-26`; `components/project/designVariables.tsx:28-34`, Turkish names "Arka plan/1"); `TextStyle.tag/small` (`types/design.ts:60-63`).

### Publishing / site preview
- `figma/publish.ts` (111 lines) — `publishedPage`, `usedComponents`, `picturesOf`, cover alt text, 12 summary pictures.
- `figma/site.ts` (132 lines) — page headings and scroll-reveal plan; imported by `figma/PageView.tsx:26` (also used by `figma/Player.tsx:7`, so PageView must be decoupled first).
- `figma/draft.ts` (26 lines) — `savedPage` for preview and Home publish.
- `home/actions.ts` (7 lines) — `publishSaved`.
- `tab/PreviewTab.tsx` (113 lines) and `tab/siteTokens.ts` (11 lines); `TabKind "preview"` (`app/tabs.ts:11,106`); `ShellBridge.openPreview` (`app/bridge.ts:22`, `app/Shell.tsx:132`); `tab/TabApp.tsx:11`.
- Session publish API: `PublishState` (`session.ts:49`), `publish/unpublish` (`:216-242`), `meta.published/changedSincePublish`.
- Editor chrome: `PublishButton` (`figma/chrome.tsx:64-77`); main-menu Publish/Unpublish/View on site/Preview the saved draft (`figma/FigmaEditor.tsx:1620-1628`); present menu "View on site" (`:2471-2474`); status "Published · changed since / Draft" (`:2482-2485`); "Set as site page" (`:1605`) and its empty-state hint (`:2426`).
- `EditorTab` reporting `savedAt` on publish changes (`tab/EditorTab.tsx:29-31`).

### Slugs / site URLs / order
- `lib/slug.ts` + `lib/slug.test.ts` — Turkish transliteration, slug rules; `home/dialogs.tsx:16-61,97,134` Title+Slug form with hint `burakkoc.net/projects/<slug>`.
- `lib/siteConfig.ts` — `SMOOTH_SCROLL_ENABLED` (Turkish comments), `SITE_URL`. Used in `home/Home.tsx:5,230,312-313,376,460`, `app/Shell.tsx:6,236`, `figma/FigmaEditor.tsx:4,1627,2471,2474`, `cv/CVEditor.tsx:11,967`, `cv/CVPage.tsx:3,17`.
- Order: `ProjectMeta.order` (`types/project.ts:30-31`), `reorderProjects` (`lib/firestore.ts:226-233`), Home "Site order" sort + drag (`Home.tsx:46,152,249-266,389-405,531`), `prefs.ts:82` `Sort "order"`.
- Project fields `titleEn, category, year, description(En), coverImage, company` (`types/project.ts:9-21`) — portfolio metadata, not Figma file metadata.

### Home UI copy and views
- Sidebar: "Published" view (`Sidebar.tsx:90`), "burakkoc.net" team + "Admin" badge (`:96-101`), "CV" nav (`:105`), Drafts meaning unpublished (`Home.tsx:163-165`), Trash copy "Off the site…" (`Home.tsx:484`).
- Header breadcrumb "burakkoc.net" (`Home.tsx:433-436`), "View site" button (`:460`), account menu "Open burakkoc.net" (`:376`).
- Filters published/drafts/changed (`Home.tsx:45,50-51`), `SiteStatus` Live/Changed badge (`FileCard.tsx:42-55`), list "Site" column (`Home.tsx:522`, `FileCard.tsx:169`), category·year subtitle (`FileCard.tsx:164`), thumbnail label "burakkoc.net" (`FileCard.tsx:35`).
- Context menu site items: View on site, Copy link (site URL), Publish/Update on site/Publish again, Unpublish… (`Home.tsx:312-313,322-323`); Unpublish modal (`:566-591`); publish toast (`:226-235`); empty-state copy (`:630,632,637`).
- Turkish collation `fold()` and `localeCompare(..., "tr")` (`Home.tsx:48,186`); Library preview fixed `lang: "tr"` (`home/Library.tsx:82`); Versions window `tr-TR` dates (`figma/VersionsWindow.tsx:8`).
- Shell: "Copy link to the site page" (`app/Shell.tsx:236`), close-tab copy "the site changes only when you publish" (`:297`), `openCv` (`:77`); menu "New Project…" and "Open burakkoc.net" (`src/main/menu.ts:47,94`).

### CV (all of it)
- `cv/CVEditor.tsx` (994), `cv/CVPage.tsx` (850), `types/cv.ts`, `lib/cvDefaults.ts`, `getCVData/saveCVData` (`lib/firestore.ts:390-441`, `demo/firestore.ts:276-279`), `TabKind "cv"` (`app/tabs.ts:11,106`), `TabApp` branch (`tab/TabApp.tsx:11`), Home "CV" nav (`Sidebar.tsx:105`, `Home.tsx:38,55,420`). Components only the CV uses: `components/Footer.tsx`, `PageEntrance.tsx`, `TextScrollingEffect.tsx` (imported only from `cv/CVPage.tsx:6-13`).

---

## 7. Gaps vs real Figma (persistence/session/Home)
1. No autosave; explicit Save button, "Saved/Not saved" states and a conflict banner (`session.ts:27-30`, `chrome.tsx:29-62`). Figma saves continuously, shows offline state, and has no Save; it offers "Save local copy" (.fig).
2. Version history = last 20 manual saves of the project part only (`lib/data.ts:14`, `lib/firestore.ts:317`); Figma has autosave checkpoints plus named versions (title + description) covering the whole file.
3. Undo = 20 whole-state snapshots, lost on reload, no selection restore (`useUndo.ts:14`).
4. Variables/styles/components are global singletons (`lib/firestore.ts:259-280`), not per file; no "Publish library", no per-file library enablement, no update review (auto-upgrade via `currentLibrary` `systemLibrary.ts:37-57`), deleted components auto-detached on open instead of Figma's "missing component" state.
5. Variable modes are fixed light/dark (`types/design.ts:21-24`); Figma collections have arbitrary modes.
6. Files are identified by a site slug fixed at creation (`dialogs.tsx:10-13`); Figma files have opaque keys and freely renamable names.
7. Files cannot exceed ~1 MB of JSON (`lib/data.ts:17`); demo embeds images as base64 inside the file JSON (`demo/storage.ts:36-43`), hitting that limit after a few images.
8. Images: lossy WebP re-encode to ≤2560 px (`media.ts:8,30-51`), timestamp paths, global bucket shared by all files, plus a whole-bucket Images panel; Figma stores images per file by content hash (max 4096 px) and has no bucket browser.
9. Home lacks teams/projects/folders, move-to-project, rename, file types (FigJam/Slides/…), Import, Community, rendered thumbnails, server-side recents/starred, 30-day trash expiry, marquee selection.
10. Auth is single admin Google account; Figma has accounts, but a single-user clone needs none (or a local profile).
11. Tabs are iframes of one WebContents (`app/Shell.tsx:256-268`), not isolated WebContents per tab as in the target direction.

---

## 8. Problems (bugs, ceilings, debt)
1. **Document size ceiling** — whole file as one JSON string ≤1,000,000 bytes (`lib/data.ts:17`, `lib/firestore.ts:52-57,294-298`); every save rewrites the entire file twice (canvas + version, `:316-317`). Not viable for real Figma-sized files.
2. **Demo save not atomic** — rev check then separate `db.set` calls in separate IDB transactions (`demo/firestore.ts:210-246`); two tabs can both pass the check; a crash mid-save leaves meta/canvas/versions inconsistent.
3. **Coarse LWW / data-loss on Overwrite** — whole `design/variables` list etc. is one doc with one rev; `force` replaces the entire part (`lib/firestore.ts:308-334`, `chrome.tsx:53`), clobbering another tab's library/variable edits.
4. **No live sync between tabs** — no `onSnapshot`/BroadcastChannel anywhere (grep); each tab loads its own copy of the design system (`session.ts:92`) and only learns of others' changes via a ConflictError at save time; Home learns via `savedAt` (`Shell.tsx:129`).
5. **Publish race** — after `await save()` publish reads `latest.current` (`session.ts:220-224`), which can include edits made during the save; also `save()` returns `false` while another save is in flight (`:171`), so Publish/close-with-save report failure spuriously.
6. **Non-transactional order** — `createProject` computes `order` from a read outside the tx (`lib/firestore.ts:175-176`); concurrent creates collide. `reorderProjects` only renumbers non-trashed projects (`Home.tsx:251`), leaving trashed ones with clashing orders.
7. **Writes without rev** — trash/restore/publish/unpublish/reorder/CV save never check or bump `rev` (`lib/firestore.ts:212-233,370-388,439-441`); a project trashed elsewhere can still be saved by an open tab (`saveAll` only checks existence, `:313`).
8. **Version pruning best-effort** — outside the tx, failures only logged (`lib/firestore.ts:337`); each version doc up to 1 MB.
9. **Versions are partial snapshots** — only the project part; restoring re-detaches against the *current* library (`session.ts:246-255`), so an old version may not reproduce how it looked.
10. **Read amplification** — Home re-reads the whole `projects` collection on every focus/visibility/save (`Home.tsx:95-103`); `referencedUrls` reads every project's canvas and every published doc (`lib/firestore.ts:349-365`); `createProject` reads all projects (`:175`).
11. **Images never garbage-collected** with their files (`lib/firestore.ts:195`); "unused" scan ignores versions (`:343-348`), so deleting "unused" images can break restored versions. Demo `referencedUrls` skips the CV key (`demo/firestore.ts:254`), so CV images show as unused in demo.
12. **Demo Images "used" scope always empty** — `usedIn` only matches Firebase URLs (`figma/ImagesPanel.tsx:39-46`) while demo URLs are `data:` URLs.
13. **Demo storage memory/size** — all uploads loaded into memory at startup (`demo/storage.ts:17-23`), linear `storagePathOf` (`:52-55`), base64 inflates ~33%.
14. **Silent edit refusal** — edits that would break the Overview are dropped with no feedback (`session.ts:139,152`).
15. **`upgradeDocument` ignores extra pages** — only `doc.nodes` are upgraded, not `doc.pages[].nodes` (`figma/model.ts:594-600`).
16. **Identity = slug** across tabs, recents, starred, storage keys (`app/tabs.ts:16-17`, `prefs.ts:59-77`, `demo/firestore.ts:32-36`): renaming is impossible by design.
17. **Client-only admin check** — `ADMIN_EMAILS` contains the owner's address in source (`lib/auth.ts:11`); real protection depends on the site's rules (outside this repo).
18. **No tests for the data layer** — tests cover model/system logic (`figma/__tests__/system.test.ts`) but not `lib/firestore.ts`, `demo/*` or `session.ts`.
19. `window.confirm` in session/editor (`session.ts:263`, `FigmaEditor.tsx:1621`) — non-Figma UI; Turkish leftovers ("Kaydet" in `useUndo.ts:6`, `CVEditor.tsx` comment).

---

## 9. Reusable for the Figma clone
- **Backend-swap pattern** (`vite.shared.ts:14-23` + `typeof Real` signatures): turn into an explicit `Store` interface with a local implementation now and a Firestore one later.
- **`demo/db.ts`** as the seed of the local store — but restructure into real object stores (files, file meta, nodes-or-blobs, images by hash, versions, prefs) and do each save in **one** readwrite transaction.
- **Error vocabulary** (`lib/data.ts:24-50`), especially `StoredDataError` semantics: never overwrite what could not be read (`lib/firestore.ts:119-130`).
- **Per-part rev / optimistic concurrency** — keep as a per-file (or per-node) version for multi-window safety even with a single user.
- **Session skeleton** (`session.ts`): load → baseline → reference-diff → write changed parts; becomes "pending changes → debounced autosave" with the same diffing.
- **Tombstones + detach** (`systemLibrary.ts:99-240`, `designSystem.ts:88-133`) — logic to keep values when a variable/style/component is deleted; reusable when a library is unpublished or a component is removed (Figma shows "missing" rather than auto-detach, so adapt).
- **Signature-based seeded-library upgrade** (`systemLibrary.ts:37-57`) — basis for library update detection ("updates available").
- **`useUndo`** as a stopgap until the engine owns undo; its coalescing rule is Figma-like.
- **Home UI skeleton**: Sidebar/NavItem, FileCard/FileRow, Pill menus, grid/list, selection model, keyboard map, context menu, toast with Undo, back/forward, Trash restore/delete-forever dialog, Starred section, `ago()`/`longDate()` (`home/time.ts`), `prefs.ts` `store<T>()`.
- **Tabs reducer** (`app/tabs.ts:42-96`) and the shell's unsaved-work flow (`Shell.tsx:80-118,184-209`) — map to "flush pending writes before close".
- **Upload pipeline pieces** — `checkUpload`, `webSized` (retune to Figma's 4096 px, keep originals), resumable progress callback shape (`lib/storage.ts:26-50`).

---

## 10. Pointers for the new storage design (from what the current code shows)
- The current schema is a nested whole-file blob precisely because of Firestore's depth/size limits (`lib/firestore.ts:52-57`). A flat node table (node id → properties, with parent id + fractional position) avoids both limits and is what per-property LWW needs; local IndexedDB/SQLite can hold the same rows, so the later Firestore mapping is 1:1.
- Make variables/styles/components rows of the file that owns them, with a "published library" snapshot table per file and a "subscribed libraries" list per file, replacing `design/*`.
- Store images as content-addressed blobs (hash → bytes) referenced from paints by hash, scoped per file, with GC on file delete; never inline data URLs in documents (`demo/storage.ts:36-43`).
- Replace slug identity with opaque file keys and a renamable `name`; move Recents/Starred into the store (per user profile).
- Versions: autosave checkpoints + named versions as full-file snapshots (including local variables/styles/components), not only the project part.
