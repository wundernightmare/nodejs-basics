/**
 * OutboxRelay — publishes the outbox to Kafka, at least once.
 *
 * Every OUTBOX_POLL_INTERVAL_MS (sooner while there is a backlog) one
 * transaction takes up to OUTBOX_BATCH_SIZE rows with FOR UPDATE SKIP LOCKED,
 * sends them and deletes them. SKIP LOCKED lets every replica run a relay
 * without two of them sending the same row; a failed send rolls the batch back
 * and the rows go out on a later tick (backoff up to 30 s).
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

import { PG_POOL } from "@base/database";
import { KafkaProducerService } from "@base/kafka";
import { AppLogger, ecsError } from "@base/logger";

interface OutboxRow {
  id: string;
  topic: string;
  key: string | null;
  payload: unknown;
  headers: Record<string, string>;
}

const MAX_BACKOFF_MS = 30_000;

function positiveInt(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

@Injectable()
export class OutboxRelay implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger: ReturnType<AppLogger["child"]>;
  private readonly intervalMs: number;
  private readonly batchSize: number;
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<void> = Promise.resolve();
  private stopping = false;
  private failures = 0;

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly kafka: KafkaProducerService,
    config: ConfigService,
    appLogger: AppLogger,
  ) {
    this.logger = appLogger.child(OutboxRelay.name);
    this.intervalMs = positiveInt(config.get<string>("OUTBOX_POLL_INTERVAL_MS"), 200);
    this.batchSize = positiveInt(config.get<string>("OUTBOX_BATCH_SIZE"), 100);
    // The one number to alert on: rows waiting to be published.
    metrics
      .getMeter("outbox")
      .createObservableGauge("outbox.pending", {
        description: "Outbox rows not yet published to Kafka.",
        unit: "{message}",
      })
      .addCallback(async (result) => {
        if (this.stopping) return;
        try {
          const { rows } = await this.pool.query<{ n: number }>(
            "SELECT count(*)::int AS n FROM outbox",
          );
          result.observe(rows[0]?.n ?? 0);
        } catch {
          // no sample this scrape (database unreachable)
        }
      });
  }

  onApplicationBootstrap(): void {
    this.schedule(0);
  }

  /** Stop polling and let a batch in flight finish before Kafka and the pool close. */
  async beforeApplicationShutdown(): Promise<void> {
    this.stopping = true;
    clearTimeout(this.timer);
    await this.running;
  }

  /** One relay pass; resolves to the number of records published. Public for tests. */
  async relayOnce(): Promise<number> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const { rows } = await client.query<OutboxRow>(
        `SELECT id, topic, key, payload, headers FROM outbox
         ORDER BY id LIMIT $1 FOR UPDATE SKIP LOCKED`,
        [this.batchSize],
      );
      if (rows.length > 0) {
        // Issued in row order: the producer keeps that order per partition.
        await Promise.all(
          rows.map((row) =>
            context.with(propagation.extract(ROOT_CONTEXT, row.headers), () =>
              this.kafka.send({
                topic: row.topic,
                messages: [
                  { key: row.key, value: JSON.stringify(row.payload), headers: row.headers },
                ],
              }),
            ),
          ),
        );
        await client.query("DELETE FROM outbox WHERE id = ANY($1::bigint[])", [
          rows.map((r) => r.id),
        ]);
      }
      await client.query("COMMIT");
      return rows.length;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
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
      if (this.failures > 0) this.logger.info({ "outbox.sent": sent }, "Outbox relay recovered");
      this.failures = 0;
      if (sent === this.batchSize) delay = 0; // backlog: go again at once
    } catch (err) {
      this.failures++;
      delay = Math.min(this.intervalMs * 2 ** this.failures, MAX_BACKOFF_MS);
      this.logger.warn(
        { ...ecsError(err as Error), "outbox.retry_in_ms": delay },
        "Outbox relay failed — rows stay queued",
      );
    }
    this.schedule(delay);
  }
}
