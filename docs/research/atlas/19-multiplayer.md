# 19 — Multiplayer, sharing, permissions

Figma Design desktop 126.9.13, read on 2026-10-16 from the cached editor build (`~/.cache/figma-rea/figma/`, outside
the repo), following `~/.cache/figma-rea/BRIEF.md`. Figma's code is not copied here: this file records behaviour,
numbers, enums, data shapes, endpoints and i18n keys, each with its evidence. **CONFIRMED** = read directly in the
build. **INFERRED** = deduced from what was read, or taken from the help site / live capture (said where).

## 1. Scope and sources

**Scope.** The multiplayer protocol as the client sees it (socket URL, message types, sessions, acks, reconnect,
signals, rejects), presence (cursors, selections, colours, cursor chat, high fives / reactions, the facepile and its
overflow, the Multiplayer tools popover, following / observation, spotlight and "Ask to spotlight", audio), conflict
rules (per-property registers, staging, collaborative text, oscillation guard, offline store), the Share modal (invite,
roles, link access, password, expiry, embed, copy-link variants), access requests, the permission levels and the
view-only chrome. Phase 6 of DesignerV2 (docs/roadmap.md) is the reader.

**Prior work, summarised and not repeated.**

- `docs/research/figma/R13-multiplayer-sharing.md` (help site + blog + live capture): presence model, cursor and
  editor limits (200 cursors / 200 editors / 500 participants), observation look (5 px frame, "Following <name>" ·
  Stop), spotlight prompts, cursor chat (help says 52 characters, 5 s), audio scope, Share dialog layout and wording,
  roles, link settings, password, embeds, Copy link formats, viewer UI, offline behaviour, Figma's 2019 multiplayer
  blog rules. All still hold except where §3–§6 below correct them from the build (chat length, spotlight delay,
  facepile size).
- `docs/research/figma/live/multiplayer/README.md` (live DOM capture 2026-10-11): pixel geometry and colours of the
  facepile, Multiplayer tools popover, observation frame and bell, Share modal cards, Share settings, viewer banner.
  It is the reference for look; this chapter adds the behaviour and numbers behind it.
- `docs/research/figma/figma-schema.kiwi` (the schema read from a .fig in round 1) and `docs/schema.md`: the
  document and Message shapes. §2.2 below diffs it against the schema embedded in 126.9.13.
- `docs/research/atlas/03-menus-shortcuts.md`: the actions `start-chat` (/), `spotlight-me`, `follow-presenter`,
  `toggle-multiplayer-cursors` (⌥⌘\), `copy-link` (⌘L, desktop), `page-copy-link` and their keyboard-layout
  variants; `docs/research/atlas/16-comments-versions.md` for savepoints / restore; chapter 22 for autosave and the
  offline store.

**Build sources read.** "fmt L" is a line in an esbuild reprint of the chunk kept in the scratchpad; quoted snippets
can be found in the minified file with `rg`.

| Source | What it gave |
|---|---|
| `3187.min.js` (fmt L15560–15660) | `handleMultiplayerSignal` (signal names and the UI each one raises), `buildMultiplayerUrl` (socket URL query), cursor-hidden / viewer-converted toasts, reconnect tags |
| `3187.min.js` (fmt L15720–15860) | A multiplayer load generator: the exact shapes of `NODE_CHANGES`, `USER_CHANGES` (cursor, viewport, selection, chat) and `CLIENT_BROADCAST` (cursor reaction) the client sends |
| `3187.min.js` embedded kiwi schema text (`enum MessageType{…}`, `message Message{…}`, `message UserChange{…}`) | The 126.9.13 wire schema |
| `3187.min.js` fmt L41815–41946 | The presence store per session (`infoBySessionId`: mouse, cursorType, chatMessage, highFiveStatus, lastMouseMoveMs), reactions (2.5 s), chat analytics |
| `3187.min.js` fmt L148041–148051 | Enums: load reason, reconnect types, unsaved/disconnected status |
| `3187.min.js` fmt L96490–96720 | Share settings: link expiration options, password field, "Viewers can copy, save, and export" |
| `3187.min.js` (minified) | `LinkAccess` / `ProtoLinkAccess` enums, access level numbers, share / role / invite / edit-request endpoints, copy-link toasts |
| `2108.min.js` fmt L20440–20610 | Facepile: max avatars, overflow split, sort priority, hidden sessions; auto-follow timing for spotlight |
| `2108.min.js` fmt L26930–27060 | The spotlight / following bell state machine and its strings |
| `2108.min.js` fmt L29000–29080 | The facepile + Multiplayer tools popover component (`MultiplayerUsers`) |
| `figma_app.min.js` fmt L64280–64850 | Multiplayer cursors layer (React), cursor chat input + reducer, high-five wiggle detector, remote message fade timers, the cursor colour whitelist |
| `figma_app.min.js` fmt L120289 (module 37932), `3187.min.js` fmt L133735 | The 7-colour multiplayer palette and the avatar colour hash |
| `app.css` (scratchpad copy of the editor CSS) | `--color-multiplayer*` tokens per theme |
| `9905.min.js` | View-only toolbelt banner |
| `3866.min.js` | Audio (voice) states and idle timeout |
| `fullscreen__fullscreen-wasm__compiled_wasm.wasm` strings (`strings -n 6`) | C++ class / file names and log lines of `MultiplayerSession`, `ChangeRegisters`, `MultiplayerPageSyncing`, `MultiplayerUserSyncing`, `CollaborativePlainText`, reject reasons, session states |

## 2. The protocol as the client sees it

### 2.1 Connection

