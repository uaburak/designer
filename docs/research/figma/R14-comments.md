# R14 — Comments in Figma Design

Method: WebFetch / WebSearch of help.figma.com and developers.figma.com only, 2026-10-11. Exact strings are quoted; "(inferred)" marks anything the pages do not state. The help pages do not name the composer placeholder, the empty state or relative-time wording; those are not documented in text.

Sources (S1..S6):
- S1 https://help.figma.com/hc/en-us/articles/360039825314-Guide-to-comments-in-Figma
- S2 https://help.figma.com/hc/en-us/articles/360041068574-Add-comments-to-files
- S3 https://help.figma.com/hc/en-us/articles/360041547593-View-and-manage-comments
- S4 https://help.figma.com/hc/en-us/articles/360041547853-Move-or-edit-comments
- S5 https://help.figma.com/hc/en-us/articles/360041547813-Manage-email-notifications-for-comments-on-files
- S6 https://developers.figma.com/docs/rest-api/comments-types/ and https://developers.figma.com/docs/rest-api/comments-endpoints/

## 1. Access and permissions
1. Comments are supported on any team or plan. (S1, S2, S3)
2. Anyone with at least "can view" access can add and view comments. Viewers can also reply and react. (S1, S3)
3. Comments work on design files, FigJam files and prototypes, from browser, desktop and mobile apps. (S1)
4. Rate limit: up to 100 comments per hour, counting replies, across all files and prototypes. (S2)
5. Who can edit: only comments you posted ("any comment you've posted"). (S4)
6. Who can delete: "You can delete comments you posted." Deleting a thread removes all replies. The REST API says "Only the person who made the comment is allowed to delete it." File owners or editors deleting others' comments is not documented (inferred: not possible). (S3, S6)
7. Who can resolve: not specified in the help pages. (S3) Inferred: any commenter, since viewers can reply and react.
8. Deletion is permanent and cannot be undone, even by restoring an earlier version. (S3)
9. Duplicating a file does not copy comments; they stay on the original only. (S1, S4)

## 2. Comment mode and adding comments
10. Enter comment mode: click the comment tool in the toolbar ("Comment") or press "C". The cursor changes to a comment icon. (S1, S2, S3)
11. Exit: press "Esc" or select another tool. In comment mode canvas objects cannot be edited. (S1, S3)
12. Click the canvas to pin a comment at a point; click and drag to select a region. (S2)
13. Mobile: long-press the canvas, then type. (S1, S2)
14. Entering comment mode opens the right sidebar, where comments are viewed and managed (browser and desktop). (S1, S3)
15. Comments are visible by default, in or out of comment mode. "Shift C" toggles show/hide. (S3)
16. The compose field has an emoji icon (smiley), an "@" key/button for mentions, and an image icon for media; a send icon submits. The help text also calls the submit control "Submit". (S2, S3)
17. Reply and send: click send or press "Return" / "Enter" to post. "Shift + Enter" adds a new line / list item. (S2, S3)
18. Placeholder texts (composer, reply): not documented. (inferred) The live UI uses "Add a comment" for a new comment and "Reply" for the reply field. S3 says "Click "Reply" and type".

## 3. Pins, clusters, attachment to frames
19. A single comment is a pin on the canvas. Hovering a pin previews the comment; clicking opens the comment modal (thread popover). (S3)
20. Close pins merge into a cluster at lower zoom. Hovering shows the comment count and author avatars; clicking focuses the comments inside. (S3)
21. Pin avatar look and unread indicator: not described in text. (inferred) Pin is a round avatar of the author with a tail at bottom-left; unread shows a dot/colour change.
22. Attachment: when pinned, or a region selected, inside a top-level frame, component or group, the comment attaches to it, and moving that frame moves its comments. (S2)
23. Comments do not attach to nested frames, components, groups or other layers (the top-level container gets them). (S2)
24. Cut and paste within a file: the comment is disconnected from the layer (still in the sidebar); if it was not pinned to the layer it stays at its coordinates. Cut and paste between files: comments stay detached in the original file. Right-click > "Move to page": comments move with the object; comments linked to the canvas rather than a frame do not. (S4)
25. Move a pin: select the comment, click its pin and drag it to the new location. Tip: "drag a comment to keep it visible while editing". (S3, S4)

## 4. Thread popover (comment modal)
26. Top-right controls: "Mark as unread", "Copy link" (link to the comment), "Delete" thread (only if you added the comment), and the resolve control. (S3)
27. Per-comment more-options menu: "Edit...", "Delete comment". Thread menu (next to the title): "Delete thread", then confirm with "Delete". (S3, S4)
28. Edit: choose "Edit..." in the comment menu, change text, click "Save". (S4)
29. Reactions appear below each comment; the reaction control shows when hovering over the comment body. (S3)
30. Reply field with "Submit" / send control; emoji and @mentions supported. (S3)
31. Resolve: click the resolve control (a checkmark; tooltip wording not documented, (inferred) "Resolve"). The comment disappears from canvas and sidebar and is marked "Resolved". (S3)
32. Unresolve: turn on "Show resolved comments" in the sidebar, then uncheck the resolved state on the comment. (S3)
33. Replying from Slack and Microsoft Teams notifications is supported; email "View comment" links open canvas view (prototype comments open presentation view). (S3)

