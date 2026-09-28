-- Transactional outbox (@base/outbox): a row is written in the same
-- transaction as the state change it announces, and deleted once the relay
-- has published it to Kafka.
CREATE TABLE outbox (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  topic      TEXT NOT NULL,
  key        TEXT,
  payload    JSONB NOT NULL,
  -- W3C trace context + x-request-id of the writing request, sent as record headers
  headers    JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