| Item | Value | Evidence | Status |
|---|---|---|---|
| Transport | One WebSocket per open file, binary frames of kiwi `Message`, created through a JS binding (`new WebSocket(url)`) the C++ `MultiplayerSession` drives | `figma_app.min.js`: class wrapping `this.ws=new WebSocket(e)`, `setBinaryType`; wasm: `fullscreen/lib/editor/multiplayer/FGMultiplayerSession.cpp` | CONFIRMED |
| Base URL | Built by `mpGlobal.url({fileKey, role, nodeIds, checkFullscreenScriptHash, suppressDecodeErrors, tagForLogging, forceViewOnly, checkpointReconnect})`; `mpGlobal` lives in the HTML page's inline script (not in the cache). Public knowledge: `wss://www.figma.com/api/multiplayer/<fileKey>?role=…` | `3187.min.js` fmt L15617 `mpGlobal.url({ fileKey: e10, role: p10, …` | CONFIRMED (arguments) / INFERRED (path) |
| `role` | `"editor"` for the editor (also used by Dev Mode with `tagForLogging: "dev_mode"`), `"viewerWithCpp"` for the export view, `"prototype"` for the prototype viewer | fmt L15615 `"export" === u10.view ? "viewerWithCpp" : "editor"`; fmt L15276 `role: "prototype"` | CONFIRMED |
| Preconnect | The socket is opened (`mpGlobal.preconnect(url)`) while the file's metadata loads, before the editor exists; the editor later adopts `mpGlobal.sock` | fmt L19279, L38829; `figma_app.min.js` `setSock`, `mpGlobal.sock=t.ws` | CONFIRMED |
| Query params added on (re)connect | `reconnect-key`, `reconnect-sequence-number`, `initialFileVersion`, `testMode`, `force-upgrade=1`, `previousLoadMode`, `incremental-loading-validation=0/1`, `force-dpl-journaled-reconnect=0/1` | fmt L15617–15618 `searchParams.set("reconnect-key"`… | CONFIRMED |
| Incremental load | `nodeIds` in the URL = the pages subscribed at join ("Connecting to multiplayer with subscribedInitialNodeIds"); later pages via `SCENE_GRAPH_QUERY` / `SCENE_GRAPH_REPLY` (`MultiplayerPageSyncing`) with behaviours `DEFAULT`, `CONTAINING_PAGE`, `PLUGIN` and mode `ADD` / `SET` | wasm strings `[MultiplayerPageSyncing] Sending sceneGraphQuery for %s with depth %u and behavior %s`; schema `enum SceneGraphQueryMode{ADD=0;SET=1;}` | CONFIRMED |
| Load reasons | `NEW_FILE` 0, `INITIAL_LOAD` 1, `RECONNECT` 2 | `3187.min.js` fmt L148041 enum | CONFIRMED |
| Reconnect types | `FAST` 0, `SLOW` 1, `JOURNALED` 2; non-trivial: `NONE` 0, `SLOW` 1, `JOURNALED_NON_DPL` 2, `JOURNALED_DPL` 3 (tags `last_reconnect_type`, `last_nontrivial_reconnect_type`) | same enum block; fmt L15646–15652 | CONFIRMED |
| Session states (C++) | `UNJOINED`, `UNJOINED_FROM_ERROR`, `JOINING_INITIAL_LOAD`, `JOINING_RECONNECT`, `JOINING_RECONNECT_AWAITING_QUERY_REPLY`, `JOINED` | wasm `Attempted to transition to JOINED from state other than JOINING_INITIAL_LOAD.` | CONFIRMED |
| Join handshake | Server sends `JOIN_START` (or `JOIN_START_JOURNALED` / `JOIN_START_SKIP_RELOAD`), the document as `NODE_CHANGES`, `JOIN_END` (or `JOIN_END_INCREMENTAL_RECONNECT` after a reconnect); the client "Deferring join until receiving JOIN_END_INCREMENTAL_RECONNECT" | MessageType enum; wasm log lines | CONFIRMED (types) / INFERRED (exact order) |
| Schema on the wire | The server may send its schema first ("multiplayer_got_schema", "MultiplayerSession: invalid compressed schema"); messages can be compressed ("unable to decompress message while streaming") | wasm strings | CONFIRMED |
| Checkpoint load | Optional: the file is fetched as a checkpoint over HTTP (`multiplayer.web.checkpoint_fetch.*` timings) and the socket only carries changes after it; on failure "falling back to normal multiplayer load" | i18n/analytics keys; wasm `checkpoint_poc: initializeFromCheckpoint FAILED` | CONFIRMED |
| Ack timeout | The client disconnects if an ack does not come in time: "Disconnecting multiplayer session after not receiving ack for %fs"; the RTT of each ack is logged | wasm strings | CONFIRMED (behaviour), value open (§11) |

### 2.2 Message types and the 126.9.13 schema

`MessageType`: `JOIN_START` 0, `NODE_CHANGES` 1, `USER_CHANGES` 2, `JOIN_END` 3, `SIGNAL` 4, `STYLE` 5, `STYLE_SET` 6,
`JOIN_START_SKIP_RELOAD` 7, `NOTIFY_SHOULD_UPGRADE` 8, `UPGRADE_DONE` 9, `UPGRADE_REFRESH` 10, `SCENE_GRAPH_QUERY` 11,
`SCENE_GRAPH_REPLY` 12, `DIFF` 13, `CLIENT_BROADCAST` 14, `JOIN_START_JOURNALED` 15, `STREAM_START` 16, `STREAM_END` 17,
`INTERACTIVE_SLIDE_CHANGE` 18, `RECONNECT_SCENE_GRAPH_QUERY` 19, `RECONNECT_SCENE_GRAPH_REPLY` 20,
`JOIN_END_INCREMENTAL_RECONNECT` 21, `NODE_STATUS_CHANGE` 22, `CLIENT_RENDERED` 23, **`BUZZ_APPROVAL_CHANGE` 24 (new)**.
CONFIRMED — `3187.min.js` embedded `enum MessageType{JOIN_START=0;…;BUZZ_APPROVAL_CHANGE=24;}`.

New `Message` fields in 126.9.13 against `docs/research/figma/figma-schema.kiwi` (CONFIRMED, embedded schema):
`buzzApprovalChange` 44, `sceneGraphQueryMode` 45 (`ADD`/`SET`), `undoBatchPageIds` 46 (GUID[]), `originFileKey` 47,
`nodeChangeOrder` 48 (`enum NodeChangeOrder{GUID=0;PREORDER=1;TOPOLOGICAL=2;}`), `changeSetIdentifiers` 49
(`{clientLifecycleId, toolCallId}`); `nodeChangesMetadata` 17 is now `[deprecated]`.
New `UserChange` fields: `agentInfo` 46 (`{name, logo, oauthClientId}`), `timelinePlaybackState` 47,
`agentCanvasActivity` 48, `assistantThreadId` 49, `sanrioCharacter` 50; `aprilFunCursor` 34 and `aprilFunFigPal` 39 are
deprecated.

The fields a Design client actually uses (from the load generator, CONFIRMED `3187.min.js` fmt L15730–15860):

| Message | Fields sent | Notes |
|---|---|---|
| `NODE_CHANGES` | `sessionID`, `ackID`, `nodeChanges[]` (each with `guid`, optional `phase: CREATED/REMOVED`, the touched fields only), `blobs[]` | `ackID` is the client's running batch id; the server echoes it back as the acknowledgement |
| `USER_CHANGES` — join | `userChanges:[{sessionID, stableSessionID, userID, connected, name, imageURL, …}]` | the server fills `color`, `canWrite`, `connectedAtTimeS` for others (INFERRED) |
| `USER_CHANGES` — cursor | `{sessionID, highFiveStatus, mouse:{cursor:"DEFAULT", canvasSpaceLocation:{x,y}, canvasGuid}}` | page-local coordinates, `canvasGuid` = the page |
| `USER_CHANGES` — viewport + selection | `{sessionID, viewport:{canvasSpaceBounds:{x,y,w,h}, pixelPreview, pixelDensity, canvasGuid}, selection:[GUID…]}` | |
| `USER_CHANGES` — chat | `{…cursor, chatMessage:{previousText, text}}`, one message per keystroke | "live typing" |
| `CLIENT_BROADCAST` | `broadcasts:[{sessionID, cursorReaction:{imageUrl}}]` | also `presenter`, `prototypePresenter` (`PresenterInfo{sessionID, nomination{sessionID,isCancelled}, isReconnected}`), FigJam `timer`, `music` |

