/**
 * The first module the process evaluates (instrumentation.ts imports it
 * before anything else), so everything after it sees the final environment:
 *
 *  - this app's OpenTelemetry service name, unless OTEL_SERVICE_NAME is set —
 *    the api and the worker never share one name in traces, logs, metrics;
 *  - the configuration: env > config.yaml > registry defaults, validated.
 *    Loaded here, not first by ConfigModule, because ESM evaluates every
 *    import before main() runs: @base/logger (LOG_LEVEL, NODE_ENV), the heap
 *    snapshot service and createApp() read process.env when they load or
 *    before the Nest container exists, and a value they read before the
 *    loader is a config.yaml line that silently does nothing.
 *
 * Imports only the loader (fs, yaml, the registry) — nothing that reads the
 * environment itself.
 */
import { yamlConfigLoader } from "@base/config/loader";

process.env["OTEL_SERVICE_NAME"] ??= "nodejs-basics-worker";

try {
  yamlConfigLoader();
} catch (err) {
  // No logger yet (it is configured by what failed): one ECS line, then out.
  process.stderr.write(
    `${JSON.stringify({
      "@timestamp": new Date().toISOString(),
      "log.level": "fatal",
      "service.name": process.env["OTEL_SERVICE_NAME"],
      message: (err as Error).message,
    })}\n`,
  );
  // 78 = EX_CONFIG (sysexits.h).
  process.exit(78);
}
