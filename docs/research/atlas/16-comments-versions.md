# 16 — Comments, version history, branching

Figma Design desktop 126.9.13, read on 2026-10-16 from the cached editor build (`~/.cache/figma-rea/figma/`, outside
the repo), following `~/.cache/figma-rea/BRIEF.md`. Figma's code is not copied here: this file records behaviour,
numbers, enums, data shapes, endpoints and i18n keys, each with its evidence. **CONFIRMED** = read directly in the
build. **INFERRED** = deduced from what was read (or taken from the help site / live capture, which is said).

## 1. Scope and sources

**Scope.** Comments (the Comment tool, pins and clusters, threads, replies, reactions, mentions, attachments,
formatting, resolve, the Comments panel with sort / filter / search, notification settings, keyboard), version history
(savepoints and autosaves, the history panel, the version menu, restore / duplicate / link, plan limits), branching
(create, the branches modal, update from main, conflicts, review, merge, force merge, undo merge, archive / restore,
the diff categories) and the Activity log (org audit feed).

**Prior work, summarised and not repeated.**

- `docs/research/figma/R14-comments.md` (help site + REST): who may comment (view access and up), the 100 comments /
  hour rate limit, attachment to top-level frames only, cut/paste and "Move to page" rules, the sidebar filter list,
  notification defaults (owners: everything; others after two comments) and the 30-minute e-mail batching, the
  formatting shortcuts (⌘B / ⌘I / ⌘⇧X / ⌘K / ⌘⇧7 / ⌘⇧8), the mention list sizes (100 / 250 recent users), the REST
  `Comment` object. All still hold; §2 below adds the numbers the help site does not give.
- `docs/research/figma/live/multiplayer/comments.md` (live capture 2026-10-11): pixel geometry and colours of the pin
  (32×32, radius 16 16 16 0), composer (296 wide, r 13), thread card (360 wide), list rows, menus and toasts. It is the
  reference for look; this chapter adds the behaviour behind it.
- `docs/research/figma/R21-branching-ui.md` (help site + a third-party walkthrough): menu items, modal titles,
  badges, the conflict flow. §4 below confirms most "Unverified" rows from the build.

**Build sources read.** The minified chunks were reprinted with esbuild into the scratchpad; "fmt L" is a line in that
reprint (`esbuild <chunk>.min.js`, default options). Quoted snippets can be found in the minified file with `rg`.

| Source | What it gave |
|---|---|
| `2108.min.js` fmt L4330–4560 (module 870774) | Comment actions: create, reply, edit, delete, resolve / unresolve with Undo, move (client_meta), reactions, read receipts, toasts, failure handling |
| `2108.min.js` fmt L4850–5025 (562885, 459250) | Pin clustering, cluster click zoom, cluster config defaults, attachment thumbnail size |
| `2108.min.js` fmt L5300–5420 (50024) | Sort functions, filter predicates, search (replies match their thread) |
| `2108.min.js` fmt L5550–5570 (714530) | Emoji picker (emoji-mart), min width, flip rule |
| `2108.min.js` fmt L6100–6145, L6170–6200 | Reaction chips and overflow, comment / thread menus and who sees which item |
| `2108.min.js` fmt L6205–6310 | `message_meta` segment model, length counting, rendering of styles / lists / mentions |
| `4752.min.js` fmt L2895–3420 (93086) | The pin custom elements (`figma-comment-pin`, `figma-pinnable-comment-pin`, `figma-comment-selection-box`), drag manager, pin size, animations |
| `348.min.js` fmt L110–160, L1000–1030 | Keyboard: Tab between pins, arrow nudge of a pin, Esc; new-comment hit box |
| any chunk with `MAX_IMAGE_SIZE_EXCEEDED` (module with `l=100,c=1e8,d=30,u=3e7`) | Attachment limits and validation order, video thumbnail timing |
| `figma_app.min.js` fmt L60690–61040 (746892) | Version history panel: rows, autosave batches, filters, keyboard, load / view toast, paywall |
| `figma_app.min.js` fmt L83260–83330 | Savepoint ("Add to version history") modal |
| `3187.min.js` fmt L72740–72800 (746287) | Version row menu: items per role, restore (CMS confirm), duplicate, copy link, undo merge |
| `3187.min.js` fmt L12560–12715 (359236, 38359) | Merge / update entry, pre-merge savepoints, force-merge modal, create-branch modal |
| `3187.min.js` fmt L69040–69090 | Branch chunk phase badges |
| `figma_app.min.js` fmt L32380–32440 | Availability rules of every branching menu item (hidden / disabled + reason) |
| `fullscreen__fullscreen-wasm__compiled_wasm.wasm` (`strings -n 6`) | C++ files `FGBranching.cpp`, `FGBranchingStager.cpp`, `FGDiffChunk.cpp`, `FGAutosave.cpp`; stager states; chunk vocabulary |
| all chunks (`rg -o`) | i18n key inventory (`comments.*`, `collaboration.feedback.*`, `collaboration.branching*.*`, `activity_log.*`), REST endpoints |

## 2. Comments

### 2.1 Data model (CONFIRMED)

