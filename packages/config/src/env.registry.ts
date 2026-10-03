/**
 * Central registry of every configuration variable understood by the application.
 *
 * Each entry is the authoritative reference for:
 *   - where the variable is consumed (usedIn)
 *   - whether it is required at startup (required)
 *   - its default value when optional (default)
 *   - what it controls (description)
 *
 * config.loader.ts uses this registry at startup to reject unknown YAML keys
 * and values that do not parse as their `type`, and to check required keys.
 *
 * Every key the code reads must be here — env.registry.spec.ts fails on a key
 * read through `config.get` / the builders' readers / `process.env` that is
 * missing. An entry is what makes a key settable from structured YAML
 * (`yaml`) and visible in /admin/config. `default` is written into
 * process.env at startup: leave it out when "unset" means "the library's
 * own default", and say the code's default in the description instead.
 */

/**
 * int, number: a decimal number (int: whole), within min/max; bool:
 * true|false|1|0; duration: Go-style ("30m", "1h30m", "500ms"; a bare number
 * is seconds); json: a JSON object (a YAML mapping is serialised to one);
 * enum: one of `values`.
 */
export type EnvType = "string" | "int" | "number" | "bool" | "duration" | "json" | "enum";

export interface EnvEntry {
  /** Exact variable name (process.env key and flat YAML key). */
  key: string;
  /**
   * Dot-separated path in the structured YAML file (e.g. "database.url").
   * When set, the loader resolves this path in addition to the flat key.
   * Env vars always win; yaml paths take priority over flat keys.
   */
  yaml?: string;
  /**
   * What the value must parse as; the loader checks every set value at
   * startup and the typed readers (config.values.ts) parse it the same way.
   * Default "string" (anything goes).
   */
  type?: EnvType;
  /** Bounds of an int / number value, inclusive. */
  min?: number;
  max?: number;
  /**
   * enum: the allowed values (matched ignoring case). Any other type: literals
   * accepted besides a value of the type ("null" for VALKEY_MAX_RETRIES_PER_REQUEST).
   */
  values?: readonly string[];
  /** Crash at startup if the variable is absent after all sources are merged. */
  required: boolean;
  /** Value used when required=false and the variable is not set. */
  default?: string;
  /** Human-readable description of what the variable controls. */
  description: string;
  /** Source files / modules that read this variable. */
  usedIn: readonly string[];
}

