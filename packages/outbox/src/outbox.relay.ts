/**
 * OutboxRelay — publishes the outbox to Kafka, at least once.
 *
 * Every OUTBOX_POLL_INTERVAL_MS (sooner while there is a backlog) one
 * transaction takes up to OUTBOX_BATCH_SIZE rows with FOR UPDATE SKIP LOCKED,
 * sends them and deletes them. SKIP LOCKED lets every replica run a relay
 * without two of them sending the same row. Sent rows are deleted; a failed
 * send is judged by the @base/kafka error registry (KAFKA_SEND_ERRORS):
 *
 *   - retryable (broker down, queue full, reconnecting, topic not provisioned
 *     yet, unknown): the row stays as it is and goes out on a later pass —
 *     never counted, so no outage or back-pressure can dead-letter an event;
 *   - not retryable (`rejected`: too large, invalid): a poison row — `attempts + 1` and `last_error`; after OUTBOX_MAX_ATTEMPTS it is
 *     left in the table for an operator (the `outbox.dead` gauge) instead of
 *     being retried forever.
 *
 * Any failure backs the relay off (up to 30 s). A row that is retried gives
 * up its order relative to later rows of its key.
 *
 * The batch's transaction stays open while Kafka acknowledges — up to
 * message.timeout.ms (30 s) when the broker is slow. Keep that below
 * DATABASE_IDLE_IN_TRANSACTION_TIMEOUT_MS (60 s): past it Postgres kills the
 * session, COMMIT fails, and every slow batch is sent again forever.
 *
 * At least once, not exactly once: a crash between the broker's ack and the
 * COMMIT sends the batch again — consumers are idempotent (the worker's BullMQ
 * jobId is the task id). Order holds per relay for rows of one key, not
 * across replicas.
 *
 * Each record is sent in the trace context stored with its row, so the
 * `send` span is a child of the request that wrote it and the consumer's
 * `process` span follows (@base/kafka traceparent headers).
 */
