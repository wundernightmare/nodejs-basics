import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";

import { yamlConfigLoader } from "@base/config";
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
      // No DB in the worker; the admin server exposes /metrics, /livez, /readyz.
      readinessChecks: [],
    }),
    TaskEventsModule,
  ],
})
export class WorkerModule {}
