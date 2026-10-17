# nodejs-basics

A cloneable NestJS + Fastify monorepo template — production-shaped scaffolding
for any new service. Bring your own domain.

## What's in the box

```
apps/
  api/                   Reference NestJS app wiring everything together. Writes a
                         task.created event to the outbox with each new task.
                         (+ distroless Dockerfile)
  worker/                Kafka consumer worker: drains tasks.events, enqueues a
                         job (BullMQ or pg-boss), processes it. (+ distroless Dockerfile)
  migrate/               Forward-only SQL migration runner: one self-contained
                         bundle + migrations/, a 156 MB image with no node_modules.

migrations/              The schema: 0001_init.sql, … (applied by apps/migrate).

e2e/                     Playwright API e2e (health, tasks CRUD, Kafka→BullMQ flow).
benchmarks/              k6 load test for the tasks API.

packages/
  resilient-client       undici + opossum + bottleneck HTTP client.
  config                 YAML config loader + env registry + secret-file watcher.
  logger                 Pino with ECS schema, OTel trace correlation, ALS context.
  common                 Request-context (ALS), nanoid, problem-details, UoW port,
                         RFC 9457 exception filters.
  resilience             Circuit breaker, retry policy with jittered backoff,
                         per-tenant DB rate limiter.
  database               pg.Pool with TLS, multi-host failover, password from a
                         mounted file, circuit breaker, AsyncLocalStorage
                         transaction context, pool + query metrics. (No ORM —
                         bring your own.)
  cache                  Valkey/Redis client with config builder shared with
                         BullMQ, client connection metrics.
  kafka                  Confluent Kafka producer (reconnecting, one error
                         type: KafkaSendError) + KafkaConsumerRunner (commit,
                         pause/backoff, tracing — you write handle()) +
                         librdkafka config builder + record and client metrics.
  outbox                 Transactional outbox: OutboxWriter (inside the UoW
                         transaction) + OutboxRelay (→ Kafka, at least once).
  jobs                   JobQueue port + BullMQ (Valkey) / pg-boss (Postgres)
                         adapters, traced and measured alike; BullBoard wiring.
  idempotency            Idempotency-Key interceptor + decorator with pluggable
                         KV store (default: Valkey).
  observability          OpenTelemetry SDK setup, process/HTTP/readiness metrics,
                         admin server (/metrics, /livez, /readyz, /admin/*).
```

## Quick start

Needs [mise](https://mise.jdx.dev), [just](https://just.systems) and Docker (or
Podman) — everything else is pinned in the repo.

```sh
just bootstrap                     # toolchain, pnpm, deps, hooks, config.yaml, deps + schema
just dev                           # apps/api on :3000, admin :9091 — rebuilds + restarts on every save
just dev-worker                    # apps/worker, admin :9093 (another terminal)
```

Then:

- `curl http://localhost:3000` — main API
- `curl http://localhost:9091/metrics` — Prometheus metrics
- `curl http://localhost:9091/readyz` — readiness probe
- `curl http://localhost:9091/version` — service, version, revision, start time / uptime (`/admin/info` is an alias)
- `curl http://localhost:9091/admin/config` — the effective config, secrets redacted
- `curl -X PUT -H "Authorization: Bearer $ADMIN_TOKEN" 'http://localhost:9091/admin/log-level?level=debug&ttl=30m'` — change
  log level live
- `curl -X POST -o api.cpuprofile 'http://localhost:9091/debug/cpu-profile?seconds=10'` — a CPU profile
  (Chrome DevTools → Performance → Load profile)

The admin ports are the ones `just stack-up` publishes too (9091 api, 9093
worker; `ADMIN_PORT` overrides), so both apps run side by side, 9090 stays free
(Prometheus; Cockpit on Fedora), and Prometheus finds them either way.
The admin listener binds `ADMIN_HOST` (every interface by default) and then
needs `ADMIN_TOKEN` — without one the app refuses to start unless the host is
loopback or `ADMIN_INSECURE=true`, which `just dev` and `docker/stack.yml` set
(never in production).

Optional observability stack:

```sh
just obs                           # Jaeger :16686, Prometheus :9090, Grafana :3001
```

### The whole thing in containers (api + worker)

```sh
just stack-up                      # build + run deps + api + worker images
curl -XPOST localhost:3000/tasks -H 'content-type: application/json' -d '{"title":"hi"}'
curl -s localhost:9093/metrics | grep job_runs_total   # the worker ran the job
just stack-down
```

The distroless images build the whole pnpm workspace and ship it on
`gcr.io/distroless/nodejs24-debian13` (non-root). The native
`@confluentinc/kafka-javascript` addon links only libstdc++/glibc (librdkafka is
bundled), which the distroless base provides.

### Tests, e2e, load, security

```sh
just test                          # unit layer (vitest project `unit`)
just deps && just test-integration # integration layer against real Postgres / Valkey / Redpanda
just stack-up && just e2e          # Playwright API e2e against the production images
just cov-all                       # all three layers → one merged coverage number, gated
just allure-report                 # one HTML report from every layer's allure-results/
just bench-tasks smoke             # k6 load test (needs the stack up)
just setup-sec                     # one-time: install the AppSec toolchain (mise)
just sec                           # expired waivers + gitleaks + semgrep + osv-scanner + hadolint
just docker-build api              # build an image; docker-scan-ci api → grype --fail-on high
```

