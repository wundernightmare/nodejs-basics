import { Inject, Injectable, OnApplicationShutdown } from "@nestjs/common";

import { AppLogger, ecsError } from "@base/logger";

import { TELEMETRY_HANDLE, type TelemetryHandle } from "./setup-telemetry.tokens.js";

function withShutdownTimeout<T>(p: Promise<T>): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => {
        reject(new Error("telemetry shutdown timeout"));
      }, 5_000),
    ),
  ]);
}

/**
 * Flushes telemetry providers on graceful shutdown so spans/metrics in flight
 * make it to the exporter before the process exits.
 */
@Injectable()
export class OtelShutdownService implements OnApplicationShutdown {
  private readonly logger: ReturnType<AppLogger["child"]>;

  constructor(
    @Inject(TELEMETRY_HANDLE) private readonly handle: TelemetryHandle,
    appLogger: AppLogger,
  ) {
    this.logger = appLogger.child(OtelShutdownService.name);
  }

  async onApplicationShutdown(signal?: string): Promise<void> {
    this.logger.info({ "process.signal": signal ?? null }, "Flushing telemetry on shutdown");

    const { tracerProvider, meterProvider, stopPyroscope } = this.handle;
    const results = await Promise.allSettled([
      withShutdownTimeout(tracerProvider.forceFlush().then(() => tracerProvider.shutdown())),
      withShutdownTimeout(meterProvider.forceFlush().then(() => meterProvider.shutdown())),
      withShutdownTimeout(stopPyroscope()),
    ]);

    for (const result of results) {
      if (result.status === "rejected") {
        this.logger.error({ ...ecsError(result.reason) }, "Telemetry shutdown error");
      }
    }
    this.logger.info("Telemetry shutdown complete");
  }
}