**Comment** (the client's thread/comment objects and the REST bodies it sends, `2108` fmt L4383–4540):

| Field | Meaning | Evidence |
|---|---|---|
| `id`, `uuid` | server id; client-generated uuid for optimistic create (Livegraph) | `optimisticallyUpdateWithUUID(...)` |
| `key` | file key | `A.Ay.url\`/api/file/${a2}/comments/${o2}\`` |
| `parent_id` | set on replies only; replies are one level deep | `e2.comment.parent_id ? "comments.delete_comment" : …thread` |
| `message_meta` | rich message (segments, §2.6) | `message_meta: t2.messageMeta` |
| `client_meta` | `{x, y, node_id, node_offset, page_id, viewport, in_frame, selection_box_anchor, stable_path}` | `clientMeta: { x: d2.x, y: d2.y, node_id: u2, node_offset…` |
| `resolved_at` | PUT `"true"` / `"false"` string toggles it | `{ resolved_at: c2 }` with `c2 = o2 ? "true" : "false"` |
| `order_id` | thread number in the file (top-level only) | `comments.number_only` / `parent_name_and_number` |
| `attachments` | list, see §2.7 | `attachment_updates: …` |
| `reactions` | `{emoji, users[], skinTonesToUsers}` per emoji | fmt L6101 |
| `isUnread` | per-viewer read receipt | `receiptsAPI.markAsRead(a2.comments.map(e8=>e8.id))` |
| `isPendingFromSinatra` | optimistic, not yet acknowledged | `comments.in_a_moment` shown instead of the time |

`in_frame` is the attachment flag: a thread pinned inside a top-level frame stores `node_id` + `node_offset` and
`in_frame: true`; the "Only current node" filter and the cluster's `anchoredNode` read it (fmt L4866, L5342).
`stable_path` is the node's path for nested anchors (`setActiveCommentAnchorData({ stablePath })`); a wasm string
validates it ("Invalid stablePath given to setActiveCommentAnchorData").

**Endpoints** (CONFIRMED, `rg -o 'url\`/api/…\`'` over all chunks):

| Action | Request |
|---|---|
| list / live | Livegraph subscription (`file.comments`), not REST |
| create | `commentsWriteApi.create({fileKey, messageMeta, attachments, pageId, uuid, clientMeta})` (POST `/api/file/:key/comments`) |
| reply | `commentsWriteApi.reply({threadId, threadUuid, uuid, messageMeta, attachments})` |
| edit | PUT `/api/file/:key/comments/:id` `{message_meta, attachment_updates, share_to_mentions, pending_mentions}` |
| resolve / unresolve | PUT same `{resolved_at: "true" \| "false"}` |
| move pin | PUT same `{client_meta}` |
| delete | DELETE same |
| reactions | `/api/file/:key/comments/:id/reactions` (toggle) |
| unread | `/api/file/:key/unread_comments`; `markAsRead(ids)`, `markAsUnread(id)`, `markAllAsRead()` |
| attachments | `/api/file/:key/file_comment_attachments[/:id]` |

Every write is optimistic: the UI changes first, the request runs, and a failure shows a red bell with the matching
`comments.an_error_occurred_while_*` key (resolving, unresolving, moving, editing, deleting, adding a reply, toggling a
reaction, marking read / unread). A server message in the error body wins over the fallback key (CONFIRMED,
`(0, n.J)(t3, r3)` pattern, fmt L4343–4370).

### 2.2 The Comment tool and placing a comment

| Behaviour | Value | Status / evidence |
|---|---|---|
| Tool / shortcut | `set-tool-comments`, key C; Shift+C `toggle-show-comments` (menu "Hide comments ⇧C") | CONFIRMED action ids (4752 fmt L3431); key letters from live capture + R14 |
| Tools under which existing pins can be dragged | COMMENTS, SELECT, SCALE, HAND, TYPE | CONFIRMED `Z = [u.NLJ.COMMENTS, u.NLJ.SELECT, …]` (2108 fmt L4862) |
| Pins ignore pointer events | while the Hand tool is held (setting), during a non-default user action, or with Multiselect | CONFIRMED fmt L4885 |
| New-comment hit box | 36.8 × 36.8 px around the click | CONFIRMED `width: 36.8, height: 36.8` (348 fmt L1006) |
| Click in an invalid area | bell `comments.comments_cannot_be_placed_in_this_area` | CONFIRMED (2108 fmt L5241) |
| Click on canvas with a composed but unsent comment elsewhere | bell `comments.finish_or_clear_your_active_comment_then_hit_view` | CONFIRMED fmt L4510 |
| Region comments | drag on the canvas: stored as `selection_box_anchor`; the box element `figma-comment-selection-box`, border 2 px, optionally drawn outside the bounds | CONFIRMED (4752 fmt L2982, `BORDER_WIDTH_PX = 2`) |
| Comment link | the URL gets `?comment=<threadId>` (replaced in history, not pushed); closing removes it | CONFIRMED `copyWith({}, { comment: o2 }).replaceInHistory()` (fmt L4492) |
| Opening a thread on another page | switches page first, then pans/zooms to the pin (`repositionViewportOnCommentSelection`) | CONFIRMED fmt L4505–4530 |

**After posting** (CONFIRMED, fmt L4471–4540):

- First comment or reply that makes you a file follower (`is_new_file_follower`): toast
  `comments.you_will_be_notified_about_replies` with **Manage** (opens the Comments panel's notification settings).
- Server `warning_message` (mention problems): toast type `at-mention-error` with that text.
- Create failure, network-type: red toast `comments.couldn_t_post_your_comment` + **Retry** (re-sends the same
  state). 4xx with a message: that message. Validation failure `comment_validation_failure` with
  `users_without_view / ext_users_without_view / uninvitable_users / user_groups_without_access /
  commenting_user_cannot_invite`: opens the "Post comment and share file" dialog (§2.8).
- A draft whose create never succeeded: sticky toast (`timeoutOverride: Infinity`)
  `comments.oops_one_of_your_comments_never_posted` with **View** (re-opens the draft).

### 2.3 Pins on the canvas (CONFIRMED, `4752` fmt L3040–3300 unless noted)

| Name | Value | Unit | Evidence |
|---|---|---|---|
| Custom elements | `figma-comment-pin`, `figma-pinnable-comment-pin`, `figma-post-pin`, `figma-comment-selection-box`, `<figma-avatars>` | — | `desiredElementName = …` |
| Pin height | 32 | px | `getPinSize(e2){ return { width: 23 * Math.min(e2-1, 2) + 32, height: 32 } }` |
| Pin width | 32 for 1 avatar, 55 for 2, 78 for 3+ (each extra avatar +23) | px | same |
| Max avatars on a pin | 3 (`MAX_PIN_AVATARS`), the avatar stack clamps at 2 + overflow | — | `clamp=${I.MAX_PIN_AVATARS - 1}` |
| Avatars listed in a cluster | first 5 users (by thread author, unread counts summed per user) | — | `avatars.slice(0, 5)` (fmt in 2108) |
| Pending delay | a pin of an unacknowledged comment shows a spinner only after 500 ms | ms | `PENDING_DELAY_MS = 500` |
| "New from others" animation | scale 0.2 → 1 in 400 ms, preview stays open 3500 ms (endDelay) | ms | `ANIMATE_NEW_DURATION = 400`, `ANIMATE_NEW_DELAY = 3500` |
| Join / split cluster animation | `translate3d(dx,dy) scale(.2)` over 200 ms | ms | `animate([...], { duration: 200 })` |
| Drag threshold | 5 px (Chebyshev: max of \|dx\|, \|dy\|) | px | `MIN_DRAG = 5` |
| Drag needs | left button, no modifier keys | — | `0 !== e.button \|\| e.ctrlKey \|\| e.altKey \|\| e.shiftKey \|\| e.metaKey` |
| Drag clamp | inside the canvas bounds, 20 px in from the right and top | px | `max:{x:i.x-20}`, `min:{y:t.y+20}` |
| Pin anchor | the pin's bottom-left corner sits on the comment point (`getPosition` scales by zoom) | — | `translate3d(${x}px, ${y}px, 0) scale(var(--scale,1))` |
| Pin states (attributes) | `hover-disabled`, `selected`, `dimmed`, `emphasized`, `preview` | — | `observedAttributes` |
| Selected state enum | NORMAL 0, ACTIVE 1, DIMMED 2 (others dim while one is open, when `dimUnselectedPins`) | — | module 3898 |
| Hover preview | author, short relative time, message (first lines; only `img`/`span` HTML allowed), reply summary, first attachment thumbnail | — | `previewText.innerHTML = sanitize(…, {ALLOWED_TAGS:["img","span"]})` |
| Reply summary | `comments.preview_reply_count` (count, or unread count with `new: true` when only some replies are unread) · attachment count | — | `getReplyPreviewString` |
| Context menu on a pin | `onPinContextClick` (right-click) | — | `oncontextmenu = this.onContextClick` |

**Clustering** (CONFIRMED, `2108` fmt L4859–4910, L5021; the distance-grid module):

| Config (default) | Value | Meaning |
|---|---|---|
| `minZoomPercentage` | 76 | below 76 % zoom, the merge distance grows |
| `zoomScaleOverlap` | 64 | extra merge distance per unit of zoom below that: `max(0.76 − zoom, 0) × 64` |
| base merge distance | `ceil(max(64, pinSize(3).w, pinSize(3).h) + overlap)` = `ceil(78 + overlap)` | screen px |
| `clusterClickResultViewportPercentage` | 35 | clicking a cluster zooms so its farthest pin sits within 35 % of the viewport's larger axis |
| `rebuildClustersZoomDelay` | 50 | ms debounce of re-clustering while zooming |
| Cluster click zoom | at least ×1.5 the current zoom, at most 1.26 (`0.76 + 0.5`) | `Math.min(u3, minZoomPercentage/100 + 0.5)` |
| Merge position | the cluster point is the thread-count-weighted mean of its members | `e.x*n/i + t.x*o/i` |
| Cluster id | rounded to 100 px buckets + count | `${100*Math.round(x/100)},${100*Math.round(y/100)},${n}` |

These defaults can only be changed through the internal debug tools (`internal_only_debug_tools`).

### 2.4 Threads, replies, menus (CONFIRMED, `2108` fmt L6170–6200 and the thread header)

- Thread header: `comments.comment_n` title, then (unless read-only) the header actions, **Thread actions** (`•••`), and
  the resolve toggle (`comments.mark_as_resolved` / `comments.mark_as_unresolved`, same key as tooltip and aria). The
  resolve control is hidden only by `hideResolve` or read-only; the client does not restrict it to the author
  (INFERRED: anyone who can comment can resolve; the server may refuse).
- Thread menu (on the root comment):
  - your own thread: [**Edit** if editable] · **Mark as read / Mark as unread** · **Copy link** · **Delete thread**;
  - someone else's thread: **Mark as read / unread** · **Copy link**.
- Comment menu (on a reply or the root inside the card): your own reply: **Edit** · **Delete comment**; your own root:
  **Edit** (delete is the thread's); others': nothing (or **Copy link** when offered). So **only the author edits or
  deletes** (CONFIRMED client-side; R14's REST note agrees).
- Delete confirm: `comments.are_you_sure_you_want_to_delete_this_comment_this_action_cannot_be_undone` /
  `comments.delete_confirmation_thread`; buttons `comments.cancel` / `comments.confirm` (live: "Delete").
- Edited comments show `comments.edited` after the text (a non-breaking space then the label).
- Pending (optimistic) comments show `comments.in_a_moment` instead of the time.
- Resolving: the open thread closes, a toast `comments.comment_resolved` with **Undo** (`comments.undo`), which
  un-resolves (CONFIRMED fmt L4385–4392). Batch resolves can suppress the toast (`suppressUndoToast`).
- Escape in the comments view: cancels a pin drag; with a thread open, closes the emoji picker first (348 fmt L1020).

### 2.5 Reactions (CONFIRMED, `2108` fmt L6100–6145; emoji data module)

| Item | Value |
|---|---|
| Picker | emoji-mart (`new u.LC({... previewEmoji: " " ...})`), categories: frequent, people, nature, foods, activity, places, objects, symbols, flags (`emoji_mart.categories_*`) |
| Picker size / placement | min width 334 px; opens above the target when the target's top is more than 405 px below the viewport top |
| Emoji identity | shortcode (e.g. `+1`), skin tone stored as a suffix modifier; the user's default skin tone is applied to toneable emoji on add |
| Chip | emoji + count; selected state when you reacted (aria `comments.reaction_selected_descriptive_aria_label_text`, else `…_unselected_…`), `aria-pressed` |
| Tooltip user list | up to 40 names (split evenly across skin-tone variants: `floor(40 / tones)`) |
| Overflow | chips laid out with a 10 px gap; when the row would exceed the width (keeping 40 + 10 px for the add button), the rest hide behind **`comments.num_hidden_more`** ("+N more"); clicking expands, and adding a reaction expands too |
| Add control | `comments.add_reaction` (smiley), compact variant in rows |

### 2.6 Message format, length, mentions (CONFIRMED, `2108` fmt L6205–6310, L51555)

- `message_meta` is an array of segments. Segment kinds: plain text `{t}`, styled `{t, styles: ["b"|"i"|"s"]}`,
  link `{t, link}`, editor mention `{user_id, user_annotated: {id, handle, img_url}}`, group mention `{user_group}`,
  community mention `{profile_id, t}`, lists `{styles: ["ol"|"ul"], children: [{children: segments}]}`. Emoji are
  text segments recognised by the emoji table. Enum: `editor_mention`, `community_mention`, `plain_text`, `emoji`.
- Rendering: bold, italic, strikethrough, mentions and links in a "lightbold" weight; ordered lists numbered
  `1. 2. …`, unordered `* ` in plain-text export. Inline code is not a comment style (`code: false`).
- **Maximum length: 2,000 characters**, counted in grapheme clusters (`Intl.Segmenter`) after trimming trailing
  whitespace (`maxCommentLength: … ?? 2e3`; `new Intl.Segmenter().segment(n2)`). An empty / whitespace-only message is
  not sent (`/^\s*$/`).
- Mentions: typeahead `comments.at_mention_listbox_label`; `comments.no_users_matched_your_search`. Sending with
  mentioned people who cannot view the file opens **"Post comment and share file"** (width 400):
  `comments.mention_confirm_warning` (count + names), external-organisation notes
  (`comments.please_note_that_*_external_to_your_organization`, `…guest_2fa_required`), buttons
  `comments.post_share` / `comments.post_anyway` / `comments.cancel_post_and_share`; the request is re-sent with
  `share_to_mentions: true` (gives them view access, `comments.mentioned_user_doesnt_have_access_adding_comment_will_give_them_view_only_access`).

### 2.7 Attachments (CONFIRMED, the upload-validation module)

| Rule | Value | Evidence |
|---|---|---|
| Max files per comment / reply | 5 | `e6({type: MAX_UPLOADS_EXCEEDED, params: {maxNum: 5}})`, `(0,en.KT)(t, e0, 5, …)` |
| Image size limit | 30 MB (3e7 bytes) | `d=30, u=3e7` → `MAX_IMAGE_SIZE_EXCEEDED, {maxFileSizeMB: 30}` |
| Video size limit | 100 MB (1e8 bytes) | `l=100, c=1e8` → `MAX_VIDEO_SIZE_EXCEEDED, {maxFileSizeMB: 100}` |
| Accepted image types | PNG, JPEG, GIF (+ HEIC / WebP in some lists) | `["image/png","image/jpeg","image/gif",…]` (INFERRED which list applies to comments) |
| Duplicate check | same name **and** lastModified as an already attached file → `already_uploaded_items` with the names | `t.name===e.name&&t.lastModified===e.lastModified` |
| Error enum | INVALID_FILE_TYPE 0, DUPLICATE_FILE_UPLOAD 1, MAX_VIDEO_SIZE_EXCEEDED 2, MAX_IMAGE_SIZE_EXCEEDED 3, MAX_UPLOADS_EXCEEDED 4, FAILED_TO_UPLOAD 5 | enum literal |
| Video thumbnail | first frame after `loadeddata` + 1 s; 10 s timeout; fallback a 1600×900 black frame; encoded as PNG | `setTimeout(…,1e3)`, `1e4`, `width=1600, height=900` |
| Thumbnail box | longest side 900 px, aspect kept | `function E(e2,t2,r2=900)` (2108 fmt L4852) |
| Attachment viewer | previous / next (`comments.attachment_previous` / `_next`), copy / download, alt text (`comments.alt_text`, `comments.edit_alt_text`) | keys |

### 2.8 The Comments panel: sort, filter, search (CONFIRMED, `2108` fmt L5305–5400)

**Sort** (single choice):

| Key | Label key | Order |
|---|---|---|
| `creationDate` (default) | `comments.sort_by_date` | root comment's `created_at`, newest first |
| `recent` | `comments.sort_by_last_action` | last reply's (or `lastRepliedAt`) time, newest first |
| `unread` | `comments.sort_by_unread` | threads with any unread comment first, then by creation date |
| `slide` / `asset` | Slides / Buzz only | keep order |

**Filters** (toggles, applied in sequence before sorting):

| Key | Label key | Predicate |
|---|---|---|
| `resolved` | `comments.show_resolved_comments` | default hides resolved (`!resolved_at`); toggling it on shows them. Opening a link to a resolved thread turns it on |
| `yours` | `comments.only_your_threads` | any comment in the thread is yours **or mentions you** |
| `currentPage` | `comments.only_current_page` | `thread.page === currentPage` |
| `currentNode` | (Dev Mode focus / node views) | root `client_meta.in_frame && node_id === node` |
| others | `only_current_slide`, `only_current_asset`, `only_latest_version` (Make) | other editors |

- **Search**: the query (an internal character normalisation applied) runs against an index of comments; a match in a
  reply returns its thread (`e4.item.parentId || e4.item.id`). Empty result: `comments.no_comments_matched_your_search`.
- Settings menu: `comments.hide_comments`, `comments.comment_notifications` with `comments.everything_option` /
  `comments.just_mentions_and_replies_option` / `comments.nothing_option` (enum `all`, `participating`, `none`),
  `comments.mark_all_as_read`. Errors `comments.error_loading_notification_preferences`,
  `comments.failed_to_update_notification_preferences`.
- Loading / failure: `comments.loading` (shown when loading runs long), `comments.failed_to_load_comments`.
- Opt-in toasts (CONFIRMED, figma_app): after a preference change `comments.you_will_be_notified_about_file_comments`
  (all) or `…_about_replies_and_at_mentions`, 15 s, with **Manage**. An experiment prompt
  `comments.get_notified_about_all_comments_prompt` with **Turn on** appears 5 s after the trigger and stays 15 s.
- List row aria: `comments.aria_label_select_comment_descriptive[_unread]`; row header `comments.parent_name_and_number`
  ("#n · Page") or `comments.number_only`; reply count `comments.reply_count`.

### 2.9 Keyboard (CONFIRMED, `348` fmt L110–160)

| Key | Effect |
|---|---|
| C / Shift+C | Comment tool / show-hide comments (action ids; key letters from live + R14) |
| Tab / Shift+Tab (pin focus mode) | next / previous pin. Order: nearest-neighbour walk starting at the pin with the smallest x+y (for ≤ 100 pins; above 100, list order). Wrap ends focus mode |
| Arrow keys on a focused pin | nudge it by the editor's small nudge; Shift: big nudge (`bigNudgeAmount` / `smallNudgeAmount`, 1 / 10 px by default — chapter 04) |
| Esc | cancel drag / close picker / close thread |
| Enter / Shift+Enter (composer) | post / new line (R14) |
| ⌘B ⌘I ⌘⇧X ⌘K ⌘⇧7 ⌘⇧8 | bold / italic / strike / link / numbered list / bulleted list (R14) |

## 3. Version history

### 3.1 Version records and kinds (CONFIRMED)

A version row carries `id`, `touched_at`, `label`, `description`, `user` (`handle`, `img_url`),
`participating_users_array`, `view`, `checkpoint_key`, `branch_file_key`, `disabled` (plan-hidden),
`dev_mode_activity`, `frameCreated / frameEdited / lastViewed` (Dev Mode compare).

`view` values (figma_app fmt L60700–60730, module 255839):

| `view` | Row text key | Kind |
|---|---|---|
| `file_default`, `file_multiplayer` | the editors' names (or "Figma System") | autosave unless labelled |
| `file_restore` | `collaboration.feedback.version_restored` / `version_restored_label` ({label}) | named |
| `branch_create` | `branch_created` | branching |
| `branch_update` | `branch_updated_from` ({link: main}) / `updated_from_main` | branching |
| `branch_merge` | `branch_merge` ({link}) / `branch_merged_into_main_and_archived` | branching |
| `branch_archive` | `branch_archived` | branching |
| `branch_restore` | `branch_restored` | branching |
| `branch_child_create` (on main) | `branch_child_create` ({link: branch}) / `new_branch_created` | branching |
| `branch_child_update` (on main) | `branch_child_update` / `branch_updated_from_main_file` | branching |
| `branch_child_merge` (on main) | `merged` ({link}) / `branch_merged` | branching |

A version counts as **named** (never folded into an autosave group) when it has a label, is any branching view, or is
`file_restore` (`AI = !!e.label || isBranching(e) || e.view === "file_restore"`). Everything else is an **autosave**.

### 3.2 Creating versions

| Item | Value | Status / evidence |
|---|---|---|
| Manual savepoint | POST `/api/multiplayer/:fileKey/create_savepoint` `{label, description}`; the reply's version is prepended to the list | CONFIRMED (module 443147) |
| Before merge / update | both the branch and main get a savepoint (empty label) before the merge modal opens; failure → `collaboration.branching.error_saving_file` | CONFIRMED 3187 fmt L12650–12668 |
| Before repairs | "Auto checkpoint before state group repair", "Failed to create savepoint before repairing overrides" | CONFIRMED wasm strings |
| Autosave interval | server side; not in the client. Help site: a checkpoint after 30 minutes of inactivity following edits | INFERRED (help); DesignerV2 uses 30 min |
| Shortcut | `create-savepoint`, labelled `collaboration.feedback.shortcut_mac` / `.shortcut`; `press_shortcut_to_add_to_version_history_while_editing` | CONFIRMED keys; ⌥⌘S / Ctrl+Alt+S from the help site (INFERRED) |

**Savepoint modal** (figma_app fmt L83260–83330, CONFIRMED):

- Title: `save_modal.add_to_version_history` (new), `save_modal.edit_version_information` (edit),
  `save_modal.edit_merge_details` (a merge version); width "lg".
- Fields: title input (placeholder / aria `fullscreen.savepoint_modal.title` / `title_label`; label
  `save_modal.merge_name_placeholder` when editing a merge), description (`save_modal.description_placeholder`,
  `fullscreen.savepoint_modal.description_label`; merges `give_this_merge_a_description`).
- **Save is disabled until the title is non-empty** (when the title is editable). Buttons `save_modal.save`,
  `save_modal.cancel`.
- `fullscreen.savepoint_modal.show_full_version_history` CTA enters history mode and keeps the typed text for when the
  modal reopens (static `keepSavepointModalInput`).
- View-only users never see it (returns null).

### 3.3 The history panel (CONFIRMED, figma_app fmt L60690–61040)

- Opening (`toggle-version-history`): runs `enter-history-mode`, deselects all, shows the properties panel side;
  topLevelMode becomes HISTORY (Dev Mode has its own `DEV_HANDOFF_HISTORY`). Closing: `exitVersionHistoryMode(canEdit)`.
- Header: `collaboration.feedback.version_history` (h2, focused on open), a **filter** button
  (`filter_tooltip`; aria `filters_enabled_aria_label` when on, blue state) and **+** (`add_to_version_history_tooltip`)
  and close (`close_tooltip`).
- Filter menu (`filter_menu_title`): radio **All** (`all_filter_text`) / **Only yours** (`only_yours_filter`, disabled
  for view-only), then a checkbox **Show autosave versions** (`show_autosave_versions`) — **default on**
  (`showAutosaves: true`). "Only yours" keeps rows where you are the user or among `participating_users_array`.
- Top row: **Current version** (`current_version`, id `current_version`).
- Rows, newest first, fetched **30 per page** (`/api/versions/:key`, `En(…, 30, …)`); **Show older**
  (`show_older`) loads the next page and moves focus to the first new row.
- Consecutive autosaves fold into a group "N autosave versions" (`autosave_count`) with a disclosure; a single autosave
  is not grouped. Groups auto-expand while no labelled versions exist, and the group holding the selected version
  expands when stepping with the keyboard.
- Row content: title (label or names), time (`time_hour_minutes` today, `time_date_minutes_without_year` this year,
  otherwise `date` / `time_date_minutes`), up to **5 editor avatars (15 px) with names**, then
  `num_editors_number_editor_count_more` when more than 4; description clamped with **Show more / Show less**; Dev Mode
  status badges; branch links (open the branch file).
- Click selects (debounced 300 ms); **double-click** opens the savepoint modal (name / edit). Up / Down arrows step
  through versions (skipping disabled ones), Esc closes when nothing is selected on the canvas.
- Viewing an old version: the canvas loads it read-only; after two animation frames a toast
  `collaboration.feedback.viewing_version` ({label or formatted time}) is shown, **cut to 34 characters + "…"**.
- Errors: `version_history_error`, `version_history_authentication_error`.

**Row menu** (`•••` `more_options`, or right-click; 3187 fmt L72768–72800, CONFIRMED):

| Role / version | Items, in order |
|---|---|
| editor, autosave / plain version | **Name this version** (`savepoint-label`) or **Edit version info** (`savepoint-edit`) · **Restore this version** · **Duplicate** · **Delete version info** (`savepoint-clear`, disabled when there is no label) · **Copy link** |
| editor, branching version | **Restore** · **Duplicate** · **Copy link** |
| editor, `branch_child_merge` | **Name / Edit** · **Restore** · **Duplicate** · **Copy link** · **Undo merge** (flag `branching_undo_merge`) |
| viewer | **Duplicate** · **Copy link** |
| Dev Mode history view | restore and clear are removed |

- **Restore** dispatches a restore of that version id (`source: VERSION_HISTORY`); files with CMS data first ask
  `cms_file_operations.cms_data_wont_roll_back` (Cancel / Continue). The restored state appears as a new `file_restore`
  version (INFERRED from the `file_restore` row type).
- **Duplicate** creates a new file from that version; on a Starter team over its limit it opens the upgrade modal
  instead. Disabled when the editor type is turned off for the org.
- **Copy link** puts a link with `version-id` in the clipboard, toast `link-copied`; failure bell "Failed to copy link".
- **Delete version info** clears label and description (the version itself stays).
- `compare_version` (`savepoint-compare`) exists as a label for Dev Mode's compare-changes modal
  (`compare_changes_modal.*`: header, layer name, "Frame created", "Section created", "Last viewed by you",
  "No changes", "Select a layer"); the 7-day window for "changes since last viewed" (`subtract(7,"days")`).

### 3.4 Plan limits (CONFIRMED where marked)

| Plan | History | Evidence |
|---|---|---|
| Starter | the last 30 days; older rows arrive `disabled`, at most 5 of them are shown greyed, with the upsell panel (`upsell.history.need_to_travel_back_in_time` when restricted rows exist, else `everything_else_is_history`; `upgrade_now`, `learn_more`) | CONFIRMED `filter(e3=>e3.disabled).slice(0,5)`, `consumption_paywalls.version_history.no_version_history_past_30_days` |
| Professional and above | unlimited (`consumption_paywalls.version_history.unlimited_version_history`) | CONFIRMED key; "unlimited" wording INFERRED |
| Clicking a disabled row | Starter: opens the paywall (`resource: VERSION_HISTORY`, upsell PRO) | CONFIRMED |

## 4. Branching

### 4.1 Model and engine (CONFIRMED wasm strings, INFERRED structure)

- A branch is a separate file in the same **repo** (`file_repo_id`) with `source_file_key` and
  `source_checkpoint_id` (the main checkpoint it was last in sync with). Update-from-main and "view source diff" are
  only enabled when main's `checkpoint_id` differs from the branch's `source_checkpoint_id` ("No changes" otherwise).
- C++: `FGBranching.cpp`, `FGBranchingStager.cpp`, `FGDiffChunk.cpp`. A diff (`DiffPayload`, `diffBasis`,
  `nodeChanges`) is cut into **chunks** (`mainChunk`, `branchChunks`, `sourceChunks`, `…SecondaryChunks`,
  `variableChunks`, `variantChunks`, `chunkDisplayNodeGUID`, `chunksAffectingThisChunk`); conflict detection returns
  `conflictGroups` / `conflictingChunkGroups`, `nonConflictingSourceChunkGUIDs`, `nonConflictingBranchChunkGUIDs`,
  `identicalChunkGUIDs`, `isMergeRequired`.
- Stager states: `STAGED_BRANCH_TIP`, `PREVIEW_BRANCH_TIP`, `DETACHED_BRANCH_TIP`, `RESET_TO_BRANCH_POINT`,
  `RECREATE_BRANCH_POINT`, `BEGIN_MERGE`; actions `enter-branching-mode`, `commitBranchingStagedChanges`,
  `abandonBranchingChanges`, `enterMergeDetachedState`, `recreateBranchPoint`. topLevelMode `BRANCHING`; the client
  waits for it in 30 × 16 ms polls.
- Directions: `TO_SOURCE` (merge into main) and `FROM_SOURCE` (update from main).

### 4.2 Who can do what (CONFIRMED, figma_app fmt L32380–32440)

| Item | Hidden when | Disabled when |
|---|---|---|
| Create branch | no file, recovery mode, limited space, editor type ≠ Design; plan not Org / Enterprise → shows an **upsell** state | file is copy/export restricted |
| Review and merge (to main) | not a branch, can't manage branch **or** main, branch archived, recovery | low memory, offline (outside branching mode) |
| Update from main | not a branch, can't manage branch, can't view main, archived, recovery | repo / files not loaded, **no changes on main**, low memory, offline |
| View source diff | not a branch, archived, recovery | can't view branch / main, no changes, low memory, offline |

Merging in the modal also needs edit rights: `branching_to_source.only_editors_of_file_can_merge_this_branch`,
`you_are_able_to_merge_this_branch_along_with_other_editors_of`.

### 4.3 Create branch (CONFIRMED, 3187 fmt L12690–12715)

- Modal width "sm", title `branching_create.title`, one input (aria `branching_create.input_label`), buttons
  `cancel_button` / `create_button`. **Create is disabled while the name is empty**; Enter submits. No naming rules
  in the client beyond non-empty.
- POST `/api/multiplayer/:sourceKey/branch_create?name=<name>` → `{file, source_file, repo}`; the branch opens in the
  same tab at the **same node** (`nodeId` kept). Failure: bell "Unable to create branch: <message>".
- Version rows: `branch_create` on the branch, `branch_child_create` on main.

### 4.4 Branches modal

`branching_modal.title`, tabs `tab_active` / `tab_archived` / `tab_yours` with empty states `tab_*_empty_state`,
`create_branch_tooltip`. Row actions (`branching.options`): `open`, `copy_link`, `rename`, `archive`, `restore`,
`delete` (each with an `_label` aria variant). Toasts: `branching.branch_archived` + `undo_archive`,
`branches_restored`, `files_trashed` + `undo_delete`, `files_restored`, `files_permanently_deleted`; errors
`error_archiving_branches`, `error_restoring_branches`, `an_error_occurred_while_renaming_this_file`, ….
An archived branch shows a footer: `branching_archived_footer.locked` / `merged`, `can_restore_branch`,
**Restore branch**, **Back to main file**. Archive = the branch file is trashed (`trashedAt`).

### 4.5 Diff categories and chunk display (CONFIRMED, 3187 fmt L69040–69090)

| Phase | Label key | Badge class / icon |
|---|---|---|
| `CREATED` | `branching_chunk.phase_created` | "added", 8 px icon |
| `UPDATED` | `branching_chunk.phase_updated` | "edited", 8 px icon |
| `REMOVED` | `branching_chunk.phase_removed` | "removed", 8 px icon |
| `UPDATED_LIBRARY` | `branching_chunk.phase_updated_library` | "updatedLibrary", 10 px icon |
| `UNMODIFIED` | — (no badge) | — |

- Chunks group by page and top-level node; non-canvas items (styles `local_style_type`, variables, components on the
  internal canvas) and annotation categories (`annotation_categories_*` added / edited / deleted counts) get their own
  sections; `header_other_changes`, `non_visible_updates` (+ description), `section_system_improvement` (+ tooltip).
- Tiles: `tile_variants`, `tile_variants_changed`, `tile_affected_items` (instances affected), fallbacks
  `fallback_missing_preview`, `fallback_missing_library_name`, `tile_empty_page_fallback`.
- Change details (`branching_chunk.change_details`): per property "added / changed / removed / edited"
  (`property_change_*`, `branching.chunk_details.*`), nested values rendered as lists; property and value names come
  from `collaboration.branching_node_treatments.property.*` (152 keys) and `.value.*` (154 keys) — Figma's own
  vocabulary of node properties for diffs. `guid` and `phase` are never listed.
- Views: **Side by side** (`branching.side_by_side`, left `side_by_side_left_label`, right `…_right_label`) and
  **Overlay** (`branching.overlay`, `overlay_show_after_image` / `overlay_hide_after_image`); zoom `zoom_in`,
  `zoom_out`, `fit`; `comparison_options`. Thumbnails are generated server-side
  (`/api/file_diff/file_merge/:a/:b/generate_images`, `/api/file_diff/checkpoint_diff/...`).
- Progress texts: `checking_for_changes`, `checking_for_conflicts`, `generating_changed_items`,
  `pulling_it_all_together`, `branching_merge_modal.calculating_conflicts`.

### 4.6 Update from main and conflicts

- Banner on the branch when main changed: `branching.updates_available_from_main_file` with **Update**
  (`branching.update`).
- Modal `branching_merge_modal.title_merge_from_source` (or `…_version`), `update_from_main_file`;
  `no_update_and_no_conflicts_from_main`; `this_branch_has_conflicts_with_the_main_file` with
  `banner_resolve_conflicts` / `button_review_conflicts`.
- Conflict view (`branching_from_source.*`): list in the left sidebar, `num_conflicts`, groups
  (`selected_conflict_group`, `selected_conflict_section`), **Keep main** / **Keep branch** (`keep_main`,
  `keep_branch`), the badge **Main** / **Branch** (`main`, `branch`), **Resolve all** → **Pick main file** /
  **Pick branch**, **Next** once all are picked, then **Confirm picks** (`confirm_picks`,
  `confirm_your_picks_as_well_as_additional_changes_that_may_be_pulled_into_your_file`), **Apply changes**
  (`apply_changes`, progress `applying_changes_from_main_file`, done `changes_applied` / `changes_kept`).
  Removed-on-main notes: `this_page_was_removed`, `this_frame_was_removed`, `this_component_was_removed`,
  `this_layer_was_removed`, `this_style_was_removed`. R21's "Unverified" pick labels are now CONFIRMED keys.
- Merge to main requires the update first: `updates_from_main_file_must_be_applied_before_merging` (and
  `…before_submitting_a_merge_request`), unless only optional (`updates_are_available_for_this_branch_but_you_can_merge_without_updating`).
  A merge blocked server-side: `couldn_t_proceed_with_merge_please_accept_updates_from_main_before_merging_your_branch`.

### 4.7 Review and merge

- **Request review** (`branching_to_source.*`): `add_reviewers`, suggested reviewers with **Add** / **Remove**,
  `other_team_member`, search `search_suggested`, `no_reviewers_added`, then description `add_context`
  (`branching_reviews.give_reviewers_more_context_for_your_changes`, `…latest_changes`), **Send to reviewers**
  (`branching_reviews.send_to_reviewers`), toast `request_submitted`; again: `resend_review_request`. Server:
  POST `/api/merge_requests`; reviewers `/api/merge_requests/:key/reviewers`; one open request per branch
  (`a_merge_request_is_already_open_for_this_branch`).
- **Reviewer**: `add_your_review` → `branching_reviews.finish_your_review` with **Approve** / **Suggest changes**,
  optional comment (`leave_a_comment`, `…_for_owner`, `…_for_owner_and_other_reviewers`), **Submit**;
  `/api/merge_requests/:key/approve|unapprove`. Badges `branching.in_review`, `approved`, `changes_suggested`;
  `review_again`, `reviewed_older_version_of_branch`; the branch's unread comments are flagged before merge
  (`you_have_unread_comments_on_this_branch`).
- **Merge**: `merge_branch`; **Edit merge description** (the savepoint modal in merge mode); toasts
  `branching.merge_pending` → `merge_success`, `merging`; summary `merging_branch_name_changes`,
  `no_changes_to_merge`, `conflicts_must_be_resolved_to_merge_this_branch`. After a merge the branch is archived
  (`branch_merged_into_main_and_archived`).
- **Concurrency**: a merge while another runs: `waiting_for_previous_merge`; error family `branching.merge_error.*`
  (could not start / in progress / review and confirm / retry / cancel / reload / contact support).
- **Memory**: `branching.file_out_of_memory`,
  `closing_other_tabs_and_reloading_figma_may_reduce_browser_memory_and_allow_you_to_continue_reviewing_and_merging_this_branch`;
  low memory disables the menu items (§4.2).

### 4.8 Force merge and undo merge (CONFIRMED, 3187 fmt L12600–12640, L72740–72760)

- **Force merge** (`branching_force.*`, width 400, destructive): to main — `merge_to_source_title` / `_description`,
  blocked when `isMergeRequired` (`merge_to_source_blocked_description`); from main — a radio "on conflicts keep"
  **Main** (default) / **Branch** applied to every conflict group at once.
- **Undo merge** (flag `branching_undo_merge`, editors only, only on a `branch_child_merge` version):
  `undo_merge_title`, `undo_merge_description`, Cancel / Confirm. Errors "Unable to undo merge", "Could not find branch
  key".
- Duplicate a branch as a new file: `duplicate-branch-as-new-file`.

## 5. Activity log (org audit feed)

`activity_log.*` (≈ 900 keys) is the org/enterprise admin's **Activity log**: a table (`table.date`, `team_member`,
`event`, `product`, `ip_address`, `date_range`, `load_more`, `get_csv` with `csv_requested_success / _error`,
`view_developer_log`), actor kinds (`anonymous_user`, `deleted_user`, `figma`, `scim_provider`,
`figma_scim_recovery`), sign-in events (`users.signed_in_google / _password / _saml / _app_auth_desktop / …`) and
file events (`fig_file_create`, `_duplicate`, `_export`, `_image_download`, `_rename`, `_move`, `_trash`,
`_restore`, `_permanent_delete`, `_view`, `_view_prototype`, link-access and password changes, export controls).
**No comment, version or branch events are logged** in this build (none of the 456 `event.*` keys name them).
There is no per-file activity feed in Figma Design besides version history and the comments list. (CONFIRMED key
inventory.)

## 6. UI strings (i18n keys)

The English text is given where attested: **[L]** live capture `docs/research/figma/live/multiplayer/comments.md`,
**[R14]**, **[R21]**, **[H]** help site. Keys without a note were read from the build only.

**Comments**
- `comments.add_a_comment` "Add a comment" [L] · `comments.reply` "Reply" [L] · `comments.search` "Search" [L] ·
  `comments.sort_filter` · `comments.settings`
- `comments.give_feedback_ask_a_question_or_just_leave_a_note_of_appreciation_click_anywhere_in_the_file_to_leave_a_comment` [L]
- `comments.sort` · `comments.sort_by_date` "Sort by date" [L] · `comments.sort_by_unread` "Sort by unread" [L] ·
  `comments.sort_by_last_action`
- `comments.show_resolved_comments` "Show resolved comments" [L] · `comments.only_your_threads` "Only your threads"
  [L] · `comments.only_current_page` "Only current page" [L]
- `comments.hide_comments` "Hide comments" [L] · `comments.comment_notifications` "Comment notifications" [L] ·
  `comments.everything_option` "Everything" [L] · `comments.just_mentions_and_replies_option` "Just mentions and
  replies" [L] · `comments.nothing_option` "Nothing" [L] · `comments.mark_all_as_read` "Mark all as read" [L]
- `comments.thread_actions` [L aria] · `comments.comment_actions` [L aria] · `comments.more_actions` [L aria] ·
  `comments.mark_as_unread` "Mark as unread" [L] · `comments.mark_as_read` · `comments.copy_link` "Copy link" [L] ·
  `comments.delete_thread` "Delete thread..." [L] · `comments.delete_comment` "Delete comment" [L] ·
  `comments.edit` "Edit" [L] · `comments.save` · `comments.cancel` · `comments.confirm` · `comments.discard`
- `comments.are_you_sure_you_want_to_delete_this_comment_this_action_cannot_be_undone` [L] ·
  `comments.delete_confirmation_thread`
- `comments.mark_as_resolved` "Mark as resolved" [L] · `comments.mark_as_unresolved` "Mark as unresolved" [L] ·
  `comments.comment_resolved` "Comment resolved" [L] · `comments.undo` "Undo" [L]
- `comments.close` "Close comment" [L aria] · `comments.comment_n` "Comment" [L] · `comments.edited` ·
  `comments.in_a_moment` · `comments.reply_count` "1 reply" / "N replies" [L] · `comments.preview_reply_count` ·
  `comments.number_only` "#n" · `comments.parent_name_and_number` "#n · Page" [L] · `comments.num_hidden_more`
- `comments.add_emoji` "Add emoji" [L] · `comments.add_mention` "Add mention" [L] · `comments.upload_images`
  "Upload up to 5 images and GIFs" [L] · `comments.add_reaction` "Add reaction" [L] · `comments.submit` "Submit" [R14]
  · `comments.post`
- `comments.you_will_be_notified_about_replies` "You will be notified about replies" [L] ·
  `comments.you_will_be_notified_about_file_comments` "You will be notified about all new comments in this file." [L] ·
  `comments.you_will_be_notified_about_replies_and_at_mentions` · `comments.manage` "Manage" [L] ·
  `comments.get_notified_about_all_comments_prompt` · `comments.turn_on`
- `comments.couldn_t_post_your_comment` · `comments.retry` · `comments.oops_one_of_your_comments_never_posted` ·
  `comments.view` · `comments.finish_or_clear_your_active_comment_then_hit_view` ·
  `comments.comments_cannot_be_placed_in_this_area` · `comments.unavailable_offline` · `comments.failed_to_load_comments`
  · `comments.loading` · `comments.no_comments_matched_your_search` · `comments.no_users_matched_your_search`
- `comments.an_error_occurred[_while_adding_a_comment_reply|_while_deleting_this_comment|_while_editing_this_comment|_while_marking_a_comment_as_read|_while_marking_a_comment_as_unread|_while_moving_this_comment|_while_resolving_this_comment|_while_toggling_a_comment_reaction|_while_unresolving_this_comment]`
- `comments.upload_error.media_file_maximum` · `.media_file_size_limit_MB` · `.media_file_types` ·
  `.already_uploaded_items` · `.failed_to_upload`
- `comments.post_comment_and_share_file` · `comments.mention_confirm_warning` · `comments.post_share` ·
  `comments.post_anyway` · `comments.cancel_post_and_share` · `comments.add_and_share` ·
  `comments.mentioned_user_doesnt_have_access_adding_comment_will_give_them_view_only_access` ·
  `comments.mentioned_user_wont_see_this_comment` · `comments.some_users_are_external_to_your_organization`
- `comments.attachment_*`, `comments.copy_attachment[_success|_error]`, `comments.download_attachment[_success|_error]`,
  `comments.alt_text`, `comments.edit_alt_text`, `comments.remove_attachment_label[_indexed]`
- aria: `comments.select_comment_by`, `comments.select_cluster`, `comments.accessibility_pin_region_name`,
  `comments.accessibility_reply_added` "Reply added" [L], `comments.reaction_(un)selected_descriptive_aria_label_text`
  (live: "1 user reacted with [..], clicking will remove your reaction") [L]
- Actions: `fullscreen_actions.set-tool-comments`, `fullscreen_actions.toggle-show-comments`,
  `fullscreen_actions.create-comment`; wasm bells `visual_bell.comments_hidden`, `visual_bell.comments_visible`

**Version history** (`collaboration.feedback.*` unless noted)
- `version_history` "Version history" [H] · `current_version` · `show_autosave_versions` "Show autosave versions" [H]
  · `autosave_count` · `all_filter_text` · `only_yours_filter` · `filter_menu_title` · `filter_tooltip` ·
  `filters_enabled_aria_label` · `add_to_version_history_tooltip` · `close_tooltip` · `show_older` · `show_more` ·
  `show_less` · `more_options` · `view_version_button_label` · `viewing_version` · `version_editor_count` ·
  `num_editors_number_editor_count_more` · `agent_co_author`
- `context_menu.name_this_version` "Name this version" [H] · `context_menu.edit_version_info` "Edit version info" [H]
  · `context_menu.restore_this_version` "Restore this version" [H] · `context_menu.duplicate` "Duplicate" [H] ·
  `context_menu.delete_version_info` · `context_menu.copy_link` "Copy link" [H] · `context_menu.compare_version` ·
  `context_menu.undo_merge`
- `save_modal.add_to_version_history` "Add to version history" [H] · `save_modal.edit_version_information` ·
  `save_modal.edit_merge_details` · `save_modal.merge_name_placeholder` · `save_modal.description_placeholder` ·
  `save_modal.save` · `save_modal.cancel` · `fullscreen.savepoint_modal.title` · `.title_label` · `.description_label`
  · `.give_this_merge_a_description` · `.show_full_version_history`
- `version_restored` · `version_restored_label` · `version_history_error` · `version_history_authentication_error` ·
  `time_hour_minutes` · `time_date_minutes` · `time_date_minutes_without_year` · `date` · `shortcut` · `shortcut_mac` ·
  `press_shortcut_to_add_to_version_history_while_editing`
- `branch` · `main_branch_name` · `branch_created` "Branch created" [R21] · `updated_from_main` "Updated from main"
  [R21] · `branch_merged` "Branch merged" [R21] · `branch_archived` · `branch_restored` · `new_branch_created` ·
  `branch_child_create` · `branch_child_update` · `branch_merge` · `branch_merged_into_main_and_archived` ·
  `branch_updated_from` · `branch_updated_from_main_file` · `merged`
- `compare_changes_modal.*` (header, current_image_header, layer_name_header, frame_created, section_created,
  last_viewed_by_you, no_changes, no_image_found, select_a_layer, history, error)
- `upsell.history.*`, `consumption_paywalls.version_history.*`, `scenegraph_and_sync.restore_version`,
  `scenegraph_and_sync.close_version_history`, `fullscreen_actions.create-savepoint`,
  `fullscreen_actions.toggle-version-history`

**Branching** (`collaboration.` prefix)
- `branching_create.title` "Create branch" [R21-ours] · `.input_label` · `.cancel_button` · `.create_button` "Create"
- `branching_modal.title` "Branches" [R21] · `.tab_active` "Active" [R21] · `.tab_archived` "Archived" [R21] ·
  `.tab_yours` "Yours" [R21] · `.tab_*_empty_state` · `.create_branch_tooltip`
- `branching.open` "Open" · `.copy_link` "Copy link" · `.rename` "Rename" · `.archive` "Archive" · `.restore`
  "Restore" · `.delete` · `.in_review` "In review" · `.approved` "Approved" · `.changes_suggested` "Changes suggested"
  · `.merged` "Merged" [R21] · `.archived` · `.side_by_side` "Side by side" · `.overlay` "Overlay" · `.zoom_in`
  "Zoom in" · `.zoom_out` "Zoom out" · `.fit` "Fit" [R21] · `.update` "Update" · `.updates_available_from_main_file`
  · `.edit_merge_description` "Edit merge description" [R21] · progress / error keys in §4
- `branching_from_source.keep_main` "Keep main" · `.keep_branch` "Keep branch" · `.resolve_all` "Resolve all" ·
  `.pick_main_file` "Pick main file" · `.pick_branch` "Pick branch" · `.next` "Next" · `.confirm_picks` "Confirm
  picks" · `.apply_changes` "Apply changes" · `.main` "Main" · `.branch` "Branch" [R21 all]
- `branching_merge_modal.*`, `branching_to_source.*`, `branching_reviews.*` (approve "Approve", suggest_changes
  "Suggest changes", submit "Submit", request_review "Request review", send_to_reviewers "Send to reviewers",
  finish_your_review "Finish your review" [R21])
- `branching_chunk.phase_created` · `.phase_updated` · `.phase_removed` · `.phase_updated_library` (English unknown;
  R21's third-party source reads "Added / Edited / Removed")
- `branching_force.*`, `branching.undo_merge_*`, `branching_archived_footer.*`
- Actions: `fullscreen_actions.create-branch` "Create branch..." [R21] · `fullscreen_actions.see-all-branches` "See all
  branches" [R21] · `fullscreen_actions.duplicate-branch-as-new-file` "Duplicate as new file" [R21]

## 7. DesignerV2 today

Compared with `src/renderer/src/editor/comments/*`, `src/shared/comments.ts`, `src/store/local/versions.ts`,
`src/renderer/src/editor/VersionDialogs.tsx`, `src/renderer/src/editor/branching/*`.

**Matches**
- Comment pin / composer / thread / list look and the Sort/Filter + Settings menus follow the live capture; Shift+C,
  Mark all as read, resolve with "Comment resolved · Undo", author-only edit/delete, the thread number, reactions and
  @mentions exist.
- Version history: 30-minute autosave checkpoints (`CHECKPOINT_INTERVAL_MS`), named versions with title and
  description, restore as a new version.
- Branching: create, the branches modal (Active / Archived / Yours), update from main with Resolve all › Pick main
  file / Pick branch and Keep main / Keep branch, request review, Approve / Suggest changes, badges, archive; change
  tags derived from `CREATED` / `REMOVED` / else.

**Differs**
- "Sort by date" in DesignerV2 orders by the **latest activity** (`last(b) - last(a)`); Figma's orders by the root
  comment's creation time and has a separate **Sort by last action**.
- "Only your threads": Figma also matches threads that **mention** you.
- Pin drag threshold 3 px (Figma 5 px, Chebyshev, left button without modifiers, clamped 20 px inside the canvas).
- Version history is a dialog with a Restore button per row; Figma has a right-side **history mode** panel with
  autosave groups, filters (All / Only yours, Show autosave versions), 30-row paging, keyboard stepping, a read-only
  preview of the selected version and a row menu.
- Change tags: DesignerV2 maps everything not created/removed to "Edited"; Figma has a fourth phase,
  **UPDATED_LIBRARY**, and no badge for UNMODIFIED.

**Missing**
- Comment attachments (5 per comment, 30 MB images / 100 MB videos), rich text (`message_meta` styles, lists, links,
  ⌘B/⌘I/⌘⇧X/⌘K), the 2,000-grapheme limit, region comments (`selection_box_anchor`).
- Pin clustering (78 px base distance growing below 76 % zoom, click-to-zoom at 35 %), multi-avatar pins
  (32/55/78 px), the 400 + 3500 ms "new comment" animation, Tab / Shift+Tab pin navigation and arrow nudging.
- "Post comment and share file" when mentioning people without access; notification opt-in toasts with Manage.
- Version menu items Name / Edit info / Duplicate / Delete version info / Copy link; Starter's 30-day limit with greyed
  rows; the "Viewing …" toast.
- Branching: savepoints on both files before a merge, force merge, Undo merge, UPDATED_LIBRARY phase and the
  per-property change details, merge-request lifecycle states (one open request per branch), low-memory / offline
  disabling rules.

### As built (2026-10-18, wave 6)

Built from the lists above, correctness first. Code: `src/shared/comments.ts`, `src/store/comments/service.ts`,
`editor/comments/{clusters.ts,CommentsLayer,Composer,Thread,CommentsPanel,attachments,richText}`;
`editor/{versionList.ts,VersionHistory,VersionDialogs}.tsx`; `src/shared/merge/{merge3,types,branches}.ts`,
`src/store/branches/service.ts`, `editor/branching/*`.

- **Sort and filter (§2.8).** "Sort by date" orders by the first comment's time; **Sort by last action** (new) by the
  last reply's; "Sort by unread" puts unread first, then by date. "Only your threads" also keeps threads that mention
  you (by id or email). A link to a resolved thread turns "Show resolved comments" on. (The English of
  `comments.sort_by_last_action` isn't read: "Sort by last action" from its key.)
- **Length (§2.6).** 2,000 characters counted as grapheme clusters after trailing whitespace (`commentLength`, the
  composer, the store and the server's check); past it nothing is sent.
- **Pins (§2.3).** As wide as their faces: the thread's author then whoever replied, 32 / 55 / 78, two faces and "+N"
  past three. The drag: 5 px Chebyshev, a plain left press only (a modified press still opens), dropped at least 20 px
  in from the canvas's right and top. **Clusters**: pins within `ceil(78 + max(0.76 − zoom, 0) × 64)` screen px merge
  (nearest cluster within that distance, grid cells of that size), at the thread-weighted mean, id
  `100·round(x/100),100·round(y/100),n`, rebuilt 50 ms after the zoom stops; the open thread stays alone; a cluster
  shows its first five authors' faces (clamped as a pin); its click zooms to fit its farthest pin in 35 % of the
  viewport's larger side, at least ×1.5, at most 1.26 — past 1.26 (pins merging even there) ×1.5 rather than a zoom
  out (what Figma does then isn't read). **Tab / Shift+Tab** with the Comment tool walk the pins (nearest neighbour
  from the smallest x + y, list order past 100; past either end back to the canvas — the key that enters focus mode is
  §8's question, here Tab from the canvas); arrows nudge the focused pin by Preferences › Nudge amount (⇧ big), Esc
  leaves. Others' new threads grow from 0.2 over 400 ms with their preview open 3.5 s.
- **Attachments (§2.7).** Picked ([Upload up to 5 images and GIFs]), pasted or dropped: Figma's checks in its order
  (type → duplicate by name + lastModified → 100 MB video / 30 MB image → 5 in all), the enum's errors as toasts; bytes
  in the store's blobs (kept by the GC through `comments.blobRefs`), a video's picture its frame 1 s in (10 s at most,
  else black 1600 × 900, PNG); thumbnails under the text, the first in the pin's preview with "N attachments"; a viewer
  with Previous / Next (← →) and Download. A comment of files alone needs no text. **A local file's comments only**:
  the server keeps no files yet (Phase 6), and the composer offers none in a shared file. Accepted types: PNG, JPEG,
  GIF and MP4 / QuickTime / WebM (§8's question).
- **Rich text (§2.6).** The composer is a rich field: ⌘B ⌘I ⌘⇧X, ⌘K (a link row under the field), ⌘⇧7 / ⌘⇧8 lists,
  Shift+Enter a new line or list item, @mentions picked as one piece, paste as plain text. Kept as `messageMeta`
  segments (Figma's shapes: `{t, styles: ["b"|"i"|"s"]}`, `{t, link}`, `{t, user_id}`, `{styles: ["ol"|"ul"],
  children}`) beside `message`, their plain text (lists "1. " / "* "), only when they say more than the text; drawn in
  the thread, the list and the preview. A local file's comments only (the server keeps `message`).
- **Notifications (§2.8).** After a setting change: "You will be notified about all comments in this file" / "…replies
  and @mentions", 15 s, Manage.
- **Version history (§3.3).** History mode: File › Show version history toggles it, deselects, and the history panel
  takes the right panel's place — "Version history", the filter (All / Only yours, Show autosave versions, on by
  default; blue when on), + (Add to version history), close; "Current version"; versions newest first, 30 a page with
  Show older; two or more autosaves in a row folded into "N autosave versions" (open while no named version exists, or
  holding the selected one); a named version is one with a title, a restore, publish, import or any branching one. A
  click (300 ms) shows the version on the canvas, read-only, in an engine of its own over the editor's (its own pan and
  zoom, the editor's camera and page to start), with the "Viewing …" toast (34 characters + "…") two frames later;
  ↑ / ↓ step, Esc leaves, a double-click names it. The row menu (••• or right-click): Name this version / Edit version
  info, Restore this version, Duplicate (Drafts, with Open), Delete version info (off without info), Copy link
  (`?version-id=…`, which opens the history on it) — branching versions Restore, Duplicate, Copy link; main's "Branch
  merged" also **Undo merge**. The savepoint modal: "Add to version history" / "Edit version information", Save off
  until the title has text, "Show full version history". "Only yours" filters nothing yet: versions don't record
  their editors (one author locally; the server's will, Phase 6). Starter's 30-day limit: none (a personal app is
  Enterprise).
- **Branching (§3.2, §4.2, §4.5, §4.8).** Savepoints on both files before an update and before a merge (at apply, not
  as the modal opens: one per change rather than per look); main's is the record's `preMergeVersionId`. **Undo merge**:
  main restored to that savepoint (the editor's restore: one undo step and a restore version) and the branch active
  again (`branches.undoMerge`; local merges only). **Force merge / Force update**: every conflict kept from one side
  (Main by default) without picking them one by one (Figma's `branching_force`, its English not read). **UPDATED_LIBRARY**:
  a library copy the incoming side updated is tagged "Updated library". **Change details**: each changed layer of a
  chunk with its properties added / changed / removed (the panel's words for the fields it shows, the field's name
  otherwise — Figma's 152-key vocabulary isn't read in English), the first 50 layers. Gates: Update from main only once
  main changed; neither it nor Review and merge while a shared branch's link is down.

**Not done:** region comments (`selection_box_anchor`: where the pin sits on the box isn't read); "Post comment and
share file" and the server side of files and rich text in shared files (Phase 6); the pending spinner (no optimistic
layer); the merge-request lifecycle (one open request per branch is the server's); low-memory gates (no memory model
yet); Dev Mode's `savepoint-compare`.

**Sweep (2026-10-18)** — branch `worktree-agent-a44e0af86efbcac0b`.

- **Pending comments (§2.1, §2.3):** a new comment or a reply shows at once, before the store (or a shared file's server) answers — the composer closes, the thread or reply is there with "In a moment" for its time (`comments.in_a_moment`; the English is ours from the key), its pin shows a spinner only after 500 ms (`PENDING_DELAY_MS`); the store's answer replaces it; a failed write takes it away and gives the new comment back to its composer with its text (`commentsController.ts` `pendingComment` / `withPending`; `Comment.pending` is never kept). Edits, resolves, reactions and moves still wait for the store (they take milliseconds locally).
- **"Only yours" (§3.3):** versions record their editors (`VersionRecord.editors`, the account signed in when the version is made); Only yours keeps the versions that name this account and — **data safety** — every version made before they were recorded (or signed out), which on a local file can only be this person's. Nothing is migrated or rewritten.

**Still not done:** region comments (Q: where the pin sits on the box); the server side of attachments and rich text, "Post comment and share file" and the merge-request lifecycle (requests, reviewers, approvals are the server's — Phase 6); a shared file's version editors (the server's); low-memory gates; Dev Mode's `savepoint-compare`.

**Phase 6 (2026-10-18, `docs/multiplayer.md` §18.6–§18.9):** a shared file's versions record their editors (Only yours works for them); its comments keep their rich text on the server (migration 0028); the merge request's lifecycle — a verdict on an older version says so, Withdraw review (Figma's unapprove), Close request (migration 0029). Still not: attachments in shared files' comments, "Post comment and share file".

## 8. Open questions

| Question | Live probe that settles it |
|---|---|
| Server autosave rule: the exact idle time and whether a checkpoint is also cut on close / every N edits | Edit a file, stop for 25 / 35 min, watch `/api/versions/:key` in DevTools |
| English text of `branching_chunk.phase_*`, `collaboration.feedback.autosave_count`, `version_editor_count`, `comments.sort_by_last_action`, `comments.num_hidden_more` | Load the English bundle (`/webpack-artifacts/.../en.json`) or capture the UI |
| Which MIME list applies to comment images (HEIC / WebP accepted?) and the accepted video types | Drop a .webp / .heic / .mov into the composer |
| Who may resolve another person's thread on the server (the client always shows the control) | Second account with "can view" resolves the owner's thread |
| The plan gate for "Show autosave versions" and the Pro / Org retention wording | Open history on a Pro and an Org file |
| Pin focus mode trigger (which key enters Tab navigation) | With the Comment tool active, press Tab and watch focus |
| Whether `savepoint-compare` appears in Figma Design (not only Dev Mode) | Right-click a version row in Design and in Dev Mode |
