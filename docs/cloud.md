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
