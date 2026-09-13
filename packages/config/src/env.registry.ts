/**
 * Central registry of every configuration variable understood by the application.
 *
 * Each entry is the authoritative reference for:
 *   - where the variable is consumed (usedIn)
 *   - whether it is required at startup (required)
 *   - its default value when optional (default)
 *   - what it controls (description)
 *
 * config.loader.ts uses this registry to validate required keys at startup.
 *
 * This file is a STARTER REGISTRY — extend it with the variables your app uses.
 */

export interface EnvEntry {
  /** Exact variable name (process.env key and flat YAML key). */
  key: string;
  /**
   * Dot-separated path in the structured YAML file (e.g. "database.url").
   * When set, the loader resolves this path in addition to the flat key.
   * Env vars always win; yaml paths take priority over flat keys.
   */
  yaml?: string;
  /** Crash at startup if the variable is absent after all sources are merged. */
  required: boolean;
  /** Value used when required=false and the variable is not set. */
  default?: string;
  /** Human-readable description of what the variable controls. */
  description: string;
  /** Source files / modules that read this variable. */
  usedIn: string[];
}

export const ENV_REGISTRY: readonly EnvEntry[] = [
  // ─── Config file ──────────────────────────────────────────────────────────

  {
    key: "APP_CONFIG_FILE",
    required: false,
    default: "config.yaml",
    description:
      "Path to the YAML configuration file. " +
      "Relative paths resolve from the process CWD. " +
      "Environment variables always override values in this file.",
    usedIn: ["config/config.loader.ts"],
  },

  // ─── Application ──────────────────────────────────────────────────────────

  {
    key: "NODE_ENV",
    yaml: "app.node_env",
    required: false,
    default: "development",
    description: "Runtime environment. Sets secure-cookie flag and selects the default log level.",
    usedIn: ["main.ts", "logger"],
  },

  {
    key: "PORT",
    yaml: "app.port",
    required: false,
    default: "3000",
    description: "TCP port the HTTP server listens on.",
    usedIn: ["main.ts"],
  },

  {
    key: "ADMIN_PORT",
    yaml: "app.admin_port",
    required: false,
    default: "9090",
    description:
      "TCP port for the internal admin/ops HTTP server " +
      "(Prometheus /metrics, /livez, /debug/heapdump). " +
      "Must NOT be exposed to the public internet — restrict at network/firewall level.",
    usedIn: ["observability"],
  },

  {
    key: "APP_URL",
    yaml: "app.url",
    required: false,
    default: "http://localhost:3000",
    description: "Public base URL of the application.",
    usedIn: ["main.ts"],
  },

  {
    key: "COOKIE_SECRET",
    yaml: "app.cookie_secret",
    required: false,
    description:
      "Secret used to sign HttpOnly cookies. " +
      "Must be cryptographically random, ≥32 chars. Required if your app uses signed cookies.",
    usedIn: ["main.ts"],
  },

  {
    key: "ALLOWED_ORIGINS",
    yaml: "app.allowed_origins",
    required: false,
    default: "http://localhost:3000,http://localhost:5173",
    description: "Comma-separated list of CORS-allowed origins.",
    usedIn: ["main.ts"],
  },

  {
    key: "LOG_LEVEL",
    yaml: "app.log_level",
    required: false,
    description:
      "Base pino log level (trace|debug|info|warn|error|fatal|silent). Default: info in " +
      "production, debug otherwise. Changeable at runtime via PUT /admin/log-level; every " +
      "runtime change reverts to this level. Read at process start (env only).",
    usedIn: ["logger"],
  },

  {
    key: "LOG_LEVEL_MAX_TTL",
    yaml: "app.log_level_max_ttl",
    required: false,
    default: "24h",
    description:
      "Cap (and default) for how long a runtime log-level change made through " +
      "PUT /admin/log-level lasts before reverting to LOG_LEVEL. Go-style duration (30m, 2h).",
    usedIn: ["logger", "observability"],
  },

  {
    key: "ADMIN_TOKEN",
    yaml: "app.admin_token",
    required: false,
    description:
      "Bearer token for the mutating admin endpoints (PUT/DELETE /admin/log-level, " +
      "POST /debug/*). Empty (the local/compose default) leaves them open; the " +
      '"Admin server listening" log line says auth=off|bearer.',
    usedIn: ["observability"],
  },

  {
    key: "DEBUG_TOKEN",
    yaml: "app.debug_token",
    required: false,
    description:
      "Value of the X-Debug-Token request header that turns on debug logging for one " +
      "request (response carries X-Debug-Logging: on). Empty disables the feature.",
    usedIn: ["main.ts", "common/http/request-context.hooks.ts"],
  },

  {
    key: "GIT_COMMIT",
    yaml: "app.git_commit",
    required: false,
    description:
      "Build revision reported by GET /version (and /admin/info). Baked into the image " +
      'at build time; "unknown" when unset.',
    usedIn: ["observability"],
  },

  // ─── Database ─────────────────────────────────────────────────────────────

  {
    key: "DATABASE_URL",
    yaml: "database.url",
    required: false,
    default: "postgresql://app:app@localhost:5432/app",
    description: "PostgreSQL connection URL.",
    usedIn: ["database"],
  },

  {
    key: "DATABASE_PASSWORD_FILE",
    yaml: "database.password_file",
    required: false,
    description:
      "Path to a Secret-mounted file holding the database password. When set it overrides " +
      "the password in DATABASE_URL and is polled for rotation (SecretFileWatcher), so new " +
      "connections pick up a rotated secret without a restart.",
    usedIn: ["database", "config/secret-file-watcher.ts"],
  },

  {
    key: "DATABASE_POOL_MAX",
    yaml: "database.pool_max",
    required: false,
    default: "10",
    description: "Maximum pg pool size.",
    usedIn: ["database"],
  },

  // ─── Cache (Valkey/Redis) ─────────────────────────────────────────────────

  {
    key: "VALKEY_URL",
    yaml: "cache.url",
    required: false,
    default: "redis://localhost:6379",
    description: "Valkey/Redis connection URL.",
    usedIn: ["cache", "jobs", "idempotency"],
  },

  // ─── Kafka ─────────────────────────────────────────────────────────────────

  {
    key: "KAFKA_BROKERS",
    yaml: "kafka.brokers",
    required: false,
    description: "Comma-separated list of Kafka bootstrap brokers (host:port,host:port).",
    usedIn: ["kafka"],
  },

  {
    key: "KAFKA_CLIENT_ID",
    yaml: "kafka.client_id",
    required: false,
    default: "app",
    description: "Kafka client.id reported to the broker.",
    usedIn: ["kafka"],
  },

  {
    key: "KAFKA_CONSUMER_AUTO_OFFSET_RESET",
    yaml: "kafka.consumer.auto_offset_reset",
    required: false,
    default: "latest",
    description:
      "librdkafka auto.offset.reset for consumers with no committed offset " +
      "(earliest|latest). The compose stack uses earliest so the worker drains events " +
      "produced before it joined the group.",
    usedIn: ["kafka", "apps/worker"],
  },

  {
    key: "KAFKA_SASL_PASSWORD_FILE",
    yaml: "kafka.sasl.password_file",
    required: false,
    description:
      "Path to a Secret-mounted file holding the SASL password (alternative to " +
      "KAFKA_SASL_PASSWORD). librdkafka cannot rotate credentials at runtime; the " +
      "SecretFileWatcher only detects the rotation so operators can roll the pods.",
    usedIn: ["kafka", "config/secret-file-watcher.ts"],
  },

  // ─── OpenTelemetry ─────────────────────────────────────────────────────────

  {
    key: "OTEL_SERVICE_NAME",
    yaml: "telemetry.service_name",
    required: false,
    default: "app",
    description: "Service name reported to OTel (and ECS service.name in logs).",
    usedIn: ["logger", "observability"],
  },

  {
    key: "OTEL_EXPORTER_OTLP_ENDPOINT",
    yaml: "telemetry.otlp_endpoint",
    required: false,
    description: "OTLP gRPC endpoint for trace export (e.g. http://otel-collector:4317).",
    usedIn: ["observability"],
  },

  // ─── Sentry ────────────────────────────────────────────────────────────────

  {
    key: "SENTRY_DSN",
    yaml: "telemetry.sentry_dsn",
    required: false,
    description:
      "Sentry DSN for error reporting. When unset, Sentry.init() runs as a no-op " +
      "and exceptions are not captured. @sentry/nestjs auto-instruments NestJS error " +
      "handling once initialised.",
    usedIn: ["observability"],
  },

  // ─── Pyroscope (continuous profiling) ─────────────────────────────────────

  {
    key: "PYROSCOPE_SERVER_ADDRESS",
    yaml: "telemetry.pyroscope_address",
    required: false,
    description:
      "Pyroscope server URL (e.g. http://pyroscope:4040). When unset, the profiler " +
      "is not started.",
    usedIn: ["observability"],
  },

  // ─── Heap snapshots / crash reports ───────────────────────────────────────

  {
    key: "HEAP_SNAPSHOT_S3_BUCKET",
    yaml: "diagnostics.s3_bucket",
    required: false,
    description:
      "S3 bucket for heap snapshots and crash diagnostic reports. " +
      "If unset, files are written to the local /tmp directory only.",
    usedIn: ["observability"],
  },

  {
    key: "HEAP_SNAPSHOT_S3_PREFIX",
    yaml: "diagnostics.heap_snapshot_prefix",
    required: false,
    default: "heap-snapshots",
    description: "S3 key prefix for heap snapshots within the bucket.",
    usedIn: ["observability"],
  },

  {
    key: "CRASH_REPORT_S3_PREFIX",
    yaml: "diagnostics.crash_report_prefix",
    required: false,
    default: "crash-reports",
    description: "S3 key prefix for crash diagnostic reports within the bucket.",
    usedIn: ["observability"],
  },

  {
    key: "HEAP_OOM_THRESHOLD",
    yaml: "diagnostics.heap_oom_threshold",
    required: false,
    default: "0.85",
    description:
      "Fraction of heap_size_limit that triggers a near-OOM heap snapshot. " +
      "Default: 0.85 (capture when used heap exceeds 85% of the V8 limit).",
    usedIn: ["observability"],
  },

  {
    key: "HEAP_OOM_POLL_INTERVAL_MS",
    yaml: "diagnostics.heap_oom_poll_ms",
    required: false,
    default: "10000",
    description: "Heap usage poll interval in milliseconds.",
    usedIn: ["observability"],
  },

  // ─── Example modules ──────────────────────────────────────────────────────

  {
    key: "TASK_LIST_PAGE_SIZE",
    yaml: "tasks.list_page_size",
    required: false,
    default: "50",
    description:
      "Default page size for GET /tasks when the caller does not pass ?limit. " +
      "Belongs to the example tasks module — drop this entry when you replace it.",
    usedIn: ["modules/tasks"],
  },
];
