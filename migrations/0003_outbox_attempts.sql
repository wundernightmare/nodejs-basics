-- Poison rows (@base/outbox): a row whose send keeps failing while others
-- succeed is retried OUTBOX_MAX_ATTEMPTS times, then left here for an
-- operator instead of blocking the batch. A constant default is metadata-only.
ALTER TABLE outbox
  ADD COLUMN attempts   INT NOT NULL DEFAULT 0,
  ADD COLUMN last_error TEXT;
