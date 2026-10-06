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

## Left to do

- Drive it in the built app with `scripts/drive.mjs` once `?files` is Home.
- Figma pieces with no counterpart here: Resources and Community, notifications, the account menu (theme switching and similar), FigJam / Slides / Make creation, sharing.
- Wording to confirm against Figma's current file browser: empty-state and toast copy. The menus match the menu bar ("Move to folder…", "Move to trash").
