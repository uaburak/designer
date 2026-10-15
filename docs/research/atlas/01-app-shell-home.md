# 01 — App shell, Home and the file browser

Figma Design desktop 126.9.13, read 2026-10-16 under `~/.cache/figma-rea/BRIEF.md`. Figma's code is not copied here:
this file records behaviour, numbers, enums and strings, each with its evidence. CONFIRMED = read directly in the
build; INFERRED = deduced from code shape, naming or a help-site page.

## 1. Scope and sources

**Scope.** The desktop shell (window, tab bar, tabs, tab groups, split tabs, tab menus, native menus, deep links,
update flow, tab discarding, error tabs), the desktop "new tab" page, and Home — the web file browser: sidebar,
toolbar, view bar (sort / filter / grid-list), tiles and list rows, tile actions, trash, folders, pins, starred and
custom sidebar sections, search, account menu, plan badges and banners, empty states, drag and drop.

**Sources read**

| Source | What it gave |
|---|---|
| `/Applications/Figma.app/Contents/Resources/app.asar` (read-only; its header parsed and files read into the session scratchpad, never into the repo) | `package.json` (version 126.9.13, only dependency chokidar); `build.json` (channel stable, `com.figma.Desktop`); `main.js` (3.6 MB, the Electron main process: menus, tab model, tab history, URL routing table, discarding, updater, protocol); `desktop_shell.js` + `desktop_shell.css` (the tab-bar renderer and its CSS Modules, **with English strings inline**); `i18n/*.json` (7 locales of the desktop strings). |
| `main.js` English dictionary | 221 `desktop.*` keys with their English text (menus, dialogs, tab context menu). |
| `desktop_shell.js` English dictionary | 110 `desktop.shell_app.*` keys with English (tab bar labels, error tabs, time-ago, tab groups, tab preview). |
| Figma desktop HTTP cache (`~/Library/Application Support/Figma/DesktopProfile/v43/Cache`) | `figma_app-c7b8d47c51164da1.min.css` (3.7 MB, decompressed in the scratchpad): the web app's CSS Modules — sidebar, sidebar rows, tile grid, resource tiles, page view, new-tab page, recent files. |
| `~/.cache/figma-rea/figma/1860.min.js` (= `4337.min.js`, same build) | The file browser: sidebar composition, Drafts / Recents / Admin rows, custom sections, pinned files, default sort configs. |
| `5915.min.js` | The view-bar controls: sort menu (keys, default direction per key, direction labels), creator / file-type / role / shared-with / plan filters, grid-list toggle. |
| `1194.min.js` | Tile action menu (groups and items), tile subtitle ("Edited …", "Trashed by you …"), list-view column headers. |
| `7621.min.js` module 276288 | Relative-time formatter (thresholds, refresh cadence, compact form). |
| `figma_app.min.js` | Desktop new-tab page, folder depth rule, recent-searches query shape, favourites limit. |
| `5020.min.js` | Account switcher / settings dropdown items. |
| Prior research | `docs/research/figma/R20-home-org.md` (help-site Home in an org; summarised in §9), `R16-notifications.md`, `R17-settings.md`, `R13-multiplayer-sharing.md`. |

The web build carries i18n keys only; English for web keys below comes from help-site research (R20) or is left as
the key. The desktop shell strings are real English (both bundles embed `{string:"…"}` for every key).

## 2. Window and tab bar (desktop shell)

### 2.1 Geometry and styling — CONFIRMED (`desktop_shell.css`)

