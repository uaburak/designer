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
  sub-pages as tabs under the page title; Resources (Libraries | Fonts) since round 3e (§9). A workspace admin gets the workspace's own Admin (its Libraries); the rest of a workspace's own scope in
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
- **Ours**: Creating user groups (Anyone / Admins only), Default seat (View, the owner's answer). Round 4's rows are
  live since 4d (§10).

## 9. Resources (read 2026-10-11, for round 3e)

Sources: **[L-find]** Help people find and use libraries — https://help.figma.com/hc/en-us/articles/21310245473815 ;
**[L-org]** Share libraries in an organization — https://help.figma.com/hc/en-us/articles/360040529593 ;
**[SF]** Add fonts to an organization or team — https://help.figma.com/hc/en-us/articles/360039956774 ;
**[F-guide2]** Guide to managing an organization — https://help.figma.com/hc/en-us/articles/360052679454 .

- **Approve** [L-find]: org admins: Admin › **Resources** › find the library › click it › the **Manage this library**
  modal › the toggle **"Set as approved library"**. Workspace admins: Admin › the workspace › **Libraries** › the same.
  "A workspace admin cannot unapprove a library that an organization admin approved at the organization level."
- **Default** [L-find]: section **"Enable or disable a default library"**; file types **Design files**, **FigJam
  boards**, **Slide decks**, **Figma Buzz files**; org admins: Admin › Resources › **Libraries** › the library › select
  the workspace › select the file types. A **Caution** block says "The Libraries tab contains a list of all the
  libraries you have access to in the organization." When the library isn't shared with everyone: "Figma will publish
  the library to the organization", and the file's permissions change. [L-org]: "Click **Off** next to the library" to
  stop a default.
- **Default modes** (Enterprise) [L-find]: a collection with at least two modes, published; org admins Admin ›
  Resources › Libraries, workspace admins Admin › ‹workspace› › Libraries; remove the **"Added by default"** search
  filter if the library isn't on by default anywhere; in Manage this library: the workspace › **"Enable this library by
  default"** › Design files on › **"Manage default modes"**.
- **Fonts** [SF]: Admin › **Resources** › **Fonts** › **Font** › pick files (several at once) › **Open** › "Confirm you
  have the necessary rights and licenses to use the font(s)" › **Upload**. A family already uploaded: **Skip** ("leave
  the font out of the upload") or **Replace** ("update the existing font"). "Admins should only upload fonts they own
  or have a license to use in Figma." The team flow has "Check the box to confirm…" and **Upload fonts**. Neither
  article describes the org font list's columns or removing a font; [F-guide2] doesn't either (no "Manage fonts" label
  was found on help.figma.com — a 2025 forum request asks for deleting fonts in the admin panel).
- **Ours (unverified)**: the filter **"Approved"** (only "Added by default" is named); the list's columns (Team, counts,
  Enabled by default, Inserts last week — Home's org Libraries' column — Last published); the modal's layout, the
  "Where" select, a workspace's tri-state "Organization setting (On/Off) / On / Off"; the warning as a confirm
  ("Publish to the organization?" … **Enable by default**; the sentence says "will publish the library to the
  organization and change the file's permissions" without Figma's name); the font table (Font, Styles, Uploaded by,
  Date added), **Remove font**, the conflict dialog's title, the licence checkbox's "I confirm I have…" wording; a
  workspace admin's Admin showing only Libraries.

## 10. Settings, round 4 (read 2026-10-11, for round 4d)

Sources: [F-auth] 360052497994, [F-okta] 360040532353, [F-adfs] 360048269533, [F-scim] 360048514653, [F-idle]
14376092335127, [F-domain] 360045953273, [F-guestctl] 4410793238167, [F-share] 5726756336791, [F-external]
12080587805719, [F-chat] 14564080039447, [F-audio] 4420953557399, [F-region] 15643274574871, [F-msi] 14172933259287,
[F-people] 4420842863255 (all help.figma.com/hc/en-us/articles/…), [F-log] developers.figma.com activity-logs-action-types.

