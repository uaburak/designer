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

## 6. As built — A, server storage (2026-10-12)

- **Bindings** `FILES` (wecra-files) and `FILES_EU` (wecra-files-eu, jurisdiction eu) in `server/wrangler.jsonc`. Without
  them (a server not yet given R2, most older tests) everything stays in SQLite as before — every path checks.
- **Code**: `server/src/storage/` — `objects.ts` (the `ObjectStore` part of `R2Bucket`, keys, `r2Redirect` / `resolveR2`),
  `refs.ts` (`r2_objects`, `r2_refs`, `sweepR2`), `blobs.ts` (the Worker's image routes), `sealing.ts` (the org's object
  cipher in the Worker), `roomObjects.ts` + `roomHost.ts` (a room's checkpoints, trash, lazy step, relocation),
  `boxObjects.ts` (libraries', fonts', icons' and previews' bytes), `relocate.ts` (a region move's images),
  `migrate.ts` (the operator's loop). Tests: `storage/r2.test.ts`, `storage/boxes.test.ts`, with
  `testing/memoryR2.ts` (an in-memory bucket counting Class A / B, multipart with R2's 5 MiB rule).
- **Reads**: a Durable Object answers a plain object by name (`x-r2-key`, `x-r2-bucket`, no body) and the Worker's stub
  wrappers (`roomsOn`, `objectFetch` / `libraryFetch`, previews' `box`) stream it from R2 — the bytes never pass through
  the object. Sealed checkpoints and REST parts are opened by the room; sealed images by the Worker (`sealing.ts`).
- **Region**: the Worker says each call's region (`x-region: eu | default`); a room or library keeps it in meta and
  writes nothing to R2 until it knows (an EU object never writes into the default bucket). A region move copies the
  copy's checkpoints into its bucket (`POST /room/storage/relocate`, `/relocate` for libraries) and re-homes the file's
  images (`relocate.ts`) before the flip; the old room's objects go with it, old images are swept.
- **Key management**: checkpoints and REST parts sealed with the room's cipher (AAD `<fileKey>|snapshot` etc., as the
  rows were) under `e/<orgId>/c/…`, `e/<orgId>/r/…`; images under `e/<orgId>/b/<sha1>` sealed with AAD **`<orgId>|blobs`**
  — not the file key: one image object is shared by the org's files. Turning key management on rewrites a room's plain
  checkpoints sealed (`encryptAll`). Multipart isn't offered to such orgs (409 `multipart_unavailable`: the Worker seals a
  whole image, ≤ 40 MB, in one PUT). Library payloads, fonts, icons and previews aren't sealed (they weren't before).
- **Images**: `missing` refers a file to an existing object without its bytes **only** when a file of the same org
  (outside orgs: of the same owner) that the caller owns or was invited to edit already uses it (`refs.ts reusableQ`;
  the multipart start likewise) — a hash alone never claims another tenant's image. Otherwise it is missing: the bytes
  are sent, their SHA-1 checked, then referenced, and an object already in the bucket isn't written again (the owner charged once:
  `stored_items` `b:<ownerId>:<sha1>`), PUT streams with a declared length (hashed on the way with `DigestStream`, the
  object dropped again if the hash lies), multipart assembles at `u/<fileKey>/<sha1>` and is checked before it becomes
  `b/<sha1>`. Rows a room held before stay readable (the Worker asks the room when the file has no reference).
- **Sweep** (daily cron): references of files deleted for good dropped (stored bytes released where it was the owner's
  last use), unreferenced objects orphaned, orphans older than 7 days deleted; a new reference within the grace keeps one.
- **Migration**: one step per wake in the background (`FileRoom.wakeStep`, the boxes likewise); `GET /operator/storage`
  (progress) and `POST /operator/storage/migrate-next {after?}` → `{files, libraries, key, kind, done, moved, cursor,
  finished}` (a big file takes several calls; a failing one is stepped past with `after: cursor`). Migrated images keep
  their old `f:<key>:b:<sha1>` charge (no `owner_id` on their reference). `files.storage_r2_at` / `libraries.storage_r2_at`.
- **Quotas**: `storage_bytes` 20 GB; `server_storage_bytes` enforced only when the operator sets it. Spend guard: three
  more metrics (`r2_storage_bytes`, `r2_class_a`, `r2_class_b`; 10 GB, 1M, 10M).
- **Client**: `src/store/multiplayer/uploads.ts` `sendBlobs` (4 at a time, > 8 MB in 8 MB parts, a part retried alone,
  Cancel aborts the multipart upload; an older server's 404 or `multipart_unavailable` falls back to one PUT), the
  snapshot after its images; library parts 4 at a time; the tracker's moving-average speed (5 s window, said after 1 s)
  and time left; the panel's line "3.2 MB/s · About 2 minutes left" (ours).
- **Owner steps**: `cd server && npx wrangler r2 bucket create wecra-files && npx wrangler r2 bucket create wecra-files-eu
  --jurisdiction eu`; `npm run db:migrate` (0022); `npm run deploy`; then run the operator loop until `finished`. The spend
  guard's token (Account Analytics: Read) should read R2's datasets too; if Settings › Operator says R2 usage is
  unknown, add "Workers R2 Storage: Read" to it.
