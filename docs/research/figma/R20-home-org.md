# R20 — Home (the file browser) in an organization

Read 2026-10-11 for Phase 7 round 1c (`src/renderer/src/files/`, docs/multiplayer.md §14). Verified facts carry their source; **(ours)** marks a choice we made where Figma's page says nothing; **(unverified)** marks a guess.

## Sources
- **[F-tour]** Tour the file browser — https://help.figma.com/hc/en-us/articles/14381406380183
- **[F-teams]** View and join organization teams — https://help.figma.com/hc/en-us/articles/360039957674
- **[F-team]** Team permissions — https://help.figma.com/hc/en-us/articles/360039970673
- **[F-transfer]** Transfer ownership of a team — https://help.figma.com/hc/en-us/articles/360039481134
- **[F-folder]** Projects renamed to folders — https://help.figma.com/hc/en-us/articles/41753150926103
- **[F-move]** Move a file — https://help.figma.com/hc/en-us/articles/360038511573
- **[F-seatreq]** Approve or decline seat requests — https://help.figma.com/hc/en-us/articles/1500003870721
- **[F-analytics]** Library analytics — https://help.figma.com/hc/en-us/articles/360039238353 (read 2026-10-11, round 3f)
- **[F-teamlib]** Enable a library for a team — https://help.figma.com/hc/en-us/articles/360039234953 (read 2026-10-11)
- **[F-find]** Help people find and use libraries (default modes) — https://help.figma.com/hc/en-us/articles/21310245473815 (read 2026-10-11)
- **[F-fonts]** Add fonts to an organization or team — https://help.figma.com/hc/en-us/articles/360039956774 (read 2026-10-11)
- **[1.png]** the owner's screenshot of live Figma's Home (Professional plan, 2x)

