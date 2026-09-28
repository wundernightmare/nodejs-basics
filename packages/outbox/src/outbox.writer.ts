/**
 * OutboxWriter — records an event for Kafka inside the caller's transaction.
 *
 *   await uow.runInTransaction(async () => {
 *     const task = await repo.create(...);
 *     await outbox.add({ topic: TASK_EVENTS_TOPIC, key: task.id, value: event });
 *   });
 *
 * The row commits or rolls back with the state change, so an event is never
 * lost (broker down) nor published for a write that did not happen (rollback).
 * OutboxRelay publishes it afterwards. The current trace context and request
 * id are stored with the row: the relay's `send` span — and the consumer's —
 * continue the request's trace.
 */
import { Inject, Injectable } from "@nestjs/common";
import { context, propagation } from "@opentelemetry/api";
import type { Pool, PoolClient } from "pg";

import { getRequestId, REQUEST_ID_HEADER } from "@base/common";
import { PG_POOL, transactionStorage } from "@base/database";

export interface OutboxMessage {
  topic: string;
  /** Record key (partitioning, compaction); null for none. */
  key: string | null;
  /** The record value, stored as JSONB and sent as JSON. */
  value: unknown;
}

@Injectable()
export class OutboxWriter {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async add(message: OutboxMessage): Promise<void> {
    const headers: Record<string, string> = {};
    propagation.inject(context.active(), headers);
    const requestId = getRequestId();
    if (requestId !== undefined) headers[REQUEST_ID_HEADER] = requestId;
    // The ambient transaction client when there is one (the point of an
    // outbox); a standalone insert otherwise.
    const db = (transactionStorage.getStore() as PoolClient | undefined) ?? this.pool;
    await db.query("INSERT INTO outbox (topic, key, payload, headers) VALUES ($1, $2, $3, $4)", [
      message.topic,
      message.key,
      JSON.stringify(message.value),
      JSON.stringify(headers),
    ]);
  }
}
