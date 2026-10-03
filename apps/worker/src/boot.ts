/**
 * The first module the process evaluates (instrumentation.ts imports it
 * before anything else), so everything after it sees the final environment:
 *
 *  - the configuration: env > config.yaml > this app's defaults (its own
 *    OTEL_SERVICE_NAME — the api and the worker never share one name in
 *    traces, logs, metrics) > registry defaults, validated.
 *    Loaded here, not first by ConfigModule, because ESM evaluates every
 *    import before main() runs: @base/logger (LOG_LEVEL, NODE_ENV), the heap
 *    snapshot service and createApp() read process.env when they load or
 *    before the Nest container exists, and a value they read before the
 *    loader is a config.yaml line that silently does nothing.
 *
 * Imports only the loader (fs, yaml, the registry) — nothing that reads the
 * environment itself.
 */
import { loadConfigOrExit } from "@base/config/loader";

loadConfigOrExit({ defaults: { OTEL_SERVICE_NAME: "nodejs-basics-worker" } });
