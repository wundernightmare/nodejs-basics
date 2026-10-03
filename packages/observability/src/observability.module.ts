import { type DynamicModule, Module, type Provider } from "@nestjs/common";

import {
  ADMIN_SERVER_OPTIONS,
  AdminServerService,
  type ConfigView,
} from "./admin-server.service.js";
import { CrashReportService } from "./crash-report.service.js";
import { DbMetricsService } from "./db-metrics.service.js";
import { HeapSnapshotService } from "./heap-snapshot.service.js";
import { IntegrationsReportService } from "./integrations-report.service.js";
import { OtelShutdownService } from "./otel-shutdown.service.js";
import { READINESS_CHECKS, type ReadinessCheck, ReadinessService } from "./readiness.service.js";
import { TELEMETRY_HANDLE, type TelemetryHandle } from "./setup-telemetry.tokens.js";

export interface ObservabilityModuleOptions {
  /** Telemetry handle returned by setupTelemetry() in main.ts. */
  telemetry: TelemetryHandle;
  /**
   * Optional readiness checks. Default: none. Services can also register
   * their own at runtime via ReadinessService.register() (the module is
   * global, so ReadinessService is injectable everywhere).
   */
  readinessChecks?: Provider<ReadinessCheck[]> | ReadinessCheck[];
  /**
   * The effective configuration to serve on GET /admin/config — pass
   * `configSnapshot` from @base/config. Secrets are redacted by the admin
   * server (redact() from @base/logger). Without it the route is absent (404).
   */
  configSnapshot?: () => ConfigView;
  /** Register DbMetricsService (requires PG_POOL). */
  enableDbMetrics?: boolean;
  /**
   * Register HeapSnapshotService — listens for SIGUSR2, polls heap usage,
   * captures + uploads V8 snapshots. Optional S3 upload via HEAP_SNAPSHOT_S3_BUCKET.
   * Adds POST /debug/heapdump on the admin server.
   */
  enableHeapSnapshot?: boolean;
  /**
   * Register CrashReportService — process-level uncaughtException +
   * unhandledRejection handler that writes a Node diagnostic report and a
   * V8 heap snapshot before exiting. Optional S3 upload.
   * Adds POST /debug/report on the admin server.
   */
  enableCrashReport?: boolean;
}

@Module({})
export class ObservabilityModule {
  static forRoot(options: ObservabilityModuleOptions): DynamicModule {
    const checksProvider: Provider = isProvider(options.readinessChecks)
      ? options.readinessChecks
      : { provide: READINESS_CHECKS, useValue: options.readinessChecks ?? [] };

    const providers: Provider[] = [
      { provide: TELEMETRY_HANDLE, useValue: options.telemetry },
      { provide: ADMIN_SERVER_OPTIONS, useValue: { configSnapshot: options.configSnapshot } },
      checksProvider,
      OtelShutdownService,
      AdminServerService,
      ReadinessService,
      IntegrationsReportService,
    ];

    if (options.enableDbMetrics === true) {
      providers.push(DbMetricsService);
    }
    if (options.enableHeapSnapshot === true) {
      providers.push(HeapSnapshotService);
    }
    if (options.enableCrashReport === true) {
      providers.push(CrashReportService);
    }

    return {
      module: ObservabilityModule,
      // Global so any feature module can inject ReadinessService and register
      // the check for the dependency it owns (see apps/worker).
      global: true,
      providers,
      exports: [TELEMETRY_HANDLE, ReadinessService],
    };
  }
}

function isProvider(value: unknown): value is Provider<ReadinessCheck[]> {
  return typeof value === "object" && value !== null && !Array.isArray(value) && "provide" in value;
}
