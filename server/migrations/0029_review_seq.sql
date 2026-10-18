-- The merge-request lifecycle (docs/multiplayer.md §18.9; atlas 16 §4.7): the branch's head (its room's seq) a reviewer's
-- verdict was given at — a branch changed since shows the verdict as for an older version ("reviewed an older version
-- of the branch", Review again). NULL: a pending verdict, or one given before this column.
ALTER TABLE branch_reviewers ADD COLUMN seq INTEGER;
