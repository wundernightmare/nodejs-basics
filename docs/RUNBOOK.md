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
`/admin/config`, `/admin/log-level`, `/debug/heapdump`. Mutations need
`Authorization: Bearer $ADMIN_TOKEN`.

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
- **`outbox.pending` growing** — Kafka is down or slow: `kafka.client.brokers.up`,
  the relay's warn logs. Nothing is lost; it drains when Kafka is back.
- **`kafka.client.consumer.lag.max` growing** — the worker falls behind or one
  message keeps failing (its warn logs repeat the same offset). Scale the
  worker or fix the handler; a message that can never succeed must be skipped
  in code, not by moving offsets by hand.
- **`db.client.connection.pending_requests` > 0 for minutes** — the Postgres
  pool is exhausted: slow queries (`pg_stat_activity` by `application_name`)
  or `DATABASE_POOL_MAX` too small for the load.
- **`http.client.circuit_breaker_state` = 1** — a dependency failed enough to
  be cut off; calls fail fast until a probe succeeds. Look at the dependency.
- **`nodejs.eventloop.delay.p99` high, or memory near the limit** — take a heap
  snapshot before the pod is killed: `curl -X POST :9090/debug/heapdump -H
  "Authorization: Bearer $ADMIN_TOKEN"` (written to the pod, or to S3 when
  `HEAP_SNAPSHOT_S3_BUCKET` is set); open it in Chrome DevTools → Memory.

## Rotating a secret

A changed Secret is a rolling restart (Stakater Reloader or a Secret checksum
annotation); `*_PASSWORD_FILE` is read once at startup.
