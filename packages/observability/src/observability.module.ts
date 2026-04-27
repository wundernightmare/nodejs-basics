import { type DynamicModule, Module, type Provider } from "@nestjs/common";

import { AdminServerService } from "./admin-server.service.js";
import { DbMetricsService } from "./db-metrics.service.js";
import { OtelShutdownService } from "./otel-shutdown.service.js";
import {
  READINESS_CHECKS,
  type ReadinessCheck,
  ReadinessService,
} from "./readiness.service.js";
import { TELEMETRY_HANDLE, type TelemetryHandle } from "./setup-telemetry.tokens.js";

export interface ObservabilityModuleOptions {
  /** Telemetry handle returned by setupTelemetry() in main.ts. */
  telemetry: TelemetryHandle;
  /** Optional readiness checks. Default: empty (always healthy). */
  readinessChecks?: Provider<ReadinessCheck[]> | ReadinessCheck[];
  /** Whether to register DbMetricsService (requires PG_POOL and VALKEY_CLIENT to be available). */
  enableDbMetrics?: boolean;
}

@Module({})
export class ObservabilityModule {
  static forRoot(options: ObservabilityModuleOptions): DynamicModule {
    const checksProvider: Provider = isProvider(options.readinessChecks)
      ? options.readinessChecks
      : { provide: READINESS_CHECKS, useValue: options.readinessChecks ?? [] };

    const providers: Provider[] = [
      { provide: TELEMETRY_HANDLE, useValue: options.telemetry },
      checksProvider,
      OtelShutdownService,
      AdminServerService,
      ReadinessService,
    ];

    if (options.enableDbMetrics === true) {
      providers.push(DbMetricsService);
    }

    return {
      module: ObservabilityModule,
      providers,
      exports: [TELEMETRY_HANDLE],
    };
  }
}

function isProvider(value: unknown): value is Provider<ReadinessCheck[]> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    "provide" in value
  );
}
