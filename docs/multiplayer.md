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
| Org libraries, library analytics, shared fonts (contract, Phase 7 round 3) | D1 (migration 0012), Durable Objects `LibraryObject` per library and `FontObject` per org (SQLite, 1 MB chunks; wrangler tag v4), a daily Cron Trigger for the analytics roll-up | `server/src/libraries/`, `server/src/analytics/`, `server/src/fonts/`, `src/store/libraries/` (docs/data.md §16–§17, docs/desktop.md §14.3) |
| Identity and security: SAML SSO, SCIM, domains, policies, idle timeout, EU data region (contract, Phase 7 round 4) | D1 (migration 0013), Durable Objects in Cloudflare's `eu` jurisdiction for EU orgs' rooms and libraries | `server/src/auth/`, `server/src/policy/`, `src/shared/org/identity.ts` (§15) |
| REST API, webhooks, private plugins, Dev Mode's server side (contract, Phase 7 round 5) | D1 (migration 0015), a second Cron Trigger (webhook retries), render jobs answered by connected clients (no new Durable Object) | `server/src/rest/`, `server/src/webhooks/`, `server/src/devmode/`, `server/src/plugins/`, `src/shared/rest/` (§16, docs/plugins.md, docs/editor.md "Dev Mode — round 5") |
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

**As built (round 1b, 2026-10-11)** — `src/store/org/service.ts` (`OrgService`, no Node or DOM imports; both stores), tested against `src/store/org/fake/server.ts` (a contract fake of §14.12, one `Request → Response` handler like `server/src/api.ts handle`, to be swapped for the real handler once 1a lands) in `src/store/org/service.test.ts` (13 cases: shapes, cache, offline, two accounts, linked copies, move in, a member opening, notices, error codes, Admin, LocalStore on disk, over the port).
- **Wiring.** `StoreApi.orgs / teams / projects / admin` are `OrgService`'s four objects (`localStore.ts localAdapter`, `memoryStore.ts api`); `protocol.ts` lists their methods (reads retry-safe), the topic `org` and the error code `conflict`; `client.ts` proxies them (`orgs.watch` is the topic); `server.ts` broadcasts `ServableStore.org.onEvent`. `src/shared/store/repositories.ts` re-exports the interfaces of `src/shared/org/repositories.ts`.
- **Errors.** `MultiplayerService` now reads `{error, code}` bodies for every server call (`httpError`): `detail` is the body without `error` (`{code: "seat_required", seat}`, `{code: "admins_only"}` …); 409 → `conflict`, 410 → `not-found` `{code: "gone"}`, 413 → `too-large`; 204 answers are read as nothing.
- **Cache.** `Workspace/spaces/<orgId>.json` / `designer.devStore.v1.space.<orgId>`: `OrgCache {v: 1, uid, orgId, savedAt, summary, info, teams {mine, browse}, team, projects ("<teamId>/<parentId>"), project, files (folder id, drafts under "@drafts"), people, groups}`. Keyed by the person (`uid` from the session token's payload, `MultiplayerService.userId`): another account's caches are never read. Cached reads: `orgs.list / get / people (no query) / drafts / groups`, `teams.list / get`, `projects.list / get / files`; they answer at once and refresh behind when older than 2 s (an event when the answer changed; offline → `cache.stale {offline: true}`; a 404 / 403 drops the entry). Everything else (members, requests, search, trash, Admin) asks the server. Writes drop the entries they change (folder counts included) and emit their event; offline they fail `offline`. `orgs.list` is `[]` signed out, and offline with nothing cached.
- **Inbox notices.** `NotificationsService.onOrg` hands on `{t: "org", orgId, what, teamId?, parentId?, projectId?}` (`OrgNotice`), and `onReconnect` fires when the socket opens again. `what` is `orgs`, `org`, `teams`, `team` (+teamId), `projects` (+teamId, parentId), `files` (+projectId; null: drafts), or an OrgEvent's own type (`teams.changed` …); the named entries are refreshed first, then one event goes out; an unknown `what` drops the org's cache. **1a: the server's notices should use these names.**
- **Files.** `FileMeta.space?: FileSpace | null` (`{orgId, key, teamId, projectId}`; optional so older records read as local). `WorkspaceModel`: Drafts, folders, Trash and search leave org copies out, Recents and Starred keep them; `moveFiles` refuses them (an org file moves within its org); `setFileSpace`. `multiplayer.openShared(key)` sets the copy's space from `GET /files/:key`'s `org` (§14.12); every listing fills `OrgFile.fileKey` with this installation's copy and moves the copy's space to where the server says. `projects.createFile` / `orgs.createDraft`: a room key, the local copy (space set from the start), then `MultiplayerService.shareTo` (register with `POST /projects/:id/files` or `/orgs/:org/drafts`, images, snapshot at seq 0, link); refused or offline, the copy is deleted again. `projects.moveLocalFile` = `shareTo` with `POST /files {key, name, orgId, projectId}` (a file shared outside orgs already: `POST /files/:key/move`); its answer's `file` is used, else the folder's list. `moveFiles` / `trashFiles` / `restoreFiles` call `/files/:key/move|trash|restore` one key at a time.
- **Prefs.** `Prefs.browse.space?: SpaceId` (absent: `"local"`), checked by `setBrowsePrefs`.
- **Contract gaps found** (not changed — `src/shared/org/` is frozen): `TeamSummary` / `ProjectInfo` carry no `orgId`, and `updateWorkspace(workspaceId)` / `updateBillingGroup(id)` / `deleteBillingGroup(id)` take no `orgId` while their routes are under `/orgs/:org/admin`: the store learns these from its listings and otherwise looks through the person's orgs. The billing-group routes' body keys aren't named in §14.12: the store reads `{billingGroups}` / `{billingGroup}` (or `groups` / `group`). `teams.leave` uses `DELETE /teams/:team/members/u:<me>`.
- **Not built**: starring an org file with no local copy (Starred holds local file keys), `FileMeta.editorType` beyond `design` (the server is told the editor type; the copy is a design file), a team name on Recents' cards (Home looks it up from `teams.list`).

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
- **Policies for the room** (round 4: cursor chat, audio, open sessions): `welcome` gains `policy: {cursorChat: boolean, audio: boolean}` from the org's settings, delivered on (re)connect. Contract: §15.9 (also the `{t: "policy"}` message for changes while open).

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
  - Round 4's idle timeout is per org (the shortest wins across the user's orgs, R18 A-6). It reads `sessions.active_at` (new in 0013: user activity only, not `last_seen_at`, which background requests move) — §15.8. It needs the app to report activity: a throttled `POST /me/sessions/active` once a minute while the user is active.
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

### 14.15 As built — round 1a, the server (2026-10-11)

`server/src/org/` (`http.ts` errors with `code` / ids / pages / CSV, `db.ts` the request-scoped `Access` resolver and shapes, `orgs.ts`, `teams.ts`, `projects.ts`, `groups.ts`, `admin.ts`, `reauth.ts`, `migrate.ts`), `server/src/activity.ts`, `server/migrations/0010_orgs.sql` (§14.5 verbatim), `src/shared/org/access.ts` (`resolveAccess`, `resolveContainer`, `seatCanEdit`, `seatNeeded`; the 22 cases and 7 more in `access.test.ts`). Every `/files/:key/…` route and the socket resolve with it; teams' and folders' routes resolve their containers the same way (an Inherited file with no rows of its own inside). Tests: `server/src/org/org.test.ts` (11 flows over every route group), and the store's org suite (`src/store/org/service.test.ts`) now runs against this handler (`src/store/org/fake/real.ts`; 1b's contract fake stays in `fake/server.ts`, unused).

