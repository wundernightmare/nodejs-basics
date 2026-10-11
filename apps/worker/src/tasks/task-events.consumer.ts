/**
 * Drains the `tasks.events` Kafka topic (produced by apps/api) and, for each
 * `task.created` event (TaskCreatedEvent — generated from api/tsp/events.tsp,
 * the same type the producer writes), enqueues a job that
 * TaskEventsProcessor handles. The Kafka side (connect, commit, pause and
 * backoff, the dead-letter topic, tracing) is @base/kafka's
 * KafkaConsumerRunner; this class is the part every consumer writes for
 * itself: decode the event, hand it off — and say which failures retrying
 * cannot fix (KafkaPermanentError: parked on tasks.events.dlq) and which are
 * the job queue's, not the event's (KafkaBackpressureError: waited out).
 */
import {
  Inject,
  Injectable,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { metrics } from "@opentelemetry/api";

import { readInt } from "@base/config";
import { isTaskCreatedEvent, TASK_EVENTS_TOPIC, type TaskCreatedEvent } from "@base/contracts";
import { type JobQueue, jobQueueToken } from "@base/jobs";
import {
  KafkaBackpressureError,
  KafkaConsumerRunner,
  KafkaPermanentError,
  KafkaProducerService,
} from "@base/kafka";
import { AppLogger } from "@base/logger";
import { ReadinessService } from "@base/observability";

const GROUP_ID = "tasks-worker";
/** The job queue between the Kafka consumer and TaskEventsProcessor. */
export const TASK_JOBS = "task-events";
// How stale the job-queue depth may be before it is read again.
const QUEUE_DEPTH_TTL_MS = 1_000;

/**
 * The job queue holds WORKER_QUEUE_MAX_WAITING jobs: the runner pauses the
 * partition, so the backlog stays in Kafka (built for it), not in the job queue.
 */
export class JobQueueFullError extends KafkaBackpressureError {
  constructor(readonly waiting: number) {
    super(`job queue holds ${waiting} waiting jobs`);
    this.name = "JobQueueFullError";
  }
}

/** The job queue (Valkey / Postgres) failed: the event is fine — waited out, never dead-lettered. */
export class JobQueueUnavailableError extends KafkaBackpressureError {
  constructor(cause: unknown) {
    super("job queue unavailable", { cause });
    this.name = "JobQueueUnavailableError";
  }
}

@Injectable()
export class TaskEventsConsumer implements OnApplicationBootstrap, OnApplicationShutdown {
  readonly runner: KafkaConsumerRunner;
  private readonly logger: ReturnType<AppLogger["child"]>;
  private readonly maxWaiting: number;
  private queueDepth: { waiting: number; at: number } | undefined;
  // Prometheus-style name on purpose (e2e greps `worker_tasks_consumed_total`
  // and that is what dashboards expect); OTel semconv would spell it
  // `worker.tasks.consumed` with unit "{task}" and let the exporter add `_total`.
  private readonly consumed = metrics
    .getMeter("worker")
    .createCounter("worker_tasks_consumed_total", {
      description: "task.created events consumed from Kafka and enqueued.",
    });

  constructor(
    config: ConfigService,
    @Inject(jobQueueToken(TASK_JOBS)) private readonly queue: JobQueue<TaskCreatedEvent>,
    appLogger: AppLogger,
    readiness: ReadinessService,
    producer?: KafkaProducerService,
  ) {
    this.logger = appLogger.child(TaskEventsConsumer.name);
    this.maxWaiting = readInt(config, "WORKER_QUEUE_MAX_WAITING");
    this.runner = new KafkaConsumerRunner(config, this.logger, {
      groupId: GROUP_ID,
      topics: [TASK_EVENTS_TOPIC],
      handle: (message) => this.handle(message.value),
      producer,
    });
    // Critical: a worker that cannot consume is not ready.
    readiness.register({
      name: "kafka",
      check: () => {
        this.runner.assertRunning();
        return Promise.resolve("ok");
      },
    });
  }

  onApplicationBootstrap(): void {
    // Not awaited: with no broker the worker still boots (not ready) and keeps trying.
    this.runner.start();
  }

  onApplicationShutdown(): Promise<void> {
    return this.runner.stop();
  }

  /**
   * Decode and hand off one event. Returns for an event type that is not
   * ours (committed, skipped); throws KafkaPermanentError for one that can
   * never be handled (parked on the dead-letter topic).
   */
  async handle(value: Buffer | null): Promise<void> {
    let decoded: unknown;
    try {
      decoded = JSON.parse((value ?? Buffer.from("{}")).toString());
    } catch (err) {
      throw new KafkaPermanentError("undecodable event (not JSON)", { cause: err });
    }
    // The topic may carry other event types (additive contract): not ours, skip.
    if ((decoded as { type?: unknown } | null)?.type !== "task.created") return;
    if (!isTaskCreatedEvent(decoded)) {
      // Ours, but not what the contract says (no id → no idempotent jobId).
      throw new KafkaPermanentError("task.created event breaks the contract");
    }
    const event = decoded;
    await this.ensureQueueRoom();
    this.consumed.add(1);
    // Keyed by task id: a redelivered event does not become a second job.
    await this.queue.send(event, event.id).catch((err: unknown) => {
      throw new JobQueueUnavailableError(err);
    });
    // Count our own enqueue into the cached depth: a burst inside one cache
    // window would otherwise all pass on a stale "0".
    if (this.queueDepth !== undefined) this.queueDepth.waiting++;
    this.logger.info({ "task.id": event.id }, "task.created consumed → enqueued");
  }

  /** Throws JobQueueFullError at WORKER_QUEUE_MAX_WAITING; the depth is read at most once a second. */
  private async ensureQueueRoom(): Promise<void> {
    const now = Date.now();
    if (this.queueDepth === undefined || now - this.queueDepth.at > QUEUE_DEPTH_TTL_MS) {
      const waiting = await this.queue.waiting().catch((err: unknown) => {
        throw new JobQueueUnavailableError(err);
      });
      this.queueDepth = { waiting, at: now };
    }
    if (this.queueDepth.waiting >= this.maxWaiting) {
      throw new JobQueueFullError(this.queueDepth.waiting);
    }
  }
}
