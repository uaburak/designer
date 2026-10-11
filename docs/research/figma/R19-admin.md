# R19 — Figma's Admin (organization and Enterprise), for Phase 7 round 1d

Read on help.figma.com on 2026-10-11, for `src/renderer/src/admin/` (the Admin location). No live Organization or
Enterprise account was available, so the layout and wording come from the help articles alone. **(unverified)** marks
a choice of ours where Figma's text says nothing.

## Sources

- **[F-people]** Manage people in an organization — https://help.figma.com/hc/en-us/articles/4420842863255
- **[F-act]** Activity logs — https://help.figma.com/hc/en-us/articles/360040449533
- **[F-drafts]** Drafts of removed members (Unassigned drafts) — https://help.figma.com/hc/en-us/articles/4420549259799
- **[F-seatreq]** Seat requests and approval settings — https://help.figma.com/hc/en-us/articles/4414038570007
- **[F-seat]** Seat types — https://help.figma.com/hc/en-us/articles/360039960434
- **[F-ws]** Create a workspace — https://help.figma.com/hc/en-us/articles/4409612431383
- **[F-bg]** Billing groups — https://help.figma.com/hc/en-us/articles/19100885191191 and 19100486415255
- **[F-teams-csv]** Download a list of teams — https://help.figma.com/hc/en-us/articles/18527655973015
- **[F-teamcreate]** Team creation controls — https://help.figma.com/hc/en-us/articles/10386065399319
- **[F-guest]** Guest membership — https://help.figma.com/hc/en-us/articles/4410793238167
- **[F-guestreq]** Guest access requests — https://help.figma.com/hc/en-us/articles/4420542281495
- **[F-guide]** Guide to organization administration — https://help.figma.com/hc/en-us/articles/360039829474
- **[F-restore]** Restore a deleted team — https://help.figma.com/hc/en-us/articles/360039965973

## 1. Where Admin is

- Organization admins get an extra item, **Admin**, in the file browser's sidebar [F-guide].
- The help pages name its parts as **tabs**: Dashboard, People (with User groups), Content (Teams, Workspaces,
  Unassigned drafts), Resources, Activity, Billing (Billing groups), Settings [F-people, F-drafts, F-ws, F-bg,
  F-teamcreate]. The newest article says "click Activity **in the left sidebar**" [F-act]. On Enterprise, a workspace is
  selected "in the sidebar" and has its own Teams tab [F-teams-csv].
- **Ours**: the sections as a left sidebar (Dashboard, People, Content, Activity, Billing, Settings) and the
  sub-pages as tabs under the page title. Resources is round 3 (3e) and isn't shown yet. A workspace's own scope in
  the sidebar is not built: workspace pages open from Content › Workspaces (unverified).

## 2. Dashboard

- Pending **seat requests** appear on the Dashboard; admins approve or decline them there. The table has **View all**,
  and from there **Approval settings** [F-seatreq].
- The buttons' labels aren't given: ours are **Approve** / **Deny** (unverified).
- Guest access requests reach admins by email or in-app notification; **View request** opens them, with **Add**
  (accept) and **Dismiss** (ignore; the guest can't ask again) [F-guestreq]. Where they're listed in Admin isn't said:
  ours are a second Dashboard table (unverified).
- The stat tiles (members, guests, seats by type, teams, workspaces, active in 30 days) are ours: the help names no
  counts besides the seat count on People (unverified).

## 3. People

- Each row shows the name, avatar and email; columns **Seat type**, **Billing group** (Enterprise), **Last active** (the
  last action in Figma). Column headers sort, a second click flips the order. A search box finds people by name. A
  **seat count** at the top, with a filter by seat type. CSV download of members and guests [F-people].
- **Filter**: Seat type (Full, Dev, Collab, View); Paid AI credits; Billing cycle; Charged; Billing groups; User type
  (Admin, Member, Guest, Pending, Unverified); Last edit / Last active (All time, More than 3 months ago, More than 6
  months ago, More than a year ago); Workspace [F-people].
- **Bulk actions** for checked people: Copy emails, Change AI credit access, Add to user group, Change workspace,
  Change billing group, Remove users from the organization [F-people].
- **Seat change**: click the person's seat in the Seat type column; a modal picks and confirms the new seat [search
  summary of 360039960434]. Billing group: "the dropdown in the Billing group column"; in bulk, "Change billing group at
  the bottom of the screen" [F-bg].