Deviations and choices, explicit:
- **`viaLink`**: every `/files/:key/…` request counts as "by link" — the key is what the link carries; listings and search resolve with `viaLink: false` (so the org link never lists a file). Outside orgs the link applies as before (§3).
- **Trash**: a trashed file (or one in a trashed folder) resolves for its owner, editors and admins (§14.5), read-only (`canEdit` false, room `viewer`); viewers get 404.
- **Removed people** lose owner on their drafts (owner counts only while in the org); admins then reach them (`ownerInOrg: false` in `AccessRows`, an addition to §14.4's shape).
- **Expiry** stops the org link too; link-only callers get 410 `gone`. `GET /files/:key` shows `linkAccess: "none"` and `linkExpired: true` past it.
- **Inviting outside emails**: an *org admin's* invite (team, folder or file) adds the person as a **member** (the owner's "friends are members"); anyone else's makes a guest (Allow), a stored guest request answered in Admin (Require approval — enforced now, not in round 4), or 403 `guest_blocked` (Block). A held invite answers **202** `{requested: true, requestId}`.
- **Seats**: `seat_required` carries `seat` = the least seat that edits that kind of file (and `current` on creation). Files can't be created (drafts included) without a seat that edits their type. `manual_unless_available` approves at once (unlimited seats).
- **Names**: team names unique per org (409); groups too. Workspaces made with no `adminIds` get the creating admin.
- **`GET /files/:key`** adds `access` (FileAccess, null while a password is asked), `org` (`{id, orgId, name, teamId, teamName, projectId, path}`), `accessMode` (Inherited / Limited — `access` was taken), `editorType`, `orgLinkAccess`, `protoLinkAccess`, `linkExpiresAt`, `linkExpired`, `trashedAt`; `role` stays the room's role (after caps). `GET /files/:key/members` adds `groups`. `GET /files` adds `orgId`, `teamId`, `projectId`, `editorType` and leaves trashed org files out. `POST /files` with `orgId` answers `{key, name, role, file}`.
- **Who may**: file invites outside orgs stay owner-only (§3); in an org `canShare` (owners, editors) or `canManage`. Moving a file to drafts (`projectId: null`) is the owner's only. Unassigned drafts moved by an admin become the moving admin's (someone has to own them); into a team they get a folder named after the person.
- **`TeamSummary` / `ProjectSummary`** carry an extra `orgId` (asked by 1b). Workspaces and billing groups are only under `/orgs/:org/admin/…` (the store finds their org itself); billing-group answers are `{billingGroups}` / `{billingGroup}`.
- **Inbox notices** are `{t: "org", what, orgId?, teamId?, parentId?, projectId?}`, `what` ∈ orgs | org | teams | team | projects | files (1b's `OrgNotice`). Org notification kinds (`team_invite`, `project_invite`, `team_join_request`, `seat_request`, `seat_request_approved`, `seat_request_denied`, `guest_request`) are stored with `file_key` null and the team / folder / org name in `file_name`; they are typed server-side only (`OrgNotificationKind`) — `src/shared/notifications.ts NotificationKind` doesn't list them yet, so the bell must tolerate unknown kinds. Requests' tab and `pending` count the org request kinds. `GET /notifications?org=<id>|none&team=<id>` filters. A `g:<groupId>` @mention notifies the group's members who can open the file.
- **Activity**: written inline (no `ctx.waitUntil` in `Deps`), failures swallowed; retention swept when an org's log is read (no Cron Trigger — `index.ts` / `wrangler.jsonc` untouched). User groups have no Figma entity type: logged as `user` with id `g:<id>`; billing groups as `org` with id `bg:<id>`. `fig_file_view(_external|_prototype)` on the socket upgrade (`?m=proto` for Present), at most hourly per person per file. Sign-ins: `user_sign_in` per org at session issue; `user_sign_out` on `DELETE /me/sessions/:id`; `personal_access_token_create` / `_delete`. Not logged: a file's Inherited / Limited (no Figma action).
- **Reauth**: every room is told inline (no 500 cap / `waitUntil`); "a person removed" and seat / group changes re-check every file of the org for that user.
- **Create organization** runs as sequential statements, not one D1 batch (`D1Like` has none).
- **Account deletion (§14.7)**: refused (409) while the person is an org's only admin and others remain; otherwise removed from every org, their files outside orgs unshared as before, their org files kept; when org rows still name them, the `users` row stays as a tombstone ("Deleted user", no email, no Google account) for the foreign keys.
- **Sessions**: `org_members.last_active_at` moves on every authenticated session request (≤ every 5 min, one UPDATE); `POST /me/sessions/active` (the app's once-a-minute report) touches the session and Last active; sign-in claims pending org / team / folder invites for the email.
- Not built: round 4's policies beyond storage (public links off, passwords required, external restriction — `externalRestricted` is always false), the room's `welcome.policy`, thumbnails (`thumbnailUrl` null), `fig_file_duplicate` (no server route duplicates), team / folder join for guests.

## 15. Identity and security (contract, Phase 7 round 4; written 2026-10-11)

**Status: contract; server built in round 4a (§15.17) and 4b (§15.16), the store in 4c (§15.18).** Figma's Enterprise identity and security, on the server of §1–§14: SAML single sign-on per organization, the org's login method, JIT and SCIM provisioning, domains and domain capture, guest, sharing and external-content policies, the idle session timeout, the room switches (cursor chat, audio, open sessions) and data storage localization (EU). The research is `docs/research/figma/R18-enterprise.md` A-5, A-6; the SAML library choice is `server/spikes/saml/README.md` (round 1e). The plan: `docs/roadmap.md` Phase 7 "Round 4". The desktop side (sign-in, the idle prompt, MSI, deployment keys) is `docs/desktop.md` §12.5 and §18.

Facts about Figma below were read on help.figma.com, developers.figma.com and Cloudflare's docs on 2026-10-11:
- **[F-auth]** Authentication method — https://help.figma.com/hc/en-us/articles/360052497994
- **[F-saml]** Guide to SAML SSO — https://help.figma.com/hc/en-us/articles/360040532333
- **[F-okta]** SAML with Okta (start URL, IdP-initiated) — https://help.figma.com/hc/en-us/articles/360040532353
- **[F-adfs]** SAML with AD FS (SP Entity ID, SP ACS URL, the three IdP values) — https://help.figma.com/hc/en-us/articles/360048269533
- **[F-login]** Log in with SSO ("Use single sign-on") — https://help.figma.com/hc/en-us/articles/360040047614 (read through a search summary, not opened)
- **[F-scim]** SCIM provisioning — https://help.figma.com/hc/en-us/articles/360048514653 ; seats via SCIM — https://help.figma.com/hc/en-us/articles/360048787534
- **[F-scim-api]** SCIM API — https://developers.figma.com/docs/rest-api/scim/ , endpoints https://developers.figma.com/docs/rest-api/scim-endpoints/ , schemas https://developers.figma.com/docs/rest-api/scim-supported-schemas/
- **[F-domain]** Domains and domain capture — https://help.figma.com/hc/en-us/articles/360045953273
- **[F-guestctl]** Guest access controls — https://help.figma.com/hc/en-us/articles/4410793238167
- **[F-share]** Public sharing settings — https://help.figma.com/hc/en-us/articles/5726756336791
- **[F-external]** External content controls — https://help.figma.com/hc/en-us/articles/12080587805719
- **[F-idle]** Idle session timeout — https://help.figma.com/hc/en-us/articles/14376092335127
- **[F-chat]** Disable cursor chat — https://help.figma.com/hc/en-us/articles/14564080039447 ; **[F-audio]** Audio — https://help.figma.com/hc/en-us/articles/4420953557399
- **[F-region]** Data storage localization — https://help.figma.com/hc/en-us/articles/15643274574871
- **[F-log]** Activity log action types — https://developers.figma.com/docs/rest-api/activity-logs-action-types/ ; entity types — https://developers.figma.com/docs/rest-api/activity-logs-entity-types/
- **[CF-do]** Durable Objects data location — https://developers.cloudflare.com/durable-objects/reference/data-location/ ; **[CF-d1]** D1 data location — https://developers.cloudflare.com/d1/configuration/data-location/

**(ours)** marks a choice Figma doesn't document or where we differ on purpose; **(unverified)** a Figma fact we could not open.

### 15.1 What Figma does (the facts this section implements)

- **Login method** [F-auth]: Admin › Settings › Login and provisioning › **Authentication**, one of "Members may log in with any method, including email and password (default)", "Members must log in with a Google account", "Members must log in with SAML SSO". It applies to **members** only: "Guests can always log in with Google SSO or email and password". To change the SAML configuration admins first go back to any method "to avoid lockouts". A change takes effect at each member's **next login**. (Newer articles place the same rows under Settings › **Access › Authentication**; the section name is the one Figma shows today — check live before building the label.)
- **SAML** [F-saml, F-okta, F-adfs]: SAML 2.0; Figma gives the **SP Entity ID** `https://www.figma.com/saml/<Tenant ID>` and **SP ACS URL** `…/<Tenant ID>/consume`; admins give the **IdP Entity Id**, the **IdP SSO Target URL** and the **Signing Certificate**, or (Okta, Entra) the IdP metadata URL; NameID format Email; attributes used: username or NameID, `givenName`, `familyName`, `displayName`, `title` ("Other attributes are ignored"). Both **SP-initiated** (Figma's login page › "Use single sign-on" › work email › Log in; or `https://www.figma.com/saml/<Tenant ID>/start`) and **IdP-initiated** (an Okta tile) are supported. **JIT** creates and updates people from the assertion's attributes at each login. "Email aliases do not work with SAML SSO." On an **unverified** domain Figma emails a 6-digit code at the first SSO login on each device; verifying the domain removes it.
- **SCIM** [F-scim, F-scim-api]: `https://www.figma.com/scim/v2/<Tenant ID>`, `Authorization: Bearer <token>`; the token is made in Settings › SCIM provisioning › **Generate API token** and shown once; SCIM requires SAML; it manages members, never guests. Endpoints: `GET /ServiceProviderConfig`, `GET /` (tenant check), `GET|POST /Users`, `PUT|PATCH|DELETE /Users/:figmaUserId`, the same for `/Groups`. Filters: Users by `userName` or `externalId`, Groups by `displayName` or `externalId`, `eq` only; `startIndex` / `count`. Schemas: core User (`userName` = the email, ≤ 100, changing it changes the account's email; `name.givenName`, `name.familyName`, `displayName` ≤ 100, `title`, `active` — false removes the person from the org, `externalId` ≤ 255 stored not used, `roles` = `[{type: "seatType", value: "Full" | "Dev" | "Collab" | "View"}]` on Enterprise), the enterprise extension (`employeeNumber`, `costCenter`, `organization`, `division`, `department`, `manager.value`, `manager.displayName`), Figma's extension `urn:ietf:params:scim:schemas:extension:figma:enterprise:2.0:User` with `figmaAdmin: boolean`. Groups: `displayName` ≤ 255, `members [{value, display}]`, `externalId`; a group whose `displayName` equals (case-sensitive) a **workspace** or **billing group** name links to it — its members join it, removed members leave it; groups also become **user groups** [F-scim]. `DELETE /Users/:id` "permanently deletes the user from Figma". Seats set by SCIM bypass seat approval.
- **Domains** [F-domain]: Admin › Settings › Login and provisioning › **Manage domains** › **+ Domain**; a new domain is **Unverified**; verification is a TXT record with Figma's snippet (format unpublished); each subdomain separately. Unverified domains still make invitees **members**. **Domain capture** (toggle on the Manage domains banner; every domain must be verified first): existing accounts on the domains join at once as members with a **View** seat and an email; new sign-ups join automatically; a domain used by another org can't be added once capture is on; turning capture off goes through Support. **Remove** a domain: its members become guests; an admin can't remove their own domain.
- **Guest membership** [F-guestctl] (Settings › Access › Guest access): "External users can join the organization without restrictions" (default; a confirmation with Cancel / Share before inviting an outside email), "External users can only join the organization with admin approval" (the inviter is told; the guest may "Ask to be added"; requests go to the workspace admin, or an org admin outside workspaces; only the first invite needs approval), "No external users can join your organization" (the inviter is told guest access is disabled; the invite isn't sent). Already enforced since round 1a (§14.15); round 4 adds the wording and workspace admins as approvers.
- **Public sharing** [F-share] (Settings › Content › Sharing and publishing › **Public sharing**): **Public link sharing** off makes every org file private (members and invited people keep access; inviting still works); **Require passwords** removes "Anyone with the link" without a password; **Password protection options › Autogenerated passwords only** (four random words); **Require design file links to expire** with a maximum of **1 hour to 31 days** (links turn private after it; this also turns public links off in FigJam); **Custom settings for workspaces** (override passwords / expiry / public links for files in that workspace's teams; drafts and unassigned teams use the org's); **FigJam open sessions** org-wide only.
- **Access to external content** [F-external] (Settings › Content › Content access; needs domain capture; allowed by default): restricted members can't create files or folders outside the org, edit their own outside files, edit or comment on files shared from outside, or accept outside invites; open sessions, public and password-protected files open view-only; their drafts elsewhere become view-only; drafts inside the org are untouched.
- **Idle session timeout** [F-idle] (Settings › Access › Authentication › Idle session timeout › **Custom timeout**): default **21 days** of inactivity, custom **12 hours to 14 days**; members only, not guests; logs out on every platform; a prompt to stay logged in when less than **one minute** remains; across orgs the **shortest** wins; a new value **resets** everyone's inactivity; each timeout logout and each change is logged (a background timeout when the person next opens Figma).
- **Communication** [F-chat]: Settings › Communication › **Cursor chat** toggle (Enterprise): off, nobody starts a cursor chat in Design or FigJam files. **Audio** [F-audio]: Settings › Other › **Audio** toggle (Organization and Enterprise): off, members and guests can't use audio in the org's files.
- **Data storage localization** [F-region] (Settings › Data, read-only; changed by Figma Support): file content **at rest** — shapes, text, stickies, frames, components, images, video — in the chosen region (EU among others); **not** localized: comments, file names, fonts, thumbnails, plugins, Dev Mode code, AI chats, metadata, activity and security logs, search indexes, the file edits journal, user profiles, publicly published files. New edits may sit in the US up to 30 days before moving.

### 15.2 Decisions (ours, where Figma is silent or we differ)

1. **Library**: `@node-saml/node-saml` 5.1.0 exactly, `@xmldom/xmldom` ≥ 0.8.15, `xml-crypto` ≥ 6.3.3, under `nodejs_compat`, wrapped by our SP layer with the spike's extra checks (§15.3.4). The spike's 29 cases move into `server/src/auth/saml/saml.test.ts` and stay the gate for every bump.
2. **Figma's URL shapes**: SP entity id `<origin>/saml/<tenantId>` (that URL also serves the SP metadata), ACS `<origin>/saml/<tenantId>/consume`, start `<origin>/saml/<tenantId>/start`. The spike's `/metadata`, `/login`, `/acs` are renamed. **Tenant ids** are 18 random decimal digits, Figma's shape.
3. **IdP-initiated sign-in is accepted by bouncing**: an unsolicited Response (no `InResponseTo`) is verified like any other (signature, issuer, audience, recipient, time, replay) but **never** turned into a session — the desktop app has no loopback waiting and a code without a PKCE challenge could be stolen through the URL scheme. The ACS answers a page "Continue to DesignerV2" whose button opens `designerv2://sign-in?tenant=<id>` (desktop) or `/auth/login?return=<web origin>&tenant=<id>` (web), which starts a normal SP-initiated flow; the IdP session is fresh, so the person sees no second login. `validateInResponseTo` stays `always` for the session path. Figma lands IdP-initiated logins directly; the visible difference is one click.
4. **SAML only for verified domains**: we can't send Figma's 6-digit email code (the server sends no email), so an assertion is accepted only when its email's domain is a **verified** domain of that org. Otherwise the ACS refuses ("‹email› isn't on a verified domain of ‹org›", code `sso_domain`). Unverified domains still make invitees members (Figma's rule). This also makes SSO routing by email domain unambiguous.
5. **One account per email, linked across methods**: `users.google_sub` stays `NOT NULL UNIQUE`; an account made by SAML JIT or SCIM gets the placeholder `none:<userId>`. A Google sign-in whose `sub` is unknown claims the most recently seen `none:` account with the same verified email (Google proved the email). A SAML sign-in matches by email. Two `google_sub` accounts with one email (two Google identities) are matched to the most recently seen one.
6. **Login method is checked at sign-in only**, as Figma ("at their next login"): sessions issued before a change keep working until they end. A Google sign-in by a **member** of an org that requires SAML doesn't get a code: the browser goes on to that org's SAML start with the same app state (so the app's loopback still completes). A SAML sign-in into an org that requires Google is refused (`google_required`). Guests are never checked. A person who is a member of two orgs with different requirements: the org they joined first decides (rare: a domain belongs to one org).
7. **No lockout**: `authMethod: "saml"` is refused (409 `invalid`, "Test SAML SSO first") until the org's IdP configuration has a successful sign-in (`idp_configs.tested_at`), and the IdP configuration can't be deleted while it is required. There is **no** admin bypass (Figma documents none); the owner's last resort is a D1 update by hand (§15.13).
8. **SCIM tokens**: one live token per org; **Generate API token** revokes the previous one (Figma shows one, unverified whether it revokes). `DELETE /Users/:id` removes the person from the org and drops the SCIM link but **never deletes the account** (Figma deletes the user; ours may be in other orgs and files).
9. **A verified domain belongs to one org**, capture or not (Figma: only once capture is on) — needed for routing (decision 4).
10. **Domain verification** record: TXT `designerv2-domain-verification=<token>` (Figma's format is unpublished), at the domain itself, checked over DNS-over-HTTPS from the Worker. Turning capture **off** is allowed to admins (Figma: Support; the owner is the support).
11. **Idle activity** is user input in the app (pointer, keys, wheel), reported at most once a minute — not background requests (sockets, polls), which would keep a forgotten session alive. Orgs that set nothing still give their members Figma's default **21 days**; people in no org keep the session token's 30 days.
12. **Room switches** (cursor chat, audio) are enforced by the clients: the room relays presence and signals without reading them (§4, §11). The room carries the policy (`welcome.policy`, `policy` messages) so a change reaches open files at once.
13. **Data storage localization is self-serve** for org admins (Figma: Support) and moves existing files with a resumable job (§15.10). Only the **EU** region (Cloudflare's `eu` jurisdiction) is offered; D1 stays where it is (EEUR location hint, no jurisdiction — it can't be added to an existing database [CF-d1]), which matches what Figma doesn't localize (names, comments, metadata, logs).
14. **Desktop deployment keys** use Figma's names; the macOS domain is our appId `net.burakkoc.designer` (electron-builder.yml) and the Windows key `HKLM\SOFTWARE\DesignerV2` (docs/desktop.md §12.5).

### 15.3 SAML: the service provider per org

#### 15.3.1 Configuration (`idp_configs`, one per org)

| Field | From | Notes |
|---|---|---|
| `tenant_id` | made when the config is first saved | 18 digits, unique; never changes |
| `provider` | the admin's choice | `okta` · `entra` · `onelogin` · `google` · `custom` (labels: Okta, Microsoft Entra ID, OneLogin, Google Workspace, Other) — only the help text and the defaults differ |
| `idp_entity_id`, `sso_url`, `certificates` | the metadata (URL fetched by the Worker over HTTPS, ≤ 256 KiB, no DOCTYPE; or the XML pasted) or the three values by hand | `sso_url`: the `SingleSignOnService` with the HTTP-Redirect binding; `certificates`: every `KeyDescriptor` with `use="signing"` or no `use`, ≤ 2 (rotation), PEM; each parsed (`crypto.X509Certificate` under `nodejs_compat`) and refused if not RSA ≥ 2048 or already expired |
| `signing` | default `assertion` | `assertion`: the assertion must be signed (Okta, Entra default). `assertion_or_response`: a signed Response envelope is enough (AD FS / Entra set to "Sign SAML response") — XSW cases of the spike then are the defence |
| `metadata_url` | optional | kept to re-fetch on **Refresh metadata** (no automatic refresh) |
| `tested_at` | the first successful sign-in through it | needed before `authMethod: "saml"` (decision 7) |

#### 15.3.2 SP metadata — `GET /saml/:tenantId`

`application/samlmetadata+xml`: `EntityDescriptor entityID="<origin>/saml/<tenantId>"`, `SPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol" AuthnRequestsSigned="false" WantAssertionsSigned="true|false (signing)"`, `NameIDFormat urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress`, `AssertionConsumerService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="<origin>/saml/<tenantId>/consume" index="0" isDefault="true"`. No signing or encryption key of ours (AuthnRequests are unsigned; encrypted assertions are not accepted in round 4 — spike risk 6). `<origin>` is the Worker's public origin (`https://designer.burak-kc-sp.workers.dev`), from `url.origin`.

#### 15.3.3 AuthnRequest — `GET /saml/:tenantId/start?st=<state token>`

- `st` is the signed `oauthState` of §2 (`{p | r, s, c, exp}`), made by `/auth/login` (§15.4). Without `st` (someone typed Figma's start URL into a browser): a page "Log in to DesignerV2 from the app" with a button `designerv2://sign-in?tenant=<id>` and, when `WEB_ORIGINS` is set, a link to the web app.
- Insert `saml_requests(id, org_id, state, expires_at = now + 10 min)` — `id` = `_` + 32 hex (the AuthnRequest's `ID`), `state` = the decoded `st` payload as JSON. In the same batch: `DELETE FROM saml_requests WHERE expires_at < now` (no cron needed).
- Redirect (302) to `sso_url` with the HTTP-Redirect binding: `SAMLRequest` = base64(deflate(AuthnRequest)), **`RelayState` = the request id** (SAML caps RelayState at 80 bytes; the signed state is longer). AuthnRequest: `ID`, `Version="2.0"`, `IssueInstant`, `Destination=sso_url`, `AssertionConsumerServiceURL=<ACS>`, `ProtocolBinding=HTTP-POST`, `Issuer=<SP entity id>`, `NameIDPolicy Format=emailAddress AllowCreate="true"`. Unsigned (node-saml `generateAuthorizeRequestAsync` with no private key).

#### 15.3.4 The ACS — `POST /saml/:tenantId/consume`

In this order; any failure answers a 403 page "Single sign-on didn't work. Try again from DesignerV2." (the reason only in the log line and, for the app, as `error=sso_failed` on the loopback when the request id is known):
1. Body ≤ 256 KiB, `application/x-www-form-urlencoded`, a `SAMLResponse`; its base64-decoded XML contains no `<!DOCTYPE` — before any parsing.
2. The tenant's config; node-saml `validatePostResponseAsync` with `idpCert` = the config's certificates, `idpIssuer`, `audience` = SP entity id, `wantAssertionsSigned` = (`signing == "assertion"`), `wantAuthnResponseSigned: false`, `validateInResponseTo: "always"` (or `"never"` on the bounce path, step 4), `acceptedClockSkewMs: 60_000`, `maxAssertionAgeMs: 300_000`, our `CacheProvider` (below), never the in-memory one.
3. **Our checks on the verified XML only** (`profile.getAssertionXml()`), as the spike: the assertion's `Issuer` is `idp_entity_id`; exactly one bearer `SubjectConfirmation` whose `Recipient` is our ACS; the Response's `Destination`, when present, is our ACS; **algorithms**: the verified `SignatureMethod` is one of `rsa-sha256`, `rsa-sha384`, `rsa-sha512` (`http://www.w3.org/2001/04/xmldsig-more#…`) and every `DigestMethod` one of `xmlenc#sha256`, `xmldsig-more#sha384`, `xmlenc#sha512` — **SHA-1 is refused** (`rsa-sha1`, `xmldsig#sha1`), for the assertion's and the Response's signature alike; an `EncryptedAssertion` is refused.
4. **InResponseTo**: present (inside the signed `SubjectConfirmationData`) → `DELETE FROM saml_requests WHERE id = ?1 AND org_id = ?2 AND expires_at > ?now RETURNING state` — **atomic consume**: the second of two concurrent posts finds nothing and fails. Absent → **unsolicited** (IdP-initiated): after steps 1–3 (with `validateInResponseTo: "never"`), answer the bounce page of decision 3 and stop — no session, no account change.
5. **Replay**: `INSERT INTO saml_assertions (id, org_id, expires_at) VALUES (<assertion ID>, ?, <SubjectConfirmationData NotOnOrAfter, else Conditions NotOnOrAfter, else now + 5 min>)` — a primary-key conflict is a replay (refused). Expired rows are deleted in the same batch. node-saml's `CacheProvider` is backed by `saml_requests` (`saveAsync` no-op — we insert at start —, `getAsync` = a SELECT of the unexpired row, `removeAsync` no-op — step 4 consumes); the atomic DELETE is the real check.
6. **Email**: the NameID when its Format is `emailAddress` or `unspecified` and it parses as an email (§15.12 `normalizeEmail`); else the first of the attributes `email`, `emailaddress`, `http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress`, `username`; else refused. Its domain must be a **verified** domain of this org (decision 4; `sso_domain`).
7. **Person** (one D1 batch where possible):
   - The account: `users` by email (most recent `last_seen_at`), else a new one (`google_sub = 'none:' || id`). Name from `displayName`, else `givenName familyName` (unless `name_locked`); `title` into `org_members.idp_attributes.title`.
   - A **SCIM-deactivated** person (`scim_users.active = 0` in this org) is refused ("Your account was deactivated by your organization").
   - Not in the org → **JIT**: `org_members` row `role 'member'`, seat `settings.defaultSeat`, `provisioned_by 'jit'`; logs `org_user_create` with `details.jit: true`; then the org's workspace default teams (§14.1). A guest → becomes a member (their email is on a verified domain); logs `org_user_permission_change`.
   - `settings.authMethod == "google"` → refused (`google_required`).
8. **Session**: the request's `state` decides where the code goes, exactly as `/auth/callback` (§2 step 3): a sign-in code (2 minutes, bound to the challenge) stored with `auth_codes`, plus `auth_codes.auth = 'saml'` and `org_id`, so `/auth/token` makes a session with `sessions.auth_method = 'saml'`, `sessions.auth_org_id`. Redirect to `http://127.0.0.1:<p>/callback?code&state` or the web page's `auth_code`. `idp_configs.tested_at` is set if null. `user_sign_in` is logged with `details: {method: "saml"}` (§15.11).

#### 15.3.5 What can't be verified without a real IdP

The spike's suite signs Responses with a test IdP in Node (`test/idp.ts`). Not covered until the owner creates accounts: Okta (free developer org, developer.okta.com), Microsoft Entra ID (a free Entra tenant or the Microsoft 365 developer program), Google Workspace (paid) — their metadata, attribute names, which element they sign, Entra's `assertion_or_response` path, AD FS's SHA-1 default (we refuse it: an AD FS admin must pick SHA-256). Each needs the Worker reachable from the internet (a deploy, or `wrangler dev --remote`/a tunnel) because the IdP posts to our ACS.

### 15.4 Signing in: routing by email domain, the login page, the desktop loopback

- **`GET /auth/login`** (§2 step 1, same parameters: `port` | `return`, `state`, `challenge`) now answers **Figma's login page** (HTML, the Worker's own, `server/src/auth/pages.ts`) instead of redirecting at once: "Log in to DesignerV2", **Continue with Google**, a divider, **Use single sign-on**. The page carries the signed state (`st`, made here exactly as `login()` makes it today). Optional parameters:
  - `method=google` → straight to Google (today's behaviour; the web app's "Continue with Google" button and tests use it).
  - `tenant=<id>` → straight to `/saml/<id>/start?st=…` (the bounce of decision 3, the desktop's `designerv2://sign-in?tenant=`).
- **Use single sign-on** shows an **Email** field and **Log in** (Figma's [F-login]; the page's exact other words are ours, unverified). It posts the form `POST /auth/sso` (`application/x-www-form-urlencoded`: `email`, `st`). The Worker takes the email's domain (§15.12 `emailDomain`), finds the **verified** `org_domains` row and that org's `idp_configs`; found → 302 `/saml/<tenantId>/start?st=…`; not found → the page again with "Single sign-on isn't set up for this email." The email never travels in a URL.
- **`POST /auth/sso` with `application/json`** `{email}` → `200 {tenantId, orgName}` or `404 {error, code: "sso_not_found"}` — for the web app and tests.
- **Google** (`/auth/callback`, §2 step 3), after Google's checks, in this order:
  1. the account: by `google_sub`; else claim a `none:` account with that verified email (decision 5); else a new one;
  2. pending invites (`claimInvites`, as today);
  3. **domain capture** (§15.7): the email's domain verified with capture on in an org → added as a member if not in it;
  4. **login method**: if the account is a **member** (role admin or member) of an org whose `authMethod` is `saml` and which has an IdP config → no code; insert a `saml_requests` row with this flow's app state and redirect to that org's AuthnRequest (§15.3.3 without `st`); the loopback receives the code from the ACS instead;
  5. otherwise the code, with `auth_codes.auth = 'google'`.
- **The desktop app** keeps §2's loopback and PKCE unchanged: it opens `/auth/login?port&state&challenge` and receives `code` on `http://127.0.0.1:<port>/callback` whichever method the person chose in the browser; `/auth/token` is unchanged. New for main (docs/desktop.md §18): the `designerv2://sign-in?tenant=<id>` deep link starts a sign-in with `&tenant=<id>`; errors `sso_failed`, `sso_domain`, `google_required` arriving as `error=` on the loopback are shown with their messages (§15.12 `SIGN_IN_ERROR_TEXT`).
- **`POST /auth/dev`** (local only) is unaffected by every policy and makes `auth_method 'dev'` sessions.

### 15.5 SCIM 2.0 — `/scim/v2/:tenantId/…`

**Auth**: `Authorization: Bearer <token>`; the token is `dsgn_scim_` + 32 random bytes base64url; only its SHA-256 is stored (`scim_tokens`); its org must own `:tenantId`; a revoked token or a wrong tenant → 401. Every answer is `application/scim+json`. Errors are RFC 7644's: `{"schemas": ["urn:ietf:params:scim:api:messages:2.0:Error"], "status": "<code as string>", "scimType"?: "uniqueness" | "invalidFilter" | "invalidValue" | "invalidPath" | "mutability" | "noTarget", "detail": "<text>"}`. `last_used_at` moves at most once a minute.

| Route | Answer |
|---|---|
| `GET /scim/v2/:tenantId` | 200 `{}` (Figma's tenant check; 400 for an unknown tenant without a token) |
| `GET …/ServiceProviderConfig` | `patch {supported: true}`, `bulk {supported: false, maxOperations: 0, maxPayloadSize: 0}`, `filter {supported: true, maxResults: 200}`, `changePassword`, `sort`, `etag` `{supported: false}`, `authenticationSchemes [{type: "oauthbearertoken", name: "OAuth Bearer Token", primary: true}]` |
| `GET …/Schemas`, `GET …/ResourceTypes` | the three User schemas and the Group schema; resource types User (`/Users`, extensions enterprise + figma) and Group (`/Groups`) — RFC 7643 §6–§7 shapes |
| `GET …/Users?filter=&startIndex=&count=` | ListResponse; filter `userName eq "…"` or `externalId eq "…"` only (else 400 `invalidFilter`); `count` ≤ 200 (Figma allows 3,000; our D1 pages are small), `startIndex` 1-based |
| `GET …/Users/:id` | the User |
| `POST …/Users` | 201 the User (below); an existing SCIM link for that `userName` in this org → 409 `uniqueness` |
| `PUT …/Users/:id` | replaces every attribute it carries; absent optional ones are cleared |
| `PATCH …/Users/:id` | PatchOp (below) |
| `DELETE …/Users/:id` | 204: removed from the org (§14.7), SCIM link deleted; the account stays (decision 8) |
| `GET/POST …/Groups`, `GET/PUT/PATCH/DELETE …/Groups/:id` | as Users; filter `displayName eq` / `externalId eq` |

**User resource** (`id` = our `users.id`, Figma's `figmaUserId`):

```json
{
  "schemas": ["urn:ietf:params:scim:schemas:core:2.0:User", "urn:ietf:params:scim:schemas:extension:enterprise:2.0:User", "urn:ietf:params:scim:schemas:extension:figma:enterprise:2.0:User"],
  "id": "u_…", "externalId": "00u1…", "userName": "eve@acme.com",
  "name": { "givenName": "Eve", "familyName": "Adams" }, "displayName": "Eve Adams", "title": "Design Manager",
  "emails": [{ "value": "eve@acme.com", "primary": true, "type": "work" }],
  "active": true,
  "roles": [{ "type": "seatType", "value": "Full", "primary": true }],
  "urn:ietf:params:scim:schemas:extension:enterprise:2.0:User": { "employeeNumber": "…", "costCenter": "…", "organization": "…", "division": "…", "department": "…", "manager": { "value": "…", "displayName": "…" } },
  "urn:ietf:params:scim:schemas:extension:figma:enterprise:2.0:User": { "figmaAdmin": false },
  "meta": { "resourceType": "User", "created": "<ISO>", "lastModified": "<ISO>", "location": "<origin>/scim/v2/<tenant>/Users/u_…" }
}
```

- **Create**: `userName` is the email (normalized; ≤ 100). The account by email, else a new one (`none:` placeholder). Any domain is accepted (the IdP is the admin's), but only verified domains can then use SAML (decision 4) — others sign in with Google when the method allows. The membership: `role` = `figmaAdmin ? 'admin' : 'member'` (an existing admin stays admin unless `figmaAdmin: false` is sent), seat = the `seatType` role (`Full` → `full` …) else `settings.defaultSeat`, `provisioned_by 'scim'`, `idp_attributes` = title, `externalId` and the enterprise attributes. A seat set here bypasses seat approval [F-scim]. Logs `idp_user_create` (entity `idp_user`, §15.11). `active: false` on create → the link only, no membership.
- **Changes**: `userName` changes the account's email (Figma) — refused with 409 `uniqueness` when another account has that email; the person's Google sign-in then claims by `sub` as before. `active` false → removed from the org (§14.7: grants, groups, sockets, drafts to Unassigned), the link kept with `active = 0` (`idp_user_deactivate`); true → back as member with the link's seat (`idp_user_activate`). A seat change logs `idp_user_update` and `org_user_account_type_change`; `figmaAdmin` logs `org_user_permission_change`. Guests are never touched: a SCIM user who is a guest becomes a member.
- **PatchOp** (`urn:ietf:params:scim:api:messages:2.0:PatchOp`, `Operations[]`): `op` `add` | `replace` | `remove`, case-insensitive (Entra sends `Replace`); `value` strings `"True"`/`"False"` accepted for booleans (Entra). Paths: `active`, `userName`, `displayName`, `title`, `externalId`, `name.givenName`, `name.familyName`, `roles` (whole list), `roles[type eq "seatType"].value`, `emails[type eq "work"].value` (= userName), `urn:ietf:params:scim:schemas:extension:enterprise:2.0:User:<attr>` (and `:manager.value`, `:manager.displayName`), `urn:ietf:params:scim:schemas:extension:figma:enterprise:2.0:User:figmaAdmin`; no `path` → `value` is an object of those attributes (Okta's and Entra's form). Anything else → 400 `invalidPath`. Groups: `displayName` replace; `members` add (`value: [{value}]`), remove with `path: members[value eq "u_…"]` or `members` + value list, replace (whole list).
- **Groups** (`scim_groups`, members in `scim_group_members`; Figma [F-scim-api]): on create and on every `displayName` change the group links, in order, to the org's **workspace** with exactly that name, else its **billing group** with that name, else a **user group** (§14.1) created with `external: true` (`user_groups.external_id` = the SCIM group id; `created_by` = the token's creator) — Figma: SCIM groups serve "workspaces, billing groups, and user groups" [F-scim]. Members then get: the workspace (`org_members.workspace_id`, and its default teams), the billing group (`billing_group_id`), or the user group's membership. A removed member loses it only if it still is that value. Unlinking (rename, delete) clears it the same way. Logs: `idp_group_create`, `idp_group_rename`, `idp_group_delete`, `idp_group_connection_add` / `_remove` (workspace or billing group). A user group made by SCIM can't be edited in Admin (its membership is the IdP's; `UserGroup.external` true, §14.13).
- **Not supported**: `/Bulk`, `/Me`, sorting, ETags, `attributes=` / `excludedAttributes=` (ignored), filters other than `eq` on the listed attributes, groups of groups.

### 15.6 Policies: `OrgSettings` and where each is enforced

`OrgSettings` gains six fields (§15.12, committed verbatim); the round-1 ones keep their names. `PATCH /orgs/:org/admin/settings` validates and logs each (§15.11).

| Field | Values (default) | Figma's row | Enforced in |
|---|---|---|---|
| `authMethod` | `"any"` · `"google"` · `"saml"` (`"any"`) | Authentication | sign-in only (§15.4, §15.3.4 step 7); `saml` needs `tested_at` (409); clients: nothing |
| `idleSessionTimeoutHours` | `null` (= 504, Figma's 21 days) or 12…336 | Idle session timeout › Custom timeout | `authenticate` (§15.8); a change resets the org's people's `active_at`; main's prompt (desktop.md §18) |
| `domainCapture` | `false` | Manage domains › Domain capture | needs ≥ 1 domain, all verified (409 `domain_unverified`); turning on captures existing accounts (§15.7); sign-in captures new ones |
| `externalContent` | `"allowed"` · `"restricted"` (`"allowed"`) | Content access › Access to external content | needs `domainCapture` (409); `resolveAccess` cap `external` (§15.9); `POST /files` without `orgId`, `POST /orgs`, `POST /orgs/:other/drafts`, `POST /teams/:t/join` and invite claiming outside the home org → 403 `external_restricted`; clients: Home hides "+ Create" in other spaces, the editor shows the view-only banner "Your organization only allows you to view this file" (ours, unverified wording) |
| `passwordMode` | `"any"` · `"autogenerated"` (`"any"`) | Password protection options › Autogenerated passwords only | `PATCH /files/:key {linkPassword}` refuses one that isn't `isGeneratedPassword` (400 `password_policy`); ShareDialog hides the field and keeps **Generate** |
| `openSessions` | `true` | FigJam open sessions | stored; enforced when FigJam's open sessions exist (round 9) |
| `publicLinks` (round 1) | `true` | Public link sharing | `filePolicy` (§15.12): off → `PATCH {linkAccess ≠ none}` and `{protoLinkAccess ≠ none}` 403 `public_links_off`; `resolveAccess` step 4 ignores `link_access` / `proto_link_access` of org files; `/embed/<key>` refuses; `org_link_access` keeps working; the Share dialog shows only "Anyone at ‹org›" and invited people |
| `passwordRequired` (round 1) | `false` | Require passwords | `PATCH {linkAccess ≠ none}` on a file with no password → 400 `password_policy`; removing the password of a file with a public link → 400; `resolveAccess` step 4 treats a public link **without** a password as off |
| `linkExpiryMaxHours` (round 1) | `null` or **1…744** (31 days; round 1 allowed a year — narrowed) | Require design file links to expire | `PATCH {linkAccess ≠ none}` needs `linkExpiresAt` ≤ now + max (400 `link_expiry_policy`); turning it on or lowering it sets `link_expires_at = min(link_expires_at, now + max)` on every org file with a public link (one UPDATE); FigJam files: public links off (`filePolicy`) |
| `guestMembership` (round 1) | as built (§14.15) | Guest membership | as built; plus workspace admins answer guest requests for resources in their workspaces [F-guestctl]; members' invites of emails on **any** of the org's domains (verified or not) make **members**, not guests [F-domain] |
| `cursorChat` (round 1) | `true` | Communication › Cursor chat | `welcome.policy` / `policy` message (§15.9); the editor: `/` doesn't open cursor chat, chat bubbles of others aren't drawn |
| `audio` (round 1) | `true` | Other › Audio | same; the editor hides Start conversation and leaves an ongoing one |

**Per-workspace sharing** [F-share]: `workspaces.settings` (§14.5, until now `{}`) holds `WorkspaceSharingSettings` `{publicLinks?, passwordRequired?, linkExpiryMaxHours?}` — each present key overrides the org's for files in teams of that workspace (drafts and teams outside workspaces use the org's). `PATCH admin/workspaces/:id {sharing: WorkspaceSharingSettings | null}`; `OrgWorkspace.sharing`. Logs `workspace_public_link_setting_change`. The effective policy of a file is `filePolicy(settings, workspaceSharing, editorType)` (§15.12), computed by the Worker and returned by `GET /files/:key` as `policy` (null outside orgs).

**Existing links when a policy tightens** (Figma doesn't say, ours): public links off or passwords required → nothing is rewritten (the files' own settings come back if the policy is relaxed); `resolveAccess` and `/embed` read the policy. Expiry → `link_expires_at` is clamped (above). In every case the Worker reauths the org's rooms for link-only people (`POST /room/revoke-link` to each org file with a public link).

### 15.7 Domains and capture

- **Rows**: `org_domains(org_id, domain, token, created_at, created_by, verified_at)`; a **verified** domain is unique across orgs (decision 9: partial unique index).
- **Add**: `POST /orgs/:org/admin/domains {domain}` → `normalizeDomain` (§15.12: lower case, no scheme / path / port / trailing dot, a valid hostname with a dot, ≤ 253) else 400; verified elsewhere → 409 `domain_taken`; `{domain: OrgDomain}` with `txtRecord` = `designerv2-domain-verification=<token>` (token 32 hex). Logs `org_domain_add`.
- **Verify**: `POST admin/domains/:domain/verify` → `fetch("https://cloudflare-dns.com/dns-query?name=<domain>&type=TXT", {headers: {accept: "application/dns-json"}})`; `Status == 0`; the TXT `Answer` records (`type == 16`), each `data` un-quoted with its quoted strings joined (`"a" "b"` → `ab`), compared exactly with the record. Found → `verified_at = now`, logs `org_domain_verify`; not found → 409 `domain_unverified` `{found: string[]}` (the TXT values seen, so the dialog can show them). DNS propagation is the admin's wait; there is no background re-check. DoH failure → 503.
- **Remove**: `DELETE admin/domains/:domain` → refused for the domain of the caller's own email (409); members whose email is on it (and on no other domain of the org) become **guests** (`org_members.role`, reauth); logs `org_domain_remove`. Capture stays on only while ≥ 1 verified domain remains (else turned off and `org_domain_capture_change` logged).
- **Capture on** (`PATCH admin/settings {domainCapture: true}`): every account whose email is on a verified domain and who isn't in the org is added as a **member, View seat** [F-domain] (`org_members`, `invited_by` null, `details.domain_capture: true` on `org_user_create`) and gets a notification `org_domain_captured` (§12; wording ours: "You were added to ‹org›"); guests on those domains become members. From then on `/auth/callback` and the ACS capture at sign-in. Off: nothing is undone.
- **"Manage domain"** list [F-domain]: `GET admin/domains/:domain/accounts` → `{people: PersonRef[]}` — accounts with emails on the domain that aren't members (role `guest` or not in the org).
- **Member or guest at invite** (4b, in the invite paths of §14.12): an email on any domain of the org (verified or not) → member; otherwise the guest policy (§14.15). Org admins' invites stay members (the owner's decision).

### 15.8 Sessions and the idle timeout

- **Columns** (0013): `sessions.auth_method` (`google` · `saml` · `dev`; older rows `google`), `sessions.auth_org_id` (SAML's org), `sessions.active_at` (the last **user activity**; older rows = `last_seen_at`), `sessions.idle_limit_ms` (null = no limit).
- **The limit** of a person: `idleLimitMs` (§15.12) = the smallest `idleSessionTimeoutHours ?? 504` over the orgs where they are **admin or member** (not guest), × 3,600,000; none → null. Computed into `sessions.idle_limit_ms` with one UPDATE … (subquery over `org_members` × `orgs.settings`): at session creation, in the 5-minute touch of `authenticate` (so membership changes reach it within 5 minutes), and for the org's people when the setting changes.
- **Activity**: `POST /me/sessions/active` (exists, §14.15) also sets `active_at = now` and answers `{activeAt, idleLimitMs}`. The desktop app calls it at most once a minute while the person uses the app (input events in any view, docs/desktop.md §18), the web app on its own input; nothing else moves `active_at`.
- **Check**: in `authenticate`, before anything else, the touch returns `active_at, idle_limit_ms`; if `idle_limit_ms != null and now − active_at > idle_limit_ms` → the row is deleted, `user_idle_session_timeout` is logged in each of the person's member orgs (`details: {logged_on: "request"}` — a background timeout, logged when next seen, as Figma), and 401 `{code: "idle_timeout"}`. Sockets: the Worker checks on upgrade; open sockets are not polled — the app's own timer (below) closes them by signing out.
- **The app's timer**: `GET /me` adds `session: {id, auth, activeAt, idleLimitMs} | null`. Main schedules the prompt at `activeAt + idleLimitMs − 60 s` (desktop.md §18): "Stay logged in" calls `/me/sessions/active`; no answer by the deadline → main sends `DELETE /me/sessions/current?reason=idle` (204; deletes the row, logs `user_idle_session_timeout` with `details: {logged_on: "client"}` — "Timeouts from an open browser or desktop app are logged immediately" [F-idle]) and signs out locally.
- **A change of the setting** (`idle_timeout_setting_change`): `UPDATE sessions SET active_at = now, idle_limit_ms = <recomputed> WHERE user_id IN (the org's admins and members)` — Figma's reset; the store learns it from the `{t: "org", what: "org"}` notice and asks `GET /me` again (main does, docs/desktop.md §18).
- **Unchanged**: Sign out per session and Sign out everywhere (§13); personal access tokens are not sessions and have no idle limit (Figma's PATs aren't subject to it either, unverified).

### 15.9 Where the policies reach rooms and `resolveAccess`

- **`AccessRows`** (§14.4) gains, filled by `loadAccessRows`: `homeOrgId: string | null` (the org whose **verified** domain matches the user's email and which has `domainCapture` on, with the user a member or admin there), `externalRestricted` = that org's `externalContent == "restricted"` (no longer always false), and `policy: FilePolicy | null` (the file's org, §15.6).
- **`resolveAccess` changes** (in `src/shared/org/access.ts`; new cases 23–30 in `access.test.ts`):
  - step 4 (public link) applies only if `policy == null or (policy.publicLinks and (not policy.passwordRequired or file.passwordProtected))`; `proto_link_access` the same;
  - step 5's external cap also applies to **files outside any org** (`orgId == null`): `legacy(r)` is capped the same way when `externalRestricted` (Figma: drafts in Starter or Professional teams become view-only);
  - the external cap applies when `file.orgId != homeOrgId` (was: "the user's home org", now defined).
  - Cases: 23 public links off, outsider by link → none; 24 same, member by org link → viewer; 25 password required, link without password → none for link-only, unchanged for invited; 26 restricted member, legacy file shared "can edit" → viewer, no comments; 27 restricted member, their own legacy file → viewer (`capped: external`); 28 restricted member, file in the home org → unchanged; 29 restricted, file in another org by public password link with pass → viewer; 30 not captured (capture off) → no cap.
- **Room policy**: the Worker adds `x-policy: {"cursorChat":bool,"audio":bool}` (from `filePolicy`; absent outside orgs = both true) to the socket upgrade it forwards; the room puts it in `welcome.policy`. On a change of `cursorChat` or `audio` the Worker posts `POST /room/policy {cursorChat, audio}` to every room of the org's files (inline, as reauth), and the room broadcasts `{t: "policy", policy}` (protocol §15.12). Clients apply it at once.
- **Close code** `4012` (`CLOSE_MOVING`): the room is moving to another region (§15.10); clients reconnect after 2 s, like 4003.
- **Activity "external" events** [F-log]: Figma logs `fig_file_view_external`, `fig_file_view_prototype_external`, `org_user_create_external`, `team_member_add_external` … in the **home** org of a captured member who views or joins **another** org's content ("Only logged for Enterprise organizations with Domain Capture enabled"). Round 1a logs `fig_file_view_external` in the *file's* org when a guest views — a misreading; round 4 (4b) changes it: the file's org logs `fig_file_view` (guest or not), and the viewer's home org (when captured and different) logs `fig_file_view_external` / `fig_file_view_prototype_external` with the file's entity.

### 15.10 Data storage localization (EU)

- **What moves** (Cloudflare `eu` jurisdiction [CF-do]): each org file's **room** (`FileRoom`: snapshot, frames, images, versions, branch base chunks — Figma's localized "file content"), branch rooms (they are org files), and each org library's **`LibraryObject`** (components and images). **What stays**: D1 (names, comments, members, activity log, sessions, analytics — Figma doesn't localize these either [F-region]), `FontObject` (fonts aren't localized), `PreviewObject` (developer previews are published publicly), `Inbox` (per person). Cloudflare can't relocate an object [CF-do]: moving is copying.
- **Rows**: `orgs.data_region` `'default' | 'eu'` (`OrgInfo.dataRegion`); `files.jurisdiction` and `libraries.jurisdiction` `NULL | 'eu'`.
- **Addressing**: `index.ts` `Rooms.fetch(fileKey, …)` keeps its signature; it reads `SELECT jurisdiction FROM files WHERE key = ?1` (one D1 read per room call, **no cache** — a stale cache would wake an empty object in the old namespace) and uses `env.ROOMS.jurisdiction("eu").idFromName(key)` for `'eu'`, else `env.ROOMS.idFromName(key)`. `libraries/db.ts objectFetch` the same with `libraries.jurisdiction`. New files: `POST /files` / drafts / folder files in an org with `data_region = 'eu'` insert `jurisdiction = 'eu'` before the first snapshot upload.
- **Routes** (org admins; ours — Figma: read-only, via Support):
  - `GET /orgs/:org/admin/data-region` → `DataRegionStatus {region, files: {total, moved}, libraries: {total, moved}, moving: string | null}`.
  - `PUT admin/data-region {region: "default" | "eu"}` → `DataRegionStatus`; sets `orgs.data_region` (new files follow at once); logs `data_storage_localization_change` (ours: Figma lists no action).
  - `POST admin/data-region/move` → moves **one** file (or library) whose jurisdiction differs from the org's region and answers `DataRegionStatus` with `moving: null`; the Admin page calls it in a loop with a progress bar ("Moving files… 12 of 40"). One per call keeps each request within the free plan's subrequest and CPU limits.
- **Moving a room** (`server/src/policy/region.ts`): (1) `POST /room/freeze` on the old object — closes sockets with `4012` and refuses sockets and writes with 503 `{code: "moving"}` until deleted; (2) `GET /room/dump?after=<cursor>` pages (≤ 4 MB JSON each: `{rows: {table, row}[], cursor | null}`, every table of the room's SQLite in rowid order, blobs base64) → `POST /room/load` on the new object, until `cursor` is null; (3) `UPDATE files SET jurisdiction = ?`; (4) `DELETE /room` on the old object. A failure before (3) unfreezes (`POST /room/unfreeze`) and deletes the partial copy. Libraries the same over `LibraryObject` (`/object/freeze`, `/object/dump`, `/object/load`). Edits during the move are refused, so clients retry after reconnecting; the window is seconds for our files.
- **Unknown until deployed**: whether the Workers **free plan** allows jurisdiction-restricted Durable Objects ([CF-do] doesn't say). Round 4 checks on the first deploy; if refused, the Admin page shows the region as unavailable and nothing else changes.

### 15.11 Activity log (round 4's actions)

All Figma's names [F-log] unless marked ours. Entity `idp_user` = `{id: <users.id>, user_name, org_saml_id: <tenantId>, external_id}` (Figma's fields; `ActivityEntityType` already lists it).

| Group | Actions | Written by |
|---|---|---|
| SSO | `google_sso_auth_change`, `saml_sso_auth_change` (authMethod from / to), `idp_config_create`, `idp_config_update`, `idp_config_delete` | admin settings, SAML config routes |
| Authentications | `scim_token_generate`, `scim_token_revoke` | SCIM token routes |
| SCIM users (entity `idp_user`) | `idp_user_create`, `idp_user_update` (seat — Figma: "paid status"), `idp_user_activate`, `idp_user_deactivate`, `idp_user_delete` | SCIM |
| SCIM groups | `idp_group_create`, `idp_group_rename`, `idp_group_delete`, `idp_group_connection_add`, `idp_group_connection_remove` | SCIM |
| Domain management | `org_domain_add`, `org_domain_verify`, `org_domain_remove`, `org_domain_capture_change` | domain routes, settings |
| Users | `user_sign_in` (`details.method`: `google` · `saml` · `dev` — ours), `user_idle_session_timeout`, `user_sign_out` | sign-in, §15.8 |
| Settings | `idle_timeout_setting_change`, `cursor_chat_setting_change`, `open_sessions_setting_change`, `external_collaboration_controls_setting_change`, `autogen_password_controls_setting_change`, `public_link_setting_change` (publicLinks, passwordRequired, linkExpiryMaxHours — the last two inferred), `workspace_public_link_setting_change`, `org_guest_invite_setting_change` (exists) | `PATCH admin/settings`, workspaces |
| Ours (Figma lists none) | `audio_setting_change`, `data_storage_localization_change`, `fig_file_region_move` (a file or library moved; entity `file`) | settings, data region |
| External (corrected, §15.9) | `fig_file_view_external`, `fig_file_view_prototype_external`, `org_user_create_external`, `org_user_delete_external`, `team_member_add_external`, `team_member_remove_external` — in the **home** org | room upgrade, invites |

Not written (not built): `mfa_required_setting_change`, `org_domain_idp_mapping_change` (Governance+ multiple IdPs, round 14), `plan_access_token_*` (round 5), `sites_*`, `open_sessions_start` / `_end` (round 9).

### 15.12 Shared types (committed verbatim before round 4)

The main session commits these before the agents start; the agents compile against them. If a type has to change, the contract changes first.

**`src/shared/org/identity.ts`** (new):

```ts
/**
 * Identity and security (docs/multiplayer.md §15, Phase 7 round 4): SAML SSO, SCIM, domains, sharing policies, the
 * idle session timeout, data storage localization. Shared by the Worker, the store, main and the views; pure, no I/O.
 */
import type { EditorType, OrgRole, OrgSettings, PersonRef } from "./types";

// ---- sign-in -------------------------------------------------------------------------------------------------------

/** Admin › Settings › Authentication [F-auth]: "Members may log in with any method…" (default) / "…with a Google account" / "…with SAML SSO" */
export type AuthMethod = "any" | "google" | "saml";
/** How a session was signed in (sessions.auth_method) */
export type SessionAuth = "google" | "saml" | "dev";
/** `error=` values the loopback (or the web page's `auth_error`) can receive, besides Google's own */
export type SignInError = "access_denied" | "google_failed" | "sso_failed" | "sso_domain" | "google_required";
export const SIGN_IN_ERROR_TEXT: Record<SignInError, string> = {
  access_denied: "Sign-in was cancelled.",
  google_failed: "Google sign-in didn't work. Try again.",
  sso_failed: "Single sign-on didn't work. Try again, or ask your organization's admin.",
  sso_domain: "Your email isn't on a verified domain of this organization. Ask your organization's admin.",
  google_required: "Your organization requires you to log in with a Google account.",
};
/** `POST /auth/sso {email}` (JSON) */
export interface SsoLookup { tenantId: string; orgName: string }
/** `GET /me`'s `session` (null for a personal access token) */
export interface SessionIdle { id: string; auth: SessionAuth; activeAt: number; idleLimitMs: number | null }

// ---- SAML ----------------------------------------------------------------------------------------------------------

export type IdpProvider = "okta" | "entra" | "onelogin" | "google" | "custom";
export const IDP_PROVIDER_LABEL: Record<IdpProvider, string> = { okta: "Okta", entra: "Microsoft Entra ID", onelogin: "OneLogin", google: "Google Workspace", custom: "Other" };
export interface IdpCertificateInfo { sha256: string; subject: string; notAfter: number }
export interface IdpConfig {
  tenantId: string;
  provider: IdpProvider;
  idpEntityId: string;
  ssoUrl: string;
  /** The PEMs stay on the server */
  certificates: IdpCertificateInfo[];
  metadataUrl: string | null;
  signing: "assertion" | "assertion_or_response";
  /** Figma's "SP Entity ID" (also the SP metadata), "SP ACS URL", the start URL */
  spEntityId: string;
  spAcsUrl: string;
  startUrl: string;
  /** The first successful sign-in through this configuration; "Members must log in with SAML SSO" needs it */
  testedAt: number | null;
  updatedAt: number;
}
/** `PUT admin/identity/saml`: the metadata (a URL or the XML) or the three values by hand [F-adfs] */
export interface IdpConfigInput {
  provider: IdpProvider;
  metadataUrl?: string;
  metadataXml?: string;
  idpEntityId?: string;
  ssoUrl?: string;
  /** PEM, or base64 DER as IdPs show it */
  certificate?: string;
  signing?: IdpConfig["signing"];
}

// ---- SCIM ----------------------------------------------------------------------------------------------------------

export const SCIM_USER_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:User";
export const SCIM_ENTERPRISE_SCHEMA = "urn:ietf:params:scim:schemas:extension:enterprise:2.0:User";
/** Figma's own extension [F-scim-api] (its one attribute: figmaAdmin) */
export const SCIM_FIGMA_SCHEMA = "urn:ietf:params:scim:schemas:extension:figma:enterprise:2.0:User";
export const SCIM_GROUP_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:Group";
export const SCIM_SEAT_VALUE = { full: "Full", dev: "Dev", collab: "Collab", view: "View" } as const;
export interface ScimTokenInfo { id: string; createdAt: number; createdBy: PersonRef | null; lastUsedAt: number | null }
/** `POST admin/identity/scim-token`: the token is shown once */
export interface ScimTokenCreated { token: string; info: ScimTokenInfo }
/** What SAML / SCIM told us about a member (Admin › People's metadata columns) */
export interface IdpAttributes {
  provisionedBy: "scim" | "jit" | null;
  /** SCIM's `active`; null when not SCIM-managed */
  scimActive: boolean | null;
  externalId?: string;
  title?: string;
  employeeNumber?: string;
  costCenter?: string;
  organization?: string;
  division?: string;
  department?: string;
  managerValue?: string;
  managerDisplayName?: string;
}

// ---- domains -------------------------------------------------------------------------------------------------------

export const DOMAIN_TXT_PREFIX = "designerv2-domain-verification=";
export interface OrgDomain { domain: string; verified: boolean; verifiedAt: number | null; txtRecord: string; createdAt: number }
/** `GET admin/identity`: Admin › Settings › Login and provisioning in one read */
export interface IdentityOverview {
  authMethod: AuthMethod;
  idp: IdpConfig | null;
  scim: { baseUrl: string; token: ScimTokenInfo | null } | null;
  domains: OrgDomain[];
  domainCapture: boolean;
}

/** The part of an email after its last "@", lower case; null when there is none */
export function emailDomain(email: string): string | null {
  const at = email.lastIndexOf("@");
  const d = at < 0 ? "" : email.slice(at + 1).trim().toLowerCase();
  return d && !d.includes("@") ? d : null;
}

/** A domain as an admin typed it → "acme.com", or null (scheme, path, port, "www." are not stripped silently: only a
 *  scheme and a trailing dot or slash are). Hostname rules: labels 1–63 of [a-z0-9-], not starting or ending with "-",
 *  at least two labels, ≤ 253 characters. */
export function normalizeDomain(input: string): string | null {
  const d = input.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/+$/, "").replace(/\.$/, "");
  if (d.length === 0 || d.length > 253 || /[/:?#@\s]/.test(d)) return null;
  const labels = d.split(".");
  if (labels.length < 2) return null;
  for (const l of labels) if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(l)) return null;
  return d;
}

// ---- sharing policies ----------------------------------------------------------------------------------------------

/** Admin › Public sharing › Custom settings for workspaces [F-share]: each present key overrides the org's */
export interface WorkspaceSharingSettings { publicLinks?: boolean; passwordRequired?: boolean; linkExpiryMaxHours?: number | null }
/** A file's effective policy (`GET /files/:key` → `policy`; null outside orgs) */
export interface FilePolicy {
  publicLinks: boolean;
  passwordRequired: boolean;
  passwordMode: "any" | "autogenerated";
  linkExpiryMaxHours: number | null;
  cursorChat: boolean;
  audio: boolean;
  openSessions: boolean;
}
export const LINK_EXPIRY_MAX_HOURS = 744; // Figma: 1 hour to 31 days

export function filePolicy(s: OrgSettings, ws: WorkspaceSharingSettings | null, editorType: EditorType): FilePolicy {
  const linkExpiryMaxHours = ws && ws.linkExpiryMaxHours !== undefined ? ws.linkExpiryMaxHours : s.linkExpiryMaxHours;
  const publicLinks = (ws?.publicLinks ?? s.publicLinks) && !(editorType === "figjam" && linkExpiryMaxHours !== null);
  return {
    publicLinks,
    passwordRequired: ws?.passwordRequired ?? s.passwordRequired,
    passwordMode: s.passwordMode,
    linkExpiryMaxHours,
    cursorChat: s.cursorChat,
    audio: s.audio,
    openSessions: s.openSessions,
  };
}

/** The room's part of the policy (`welcome.policy`, `{t: "policy"}`) */
export interface RoomPolicy { cursorChat: boolean; audio: boolean }

/** Four random words, Figma's "Autogenerated passwords" (the Share dialog's Generate; moved here from ShareDialog.tsx) */
export const PASSWORD_WORDS: readonly string[] = "amber anchor apple arrow autumn bamboo beacon berry bloom breeze canyon cedar cloud comet coral cotton crystal dawn delta desert echo ember falcon fern forest frost galaxy garden glacier harbor hazel horizon island ivory jade jasmine juniper lagoon lemon lily lotus maple meadow meteor mint moss nebula oasis ocean olive orbit orchid pebble pepper pine planet plum prairie quartz rain raven reef river robin saffron sage sand shadow silver sky spruce star stone storm summer sunset thunder tide timber topaz tulip valley velvet violet willow winter".split(" ");
export function generateLinkPassword(): string {
  const r = crypto.getRandomValues(new Uint32Array(4));
  return [...r].map((n) => PASSWORD_WORDS[n % PASSWORD_WORDS.length]).join("-");
}
export function isGeneratedPassword(p: string): boolean {
  const words = p.split("-");
  return words.length === 4 && words.every((w) => PASSWORD_WORDS.includes(w));
}

// ---- idle session timeout ------------------------------------------------------------------------------------------

export const IDLE_DEFAULT_HOURS = 504; // 21 days [F-idle]
export const IDLE_MIN_HOURS = 12;
export const IDLE_MAX_HOURS = 336; // 14 days
/** The idle limit of a person: the shortest over the orgs where they are a member or admin (guests: none); null: no org */
export function idleLimitMs(orgs: { role: OrgRole; settings: Pick<OrgSettings, "idleSessionTimeoutHours"> }[]): number | null {
  let hours: number | null = null;
  for (const o of orgs) {
    if (o.role === "guest") continue;
    const h = o.settings.idleSessionTimeoutHours ?? IDLE_DEFAULT_HOURS;
    hours = hours === null ? h : Math.min(hours, h);
  }
  return hours === null ? null : hours * 3_600_000;
}
/** The prompt shows this long before the logout [F-idle] */
export const IDLE_WARNING_MS = 60_000;

// ---- data storage localization -------------------------------------------------------------------------------------

export type DataRegion = "default" | "eu";
export const DATA_REGION_LABEL: Record<DataRegion, string> = { default: "Default", eu: "European Union" };
export interface DataRegionStatus {
  region: DataRegion;
  files: { total: number; moved: number };
  libraries: { total: number; moved: number };
  /** The file or library key being moved by this call, or null */
  moving: string | null;
  /** False when Cloudflare refused a jurisdiction-restricted object (§15.10) */
  available: boolean;
}

// ---- errors and the activity log -----------------------------------------------------------------------------------

/** New `code`s of §14.12's error bodies */
export type IdentityErrorCode =
  | "sso_not_found" | "idle_timeout" | "external_restricted" | "domain_unverified" | "domain_taken"
  | "password_policy" | "link_expiry_policy" | "public_links_off" | "moving";

/** Round 4's activity actions (§15.11): Figma's names, then ours */
export type IdentityActivityAction =
  | "google_sso_auth_change" | "saml_sso_auth_change" | "idp_config_create" | "idp_config_update" | "idp_config_delete"
  | "scim_token_generate" | "scim_token_revoke"
  | "idp_user_create" | "idp_user_update" | "idp_user_activate" | "idp_user_deactivate" | "idp_user_delete"
  | "idp_group_create" | "idp_group_rename" | "idp_group_delete" | "idp_group_connection_add" | "idp_group_connection_remove"
  | "org_domain_add" | "org_domain_verify" | "org_domain_remove" | "org_domain_capture_change"
  | "user_idle_session_timeout" | "idle_timeout_setting_change" | "cursor_chat_setting_change" | "open_sessions_setting_change"
  | "external_collaboration_controls_setting_change" | "autogen_password_controls_setting_change" | "workspace_public_link_setting_change"
  | "fig_file_view_prototype_external"
  // ours
  | "audio_setting_change" | "data_storage_localization_change" | "fig_file_region_move";
```

**`src/shared/org/types.ts`** — additions, each in a marked block:

```ts
// in `interface OrgSettings`, after `audio: boolean;`:
  // ---- Phase 7 round 4: identity and security (docs/multiplayer.md §15.6) ----
  /** Authentication: any method (default), a Google account, SAML SSO — checked at sign-in, members only */
  authMethod: "any" | "google" | "saml";
  /** Idle session timeout in hours, 12…336; null: Figma's default 21 days */
  idleSessionTimeoutHours: number | null;
  /** Domain capture: needs every domain verified */
  domainCapture: boolean;
  /** Access to external content: "restricted" needs domainCapture */
  externalContent: "allowed" | "restricted";
  /** Password protection options: "autogenerated" = Autogenerated passwords only */
  passwordMode: "any" | "autogenerated";
  /** FigJam open sessions (enforced with FigJam, round 9) */
  openSessions: boolean;

// DEFAULT_ORG_SETTINGS gains:
  authMethod: "any", idleSessionTimeoutHours: null, domainCapture: false, externalContent: "allowed", passwordMode: "any", openSessions: true,

// in `interface OrgInfo`, after `settings: OrgSettings;`:
  /** Data storage localization (§15.10); optional so round 1–3 code compiles, always sent from round 4 */
  dataRegion?: DataRegion;

// `interface OrgWorkspace` gains `sharing?: WorkspaceSharingSettings | null;` (always sent from round 4)
// `interface WorkspacePatch` gains `sharing?: WorkspaceSharingSettings | null;`
// `interface AdminPerson` gains `idp?: IdpAttributes | null;` (always sent from round 4)
// (New fields of existing interfaces are optional so the commit compiles before the agents; an object literal of
// OrgSettings that stops compiling is completed from DEFAULT_ORG_SETTINGS by the main session in the same commit.)
// `interface FileAccess` `capped` stays "seat" | "external" | null (unchanged)
// `type ActivityAction` gains `| IdentityActivityAction` as its last member
// the import at the top: `import type { DataRegion, IdentityActivityAction, IdpAttributes, WorkspaceSharingSettings } from "./identity";`
```

**`src/shared/multiplayer/protocol.ts`** — additions:

```ts
// `welcome` gains an optional field (absent outside orgs = everything allowed):
  | { t: "welcome"; sessionID: number; role: Role; seq: number; peers: PeerInfo[]; snapshotSeq: number; policy?: RoomPolicy }
// a new ServerControl member:
  /** The org changed cursor chat or audio (docs/multiplayer.md §15.9) */
  | { t: "policy"; policy: RoomPolicy }
// and, with the import `import type { RoomPolicy } from "../org/identity";`:
/** The room is moving to another region (§15.10): reconnect after a moment */
export const CLOSE_MOVING = 4012;
```

**`src/shared/org/repositories.ts`** — a new repository (the store's `identity`, 4c; Admin's, 4d):

```ts
import type * as I from "./identity";

/** Admin › Settings › Login and provisioning, domains, data storage localization (docs/multiplayer.md §15; org admins) */
export interface IdentityRepository {
  overview(orgId: string): Promise<I.IdentityOverview>;
  saveIdp(orgId: string, input: I.IdpConfigInput): Promise<I.IdpConfig>;
  refreshIdpMetadata(orgId: string): Promise<I.IdpConfig>;
  deleteIdp(orgId: string): Promise<void>;
  generateScimToken(orgId: string): Promise<I.ScimTokenCreated>;
  revokeScimToken(orgId: string): Promise<void>;
  addDomain(orgId: string, domain: string): Promise<I.OrgDomain>;
  /** Throws a StoreError with code "domain_unverified" and `found` (the TXT values seen) when the record isn't there */
  verifyDomain(orgId: string, domain: string): Promise<I.OrgDomain>;
  removeDomain(orgId: string, domain: string): Promise<void>;
  domainAccounts(orgId: string, domain: string): Promise<O.PersonRef[]>;
  dataRegion(orgId: string): Promise<I.DataRegionStatus>;
  setDataRegion(orgId: string, region: I.DataRegion): Promise<I.DataRegionStatus>;
  /** Moves one file or library; call until `files.moved == files.total` and `libraries.moved == libraries.total` */
  moveNext(orgId: string): Promise<I.DataRegionStatus>;
}
// StoreApi (src/shared/store/repositories.ts) gains `identity: IdentityRepository;` with a notImplemented stub in both
// stores, committed with these types (as rounds 1 and 3 did).
```

### 15.13 Routes (round 4)

Conventions of §14.12 (JSON, `{error, code}`); SCIM's are §15.5's.

**Sign-in** (no session):

| Route | Request | Answer |
|---|---|---|
| `GET /auth/login` | `port`·`return`, `state`, `challenge`, `method=google`?, `tenant`? | the login page; or 302 to Google / to `/saml/:tenantId/start?st=` |
| `POST /auth/sso` | form `{email, st}` · JSON `{email}` | 302 to the start · `SsoLookup` / 404 `sso_not_found` |
| `GET /saml/:tenantId` | — | SP metadata XML |
| `GET /saml/:tenantId/start` | `st`? | 302 to the IdP (AuthnRequest) · the "log in from the app" page |
| `POST /saml/:tenantId/consume` | form `{SAMLResponse, RelayState}` | 302 to the loopback / web page with `code` or `error` · the bounce page (unsolicited) · 403 page |

**The account** (session):

| Route | Answer |
|---|---|
| `GET /me` | adds `session: SessionIdle \| null` |
| `POST /me/sessions/active` | `{activeAt, idleLimitMs}` (was 204) |
| `DELETE /me/sessions/current?reason=idle` | 204; logs the idle timeout (`reason` absent: a plain Log out, `user_sign_out`) |

**Admin** (`/orgs/:org/admin/…`, org admins only — workspace and billing-group admins get 403 `not_admin`):

| Route | Request → Answer |
|---|---|
| `GET admin/identity` | → `IdentityOverview` |
| `PUT admin/identity/saml` | `IdpConfigInput` → `{idp: IdpConfig}` (400 naming the bad field: unreachable metadata, no signing certificate, an RSA key < 2048, no HTTP-Redirect SSO service) |
| `POST admin/identity/saml/refresh` | → `{idp}` (re-fetches `metadataUrl`) |
| `DELETE admin/identity/saml` | → 204 (409 while `authMethod` is `saml`; also revokes the SCIM token) |
| `POST admin/identity/scim-token` | → `ScimTokenCreated` (409 without an IdP config: "Set up SAML SSO first") |
| `DELETE admin/identity/scim-token` | → 204 |
| `POST admin/domains` | `{domain}` → `{domain: OrgDomain}` |
| `POST admin/domains/:domain/verify` | → `{domain}` · 409 `domain_unverified {found}` · 409 `domain_taken` |
| `DELETE admin/domains/:domain` | → 204 |
| `GET admin/domains/:domain/accounts` | → `{people: PersonRef[]}` |
| `GET admin/data-region` · `PUT admin/data-region {region}` · `POST admin/data-region/move` | → `DataRegionStatus` |
| `PATCH admin/settings` (§14.12) | the new keys of §15.6 |
| `PATCH admin/workspaces/:id` (§14.12) | `{sharing}` |
| `GET admin/people` (§14.12) | each `AdminPerson` with `idp` |

**Files** (§14.12): `GET /files/:key` adds `policy: FilePolicy | null`; `PATCH /files/:key` refuses with `public_links_off`, `password_policy`, `link_expiry_policy` as §15.6; `POST /files` refuses with `external_restricted` (§15.9).

**Last-resort recovery** (the owner, if an IdP breaks while SAML is required): `npx wrangler d1 execute designer --remote --command "UPDATE orgs SET settings = json_set(settings, '$.authMethod', 'any') WHERE id = '<org>'"`.

### 15.14 D1: migration `server/migrations/0013_identity.sql`

The latest migration is `0012_libraries.sql`. Agent 4a copies this text verbatim.

```sql
-- Identity and security (docs/multiplayer.md §15): SAML SSO per org, SCIM, domains, sessions' auth method and idle
-- timeout, data storage localization. Times are ms since the epoch.

-- One SAML configuration per org (§15.3.1). certificates: JSON array of PEM strings (≤ 2).
CREATE TABLE idp_configs (
  org_id        TEXT PRIMARY KEY REFERENCES orgs (id) ON DELETE CASCADE,
  tenant_id     TEXT NOT NULL UNIQUE,
  provider      TEXT NOT NULL CHECK (provider IN ('okta', 'entra', 'onelogin', 'google', 'custom')),
  idp_entity_id TEXT NOT NULL,
  sso_url       TEXT NOT NULL,
  certificates  TEXT NOT NULL,
  metadata_url  TEXT,
  signing       TEXT NOT NULL DEFAULT 'assertion' CHECK (signing IN ('assertion', 'assertion_or_response')),
  tested_at     INTEGER,
  created_by    TEXT REFERENCES users (id) ON DELETE SET NULL,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

-- AuthnRequests waiting for their Response (§15.3.3): consumed once with DELETE … RETURNING. state: the app's
-- {p | r, s, c} (the signed oauthState's payload) as JSON.
CREATE TABLE saml_requests (
  id         TEXT PRIMARY KEY,
  org_id     TEXT NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
  state      TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX saml_requests_expiry ON saml_requests (expires_at);

-- Accepted assertion IDs until their NotOnOrAfter: a second INSERT of one is a replay (§15.3.4 step 5).
CREATE TABLE saml_assertions (
  id         TEXT PRIMARY KEY,
  org_id     TEXT NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
CREATE INDEX saml_assertions_expiry ON saml_assertions (expires_at);

-- The sign-in code knows how it was earned, so /auth/token makes the right session.
ALTER TABLE auth_codes ADD COLUMN auth TEXT NOT NULL DEFAULT 'google' CHECK (auth IN ('google', 'saml', 'dev'));
ALTER TABLE auth_codes ADD COLUMN org_id TEXT;

-- One live SCIM token per org (§15.5): only its SHA-256.
CREATE TABLE scim_tokens (
  id           TEXT PRIMARY KEY,
  org_id       TEXT NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
  token_hash   TEXT NOT NULL UNIQUE,
  created_by   TEXT REFERENCES users (id) ON DELETE SET NULL,
  created_at   INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at   INTEGER
);
CREATE INDEX scim_tokens_org ON scim_tokens (org_id, revoked_at);

-- People the IdP manages in an org (SCIM's Users). active 0: deactivated (removed from the org, the link kept).
CREATE TABLE scim_users (
  org_id      TEXT NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  user_name   TEXT NOT NULL,
  external_id TEXT,
  active      INTEGER NOT NULL DEFAULT 1,
  -- the seat SCIM last set ('full' | 'dev' | 'collab' | 'view'), restored on reactivation
  seat        TEXT CHECK (seat IN ('full', 'dev', 'collab', 'view')),
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (org_id, user_id)
);
CREATE UNIQUE INDEX scim_users_name ON scim_users (org_id, user_name);
CREATE UNIQUE INDEX scim_users_external ON scim_users (org_id, external_id) WHERE external_id IS NOT NULL;

-- SCIM's Groups and what each is linked to by its name (§15.5).
CREATE TABLE scim_groups (
  id           TEXT PRIMARY KEY,
  org_id       TEXT NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
  display_name TEXT NOT NULL,
  external_id  TEXT,
  target_type  TEXT NOT NULL CHECK (target_type IN ('workspace', 'billing_group', 'user_group')),
  target_id    TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
CREATE INDEX scim_groups_org ON scim_groups (org_id, display_name);
CREATE UNIQUE INDEX scim_groups_external ON scim_groups (org_id, external_id) WHERE external_id IS NOT NULL;

CREATE TABLE scim_group_members (
  group_id TEXT NOT NULL REFERENCES scim_groups (id) ON DELETE CASCADE,
  user_id  TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  PRIMARY KEY (group_id, user_id)
);
CREATE INDEX scim_group_members_user ON scim_group_members (user_id);

-- What SAML JIT and SCIM told us about a member (IdpAttributes JSON) and who provisioned them.
ALTER TABLE org_members ADD COLUMN idp_attributes TEXT NOT NULL DEFAULT '{}';
ALTER TABLE org_members ADD COLUMN provisioned_by TEXT CHECK (provisioned_by IN ('scim', 'jit'));

-- An org's email domains (§15.7). A verified domain belongs to one org.
CREATE TABLE org_domains (
  org_id      TEXT NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
  domain      TEXT NOT NULL,
  token       TEXT NOT NULL,
  created_by  TEXT REFERENCES users (id) ON DELETE SET NULL,
  created_at  INTEGER NOT NULL,
  verified_at INTEGER,
  PRIMARY KEY (org_id, domain)
);
CREATE UNIQUE INDEX org_domains_verified ON org_domains (domain) WHERE verified_at IS NOT NULL;
CREATE INDEX org_domains_domain ON org_domains (domain);

-- Sessions: how they were signed in, the last user activity and the idle limit (§15.8).
ALTER TABLE sessions ADD COLUMN auth_method TEXT NOT NULL DEFAULT 'google' CHECK (auth_method IN ('google', 'saml', 'dev'));
ALTER TABLE sessions ADD COLUMN auth_org_id TEXT;
ALTER TABLE sessions ADD COLUMN active_at INTEGER;
ALTER TABLE sessions ADD COLUMN idle_limit_ms INTEGER;
UPDATE sessions SET active_at = last_seen_at;

-- Data storage localization (§15.10): the org's region; the jurisdiction each room or library object lives in.
ALTER TABLE orgs ADD COLUMN data_region TEXT NOT NULL DEFAULT 'default' CHECK (data_region IN ('default', 'eu'));
ALTER TABLE files ADD COLUMN jurisdiction TEXT CHECK (jurisdiction IN ('eu'));
ALTER TABLE libraries ADD COLUMN jurisdiction TEXT CHECK (jurisdiction IN ('eu'));
```

Notes: `users` is unchanged (decision 5's `none:` placeholder lives in `google_sub`). `user_groups.external_id` (0010) holds the SCIM group id of a group made by SCIM. No new Durable Object class; `wrangler.jsonc` gains `"compatibility_flags": ["nodejs_compat"]` (node-saml).

### 15.16 As built — round 4b, server policy and region (2026-10-11)

`server/src/policy/` (new: `sharing.ts` — `policyOfFile`, `checkFilePatch`, `checkExpiry`, `applySharingChange` (the clamp + revoke-link fan-out), `cleanWorkspaceSharing`; `external.ts` — `homeOrgOf`, `requireInside`, `logExternal`; `roomPolicy.ts` — `roomPolicyOf`, `x-policy` encode / parse, `broadcastRoomPolicy`; `region.ts` — `roomsOn` (index.ts's `Rooms`), the data-region routes and `moveObject`; `dump.ts` — paged dump / load of an object's SQLite), `server/src/org/` (`patchSettings`, workspace `sharing`, `AdminPerson.idp`, invites on the org's domains, workspace admins answering guest requests, `Access.home()` / `Access.policy()` feeding `rowsFor`), `src/shared/org/access.ts` (cases 23–30), `src/shared/multiplayer/room.ts` (`Identity.policy`, `welcome.policy`, `setPolicy`), `server/src/fileRoom.ts`, `server/src/roomBox.ts`, `server/src/libraries/` (`libraryFetch` by `libraries.jurisdiction`, `LibraryBox` freeze / dump / load), `server/src/branches.ts`, `server/src/activity.ts`, `server/src/index.ts`, `server/src/testing/`. Tests: `server/src/policy/policy.test.ts` (15), `server/src/policy/region.test.ts` (6), `access.test.ts` cases 23–30, `room.test.ts` (welcome.policy and the broadcast).

As built, for 4c / 4d / 4e:
- **`GET /files/:key`** adds `policy: FilePolicy | null` (null outside orgs). **`PATCH /files/:key`** is checked as a whole before anything is written: 403 `public_links_off` (`linkAccess` or `protoLinkAccess` ≠ none), 400 `password_policy` (a public link without a password — set `linkPassword` in the same PATCH —, removing the password while the link is on, a typed password under "Autogenerated passwords only"), 400 `link_expiry_policy` with `{maxHours}` (opening a link without `linkExpiresAt` ≤ now + max; changing `linkExpiresAt` past the max or to null while the link is on). The max is the file's effective one (workspace override, else the org's).
- **`PATCH admin/settings`**: every key validated (unknown keys 400; `linkExpiryMaxHours` null or a whole 1…744; `idleSessionTimeoutHours` null or a whole 12…336); `externalContent: "restricted"` without `domainCapture` → 409 `conflict`. Changed `authMethod` / `idleSessionTimeoutHours` / `domainCapture` go to 4a's `validateIdentitySettings` before the save and `onIdentitySettingsChanged` after it — **4a logs those three** (`google_sso_auth_change` / `saml_sso_auth_change`, `idle_timeout_setting_change`, `org_domain_capture_change`); 4b logs the rest (`cursor_chat_setting_change`, `audio_setting_change`, `external_collaboration_controls_setting_change`, `autogen_password_controls_setting_change`, `open_sessions_setting_change`, one `public_link_setting_change` for any of publicLinks / passwordRequired / linkExpiryMaxHours with `{settings, from, to}` when several change). Sharing changes clamp `link_expires_at` per file to its effective maximum and post `/room/revoke-link` to files with a public or prototype link when the policy tightened (or a file was clamped); cursor chat / audio post `POST /room/policy {cursorChat, audio}` to every org file's room; external content reauths the org's members on files outside it.
- **`PATCH admin/workspaces/:id {sharing}`** (org admins; `WorkspaceSharingSettings | null`, other keys 400) → `{workspace}` with `sharing`; stored in `workspaces.settings.sharing`; logs `workspace_public_link_setting_change {from, to}`; clamp / revoke for that workspace's teams only. `OrgWorkspace.sharing` is always sent (null: none).
- **`GET admin/people`**: `AdminPerson.idp` = `{provisionedBy, scimActive, …org_members.idp_attributes}` or null (nothing from SAML / SCIM).
- **Guest requests**: `GET / POST admin/guest-requests` open to workspace admins for requests whose team / folder / file is in their workspaces (others 404); new requests notify the resource's workspace admins, else the org admins.
- **Invites**: an email on any of the org's domains (verified or not) joins as a member, before the guest policy. An invitee whose home org restricts external content → 403 `external_restricted` (any inviter); `claimInvites` claims the would-be home org's rows first and, when restricted, nothing outside it.
- **External restriction** (`requireInside`, 403 `external_restricted` with `{homeOrgId}`): `POST /files` without `orgId`, `POST /orgs`, `createOrgFile` in another org (`POST /files {orgId}`, `POST /orgs/:o/drafts`, `POST /projects/:p/files`), `POST /teams/:t/projects`, `POST /teams/:t/join`. `resolveAccess` caps files outside the home org (files outside any org included) — view-only, no comments, no sharing (`canShare` false).
- **Rooms**: `Rooms.fetch` init gains `policy?: RoomPolicy` (api.ts); `roomsOn` sends it as `x-policy`; `FileRoom` puts it on the socket's identity → `welcome.policy`; `POST /room/policy` → `{t: "policy", policy}` to every member (kept in each socket's attachment across hibernation). Absent outside orgs.
- **Activity, corrected**: the file's org logs `fig_file_view` / `fig_file_view_prototype` (guests too); the viewer's home org (captured, another org) logs `fig_file_view_external` / `fig_file_view_prototype_external` with `details.external_org_id`. Likewise `org_user_create` / `org_user_delete` / `team_member_add` / `team_member_remove` in the content's org (guests carry `details.guest` or `role`), and their `_external` twins in the person's home org.
- **Data region** (org admins): `GET admin/data-region` → `DataRegionStatus` (`files` = org files incl. branches, `libraries` = not deleted; `available` = the `ROOMS` binding has `jurisdiction()`); `PUT {region}` → status, logs `data_storage_localization_change {from, to}`, 503 when `eu` isn't available; `POST admin/data-region/move` → status with **`moving` = the key this call moved** (files first in key order, then libraries), `null` when nothing was left — loop until `moving` is null. A failed move → 502 (the old object unfrozen, the copy deleted, D1 unchanged). Each move logs `fig_file_region_move {object: "room" | "library", from, to}`. `OrgInfo.dataRegion` is sent.
- **Move protocol**: rooms `POST /room/freeze {moving: true}` (meta `moving`; `FileRoom` closes sockets with 4012 and answers upgrades 503 `{code: "moving"}`; RoomBox refuses non-GET routes 503 `moving`), `GET /room/dump?after=`, `POST /room/load {rows}`, `POST /room/unfreeze {moving: true}`, `DELETE /room`. Libraries use the object's own root paths — `/freeze`, `/dump`, `/load`, `/unfreeze`, `/delete` — not `/object/…` (LibraryBox has no prefix). Pages: `{rows: {table, row}[], cursor}` ≤ 3 MB of JSON, blobs `{$b64}`, cursor `"<table index>:<last rowid>"`; the `moving` mark is never copied.
- **Jurisdictions**: `files.jurisdiction` set at creation for EU orgs (`createOrgFile`), branches take their main file's; legacy files moved into an org keep NULL until the move job; libraries take the org's region at their first publish and, before it, `libraryJurisdiction` falls back to the org's region. Fonts, previews and inboxes stay in the default namespace.
- **Not built**: `openSessions` is stored and logged only (round 9); a failed delete of the old object after the flip is logged, not retried (an unused object remains); concurrent move calls aren't locked (two calls racing on one object copy it twice; the load is INSERT OR REPLACE, so the copy ends the same).

### 15.17 As built — round 4a, server identity (2026-10-11)

Code: `server/src/auth/` — `saml/` (`sp.ts` the SP over node-saml with our checks, `config.ts` IdP metadata / certificates / the D1 `CacheProvider`, `routes.ts` metadata · start · ACS, `lib.js` + `lib.d.ts` the Node libraries behind narrow types), `sso.ts` (login page routing, `/auth/sso`, Google's callback, codes), `pages.ts`, `people.ts` (accounts by email, `ensureMember`), `scim/` (`routes.ts`, `users.ts`, `groups.ts`, `common.ts`), `domains.ts`, `capture.ts`, `idle.ts`, `identityRoutes.ts`, `settingsHooks.ts`; `db.ts` (`upsertUser` claims `none:` accounts; sessions' `auth_method`, `auth_org_id`, `active_at`, `idle_limit_ms`; codes' `auth`, `org_id`), `account.ts` (`GET /me` `session`, `POST /me/sessions/active` → `{activeAt, idleLimitMs}`, `DELETE /me/sessions/current[?reason=idle]`), `api.ts` (dispatch lines; `login`, `callback`, `token`, `devSignIn`, `issueSession`, `authenticate`). `wrangler.jsonc` `nodejs_compat`; `server/package.json` `@node-saml/node-saml` 5.1.0 (exact), `@xmldom/xmldom` ^0.8.15, `xml-crypto` ^6.3.3.

Routes exactly as §15.13, plus: `GET /orgs/:org/admin/domains` → `{domains: OrgDomain[]}`; `GET /auth/login?st=<signed state>&method=google|sso` (the login page's own links carry the state already made; `method=sso` is the email step, served without JavaScript); the web bounce link is `<WEB_ORIGINS[0]>/?sso=<tenantId>` (the web app starts `/auth/login?return=…&tenant=` itself — §15.2 decision 3's web form needs the app's state and challenge, which only the app has).

Differences and details:
- **Type isolation**: node-saml's and xmldom's typings pull Node's and the DOM's globals into the Worker's typecheck (and break `Uint8Array` / `Element` across `server/src`); `saml/lib.js` re-exports them and `lib.d.ts` declares only what the SP uses. Tests import the libraries directly.
- **SHA-1 and encryption** are refused on the raw document before verification: every `SignatureMethod` / `DigestMethod` anywhere must be RSA-SHA-256/384/512 / SHA-256/384/512 (the verified signature is among them; the verified XML has its Signature removed by the enveloped transform, so it can't be read there).
- **Path choice**: the raw post decides `validateInResponseTo` (`always` when the Response or any `SubjectConfirmationData` carries `InResponseTo`, else `never`); the **signed** `SubjectConfirmationData/@InResponseTo` decides the outcome — absent → the bounce (an unsigned `Response/@InResponseTo` alone never makes a session). Unsolicited assertions also go through the replay table.
- **Failures** before the request is consumed reach the app (`error=sso_failed` on its loopback) when `RelayState` names a pending request of this org (that request is consumed); otherwise the 403 page. Reasons go to `console.warn` only.
- **`user_sign_in`** is logged once, when the app trades the code (`issueSession`), with `details.method` (`google` · `saml` · `dev`) and `org_id` for SAML — in every org of the person, as before.
- **Login method**: "the org they joined first" = the first `org_members.created_at` among the person's admin/member orgs whose `authMethod` isn't `any`. A Google sign-in only *claims* `none:` accounts; `dev:` accounts are separate (a SAML sign-in matches any account by email).
- **SCIM**: tokens `dsgn_scim_…`, stored as `sha256b64url` (as PATs). `GET /scim/v2/:tenant` answers `{}` without a token for a known tenant. A deactivated user's `org_members` row goes (§14.7), so their title / enterprise attributes are lost until the IdP sends them again (names stay on `users`). PUT without `roles` or `figmaAdmin` keeps the seat / role; PUT without `active` keeps it. The last admin can't be deactivated, demoted or deleted by SCIM (400 `mutability`). Groups: ids `g_<16>`; a rename to a name linking nothing renames a SCIM user group in place; otherwise the old link is undone (a SCIM user group deleted) and the new one made. Members must be users provisioned in, or members of, the org (else 400 `invalidValue`). Group events are logged on the `org` entity with `{group_id, display_name, target_type, target_id}`. Lists order by creation (`rowid`).
- **Domains**: `GET admin/domains/:domain/accounts` lists ≤ 500. Removing the last verified domain turns capture off *and* resets `externalContent` to `allowed` (it needs capture). Admins on a removed domain become guests too.
- **Capture**: notification kind `org_domain_captured` (text "You were added to ‹org›"; the client doesn't render it yet). Sign-in capture runs in Google's callback; the ACS's JIT already makes members.
- **Idle**: `idle_limit_ms` set at session creation and recomputed in the 5-minute touch, so a session made before its person joined an org gets its limit within 5 minutes. `DELETE /me/sessions/current` without `reason` logs `user_sign_out`.
- **Hooks** (`settingsHooks.ts`, called by 4b's `patchSettings` for changed keys): validate shapes and preconditions (409 `invalid` "Test SAML SSO first"; 409 `domain_unverified`; 400 for 12…336 h); after saving, log `saml_sso_auth_change` (to or from `saml`) / `google_sso_auth_change`, `idle_timeout_setting_change` (+ the sessions' reset), `org_domain_capture_change` (+ capturing existing accounts).
- **IdP config**: `PUT admin/identity/saml` while `authMethod` is `saml` is refused (409) only when the entity id, SSO URL or certificates change; `tested_at` resets when the entity id or SSO URL change (a rotated certificate keeps it). Refresh is allowed while SAML is required.

Tests (node:sqlite; a test IdP signing in Node with throwaway openssl keys, `server/src/testing/samlIdp.ts`; the world `testing/identityWorld.ts` fakes Google, DoH and metadata URLs through `deps.fetch`): `auth/saml/saml.test.ts` 38 (the spike's 29 on the real routes + SHA-1, encryption, unsolicited replay and bounce, concurrent posts, the AuthnRequest, request expiry, `assertion_or_response`, rotation, malformed posts), `auth/identity.test.ts` 18 (login page, SSO routing, Google → SAML with the app's state, guests never, `google_required`, `sso_domain`, JIT, account linking both ways, SCIM-deactivated refused, IdP config by URL / XML / by hand and its refusals, tested-before-required, SCIM token rotation, admins only, domains with faked DoH — found, split strings, absent, NXDOMAIN, resolver down, taken —, removal → guests, capture, idle limit / expiry / activity / reset / client logout), `auth/scim/scim.test.ts` 12. **Not verified**: a real IdP (Okta, Entra, Google Workspace), real DNS, workerd (`nodejs_compat` ran in the spike; this code is tested in Node only).

### 15.18 As built — round 4c, the store (2026-10-11)

Code: `src/store/org/identity.ts` (new; replaces `identityStub.ts` in LocalStore and the browser's MemoryStore), `src/store/multiplayer/service.ts` + `api.ts`, `src/store/server.ts`, `src/shared/multiplayer/types.ts`, `src/shared/store/protocol.ts` + `client.ts`.

As built, for 4d / 4e / 4f:
- **`identity`** (`IdentityRepository`, method names unchanged from the stub — `overview`, `saveIdp`, `refreshIdpMetadata`, `deleteIdp`, `generateScimToken`, `revokeScimToken`, `addDomain`, `verifyDomain`, `removeDomain`, `domainAccounts`, `dataRegion`, `setDataRegion`, `moveNext`) over the routes of §15.16 / §15.17 one to one, unwrapping `{idp}`, `{domain}`, `{people}`; nothing cached. The store checks shapes before asking (an org id, `normalizeDomain` for every domain — `addDomain` sends the normalized one —, `provider` one of `IDP_PROVIDER_LABEL`, only `IdpConfigInput`'s string keys, `region` `default` | `eu`) and refuses with `invalid` (`detail.field`). The server's refusals are §14.6's StoreErrors with its `code` in `detail.code`: **`verifyDomain`** → `conflict` with `detail: {code: "domain_unverified", found}` (not a StoreError code of its own, as the stub's comment had it; `repositories.ts` says so now) or `detail.code` `domain_taken`; non-admins → `forbidden` `not_admin`; `setDataRegion("eu")` where Cloudflare has no jurisdictions → `invalid` (503). `domainAccounts` lists the accounts on the domain **outside** the org. `moveNext` → loop until `moving` is null. `saveIdp`, `deleteIdp`, `verifyDomain`, `removeDomain` and `setDataRegion` refresh the org's cache (`OrgService.notice({what: "org"})` → `org.updated`), as the server's own notice would. Read methods `overview`, `domainAccounts`, `dataRegion` are retry-safe on a new port.
- **The file's policy**: `SharedFileInfo.policy?: FilePolicy | null` (`multiplayer.fileInfo` and every call answering it — the Share dialog's source; null outside orgs).
- **The room's policy**: `FileShareState.policy?: RoomPolicy | null` — `welcome.policy` on every (re)connect, then `{t: "policy"}`; null outside orgs (everything allowed). A change while the file is open is also a `multiplayer` event `{fileKey, state, policy}` (`MultiplayerEvent.policy`); a reconnect whose welcome repeats the same policy sends none.
- **Close 4012** (`CLOSE_MOVING`): the link reconnects after `MOVING_RETRY_MS` = 2 s, past its backoff; the room's copy answers once the move flipped the file (if the move is still on, the 503'd upgrade falls back to the usual retries).
- **A 401** on any of the store's calls (the server answers 401 only for a dead session) → `SessionEnded {reason: "idle_timeout" | "expired"}`, said once per session, on the new event topic **`session`** (`multiplayer.watchSession(listener)` in both stores and the StoreClient); the store first drops the session itself (`setSession(null)`: sockets closed, the org caches and the inbox follow) so nothing retries with it. The StoreError of an idle refusal reads "You were logged out because you were inactive." with `detail.code` `idle_timeout`. **Caveat**: an idle session first refused on a **socket upgrade** (no HTTP call in between) is deleted there and the WebSocket shows no status, so the store's next call sees a plain 401 → `expired`. Main and the web page must treat `expired` as signed out too and tell the two apart with their own timer (§15.8: main's prompt fires before the limit anyway) — or the server could keep a tombstone of idle-deleted sessions (not built).
- **Tests** against the real handler (no contract fake): `src/store/org/identity.test.ts` 6 (SAML by XML / URL / refresh / refusals / delete while required, SCIM token rotation and revoke checked against `/scim/v2`, domains with faked DoH — found, absent, taken by another org, accounts outside, own domain refused —, the data region to the EU and the move of two files through 4b's fake `ROOMS` namespace, admins only, offline, a bad id never sent, over the port), `src/store/multiplayer/policy.test.ts` 6 (the file's policy with its share info and after a settings change, `welcome.policy`, `PATCH admin/settings {cursorChat}` → the Worker's `POST /room/policy` → the real `Room` → the `policy` event, 4012 → 2 s, idle on a socket upgrade, idle on a call, any other 401). `src/store/org/fake/real.ts` gained `dns` / `metadata` for the Worker's fetches, `call`, `rows`, `acmeServer()` and `testIdpMetadata()` (openssl certificate; `server/src/testing/samlIdp.ts` / `identityWorld.ts` can't be imported into the root typecheck: xml-crypto's typings bring `@types/node` 26 next to the root's 24). `server/src/testing/memoryRooms.ts`: one cast `BodyInit` → `RequestInit["body"]` (no DOM lib in the root's node config).

### 15.19 As built — round 4e, the clients (2026-10-11)

Code: `src/renderer/src/editor/ShareDialog.tsx` (+ css), `editor/multiplayer/` (`presence.ts`, `Multiplayer.tsx`), `src/renderer/src/account/IdleWarning.tsx` (new), `src/renderer/src/files/` (`session.ts`, `orgPolicy.ts` new; `FileBrowser.tsx`, `FilesApp.tsx`, `OrgMain.tsx`, `account.ts`, `storeAccess.ts`), `settings/SecurityTab.tsx`, `store/webAccount.ts`, `src/shared/idleTimer.ts` (main's `IdleTimer` moved here so the web page runs the same timer; `src/main/account/idle.ts` re-exports it).

- **Share dialog by `SharedFileInfo.policy`**: Share settings' "Who can access" is People invited to file / **Anyone at ‹org›** (org files: `orgLinkAccess`) / Anyone — Anyone missing when public links are off (help 360040531773); the link row says the same three. Passwords required → with Anyone the "Password required" box is checked and locked, the caption "‹org› requires a password for links anyone can open.", Save waits for a password. Autogenerated passwords only → no field: **Generate** shows the four words (selectable) and "‹org› only allows autogenerated passwords.". Org files with Anyone get **Link expires** (Never / In 1 hour / 1 day / 7 / 14 / 30 / 31 days; with a maximum: only the choices up to it plus the maximum itself, no Never, "‹org› requires links anyone can open to expire within ‹max›…"; a current expiry is kept as "On ‹date›"). Save is **one** `PATCH /files/:key` (new `multiplayer.updateLink(fileKey, LinkSettingsPatch)` — `setLinkAccess` + `setLinkPassword` in two calls could never satisfy "a public link needs a password in the same PATCH"), so the server's `checkFilePatch` sees the link, password and expiry together. `SharedFileInfo` now also types what `GET /files/:key` already sent: `orgLinkAccess`, `linkExpiresAt`, `org`, `access`.
- **Guests** (`orgs.get(file's org).settings.guestMembership`): an email is "outside" when the inviter isn't an org admin (admins' invites make members), it isn't on the inviter's own email domain, isn't a member of the file and `orgs.people(org, {text})` doesn't know it (the client doesn't see the org's domains). Allow → "Share outside your organization?" with Cancel / **Share**; Require approval → a warning notice "Admin approval is required to share with people outside ‹org›…" under the field and the toast "Asked an admin to approve …" after Invite (the server answers 202 `requested`); No external users → a danger notice "Sharing with external users is disabled…" and Invite disabled while such a chip is there. Wording ours (Figma documents the behaviour, not the words).
- **External cap**: `access.capped === "external"` → the Share dialog's notice and the editor's view-only banner "Your organization only allows you to view this file." (no Ask to edit).
- **Room switches live** (`FileShareState.policy`): `Presence.state.policy`; cursor chat off → `/` and the canvas menu's Cursor chat do nothing (`commands.ts openCursorChat` asks `chatAllowed`, one line), an open bubble closes, others' bubbles aren't drawn, presence stops carrying `chat`; audio off → the headphones leave Multiplayer tools, an ongoing call is left with the toast "Your organization turned off audio. You left the conversation.", incoming call signals ignored.
- **Session end** (`multiplayer.watchSession` via `FilesBackend.watchSession`): Home signs the account out on both reasons; `idle_timeout` → "You were logged out because you were inactive." (shared with the idle prompt's toast, said once within 5 s), `expired` → "You were logged out. Log in again to work on shared files." (ours).
- **Server fix (4a's caveat in §15.18)**: an idle session deleted on any request — a socket upgrade included — or by the app's `DELETE /me/sessions/current?reason=idle` is remembered in **`idle_ended_sessions`** (migration **0014**, rows dropped after 30 days as new ones come); `authenticate` answers a token whose row is gone with `401 idle_timeout` when it is there, so the store says `idle_timeout`, not `expired`. **`DELETE /me/sessions`** = Sign out everywhere as an account path (the preload's `account.request` only allows `/me…`; `POST /auth/signout-everywhere` stays), logs `user_sign_out {everywhere: true}`.
- **Home**: "+ Create" (Design, Import, New folder; in org spaces Design, New folder, Create team and the empty states' New design file) hidden outside the person's home org when it restricts external content — the home org is read client-side as a member/admin org with `domainCapture` and `externalContent: "restricted"`; Admin gets `store.identity`, `onTestSso = (tenant) => account.signIn({tenant})`, and `workspace` for a workspace admin who isn't an org admin (name from `admin.workspaces`). Sign-in failures from SSO show `SIGN_IN_ERROR_TEXT` (desktop's `SignInResult.message`, and the web page's `auth_error`).
- **Not built**: Admin › workspace's own Settings for workspace admins (only Libraries, as 3e built); a live check of the wording against a real Enterprise account.

### 15.15 Not decided here (owner)

See `docs/roadmap.md` Phase 7 "Round 4" — open questions for the owner (IdP-initiated bounce, SAML only on verified domains, the login page, which IdP and domain to test with, self-serve data region).

## 16. REST API and webhooks (contract, Phase 7 round 5; written 2026-10-11)

**Status: the server is built (round 5a, 2026-10-11; §16.16 "As built"); the clients too (round 5b, 2026-10-12; §16.17 "As built").** This section covers Figma's public REST API (`/v1/…`, `/v2/…`) and Webhooks V2 on our Worker. The callers are the owner's and dev friends' scripts, CI, the Code Connect CLI (docs/editor.md "Dev Mode — round 5"), and anything written against Figma's API with its host swapped. Research: R18 E-1, `server/spikes/rest-images.md`. The plan: `docs/roadmap.md` "Round 5".

Facts below were read on developers.figma.com on 2026-10-11 (paths under `https://developers.figma.com/docs/rest-api/`):
- **[R-auth]** `/authentication/`, `/personal-access-tokens/`, `/oauth-apps/`, `/scopes/`
- **[R-rate]** `/rate-limits/`, `/errors/`
- **[R-file]** `/file-endpoints/`, `/version-history-endpoints/`, `/comments-endpoints/`, `/users-endpoints/`
- **[R-team]** `/projects-endpoints/` (deprecated), `/folders-endpoints/`
- **[R-lib]** `/component-endpoints/`, `/library-analytics-endpoints/`
- **[R-var]** `/variables-endpoints/`
- **[R-dev]** `/dev-resources-endpoints/`, `/dev-resources-types/`
- **[R-org]** `/activity-logs-endpoints/`, `/ai-usage-endpoints/`, `/discovery-endpoints/`
- **[R-hook]** `/webhooks/`, `/webhooks-endpoints/`, `/webhooks-events/`, `/webhooks-security/`, `/webhooks-types/`

**(unverified)** marks what those pages don't state. Where something is marked unverified, the choice made there is ours and the text says so.

### 16.1 What Figma does (the facts this section implements)

**Host and auth** [R-auth]. Figma's host is `https://api.figma.com`. There are three kinds of token:
- **Personal access tokens.**
  - Sent in the header `X-Figma-Token`.
  - Made in Settings › Security, with scopes and an expiry.
  - Revoked at once; "last used" is shown.
- **OAuth apps.**
  - Sent as `Authorization: Bearer`.
  - Authorize at `www.figma.com/oauth` with `client_id`, `redirect_uri`, `scope`, `state`, `response_type=code`, and optional PKCE S256.
  - `POST /v1/oauth/token` with Basic client auth; the code is valid for 30 s. `POST /v1/oauth/refresh` refreshes.
  - Access tokens last 90 days.
  - Required for Activity Logs and Discovery.
- **Plan access tokens.**
  - For Organization and Enterprise plans, made by admins for the plan.
  - Optionally restricted; expire within a year.
  - The only tokens the AI usage API accepts.

Scopes never widen file, folder or org permissions.

**Scopes** [R-auth]:
- `current_user:read`, `file_content:read`, `file_metadata:read`
- `file_comments:read|write`, `file_dev_resources:read|write`, `file_variables:read|write`, `file_versions:read`
- `library_analytics:read`, `library_assets:read`, `library_content:read`, `team_library_content:read`
- `folders:read`, `folder_metadata:read`
- `webhooks:read|write`, `selections:read`
- `org:activity_log_read`, `org:ai_metering_usage_read`, `org:developer_log_read`, `org:discovery_read`
- Deprecated, still honoured for old tokens: `files:read`, `projects:read`, `project_metadata:read`.

**Rate limits** [R-rate] are per user (for an OAuth token, the token's user), per minute, by **tier** and seat.

| Tier | Endpoints | Full / Dev seats (Organization plan) | View / Collab seats |
|---|---|---|---|
| 1 | file, nodes, images | 20 a minute | "up to 20 a **month**" |
| 2 | comments, dev resources, image fills, folders / projects, variables GET, versions, webhooks | 100 a minute | 5 a minute |
| 3 | activity logs, components and styles, file and folder metadata, library analytics, users, POST variables | 150 a minute | 10 a minute |

Enterprise's numbers are not on the page. A 429 carries `Retry-After` (seconds), `X-Figma-Plan-Tier`, `X-Figma-Rate-Limit-Type` (`low` | `high`) and `X-Figma-Upgrade-Link`.

**Bodies**:
- File endpoints answer `{err, …}`; `GET /v1/images` answers `{err, images, status?}`.
- Library and variable endpoints answer `{status, error, meta}`.
- Activity logs answer `{status, error: false, i18n: null, meta}`.
- The errors page lists codes only (400, 403, 404, 429, 500), with no body. Which shape errors take is unverified; in practice Figma's own API answers `{status, err}` on the file routes.

**Endpoints**: listed with their shapes in §16.7, each from its page.

**Webhooks V2** [R-hook]: §16.9.

### 16.2 Decisions

| # | Topic | Decision |
|---|---|---|
| 1 | Host | The same Worker: `<server>/v1/…` and `<server>/v2/…` (today `https://designer.burak-kc-sp.workers.dev`). Figma's paths and field names exactly, so a Figma client works with its base URL swapped (the Code Connect CLI's `--api-url`, most SDKs' `baseUrl`). |
| 2 | Tokens | See the list after this table. |
| 3 | Scopes | Figma's names (§16.3). A PAT may hold `org:activity_log_read` only when an org admin made it; this is checked per request against the org asked for. |
| 4 | Rate limits | Figma's tiers. Full or Dev seats, and people outside orgs, get the **Organization Full / Dev** numbers (20 / 100 / 150 a minute). View and Collab seats get Figma's `low` numbers, except Tier 1 is **20 a day** (ours: "a month" would make the API useless to friends with View seats); Tier 2 is 5 and Tier 3 is 10 a minute. A **daily cap of 5,000 REST calls per person** (ours) keeps the API from eating the free plan's 100,000 Worker requests a day. Counted in D1 (`rest_rate`, one upsert per call; the free plan's 100,000 row writes a day allow it). |
| 5 | Errors | `/v1/files/…` and `/v1/images/…` answer `{status, err}`. Every other route answers `{status, error: true, message}`, with `i18n: null` where Figma shows it. Never the private API's `{error, code}`. |
| 6 | Document reads and renders | **Client render-and-cache by default** (the spike's option (b)). See the paragraph after this table. |
| 7 | Server render | **Behind a flag** (`REST_SERVER_RENDER=1`, which needs the Workers Paid plan). SVG and PDF come from a server build of the engine (`-sENVIRONMENT=web,worker`, `NullDevice`, the spike's measurements) in the file's Durable Object, for pages of ≤ 15,000 nodes; larger pages fall back to the client. **Specified, not built in round 5**: it needs an engine server build and the paid plan. `RenderBackend` (§16.6) is the seam. PNG / JPG never render on the server: the spike's option (c), a CPU rasterizer, is rejected. |
| 8 | What needs no client | Answered from D1 or the room's tables: metadata, image fills (our image hash *is* Figma's `imageRef`, the SHA-1 the room stores), comments, versions, components / styles / published variables (D1), dev resources, library analytics, activity logs, AI usage, folders / teams, webhooks. |
| 9 | Files outside orgs | Served when they are shared files with a room. Team and folder routes, and team / project webhooks, need orgs. Local-only files are not on the server: 404. |
| 10 | Image URLs | Figma returns expiring S3 links. Ours are `<server>/v1/blobs/:fileKey/:sha1.<ext>?exp=<unix s>&sig=<HMAC>`, which need no auth header, like S3's. Renders expire after **30 days**, image fills after **14 days** (Figma's numbers). |
| 11 | Webhook security | Figma's **passcode**, echoed in every payload. **Plus** (ours, harmless to Figma's receivers) `X-Designer-Signature: t=<unix s>,v1=<hex HMAC-SHA256(passcode, t + "." + body)>`, so a receiver can check the body too. |
| 12 | Webhook timing | Retries after 5 min, 30 min and 3 h (Figma's), run by a second Cron Trigger `*/5 * * * *` (the free plan allows five; round 3 uses one). `FILE_UPDATE` fires 30 minutes after the last edit, from the room's alarm (§16.10). |
| 13 | Ready-for-dev status | Figma has no REST route for it, only the plugin API's `devStatus` and the webhook. The editor reports each status change it commits (`POST /files/:key/dev-status`, docs/editor.md "Dev Mode — round 5" D-4). That one report feeds notifications and `DEV_MODE_STATUS_UPDATE`. |
| 14 | Not built | OAuth apps; `selections:read`; Discovery and Developer logs (Governance+, round 14); payments (no Community); avatar URLs in `/v1/files/:key/meta`'s `creator` (our avatars are data: URLs, so `img_url` is sent as `null`). |

**Decision 2, tokens.**
- **Personal access tokens** (§13, `dsgn_…`) are accepted in Figma's header `X-Figma-Token` and, as today, as `Authorization: Bearer`.
- **Plan access tokens** (`dsgn_plan_…`):
  - Made by org admins in Admin › Settings › **Plan access tokens** (location ours; Figma's page doesn't name it).
  - Scoped to one org.
  - May hold only `org:*`, `library_analytics:read`, and `webhooks:*` with `plan_api_id`.
  - Act as the org, with admin reach, for those routes only — never a file's content.
- **OAuth apps: not in round 5.**
  - Every caller here is the owner or a friend running their own script or CLI, and PATs serve them.
  - OAuth needs app registration, a consent page and client secrets, for no current caller.
  - `/v1/oauth/*` answers 404.
  - Where Figma *requires* OAuth (Activity Logs), we accept a plan access token, or an org admin's PAT with the scope (ours).

**Decision 6, document reads and renders.** The Worker can't decode a room's kiwi within the free plan's 10 ms of CPU. So `GET /v1/files/:key`, `/nodes`, `/v1/images/:key`, `variables/local` and `POST …/variables` are **jobs** that the room hands to a connected client of the file:
1. an editor first,
2. then a viewer,
3. then the desktop app's **render helper** (§16.6).

Results are cached by `(file, room seq | version, job, params)`, so each state renders once.

### 16.3 Tokens and scopes

`src/shared/account.ts` `TOKEN_SCOPES` grows to the rows below. The labels are ours; Figma's dialog wording is unverified.

| Scope | Group | Opens |
|---|---|---|
| `current_user:read` | Users | `GET /v1/me` |
| `file_content:read` | Files | `GET /v1/files/:key`, `/nodes`, `GET /v1/images/:key`, `/v1/files/:key/images` |
| `file_metadata:read` | Files | `GET /v1/files/:key/meta` |
| `file_versions:read` | Files | `GET /v1/files/:key/versions` |
| `file_comments:read` · `:write` | Comments | comments and reactions |
| `file_dev_resources:read` · `:write` | Dev resources | §16.7 dev resources |
| `file_variables:read` · `:write` | Variables | `GET …/variables/local\|published` · `POST …/variables` |
| `file_code_connect:write` | Code Connect | `POST` / `DELETE /v1/code_connect` (the id is ours: Figma's CLI asks for "Code Connect: Write" but its scope id is unpublished) |
| `library_assets:read` | Libraries | `GET /v1/components/:key`, `/component_sets/:key`, `/styles/:key` |
| `library_content:read` | Libraries | `GET /v1/files/:key/components\|component_sets\|styles` |
| `team_library_content:read` | Libraries | `GET /v1/teams/:id/components\|component_sets\|styles` |
| `library_analytics:read` | Libraries | `/v1/analytics/libraries/…` |
| `folders:read` (`projects:read` accepted) | Folders | `/v2/teams/:id/folders`, `/v2/folders/:id/folders\|files`, `/v1/teams/:id/projects`, `/v1/projects/:id/files` |
| `folder_metadata:read` (`project_metadata:read` accepted) | Folders | `/v2/folders/:id/meta`, `/v1/projects/:id/meta` |
| `webhooks:read` · `:write` | Webhooks | `/v2/webhooks…` |
| `org:activity_log_read` | Organization | `GET /v1/activity_logs` (org admins' PATs, plan tokens) |
| `org:ai_metering_usage_read` | Organization | `GET /v1/ai_usage/daily` (plan tokens only, as Figma) |

- **Private routes** keep `patAllows` (§13) unchanged.
- **`/v1` and `/v2`** check scopes per route in `server/src/rest/scopes.ts`: one table of route → scope(s) → tier.
- **Plan access tokens**:
  - Stored as `access_tokens.kind = 'plan'` with `org_id` set.
  - `user_id` is the admin who made it, kept when they leave: the token belongs to the org.
  - Routes (org admins only): `GET / POST /orgs/:org/admin/plan-tokens` and `DELETE /orgs/:org/admin/plan-tokens/:id`. The token is shown once; expiry is 1–365 days.
  - Logged as `plan_access_token_create` / `plan_access_token_delete` (ours).
  - `plan_api_id` is `organization-<orgId>` (Figma's form).
- Every `/v1` call moves the token's "Last used" (§13), at most once a minute.

### 16.4 Rate limits

**Counting.** `server/src/rest/rate.ts` `charge(deps, caller, tier)` runs one statement per bucket:

```sql
INSERT INTO rest_rate (subject, bucket, window, count) VALUES (?, ?, ?, 1)
ON CONFLICT DO UPDATE SET count = count + 1 RETURNING count
```

- `subject` is the user id, or `org:<id>` for a plan token.
- The **minute** bucket is `t1`, `t2` or `t3`, with window = `floor(now / 60000)`.
- The **day** bucket is `day`, with window = the UTC day.
- For `low` seats, Tier 1 also counts in `t1day`.

**Over the limit** → 429 with body `{status: 429, err: "Rate limit exceeded"}` and these headers:
- `Retry-After`: the seconds until the window ends.
- `X-Figma-Plan-Tier`: `enterprise` for orgs, `starter` outside them.
- `X-Figma-Rate-Limit-Type`: `high` or `low`, from the caller's best seat in the file's org; `high` outside orgs.
- No upgrade link.

**Housekeeping and edge cases:**
- The cron (`17 3 * * *`) deletes `rest_rate` rows older than two days.
- A render job counts once, when it is asked for. An answer served from the cache still counts as a call.

### 16.5 Conventions

- **Names and ids**:
  - Paths and query names are Figma's.
  - File keys are our room keys.
  - Node ids are `"1:2"` (our GUIDs as `sessionID:localID`, as Figma's).
  - Team, folder and org ids are our D1 ids (strings).
  - Webhook ids are numbers (Figma's).
- **Times**: ISO 8601 UTC strings where Figma uses them (`lastModified`, `created_at`, `updated_at`); Unix seconds in activity logs.
- **Writes**: a `GET` only reads D1 or the room. Nothing in `/v1` writes the document except `POST /v1/files/:key/variables`, and that goes through a client (§16.8).
- **CORS**: `/v1` and `/v2` answer any origin (`access-control-allow-origin: *`, no credentials), so a plugin UI or a docs page can call them with a token. Figma's API does the same.
- **Activity**:
  - Reads of org files log `fig_file_view` with `details.client_name = "REST API"`, at most once per token per file per hour (ours: whether Figma logs API reads is unverified).
  - Writes log as their private-API twins.

### 16.6 Render jobs: client render-and-cache

```
caller ─GET /v1/images/K?ids=…&format=png─▶ Worker ── checks token, scope, rate, resolveAccess (view) ──▶ FileRoom K
FileRoom: cache hit (job key) → links;  miss → pick a client ─{t:"rest-job", id, job}─▶ client (editor › viewer › helper)
client: runs the job on its engine ─PUT /files/K/rest-jobs/:id/parts/:name─▶ Worker ─▶ FileRoom (blob store, 1 MB chunks)
FileRoom answers the waiting Worker (≤ 25 s) → the caller gets {err: null, images: {id: url}}
```

**Job kinds** (`RestJob` in `src/shared/rest/types.ts`):

| Kind | Serves | Params |
|---|---|---|
| `file` | `GET /v1/files/:key` | `ids`, `depth`, `geometry`, `plugin_data`, `branch_data` |
| `nodes` | `GET /v1/files/:key/nodes` | as `file`, `ids` required |
| `images` | `GET /v1/images/:key` | `ids`, `scale`, `format`, the `svg_*` flags, `contents_only`, `use_absolute_bounds` |
| `variables_local` | `GET …/variables/local` | — |
| `variables_post` | `POST …/variables` | the request body (§16.8) |

Each kind may carry `version`, a room version id (data.md §15.7.1). The client then loads that version in a scratch engine (as Compare changes does) instead of the open document.

**Caching:**
- The **job key** is the SHA-1 of `{kind, params sorted, seq | version}`, where `seq` is the room's head when the job is asked for.
- `variables_post` is never cached.
- Results live in the room's `blobs` as `rest:<jobKey>[:<part>]`.
- They are dropped by an LRU once a room holds more than 64 MB of them (ours), and when older than 30 days.

**Who answers.** The room keeps a role and a `canRender` flag per socket; `canRender` means the client said `hello {render: true}` (an editor view with the file's engine loaded). The order of preference:
1. the `editor` socket that has been idle longest;
2. a `viewer`;
3. a **render helper** socket.

`variables_post` needs an editor, or a helper whose person can edit. If no one can answer, the Worker answers `503 {status: 503, err: "No client available to render this file. Open the file in DesignerV2 and try again."}`; for images that is `{err, images: {id: null}}`.

**The render helper** (desktop, `src/main/restHelper.ts`):
- Its setting is Settings › Account › "Answer API requests for my files while DesignerV2 is open" (ours). It is on by default for files the person owns, off for others.
- When a room has no client that can render, it posts `{t: "rest-wanted", fileKey}` to the inboxes of the file's owner and editors. §12's `Inbox` carries it live; it is never stored.
- Main, in an app with the setting on, opens a **hidden editor view** on the file. It has no tab, uses the spare-editor mechanism of docs/desktop.md §3.1, and is discarded after 5 minutes without jobs.
- That view joins the room with `render: true`.
- The first call waits for that start, within the 25 s total.

**Timeouts.** The room gives each client 20 s, then tries the next one. The Worker gives up at 25 s with the 503 above.

**Bytes:**
- The client gzips JSON results; `content-encoding: gzip` is passed through to a caller that accepts it.
- Images are sent as exported by E7's exporter: PNG / JPG / SVG / PDF, `scale` 0.01–4, with Figma's 32-megapixel cap (larger renders are scaled down).

**`RenderBackend`** (`server/src/rest/render.ts`) is `{ canRender(job): boolean; run(job): Promise<RestJobResult> }`, with two implementations:
- `ClientBackend` (round 5).
- `ServerBackend` (§16.2 decision 7): `images` with `svg` / `pdf`, plus `file` / `nodes`, when `REST_SERVER_RENDER=1` and the page has ≤ 15,000 nodes. Not built.

When the server backend is enabled, the room tries it first.

**Room protocol** (`src/shared/multiplayer/protocol.ts`, committed before the round):
- `hello.render?: boolean`.
- Server → client: `{t: "rest-job", id: string, job: RestJob}`.
- The client uploads each part with `PUT /files/:key/rest-jobs/:id/parts/:name` (bytes ≤ 64 MB each, SHA-1 checked).
- Client → server, after the uploads: `{t: "rest-job-done", id, parts: {name, sha1, size, contentType}[]}`, or `{t: "rest-job-failed", id, err}`.
- Inbox: `{t: "rest-wanted", fileKey}`.

**What the client computes** (`src/renderer/src/editor/rest/`, round 5b):
- **`fileJson.ts`**: the engine's document → Figma's REST JSON.
  - Node types: `DOCUMENT`, `CANVAS`, `FRAME`, `GROUP`, `SECTION`, `COMPONENT`, `COMPONENT_SET`, `INSTANCE`, `RECTANGLE`, `ELLIPSE`, `LINE`, `REGULAR_POLYGON`, `STAR`, `VECTOR`, `BOOLEAN_OPERATION`, `TEXT`, `SLICE`, `TABLE`… as built.
  - Node fields:
    - `absoluteBoundingBox` / `absoluteRenderBounds`, from the engine's derived boxes;
    - `fills` / `strokes` / `effects`, in Figma's Paint / Effect JSON (`nodeSpec.ts describePaints` is the start);
    - `characters` + `style` + `characterStyleOverrides` + `styleOverrideTable`;
    - `layoutMode` and the auto-layout fields, `constraints`;
    - `componentProperties`, `boundVariables`, `styles` (`{fill: styleKey}`);
    - `fillGeometry` / `strokeGeometry` with `geometry=paths` (SVG path strings from the engine's outlines);
    - `pluginData` / `sharedPluginData` (docs/plugins.md §8) with `plugin_data`.
  - Top level: `{name, role, lastModified, editorType: "figma", thumbnailUrl, version, document, components, componentSets, schemaVersion: 0, styles, mainFileKey?, branches?}`.
  - **Test corpus**: where available, the owner's sample files' JSON compared field by field with Figma's own `GET /v1/files` output for the same `.fig` (`docs/research/figma/samples/`). Differences are listed in the as-built section.
- **`images.ts`**: `engine_export` per id with the settings; `null` for an id that doesn't exist or exports nothing.
- **`variablesJson.ts`**: local variables in `GET …/variables/local`'s shape (§16.7), extended collections' fields included.
- **`variablesPost.ts`**: §16.8.

### 16.7 Endpoints

Every route needs a token (PAT or session) unless the table says otherwise. "view" and "edit" mean `resolveAccess` on the file. `T1`–`T3` are the rate-limit tiers.

**Files** (`server/src/rest/files.ts`):

| Route | Scope · tier · access | Answer |
|---|---|---|
| `GET /v1/files/:key?version&ids&depth&geometry=paths&plugin_data&branch_data` | `file_content:read` · T1 · view | job `file` → `{name, role, lastModified, editorType, thumbnailUrl, version, document, components, componentSets, schemaVersion, styles, mainFileKey?, branches?}`. `role` is `owner` \| `editor` \| `viewer`. With `branch_data=true`, `branches` is `{key, name, thumbnail_url, last_modified, link_access}[]` from D1 |
| `GET /v1/files/:key/nodes?ids&version&depth&geometry&plugin_data` | as above | job `nodes` → `{name, role, lastModified, editorType, thumbnailUrl, err, nodes: {id: {document, components, componentSets, schemaVersion, styles} \| null}}` |
| `GET /v1/images/:key?ids&scale&format&svg_outline_text&svg_include_id&svg_include_node_id&svg_simplify_stroke&contents_only&use_absolute_bounds&version` | as above | job `images` → `{err: null, images: {id: url \| null}, status?}`. Defaults are Figma's: `scale` 1, `format` png, `svg_outline_text` true, `svg_simplify_stroke` true, `contents_only` true |
| `GET /v1/files/:key/images` | `file_content:read` · T2 · view | no job: every `IMAGE` paint's hash in the room's `blobs` index → `{error: false, status: 200, meta: {images: {imageRef: url}}}`. The `meta` wrapper follows what Figma's API answers in practice; the page shows `images` alone (unverified) |
| `GET /v1/files/:key/meta` | `file_metadata:read` · T3 · view | D1 → `{file: {name, folder_name, last_touched_at, creator: {id, handle, img_url}, last_touched_by, thumbnail_url, editorType, version, role, link_access, url}}`. `url` is `<server>/f/<key>`. `link_access` is mapped from ours to Figma's `view` \| `edit` \| `org_view` \| `org_edit` \| `inherit` |
| `GET /v1/files/:key/versions?page_size&before&after` | `file_versions:read` · T2 · view | the room versions (data.md §15.7.1) → `{versions: {id, created_at, label, description, user: {id, handle, img_url}, thumbnail_url}[], pagination: {prev_page, next_page}}`. Ids are our version ids. `page_size` ≤ 50, default 30 (Figma's numbers unverified) |
| `GET /v1/files/:key/thumbnail` (ours, the target of `thumbnailUrl`) | signed URL | the PNG the store uploads with each snapshot (`PUT /files/:key/thumbnail`, editors only, ≤ 2 MB; round 5b) |

**Comments** (`rest/comments.ts`, over `server/src/comments.ts`'s functions). Figma's REST `Comment` is already our shape (`src/shared/comments.ts`).

| Route | Scope · tier | Answer |
|---|---|---|
| `GET /v1/files/:key/comments?as_md` | `file_comments:read` · T2 | `{comments: Comment[]}` (Figma's fields: `id, file_key, parent_id, user, created_at, resolved_at, message, client_meta, order_id, reactions`) |
| `POST /v1/files/:key/comments` | `file_comments:write` · T2 | `{message, comment_id?, client_meta?}` → the Comment. `client_meta` is a Vector `{x, y}`, FrameOffset `{node_id, node_offset}`, Region or FrameOffsetRegion, mapped to `CommentAnchor` |
| `DELETE /v1/files/:key/comments/:id` | write · T2 | `{status: 200, error: false}`; the author only |
| `GET /v1/files/:key/comments/:id/reactions?cursor` · `POST {emoji}` · `DELETE ?emoji=` | read · write · T2 | `{reactions, pagination}` · `{status: 200, error: false}`. Emoji are Figma's `:shortcode:`; `src/shared/comments.ts` maps them |

**People and folders** (`rest/teams.ts`):

| Route | Scope · tier | Answer |
|---|---|---|
| `GET /v1/me` | `current_user:read` · T3 | `{id, email, handle, img_url}` |
| `GET /v2/teams/:team/folders` | `folders:read` · T2 | `{folders: {id, name, parent_folder_id: null}[]}`: the top-level folders the caller can see |
| `GET /v2/folders/:id/folders` · `/v2/folders/:id/files?branch_data` | `folders:read` · T2 | `{folders: […]}` · `{files: {key, name, thumbnail_url, last_modified, branches?}[]}`. Figma's page shows no list shapes (unverified); ours mirror v1's |
| `GET /v2/folders/:id/meta` | `folder_metadata:read` · T3 | `{id, name, thumbnail_url, file_count, updated_at, created_at}` |
| `GET /v1/teams/:team/projects` · `GET /v1/projects/:id/files?branch_data` · `GET /v1/projects/:id/meta` | deprecated twins | `{name, projects: {id, name}[]}` · `{name, files: […]}` · as `/v2/folders/:id/meta` |

**Libraries** (`rest/libraries.ts`). Data: D1 `libraries` and `library_assets` (migration 0012), plus 0015's `node_id`, `created_at`, `updated_at`, `created_by`.

| Route | Scope · tier | Answer |
|---|---|---|
| `GET /v1/teams/:team/components\|component_sets\|styles?page_size&after&before` | `team_library_content:read` · T3 | `{status: 200, error: false, meta: {components\|component_sets\|styles: Item[], cursor: {before, after}}}`. `page_size` defaults to 30, max 1000. Lists the team's published libraries: scope team, plus org libraries published from the team's files |
| `GET /v1/files/:key/components\|component_sets\|styles` | `library_content:read` · T3 | the same for the file's library, without a cursor; 404 for a branch key |
| `GET /v1/components/:key` · `/v1/component_sets/:key` · `/v1/styles/:key` | `library_assets:read` · T3 | `{status, error, meta: Item}` |

- **`Item`** is `{key, file_key, node_id, thumbnail_url, name, description, updated_at, created_at, user: {id, handle, img_url}, containing_frame?: {name, nodeId, pageId, pageName, containingStateGroup?}}`. Styles add `{style_type: FILL | TEXT | EFFECT | GRID, sort_position}`.
- **Access**: `canUseLibrary` (data.md §16.4).
- **Local libraries** (the store's) are not on the server, so they are not listed.

**Variables** (`rest/variables.ts`). Figma restricts these to Enterprise full members; we serve anyone with the file access below.

| Route | Scope · tier · access | Answer |
|---|---|---|
| `GET /v1/files/:key/variables/local` | `file_variables:read` · T2 · view, plus a Full seat in orgs | job `variables_local` → `{status, error, meta: {variables: {id: Variable}, variableCollections: {id: Collection}}}` (fields below) |
| `GET /v1/files/:key/variables/published` | as above, no job | D1 `library_assets` (VARIABLE, VARIABLE_COLLECTION) → `{status, error, meta: {variables: {id: {id, subscribed_id, name, key, variableCollectionId, resolvedType, updatedAt}}, variableCollections: {id: {id, subscribed_id, name, key, updatedAt}}}}`. `id` is the GUID in the library file; `subscribed_id` is the asset key (ours) |
| `POST /v1/files/:key/variables` | `file_variables:write` · T3 · edit, plus a Full seat | job `variables_post` (§16.8) → `{status: 200, error: false, meta: {tempIdToRealId}}` |

The local answer's fields:
- **Variable**: `{id, name, key, variableCollectionId, resolvedType, valuesByMode, remote, description, hiddenFromPublishing, scopes, codeSyntax}`.
- **Collection**: `{id, name, key, modes: {modeId, name, parentModeId?}[], defaultModeId, remote, hiddenFromPublishing, variableIds}`, plus the extension fields `isExtension, parentVariableCollectionId, rootVariableCollectionId, inheritedVariableIds, localVariableIds, variableOverrides`, and `deletedButReferenced`.

**Dev resources** (`rest/devResources.ts`, over 5c's `server/src/devmode/`). Figma's shapes; main file keys only.

| Route | Scope · tier · access | Answer |
|---|---|---|
| `GET /v1/files/:key/dev_resources?node_ids` | `file_dev_resources:read` · T2 · view | `{dev_resources: {id, name, url, file_key, node_id}[]}` |
| `POST /v1/dev_resources` | `:write` · T2 · edit per file, plus a Full / Dev seat in orgs | `{dev_resources: {name, url, file_key, node_id}[]}` → `{links_created: DevResource[], errors: {file_key, node_id, error}[]}`. Answers 200 with per-item errors: more than 10 per node, a URL already on the node, a branch key, no access |
| `PUT /v1/dev_resources` | `:write` · T2 | `{dev_resources: {id, name?, url?}[]}` → `{links_updated: string[], errors: {id, error}[]}` |
| `DELETE /v1/files/:key/dev_resources/:id` | `:write` · T2 | 200 with an empty body; 404 when missing |

**Code Connect** (ours: the endpoint Figma's CLI calls is unpublished; docs/editor.md D-1). Scope `file_code_connect:write`, T3, edit access to the library file.

| Route | Body → answer |
|---|---|
| `POST /v1/code_connect` | `{docs: CodeConnectDoc[]}` → `{published: {nodeId, fileKey, label, url}[], errors}` |
| `DELETE /v1/code_connect` | `{label, nodes?: {fileKey, nodeId}[]}` → `{removed}` |
| `GET /v1/files/:key/code_connect?label` | → `{docs}`; needs `file_content:read`, T3 |

5c implements these in `server/src/devmode/codeConnect.ts`, dispatched from `/v1`.

**As built (5c, 2026-10-11)** — `server/src/devmode/rest.ts` `devModeRestRoute(req, url, deps, caller, parts)`. `parts` may start with `"v1"` or not. It returns null for any other path. 5a's `restRoute` checks scope, tier and rate first. Answers:
- Errors are Figma's `{status, err}` (the 404 is "File not found").
- A branch key is refused (400).
- Access: `resolveAccess` by the link, with no password pass. Prototype-only callers can't read (403). Writes need `canWriteDev` (docs/editor.md D-3 "As built").
- `POST /v1/dev_resources` reports per-item errors as `{file_key, node_id, error}`. `PUT` reports them as `{id, error}`. `DELETE` answers 200 with an empty body.
- **Code Connect**:
  - `POST /v1/code_connect` accepts our links and Figma's (`/f|file|design|proto/<key>/…?node-id=1-2`, `1:2`, `1%3A2`). Each doc is upserted as `origin: "cli"`, replacing a UI mapping of the same label. Limits: ≤ 500 docs per call, templates ≤ 256 kB. It answers `{published: [{nodeId, fileKey, label, url: <origin>/f/<key>?node-id=1-2}], errors: [{url, label, error}]}`.
  - `DELETE /v1/code_connect {label, nodes?: ({fileKey, nodeId} | {url})[]}` answers `{removed: [{fileKey, nodeId, label}], errors}`. It removes CLI mappings only. Without `nodes`, it removes the label's CLI mappings that the caller last published (ours).
  - `GET /v1/files/:key/code_connect?label` answers `{docs}`. Each doc is a `CodeConnectDoc` plus `origin`. Readers: view access, or the library's users.
  - Logged as one `code_connect_publish` / `_unpublish` per file and call.
- Not built: the pre-round `patAllows` stays unchanged for the private `/files/:key/dev-resources…` routes. A PAT can't use them; the CLI and integrations use `/v1`.

**Library analytics** (`rest/analytics.ts`). It reuses `server/src/analytics/query.ts` with Figma's names (data.md §17.6).

| Route | Params | Rows |
|---|---|---|
| `GET /v1/analytics/libraries/:key/component/actions` | `group_by=component\|team` (required), `start_date`, `end_date` (YYYY-MM-DD, rounded to Sunday weeks), `cursor` | `{week, insertions, detachments}` plus either `component_key, component_name, component_set_key, component_set_name` or `team_name, workspace_name` |
| `…/component/usages` | `group_by=component\|file`, `cursor` | `{usages, files_using, teams_using}` plus the component's fields, or `{usages, team_name, workspace_name, file_name}` ("File not visible") |
| `…/style/actions` · `…/style/usages` · `…/variable/actions` · `…/variable/usages` | as Figma's: `style\|team`, `style\|file`, `variable\|team`, `variable\|file` | style: `style_key, style_name, style_type`; variable: `variable_key, variable_name, variable_type, collection_key, collection_name` |

- **Answer**: `{rows, next_page: boolean, cursor}`.
- **Scope**: `library_analytics:read`, T3.
- **Callers**: as data.md §17.6, org members who can view the library's file. A plan token may read any library of its org.
- **Rows**: only weeks with data, newest first, a year at most.

**Organization** (`rest/org.ts`):

| Route | Scope · tier · who | Answer |
|---|---|---|
| `GET /v1/activity_logs?events&start_time&end_time&limit&order&cursor&org_id` | `org:activity_log_read` · T3 · a plan token, or an org admin's PAT (`org_id` is required if they admin several orgs) | `{status: 200, error: false, i18n: null, meta: {activity_logs: ActivityLog[], cursor, next_page}}`: §14.10's rows. `limit` ≤ 1000 (default 1000); `order` defaults to asc; `start_time` defaults to a year ago |
| `GET /v1/ai_usage/daily?start_date&end_date&user_email&limit&cursor` | `org:ai_metering_usage_read` · T3 · plan tokens only (403 otherwise, as Figma) | `{rows, next_cursor, has_next_page}` from `ai_usage_daily` (0015); row fields below |

The AI usage rows have `{plan_id, user_id, user_email, day, editor_type, seat_credits_sum, plan_credits_sum, workspace_id, workspace_name, team_id, team_name, license_group_id, license_group_name, metering_period_start, metering_period_end}`. The table is **filled by round 6** (the agents' usage meter) and is empty until then.

**Webhooks**: §16.9.

### 16.8 `POST /v1/files/:key/variables`

**Figma's request** [R-var] is `{variableCollections?, variableModes?, variables?, variableModeValues?}`.
- **Order and atomicity**:
  - Applied in that order, and in array order within each.
  - `action` is `CREATE`, `UPDATE` or `DELETE`.
  - Temporary ids on CREATE can be referenced later in the same body.
  - All or nothing.
- **Limits**:
  - The body is at most 4 MB (413 over it).
  - 40 modes per collection. Ours stays at our own cap of 1,000 (data.md §16.8).
  - 5,000 variables per collection.
- **Rules**:
  - Names are unique per collection and may not contain `.{}`.
  - `resolvedType` is fixed at creation.
  - Remote collections are read-only.
  - No alias cycles.
- **Extended collections**:
  - They take `initialModeIdToParentModeIdMapping`.
  - No new variables or modes.
  - A `null` value removes an override in an extended mode.

**How we apply it:**
1. **The Worker** validates the body's **shape** (`src/shared/rest/variablesPost.ts validateShape`, pure; 400 with Figma's messages) and hands it to an editor client as job `variables_post`.
2. **The client** (`editor/rest/variablesPost.ts`, 5b) validates the body against the document with `validateAgainst`.
3. **The client applies it** as **one engine actor write**:
   - `engine_actor_begin {actor: <rest actor>, label: "REST API: Update variables", undoTo: 0}`;
   - through the editor's variable model (`editor/variables.ts`);
   - one step in the user history of the client that carried it (docs/engine.md §9.5);
   - nothing changes that person's selection or page.
4. **The answer** is `{tempIdToRealId}`.

**After the write:**
- Its frames reach the room as that client's edits.
- The activity log names the **token's** person: `file_variables_update` (ours; Figma's action name is unverified).
- On failure the answer is 400 `{status: 400, error: true, message}`, and nothing is applied.
- A `GET …/variables/local` right after a POST sees the change, because the job key's `seq` moved.

### 16.9 Webhooks V2

Figma's model [R-hook], stored in the D1 tables `webhooks` and `webhook_requests` (§16.12).

| Route | Scope · tier · who | Body → answer |
|---|---|---|
| `POST /v2/webhooks` | `webhooks:write` · T2 · team context: team admins; project (folder): editors of the folder; file: "can edit" | `{event_type, context: "team" \| "project" \| "file", context_id, endpoint (≤ 2048), passcode (≤ 100), status?: "ACTIVE" \| "PAUSED", description? (≤ 150)}` → `WebhookV2`; sends `PING` at once |
| `GET /v2/webhooks?context&context_id` · `?plan_api_id&cursor` | `webhooks:read` · T2 | `{webhooks: WebhookV2[], pagination: {next_page?, prev_page?}}`. With `plan_api_id` = `organization-<id>`: every webhook of the org, for org admins and plan tokens |
| `GET /v2/webhooks/:id` | read · T2 · its creator, admins of its context | `WebhookV2` (`passcode: ""`) |
| `PUT /v2/webhooks/:id` | write · T2 | `{event_type?, endpoint?, passcode?, status?, description?}` (`""` clears the description) → `WebhookV2` |
| `DELETE /v2/webhooks/:id` | write · T2 | → the deleted `WebhookV2` |
| `GET /v2/webhooks/:id/requests` | read · T2 | `{requests: {webhook_id, request_info: {endpoint, payload, sent_at}, response_info: {status, received_at} \| null, error_msg: string \| null}[]}`: the last 7 days |

**`WebhookV2`** is `{id: number, event_type, context: "PROJECT" | "TEAM" | "FILE", context_id, team_id ("" for file / project contexts), plan_api_id, status: "ACTIVE" | "PAUSED", client_id: null, passcode, endpoint, description: string | null}`.

**Limits:**
- Figma's: 20 per team, 5 per folder, 3 per file; 600 file webhooks per org (Enterprise).
- Outside orgs (ours): file context only, 3 per file, 20 per person.

**Delivery reach:**
- A team webhook fires for files in the team's folders that are open to the team (`access = inherited`), not in Limited folders (Figma's).
- A folder webhook fires for its files and for its subfolders' files (subfolders: ours, unverified).
- A file webhook fires for that file and its branches (branches: ours, unverified).

**Events and payloads.** Every payload has `{event_type, passcode, timestamp (ISO 8601 UTC), webhook_id}`, plus:

| Event | Extra fields | Raised by |
|---|---|---|
| `PING` | — | `POST /v2/webhooks` |
| `FILE_UPDATE` | `file_key, file_name` | the room's alarm, 30 min after the last edit of a burst (§16.10) |
| `FILE_VERSION_UPDATE` | `file_key, file_name, created_at, version_id, label, description, triggered_by: User` | a **named** version: `POST /files/:key/versions` with `kind: named`, or a `PATCH` naming an autosave (data.md §15.7.1) |
| `FILE_DELETE` | `file_key, file_name, triggered_by` | `DELETE /files/:key`: for org files the permanent delete; outside orgs, stop sharing. Trashing doesn't fire it (unverified) |
| `LIBRARY_PUBLISH` | `file_key, file_name, description, created_components, modified_components, deleted_components, created_styles, …_styles, created_variables, …_variables` (`LibraryItemData {key, name}[]`), `triggered_by` | `POST /libraries/:key/versions` (data.md §16.10). **One event per asset type** that changed, split above 200 items each (Figma says "hundreds"; 200 is ours) |
| `FILE_COMMENT` | `file_key, file_name, comment: CommentFragment[] ({text} \| {mention: userId}), comment_id, mentions: User[], order_id (top-level only), parent_id, created_at, resolved_at, triggered_by` | `POST /files/:key/comments` and `/v1/…/comments` |
| `DEV_MODE_STATUS_UPDATE` | `file_key, node_id, status: "NONE" \| "READY_FOR_DEV" \| "COMPLETED", change_message, related_links: DevResource[], triggered_by` | `POST /files/:key/dev-status` (docs/editor.md D-4) |

`User` is `{id, handle, img_url: null}`.

**Sending** (`server/src/webhooks/deliver.ts`). `emitWebhook(deps, event, ctx: {fileKey, orgId, teamId, projectId})` is the stub committed before the round (§16.13). It:
1. selects the matching ACTIVE webhooks: the file's, then its folder chain's, then its team's;
2. writes one `webhook_requests` row for each (`attempt 0`, `next_at = now`);
3. sends them in `ctx.waitUntil`:
   - `POST endpoint`;
   - headers `content-type: application/json`, `user-agent: DesignerV2-Webhooks/1`, and `X-Designer-Signature` (§16.2 decision 11);
   - 10 s timeout.

**Retries:**
- **Only 200 counts as success** (Figma's rule).
- A failure sets `next_at` to +5 min, +30 min and +3 h for attempts 1–3; after that it gives up.
- The `*/5` cron sends what is due, at most 50 per run; the rest wait for the next run.
- Webhooks with constant errors are not paused (Figma says it "currently" doesn't pause them).
- `GET …/requests` reads the rows. The cron deletes rows older than 7 days.

**Endpoint rules**: `https://` only. `http://localhost…` is refused in production (a Worker can't reach it anyway). Private IP literals are refused.

**Activity** (org webhooks): `webhook_create`, `webhook_update`, `webhook_delete` (ours; Figma doesn't publish the names in its "Webhooks" event group).

### 16.10 Where events come from (the server pieces outside `rest/`)

**FILE_UPDATE** comes from the room:
- `RoomBox` keeps `webhook_dirty_at`, the first unreported edit. Each edit moves `webhook_due` to last edit + 30 min.
- The object's alarm fires it. The alarm is already used by autosave (data.md §15.7.1); there is one alarm, and the earliest due time wins.
- The alarm reports the event in one of two ways (5a chooses; both have D1):
  - `POST <worker>/internal/webhooks {event: "FILE_UPDATE", fileKey}` through `env`, to the Worker's handler. The handler is guarded by a header only the object sets: `x-internal: <HMAC(SESSION_SECRET, body)>`.
  - Or `emitWebhook` called directly with the object's own `env.DB`.
- Only when the file has a matching webhook. The room asks D1 once at wake (`SELECT 1 FROM webhooks …` for its file, folder and team) and caches the answer for 5 minutes.

**FILE_VERSION_UPDATE, LIBRARY_PUBLISH, FILE_COMMENT, FILE_DELETE**: one `emitWebhook` call after the write succeeds — in `branches.ts` / the versions routes, `libraries/routes.ts`, `comments.ts` and `api.ts` respectively.

**DEV_MODE_STATUS_UPDATE**: 5c's `devmode/status.ts`.

**Library items**: `library_assets` gains `node_id`, `created_at`, `updated_at` and `created_by` (0015). `POST /libraries/:key/versions` writes them from the manifest's `guid` (data.md §9.1). Rows from earlier publishes stay null until the next publish, so REST answers `node_id: null` for them.

### 16.11 Activity log (round 5's actions)

**Figma's names** [F-log action types], where they exist:

| Group | Actions |
|---|---|
| Private plugins and widgets | `private_plugin_publish`, `private_plugin_update`, `private_plugin_delete`, `private_widget_publish`, `private_widget_update`, `private_widget_delete` |
| Plugin approvals | `plugin_approvelist_enable`, `plugin_approvelist_disable`, `plugin_approvelist_add`, `plugin_approvelist_add_workspace`, `plugin_approvelist_remove`, `plugin_approvelist_remove_workspace`, `plugin_approvelist_request_org`, `plugin_approvelist_request_approve_org`, `plugin_approvelist_request_reject_org`, `plugin_approvelist_request_approve_workspace`, `plugin_approvelist_request_reject_workspace` |
| Widget approvals | `widgets_enabled`, `widgets_disable`, `widget_approvelist_add`, `widget_approvelist_add_workspace`, `widget_approvelist_remove`, `widget_approvelist_remove_workspace`, `widget_approvelist_request_org`, `widget_approvelist_request_approve_org`, `widget_approvelist_request_reject_org`, `widget_approvelist_request_approve_workspace`, `widget_approvelist_request_reject_workspace` |

**Ours** (Figma's are unpublished): `plan_access_token_create`, `plan_access_token_delete`, `webhook_create`, `webhook_update`, `webhook_delete`, `file_variables_update`, `dev_resource_create`, `dev_resource_delete`, `code_connect_publish`, `code_connect_unpublish`.

The entity types `plugin` / `widget` (§14.10) carry `{id, name}`.

### 16.12 D1: migration `server/migrations/0015_extensibility.sql`

The latest migration is `0014_idle_sessions.sql` (round 4e). The main session commits this text verbatim before the round, as round 4 did. No agent edits `server/migrations/` in round 5.

```sql
-- Extensibility and Dev Mode (docs/multiplayer.md §16, docs/plugins.md, docs/editor.md "Dev Mode — round 5"): the REST
-- API's plan tokens and rate counters, webhooks, dev resources, Code Connect, Dev Mode viewers, prototype-only
-- members, private plugins and approvals, the AI usage table round 6 fills. Times are ms since the epoch.

-- Plan access tokens (§16.3) are access_tokens rows of kind 'plan' for one org; user_id = the admin who made it.
ALTER TABLE access_tokens ADD COLUMN kind TEXT NOT NULL DEFAULT 'personal' CHECK (kind IN ('personal', 'plan'));
ALTER TABLE access_tokens ADD COLUMN org_id TEXT REFERENCES orgs (id) ON DELETE CASCADE;
CREATE INDEX access_tokens_org ON access_tokens (org_id) WHERE org_id IS NOT NULL;

-- REST rate counters (§16.4): subject = user id or 'org:<id>'; bucket t1 | t2 | t3 | t1day | day; window = minute
-- number or UTC day number.
CREATE TABLE rest_rate (
  subject TEXT NOT NULL,
  bucket  TEXT NOT NULL,
  window  INTEGER NOT NULL,
  count   INTEGER NOT NULL,
  PRIMARY KEY (subject, bucket, window)
);

-- Webhooks V2 (§16.9). Ids are numbers, as Figma's. context_id: team, folder (project) or file key.
CREATE TABLE webhooks (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type  TEXT NOT NULL CHECK (event_type IN ('FILE_UPDATE', 'FILE_VERSION_UPDATE', 'FILE_DELETE', 'LIBRARY_PUBLISH', 'FILE_COMMENT', 'DEV_MODE_STATUS_UPDATE')),
  context     TEXT NOT NULL CHECK (context IN ('team', 'project', 'file')),
  context_id  TEXT NOT NULL,
  org_id      TEXT REFERENCES orgs (id) ON DELETE CASCADE,
  team_id     TEXT,
  endpoint    TEXT NOT NULL,
  passcode    TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'PAUSED')),
  description TEXT,
  created_by  TEXT REFERENCES users (id) ON DELETE SET NULL,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX webhooks_context ON webhooks (context, context_id, event_type);
CREATE INDEX webhooks_org ON webhooks (org_id);

-- One row per delivery (the log of GET /v2/webhooks/:id/requests and the retry queue). next_at null: done.
CREATE TABLE webhook_requests (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  webhook_id  INTEGER NOT NULL REFERENCES webhooks (id) ON DELETE CASCADE,
  endpoint    TEXT NOT NULL,
  payload     TEXT NOT NULL,
  sent_at     INTEGER,
  attempt     INTEGER NOT NULL DEFAULT 0,
  status      INTEGER,
  received_at INTEGER,
  error_msg   TEXT,
  next_at     INTEGER,
  created_at  INTEGER NOT NULL
);
CREATE INDEX webhook_requests_due ON webhook_requests (next_at) WHERE next_at IS NOT NULL;
CREATE INDEX webhook_requests_hook ON webhook_requests (webhook_id, created_at);

-- Dev resources (docs/editor.md D-3): links on a node of a shared file; ≤ 10 per node, a URL once per node.
CREATE TABLE dev_resources (
  id         TEXT PRIMARY KEY,
  file_key   TEXT NOT NULL REFERENCES files (key) ON DELETE CASCADE,
  node_id    TEXT NOT NULL,
  name       TEXT NOT NULL,
  url        TEXT NOT NULL,
  created_by TEXT REFERENCES users (id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (file_key, node_id, url)
);
CREATE INDEX dev_resources_node ON dev_resources (file_key, node_id);

-- Code Connect (docs/editor.md D-1): one mapping per (library file, main component or set node, label). template:
-- the template file's JavaScript (CLI), null for a Code Connect UI mapping (source + component only).
CREATE TABLE code_connect (
  file_key     TEXT NOT NULL REFERENCES files (key) ON DELETE CASCADE,
  node_id      TEXT NOT NULL,
  label        TEXT NOT NULL,
  language     TEXT NOT NULL,
  origin       TEXT NOT NULL CHECK (origin IN ('cli', 'ui')),
  source       TEXT,
  component    TEXT,
  template     TEXT,
  imports      TEXT NOT NULL DEFAULT '[]',
  nestable     INTEGER NOT NULL DEFAULT 1,
  instructions TEXT NOT NULL DEFAULT '',
  updated_by   TEXT REFERENCES users (id) ON DELETE SET NULL,
  updated_at   INTEGER NOT NULL,
  PRIMARY KEY (file_key, node_id, label)
);

-- Who viewed a file in Dev Mode (notified of status changes, docs/editor.md D-4) and their choice: 1 "Status
-- changes", 0 "Nothing".
CREATE TABLE dev_mode_viewers (
  file_key  TEXT NOT NULL REFERENCES files (key) ON DELETE CASCADE,
  user_id   TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  viewed_at INTEGER NOT NULL,
  notify    INTEGER NOT NULL DEFAULT 1 CHECK (notify IN (0, 1)),
  PRIMARY KEY (file_key, user_id)
);
CREATE INDEX dev_mode_viewers_user ON dev_mode_viewers (user_id);

-- Prototype-only access (docs/editor.md D-6): people invited from "Share prototype", and the org audience of the
-- prototype link (files.proto_link_access, 0010, stays "Anyone").
CREATE TABLE prototype_members (
  file_key   TEXT NOT NULL REFERENCES files (key) ON DELETE CASCADE,
  email      TEXT NOT NULL,
  user_id    TEXT REFERENCES users (id) ON DELETE CASCADE,
  invited_by TEXT REFERENCES users (id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (file_key, email)
);
CREATE INDEX prototype_members_user ON prototype_members (user_id);
ALTER TABLE files ADD COLUMN proto_org_link_access TEXT NOT NULL DEFAULT 'none' CHECK (proto_org_link_access IN ('none', 'viewer'));

-- Library items for the REST API (§16.7, §16.10): the asset's node in the library file and its dates.
ALTER TABLE library_assets ADD COLUMN node_id TEXT;
ALTER TABLE library_assets ADD COLUMN created_at INTEGER;
ALTER TABLE library_assets ADD COLUMN updated_at INTEGER;
ALTER TABLE library_assets ADD COLUMN created_by TEXT;

-- Private plugins and widgets of an org (docs/plugins.md §10). id: a 19-digit decimal string, as Figma's plugin ids.
CREATE TABLE plugins (
  id           TEXT PRIMARY KEY,
  org_id       TEXT NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
  kind         TEXT NOT NULL CHECK (kind IN ('plugin', 'widget')),
  name         TEXT NOT NULL,
  description  TEXT NOT NULL DEFAULT '',
  -- the manifest as published (docs/plugins.md §4), with id set to this row's id
  manifest     TEXT NOT NULL,
  version      INTEGER NOT NULL,
  -- {sha1, size} per part: code, ui[:key]
  parts        TEXT NOT NULL,
  published_by TEXT REFERENCES users (id) ON DELETE SET NULL,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  deleted_at   INTEGER
);
CREATE INDEX plugins_org ON plugins (org_id, kind) WHERE deleted_at IS NULL;

-- Plugin code and UI in ≤ 1 MB chunks (no Durable Object: a few MB per plugin).
CREATE TABLE plugin_chunks (
  plugin_id TEXT NOT NULL REFERENCES plugins (id) ON DELETE CASCADE,
  version   INTEGER NOT NULL,
  part      TEXT NOT NULL,
  idx       INTEGER NOT NULL,
  bytes     BLOB NOT NULL,
  PRIMARY KEY (plugin_id, version, part, idx)
);

-- Admin-approved plugins and widgets (docs/plugins.md §10.2). plugin_id: any manifest id (not only private ones).
CREATE TABLE plugin_approvals (
  org_id     TEXT NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
  plugin_id  TEXT NOT NULL,
  kind       TEXT NOT NULL CHECK (kind IN ('plugin', 'widget')),
  name       TEXT NOT NULL,
  scope_type TEXT NOT NULL CHECK (scope_type IN ('org', 'workspace')),
  scope_id   TEXT NOT NULL,
  added_by   TEXT REFERENCES users (id) ON DELETE SET NULL,
  added_at   INTEGER NOT NULL,
  PRIMARY KEY (org_id, plugin_id, scope_type, scope_id)
);

CREATE TABLE plugin_requests (
  id             TEXT PRIMARY KEY,
  org_id         TEXT NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
  plugin_id      TEXT NOT NULL,
  kind           TEXT NOT NULL CHECK (kind IN ('plugin', 'widget')),
  name           TEXT NOT NULL,
  -- the manifest the requester has (development / imported plugins), so admins see what it asks for
  manifest       TEXT NOT NULL DEFAULT '{}',
  requested_by   TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  workspace_id   TEXT,
  reason         TEXT NOT NULL DEFAULT '',
  state          TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'approved', 'declined')),
  decline_reason TEXT NOT NULL DEFAULT '',
  created_at     INTEGER NOT NULL,
  answered_at    INTEGER,
  answered_by    TEXT REFERENCES users (id) ON DELETE SET NULL
);
CREATE INDEX plugin_requests_org ON plugin_requests (org_id, state);

-- AI usage per person and day (§16.7 GET /v1/ai_usage/daily), filled by round 6's usage meter.
CREATE TABLE ai_usage_daily (
  org_id           TEXT NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
  user_id          TEXT NOT NULL,
  day              TEXT NOT NULL,
  editor_type      TEXT NOT NULL,
  seat_credits     REAL NOT NULL DEFAULT 0,
  plan_credits     REAL NOT NULL DEFAULT 0,
  workspace_id     TEXT,
  team_id          TEXT,
  billing_group_id TEXT,
  PRIMARY KEY (org_id, user_id, day, editor_type)
);
```

Notes:
- No new Durable Object class, so no wrangler migration tag.
- `wrangler.jsonc` `triggers.crons` gains `"*/5 * * * *"` (webhook retries). `scheduled()` tells the two crons apart by `event.cron`.
- The plugin org settings (`pluginApproval` …) live in the `orgs.settings` JSON (§16.13).
- `REST_SERVER_RENDER` is a var, left unset.

### 16.13 Shared types (committed verbatim before round 5)

**`src/shared/rest/types.ts`** (new):

```ts
/** Figma's REST API on our Worker (docs/multiplayer.md §16). Wire shapes are Figma's; field names snake_case where Figma's are. */
export type RestTier = 1 | 2 | 3;
export type RestScope =
  | "current_user:read" | "file_content:read" | "file_metadata:read" | "file_versions:read"
  | "file_comments:read" | "file_comments:write" | "file_dev_resources:read" | "file_dev_resources:write"
  | "file_variables:read" | "file_variables:write" | "file_code_connect:write"
  | "library_assets:read" | "library_content:read" | "team_library_content:read" | "library_analytics:read"
  | "folders:read" | "folder_metadata:read" | "projects:read" | "project_metadata:read"
  | "webhooks:read" | "webhooks:write" | "org:activity_log_read" | "org:ai_metering_usage_read";
/** Scopes a plan access token may hold (§16.3) */
export const PLAN_TOKEN_SCOPES: readonly RestScope[] = ["org:activity_log_read", "org:ai_metering_usage_read", "library_analytics:read", "webhooks:read", "webhooks:write"];
/** Per-minute limits by tier (§16.2 decision 4): Figma's Organization numbers; low seats' Tier 1 is per day (ours) */
export const RATE_LIMITS = { high: { 1: 20, 2: 100, 3: 150 }, low: { 1: 20, 2: 5, 3: 10 }, lowTier1PerDay: true, dailyCap: 5000 } as const;

// ---- render jobs (§16.6) ----
export interface ImagesParams { ids: string[]; scale: number; format: "jpg" | "png" | "svg" | "pdf"; svg_outline_text: boolean; svg_include_id: boolean; svg_include_node_id: boolean; svg_simplify_stroke: boolean; contents_only: boolean; use_absolute_bounds: boolean }
export interface FileParams { ids?: string[]; depth?: number; geometry?: "paths"; plugin_data?: string[]; branch_data?: boolean }
export type RestJob =
  | { kind: "file"; params: FileParams; version?: string }
  | { kind: "nodes"; params: FileParams & { ids: string[] }; version?: string }
  | { kind: "images"; params: ImagesParams; version?: string }
  | { kind: "variables_local"; version?: string }
  | { kind: "variables_post"; body: VariablesPostBody; actorUserId: string };
export interface RestJobPart { name: string; sha1: string; size: number; contentType: string }
/** images: one part per id (name = the node id), absent = null; file / nodes / variables_*: one part "json" (gzip) */
export type RestJobResult = { ok: true; parts: RestJobPart[] } | { ok: false; status: number; err: string };

// ---- variables (§16.7, §16.8) ----
export type VariableAction = "CREATE" | "UPDATE" | "DELETE";
export type RestResolvedType = "BOOLEAN" | "FLOAT" | "STRING" | "COLOR";
export interface RestColor { r: number; g: number; b: number; a: number }
export interface RestVariableAlias { type: "VARIABLE_ALIAS"; id: string }
export type RestVariableValue = boolean | number | string | RestColor | RestVariableAlias | null;
export interface VariablesPostBody {
  variableCollections?: { action: VariableAction; id: string; name?: string; initialModeId?: string; parentVariableCollectionId?: string; initialModeIdToParentModeIdMapping?: Record<string, string>; hiddenFromPublishing?: boolean }[];
  variableModes?: { action: VariableAction; id: string; name?: string; variableCollectionId: string }[];
  variables?: { action: VariableAction; id: string; name?: string; variableCollectionId?: string; resolvedType?: RestResolvedType; description?: string; hiddenFromPublishing?: boolean; scopes?: string[]; codeSyntax?: { WEB?: string; ANDROID?: string; iOS?: string } }[];
  variableModeValues?: { variableId: string; modeId: string; value: RestVariableValue }[];
}

// ---- dev resources (§16.7) ----
export interface DevResource { id: string; name: string; url: string; file_key: string; node_id: string }
export interface DevResourceCreate { name: string; url: string; file_key: string; node_id: string }
export interface DevResourceUpdate { id: string; name?: string; url?: string }
export const DEV_RESOURCES_PER_NODE = 10;

// ---- webhooks (§16.9) ----
export type WebhookEventType = "PING" | "FILE_UPDATE" | "FILE_VERSION_UPDATE" | "FILE_DELETE" | "LIBRARY_PUBLISH" | "FILE_COMMENT" | "DEV_MODE_STATUS_UPDATE";
export type WebhookContext = "team" | "project" | "file";
export interface WebhookV2 { id: number; event_type: Exclude<WebhookEventType, "PING">; context: "TEAM" | "PROJECT" | "FILE"; context_id: string; team_id: string; plan_api_id: string; status: "ACTIVE" | "PAUSED"; client_id: null; passcode: string; endpoint: string; description: string | null }
export interface RestUser { id: string; handle: string; img_url: string | null }
export interface LibraryItemData { key: string; name: string }
export type CommentFragment = { text: string } | { mention: string };
export type WebhookEvent =
  | { event_type: "PING" }
  | { event_type: "FILE_UPDATE"; file_key: string; file_name: string }
  | { event_type: "FILE_DELETE"; file_key: string; file_name: string; triggered_by: RestUser }
  | { event_type: "FILE_VERSION_UPDATE"; file_key: string; file_name: string; created_at: string; version_id: string; label: string; description: string; triggered_by: RestUser }
  | { event_type: "LIBRARY_PUBLISH"; file_key: string; file_name: string; description: string; created_components: LibraryItemData[]; modified_components: LibraryItemData[]; deleted_components: LibraryItemData[]; created_styles: LibraryItemData[]; modified_styles: LibraryItemData[]; deleted_styles: LibraryItemData[]; created_variables: LibraryItemData[]; modified_variables: LibraryItemData[]; deleted_variables: LibraryItemData[]; triggered_by: RestUser }
  | { event_type: "FILE_COMMENT"; file_key: string; file_name: string; comment: CommentFragment[]; comment_id: string; mentions: RestUser[]; order_id: string | null; parent_id: string | null; created_at: string; resolved_at: string | null; triggered_by: RestUser }
  | { event_type: "DEV_MODE_STATUS_UPDATE"; file_key: string; node_id: string; status: "NONE" | "READY_FOR_DEV" | "COMPLETED"; change_message: string; related_links: DevResource[]; triggered_by: RestUser };
/** What is sent: the event plus Figma's common fields */
export type WebhookPayload = WebhookEvent & { passcode: string; timestamp: string; webhook_id: string };
export const WEBHOOK_RETRY_MINUTES = [5, 30, 180] as const;
export const WEBHOOK_LIMITS = { team: 20, project: 5, file: 3, orgFileWebhooks: 600, personOutsideOrgs: 20 } as const;

// ---- Code Connect (docs/editor.md D-1) ----
export interface CodeConnectDoc {
  /** The node link the template's `// url=` names: <server>/f/<key>?node-id=1-2 or a Figma-style /design/<key>/…?node-id= */
  url: string;
  label: string; language: string;
  source?: string; component?: string;
  /** The template file's JavaScript after the CLI strips TypeScript; null: a UI mapping */
  template: string | null;
  imports?: string[]; nestable?: boolean; instructions?: string;
}
```

**Other additions** (the same commit):
- `src/shared/account.ts`:
  - `TOKEN_SCOPES` gains §16.3's rows (ids = `RestScope`; groups and labels as the table).
  - `AccessTokenInfo` gains `kind: "personal" | "plan"` and `orgId: string | null`.
- `src/shared/org/types.ts`:
  - `ActivityAction` gains §16.11's names (docs/plugins.md §10's are among them).
  - `OrgSettings` gains the four keys below. The defaults go into `DEFAULT_ORG_SETTINGS`.

    | Key | Type | Default |
    |---|---|---|
    | `pluginApproval` | `"all" \| "approved"` | `"all"` |
    | `pluginRequests` | `boolean` | `true` |
    | `widgetApproval` | `"all" \| "approved"` | `"all"` |
    | `widgetRequests` | `boolean` | `true` |
- `src/shared/notifications.ts`: `NotificationKind` gains `"dev_ready" | "dev_completed" | "dev_changed" | "plugin_request" | "plugin_request_answer"` (docs/editor.md D-4, docs/plugins.md §10.3).
- `src/shared/multiplayer/protocol.ts`: §16.6's messages.
- **`server/src/webhooks/emit.ts`**, a stub:
  - `export type WebhookEventInput = Exclude<WebhookEvent, { event_type: "PING" }>;`
  - `export async function emitWebhook(deps: Deps, event: WebhookEventInput, ctx: {fileKey: string; orgId: string | null; teamId: string | null; projectId: string | null}, waitUntil: (p: Promise<unknown>) => void): Promise<void> {}`
  - 5a fills it; 5c calls it.
- **`server/src/devmode/rest.ts`**, a stub:
  - `export async function devModeRestRoute(req: Request, url: URL, deps: Deps, caller: Caller, parts: string[]): Promise<Response | null> { return null; }`
  - 5a's `restRoute` calls it for `/v1/dev_resources…`, `/v1/files/:key/dev_resources…`, `/v1/code_connect` and `/v1/files/:key/code_connect` (after the scope, tier and rate checks); 5c fills it.
- `server/migrations/0015_extensibility.sql` (§16.12).
- `npm run check` green with the stubs.

### 16.14 Server layout (round 5a) and tests

**`server/src/rest/`** (new):
- `index.ts`: `restRoute(req, url, deps, ctx)`. Auth by `X-Figma-Token` or Bearer, CORS, the scope + tier table, rate, error shapes.
- `scopes.ts`, `rate.ts`.
- `signedUrl.ts`: sign / verify, `/v1/blobs/…`.
- `jobs.ts`: asks the room and waits.
- `render.ts`: `RenderBackend`.
- One file per route group: `files.ts`, `comments.ts`, `teams.ts`, `libraries.ts`, `variables.ts`, `devResources.ts` (only the scope, tier and rate checks, then 5c's `devModeRestRoute`), `analytics.ts`, `org.ts`, `planTokens.ts`.

**`server/src/webhooks/`** (new):
- `routes.ts`: `/v2/webhooks…`.
- `emit.ts`: fills the stub.
- `deliver.ts`: send, sign, retry, and the cron's sweep.

**`server/src/api.ts`** gets dispatch lines only:
- `/v1/*` and `/v2/*` before `authenticate` (they authenticate themselves);
- `/orgs/:org/admin/plan-tokens…`;
- `PUT /files/:key/thumbnail`;
- `PUT /files/:key/rest-jobs/:id/parts/:name`;
- `emitWebhook` calls in the file delete path.

**Other files**:
- `server/src/fileRoom.ts`, `server/src/roomBox.ts`, `src/shared/multiplayer/room.ts`:
  - rest jobs: pick a client, forward, time out, cache in `blobs`;
  - `hello.render`;
  - the FILE_UPDATE alarm;
  - the thumbnail blob;
  - the `/room/rest-wanted` fan-out through `INBOXES`.
- `server/src/comments.ts`, `server/src/branches.ts` (versions), `server/src/libraries/routes.ts`: one `emitWebhook` call each. Libraries also fill `library_assets.node_id` and the dates.
- `server/src/index.ts`: `scheduled` for `*/5`.
- `server/wrangler.jsonc`: the cron.
- `server/src/testing/`: a fake render client for rooms.

**Tests** (node:sqlite):
- **Routes**: every route's auth, scope and shapes, against Figma's examples.
- **Rate limits**: minute, day, low seats, headers.
- **Signed URLs**: expiry, tampering.
- **Render jobs**, with fake clients:
  - editor before viewer before helper;
  - a timeout falling to the next client;
  - nobody → 503;
  - a cache hit on the same seq, a miss after an edit;
  - versions.
- **Variables POST**: shape errors (Figma's messages) and the client's answer.
- **Webhooks**:
  - limits, and who may create them;
  - PING, and each event's payload;
  - reach through folders and teams, Limited folders excluded;
  - 200-only success, the three retries on the cron's clock;
  - the 7-day log, signatures.
- **Plan tokens**: created and shown once, org routes only, revoked.
- **Activity actions**.

### 16.15 Not decided here (owner)

See `docs/roadmap.md` "Round 5" — open questions.

### 16.16 As built — the server (round 5a, 2026-10-11)

**Layout**:
- `server/src/rest/`: `index.ts` (`restRoute`: CORS `*`, auth, scope, the plan-token gate, rate, dispatch; `HttpError`s from shared helpers become REST errors), `scopes.ts` (the route table), `rate.ts`, `signedUrl.ts`, `jobs.ts` (the Worker's side), `roomJobs.ts` (the room's side, `RestJobs`), `render.ts` (`RenderBackend`, `ClientBackend`; `serverRenderEnabled` always false), `access.ts`, `http.ts`, `uploads.ts` (thumbnail and part uploads on the private API), `files.ts`, `comments.ts`, `teams.ts`, `libraries.ts`, `variables.ts`, `devResources.ts`, `analytics.ts`, `org.ts`, `planTokens.ts`.
- `server/src/webhooks/`: `routes.ts`, `emit.ts`, `deliver.ts`, `events.ts` (the FILE_COMMENT, FILE_VERSION_UPDATE and LIBRARY_PUBLISH builders).
- `server/src/roomBroadcast.ts` (5c's request, below).

**Dispatch in `api.ts`**: `/v1` and `/v2` at the top of `handle()` — before the private API's CORS and OPTIONS, which refuse unknown origins — with `authenticate` passed in for session Bearers; `/orgs/:org/admin/plan-tokens…`; the file switch's `thumbnail` and `rest-jobs` cases; `fileDeleted` (FILE_DELETE) before an org file's permanent delete and before stop-sharing outside orgs.

**Auth**: `X-Figma-Token` or `Authorization: Bearer` with a personal access token, a plan access token (`dsgn_plan_…`) or a session (every scope). Unknown or expired: 403 `Invalid token` (Figma's). `account.ts accessToken` reads both kinds; `personalToken` (the private API's PATs) refuses plan tokens; Settings' token list and limit count personal ones only.

**Errors**: `/v1/files/…` and `/v1/images/…` answer `{status, err}`; the variables routes and every other route `{status, error: true, message}`; a 429 is always `{status: 429, err: "Rate limit exceeded"}`.

**Rate limits**: one multi-row `INSERT … ON CONFLICT DO UPDATE … RETURNING` per call (the minute bucket — `t1day` for low seats' Tier 1 — and `day`). The rate type is the caller's seat in the org of the file, team, folder or library named, else their best seat anywhere; plan tokens count as `org:<id>`, type high. The daily cron deletes counters older than two days.

**Render jobs** (for 5b):
- The room: `POST /room/rest-job?fileKey= {job, waitMs, wanted}` → `{ok: true, parts, cached, jobKey}` | `{ok: false, status, err}`. The job key is the SHA-1 of the canonical JSON `{kind, params, at: "s:<seq>" | "v:<version>"}`; the same key asked twice at once runs once. An unknown `version` answers 404.
- Who: `Room.renderers()` — members whose hello said `render: true`: owners and editors idle longest first (`activeAt` moves with each accepted frame), then viewers, then **helpers**. A helper says `hello {since, render: true, helper: true}`. `helper` is read from the hello untyped: it is an addition to §16.6's protocol, and 5b may add `helper?: boolean` to `ClientControl`. `variables_post` goes to owners and editors only.
- Each client gets 20 s (`REST_TIMING.clientMs`); the Worker waits 25.5 s. With no renderer, `{t: "rest-wanted", fileKey}` goes to the inboxes of the owner and the file's editors (`members`, role editor), once per job; then the job waits for a renderer to say hello.
- The client uploads `PUT /files/:key/rest-jobs/:id/parts/:name` (a session; ≤ 64 MB; only the user the job went to; the room keeps the bytes by SHA-1), then sends `{t: "rest-job-done", id, parts: [{name, sha1, size, contentType}]}`. A part that doesn't match its upload makes the answer void, and the next client is asked. `{t: "rest-job-failed", id, err}`: an `err` that starts with an HTTP status and a space (`"404 Node not found"`) answers that status; otherwise 400 for `variables_post`, 500 for the others.
- **Parts**:
  - `images`: one part per node id (name = the id, `"1:2"`); a missing one is `null`.
  - `variables_local`, `variables_post`: part `json`, the gzip of the whole answer (`{status, error, meta}`).
  - **`file`, `nodes`: part `json`, the gzip of the answer's JSON text without its opening `{` and without `role`, `thumbnailUrl`, `branches` and `mainFileKey`.** The Worker writes `{"role":…,"thumbnailUrl":…,["mainFileKey":…,]["branches":[…],]` as a gzip member of its own before the cached part, so one cached render serves every caller without the Worker reading it. Callers that send `accept-encoding: gzip` get the two members as they are (`encodeBody: "manual"`); others get the text unzipped.
- The cache: the room's `rest_cache` (job key → parts, size, created, used) and `rest_blobs` (parts by SHA-1, 1 MB rows), not the room's `blobs`, so an eviction never touches an image fill. LRU over 64 MB, 30 days. A region move doesn't copy them (a cache). `GET /room/rest-blob/:sha1` reads `rest_blobs`, then `blobs`.
- The thumbnail: `PUT /files/:key/thumbnail` (people who can edit, a PNG ≤ 2 MB) → the room (`rest_cache` key `thumbnail`, never evicted). `thumbnailUrl` is a signed `/v1/files/:key/thumbnail`.

**Signed URLs**: HMAC-SHA256 with a key derived from `SESSION_SECRET`, over `<path>:<exp>`. Renders `/v1/blobs/:key/:sha1.<format>` (30 days), image fills `/v1/blobs/:key/:sha1` (14 days, type sniffed), library thumbnails `/v1/library-blobs/:libraryKey/:sha1.png`, file thumbnails (30 days).

**Routes, where they differ from the contract or it left a choice**:
- Comments: `parent_id` is `""` on a thread's first comment; `order_id` is `null` on replies. A REST pin goes on page `"0:1"` unless `client_meta.page_id` names one (ours). About 20 common reactions map between shortcodes and characters (`rest/comments.ts`; `src/shared/comments.ts` isn't 5a's); others pass as they are. Writes go through `commentsRoute`, so the room, notifications and FILE_COMMENT follow.
- Meta: `version` is the room's head seq; `last_touched_by` is `null` (not tracked).
- Versions: newest first; `before` and `after` take version ids; `thumbnail_url` is `""`.
- Folders: what `Access.container` lets the caller see — a Limited folder is listed to its team's members and its files only to its people, as on the private API.
- Libraries: team lists page with numeric `cursor.before` / `after` (positions in the list); `containing_frame` is left out; `user` is the item's first publisher, else the library's last.
- Published variables: `id` is `VariableID:<node_id>` / `VariableCollectionId:<node_id>` once 0015's node id is written, else the asset key.
- Dev resources and Code Connect: `devModeRestRoute(req, url, deps, caller, ["v1", …parts])`; a plan token is refused first.
- Activity logs: `order` defaults to asc and `limit` to 1000. AI usage: plan tokens only; `metering_period_*` is the calendar month of `day` (ours).
- Plan tokens: the Admin routes of §16.3; `expiresInDays` 1–365; at most 50 per org.
- REST reads of org files log `fig_file_view` with `client_name "REST API"` and `details.token_id` (the token's id, or `"session"`), once an hour.

**Webhooks**:
- `POST` accepts `context` in any case and Figma's deprecated `team_id`. Creating needs the context's rights (team admins, folder editors, file editors); plan tokens reach their own org's.
- `GET` without `context` or `plan_api_id` lists the caller's own (ours). Pagination: `cursor` is the last id; `next_page` is a URL. In `requests`, `response_info.status` is a string (Figma's example).
- Delivery: `deliverRows` right after the rows are queued (in `waitUntil`); retries by `sweepWebhooks` on the five-minute cron (`scheduled()` tells the crons apart by `controller.cron`). Redirects aren't followed.
- Endpoints: https only, `http://localhost` when `DEV_AUTH=1`, no private or loopback IP literals.
- The activity entity of webhook actions: `{type: "webhook", id, name, event_type, context, context_id}`.
- Reach: the file and, for a branch, its main file; the folder chain; the team, when the file is Inherited and no folder on the way is Limited.

**Event sources**:
- FILE_COMMENT: `comments.ts`, threads and replies.
- FILE_VERSION_UPDATE: `branches.ts`, `POST …/versions {kind: "named"}` and a `PATCH` naming an autosave.
- LIBRARY_PUBLISH: `libraries/routes.ts`, one event per type (components = COMPONENT + COMPONENT_SET, styles, variables = VARIABLE), split by 200. `library_assets.node_id` comes from the manifest's `guid`; `created_at` / `created_by` are kept from the first publish; `updated_at` moves with each.
- FILE_DELETE: `api.ts`.
- FILE_UPDATE: `RoomBox.edited(fileUpdate)` keeps `webhookDirtyAt` and `webhookDue`; one alarm with the autosave, earliest first. The autosave now also needs `dueSince`, so a webhook alarm never takes an early autosave. `FileRoom.alarm` calls `emitFileUpdate` with its own `env.DB`. The room asks D1 whether a FILE_UPDATE webhook reaches the file at wake (async, cached 5 minutes; unknown counts as yes). The file's key is `ctx.id.name`, else the `?fileKey=` the Worker's REST calls carry.

**5c's requests (built here)**:
- `POST /room/broadcast {t: "dev-resources" | "code-connect", …}` sends a non-stored message to every member that said hello. `roomBroadcast(deps, key, t)` is called from `devmode/devResources.ts` (add, edit, remove) and `devmode/codeConnect.ts` (upsert, UI delete, CLI unpublish); clients read the links or mappings again. `ServerControl` in `protocol.ts` doesn't list them yet.
- The room refuses changes from any role but owner and editor (it refused `viewer` only).

**Not built**: `ServerBackend` (decision 7); OAuth (`/v1/oauth/*` answers 404). (A claim on a webhook row while it is sent was added 2026-10-12: migration 0016 `sending_until`, a 60 s lease taken by one `UPDATE … RETURNING` in `deliver.ts claim`.)

**Tests** (node:sqlite; `server/src/testing/restWorld.ts`: orgWorld + memoryRooms with `RestJobs`, fake render clients and a recording `fetch`):
- `rest/rest.test.ts` (17): auth and scopes, plan tokens, rate limits (high, low, daily), signed URLs and the thumbnail, render order / timeout / cache / versions / helper wanted / 503 / failures, variables (shape, POST, local, published), meta and versions, comments, folders, dev resources through 5c, activity logs and AI usage, analytics.
- `webhooks/webhooks.test.ts` (7): creation and the PING's signature, rights, endpoint rules, limits; reads, PUT, the log, DELETE, the plan listing; retries on the cron's clock and the 7-day log; FILE_COMMENT's reach through team and folder with the Limited folder left out; FILE_VERSION_UPDATE; LIBRARY_PUBLISH and the REST library reads; FILE_DELETE; FILE_UPDATE from the alarm; the broadcast and the write guard.

### 16.17 As built — the clients (round 5b, 2026-10-12)

**The path of a job**: the room's `{t: "rest-job", id, job}` reaches the store's link of that file (`src/store/multiplayer/service.ts`); the store hands it to the file's renderer as a `multiplayer` event (`MultiplayerEvent.restJob = {id, job, to, seq, name, lastModified}`); the editor's runner answers with `multiplayer.restAnswer(fileKey, id, {parts} | {err})`; the store uploads each part (`PUT /files/:key/rest-jobs/:id/parts/:name`), waits for the frames it queued before (`Link.settled`), and says `{t: "rest-job-done", id, parts: [{name, sha1, size, contentType}]}` — or `rest-job-failed`.

**Store** (`src/store/multiplayer/`):
- `multiplayer.restRender(fileKey, on, {helper}, token?)` → a renderer token (new store methods in `src/shared/store/protocol.ts` / `client.ts`, types in `src/shared/multiplayer/types.ts`). The link's hello says `render: true` while the file has a renderer, and `helper: true` when every renderer is the hidden helper; a change of either reconnects the link (a hello is said once per socket). `hello.helper` is typed in `src/shared/multiplayer/protocol.ts`.
- A job goes to one renderer (`to`): an editor before the helper. With none left, the store answers `"503 No client available…"` itself.
- **Thumbnail**: `MultiplayerHost.thumbnail(fileKey)` (the store's `thumbnail.png`) goes to `PUT /files/:key/thumbnail` after a share and after each compaction snapshot, and when the editor saves a new thumbnail (`files.saveThumbnail` → `thumbnailSaved`, at most once a minute per file; editors only).
- **rest-wanted**: the inbox socket's `{t: "rest-wanted", fileKey}` (`src/store/notifications/service.ts`, one branch) → `MultiplayerService.restWanted(roomKey)` → `MultiplayerEvent.restWanted` for this installation's copy, with its `state.role`.

**Editor** (`src/renderer/src/editor/rest/`; `EditorApp.tsx` has one line, `attachRestRunner(ed)` — editors of store files only; `?restHelper` in the URL marks the helper):
- `runner.ts`: registers, runs jobs one at a time; a job with `version` loads `source.openVersion(id)` in a scratch `Engine.create(null)` (unknown → `"404 Version not found"`); answers never throw (`"500 …"`).
- `fileJson.ts`: the engine's `readNodes` of each page's subtree (instance sublayers under Figma's ids `I1:2;3:4`) → Figma's REST JSON. Types: GROUP = FRAME with `resizeToFit`, COMPONENT_SET = FRAME (or SYMBOL) with `isStateGroup` (that is how Figma's `.fig` files store sets — checked on `sections.fig`), COMPONENT = SYMBOL, RECTANGLE = ROUNDED_RECTANGLE, BRUSH = VECTOR; variables, styles and internal canvases are left out. Fields: `scrollBehavior`, `blendMode`, `clipsContent`, `fills` / `strokes` (gradient handles from the inverse paint transform, `imageRef`, `scaleMode`, `imageTransform`), `strokeWeight` / `Align` / `Dashes` / `Cap` / `Join`, `individualStrokeWeights`, `cornerRadius` / `rectangleCornerRadii`, `opacity` (≠ 1), `absoluteBoundingBox` (the world box), `absoluteRenderBounds`, `constraints`, `effects` (FOREGROUND_BLUR → LAYER_BLUR), `exportSettings`, auto layout (`layoutMode`, sizing modes, alignments, paddings, `itemSpacing`, wrap, `layoutAlign` / `layoutGrow` / `layoutPositioning`, `layoutSizingHorizontal` / `Vertical`), min / max sizes, `layoutGrids`, `overflowDirection`, text (`characters`, `style`, `characterStyleOverrides`, `styleOverrideTable`, `lineTypes`, `lineIndentations`), instances (`componentId`, `componentProperties` by Figma's `Name#id`, variants by name, `overrides` with REST field names, `exposedInstances`), `componentPropertyDefinitions`, `boundVariables` (Figma's keys; paints / effects carry their own), `styles`, `explicitVariableModes`. Top level: `components` (with `componentSetId`), `componentSets`, `styles` (the ones the document uses). `depth` and `ids` as Figma's; nodes: `{document, components, componentSets, schemaVersion, styles} | null` per id. `version` is the room seq the copy holds (a version job: its id).
- `geometry=paths`: `size`, `relativeTransform`, and `fillGeometry` — rectangles, frames and full ellipses written as Figma writes them (cubic corners), everything else from the engine's own SVG export of that node (its `<path>`s with fill, in the node's box).
- `images.ts`: `renderEngineExport` per id (pages and missing ids: no part → `null`); `scale` 0.01–4, vector formats at 1x, the 32-megapixel cap; `svg_include_id` / `svg_include_node_id` write ids always.
- `variablesJson.ts`: `GET …/variables/local` — own and library collections / variables; ids `VariableID:1:2`, `VariableCollectionId:1:3`, a library copy's `VariableID:<key>/1:2`; aliases `{type: "VARIABLE_ALIAS", id}`; extended collections with `isExtension`, `parentVariableCollectionId`, `rootVariableCollectionId`, `inheritedVariableIds`, `localVariableIds: []`, `variableOverrides`.
- `variablesPost.ts`: `validateShape` again, then `validateAgainst` (pure, on a copy of the model in Figma's order: ids and temporary ids, remote copies read-only, extensions take no modes or variables of their own, names unique per collection, values of the variable's type, `null` only on an extension's mode, alias types and cycles, limits), then one actor write (`REST_ACTOR`, "REST API: Update variables", `undoTo: 0` — one step of the user's history, selection and page untouched) through the engine's variable commands; any refusal cancels the write. Answers `{status: 200, error: false, meta: {tempIdToRealId}}`; a refusal is `rest-job-failed "400 <message>"`.

**Main** (`src/main/restHelper.ts`, one line in `index.ts`): `RestHelper` (the policy, tested without Electron) opens a hidden editor view (`createView`, never added to a window, background throttling off) on `restWanted` for a file whose `state.role` is `owner`, while Settings › Account › "Answer API requests for my files" is on — `AccountPrefs.restHelper` (default on; the server's `PATCH /me/profile` takes it; read through `/me/profile`, cached a minute) — and the file isn't open in a tab; at most 3; closed after 5 minutes without a job (main watches the `restJob` events) or when a tab opens the file. The switch is in Settings › Account (desktop only).

**Differences from Figma's JSON** (no Figma `GET /v1/files` output for the samples was available here: the shapes follow developers.figma.com's node types, the samples' types come from their `.fig`):
- `strokeGeometry` is always `[]` (the engine doesn't hand out outlined strokes).
- `absoluteRenderBounds` is the box grown by outside / centre strokes, drop shadows and layer blurs, with unclipped children — not the drawn ink (a text's glyph bounds are its box).
- Component and set `key`s are the node's own (empty until published); `preferredValues` are `[]`; `documentationLinks` `[]`; `interactions` and `devStatus` aren't written; `pluginData` / `sharedPluginData` are written since 2026-10-12 with `plugin_data` (`{pluginId: {key: value}}` for the listed ids, `{namespace: {key: value}}` with `shared`; only when non-empty — whether Figma writes empty objects is unverified); `lineHeightPx` for "Auto" is the engine's first line's height.
- `fillGeometry` of a rotated or mirrored vector, star or polygon comes from the export of its axis-aligned box.

**Tests**: `editor/rest/__tests__/fileJson.wasm.test.ts` (15: the samples `structure.fig`, `sections.fig`, `stacks_wrap.fig` and the editor's fixtures — types, sublayer ids, components and sets, text, auto layout, paints and effects, instances, variables and styles, `depth`, `ids`, `geometry=paths`, nodes, the part's wire form, images), `variables.wasm.test.ts` (7: local JSON, POST with temporary ids as one undo step, all or nothing, extended collections and `null`, deletes / renames, `validateAgainst`), `runner.wasm.test.ts` (6: end to end against the real handler — `server/src/testing/restClients.ts`, restWorld + the store's service on an in-process socket + the wasm runner: file / nodes / thumbnail, images and local variables, POST seen by the next read and a 400, the helper asked after an editor and `rest-wanted`, 503 after the runner stops, versions), `src/main/restHelper.test.ts` (5: the helper with a fake inbox).

**Not verified here**: the hidden helper in the built Electron app (a WebContentsView never attached to a window rendering WebGL), and the JSON against Figma's own output for the same files.