## 5. Comments sidebar (right sidebar in comment mode)
34. The sidebar lists all comments in the file, can search, sort and filter; each entry shows its page; clicking one navigates to that page and location (pan/zoom to the pin; zoom behaviour inferred). (S3)
35. A filter control at the top opens a dropdown with exactly: "Sort by date", "Sort by unread", "Show resolved comments", "Only your threads", "Only current page". (S3)
36. Default sort is "Date". "Sort by unread" puts unread first, still by date. (S3)
37. "Only your threads": comments where you are @mentioned, threads you replied to, and your comments that others replied to. (S3)
38. "Show resolved comments" is a toggle, off by default. (S3)
39. "Settings" sits at the top of the sidebar: notification dropdown "Everything" / "Just mentions and replies" / "Nothing". (S5)
40. Search placeholder, empty state text, relative-time wording ("Just now", "5m" ...): not documented. (inferred) Not retrievable from help text; check the live UI.
41. Comment numbering: the REST `order_id` is "the number shown with the comment in the UI", only on top-level comments. (S6)
42. Hover a comment in the sidebar: "Mark as unread" also reachable via "More options" at the top of a thread. (S3 and Figma Make article https://help.figma.com/hc/en-us/articles/38701587731735-Add-comments-in-Figma-Make)

## 6. Mentions, media, formatting
43. Press "@" or click @ in the field, then type a name, email or user group name. Mentions render in blue text. (S2)
44. Mentioned people get an email with the comment and a design preview, plus an in-app notification if enabled. (S2)
45. Mention someone not in the list: invite them to the file first. User groups: Organization and Enterprise plans only; guests can mention only groups they belong to. (S2)
46. Mention list limits: personal accounts "The last 100 users you've interacted with"; starter, education, professional teams "The last 250 users". (S2)
47. Media: up to 5 images or GIFs per comment or reply; PNG, JPEG, GIF; drag and drop, paste, or click the image icon. Remove with the "X" in the attachment's upper-right corner. (S2)
48. Emoji picker: smiley icon; sections "Frequently used", catalogue, "Search" bar; Apple emoji set. (S2)
49. Formatting shortcuts (Mac / Windows / markdown): Bold Cmd B / Ctrl B / `**bold**`; Italic Cmd I / Ctrl I / `*italicized*`; Strikethrough Cmd Shift X / Ctrl Shift X / `~strikethrough~`; Add URL Cmd K / Ctrl K; Numbered list Cmd Shift 7 / Ctrl Shift 7 / `1. First item`; Bulleted list Cmd Shift 8 / Ctrl Shift 8 / `- First item`. (S2)

## 7. Notifications
50. Defaults: file owners get email for all comments; non-owners are notified of all new comments after leaving two or more comments on a file. (S5)
51. Per-file setting (comment mode, "Settings", dropdown): "Everything" ("This setting will notify you of any comments made on the file"), "Just mentions and replies" ("notify you of @mentions that mention you", plus replies or reactions to your threads), "Nothing" ("You will not be sent any email notifications for new comments"; @mention emails still arrive). (S5)
52. In-app notifications cannot be disabled. Emails are batched about every 30 minutes. Slack notifications need the Slack integration. (S5, S2)

## 8. REST API Comment object (S6)
53. Fields: `id` (String), `client_meta` (Vector | FrameOffset | Region | FrameOffsetRegion), `file_key`, `parent_id` (only on replies), `user` (User), `created_at` (UTC ISO 8601), `resolved_at` (only if resolved), `message`, `order_id` (Number, top-level only), `reactions` (Reaction[]).
54. Reaction: `user`, `emoji` (shortcode like `:heart:`, optional skin-tone modifier e.g. `:+1::skin-tone-2:`), `created_at`.
55. Vector: `{x, y}` Numbers (canvas coordinates). FrameOffset: `{node_id, node_offset: Vector}` (inferred from the API; the fetched pages do not define it). Region: `{x, y, region_height, region_width, comment_pin_corner}` (inferred). FrameOffsetRegion: FrameOffset fields plus region_height, region_width, comment_pin_corner (inferred).
56. Endpoints: GET `/v1/files/:key/comments` (scope `file_comments:read`, `as_md` returns markdown); POST `/v1/files/:file_key/comments` (`file_comments:write`; body `message` required, `comment_id` optional and must be a root comment, `client_meta` optional); DELETE `/v1/files/:file_key/comments/:comment_id`; reactions GET/POST/DELETE on `.../comments/:comment_id/reactions` (POST body `emoji`). All Tier 2. Replies are one level deep. (S6)

## 9. Not documented (build from live-UI knowledge, mark inferred)
- Composer placeholder, reply placeholder, sidebar search placeholder, empty state, relative-time strings, resolve tooltip, arrow/J/K stepping through comments, pin visuals.
- Since answered by the live capture (`live/multiplayer/comments.md`, 2026-10-11; live wins over this file): composer "Add a comment", reply "Reply", search "Search" (aria "Search for comments"), the empty state, "Just now" / "1 minute ago", [Mark as resolved], the Sort/Filter and Settings menus, the pin and thread geometry, "Comment resolved" · Undo, "You will be notified about replies".

## 10. Who resolves and who deletes (as built)
- Delete: the author only (fact 1 area: "Only the author edits or deletes their own comments"); the server refuses others, the owner included.
- Resolve / reopen and move a pin: the thread's author or anyone who can edit (inferred — the help text is silent; the live capture showed [Mark as resolved] on a viewer's own thread; others' threads were not captured).