- **Ours**: also Change seat and Change role in bulk; a Workspace column with its dropdown; the row's "…" menu;
  **Add people** (the button's name is unverified; the owner's decision is that admins add members by hand). Not
  built: AI credits, billing cycle, charged, Unverified, SCIM columns.

## 4. Content

- **Teams**: admins see every team including hidden ones; the teams CSV (**Get CSV**) has team name, owner name and
  email, last active, folder count, members, access setting and workspace ("Unassigned" without one) [F-teams-csv,
  F-guide]. A deleted team can be restored by its admins within 28 days (by an emailed link) [F-restore]. **Ours**:
  Restore in the Admin table's row menu, and Make hidden / Delete team.
- **Workspaces**: Content › Workspaces › **New workspace**; a name; **Workspace admin** (at least one); **Make it
  hidden** (hidden from non-members in **All workspaces**); **Create workspace**. Then assign teams and default teams;
  a person belongs to one workspace [F-ws].
- **Unassigned drafts**: Content › **Unassigned drafts**; a folder per removed person; its action menu **Move** (to a
  team, Organization / Enterprise), a file's **Move** (to a folder in the org); **Permanently delete** (can't be
  restored); **Show trashed files** [F-drafts]. **Ours**: files move to a team too (AdminRepository has no folder
  list).

## 5. Activity

- Filters: **Member** (an email), **Date** (start and end; "Last 30 days" by default, "Custom"), **Events** (an event
  type; "Explore tracked events"), **Team** [F-act].
- Each event has its type, the team member's name and email, the date and time in **UTC**, the product and team when
  there is one, and the IP address; the only header named is **Team Member** [F-act].
- **Get CSV** (top right) emails the log; it covers the date range and **ignores the other filters** [F-act].
- Event groups: Members, Files, Branches, Sites and web apps, Folders, Teams, Organizations, Seat changes, User limits,
  Credit requests, External access, Workspaces, Billing groups, SCIM groups, Libraries, Users, Community, Private
  plugins, Plugin management, Plugin publishers, Private widgets, Widget management, Widget publishers, SSO
  Authentications, Audio, Integrations, Custom MCP connectors, Webhooks, Domain management, GitHub, SCIM provisioning
  [F-act].
- **Ours**: columns Date (UTC), Team member, Event, Product, Team, IP address; the Event column's sentences per action
  (Figma's in-app sentences aren't published); the CSV saved at once through a callback (no email).

## 6. Billing

- Billing groups: **Billing** tab › Billing groups › **Billing group** (a name and its admins); only org admins create,
  rename or delete them; people not in one are **Unassigned**; deleting one sends its people back to Unassigned
  [F-bg].
- **Ours**: an Overview tab with the plan and seats by type; there is no payment (R18 §0).

## 7. Settings

- **Team management › Creating teams**: **Anyone** / **Admins only** (only org and workspace admins), **Save**
  [F-teamcreate].
- **Access › Guest access › Guest membership**: "External users can join the organization (default)" / "External
  users can only join with admin approval" / "No external users can join the organization", **Save** [F-guest].
- **Billing › Seat approval settings**: per seat type "Manually approve seats" / "Manually approve, unless seat is
  available" (default) / "Auto-approve seats" [F-seatreq].
- **Ours**: Creating user groups (Anyone / Admins only), Default seat (View, the owner's answer), and round 4's rows
  shown disabled (Public links, Link expiration, Require passwords, Cursor chat, Audio — the settings named in
  [F-guide]'s security list).

## 8. Open

- Live screenshots of an Organization trial would settle: the sidebar vs tabs question, every button's label (Add
  people / Invite, Approve / Deny), the Dashboard's tiles, the Activity table's headers and its event sentences.
