import "@typespec/http";

using TypeSpec.Http;

namespace Tasks;

/**
 * Body of GET /health — the public-side liveness of the API process.
 * Kubernetes probes target the admin listener (/healthz, /readyz on
 * ADMIN_PORT), not this route; it exists so a client can tell the API is up.
 */
model HealthStatus {
  /** Always "ok" — the process answered. */
  status: "ok";
  /** Service name (OTEL_SERVICE_NAME; "app" when unset). */
  service: string;
  /** NODE_ENV of the process ("development" when unset). */
  env: string;
  /** Whole seconds since the process started. */
  @minValue(0)
  uptimeSeconds: int32;
  /** Time of the answer, RFC 3339 UTC. */
  timestamp: utcDateTime;
}

@route("/health")
interface HealthOps {
  /** Report that the API process is up. */
  @get
  health(): HealthStatus;
}
