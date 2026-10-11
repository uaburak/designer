# R16 — Notifications (verified 2026-10-11)

Figma's notifications as the help centre states them and the owner's captures of the live desktop app show them
(dark theme, 2x: `1.png` Home's sidebar with the bell, `2.png` the bell pressed, `3.png` / `4.png` Settings ›
Notifications). Built from this: `docs/multiplayer.md` §12.

## 1. Where they are

- **The bell is in the file browser**, "next to the account menu on the left side of the navigation bar"; "a red dot over
  the bell when you have a new notification" [1]. 1.png: the account (avatar, name, chevron) at the left of the
  sidebar's first row, the bell (a 32 × 32 button, 8 from the sidebar's right) at its right.
- The red dot means *new since last opened*, not *unread*: 2.png shows "Unread (22)" while 1.png (the same session)
  shows the bell without a dot.
- **No bell inside files.** The help centre puts notifications in the file browser only [1]; in a file, comments show
  as unread threads in comment mode and edit requests as a red badge on Share [3]. Nothing to build in the editor beyond
  landing on a comment when a notification opens it.
- **In-app notifications can't be turned off** [1][2]; settings govern email, push / desktop and Slack.

## 2. The modal (2.png, measured: px at 1x)

- A panel 384 wide, its left 62 left of the bell's left, 2 under the bell; 13 corner radius; it overlaps the sidebar
  and the content. "The notifications modal lists the 50 most recent notifications" [1].
- Header 48: "All notifications ⌄" (11 px, strong; a menu) at 21 from the left; the settings gear (24 icon button) 8
  from the right. Then a 42 row: tabs **All | Requests | Unread (n)** (pills 24 high, the chosen one filled, 5 apart,
  starting 16 in) and **Mark all as read** (brand blue) at the right.
- Rows: padding 12 / 13 / 12 / 16; a 32 avatar (one initial, coloured per person) 2 lower than the first line, with a
  badge cut into its lower right (a comment bubble; the reaction's emoji; a smiley for several reactions); text 63 from
  the left, 18 a line: the person (strong), "<what> · <file>", then the comment (secondary colour, 2 below). Date at
  the right ("Sep 21", "Aug 4"), then a 5 gap and an 8 px blue dot while unread (13 from the right). Text is 11 px
  throughout (widths: "oguz berk acar" 78.5 px, "Requests" 49 px).
- Wording in the capture: "4 comments · Insider V3", "Commented · Insider V3", "Reacted · AWA V3", "2 reactions · AWA
  V3", "5 reactions · AWA V3". A single comment / reaction shows the comment's text; a group doesn't.
- Actions [1]: accept or decline invitations; open the file / resource; Mark all as read; reply inline to single comment
  notifications.

## 3. Who is notified

- **Comments** [2]: the file's owner gets all comments by default; "If you're not the file owner and leave two or more
  comments on a file, you'll be notified about all new comments that file receives"; @mentions (including user groups
  you're in) reach you even with "Nothing"; replies and reactions to threads you created or participated in.
  Per-file choice in comment mode › Settings: Everything / Just mentions and replies / Nothing (email only).
- Comment notifications are "grouped and sent every 30 minutes" [1] (email); the modal groups too (2.png).
- Losing a direct role (link access narrowed to invited people) stops a collaborator's notifications [2].
- **Request to edit** [3]: "Figma will notify the file owner via email and in-app notifications"; anyone with can edit
  or owner access can approve or deny — from the Share dialog (red badge on Share), email, or "File browser via the
  notification bell"; the requester gets "an email and in-app notification" when approved (the article doesn't say what
  a denial sends).
- **Invites** to files, folders, teams: in the modal with accept / decline [1].

## 4. Settings › Notifications (3.png / 4.png, verbatim)

- **Desktop notifications** — ☑ Send notifications to my computer; File comments: All comments, mentions, and replies /
  Only mentions and replies / None.
- **Email notifications** — ☑ Send notifications by email; "You'll still get other emails from Figma, like important
  account or billing info."; File comments (same three); Invites and requests: All types of invites and requests /
  Only invites and requests that need my response / None; Community comments: All comments on my published resources /
  Only mentions and replies / None; Workspace: All activity on my workspace / None; User groups: Shared resources and
  when added to user groups / Only shared resources / None; Activity digests: ☑ Activity on my Community resources ·
  Weekly.
- **Product tips and news** — ☑ Send me occasional emails with updates and promotions from Figma. Footer: "You can
  unsubscribe from Figma emails any time. For more information, review our Privacy Policy."
- Layout: content 48 from the modal's left; 11 px options, 13 px group titles, 14 px section titles; checkbox and radio
  16; centres 24 title → checkbox, 32 → group title (40 in), 28 per radio, 36 between groups, 48 to the next section,
  44 to the footer.
- Defaults: on [1] ("Desktop notifications are on by default", "Email notifications are on by default").
- Settings live in the account menu › Settings › Notifications (tabs Account, Community, Notifications [4]; 3.png adds
  Security).

## 5. Desktop

- The desktop app shows notifications on the computer (Mac menu bar / Windows tray icon with a red dot; push
  notifications on by default, managed in Settings › Notifications) [1]. Only the current account's [1].

## Not verified

- The modal's empty states, the filter menu's entries (Figma's lists plans / teams; we list the files), the wording of
  invite / request / approval rows and of today's dates, the red dot's exact size and place, Deny / Approve on request
  rows (the help centre says approve or deny from the bell, not how the row looks).

## Sources

1. help.figma.com 360039813234 — "Manage notifications" (bell, red dot, modal of the 50 most recent, desktop / push /
   email, in-app can't be disabled, comments grouped every 30 minutes).
2. help.figma.com 360041547813 — "Adjust comment notification settings" (owner default, two-comments rule, the three
   choices, mentions, permission changes).
3. help.figma.com 4408435431319 — "Request to edit a file" (who's notified, approve / deny, red badge on Share, the
   requester's notification).
4. help.figma.com 1500006061462 — "View and manage account settings" (Account, Community, Notifications tabs).
5. The owner's captures 1.png–4.png (2026-10-11, live desktop app, dark, 2x).
