import { type Redis as Valkey } from "iovalkey";
import { type Pool } from "pg";

import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";

import { ValkeyModule, VALKEY_CLIENT } from "@base/cache";
import { configSnapshot, integrationEnabled, yamlConfigLoader } from "@base/config";
import { DatabaseModule, PG_POOL } from "@base/database";
import { IdempotencyModule, pgIdempotencyStoreProvider } from "@base/idempotency";
import { KafkaModule } from "@base/kafka";
import { LoggerModule } from "@base/logger";
import { OutboxModule } from "@base/outbox";
import { ObservabilityModule, READINESS_CHECKS, type ReadinessCheck } from "@base/observability";

import { telemetry } from "./instrumentation.js";
import { HealthModule } from "./modules/health/health.module.js";
import { TasksModule } from "./modules/tasks/tasks.module.js";
import { UnitOfWorkModule } from "./unit-of-work.module.js";

// Postgres is the core; Valkey and Kafka are on when VALKEY_URL / KAFKA_BROKERS
// are set. One that is off is not imported at all, and what needs it runs on
// a substitute — see README "Optional integrations".
const valkey = integrationEnabled("valkey");
const kafka = integrationEnabled("kafka");

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, load: [yamlConfigLoader] }),
    LoggerModule,
    DatabaseModule,
    UnitOfWorkModule,
    ...(valkey ? [ValkeyModule] : []),
    ...(kafka ? [KafkaModule] : []),
    // Transactional outbox → Kafka (OutboxWriter in use cases, OutboxRelay in
    // the background). Without Kafka the events wait in the table.
    OutboxModule.forRoot({ relay: kafka }),
    // Idempotency-Key results: Valkey, or the same in a Postgres table.
    IdempotencyModule.forRoot(valkey ? {} : { storeProvider: pgIdempotencyStoreProvider }),
    ObservabilityModule.forRoot({
      telemetry,
      // GET /admin/config — the effective ENV_REGISTRY values (redacted).
      configSnapshot,
      enableDbMetrics: true,
      enableHeapSnapshot: true,
      enableCrashReport: true,
      readinessChecks: {
        provide: READINESS_CHECKS,
        inject: valkey ? [PG_POOL, VALKEY_CLIENT] : [PG_POOL],
        // Checks for what this process connects to — one that is off has none.
        useFactory: (pool: Pool, valkeyClient?: Valkey): ReadinessCheck[] => [
          { name: "db", check: () => pool.query("SELECT 1").then(() => "ok") },
          ...(valkeyClient === undefined
            ? []
            : [{ name: "valkey", check: () => valkeyClient.ping().then(() => "ok") }]),
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
