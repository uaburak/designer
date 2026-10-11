-- Branches (docs/data.md §15): a branch is a file whose repo's main file is main_key.
CREATE TABLE branches (
  key             TEXT PRIMARY KEY REFERENCES files (key) ON DELETE CASCADE,
  main_key        TEXT NOT NULL REFERENCES files (key) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived', 'merged')),
  created_by      TEXT NOT NULL REFERENCES users (id),
  created_at      INTEGER NOT NULL,
  -- the main room's seq the branch's base is (moves on "Update from main")
  base_seq        INTEGER NOT NULL,
  main_seen_seq   INTEGER NOT NULL,
  -- first session id of the branch room's block (§15.2)
  session_base    INTEGER NOT NULL,
  archived_at     INTEGER,
  archived_by     TEXT REFERENCES users (id),
  merged_at       INTEGER,
  merged_by       TEXT REFERENCES users (id),
  merge_version   TEXT
);
CREATE INDEX branches_main ON branches (main_key, status);

CREATE TABLE branch_reviews (
  id           TEXT PRIMARY KEY,
  branch_key   TEXT NOT NULL REFERENCES branches (key) ON DELETE CASCADE,
  requested_by TEXT NOT NULL REFERENCES users (id),
  description  TEXT NOT NULL DEFAULT '',
  state        TEXT NOT NULL DEFAULT 'in-review' CHECK (state IN ('in-review', 'approved', 'changes-suggested', 'closed')),
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
CREATE INDEX branch_reviews_branch ON branch_reviews (branch_key, created_at);

CREATE TABLE branch_reviewers (
  review_id TEXT NOT NULL REFERENCES branch_reviews (id) ON DELETE CASCADE,
  user_id   TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  verdict   TEXT NOT NULL DEFAULT 'pending' CHECK (verdict IN ('pending', 'approved', 'changes-suggested')),
  comment   TEXT NOT NULL DEFAULT '',
  at        INTEGER,
  PRIMARY KEY (review_id, user_id)
);
