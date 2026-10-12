-- Object storage on R2 (docs/cloud.md §1, Wecra 1.1): images and blobs of every file are content-addressed objects
-- (`b/<sha1>`, or `e/<orgId>/b/<sha1>` sealed for orgs with key management) in the bucket of the file's data region
-- (`files` = wecra-files, `files_eu` = wecra-files-eu). One object per bucket and key, shared by every file that uses it.

-- Every blob object the Worker or a room put: its plain size, and since when nothing refers to it (`orphan_at`; NULL
-- while referenced). The daily cron deletes objects orphaned more than 7 days ago.
CREATE TABLE r2_objects (
  bucket     TEXT NOT NULL CHECK (bucket IN ('files', 'files_eu')),
  key        TEXT NOT NULL,
  bytes      INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  orphan_at  INTEGER,
  PRIMARY KEY (bucket, key)
);
CREATE INDEX r2_objects_orphan ON r2_objects (orphan_at) WHERE orphan_at IS NOT NULL;

-- A file's use of a blob (reference counting): one row per (sha1, file). `owner_id`: whose stored bytes it is charged to
-- (stored_items `b:<owner>:<sha1>`, counted once per owner however many of their files use it). A file deleted for
-- good leaves its rows behind until the daily cron drops them and orphans what they held.
CREATE TABLE r2_refs (
  sha1       TEXT NOT NULL,
  file_key   TEXT NOT NULL,
  bucket     TEXT NOT NULL,
  key        TEXT NOT NULL,
  owner_id   TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (sha1, file_key)
);
CREATE INDEX r2_refs_object ON r2_refs (bucket, key);
CREATE INDEX r2_refs_file ON r2_refs (file_key);

-- A file whose room holds nothing in its SQLite any more but frames and metadata (checkpoints and blobs moved to R2):
-- set by the room once its lazy migration finished (or by POST /operator/storage/migrate-next).
ALTER TABLE files ADD COLUMN storage_r2_at INTEGER;
ALTER TABLE libraries ADD COLUMN storage_r2_at INTEGER;
