# Multiplayer, accounts and sharing — on Cloudflare

Contract for roadmap Phase 6 (owner's decision 2026-10-10: Cloudflare instead of Firebase, Google sign-in). Figma's model (R1/R2; "How Figma's multiplayer technology works"): one authoritative process per file, kiwi `NODE_CHANGES` carrying only touched fields, server order decides, per-property last writer wins, optimistic clients, undo of one's own changes only, presence on an ephemeral channel.

## 1. Pieces

| Piece | Cloudflare | Code |
|---|---|---|
| HTTP API, sign-in, sharing | Worker `designer` → `https://designer.burak-kc-sp.workers.dev` | `server/src/index.ts`, `server/src/api.ts`, `server/src/auth.ts` |
| One room per file (sequencer, journal, snapshot, presence) | Durable Object `FileRoom`, SQLite storage, WebSocket hibernation | `server/src/fileRoom.ts` around the pure `src/shared/multiplayer/room.ts` |
| Accounts, files, members, sign-in codes | D1 `designer` | `server/schema.sql`, `server/src/db.ts` |
| Images / large blobs, preview pages (later) | R2 `designer` | `StorageDriver` (docs/data.md §12) |
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
   - Not built: transfer ownership, "Ask to spotlight", password links, Dev Mode / embed links, audio. (Comments: §10.)

## 7. Deployed (2026-10-10)

- Worker `designer` live at `https://designer.burak-kc-sp.workers.dev` (Durable Object `FileRoom`, migration v1); D1 `designer` (`98f2c9e2-…`, region EEUR) migrated remotely; secrets `SESSION_SECRET` (random, 32 bytes) and `GOOGLE_CLIENT_SECRET` set; `GOOGLE_CLIENT_ID` in `wrangler.jsonc` vars. Checked from outside: `/` ok, `/me` 401, `/auth/dev` 404 (no DEV_AUTH in production), `/auth/login` → Google with the production redirect URI, a forged callback state 400.
- Real Google sign-in verified against `wrangler dev` (the owner's account; session sealed with safeStorage). Against production: the owner's first log in after this.
- Wrangler authenticates with an API token in `server/.env` (`CLOUDFLARE_API_TOKEN`, git-ignored): `wrangler login`'s OAuth page failed twice in the owner's browser ("No CSRF value available in the session cookie"). Token permissions: Edit Cloudflare Workers template + Account › D1 › Edit.
- Redeploy: `npm --prefix server run deploy`; new migrations: `npm --prefix server run db:migrate`.

## 8. What the owner does

- Cloudflare: account (done), `workers.dev` subdomain `burak-kc-sp` (done), `npx wrangler login` in `server/` when asked; R2 enabled before step 6.
- Google Cloud Console: a project, OAuth consent screen (External, testing, the owner and friends as test users), an OAuth client of type **Web application** with redirect URIs `https://designer.burak-kc-sp.workers.dev/auth/callback` and `http://localhost:8787/auth/callback`; its client id and secret go in with `npx wrangler secret put GOOGLE_CLIENT_SECRET` (and the id as `GOOGLE_CLIENT_ID`). Nothing goes in the repo.

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
- **Not built**: images in comments ("Upload up to 5 images and GIFs" left out), comment notifications (the Settings menu's choice is kept per machine but nothing is sent — no notification inbox / email), pin clusters, markdown formatting, "Copy link" opening a comment from the link (the link is copied, opening it doesn't focus the thread yet), keyboard stepping between threads, the 100-comments-an-hour limit.