Other presence fields of `UserChange` the Design editor reads (CONFIRMED by name in the schema and JS):
`observing` (uint[] = session ids this user follows), `heartbeat` (`FOREGROUND` 0 / `BACKGROUND` 1),
`textCursor` / `textSelection` / `collaborativeTextSelection`, `voiceMetadata.connectedCallId`, `focusOnTextCursor`,
`deviceName` ("editor", agents), `mouse.cursorHiddenReason` (uint), `mouse.canvasSpaceSelectionBox` (others' marquee),
`MouseCursor` enum `DEFAULT`…`LASSO` (11 values).

### 2.3 Signals (server → client `SIGNAL`, `signalName` + `signalPayload`)

CONFIRMED — `3187.min.js` fmt L15573–15600 `handleMultiplayerSignal`. The i18n keys are given; English where R13 / live
attest it is not available for these — they are read as the key says.

| Signal | Client reaction |
|---|---|
| `force-refresh` | reloads the page ("Multiplayer got force-refresh signal") |
| `too-many-connections` | with unsaved changes: modal `unsaved_changes.syncing.changes_cannot_be_saved` / `…too_many_people_in_file`; else the "too many connections" modal (`multiplayer_connection_error.too_many_connections.title/.content`, button `…view_only_button` = open view-only, not in the desktop app) |
| `message-decode-failure` | one visual bell per session: `unsaved_changes.syncing.experiencing_server_issues` |
| `invalid-permissions` | unsaved: `changes_cannot_be_saved` + `unsaved_revoked_access`; else `access_revoked` + "someone revoked access to the file you had open, ask the owner for access to open it again" and the file closes (desktop tab closes) |
| `not-logged-in` | unsaved: `unsaved_not_logged_in`; else logs out to files, `logged_out` + `you_have_been_logged_out_of_figma` |
| `client-too-old` | unsaved: `app_out_of_date`; else bell `updating_the_app`, then after 50 ms reloads with `flash=` "Figma was automatically updated to the latest version" |
| `ip-allowlist`, `network-access-restriction` | navigates to `/ip_account_restriction?reason=…&redirect_uri=…` |
| `schema-validation-failure` | bell `we_re_experiencing_issues_opening_this_file_please_try_again_later` |

Connection rejects known to the C++ (CONFIRMED wasm): `REJECT_INVALID_PERMISSIONS`, `REJECT_NOT_LOGGED_IN`,
`REJECT_TOO_MANY_CONNECTIONS`, `REJECT_TOO_OLD` (test actions `test-multiplayer-reject-*`). Upgrade path:
`NOTIFY_SHOULD_UPGRADE` → banner `banner.multiplayer_session_upgrade.out_of_date.editor|viewer|page_out_of_date` with
`reload` / `save_and_reload`, and the modal `multiplayer_upgrade_modal.content_saving|content_reloading|content_offline`.

Presence notices raised by the C++ through bindings (CONFIRMED fmt L15620–15640):
`your_cursor_has_been_hidden_from_others_users` (+ "Learn more" → the cursor-limit modal), `your_cursor_is_now_visible_to_others_as_someone_is_observing_you`,
`your_cursor_is_now_visible_to_others_as_users_have_left_the_file`, `you_have_been_converted_to_a_viewer_with_a_hidden_cursor`
(+ Learn more → the editor-limit modal `multiplayer_limit.editor_limit_modal_title.seat_rename`). These are the 200-cursor /
200-editor limits of R13 §4.

### 2.4 Save status shown to the user

`unsaved_changes` status enum (CONFIRMED fmt L148041): `NONE`, `DISCONNECTED_AUTOSAVE_DISABLED`,
`DISCONNECTED_SERVER_ISSUES`, `DISCONNECTED_OTHER`, `SYNCING_AUTOSAVE_DISABLED`, `SYNCING_SERVER_ISSUES`,
`SYNCING_OTHER` — keys `unsaved_changes.disconnected.{autosave_disabled, live_updates, other, server_issues}` and
`unsaved_changes.syncing.{autosave_disabled, other, server_issues}`. The offline store is IndexedDB "Autosave"
(object stores `node-changes`, `saved-images`, `referenced-nodes`, `editor-sessions`, `new-files`, `activity-log`,
`session-index`; DB version 4; open timeout 6 s; CONFIRMED `3187.min.js` fmt L26877–26895) — details in chapter 22.

## 3. Conflict rules (C++ `ChangeRegisters`, `MultiplayerDocumentSyncing`)

| Rule | Evidence | Status |
|---|---|---|
| Every local edit lands in a per-node, per-property **register**; a flush builds one `NODE_CHANGES` "with %u phase changes and %u property changes"; the server's ack frees the registers ("Received ack from multiplayer. Round trip time (RTT): %fms") | wasm `[ChangeRegisters] client: flushing message %d with %u phase changes and %u property changes %s` | CONFIRMED |
| While a property register is unacked, the remote value for that property is not applied (Figma's blog rule; R13 §4) — the build's form: "Found staged conflict with remote change", `remoteConflictBehavior` | wasm strings | CONFIRMED (exists) / INFERRED (exact policy per field) |
| Some fields hold back other flushes: "Skipping flushing property change for %s due to unacked table register" (tables: merged cells are reconciled after conflicts, "reconcileMergedCells: fixed inconsistencies from multiplayer conflict") | wasm | CONFIRMED |
| Acks for nodes deleted meanwhile are tolerated ("Received an ack for a property change to a node that doesn't exist") | wasm | CONFIRMED |
| Reparent races: the server refuses cycles; the client rejects moves that would cycle ("Cannot move node. Doing so would create a parenting cycle"); after a reconnect "Orphaned nodes after reconnect: parent not found in scene" are handled | wasm | CONFIRMED |
| Order among siblings = `parentIndex.position` (fractional index string), so concurrent inserts never collide; a `NODE_CHANGES` may declare `nodeChangeOrder` (`GUID` / `PREORDER` / `TOPOLOGICAL`) | schema | CONFIRMED |
| **Auto layout oscillation guard**: two clients re-laying out each other's output could ping-pong; Figma detects it (`detect_multiplayer_oscillations`, `numOscillations`) and "Skipping auto layout to avoid likely multiplayer oscillation" | wasm | CONFIRMED |
| Field versions: some fields carry a version (`MultiplayerFieldVersion`, "Writing multiplayer versioned field with no attached version", `Message.fileVersion`) | wasm | CONFIRMED (exists) |
| **Text is atomic**: ordinary TEXT nodes keep last-writer-wins on `textData`; op-based collaborative text (`CollaborativePlainText`: op runs with `CollaborativeTextOpID{session, counter}`, `INSERT`/`DELETE`, history + snapshot) is used only for `collaborativeSourceCode` 444 (code layers) and `specBlockContent` 560 (Figma specs) | embedded schema: only these two fields have type `CollaborativePlainText` | CONFIRMED |
| Undo touches only one's own changes; the undo stack can be carried in `localUndoStack` / `localRedoStack` and, new in 126, `undoBatchPageIds` | schema | CONFIRMED (fields) |
| Retransmission: a resent batch sets `isRetransmission`; reconnect carries `reconnectSequenceNumber` and the URL's `reconnect-sequence-number` so the server can tell which batches it already has | schema; fmt L15617 | CONFIRMED |
| Offline: edits keep landing in registers and in the Autosave IDB; on reconnect the session rejoins (fast / slow / journaled) and resends unacked batches | wasm `disconnecting_multiplayer_unacked`, `Flushing limboed changes`; R13 §4 | CONFIRMED (names) / INFERRED (sequence) |

## 4. Presence

### 4.1 Multiplayer colours

Seven colours (CONFIRMED `figma_app.min.js` module 37932: `w3r "#667799"`, `dVU "#007be5"`, `$rq "#9747ff"`,
`JTC "#ff24bd"`, `Men "#f24822"`, `$C9 "#ffcd29"`, `Wnq "#14ae5c"`; names `["gray","blue","purple","pink","red","yellow","green"]`):

| Name | Base (cursor / avatar) | Light hover | Light secondary | Dark base | Dark hover | Dark secondary | Text on it |
|---|---|---|---|---|---|---|---|
| grey | #667799 | #536383 | #394360 | #667799 | #536383 | #394360 | white |
| blue | #007be5 | #0768cf | #034ac1 | #0a6dc2 | #105cad | #184591 | white |
| purple | #9747ff | #8638e5 | #681abb | #8a38f5 | #7a2ed6 | #50297a | white |
| pink | #ff24bd | #ea10ac | #971172 | #f316b0 | #d01b9c | #68275e | white |
| red | #f24822 | #dc3412 | #9f1f18 | #e03e1a | #c4381c | #7c2622 | white |
| yellow | #ffcd29 | #ffc21a | #eba611 | #f3c11b | #f2b50d | #c58011 | rgba(0,0,0,.9) |
| green | #14ae5c | #009951 | #036838 | #198f51 | #078348 | #0a4c2d | white |

Evidence: `app.css` blocks `[data-preferred-theme=light]` and `[data-preferred-theme=dark]:not([data-editor-theme=whiteboard])`,
tokens `--color-multiplayer<name>`, `…hover`, `…secondary`, `--color-textonmultiplayer<name>`. CONFIRMED. (The UI3
`:root` block maps them to ramps `--ramp-<hue>-500/600/800`.) "Secondary" is the darker shade used for the bell's Stop
button and Ask-to-spotlight ("useSecondaryColor").

- **Session colour**: comes from the server in `UserChange.color`; the cursor layer accepts only a whitelist — the 7
  above plus legacy `#0FA958 #5551FF #848484 #D27C2C #F24E1E #FFC700` and white (`figma_app.min.js` fmt L64588
  "Unknown color %s for Cursor High Fives"). CONFIRMED (whitelist) / INFERRED (server picks among the 7, typically the
  least-used).
- **Avatar placeholder colour** (no photo): the user id's last 4 characters parsed as an integer, mod 7, into the order
  grey, blue, purple, pink, red, yellow, green; if not numeric, a 31-multiplier string hash mod 7. Icon colour dark on
  yellow, white otherwise. CONFIRMED `3187.min.js` fmt L133739–133762.
- The old (pre-UI3) palette survives as deprecated SCSS values `ui_color_multiplayer_{b #18a0fb, g #1bc47d, p #907cff, r #ef5533, s #ee46d3, t #00b5ce, y #ffc700}` — not used for new sessions. CONFIRMED.

### 4.2 Cursors

| Item | Value | Evidence | Status |
|---|---|---|---|
| Drawn for | others on **the same page** (`mouse.pageId === currentPage`), session device "editor", with a valid position | `figma_app.min.js` fmt L64413 | CONFIRMED |
| Idle hide | a cursor whose last move is **> 60 000 ms** ago is not drawn, unless it is the user you are observing | same: `window.performance.now() - t2.lastMouseMoveMs > 6e4` | CONFIRMED |
| Toggle | View › Multiplayer cursors (`toggle-multiplayer-cursors`, ⌥⌘\, UI state `hideMultiplayerCursors`); bells `visual_bell.multiplayer_cursors_hidden` / `…_visible`; in Dev Mode the toggle is handled separately | `3187.min.js` fmt L22701, L22727 | CONFIRMED |
| Name chip | colour = session colour; text colour = contrast of it (`GL(color)`); "enhanced contrast" preference swaps to a darker variant | fmt L64707 | CONFIRMED |
| Cursor glyph | an image per `MouseCursor` type and colour (DEFAULT, PEN …); pointing-right variant when the default arrow is near the right edge | fmt L64732–64740 | CONFIRMED |
| Background tab | `heartbeat: BACKGROUND` | schema | INFERRED (R13 live: a background tab draws no cursor) |
| Following overrides | the followed person's cursor is always visible to everyone (R13); the C++ sends "your cursor is now visible … someone is observing you" | fmt L15628 | CONFIRMED |
| Others' marquee | `mouse.canvasSpaceSelectionBox` | schema | CONFIRMED (field) |
| Others' text caret / selection | `textCursor`, `textSelection` per text node | schema | CONFIRMED (field) |

### 4.3 Cursor chat

| Item | Value | Evidence | Status |
|---|---|---|---|
| Open | `/` (`start-chat`, any editor, not in text edit; `,` on German/Nordic/Italian/Spanish layouts, `:` AZERTY, `Å` Swedish — ch03) | ch03 | CONFIRMED |
| Org switch | org setting `cursorChatDisabledAt` disables it | `figma_app.min.js` fmt L64111 | CONFIRMED |
| Input | one `<input maxLength 50>`, font 14 px Inter, width measured from the longer of the two lines | fmt L64454, L64518 | CONFIRMED (help says 52: the build's limit is **50 per line**) |
| Two lines | **Enter** moves the current line up (`previousLine`), starts an empty new line, and locks the bubble width; this is `ChatMessage{text, previousText}` on the wire | reducer `HANDLE_KEYDOWN` | CONFIRMED |
| Esc | closes; blur closes; switching tool / opening a menu closes (help) | reducer; R13 | CONFIRMED / INFERRED |
| Local idle | 5 000 ms after the last keystroke the bubble starts fading (`START_FADING_INACTIVE_CHAT`); at 8 000 ms it closes | fmt L64490 `}, 5e3)` … `}, 8e3)` | CONFIRMED |
| Remote bubble | full opacity on each change; opacity 0 at **5 000 ms**; removed at **8 000 ms** after the last change | fmt L64709–64716 | CONFIRMED |
| Placeholder | `whiteboard.cursor_chat.say_something` (shared by all editors) | fmt L64518 | CONFIRMED |
| FigJam-only extras | emote backgrounds and keyword emotes (`cursor_chat_emotes--*`), shake-to-high-five | `j2 = "whiteboard" === p2` | CONFIRMED |

### 4.4 High fives and reactions

- **High fives are FigJam only**: the cursor layer enables them only when the editor type is whiteboard
  (`em()` → `"whiteboard" === editorType`), `isHighFivingSupported` false in Design. CONFIRMED fmt L64428. The wiggle
  detector numbers (for completeness): min shakes to trigger 6.5, replenish 3.5, deactivation 6 s, about-to-hide 3 s,
  H key time 0.5 s, mouse reset 0.6 s, shake grace 0.3 s, shake reset 0.5 s, leave-canvas grace 0.3 s, movement decay
  1.5 s, min 0.1 s; collision → hands placed 32 px (scaled) from each cursor, burst at 0.3 s with 6 stars. CONFIRMED
  fmt L64280–64300, L64800–64825.
- **Cursor reactions** (emoji wheel, `CLIENT_BROADCAST.cursorReaction`) live 2 500 ms each; the wheel is 228 × 228 px.
  The `set-default-emoji-skin-tone` action exists only for FigJam/Slides/Buzz/Sites, and no Design action opens the
  wheel — INFERRED FigJam/Slides only (R13: not in Design). CONFIRMED (timings) `3187.min.js` fmt L41915.

### 4.5 Facepile (right panel header) and overflow

| Item | Value | Evidence | Status |
|---|---|---|---|
| Max visible avatars (others, quick access) | `min(floor(availableWidth / 21) + 1, 8)` when the properties panel is open and the width is measured; else **3** | `2108.min.js` fmt L20446 | CONFIRMED |
| Overflow split | if users ≥ max: show `max − 1`, the rest go to overflow (the count chip); else all | fmt L20511 | CONFIRMED |
| Popover's quick-access row | `maxVisibleUsers: 7` | fmt L29034 | CONFIRMED |
| Count chip | total = others + you (`eN.length + 1`); with gate `avatar_facepile_overflow_count` the chip shows the overflow count instead | fmt L29034 | CONFIRMED |
| Sort priority | you 0 → presenter 1 → the person you follow 2 → the file's creator 3 → most active speaker (audio) 4 → others 5 → anonymous last; ties by lower-cased name, then session id | fmt L20476 | CONFIRMED |
| Hidden sessions | a second "editor" device session that has not moved its mouse yet (`sawMouse === false`) is not listed; agent sessions (Figma's agent, external agents) are listed separately | fmt L20480–20487 | CONFIRMED |
| Same account, two tabs | two sessions, two avatars (R13 live) | | INFERRED |

### 4.6 Multiplayer tools popover

CONFIRMED `2108.min.js` fmt L29000–29034 unless said.

- Dark popover, `role="dialog"`, aria-label `fullscreen.toolbar.multiplayer.multiplayer_tools`.
- Header row: you (`avatar.tooltip.you` / "(You)"), then **Spotlight me** (`collaboration.spotlight.tooltip.spotlight_me`)
  or, while you present, **Stop** (`collaboration.spotlight.button.stop`); then the audio button
  ("Start conversation", §4.9). Spotlight may be disabled with a tooltip reason below.
- Search field appears when people + previous viewers > **8** (`collaboration.spotlight.menu.search.placeholder`);
  "No user found" (`fullscreen.toolbar.multiplayer.no_user_found`), result count `…search_results_count`.
- One row per other person ("Click to follow <name>" / "Click to unfollow"); with gate
  `multiplayer_tools_dropdown_page_names` the row shows the person's current page name.
- Row **More options** menu: **Ask to spotlight** / **Cancel ask to spotlight** (hidden for yourself, for the
  presenter, when spotlight is disabled, or in the viewer), **View profile** (not for anonymous users).
- **Previously viewed** section (`fullscreen.toolbar.multiplayer.previously_viewed`): people who opened the file before
  (from `fileViewHistory`, newest first), not in the file now.
- Agents (Figma's assistant and external agents) have their own rows and button (`agents_button_label` …) — out of scope.

### 4.7 Following (observation mode)

| Item | Value | Evidence | Status |
|---|---|---|---|
| Start | click an avatar / row (`observeUser(sessionID)` in the C++), or the bell's Follow | `2108.min.js` fmt L20560 | CONFIRMED |
| State | `multiplayer.observingSessionID` (−1 = none); sent as `UserChange.observing`; the observed side gets `isBeingObserved` | fmt L20570–20590 | CONFIRMED |
| Bell | colour = followed person's colour; text `collaboration.spotlight.bell.follower.following_non_presenter` ("Following <name>") or `…spotlight_on_presenter` when following the presenter; button `collaboration.spotlight.bell.stop_following` / Stop; **auto-hides** (not on mobile) | fmt L27030–27035 | CONFIRMED |
| Zoom mismatch | when the follower's zoom differs, a secondary button "Reset zoom" (`collaboration.spotlight.bell.reset_zoom`, gate `spotlight_zoom_override`) | same | CONFIRMED |
| Overlay | frame + bell fade in with opacity 0 → 1, ease-in, 100 ms | fmt L26985 `transition: { ease: "easeIn", duration: 0.1 }` | CONFIRMED |
| Reconnect | `MULTIPLAYER_OBSERVING_USER_RECONNECTED`; a lost presenter re-presents ("Spotlight Restarted After Disconnect") | wasm; fmt L15566 | CONFIRMED |
| Stop on canvas interaction | R13 live | | INFERRED |

### 4.8 Spotlight and "Ask to spotlight"

State machine (CONFIRMED `2108.min.js` fmt L26938–27060, L20540–20600):

| Self status | When | Bell |
|---|---|---|
| `presenting`, no follower yet | after Spotlight me | brand colour, "waiting for followers" (`…presenter.waiting_for_followers`) with a **4 000 ms progress bar** and **Cancel** |
| `presenting` | ≥ 1 follower | brand, follower count (`…presenter.follower_count`), **Stop** (aria `…stop_label` with count), docked |
| `prompt_to_accept_nomination` | someone asked you | brand secondary, "<nominator> …" (`…follower.nominated`), button **Spotlight me**, close ✕ = decline |
| `showing_explainer` | first time | `…bell.explainer` / `…explainer.takeover` (when replacing a presenter) |

| Others' status | When | Bell |
|---|---|---|
| `pending_auto_follow` | someone starts presenting | presenter's colour, "<presenter> is spotlighting" (`…spotlighting_presenter_alternate_copy`) with a progress bar and **Not now**; auto-follows after **4 000 ms** (0 ms if the presenter reconnected); when the presenter changes, "switching to <new presenter>" (`…switching_to_new_presenter`) and **2 000 ms** |
| `following` | following anyone | §4.7 |
| `prompt_to_rejoin` | a presenter you dismissed / stopped following | "<presenter> is spotlighting" (`…reprompt_spotlight_on_presenter`), **Follow** |
| `pending_presenter_view_follow` | a presenter in a prototype / deck view | `…presenting_in_viewer` / `…spotlight_in_viewer`, **Follow in viewer** (opens the deck) |

- Preference `collaboration.spotlight.auto_follow_label` / `…auto_follow_description` turns auto-follow off (then
  only the rejoin bell is shown). CONFIRMED `figma_app.min.js` fmt L64219.
- Presenter left: bell `…visual_bell.user_left_the_spotlight` / `…the_presenter_left_the_spotlight`. Nomination toasts:
  `…visual_bell.nominated_user_to_spotlight`, `…stopped_nominating_user_to_spotlight`. CONFIRMED.
- Wire: `CLIENT_BROADCAST.presenter = PresenterInfo{sessionID, nomination{sessionID, isCancelled}, isReconnected}`;
  prototype presenting uses `prototypePresenter`. CONFIRMED (schema).

### 4.9 Audio

Design files have it (Professional and up; Starter teams see `to_use_audio_in_this_file_move_it_to_a_team_on_one_of_our_paid_plans`).
Agora RTC (`enable_agora_transcriptions` gate, captions); `UserChange.voiceMetadata.connectedCallId`;
`GET /api/voice/:fileKey/users?user_ids=…`; states connecting / connected / connected with mic disabled / call inactive /
token will expire ("…we'll end the conversation in 20 seconds, click to stay on") / token expired; org switch
`audio_has_been_disabled_by_your_organization`; captions with text sizes small/medium/large/x-large. CONFIRMED
`3866.min.js`, `3187.min.js`. Out of scope for DesignerV2's first multiplayer pass (DesignerV2 already has a WebRTC
audio, docs/multiplayer.md §11).

## 5. Sharing

### 5.1 Permission levels and link access

| Level | Number | i18n (`permissions.level_name.*`) | Evidence |
|---|---|---|---|
| NONE | −1 | `none` / `no_access` | `3187.min.js` module 251565 |
| VIEW_PROTOTYPES | 30 | `can_view_prototypes` | same |
| VIEW_METADATA | 50 | — | same |
| VIEWER | 100 | `can_view` | same |
| EDITOR | 300 | `can_edit` | same |
| ADMIN | 900 | `admin` | same |
| OWNER | 999 | `owner` | same |

All CONFIRMED. Role names: `permissions.level_role_name.{owner, editor, viewer, prototype_viewer, admin}`;
`branch_owner` for branches.

`LinkAccess` (file audience): `invite_only`, `inherit`, `view`, `edit`, `org_view`, `org_edit`, `plan_view`,
`plan_edit`, `workspace_view`, `workspace_edit`. `ProtoLinkAccess` (prototype audience, a separate setting):
`inherit`, `view`, `org_view`, `plan_view`, `workspace_view`. CONFIRMED (`addEnum({name:"LinkAccess",values:[…]})`).
Audience rows: `file_access_row.{anyone_with_the_link, anyone_with_the_link_and_password, anyone_at_org_name,
anyone_at_org_name_with_the_link, only_people_invited_to_this_noun, can_view, can_edit, can_view_prototypes}`.

### 5.2 Share modal

Layout is in R13 §2.1 and the live capture. The build adds:

- Title per resource: `file_permissions_modal.share_this_{file, board, prototype, branch, spec, slides}`,
  `share_these_assets`; "Copy link" = `file_permissions_modal.copy_file_link` (`copy_folder_link` for folders).
- "Share as" rows (card 2): `share_as.copy_dev_mode_link`, `share_as.copy_prototype_link`,
  `share_as.copy_presentation_link`, `share_as.embed`, `share_as.publish` (Community), `share_as.publish_template`,
  `share_as.google_classroom`, `share_as.google_device` (screenshare code with countdown), `share_as.more`,
  `share_as.share_settings`, `share_as.nudge_to_move_text` (the Drafts "move to folder" nudge). A copied row shows
  `file_permissions_modal.link_copied` for **4 000 ms**. CONFIRMED (`setTimeout(…, 4e3)`).
- Who has access: direct roles, user-group permissions, then inherited roles from the folder/team
  (`permissions_from_folder`, `file_name_s_team`), pending invites (`autocomplete_permissions.invite_pending`); the
  invite autocomplete groups "have access" vs "invite" and shows "n more people".
- Changing a role: `PUT /api/roles/:id {…role, cascade, response_version: 2}`; listing:
  `GET /api/roles/:resourceType/:resourceId`, `GET /api/roles/file_users/:key`. Removing yourself warns
  `confirm_lose_access_warning`; the "can still edit / see" explanations (`permissions.can_still_edit_*`) say which
  inherited route still grants access. CONFIRMED (endpoints, keys).
- Invites: `POST /api/invites {emails, resource_type, resource_id_or_key, level, node_id, initial_view, git_branch,
  billable_product_key, user_group_ids}` — `node_id` makes the invite open on the selection. Resend:
  `/api/invites/resend` (`invite_email_sent_again`); revoke errors `failed_to_revoke_invite`. "Send link to people who
  can already access": `PUT /api/invites/file_link_access {emails, …, node_id}` → `link_has_been_sent`. Errors:
  `please_provide_a_valid_email_address`, `no_new_users_invited`, guest / external warnings
  (`permissions.confirm_guest_invite.*`). CONFIRMED.
- File settings (link access, password, export, expiry): `PUT /api/files/:key`. CONFIRMED (route); field names INFERRED.

### 5.3 Share settings (sub-view)

| Control | Values | Evidence | Status |
|---|---|---|---|
| Who can access | `permissions.audience_selector.{only_invited_people / people_invited_to_resource, org_members, workspace_members, plan_members, anyone}` with captions (`anyone_even_those_outside_your_org_can_access_this_resource`, `audience_can_access_through_link_or_file_browser`, …, `can_access_through_search_file_browser_link`) | i18n keys | CONFIRMED |
| What can they do | `can_view_and_comment_on_this_file` / `can_edit_this_file` | keys | CONFIRMED |
| Additional security › Password required | field `file_access_row.passwords.add_a_password`, **Generate** (`generate_password`, toast `password_generated`), copy button ("Copy password", toast `passwords.copied`), `please_enter_a_password`; org may force auto-generated passwords (`autogen_password_controls`); who set it: `link_password_set_by_current_user/another_user/without_user`; `link_password_reset` | `3187.min.js` fmt L96528–96535 | CONFIRMED |
| Link expiration | **1 day**, **1 week**, **Custom** (a date, then a time at whole hours; at most 1 year ahead and not past an org limit — `past_max`, `past_org_limit_days/hours`); "Link expires in …" / "Expires on <date>"; when the time comes the open client calls `PUT /api/files/:key/expire_public_link` | fmt L96537–96560; `expire_public_link` | CONFIRMED |
| Discoverable via search (org) | checkbox `discoverable_via_search` | key | CONFIRMED |
| Advanced | "Viewers can copy, save, and export from this file" (`viewers_can_copy_save_export`), caption "This setting applies to anyone with view access" / to members-viewers; org setting `file_export_setting` `banned` greys it (`viewers_cannot_export_hover`), `members_only` changes the caption; file flag `viewerExportRestricted` | fmt L96519 | CONFIRMED |
| Prototype / presentation | same view for the prototype audience: "Any changes you make will only update access to the prototype / presentation" | keys | CONFIRMED |

### 5.4 Copy link variants

| Source | Link | Toast | Evidence |
|---|---|---|---|
| Share › Copy link | file URL, with `node-id` of the selection's frame (help: nested → parent) | `file_permissions_modal.link_copied` | R13; key |
| `copy-link` (⌘L, desktop; right-click › Copy link) / `page-copy-link` | `node-id` of the node; toast by node type: FRAME → "frame link copied", SECTION → "section link copied", a page in a file with > 1 page → "page link copied", else "file link copied"; Dev Mode overview → "summary link copied" | `desktop_bindings.interstitial.{frame,section,page}_link_copied`, `desktop_bindings.visual_bell.{file,summary,slide_deck}_link_copied` | `3187.min.js` `copyLinkToPage` — CONFIRMED |
| Copy Dev Mode link | `?m=dev` | `link_copied` | key |
| Copy prototype link | `/proto/…` | `permissions.copy_link_button.visual_bell.copy_prototype_link(_name)` | key |

Editor URL query the client writes (CONFIRMED `3187.min.js` fmt L72510–72531): `node-id` (hyphenated form),
`m=auto|dev`, `version-id`, `compare-version-id`, `compare-latest=1`, `p=f` (when the node is a page/document),
`t=<sharing attribution key>`, `viewport`, `check-designs=1`, `review-number`, `merge-branch-key` …, `timeline`,
`timeline-playback-time`. Path segment by editor: `design`, `board`, `slides`, `site`, `buzz`, `make`, `spec`, `weave`.

### 5.5 Embeds

`permissions.embed.{copy_embed_code, copy_public_embed_code, embed_page_name_in_your_webpage, cancel_embed}`; hosts
`embed.figma.com`. Rules (password-protected files cannot embed; view access needed) in R13 §2.7. CONFIRMED (keys).

## 6. Access requests ("Ask to edit")

| Step | Behaviour | Evidence | Status |
|---|---|---|---|
| Eligibility | `GET /api/files/:key/can_request_edit` | `3187.min.js` | CONFIRMED |
| Request | `POST /api/files/edit_request {file_key}`; error "Org access needed" opens the join-org form (`permissions.join_org.*`) | module 613238 | CONFIRMED |
| Button | `fullscreen.toolbar.request.ask_to_edit` in the view-only banner (§7); tooltip `role_request.edit_request_tooltip.*` | keys | CONFIRMED |
| Editors' side | Share button badge (`fullscreen.toolbar.multiplayer.share_pending_requests`); modal section `role_requests.header_text`, `role_requests.num_pending_requests`, rows with `role_requests.edit` / `role_requests.view` | keys | CONFIRMED |
| Approve / deny | `POST /api/files/role_request/:id/accept|deny {source}`; row result `role_request_row.request_approved_for_user…` / `…denied…` | endpoints | CONFIRMED |
| Requester | toasts `file_request_tooltip.toast.edit_request_approved/declined`, `…view_request_approved/declined` | keys | CONFIRMED |
| Request from the file browser (no access) | modal `file_browser.request_access_modal.{request_view_access, request_edit_access, access_level_for_user, request_access_reason_placeholder}` | keys | CONFIRMED |
| Self-grant | `POST /api/files/:key/grant_self_editor_role` (admins / eligible seats) | endpoint | CONFIRMED |

## 7. Permissions in the editor (what a viewer gets)

- Every editor action carries `isEdit` (ch03's table: "edit" vs "view" column). A can-view session has
  `canEdit = false`; edit actions are disabled, and the C++ marks the few edits allowed while read-only
  (`canWriteInReadOnly` on actions — local-only state such as selection, viewport, measurements). CONFIRMED (flag names);
  INFERRED (the exact allowed set; see ch03).
- View-only banner (`ViewOnlyToolbeltBanner`, `bannerType: "view_only"`): left icon, text
  `fullscreen.toolbar_banner.you_can_only_view_and_comment_on_this_file`, right the "Ask to edit"/request button,
  close ✕ hides it for the session; lifts toasts above it (`shouldIncreaseToastBottomPositioning`). With a
  seat-upgrade case the text becomes `1_click_expansion.you_need_a_full_seat`. CONFIRMED `9905.min.js`.
- View-only onboarding: `view_only_design_onboarding.so_what_do_you_think`, `…leave_a_comment_anywhere_in_the_canvas…`.
- Export / copy for viewers: `canExport`, `canCopyContents`, file `viewerExportRestricted(At)`; plugins need edit
  (`permissions.join_org.cannot_run_plugins`). CONFIRMED (names).
- Server conversions: an editor past the editor cap becomes a viewer with a hidden cursor (§2.3); `Message.access`
  (`READ_ONLY` / `READ_WRITE`) tells the client its access. CONFIRMED (schema + toast).

## 8. UI strings

i18n keys of the area (the English bundle is not in the cache). English is given where attested — **[R13]** =
`docs/research/figma/R13-multiplayer-sharing.md` / live capture, **[repo]** = DesignerV2's own `t()` strings modelled on
them, else the key's words.

Presence and spotlight:
- `fullscreen.toolbar.multiplayer.multiplayer_tools` — "Multiplayer tools" [R13]
- `fullscreen.toolbar.multiplayer.follow_a_name` / `unfollow_name` — "Follow <name>" / "Unfollow <name>" [R13 aria]
- `collaboration.spotlight.tooltip.click_to_follow` / `click_to_unfollow` — "Click to follow" [R13]
- `collaboration.spotlight.tooltip.spotlight_me` — "Spotlight me" [R13]
- `collaboration.spotlight.button.stop`, `collaboration.spotlight.bell.stop`, `…bell.presenter.stop` — "Stop" [R13]
- `collaboration.spotlight.tooltip.ask_to_spotlight` — "Ask to spotlight" [R13]; `…menu.cancel_ask_to_spotlight`
- `collaboration.spotlight.bell.follower.following_non_presenter` — "Following <name>" [R13]
- `collaboration.spotlight.bell.follower.spotlighting_presenter_alternate_copy` — "<name> is spotlighting" [repo]
- `collaboration.spotlight.bell.follower.not_now` — "Not now" [R13 help]; `…follower.follow` — "Follow" [R13]
- `collaboration.spotlight.bell.follower.nominated` — "<name> is asking you to spotlight" [repo]
- `collaboration.spotlight.bell.presenter.waiting_for_followers`, `…presenter.follower_count`, `…presenter.cancel`,
  `…bell.reset_zoom`, `…bell.stop_following`, `…bell.stopped_following`, `…bell.explainer(.takeover)`,
  `…follower.switching_to_new_presenter`, `…follower.reprompt_spotlight_on_presenter`, `…follower.presenting_in_viewer`,
  `…follower.follow_in_viewer`, `…visual_bell.user_left_the_spotlight`, `…visual_bell.the_presenter_left_the_spotlight`,
  `…visual_bell.nominated_user_to_spotlight`, `…auto_follow_label`, `…auto_follow_description`,
  `…onboarding_observation.title/.description`, `…onboarding_spotlight.title`
- `fullscreen.toolbar.multiplayer.previously_viewed`, `…currently_viewing`, `…no_user_found`, `…search_results_count`,
  `…anonymous`, `…you`, `avatar.tooltip.you` — "(You)" [R13], `avatar.tooltip.view_profile` — "View profile"
- `visual_bell.multiplayer_cursors_hidden` / `…visible`; View menu "Multiplayer cursors" [R13]
- `whiteboard.cursor_chat.say_something` (cursor chat placeholder)
- `multiplayer_limit.cursor_limit_modal_title/content`, `multiplayer_limit.editor_limit_modal_title.seat_rename`,
  `multiplayer_limit.more_info`, `multiplayer_limit.help_center`, `multiplayer_limit.done_button`
- `multiplayer_connection_error.too_many_connections.title/.content/.view_only_button` — "Open view-only" [R13 help]
- `unsaved_changes.syncing.*` (§2.3), `unsaved_changes.disconnected.*` (§2.4), `banner.multiplayer_session_upgrade.*`,
  `multiplayer_upgrade_modal.*`
- Audio: `collaboration.voice.start_conversation` — "Start conversation" [R13], `…join_conversation`, `…connected` —
  "Connected" [R13], `…leave`, `…click_to_mute/unmute`, `…num_users_in_call`, `…closed_captions`, and the error/idle
  keys of §4.9.

Sharing:
- `file_permissions_modal.share_this_file` — "Share this file" [R13]; `copy_file_link` / Copy link — "Copy link" [R13]
- `file_permissions_modal.send_invite` / `send` — help "Send invite", live "Invite" [R13]
- `file_permissions_modal.who_has_access` — "Who has access" [R13]
- `permissions.level_name.{owner, can_edit, can_view, can_view_prototypes}` — "owner", "can edit", "can view",
  "can view prototypes" [R13]
- `permissions.audience_selector.only_invited_people` / `people_invited_to_resource` — "People invited to file" [R13];
  `…anyone` — "Anyone" [R13]; `…anyone_even_those_outside_your_org_can_access_this_resource` — "Anyone, even those
  outside your organization, will be able to access this file." [R13]
- `permissions_modal.file_share_settings.can_view_and_comment_on_this_file` — "Can view and comment on this file." [R13]
- `permissions_modal.file_share_settings.{additional_security, password_required, advanced, viewers_can_copy_save_export,
  this_setting_applies_to_anyone_with_view_access, link_expiration, link_expires_in, expires_on_date, one_day, one_week,
  custom_time, discoverable_via_search}` — "Additional security", "Password required", "Advanced", "Viewers can copy,
  save, and export from this file", "This setting applies to anyone in the file with can view access" [R13 for those]
- `file_access_row.passwords.{add_a_password, generate, generate_password, password_generated, copied}` — "Add
  password", "Generate" [R13]
- `file_permissions_modal.share_as.{copy_dev_mode_link, copy_prototype_link, copy_presentation_link, embed, publish,
  more, share_settings}` — "Copy Dev Mode link", "Get embed code", "Publish to Community", "More" [R13]
- `file_permissions_modal.link_copied`, `…share_as.link_copied`, `desktop_bindings.interstitial.{frame,section,page}_link_copied`,
  `desktop_bindings.visual_bell.{file,summary}_link_copied`
- `permissions.embed.{copy_embed_code, copy_public_embed_code, embed_page_name_in_your_webpage}`
- `fullscreen.toolbar.multiplayer.share` — "Share" [R13]; `…share_pending_requests`
- `fullscreen.toolbar_banner.you_can_only_view_and_comment_on_this_file` — "You can only view and comment on this
  file." [R13]; `fullscreen.toolbar.request.ask_to_edit` — "Ask to edit" [R13]
- `role_requests.header_text`, `role_requests.num_pending_requests`, `role_request_row.*`,
  `file_request_tooltip.toast.*`, `file_browser.request_access_modal.*`
- Transfer ownership: `file_browser.modal.transfer_ownership_title`, `…transfer_ownership_cta` — "Transfer ownership"
  [R13 help], `…are_you_sure_to_transfer_ownership`, `…cant_transfer_ownership_title`,
  `…this_resource_is_for_sale_on_community_so_you_cant_change_ownership`.

## 9. DesignerV2 today

Checked against `docs/multiplayer.md` §3–§6, `src/shared/multiplayer/`, `src/renderer/src/editor/multiplayer/`,
`server/src/api.ts`.

| Area | DesignerV2 | Figma (this chapter) | Verdict |
|---|---|---|---|
| Wire | own frames `[u8 kind][u32 seq][u32 sessionID][u32 batch][kiwi Message]`; presence as JSON `{t:"presence"}` | kiwi `Message` for everything; presence = `USER_CHANGES`, broadcasts = `CLIENT_BROADCAST`, server notices = `SIGNAL` | differs (fine for Phase 6; keep the Message fields free so a later switch is mechanical) |
| Acks | room echoes the frame to the sender | `ackID` echoed; RTT measured; disconnect after an ack timeout | matches in spirit; **missing**: ack timeout → reconnect |
| Reject / signals | close codes 4001/4003/4012 | named signals and rejects with the exact UI per case (§2.3) | partly; the per-case wording is missing |
| Per-property LWW, ignore remote while unacked | yes (`conflict.ts`, §5) | yes | matches |
| Auto layout oscillation guard | no | yes ("Skipping auto layout…") | **missing** |
| Text | atomic | atomic for TEXT; op-based only for code / spec blocks | matches |
| Incremental page loading | whole snapshot | per-page `SCENE_GRAPH_QUERY` | missing (not needed at our sizes) |
| Colours | 12 colours by `(sessionID − 1) mod 12` (`colors.ts`), incl. #0d99ff, #ff7262, #1bc4b5, #a259ff, #fe7a00, #4d6aff | **7 colours** (#667799, #007be5, #9747ff, #ff24bd, #f24822, #ffcd29, #14ae5c), dark-theme variants, black text on yellow | **differs** |
| Avatar placeholder colour | initials | userId last-4-digits mod 7 over the same 7 | differs |
| Facepile size | `MAX_SHOWN = 3` | `min(floor(w/21)+1, 8)` (3 when panel collapsed); overflow = max−1 shown | **differs** |
| Facepile order | room order | you, presenter, followed, file creator, speaker, others, anonymous; then name | **missing** |
| Idle cursor hide | no | hidden after 60 s without movement | **missing** |
| Cursor chat | 52 characters, gone 5 s after typing | 50 per line, two lines (Enter), fade at 5 s, gone at 8 s (local and remote) | **differs** |
| Spotlight auto-follow | 3 000 ms | 4 000 ms (2 000 ms when the presenter changes; 0 after a presenter reconnect); presenter "waiting for followers" bell with 4 s bar + Cancel | **differs** |
| Spotlight explainer / rejoin / auto-follow preference | rejoin yes; explainer, auto-follow preference no | yes | partly |
| Reset zoom while following | no | "Reset zoom" secondary button | missing |
| Multiplayer tools | you, Spotlight me, follow rows, Ask to spotlight | + search when > 8, previously viewed, View profile, page names, Cancel ask | partly |
| High fives / reactions | none | FigJam only | matches (nothing to do) |
| Link access | none / viewer / editor + proto link access + expiry + password + viewers-can-copy | full `LinkAccess` / `ProtoLinkAccess` enums; expiry 1 day / 1 week / custom (hours, ≤ 1 year) | matches for our plan scope; check our expiry choices match these three |
| Copy link toasts | "Link copied!" | frame / section / page / file wording by node type | **differs** |
| Ask to edit | yes (requests, Deny / Approve, toast) | yes, plus file-browser request modal and view requests | matches (core) |
| Audio | WebRTC (own) | Agora, captions, idle end after warning 20 s | out of scope |

## 10. Top gaps for Phase 6 (ordered)

1. Palette: switch `PEER_COLORS` to Figma's 7 colours with the dark-theme variants and the yellow text rule; assign
   per session on the server (least used).
2. Facepile: width-driven count `min(floor(w/21)+1, 8)`, overflow `max−1`, Figma's sort priority.
3. Cursor chat: 50 per line, two-line Enter behaviour, 5 s fade / 8 s gone on both sides.
4. Spotlight: 4 000 ms auto-follow, 2 000 ms on presenter change, presenter "waiting for followers" bell, Reset zoom.
5. Remote cursors hidden after 60 s idle; ack timeout → reconnect; the auto-layout oscillation guard in the engine.

## 11. Open questions

| Question | Probe |
|---|---|
| The socket path and full query (`mpGlobal.url`) | Live: DevTools › Network › WS on figma.com, copy the request URL |
| Ack timeout seconds, presence send rate (USER_CHANGES per second), heartbeat cadence | Live WS capture with two sessions; count frames per second while moving the mouse; leave a tab in background |
| How the server picks a session colour (least used? hash?) | Live: open the same file in 8+ sessions and record the colours in join order |
| `cursorHiddenReason` values | Live WS capture past the 200-cursor cap (not practical) or a binary search in the wasm for the enum |
| Auto-hide delay of the "Following <name>" bell | Live: follow someone and time the bell |
| What exactly ends following (pan / zoom / click / key) | Live, one gesture at a time |
| The help site's 52-character chat limit vs the build's 50 per line | Live: type 60 characters, then Enter and type again |
| Exact copy-link `node-id` choice for nested selections | Live: select a nested layer, ⌘L, read the clipboard |
| Field names of `PUT /api/files/:key` for link settings | Live: change Who can access with DevTools open |
| The pending-invite row wording ("Invited" / "Resend") | Live: invite an address with no account and read the row |
