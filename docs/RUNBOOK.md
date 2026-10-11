# Runbook

For whoever runs the api and the worker. The reference lists come from the
binary itself, so they always match the deployed version:

```sh
node dist/main.js --config-reference    # every setting: env key, YAML path, type, default
node dist/main.js --metrics-reference   # every metric: labels, meaning, when to worry
node dist/main.js --log-events-reference # the log lines for alerts and audits (event.action)
node dist/main.js --check-config        # validate this deployment's env + config.yaml (exit 0 / 78)
```

Each pod has an admin listener (port `ADMIN_PORT`, 9090 in a container; keep
it off the ingress): `/livez`, `/readyz`, `/metrics`, `/version`,
`/admin/config`, `/admin/log-level`, `/debug/heapdump`, `/debug/cpu-profile`.
Mutations need `Authorization: Bearer $ADMIN_TOKEN`; a pod without a token
does not start (unless `ADMIN_INSECURE=true` — never in production).

## A pod does not start

It exits with **78** and one log line `"log.level":"fatal"` listing every
configuration problem (unknown key, bad value, missing required). Fix the
values, check them with `--check-config`, roll out again. Any other early exit
is in the same log line's `message`.

## A pod is not ready

`curl :9090/readyz` names the failing check (`db` and `valkey` on the api,
`kafka` and `jobs` on the worker; an integration whose address is unset has
none — the startup line `integrations.resolved` says what a pod runs with):
`503 not_ready` is a critical dependency down — the pod gets no traffic until
it recovers, no restart needed. `degraded` is an optional one.

A worker whose `kafka` check says `consumer has not joined its group yet` for
longer than a rebalance is kept out of its consumer group. The usual cause is
a rollout that changes the assignment strategy (eager `roundrobin` / `range` ↔
`cooperative-sticky`): the broker refuses the new pods while an old one is in
the group — `Inconsistent group protocol` in their logs. Finish it with a
recreate (scale the old release to zero first), or give the new release a new
`group.id` (it starts from `KAFKA_CONSUMER_AUTO_OFFSET_RESET`, `earliest`:
expect the retained backlog again — handlers are idempotent).

## Something is wrong — where to look

Logs are one JSON object per line (envelope: `docs/log-envelope.schema.json`);
`service.version` and `host.hostname` say which build and which pod.

Find the request: every error response carries `errorId` and `request_id`;
both are fields of the matching log line (`error.id`, `http.request.id`), and
the log line carries `trace.id` for the trace in Jaeger.

More detail for a while, without a restart:

```sh
curl -X PUT ':9090/admin/log-level?level=debug&ttl=30m' -H "Authorization: Bearer $ADMIN_TOKEN"
```

It reverts by itself (`LOG_LEVEL_MAX_TTL`). One request only: send it with
`X-Debug-Token: $DEBUG_TOKEN`.

## Signals

What each means is in `--metrics-reference` (`watch:`); what to do:

- **`outbox.dead` > 0** — events that will never be sent. `SELECT topic, key,
  attempts, last_error FROM outbox WHERE attempts >= <OUTBOX_MAX_ATTEMPTS>`;
  fix the cause, then `UPDATE outbox SET attempts = 0 …` to resend or delete
  the rows.
- **504s from the api** — a request ran out of its budget
  (`HTTP_REQUEST_TIMEOUT_MS`, or less when the caller sent
  `x-request-timeout-ms` — never below `HTTP_REQUEST_TIMEOUT_MIN_MS`, so a
  client cannot produce them on purpose): the trace shows which Postgres /
  Valkey / HTTP call took the time.
- **`outbox.pending` growing** — Kafka is down or slow: `kafka.client.brokers.up`,
  the relay's warn logs. Nothing is lost; it drains when Kafka is back.
- **`kafka.client.consumer.lag.max` growing** — the worker falls behind, the
  job queue is down (warn "Downstream unavailable"), or a message keeps failing
  while the dead-letter topic is missing (warn "Could not dead-letter"). Scale
  the worker, fix the dependency, or provision `<topic>.dlq`; never move
  offsets by hand.
- **`kafka.consumer.dead_lettered` > 0** — the worker gave up on messages and
  parked them on `<topic>.dlq` (log `kafka.dead_lettered`: the reason and the
  error; the record's `dlq_*` headers say where it came from). Fix the
  handler, then produce the parked records back to their source topic.
- **`kafka.client.producer.queue.size` near `.limit`, or send() failing
  `queue_full`** — the broker takes records slower than the app makes them
  (or is down). The queue is bounded on purpose (README "Kafka" → "Memory"):
  fix the broker side before raising `KAFKA_PRODUCER_QUEUE_MAX_KBYTES`
  together with the pod's memory limit.
- **`db.client.connection.pending_requests` > 0 for minutes** — the Postgres
  pool is exhausted: slow queries (`pg_stat_activity` by `application_name`)
  or `DATABASE_POOL_MAX` too small for the load.
- **`http.client.circuit_breaker_state` = 1** — a dependency failed enough to
  be cut off; calls fail fast until a probe succeeds. Look at the dependency.
- **`nodejs.eventloop.delay.p99` high, or memory near the limit** — take a heap
  snapshot before the pod is killed: `curl -X POST :9090/debug/heapdump -H
  "Authorization: Bearer $ADMIN_TOKEN"` (written to the pod, or to S3 when
  `HEAP_SNAPSHOT_S3_BUCKET` is set); open it in Chrome DevTools → Memory.
- **CPU high, latency up** — `curl -X POST -o cpu.cpuprofile
  ':9090/debug/cpu-profile?seconds=30' -H "Authorization: Bearer $ADMIN_TOKEN"`
  (1–60 s; open it in Chrome DevTools → Performance, or speedscope).

## Rotating a secret

A changed Secret is a rolling restart (Stakater Reloader or a Secret checksum
annotation); `*_PASSWORD_FILE` is read once at startup.
