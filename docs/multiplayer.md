# Multiplayer, accounts and sharing — on Cloudflare

Contract for roadmap Phase 6 (owner's decision 2026-10-10: Cloudflare instead of Firebase, Google sign-in). Figma's model (R1/R2; "How Figma's multiplayer technology works"): one authoritative process per file, kiwi `NODE_CHANGES` carrying only touched fields, server order decides, per-property last writer wins, optimistic clients, undo of one's own changes only, presence on an ephemeral channel.

## 1. Pieces

| Piece | Cloudflare | Code |
|---|---|---|
| HTTP API, sign-in, sharing | Worker `designer` → `https://designer.burak-kc-sp.workers.dev` | `server/src/index.ts`, `server/src/api.ts`, `server/src/auth.ts` |
| One room per file (sequencer, journal, snapshot, presence) | Durable Object `FileRoom`, SQLite storage, WebSocket hibernation | `server/src/fileRoom.ts` around the pure `src/shared/multiplayer/room.ts` |
| Accounts, files, members, sign-in codes | D1 `designer` | `server/schema.sql`, `server/src/db.ts` |
| Images of shared files | the room's SQLite (`blobs`, 1 MB chunks) — no R2 | `server/src/fileRoom.ts` |
| Developer previews (package + viewer page at `/p/<id>`) | Durable Object `PreviewObject` per preview (SQLite, 1 MB chunks), D1 `previews` (migration 0007), Workers Static Assets (`out/viewer`) | `server/src/previews.ts`, `server/src/previewObject.ts`, `src/store/preview/previews.ts`, `src/viewer/remote.ts` (§9) |
| Notifications (the bell; live to each person's apps) | D1 `notifications`, `notification_prefs` (migration 0008), Durable Object `Inbox` per user (hibernated WebSockets) | `server/src/notifications.ts`, `server/src/inbox.ts`, `src/store/notifications/service.ts` (§12) |
| Organizations: workspaces, teams, folders, seats, groups, Admin, activity log (contract, Phase 7) | D1 (migration 0010), no new Durable Object | `server/src/org/`, `server/src/activity.ts`, `src/shared/org/`, `src/store/org/` (§14) |
| Wire format | — | `src/shared/multiplayer/protocol.ts` |

Free plan limits that matter: 100k Worker requests a day (a WebSocket message counts 1/20 of a request), Durable Objects on SQLite storage, D1 5 GB, R2 10 GB. One person and a few friends stay far below them.

## 2. Sign-in (Google, the server holds the secret)

The desktop app never holds a Google secret; the Worker runs Google's web OAuth flow and hands the app its own session token through a loopback, with PKCE between app and Worker.

1. Main starts a loopback HTTP server on `127.0.0.1:<random port>`, makes `state` and a PKCE `verifier`, opens the system browser at `GET /auth/login?port=<p>&state=<s>&challenge=<S256(verifier)>`.
2. The Worker keeps `{port, state, challenge}` in a signed, 10-minute cookie-less `oauthState` (HMAC) and redirects to Google (`openid email profile`, `prompt=select_account`), `redirect_uri = <origin>/auth/callback`.
3. `/auth/callback` exchanges Google's code (client secret = Worker secret `GOOGLE_CLIENT_SECRET`) over HTTPS — an ID token received straight from Google's token endpoint needs no signature check; `iss`, `aud`, `exp` and `email_verified` are checked. The user is upserted (key: Google `sub`), pending invites for that verified email become memberships, and a one-time **sign-in code** (2 minutes, bound to the challenge) is stored in D1. The browser is redirected to `http://127.0.0.1:<port>/callback?code=…&state=…` and shows "You can close this tab".
4. Main checks `state` (constant time), then `POST /auth/token {code, verifier}` → `{token, user}`. The code is single-use.
5. **Session token**: `v1.<base64url(JSON {uid, tv, exp})>.<HMAC-SHA256>` with Worker secret `SESSION_SECRET`, 30 days; `tv` = the user's token version (Sign out everywhere bumps it). Main keeps it with `safeStorage` (`userData/account/session.bin`) and gives it to the store process; no renderer sees it.
6. Local development: `wrangler dev` with `DEV_AUTH=1` in `server/.dev.vars` enables `POST /auth/dev {email, name}` — never set in production.

### 2.1 Device ordinals and the web app

- **Device ordinals**: new nodes' GUIDs are `(deviceOrdinal << 20) | n` (src/shared/schema/guid.ts) and every installation started at 1, so two people would mint the same ids. On a session the store asks `POST /devices {installationId}` (D1 `devices`, migration 0002): one ordinal per installation, 2…4095, unique on the server, kept in `userData/device.json` (desktop) or the dev store's storage (browser). Edit sessions opened afterwards use it; sessions opened under the old ordinal stay valid on reattach.
- **The web app** (`npm run web`, origins in the Worker var `WEB_ORIGINS`): `/auth/login?return=<page>` instead of `port=`; Google's answer comes back to the page as `auth_code` / `auth_state` / `auth_error`, the page trades the code itself (`src/renderer/src/store/webAccount.ts`), CORS answers the listed origins only. The session lives in localStorage; `VITE_DESIGNER_SERVER` points the page at another server.

## 3. Files, roles, sharing (Figma's wording)

- A file becomes shared when its owner chooses **Share** › invite (or "Anyone with the link" later). Until then it stays local-only, exactly as today.
- Roles: `owner`, `editor` ("can edit"), `viewer` ("can view"). Viewers receive changes and presence but cannot send changes or snapshots.
- Invites are by email; an email with no account yet waits as a pending member until that Google account signs in.
- **Anyone with the link** (migration 0003, `files.link_access` none / viewer / editor; owner sets it in the Share dialog): a signed-in person with the link gets that role. The link is `<server>/f/<key>`, a page that hands the key to the desktop app (`designer://open?key=…`, registered by main; Home opens it) — or paste it in Home › Shared with me › Open link (the browser also takes `?files&shared=<key>`). Turning it down closes the sockets of everyone but the owner (`/room/revoke-link`); members reconnect, link-only people are refused.
- D1 tables (`server/schema.sql`): `users`, `files`, `members (file_key, email, user_id?, role)`, `auth_codes`.

API (JSON, `Authorization: Bearer <session>`):

| Route | Who | Does |
|---|---|---|
| `GET /me` | signed in | the user |
| `GET /files` | signed in | files the user owns or is a member of, with role |
| `POST /files {key, name}` | signed in | registers a local file as shared, caller = owner |
| `PATCH /files/:key {name}` | editor+ | rename |
| `DELETE /files/:key` | owner | stops sharing, drops the room |
| `GET /files/:key/members` | member | members and pending invites |
| `PUT /files/:key/members {email, role}` | owner | invite / change role |
| `DELETE /files/:key/members/:email` | owner | remove |
| `GET /files/:key/snapshot` | member | `{seq}` header + kiwi bytes of the latest snapshot |
| `PUT /files/:key/snapshot?seq=N` | editor+ | uploads a snapshot at seq N; frames ≤ N are dropped |
| `GET /files/:key/ws?token=` | member | the room's WebSocket (token in the query: browsers can't set headers on a WebSocket) |

The Worker resolves the caller's role before forwarding to the Durable Object (headers `x-user-id`, `x-user-name`, `x-role`); the object is reachable only through the Worker's binding.

## 4. The room

`src/shared/multiplayer/room.ts`, pure and tested in Node; `FileRoom` gives it SQLite storage and hibernatable WebSockets (each socket's identity and presence in its serialized attachment, so a woken object rebuilds its members).

- Frames: client → `[u8 1][u32 batch][kiwi Message]`; server → `[u8 2][u32 seq][u32 sessionID][u32 batch][kiwi Message]`. The room never decodes the kiwi payload: it numbers it, stores it, sends it to everyone — the sender too, as its acknowledgement.
- `hello {since}` → `welcome {sessionID, seq, peers}`, the frames after `since`, `ready`. `sessionID` is unique per file (a counter in the object's storage) — new nodes' GUIDs use it, so two sessions never mint the same id.
- A frame is at most 1.9 MB (an SQLite value holds 2 MB); images travel as blobs through R2, not in frames.
- Snapshots: SQLite rows of 1 MB chunks with their `seq`. A client joining loads the snapshot, then says `hello {since: snapshotSeq}`. An editor's client uploads a new snapshot when the journal passes 2,000 frames or 8 MB; older frames are dropped. A client whose `since` is older than the first kept frame gets `too-old` and reloads from the snapshot.
- Presence (`{t: "presence", data}`: cursor, selection, viewport, page) is relayed to the others, remembered per socket for newcomers, never stored.

## 5. The client (as built 2026-10-11)

- `src/store/multiplayer/service.ts` (`MultiplayerService`, no Node or DOM imports) runs in both stores (LocalStore in the store process, MemoryStore in the browser) and is the store's `multiplayer` repository (`src/shared/multiplayer/types.ts`; `setSession` main-only; events on topic `multiplayer`). One link per shared file, persisted per file (`{key, since, acked, sessions, role}`): every local journal frame goes to the room as one batch (batch = its local seq); the room's frames from other sessions are appended with `appendRemote` (`kind: "remote"`) and reach the open editor as `file.changes` → `engine_apply_changes(…, APPLY_REMOTE)` with no change to the editor. Own frames (any room session this link has been) acknowledge.
- Share: the editor flushes, encodes the document and reads `knownHeadSeq` in one task; the store registers the file, uploads that snapshot at seq 0 and marks the frames up to `headSeq` acknowledged. Join: `openShared(key)` downloads the room's snapshot and makes a local file from it **without GUID remapping** (`createSharedFile`), linked at the snapshot's seq.
- Desktop: main hands the session to every store start (`onStoreReady`) and on sign-in / out. Browser: each tab's dev store gets it from localStorage; only the tab editing a file joins its room (`setSession(…, {only: [fileKey]})`), Home tabs none — tabs share one storage.
- UI: Share dialog's people section (`editor/SharePeople.tsx`: invite "can edit" / "can view", Who has access with role menus and Remove, Live / Connecting / Offline), Home's "Shared with me" (`files/SharedFiles.tsx`, signed in only).
- **Figma's conflict rule on the client**: while a batch is unacknowledged, remote values for the properties it touched are ignored (they would be overwritten by it in server order anyway); when its echo arrives the client's state equals the server's. On reconnect, unacknowledged batches are resent after `ready`.
- The remote session is one more engine actor (docs/engine.md §9.5): the user's ⌘Z skips fields others changed since.
- Offline: edits keep landing in the local journal; on reconnect the store sends what the room hasn't acknowledged.

## 6. Order of work

1. Room core, protocol — **done** (`room.test.ts`, 8 cases).
2. Server — **done, not deployed**: auth (Google flow, session tokens, dev sign-in), D1 schema and API, `FileRoom`, `wrangler.jsonc`; `server/src/api.test.ts` (8 cases on `node:sqlite` with the real migration); smoke against `wrangler dev` (real workerd, local D1 and Durable Object): dev sign-in, share, a 3 MB snapshot in 3 chunks read back whole, two sockets in one order with the sender echoed, presence, a late viewer caught up from `since`, the viewer's write refused, compaction (`too-old`, forward-only snapshots), a role change closing with 4003, unsharing with 4001 — 18 / 18.
3. Desktop sign-in — **done, untried against real Google**: `src/main/account/` (loopback + PKCE in `signIn.ts`, its test running the whole chain through the Worker's handler; session sealed with `safeStorage` in `userData/account/session.json`; `checkSession` at launch drops a session the server refuses, keeps it offline), IPC `account:get / sign-in / cancel-sign-in / sign-out` and the `account:changed` event, Home's account row as a button with Figma's menu ("Log in with Google…" / the email over "Log out"; `files/account.ts`, `account.dom.test.ts`). `DESIGNER_SERVER` points the app at another server (e.g. `http://localhost:8787`). The avatar shows initials: the renderer's CSP allows no outside images yet.
4. Store client — **done (2026-10-11)**: §5; `src/store/multiplayer/service.test.ts` (7 cases: two installations through the real API on node:sqlite and the real room — share, join, both ways, Figma's rule, offline edits resent, restart, viewer), `conflict.ts`; device ordinals and the web sign-in (§2.1; api tests 11). Checked in the browser against `wrangler dev`: Alice (localhost:5199) shares a demo file and invites Bob, Bob (127.0.0.1:5199) opens it from Shared with me, edits go both ways live, Bob reloads and reopens with Alice's change kept, and his next edit reaches Alice. Server redeployed with migration 0002 and `WEB_ORIGINS`. Not done: images in shared files (R2), cursors (step 5), compaction by clients (`too-old` stops a link — a fresh copy is needed).
5. Presence: cursors with names, selections, avatars in the toolbar, follow / spotlight.
6. Presence, images, history, links — **2026-10-11**:
   - Presence (`editor/multiplayer/presence.ts`, `Multiplayer.tsx`): cursor (page coordinates), page, selection and view sent at most every 100 ms when changed; peers' cursors eased each frame and handed to the engine (`setPresence`, drawn in the overlay — engine round 18); avatars in the right panel's header (their colour, `shared/multiplayer/colors.ts`; click: follow), observation mode (their page and view; a border in their colour with "Following …" and Stop; any touch of the canvas stops it), "Spotlight me" in the account menu (everyone follows; stopping declines that spotlight), Offline / Connecting shown in the header; "can view" files open read-only (engine viewer mode).
   - Images: kept by the room by SHA-1 (`blobs` table in the Durable Object, 1 MB chunks, the bytes checked against their name); a frame's images are uploaded before it is sent, downloaded before it lands; the snapshot's at share and join. No R2 needed.
   - History: a client uploads a new snapshot every 1,000 frames when its copy is exactly the room's state (nothing pending; the owner, else the present editor with the lowest session); the room keeps 5,000 frames before the snapshot so returning clients catch up from their own seq; a copy older than that is replaced by a fresh one (`recover`, the old copy stays unlinked, the editor offers "Open latest").
   - Link sharing (§3).
7. Figma's UI, measured live — **2026-10-11** (docs/research/figma/live/multiplayer/README.md, R13-multiplayer-sharing.md; checked side by side with two accounts in the browser):
   - Share modal (`editor/ShareDialog.tsx`): two cards at the top centre (480 wide, y 86), "Share this file" · Copy link · ✕; the invite field with chips and the role select inside (default "can view"), Invite (disabled look until an email); Who has access: the link row ("People invited to file" / "Anyone … can view|edit" → Share settings), the owner "(you)", members with can edit / can view / Remove, pending "invited"; "Ask to edit" requests with Deny / Approve; card 2: Developer preview (its own view). Share settings: Who can access (People invited to file | Anyone), What can they do (View | Edit), Advanced "Viewers can copy, save, and export from this file" (`files.viewers_can_copy`, migration 0004). Measured equal to live: modal 363,86 480 wide, field 387×34, Invite 53×32, rows 32 / 36 apart, role text at 397, Copy link at 389, card-2 label at 45.
   - Header facepile (`multiplayer/Multiplayer.tsx`): others' 24 px avatars in 28 px rings of the panel colour, 21 px apart, a 4×2 bar in their colour; your avatar + the count = "Multiplayer tools" (you "(You)", Spotlight me, "Click to follow <name>"); the account avatar's place when others are in.
   - Observation mode: the UI minimized, the window framed 5 px in the followed colour, "Following <name>" / Stop at the top centre (170×32 bell, Stop 40×24 at half brightness); Spotlight: followers get "<name> is spotlighting" · Not now · Follow, and follow after 3 s.
   - "can view": the banner "You can only view and comment on this file." · Ask to edit · ✕ (527 × 40, 8 above the toolbar); Ask to edit → editors get a toast with Review and a red dot on Share, the requester "You can now edit this file" on approval (migration 0004 `access_requests`, room notices).
   - Cursor chat (Figma: "/"; on a Turkish Q keyboard the r14 layout rule puts it on Ç): live to the others in your colour with your name, 52 characters, gone 5 s after typing stops; the engine draws both bubbles (`setLocalChat`, presence `chat`). View › Multiplayer cursors (⌥⌘\) hides others' cursors and chat.
   - Home › Recents: "Recently viewed | Shared files" tabs (no "Shared with me" item), cards "From <name>", Open link… for pasted links.
   - Built in round 4 (item 8). Not built: Community publishing, audio's TURN relay.
8. Round 4 — **2026-10-11** (live capture: live/multiplayer/README.md "Second capture"):
   - **Transfer ownership** (help.figma.com 360038512093): the owner picks "Owner" in an invited member's role menu, confirms "Transfer ownership" ("You can't undo this action."); `POST /files/:key/transfer {email}` makes them the owner and the old owner a "can edit" member; both reconnect with their new roles.
   - **Password required** (Share settings › Additional security, with Generate = four random words; Save applies everything in the view, Cancel drops it): migration 0005 (`files.link_password` PBKDF2-SHA256, 4,000 iterations for the free plan's CPU budget, and its version). Link-only people (not invited) enter it once per password: `POST /files/:key/unlock {password}` → a pass `{k, u, v}` signed with the session secret, sent as `x-file-pass` (or `pass=` on the socket). The file's name stays readable so the app can ask ("This file is password protected", "Incorrect password. Try again."). A changed password closes link-only sockets; their copies lock (`FileShareState.locked`) until they enter the new one.
   - **Links that land**: "Copy link" names the selection's top-level frame or the page (`node-id=1-2`), "Copy Dev Mode link" adds `m=dev`, More › "Copy prototype link" `m=proto`; each says "Link copied!" in place. `/f/<key>` passes them on to `designer://open`; Home opens the file and the editor lands there (its page, the frame selected and zoomed, Dev Mode or Present) — desktop through the store (`openShared(…, intent)` / `takeOpenIntent`), browser through the editor's URL.
   - **Embeds**: More › "Get embed code" → "Copy public embed code" (`<iframe … src="<server>/embed/<key>?node-id=…&embed-host=share">`, "Embed <page> in your webpage"). `/embed/<key>` serves the viewer, which loads the room's snapshot and the frames after it (`/embed/<key>/snapshot|frames|images/<sha1>`, CORS open) and merges them itself; only files anyone with the link can view, without a password (Figma: password-protected files can't be embedded).
   - **Ask to spotlight**: Multiplayer tools rows hover as live (brand fill, "Click to follow", More options); More options › Ask to spotlight sends a `signal` (room protocol: to one session, never stored) — the asker sees "Asked <name> to spotlight", the asked person's canvas is framed in the asker's colour with "<name> is asking you to spotlight" · Spotlight me · ✕. The observation frame now frames the canvas between the panels (live: `viewportFrame` is the canvas view; the whole window only while the UI is minimized).
   - **Audio** (§11).


## 7. Deployed (2026-10-10)

- Worker `designer` live at `https://designer.burak-kc-sp.workers.dev` (Durable Object `FileRoom`, migration v1); D1 `designer` (`98f2c9e2-…`, region EEUR) migrated remotely; secrets `SESSION_SECRET` (random, 32 bytes) and `GOOGLE_CLIENT_SECRET` set; `GOOGLE_CLIENT_ID` in `wrangler.jsonc` vars. Checked from outside: `/` ok, `/me` 401, `/auth/dev` 404 (no DEV_AUTH in production), `/auth/login` → Google with the production redirect URI, a forged callback state 400.
- Real Google sign-in verified against `wrangler dev` (the owner's account; session sealed with safeStorage). Against production: the owner's first log in after this.
- Wrangler authenticates with an API token in `server/.env` (`CLOUDFLARE_API_TOKEN`, git-ignored): `wrangler login`'s OAuth page failed twice in the owner's browser ("No CSRF value available in the session cookie"). Token permissions: Edit Cloudflare Workers template + Account › D1 › Edit.
- Redeploy: `npm --prefix server run deploy`; new migrations: `npm --prefix server run db:migrate`.

## 8. What the owner does

- Cloudflare: account (done), `workers.dev` subdomain `burak-kc-sp` (done), `npx wrangler login` in `server/` when asked; R2 enabled before step 6.
- Google Cloud Console: a project, OAuth consent screen (External, testing, the owner and friends as test users), an OAuth client of type **Web application** with redirect URIs `https://designer.burak-kc-sp.workers.dev/auth/callback` and `http://localhost:8787/auth/callback`; its client id and secret go in with `npx wrangler secret put GOOGLE_CLIENT_SECRET` (and the id as `GOOGLE_CLIENT_ID`). Nothing goes in the repo.

## 9. Previews (2026-10-11)

Developer previews (docs/data.md §13) are published to the Worker instead of Firebase. The desktop store packages the preview (manifest.json, doc.kiwi, images) as before and uploads it with the session main handed it (`multiplayer.setSession`, captured as `LocalStore.session`); logged out, the Share dialog's Developer preview says "Log in to publish" (Export as HTML… still works).

| Route | Who | Does |
|---|---|---|
| `GET /p/:id` | anyone | the viewer page (static asset `index.html`; the viewer reads the id from its path) |
| `GET /previews/:id/manifest.json` · `doc.kiwi` · `images/:sha1` | anyone | the live package (404 none, 410 expired; `access-control-allow-origin: *`) |
| `GET /previews` | signed in | the caller's live previews |
| `POST /previews/:id/images/missing {sha1s}` | owner | `{missing}` |
| `PUT /previews/:id/images/:sha1` | owner | an image (≤ 40 MB, bytes checked against the SHA-1) |
| `PUT /previews/:id/doc` | owner | doc.kiwi (≤ 64 MB), staged until the manifest |
| `PUT /previews/:id/manifest {manifest, fileKey?}` | owner | goes live: staged doc swapped in, images not listed dropped, expiry alarm set → `{id, url, expiresAt}` |
| `DELETE /previews/:id` | owner | unpublish: the object's storage and the D1 row |

- The id is the store's 22-character base62 `previewId` (unguessable); the first write claims it for the caller in D1 `previews` (owner, file key, name, times, expiry), at most 100 per person; someone else's id answers 404.
- Storage: one `PreviewObject` Durable Object per preview (`PreviewBox` in previews.ts is its logic over SQLite, tested on node:sqlite), rows `files(name, idx, bytes)` of 1 MB (`doc`, `doc:next`, `img:<sha1>`) and the manifest in `meta`. No R2.
- Expiry (7 / 30 days or never, as before): reads answer 410, the list leaves it out, the object's alarm deletes its storage at `expiresAt`; the store drops its record and the D1 row (`DELETE`) when it next gets a session.
- Viewer: `wrangler.jsonc` `assets` = `../out/viewer` (binding `ASSETS`, `run_worker_first: true`, so every API route stays the Worker's; `html_handling` / `not_found_handling` none). `src/viewer/source.ts` reads `/previews/<id>/…` on its own origin (`?p=<id>&server=<origin>` for a dev viewer elsewhere) through `remote.ts loadRemote`, a small general loader (a fig-kiwi document or a bare kiwi Message, a manifest URL or one made from the message with `manifestFromMessage`, optional request headers) meant also for `/embed/<fileKey>` reading a shared file's room snapshot.
- Tests: `server/src/previews.test.ts` (7: publish and public read, republish in place with the staged doc, refusals, someone else's id, unpublish, expiry and alarm, the per-person cap); `src/store/preview/previews.test.ts` (the store against the real handler); `npm run viewer:check` serves the Worker's layout. Smoke against `wrangler dev` (real workerd, local D1, Durable Object, static assets): a synthetic package published, read back, the viewer at `/p/<id>` rendering it with its image, unpublished.
- Deploy (the main session): `npm run build:viewer` (out/viewer must exist before `wrangler dev` / deploy), `npm --prefix server run db:migrate` (0007), `npm --prefix server run deploy` (Durable Object migration `v2` creates `PreviewObject`).

## 10. Comments (2026-10-11)

Figma Design's comments (research `docs/research/figma/R14-comments.md`; live capture `docs/research/figma/live/multiplayer/comments.md`, which wins where they differ). Types and the pure helpers in `src/shared/comments.ts` (Figma's REST `Comment` shape: a thread = its first comment + replies one level deep, `order_id` → `number`, `client_meta` → `CommentAnchor`, reactions, resolve, per-person read marks).

- **Where they live.** A shared file (one with a room link) keeps them on the server: D1 migration `server/migrations/0006_comments.sql` (`comments` — the first comment holds the thread's place, number and resolve state; `comment_reactions`; `comment_reads`), routes in `server/src/comments.ts` (dispatched by one line in `api.ts`):

  | Route | Who |
  |---|---|
  | `GET /files/:key/comments` | everyone with access — the threads as the caller sees them (`unread` from their read marks), `me`, `canResolveAny` |
  | `POST /files/:key/comments {id?, threadId?, message, mentions?, anchor?}` | everyone with access, "can view" too (a new thread needs `anchor`) |
  | `PATCH /files/:key/comments/:id {message?, mentions?, resolved?, anchor?}` | message: the author; resolve / reopen and moving the pin: the thread's author or an editor |
  | `DELETE /files/:key/comments/:id` | the author (the first comment deletes the thread) |
  | `PUT /files/:key/comments/:id/reactions {emoji}`, `DELETE …?emoji=` | everyone with access, one per emoji per person |
  | `POST /files/:key/comments/read {threadIds, read}` | the caller's own marks ("Mark as unread" sets 0) |

  Every route answers with the whole list. After a change the Worker posts `/room/comments {threadId, by}` to the file's room (`fileRoom.ts`), which sends `{t: "comments"}` to every socket that said hello; clients read the list again. Unsharing deletes the file's comments (cascade).
- **Local files** keep them in the store: `files/<key>/comments.json` (LocalStore; removed with the file) or `designer.devStore.v1.comments.<key>` (the browser's MemoryStore), authored as "You" (shown with the signed-in name when there is one). A local file's comments stay local when it is shared later (not uploaded — open).
- **The store**: `src/store/comments/service.ts` (`CommentsService`, both stores; the `comments` repository in `StoreApi`, methods `list / add / edit / remove / setResolved / setRead / react / move / mentionable / watch`, event topic `comments`). It asks the server for a shared file through `MultiplayerService` (`roomKey`, `call`, `onComments` — the room's notice; a link coming back live re-reads), keeps the last list for offline (shown with its error).
- **The editor** (`src/renderer/src/editor/comments/`): `commentsController.ts` (per editor: the list, the draft, the open thread, search / sort / filters kept per machine), `CommentsLayer.tsx` (pins as DOM over the canvas in canvas coordinates — `cam.x + x·zoom` —, re-placed on camera and document changes; the Comment tool's click → a new-comment pin and the composer 48 to its right; hover preview; click opens; drag moves), `Thread.tsx` (the 360-wide card, menus, reactions, edit, the delete dialog), `Composer.tsx` (Enter posts, ⇧Enter new line, "@" lists people with access — members of the shared file —, emoji), `EmojiPicker.tsx`, `CommentsPanel.tsx` (the right panel in comment mode; the viewer's "Comments | Properties" tabs). Pins show while View › Comments (⇧C) is on, and always in comment mode; resolved threads only with "Show resolved comments" (dimmed).
- **Anchors**: a click over a top-level frame / component / instance / group / section stores that layer and the offset from its top-left (Figma attaches comments to the top-level frame), so the pin moves with it; otherwise a page point. A layer gone → the stored page point.
- **Engine**: one change — viewer mode accepts the Comment tool (`Editor::setTool`; a click with it changes nothing), so "can view" people comment as in Figma.
- **Not built**: images in comments ("Upload up to 5 images and GIFs" left out), email for comments (the in-app and desktop notifications are §12; the comment panel's per-file Settings choice is still kept per machine only), pin clusters, markdown formatting, "Copy link" opening a comment from the link (the link is copied, opening it doesn't focus the thread yet), keyboard stepping between threads, the 100-comments-an-hour limit.

## 11. Audio (2026-10-11)

Figma's audio conversation (help.figma.com 1500004414622; live: Multiplayer tools' headphones [Start conversation], then a 151×40 widget at the canvas's top right with avatars, the microphone and Leave). One conversation per file: who is in it is presence (`audio: {muted}`); "Join conversation" when someone else is. Peer to peer (`editor/multiplayer/audio.ts`): one WebRTC connection between each two people in it, the lower session offering, offers / answers / ICE candidates sent as room `signal`s; STUN only (Cloudflare's and Google's) — two people behind strict NATs may not connect (a TURN relay would need Cloudflare Calls credentials). Without a microphone one listens only (the mic crossed out, "Check your microphone permissions to start chatting."). Electron: main grants audio-only media to the app's pages and asks macOS first (`systemPreferences.askForMediaAccess`); the packaged app also needs `NSMicrophoneUsageDescription` in electron-builder's `mac.extendInfo` (not added: electron-builder.yml carries uncommitted Windows work). Not verified with real microphones (the browser pane blocks them): the owner's test with two machines.

## 12. Notifications (2026-10-11)

Figma's bell (research `docs/research/figma/R16-notifications.md`; the owner's captures 1.png–4.png). Types and pure helpers (wording, dates, preferences, what reaches the computer, a click's link) in `src/shared/notifications.ts`.

- **Stored on the server**: D1 migration `server/migrations/0008_notifications.sql` — `notifications` (one row per person: kind, file, actor, thread / comment, text, emoji, role, `count`, request `state`, times, `read_at`; cascades with the file and the user) and `notification_prefs` (the person's Settings › Notifications as JSON). Made in `server/src/notifications.ts`, called from where things happen: `comments.ts` (a new thread → the file's owner and everyone with two or more comments on it — Figma's rule; a reply → also the thread's participants; an @mention → that person, as "Mentioned you"; a reaction → the thread's participants; deleting a thread forgets its notifications), `api.ts` (an invite of someone with an account; "Ask to edit" → the owner and every "can edit" member, one pending row per asker; its answer → every request row settles to approved / denied and the asker gets "Approved / Denied your request to edit"; "Transfer ownership" → the new owner). Only people who can open the file are told; nobody of their own actions. Comments and replies from one person on one file fold into one unread row for 30 minutes ("4 comments · <file>"), reactions likewise ("2 reactions · <file>"); a mention keeps its own row. In-app notifications can't be turned off (Figma).
- **Routes** (dispatched by one line in `api.ts`):

  | Route | Does |
  |---|---|
  | `GET /notifications?filter=all\|requests\|unread&file=<key>&before=<cursor>&limit=50` | a page, newest first (`updated_at`, id), with `unread`, `pending` (requests waiting) and `files` (the "All notifications ⌄" menu) and `next` |
  | `POST /notifications/read {ids? \| all, read?}` | read marks (only one's own) → `{unread, pending}` |
  | `POST /notifications/:id/answer {approve}` | a request's Approve / Deny from the Requests tab — the same `answerEditRequest` as the Share dialog's `POST /files/:key/requests/:userId` (owner and editors only) |
  | `GET` / `PUT /notifications/prefs` | Settings › Notifications (cleaned with Figma's defaults: everything on) |
  | `GET /notifications/ws?token=` | the person's inbox socket |

- **Live, no polling**: one Durable Object `Inbox` per user id (`server/src/inbox.ts`, binding `INBOXES`, wrangler migration tag **v3**) holds the WebSockets of that person's open apps, hibernated; `ping` is answered by the runtime (`setWebSocketAutoResponse`) without waking it. Every change to someone's notifications posts `{t: "notifications", unread, pending, item?, desktop?}` to their inbox — `desktop` is the server's verdict from their preferences (`wantsDesktop`: "Send notifications to my computer", and for comments All / Only mentions and replies — mentions, replies and reactions in your threads — / None; invites and requests always). The inbox stores nothing; an app that was away reads the list when its socket opens. Chosen over the file's room (`FileRoom`) because notifications follow a person across files, and over long-polling because the Worker can't wait on D1.
- **The store**: `src/store/notifications/service.ts` (`NotificationsService`, both stores; the `notifications` repository — `list / markRead / prefs / setPrefs / answer / watch`, event topic `notifications`). It follows the session through `MultiplayerService.onSession` and opens `/notifications/ws` with `MultiplayerService.wsUrl` (reconnects with backoff, pings every 60 s). Signed out: an empty list, preferences kept in memory.
- **Main**: `src/main/notifications.ts` — on each store event carrying `desktop: true`, when no window of the app is focused, an Electron `Notification` (title: the person; body: "<what> · <file>" and the comment). A click opens `designer://open?key=<file>#comment-<thread>` through the same path as a shared file's link (Home → `openShared` with the intent → the editor lands in comment mode with the thread open: `OpenIntent.commentId`, `editor/multiplayer/links.ts applyIntent`) and marks it read. No new IPC channel: views reach the repository over their store port.
- **Home** (`src/renderer/src/notifications/`): the bell at the right of the account row (`Sidebar accountAccessory`, signed in only) with Figma's red dot for something new since the panel was last opened (kept per person in localStorage — 22 unread and no dot in the capture); `NotificationsPopover` as 2.png (384 wide, 62 left of the bell, 2 under it; "All notifications ⌄" = all or one file's; the gear; All | Requests | Unread (n); Mark all as read; rows with the per-person initial avatar, the badge — comment bubble, the reaction's emoji, `16.emoji` for several —, the 11 px text, date, blue dot; Deny / Approve on pending requests, "Approved" / "Denied" after; a row marks itself read and opens its file at the thread; paging on scroll). The gear opens the Settings modal at its Notifications tab (`settings/NotificationsTab.tsx`, 3.png / 4.png, measured; §13).
- **The editor**: no bell — Figma has none in files (R16 §1); a notification lands on its comment.
- **Tests**: `server/src/notifications.test.ts` (8, node:sqlite: invites, who gets comments, grouping, reactions, filters / paging / read marks, requests answered from the tab and from Share, ownership, preferences and the desktop verdict, the socket's auth), `src/store/notifications/service.test.ts` (the inbox socket following the session, events, answer, prefs), `src/shared/notifications.test.ts`. Checked in the browser against `wrangler dev` (real workerd, local D1, the Inbox object): seeded comments / reactions / a request / an invite, the panel side by side with 2.png, Approve, the file filter, Mark all as read, a mention arriving live, Settings › Notifications side by side with 3.png / 4.png.
- **Not built**: sending email (the choices are stored, nothing is mailed — it would need a mail provider), inline reply in the panel (Figma: "reply inline to single comment notifications"), accept / decline on invites (here an invite is already a membership; the row opens the file), invites to emails without an account (no notification when they first log in), access requests from people without access (only "Ask to edit" exists), Figma's plan / team filter (the menu lists files), Slack, the Mac menu-bar / Windows tray icon, the browser's push notifications, the comment panel's per-file notification choice on the server.
- **Deploy** (the main session): `npm --prefix server run db:migrate` (0008), `npm --prefix server run deploy` (Durable Object migration `v3` creates `Inbox`).

## 13. Settings: the account, sessions, personal access tokens (2026-10-11)

Figma's Settings modal (docs/design-system.md §4.36; research `docs/research/figma/R17-settings.md`) keeps its account parts on the server. Migration **`server/migrations/0009_sessions.sql`**, routes in `server/src/account.ts` (one dispatch line in `api.ts`: every `/me…` path), tests `server/src/account.test.ts` (4, node:sqlite). Views reach them through main — `account:request {method, path, body}` (Home and editors; only `/me`, `/me/profile|sessions|tokens[/id]`, `shared/account.ts ACCOUNT_PATH`), main adding the session (`src/main/account/index.ts accountRequest`); the browser's own sign-in does the same from the page (`store/webAccount.ts request`).

| Route | Does |
|---|---|
| `GET /me` | the user (a personal access token with `current_user:read` too) |
| `DELETE /me {confirm: email}` | **Delete account** (below) |
| `GET /me/profile` · `PATCH /me/profile` | `AccountProfile`: name, photo, role, Community profile, prefs (`ProfilePatch`) |
| `GET /me/sessions` | `{sessions}` with the caller's own `current: true` first |
| `DELETE /me/sessions/:id` | **Sign out** that session (not the current one: that is Log out) |
| `GET /me/tokens` · `POST /me/tokens {description, expiresInDays, scopes}` · `DELETE /me/tokens/:id` | personal access tokens: list, Generate new token (`{token, info}`, the token shown once), Revoke access |

- **Sessions**: one `sessions` row per sign-in (`/auth/token`, `/auth/dev`): kind `app` (the desktop app — main sends `user-agent: DesignerV2-Desktop/<version> (<os>)` with the code exchange and its requests) or `login` (a browser), OS and browser from the User-Agent (`shared/account.ts deviceFromUserAgent`: macOS / Windows / iOS (iPhone) / Android…, Chrome / Safari / Firefox / Edge…), IP from `cf-connecting-ip`, city and country from Cloudflare's `request.cf` (the country's English name, `Intl.DisplayNames`: "Türkiye"), created and last accessed. The session token carries its row's id (`sid`); every request with it checks the row is there and moves "Last accessed" on (at most every 5 minutes: one UPDATE … RETURNING). **Sign out** on a row deletes it — that token stops at once, others go on. Sign out everywhere (the token version) still ends all of them and drops the rows. Tokens issued before 0009 have no `sid`: they keep working (not listed) until they expire or the next sign-in. `wrangler dev` fills `request.cf` from the real network, so local sessions show a real city.
- **Personal access tokens** (Figma's, help.figma.com 8085703771159; `dsgn_` + 32 random bytes, Figma's are `figd_`): only their SHA-256 is stored (`access_tokens`), with a name, the scopes (`shared/account.ts TOKEN_SCOPES`: Figma's REST names this API serves — `current_user:read`, `file_content:read`, `file_metadata:read`, `file_comments:read`, `file_comments:write`) and an expiry of 1, 7, 30 or 90 days (Figma dropped non-expiring tokens in 2025); "Last used" moves on at most once a minute. A token is a `Bearer` for the API's reads (`account.ts patAllows`): the files list and a file (`file_metadata:read` or `file_content:read`), a file's snapshot and images (`file_content:read`), comments (read / write). Never the account (`/me…` except `GET /me`), sharing, members, uploads, previews, devices or the rooms' sockets. **The MCP server doesn't take them**: it runs on this computer with its own token sealed by safeStorage (docs/editor.md "Agents"); a cloud token would make it reachable by anyone holding one — not sensible for a local server.
- **Profile**: `PATCH /me/profile` changes the name (`name_locked`: the next Google sign-in keeps it), the photo (a `data:image/(png|jpeg|webp)` URL ≤ 300 kB — the app crops it to a 256 px JPEG; null goes back to Google's at the next sign-in; `picture_locked`), the role (Figma's list, `ROLES`), the Community profile (`community` JSON: a unique handle — 15 letters, numbers or _ , a unique index on its lower case —, bio ≤ 160, location, website, X, Instagram) and the prefs (`prefs` JSON: language — only `en` —, closed captions, view history). The views' CSP allows no outside images, so main fetches Google's photo once and hands views a data: URL (`accountState`). Change email: we log in with Google, so the email is "Managed by Google" (as Figma shows for SSO accounts) — the dialog says so; Password / two-factor authentication open the Google account's own pages.
- **Delete account** (help.figma.com 360039826814; the email typed to confirm): files the person owns stop being shared (their rooms dropped, comments with them; everyone's local copies stay), their memberships (closing their sockets), requests, comments and reactions, read marks, notifications they caused, devices, previews (storage and rows), sessions and tokens go, then the user. Main logs the app out. Their local files stay on their computer. The same Google account can sign in again as a new user.
- **Connected apps** (Security): the MCP clients connected to this computer's agents' server (`agents:clients`, now Home's too; "Connected N days ago" is the client config file's last change), Revoke access = Disconnect.
- **Not built**: language switching (Figma's list shown, English only), closed captions (stored; captioning the audio conversation needs speech recognition the app doesn't have — Chromium's Web Speech API has no backend in Electron), view history (stored; there is no "viewed by" list yet), Community publishing, organisations in "Your spaces" (the one space is this computer's workspace — Phase 7 Enterprise adds orgs).
- **Deploy** (the main session): `npm --prefix server run db:migrate` (0009), `npm --prefix server run deploy`. No new Durable Object.

## 14. Organizations (contract, Phase 7 rounds 1–2; written 2026-10-11)

**Status: contract, not built.** Figma's content model for organizations, on the server of §1–§13: who is in an organization, what each person may open and change, how the store reaches it, the Admin API and the activity log. Research: `docs/research/figma/R18-enterprise.md` §2 (A-1 … A-4). The plan: `docs/roadmap.md` "Phase 7", rounds 1–2. The branches that round 2 adds are in `docs/data.md` §15.

Facts about Figma below were read on help.figma.com and developers.figma.com on 2026-10-11:
- **[F-perm]** File and folder permissions — https://help.figma.com/hc/en-us/articles/35361119554711
- **[F-team]** Team permissions — https://help.figma.com/hc/en-us/articles/360039970673
- **[F-admin]** Admin roles — https://help.figma.com/hc/en-us/articles/4420557724439
- **[F-seat]** Seat types — https://help.figma.com/hc/en-us/articles/360039960434
- **[F-guest]** Members and guests — https://help.figma.com/hc/en-us/articles/4420557314967
- **[F-group]** User groups — https://help.figma.com/hc/en-us/articles/38020006913943
- **[F-folder]** Projects renamed to folders — https://help.figma.com/hc/en-us/articles/41753150926103
- **[F-drafts]** Drafts of removed members — https://help.figma.com/hc/en-us/articles/4420549259799
- **[F-ws]** Workspaces:
  - Create a workspace — https://help.figma.com/hc/en-us/articles/4409612431383
  - Default teams — https://help.figma.com/hc/en-us/articles/4419450594455
  - Assign people — https://help.figma.com/hc/en-us/articles/4419365500695
  - Workspace admins — https://help.figma.com/hc/en-us/articles/4409605157143
  - Team creation — https://help.figma.com/hc/en-us/articles/10386065399319
- **[F-log]** Activity logs:
  - The API — https://developers.figma.com/docs/rest-api/activity-logs-endpoints/
  - Events — https://developers.figma.com/docs/rest-api/activity-logs-events/
  - Entity types — https://developers.figma.com/docs/rest-api/activity-logs-entity-types/
  - Action types — https://developers.figma.com/docs/rest-api/activity-logs-action-types/

**(unverified)** marks a rule we could not find stated by Figma; the choice made there is ours and says so.

### 14.1 The hierarchy

```
organization ─┬─ workspaces (optional grouping of teams and people; Enterprise)
              ├─ teams ── folders (nested ≤ 10 levels) ── files
              ├─ drafts (each person's files outside any folder; owned by the organization)
              ├─ people: members, guests;  user groups;  billing groups
              └─ settings, activity log
```

- **Organization.** It owns everything inside it, drafts included. When someone is removed, their drafts go to Admin › Content › **Unassigned drafts** [F-drafts]. Admins can move them into a folder or a team, or delete them for good.
- **Workspace** (Enterprise) [F-ws]:
  - A named group of teams, made by org admins with at least one **workspace admin**; it can be hidden ("Make it hidden").
  - Each member or guest is in at most one workspace, but may join teams elsewhere.
  - A workspace has **default teams**: its members, never its guests, are added to them, existing members when the list is set and new members as they join.
  - Workspaces are optional. An org with none has teams directly.
- **Team.** Belongs to the org, and to at most one workspace. It has one **owner** (the creator; ownership can be transferred), **team admins**, and members with "can edit" or "can view" [F-team]. Team audience settings:
  - **Only those invited**, either **Visible** (members can find the team and ask to join) or **Hidden**.
  - **‹Workspace›** (members of its workspace) or **‹Organization›** (every org member), each with a "What they can do" of can view or can edit.
- **Folder.** Figma renamed projects to folders on 2026-08-03 [F-folder]:
  - The UI says **folder** everywhere.
  - Our D1 tables, our API and the activity log keep Figma's REST and log name **project** (`project_create`…; the log's `project` entity, whose page notes "projects are now known as folders" [F-log]). In this document, "folder" and "project" are the same thing.
  - Folders nest up to 10 levels. Each folder has an **owner** (its creator), members with "can edit" or "can view", and an access setting:
    - **Inherited**: "Anyone in ‹parent› can access". This is the default.
    - **Limited**: "Only people added to ‹folder› can access".
- **File.** In a folder, or a **draft** (no folder) of its owner. It has the roles of today's shared files (§3: owner, can edit, can view), an access setting (Inherited / Limited, as folders: ours, extending [F-perm]'s rule that files inherit folder roles), and link sharing:
  - "Anyone with the link" (today's `link_access`).
  - **"Anyone at ‹org› with the link"** (`org_link_access`, members only).
  - The password and expiry (§6 item 8, R18 A-6).
- **People.** **Members** are added to the org. **Guests** are everyone else, invited to particular teams, folders or files [F-guest]. Figma decides member or guest by the org's email domains. We have no verified domains until round 4, so until then:
  - an admin adds members by email;
  - anyone invited into the org's content from outside becomes a guest.

  This is ours; Figma's domain rule takes over with domain capture in round 4.
- **User groups** [F-group]:
  - Any member creates them (Enterprise can limit creation to admins).
  - Creators and org admins manage them.
  - A group can be invited to a file, folder or team as "can edit" or "can view", and @mentioned in comments.
  - Guests can share with, or mention, only the groups they are in.
  - SCIM groups come in round 4.
- **Seats.** Full, Dev, Collab or View, one per person per org [F-seat]. A seat **caps** what a role allows (§14.3). There is no billing (R18 §0). **Billing groups** (Enterprise) group people under billing group admins, with no money.

**Today's local workspace stays as it is**: the `local` space (§14.6). The org is a second kind of space. Files shared per file (§3) that belong to no org keep working exactly as today; §14.8 moves the owner's own into a team.

### 14.2 Roles

| Level | Roles (Figma's words) | Who can change them |
|---|---|---|
| Organization | **Organization admin**, member, guest | org admins [F-admin] |
| Workspace | **Workspace admin** (acts as team admin for the non-hidden teams of its workspaces; manages its people's seats and default teams) | org admins [F-ws] |
| Billing group | **Billing group admin** (assigns people, answers seat requests) | org admins [F-admin] |
| Team | **owner** (one), **admin**, member **can edit** / **can view** | team admins, owner; org admins [F-team] |
| Folder | **owner**, **can edit** (create files and folders inside), **can view** | owners and editors of the folder; admins [F-perm] |
| File | **owner**, **can edit**, **can view** | owners and editors of the file; admins [F-perm] |
| User group | its creator; members | creator, org admins [F-group] |

Rules that hold at every level [F-perm, F-team]:
1. **Individual roles pass down.** A team role reaches every folder and file of the team, and a folder role reaches its subfolders and files. A child can give someone **more** than the parent does, never less.
2. **Audience access does not pass down past a Limited child.** "Audience" means team org-wide or workspace-wide access, and folder or file "Inherited". Someone in only by audience gets nothing in a Limited folder; they may see it empty.
3. Changing roles at a level requires being its owner, an editor of it, or an admin. Only the team owner transfers the team [F-team].
4. **Admin roles grant content access (unverified)**:
   - **Org admins** resolve to "can edit" on every team's content (not on active members' drafts).
   - **Workspace admins** resolve to "can edit" on the non-hidden teams of their workspaces.
   - **Team admins** and the **team owner** resolve to "can edit" on their team.
   
   Figma says admins "can change permissions on resources they can access" [F-perm] and that team admins manage everything about a team [F-team]. That they *edit* implicitly is our reading, and the same as Figma's Education plan rule ("admins (and owners) will automatically get edit access").
5. **Guests** never get audience access through the org or a workspace. Only their own grants (as a person or through a group they are in) and plain "Anyone with the link" reach them [F-guest]. Guests can be team admins.

### 14.3 Seats as caps

What each seat may **edit** [F-seat]. Viewing and commenting are open to every seat on files the person can open. Editor types are the product of the file (`files.editor_type`; until round 7 every file is `design`).

| Editor type (`files.editor_type`, Figma's `EditorType`) | Full | Dev | Collab | View |
|---|---|---|---|---|
| `design` (DESIGN) — edit | ✓ | — | — | — |
| `design` — Dev Mode (DEV_HANDOFF) | ✓ | ✓ | — (basic inspection only) | — (basic inspection only) |
| `figjam` (WHITEBOARD) | ✓ | ✓ | ✓ | — |
| `slides` (SLIDES) | ✓ (+ Design mode) | ✓ (no Design mode) | ✓ | — |
| `buzz` (COOPER) | ✓ | ✓ | ✓ | — (unverified: the pricing FAQ's seat list, R18 §0) |
| `sites` (SITES), `make` (FIGMAKE) | ✓ | drafts trial only | drafts trial only | drafts trial only |

- **Branching** needs a Full seat (docs/data.md §15).
- Outside any org there are no seats: §3's roles apply alone.
- A person whose role is "can edit" or owner on a file their seat can't edit gets the file **read-only**: the room's role is `viewer` and the editor shows the banner of §6 item 7, "You can only view and comment on this file.".
- Moving someone to View stops all their edits at once (§14.9 re-checks open sockets).
- **Seat requests** ("Ask to upgrade") reuse the request rows (§14.5 `seat_requests`). The org setting picks how each seat type is approved [R18 A-2]: `manual`, `manual_unless_available` (Figma's default) or `auto`. We have unlimited seats, so "unless seat is available" always approves. New people get `settings.defaultSeat`, which is `view`, Figma's (unverified as the current default).

### 14.4 Permission resolution

One pure function, `resolveAccess` in `src/shared/org/access.ts`. It is shared: the Worker uses it for every route and room, the store uses it to grey out actions offline, and tests use it. It takes plain rows and does no I/O; the server loads them with one recursive query per request (`server/src/org/db.ts loadAccessRows`).

```ts
type Level = "owner" | "editor" | "viewer";            // order: owner > editor > viewer > null
interface AccessRows {
  user: { id: string; email: string } | null;          // null: not signed in (embeds, previews)
  file: { key: string; ownerId: string; orgId: string | null; teamId: string | null; projectId: string | null;
          editorType: EditorType; access: "inherited" | "limited"; linkAccess: Audience; orgLinkAccess: Audience;
          linkExpiresAt: number | null; viewersCanCopy: boolean; passwordProtected: boolean; trashedAt: number | null };
  fileGrants: Grant[];                                  // members rows (user or pending email) + group_grants on the file
  folders: { id: string; ownerId: string; access: "inherited" | "limited"; grants: Grant[] }[]; // nearest first, to the top
  team: { id: string; ownerId: string; workspaceId: string | null; orgAccess: Audience; workspaceAccess: Audience;
          visibility: "visible" | "hidden"; deletedAt: number | null; grants: Grant[] /* role + admin flag */ } | null;
  membership: { role: OrgRole; seat: Seat; workspaceId: string | null } | null; // the user in file.orgId
  workspaceAdminOf: string[];                           // workspace ids
  userGroups: string[];                                 // groups the user is in (same org)
  viaLink: boolean;                                     // the request names the file by its link (/f/<key>, ?link=1)
  passOk: boolean;                                      // a valid x-file-pass for the current password (§6 item 8)
  externalRestricted: boolean;                          // round 4: the user's home org restricts external content
  now: number;
}
```

Algorithm, in this order:

```
resolveAccess(r):
  if r.file.trashedAt: only owner / admins (step 2) see it, read-only, for Restore           // Figma's trash
  if r.file.orgId == null: return legacy(r)            // §3 exactly as today: owner | members | link (+password)

  role = null; via = []
  -- 1. individual roles (never reduced downwards)
  if r.user.id == file.ownerId:                       role = owner,  via += "file"
  role = max(role, grant(r.fileGrants))                                      via += "file"
  for f in r.folders: role = max(role, f.ownerId == user ? editor : null, grant(f.grants))   via += "folder"
  if r.team and not r.team.deletedAt:
     t = team grant (person or group): role = max(role, t.role); if t.admin or r.team.ownerId == user: role = max(role, editor)   via += "team"
  -- 2. admins (unverified: §14.2 rule 4); never on drafts (projectId == null) of someone else
  if file.projectId != null:
     if membership.role == admin:                                            role = max(role, editor), via += "org-admin"
     if r.team.workspaceId in r.workspaceAdminOf and r.team.visibility != hidden: role = max(role, editor), via += "workspace-admin"
  -- 3. audience (members only; stops at the first Limited level, the file's own counted)
  if membership.role in (admin, member):
     a = r.viaLink ? file.orgLinkAccess : none
     if file.access == inherited and every folder in r.folders has access == inherited and r.team:
        if team.orgAccess != none:                                        a = max(a, team.orgAccess)
        if team.workspaceAccess != none and membership.workspaceId == team.workspaceId: a = max(a, team.workspaceAccess)
     role = max(role, a), via += "audience" if it raised it
  -- 4. public link (anyone signed in, guests included)
  if r.viaLink and file.linkAccess != none and (linkExpiresAt == null or now < linkExpiresAt) and (not passwordProtected or passOk or role != null):
     role = max(role, file.linkAccess), via += "link"
  if role == null: return NONE (404, as today: an existing file not shared with the caller is "no such file")

  -- 5. caps
  capped = null; canEdit = role in (owner, editor)
  if canEdit and membership and not seatCanEdit(membership.seat, file.editorType): canEdit = false, capped = "seat"
  if canEdit and r.externalRestricted and file.orgId != user's home org:      canEdit = false, capped = "external"   (round 4)
  return {
    role,                                     // before caps: what the Share dialog shows
    roomRole: not canEdit ? viewer : role,    // §3's Role for the room's x-role; a capped owner keeps canManage below
    canView: true,
    canEdit,
    canComment: not (capped == "external"),   // external content controls also stop comments (R18 A-6)
    canExport: canEdit or file.viewersCanCopy (unless the org's export restriction says otherwise — round 14),
    canDevMode: seat in (full, dev) or no membership,
    canShare: role in (owner, editor) or (role == viewer and org guest policy allows viewers to invite — Figma lets "can view" invite as viewers; unverified for files),
    canManage: role == owner or via has org-admin / workspace-admin / team admin,   // delete, move, link settings, transfer
    capped, via
  }
```

`grant(gs)` is the highest role among the user's own row, matched by `user_id`, or by email while still pending, and the rows of groups in `userGroups`.

`roomRole` stays §3's `Role` (`owner | editor | viewer`) for the room's `x-role`. When an owner's seat stops them editing, the room gets `viewer`, while the Worker still lets them manage sharing (`canManage`).

**Cases** (the tests of `access.test.ts`, one row each):

| # | Setup | Result |
|---|---|---|
| 1 | File with no org, caller owner | owner (legacy, unchanged) |
| 2 | Org file, caller has no row anywhere, team audience none | none → 404 |
| 3 | Team member can view; file in a top-level Inherited folder | viewer via team |
| 4 | Team can view, folder grant can edit | editor via folder (more than the team: allowed) |
| 5 | Team can edit, file grant can view | **editor** (a child can't reduce) |
| 6 | Team org access can edit, caller a member with no rows | editor via audience |
| 7 | Same, but the folder is Limited | none (audience stops) — the folder shows empty |
| 8 | Same as 6 but caller is a guest | none (guests get no org audience) |
| 9 | Guest with a file grant can edit, Full seat | editor |
| 10 | Member with a team grant can edit, **Collab** seat, `design` file | role editor, `canEdit` false, `capped: "seat"`, roomRole viewer, banner shown |
| 11 | Same member, `figjam` file | editor |
| 12 | Org admin, no rows, team file | editor via org-admin |
| 13 | Org admin, another member's draft | none (drafts are not admins' — until the owner is removed, §14.7) |
| 14 | Workspace admin, team of their workspace, team Hidden | none from admin (Figma: non-hidden teams only); rows still apply |
| 15 | Team owner with no grant row | editor via team |
| 16 | User group "Design" granted can edit on a folder; caller in the group | editor via folder |
| 17 | Member opens by link, `org_link_access` viewer, file Limited | viewer (the file's own org link counts even when Limited) |
| 18 | Outsider, `link_access` viewer, password set, no pass | 403 password required (§6 item 8, unchanged) |
| 19 | Link expired (`link_expires_at` past), caller only by link | none |
| 20 | Team soft-deleted | only admins see it (Admin › Teams › Restore); rows from the team ignored |
| 21 | Owner of an org file moved to a View seat | role owner, canEdit false, canManage true, roomRole viewer |
| 22 | External content restricted (round 4), member opens another org's file with a grant can edit | viewer, no comments, `capped: "external"` |

### 14.5 D1: migration `server/migrations/0010_orgs.sql`

What earlier migrations already cover, so round 1 doesn't redo it:
- 0001 `users`, `files`, `members` (file grants, pending by email), `auth_codes`; 0002 `devices`; 0003 `link_access`; 0004 `access_requests`, `viewers_can_copy`; 0005 link passwords; 0006 comments; 0007 previews; 0008 notifications.
- **0009 already holds sessions** (one row per sign-in, `sid` in the token, last seen ≤ 5 min, Sign out per row) and personal access tokens.

Round 4's idle timeout reads `sessions.last_seen_at`; nothing about sessions is in 0010.

0010 is the following text. The round 1 server agent (1a) copies it into the file verbatim; if a column has to change, the contract changes first.

```sql
-- Organizations (docs/multiplayer.md §14): orgs → workspaces → teams → folders ("projects", Figma's API and log name)
-- → files; members, guests, seats, user groups, billing groups, the activity log. Times are ms since the epoch.

CREATE TABLE orgs (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  -- OrgSettings JSON (src/shared/org/types.ts): team creation, guests, links, seats, …
  settings   TEXT NOT NULL DEFAULT '{}',
  created_by TEXT NOT NULL REFERENCES users (id),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE workspaces (
  id         TEXT PRIMARY KEY,
  org_id     TEXT NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  hidden     INTEGER NOT NULL DEFAULT 0,
  -- per-workspace overrides of OrgSettings (round 4: sharing, export, AI)
  settings   TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX workspaces_org ON workspaces (org_id);

CREATE TABLE billing_groups (
  id         TEXT PRIMARY KEY,
  org_id     TEXT NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX billing_groups_org ON billing_groups (org_id);

-- Everyone in an org. A row with no user_id is an invite to an email without an account yet (as members, 0001).
CREATE TABLE org_members (
  org_id           TEXT NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
  email            TEXT NOT NULL,
  user_id          TEXT REFERENCES users (id) ON DELETE CASCADE,
  role             TEXT NOT NULL CHECK (role IN ('admin', 'member', 'guest')),
  seat             TEXT NOT NULL DEFAULT 'view' CHECK (seat IN ('full', 'dev', 'collab', 'view')),
  workspace_id     TEXT REFERENCES workspaces (id) ON DELETE SET NULL,
  billing_group_id TEXT REFERENCES billing_groups (id) ON DELETE SET NULL,
  invited_by       TEXT REFERENCES users (id),
  created_at       INTEGER NOT NULL,
  seat_changed_at  INTEGER,
  -- last request seen from this person in this org (Admin › People "Last active"; moved on at most every 5 minutes)
  last_active_at   INTEGER,
  PRIMARY KEY (org_id, email)
);
CREATE INDEX org_members_user ON org_members (user_id);
CREATE INDEX org_members_workspace ON org_members (org_id, workspace_id);

CREATE TABLE workspace_admins (
  workspace_id TEXT NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  user_id      TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  PRIMARY KEY (workspace_id, user_id)
);

CREATE TABLE billing_group_admins (
  billing_group_id TEXT NOT NULL REFERENCES billing_groups (id) ON DELETE CASCADE,
  user_id          TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  PRIMARY KEY (billing_group_id, user_id)
);

CREATE TABLE teams (
  id               TEXT PRIMARY KEY,
  org_id           TEXT NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
  workspace_id     TEXT REFERENCES workspaces (id) ON DELETE SET NULL,
  name             TEXT NOT NULL,
  description      TEXT NOT NULL DEFAULT '',
  -- a data: URL ≤ 100 kB, or null (the initial on a colour)
  icon             TEXT,
  owner_id         TEXT NOT NULL REFERENCES users (id),
  -- audience: "‹Organization›" / "‹Workspace›" and what they can do; visibility applies to "Only those invited"
  org_access       TEXT NOT NULL DEFAULT 'none' CHECK (org_access IN ('none', 'viewer', 'editor')),
  workspace_access TEXT NOT NULL DEFAULT 'none' CHECK (workspace_access IN ('none', 'viewer', 'editor')),
  visibility       TEXT NOT NULL DEFAULT 'visible' CHECK (visibility IN ('visible', 'hidden')),
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  deleted_at       INTEGER,
  deleted_by       TEXT REFERENCES users (id)
);
CREATE INDEX teams_org ON teams (org_id, workspace_id);

CREATE TABLE workspace_default_teams (
  workspace_id TEXT NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  team_id      TEXT NOT NULL REFERENCES teams (id) ON DELETE CASCADE,
  PRIMARY KEY (workspace_id, team_id)
);

CREATE TABLE team_members (
  team_id    TEXT NOT NULL REFERENCES teams (id) ON DELETE CASCADE,
  email      TEXT NOT NULL,
  user_id    TEXT REFERENCES users (id) ON DELETE CASCADE,
  role       TEXT NOT NULL CHECK (role IN ('editor', 'viewer')),
  admin      INTEGER NOT NULL DEFAULT 0,
  invited_by TEXT REFERENCES users (id),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (team_id, email)
);
CREATE INDEX team_members_user ON team_members (user_id);

-- "Request to join" a Visible team (org members only)
CREATE TABLE team_requests (
  team_id    TEXT NOT NULL REFERENCES teams (id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (team_id, user_id)
);

-- Folders (Figma's "projects" until 2026-08-03; the API and the activity log keep "project").
CREATE TABLE projects (
  id         TEXT PRIMARY KEY,
  team_id    TEXT NOT NULL REFERENCES teams (id) ON DELETE CASCADE,
  parent_id  TEXT REFERENCES projects (id) ON DELETE CASCADE,
  depth      INTEGER NOT NULL DEFAULT 1 CHECK (depth BETWEEN 1 AND 10),
  name       TEXT NOT NULL,
  owner_id   TEXT NOT NULL REFERENCES users (id),
  access     TEXT NOT NULL DEFAULT 'inherited' CHECK (access IN ('inherited', 'limited')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  trashed_at INTEGER,
  trashed_by TEXT REFERENCES users (id)
);
CREATE INDEX projects_team ON projects (team_id, parent_id);

CREATE TABLE project_members (
  project_id TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  email      TEXT NOT NULL,
  user_id    TEXT REFERENCES users (id) ON DELETE CASCADE,
  role       TEXT NOT NULL CHECK (role IN ('editor', 'viewer')),
  invited_by TEXT REFERENCES users (id),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (project_id, email)
);
CREATE INDEX project_members_user ON project_members (user_id);

CREATE TABLE user_groups (
  id          TEXT PRIMARY KEY,
  org_id      TEXT NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  created_by  TEXT NOT NULL REFERENCES users (id),
  -- set for groups synced from the IdP (round 4, SCIM): their membership is the IdP's
  external_id TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX user_groups_org ON user_groups (org_id);

CREATE TABLE user_group_members (
  group_id   TEXT NOT NULL REFERENCES user_groups (id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  added_by   TEXT REFERENCES users (id),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (group_id, user_id)
);
CREATE INDEX user_group_members_user ON user_group_members (user_id);

-- A user group invited to a team, folder or file ("Can edit" / "Can view").
CREATE TABLE group_grants (
  group_id      TEXT NOT NULL REFERENCES user_groups (id) ON DELETE CASCADE,
  resource_type TEXT NOT NULL CHECK (resource_type IN ('team', 'project', 'file')),
  resource_id   TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('editor', 'viewer')),
  granted_by    TEXT REFERENCES users (id),
  created_at    INTEGER NOT NULL,
  PRIMARY KEY (group_id, resource_type, resource_id)
);
CREATE INDEX group_grants_resource ON group_grants (resource_type, resource_id);

-- "Ask to upgrade" a seat; answered by org, workspace or billing group admins (or automatically, OrgSettings.seatApproval)
CREATE TABLE seat_requests (
  id          TEXT PRIMARY KEY,
  org_id      TEXT NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  seat        TEXT NOT NULL CHECK (seat IN ('full', 'dev', 'collab')),
  note        TEXT NOT NULL DEFAULT '',
  state       TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'approved', 'denied')),
  answered_by TEXT REFERENCES users (id),
  created_at  INTEGER NOT NULL,
  answered_at INTEGER
);
CREATE INDEX seat_requests_org ON seat_requests (org_id, state, created_at);

-- Invites of outside emails waiting for an admin ("Require admin approval", round 4 enforces; round 1 stores)
CREATE TABLE guest_requests (
  id            TEXT PRIMARY KEY,
  org_id        TEXT NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
  email         TEXT NOT NULL,
  invited_by    TEXT NOT NULL REFERENCES users (id),
  resource_type TEXT NOT NULL CHECK (resource_type IN ('team', 'project', 'file')),
  resource_id   TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('editor', 'viewer')),
  state         TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'approved', 'denied')),
  answered_by   TEXT REFERENCES users (id),
  created_at    INTEGER NOT NULL,
  answered_at   INTEGER
);
CREATE INDEX guest_requests_org ON guest_requests (org_id, state);

-- Files join the hierarchy. org_id null: a file shared per file outside any org (§3, unchanged).
-- project_id null with org_id set: a draft of owner_id in that org. team_id is project_id's team, kept for queries.
ALTER TABLE files ADD COLUMN org_id TEXT REFERENCES orgs (id);
ALTER TABLE files ADD COLUMN team_id TEXT REFERENCES teams (id);
ALTER TABLE files ADD COLUMN project_id TEXT REFERENCES projects (id);
ALTER TABLE files ADD COLUMN editor_type TEXT NOT NULL DEFAULT 'design' CHECK (editor_type IN ('design', 'figjam', 'slides', 'buzz', 'sites', 'make'));
ALTER TABLE files ADD COLUMN access TEXT NOT NULL DEFAULT 'inherited' CHECK (access IN ('inherited', 'limited'));
-- "Anyone at ‹org› with the link" (members only); link_access (0003) stays "Anyone with the link"
ALTER TABLE files ADD COLUMN org_link_access TEXT NOT NULL DEFAULT 'none' CHECK (org_link_access IN ('none', 'viewer', 'editor'));
-- prototype-only links (round 5c); stored now so fig_file_proto_link_access_change has a column
ALTER TABLE files ADD COLUMN proto_link_access TEXT NOT NULL DEFAULT 'none' CHECK (proto_link_access IN ('none', 'viewer'));
-- "Require design-file links to expire" (R18 A-6): past it, link-only people are refused and the link reads as off
ALTER TABLE files ADD COLUMN link_expires_at INTEGER;
ALTER TABLE files ADD COLUMN trashed_at INTEGER;
ALTER TABLE files ADD COLUMN trashed_by TEXT REFERENCES users (id);
CREATE INDEX files_project ON files (project_id);
CREATE INDEX files_org_owner ON files (org_id, owner_id);

-- Notifications (§12) learn their org and team: the bell's "All notifications ⌄" can filter by them; new kinds in §14.11.
ALTER TABLE notifications ADD COLUMN org_id TEXT REFERENCES orgs (id) ON DELETE CASCADE;
ALTER TABLE notifications ADD COLUMN team_id TEXT REFERENCES teams (id) ON DELETE SET NULL;

-- The activity log (Admin › Activity; the REST /v1/activity_logs of round 5): Figma's event shape, one row per event.
CREATE TABLE activity_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id      TEXT NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
  at          INTEGER NOT NULL,
  -- Figma's action.type, e.g. fig_file_view (§14.10)
  action      TEXT NOT NULL,
  -- null: anonymous (Figma: "The actor field can be empty if an anonymous request triggers the event")
  actor_id    TEXT,
  actor_email TEXT,
  actor_name  TEXT,
  -- file | file_repo | org | project | team | user | workspace | … (Figma's entity types) and the entity's fields
  entity_type TEXT NOT NULL,
  entity_id   TEXT NOT NULL,
  entity      TEXT NOT NULL DEFAULT '{}',
  -- action.details
  details     TEXT NOT NULL DEFAULT '{}',
  team_id     TEXT,
  ip          TEXT,
  -- context.client_name: "DesignerV2-Desktop/<v>" or the browser
  client_name TEXT
);
CREATE INDEX activity_org_at ON activity_log (org_id, at);
CREATE INDEX activity_org_action ON activity_log (org_id, action, at);
CREATE INDEX activity_org_actor ON activity_log (org_id, actor_id, at);
CREATE INDEX activity_org_team ON activity_log (org_id, team_id, at);
```

Notes:
- **Ids.** Org, workspace, team, project, group and request ids are 16-character base62 (`randomId(16)`, as `VersionId`). Team and folder ids appear in links: `/files/team/<id>`, `/files/project/<id>` (Figma's URL shapes, unverified for after the rename).
- **Deleting.** Teams are soft-deleted (`deleted_at`): an org admin restores them from Admin › Teams. Permanent deletion is a 30-day sweep (unverified length; Figma's file trash keeps 30 days). Folders and files go to the trash (`trashed_at`), restorable by their owner, editors and admins; "Delete forever" drops the row, its room and its comments.
- **Size.** A few people: every query is by index. The only recursive query is the folder chain (≤ 10 levels).

### 14.6 The store: two spaces

The store stays the only writer (AGENTS.md). Views keep talking only to it.

- **Spaces.** `SpaceId = "local" | \`org:${string}\``.
  - `local` is today's workspace on disk, untouched: Drafts, folders, Recents, Starred, Trash, and the per-file "Shared files" of §3.
  - An org space lists from the server, through the new repositories below, and keeps a **cache** for offline use, one JSON per org: `Workspace/spaces/<orgId>.json` (desktop) or `designer.devStore.v1.space.<orgId>` (the browser's MemoryStore). The cache holds the last lists of teams, folders, files, drafts, people and groups. Reads answer from it at once, then refresh; offline, the cache answers and writes fail with `offline`.
- **Files in an org space** are rooms, with a local copy exactly like today's shared files (§5):
  - Opening one is `multiplayer.openShared(key)` (made from the room's snapshot the first time, linked after).
  - Editing is the journal + room path of §5, offline edits included.
  - The local copy's `FileMeta` gains `space: { orgId, key, teamId, projectId }` (null: local). Local listings (Drafts, folders, search) leave such copies out. Recents and Starred show both spaces, the card saying its team.
- **Creating** a file in a folder or in the org's drafts makes the local copy and registers it on the server **in one call**. A file in a team is born shared: Figma's model, where the org owns it. Offline, creation waits (`offline`): a team file can't exist before the server has it.
- **Moving a local file into a team folder** (Home's "Move to…" across spaces) is §5's Share with a destination: `POST /files {key, name, orgId, projectId}`, then the snapshot upload. The local file becomes the linked copy; its local Drafts entry disappears (now `space` is set). Moving back out of an org is not offered: Figma moves files within an org, and across orgs only by duplicating. "Duplicate to drafts" makes a new local file.
- **The current space** is a UI preference: `Prefs.browse.space` (local, per machine). Home's org switcher sets it.

Interfaces added to `src/shared/store/` (`repositories.ts` gains `orgs`, `teams`, `projects`, `admin` in `StoreApi`; `protocol.ts` gains the repositories and the event topic `org`; `types.ts` gains `FileMeta.space` and `Prefs.browse.space`). The value types live in `src/shared/org/types.ts`, which the main session commits verbatim from §14.13 before round 1 starts, so the parallel agents share them.

```ts
// src/shared/store/repositories.ts (additions)
import type * as O from "../org/types";

export type SpaceId = "local" | `org:${string}`;

export type OrgEvent =
  | { type: "orgs.changed" }                                  // membership, role or seat of the user changed
  | { type: "org.updated"; orgId: string }
  | { type: "teams.changed"; orgId: string }
  | { type: "team.updated"; teamId: string }
  | { type: "projects.changed"; teamId: string; parentId: string | null }
  | { type: "files.changed"; orgId: string; projectId: string | null } // null: drafts
  | { type: "cache.stale"; orgId: string; offline: boolean };

export interface OrgsRepository {
  /** The orgs the user is in (cached; empty when signed out) */
  list(): Promise<O.OrgSummary[]>;
  get(orgId: string): Promise<O.OrgInfo>;
  /** "Create organization": the caller becomes its admin with a Full seat; `importSharedFiles` runs §14.8 */
  create(input: { name: string; importSharedFiles?: boolean }): Promise<O.OrgInfo>;
  /** The people the caller may share with or @mention: members (to members), the groups (§14.1) */
  people(orgId: string, query?: { text?: string; limit?: number }): Promise<{ people: O.PersonRef[]; groups: O.GroupRef[] }>;
  /** The caller's drafts in this org */
  drafts(orgId: string): Promise<O.OrgFile[]>;
  createDraft(orgId: string, input?: { name?: string; editorType?: O.EditorType }): Promise<{ fileKey: FileKey; file: O.OrgFile }>;
  search(orgId: string, text: string): Promise<O.OrgSearchResult>;
  /** "Ask to upgrade" */
  requestSeat(orgId: string, seat: Exclude<O.Seat, "view">, note?: string): Promise<O.SeatRequest>;
  /** User groups (any member may create unless OrgSettings.groupCreation is "admins") */
  groups(orgId: string): Promise<O.UserGroup[]>;
  createGroup(orgId: string, input: { name: string; description?: string; userIds?: string[] }): Promise<O.UserGroup>;
  updateGroup(groupId: string, patch: { name?: string; description?: string }): Promise<O.UserGroup>;
  setGroupMembers(groupId: string, change: { add?: string[]; remove?: string[] }): Promise<O.UserGroup>;
  deleteGroup(groupId: string): Promise<void>;
  leave(orgId: string): Promise<void>;
  watch(listener: (e: OrgEvent) => void): Unsubscribe;
}

export interface TeamsRepository {
  /** "mine": teams the user is in; "browse": also the Visible and audience-reachable teams of the org (members only) */
  list(orgId: string, filter?: "mine" | "browse"): Promise<O.TeamSummary[]>;
  get(teamId: string): Promise<O.TeamInfo>;
  create(orgId: string, input: { name: string; workspaceId?: string | null }): Promise<O.TeamInfo>;
  update(teamId: string, patch: O.TeamPatch): Promise<O.TeamInfo>;
  /** Soft delete (admins and the owner); restore from Admin or by the owner within the sweep */
  remove(teamId: string): Promise<void>;
  restore(teamId: string): Promise<O.TeamInfo>;
  /** Only the owner; the new owner must be a member of the team */
  transfer(teamId: string, userId: string): Promise<O.TeamInfo>;
  members(teamId: string): Promise<O.TeamMember[]>;
  /** Invite a person (email) or a group as can edit / can view; `admin` only by admins */
  invite(teamId: string, input: { email?: string; groupId?: string; role: O.GrantRole; admin?: boolean }): Promise<O.TeamMember[]>;
  setMember(teamId: string, principal: O.Principal, patch: { role?: O.GrantRole; admin?: boolean }): Promise<O.TeamMember[]>;
  removeMember(teamId: string, principal: O.Principal): Promise<O.TeamMember[]>;
  /** A Visible team: joins at once when the team's audience allows, else asks the admins */
  join(teamId: string): Promise<{ status: "joined" | "requested" }>;
  leave(teamId: string): Promise<void>;
  requests(teamId: string): Promise<O.JoinRequest[]>;
  answerRequest(teamId: string, userId: string, approve: boolean): Promise<O.JoinRequest[]>;
}

export interface ProjectsRepository {
  /** Folders of a team at one level (parentId null: top level), with counts */
  list(teamId: string, parentId?: string | null): Promise<O.ProjectSummary[]>;
  get(projectId: string): Promise<O.ProjectInfo>;
  create(teamId: string, input: { name: string; parentId?: string | null; access?: O.InheritMode }): Promise<O.ProjectInfo>;
  update(projectId: string, patch: { name?: string; access?: O.InheritMode }): Promise<O.ProjectInfo>;
  /** Move within the org: another parent or another team (depth ≤ 10 kept, else `invalid`) */
  move(projectId: string, to: { teamId: string; parentId: string | null }): Promise<O.ProjectInfo>;
  trash(projectId: string): Promise<void>;
  restore(projectId: string): Promise<O.ProjectInfo>;
  deleteForever(projectId: string): Promise<void>;
  members(projectId: string): Promise<O.ProjectMember[]>;
  invite(projectId: string, input: { email?: string; groupId?: string; role: O.GrantRole }): Promise<O.ProjectMember[]>;
  setMember(projectId: string, principal: O.Principal, role: O.GrantRole): Promise<O.ProjectMember[]>;
  removeMember(projectId: string, principal: O.Principal): Promise<O.ProjectMember[]>;
  /** Files directly in the folder */
  files(projectId: string): Promise<O.OrgFile[]>;
  createFile(projectId: string, input?: { name?: string; editorType?: O.EditorType }): Promise<{ fileKey: FileKey; file: O.OrgFile }>;
  /** Org files (by room key) into a folder, or into the mover's drafts (null) — same org only */
  moveFiles(keys: string[], to: { projectId: string | null }): Promise<void>;
  /** A local file into a folder: §5's share with a destination; the editor hands the snapshot (as multiplayer.share) */
  moveLocalFile(fileKey: FileKey, projectId: string, input: { snapshot: Uint8Array; headSeq: number }): Promise<O.OrgFile>;
  trashFiles(keys: string[]): Promise<void>;
  restoreFiles(keys: string[]): Promise<void>;
  /** The team's trash (folders and files), for editors and admins */
  trashed(teamId: string): Promise<{ projects: O.ProjectSummary[]; files: O.OrgFile[] }>;
}

/** The Admin location (src/renderer/src/admin/): org admins; workspace / billing group admins see their part. */
export interface AdminRepository {
  dashboard(orgId: string): Promise<O.AdminDashboard>;
  people(orgId: string, query?: O.PeopleQuery): Promise<O.Page<O.AdminPerson>>;
  addPeople(orgId: string, input: O.AddPeopleInput): Promise<O.AdminPerson[]>;
  updatePeople(orgId: string, input: O.UpdatePeopleInput): Promise<O.AdminPerson[]>;
  removePeople(orgId: string, userIds: string[]): Promise<void>;
  seatRequests(orgId: string, state?: "pending" | "all"): Promise<O.SeatRequest[]>;
  answerSeatRequest(orgId: string, id: string, approve: boolean): Promise<O.SeatRequest>;
  guestRequests(orgId: string): Promise<O.GuestRequest[]>;
  answerGuestRequest(orgId: string, id: string, approve: boolean): Promise<O.GuestRequest>;
  teams(orgId: string, query?: O.TeamsQuery): Promise<O.Page<O.AdminTeam>>;
  workspaces(orgId: string): Promise<O.OrgWorkspace[]>;
  createWorkspace(orgId: string, input: { name: string; adminIds: string[]; hidden?: boolean }): Promise<O.OrgWorkspace>;
  updateWorkspace(workspaceId: string, patch: O.WorkspacePatch): Promise<O.OrgWorkspace>;
  deleteWorkspace(workspaceId: string): Promise<void>;
  billingGroups(orgId: string): Promise<O.BillingGroup[]>;
  createBillingGroup(orgId: string, input: { name: string; adminIds?: string[] }): Promise<O.BillingGroup>;
  updateBillingGroup(id: string, patch: { name?: string; adminIds?: string[] }): Promise<O.BillingGroup>;
  deleteBillingGroup(id: string): Promise<void>;
  activity(orgId: string, query?: O.ActivityQuery): Promise<O.ActivityPage>;
  settings(orgId: string): Promise<O.OrgSettings>;
  updateSettings(orgId: string, patch: Partial<O.OrgSettings>): Promise<O.OrgSettings>;
  unassignedDrafts(orgId: string): Promise<O.UnassignedDrafts[]>;
  moveUnassigned(orgId: string, input: { fileKeys?: string[]; ownerId?: string; to: { projectId: string } | { teamId: string } }): Promise<void>;
  deleteUnassigned(orgId: string, fileKeys: string[]): Promise<void>;
  /** CSV text of People, Teams or Activity with the same query (the view saves it through main's Save dialog) */
  exportCsv(orgId: string, what: "people" | "teams" | "activity", query?: unknown): Promise<string>;
}

// StoreApi gains: orgs: OrgsRepository; teams: TeamsRepository; projects: ProjectsRepository; admin: AdminRepository;
```

- **Errors** over the port use the existing `StoreErrorCode`s:
  - `forbidden` (detail `{code}` from the server: `seat_required`, `guest_blocked`, `admins_only`, `not_admin`, `limited`);
  - `not-found`, `invalid`, `offline`;
  - `conflict` is new: a name taken or a stale write.
- **Events** go on topic `org` (OrgEvent). The store learns of changes from the user's **Inbox** socket (§12), which carries `{t: "org", orgId, what}` notices besides notifications. There is no polling.
- **The browser's MemoryStore** implements the same four repositories over the same server client. The fake that 1d builds against implements `AdminRepository` alone.

### 14.7 People leaving, drafts

- **Removing someone from the org** (Admin › People):
  - drops their `org_members` row, team, folder and file grants in that org, and group memberships;
  - closes their sockets (§14.9);
  - moves their drafts' ownership to the org: `files.owner_id` is kept, but their drafts list under Admin › Content › **Unassigned drafts** [F-drafts].
  
  A draft shared before removal keeps its invited people. Admins move unassigned drafts into a folder or a team (`moveUnassigned`), or delete them for good.
- **Deleting the account** (§13) removes the person from every org first, the same way. Their org drafts **stay** (the org owns them): a change to §13's rule for files in an org. Files outside any org go as before.

### 14.8 Migrating today's shared files

Today every shared file belongs to no org (`files.org_id` null). Nothing moves by itself. "Create organization" with **Import shared files** (`POST /orgs {name, importSharedFiles: true}`, run once by the owner) does the following in one D1 batch:
1. Makes the org. The caller becomes `admin`, seat `full`, `OrgSettings` at defaults.
2. Makes a team named "‹name›" (owner and admin: the caller; org access none, Visible) and in it a top-level folder **"Shared files"** (Inherited).
3. Moves every file **the caller owns** with `org_id` null into that folder: sets `org_id`, `team_id`, `project_id`. Rooms, keys, links, members, passwords, comments and notifications stay as they are; nothing in a room changes.
4. Adds every person with a grant on those files (members rows, pending ones included) to the org as **member** (owner's decision 2026-10-11), seat `full` if they had "can edit" on any of them, else `view`. A pending email becomes a pending `org_members` row.

   They are members at once (the owner's decision; Figma would make them guests without a shared domain). Their file roles stay what they were, so nobody loses access.
5. Logs `org_user_create` / `org_user_create_external`, `team_create`, `project_create` and `fig_file_move` with `details.migrated: true`.

Files other people own and shared with the caller stay outside the org: they are theirs. Each owner may run "Create organization" or be invited and move their files in. Local files are untouched; they move with "Move to…" (§14.6).

### 14.9 How the room checks roles

- **The Worker decides**, as today (§3): every `/files/:key/…` route and the socket upgrade call `resolveAccess` and forward the room's identity (`x-user-id`, `x-user-name`, `x-role` = `roomRole`). The room itself never reads D1.
- **Changes re-check open sockets.** Any change that can lower someone's access ends with a reauthorization. Such changes are: a grant removed or lowered; a team's audience, visibility or deletion; a folder becoming Limited or moving; a file moving, being trashed or changing link; a seat change; a person removed; a group's membership change.
  - The Worker lists the affected file keys: the file; the files under the folder subtree; the team's files; or every file the person could reach in the org.
  - It posts `POST /room/reauth {userIds?: string[]}` to each room (new route in `fileRoom.ts`; at most 500 rooms inline, the rest through `ctx.waitUntil`). The room closes those users' sockets (all, when `userIds` is absent) with **4003**, the existing "role changed" close code.
  - Clients reconnect, and the Worker resolves again.
  - A room with no sockets wakes, finds nobody and sleeps.
- **Raising** access needs nothing: the next request resolves the new role.
- **Comments, previews and notifications** check with `resolveAccess` too. "Only people who can open the file are told" (§12) now uses it.
- **Policies for the room** (round 4: cursor chat, audio, open sessions): `welcome` gains `policy: {cursorChat: boolean, audio: boolean}` from the org's settings, delivered on (re)connect.

### 14.10 Activity log

**Row shape**: Figma's ActivityLog [F-log events], which both `GET /orgs/:org/admin/activity` and round 5's `/v1/activity_logs` return.

```ts
interface ActivityLog {
  id: string;                         // the row id as a string
  timestamp: number;                  // Unix seconds (Figma's); `at` in D1 is ms
  actor: { type: "user"; id: string; email: string; name: string } | null;
  action: { type: ActivityAction; details: Record<string, unknown> };
  entity: { type: ActivityEntityType; id: string; name: string } & Record<string, string>; // Figma's entity fields
  context: { client_name: string | null; ip_address: string; is_figma_support_team_action: false; org_id: string; team_id: string | null };
}
type ActivityEntityType = "file" | "file_repo" | "org" | "project" | "team" | "user" | "workspace" | "idp_user" | "plugin" | "widget" | "policy_acknowledgement_config";
```

**Entity fields** are Figma's [F-log entity types]:
- `file {key, name, editor_type, link_access, proto_link_access}`
- `file_repo {id, name, main_file_key}`, which is a branch's repository (data.md §15)
- `project {id, name}`, `team {id, name}`, `user {id, name, email}`, `workspace {id, name}`, `org {id, name}`

**Writing.** `server/src/activity.ts`:
- `logActivity(deps, {orgId, action, actor, entity, details, teamId?, req})` writes one row.
- IP comes from `cf-connecting-ip`; `client_name` comes from the User-Agent (`DesignerV2-Desktop/…` or the browser, `shared/account.ts deviceFromUserAgent`).
- Every mutating route of §14.12 and of §3, §6, §8 on an **org file** calls it after its write succeeds, in the same `ctx.waitUntil` as notifications.
- Events of files outside any org are not logged (Figma logs organizations only).

**Sign-ins** (`user_sign_in`, `user_sign_out`, from `/auth/token` and `/me/sessions` deletes) are written once per org the user is a member of.

**Views and exports.**
- `fig_file_view` is written by the Worker on a socket upgrade, at most once per person per file per hour (ours; Figma's rate is unpublished). `fig_file_view_external` is used when the viewer is a guest.
- `fig_file_view_prototype` is used for Present, `m=proto`.
- `fig_file_export` is **client-reported** (`POST /files/:key/activity {action: "fig_file_export", details: {format, count}}`): the server can't see a local export. Its details carry `client_reported: true`.

**Retention**: one year, by a daily Cron Trigger (unverified: Figma's API defaults `start_time` to one year ago [F-log endpoints]).

**Round 1 writes these actions** (Figma's exact names [F-log action types]; the mapping to our routes is ours where marked (inferred)):

| Group | Actions |
|---|---|
| Files | `fig_file_create`, `fig_file_duplicate`, `fig_file_move`, `fig_file_rename`, `fig_file_trash`, `fig_file_restore`, `fig_file_permanent_delete`, `fig_file_member_add`, `fig_file_member_permission_change`, `fig_file_member_remove`, `fig_file_link_access_change` (both link settings), `fig_file_link_expiration_change`, `fig_file_proto_link_access_change`, `fig_file_set_password`, `fig_file_unset_password`, `fig_file_viewer_access_change` ("Viewers can copy, save, and export" — inferred), `fig_file_view`, `fig_file_view_external`, `fig_file_view_prototype`, `fig_file_export`, `fig_file_save_as` (Save local copy — client-reported, inferred) |
| Folders | `project_create`, `project_rename`, `project_move`, `project_trash`, `project_restore`, `project_delete`, `project_member_add`, `project_member_permission_change`, `project_member_remove`, `project_team_access_change` (Inherited ↔ Limited — inferred) |
| Teams | `team_create`, `team_rename`, `team_delete`, `team_restore`, `team_member_add`, `team_member_add_external` (a guest), `team_member_permission_change` (role or admin), `team_member_remove`, `team_member_remove_external`, `team_org_access_change` (org / workspace audience), `team_sharing_audience_control_change` (Visible ↔ Hidden — inferred), `team_workspace_change`, `team_license_group_change`, `org_team_creation_controls`, `org_team_csv_exported` |
| People and seats | `org_user_create`, `org_user_create_external`, `org_user_delete`, `org_user_delete_external`, `org_user_permission_change` (member ↔ admin), `org_user_account_type_change` (seat), `org_user_account_type_change_to_full`, `org_user_account_type_upgrade_requested`, `org_user_account_type_upgrade_approved`, `org_user_account_type_upgrade_denied`, `org_invite_create`, `org_join_request_create`, `org_join_request_approve`, `roster_exported` (People CSV), `org_default_license_type_change` |
| Settings | `org_guest_invite_setting_change`, `public_link_setting_change` |
| Workspaces | `workspace_create`, `workspace_rename`, `workspace_delete`, `workspace_member_add`, `workspace_member_remove`, `workspace_admins_add`, `workspace_admins_remove`, `workspace_visibility_setting_change`, `workspace_team_csv_exported` |
| Billing groups | `license_group_create`, `license_group_rename`, `license_group_delete`, `license_group_admins_add`, `license_group_admins_remove`, `license_group_membership_change` |
| Sign-in and tokens | `user_sign_in`, `user_sign_out`, `personal_access_token_create`, `personal_access_token_delete` |
| User groups | Figma's published names cover IdP groups only (`idp_group_create`, `idp_group_rename`, `idp_group_delete`, …, round 4). For manual groups we write **ours**: `user_group_create`, `user_group_rename`, `user_group_delete`, `user_group_member_add`, `user_group_member_remove` |
| Branches (round 2) | `branch_create`, `branch_archive`, `branch_unarchive`, `branch_delete`, `branch_member_add`, `branch_member_permission_change`, `branch_member_remove`, `repo_merge_to_source` (merge into main — inferred), `repo_merge_from_source` (Update from main — inferred) |

Later rounds add their groups with Figma's names: domains, SSO and SCIM in round 4; libraries (`org_library_approve`…) in round 3; AI in round 6; plugins in round 5. The full list is [F-log action types].

### 14.11 Notifications and sessions in orgs

- **Notifications (§12)** keep their table and Inbox. Changes:
  - **New kinds**, with the wording to be read from Figma's bell when built (unverified): `team_invite`, `project_invite`, `team_join_request` (to team admins), `seat_request` and its answer, `guest_request` (to admins).
  - Round 2 adds `branch_review_request`, `branch_review` (approved / changes suggested) and `branch_merged`.
  - Rows carry `org_id` / `team_id`, so the bell's menu can offer Figma's plan / team filter.
  - "Only people who can open the file are told" uses `resolveAccess`.
  - An @mention of a **user group** notifies each member who can open the file, each per their own preferences [F-group].
  - The Inbox also carries `{t: "org", …}` notices for the store's cache (§14.6).
- **Sessions and tokens (§13).** Already per user and not per org; they stay that way.
  - `org_members.last_active_at` moves on with the session's own 5-minute touch, for each org of the user. One extra UPDATE when the session row is touched.
  - Round 4's idle timeout is per org (the shortest wins across the user's orgs, R18 A-6) and reads `sessions.last_seen_at`. It needs the app to report activity: a throttled `POST /me/sessions/active` once a minute while the user is active.
  - Admins see a person's sessions only through the activity log (`user_sign_in`). Figma documents no admin session list (R18 Part 6).
  - **Personal access tokens** read org files only where `resolveAccess` gives the person view access. Org-level "plan access tokens" (`plan_access_token_*`) are round 5.

### 14.12 HTTP routes

**Conventions:**
- JSON, `Authorization: Bearer <session>`.
- Errors are `{error: "<message>", code: "<code>"}`. `code` is new and machine-readable; `error` stays the human message, as today.

| HTTP | `code` | When |
|---|---|---|
| 400 | `invalid` | a bad field (message names it) |
| 401 | `unauthorized` | no or bad session |
| 403 | `forbidden` | not allowed |
| 403 | `seat_required` | the seat can't do it (detail `seat`) |
| 403 | `not_admin` | an admin route |
| 403 | `admins_only` | team or group creation is restricted to admins |
| 403 | `guest_blocked` | outside emails are blocked |
| 403 | `password_required` | — |
| 404 | `not_found` | also for what exists but the caller can't see |
| 409 | `conflict` | name taken, transfer target not a member, a folder deeper than 10 |
| 410 | `gone` | link expired |
| 413 | `too_large` | — |
| 429 | `rate_limited` | — |

Pages use `?cursor=&limit=` (≤ 200) and return `{items, cursor: string | null}`.

**Organization and people** (any member unless said):

| Route | Request | Response |
|---|---|---|
| `GET /orgs` | — | `{orgs: OrgSummary[]}` |
| `POST /orgs` | `{name, importSharedFiles?}` | `{org: OrgInfo}` (§14.8) |
| `GET /orgs/:org` | — | `{org: OrgInfo}` |
| `GET /orgs/:org/people?text=&limit=` | — | `{people: PersonRef[], groups: GroupRef[]}` (guests: only people of resources they're in, and their groups) |
| `GET /orgs/:org/drafts` | — | `{files: OrgFile[]}` |
| `POST /orgs/:org/drafts` | `{key, name, editorType?}` | `{file: OrgFile}` — then `PUT /files/:key/snapshot?seq=0` as §3 |
| `GET /orgs/:org/search?text=` | — | `OrgSearchResult` |
| `POST /orgs/:org/seat-requests` | `{seat, note?}` | `{request: SeatRequest}` (approved at once under `auto`) |
| `DELETE /orgs/:org/me` | — | 204 (leave; the last admin can't) |
| `GET /orgs/:org/groups` | — | `{groups: UserGroup[]}` |
| `POST /orgs/:org/groups` | `{name, description?, userIds?}` | `{group}` (`admins_only` per settings) |
| `PATCH /groups/:id` | `{name?, description?}` | `{group}` (creator or admin) |
| `POST /groups/:id/members` | `{add?: string[], remove?: string[]}` | `{group}` |
| `DELETE /groups/:id` | — | 204 |

**Teams:**

| Route | Who | Request → Response |
|---|---|---|
| `GET /orgs/:org/teams?filter=mine\|browse` | member (guests: `mine`) | `{teams: TeamSummary[]}` |
| `POST /orgs/:org/teams` | members (settings.teamCreation) | `{name, workspaceId?}` → `{team: TeamInfo}` |
| `GET /teams/:team` | anyone who can see it | `{team: TeamInfo}` |
| `PATCH /teams/:team` | team admin / owner / org admin; `workspaceId` org admin only | `TeamPatch` → `{team}` |
| `DELETE /teams/:team` | owner, team admins, org admins | 204 (soft) |
| `POST /teams/:team/restore` | org admins, owner | `{team}` |
| `POST /teams/:team/transfer` | owner | `{userId}` → `{team}` |
| `GET /teams/:team/members` | anyone in the team | `{members: TeamMember[]}` |
| `PUT /teams/:team/members` | editors (as viewer or editor), admins (any, `admin`) | `{email? \| groupId?, role, admin?}` → `{members}` |
| `PATCH /teams/:team/members/:principal` | admins | `{role?, admin?}` → `{members}` (`principal` = `u:<userId>`, `e:<email>`, `g:<groupId>`) |
| `DELETE /teams/:team/members/:principal` | admins; anyone for themselves | `{members}` |
| `POST /teams/:team/join` | org members | → `{status: "joined" \| "requested"}` |
| `GET /teams/:team/requests` · `POST /teams/:team/requests/:userId {approve}` | admins | `{requests: JoinRequest[]}` |
| `GET /teams/:team/projects?parent=` | anyone in | `{projects: ProjectSummary[]}` |
| `GET /teams/:team/trash` | editors, admins | `{projects, files}` |

**Folders** (`/projects/…`):

| Route | Who | Request → Response |
|---|---|---|
| `POST /teams/:team/projects` | team editors, admins | `{name, parentId?, access?}` → `{project: ProjectInfo}` |
| `GET /projects/:id` | anyone who can see it | `{project: ProjectInfo}` (with `path`) |
| `PATCH /projects/:id` | folder owner / editors / admins | `{name?, access?}` → `{project}` |
| `POST /projects/:id/move` | editors of the folder and of the destination | `{teamId, parentId}` → `{project}` |
| `POST /projects/:id/trash` · `/restore` · `DELETE /projects/:id` | editors / admins (`DELETE` only from the trash) | 204 / `{project}` / 204 |
| `GET /projects/:id/members` · `PUT` · `PATCH /:principal` · `DELETE /:principal` | as teams | `{members: ProjectMember[]}` |
| `GET /projects/:id/files` | anyone who can see it | `{files: OrgFile[]}` |
| `POST /projects/:id/files` | folder editors (seat may create the editor type) | `{key, name, editorType?}` → `{file}` |

**Files** (§3 extended): `POST /files {key, name, orgId?, projectId?}` (a draft when `orgId` and no `projectId`). The existing routes keep their shapes, with these changes:
- `PATCH /files/:key` takes `{name?, access?, orgLinkAccess?, protoLinkAccess?, linkExpiresAt?}`; `linkExpiresAt` must not pass the org's maximum (round 4).
- `POST /files/:key/move {projectId: string | null}` — same org; `null` means the mover's drafts.
- `POST /files/:key/trash` · `/restore`. `DELETE /files/:key` for an org file deletes it for good, from the trash only; outside orgs it still means "stop sharing".
- `PUT /files/:key/members` accepts `groupId` instead of `email`.
- `GET /files/:key` adds `access: {role, canEdit, canComment, canExport, canDevMode, canShare, canManage, capped, via}` and `org: {id, name, teamId, teamName, projectId, path} | null`.
- `POST /files/:key/activity {action, details}` — client-reported events only: `fig_file_export`, `fig_file_save_as`, `fig_file_view_prototype`.
- **Enforced in round 1** (R18 A-8, A-6):
  - `viewers_can_copy` off → `GET /files/:key/snapshot` and `/images/*` are still served (viewing needs them), but the editor gets `canExport: false` and hides Export, Copy as, Save local copy and Duplicate. The snapshot route refuses `?purpose=export`, which the store sends for Save local copy and Duplicate.
  - `link_expires_at` past → link-only people get 410 `gone`; the Share dialog shows the link as off.

**Admin** (`/orgs/:org/admin/…`; org admins, except workspace admins for their workspaces' people and teams, and billing group admins for their groups' people and seat requests):

| Route | Request → Response |
|---|---|
| `GET admin/dashboard` | → `AdminDashboard` |
| `GET admin/people?text=&role=&seat=&workspace=&billingGroup=&activeBefore=&cursor=&limit=&format=json\|csv` | → `Page<AdminPerson>` or `text/csv` (logs `roster_exported`) |
| `POST admin/people` | `AddPeopleInput` → `{people: AdminPerson[]}` |
| `PATCH admin/people` | `UpdatePeopleInput` (bulk) → `{people}` |
| `POST admin/people/remove` | `{userIds}` → 204 |
| `GET admin/seat-requests?state=` · `POST admin/seat-requests/:id {approve}` | → `{requests}` / `{request}` |
| `GET admin/guest-requests` · `POST admin/guest-requests/:id {approve}` | → `{requests}` / `{request}` |
| `GET admin/teams?text=&workspace=&includeHidden=1&includeDeleted=1&format=` | → `Page<AdminTeam>` or CSV (`org_team_csv_exported`) |
| `GET admin/workspaces` · `POST admin/workspaces {name, adminIds, hidden?}` | → `{workspaces}` / `{workspace}` |
| `PATCH admin/workspaces/:id` | `WorkspacePatch` (`name`, `hidden`, `adminIds`, `defaultTeamIds`, `memberIds` add/remove) → `{workspace}` |
| `DELETE admin/workspaces/:id` | → 204 (its teams and people become unassigned) |
| `GET/POST admin/billing-groups` · `PATCH/DELETE admin/billing-groups/:id` | as workspaces |
| `GET admin/activity?events=&email=&team=&start_time=&end_time=&order=&cursor=&limit=&format=` | → `ActivityPage` `{activity_logs: ActivityLog[], cursor, next_page}` (Figma's `meta` content) or CSV |
| `GET admin/settings` · `PATCH admin/settings` | `Partial<OrgSettings>` → `OrgSettings` (each changed key logs its action) |
| `GET admin/drafts` | → `{owners: UnassignedDrafts[]}` |
| `POST admin/drafts/move` | `{fileKeys? \| ownerId?, to: {projectId} \| {teamId}}` → 204 (into a team: a new folder named after the person — unverified) |
| `POST admin/drafts/delete` | `{fileKeys}` → 204 |

Server layout (round 1a):
- `server/src/org/` holds:
  - `db.ts` — queries, `loadAccessRows`;
  - `orgs.ts`, `teams.ts`, `projects.ts`, `groups.ts`, `admin.ts` — routes;
  - `reauth.ts` — §14.9;
  - `migrate.ts` — §14.8.
- `server/src/activity.ts` holds the log.
- `api.ts` gains one dispatch line each for `/orgs`, `/teams`, `/projects`, `/groups`, and calls `resolveAccess` in the files routes.

### 14.13 Shared types (`src/shared/org/types.ts`, committed verbatim before round 1)

```ts
export type OrgRole = "admin" | "member" | "guest";
export type Seat = "full" | "dev" | "collab" | "view";
export type GrantRole = "editor" | "viewer";
export type Level = "owner" | "editor" | "viewer";
export type Audience = "none" | "viewer" | "editor";
export type InheritMode = "inherited" | "limited";
/** Figma's EditorType, by product (docs/schema.md §15): design = DESIGN, figjam = WHITEBOARD, slides = SLIDES, buzz = COOPER, sites = SITES, make = FIGMAKE */
export type EditorType = "design" | "figjam" | "slides" | "buzz" | "sites" | "make";
export type Principal = `u:${string}` | `e:${string}` | `g:${string}`;

export interface OrgSettings {
  /** "Anyone" (default) or "Admins only" [F-ws team creation] */
  teamCreation: "anyone" | "admins";
  /** Enterprise: "Team and user group creation" [F-group] */
  groupCreation: "anyone" | "admins";
  /** Guest membership: Allow (default) / Require admin approval / Block (enforced round 4, stored round 1) */
  guestMembership: "allow" | "approval" | "block";
  /** Seat for new people [unverified default] */
  defaultSeat: Seat;
  seatApproval: Record<Exclude<Seat, "view">, "manual" | "manual_unless_available" | "auto">;
  /** Sharing and publishing (round 4): public links allowed, link expiry maximum in hours (null: none), passwords required */
  publicLinks: boolean;
  linkExpiryMaxHours: number | null;
  passwordRequired: boolean;
  /** Round 4: */
  cursorChat: boolean;
  audio: boolean;
}
export const DEFAULT_ORG_SETTINGS: OrgSettings = {
  teamCreation: "anyone", groupCreation: "anyone", guestMembership: "allow", defaultSeat: "view",
  seatApproval: { full: "manual_unless_available", dev: "manual_unless_available", collab: "manual_unless_available" },
  publicLinks: true, linkExpiryMaxHours: null, passwordRequired: false, cursorChat: true, audio: true,
};

export interface OrgSummary { id: string; name: string; role: OrgRole; seat: Seat; workspaceId: string | null }
export interface OrgInfo extends OrgSummary {
  createdAt: number;
  /** The caller's admin reach */
  workspaceAdminOf: string[];
  billingGroupAdminOf: string[];
  counts: { members: number; guests: number; teams: number };
  settings: OrgSettings;            // readable by everyone in the org (the UI hides what policy forbids)
}
export interface PersonRef { id: string; email: string; name: string | null; picture: string | null; role: OrgRole }
export interface GroupRef { id: string; name: string; memberCount: number }
export interface UserGroup extends GroupRef { description: string; createdBy: string; external: boolean; members: PersonRef[]; canManage: boolean }

export interface TeamSummary {
  id: string; name: string; icon: string | null; workspaceId: string | null;
  visibility: "visible" | "hidden"; orgAccess: Audience; workspaceAccess: Audience;
  /** The caller's place: null when they only see it (browse) */
  me: { role: GrantRole | null; admin: boolean; owner: boolean; requested: boolean } | null;
  memberCount: number; projectCount: number;
}
export interface TeamInfo extends TeamSummary { description: string; ownerId: string; createdAt: number; deletedAt: number | null }
export interface TeamPatch { name?: string; description?: string; icon?: string | null; orgAccess?: Audience; workspaceAccess?: Audience; visibility?: "visible" | "hidden"; workspaceId?: string | null }
export interface TeamMember { principal: Principal; person: PersonRef | null; group: GroupRef | null; email: string | null; role: GrantRole; admin: boolean; owner: boolean; pending: boolean; guest: boolean }
export interface JoinRequest { userId: string; person: PersonRef; createdAt: number }

export interface ProjectSummary { id: string; teamId: string; parentId: string | null; name: string; access: InheritMode; fileCount: number; folderCount: number; updatedAt: number; trashedAt: number | null; me: Level | null }
export interface ProjectInfo extends ProjectSummary { ownerId: string; depth: number; path: { id: string; name: string }[]; createdAt: number }
export interface ProjectMember extends Omit<TeamMember, "admin"> { inherited: boolean /* from the team or a parent: can't be lowered here */ }

export interface OrgFile {
  key: string; name: string; editorType: EditorType; ownerId: string; ownerName: string | null;
  orgId: string; teamId: string | null; projectId: string | null;
  updatedAt: number; createdAt: number; trashedAt: number | null;
  /** Figma REST's thumbnail_url: a route of ours (/files/:key/thumbnail), null until a client uploaded one */
  thumbnailUrl: string | null;
  access: FileAccess;
  /** The local linked copy on this installation, if any */
  fileKey: string | null;
  /** Round 2: branches (docs/data.md §15) */
  mainFileKey?: string | null; branchCount?: number;
}
export interface FileAccess { role: Level; canEdit: boolean; canComment: boolean; canExport: boolean; canDevMode: boolean; canShare: boolean; canManage: boolean; capped: "seat" | "external" | null; via: ("file" | "folder" | "team" | "org-admin" | "workspace-admin" | "audience" | "link")[] }
export interface OrgSearchResult { files: OrgFile[]; projects: ProjectSummary[]; teams: TeamSummary[]; people: PersonRef[] }

export interface SeatRequest { id: string; orgId: string; userId: string; person: PersonRef; seat: Exclude<Seat, "view">; note: string; state: "pending" | "approved" | "denied"; createdAt: number; answeredAt: number | null; answeredBy: string | null }
export interface GuestRequest { id: string; email: string; invitedBy: PersonRef; resource: { type: "team" | "project" | "file"; id: string; name: string }; role: GrantRole; state: "pending" | "approved" | "denied"; createdAt: number }

export interface Page<T> { items: T[]; cursor: string | null; total?: number }
export interface AdminDashboard { members: number; guests: number; seats: Record<Seat, number>; pendingSeatRequests: number; pendingGuestRequests: number; teams: number; workspaces: number; activeLast30Days: number }
export interface PeopleQuery { text?: string; role?: OrgRole; seat?: Seat; workspaceId?: string | "none"; billingGroupId?: string | "none"; activeBefore?: number; cursor?: string; limit?: number }
export interface AdminPerson extends PersonRef { seat: Seat; workspaceId: string | null; billingGroupId: string | null; lastActiveAt: number | null; joinedAt: number; pending: boolean; teams: number }
export interface AddPeopleInput { emails: string[]; role: Exclude<OrgRole, "admin"> | "admin"; seat?: Seat; workspaceId?: string | null; billingGroupId?: string | null }
export interface UpdatePeopleInput { userIds: string[]; role?: OrgRole; seat?: Seat; workspaceId?: string | null; billingGroupId?: string | null }
export interface TeamsQuery { text?: string; workspaceId?: string | "none"; includeHidden?: boolean; includeDeleted?: boolean; cursor?: string; limit?: number }
export interface AdminTeam extends TeamInfo { ownerName: string | null; adminCount: number; fileCount: number; lastEditedAt: number | null }
export interface OrgWorkspace { id: string; name: string; hidden: boolean; admins: PersonRef[]; defaultTeamIds: string[]; memberCount: number; teamCount: number; createdAt: number }
export interface WorkspacePatch { name?: string; hidden?: boolean; adminIds?: string[]; defaultTeamIds?: string[]; members?: { add?: string[]; remove?: string[] }; teams?: { add?: string[]; remove?: string[] } }
export interface BillingGroup { id: string; name: string; admins: PersonRef[]; memberCount: number }
export interface ActivityQuery { events?: string[]; email?: string; teamId?: string; startTime?: number; endTime?: number; order?: "asc" | "desc"; cursor?: string; limit?: number }
export interface ActivityPage { activity_logs: ActivityLog[]; cursor: string | null; next_page: boolean }
export interface UnassignedDrafts { owner: { id: string; email: string; name: string | null; removedAt: number }; files: OrgFile[] }
// ActivityLog, ActivityEntityType: §14.10; ActivityAction = the string union of §14.10's table
```

### 14.14 Not decided here (owner)

See `docs/roadmap.md` Phase 7 "Open questions for the owner". **Answered (owner, 2026-10-11):**
- friends are **members**: an admin adds anyone as a member by hand, and §14.8's import makes the people the owner shared with **members** (not guests); the email-domain rule still makes self-joiners from other domains guests;
- seats default to **View** (Figma's), "Ask to upgrade" raises them;
- org admins **edit everything implicitly**;
- **several orgs** per person: the org switcher, "Create organization" asks the name;
- files outside an org stay legal (not asked; Figma keeps sharing drafts).