- **Section names as the articles give them** (Admin › **Settings** tab):
  - **Login and provisioning** › **Authentication** ("Members may log in with any method, including email and password
    (default)" / "Members must log in with a Google account" / "Members must log in with SAML SSO", **Done**) [F-auth];
    › **SAML SSO** › **Configure SAML** › the provider › **IdP Metadata URL** › **Review** › "This information is
    correct…" › **Configure SAML SSO**; **Copy** next to **Tenant ID** [F-okta]; the page shows **SP Entity ID** and **SP
    ACS URL** [F-adfs]; › **Manage domains** › **+ Domain**, **Add** (capture off) / **Verify and add** (capture on),
    **Verify**, the **More** menu › **Remove**; statuses **Unverified** / **Verified**; the **Domain capture** banner with
    a toggle and **Save** [F-domain].
  - **Access › Authentication** › **Idle session timeout** › **Custom timeout** › **Save** (12 hours–14 days; default 21
    days; "Figma resets inactivity for everyone") [F-idle]; **Access › Authentication** › **SCIM Provisioning** ›
    **Generate API token** (the SCIM article; its Governance+ note names "Manage identity providers (IdP)") [F-scim].
    **Conflict**: the older articles (auth, domains, Okta, AD FS) say "Login and provisioning", the newer ones (idle,
    SCIM, guest access) "Access › …". Without a live Enterprise account we follow the majority: **Login and
    provisioning** holds Authentication, SAML SSO, SCIM provisioning, Idle session timeout and Manage domains; **Access**
    holds Guest access. Recheck on a live account.
  - **Access › Guest access › Guest membership** (the three options, **Save**) [F-guestctl].
  - **Content › Sharing and publishing › Public sharing**: **Public link sharing**, **Require passwords**, **Password
    protection options** › "Autogenerated passwords only" › **Save**, **Require design file links to expire** (1 hour to
    31 days), **Custom settings for workspaces** › **Add workspace**, **FigJam open sessions** [F-share].
  - **Content › Content access › Access to external content** › **Save** (option labels not given) [F-external].
  - **Communication › Cursor chat** (a toggle) [F-chat]; **Other › Audio** (a toggle) [F-audio]; **Other › Enterprise
    installer** › **Download** [F-msi]; **Data** › **Data storage localization** (read-only at Figma; changed by Support)
    [F-region].
- **The token dialog**: Figma's article doesn't say the token is shown once; ours says so (we store only its hash).
- **People**: "If you have configured SCIM, you can sort members based on your SCIM member data, like cost center,
  organization division, or department" [F-people]; no column picker is named.
- **Activity**: each round-4 action's description [F-log] ("Org members authentication method through SAML SSO was
  changed.", "A token was generated for an IdP service to call Figma SCIM endpoints." …) — the Event column says them
  as past-tense phrases, and for settings with a new value in `details`, what it became ("Turned cursor chat off").
- **Ours (unverified)**: rows' descriptions; "Any password" (Password protection's other option); "Allow / Restrict
  access to external content"; the SAML dialog's view (the SP values, Test, Refresh metadata, Edit, Remove), its "How to
  connect" choice (metadata URL / XML / the three values) and "Signing"; the SCIM dialog's layout, **Generate new
  token** and **Revoke**; the idle dialog's number + Hours / Days; the domain table's columns, the TXT block, the
  values found on a failed Verify, "Accounts outside the organization"; a workspace's tri-state "Organization setting
  (On/Off) / On / Off"; the data region dialog (self-serve: Change → confirm → "Moving files… n of m", Resume moving);
  People's **SCIM data** menu of columns (Provisioned by, Title, Department, Division, Organization, Cost center,
  Employee number, Manager, External ID).

## 8. Open

- Live screenshots of an Organization trial would settle: the sidebar vs tabs question, every button's label (Add
  people / Invite, Approve / Deny), the Dashboard's tiles, the Activity table's headers and its event sentences.
