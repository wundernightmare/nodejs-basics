# Kafka over SASL_SSL with your own CA

How a service connects to a cluster that wants SCRAM credentials over TLS
signed by a private CA — the usual shape of a managed or platform-run Kafka —
and a local broker to try it against.

| File | What it is |
|---|---|
| `gen-certs.sh` | a CA, the broker's certificate (SAN `localhost`, `redpanda`), a client certificate for mTLS → `certs/` (gitignored) |
| `compose.yml` | Redpanda with one SASL_SSL listener on `localhost:29095`, users `app` / `admin`, ACLs for `app` |
| `configmap.yaml` | the same client settings on Kubernetes: a ConfigMap with the app's `config.yaml`, the password and `ca.crt` from a Secret mounted as files |

```sh
just kafka-sasl-ssl-up                # certificates, broker, users and ACLs
KAFKA_SASL_SSL_BROKERS=localhost:29095 pnpm test:integration kafka-sasl-ssl
just kafka-sasl-ssl-down
```

The client settings — env or `config.yaml`, the same keys
(`--config-reference` lists them all):

```sh
KAFKA_BROKERS=localhost:29095
KAFKA_SECURITY_PROTOCOL=SASL_SSL
KAFKA_SASL_MECHANISM=SCRAM-SHA-512
KAFKA_SASL_USERNAME=app
KAFKA_SASL_PASSWORD_FILE=/etc/kafka-secret/sasl-password   # or KAFKA_SASL_PASSWORD
KAFKA_SSL_CA_LOCATION=examples/kafka-sasl-ssl/certs/ca.crt  # or KAFKA_SSL_CA_PEM (inline)
```

- **Files, not values.** The password and the CA come from a mounted Secret;
  the password file is read once — a new password is a rollout restart.
- **mTLS.** When the broker also asks for a client certificate, pass
  `ssl.certificate.location` / `ssl.key.location` through
  `KAFKA_EXTRA_PROPERTIES` (commented out in `configmap.yaml`); the compose
  broker does not require one (`require_client_auth: false`).
- **Hostname check.** librdkafka verifies the broker's name against its
  certificate (`ssl.endpoint.identification.algorithm=https`, the default):
  the certificate must carry the advertised host names.
- **Any other librdkafka property** goes through `KAFKA_EXTRA_PROPERTIES`
  (every client), `KAFKA_PRODUCER_EXTRA_PROPERTIES`,
  `KAFKA_CONSUMER_EXTRA_PROPERTIES` — a JSON object in env, a mapping in YAML.
  Buffer and message sizes are not among them: they have their own keys and
  are always set (root README, "Kafka client").
- **ACLs.** `app` may do anything on any topic and group here; a real
  cluster scopes it to the service's topics and groups. Idempotent producers
  (the default) also need `IDEMPOTENT_WRITE` on the cluster.
