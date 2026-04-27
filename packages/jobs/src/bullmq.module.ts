import { type DynamicModule, Global, Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Queue } from "bullmq";
import type { ConnectionOptions, DefaultJobOptions } from "bullmq";

import { createBullMQConnection } from "./bullmq-connection.factory.js";
import { BullMQMetricsService } from "./bullmq-metrics.service.js";

/** DI token for the shared BullMQ connection options. */
export const BULLMQ_CONNECTION = Symbol("BULLMQ_CONNECTION");

/**
 * Build a DI symbol token for a queue name. The token is stable across
 * import cycles when callers pass the same name.
 *
 *   const FOO_QUEUE = bullmqQueueToken("foo");
 *   constructor(@Inject(FOO_QUEUE) private readonly q: Queue) {}
 */
const queueTokens = new Map<string, symbol>();
export function bullmqQueueToken(name: string): symbol {
  let token = queueTokens.get(name);
  if (!token) {
    token = Symbol(`BULLMQ_QUEUE:${name}`);
    queueTokens.set(name, token);
  }
  return token;
}

/**
 * Default job options applied to every job unless overridden at enqueue time.
 *  - 3 attempts with exponential backoff: 5 s → 10 s → 20 s
 *  - Completed: keep last 500, max 1 day
 *  - Failed:    keep last 1000, max 7 days (visible in BullBoard for debugging)
 */
export const DEFAULT_JOB_OPTIONS: DefaultJobOptions = {
  attempts: 3,
  backoff: { type: "exponential", delay: 5_000 },
  removeOnComplete: { count: 500, age: 86_400 },
  removeOnFail: { count: 1_000, age: 7 * 86_400 },
};

/**
 * Configures the BullMQ infrastructure for a list of named queues.
 *
 *   imports: [
 *     BullMQModule.forQueues([
 *       { name: "snapshot-publish" },
 *       { name: "alert-check", defaultJobOptions: { attempts: 5 } },
 *     ]),
 *   ],
 *
 * Inject queue instances via:
 *   @Inject(bullmqQueueToken("snapshot-publish")) private readonly q: Queue
 */
@Global()
@Module({})
export class BullMQModule {
  static forQueues(
    queues: ReadonlyArray<{ name: string; defaultJobOptions?: DefaultJobOptions }>,
  ): DynamicModule {
    const queueProviders = queues.map((q) => ({
      provide: bullmqQueueToken(q.name),
      inject: [BULLMQ_CONNECTION],
      useFactory: (connection: ConnectionOptions): Queue =>
        new Queue(q.name, {
          connection,
          defaultJobOptions: q.defaultJobOptions ?? DEFAULT_JOB_OPTIONS,
        }),
    }));

    const queueTokensList = queues.map((q) => bullmqQueueToken(q.name));

    return {
      module: BullMQModule,
      providers: [
        BullMQMetricsService,
        {
          provide: BULLMQ_CONNECTION,
          inject: [ConfigService],
          useFactory: (config: ConfigService) => createBullMQConnection(config),
        },
        ...queueProviders,
      ],
      exports: [BullMQMetricsService, BULLMQ_CONNECTION, ...queueTokensList],
    };
  }
}
