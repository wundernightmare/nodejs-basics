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
 * Command-line flags (--help, --check-config, --config-reference) are
 * handled here too, before anything else loads. Imports only the loader
 * (fs, yaml, the registry) — nothing that reads the environment itself.
 */
import { bootConfig } from "@base/config/boot";
import { logEventsReference } from "@base/logger/log-events";
import { metricsReference } from "@base/observability/metrics-registry";

bootConfig({
  name: "nodejs-basics-worker",
  defaults: { OTEL_SERVICE_NAME: "nodejs-basics-worker" },
  // Kafka → jobs: without Kafka there is nothing to do — exit 78. Jobs run on
  // BullMQ with VALKEY_URL, else on pg-boss in Postgres.
  requires: ["kafka"],
  references: {
    "metrics-reference": {
      help: "every metric: name, instrument, unit, labels, meaning, when to worry",
      text: metricsReference,
    },
    "log-events-reference": {
      help: "the log lines meant for machines (event.action): meaning and fields",
      text: logEventsReference,
    },
  },
});