| Element | Value | Evidence |
|---|---|---|
| Tab bar height | 38 px, 1 px bottom border `--color-bordertranslucent` | `.tab_bar--container{height:38px;border-bottom:solid 1px …}` |
| macOS traffic-lights spacer | 80 px, draggable, right border | `.tab_bar--trafficLightsSpacer{flex:0 0 80px}` |
| Draggable strip above tabs | 10 px tall, full width, fixed at top | `.tab_bar--draggableTopRegionElement{height:10px}` |
| Title-bar spacer (empty area after the tabs) | flex-grow, min 24 px, 38 px tall, window-drag region | `.tab_bar--titleBarSpacer{min-width:24px}` |
| Home (file-browser) tab and Community tab | 40 × 38 px, icon centred | `.tab--fileBrowserTab,.tab--communityTab{flex:0 0 40px;height:38px}` |
| New-tab "+" button (UI3) | 24 × 24, radius 5, margin 0 7 px, transparent; hover `--color-bgtransparent-secondary-hover`, pressed `…-pressed`; 100 ms bg/colour transition | `.tab_bar--newTabButtonUI3` |
| Tabs menu button ("Open and recently closed tabs") | 40 × 38 px at the right | `.tab_bar_options_menu--tabOptionsButton{height:38px;width:40px}` |
| Windows caption buttons | 50 × 38 px; close hover `#e81123`, pressed `#bf0f1d` | `.tab_bar--captionButton`, `.tab_bar--closeCaptionButton` |
| Update button wrapper | after the traffic lights, padding-right 8, margin-left 8, right border | `.tab_bar--updateButtonWrapper` |
| File tab | min-width 40 px; inner button padding 0 8 px, column gap 8 | `.file_tab--fileTab{min-width:40px}`, `.file_tab--fileTabButton` |
| Tab title | max-width 200 px, padding-right 32 px (16 when the title is empty), right edge faded by a mask gradient (8 px) instead of an ellipsis | `.tab--text{max-width:200px;padding-right:32px;…mask-image…}` |
| Rename-in-place input | min 5, max 180 px, margin-right 32 | `.file_tab--editingInput` |
| File-type icon | 24 × 24, margin-right −4; collapses to width 0 (margin −8) with a 100 ms ease transition | `.file_tab--fileIcon`, `--fileIconCollapsed` |
| Tab close / mute buttons | 24 × 24 | `.tab--button`, `.file_tab--actionIconContainer` |
| Active tab | background `--color-bg`; inactive tabs transparent; hover `--color-bghovertransparent`; reduced transparency → `--color-bg-disabled`; a 1 px bottom line mixed 10 % opposite colour | `.tab--activeTab`, `prefers-reduced-transparency` rule |
| Focus ring | 2 px `--color-border-selected`, offset −2 | several `:focus-visible` rules |
| Tab enter animation | 120 ms (`tabEnter`, fade from 0) | `.tab_bar--tabEnterAnimation .tab_bar--tabAnimationTarget{animation-duration:.12s}` |
| Tab leave animation | 150 ms | `.tab_bar--tabLeaveAnimation … .15s` |
| "+" hide animation | 120 ms step-end | `.tab_bar--newTabButtonHideAnimation` |
| Loading spinner on a tab | 1 s linear per turn; task-status spinner 2 s | `file_tab--spin` |
| Live message (e.g. "Mentioned by …") | slides up 5 px in 350 ms, max 200 px | `.file_tab--liveMessage` |
| Staging tooltip ("factory tab") | 6 × 8 px padding, radius 5, max 240 px, appears after 1.5 s | `.tab--factoryTab:hover:before{transition:visibility 0s linear 1.5s}` |

### 2.2 Tab hover preview — CONFIRMED (`desktop_shell.css`, `desktop_shell.js`)

- A card under the hovered tab: padding 8, radius 13, 0.5 px translucent border; thumbnail 16:9 (radius 8,
  `object-fit: cover` top-aligned for Design files, `contain` + 5 px padding for canvas/FigJam images, FigJam gets a
  10 px dot-grid background); title 13 px medium; date line 11 px secondary, max 210 px; face pile with −8 px overlap.
- Appears with `opacity` 250 ms ease-in after a **600 ms** delay while the tab bar is hovered; immediately when the
  tab bar has keyboard focus (`.file_tab_preview--isTabBarHovered{transition:opacity .25s ease-in .6s}`).
- Date line: `desktop.shell.app.edited_time` "Edited {time}" or `last_viewed_time` "Last viewed {time}". Optional
  memory line: "Memory usage: {memory}MB/GB" or, for a discarded tab, "Offloaded tab: {memory}MB freed up".
- Shell time-ago (`desktop_shell.js` fn `dP`): seconds < 60 → "{n} second(s) ago"; minutes < 60; hours < 24; days
  < 30 ("yesterday" for 1); months < 12 ("last month" for 1); then years ("last year" for 1). Values truncated (`~~`).

### 2.3 Tab kinds and features — CONFIRMED (`main.js`, `desktop_shell.js`)