const REGISTRY = [
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
    type: "int",
    min: 0,
    max: 65_535,
    required: false,
    default: "3000",
    description: "TCP port the HTTP server listens on.",
    usedIn: ["main.ts"],
  },

  {
    key: "HTTP_BODY_LIMIT_BYTES",
    yaml: "app.http.body_limit_bytes",
    type: "int",
    min: 1,
    required: false,
    default: "1048576",
    description: "Largest request body the api accepts; a bigger one is a 413 problem.",
    usedIn: ["apps/api/src/app.ts"],
  },

  {
    key: "HTTP_REQUEST_TIMEOUT_MS",
    yaml: "app.http.request_timeout_ms",
    type: "int",
    min: 1,
    required: false,
    default: "10000",
    description:
      "Budget of one api request: receiving it, and every Postgres / Valkey / HTTP call made " +
      "while handling it (the deadline, @base/common deadline.ts) — then 504. A caller's " +
      "x-request-timeout-ms header can shorten it, never extend it.",
    usedIn: ["apps/api/src/app.ts", "common"],
  },

  {
    key: "ADMIN_PORT",
    yaml: "app.admin_port",
    type: "int",
    min: 0,
    max: 65_535,
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
    key: "DISABLED_INTEGRATIONS",
    yaml: "app.disabled_integrations",
    required: false,
    description:
      "Comma-separated integrations this process runs without: never connected to, what " +
      "needs them runs on a substitute (the api: valkey,kafka — Postgres alone). Unset: all " +
      "on. A name the app cannot do without fails the start (@base/config integrations.ts).",
    usedIn: ["config/integrations.ts", "apps/api/src/app.module.ts"],
  },

  {
    key: "LOG_LEVEL",
    yaml: "app.log_level",
    type: "enum",
    values: ["trace", "debug", "info", "warn", "error", "fatal", "silent"],
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
    type: "duration",
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
    key: "SERVICE_VERSION",
    required: false,
    description:
      "The build's version — service.version in every log line, trace and metric target, " +
      "and GET /version. Baked into the image (--build-arg: the release tag, else the " +
      'commit); npm\'s package version under `pnpm run`, else "dev".',
    usedIn: ["logger"],
  },

  {
    key: "GIT_COMMIT",
    yaml: "app.git_commit",
    required: false,
    description:
      "Build revision reported by GET /version (and /admin/info). Baked into the image " +
      '(--build-arg); "unknown" when unset.',
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
      "Path to a Secret-mounted file holding the database password; overrides the password " +
      "in DATABASE_URL. Read once at startup (unreadable or empty → startup error).",
    usedIn: ["database"],
  },

  {
    key: "DATABASE_POOL_MAX",
    yaml: "database.pool_max",
    type: "int",
    min: 1,
    required: false,
    default: "10",
    description: "Maximum pg pool size.",
    usedIn: ["database"],
  },

  {
    key: "DATABASE_READONLY_URL",
    yaml: "database.readonly_url",
    required: false,
    description:
      "Connection URL of a read replica for the PG_POOL_READONLY pool. Unset: read-only callers share the primary pool.",
    usedIn: ["database"],
  },

  {
    key: "DATABASE_POOL_MIN",
    yaml: "database.pool_min",
    type: "int",
    min: 0,
    required: false,
    default: "0",
    description: "Minimum pg pool size kept open.",
    usedIn: ["database"],
  },

  {
    key: "DATABASE_POOL_IDLE_TIMEOUT_MS",
    yaml: "database.pool_idle_timeout_ms",
    type: "int",
    min: 0,
    required: false,
    default: "30000",
    description: "Close a pooled connection idle this long.",
    usedIn: ["database"],
  },

  {
    key: "DATABASE_POOL_MAX_USES",
    yaml: "database.pool_max_uses",
    type: "int",
    min: 0,
    required: false,
    default: "0",
    description: "Recycle a connection after this many checkouts (0 = never).",
    usedIn: ["database"],
  },

  {
    key: "DATABASE_CONNECT_TIMEOUT_MS",
    yaml: "database.connect_timeout_ms",
    type: "int",
    min: 1,
    required: false,
    default: "5000",
    description: "TCP + auth connect timeout (libpq connect_timeout).",
    usedIn: ["database"],
  },

  {
    key: "DATABASE_STATEMENT_TIMEOUT_MS",
    yaml: "database.statement_timeout_ms",
    type: "int",
    min: 0,
    required: false,
    default: "30000",
    description: "Server-side statement_timeout set on every connection.",
    usedIn: ["database"],
  },

  {
    key: "DATABASE_IDLE_IN_TRANSACTION_TIMEOUT_MS",
    yaml: "database.idle_in_transaction_timeout_ms",
    type: "int",
    min: 0,
    required: false,
    default: "60000",
    description: "Server-side idle_in_transaction_session_timeout set on every connection.",
    usedIn: ["database"],
  },

  {
    key: "DATABASE_QUERY_TIMEOUT_MS",
    yaml: "database.query_timeout_ms",
    type: "int",
    min: 0,
    required: false,
    description:
      "Client-side pg query_timeout. Unset: none (the server statement_timeout applies).",
    usedIn: ["database"],
  },

  {
    key: "DATABASE_KEEPALIVE",
    yaml: "database.keepalive",
    type: "bool",
    required: false,
    default: "true",
    description: "TCP keepalive on pool connections (true|false).",
    usedIn: ["database"],
  },

  {
    key: "DATABASE_KEEPALIVE_INITIAL_DELAY_MS",
    yaml: "database.keepalive_initial_delay_ms",
    type: "int",
    min: 0,
    required: false,
    default: "10000",
    description: "Delay before the first TCP keepalive probe.",
    usedIn: ["database"],
  },

  {
    key: "DATABASE_APPLICATION_NAME",
    yaml: "database.application_name",
    required: false,
    description:
      "application_name shown in pg_stat_activity (the read-only pool appends -ro). Default: OTEL_SERVICE_NAME.",
    usedIn: ["database"],
  },

  {
    key: "DATABASE_TARGET_SESSION_ATTRS",
    yaml: "database.target_session_attrs",
    type: "enum",
    values: ["any", "read-write", "read-only", "primary", "standby", "prefer-standby"],
    required: false,
    description:
      "libpq target_session_attrs of the primary pool (e.g. read-write for multi-host failover URLs). Unset: libpq default (any).",
    usedIn: ["database"],
  },

  {
    key: "DATABASE_READONLY_TARGET_SESSION_ATTRS",
    yaml: "database.readonly_target_session_attrs",
    type: "enum",
    values: ["any", "read-write", "read-only", "primary", "standby", "prefer-standby"],
    required: false,
    description:
      "target_session_attrs of the read-only pool (e.g. prefer-standby). Default: DATABASE_TARGET_SESSION_ATTRS, else any.",
    usedIn: ["database"],
  },

  {
    key: "DATABASE_USE_NATIVE",
    yaml: "database.use_native",
    type: "bool",
    required: false,
    default: "false",
    description: "Use pg-native (libpq) instead of pure-JS pg — needed for multi-host URLs.",
    usedIn: ["database"],
  },

  {
    key: "DATABASE_SSL_MODE",
    yaml: "database.ssl.mode",
    type: "enum",
    values: ["disable", "allow", "prefer", "require", "verify-ca", "verify-full", "no-verify"],
    required: false,
    description: "libpq sslmode (disable|require|verify-ca|verify-full). Unset: from DATABASE_URL.",
    usedIn: ["database"],
  },

  {
    key: "DATABASE_SSL_CA_LOCATION",
    yaml: "database.ssl.ca_location",
    required: false,
    description: "Path to the CA bundle that verifies the server certificate.",
    usedIn: ["database"],
  },

  {
    key: "DATABASE_SSL_CA_PEM",
    yaml: "database.ssl.ca_pem",
    required: false,
    description:
      "The CA bundle inline (PEM), when a file cannot be mounted. DATABASE_SSL_CA_LOCATION wins.",
    usedIn: ["database"],
  },

  {
    key: "DATABASE_SSL_SKIP_VERIFY",
    yaml: "database.ssl.skip_verify",
    type: "bool",
    required: false,
    default: "false",
    description: "Accept any server certificate (true|false). Never in production.",
    usedIn: ["database"],
  },

  {
    key: "DATABASE_EXTRA_PROPERTIES",
    yaml: "database.extra_properties",
    type: "json",
    required: false,
    description: "JSON object of extra pg PoolConfig properties, applied last (escape hatch).",
    usedIn: ["database"],
  },

  {
    key: "DATABASE_RETRY_MAX_ATTEMPTS",
    yaml: "database.retry.max_attempts",
    type: "int",
    min: 1,
    required: false,
    default: "3",
    description: "Attempts per Postgres operation incl. the first.",
    usedIn: ["database"],
  },

  {
    key: "DATABASE_RETRY_BASE_DELAY_MS",
    yaml: "database.retry.base_delay_ms",
    type: "int",
    min: 0,
    required: false,
    default: "100",
    description: "First backoff delay (full jitter, doubling).",
    usedIn: ["database"],
  },

  {
    key: "DATABASE_RETRY_MAX_DELAY_MS",
    yaml: "database.retry.max_delay_ms",
    type: "int",
    min: 0,
    required: false,
    default: "5000",
    description: "Backoff delay cap.",
    usedIn: ["database"],
  },

  {
    key: "DATABASE_RETRY_BUDGET_MS",
    yaml: "database.retry.budget_ms",
    type: "int",
    min: 0,
    required: false,
    default: "10000",
    description: "Total time one operation may spend retrying.",
    usedIn: ["database"],
  },

  {
    key: "DATABASE_CB_ENABLED",
    yaml: "database.circuit_breaker.enabled",
    type: "bool",
    required: false,
    default: "true",
    description: "Circuit breaker around Postgres calls (true|false).",
    usedIn: ["database"],
  },

  {
    key: "DATABASE_CB_TIMEOUT_MS",
    yaml: "database.circuit_breaker.timeout_ms",
    type: "int",
    min: 1,
    required: false,
    default: "30000",
    description: "A call slower than this counts as a failure.",
    usedIn: ["database"],
  },

  {
    key: "DATABASE_CB_ERROR_THRESHOLD_PCT",
    yaml: "database.circuit_breaker.error_threshold_pct",
    type: "number",
    min: 0,
    max: 100,
    required: false,
    default: "50",
    description: "Failure percentage that opens the breaker.",
    usedIn: ["database"],
  },

  {
    key: "DATABASE_CB_VOLUME_THRESHOLD",
    yaml: "database.circuit_breaker.volume_threshold",
    type: "int",
    min: 1,
    required: false,
    default: "10",
    description: "Calls in the window before the breaker may open.",
    usedIn: ["database"],
  },

  {
    key: "DATABASE_CB_RESET_TIMEOUT_MS",
    yaml: "database.circuit_breaker.reset_timeout_ms",
    type: "int",
    min: 1,
    required: false,
    default: "30000",
    description: "Time open before a half-open probe.",
    usedIn: ["database"],
  },

  {
    key: "MIGRATIONS_DIR",
    required: false,
    description:
      "Directory of the *.sql migrations apps/migrate applies. Default: migrations/ at the repo root; " +
      "/migrations in the migrate image.",
    usedIn: ["apps/migrate"],
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

  {
    key: "VALKEY_USERNAME",
    yaml: "cache.username",
    required: false,
    description: "ACL user. Overrides the user in VALKEY_URL.",
    usedIn: ["cache"],
  },

  {
    key: "VALKEY_PASSWORD",
    yaml: "cache.password",
    required: false,
    description: "Password. Overrides the password in VALKEY_URL.",
    usedIn: ["cache"],
  },

  {
    key: "VALKEY_DB",
    yaml: "cache.db",
    type: "int",
    min: 0,
    required: false,
    description:
      "Logical database number; overrides the path of VALKEY_URL (unset: that path, else 0).",
    usedIn: ["cache"],
  },

  {
    key: "VALKEY_TLS",
    yaml: "cache.tls",
    type: "bool",
    required: false,
    default: "false",
    description: "TLS without a rediss:// URL (true|false).",
    usedIn: ["cache"],
  },

  {
    key: "VALKEY_SKIP_VERIFY",
    yaml: "cache.skip_verify",
    type: "bool",
    required: false,
    default: "false",
    description: "Accept any server certificate (true|false). Never in production.",
    usedIn: ["cache"],
  },

  {
    key: "VALKEY_CA_LOCATION",
    yaml: "cache.ca_location",
    required: false,
    description: "Path to the CA bundle that verifies the server certificate.",
    usedIn: ["cache"],
  },

  {
    key: "VALKEY_CA_PEM",
    yaml: "cache.ca_pem",
    required: false,
    description: "The CA bundle inline (PEM). VALKEY_CA_LOCATION wins.",
    usedIn: ["cache"],
  },

  {
    key: "VALKEY_CONNECT_TIMEOUT_MS",
    yaml: "cache.connect_timeout_ms",
    type: "int",
    min: 1,
    required: false,
    default: "5000",
    description: "Connect timeout.",
    usedIn: ["cache"],
  },

  {
    key: "VALKEY_COMMAND_TIMEOUT_MS",
    yaml: "cache.command_timeout_ms",
    type: "int",
    min: 0,
    required: false,
    default: "5000",
    description: "Per-command timeout of the shared client (never applied to BullMQ connections).",
    usedIn: ["cache"],
  },

  {
    key: "VALKEY_KEEPALIVE_MS",
    yaml: "cache.keepalive_ms",
    type: "int",
    min: 0,
    required: false,
    default: "0",
    description: "TCP keepalive initial delay (0 = off).",
    usedIn: ["cache"],
  },

  {
    key: "VALKEY_MAX_RETRIES_PER_REQUEST",
    yaml: "cache.max_retries_per_request",
    type: "int",
    min: 0,
    values: ["null"],
    required: false,
    default: "3",
    description: 'iovalkey maxRetriesPerRequest ("null" = retry forever). Default 3.',
    usedIn: ["cache"],
  },

  {
    key: "VALKEY_RECONNECT_BASE_DELAY_MS",
    yaml: "cache.reconnect_base_delay_ms",
    type: "int",
    min: 0,
    required: false,
    default: "100",
    description: "First reconnect delay (exponential).",
    usedIn: ["cache"],
  },

  {
    key: "VALKEY_RECONNECT_MAX_DELAY_MS",
    yaml: "cache.reconnect_max_delay_ms",
    type: "int",
    min: 0,
    required: false,
    default: "5000",
    description: "Reconnect delay cap.",
    usedIn: ["cache"],
  },

  {
    key: "VALKEY_EXTRA_PROPERTIES",
    yaml: "cache.extra_properties",
    type: "json",
    required: false,
    description: "JSON object of extra iovalkey options, applied last (escape hatch).",
    usedIn: ["cache"],
  },

  {
    key: "VALKEY_RETRY_MAX_ATTEMPTS",
    yaml: "cache.retry.max_attempts",
    type: "int",
    min: 1,
    required: false,
    default: "3",
    description: "Attempts per Valkey operation incl. the first.",
    usedIn: ["cache"],
  },

  {
    key: "VALKEY_RETRY_BASE_DELAY_MS",
    yaml: "cache.retry.base_delay_ms",
    type: "int",
    min: 0,
    required: false,
    default: "50",
    description: "First backoff delay (full jitter, doubling).",
    usedIn: ["cache"],
  },

  {
    key: "VALKEY_RETRY_MAX_DELAY_MS",
    yaml: "cache.retry.max_delay_ms",
    type: "int",
    min: 0,
    required: false,
    default: "1000",
    description: "Backoff delay cap.",
    usedIn: ["cache"],
  },

  {
    key: "VALKEY_RETRY_BUDGET_MS",
    yaml: "cache.retry.budget_ms",
    type: "int",
    min: 0,
    required: false,
    default: "5000",
    description: "Total time one operation may spend retrying.",
    usedIn: ["cache"],
  },

  {
    key: "VALKEY_CB_ENABLED",
    yaml: "cache.circuit_breaker.enabled",
    type: "bool",
    required: false,
    default: "false",
    description: "Circuit breaker around Valkey calls (true|false).",
    usedIn: ["cache"],
  },

  {
    key: "VALKEY_CB_TIMEOUT_MS",
    yaml: "cache.circuit_breaker.timeout_ms",
    type: "int",
    min: 1,
    required: false,
    default: "5000",
    description: "A call slower than this counts as a failure.",
    usedIn: ["cache"],
  },

  {
    key: "VALKEY_CB_ERROR_THRESHOLD_PCT",
    yaml: "cache.circuit_breaker.error_threshold_pct",
    type: "number",
    min: 0,
    max: 100,
    required: false,
    default: "50",
    description: "Failure percentage that opens the breaker.",
    usedIn: ["cache"],
  },

  {
    key: "VALKEY_CB_VOLUME_THRESHOLD",
    yaml: "cache.circuit_breaker.volume_threshold",
    type: "int",
    min: 1,
    required: false,
    default: "20",
    description: "Calls in the window before the breaker may open.",
    usedIn: ["cache"],
  },

  {
    key: "VALKEY_CB_RESET_TIMEOUT_MS",
    yaml: "cache.circuit_breaker.reset_timeout_ms",
    type: "int",
    min: 1,
    required: false,
    default: "15000",
    description: "Time open before a half-open probe.",
    usedIn: ["cache"],
  },

  {
    key: "IDEMPOTENCY_TTL_SECONDS",
    yaml: "idempotency.ttl_seconds",
    type: "int",
    min: 1,
    required: false,
    default: "86400",
    description: "How long a stored Idempotency-Key result is replayed. 86400 = 24 h.",
    usedIn: ["idempotency"],
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
    description: "Kafka client.id reported to the broker. Default: OTEL_SERVICE_NAME.",
    usedIn: ["kafka"],
  },

  {
    key: "KAFKA_CONSUMER_AUTO_OFFSET_RESET",
    yaml: "kafka.consumer.auto_offset_reset",
    type: "enum",
    values: ["earliest", "latest", "smallest", "largest", "beginning", "end", "error"],
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
      "Path to a Secret-mounted file holding the SASL password; wins over " +
      "KAFKA_SASL_PASSWORD. Read once at startup (unreadable or empty → startup error).",
    usedIn: ["kafka"],
  },

  {
    key: "KAFKA_SECURITY_PROTOCOL",
    yaml: "kafka.security_protocol",
    type: "enum",
    values: ["plaintext", "ssl", "sasl_plaintext", "sasl_ssl"],
    required: false,
    description:
      "librdkafka security.protocol (plaintext|ssl|sasl_plaintext|sasl_ssl). Unset: plaintext.",
    usedIn: ["kafka"],
  },

  {
    key: "KAFKA_SASL_MECHANISM",
    yaml: "kafka.sasl.mechanism",
    type: "enum",
    values: ["PLAIN", "SCRAM-SHA-256", "SCRAM-SHA-512"],
    required: false,
    description: "sasl.mechanism (PLAIN|SCRAM-SHA-256|SCRAM-SHA-512).",
    usedIn: ["kafka"],
  },

  {
    key: "KAFKA_SASL_USERNAME",
    yaml: "kafka.sasl.username",
    required: false,
    description: "SASL user.",
    usedIn: ["kafka"],
  },

  {
    key: "KAFKA_SASL_PASSWORD",
    yaml: "kafka.sasl.password",
    required: false,
    description: "SASL password. KAFKA_SASL_PASSWORD_FILE wins.",
    usedIn: ["kafka"],
  },

  {
    key: "KAFKA_SSL_CA_LOCATION",
    yaml: "kafka.ssl.ca_location",
    required: false,
    description: "Path to the CA bundle that verifies the brokers.",
    usedIn: ["kafka"],
  },

  {
    key: "KAFKA_SSL_CA_PEM",
    yaml: "kafka.ssl.ca_pem",
    required: false,
    description:
      "The CA bundle inline (PEM); written to a temp file for librdkafka. KAFKA_SSL_CA_LOCATION wins.",
    usedIn: ["kafka"],
  },

  {
    key: "KAFKA_SSL_ENDPOINT_IDENTIFICATION_ALGORITHM",
    yaml: "kafka.ssl.endpoint_identification_algorithm",
    type: "enum",
    values: ["https", "none"],
    required: false,
    description:
      "ssl.endpoint.identification.algorithm (https|none). Unset: librdkafka default (https).",
    usedIn: ["kafka"],
  },

  {
    key: "KAFKA_REQUEST_TIMEOUT_MS",
    yaml: "kafka.request_timeout_ms",
    type: "int",
    min: 1,
    required: false,
    description: "socket request timeout. Unset: librdkafka default.",
    usedIn: ["kafka"],
  },

  {
    key: "KAFKA_METADATA_MAX_AGE_MS",
    yaml: "kafka.metadata_max_age_ms",
    type: "int",
    min: 0,
    required: false,
    description: "metadata.max.age.ms. Unset: librdkafka default.",
    usedIn: ["kafka"],
  },

  {
    key: "KAFKA_RECONNECT_BACKOFF_MS",
    yaml: "kafka.reconnect_backoff_ms",
    type: "int",
    min: 0,
    required: false,
    description: "reconnect.backoff.ms. Unset: librdkafka default.",
    usedIn: ["kafka"],
  },

  {
    key: "KAFKA_RECONNECT_BACKOFF_MAX_MS",
    yaml: "kafka.reconnect_backoff_max_ms",
    type: "int",
    min: 0,
    required: false,
    description: "reconnect.backoff.max.ms. Unset: librdkafka default.",
    usedIn: ["kafka"],
  },

  {
    key: "KAFKA_PRODUCER_ACKS",
    yaml: "kafka.producer.acks",
    type: "enum",
    values: ["all", "-1", "0", "1"],
    required: false,
    default: "all",
    description: "Producer acks.",
    usedIn: ["kafka"],
  },

  {
    key: "KAFKA_PRODUCER_ENABLE_IDEMPOTENCE",
    yaml: "kafka.producer.enable_idempotence",
    type: "bool",
    required: false,
    default: "true",
    description: "Producer enable.idempotence (true|false).",
    usedIn: ["kafka"],
  },

  {
    key: "KAFKA_PRODUCER_COMPRESSION_TYPE",
    yaml: "kafka.producer.compression_type",
    type: "enum",
    values: ["none", "gzip", "snappy", "lz4", "zstd"],
    required: false,
    default: "lz4",
    description:
      "Producer compression.type (none|gzip|snappy|lz4|zstd). lz4: cheapest in CPU and " +
      "latency; zstd when bandwidth or broker disk is the constraint.",
    usedIn: ["kafka"],
  },

  {
    key: "KAFKA_PRODUCER_LINGER_MS",
    yaml: "kafka.producer.linger_ms",
    type: "int",
    min: 0,
    required: false,
    default: "10",
    description: "Producer linger.ms (batching window).",
    usedIn: ["kafka"],
  },

  {
    key: "KAFKA_PRODUCER_MESSAGE_TIMEOUT_MS",
    yaml: "kafka.producer.message_timeout_ms",
    type: "int",
    min: 1,
    required: false,
    default: "30000",
    description: "Producer message.timeout.ms (delivery deadline).",
    usedIn: ["kafka"],
  },

  {
    key: "KAFKA_PRODUCER_QUEUE_MAX_KBYTES",
    yaml: "kafka.producer.queue_max_kbytes",
    type: "int",
    min: 1,
    required: false,
    default: "65536",
    description:
      "Producer queue.buffering.max.kbytes — memory bound of the local send queue. Default 65536 " +
      "(64 MiB; librdkafka's own is 1 GiB). A full queue fails send() with QUEUE_FULL.",
    usedIn: ["kafka"],
  },

  {
    key: "KAFKA_PRODUCER_EXTRA_PROPERTIES",
    yaml: "kafka.producer.extra_properties",
    type: "json",
    required: false,
    description:
      "JSON object of librdkafka properties for the producer only, applied after " +
      "KAFKA_EXTRA_PROPERTIES.",
    usedIn: ["kafka"],
  },

  {
    key: "KAFKA_CONSUMER_EXTRA_PROPERTIES",
    yaml: "kafka.consumer.extra_properties",
    type: "json",
    required: false,
    description:
      "JSON object of librdkafka properties for consumers only, applied after " +
      "KAFKA_EXTRA_PROPERTIES.",
    usedIn: ["kafka", "apps/worker"],
  },

  {
    key: "KAFKA_CONSUMER_PARTITIONS_CONCURRENTLY",
    yaml: "kafka.consumer.partitions_concurrently",
    type: "int",
    min: 1,
    required: false,
    default: "1",
    description:
      "How many assigned partitions a consumer handles in parallel (eachMessage; order within " +
      "a partition holds). Raise it when one consumer serves many partitions/topics.",
    usedIn: ["apps/worker"],
  },

  {
    key: "WORKER_QUEUE_MAX_WAITING",
    yaml: "worker.queue_max_waiting",
    type: "int",
    min: 1,
    required: false,
    default: "10000",
    description:
      "Waiting jobs in the worker's BullMQ queue above which the Kafka consumer pauses its " +
      "partitions (back-pressure: the backlog stays in Kafka, not in Valkey).",
    usedIn: ["apps/worker"],
  },

  {
    key: "KAFKA_STATISTICS_INTERVAL_MS",
    yaml: "kafka.statistics_interval_ms",
    type: "int",
    min: 0,
    required: false,
    default: "15000",
    description:
      "statistics.interval.ms — how often librdkafka reports the stats behind the kafka.client.* " +
      "metrics. 0 disables them. The report lists every topic and partition " +
      "(~2.4 MB / ~5 ms to parse at 300 topics × 12 partitions): raise it for thousands of topics.",
    usedIn: ["kafka"],
  },

  {
    key: "KAFKA_CONSUMER_ENABLE_AUTO_COMMIT",
    yaml: "kafka.consumer.enable_auto_commit",
    type: "bool",
    required: false,
    default: "false",
    description: "Consumer enable.auto.commit (true|false). Commits after handling.",
    usedIn: ["kafka", "apps/worker"],
  },

  {
    key: "KAFKA_CONSUMER_SESSION_TIMEOUT_MS",
    yaml: "kafka.consumer.session_timeout_ms",
    type: "int",
    min: 1,
    required: false,
    default: "10000",
    description: "Consumer session.timeout.ms.",
    usedIn: ["kafka", "apps/worker"],
  },

  {
    key: "KAFKA_CONSUMER_MAX_POLL_INTERVAL_MS",
    yaml: "kafka.consumer.max_poll_interval_ms",
    type: "int",
    min: 1,
    required: false,
    default: "300000",
    description: "Consumer max.poll.interval.ms.",
    usedIn: ["kafka", "apps/worker"],
  },

  {
    key: "KAFKA_EXTRA_PROPERTIES",
    yaml: "kafka.extra_properties",
    type: "json",
    required: false,
    description:
      "JSON object of extra librdkafka properties, applied last to every client (escape hatch).",
    usedIn: ["kafka"],
  },

  // ─── Outbox ────────────────────────────────────────────────────────────────

  {
    key: "OUTBOX_POLL_INTERVAL_MS",
    yaml: "outbox.poll_interval_ms",
    type: "int",
    min: 1,
    required: false,
    default: "200",
    description:
      "How often OutboxRelay looks for unpublished outbox rows (at once again while a full batch " +
      "comes back; backoff up to 30 s on failure). The latency of an event, at worst.",
    usedIn: ["outbox"],
  },

  {
    key: "OUTBOX_BATCH_SIZE",
    yaml: "outbox.batch_size",
    type: "int",
    min: 1,
    required: false,
    default: "100",
    description: "Outbox rows one relay pass takes (FOR UPDATE SKIP LOCKED) and publishes.",
    usedIn: ["outbox"],
  },

  {
    key: "OUTBOX_MAX_ATTEMPTS",
    yaml: "outbox.max_attempts",
    type: "int",
    min: 1,
    required: false,
    default: "10",
    description:
      "Failed sends after which an outbox row is no longer published. Only a rejected record " +
      "counts (KAFKA_SEND_ERRORS: too large, invalid) — an outage, back-pressure or a missing " +
      "topic never does. The row stays with last_error; outbox.dead counts them.",
    usedIn: ["outbox"],
  },

  // ─── OpenTelemetry ─────────────────────────────────────────────────────────

  {
    key: "OTEL_SERVICE_NAME",
    required: false,
    description:
      "Service name reported to OTel, in ECS service.name of every log line, and the default " +
      "Kafka client.id / Postgres application_name. Default: per app (apps/*/src/boot.ts: " +
      "nodejs-basics-api / nodejs-basics-worker)." +
      " Environment only: telemetry starts in instrumentation.ts, before config.yaml is read.",
    usedIn: ["logger", "observability"],
  },

  {
    key: "OTEL_EXPORTER_OTLP_ENDPOINT",
    required: false,
    description:
      "OTLP gRPC endpoint for trace export (e.g. http://otel-collector:4317). Environment only: telemetry starts in instrumentation.ts, before config.yaml is read.",
    usedIn: ["observability"],
  },

  {
    key: "OTLP_ENDPOINT",
    required: false,
    description:
      "Legacy alias of OTEL_EXPORTER_OTLP_ENDPOINT (read only when that is unset). Environment only: telemetry starts in instrumentation.ts, before config.yaml is read.",
    usedIn: ["observability"],
  },

  // ─── Sentry ────────────────────────────────────────────────────────────────

  {
    key: "SENTRY_DSN",
    required: false,
    description:
      "Sentry DSN for error reporting. When unset, Sentry.init() runs as a no-op " +
      "and exceptions are not captured. @sentry/nestjs auto-instruments NestJS error " +
      "handling once initialised. Environment only: telemetry starts in instrumentation.ts, before config.yaml is read.",
    usedIn: ["observability"],
  },

  // ─── Pyroscope (continuous profiling) ─────────────────────────────────────

  {
    key: "PYROSCOPE_SERVER_ADDRESS",
    required: false,
    description:
      "Pyroscope server URL (e.g. http://pyroscope:4040). When unset, the profiler " +
      "is not started. Environment only: telemetry starts in instrumentation.ts, before config.yaml is read.",
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
    type: "number",
    min: 0,
    max: 1,
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
    type: "int",
    min: 1,
    required: false,
    default: "10000",
    description: "Heap usage poll interval in milliseconds.",
    usedIn: ["observability"],
  },

  // ─── Example modules ──────────────────────────────────────────────────────

  {
    key: "TASK_LIST_PAGE_SIZE",
    yaml: "tasks.list_page_size",
    type: "int",
    min: 1,
    required: false,
    default: "50",
    description:
      "Default page size for GET /tasks when the caller does not pass ?limit. " +
      "Belongs to the example tasks module — drop this entry when you replace it.",
    usedIn: ["modules/tasks"],
  },
] as const satisfies readonly EnvEntry[];

/** Every entry, for code that walks the registry. */
export const ENV_REGISTRY: readonly EnvEntry[] = REGISTRY;

/** Every configuration key the application knows. */
export type EnvKey = (typeof REGISTRY)[number]["key"];

/** The keys with a registry default — reading one never yields undefined. */
export type DefaultedEnvKey = Extract<
  (typeof REGISTRY)[number],
  { readonly default: string }
>["key"];
