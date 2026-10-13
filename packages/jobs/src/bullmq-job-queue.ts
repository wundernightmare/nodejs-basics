import {
  type ConnectionOptions,
  type DefaultJobOptions,
  type Job,
  Queue,
  UnrecoverableError,
  Worker,
} from "bullmq";

import { JobMetrics } from "./job-metrics.js";
import type { JobQueue } from "./job-queue.js";
import { addTraced, traceJob } from "./job-tracing.js";

/** 3 attempts, exponential backoff from 5 s; done jobs kept 24 h / 500, failed 7 days / 1000. */
export const DEFAULT_JOB_OPTIONS: DefaultJobOptions = {
  attempts: 3,
  backoff: { type: "exponential", delay: 5_000 },
  removeOnComplete: { count: 500, age: 86_400 },
  removeOnFail: { count: 1_000, age: 7 * 86_400 },
};

/** Whether a failed attempt is the job's last: no attempt left, or BullMQ never retries the error. */
export function isFinalAttempt(job: Pick<Job, "attemptsMade" | "opts">, err: unknown): boolean {
  // attemptsMade counts the attempts before this one.
  return err instanceof UnrecoverableError || job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
}

/** JobQueue on BullMQ (Valkey): the job id is the key, completed jobs kept 24 h / 500. */
export class BullMQJobQueue<T extends object> implements JobQueue<T> {
  readonly #queue: Queue;
  readonly #metrics: JobMetrics;
  #worker: Worker | undefined;

  constructor(
    readonly name: string,
    private readonly connection: ConnectionOptions,
  ) {
    this.#queue = new Queue(name, { connection, defaultJobOptions: DEFAULT_JOB_OPTIONS });
    this.#metrics = new JobMetrics(name);
  }

  async send(data: T, key: string): Promise<void> {
    await addTraced(this.#queue, this.name, data, { jobId: key });
  }

  waiting(): Promise<number> {
    return this.#queue.getWaitingCount();
  }

  work(handler: (data: T) => Promise<void>): Promise<void> {
    const run = (job: Job<T>): Promise<void> =>
      this.#metrics.run(
        () => traceJob(job, () => handler(job.data)),
        (err) => isFinalAttempt(job, err),
      );
    this.#worker = new Worker(this.name, run, {
      connection: this.connection,
      // One job at a time; a job whose lock is not renewed for 30 s is
      // stalled and moved back to wait (once — the second stall fails it).
      concurrency: 1,
      lockDuration: 30_000,
      stalledInterval: 30_000,
      maxStalledCount: 1,
    });
    return Promise.resolve();
  }

  async ping(): Promise<void> {
    // bullmq types the client as its own IRedisClient; at runtime it is the
    // iovalkey/ioredis instance, which answers PING.
    const client = (await this.#queue.backend.client) as unknown as { ping(): Promise<string> };
    await client.ping();
  }

  async close(): Promise<void> {
    await this.#worker?.close();
    await this.#queue.close();
  }
}
