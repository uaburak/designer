-- Webhook deliveries are claimed before they are sent (docs/multiplayer.md §16.16 "As built"): the immediate send
-- (waitUntil) and the five-minute cron both take a row only by setting `sending_until` in one UPDATE … RETURNING, and
-- only when no unexpired lease is on it, so one delivery is never sent twice at once. The send's answer clears it; a
-- Worker that dies mid-send leaves a lease that expires (deliver.ts SEND_LEASE_MS) and the cron takes the row again.
ALTER TABLE webhook_requests ADD COLUMN sending_until INTEGER;
