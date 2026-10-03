-- Idempotency-Key results (@base/idempotency PgIdempotencyStore) for an api
-- running without Valkey (DISABLED_INTEGRATIONS=valkey). An expired row is
-- dead: reads skip it, the next insert of its key replaces it, inserts prune
-- a few expired rows each.
-- migration-safety: reviewed — the index is on the table this file creates (empty).
CREATE TABLE idempotency_keys (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX idempotency_keys_expires_at ON idempotency_keys (expires_at);
