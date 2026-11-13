import { randomBytes } from "node:crypto";

/**
 * Backing services an integration suite can ask for. Each one is reached
 * through the same env variable the application reads. The integration
 * project's global setup (containers.global-setup.ts) starts a container for
 * every requested service whose variable is unset, so a suite runs the same
 * against `just deps`, a CI service or a throwaway container — and the test
 * process itself orchestrates nothing. "s3" is an S3-compatible store
 * (S3_ENDPOINT; the container's credentials are S3_TEST_CREDENTIALS).
 * "toxiproxy" is the chaos proxy: ask for it next to the service you want to
 * break (see chaos.ts).
 */
export type Service = "postgres" | "valkey" | "kafka" | "s3" | "toxiproxy";

/** The keys of the object store the global setup starts (the Go sibling's, too). */
export const S3_TEST_CREDENTIALS = {
  accessKeyId: "testaccess",
  secretAccessKey: "testsecret-0123456789",
  region: "us-east-1",
} as const;

const ENV: Record<Service, string> = {
  postgres: "DATABASE_URL",
  valkey: "VALKEY_URL",
  kafka: "KAFKA_BROKERS",
  s3: "S3_ENDPOINT",
  toxiproxy: "TOXIPROXY_URL",
};

export interface Integration {
  /** true when at least one requested service is not configured — pass to `describe.skipIf`. */
  skip: boolean;
  /** Why the suite is skipped (empty when it isn't). */
  reason: string;
  /** The connection string / broker list of a requested service. */
  url(service: Service): string;
}

/**
 * The layer switch of the integration suites, with the policy of the Go
 * sibling's `testx.Postgres(t)`: locally, a missing service *skips* the
 * suite (a laptop without a container runtime still runs
 * `pnpm test:integration` green); on CI (`CI` set) a missing service *fails* it, so a pipeline can
 * never go green by silently skipping the layer.
 *
 *   const infra = integration("postgres");
 *   describe.skipIf(infra.skip)("pg pool", () => {
 *     const pool = new Pool({ connectionString: infra.url("postgres") });
 *     …
 *   });
 */
export function integration(...services: Service[]): Integration {
  const missing = services.filter((s) => !process.env[ENV[s]]);
  if (missing.length > 0 && process.env["CI"]) {
    throw new Error(
      `integration suite needs ${missing.map((s) => ENV[s]).join(", ")} on CI (services not provisioned?)`,
    );
  }
  return {
    skip: missing.length > 0,
    reason:
      missing.length > 0
        ? `${missing.map((s) => ENV[s]).join(", ")} unset — no container runtime? (or run \`just deps\`)`
        : "",
    url(service) {
      const v = process.env[ENV[service]];
      if (!v) throw new Error(`${ENV[service]} is unset`);
      return v;
    },
  };
}

/**
 * A unique name for a table, key prefix, topic or group: suites share one
 * service instance and isolate through names, never through a fresh
 * container — the same rule as the Go sibling's `testx.Unique`.
 */
export function unique(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${randomBytes(3).toString("hex")}`;
}