import {
  type BeforeApplicationShutdown,
  Inject,
  Injectable,
  type OnApplicationBootstrap,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { context, metrics, propagation, ROOT_CONTEXT } from "@opentelemetry/api";
import type { Pool } from "pg";

import { readInt } from "@base/config";
import { PG_POOL } from "@base/database";
import { KafkaProducerService, toKafkaSendError } from "@base/kafka";
import { AppLogger, ecsError } from "@base/logger";

interface OutboxRow {
  id: string;
  topic: string;
  key: string | null;
  payload: unknown;
  headers: Record<string, string>;
}

const MAX_BACKOFF_MS = 30_000;
// Upper bound on how long shutdown waits for a batch in flight; after it the
// pool closes anyway and the batch rolls back (sent again by the next relay).
const DRAIN_TIMEOUT_MS = 5_000;

@Injectable()
export class OutboxRelay implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger: ReturnType<AppLogger["child"]>;
  private readonly intervalMs: number;
  private readonly batchSize: number;
  private readonly maxAttempts: number;
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<void> = Promise.resolve();
  private stopping = false;
  private failures = 0;
  // The last pass had rows that failed while it still made progress.
  private partial = false;

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly kafka: KafkaProducerService,
    config: ConfigService,
    appLogger: AppLogger,
  ) {
    this.logger = appLogger.child(OutboxRelay.name);
    this.intervalMs = readInt(config, "OUTBOX_POLL_INTERVAL_MS");
    this.batchSize = readInt(config, "OUTBOX_BATCH_SIZE");
    this.maxAttempts = readInt(config, "OUTBOX_MAX_ATTEMPTS");
    // The numbers to alert on: rows waiting to be published, rows given up on.
    const meter = metrics.getMeter("outbox");
    const pending = meter.createObservableGauge("outbox.pending", {
      description: "Outbox rows not yet published to Kafka.",
      unit: "{message}",
    });
    const dead = meter.createObservableGauge("outbox.dead", {
      description: "Outbox rows that failed OUTBOX_MAX_ATTEMPTS times and are no longer sent.",
      unit: "{message}",
    });
    meter.addBatchObservableCallback(
      async (result) => {
        if (this.stopping) return;
        try {
          const { rows } = await this.pool.query<{ pending: number; dead: number }>(
            `SELECT count(*) FILTER (WHERE attempts < $1)::int AS pending,
                    count(*) FILTER (WHERE attempts >= $1)::int AS dead
               FROM outbox`,
            [this.maxAttempts],
          );
          result.observe(pending, rows[0]?.pending ?? 0);
          result.observe(dead, rows[0]?.dead ?? 0);
        } catch {
          // no sample this scrape (database unreachable)
        }
      },
      [pending, dead],
    );
  }

  onApplicationBootstrap(): void {
    this.schedule(0);
  }

  /** Stop polling and let a batch in flight finish (up to DRAIN_TIMEOUT_MS) before Kafka and the pool close. */
  async beforeApplicationShutdown(): Promise<void> {
    this.stopping = true;
    clearTimeout(this.timer);
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        this.logger.warn({ "outbox.drain_timeout_ms": DRAIN_TIMEOUT_MS }, "Outbox drain timed out");
        resolve();
      }, DRAIN_TIMEOUT_MS);
    });
    await Promise.race([this.running, timeout]);
    clearTimeout(timer);
  }

  /**
   * One relay pass; resolves to the number of records published, rejects when
   * every send failed (nothing changes then). Public for tests.
   */
  async relayOnce(): Promise<number> {
    const client = await this.pool.connect();
    let broken = false; // ROLLBACK failed → destroy, don't pool
    try {
      await client.query("BEGIN");
      const { rows } = await client.query<OutboxRow>(
        `SELECT id, topic, key, payload, headers FROM outbox
          WHERE attempts < $2
         ORDER BY id LIMIT $1 FOR UPDATE SKIP LOCKED`,
        [this.batchSize, this.maxAttempts],
      );
      // Issued in row order: the producer keeps that order per partition.
      const results = await Promise.allSettled(
        rows.map((row) =>
          context.with(propagation.extract(ROOT_CONTEXT, row.headers), () =>
            this.kafka.send(
              {
                topic: row.topic,
                messages: [
                  { key: row.key, value: JSON.stringify(row.payload), headers: row.headers },
                ],
              },
              // No waiting inside send(): the relay has its own backoff.
              { waitMs: 0 },
            ),
          ),
        ),
      );
      const sent = rows.filter((_, i) => results[i]?.status === "fulfilled");
      const failed = rows.flatMap((row, i) => {
        const r = results[i];
        return r?.status === "rejected" ? [{ row, error: toKafkaSendError(r.reason) }] : [];
      });
      const poison = failed.filter((f) => !f.error.retryable);
      // Nothing went out and nothing is the rows' fault: an outage — leave
      // the batch as it is (the rollback below) and back off.
      const first = failed[0];
      if (first !== undefined && sent.length === 0 && poison.length === 0) throw first.error;

      if (sent.length > 0) {
        await client.query("DELETE FROM outbox WHERE id = ANY($1::bigint[])", [
          sent.map((r) => r.id),
        ]);
      }
      for (const { row, error } of poison) {
        await client.query(
          "UPDATE outbox SET attempts = attempts + 1, last_error = $2 WHERE id = $1",
          [row.id, error.message.slice(0, 1000)],
        );
      }
      await client.query("COMMIT");
      this.partial = first !== undefined;
      if (first !== undefined) {
        const worst = poison[0] ?? first;
        this.logger.warn(
          {
            ...ecsError(worst.error),
            "event.action": poison.length > 0 ? "outbox.rejected" : "outbox.deferred",
            "error.code": worst.error.kind,
            "outbox.failed": failed.length,
            "outbox.poison": poison.length,
            "outbox.sent": sent.length,
          },
          poison.length > 0
            ? "Outbox rows rejected by Kafka — counted towards OUTBOX_MAX_ATTEMPTS"
            : "Outbox rows not published yet — kept for a later pass",
        );
      }
      return sent.length;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {
        broken = true;
      });
      throw err;
    } finally {
      client.release(broken);
    }
  }

  private schedule(delayMs: number): void {
    if (this.stopping) return;
    this.timer = setTimeout(() => {
      this.running = this.tick();
    }, delayMs);
    this.timer.unref();
  }

  private async tick(): Promise<void> {
    let delay = this.intervalMs;
    try {
      const sent = await this.relayOnce();
      if (this.partial) {
        // Space out the retries of the failed rows, as for a failed pass.
        this.failures++;
        delay = Math.min(this.intervalMs * 2 ** this.failures, MAX_BACKOFF_MS);
      } else {
        if (this.failures > 0) this.logger.info({ "outbox.sent": sent }, "Outbox relay recovered");
        this.failures = 0;
        if (sent === this.batchSize) delay = 0; // backlog: go again at once
      }
    } catch (err) {
      this.failures++;
      delay = Math.min(this.intervalMs * 2 ** this.failures, MAX_BACKOFF_MS);
      this.logger.warn(
        { ...ecsError(err), "outbox.retry_in_ms": delay },
        "Outbox relay failed — rows stay queued",
      );
    }
    this.schedule(delay);
  }
}