- Fixed tabs: **Home** (file browser, label "Home"), optional **Community** tab (label "Community", tooltip "Figma
  Community"), the **new-tab page** (`/desktop_new_tab`). Community plugin tabs are titled "{pluginName} (Community)";
  new files "Untitled" unless `?name=`.
- **Pinned tabs** (`isPinned`, context menu Pin / Unpin; aria "Pinned tab: {tabTitle}"). Pinned tabs are never
  discarded and cannot join a tab group.
- **Tab groups**: named "Group {number}" by default; colours blue, red, yellow, green, purple, pink, persimmon, grey
  (swatches 12 px, `--ramp-pale-*-400`, grey `--ramp-grey-400`); group menu: Edit group name, Group color, Ungroup,
  Delete group. In a group, tabs become 24 px pills (radius 5, margin 0 2 px); the active one gets
  `--color-bg-brand-tertiary` + brand border. Name input min-width 172.
- **Split tabs**: two files side by side in one tab ("Split tab group: {tab1}, {tab2}"); commands "Open in Split
  Tab" and "Separate Tabs"; drop zones on drag.
- Tabs show mute buttons (audio), chat status ("Generating response", "New response", "Response failed"),
  spotlight ("Spotlight on {handle}", "You are spotlighting"), mention ("Mentioned by {handle}").
- Drag and drop reorders tabs, moves them between windows (`tabDragEnterTabBar`/`LeaveTabBar`), Esc cancels a drag.

### 2.4 Tab context menu — CONFIRMED (`main.js` @3611037, fn `DSr`)

Order (items hidden when not applicable):

1. Pin / Unpin
2. Copy Link (⌘L) — only for shareable tabs (not new-tab or `/new/`); strips `viewport` from the URL
3. Rename File (when the tab can rename; switches to the tab first, then edits the title in place)
4. Reload (reloads with `clearCache`)
5. — separator —
6. Remove from Tab Group / Add to Tab Group › New Tab Group, —, existing groups (not for pinned or Community tabs)
7. Move to New Window (one window) or Move to Another Window › New Window, —, "{tabName} and # Other Tab(s)" per
   window (hidden for split tabs)
8. Separate Tabs / Open in Split Tab (when allowed)
9. Open in Browser (adds `skip_desktop_redirect=1`)
10. — separator — Close, Close Other Tabs, Close All Tabs

New-tab page's menu: Reload, —, Close. Home tab's menu: Copy Link, —, Reload.

### 2.5 Tabs dropdown (right end of the bar) — CONFIRMED (`desktop_shell.js`, `.css`)

"Open and recently closed tabs" — a combobox (280 px filter, rows ≥ 24 px, max height 80 vh) with a search field
"Search tabs", sections "Tabs in this window", "Tabs in window {windowIndex}", "Recently closed tabs"; each open row
has hover-only Close / Mute buttons. Empty: "Your open tabs and recently closed tabs will appear here" (min 85 px,
264 wide); no match: "No matches found".

### 2.6 Recently closed tabs — CONFIRMED (`main.js` @1137258, @3393345)

| Rule | Value |
|---|---|
| Kept in history | 100 records (`MAX_RECENTLY_CLOSED_TABS_RETAINED`), persisted in settings (`sharedTabHistory`) |
| Shown in File › Recently Closed Tabs | last 8 |
| Filtering | newest first, only the current user's (`userId`), de-duplicated by path |
| Reopen | ⌘⇧T pops the last record |

### 2.7 Startup restore and tab discarding — CONFIRMED (`main.js` @3428537, @3429632)

| Rule | Value |
|---|---|
| Tabs loaded live at app start | 15 most recently viewed (6 when a proxy is detected); the rest restored "discarded" (URL kept, loads on view) |
| Discard sweep | every 1 h, and after the app regains focus following > 4 h of inactivity |
| Candidate | not visible, not pinned, has web contents, Design/FigJam-type tab, last viewed (or created) > 48 h ago |
| Run only when | total tabs ≥ 5, not within 30 min of the last reset, not after > 4 h idle, and memory likely allows loading |
| Keep live | at least 3 non-discardable tabs; oldest candidates discarded first |
| Debug | "Discard Tab (In 5 Seconds)" in the internal menu |

### 2.8 Error tabs and offline — CONFIRMED strings (`desktop_shell.js`)

In-tab error pages (not dialogs): connection error ("Connection error: {errorCode}", "Your computer may be offline or
the Figma server may be experiencing problems.", "Figma will automatically try to reconnect.", button "Try again");
403 ("You can't access this resource"); 404 ("Not found ({statusCode})"); 407 proxy auth; 502/503 ("Temporary
outage ({statusCode})", maintenance); generic 5xx ("Server error ({statusCode})"); crash ("Something went wrong",
"Reloading Figma may fix this.", Reload / Close tab, "Reason: crashed"). Footer "For help, visit {helpPageUrl} or
contact {supportEmail}." Loading-window failure: "Oops something went wrong" / "Figma failed to load" / Try Again.
The reconnect back-off timing was not located (Open questions).

Close-with-unsaved dialogs: "You have unsaved changes" — "Closing the tab won't lose your changes, but you'll have
to reconnect to sync the changes." [Close Tab]; window close / log out while saving: "Discard Unsaved Changes?";
import running: "File import in progress" [Close Tab / Keep Tab Open]; merging: "Hang tight! Still merging…".

### 2.9 Native menus and shortcuts — CONFIRMED (`main.js`)

| Command | Accelerator |
|---|---|
| New Window | ⌘⇧N |
| New Tab | ⌘T (opens the new-tab page) |
| New Design File (hidden item) | ⌘N |
| New FigJam File (hidden item) | ⌘⌥N |
| Open File Browser | ⌘O |
| Close Tab | ⌘W (when a window has no tabs, ⌘W closes the window) |
| Close Window | ⌘⇧W |
| Reopen Closed Tab | ⌘⇧T |
| Copy Link (tab menu) | ⌘L |
| Select Previous / Next Tab | ⌃⇧Tab / ⌃Tab; also hidden ⌘⇧{ / ⌘⇧} |
| Minimize | ⌘M |
| Interface Scale: Reset / Larger / Smaller | ⇧⌘⌥0 / ⇧⌘⌥= / ⇧⌘⌥- (submenu shows "{n}%") |
| Toggle Web App Developer Tools | ⌘⌥I; Tab Bar dev tools ⇧⌘⌥I |

Other desktop menu items: File › Open File URL From Clipboard (error "Invalid Figma URL" / "The clipboard does not
contain a valid Figma URL."), Save Local Copy…, Save to Version History, Show Version History, Export…, Import…;
Help › Help Page, Video Tutorials, Release Notes, Legal Summary, Support Forum, Troubleshooting (Save Debug Info…,
Save Network/Performance Log… with a 30 s wait, Reset Figma and Restart, Disable Hardware Acceleration, Graphics
Backend, Prefer High-Performance GPU); View › Color Management › Color Space (Managed / sRGB / Unmanaged), Always
Show Tabs When Presenting; Preferences › Show Figma in Menu Bar, Enable Trackpad Haptic Feedback. On Windows the
app menu opens at (window width − 200, 38) (`main.js` @3615974).

### 2.10 Deep links and URL routing — CONFIRMED (`main.js` @920841, @1151587, @3582833)

- Protocol per channel: `figma` (stable), `figma-beta`, `figma-gov`, `figma-sycamore`, `figma-dev`; registered with
  `setAsDefaultProtocolClient` at launch. `figma://X` is rewritten to `https://www.figma.com/X` and routed like any
  URL. macOS `open-url` and `open-file` (a .fig) are handled; a second instance forwards its argv to the first.
- File key pattern `[0-9a-zA-Z]{22,128}`. Rules (first match wins): image URLs and `?openInBrowser` → external;
  `files/…/feed` → bell feed; `files|idle_timeout|my_plugins|user|org|team` → FILE_BROWSER; `c|community|@handle`
  → COMMUNITY; `file/new`, `design/new`, `board/new|jam`, `slides/new` … → new file (title from `?name`, else
  "Untitled"); `file|design|board|slides|site|buzz|rev|make|weave|spec/{key}(/branch/{key})(/{slug})` → EDITOR with
  the tab title taken from the slug (dashes → spaces, URI-decoded); `proto/…` → PROTOTYPE; `deck`, `presenter`,
  `export`; anything else → open in the system browser. The table can be replaced by a server-sent config
  (≤ 1 MB, versioned by API version).

### 2.11 Updates — CONFIRMED (`main.js` @3376868, strings)

- Automatic check at start and **every 3 h** (Squirrel on macOS). A ready update shows **"Update now"** in the tab
  bar (left, after the traffic lights) and a dialog "Update Available" — "A new version of {appName} is ready to be
  installed." [Install now] [Install on next launch]. Manual "Check for Updates…": "No Update Available" … [Reload
  All Tabs]; failure "Update Error" [Download update manually]. A separate runtime-updater poll exists for web assets.

## 3. Desktop new-tab page — CONFIRMED (`figma_app.min.js` @1459858, CSS)

- Centred column, max 800 px (`calc(100vw − 2rem)`), top padding 97 px (64 with the folder dropdown), sticky top
  section with a shadow (0 2 4 30 % black, 150 ms) once scrolled.
- Row of file-type buttons (`desktop_new_tab.file_type.*`: design, figjam, slides, site, buzz, prototype, spec, repo,
  templates…), then **"Create new file in"** dropdown (team avatar 16 + "team / folder path", "See more editable
  folders", or Drafts), placeholder 275 × 27 while loading.
- "Recents" header (13 px, weight 550; "No recents" variant) and a list of recent files: rows 58 px, gap 16,
  thumbnail 48 px high 16:9 with a 14 px type badge, title 11 px (375 px, tooltip when truncated), capitalised
  relative time, face pile of people in the file; hover `--color-bg-hover`, keyboard focus `--color-bg-selected`;
  arrow keys move focus (smooth scroll into view). Placeholders fade 200 ms; a 2 s guard before the placeholder
  swaps. Footer link "browse more recent files" → Home › Recents.

## 4. Home layout and sidebar

### 4.1 Layout — CONFIRMED (CSS)

| Element | Value | Evidence |
|---|---|---|
| Sidebar | 240 px, `--color-bg` | `.sidebar--navContent{width:240px}` |
| Sidebar section header | 32 px tall, name weight 600 | `.sidebar--sectionHeaderContainer{height:32px}` |
| Sidebar row | 28 px, margin 2 px 8 px (32 px pitch), padding 0 4, radius `--radius-medium`, gap 8; hover `--color-bg-secondary`; selected `--color-bg-selected` + 1 px inner outline | `.sidebar_row--sidebarRow` |
| Sidebar divider | 1 px `--color-border`, margin 8 0 | `.sidebar--divider` |
| Mobile nav | slides in by 241 px | `.sidebar--showMobileNav` |
| Page header | below 645 px width collapses to a mobile header | `iN` `(min-width: 645px)` |
| View bar | sticky at top 49 px, padding 0 34 0 32 | `.file_browser_page_view--viewBarWrapper` |
| Tile grid | padding 24 32 32; gap 32 × 32; columns `repeat(auto-fill, minmax(264px,1fr))` (medium) or `minmax(396px,1fr)` (large) | `.tile_grid--grid*` |
| Thumbnail | 16:9 (`padding-top:56.25%`), radius 6, 1 px `--color-border` ring, selected 2 px `--color-border-selected` | `.resource_tile--aspectRatioContainer`, `--resourceTileImageContainer` |
| Tile meta | margin-top 12, gap 8; title weight 500, 1 line; meta 11 px secondary | `.tile_meta--*` |
| Scroll edges | a top border fades in once content scrolls (`--sticky-top-border-opacity`) | module 674290 |

### 4.2 Sidebar order — CONFIRMED order of components (`1860.min.js` @593300), names INFERRED where noted

1. Top block (account switcher, search, notifications) — `n6` (R20 lists account menu, Search, bell).
2. **Recents** (`view: recentsAndSharing`), then a Community / Resources entry when enabled (`a$`; "Community" opens
   in a new tab: `sidebar.open_community_in_new_tab`).
3. Divider; an AI/assistant entry point (`aq.b`, INFERRED).
4. Team-scoped list: team feed (`n2`, when enabled), shared projects (`aA`), **Drafts** (with a hover "+" New file
   menu, drop target for files), then for a team: **All projects / All folders** (`sidebar.all_projects.fmr`),
   Design systems (when enabled), CMS (alpha, flag), **Trash** (`deletedFiles`), team admin (`aG`).
5. Upgrade section between content (or in the footer for Starter).
6. Org-scoped list: **All teams / All workspaces** (`sidebar.browse.*`), Design systems, CMS, Trash, **Admin**
   (badge; org admins → Admin dashboard, billing-group / workspace admins → their dashboards; hidden on mobile).
7. Custom-sections banner ("custom_sections_banner_*", dismissible, button creates a section at index 0).
8. **Starred** and **custom sidebar sections** (favourites): sections can be created, renamed, deleted (with
   confirmation), moved up/down; starred items moved up/down; "Move these starred items" when switching plans.
9. Footer (upgrade banner `n5` when placed in the footer).

Drafts click ignores ⌘/Ctrl-click and non-primary buttons (opens in place only on a plain left click).

## 5. Toolbar, view bar, sort and filter — CONFIRMED (`5915.min.js`)

### 5.1 Sort keys

| Key | Label key | Default direction (when picking the key) | Kind |
|---|---|---|---|
| NAME | `tile.sort_filter.sort_alphabetical` | ascending | alphabetical |
| CREATED_AT | `sort_date_created` | descending | time |
| TOUCHED_AT | `sort_last_modified` | descending | time |
| ACCESSED_AT | `sort_last_viewed` | descending | time |
| TRASHED_AT | `sort_date_trashed` | descending | time |
| SHARED_AT | `date_shared` | descending | time |
| PROJECT_NAME | `tile.sort_filter.team` | ascending | alphabetical |
| SEARCH_RELEVANCE | `tile.sort_filter.trending` | descending | other |

Direction labels depend on the kind: time → "oldest first / newest first"; alphabetical → "A to Z / Z to A";
other → ascending / descending. The menu has two groups, "Sort by" (only when > 1 key) and "Order". If the current
key is not offered in a view, the view switches to its last key.

### 5.2 Per-view sort keys and defaults — CONFIRMED (`1860.min.js` @248544, `3083.min.js`, module `pI`/`xi`/`fs`)

| View | Sort keys | Default | Filters |
|---|---|---|---|
| Folder / Drafts | Alphabetical, Date created, Last modified (Date created only with the new folder model) | Last modified, newest first | Created by, File type, view mode |
| Team page (folders) | Alphabetical, (Date created), Last modified | Last modified ↓ | — |
| Recents | Last viewed | Last viewed ↓ | Created by: any; File type: any (+ Prototypes); plan filter |
| Shared with you | Date shared (also Name, Created at, Shared at in some lists) | Date shared ↓ | Shared by, Shared with (all / you directly / user groups), plan |
| Trash (files) | Date trashed | Date trashed ↓, creator = **you** | Created by, File type |
| Trash (folders) | Date trashed, Alphabetical | Date trashed ↓ | Role: "can be restored / permanently deleted" (default) or "can be viewed" |

Filters: **Created by** anyone / you / others; **File type** all files (or "all types" with Folders when the new
folder model is on) + Folders, Design, FigJam, Slides, Buzz (flag), Sites (flag), Make, Spec (flag), Weave (flag),
Prototypes (Recents only), each with its product icon; **plan** filter grouped "default plan and all organizations"
/ "other plans". Every change logs `file_browser.filter_sort_updated`. Grid / list toggle is a segmented control
("Show as grid" / "Show as list").

### 5.3 List view columns — CONFIRMED keys (`1194.min.js` @65835–68472)

Star, Name, Last modified, Trashed at, Previous location, Created, Shared at, people (face pile), Owner, Shared by;
folder lists add Files, Location, Updated.

### 5.4 Tile subtitle — CONFIRMED (`1194.min.js` fn `G`)

- Default "Edited {time}" (prototypes "Viewed {time}"); Trash "Trashed by you {time}" / generic trashed; Shared tab
  "Shared by {name}" or shared date; imported files never edited since import "Imported {time}"; password-protected
  files a lock text (+ " · " + edited time); repos (branching) "{n} branches · ".
- Folder name prefix (with "(trashed folder)") precedes the time on Recents tiles.

### 5.5 Relative time ("Edited 3 hours ago") — CONFIRMED (`7621.min.js` @615220)

Uses `Intl.RelativeTimeFormat` (style long; `narrow` for Japanese) with moment-style buckets:

| Elapsed | Output |
|---|---|
| < 45 s | "just now" (`general.time.just_now_past`) |
| 45–90 s | 1 minute |
| 90 s – 45 min | n minutes (rounded) |
| 45–90 min | 1 hour |
| 90 min – 22 h | n hours (rounded) |
| 22–36 h | 1 day ("yesterday") |
| 36 h – 26 days | n days (rounded) |
| 26–45 days | 1 month |
| 45–320 days | n months (30-day months, rounded) |
| ≥ 320 days | n years (365-day years, rounded) |

Live refresh: every 30 s while < 1 h old, every 30 min while < 1 day, else every 6 h. Compact form (floor):
< 1 min just now, minutes, hours, days < 7, weeks < 30 d, months < 1 y, years. Absolute tooltip format:
month short, day, year, hour, minute.

## 6. Tile actions — CONFIRMED groups (`1194.min.js` @53186); item placement partly INFERRED

Menu groups in order, separators between groups:

1. **nav-open**: Open; Open in new tab (not in mobile / some embeds); Open with preview disabled (Make files); Show
   in folder.
2. **branching**: Create new branch.
3. **file-analytics**: Library analytics.
4. **favorite-pin**: Add to sidebar / Remove from sidebar (star); Pin to folder / Remove folder pin; Pin to
   workspace / Edit pin / Remove pin.
5. **copy-share-duplicate-template**: Copy link; Share (with "Request" / "Request sent" trail when an upgrade is
   needed); Duplicate (or "Duplicate to drafts"); Use in new file (templates).
6. **restore-rename-move-trash**: Version history (`fullscreen_actions.toggle-version-history`, not for Make/Weave);
   Rename (single file / repo / offline file); Restore / Restore to…; Move (files / folders / items); Remove from
   shared files; Remove from recent; custom actions; Move to trash (files / folders / items) / Delete forever.

Folders get their own action list (`tl`, min width 136). Multi-selection uses a separate menu (`ep`) with plural
labels ("Move items", "Trash items", "Duplicate" with a count suffix). Errors: "no permission to trash / restore".

## 7. Trash, delete and restore — CONFIRMED keys; retention INFERRED

- Trash view: Files / Folders tabs (`file_browser.tool_bar.trashed_files|folders`), empty state
  `trashed_empty_state`. Restore puts items back or opens a "Restore to" picker when the parent folder is trashed
  ("original parent folder was trashed").
- Move to trash confirmation (`confirm_file_trash_modal.*`) warns about: library files (subscribers lose access and
  updates), team templates, published Sites, Community files, unsynced offline files, pending asset transfers or
  resource connections. Folder trash shows subfolder and file counts.
- Delete forever (`confirm_file_delete_forever_modal`, `trash_warning.permanently_delete_*`): toast single / bulk.
- Retention: no number in the client. The help site and our cloud doc say files in Trash are purged after 30 days
  (Starter drafts); INFERRED, see Open questions.

## 8. Folders, pins, starred, search, account

### 8.1 Folders — CONFIRMED

- Nesting: a new subfolder is allowed while `depth + 1 < 10` → at most **10 levels** (`figma_app.min.js`
  @6822859); errors "depth exceeded" on create and move, "tree size exceeded" on move.
- Folder page: "Pinned" files row (max **8** pins, tooltip "max files", `1860.min.js` @49836), "Add file", suggested
  files; settings modal (Name, Description, team access: same as team / view only / disabled, connections).
- Folder title input maxLength 118 (`1860.min.js` page header, INFERRED to be the folder name).
- Bulk move errors: cross-org, pending asset transfer, published hub file, depth exceeded, different plan
  (drag and drop: "different plan" errors for files, folders, teams).
- Folder import from disk: tar.gz archive limit 1 GiB (`MAX_FOLDER_IMPORT_TAR_GZ_BYTES` 0x40000000).

### 8.2 Starred / sidebar favourites — CONFIRMED

Max **1000** favourites (`tile.favoriting.max_favorites`, `maxFavorites:1e3`, `1860.min.js` @529462); tooltip
"Add to sidebar" / "Remove from sidebar"; label "Star in sidebar"; toasts "file added to / removed from sidebar".

### 8.3 Search — CONFIRMED keys / shapes

- Placeholder `search.search_bar.placeholder_v2`; clear; "Ask agent" button; recent searches stored server-side per
  user and org (`recentSearches`, ≤ 100 rows, `{query, timestamp}`), filtered to the last N days and removable
  (`remove_recent_search_description`).
- Preview dropdown sections: Recent, Files ("See all results"), Folders, Teams, People, Orgs.
- Results page facets: Resource (Design, FigJam, Slides, Sites, Buzz, Make, Weave), Creator (anyone / you / name),
  Space (teams, workspaces, "All spaces"), Folder; "Clear all"; `filter_limit_reached`. Sort: relevance, last
  updated (touched_at), created, name, creator. Empty states: "no results matching", "try searching whole org".
  Too-long queries show `search.error.max_query_length_exceeded` (limit not found).

### 8.4 Account menu and plan badges — CONFIRMED keys (`5020.min.js`)

Settings, Theme ›, View community profile / Create a community profile, Saved from Community, Log out / Log out of
all accounts, Switch account, Add account. Plan badges: Free, Professional, Org, Enterprise, Edu, Government,
Locked, Guest, plus "full / limited team member access". Notifications bell: see R16 (disabled tooltip
`navbar.navbar.notifications_disabled_tooltip`).

### 8.5 Creation buttons — CONFIRMED keys (`file_browser.creation_buttons.*`)

Design, FigJam, Slide deck, Sites, Figma Make, Buzz (marketing asset), Weave, Spec, Folder, Import, More; badges
Alpha / Beta / Coming soon; disabled "by organization" / "by team". Import view: progress per file, cancel per row,
"Import to folder", PDF source picker, PPTX in the description.

## 9. Prior help-site research (R20) in one line each

- Sidebar per plan, teams, audience, joining, roles, folders (Inherited / Limited access), moving files, seat
  requests, org library analytics and team fonts: see `docs/research/figma/R20-home-org.md`. This chapter confirms
  its sidebar 240 / 32-pitch measures from CSS and adds the code-level order (§4.2).

## 10. UI strings

**Desktop (English attested in `main.js` / `desktop_shell.js`)**: Home; Community; Figma Community; Tab bar; Close
tab; Mute tab; Update now; Menu; Minimize; Maximize; Close; New file; Open and recently closed tabs; Search tabs;
Tabs in this window; Tabs in window {windowIndex}; Recently closed tabs; Your open tabs and recently closed tabs will
appear here; No matches found; Pin; Unpin; Copy Link; Rename File; Reload; Add to Tab Group; New Tab Group; Remove
from Tab Group; Group {number}; Edit group name; Group color; Ungroup; Delete group; Blue/Red/Yellow/Green/Purple/
Pink/Persimmon/Grey; Move to New Window; Move to Another Window; New Window; {tabName} and # Other Tab(s); Separate
Tabs; Open in Split Tab; Open in Browser; Close Other Tabs; Close All Tabs; Edited {time}; Last viewed {time};
Memory usage: {memory}MB; Offloaded tab: {memory}MB freed up; {n} second(s)/minute(s)/hour(s) ago; yesterday; {n}
days ago; last month; {n} months ago; last year; {n} years ago; Mentioned by {handle}; Spotlight on {handle}; You are
spotlighting; Generating response; New response; Response failed; Connection error: {errorCode}; Your computer may be
offline or the Figma server may be experiencing problems.; Figma will automatically try to reconnect.; Try again;
Something went wrong; Reloading Figma may fix this.; Not found ({statusCode}); You can't access this resource;
Temporary outage ({statusCode}); Server error ({statusCode}); Update Available; A new version of {appName} is ready
to be installed.; Install now; Install on next launch; No Update Available; Update Error; Download update manually;
You have unsaved changes; Close Tab; Discard Unsaved Changes?; File import in progress; Keep Tab Open; Hang tight!
Still merging…; Invalid Figma URL; New Window; New Tab; Open File Browser; Close Window; Reopen Closed Tab; Recently
Closed Tabs; Select Previous Tab; Select Next Tab; Bring All to Front; Interface Scale; Make Larger; Make Smaller;
Reset to Default; Open File URL From Clipboard; Save Local Copy…; Check for Updates…; Log Out.

**Web (keys; English only where R20 attests it)**: `sidebar.recents` (Recents), `sidebar.drafts` (Drafts),
`sidebar.all_projects.fmr` (All folders), `file_browser.tool_bar.trash` (Trash), `sidebar.admin_dashboard`
(Admin), `sidebar.starred` (Starred), `sidebar.browse.all_teams` (All teams), `sidebar.browse.all_workspaces` (All
workspaces), `sidebar.resources` (Resources), `sidebar.community`, `sidebar.new_file`, `sidebar.new_section`,
`sidebar.rename_section`, `sidebar.delete_section(_confirmation)`, `favorited_resources.add_to_sidebar`,
`favorited_resources.remove_from_sidebar`, `favorited_resources.star_in_sidebar`, `tile.favoriting.max_favorites`,
`tile.sort_filter.*` (§5.1), `tile.sort_filter.created_by_anyone|you|others`, `filter_by_*`,
`can_be_restored_permanently_deleted`, `can_be_viewed`, `fullscreen.view_mode.show_as_grid|list`,
`tile.dropdown.*` (§6), `tile.file_tile.edited_time|viewed_time|imported_time|trashed_by_you|trashed_generic|
password_protected|branch_count`, `file_browser.file_list_view.header_*`, `file_browser.trash_warning.*`,
`file_browser.confirm_file_trash_modal.*`, `file_browser.confirm_file_delete_forever_modal.*`,
`file_browser.pinning.*`, `file_browser.creation_buttons.*`, `file_browser.file_import_view.*`,
`file_browser.create_folder_error.depth_exceeded`, `search.*` (§8.3), `account_switcher.*`, `navbar.*` (§8.4),
`desktop_new_tab.*` (§3), `general.time.just_now_past`, `general.time.compact.*`.

## 11. DesignerV2 today

| Area | Status |
|---|---|
| Tab bar 38 px, 80 px traffic lights, 40 px Home | matches (`src/renderer/src/ds/tokens.css:37-42`) |
| "+" button | differs: 32 × 32 and it creates a design file, not the new-tab page (`TabBarApp.tsx:56`) |
| Tab width | differs: tab min 72 / max 240 vs Figma min 40 and title ≤ 200 with a fade mask |
| Tab enter / leave animations, hover preview card | missing |
| Tab context menu | differs: has Close / Close others / Close to the right / Copy link (disabled) / Show in file browser / Reopen; missing Pin, Rename, Reload, groups, windows, split, Open in browser, Close all (`src/main/tabs.ts:622-640`) |
| Pinned tabs, tab groups, split tabs, tabs dropdown with search | missing |
| Recently closed | differs: 20 kept (`src/shared/tabs.ts:64`) vs 100 (menu shows 8) |
| Shortcuts | ⌘N, ⌘W, ⌘⇧W, ⌘⇧T, ⌃Tab match; ⌘T, ⌘⇧N, ⌘O, ⌘⇧[ ], interface scale missing |
| Deep links | differs: `designer://`, looser key regex (`src/shared/multiplayer/types.ts:245`); no "Open File URL From Clipboard" |
| Update checks | differs: 24 h vs 3 h; "Restart to update" wording vs "Update now" / Install now / Install on next launch (`src/main/updater.ts`) |
| Startup restore / discarding | partly: all restored tabs lazy; no 15-live rule, hourly 48 h sweep or keep-3 |
| Error tabs | differs: native dialogs instead of in-tab pages |
| Desktop new-tab page | missing |
| Sidebar 240 / 28 / 32 pitch | matches (`tokens.css:69-71`); order differs, no custom sections, no Admin / Community rows |
| Grid | differs: fixed 268 px cards, gap 36, padding 0 32 48, radius 9 vs minmax(264) / 396, gap 32, 24 32 32, radius 6 |
| Sort | differs: one global list (`files/model.ts:219`) vs per-view keys; no Date trashed / shared; direction labels match |
| Filters | partial: All / Design only; no Created by, Trash role filter |
| Relative time | differs in thresholds: ours floors at 1 min / 1 h / 1 day / 30 d / 12 mo (`ds/util/time.ts:27`); Figma rounds with 45 s / 90 s / 45 min / 90 min / 22 h / 36 h / 26 d / 45 d / 320 d buckets and refreshes 30 s / 30 min / 6 h |
| Tile menu | partial: no Share, Pin, Version history, Show in folder, Create branch; group order differs |
| Trash retention 30 days | cloud drafts only (`docs/cloud.md:113`); no local purge |
| Folder nesting limit 10, 8 pins per folder, 1000 favourites | missing (no limits, no pins) |
| Search facets, recent searches, relevance | missing (name filter only) |

## 12. Open questions

1. Reconnect back-off of the connection-error tab — probe: disable the network in Figma desktop and time the retries.
2. Trash retention per plan (30 days Starter vs indefinite on paid?) — probe: help.figma.com "Delete files" article
   and an old trashed file in a paid team.
3. Search max query length and the recent-searches day window / count — probe: type a 300-char query; inspect the
   `recentSearches` payload in DevTools.
4. Exact English of web keys (e.g. `tile.sort_filter.sort_direction_newest_first`) — probe: switch Home to English
   and capture the sort menu (`scripts`-style live capture into `docs/research/figma/live/`).
5. Which tile-menu variables map to Move vs Remove from recent in group 6 — probe: right-click a file in Recents and
   in a folder.
6. When the "large" tile grid (396 px) is used — probe: compare Recents, folder and team pages at 1440 px wide.
7. Keyboard shortcuts inside the web file browser (Delete to trash, ⌘A, Enter, F2) — none found statically; probe:
   select tiles and press keys.
