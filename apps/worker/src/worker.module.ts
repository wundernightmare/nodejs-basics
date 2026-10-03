import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";

import { configSnapshot, yamlConfigLoader } from "@base/config";
import { LoggerModule } from "@base/logger";
import { ObservabilityModule } from "@base/observability";

import { telemetry } from "./instrumentation.js";
import { TaskEventsModule } from "./tasks/task-events.module.js";

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, load: [yamlConfigLoader] }),
    LoggerModule,
    ObservabilityModule.forRoot({
      telemetry,
      configSnapshot,
      // The Kafka consumer and the job processor register their own /readyz
      // checks (ReadinessService.register).
    }),
    TaskEventsModule,
  ],
})
export class WorkerModule {}
