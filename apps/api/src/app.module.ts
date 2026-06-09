import { type Pool } from "pg";

import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";

import { ValkeyModule, VALKEY_CLIENT } from "@base/cache";
import { yamlConfigLoader } from "@base/config";
import { DatabaseModule, PG_POOL } from "@base/database";
import { IdempotencyModule } from "@base/idempotency";
import { KafkaModule } from "@base/kafka";
import { LoggerModule } from "@base/logger";
import { ObservabilityModule, READINESS_CHECKS, type ReadinessCheck } from "@base/observability";

import { telemetry } from "./instrumentation.js";
import { HealthModule } from "./modules/health/health.module.js";
import { TasksModule } from "./modules/tasks/tasks.module.js";
import { UnitOfWorkModule } from "./unit-of-work.module.js";

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, load: [yamlConfigLoader] }),
    LoggerModule,
    DatabaseModule,
    UnitOfWorkModule,
    ValkeyModule,
    KafkaModule,
    IdempotencyModule.forRoot(),
    ObservabilityModule.forRoot({
      telemetry,
      enableDbMetrics: true,
      enableHeapSnapshot: true,
      enableCrashReport: true,
      readinessChecks: {
        provide: READINESS_CHECKS,
        inject: [PG_POOL, VALKEY_CLIENT],
        useFactory: (pool: Pool, valkey: import("iovalkey").Redis): ReadinessCheck[] => [
          {
            name: "db",
            check: async () => {
              await pool.query("SELECT 1");
              return "ok";
            },
          },
          {
            name: "valkey",
            check: async () => {
              await valkey.ping();
              return "ok";
            },
          },
        ],
      },
    }),

    // Example modules — see apps/api/src/modules/*/README.md for explanations.
    HealthModule,
    TasksModule,
  ],
  // The IUnitOfWork → PgUnitOfWork binding lives in the @Global UnitOfWorkModule
  // so feature modules (TasksModule) can inject UNIT_OF_WORK.
})
export class AppModule {}
