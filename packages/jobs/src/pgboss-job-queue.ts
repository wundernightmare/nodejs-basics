import { createHash } from "node:crypto";

import { type Job, PgBoss } from "pg-boss";
import type { Pool } from "pg";

import type { JobQueue } from "./job-queue.js";
import { traceProcess, traceSend } from "./job-tracing.js";

/** What pg-boss stores: the job's data and the producer's trace context. */
interface Envelope<T> {
  data: T;
  trace: Record<string, string>;
}

/**
 * The pg-boss instance of a process, on the app's own pool (@base/database:
 * TLS, password file, tracing). Not started: JobsModule starts it — pg-boss
 * owns the `pgboss` schema and migrates it itself on start, under an advisory
 * lock (the one schema migrations/ does not hold) — and stops it.
 */
export function createPgBoss(pool: Pool): PgBoss {
  return new PgBoss({
    db: { executeSql: (text, values) => pool.query(text, values) },
    schema: "pgboss",
  });
}

/** pg-boss ids are UUIDs: the key's as a UUID (v5 layout), so the same key is the same job. */
export function keyToUuid(key: string): string {
  const h = createHash("sha1").update(`job:${key}`).digest();
  h[6] = (h[6]! & 0x0f) | 0x50;
  h[8] = (h[8]! & 0x3f) | 0x80;
  const x = h.subarray(0, 16).toString("hex");
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}

/** JobQueue on pg-boss (Postgres): the job id is the key's UUID, completed jobs kept 24 h. */
export class PgBossJobQueue<T extends object> implements JobQueue<T> {
  #ready: Promise<void> | undefined;

  constructor(
    readonly name: string,
    private readonly boss: PgBoss,
  ) {}

  /** The queue, created once (createQueue is a no-op for an existing one). */
  #setup(): Promise<void> {
    this.#ready ??= this.boss.createQueue(this.name, {
      retryLimit: 2,
      retryDelay: 5,
      retryBackoff: true,
      expireInSeconds: 30,
      deleteAfterSeconds: 86_400,
    });
    return this.#ready;
  }

  async send(data: T, key: string): Promise<void> {
    await this.#setup();
    const id = keyToUuid(key);
    await traceSend("pg-boss", this.name, id, (trace) =>
      this.boss.send(this.name, { data, trace } satisfies Envelope<T>, { id }),
    );
  }

  /** Counted now: getQueue()'s counts are pg-boss's stats, refreshed once a minute. */
  async waiting(): Promise<number> {
    await this.#setup();
    const { rows } = await this.boss
      .getDb()
      .executeSql(
        "SELECT count(*)::int AS n FROM pgboss.job WHERE name = $1 AND state IN ('created', 'retry')",
        [this.name],
      );
    return (rows[0] as { n: number } | undefined)?.n ?? 0;
  }

  async work(handler: (data: T) => Promise<void>): Promise<void> {
    await this.#setup();
    await this.boss.work<Envelope<T>>(
      this.name,
      { batchSize: 1, pollingIntervalSeconds: 1 },
      async ([job]: Job<Envelope<T>>[]) => {
        if (job === undefined) return;
        await traceProcess("pg-boss", this.name, job.id, job.data.trace, {}, () =>
          handler(job.data.data),
        );
      },
    );
  }

  async ping(): Promise<void> {
    await this.boss.getDb().executeSql("SELECT 1");
  }

  /** Stop this queue's worker after the job in hand; the instance stops with the module. */
  async close(): Promise<void> {
    await this.boss.offWork(this.name, { wait: true });
  }
}
