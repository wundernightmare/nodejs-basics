# @base/config

YAML config loader with an env-var overlay, a central env registry, a snapshot
of the effective configuration for `GET /admin/config`, and typed readers
(`readInt`, `readBool`, …, `readSecretFile` for `*_FILE` secrets).

## Priority

```
process.env  >  YAML structured (database.url)  >  YAML flat (DATABASE_URL)  >  registry default
```

`yamlConfigLoader` (plug into `ConfigModule.forRoot({ load: [yamlConfigLoader] })`)
reads `config.yaml` (or `APP_CONFIG_FILE`) and back-fills `process.env`, applies
registry defaults, then fails fast if a `required: true` key is still missing.

## ENV_REGISTRY

`src/env.registry.ts` is the single list of every variable the application
understands — key, YAML path, default, description, where it is used. Add an
entry for every knob your app reads; the loader validates against it and
`configSnapshot()` reports from it. Runtime-debugging entries (`ADMIN_TOKEN`,
`DEBUG_TOKEN`, `LOG_LEVEL_MAX_TTL`, `GIT_COMMIT`) and the secret-file paths
(`DATABASE_PASSWORD_FILE`, `KAFKA_SASL_PASSWORD_FILE`) are registered there.

## configSnapshot()

The effective configuration after the loader ran: every registered key with the
value the process is running with and where it came from.

```ts
configSnapshot();
// { config:  { PORT: "3000", DATABASE_URL: "postgresql://app:app@…", ADMIN_TOKEN: null },
//   sources: { PORT: "env",  DATABASE_URL: "default",                ADMIN_TOKEN: "unset" } }
```

Values are **raw** — pass it to `ObservabilityModule.forRoot({ configSnapshot })`
and the admin server serves it on `GET /admin/config` through `redact()`
(`@base/logger`), which masks secret-looking keys and URL passwords.
