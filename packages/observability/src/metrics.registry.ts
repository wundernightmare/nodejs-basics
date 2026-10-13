/**
 * Every metric the services export — what an operator sees on /metrics and
 * in the dashboards, in one list: name, instrument, unit, the labels it is
 * recorded with (all of bounded cardinality: never an id, a path with
 * parameters or a free-form value), what it measures, and for the ones worth
 * an alert what a bad value means.
 *
 * The names are the Prometheus names, and the contract shared with
 * golang-basics (same name, same labels, base units in the name): the
 * exporter prints an instrument's name as it is (a counter without `_total`
 * would get one; units are never appended), with no otel_scope_* labels and
 * no target_info (setup-telemetry.ts). What a broker or a database server
 * measures better — consumer-group lag, server-side connection counts, job
 * queue depth — is read from its exporter, not from every pod.
 *
 * The code creates its instruments with these names, units and
 * descriptions; metrics.registry.spec.ts fails on an instrument that is not
 * here or does not match. `--metrics-reference` prints the list.
 *
 * Data only — no imports: an app's boot.ts reads it before anything loads.
 */

export interface MetricEntry {
  name: string;
  /** The OpenTelemetry instrument that records it. */
  kind: "Counter" | "UpDownCounter" | "Histogram" | "ObservableCounter" | "ObservableGauge";
  unit?: string;
  /** Attribute keys it is recorded with. */
  labels: readonly string[];
  description: string;
  /** What a bad value means and where to look — for alerts and the runbook. */
  watch?: string;
  /** The package or app that records it. */
  source: string;
}

