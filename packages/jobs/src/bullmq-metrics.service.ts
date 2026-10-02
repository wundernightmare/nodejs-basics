import { Injectable } from "@nestjs/common";
import type { Counter, Histogram } from "@opentelemetry/api";
import { metrics } from "@opentelemetry/api";
import type { Job, Worker } from "bullmq";

/**
 * OTel metrics for BullMQ jobs, keyed by queue. `observe(worker)` subscribes
 * to the worker's events — call it once right after creating a Worker.
 *
 *   bullmq.job.completed.total   jobs that succeeded
 *   bullmq.job.failed.total      jobs that failed for good (attempts exhausted)
 *   bullmq.job.stalled.total     jobs whose lock expired mid-run (pod crash, blocked loop)
 *   bullmq.job.duration.ms       run time (processedOn → finishedOn) of every
 *                                attempt, by `outcome` — not the queue wait
 */
@Injectable()
export class BullMQMetricsService {
  private readonly completedCounter: Counter;
  private readonly failedCounter: Counter;
  private readonly stalledCounter: Counter;
  private readonly durationHistogram: Histogram;

  constructor() {
    const meter = metrics.getMeter("bullmq");

    this.completedCounter = meter.createCounter("bullmq.job.completed.total", {
      description: "Number of BullMQ jobs completed successfully",
    });

    this.failedCounter = meter.createCounter("bullmq.job.failed.total", {
      description: "Number of BullMQ jobs that failed (all attempts exhausted)",
    });

    this.stalledCounter = meter.createCounter("bullmq.job.stalled.total", {
      description: "Number of BullMQ jobs that stalled (pod crash during processing)",
    });

    this.durationHistogram = meter.createHistogram("bullmq.job.duration.ms", {
      description: "BullMQ job processing duration in milliseconds",
      unit: "ms",
      advice: {
        explicitBucketBoundaries: [100, 500, 1_000, 5_000, 15_000, 30_000, 60_000],
      },
    });
  }

  /** Record this worker's completed / failed / stalled jobs. */
  observe(worker: Worker): void {
    const queue = worker.name;
    worker.on("completed", (job) => {
      this.completedCounter.add(1, { queue });
      this.recordDuration(queue, job, "completed");
    });
    worker.on("failed", (job) => {
      if (job === undefined) return;
      this.recordDuration(queue, job, "failed");
      // `failed` fires on every attempt; a retried job is not a failure yet.
      if (job.attemptsMade >= (job.opts.attempts ?? 1)) this.failedCounter.add(1, { queue });
    });
    worker.on("stalled", () => {
      this.stalledCounter.add(1, { queue });
    });
  }

  private recordDuration(queue: string, job: Job, outcome: "completed" | "failed"): void {
    if (job.processedOn === undefined || job.finishedOn === undefined) return;
    this.durationHistogram.record(job.finishedOn - job.processedOn, { queue, outcome });
  }
}
