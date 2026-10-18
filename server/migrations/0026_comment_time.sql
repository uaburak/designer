-- Comments with a time (docs/motion.md §6.8): the playhead's time in ms when the thread was placed in Motion mode
-- (CommentAnchor.timeMs); the timeline's ruler shows a marker there. NULL: placed outside Motion.
ALTER TABLE comments ADD COLUMN time_ms INTEGER;
