# Comments — live Figma capture (2026-10-11)

Captured in live Figma (UI3, dark theme, desktop web) with the owner's second account as **can view** on the wecra.co file's "Test" page. Window 986×863 CSS px. Coordinates are CSS px in the window unless they are given relative to a box. The test comment, its reaction and its reply were deleted afterwards.

## Right panel (viewer): Comments | Properties

- Tabs at y 48: "Comments" 74×24 (selected: bg #383838, r 5, 11px/550 #fff), "Properties" 72×24 (11px/550 at 0.698). Zoom "100%" 60×24 at the right.
- Panel `dialog [Comments panel]` 240 wide from y 81. Header 240×41 (bg #2c2c2c):
  - search 160×24 at 8,8 (bg #383838, r 5, a search glyph, input placeholder "Search", aria "Search for comments");
  - [Sort/Filter] 24×24 at 176,8 (r 5; bg #394360 while its menu is open or a filter is on — the glyph turns blue);
  - [Settings] 24×24 at 208,8 ("•••").
- Empty state: a speech-bubble glyph at 16,16 below the header, the text at 44,59 (174 wide), 11px/400 #fff: "Give feedback, ask a question, or just leave a note of appreciation. Click anywhere in the file to leave a comment."

### Sort/Filter menu (184×135, below the button)

```
Sort                     (section label, not drawn as a row in the dump)
✓ Sort by date
  Sort by unread
─────────
  Show resolved comments
  Only your threads
  Only current page
```

Rows 24 apart, text at x 32, 11px/450. Checked items get ✓ at the left. The filter items are toggles.

### Settings menu ("•••", 183×174)

```
Hide comments                ⇧C
─────────
Comment notifications        (label, 0.698)
  Everything
  Just mentions and replies
  Nothing
─────────
Mark all as read             (disabled at 0.4 when nothing is unread)
```

## The Comment tool

- Toolbar for a viewer: Move, Hand, **Comment** (selected: bg #0c8ce9, r 5), the creation tools greyed.
- A click on the canvas puts down the **new-comment pin** and a composer next to it:
  - the pin: 32×32, `border-radius: 16px 16px 16px 0` (its point is the bottom-left corner, which sits on the clicked point), bg #0c8ce9 (brand), elevation shadow `0 3px 8px rgba(0,0,0,.35), 0 1px 3px rgba(0,0,0,.5), inset 0 .5px 0 rgba(255,255,255,.08)`;
  - the composer: 296×40, r 13, bg #2c2c2c, the same shadow; left edge 48 right of the pin's left edge, top 4 above the pin's top (pin 542,338 → composer 590,334). Focused: a 1 px blue border (#0c8ce9). Input `combobox [Add a comment]` 236×24 at 16,8 (13px/400, placeholder at 0.4); [Send] 24×24 circle at the right (8 in), bg #757575 while empty, #0c8ce9 with text, an ↑ glyph.
  - with text the composer grows: the text wraps (264 wide), and a bottom row appears 8 from the left: [Add emoji] 24×24, [Add mention] 24×24 ("@"), [Upload up to 5 images and GIFs] 24×24; [Send] stays at the right of that row. 296×104 with two lines.
  - Enter posts (Shift+Enter: new line — standard). A second click on the canvas while the composer is empty closes it.
- After posting: toast "You will be notified about replies" · Manage · ✕ (309×40, r 13, at the bottom centre above the toolbar; first comment of the session). After the first reply: "You will be notified about all new comments in this file." · Manage.

## Pins on the canvas

- Collapsed pin: 32×32, `border-radius: 16px 16px 16px 0`, bg #2c2c2c, the elevation shadow; the author's avatar 26×26 at 3,3 (a 1 px #2c2c2c border, round). Pins are DOM (`<clustered-pins>` with a shadow root) over the canvas; several pins close together cluster.
- Hover: the pin grows into a preview card from the same bottom-left point: 240×72 (grows with the text), same radius rule, bg #2c2c2c: avatar 26 at 12,12; name 11px/500 #fff at 46,14, then the relative time 11px/400 at 0.698 ("just now"); the text below at 46,30, 11px/400 #fff, wrapped to 180, up to two lines; a reply summary line (0.698) when there are replies.
- Resolved threads disappear from the canvas and the list unless "Show resolved comments" is on; then the pin is drawn dimmed (about half opacity).

## The thread (opened from a pin or a list row)

- A draggable card 360 wide, r 13, bg #2c2c2c, modal shadow `0 10px 16px rgba(0,0,0,.35), 0 2px 5px rgba(0,0,0,.35), inset 0 .5px 0 rgba(255,255,255,.08)`. aria "Currently expanded comment thread. Close this dialog to return to the board."
- Header 42 high with a 1 px #444 bottom border: "Comment" 11px/550 at 16,14; at the right [Thread actions] "•••" (272,9), [Mark as resolved] ✓-in-circle (300,9), [Close comment] ✕ (328,9), 24×24 each, 4 apart.
- Each comment: avatar 24 at 16 (rows start at y 54 from the card's top); name 13px/550 #fff at 48; time 13px/400 at 0.4 ("Just now", "1 minute ago", "2 minutes ago"; the full date in its tooltip/aria "Oct 11, 2026, 2:14 AM"); [Comment actions] "•••" 24×24 at 320; the text at 48, 13px/400 #fff, wrapped to ~283 (225 while the reaction button sits at its right); [Add reaction] (smiley) 24×24 at 320 on the text's first line when there are no reactions.
- Reactions under the text: a chip 47×32 (r 6, 1 px #0c8ce9 border and bg #32394d when you reacted) with the emoji 18px and the count 11px/600; then [Add reaction] 32×32. aria: `1 user reacted with ["👍"], clicking will remove your reaction`.
- Replies follow in the same layout, 24 below the previous comment block.
- The reply composer at the bottom: 296×40 at 48 (bg #383838, r 13), your avatar 24 at 16 to its left; placeholder "Reply"; aria "Reply to comment with <author>"; [Send] like the composer's.
- Screen-reader text "Reply added" after a reply.

### Menus

- [Thread actions] (114×72): **Mark as unread** · **Copy link** · **Delete thread...**
- [Comment actions] on the first comment (your own): **Edit**; on a reply (your own): **Edit** · **Delete comment**.
- The list row's [More Actions]: the same as Thread actions (Mark as unread · Copy link · Delete thread...).
- Delete confirm dialog 320×128, r 13: title "Delete comment" (11px/550) with ✕, a 1 px #444 line under the 40 px header, "Are you sure you want to delete this comment? This action cannot be undone.", footer (1 px #444 line above, 40 high) with "Cancel" (secondary) and "Delete" (50×24, bg #e03e1a, r 5).
- [Add reaction] opens an emoji picker (≈ 330 wide): category tabs (recent, smileys, nature, food, activity, travel, objects, symbols, flags), a search field, "Frequently used" (➕ 👍 👎 …), then "Smileys & People" grid.
- Resolving: the thread closes, toast "Comment resolved" · **Undo** · ✕.

## The list (Comments panel)

- One row per thread: a button 240×(120…) (aria "Select comment by <name>, <text>, <n> replies"), its inner box 224 wide at 8 (r 5): bg #383838 normally, **#394360 selected** (the open thread).
- Inside, from the top: the author's avatar 24 at 16,8; at the right [More Actions] "•••" (172,8) and [Mark as resolved] (200,8) — resolved threads show a filled grey ✓ and [Mark as unresolved]; "#1 · Test" (thread number · page name, 11px/450 at 0.698) at 16,38; name (11px/450, 0.898) + time (0.698) at 16,54; the text 11px/400 #fff at 16,70 (up to two lines); "1 reply" / "N replies" 11px/400 in #7cc4f8 at the bottom.
- The thread number (#1, #2…) is per file, in creation order.
