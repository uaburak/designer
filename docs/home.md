# Home: the file browser

Home is Figma's file browser built on the store. It has Recents, Drafts, nested coloured folders, Starred and Trash, shown as cards or a list, with selection, context menus, dialogs and toasts. The code is in `src/renderer/src/files/`. It runs at `?files` (`main.tsx` lazy-loads `files/FilesApp.tsx`) and is built only from `@/ds`.

## Status (2026-10-06)

- Works in a browser on the data layer's dev store (`npm run web:demo`, then `/?files`). Light and dark have been checked in screenshots.
- `npm run typecheck`, `npm run lint` and `npm test` are green for `files/`: 3 test files, 43 tests.
- The desktop integration is making `?files` the only Home. Everything Home needs from the preload (`HomeApi`) is already called, behind feature checks.

## Structure

| File | What |
|---|---|
| `FilesApp.tsx` | `?files` entry. Imports `ds/global.css`, keeps the theme (`useThemeRoot`), mounts `TooltipManager` and `ToastHost`, gets the backend and renders `FileBrowser`. Calls `designer.ready()` once shown. |
| `FileBrowser.tsx` | The controller. Holds the location and its back/forward history, search, selection, rename, menus, dialogs, sort order, filter, the expanded folders, drag and drop, the keyboard handler and the menu-bar commands. |
| `Sidebar.tsx` | Account row, Search, Recents, the team, Drafts, All folders with the folder tree (disclosure chevrons, folder colours), Trash, and the collapsible Starred group. Drafts and folders accept dropped items. |
| `ItemsView.tsx` | The main area inside the DS `CollectionView`, which handles arrows, ⌘A, Esc, ⌫ and the marquee. Grid: `FolderCard` (up to four file thumbnails), then `FileCard`. List: `ListHeader` (Name and the date column sort) and `ListRow`, with `InlineEdit` for rename. |
| `dialogs.tsx` | New folder; Move to folder (a searchable tree; files can go to Drafts, folders to the top level, never into their own subtree); and the Delete forever / Empty trash confirmations. |
| `menus.ts` | Context-menu entries (pure). |
| `actions.ts` | Each change: the store call plus its toast, with Undo for Move to trash and Move to folder. |
| `model.ts` | Pure logic: locations and their store queries and titles, `FolderIndex` (tree, paths, hidden-by-trash, search, flatten), sorting, filtering, the item list, subtitles, the selection model (click, ⇧ range, ⌘ toggle, right-click, ⌘A, marquee, arrow moves) and labels. |
| `useWorkspaceData.ts` | Loads what a location needs and reloads on every workspace watch event (coalesced over 16 ms). |
| `storeAccess.ts` | The one door to the data: `getStoreClient().workspace`, `files.importFigBytes` and `thumbnailUrl()` from `@/store`. |
| `desktop.ts` | Everything that needs the shell: `openFile`, `newDesignFile`, `importWithShell`, `saveLocalCopy`, `onShellCommand`, `setMenuState`, `onReveal`. Each falls back to browser behaviour. |
| `parts.tsx` | `FolderGlyph`: the DS glyph in a folder's colour (`folderColor()`, the DS's `--ds-color-folder-*` tokens). |
| `__tests__/` | `model.test.ts`, `actions.test.ts` (on `memoryWorkspace.ts`, an in-memory `WorkspaceRepository` with the store's semantics), `fileBrowser.dom.test.ts` (happy-dom). |

## Data flow

1. `filesBackend()` returns `{ workspace, thumbnailUrl }` from `@/store`. In the desktop app that is the store client on the preload's port; in a plain browser it is the dev store, kept in localStorage and seeded with demo files.
2. `useWorkspaceData(repo, location)` loads `getWorkspace`, `getPrefs`, `listFolders`, the location's `listFiles` query, `listFiles({in:"starred"})` for the sidebar, and `listFiles({in:"folder"})` for every live folder (for counts and card previews).
3. `repo.watch()` events trigger a reload, so changes from editors, other views and Home's own actions come back the same way. Nothing is patched by hand.
4. Writes go through `actions.ts`. Layout and sort are stored in prefs (`setBrowsePrefs`). Sort order (A to Z / Newest first, reversed) and the file filter live only in the view.

### Store calls used

`files.importFigBytes` (Import in a browser, and `.fig` files dropped from Finder in both the app and the browser), `getWorkspace`, `getPrefs`, `setBrowsePrefs`, `listFolders`, `createFolder`, `updateFolder` (name, color, parentId), `listFiles` (recents, drafts, folder, starred, trash, search), `getFile`, `createFile` (browser only), `duplicateFile`, `renameFile`, `moveFiles`, `trash`, `restore`, `deleteForever`, `emptyTrash`, `setStarred`, `recordViewed` (browser only; in the app main records the view when the tab activates), `removeFromRecents`, `watch`.

### Shell calls used (when `window.designer` exists)

- `nav.openFile(fileKey, { title, background })`. "Open in new tab" passes `background: true`.
- `nav.newFile(folderId)`. Main creates the file and opens its tab.
- `files.import(folderId)`. Main shows the Open dialog and imports each `.fig`.
- `files.saveLocalCopy(fileKey)`, from the menu bar.
- `menu.onCommand`: `edit.select-all`, `edit.delete`, `file.delete`, `file.duplicate`, `file.rename`, `file.move`, `file.save-local-copy`, `file.new`, `file.import`.
- `menu.setState({ enabled })`, updated as the selection changes.
- `home.onReveal(({ fileKey }))`: Home goes to the file's Drafts, folder or Trash and selects it.

Thumbnails: `app://designer/_thumb/<key>.png?v=<n>` on the desktop, object URLs from the dev store in a browser (both through `thumbnailUrl()` from `@/store`).

In a browser, a file opens as `?editor&file=<fileKey>`, and "Open in new tab" opens a new browser tab.

## Behaviour

- **Sidebar**: Recents | the team: Drafts, All folders and the folder tree, Trash | Starred (folders and files; a starred file opens on click). Search filters files through the store and folders on the client (case- and diacritic-insensitive). Esc in an empty search field returns to where you were.
- **Top bar**: back and forward, a Breadcrumb (`All folders / … / Folder ⌄`; the current folder's chevron opens its menu), and the create buttons: New folder (All folders and folders), Design (new design file) and Import (Recents, Drafts and folders), or Empty trash (Trash).
- **Filter row**: All files / Design files, the sort menu (Sort by: Alphabetical, Date created, Last viewed, Last modified; Order: A to Z / Z to A or Newest first / Oldest first), and Grid / List view.
- **Selection**: click, ⇧-click (range from the anchor), ⌘-click (toggle), ⌘⇧ (add a range), marquee (⇧ or ⌘ adds), ⌘A, Esc, arrow keys (⇧ extends). A right-click keeps a selection that contains the item.
- **Keys**: Enter opens (a single folder navigates; files open). ⌫ / Delete moves to Trash; in Trash it asks before deleting forever.
- **Context menus**:
  - File: Open, Open in new tab | Copy link | Add to starred / Remove from starred | Duplicate, Rename, Move to folder…, (Recents) Remove from recents | Move to trash.
  - Folder: Open | New folder, Add to starred | Rename, Change color ▸ (No color, Red, Orange, Yellow, Green, Teal, Blue, Purple, Pink, Gray, with the current one checked), Move to folder… | Move to trash.
  - In Trash: Restore | Delete forever.
  - Empty area: New design file, New folder, Import…, or Empty trash….
- **Drag and drop**: drag cards or rows onto a folder card or row, a sidebar folder, or Drafts. Undo is offered. A folder can't be dropped into itself, and Drafts takes only files.
- **Import**: the Import button uses main's Open dialog in the app, and a file input in a browser. `.fig` files dropped from Finder go into the folder dropped on (card, row or sidebar), else the folder shown, else Drafts. Each failure is a red toast with the store's message: the dev store can't read zstd-compressed `.fig`s and answers `unsupported-format`. Files that aren't `.fig` are refused.
- **Toasts** (DS `showToast`):
  - "File moved to trash" / "3 files moved to trash" (Undo);
  - "Moved to ‹folder›" (Undo);
  - "File duplicated";
  - "… restored";
  - "… deleted forever";
  - "Trash emptied";
  - "Link copied to clipboard";
  - import results;
  - store errors (red).
- **Empty states**: one per location, plus "Couldn't load files" with Try again, and a missing or trashed folder with Go to All folders.
- **In an organization** (OrgMain.tsx; docs/multiplayer.md §14, §14.17; Designer 1.0.3):
  - Drafts has **Design** and **Import**. A folder has **New folder**, **Design** and **Import**. A team page has **New folder** and **Import**, which asks for one of the team's folders, since files in a team live in its folders (help.figma.com 360041003114 names only folders and Drafts).
  - Each page's blank area offers the same items on right-click (New design file, New folder, Import…).
  - `.fig` files dropped on the page go into that place; dropped on a folder card, they go into that folder. Org file and folder cards drag onto a folder card to move there.
  - Gating: a person who can't edit the folder or team sees none of these. A View seat is asked to upgrade.
  - Import goes through FileBrowser's `doImport(at)` / `importFilesAt(files, at)`.
  - The file menu: Open, Open in new tab | Copy link (`<server>/f/<key>`) | (Library analytics) | Rename, Move to… | Move to trash. In Trash: Restore | Delete forever (the owner and admins).
  - ⌫ / Delete moves the selected card to the trash.
  - Trash lists the person's trashed drafts first, then each team's trash.
  - Right-clicking the space row gives **Leave organization…**.
  - A deleted organization shows its admins **Restore organization**.

- **Personal Drafts in the cloud** (Wecra 1.1, docs/cloud.md §2 and §6): signed in, the personal space is the person (name and photo) with Drafts and Trash only — no All folders, folder tree or New folder; Drafts are the account's drafts on the server (records cached here, `FileMeta.cloud`), listed again when Home shows or comes to the front (`useCloud`). Offline, only files on this computer list, each "Available offline", under the offline line. Signed out or in the browser's dev store, the local workspace as above. Tests: `__tests__/personalHome.dom.test.ts`.

### As built 2026-10-19 — the owner's Home design and Home › Shared

- **The owner's design decides Home's look** (his Wecra frame, `docs/research/figma/live/owner-2026-10-19/owner-home-drafts-design.txt` and its pictures; after-shots in `owner-2026-10-19/after/`). His variables map to ours: `bg/bg` → `--figma-color-bg`, `bg/bg-secondary` → `bg-secondary`, `bg/bg-selected` → `bg-selected`, `border/border` → `border`, `border/border-selected` → `border-selected`, `app/card-border-hover` → `--ds-color-card-border-hover`, `text/text-secondary` → `text-secondary`, `icon/icon-disabled` → `icon-disabled`, `radius/medium` 5, the card's 9 → `--ds-radius-medium-large`.
- **File card** (`ds/components/FileCard`): 260 × 208 at the least (5:4; `--ds-size-card-width` 260), radius 9, the thumbnail over a 60 footer (`--ds-size-card-footer`) — name 11 / 550 over the date 11 / 450 secondary, 16 in (16 top, 12 bottom), a hairline on top; no kind badge. The star box 24 × 24, 6 in from the thumbnail's corner, on bg with a 1px ring, the outline star icon-disabled. Rings are inside strokes over the content (`::after`): 1px at rest, 2px card-border-hover on hover, 2px border-selected selected. Folder cards' hover ring is 2px too.
- **Sidebar** 240 with its border inside: the account's 24 photo at 16 and the name 13 / 550; Search a 207 × 32 pill at 16; rows' labels 13 / 450 (SidebarItem); the space row 11 / 550 at 16. **Top bar**: the title 13 / 450; Design and Import tinted pills without a ring (Design with the 24 design glyph). **Filters**: "All files" a ghost select, no line under the row, the grid right below it (cards at y 112).
- **Shared** (`{ kind: "shared" }`, under All projects — in Recents' place, which the owner removed): two tabs, **Shared with you** (files others shared, cards "From <name>") and **Shared by you** (the user's shared files, "Shared <time>"), newest share first (Date shared, either order), grid or list (Name / Shared by or Your role / Date shared), Open link…, a star on files this computer has a copy of; double-click opens the local copy (made the first time). Data: `FilesBackend.shared` (`SharedSource`: the store's `multiplayer.listRemote` / `openShared` over the store port — the server's `GET /files`, owner and invited). Signed out: "Log in to see shared files" with Log in; the server not answering: "Couldn’t load shared files" with Try again; nothing: "No shared files" / "You haven’t shared any files". Not there: projects shared with the person (the server has no such listing yet). Tests: `__tests__/sharedPage.dom.test.ts`, `ds/__tests__/fileCardStates.dom.test.ts`.

## File settings [ours]

Figma has no such screen; the owner asked for one (2026-10-19). Right-clicking a file card or list row (one file, any local
location, Starred in the sidebar too) offers **File settings…** just before Move to trash. It opens `FileSettingsDialog`
(`files/FileSettings.tsx`, `FileSettings.module.css`): the DS `Dialog`, large, draggable by its small header like
Manage libraries, with five `Tabs`. Images: `docs/research/figma/live/owner-2026-10-19/after/file-settings-*.png`.

| Tab | What | Where it comes from |
|---|---|---|
| Overview | Name; Location (Drafts, the team's folder path, Shared with you, or org / team / folder); Owner; Created; Last edited (by whom, from the room's last version's editors); Last viewed; Size on this computer; Size in the cloud; Versions; Branches; Comments (threads, open); Status (Local only / In your cloud drafts / Shared / In an organization); File key with Copy link | `workspace.getFile` / `listFolders`, `files.details`, `multiplayer.fileReport`, `branches.list` |
| Storage | Bars by kind — Document, Images, Videos and sounds, Versions, Developer previews, Thumbnail — on this computer and in the cloud, each with a legend (items, bytes); the owner's account quota (Storage, Files on the server, Developer previews: `QUOTA_LIMITS`, brand → warning at 75 % → danger at 90 %) | `files.details`; the report's `stored_items` sums; the report's `quota`, else `GET /me/usage` through the account bridge |
| People | Link access (owner: Only people invited / Anyone with the link can view / can edit); Who has access (role select Can edit / Can view / Remove for people who can share; Invited for pending); Requests to edit (Approve / Decline); Opened by (org files: their `fig_file_view` audit rows) | the Share dialog's own calls: `multiplayer.fileInfo`, `members`, `invite` (a role change), `removeMember`, `requests`, `answerRequest`, `setLinkAccess` |
| Activity | One log, newest first: local entries (created / imported, versions, editing sessions still in the journal with their change count, previews) marked "This computer", and the server's (org audit rows, or creation and invitations outside orgs; comments, replies, resolutions; branches and merges; previews; the room's versions and autosaves); Show (All activity, Edits, Versions, Sharing, Comments, Views), search, Show more (50 at a time, the server paged by `cursor`) | `files.details().activity` + `multiplayer.fileActivity` (`mergeActivity` keeps an event recorded on both sides once) |
| Settings | Starred; Available offline (local only / downloaded / not downloaded); Thumbnail size; Library status; Viewers can copy, save, and export (shared, owner); Libraries in this file (enable / disable each published library) | `workspace.setStarred`, `FileMeta`, `multiplayer.setViewersCanCopy`, `libraries.listAvailable` / `setEnabled` |

Signed out, the server parts say "Log in to see this"; a local-only file "Only on this computer"; a server that didn't
answer "Couldn't reach the server" — the local parts show in every case.

**The store** (`src/shared/store/fileSettings.ts` holds the types and the pure helpers): `files.details(fileKey)` —
`FileStore.diskUsage` reads the file's directory by kind (a version hard-linked to a snapshot counted once, by inode) and
its journal segments' frame headers straight from disk (nothing loaded or kept in memory), `LocalBlobs.stat` sizes each
image and sorts images from videos and sounds by their first bytes (`blobKind`); the dev store answers the same from
its memory. `multiplayer.fileReport` / `multiplayer.fileActivity` resolve the file's room key (a shared file's link,
an org copy's `space.key`, a cloud draft's `cloud.key`) and answer null signed out or for a local-only file.

**The server** (`server/src/fileReport.ts`, no migration): `GET /files/:key/report` (anyone with access; the quota
only for the owner) and `GET /files/:key/activity?cursor=&limit=&kinds=` (who was given access shows only to people
who can share). Both read existing records only: `files`, `users`, `stored_items` under `f:<key>:` and its previews'
`p:<id>:`, `branches`, `comments`, `previews`, `members`, `activity_log` (org files) and the room's `/room/versions`.
Tests: `server/src/fileReport.test.ts`, `src/store/fileDetails.test.ts`, `files/__tests__/fileSettings.dom.test.ts`.

**Not there**: images and videos on the server aren't told apart (`stored_items` keeps no type: all count as Images);
opens of files outside organizations aren't recorded (no audit log there); teams and organizations have no quota of
their own; org files' cards on an org's pages (OrgMain) don't offer the item yet (they may have no local copy);
per-file comment or Dev Mode notification settings aren't readable through the store yet.

## Left to do

- Drive it in the built app with `scripts/drive.mjs` once `?files` is Home.
- Figma pieces with no counterpart here: Resources and Community, notifications, FigJam / Slides / Make creation, sharing.
- Wording to confirm against Figma's current file browser: empty-state and toast copy. The menus match the menu bar ("Move to folder…", "Move to trash").
