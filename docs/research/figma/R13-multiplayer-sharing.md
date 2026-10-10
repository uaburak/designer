# R13-multiplayer-sharing — Figma's real-time collaboration, sharing and permissions (verified 2026-10-11)

Scope: what Figma Design (UI3, desktop app) does for multiplayer presence, following / spotlight, cursor chat and audio, the Share dialog, roles and link sharing, Home's shared views, and the offline / conflict / limit behaviour a user notices. Our contract is `docs/multiplayer.md`; the live DOM capture of the real UI is `live/multiplayer/README.md` (cited below as **[live]**) and `live/multiplayer/home-shared-files.txt` (**[live-home]**). Where help articles and the live capture differ, the live capture wins (help articles lag UI3; several still say "toolbar" for what UI3 puts in the right panel header).

Legend: quotes are Figma's own wording. **(unverified)** = not found in an official source or the live capture; **(forum)** = Figma Community forum, staff reply unless marked "user"; **(3rd party)** = secondary source.

Sources opened:
- help.figma.com Present to collaborators using spotlight — https://help.figma.com/hc/en-us/articles/360040322673
- help.figma.com Facilitate meetings with spotlight (FigJam) — https://help.figma.com/hc/en-us/articles/5025214483351
- help.figma.com Spotlight yourself or other presenters (Slides) — https://help.figma.com/hc/en-us/articles/24260248467735
- help.figma.com Use cursor chat in Figma Design — https://help.figma.com/hc/en-us/articles/4403130802199
- help.figma.com Use audio to chat with your team — https://help.figma.com/hc/en-us/articles/1500004414622
- help.figma.com How many people can be in a file at once? — https://help.figma.com/hc/en-us/articles/1500006775761
- help.figma.com Adjust your zoom and view options — https://help.figma.com/hc/en-us/articles/360041065034
- help.figma.com Share or embed files and prototypes — https://help.figma.com/hc/en-us/articles/360040531773
- help.figma.com File and folder permissions — https://help.figma.com/hc/en-us/articles/35361119554711
- help.figma.com Remove or adjust access — https://help.figma.com/hc/en-us/articles/360040530793
- help.figma.com Transfer ownership of files or folders — https://help.figma.com/hc/en-us/articles/360038512093
- help.figma.com Request to edit a file — https://help.figma.com/hc/en-us/articles/4408435431319
- help.figma.com Accept invitations — https://help.figma.com/hc/en-us/articles/1500008023902
- help.figma.com Add password protection to files and prototypes — https://help.figma.com/hc/en-us/articles/5726720100247
- help.figma.com Restrict copying and sharing on files — https://help.figma.com/hc/en-us/articles/360040045574
- help.figma.com Embed files and prototypes — https://help.figma.com/hc/en-us/articles/360039827134
- help.figma.com Guide to view-only access (Figma Design) — https://help.figma.com/hc/en-us/articles/22012921621015
- help.figma.com Design, prototype and explore layer properties in the right sidebar — https://help.figma.com/hc/en-us/articles/360039832014
- help.figma.com What can I do offline in Figma? — https://help.figma.com/hc/en-us/articles/360040328553
- help.figma.com View a file's version history — https://help.figma.com/hc/en-us/articles/360038006754
- help.figma.com Recents (file browser) — https://help.figma.com/hc/en-us/articles/14381406380183
- figma.com/blog How Figma's multiplayer technology works (Evan Wallace, 2019) — https://www.figma.com/blog/how-figmas-multiplayer-technology-works/
- figma.com/blog Multiplayer editing in Figma (2016) — https://www.figma.com/blog/multiplayer-editing-in-figma/
- figma.com/blog Behind the feature: autosave (2020-10-27) — https://www.figma.com/blog/behind-the-feature-autosave/
- figma.com/blog Talk it out in Figma and FigJam (2021-08-31) — https://www.figma.com/blog/talk-it-out-in-figma-and-figjam/
- developers.figma.com Embeds resources (URL formats) — https://developers.figma.com/docs/embeds/resources
- developers.figma.com Embed a Figma file — https://developers.figma.com/docs/embeds/embed-figma-file/
- forum.figma.com threads (cited inline)