See [Tests](#tests) for the layers, the harness and the coverage / Allure flow,
[Contracts](#contracts) for the TypeSpec → OpenAPI → types pipeline.

## Build & watch

Packages are compiled by `tsc` (they ship `dist/` with declarations); the
apps are bundled by **Vite** — one ESM file per app, `apps/<app>/dist/main.js`
(+ source map), from [`vite.app.config.ts`](vite.app.config.ts):

- `@base/*` is bundled **from `src/`** (the `source` export condition, the
  same one vitest and the tests use), so an app build needs no package build
  and a watch picks up a change anywhere in the workspace. Every other bare
  import stays external — native addons and OpenTelemetry's module patching
  need the real modules on disk.
- Imports a bundled package makes (`@opentelemetry/api` from
  `@base/observability`, `pg` from `@base/database`, …) are resolved at build
  time from that package's own `node_modules` and emitted as paths relative to
  `dist/`: pnpm's strict layout would not let the app resolve them, and each
  package keeps declaring exactly what it imports. The resolution follows
  Node's (`node` / `import` / `default` conditions, `main` field), so a package
  imported both bare by the app and by path from a bundle is one module
  instance.
- NestJS needs legacy decorators with `emitDecoratorMetadata`; Vite's oxc
  transform does not emit it, so the transform is SWC (`unplugin-swc`). There
  is no Nest CLI.

```sh
pnpm build                         # every package (tsc) + every app (vite)
just dev                           # api: vite build --watch + restart after each build (scripts/dev.mjs)
just dev-worker                    # the same for the worker
just build-watch api               # rebuild only, no process
just test-watch                    # vitest, unit project — re-runs what a change touches
just test-watch-integration        # vitest, integration project (needs `just deps`)
```

`scripts/dev.mjs` restarts the app **after** Vite reports a successful build
(SIGTERM → the app's graceful shutdown → spawn), never on a file event, so a
half-written bundle is never started and a save with a syntax error keeps the
last good build running. `pnpm start:debug` passes `--inspect` to the app
process. The Docker images run the same bundle (`CMD ["dist/main.js"]`).

## Renaming `@base` to your org

```sh
# rg + sd are the fastest combo. Falls back to grep + sed.
sd '@base/' '@yourorg/' $(rg -l '@base/')
sd '"@base/' '"@yourorg/' $(rg -l '@base/')
sd '"name": "@base/' '"name": "@yourorg/' packages/*/package.json apps/*/package.json
pnpm install
```

Verify:

```sh
pnpm typecheck
pnpm lint
```

## Design notes

### Layering

```
apps/api  →  @base/* packages  →  third-party (NestJS, OTel, Fastify, ...)
```

`apps/api` is yours to edit; `packages/*` are framework code you'll occasionally
upgrade. The split matters because `apps/api/src/main.ts` and `app.module.ts`
are the only files that need bespoke wiring per project.

### Configuration and telemetry must be first

`apps/api/src/instrumentation.ts` calls `setupTelemetry()` and is imported as
the very first line of `main.ts`; its own first import (`boot.ts`) sets the
app's default `OTEL_SERVICE_NAME` (`nodejs-basics-api` /
`nodejs-basics-worker`) and loads the configuration, before any other module
is evaluated. Don't move either: ESM runs every import before `main()`, and
@base/logger (`LOG_LEVEL`, `NODE_ENV`), the heap-snapshot service and
`createApp()` read `process.env` while loading — a value they read before the
loader is a `config.yaml` line that silently does nothing.
`env.registry.spec.ts` pins the order. Which instrumentations work in the
bundle: see "How spans are made" below.

### Config priority

```
process.env  >  YAML structured (database.url)  >  YAML flat (DATABASE_URL)  >  defaults
```

Defined once in `packages/config/src/env.registry.ts`. Every config knob your
app reads must be added there — `env.registry.spec.ts` scans the runtime
sources and fails on a key read through `config.get`, a typed reader or
`process.env` that is not registered (only a registered key has a YAML path and
shows up in `GET /admin/config`). An entry has a `type` (`int`, `number`,
`bool`, `duration`, `json`, `enum`; `string` when omitted) and, for numbers,
`min` / `max`. At startup the loader fails with **one error listing every
problem** (exit 78, a single ECS line):

```
Invalid configuration (config.yaml):
  - unknown key databse.url — did you mean database.url?
  - KAFKA_PRODUCER_LINGER_MS="10ms": expected an integer (yaml: kafka.producer.linger_ms)
  - OUTBOX_BATCH_SIZE="-5": expected an integer >= 1 (yaml: outbox.batch_size)
```

— a YAML key no entry has, a value (from YAML or the environment) that does
not parse as its type, a missing `required` key. An empty value (`KEY=`) is
unset. Code reads values with the same rules and the registry's default —
the only one: `readInt(config, "KEY")` (also `readNumber`, `readBool`,
`readJson`, `readString`, from `@base/config`) is a `number` for a key with a
default, `number | undefined` for one without, and the key is checked by the
compiler; garbage throws naming the key, never a silent fallback.

The app answers the questions of whoever runs it without starting (the
operator's side of all this is in [docs/RUNBOOK.md](docs/RUNBOOK.md)):

```
node dist/main.js --config-reference   # every setting: env key, YAML path, type, default, description
node dist/main.js --metrics-reference  # every metric: instrument, unit, labels, meaning, when to worry
node dist/main.js --check-config       # validate env + config.yaml: exit 0, or 78 with every problem
node dist/main.js --help
```

`--check-config` against a deployment's rendered environment and
`config.yaml` (e.g. `docker run --env-file … IMAGE --check-config`) catches a
bad value before the rollout instead of on the first pod. Telemetry keys (`OTEL_*`,
`SENTRY_DSN`, `PYROSCOPE_SERVER_ADDRESS`) are environment-only, under the
names the OpenTelemetry SDKs use.

No profiles, layered files or hot reload, on purpose: one file per deployment
(a ConfigMap) plus environment overrides is all a container needs, and a
changed value means a rollout — a restart is the reload that every component
honours. Secrets too: `*_PASSWORD_FILE` is read once at startup, a rotated
Secret is a rolling restart (Stakater Reloader, or a Secret checksum in the
pod annotations). Zero-downtime password rotation alternates two database
roles; the runtime-only tweaks (log level, per-request debug) are admin
endpoints.

### Domain errors → HTTP

Subclass `DomainError` (`@base/common`) for every domain-level error your use
cases throw. Wire the class → status mapping in `apps/api/src/main.ts`'s
`ERROR_MAP`. The global filter formats every response as RFC 9457
`application/problem+json`. Never throw `HttpException` outside of HTTP
controllers/guards.

### Transactions

`@base/common` exposes `IUnitOfWork` and `UNIT_OF_WORK`; `@base/database`
implements it for pg (`PgUnitOfWork`) and exposes `currentTransaction()` — the
ambient transaction's client, `undefined` outside one. The pattern your
repositories follow (see `apps/api/src/modules/tasks`):

```ts
private db(): PoolClient | Pool {
  return currentTransaction<PoolClient>() ?? this.pool;
}
```

Three rules the code enforces, each covered by an integration test:

- **No silent rollbacks.** A statement that fails aborts the whole Postgres
  transaction; COMMIT then rolls back *without an error*. `runInTransaction`
  (and `commit()` for hand-rolled transactions) rejects with
  `TransactionAbortedError` instead of reporting writes that never happened —
  so catching a DB error inside a transaction and carrying on is a bug.
- **A nested call joins the outer transaction** (no savepoint): its failure is
  the outer one's failure.
- **Nothing outlives the transaction.** Work scheduled inside it (a timer, an
  un-awaited promise) that runs after COMMIT gets `TransactionEndedError`
  from `currentTransaction()` instead of a client already handed to another
  request. Await everything inside.

`OutboxWriter.add()` refuses to run outside a transaction
(`OutboxOutsideTransactionError`): the event must commit with its change.

For another ORM, implement `IUnitOfWork` the same way — run `fn` inside
`transactionStorage.run({ client: tx, open: true }, fn)` and set `open =
false` when the transaction ends — and check that the commit committed.

### Limits and deadlines

Every api request has a budget, `HTTP_REQUEST_TIMEOUT_MS` (10 s): receiving
the request is bounded by it, and so is every dependency call made while
handling it — the deadline lives in AsyncLocalStorage (`@base/common`
`withDeadline` / `remainingMs` / `callBudgetMs`) and each client takes what
is left of it:

| Dependency                                  | How the budget applies                                                                                                                                                                         |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Postgres                                    | nothing is sent once it is spent (a `ROLLBACK` always is); a unit of work sets `SET LOCAL statement_timeout` to the rest, so the **server** cancels a statement that would outlive the request |
| Valkey                                      | rejected unsent once spent; the request stops waiting when it runs out                                                                                                                         |
| HTTP (`resilient-client`, `getRemainingMs`) | each attempt is aborted at the deadline and sends `x-request-timeout-ms` downstream; spent → `deadline_exceeded`, never retried                                                                |

A spent budget surfaces as `DeadlineExceededError` → **504** problem. A
caller can ask for less with `x-request-timeout-ms` (never more), which is
also how a budget crosses services — but not below `HTTP_REQUEST_TIMEOUT_MIN_MS`
(1 s; 0 = no floor), so no client can make 504s on demand and drive the 5xx
rate the alerts watch. Bodies over `HTTP_BODY_LIMIT_BYTES`
(1 MiB) are a **413** problem. Both statuses are in the contract. Rate
limiting is left to the gateway / ingress in front of the service.

On SIGTERM `/readyz` turns 503 first, the api keeps serving for
`HTTP_SHUTDOWN_DELAY_MS` (2 s — the time a load balancer needs to stop
routing; 0 in tests and `just dev`), then stops accepting and drains, and the
admin listener closes last.

### Outbox

An event that must not be lost is written in the same transaction as the
state change it announces, then published by a background relay:

```ts
await uow.runInTransaction(async () => {
  const task = await repo.create(...);
  await outbox.add({ topic: TASK_EVENTS_TOPIC, key: task.id, value: event });
});
```

`OutboxWriter` inserts into `outbox` through the ambient
transaction client, with the request's trace context and request id.
`OutboxRelay` (every `OUTBOX_POLL_INTERVAL_MS`, 200 ms) takes up to
`OUTBOX_BATCH_SIZE` rows `FOR UPDATE SKIP LOCKED` — every replica can run one —
sends them and deletes them in that transaction. A failed send is judged by
the `@base/kafka` error registry (`KAFKA_SEND_ERRORS`): a retryable one
(broker down, queue full, topic not provisioned yet) leaves the row for a
later pass (backoff to 30 s) and is never counted; a `rejected` record (too
large, invalid) makes it a poison row — `attempts`/`last_error`, and after `OUTBOX_MAX_ATTEMPTS` (10) it stays in the
table instead of being retried forever. Delivery is at least once, so consumers
are idempotent (the worker's BullMQ `jobId` is the task id). The relay sends
each record in the trace of the request that wrote it, so the trace still
reads request → Kafka → worker. Alert on `outbox_oldest_age_seconds`
(Grafana: "Outbox oldest event age", `OutboxStuck`) and on any `outbox_dead`. Shutdown waits up to 5 s for a batch in
flight.

### Kafka

One engine for every client: **librdkafka**, through
`@confluentinc/kafka-javascript` and its kafkajs-compatible API (`@base/kafka`).
`kafka-config.builder.ts` turns the `KAFKA_*` keys into raw librdkafka
properties (the names in librdkafka's `CONFIGURATION.md`, so a platform team's
settings map one to one). Kafka is on when `KAFKA_BROKERS` is set; the worker
requires it.

#### Keys, properties, defaults

Every key is also a YAML path (`--config-reference` prints both).

| Key | librdkafka property | Default | Why the default is safe |
|---|---|---|---|
| `KAFKA_BROKERS` | `metadata.broker.list` | — (off) | presence switches Kafka on; no localhost fallback |
| `KAFKA_CLIENT_ID` | `client.id` (+ `-producer` / `-consumer-<group>`) | `OTEL_SERVICE_NAME` | each client is told apart in broker metrics and quotas |
| `KAFKA_SECURITY_PROTOCOL` | `security.protocol` | librdkafka: `plaintext` | set per environment; see "TLS and SASL" |
| `KAFKA_SASL_MECHANISM` / `_USERNAME` / `_PASSWORD` / `_PASSWORD_FILE` | `sasl.mechanism` / `sasl.username` / `sasl.password` | — | the file (a mounted Secret) wins and is read once |
| `KAFKA_SSL_CA_LOCATION` / `KAFKA_SSL_CA_PEM` | `ssl.ca.location` | system trust store | a private CA as a file, or inline PEM written to `/tmp/kafka-ca.pem` |
| `KAFKA_SSL_ENDPOINT_IDENTIFICATION_ALGORITHM` | `ssl.endpoint.identification.algorithm` | librdkafka: `https` | the broker's hostname is verified against its certificate |
| `KAFKA_REQUEST_TIMEOUT_MS` | `socket.timeout.ms` | librdkafka: 60000 | — |
| `KAFKA_METADATA_MAX_AGE_MS` | `topic.metadata.refresh.interval.ms` | librdkafka: 300000 | — |
| `KAFKA_RECONNECT_BACKOFF_MS` / `_MAX_MS` | `reconnect.backoff.ms` / `.max.ms` | 100 / 10000 | librdkafka's own, exponential, jittered; set explicitly — the kafkajs-compat layer would put its 300 / 30000 here |
| — | `socket.keepalive.enable` | `true` | NATs and load balancers drop idle connections silently |
| `KAFKA_STATISTICS_INTERVAL_MS` | `statistics.interval.ms` | 15000 | feeds the client metrics; 0 turns them off |
| `KAFKA_MESSAGE_MAX_BYTES` | `message.max.bytes` | 1000000 | under the broker's 1 MiB `max.message.bytes`: too big fails locally as `rejected` |
| `KAFKA_PRODUCER_ACKS` | `acks` | `all` | a record is acknowledged once every in-sync replica has it |
| `KAFKA_PRODUCER_ENABLE_IDEMPOTENCE` | `enable.idempotence` | `true` | retries never duplicate or reorder within a partition |
| `KAFKA_PRODUCER_COMPRESSION_TYPE` | `compression.type` | `lz4` | cheapest codec in CPU and latency; see "Compression" |
| `KAFKA_PRODUCER_LINGER_MS` | `linger.ms` | 5 | small batches (better compression) for at most 5 ms of latency |
| — | `retries` | 5 | re-sends of a failed produce request (the compat layer's default, kept when its `retry.retries` goes to 0 — see "Connecting") |
| `KAFKA_PRODUCER_MESSAGE_TIMEOUT_MS` | `message.timeout.ms` | 30000 | librdkafka retries within it, then send() fails `unavailable` |
| `KAFKA_PRODUCER_QUEUE_MAX_KBYTES` | `queue.buffering.max.kbytes` | 65536 | 64 MiB instead of librdkafka's 1 GiB; see "Memory" |
| `KAFKA_PRODUCER_QUEUE_MAX_MESSAGES` | `queue.buffering.max.messages` | 100000 | the count bound next to the byte bound |
| `KAFKA_CONSUMER_AUTO_OFFSET_RESET` | `auto.offset.reset` | `earliest` | a new group reads the retained backlog instead of skipping it |
| `KAFKA_CONSUMER_ENABLE_AUTO_COMMIT` | `enable.auto.commit` | `false` | the runner commits after `handle()`; see "Commits" |
| `KAFKA_CONSUMER_ASSIGNMENT_STRATEGY` | `partition.assignment.strategy` | `cooperative-sticky` | incremental rebalances; see "Rebalance" |
| `KAFKA_CONSUMER_SESSION_TIMEOUT_MS` | `session.timeout.ms` | 45000 | the Kafka default: a GC pause or node hiccup does not trigger a rebalance; a clean shutdown leaves the group at once |
| `KAFKA_CONSUMER_MAX_POLL_INTERVAL_MS` | `max.poll.interval.ms` | 300000 | the longest one `handle()` may take before the partition moves; at least the session timeout (librdkafka refuses less — checked at boot) |
| `KAFKA_CONSUMER_QUEUE_MAX_KBYTES` | `queued.max.messages.kbytes` | 4096 | 4 MiB of prefetch instead of 64 MiB |
| — | `queued.min.messages` | 1000 | prefetch target in messages instead of 100000 |
| `KAFKA_CONSUMER_FETCH_MAX_BYTES` | `fetch.max.bytes` (`receive.message.max.bytes` = +512) | 4194304 | one fetch response ≤ 4 MiB instead of 50 MB |
| `KAFKA_CONSUMER_PARTITION_FETCH_MAX_BYTES` | `max.partition.fetch.bytes` (+ its alias `fetch.message.max.bytes`, which the compat layer would otherwise set to 10 MiB) | 1048576 | one hot partition cannot fill a whole fetch |
| — | `allow.auto.create.topics` | `true` | the client may ask; the broker decides (see "Topics") |
| `KAFKA_CONSUMER_PARTITIONS_CONCURRENTLY` | kafkajs-compat `partitionsConsumedConcurrently` | 1 | order holds per partition at any value |
| `KAFKA_CONSUMER_MAX_RETRIES` | — (runner) | 5 | then the message is parked; see "Commits" |
| `KAFKA_DEAD_LETTER_TOPIC` | — (runner) | `{topic}.dlq` | `none` keeps a failing message on its partition |
| `KAFKA_EXTRA_PROPERTIES` / `KAFKA_PRODUCER_` / `KAFKA_CONSUMER_EXTRA_PROPERTIES` | anything else | — | applied last; see "Extra properties" |

The loader checks the sizes against each other at start (exit 78):
`fetch_max_bytes` ≥ `message_max_bytes`, `partition_fetch_max_bytes` ≤
`fetch_max_bytes`.

#### Connecting

Neither the producer nor the consumer waits for the broker at start: each
connects in the background and retries with its own backoff (1 s → 30 s,
`reconnect.ts`), with a fresh client per attempt. Every client is created
with `retry.retries: 0` in its `kafkaJS` block, so one `connect()` is one
attempt, bounded by the connection-setup timeout (~12 s). Since
kafka-javascript 1.11 the compat `connect()` would otherwise retry by itself
(5 times, 300 ms → 30 s — ~80 s against a dead broker before the first
"failed to connect" warning, and a retry loop that outlives the shutdown).
The same setting drives the producer's message `retries`, which the builder
sets back to 5. Shutdown never waits for a connect in flight.

#### Memory: what librdkafka buffers

librdkafka's defaults are sized for throughput on a dedicated host — a 1 GiB
producer queue, 64 MiB of prefetch, 50 MB fetches. In a pod with a memory
limit that is an OOM kill waiting for the first broker outage or backlog.
Every size is therefore an explicit key, always set by the builder, and none
can be set from an escape hatch.

- **Producer.** send() puts a record on the local queue; librdkafka batches it
  per partition, compresses the batch and keeps it until the broker
  acknowledges it (or `message.timeout.ms` passes). Records in the queue and
  in flight count against `queue.buffering.max.kbytes` and
  `queue.buffering.max.messages` — whichever is hit first makes send() fail
  with `queue_full` (waited out for up to `waitMs`, then back-pressure for the
  caller; the outbox keeps the rows). Worst case ≈
  `QUEUE_MAX_KBYTES` + brokers × in-flight requests (≤ 5 with idempotence) ×
  `MESSAGE_MAX_BYTES` of compressed copies ≈ 64 MiB + 3 × 5 × 1 MB ≈ 80 MB
  for three brokers.
- **Consumer.** librdkafka prefetches into one local queue for all assigned
  partitions until it holds `queued.min.messages` or
  `queued.max.messages.kbytes`; each broker connection has at most one fetch
  in flight, ≤ `fetch.max.bytes` (≤ `max.partition.fetch.bytes` per
  partition). The kafkajs-compat layer then moves batches of ≤ 32 messages
  per worker into the JS heap (about 1.5 s of consumption). Worst case ≈
  `CONSUMER_QUEUE_MAX_KBYTES` + brokers × `FETCH_MAX_BYTES` + the JS batch ≈
  4 MiB + 3 × 4 MiB ≈ 16 MB for three brokers. A consumer that handles one
  message at a time gains nothing from more; raise them for throughput, with
  the pod's memory limit.

Watch `kafka_producer_queue_bytes` against
`kafka_producer_queue_max_bytes`.

#### Compression

`lz4` by default: the cheapest codec in CPU and latency, at a ratio close to
the others for JSON events. `zstd` when bandwidth or broker disk is the
constraint (best ratio, more CPU); `none` for payloads that are already
compressed. A batch is compressed as a whole, so the ratio grows with the
batch: `linger.ms` (5 ms) lets a few records share one; a producer that sends
one record at a time compresses little whatever the codec. The broker keeps
the producer's codec unless the topic's `compression.type` says otherwise.

#### Delivery guarantees

`acks=all` + `enable.idempotence=true`: a record is acknowledged once every
in-sync replica has it, and librdkafka's retries can neither duplicate nor
reorder it within a partition (it limits itself to ≤ 5 requests in flight).
Pair it with the topic's `min.insync.replicas=2` (broker side) or `all` means
"the one replica left". Retries are librdkafka's, within
`message.timeout.ms`; after that send() fails with a `KafkaSendError` whose
`kind` (`KAFKA_SEND_ERRORS` in `kafka-errors.ts`) says whether the same record
can succeed later — only `rejected` (too large, invalid, refused by a broker
policy) cannot. Events that must not be lost go through the outbox
("Outbox"): written in the business transaction, sent at least once.

#### Rebalance

`cooperative-sticky` by default: when a member joins or leaves, only the
partitions that change owner stop; the rest keep being consumed. The eager
strategies (`roundrobin`, which the kafkajs-compat layer would pick, and
`range`) stop the whole group on every deploy. A group runs one protocol —
switching an existing group between cooperative and eager takes stopping all
its members, or a new `group.id`; a mixed group fails to rebalance. **Upgrading
from a release that ran the compat default (`roundrobin`)** is such a switch:
roll it out with the `Recreate` strategy (or a new `group.id`). A rolling
update stalls safely — the worker is ready only once the group has handed it
an assignment (`assertRunning()`), so the refused new pods never turn ready
and the rollout stops with the old pods still consuming; see RUNBOOK "A pod is
not ready". A member
is evicted after `session.timeout.ms` (45 s) without a heartbeat, or when one
`handle()` runs longer than `max.poll.interval.ms` (5 min) — its partitions
then go to another member, which handles the message again.

#### Commits, retries and the dead-letter topic

`KafkaConsumerRunner` commits a message — explicitly, offset + 1 — once
`handle()` resolves, so nothing handled waits uncommitted: a revoked
partition hands over at most the message in flight, which the new owner
handles again (at least once; handlers are idempotent — the worker's job id is
the event id). A handler that throws gets its partition paused and the message
again after a backoff (1 s → 60 s); after `KAFKA_CONSUMER_MAX_RETRIES` (5)
retries the message goes to the dead-letter topic `KAFKA_DEAD_LETTER_TOPIC`
(`{topic}.dlq` — key, value and headers as consumed, plus `dlq_reason`,
`dlq_error`, `dlq_source_topic` / `_partition` / `_offset`, `dlq_attempts`)
and is committed, so one poison message costs its retries, not the
partition. The handler says what retrying cannot fix — `KafkaPermanentError`
(the worker: not JSON, breaks the contract) is parked at once — and what is
not the message's fault: `KafkaBackpressureError` (the job queue is full or
down) is waited out and never parked. Until the dead-letter topic exists, or
with `none`, the message keeps its partition. Alert on
`kafka_consumer_records_total{result="dead_lettered"}` (log: `kafka.dead_lettered`); replay a fixed
batch by producing the dead-letter topic back to its source.

#### TLS and SASL with your own CA

`SASL_SSL` + `SCRAM-SHA-512`, the CA and the password as files mounted from
a Secret — [`examples/kafka-sasl-ssl/`](examples/kafka-sasl-ssl/) has the
certificates script, a local broker that accepts nothing else
(`just kafka-sasl-ssl-up`), a Kubernetes ConfigMap + Secret, and an
integration test that produces and consumes through it. mTLS (a client
certificate) goes through `KAFKA_EXTRA_PROPERTIES`:
`ssl.certificate.location` / `ssl.key.location`.

#### Extra properties

`KAFKA_EXTRA_PROPERTIES` (every client), then
`KAFKA_PRODUCER_EXTRA_PROPERTIES` or `KAFKA_CONSUMER_EXTRA_PROPERTIES`, are
applied last: any librdkafka property — a JSON object in env, a mapping in
YAML (`kafka.consumer.extra_properties`). Use them for what has no key
(`debug`, `fetch.wait.max.ms`, `batch.size`, mTLS files). The properties a key
owns are refused at start (exit 78, naming the key): the sizes above
(`message.max.bytes`, `queue.buffering.max.kbytes` / `.messages`,
`queued.max.messages.kbytes`, `fetch.max.bytes`, `receive.message.max.bytes`,
`max.partition.fetch.bytes` / `fetch.message.max.bytes`) and
`partition.assignment.strategy` — one place per setting. They may carry
credentials: `/admin/config` redacts them whole, and a config error never
repeats their text.

#### Topics

Topics are the broker's policy, not the app's: the app never creates or
configures them (partitions, retention, `min.insync.replicas`). The client
may ask (`allow.auto.create.topics`, and the runner asks for its topics
before subscribing — otherwise a consumer would notice a new topic only at
the next 5-minute metadata refresh); a dev broker creates them
(`docker/deps.yml`), a provisioned cluster refuses — then a send fails
`not_provisioned` (retryable: it goes through once the topic exists). The
dead-letter topics are provisioned like any other.

#### Observability

- Metrics: what the app does with records — `kafka_producer_records_total`
  / `kafka_producer_send_duration_seconds` (`send()`, the dead-letter sends
  included) and `kafka_consumer_records_total{result}` /
  `kafka_consumer_handler_duration_seconds`, `kafka_consumer_rebalances_total`,
  `kafka_consumer_assigned_partitions`, `kafka_consumer_commit_errors_total`
  (the runner) — and what only the client sees, from librdkafka's statistics
  (`kafkaClientMetrics`, `statistics.interval.ms`): `kafka_client_brokers_up`,
  `kafka_client_request_errors_total`, `kafka_producer_queue_bytes` /
  `_max_bytes`. The `topic` label is a topic named in the code or the
  subscription (a regex match counts as `other`); no partition label.
  Consumer lag is not exported by the apps: it is the broker's number
  (Redpanda `redpanda_kafka_consumer_group_lag_sum{redpanda_group}` with
  `enable_consumer_group_metrics`, docker/deps.yml; kafka-exporter or Burrow
  on Kafka) — one series per group, there even when every consumer is down.
- Traces: `send()` makes a producer span and puts `traceparent` in the record
  headers; the runner continues it in a `process` span, so a request, its
  outbox row, the record and the worker's job are one trace.
- Logs: librdkafka's go through `kafkaLogger`, repeats folded for 60 s
  (`kafka.log.suppressed`); `debug` in `KAFKA_EXTRA_PROPERTIES` turns on its
  debug contexts (`{"debug":"broker,protocol"}`).
- What to do about each signal: [docs/RUNBOOK.md](docs/RUNBOOK.md).

### Migrations

The schema lives in `migrations/*.sql` — plain SQL, one file per change,
`<version>_<name>.sql`, forward-only (a rollback is a new migration).
`apps/migrate` applies what is pending, each file in a transaction with its
row in `schema_migrations` (`-- migrate: no-transaction` on the first line
for `CREATE INDEX CONCURRENTLY`), under an advisory lock so replicas and CI
jobs can race safely, and refuses to run when an applied file was edited.
A unit test (`apps/migrate/src/migrations-safety.spec.ts`) flags DDL that
breaks the release still running or locks a busy table — DROP/RENAME COLUMN,
DROP TABLE, SET NOT NULL, a type change without USING, CREATE INDEX without
CONCURRENTLY on an existing table — unless the file carries
`-- migration-safety: reviewed`; a no-transaction file must be one statement.

```sh
just deps                      # compose up + just migrate
just migrate                   # after adding a file
docker run --rm -e DATABASE_URL=… nodejs-basics-migrate:dev   # the image
node apps/migrate/dist/main.js --check-config                 # --help, --config-reference
```

It is configured like the apps (`@base/config`: env > config.yaml > the
registry, a bad value exits 78) and reads `DATABASE_URL`,
`DATABASE_PASSWORD_FILE`, `DATABASE_SSL_MODE` and `DATABASE_APPLICATION_NAME`;
its log lines carry the apps' envelope.

Everything that needs a schema goes through it: `docker/stack.yml` (the api
waits for the `migrate` service to exit 0 — how a Kubernetes Job / init
container would run it), the integration layer (vitest `globalSetup`), the
e2e spawn harness and `just schemathesis`. The apps never create tables.
The image is small on purpose: Vite bundles the runner _with_ `pg`
(`nodeApp(…, { selfContained: true })`), so it is distroless Node + one
`.js` + the SQL files, no `node_modules` (156 MB vs 722 MB for the api).
An ORM's migrator (Prisma, Drizzle, Kysely) replaces it cleanly — keep the
image and the compose / CI wiring, swap the command.

### Hexagonal layout per domain (recommended)

```
modules/<domain>/
  domain/             entities, errors, repository ports, const enums
  application/        use cases (commands), query services (reads)
  infrastructure/     repository implementations, external service adapters
  http/               controllers, DTOs, route guards
```

- Use cases throw domain errors; the `DomainExceptionFilter` maps to HTTP.
- Reads (queries) bypass domain entities — go directly through your ORM
  with `JOIN`/`include`. No N+1.
- Writes (commands) wrap the entire read-then-write sequence in
  `runInTransaction()` to be TOCTOU-safe.
- External calls (email, third-party APIs) happen **after** the
  transaction commits — capture data inside the tx, fire side effects after.

### Idempotency

Decorate any mutating endpoint with `@Idempotent()` and clients can safely
retry by sending an `Idempotency-Key` header. The interceptor caches the
response in Valkey (in Postgres when the api runs without it, below).
Lock-on-conflict semantics prevent the same key from being processed twice
concurrently.

### Optional integrations

Postgres is the api's core. Valkey and Kafka are on when their address is
set (`VALKEY_URL`, `KAFKA_BROKERS`), so the api runs with `DATABASE_URL`
alone. To get that locally, drop the `cache:` and `kafka:` blocks from
`apps/api/config.yaml`.

| Unset | What runs instead |
|---|---|
| `VALKEY_URL` | `Idempotency-Key` results in the `idempotency_keys` table |
| `KAFKA_BROKERS` | no relay: events wait in the `outbox` table for a process that has one |
| `VALKEY_URL` (worker) | its jobs run on pg-boss in Postgres (below) |

The rules, for adding a module of your own (`@base/config` integrations.ts):

- **The address is the switch.** There is no `*_ENABLED` flag that could
  disagree with it.
- **Decided once, at startup, in one place.** `app.module.ts` imports a
  module only when its integration is on (`integrationEnabled()`), and binds
  the port to the real adapter or the substitute. An integration that is off
  is never connected to and has no readiness check. Nothing is registered
  only to throw when called.
- **Never half-configured.** Another variable of the group set without the
  address fails the start with exit 78, e.g. `VALKEY_PASSWORD` without
  `VALKEY_URL` (a typo, a Secret without its ConfigMap). So does an
  integration the app cannot do without: the worker declares
  `requires: ["kafka"]` in `boot.ts`.
- **Visible.** Each process logs `integrations.resolved` at startup and
  exports `app_integration_enabled{integration}`; alert on a 0 in production.
- **A feature that cannot be substituted** (a payment provider) is a module
  whose routes are absent when it is off (404), not routes that answer 500.

### Jobs: BullMQ or pg-boss

The worker's code depends on `JobQueue` (`@base/jobs`): `send(data, key)`
(once per key), `work(handler)`, `waiting()`. `JobsModule.forQueues` puts
BullMQ behind it when `VALKEY_URL` is set, pg-boss on the app's Postgres
otherwise. Both pass the same contract test (`job-queue.integration.spec.ts`).

| | BullMQ (Valkey) | pg-boss (Postgres) |
|---|---|---|
| Extra infrastructure | Valkey, persistent (AOF) for jobs that must survive | none: the database you already run |
| Enqueue in the business transaction | no; use the outbox | possible: same database, one commit |
| Latency, throughput | ms, tens of thousands of jobs/s | polling (1 s here, or LISTEN/NOTIFY), hundreds to thousands/s; every job is rows and WAL |
| Load on the database | none | job writes, autovacuum on `pgboss.job` |
| Features | rate limits, priorities, flows, repeatable jobs, BullBoard UI | priorities, cron, throttling, dead-letter queues, no UI here |
| Schema | none | pg-boss owns the `pgboss` schema and migrates it on start; the one schema not in `migrations/` |
| Observability here | `job_runs_total` / `job_duration_seconds`, spans | the same; `waiting()` is a `count(*)` |

Pick pg-boss when jobs are modest and one less moving part matters. Pick
BullMQ for volume, low latency, or its rate limiting and flows.

### Logging

Always use the merge-object form — never interpolate values into the message:

```ts
this.logger.info({ "task.id": task.id }, "Task archived");
```

`http.request.id`, `trace.id`, `span.id` are auto-injected from ALS / the
active span by the pino mixin in `@base/logger`. Don't pass them explicitly.

What is a contract and what is not:

- **The envelope** — `@timestamp`, `log.level`, `message`, `ecs.version`,
  `service.name` / `.version` / `.environment`, `process.pid`,
  `host.hostname` (the pod), and when present `trace.id`, `http.request.id`,
  `error.*` — is in [`docs/log-envelope.schema.json`](docs/log-envelope.schema.json).
  A log pipeline parses it and an incident search relies on it; a unit test
  checks the logger's lines against it, and the e2e suite (spawn mode) every
  line the running api and worker write.
- **Events for machines** — the few lines a log-based alert, SIEM rule or
  audit query matches on — carry `event.action`, catalogued in
  `@base/logger/log-events` with their fields (`--log-events-reference`);
  `log-events.spec.ts` keeps the catalog and the code in step.
- **Everything else** is for people: the message and extra fields change
  freely.

A field of the envelope or an event is added freely; renaming or removing one
takes a release with both. `service.version` is the build's (`SERVICE_VERSION`,
baked into the image like `GIT_COMMIT`); traces carry the same identity plus
`service.instance.id` and the semantic-conventions schema URL.

## Patterns NOT included (build per project)

- **Auth (JWT, OAuth, MFA, PATs)** — strongly project-specific.
- **AuthZ (OPA, Casbin, role matrices)** — project-specific.
- **Tenant model** — your User/Tenant/Membership schema.
- **Prisma / Drizzle / Kysely** — `@base/database` exposes `PG_POOL`. Hand it
  to your ORM's adapter and you're done. See README's "Transactions" for the
  UnitOfWork pattern.

## Local dependencies (`docker/deps.yml`)

| Service     | Image                           | Port |
| ----------- | ------------------------------- | ---- |
| Postgres 18 | `postgres:18`                   | 5432 |
| Valkey 9    | `valkey/valkey:9.0`             | 6379 |
| Redpanda    | `redpandadata/redpanda:v26.2.3` | 9092 |

Default credentials: `app` / `app` for postgres. **Change before deploying.**

## Observability stack (`docker/observability.yml`)

| Service        | Image                                          | Port  |
| -------------- | ---------------------------------------------- | ----- |
| Jaeger v2      | `jaegertracing/jaeger:2.21.0`                  | 16686 |
| Prometheus     | `prom/prometheus:v3.15.0`                      | 9090  |
| Grafana        | `grafana/grafana:12.4.12`                      | 3001  |
| OTel Collector | `otel/opentelemetry-collector-contrib:0.162.0` | 4317  |

Images are pulled through `${DOCKER_HUB}` (default `docker.io`, see
`.env.example`), like everything else in the repo.

Bring up only when you want traces/metrics locally. The apps export without
it — Prometheus is just unscraped, traces are dropped.

- **Metrics**: Prometheus scrapes the admin `/metrics` of the api (host 9091)
  and the worker (host 9093) — the same ports under `just dev` and
  `just stack-up` — and the broker's `/public_metrics`, and evaluates
  `docker/prometheus/rules.yml`. What each metric is:
  [Metrics](#metrics) below; the dashboards: [Dashboards](#dashboards).
- **Back-pressure**: `KafkaProducerService.send()` fails only with a
  `KafkaSendError` — `kind` + `retryable` from the `KAFKA_SEND_ERRORS`
  registry (JSDoc lists each kind and what to do). It waits out a full local
  queue or a reconnect for up to 5 s itself, so a caller that "just sends"
  needs no retry code. The worker pauses its partitions while the BullMQ queue
  holds `WORKER_QUEUE_MAX_WAITING` (10 000) jobs, so a slow processor leaves
  the backlog in Kafka instead of filling Valkey.
- **librdkafka logs** are pino/ECS lines (`log.logger: kafka:*`,
  `kafka.log.facility`, `kafka.client.name`); identical lines are folded
  for 60 s (`kafka.log.suppressed` on the next one), so a broker outage logs
  a line a minute per client instead of ~20 a second.
- **Traces**: one trace per request, across both apps —
  `POST /tasks` → Valkey (idempotency) → Postgres (`BEGIN` / `INSERT` /
  `COMMIT`) → `send tasks.events` → worker `process tasks.events` →
  `send task-events` → `process task-events`. Every log line carries the
  `trace.id` of the span it was written in.

### Metrics

One contract with golang-basics: the same names, labels and units, so one
set of alerts and dashboards reads either repo. `--metrics-reference` prints
the whole list (`METRIC_REGISTRY`, @base/observability — the spec keeps it
equal to the code; e2e checks that every name the rules and the dashboard
read is on a live `/metrics`).

| Area | Metrics |
| --- | --- |
| HTTP in | `http_requests_total{method,route,status}`, `http_request_duration_seconds{method,route}`, `http_requests_in_flight`, `http_unhandled_errors_total` |
| HTTP out (ResilientPool) | `http_client_requests_total{target,method,outcome}`, `http_client_request_duration_seconds{target,method}`, `http_client_retries_total{target}`, `http_client_circuit_breaker_state{target}` |
| Postgres | `db_pool_connections{pool,state}`, `db_pool_max_connections{pool}`, `db_pool_pending_acquires{pool}`, `db_query_duration_seconds{pool,operation}`, `db_query_errors_total{pool,operation}` |
| Kafka | `kafka_producer_records_total{client,topic,result}`, `kafka_producer_send_duration_seconds{client,topic}`, `kafka_consumer_records_total{topic,result}`, `kafka_consumer_handler_duration_seconds{topic}`, `kafka_consumer_commit_errors_total`, `kafka_consumer_rebalances_total{event}`, `kafka_consumer_assigned_partitions`, `kafka_client_brokers_up{client}`, `kafka_client_request_errors_total{client}`, `kafka_producer_queue_bytes`, `kafka_producer_queue_max_bytes` |
| Outbox | `outbox_pending`, `outbox_dead`, `outbox_oldest_age_seconds` |
| Jobs | `job_runs_total{queue,result}`, `job_duration_seconds{queue}` |
| Valkey | `valkey_client_connected`, `valkey_client_errors_total`, `valkey_client_reconnects_total` |
| Readiness, build | `health_check_up{check,critical}`, `app_integration_enabled{integration}`, `build_info{version,revision}` |
| Process | `process_cpu_{user,system}_seconds_total`, `process_resident_memory_bytes`, `process_start_time_seconds`, `process_open_fds`, `process_max_fds` (Linux), `nodejs_heap_{used,total,limit}_bytes`, `nodejs_external_memory_bytes`, `nodejs_eventloop_delay_seconds{quantile}`, `nodejs_eventloop_utilization`, `nodejs_gc_duration_seconds{kind}`, `nodejs_version_info` |

The rules behind it:

- **Base units in the name** (`_seconds`, `_bytes`, counters `_total`). The
  OTel instruments carry the Prometheus name itself: the exporter appends no
  unit, and `setupTelemetry` turns off its `otel_scope_*` labels and
  `target_info` — the scrape adds `service` and `instance`.
- **Bounded labels only**: a route template (`unmatched` for a 404/405), a
  standard method or `_OTHER`, a status code (499: the client left), a
  configured target or pool, a topic named in the code or the subscription
  (else `other`), an operation named with `withDbOperation()` (else the
  statement's keyword). Never an id, a URL, a key or an error message.
- **Not in the app what the server measures better**: consumer-group lag
  (the broker: `redpanda_kafka_consumer_group_lag_sum{redpanda_group}`),
  server-side Postgres / Valkey state (their exporters), job queue depth
  (Valkey / `pgboss.job`). Library instrumentations are kept for their
  spans; their metrics are dropped (undici would add a second, host-labelled
  `http_client_*`).
- **Nothing twice**: no count that another metric already gives (the
  worker's events are `kafka_consumer_records_total`, its jobs
  `job_runs_total`; dead-lettered records are a `result`).

### Dashboards

Two provisioned dashboards (`docker/grafana/dashboards/`, the same layout as
golang-basics'), linked to each other, with `$datasource`, `$service` and
`$instance` variables:

- **`nodejs-basics`** (overview, the Grafana home): RED by service
  (requests/s, 5xx and 4xx ratio, p50/p95/p99) → HTTP by route (rate, p95,
  errors by status + unhandled, in-flight) → client-side dependencies (DB pool
  saturation and waits, query p95 and errors by operation, Valkey client) →
  Kafka & outbox (records by client/topic/result, send and handle p95,
  consumer-group lag from the broker, outbox oldest age, pending, dead) → jobs
  (runs by result, p95) → health & build (targets up, readiness checks,
  running versions).
- **`nodejs-basics — runtime`** (reference): process CPU user/system, RSS,
  open fds / limit, uptime and restarts; event loop delay and utilization,
  heap used / limit, external memory, time in GC and GC rate by kind, Node.js
  versions — per instance.

The rules they follow (`dashboards.spec.ts` in @base/observability enforces
them, and e2e checks the names on a live `/metrics`): every app query is
scoped by `service=~"$service", instance=~"$instance"` (never a `job`), every
window is `$__rate_interval` (`$__range` for "in range" stats), aggregation
only by bounded labels (per instance only on the runtime dashboard), ratios
never divide by zero, and the threshold lines are the alerts' thresholds.
No exemplars: the OTel Prometheus exporter does not emit them, so the
latency panels cannot link to a trace; find the trace from the logs
(`trace.id` on every line) or in Jaeger by route.

### How spans are made

The apps ship as one Vite bundle, and every module it imports is loaded
before `instrumentation.ts` runs — so OTel instrumentations that patch a
module when it is first loaded (`instrumentation-pg`, `-nestjs-core`,
`-aws-sdk`, `-ioredis`, …) never fire. What does work, and what the repo uses:

| Source        | How                                                                                                   |
| ------------- | ----------------------------------------------------------------------------------------------------- |
| inbound HTTP  | `@fastify/otel` plugin (`apps/api/src/instrumentation.ts`), span `{method} {route}`                   |
| outbound HTTP | `UndiciInstrumentation` (diagnostics_channel, no patching)                                            |
| Postgres      | `@base/database` `tracePgPool` — wraps the pool it builds                                             |
| Valkey        | `@base/cache` `traceValkeyClient` — wraps the shared client                                           |
| Kafka         | `@base/kafka` `KafkaProducerService.send` / `traceKafkaMessage` — `traceparent` in the record headers |
| BullMQ        | `@base/jobs` `addTraced` / `traceJob` — context in the job's `opts.telemetry.metadata`                |

DB / cache spans are only made under an active span (no root trace per
readiness probe); query text is the parameterised statement and Valkey
arguments are never recorded. Adding a client of your own: wrap it the same
way, or use an instrumentation that does not rely on patching. Tests assert on
spans with `captureSpans()` from `@base/testing`.

## Tests

Every test in the workspace is an Allure test, every layer feeds one merged
coverage number, and every behaviour is checked at exactly one layer — the
same contract as the Go sibling. The harness that makes that cheap is
[`packages/testing`](packages/testing) (`@base/testing`, test-only).

### Layers and what each one owns

| Layer           | Where                                                                                                                                                                   | Owns                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Does not repeat                                                                                       |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| **Unit**        | `*.spec.ts` next to the code — vitest project `unit`, `just test`                                                                                                       | pure logic: config builders, backoff, the resilient client against a mock agent, redaction, the runtime log level, the admin router over an in-process `node:http` server                                                                                                                                                                                                                                                                                                               | anything that needs a real dependency                                                                 |
| **Property**    | `*.prop.spec.ts` next to the code ([fast-check](https://fast-check.dev)) — part of `just test` (100 cases per property), `just fuzz` for the deep run (5000)            | the invariants of the pure parsers and calculators over generated input, where a unit test says "for this one" and a property says "for all": the back-off never leaves its window, `redact()` lets no secret or URL password through and is idempotent, durations round-trip and reject everything else with the documented error, a request id is exactly 1–128 printable ASCII, `metricValue` reads back what an exporter writes, a problem body always carries its standard members | the example-based cases already in the unit spec                                                      |
| **Mutation**    | `packages/resilient-client` — `just mutate` (StrykerJS, [`stryker.config.mjs`](stryker.config.mjs)), the nightly `mutation` CI job                                      | whether the unit tests of the pure decision logic would notice a wrong comparison, operator or branch                                                                                                                                                                                                                                                                                                                                                                                   | —                                                                                                     |
| **Integration** | `*.integration.spec.ts` — vitest project `integration`, `just test-integration`                                                                                         | the libs against real Postgres / Valkey / Redpanda from `docker/deps.yml`: the unit of work commits and rolls back as one, the Valkey option bag connects and BullMQ's blocking poll outlives the command timeout                                                                                                                                                                                                                                                                       | route behaviour already proven with fakes; process-level behaviour                                    |
| **E2E**         | [`e2e/`](e2e) (Playwright, API tests) — `just e2e` (production images) / `just e2e-spawn` (built processes)                                                             | what only a real process shows: it boots, is ready on its admin listener, is a scrape target, and the cross-process flow api → Kafka → worker → BullMQ                                                                                                                                                                                                                                                                                                                                  | per-route behaviour, error bodies (unit), the libs' semantics (integration)                           |
| **Smoke**       | the `@smoke` titles in `e2e/` — `just e2e-smoke`, the `e2e-stack` CI job                                                                                                | the distroless images start and serve                                                                                                                                                                                                                                                                                                                                                                                                                                                   | everything else                                                                                       |
| **Contract**    | `apps/api/src/app.contract.integration.spec.ts` (integration project; `createApp` + fastify `inject`, every exchange validated with `loadOpenAPI` from `@base/testing`) | the running app honours [`api/tsp`](api/tsp): every route, every declared status, problem bodies, 404/405 routing                                                                                                                                                                                                                                                                                                                                                                       | inputs the schema can generate (generative)                                                           |
| **Generative**  | `just schemathesis` (Schemathesis against the built api and its OpenAPI document)                                                                                       | inputs nobody wrote a test for: every operation with generated positive and negative requests and stateful sequences, no 5xx, every response in the contract's shape — "bad input → 4xx problem" cases are owned here, not hand-written                                                                                                                                                                                                                                                 | business semantics the schema cannot express (unit / contract), effects on dependencies (integration) |
| **Load**        | [`benchmarks/`](benchmarks) (k6)                                                                                                                                        | latency / error thresholds under load; reports on the load stand, outside Allure                                                                                                                                                                                                                                                                                                                                                                                                        | —                                                                                                     |

When you add a behaviour, put its test at the lowest layer that can observe
it, and only there. If a higher layer needs it as a precondition, it waits for
it (the e2e harness waits for `/readyz`), it does not assert it again.

### Harness: `@base/testing`

- `meta({ epic, feature, owner, tags })` at the top of a `describe` labels
  every test in it; `await testCase("NB-101", "story")` inside a test binds it
  to its TestOps case (Allure id, story, TMS link). Sample values — see
  [TestOps metadata](#testops-metadata).
- `integration("postgres", "valkey")` is the layer switch: it reads the same
  env the app reads (`DATABASE_URL`, `VALKEY_URL`, `KAFKA_BROKERS`), **skips**
  the suite locally when a service is unset (`describe.skipIf(infra.skip)`)
  and **fails** it when `CI` is set, so a pipeline can never go green by
  silently skipping the layer. No container orchestration in the test process,
  no extra dependency: `just deps` locally, the deps compose in CI. Suites
  isolate through `unique("prefix")` names, never a fresh service.
- `captureLogs()` (a real pino logger writing JSON into memory) and
  `metricValue(text, name, labels)` (a sample out of Prometheus text; `-1`
  when absent) let a test assert on telemetry instead of mocking it.
- `loadOpenAPI("openapi3/tasks.openapi.yaml").validate(method, path, status,
body, headers)` throws unless the exchange is in the contract (operation
  matched by path template, status declared, content type declared, required
  headers present, body conforms — ajv, OpenAPI 3.0 `nullable` translated);
  `validateSchema("Problem", body)` checks a body against a named component.
  The Node twin of the Go sibling's `testx.LoadOpenAPI`.

Specs import `describe` / `it` / `expect` from `vitest` explicitly (no
globals). The root [`vitest.config.ts`](vitest.config.ts) is the one config:
two projects, `resolve.conditions: ["source"]` so `@base/*` resolves to
`src/` without a build, allure-vitest for every run.

### Allure

vitest (allure-vitest) and Playwright (allure-playwright) write to
`allure-results/`, or to `ALLURE_RESULTS_DIR` — CI points every job at one
directory and publishes the raw results (for an Allure server / TestOps) plus a
single-file HTML report (`allure-report` job; locally `just allure-report`,
`allure-commandline` from the root `package.json`, JRE pinned in `mise.toml`).
`scripts/allure-meta.sh` adds [`allure/categories.json`](allure/categories.json)
(how failures are bucketed: product defect / test defect / infrastructure /
flaky / skipped) and an `executor.json` (which CI run, linked) before the
report is generated. Tags name the package and the layer (`cache`,
`integration`, `e2e`), so the report can be sliced by either.

### TestOps metadata

Every suite carries an epic / feature / owner, every test an id and a story;
the id becomes a TMS link through the `links.tms.urlTemplate` in the vitest
and Playwright configs. The values in this repo are **samples** —
`nodejs-basics`, `@team-platform`, `NB-<n>`, `*.example.internal` — whose
shape is the point; replace them with your TestOps tree. One rule survives
the replacement: an id appears in exactly one test, and a test without an id
is not in the test plan.

### Coverage: one number, three layers

[`scripts/cover.mjs`](scripts/cover.mjs) collects each layer as an istanbul
`coverage-final.json`: vitest writes it directly (v8 provider), and for the e2e
layer the harness spawns the built api + worker under `NODE_V8_COVERAGE`
(`E2E_SPAWN=1`), waits for them to exit on SIGTERM (that is when Node flushes
the counters) and `scripts/v8-to-istanbul.mjs` (ast-v8-to-istanbul, the
converter vitest itself uses) maps the bundles' raw V8 ranges back to `src/**`
through their source maps — c8 was tried first and silently dropped every
_uncovered_ range of a bundle. `merge` unions the layers **per line**: the
executable lines of every file are what vitest reports (it lists every
included file, covered or not; the e2e layer only contributes hits), and a
line is covered when any layer hit it. Nothing is counted twice; it writes
`coverage-merged.lcov` + a per-package `coverage-breakdown.json`, and gates on
[`scripts/cover.config.mjs`](scripts/cover.config.mjs). `just cov-check`
gates whatever is under `.cover/`; `just cov-all` is the only entry point that
guarantees all three layers. Both pipelines do the same: the test jobs upload
`.cover/<layer>`, the `coverage` job merges, gates and prints the per-layer and
merged totals.

Two gates, both on the merged profile: the absolute total (and per-package
overrides) in `cover.config.mjs`, and **no regression** — the `coverage` job
keeps master's per-package breakdown (a cache on GitHub, the master pipeline's
artifact on GitLab) and a pull request is compared to it with
`--diff-threshold 0`. Old code's coverage cannot pay for new code's. The
thresholds are a ratchet: raise them when coverage improves, lower only with a
reason in the commit.

### Contracts

The HTTP API and the Kafka events are written once, in
[TypeSpec](https://typespec.io) under [`api/tsp`](api/tsp) (TypeSpec 1.16 —
the same toolchain as the Go sibling), and everything else is generated from
it:

```
api/tsp/*.tsp ─tsp compile─▶ api/openapi3/tasks.openapi.yaml ─openapi-typescript─▶ packages/contracts/src/tasksapi.gen.ts
              └────────────▶ api/jsonschema/*.json ─────────(same, via a 3.1 wrapper)─▶ packages/contracts/src/events.gen.ts
```

The events (`api/tsp/events.tsp`, `@jsonSchema`) become one JSON Schema per
event — the artefact another service, in any language, builds its consumer
from — and a TypeScript type in `@base/contracts` (`TaskCreatedEvent`, plus
`TASK_EVENTS_TOPIC`) that the api writes into the outbox and the worker reads,
so the two sides cannot drift. Evolve an event additively: new fields
optional, never remove or retype one.

The same types give a **typed client**: `createTasksClient({ baseUrl })`
(`@base/contracts`, openapi-fetch over the generated `paths`) — a path, a
parameter or a body that is not in the contract does not compile, and each
response is typed by its status. The e2e suite drives the api with it. Inside
a service, give it `resilientFetch(new ResilientClient(baseUrl, {
passthrough4xx: true, getRequestId, getRemainingMs: remainingMs }))` as its
`fetch`: retries, breaker, the request id and the request budget come along.

`just contracts` (`pnpm contracts`) regenerates all of it; the outputs are
committed, so a reviewer sees the contract diff next to the code diff.
`just contracts-check` (the `contracts` CI job) fails when the committed
outputs are stale and, on a pull request, when `oasdiff` finds a breaking
change against master's OpenAPI document. A change that is breaking by the
rules but safe in practice is waived in
[`api/oasdiff-breaking.ignore`](api/oasdiff-breaking.ignore), one line per
change with the reason and the removal trigger — the same discipline as the
CVE waivers.

The document says what is true of the app, member for member: every object is
closed (`seal-object-schemas` — the zod DTOs are `.strict()`), text carries
the `^[^\u0000]*$` pattern (PostgreSQL TEXT rejects a NUL byte; lengths count
code points, as JSON Schema does), ids are 21-character nanoids,
`Idempotency-Key` is a UUID, and every error — validation, domain, routing
(404 unknown path, 405 undeclared method with `Allow`), the unplanned 500 — is
an RFC 9457 `Problem` with `errorId`, `instance` and `request_id`. The
generated types are the wire types for a client; the app's own request DTOs
stay zod (runtime validation), mirrored on the contract and held to it by the
two layers below.

Tests enforce it: the contract layer
([`apps/api/src/app.contract.integration.spec.ts`](apps/api/src/app.contract.integration.spec.ts))
boots the real app (`createApp` in `apps/api/src/app.ts`, the wiring
`main.ts` listens with) against the real deps, drives it with fastify
`inject` and validates every exchange with `loadOpenAPI(...).validate`; the
generative layer (below) does the same with requests it derives from the
document. A handler that drifts from the contract fails its own test.

### Schemathesis

[Schemathesis](https://schemathesis.io) is the generative layer: it reads the
OpenAPI document and drives the _real process_ (`apps/api/dist`, scratch ports
18300/19300) with requests it derives from the schema — boundary values,
invalid bodies, unknown members, undeclared methods, stateful
create → read → update → archive chains over the links it infers — checking
that nothing answers 5xx, that valid data is accepted and invalid data
rejected, and that every response's status, headers and body are in the
contract.

```sh
just deps && just schemathesis          # SKIP_BUILD=1 reuses dist/, SCHEMATHESIS_MAX_EXAMPLES=… tunes depth
```

It runs from its pinned image (`SCHEMATHESIS_VERSION` in `mise.toml`,
`DOCKER_HUB` for a closed network; the script adapts to rootless podman and
SELinux hosts), reports natively to Allure next to every other layer, and is a
job in both pipelines (`schemathesis`, in the gate). Its first run found that
an undeclared method got a 404 instead of a 405, that `POST /tasks/{id}/archive`
answered 201 (NestJS's POST default) for a document that says 200, that an
over-long id was a 414, that the bodies were strict while the document was
open, that unknown query parameters were silently ignored, and that a reused
`Idempotency-Key` replayed the first 201 for _any_ payload (even none) — the
interceptor now binds the key to a request fingerprint and answers a
different request under the same key with a 409 problem. The app and the
document agree on all of it. With it in place, hand-written
"bad input → 4xx" tests are not needed — the schema and the generator own
that class of case.

`api/schemathesis.toml` makes every Schemathesis warning fail the run, except
two on `/tasks/{id}…`, where they describe the contract rather than a gap:
generated ids name no task (404) and generated versions are never the current
one (409) — server-assigned ids and optimistic locking. The happy paths come
from the stateful phase, which chains `POST /tasks` into those operations
through the links it infers (all 9 covered). Pinning a seeded id instead would
silence the warnings too, but it overrides those links and tests less.

### Property-based testing

Everything that parses or computes from input it does not control has a
property spec next to it — `*.prop.spec.ts`, [fast-check](https://fast-check.dev):
`computeJitteredDelay` (`@base/resilient-client`), `redact` / `redactUrl` and
`parseDuration` / `formatDuration` (`@base/logger`), `isValidRequestId` and
`problemDetail` (`@base/common`), `metricValue` (`@base/testing`). They are
unit tests: `pnpm test` runs each property with 100 generated cases
(`propertyRuns()` in `@base/testing`); `just fuzz` / `pnpm fuzz` is the deep
run with `FC_NUM_RUNS=5000` — the Node analogue of the Go sibling's
`just fuzz` / `FUZZTIME` — and the nightly `fuzz` CI job. A failing property
prints its shrunk counterexample and seed (`{ seed, path }`); pin the
counterexample as an `examples:` entry of that property so it stays a
regression case, the way the Go sibling commits `testdata/fuzz/` corpora. The
first run found four: `computeJitteredDelay` returned `NaN` for
`minTimeout: 0` once `factor^attempt` overflowed (0 · ∞); `parseDuration`
accepted a number too long for a double as `Infinity` and returned `0` for
`"0.0001"`; `redact()` turned an own `"__proto__"` key (what `JSON.parse`
produces) into the copy's prototype and dropped it; `metricValue` could not
read a label value containing `}` (a route template) or an escaped newline.
All fixed; each spec carries the case.

### Mutation testing

Coverage says a line ran; mutation testing says a test would notice if it
were wrong. [StrykerJS](https://stryker-mutator.io) mutates the code (flips a
comparison, an operator, a branch, empties a literal), re-runs the specs that
cover the mutated line (`coverageAnalysis: perTest`) and reports every mutant
that _survived_. It is worth its cost on small, pure, decision-heavy code and
noise elsewhere, so — like the Go sibling — it is scoped, not global:
[`stryker.config.mjs`](stryker.config.mjs) mutates `packages/resilient-client`
only (backoff, cache, errors, pool, the client; not the OTel wiring).

```sh
just mutate          # pnpm mutate → reports/mutation/mutation.html (+ mutation.json)
```

Score when introduced: 56.8 % (backoff 95, cache 86, errors 88, pool 39,
client 56). `thresholds.break` (50) is a ratchet like the coverage gate: the
run fails below it; raise it as survivors are triaged — a survivor is a
missing assertion or dead code — lower it only with a reason in the commit.
Two things make it run in this workspace: Stryker works **in place**
(`inPlace: true`, the tree is restored on exit, backup under `.stryker-tmp/`)
because pnpm's `node_modules` symlinks and the `source` export condition do
not survive a sandbox copy — so never run it alongside a formatter or another
vitest run; and the root `vitest.config.ts` drops Allure and the integration
project when `STRYKER_MUTATOR_WORKER` is set. CI runs it nightly and on
demand (`mutation` job), never per PR: 20 s on a 32-core box, minutes on a
2-core runner.

### Flakiness policy

No retries anywhere (`retries: 0` in Playwright, `retry: 0` in vitest). A
test that fails once in a while is reported by Allure as what it is; mark it
flaky with a ticket, fix it, or delete it — never hide it behind a re-run.

## Security tooling

AppSec tools are pinned in `mise.toml` and installed by `just setup-sec`; every
`just sec-*` recipe runs its tool through `mise exec --`, and CI runs the same
versions from pinned container images (see "Pipelines" below).

| Recipe             | Tool        | Config             | Covers                                       |
| ------------------ | ----------- | ------------------ | -------------------------------------------- |
| `just sec-waivers` | sh + awk    | —                  | no `Remove after YYYY-MM-DD` date has passed |
| `just sec-secrets` | gitleaks    | `.gitleaks.toml`   | secrets in tree + history                    |
| `just sec-sast`    | semgrep     | `.semgrepignore`   | `p/owasp-top-ten` + `p/typescript` packs     |
| `just sec-deps`    | osv-scanner | `osv-scanner.toml` | OSV.dev advisories over `pnpm-lock.yaml`     |
| `just sec-iac`     | hadolint    | `.hadolint.yaml`   | every `apps/*/Dockerfile`                    |
| `just sec`         | —           | —                  | all of the above, fail-fast                  |

Container side (against a locally-built image):

```sh
just docker-build api         # build nodejs-basics-api:dev
just docker-scan api          # syft SBOM (sbom-api.json) + grype CVE scan
just docker-scan-ci api       # same, --fail-on high (the CI gate)
just docker-sign reg.example/api@sha256:…    # cosign sign a pushed image (key-mode, no Rekor; COSIGN_PRIVATE_KEY from .env)
just docker-verify reg.example/api@sha256:…  # offline verify against COSIGN_PUBLIC_KEY (cosign.pub)
```

CI builds every `apps/*/Dockerfile`, generates the SBOM (kept 7 days as a job
artifact) and fails on HIGH+; it does not push or sign — that stays a local /
release-time step.

### pnpm supply-chain policy (`pnpm-workspace.yaml`)

| Setting                     | Effect                                                                                    |
| --------------------------- | ----------------------------------------------------------------------------------------- |
| `minimumReleaseAge: 10080`  | a version published < 7 days ago does not resolve (`.npmrc` `min-release-age=7` for npm)  |
| `blockExoticSubdeps`        | transitive deps come from the registry only — no git / tarball URLs                       |
| `trustPolicy: no-downgrade` | a dependency update cannot silently relax these settings                                  |
| `allowBuilds`               | the only postinstall scripts allowed to run (pnpm 11+ fails the install otherwise)        |
| `overrides`                 | caret floors: CVE fixes on transitive deps + one copy of cross-package types              |
| `peerDependencyRules`       | peers declared older than what we run (Sentry / nestjs-zod vs NestJS 12), checked to work |
| `minimumReleaseAgeExclude`  | the escape hatch — time-boxed, with a `Remove after YYYY-MM-DD` line                      |

Waivers that cannot be pinned out go in `osv-scanner.toml` / `.grype.yaml`,
each with the reason and a removal trigger. A dated trigger is written
`Remove after YYYY-MM-DD` anywhere in the repo, and `scripts/check-waivers.sh`
(`just sec-waivers`, part of `just sec`; the CI `sast` job) fails once the date
has passed (`TODAY=2026-12-01 scripts/check-waivers.sh` previews). Both the
appsec workflow (nightly) and the docker workflow (weekly, base images
re-pulled) also run on a schedule — advisories and expiry dates do not need a
commit to arrive.

### Pipelines

`.github/workflows/{appsec,docker}.yml` and the `security` / `docker` stages of
`.gitlab-ci.yml` are kept at parity, and the pipeline itself is part of the
attack surface — the `sast` job scans it too. Rules worth knowing before they
block a change:

- **nothing hard-codes a tool version**: both pipelines start with a `versions`
  job that runs `scripts/mise-pins.sh` (pins out of `mise.toml`, pnpm out of
  `package.json`); GitHub consumes them as job outputs, GitLab as a `dotenv`
  artifact used even inside `image:` (`extends: .pins`);
- **scanners run from version-pinned images** on both sides (gitleaks, semgrep,
  osv-scanner, hadolint, syft, grype) — no marketplace action with its own
  bundled binary, no `curl | sh`, no `:latest`;
- **every `uses:` is pinned to a full commit SHA** with the version as a comment
  (`actions/checkout@3d3c42e5… # v7.0.1`) — a tag can be repointed by the
  action owner; `.github/dependabot.yml` keeps the SHAs current (weekly, 7-day
  cooldown, one grouped PR);
- **`github.*` context never appears inside `run:` text** — it goes through
  `env:` and the script expands the variable (an attacker-controlled branch
  name or PR title in a script is shell injection);
- **`semgrep scan --metrics=off`, never `semgrep ci`**;
- **every upstream host is a variable with the public default**, so a closed
  network sets `DOCKER_HUB` / `GHCR` / `GCR`, `GRYPE_DB_UPDATE_URL`,
  `OSV_SCANNER_FLAGS`, `SEMGREP_CONFIG`, `npm_config_registry` /
  `COREPACK_NPM_REGISTRY` as CI variables (GitLab group/project variables,
  GitHub `vars.*`) and locally in `.env` — [`.env.example`](.env.example)
  documents every knob; `just` (`set dotenv-load`) and mise (`[env] _.file`)
  both load it.

## Scripts

| Command                                | What it does                                                   |
| -------------------------------------- | -------------------------------------------------------------- |
| `pnpm typecheck`                       | tsc --noEmit per package (TypeScript 7, native)                |
| `pnpm lint`                            | oxlint                                                         |
| `pnpm format`                          | oxfmt                                                          |
| `pnpm test`                            | unit layer (vitest project `unit`)                             |
| `pnpm test:integration`                | integration layer (needs `just deps`)                          |
| `just contracts`                       | regenerate `api/openapi3` + `@base/contracts` from `api/tsp`   |
| `just contracts-check [BASE]`          | generated files current + oasdiff breaking-change gate         |
| `just schemathesis`                    | generative layer against the built api (needs `just deps`)     |
| `just cov-all` / `cov-check`           | three-layer coverage, merged + gated                           |
| `just fuzz` / `mutate`                 | property specs with 5000 cases / StrykerJS on resilient-client |
| `just allure-report`                   | one Allure HTML report from every layer                        |
| `just e2e` / `e2e-smoke` / `e2e-spawn` | Playwright vs images / @smoke / spawned processes              |
| `pnpm check`                           | typecheck + lint + format:check                                |
| `just clean`                           | drop build output, coverage, reports (not committed contracts) |
| `pnpm clean`                           | pnpm built-in: remove every `node_modules` (full reinstall)    |
| `just deps`                            | docker compose up postgres/valkey/kafka                        |
| `just obs`                             | docker compose up Jaeger/Prometheus/Grafana                    |
| `just dev` / `dev-worker`              | vite build --watch + restart after each build                  |
| `just build-watch <app>`               | rebuild an app bundle on change, no process                    |
| `just test-watch[-integration]`        | vitest watch, unit / integration project                       |
| `just setup-sec`                       | install the AppSec toolchain (mise)                            |
| `just sec`                             | expired waivers + gitleaks + semgrep + osv-scanner + hadolint  |
| `just docker-build <app>`              | build `nodejs-basics-<app>:dev`                                |
| `just docker-scan[-ci] <app>`          | syft SBOM + grype (`-ci`: fail on HIGH+)                       |
| `just docker-sign\|verify <image>`     | cosign key-mode sign / offline verify of a pushed image         |

## Worktrees (multi-branch dev)

This repo can be cloned as a **bare-repo container** so each branch is a clean
sibling checkout — like the Go/Rust sibling repos. Don't nest worktrees inside a
live checkout, or tooling will scan every branch's `node_modules` / `dist`.

```sh
# one-time container
git clone --bare git@github.com:wundernightmare/nodejs-basics.git nodejs-basics/.bare
cd nodejs-basics && echo 'gitdir: ./.bare' > .git
git --git-dir=.bare config remote.origin.fetch '+refs/heads/*:refs/remotes/origin/*'
git fetch origin
git worktree add master master
cp master/wt ./wt && chmod +x ./wt   # the wt helper lives at the container root

# per branch — the `wt` helper wraps the extra setup:
./wt add feat/x          # worktree + mise trust + pnpm install + link secrets
./wt list
./wt rm  feat/x
```

What `git worktree add` does **not** do, and `wt` does:

- `mise trust` the new worktree (else mise-shimmed tools fail with a misleading
  "error parsing config file");
- `pnpm install` to wire up node_modules + native deps (the global pnpm store
  makes this mostly hardlinks — fast);
- link machine-local secrets/config (`.env*`, `apps/api/config.yaml`) from the
  canonical `master/` worktree.

**Build cache.** pnpm's content-addressable store
(`~/.local/share/pnpm/store`) is global, so install reuse across worktrees is
automatic. **Docker** `docker/deps.yml` is a singleton (fixed project name
`nodejs-basics-deps` + host ports) — run one deps stack and every worktree
reaches it at `localhost:<port>`.

## License

UNLICENSED — replace with your project's license.