export const METRIC_REGISTRY: readonly MetricEntry[] = [
  {
    name: "http_requests_total",
    kind: "Counter",
    labels: ["method", "route", "status"],
    description: "HTTP requests handled, by method, route template and status.",
    watch:
      '5xx share rising (status=~"5.."): failing requests — the error.id in the response is in the logs. 499: clients gave up before the answer.',
    source: "packages/observability",
  },
  {
    name: "http_request_duration_seconds",
    kind: "Histogram",
    unit: "s",
    labels: ["method", "route"],
    description: "HTTP request latency in seconds, by method and route template.",
    watch:
      "p99 rising: requests slow down — the trace of a slow one (Jaeger) names the slow dependency.",
    source: "packages/observability",
  },
  {
    name: "http_requests_in_flight",
    kind: "UpDownCounter",
    labels: [],
    description: "HTTP requests currently being handled.",
    source: "packages/observability",
  },
  {
    name: "http_unhandled_errors_total",
    kind: "Counter",
    labels: [],
    description: "Requests that failed with an unexpected error (each one answered 500).",
    watch:
      'Any: a bug or an unmapped driver error — the "Unhandled error" log line has the stack and the error.id.',
    source: "apps/api",
  },
  {
    name: "http_client_requests_total",
    kind: "Counter",
    labels: ["target", "method", "outcome"],
    description: "Outbound HTTP calls by target, method and outcome (status class or error kind).",
    source: "packages/resilient-client",
  },
  {
    name: "http_client_request_duration_seconds",
    kind: "Histogram",
    unit: "s",
    labels: ["target", "method"],
    description: "Outbound HTTP call latency in seconds (retries included), by target and method.",
    source: "packages/resilient-client",
  },
  {
    name: "http_client_retries_total",
    kind: "ObservableCounter",
    labels: ["target"],
    description: "Retries sent (attempts after the first), by target.",
    source: "packages/resilient-client",
  },
  {
    name: "http_client_circuit_breaker_state",
    kind: "ObservableGauge",
    labels: ["target"],
    description: "Circuit breaker state per target: 0 closed, 1 open, 2 half-open.",
    watch: "1 (open): calls to that dependency fail fast; it was failing. 2 = probing.",
    source: "packages/resilient-client",
  },
  {
    name: "db_pool_connections",
    kind: "ObservableGauge",
    labels: ["pool", "state"],
    description: "Connections in the pool, by pool and state (idle, in_use).",
    source: "packages/database",
  },
  {
    name: "db_pool_max_connections",
    kind: "ObservableGauge",
    labels: ["pool"],
    description: "The pool's configured maximum size.",
    source: "packages/database",
  },
  {
    name: "db_pool_pending_acquires",
    kind: "ObservableGauge",
    labels: ["pool"],
    description: "Callers waiting for a free connection (the pool is exhausted).",
    watch:
      "> 0 for long: the Postgres pool is exhausted — slow queries or DATABASE_POOL_MAX too small.",
    source: "packages/database",
  },
  {
    name: "db_query_duration_seconds",
    kind: "Histogram",
    unit: "s",
    labels: ["pool", "operation"],
    description: "PostgreSQL statement latency in seconds, by pool and operation.",
    source: "packages/database",
  },
  {
    name: "db_query_errors_total",
    kind: "Counter",
    labels: ["pool", "operation"],
    description: "PostgreSQL statements that failed, by pool and operation.",
    watch:
      "Rising: the operation's warn/error logs and spans carry the SQLSTATE (db.response.status_code).",
    source: "packages/database",
  },
  {
    name: "kafka_producer_records_total",
    kind: "Counter",
    labels: ["client", "topic", "result"],
    description: "Records sent, by client, topic and result (ok, or the KafkaSendError kind).",
    watch:
      "result other than ok: the broker is down or slow (not_connected, queue_full, unavailable) or refuses the record (rejected).",
    source: "packages/kafka",
  },
  {
    name: "kafka_producer_send_duration_seconds",
    kind: "Histogram",
    unit: "s",
    labels: ["client", "topic"],
    description:
      "Time from send() to the broker's acknowledgement (or failure), by client and topic.",
    source: "packages/kafka",
  },
  {
    name: "kafka_consumer_records_total",
    kind: "Counter",
    labels: ["topic", "result"],
    description:
      "Records consumed, by topic and final outcome (ok, retried: ok after a failed attempt, dead_lettered, failed: given up on but not parked).",
    watch:
      "dead_lettered: a handler gives up on messages — log kafka.dead_lettered names the error; replay <topic>.dlq once fixed. failed: a message cannot be parked and holds its partition.",
    source: "packages/kafka",
  },
  {
    name: "kafka_consumer_handler_duration_seconds",
    kind: "Histogram",
    unit: "s",
    labels: ["topic"],
    description: "Duration of one handler attempt, by topic.",
    source: "packages/kafka",
  },
  {
    name: "kafka_consumer_commit_errors_total",
    kind: "Counter",
    labels: [],
    description: "Offset commits that failed (the message is handled; it may be redelivered).",
    source: "packages/kafka",
  },
  {
    name: "kafka_consumer_rebalances_total",
    kind: "Counter",
    labels: ["event"],
    description: "Group rebalance events for this member, by event (assigned, revoked, lost).",
    watch: "lost rising, or constant churn: members time out (max.poll.interval.ms) or crash-loop.",
    source: "packages/kafka",
  },
  {
    name: "kafka_consumer_assigned_partitions",
    kind: "ObservableGauge",
    labels: [],
    description: "Partitions currently assigned to this group member.",
    source: "packages/kafka",
  },
  {
    name: "kafka_client_brokers_up",
    kind: "ObservableGauge",
    labels: ["client"],
    description: "Brokers this client has a live connection (state UP) to.",
    watch:
      "0: the client reaches no broker — network, TLS/SASL settings, or the brokers themselves.",
    source: "packages/kafka",
  },
  {
    name: "kafka_client_request_errors_total",
    kind: "ObservableCounter",
    labels: ["client"],
    description: "Request timeouts and transmit/receive errors, summed over brokers.",
    source: "packages/kafka",
  },
  {
    name: "kafka_producer_queue_bytes",
    kind: "ObservableGauge",
    unit: "By",
    labels: [],
    description: "Bytes waiting in the producer's local send queue.",
    watch:
      "Near kafka_producer_queue_max_bytes: sends back up (queue_full) — the broker is slow or unreachable.",
    source: "packages/kafka",
  },
  {
    name: "kafka_producer_queue_max_bytes",
    kind: "ObservableGauge",
    unit: "By",
    labels: [],
    description:
      "The local send queue's bound (KAFKA_PRODUCER_QUEUE_MAX_KBYTES); full → queue_full.",
    source: "packages/kafka",
  },
  {
    name: "outbox_pending",
    kind: "ObservableGauge",
    labels: [],
    description: "Outbox rows not yet published to Kafka (as of the relay's last pass).",
    source: "packages/outbox",
  },
  {
    name: "outbox_dead",
    kind: "ObservableGauge",
    labels: [],
    description: "Outbox rows rejected OUTBOX_MAX_ATTEMPTS times and no longer sent.",
    watch:
      "> 0: events that will never be published (rejected by the broker). The rows' last_error says why; fix the cause, then reset attempts or delete the rows.",
    source: "packages/outbox",
  },
  {
    name: "outbox_oldest_age_seconds",
    kind: "ObservableGauge",
    unit: "s",
    labels: [],
    description: "Age of the oldest unpublished outbox row (0 when the outbox is empty).",
    watch:
      "Over a minute: the relay is not publishing — Kafka down or slow (kafka_client_brokers_up, the relay's warn logs).",
    source: "packages/outbox",
  },
  {
    name: "job_runs_total",
    kind: "Counter",
    labels: ["queue", "result"],
    description: "Job attempts, by queue and result (completed, retried, failed: no attempt left).",
    watch: "failed rising: jobs exhaust their attempts — the worker's error logs name the job.",
    source: "packages/jobs",
  },
  {
    name: "job_duration_seconds",
    kind: "Histogram",
    unit: "s",
    labels: ["queue"],
    description: "Run time of one job attempt in seconds, by queue.",
    source: "packages/jobs",
  },
  {
    name: "valkey_client_connected",
    kind: "ObservableGauge",
    labels: [],
    description: "1 when the Valkey client is in the ready state, 0 otherwise.",
    watch: "0: Valkey is unreachable; idempotency and jobs fail.",
    source: "packages/cache",
  },
  {
    name: "valkey_client_errors_total",
    kind: "Counter",
    labels: [],
    description: "Errors emitted by the Valkey client.",
    source: "packages/cache",
  },
  {
    name: "valkey_client_reconnects_total",
    kind: "Counter",
    labels: [],
    description: "Reconnect attempts of the Valkey client.",
    source: "packages/cache",
  },
  {
    name: "health_check_up",
    kind: "ObservableGauge",
    labels: ["check", "critical"],
    description:
      "Readiness check result as of the last probe: 1 passing, 0 failing; critical checks gate /readyz.",
    watch:
      "0 with critical=true: the pod is out of the load balancer — the check's name is the dependency.",
    source: "packages/observability",
  },
  {
    name: "app_integration_enabled",
    kind: "ObservableGauge",
    labels: ["integration"],
    description:
      "1 when the integration is on in this process, 0 when its connection variable is unset.",
    watch: "0 in production: a process runs without it (kafka: events wait in the outbox table).",
    source: "packages/observability",
  },
  {
    name: "build_info",
    kind: "ObservableGauge",
    labels: ["version", "revision"],
    description: "Build identity of the running service; always 1.",
    source: "packages/observability",
  },
  {
    name: "nodejs_version_info",
    kind: "ObservableGauge",
    labels: ["version"],
    description: "Node.js version of the running process; always 1.",
    source: "packages/observability",
  },
  {
    name: "process_cpu_user_seconds_total",
    kind: "ObservableCounter",
    unit: "s",
    labels: [],
    description: "User-mode CPU time consumed by the process since it started.",
    source: "packages/observability",
  },
  {
    name: "process_cpu_system_seconds_total",
    kind: "ObservableCounter",
    unit: "s",
    labels: [],
    description: "Kernel-mode CPU time consumed by the process since it started.",
    source: "packages/observability",
  },
  {
    name: "process_start_time_seconds",
    kind: "ObservableGauge",
    unit: "s",
    labels: [],
    description: "Start time of the process since the Unix epoch.",
    source: "packages/observability",
  },
  {
    name: "process_open_fds",
    kind: "ObservableGauge",
    labels: [],
    description: "Open file descriptors (sockets included).",
    watch:
      "Approaching process_max_fds: a connection or file leak — new sockets fail with EMFILE. Linux only.",
    source: "packages/observability",
  },
  {
    name: "process_max_fds",
    kind: "ObservableGauge",
    labels: [],
    description: "The process's open file descriptor limit (soft RLIMIT_NOFILE).",
    source: "packages/observability",
  },
  {
    name: "process_resident_memory_bytes",
    kind: "ObservableGauge",
    unit: "By",
    labels: [],
    description: "Resident set size of the process.",
    source: "packages/observability",
  },
  {
    name: "nodejs_heap_used_bytes",
    kind: "ObservableGauge",
    unit: "By",
    labels: [],
    description: "V8 heap in use.",
    watch:
      "Close to nodejs_heap_limit_bytes: near OOM — a heap snapshot (POST /debug/heapdump) shows what holds memory.",
    source: "packages/observability",
  },
  {
    name: "nodejs_heap_total_bytes",
    kind: "ObservableGauge",
    unit: "By",
    labels: [],
    description: "V8 heap allocated.",
    source: "packages/observability",
  },
  {
    name: "nodejs_heap_limit_bytes",
    kind: "ObservableGauge",
    unit: "By",
    labels: [],
    description: "V8 heap size limit; reaching it is an out-of-memory crash.",
    source: "packages/observability",
  },
  {
    name: "nodejs_external_memory_bytes",
    kind: "ObservableGauge",
    unit: "By",
    labels: [],
    description: "Memory of C++ objects bound to JavaScript objects (Buffers included).",
    source: "packages/observability",
  },
  {
    name: "nodejs_eventloop_delay_seconds",
    kind: "ObservableGauge",
    unit: "s",
    labels: ["quantile"],
    description: "Event loop delay over the last 10 s window, by quantile (0.5, 0.99, max).",
    watch:
      "quantile=0.99 above ~0.1: something blocks the event loop — every request waits for it.",
    source: "packages/observability",
  },
  {
    name: "nodejs_eventloop_utilization",
    kind: "ObservableGauge",
    labels: [],
    description: "Share of the last 10 s window the event loop was busy (0..1).",
    watch:
      "Near 1: the loop is saturated (CPU-bound) — scale out or move the work off the loop; delay rises with it.",
    source: "packages/observability",
  },
  {
    name: "nodejs_gc_duration_seconds",
    kind: "Histogram",
    unit: "s",
    labels: ["kind"],
    description: "Garbage collection pauses, by kind (minor, major, incremental, weakcb).",
    source: "packages/observability",
  },
];

/** The list as --metrics-reference prints it. */
export function metricsReference(): string {
  return METRIC_REGISTRY.map((m) => {
    const head = [
      m.name,
      m.kind,
      m.unit ?? "",
      m.labels.length === 0 ? "no labels" : `labels: ${m.labels.join(", ")}`,
    ]
      .filter((part) => part !== "")
      .join("  ");
    const watch = m.watch === undefined ? "" : `\n    watch: ${m.watch}`;
    return `${head}\n    ${m.description} (${m.source})${watch}`;
  }).join("\n\n");
}
