import { Injectable } from "@nestjs/common";
import type { Counter, Histogram } from "@opentelemetry/api";
import { metrics } from "@opentelemetry/api";

/**
 * OTel metrics for BullMQ jobs.
 *
 * Counters and histograms are keyed by queue name + tenantId so that Grafana
 * dashboards can show per-tenant job latency and failure rates.
 *
 * Usage: inject into processor services and call from worker event listeners.
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

  recordCompleted(queue: string, tenantId: string, durationMs: number): void {
    const attrs = { queue, tenant_id: tenantId };
    this.completedCounter.add(1, attrs);
    this.durationHistogram.record(durationMs, attrs);
  }

  recordFailed(queue: string, tenantId: string): void {
    this.failedCounter.add(1, { queue, tenant_id: tenantId });
  }

  recordStalled(queue: string): void {
    this.stalledCounter.add(1, { queue });
  }
}