## Sidebar
- Top, for every plan [F-tour]: the **account** menu (account, profile, theme, settings, switching accounts), **Search**, **Recents**, **Community**, the notifications bell.
- Then, Organization and Enterprise [F-tour], in order: **Organization** (its dropdown "switches organizations or teams"), **Drafts** (with a "Deleted files" tab), **Browse**, **Trash**, **Admin**, then a custom sidebar (pinned items) instead of Starred.
- Starter and Professional [F-tour]: **Team** (a dropdown when you're in more than one team or org), Drafts, Browse ("All folders"), Trash, Admin, Starred. 1.png is this layout: the team row "Anex Softw… ⌄" with a **Professional** plan badge at its right, then Drafts, All folders, Resources, Trash, Admin; a Starred section.
- On the Organization plan, teams are listed from **All teams** in the sidebar; Enterprise with workspaces uses **All workspaces**, then a workspace [F-teams].
- **Admin** shows for org admins (Organization), and also workspace and billing group admins (Enterprise) [F-tour].
- 1.png measures (÷ 2): sidebar 240 wide; the org row 16 icon (a green circle with the initial), name 13/strong, chevron, the badge 16 high at the right; items on a 32 pitch.

## Teams
- An organization is made of teams; each has folders and files, members, admins, libraries and fonts [F-teams].
- Team audience [F-teams, F-team] — "Who has access": **Only those invited** with **Visible** (members can find it and ask to join) or **Hidden** (not found by search; invited only); **Anyone in ‹org›** with "What they can do" can view / can edit ("Open to the organization").
- Joining a Visible team: **Ask to join** on the team card, pick "can view" or "can edit", optional note, **Request access**; **Cancel request** withdraws it [F-teams]. A lock marks visible teams that need approval. Guests see only teams they're invited to. Org members can't join org teams through a join link.
- Team roles: one **owner** (the creator; ownership transferable only by the owner, from the team's share modal; not undoable; the old owner stays as a **team admin**) [F-team, F-transfer]; admins; members with **can edit** / **can view**. **Delete team** is in the permissions table [F-team]. Leaving: an owner must transfer first [F-transfer].
- 1.png's team page: the team's 40 icon (radius 5, the initial in white on green), 20 to its name in a 24 heading, then folder cards (four thumbnails, the folder glyph, name, "Updated 22 hours ago").

## Folders
- Projects are called **folders** everywhere in Figma since 2026-08 [F-folder]; nested up to 10 levels on paid plans.
- Access: **Inherited** "Anyone in ‹parent› can access", **Limited** "Only people added to ‹folder› can access"; the members list badges **Limited Access** [F-folder].

## Moving files
- Right-click a file › move, search or pick a destination, confirm; or from the editor's file-name menu [F-move]. Several files at once with ⌘-select.
- Within a team: can edit on both places. Files don't move directly between organizations or accounts: duplicate / save a copy and import [F-move].

## Seats
- A seat request goes to the admins (Admin › dashboard: **Approve** / **Deny**, **View all**) [F-seatreq]; the requester may add a note and gets temporary access while waiting (the request-a-seat flow; the requester's button wording isn't stated on these pages).

## What Home does here (round 1c)
- **Ours / unverified**: the space switcher also lists the local workspace (no plan has a "local" space); the org row's badge says the plan, **Enterprise** (ours is an Enterprise org; 1.png shows "Professional" for a Professional team); teams with their folders nested under All teams in the sidebar (Figma's custom sidebar pins them instead); the button label **Ask to upgrade** and the View-seat notice; "Join team" for teams open to the org; Ask to join without the role / note (the store's `teams.join` takes neither); the org's Trash lists the teams' trash (drafts' trash isn't listed by the API); "Resources" is a placeholder; "Community" isn't shown.

## Libraries and fonts (round 3f, read 2026-10-11)
- **Org-wide analytics** [F-analytics]: Organization — **All teams**, then **Libraries**; Enterprise with workspaces — **All workspaces**, then **Libraries**. The modal's totals: **Total teams**, **Teams with libraries**, **Total libraries**, **Total components**, **Total styles**; each library: **# of components**, **# of styles**, **Inserts last week**; a **Search** field. (No variables total is named there; we show none.)
- **One library** [F-analytics]: in the library file, nothing selected, the file name's ⌄ › **Library analytics**; or in the file browser **right-click the library file › Library analytics**. Tabs **Overview** / **Analytics** (the modal is the editor's, round 3c).
- **Enable a library for a team** [F-teamlib]: team admins; the team dropdown › **View settings** › under **Libraries** or **Shared** › **View team's libraries** (Professional; the Organization / Enterprise path in the same article says **Enable libraries** — the default-mode article [F-find] says "From the Shared section, click **View team's libraries**" for organizations, which we follow). **Off** next to the library, then **Design files**, **FigJam boards**, **Slide decks**, **Buzz files** or **All files**; back to **Off** to remove.
- **Default mode** [F-find] (Enterprise): the library must have a published collection with at least two modes; **Enabled by default** set to **All files** or **Design files**; then the **Default mode** column.
- **Team fonts** [F-fonts]: team admins; the team's dropdown › **View settings** › **View team's fonts** lists the team's fonts › **Upload fonts** › pick files › **Open** › a checkbox confirming "the necessary rights and licenses" (label not quoted) › **Upload**. .TTF and .OTF only. Team fonts show in the font picker for that team's files. Removing isn't described. Org fonts: Admin › Resources › Fonts › **Font** (round 3e); same-family conflicts **Skip** / **Replace**.
- **Ours / unverified** (round 3f): the **Libraries** button sits in All teams' header next to Create team; the modals' titles ("Libraries", "‹team› settings", "Fonts", "Upload fonts"); the Shared section's two rows; a row of the org list opens that library's analytics; "View settings" in the team's ⋯ menu (Figma: the ⌄ by the team name); a mix of file types shows as their names joined (the dropdown names one type or All files); a workspace default read as Design files; the checkbox's words "I have the necessary rights and licenses to use the font(s)" (from the org steps' sentence); Skip as the conflict default; Remove per family with the trash icon (§14.3: the uploaders); "Library analytics" offered only on published libraries of the org (the store's `orgLibraries.list`).

