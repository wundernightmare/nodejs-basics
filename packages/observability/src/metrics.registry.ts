/**
 * Every metric the services export — what an operator sees on /metrics and
 * in the dashboards, in one list: name, instrument, unit, the labels it is
 * recorded with (all of bounded cardinality: never an id, a path with
 * parameters or a topic), what it measures, and for the ones worth an alert
 * what a bad value means.
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
    name: "worker_tasks_consumed_total",
    kind: "Counter",
    labels: [],
    description: "task.created events consumed from Kafka and enqueued.",
    source: "apps/worker",
  },
  {
    name: "worker_tasks_processed_total",
    kind: "Counter",
    labels: [],
    description: "Task jobs processed successfully by the job worker.",
    source: "apps/worker",
  },
  {
    name: "app.integration.enabled",
    kind: "ObservableGauge",
    labels: ["integration"],
    description:
      "1 when the integration is on in this process, 0 when its connection variable is unset.",
    watch: "0 in production: a process runs without it (kafka: events wait in the outbox table).",
    source: "packages/observability",
  },
  {
    name: "valkey.client.connected",
    kind: "ObservableGauge",
    labels: ["client_id"],
    description: "1 when the Valkey client is in the ready state, 0 otherwise.",
    watch: "0: Valkey is unreachable; idempotency and jobs fail.",
    source: "packages/cache",
  },
  {
    name: "valkey.client.errors_total",
    kind: "Counter",
    labels: ["client_id", "type"],
    description: "Total number of errors emitted by the Valkey client.",
    source: "packages/cache",
  },
  {
    name: "valkey.client.reconnects_total",
    kind: "Counter",
    labels: ["client_id"],
    description: "Total reconnect attempts triggered by iovalkey's retryStrategy.",
    source: "packages/cache",
  },
  {
    name: "errors.total",
    kind: "Counter",
    unit: "{error}",
    labels: ["error.type", "http.route", "http.response.status_code"],
    description: "Total HTTP errors by type and route",
    watch:
      "5xx rising (http.response.status_code=5xx): unplanned errors \u2014 the error.id in the response is in the logs.",
    source: "packages/common",
  },
  {
    name: "bullmq.job.completed.total",
    kind: "Counter",
    labels: ["queue"],
    description: "Number of BullMQ jobs completed successfully",
    source: "packages/jobs",
  },
  {
    name: "bullmq.job.failed.total",
    kind: "Counter",
    labels: ["queue"],
    description: "Number of BullMQ jobs that failed (all attempts exhausted)",
    watch: "Rising: jobs exhaust their attempts \u2014 the worker's error logs name the job.",
    source: "packages/jobs",
  },
  {
    name: "bullmq.job.stalled.total",
    kind: "Counter",
    labels: ["queue"],
    description: "Number of BullMQ jobs that stalled (pod crash during processing)",
    watch: "Rising: workers die or block mid-job (event loop delay, OOM restarts).",
    source: "packages/jobs",
  },
  {
    name: "bullmq.job.duration.ms",
    kind: "Histogram",
    unit: "ms",
    labels: ["queue", "outcome"],
    description: "BullMQ job processing duration in milliseconds",
    source: "packages/jobs",
  },
  {
    name: "kafka.client.brokers.up",
    kind: "ObservableGauge",
    unit: "{broker}",
    labels: ["kafka.client.role"],
    description: "Brokers this client has a connection in state UP to.",
    watch:
      "0: the client reaches no broker \u2014 network, TLS/SASL settings, or the brokers themselves.",
    source: "packages/kafka",
  },
  {
    name: "kafka.client.request.errors",
    kind: "ObservableCounter",
    unit: "{error}",
    labels: ["kafka.client.role"],
    description: "Request timeouts and transmit/receive errors, summed over brokers.",
    source: "packages/kafka",
  },
  {
    name: "kafka.client.producer.queue.size",
    kind: "ObservableGauge",
    unit: "By",
    labels: ["kafka.client.role"],
    description: "Bytes in the producer's local send queue.",
    watch:
      "Near kafka.client.producer.queue.size.limit: sends back up (queue_full) \u2014 the broker is slow or unreachable.",
    source: "packages/kafka",
  },
  {
    name: "kafka.client.producer.queue.size.limit",
    kind: "ObservableGauge",
    unit: "By",
    labels: ["kafka.client.role"],
    description: "The local queue's bound (queue.buffering.max.kbytes); full \u2192 QUEUE_FULL.",
    source: "packages/kafka",
  },
  {
    name: "kafka.client.consumer.lag.max",
    kind: "ObservableGauge",
    unit: "{message}",
    labels: ["kafka.client.role"],
    description: "Largest lag (messages behind the partition end) over the assigned partitions.",
    watch:
      "Growing: a consumer falls behind or a partition is stuck on a message whose handler keeps failing (warn logs with the offset).",
    source: "packages/kafka",
  },
  {
    name: "kafka.client.consumer.lag.sum",
    kind: "ObservableGauge",
    unit: "{message}",
    labels: ["kafka.client.role"],
    description: "Total lag over the assigned partitions.",
    source: "packages/kafka",
  },
  {
    name: "kafka.client.consumer.rebalances",
    kind: "ObservableCounter",
    unit: "{rebalance}",
    labels: ["kafka.client.role"],
    description: "Consumer group rebalances this client went through.",
    source: "packages/kafka",
  },
  {
    name: "valkey.client.command_queue_size",
    kind: "ObservableGauge",
    unit: "{command}",
    labels: [],
    description: "Commands dispatched to Valkey that are awaiting a reply from the server",
    source: "packages/cache",
  },
  {
    name: "db.client.connection.count",
    kind: "ObservableGauge",
    unit: "{connection}",
    labels: ["db.client.connection.state"],
    description: "Number of connections currently in the pg.Pool, split by state",
    source: "packages/observability",
  },
  {
    name: "db.client.connection.pending_requests",
    kind: "ObservableGauge",
    unit: "{request}",
    labels: [],
    description: "Number of pending client requests waiting for a free pg.Pool connection",
    watch:
      "> 0 for long: the Postgres pool is exhausted \u2014 slow queries or DATABASE_POOL_MAX too small.",
    source: "packages/observability",
  },
  {
    name: "http.server.request.duration",
    kind: "Histogram",
    unit: "ms",
    labels: ["http.request.method", "http.route", "http.response.status_code"],
    description: "Duration of HTTP server requests",
    watch:
      "p99 rising: requests slow down \u2014 look at the trace of a slow one (Jaeger) for the slow dependency.",
    source: "packages/observability",
  },
  {
    name: "http.server.active_requests",
    kind: "UpDownCounter",
    unit: "{request}",
    labels: ["http.request.method"],
    description: "Number of HTTP server requests currently in flight",
    source: "packages/observability",
  },
  {
    name: "nodejs.heap.size.used",
    kind: "ObservableGauge",
    unit: "By",
    labels: [],
    description: "Process heap used in bytes",
    watch:
      "Close to the heap limit: near OOM \u2014 a heap snapshot (POST /debug/heapdump) shows what holds memory.",
    source: "packages/observability",
  },
  {
    name: "nodejs.heap.size.total",
    kind: "ObservableGauge",
    unit: "By",
    labels: [],
    description: "Process heap total in bytes",
    source: "packages/observability",
  },
  {
    name: "nodejs.process.rss",
    kind: "ObservableGauge",
    unit: "By",
    labels: [],
    description: "Resident set size of the Node.js process in bytes",
    source: "packages/observability",
  },
  {
    name: "nodejs.process.memory.external",
    kind: "ObservableGauge",
    unit: "By",
    labels: [],
    description: "Memory used by C++ objects bound to JavaScript objects in bytes",
    source: "packages/observability",
  },
  {
    name: "nodejs.process.memory.array_buffers",
    kind: "ObservableGauge",
    unit: "By",
    labels: [],
    description: "Memory allocated for ArrayBuffers and SharedArrayBuffers in bytes",
    source: "packages/observability",
  },
  {
    name: "nodejs.process.cpu.user",
    kind: "ObservableCounter",
    unit: "us",
    labels: [],
    description: "Total user-mode CPU time consumed by the process in microseconds",
    source: "packages/observability",
  },
  {
    name: "nodejs.process.cpu.system",
    kind: "ObservableCounter",
    unit: "us",
    labels: [],
    description: "Total kernel-mode CPU time consumed by the process in microseconds",
    source: "packages/observability",
  },
  {
    name: "nodejs.process.uptime",
    kind: "ObservableGauge",
    unit: "s",
    labels: [],
    description: "Number of seconds the Node.js process has been running",
    source: "packages/observability",
  },
  {
    name: "nodejs.eventloop.delay.min",
    kind: "ObservableGauge",
    unit: "ns",
    labels: [],
    description: "Minimum recorded event loop delay in nanoseconds",
    source: "packages/observability",
  },
  {
    name: "nodejs.eventloop.delay.max",
    kind: "ObservableGauge",
    unit: "ns",
    labels: [],
    description: "Maximum recorded event loop delay in nanoseconds",
    source: "packages/observability",
  },
  {
    name: "nodejs.eventloop.delay.mean",
    kind: "ObservableGauge",
    unit: "ns",
    labels: [],
    description: "Mean recorded event loop delay in nanoseconds",
    source: "packages/observability",
  },
  {
    name: "nodejs.eventloop.delay.p99",
    kind: "ObservableGauge",
    unit: "ns",
    labels: [],
    description: "99th percentile event loop delay in nanoseconds",
    watch: "Above ~100 ms: something blocks the event loop \u2014 every request waits for it.",
    source: "packages/observability",
  },
  {
    name: "nodejs.gc.duration",
    kind: "Histogram",
    unit: "ms",
    labels: ["gc_type"],
    description: "Garbage collection duration in milliseconds",
    source: "packages/observability",
  },
  {
    name: "nodejs.active_handles",
    kind: "ObservableGauge",
    labels: [],
    description: "Number of active libuv handles",
    source: "packages/observability",
  },
  {
    name: "nodejs.active_requests",
    kind: "ObservableGauge",
    labels: [],
    description: "Number of active libuv requests",
    source: "packages/observability",
  },
  {
    name: "nodejs.version_info",
    kind: "ObservableGauge",
    labels: ["major", "minor", "patch"],
    description: "Node.js version metadata (value always 1)",
    source: "packages/observability",
  },
  {
    name: "outbox.pending",
    kind: "ObservableGauge",
    unit: "{message}",
    labels: [],
    description: "Outbox rows not yet published to Kafka.",
    watch:
      "Growing: the relay is not publishing \u2014 Kafka down or slow (see kafka.client.brokers.up, the relay's warn logs).",
    source: "packages/outbox",
  },
  {
    name: "outbox.dead",
    kind: "ObservableGauge",
    unit: "{message}",
    labels: [],
    description: "Outbox rows that failed OUTBOX_MAX_ATTEMPTS times and are no longer sent.",
    watch:
      "> 0: events that will never be published (non-retryable send errors). The rows' last_error says why; fix the cause, then reset attempts or delete the rows.",
    source: "packages/outbox",
  },
  {
    name: "http.client.request.duration",
    kind: "Histogram",
    unit: "ms",
    labels: ["outbound_target", "http.request.method"],
    description: "Duration of outbound HTTP requests in ms",
    source: "packages/resilient-client",
  },
  {
    name: "http.client.requests.total",
    kind: "Counter",
    labels: ["outbound_target", "http.request.method", "http.response.status_code", "error.type"],
    description: "Total outbound HTTP requests by target, method, status, and error type",
    source: "packages/resilient-client",
  },
  {
    name: "http.client.active_requests",
    kind: "UpDownCounter",
    unit: "{request}",
    labels: ["outbound_target"],
    description: "Number of outbound HTTP requests currently in flight",
    source: "packages/resilient-client",
  },
  {
    name: "http.client.circuit_breaker_state",
    kind: "ObservableGauge",
    labels: ["outbound_target"],
    description: "Circuit breaker state per target: 0=closed, 0.5=half-open, 1=open",
    watch: "1 (open): calls to that dependency fail fast; it was failing. 0.5 = probing.",
    source: "packages/resilient-client",
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
