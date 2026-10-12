# Cloud storage, Figma's way (contract, Wecra 1.1; written 2026-10-12)

The owner's decision (2026-10-12): files live on the server like Figma's; the computer keeps a cache. Figma's own
shape (its engineering blog: "How Figma's multiplayer technology works", "Making multiplayer more reliable", "How Figma
scaled to multiple databases"): a multiplayer server per open file + a journal, checkpoints and images in object storage
(S3, content-addressed, through a CDN), metadata in Postgres, a client cache. Ours already has the room (Durable Object
`FileRoom`), the journal (the room's SQLite `frames`) and the metadata (D1). What changes:

1. **Object storage: Cloudflare R2** (S3's counterpart; no egress fees; 10 GB-month, 1M Class A and 10M Class B
   operations a month included, then $0.015/GB-month). Bucket `wecra-files` (binding `FILES`), plus `wecra-files-eu`
   (binding `FILES_EU`, jurisdiction `eu`) for orgs with the EU data region (docs/multiplayer.md §15.10).
2. **Personal Drafts on the server** (Figma: every account's Drafts are in the cloud). The local "My team" space goes;
   the computer holds a cache of the person's files.

## 1. What goes to R2

Content-addressed, immutable, keyed by the SHA-1 already used everywhere (`blobs`, `images/<sha1>`):
- **Images and blobs** of every file: `b/<sha1>` (one copy per bucket, shared by every file that uses it; reference
  counting in D1 `r2_refs (sha1, file_key)` decides deletion — the daily cron deletes unreferenced objects older than 7 days).
- **Checkpoints** (the room's `snapshot`, `history_snapshots`, `base_chunks`): `c/<fileKey>/<seq>` — written once, read on
  wake / version open. The room keeps in SQLite only the live journal `frames` since the last checkpoint, `meta`, version
  metadata and an index of checkpoint keys.
- **REST job parts** (`rest_blobs`), **library payloads and images**, **preview documents and images**, **org/team icons**,
  **shared fonts**: their own prefixes (`r/`, `l/<libKey>/`, `p/<id>/`, `i/`, `f/`).
- Encryption (docs/governance.md §2.10): objects of orgs with key management are sealed with the same `RoomCipher` (v2,
  AAD `fileKey|kind`) before `put`; content addressing uses the plaintext SHA-1 inside the org's own prefix
  `e/<orgId>/b/<sha1>` (no cross-org dedup for encrypted orgs).
- Reads go Worker → R2 directly (not through the room) with the same access checks as today; responses are
  `cache-control: private, max-age=31536000, immutable` (the client caches by hash).
- **Migration:** existing rows stay readable; the room moves its checkpoints and blobs to R2 lazily on wake (one file at
  a time, idempotent), and an operator loop `POST /operator/storage/migrate-next` drives the rest. No downtime.

## 2. Personal Drafts in the cloud

- A personal file is a server file with `org_id NULL` and `owner_id` = the person (today's "shared files" already are);
  `files.space = 'personal'` marks Drafts (vs. files merely shared by link). Figma's personal Drafts are flat (no
  folders); ours too. Personal Trash: `trashed_at` (30 days, then the daily cron deletes, as Figma).
- Routes: `GET /me/drafts` (+`?trashed=1`), `POST /me/drafts {name}` (creates file + empty snapshot), the existing file
  routes for rename/trash/restore/delete forever, `PATCH /files/:key {space}` to move between Drafts and org folders.
- **Store:** the local workspace becomes a cache (`Workspace/cache/…`): every file the person opens is a linked copy
  (as org files are today), edits sync through the room, offline edits queue in the journal and resend (existing
  multiplayer machinery). New file → server file first; offline → created locally with `pendingCreate`, registered when
  online (upload panel shows it).
- **Home:** the personal space is "Drafts" under the person's name (Figma: the account row, then Drafts / Trash);
  "My team", local folders and "All folders" go. Recents spans all spaces (server-backed).
- **Migration of existing local files:** on first launch of 1.1, every local file not yet linked is uploaded into the
  person's Drafts (upload panel; the local folder name becomes a prefix in the file name, e.g. "KOC / Logo", since Drafts are flat).
  Nothing is deleted locally until the upload is confirmed.
- **Offline:** files opened before stay openable offline (cache); Home lists the cached ones with an offline badge.
  The cache is bounded (default 5 GB, LRU by last opened; settings to change it).

## 3. Quotas and the spend guard

- `storage_bytes` per account default 20 GB (counted on R2 bytes; shared blobs counted once per uploader), server-wide cap
  removed — the spend guard decides; operator overrides stay.
- The spend guard adds R2: storage (`r2StorageAdaptiveGroups`), Class A / Class B operations
  (`r2OperationsAdaptiveGroups`), with included amounts 10 GB-month, 1M, 10M.

## 4. Uploads

- Blobs upload **4 at a time** (bounded concurrency), checkpoints after their blobs; the upload panel shows speed
  (MB/s, moving average) and time left.
- Big blobs (> 8 MB) use R2 multipart through the Worker (`POST …/uploads`, `PUT …/parts/:n`, `POST …/complete`) so a
  failed part retries alone.

## 5. Work split (Wecra 1.1)

| Agent | Owns |
|---|---|
| A server storage | `server/` R2 bindings (`wrangler.jsonc`), checkpoints/blobs/rest/library/preview/icons/fonts → R2, lazy + operator migration, EKM on objects, EU bucket, `r2_refs` + cron, quotas, spend guard R2 metrics, multipart routes; migration `0022`; client side only `src/store/multiplayer/uploads.ts` + the upload code paths in `service.ts` for 4-way concurrency, multipart and speed/ETA, and `src/renderer/src/uploads/` for the speed line |
| B personal cloud | server personal Drafts routes (`server/src/personal/` new + dispatch lines), store cache model + migration of local files + offline (`src/store/` except A's upload paths), Home (`src/renderer/src/files/`), Settings cache size |

Merge order: A, then B. Deploy: create buckets (`wrangler r2 bucket create wecra-files`, `… wecra-files-eu --jurisdiction eu`),
migration 0022, deploy, then the 1.1 app.

## 6. As built — B, personal Drafts in the cloud (2026-10-12)

**Server** (`server/src/personal/routes.ts`, migration `0023_personal_drafts.sql`):
- `files.space TEXT CHECK (space IN ('personal'))`; 0023 makes every file outside an org (not a branch) its owner's
  draft (1.0.x shares were the owner's local drafts). Legacy `POST /files` (no org) now writes `space = 'personal'`.
  `FILE_COLS` carries `f.space`; `GET /files/:key` answers `space`.
- `GET /me/drafts[?trashed=1]` → `{files: PersonalFile[]}` (owner = caller, `space = 'personal'`, no org, branches left
  out; newest change / newest trashed first). Sessions only (a personal access token: 403).
- `POST /me/drafts {key?, name?}` → `{key, name, role: "owner", file}` (201; the same owner's key again: 200, the same
  draft — the store's retries after a lost answer). Quota `shared_files`, external-content policy, suspension checked.
  The document is uploaded by the client after (as a share): a draft registered whose upload never landed answers
  `no_snapshot`, and the store opens it as a new document and finishes the upload. (Deviation: the server writes no
  empty snapshot — the Worker doesn't carry the schema codec.)
- Rename / trash / restore / delete forever are the file routes': `POST /files/:key/trash|restore` now take a personal
  draft (its owner only); `DELETE` deletes at once (as before for files outside orgs).
- `PATCH /files/:key {space}`: `{orgId, projectId|null}` moves the owner's draft into an org (it is `createOrgFile`'s
  move-in, which now clears `space`); `"personal"` takes the owner's org draft (no folder) back to their Drafts.
- Daily cron: `purgePersonalTrash` deletes drafts 30 days in the trash (room, branches, rows), 200 per run.

**Store** (`src/store/personal/service.ts` `PersonalService`; `StoreApi.cloud`, topic `cloud`):
- Records: `FileMeta.cloud {uid, key, pendingCreate?, remote?}` (`src/shared/store/cloud.ts`). The workspace's records
  are the cache (in `Workspace/files/`, not a new `Workspace/cache/` — no on-disk move). A draft listed by the server and
  never opened here is a record with no document (`remote`); opening it (`files.open`, Duplicate, Save local copy)
  downloads its room's snapshot into the record (`MultiplayerService.linkInto`). Offline it refuses: "“X” isn't available
  offline. Connect to the internet to open it."
- Accounts: `WorkspaceModel.account` (the signed-in uid) — Drafts, Trash and search list that account's drafts only,
  Recents / Starred hide other accounts'; Drafts are flat (folders ignored). Links carry `LinkRecord.uid` and join rooms
  only with their own account's session (no more dropping another account's links on a switch).
- New files (Design, Duplicate, Import .fig incl. main's Open dialog, Duplicate version) are `pendingCreate` drafts with a
  reserved room key, registered at once in the background through `MultiplayerService.shareTo` (`POST /me/drafts`, then
  A's upload path — the upload panel shows "Drafts"); offline they stay pending and register when the server answers
  again (each sync: session start, the inbox reconnecting, Home shown / focused, a 60 s retry while something waits).
- Writes on a registered draft go to the server first (rename `PATCH`, trash / restore, delete forever / Empty trash);
  offline they fail `offline` with nothing changed here. `refresh()` makes the records say what the server says (names,
  trash, new drafts from elsewhere; a draft gone from the list is asked about: deleted → the record goes, moved into an
  org → it becomes the org copy, given away → it stays as a shared copy).
- Migration (1.1): at a sign-in, every local file that is no draft yet — not an org copy, branch or someone else's
  linked file — is marked a pending draft of that account, its folder path a name prefix ("KOC / Brand / Icon"), its
  folder dropped, a trashed one (itself or by its folder) kept trashed; then registered one at a time (the server's
  trash too). A file shared before 1.1 by its owner just becomes the draft (its link claimed). Nothing is deleted;
  idempotent (the reserved key makes a repeated `POST /me/drafts` the same draft; the next start goes on with what is
  pending).
- Cache: `Workspace/cloud.json {v, limitBytes}` (default 5 GB; Settings: 1–50 GB, ≥ 256 MB). Size = each cached draft's
  directory plus its images. Over the bound, least recently opened (`prefs.viewedAt`) first; never one open, a published
  library, one with unacknowledged edits or an upload not finished. Eviction keeps the record, the thumbnail and the
  device's session counter (`sessions.json`, so a later download never reuses a session id). Checked after a file
  closes, a download and every sync. Org copies aren't counted or evicted.
- Tests turn it off with `LocalStoreOptions.personalDrafts: false` where they test local files' own behaviour.

**Home** (`src/renderer/src/files/`): signed in (`cloud.status().uid`), the space row is the person (name and photo),
then Drafts and Trash — no All folders, folder tree, New folder, starred folders, team Rename; "Move to folder…" only
when there is an org to move into (its local section is Drafts alone). Folder pages fall back to Drafts. Offline
(`checked && !online`): "You’re offline. Files you’ve opened on this computer are still available." over the list, only
cached drafts listed, each with "Available offline" (`FileCard.badge`). The switcher's personal entry is the person's
name. Settings › Account: "Your spaces" shows the person's space; **Offline cache** (size, "N used by M files", Clear
cache). Signed out / the browser's dev store (`localOnlyCloud`): the local workspace as before.

**Not done:** server-backed Recents (Recents spans spaces from this computer's views); thumbnails of drafts never opened
here (cards show none until opened); org copies in the cache bound.

**First launch of 1.1 (the owner):** Home opens with the person's name in the sidebar and Drafts holding every local
file, folder files renamed "Folder / File"; the upload panel lists them uploading one by one to "Drafts" (big files take
a while; quitting resumes them next time). Nothing local is removed. The `shared_files` quota (200) and `uploads_per_day`
apply to the migration — raise them for the account as operator first if the workspace holds more.
