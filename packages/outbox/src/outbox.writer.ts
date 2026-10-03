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
import { Injectable } from "@nestjs/common";
import { context, propagation } from "@opentelemetry/api";
import type { PoolClient } from "pg";

import { getRequestId, REQUEST_ID_HEADER } from "@base/common";
import { currentTransaction } from "@base/database";

export interface OutboxMessage {
  topic: string;
  /** Record key (partitioning, compaction); null for none. */
  key: string | null;
  /** The record value, stored as JSONB and sent as JSON. */
  value: unknown;
}

/** add() called with no ambient transaction — the event would not commit with its change. */
export class OutboxOutsideTransactionError extends Error {
  constructor() {
    super(
      "OutboxWriter.add() needs the ambient transaction of the state change it announces — " +
        "call it inside uow.runInTransaction.",
    );
    this.name = "OutboxOutsideTransactionError";
  }
}

@Injectable()
export class OutboxWriter {
  /**
   * Insert the event in the caller's transaction, so it commits (or not)
   * with the state change it announces. Refuses to run outside one: a
   * standalone insert is exactly the non-atomic write an outbox exists to
   * prevent.
   */
  async add(message: OutboxMessage): Promise<void> {
    const db = currentTransaction<PoolClient>();
    if (db === undefined) throw new OutboxOutsideTransactionError();
    const headers: Record<string, string> = {};
    propagation.inject(context.active(), headers);
    const requestId = getRequestId();
    if (requestId !== undefined) headers[REQUEST_ID_HEADER] = requestId;
    await db.query("INSERT INTO outbox (topic, key, payload, headers) VALUES ($1, $2, $3, $4)", [
      message.topic,
      message.key,
      JSON.stringify(message.value),
      JSON.stringify(headers),
    ]);
  }
}
