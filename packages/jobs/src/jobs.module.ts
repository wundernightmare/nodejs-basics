import { type DynamicModule, Global, Module, type Provider } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { ConnectionOptions } from "bullmq";
import type { Pool } from "pg";
import type { PgBoss } from "pg-boss";

import { integrationEnabled } from "@base/config";
import { PG_POOL } from "@base/database";
import { AppLogger, ecsError } from "@base/logger";

import { BullMQJobQueue } from "./bullmq-job-queue.js";
import { createBullMQConnection } from "./bullmq-connection.factory.js";
import { BullMQMetricsService } from "./bullmq-metrics.service.js";
import { type JobQueue, jobQueueToken } from "./job-queue.js";
import { createPgBoss, PgBossJobQueue } from "./pgboss-job-queue.js";

const BULLMQ_CONNECTION = Symbol("BULLMQ_CONNECTION");
const PG_BOSS = Symbol("PG_BOSS");
const JOBS_LIFECYCLE = Symbol("JOBS_LIFECYCLE");

/**
 * JobQueues by name, on whatever the process has: BullMQ when Valkey is on
 * (VALKEY_URL), else pg-boss on the app's Postgres (needs DatabaseModule).
 * Inject one with `@Inject(jobQueueToken("name")) queue: JobQueue<Data>`.
 */
@Global()
@Module({})
export class JobsModule {
  static forQueues(names: readonly string[]): DynamicModule {
    const tokens = names.map((name) => jobQueueToken(name));
    const backend = integrationEnabled("valkey") ? bullmq(names) : pgBoss(names);
    return {
      module: JobsModule,
      providers: [
        ...backend.providers,
        {
          // Workers stop first (the job in hand finishes), then the backend.
          provide: JOBS_LIFECYCLE,
          inject: [...tokens, ...backend.inject],
          useFactory: (...deps: unknown[]) => ({
            onApplicationShutdown: async (): Promise<void> => {
              const queues = deps.slice(0, tokens.length) as JobQueue<object>[];
              await Promise.all(queues.map((q) => q.close()));
              await backend.stop(deps.slice(tokens.length));
            },
          }),
        },
      ],
      exports: tokens,
    };
  }
}

interface Backend {
  providers: Provider[];
  inject: symbol[];
  stop(deps: unknown[]): Promise<void>;
}

function bullmq(names: readonly string[]): Backend {
  return {
    providers: [
      BullMQMetricsService,
      {
        provide: BULLMQ_CONNECTION,
        inject: [ConfigService],
        useFactory: (config: ConfigService) => createBullMQConnection(config),
      },
      ...names.map((name) => ({
        provide: jobQueueToken(name),
        inject: [BULLMQ_CONNECTION, BullMQMetricsService],
        useFactory: (connection: ConnectionOptions, metrics: BullMQMetricsService) =>
          new BullMQJobQueue(name, connection, metrics),
      })),
    ],
    inject: [],
    stop: () => Promise.resolve(),
  };
}

function pgBoss(names: readonly string[]): Backend {
  return {
    providers: [
      {
        provide: PG_BOSS,
        inject: [PG_POOL, AppLogger],
        useFactory: async (pool: Pool, appLogger: AppLogger): Promise<PgBoss> => {
          const logger = appLogger.child("PgBoss");
          const boss = createPgBoss(pool);
          // An unhandled "error" event would crash the process; pg-boss retries on its own.
          boss.on("error", (err) => {
            logger.error({ ...ecsError(err) }, "pg-boss error");
          });
          await boss.start();
          return boss;
        },
      },
      ...names.map((name) => ({
        provide: jobQueueToken(name),
        inject: [PG_BOSS],
        useFactory: (boss: PgBoss) => new PgBossJobQueue(name, boss),
      })),
    ],
    inject: [PG_BOSS],
    stop: async ([boss]) => {
      await (boss as PgBoss).stop({ graceful: true, close: false });
    },
  };
}