---

## 1. Real-time collaboration

### 1.1 Presence model
- "Every user in the document gets an avatar in the top right corner." — https://www.figma.com/blog/multiplayer-editing-in-figma/ (2016; in UI3 this is the right panel header, [live]).
- "We show the cursor and selection of all active participants." — same post. Presence is ephemeral: the cursor, selection and viewport are not part of the document (cf. the 2019 tech post, which covers only document properties).
- Anyone with **can view** or **can edit** can follow, use cursor chat and audio; viewers' cursors are visible to others (the limits article ranks "Cursors of people with edit access" first when capping) — https://help.figma.com/hc/en-us/articles/1500006775761, https://help.figma.com/hc/en-us/articles/4403130802199.

### 1.2 Multiplayer cursors
- "If you're collaborating with other team members in a file, you will be able to see their cursors." "Collaborator names and cursors are shown next to their location on the canvas." — https://help.figma.com/hc/en-us/articles/360041065034
- Look: an arrow in the person's multiplayer colour with a name chip below-right in the same colour, white text **(unverified in help; Figma's well-known look, see [live] "Not captured")**.
- Hide others' cursors: Zoom/view options menu › "Multiplayer cursors" (checkbox), shortcut **⌥⌘\\** (Mac) / **Ctrl+Alt+\\** (Windows). "If you don't want to be distracted by other users, you can hide their cursors from your view." — https://help.figma.com/hc/en-us/articles/360041065034. Also in the main menu View › "Multiplayer cursors" (forum).
- The Zoom/view options items in that article: "Pixel preview", "Pixel grid", "Snap to pixel grid", "Layout guides", "Multiplayer cursors", "Property labels", "Prototyping" (viewers only).
- Hiding your own cursor ("private / incognito mode") does not exist: staff reply "Currently, there is no private view option, but you can disable the display of multiplayer cursors." (forum staff reply, seen via search; thread URL not pinned down — likely https://forum.figma.com/t/avatar-in-toolbar/84737); long-running request "Disable 'observe' mode" (forum, 150+ replies: https://forum.figma.com/suggest-a-feature-11/disable-observe-mode-18772).
- When hidden: a background tab draws no cursor for that session [live]. Other page: a cursor is drawn only for people on the page you are viewing (cursor coordinates are page-local) **(unverified in help; observed behaviour)**. Idle fade/hide after inactivity **(unverified — a 3rd-party guide claims an "Away" 50 % cursor; no Figma source)**.
- Cap: "Figma and FigJam will only show up to 200 multiplayer cursors to other users in a file at any one time"; "Figma and FigJam will always show the cursors of anyone being followed by other participants." (not counted toward 200); "If you join any time after this limit is reached, we will notify you that your cursor is hidden to other participants." — https://help.figma.com/hc/en-us/articles/1500006775761

### 1.3 Others' selections
- Shown as outlines in the selector's multiplayer colour (blog: "cursor and selection of all active participants") — https://www.figma.com/blog/multiplayer-editing-in-figma/. Exact style (stroke width, name tag on the selection) **(unverified)**. You cannot deselect someone else's selection (feature request "deselect another user's selection", forum).

### 1.4 Avatars (facepile) in the UI3 right panel header [live]
- Order left → right: other people, then **your own avatar fused with a count chip** at the right end (the "Multiplayer tools" button), then Present, then Share.
- Each avatar 24 px circle, cut out by a 2 px ring of the panel colour (avatars overlap ≈3 px, step 21–22 px); a **4×2 px bar above each avatar in the person's multiplayer colour** (yours #0c8ce9 blue).
- Count chip: 28 px circle bg #383838, "3" = people in the file including you.
- Another tab of the same account counts as another person (shown with its own avatar/colour) [live].
- Each other avatar is a button with the accessible name "Follow <name>" [live]; click = follow immediately (§1.5). Hover offers "Ask to spotlight" — https://help.figma.com/hc/en-us/articles/360040322673.
- Max avatars before overflow: **(unverified)** — no official number; the count chip is always there and the popover lists everyone.
- The person you follow gets an outer ring; a spotlighting presenter's avatar shows "a dashed border" — https://help.figma.com/hc/en-us/articles/360040322673.

### 1.5 Multiplayer tools popover (click your avatar + count) [live]
- 224 wide. Row 1: your avatar, "burak.koc" + "(You)".
- Row 2: primary blue button "Spotlight me" (156×24) + square button [Start conversation] (headphones — audio).
- Divider, then one row per other person: avatar + name, accessible name "Click to follow <name>", a [More options] button at the right (menu contents **(unverified)**; likely "Ask to spotlight").
- Screen-reader-only "2 users found".
- Help: "Hover over your avatar in the toolbar and click to open the Multiplayer tools dropdown" › "Spotlight me" — https://help.figma.com/hc/en-us/articles/360040322673.

### 1.6 Following (observation mode)
- Start: click a person's avatar ("Click on the user's avatar in the toolbar to automatically follow them") — https://help.figma.com/hc/en-us/articles/360040322673.
- What follows: their page and viewport — "track each movement you make on the canvas", including zooming and switching pages (spotlight article); a follower on another page is "teleported over" to theirs (forum user, 2021: https://forum.figma.com/suggest-a-feature-11/back-to-work-following-yourself-697 — feature request for "return to last location"). You see "their canvas actions and cursor". Toolbar and sidebar actions are **not** shared ("Your toolbar and sidebar actions aren't shared"). Your selection is not changed **(unverified; consistent with help)**.
- Look: "a border appears around your canvas in the color of the person's avatar, and a message at the top of the screen shows who you are following" — https://help.figma.com/hc/en-us/articles/360040322673. [live] measured: 5 px solid border round the whole window in their colour; a bar at top centre touching the top edge, bg = their colour, "Following <name>" 11px/500 + "Stop" button (bg a darker shade of the colour, 11px/600), bottom corners rounded ≈6 px.
- UI minimizes while following [live]: left and right panels replaced by floating pills (file name top-left; avatars + zoom + Present + Share top-right); toolbar stays.
- Stop: "click Stop following at the top of your canvas" (help) — the live UI3 button reads **"Stop"**; any canvas interaction (pan, zoom, click) also ends it [live].
- Privacy: "We won't tell someone if you follow them" / the presenter isn't notified, but your cursor stays visible to them "If they have Multiplayer Cursors enabled" — https://help.figma.com/hc/en-us/articles/360040322673. Followed people's cursors are always shown to everyone (limits article).
- No way to block followers (forum feature request, 2024-10-22: https://forum.figma.com/t/enable-and-disable-follow-option/90279).
- Following doesn't carry between the editor and presentation view (forum requests 2023).

### 1.7 Spotlight
- Who: anyone with can view or can edit can follow; Slides says "Anyone with can view or can edit access … can use it" — https://help.figma.com/hc/en-us/articles/24260248467735. For Design files help doesn't restrict who may spotlight (viewers have the same popover, **unverified** in [live] for B).
- Start: Multiplayer tools › "Spotlight me". "Viewers will receive a prompt and have a few seconds to click Not now. Otherwise, they'll be automatically taken to your view." — https://help.figma.com/hc/en-us/articles/360040322673. Prompt text (e.g. "<name> is spotlighting…") and countdown length **(unverified)**.
- Presenter sees: own avatar with "a dashed border, and you can see how many people are following" (same).
- End: presenter clicks "Stop" at the top of the canvas (same). A follower who left can rejoin by clicking "Follow" in the message at the top (prototype section of the same article).
- "Ask to spotlight": hover someone's avatar → request; "they can accept or decline" (same).
- Scope: "Spotlight shares your view of the canvas only. It doesn't share your toolbar or sidebar actions." — https://help.figma.com/hc/en-us/articles/24260248467735

### 1.8 Cursor chat — https://help.figma.com/hc/en-us/articles/4403130802199
- Enter: "/" or right-click canvas › "Cursor chat". "An empty speech bubble will appear next to your cursor"; it moves with the cursor.
- Live: "other collaborators in your file will see what you're typing as you're typing it" — no send step.
- "A single chat has a 52 character limit." "Your cursor displays the message for five seconds after you're done typing."
- Exit: "Press Esc", "Click anywhere in your file", "Switch to a different tool", "Open a menu". No log is kept.
- Who: "Anyone with can view or can edit access in a Figma Design file".

### 1.9 Audio conversation — https://help.figma.com/hc/en-us/articles/1500004414622
- Built-in voice call per file (headphones button "Start conversation" in Multiplayer tools [live]; "Join conversation" for others once one is running — 3rd-party summary). "Each file holds a single conversation at any given time"; a green "Connected" label in your audio controls; leave via the controls or by closing the tab; ends when the last person leaves; not recorded. Professional / Education / Organization plans; not on mobile or in presentation view. Launched 2021-08-31 — https://www.figma.com/blog/talk-it-out-in-figma-and-figjam/. **Out of scope for us.**

### 1.10 High fives / emotes
- FigJam only: shake cursor or hold H ("Shake cursor for high five" preference) — forum staff 2024-09. Requested for Design files, not shipped (forum: https://forum.figma.com/suggest-a-feature-11/add-high-five-to-non-figjam-workspaces-figma-32232). Emotes/stamps are FigJam. **Not in Figma Design.**

### 1.11 Presence across pages
- Avatars show everyone in the file regardless of page; following takes you to their page (§1.6). A per-avatar page label / badge **(unverified — none found; not in [live])**. Cursors only on the shared page (§1.2).

---

## 2. Sharing

### 2.1 Share dialog (UI3) [live] + https://help.figma.com/hc/en-us/articles/360040531773
- Opened from the blue "Share" button at the right of the right-panel header (help still says "toolbar"/"right sidebar"). A red badge appears on Share when edit requests are pending — https://help.figma.com/hc/en-us/articles/4408435431319.
- Modal 480 wide, **two stacked cards** (bg #2c2c2c, r 13, 8 apart) [live]:
  - **Card 1** header: "Share this file" (11/550) · "Copy link" (blue link text, no button chrome) · [Close].
  - Invite field: placeholder **"Add comma separated emails to invite"**; button **"Invite"** (disabled grey until an email is typed, then blue). Help names the button "Send invite" (older wording).
  - Typed emails become chips with ✕ [Remove]; a role select appears **inside** the field at its right, default **"can view"**; menu "can edit", "can view" [live].
  - Suggestions below the field: chips of recent collaborators ("Invite <email>") [live].
  - **"Who has access"** (11/550, 70 % white): first the audience row — globe icon, "Anyone" … "can view" ▾ (click → Share settings); then people rows — avatar, name, "(you)" muted, role at right ("owner", "can edit", "can view" with chevron). Rows 36 apart [live]. Help: the list "shows people explicitly invited", not everyone with inherited access; files in folders also show inherited folder roles ("Inherited user roles").
  - **Card 2** (additional options) [live]: "Share selected frames to Community" (disabled), "Publish to Community", "Copy Dev Mode link", "Get embed code", "More"; in Drafts a tinted row "Ready to share with your team?" + "Move to folder".
- Help's section list: 1 Invite field, 2 Audience access, 3 Inherited user roles, 4 Individual user roles, 5 Additional sharing options (Dev Mode link, prototype link, "Publish the file to the Community", embed code), 6 Copy link.

### 2.2 Invites
- "Click Share, enter emails or user group names in the invite field, set each person's permissions, and click Send invite. Invitees receive an email and a file browser notification." — https://help.figma.com/hc/en-us/articles/360040531773 (comma-separated).
- Email button: "**Open in Figma**" ("Use the Open in Figma button to accept the invitation and open the file"); in-app notification with "Accept" / "Decline" (teams). The invite states view or edit access. — https://help.figma.com/hc/en-us/articles/1500008023902
- An account is needed to accept; invites without an account wait **(pending-row wording unverified)**. "If an invitee doesn't get the email, copy and send the link directly." — 360040531773.
- Who can invite / change permissions: "Anyone with can edit access on a file or folder can make changes to permissions on that file or folder." — https://help.figma.com/hc/en-us/articles/360040530793. (Viewers can still invite at can view **(unverified)**.)
- Limit: "You can invite up to 500 collaborators to your files (of which 200 can edit at a time)" — https://help.figma.com/hc/en-us/articles/1500006775761.

### 2.3 Changing roles, removing, ownership
- "Click the dropdown next to a user's name to adjust or remove their file access." After removal "They no longer appear in the Share list"; they "may still access the file via inherited permissions"; they keep getting emails on their old comment threads. — https://help.figma.com/hc/en-us/articles/360040530793
- Member role menu: "can edit", "can view", divider, "Remove" **(menu layout unverified; [live] had no other member)**; for the owner viewing an editor's row, "Owner" appears too (below).
- Transfer: "Click the collaborator's current permissions and select **Owner**", then "Click the **Transfer ownership** button to confirm the transfer. You can't undo this action." Only the current owner can; for a Drafts file "you can transfer ownership to anyone you've shared it with, including someone outside your team"; for shared files the new owner must already be a collaborator; "Transferring ownership only changes who the owner is — it doesn't move the file." Old owner keeps their access. — https://help.figma.com/hc/en-us/articles/360038512093
- Ownership gives no extra rights over an editor except transferring (help: owner = "The person who created the file. They have full editing access.") — https://help.figma.com/hc/en-us/articles/35361119554711

### 2.4 Request to edit ("Ask to edit") — https://help.figma.com/hc/en-us/articles/4408435431319
- "Anyone with can view access to a file in a team can request to edit it" by clicking "**Ask to edit**". In UI3 the button is in the viewer banner (§2.8) [live]; tooltip "Any of this file's editors can give you access" [live] (help image: "editors can grant access").
- "Figma will notify the file owner via email and in-app notifications of your request"; red badge on Share; "Anyone with can edit or owner access to a file in a team can deny or approve edit requests." "The share modal will open, and you'll have the option to deny or approve the requests." On approval "you'll receive an email and in-app notification, and can start editing the file right away."
- Seats: if your seat doesn't cover the product, a seat request instead ("Only admins can approve or deny seat upgrade requests"). Not relevant for us.
- No-access page (opening a link you can't access) and its "Request access" wording **(unverified)**.

### 2.5 Link sharing — Share settings [live] + help
- Reached by clicking the audience row in Who has access. Sub-view header: [Back] + "Share settings".
- "Who can access" select: **"People invited to file" | "<team name>" | "Anyone"** [live] (help, org plans: "Anyone", "[Organization name]", "[Workspace name]", "Only invited people"). Caption for Anyone: "Anyone, even those outside your organization, will be able to access this file." [live]
- "What can they do": radios **"View" | "Edit"**; caption "Can view and comment on this file." [live]. Starter Drafts set to Anyone are view-only — "Move the file into a folder to allow editing." (360040531773)
- "Additional security": checkbox "**Password required**" → "Add password" field, "Generate" (four random words), "Save"; "Reset" later. Invited people and folder members don't need it; protected files show lock icons instead of thumbnails, hide previews in embeds/unfurls; removing it reloads the file for everyone; changing it makes open sessions re-enter. Paid plans, needs can edit. — https://help.figma.com/hc/en-us/articles/5726720100247. Enterprise: link expiration.
- "Advanced": checkbox (on by default in [live]) "**Viewers can copy, save, and export from this file**" + "This setting applies to anyone in the file with can view access" [live]. Help wording differs ("Viewers can copy, share, and export from this file"); off → viewers can't copy layers/text, duplicate the file, export, or save a local copy — https://help.figma.com/hc/en-us/articles/360040045574.
- If an admin disabled public links, "Anyone" is missing (360040531773).

### 2.6 Copy link and link format
- "Copy link" in the dialog copies the file URL; "If a frame is selected, the link opens to that frame. Nested frames link to the parent." — 360040531773.
- Formats — https://developers.figma.com/docs/embeds/resources: `https://www.figma.com/design/:file_key/:file_name`, Dev Mode `…?m=dev`, FigJam `/board/`, prototype `/proto/`. `node-id=5-3` (hyphen in URLs; API uses `5:3`). `t=` is a share-attribution key (forum, unverified) — https://forum.figma.com/ask-the-community-7/details-of-t-parameter-of-url-38141.
- Also: right-click › "Copy/Paste as" › "Copy link to selection" (⌘L), page: "Copy link to page". Toast wording ("Link copied to clipboard" / "Page link copied to clipboard") **(unverified, forum/3rd party)**.

### 2.7 Dev Mode link, embed, prototype share
- "Copy Dev Mode link" → `?m=dev` URL (a known bug copied `m=auto`, forum: https://forum.figma.com/report-a-problem-6/copy-dev-mode-link-is-not-creating-the-right-url-m-auto-instead-of-m-dev-37859).
- "Get embed code" → window with "Copy"; "Anyone with can view or can edit access to a file or prototype can copy the embed code."; private files need access to view; password-protected files can't be embedded — https://help.figma.com/hc/en-us/articles/360039827134. Code: `<iframe src="https://embed.figma.com/design/<key>?embed-host=…" height="450px" width="100%" allowFullscreen>` with params `footer`, `viewport-controls`, `page-selector`, `theme`, `node-id`, `m` — https://developers.figma.com/docs/embeds/embed-figma-file/.
- Prototype-only sharing moved to presentation view's "Share prototype" (2024-05 release; staff: "Prototype sharing behavior/policy has not changed, but will be presented through a dedicated prototype share dialog") — https://forum.figma.com/t/what-happened-to-the-can-view-prototypes-only-permission/73383/10.

### 2.8 Roles and what each can do in the editor
- File roles: **owner**, **can edit**, **can view** — https://help.figma.com/hc/en-us/articles/35361119554711 ("Can view: View and comment on the file, but not edit it."; copy/export unless restricted). The old "can view prototypes" option is gone from the file Share modal (2024; now via Share prototype) — forum link above.
- Inheritance: a file always inherits folder roles; a file can give more but not less than the folder role; audience is per file/folder, not inherited (35361119554711).
- Viewer UI [live]: bottom-centre banner (bg #394360, r 13) "**You can only view and comment on this file.**" + "Ask to edit" + ✕. Right panel tabs **"Comments" | "Properties"** (help: "Comment and Properties" — https://help.figma.com/hc/en-us/articles/360039832014); Comments empty state "Give feedback, ask a question, or just leave a note of appreciation. Click anywhere in the file to leave a comment." Toolbar: Move, Hand, Comment, creation tools greyed; left rail only "File".
- Viewers can: select, inspect, measure (⌥ hover), export (Export section), "Copy as code", comment (C), follow, cursor chat, view prototype connections (hidden by default; toggle in Properties / Zoom menu "Prototyping"); cannot: edit, run plugins ("You'll need can edit access to use plugins in a file"), change version history — https://help.figma.com/hc/en-us/articles/22012921621015, https://help.figma.com/hc/en-us/articles/360038006754.

---

## 3. Home / file browser

- Recents shows "files you've opened" "as well as files and folders people have recently shared with you"; right-click › "Show in folder" — https://help.figma.com/hc/en-us/articles/14381406380183.
- Tabs [live-home]: **"Recently viewed" | "Shared files" | "Shared folders"** (24 high, selected bg #383838 white 11/550, others muted). URL `…/recents-and-sharing/shared-with-you`. No separate "Shared with me" sidebar item.
- Filters at the right: "All organizations" · "Shared with ▾ Anyone ▾" (label + value) · "All files" · "Date shared" (sort) · grid | list segmented [live-home]. Filter option lists **(unverified)**.
- Cards: thumbnail + footer with file-type glyph, name 11/550, second line **"From <name>"** (the sharer) [live-home].
- Shared files can't be removed from the list (staff 2024-03, forum: https://forum.figma.com/t/cant-remove-file-from-recent-shared-files/60324); Recents is capped (older shares drop off, forum user).
- Presence in Home (who's in a file now) **(unverified — not seen)**. Invitations also arrive in the notification bell.
- Offline changes: "We also show UI in the file browser that actively prompts the user to restore their changes" — https://www.figma.com/blog/behind-the-feature-autosave/.

---

## 4. Edit behaviour a user notices

- **Conflicts — last writer wins per property**: the server keeps the latest value per property; different properties never conflict; text is one atomic value (no merge). Client applies its own edits immediately and ignores incoming values that conflict with its unacknowledged edits (no flicker). Server rejects invalid trees (parent cycles); an object may briefly vanish in a reparent race. — https://www.figma.com/blog/how-figmas-multiplayer-technology-works/
- **Undo**: "undo in a multiplayer environment is inherently confusing"; principle "if you undo a lot, copy something, and redo back to the present (a common operation), the document should not change"; "an undo operation modifies redo history at the time of the undo". Undo affects only your own changes and doesn't overwrite others' later work (same post).
- **Offline** — https://help.figma.com/hc/en-us/articles/360040328553: a toolbar icon while "Figma is attempting to save your changes", another when "Figma considers you offline" (icon tooltips **unverified**); "a notification at the bottom of your screen that your file has unsaved changes"; changes kept in the browser, synced on reconnect (up to 30 days; Safari 7); only loaded pages available; no updates from collaborators while offline; desktop app on close offers to discard; browser shows its own "Changes you made may not be saved." On reconnect the client loads a fresh copy and replays its offline edits (tech post). Blog: Figma prevents closing the tab while unsynced.
- **Version history**: checkpoint "every 30 minutes" plus on connection loss / crash; each version shows "The name and avatar of the main contributor"; only can edit can create/name/restore — https://help.figma.com/hc/en-us/articles/360038006754.
- **Limits** — https://help.figma.com/hc/en-us/articles/1500006775761: "200 cursors", "200 people editing", "500 total participants". Past 200 editors joiners get view-only ("Figma will show an alert to confirm you've been converted to view-only access", session-only); past 500 "anyone that joins the file will only see a static version of the file" with "Open view-only"; up to 20 editors may still join past 500.
- "This file was updated / reload" style message **(unverified — none found; Figma applies remote changes live)**. Removing a password reloads the file for everyone (5726720100247).

---

## Implications for DesignerV2 (ordered by importance)

1. **Viewer mode UI** exactly as [live]: bottom banner "You can only view and comment on this file." + "Ask to edit" + ✕; right panel tabs "Comments | Properties"; toolbar Move/Hand/Comment with creation tools greyed; plugins and version restore disabled; export/copy allowed unless "Viewers can copy, save, and export from this file" is off.
2. **Share dialog layout**: two cards; "Share this file" + "Copy link" + Close; invite field "Add comma separated emails to invite" with chips and an in-field role select (default "can view"), "Invite" disabled until valid; "Who has access" starting with the audience row ("Anyone … can view" / "People invited to file"), then people rows (owner "(you)" first) with role menus "can edit" / "can view" / "Remove", "Owner" for the owner → "Transfer ownership" confirm ("You can't undo this action."). Card 2: "Copy Dev Mode link", "Get embed code" (drop Community rows or show disabled).
3. **Share settings sub-view**: Back + "Share settings"; "Who can access" select (People invited to file | Anyone; we have no teams), caption, "What can they do" View/Edit radios with captions, "Advanced" checkbox "Viewers can copy, save, and export from this file". Maps onto `files.link_access`; add a `viewers_can_copy` flag. Password: optional/later.
4. **Facepile** in the right panel header: others' 24 px avatars with 2 px panel-colour ring, 4×2 colour bar, then your avatar + count chip (people incl. you) as the "Multiplayer tools" button; "Follow <name>" on click; same account in two tabs = two people.
5. **Multiplayer tools popover**: you + "(You)", "Spotlight me" primary button (audio button omitted or hidden), list of others "Click to follow <name>" with More options ("Ask to spotlight"). Move "Spotlight me" out of the account menu (contract §6 item 6 says account menu — differs from Figma).
6. **Observation mode**: 5 px window border in their colour, top-centre bar "Following <name>" + "Stop", minimized UI pills, follow their page + viewport (not selection), stop on any canvas interaction; followed person's avatar ringed; presenter not notified.
7. **Spotlight**: followers get a prompt with "Not now" and a few seconds before auto-follow; presenter's avatar dashed border + follower count; presenter's "Stop" at top; a follower who left can "Follow" again from the top message; "Ask to spotlight" request accept/decline.
8. **Cursors**: arrow + name chip in colour, only for peers on the same page and in a foreground tab; Zoom/view menu "Multiplayer cursors" toggle + ⌥⌘\\; others' selections outlined in their colour.
9. **Cursor chat**: "/" (and context menu "Cursor chat"), bubble at cursor, live typing, 52 chars, visible 5 s after typing stops, Esc/click/tool/menu exits; viewers too.
10. **Ask to edit** flow: request → red badge on Share + notification; Share modal shows request with approve/deny; requester notified.
11. **Home › Recents** tabs "Recently viewed | Shared files | Shared folders" replacing our "Shared with me"; cards with "From <name>"; filters "Shared with", "Date shared"; grid/list.
12. **Offline / sync indicators**: toolbar icon for saving vs offline; bottom notification for unsaved changes; prevent closing a window with unsynced changes (desktop: offer discard); Home prompt to restore. Our contract's Live/Connecting/Offline label in the header should become Figma's icon form.
13. **Links**: our `/f/<key>` link is fine for us, but "Copy link" should include `node-id` of the selected top-level frame (nested → parent) and Dev Mode link `?m=dev`.
14. **Limits** (cosmetic for one person): none required; keep viewer cap logic out.
15. Out of scope: audio conversations, high fives (FigJam), Community publishing, password protection (paid), embeds (no web host).

## Open / unverified

- Max avatars before overflow, and whether the count chip opens the same popover (it does in [live] when clicking your avatar).
- Others' "More options" menu contents in the popover; avatar hover tooltip wording.
- Spotlight prompt wording, countdown length, and whether viewers can "Spotlight me" in Design files.
- Idle fade of cursors/avatars; page indicator on avatars; cursor of a peer on another page.
- Selection-outline style for others (stroke width, name label).
- Pending invite row wording ("Invited"/"Resend"); role menu layout with Remove; whether viewers can invite.
- No-access page wording ("Request access").
- Offline icon names/tooltips; exact "unsaved changes" notification text.
- "Shared with" / "All files" filter option lists in Home.
- Copy link toast wording.
- Help says "Send invite" / "Stop following" / "Viewers can copy, share, and export"; live UI3 shows "Invite" / "Stop" / "Viewers can copy, save, and export" — trust live.
