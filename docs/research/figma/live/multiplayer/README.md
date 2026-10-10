# Live Figma — multiplayer and sharing (2026-10-11)

Captured in the owner's file "wecra.co" (page "Test", empty) with two of the owner's accounts in the built-in browser: **A** = `burak.koc` (owner; the file is in A's Drafts, Professional team), **B** = `Burak Koç` (Free), who reaches the file through the link setting "Anyone · can view". Dark theme, Figma UI3, browser viewport 1206×863 (dpr 2). DOM measured with the `__dump2` helper (`../figma-dump.js`, plus borders and shadows); `x,y wxh` relative to the container named on each block. Screenshots stay local (`../img/`, git-ignored). Home's "Shared files" tab: `home-shared-files.txt`.

## Header people (right panel header, container `@966,0 240x48`)

```
11,12 24x24 button [Follow burak.koc]  r=50%      ← another session of A (another tab)
 9,10 28x28 ring div r=100% border=2px #2c2c2c   ← the ring is the panel colour: avatars cut into each other
21,4  4x2  div bg=#9747ff                         ← a 4×2 bar above each avatar in the person's multiplayer colour
32,12 24x24 button [Follow Burak Koç]   ring 30,10 28x28; bar 42,4 bg=#667799
54,12 50x24 button [Multiplayer tools] r=50px     ← YOUR avatar (bar 64,4 bg=#0c8ce9) + a count chip
74,10 28x28 div bg=#383838 r=9999px border=2px #2c2c2c; "3" 11px/450 #ffffff   ← people in the file, you included
124,8 49x32 Present group; 177,8 55x32 Share (bg #0c8ce9 r=5px, "Share" 11px/450)
```
Avatars step 21–22 px (overlap ≈ 3 px); the followed person's avatar gets an outer ring.

## Multiplayer tools (click on your avatar + count) — popover `@933,44 224x200`

```
16,16 24x24 avatar; 48,22 "burak.koc" 11px/450 #fff; 103,22 "(You)" 11px/450 #fff
16,50 156x24 button bg=#0c8ce9 r=5px "Spotlight me" 11px/450 #fff (centred)
180,48 28x28 button [Start conversation] r=6px (headphones glyph — audio)
"2 users found" (screen-reader only), 8,88 208x1 divider bg=#383838
8,96  208x48 button [Click to follow Burak Koç] r=5px: avatar 24 at (11,12), name 11px/450 at (43,18), 174,10 26x26 [More options]
8,144 208x48 next person …
```

## Observation mode (A follows B)

* The UI goes **minimized**: the left panel and the right panel are replaced by floating pills (file name pill top-left; avatars + zoom + Present + Share pill top-right), the toolbar stays.
* `multiplayer_viewport_overlay--viewportFrame`: the whole window `0,0 1206x863`, **border 5px solid <colour>** (B's #667799), radius 0.
* `multiplayer_bell` at the top centre, touching the top edge: `170.5x32`, bg = the colour, padding 0 4px; message "Following Burak Koç" 11px/500 rgba(255,255,255,0.898) padding 8px; button "Stop" 40.8x24 r=4px padding 2px 6px 11px/600 rgba(255,255,255,0.898), bg a darker shade of the colour (#30344c for #667799); the bar's bottom corners rounded (≈6px).
* Clicking Stop (or any canvas interaction) ends it; the UI comes back.

## Share dialog (A, owner) — `file_permissions_modal_base--modalContentContainer` `480 wide`

Two cards, each bg #2c2c2c r=13px, shadow `0 3px 5px rgba(0,0,0,.35), inset 0 0 .5px rgba(255,255,255,.35), 0 10px 24px rgba(0,0,0,.45), inset 0 .5px rgba(255,255,255,.08)`, 8 apart.

Card 1 (480×242):
```
0,0 480x40 header, inset bottom line #444444; 16,14 "Share this file" 11px/550 #fff; 389,14 "Copy link" 11px/450 #7cc4f8 (link style, no button chrome); 448,8 24x24 [Close]
16,56 387x34 field bg=#383838 r=5px (focused: border 1px #0c8ce9); input placeholder "Add comma separated emails to invite"
411,56 53x32 "Invite" button — empty field: bg=#757575 text #2c2c2c 11px/550 (disabled look); with an email: bg=#0c8ce9 text #fff
16,98 … suggestion chips 24 high r=5px bg=#2c2c2c inset ring #444444: avatar 16 + name 11px/450 ("Invite <email>" — recent collaborators)
16,142 "Who has access" 11px/550 rgba(255,255,255,0.698)
rows 36 apart, each 432x24: icon/avatar 24 at x 12, name at x 44 11px/450 #fff, role at the right edge 11px/450 #fff with a chevron
  "Anyone" … "can view"            ← the link row (globe icon); click → Share settings view
  avatar  "burak.koc" "(you)" (rgba(255,255,255,.698)) … "owner"
```
Invite bar with an email typed (`permissions_modal--inviteBar` 448×50): the email becomes a chip (158×24 bg #2c2c2c r=5px inset ring #444444, ✕ [Remove]), the input shrinks, a role select appears **inside the field** at its right: `81x24 bg=#2c2c2c r=5px border 1px #444444 "can view"` (default **can view**), menu = "can edit", "can view" (check column, 111 wide).

Card 2 (480×196): rows 464×36 r=5px, label at x 45: "Share selected frames to Community" (disabled, 0.4), "Publish to Community", "Copy Dev Mode link", "Get embed code" / "More", then a tinted row (bg #394360) "Ready to share with your team?" + "Move to folder" (#7cc4f8). (Drafts only.)

### Share settings (click the "Anyone · can view" row) — the same modal, 480×454

```
header: 8,8 24x24 [Back]; 40,14 "Share settings" 11px/500
16,58 "Who can access" 11px/500
16,84 448x32 select bg=#2c2c2c r=5px border 1px #444444 (globe icon) "Anyone" — menu: "People invited to file" | "<team name>" | "Anyone"
16,126 "Anyone, even those outside your organization, will be able to access this file." 11px/450 0.698
16,150 "What can they do" 11px/550 0.698
radios 16×16 (on: #0c8ce9, off: #383838, inset ring rgba(255,255,255,.2)): "View" | "Edit"
16,230 "Can view and comment on this file." 0.698
16,256 448x1 divider #444444; "Additional security" 11px/500; checkbox "Password required"
divider; "Advanced"; checkbox (on) "Viewers can copy, save, and export from this file" + "This setting applies to anyone in the file with **can view** access"
```

## Viewer (B: "can view")

* Bottom-centre banner above the toolbar, `527x40` bg=#394360 r=13px padding 8px, shadow `0 3px 8px rgba(0,0,0,.35), 0 1px 3px rgba(0,0,0,.5), inset 0 .5px rgba(255,255,255,.08), inset 0 0 .5px rgba(255,255,255,.3)`: info glyph, "You can only view and comment on this file." 13px/500 #7cc4f8, "Ask to edit" button 73×24 bg #0c8ce9 r=5px 11px/450 (tooltip "Any of this file's editors can give you access"), ✕ [Close].
* Right panel tabs **Comments | Properties** (instead of Design | Prototype); Comments panel: search "Search for comments", Sort/Filter, Settings, empty text "Give feedback, ask a question, or just leave a note of appreciation. Click anywhere in the file to leave a comment."
* Toolbar: Move, Hand, Comment, then the creation tools greyed; rail has only "File".

## Second capture (2026-10-11, later) — window 986×863

Comments: `comments.md`.

### Multiplayer tools, a person's row

* Hovered row: bg #0c8ce9 (r 5), the name moves up (y 10) and a second line "Click to follow" (11px/450 at 0.698) appears under it; [More options] "•••" 26×26 at 174,10 gets bg #105cad.
* The owner shows as "burak.koc (Owner)" in the others' lists.
* [More options] menu (115×48): **Ask to spotlight** · **View profile**.
* Ask to spotlight → the asker gets a toast "Asked <name> to spotlight". The asked person gets, over the **canvas** (the viewport between the panels, not the window — `multiplayer_viewport_overlay--viewportFrame` 338,0 407×863), a 5 px frame in the asker's colour and a bell at the canvas's top centre, 8 below the top edge: 322×32, bg a darker shade of the colour (#0a6dc2 for #0c8ce9), square corners; "burak.koc is asking you to spotlight" 11px/500 #fff; button **Spotlight me** 84×24 (bg #1e1e1e, r 4, 11px/600 #fff); ✕ 24×24 [Dismiss request to spotlight from <name>]. Spotlight me starts spotlighting (the asker then follows); ✕ dismisses. Observation mode's frame is the same element: with the UI minimized the canvas is the whole window, hence "the whole window" above.

### Share dialog, card 2 and links

* Card 2 rows: "Share selected frames to Community" (disabled), "Publish to Community" ›, "Copy Dev Mode link", "More" (•••). **More** expands in place into "Copy prototype link" (a gear button at the right → prototype link settings) and "Get embed code" ›.
* "Copy Dev Mode link": the row's right side shows **"Link copied!"** (11px, 0.698) for a moment. The header's "Copy link" turns into **"Link copied!"** (the link icon goes) for a moment.
* "Get embed code" replaces the card with **"Copy public embed code"** (Back ‹ at 8,8; title 11px/500 at 40,14; ✕): a read-only textarea 448×112 (bg #2c2c2c, r 5, selected on open, focus ring) holding
  `<iframe style="border: 1px solid rgba(0, 0, 0, 0.1);" width="800" height="450" src="https://embed.figma.com/design/<key>/<name>?node-id=<page or frame id>&embed-host=share" allowfullscreen></iframe>`;
  footer: "Embed **<page name>** in your webpage" (the page name 11px/800), Cancel, **Copy** (44×24 bg #0c8ce9).
* Share settings has a footer **Cancel · Save** (Save disabled until something changes); nothing applies until Save.
* "Password required" ticked: a **↻ Generate** button (77×24, text 0.698) at the right of the checkbox row ([Generate password]), and under it a 448×32 field "Add a password" (bg #3b3b3b, 1 px #444, r 5, monospace placeholder). Not saved in the capture (it would lock the owner's file).

### Audio

* [Start conversation] (headphones) → a widget at the canvas's top-right, 12 from the top and the right panel: 151×40, bg #2c2c2c, r 13, the small elevation shadow; your avatar 24 at 8,8, a microphone button 24×24 (crossed out, tooltip "Check your microphone permissions to start chatting." when the browser hasn't granted the mic), a Settings gear 24×24, "Leave" (an outlined 47×24 button, text at 0.4 while not connected).
* The others' Multiplayer tools keep showing [Start conversation] until the call is really connected (not checked further: the browser pane had no microphone).

### Remote cursor (1:1, viewport 800×700 CSS px)

Drawn in the canvas (not DOM). Another session's cursor at rest, pixels traced (`#` the colour, `w` the white rim):

```
tip (0,0) ─ #www
            ####ww
            ######.ww
            #########ww      ← the head reaches x ≈ 9.6 at y ≈ 4
            #########.w
            w####.wwww
            w####w           ← a short tail, x 1…4, down to y ≈ 10
            w###w
             w##w
             w##w
```
* Name chip: 61×17 for "Burak Koç", top left 10 right / 13 below the tip, corners ≈ 2, fill the person's colour (#f608b8 here), text Inter 11 (medium), white, 5 px from the left, the line box 2 px from the top.
* Cursor chat ("/") couldn't be opened from the automation (the key didn't reach Figma); its bubble stays as built in round 18.

## Not captured

* Remote cursors: B's tab was in the background and Figma drew no cursor for it (it hides idle / background sessions). The cursor look follows Figma's known style (arrow in the colour with a white edge, name chip below-right).
* A member row's role menu (no member besides the owner): Figma's is "can edit", "can view", divider, "Remove".
