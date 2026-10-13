/**
 * Job metrics, the same for every JobQueue backend (BullMQ, pg-boss) —
 * measured around the handler, not from a backend's events, so both count
 * alike and every attempt is seen:
 *
 *   job_runs_total{queue,result}    one per attempt: completed, retried (failed,
 *                                   another attempt follows), failed (final)
 *   job_duration_seconds{queue}     run time of every attempt, not the queue wait
 *
 * How many jobs wait is the backend's number (BullMQ's keys in Valkey,
 * pgboss.job in Postgres) — read it there, not from every worker.
 */
import { type Counter, type Histogram, metrics } from "@opentelemetry/api";

/** Seconds: the shared latency buckets + 30, 60 (a job may run up to its 30 s lock). */
const JOB_DURATION_BUCKETS_SECONDS = [
  0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60,
];

export class JobMetrics {
  readonly #runs: Counter;
  readonly #duration: Histogram;

  constructor(private readonly queue: string) {
    const meter = metrics.getMeter("jobs");
    this.#runs = meter.createCounter("job_runs_total", {
      description:
        "Job attempts, by queue and result (completed, retried, failed: no attempt left).",
    });
    this.#duration = meter.createHistogram("job_duration_seconds", {
      description: "Run time of one job attempt in seconds, by queue.",
      unit: "s",
      advice: { explicitBucketBoundaries: JOB_DURATION_BUCKETS_SECONDS },
    });
  }

  /**
   * Runs one attempt and counts it; `final(err)` says whether a failure is
   * the job's last (no attempt left, or an error the backend never retries).
   */
  async run(attempt: () => Promise<void>, final: (err: unknown) => boolean): Promise<void> {
    const started = performance.now();
    let result = "completed";
    try {
      await attempt();
    } catch (err) {
      result = final(err) ? "failed" : "retried";
      throw err;
    } finally {
      this.#duration.record((performance.now() - started) / 1000, { queue: this.queue });
      this.#runs.add(1, { queue: this.queue, result });
    }
  }
}
