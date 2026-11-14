/**
 * vitest globalSetup of the integration project: the backing services as
 * containers, started for the run and stopped after it — the Node counterpart
 * of golang-basics' testx/containers.
 *
 * - Only what the selected spec files ask for is started: a file says what it
 *   needs with `integration("postgres", "toxiproxy")`, and this setup reads
 *   that. `pnpm test:integration some.file` starts that file's services only.
 * - A service whose variable is already set (DATABASE_URL / VALKEY_URL /
 *   KAFKA_BROKERS from `just deps`, the CI job, a shared stand) is used as it
 *   is; nothing is started for it. Toxiproxy then proxies to that address.
 * - No container runtime: locally nothing is started and the suites skip
 *   themselves; on CI (`CI` set) `integration()` fails them.
 * - Suites share the containers and isolate with `unique()` — a table, a key
 *   prefix, a topic — never a fresh container.
 *
 * Images are the ones docker/deps.yml runs, behind the same registry
 * variables (DOCKER_HUB, GHCR). Rootless Podman needs
 * TESTCONTAINERS_RYUK_DISABLED=true; the teardown below stops everything
 * either way.
 */
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

import { GenericContainer, getContainerRuntimeClient, Wait } from "testcontainers";
import type { StartedTestContainer } from "testcontainers";
import type { TestProject } from "vitest/node";

import { PROXY_PORTS } from "./chaos.js";
import { S3_TEST_CREDENTIALS } from "./services.js";
import type { Service } from "./services.js";

const DOCKER_HUB = process.env["DOCKER_HUB"] ?? "docker.io";
const GHCR = process.env["GHCR"] ?? "ghcr.io";

export const IMAGES = {
  postgres: `${DOCKER_HUB}/library/postgres:18`,
  valkey: `${DOCKER_HUB}/valkey/valkey:9.0`,
  kafka: `${DOCKER_HUB}/redpandadata/redpanda:v26.2.3`,
  s3: `${DOCKER_HUB}/rustfs/rustfs:1.0.5`,
  toxiproxy: `${GHCR}/shopify/toxiproxy:2.12.0`,
} as const;

const ENV: Record<Service, string> = {
  postgres: "DATABASE_URL",
  valkey: "VALKEY_URL",
  kafka: "KAFKA_BROKERS",
  s3: "S3_ENDPOINT",
  toxiproxy: "TOXIPROXY_URL",
};

const SERVICES = Object.keys(ENV) as Service[];
const LABELS = { "nodejs-basics.role": "integration-test" };
const TOXIPROXY_API = 8474;

/** What the spec files of this run ask for: every `integration("a", "b")` they contain. */
export function servicesIn(source: string): Set<Service> {
  const found = new Set<Service>();
  for (const call of source.matchAll(/\bintegration\(([^)]*)\)/gu)) {
    for (const name of (call[1] ?? "").matchAll(/["'`]([a-z0-9]+)["'`]/gu)) {
      if (SERVICES.includes(name[1] as Service)) found.add(name[1] as Service);
    }
  }
  return found;
}

async function needed(project: TestProject): Promise<Set<Service>> {
  // The CLI's file filters; internal to vitest, so absent means "every file".
  const filters = (project.vitest as { filenamePattern?: string[] }).filenamePattern;
  const { testFiles } = await project.globTestFiles(filters);
  const all = new Set<Service>();
  for (const file of testFiles) {
    for (const service of servicesIn(await readFile(file, "utf8"))) all.add(service);
  }
  return all;
}

type Starter = () => Promise<{ container: StartedTestContainer; env: Record<string, string> }>;

const START: Record<Service, Starter> = {
  async postgres() {
    const container = await new GenericContainer(IMAGES.postgres)
      .withEnvironment({ POSTGRES_DB: "app", POSTGRES_USER: "app", POSTGRES_PASSWORD: "app" })
      .withCommand(["postgres", "-c", "max_connections=100", "-c", "fsync=off"])
      // The data lives for one run: in memory it costs no disk I/O at all.
      .withTmpFs({ "/var/lib/postgresql": "rw" })
      .withExposedPorts(5432)
      .withLabels(LABELS)
      // The entrypoint starts a temporary server first: ready is the second "ready" line.
      .withWaitStrategy(
        Wait.forAll([
          Wait.forLogMessage(/database system is ready to accept connections/u, 2),
          Wait.forListeningPorts(),
        ]),
      )
      .start();
    const address = `${container.getHost()}:${container.getMappedPort(5432)}`;
    return { container, env: { DATABASE_URL: `postgresql://app:app@${address}/app` } };
  },

  async valkey() {
    const container = await new GenericContainer(IMAGES.valkey)
      .withCommand(["valkey-server", "--save", "", "--appendonly", "no"])
      .withExposedPorts(6379)
      .withLabels(LABELS)
      .withWaitStrategy(Wait.forLogMessage(/Ready to accept connections/u))
      .start();
    return {
      container,
      env: { VALKEY_URL: `redis://${container.getHost()}:${container.getMappedPort(6379)}` },
    };
  },

  async kafka() {
    // The broker advertises the address clients must dial, and the mapped port
    // is only known once the container runs: start it idle, then start the
    // broker with the right address.
    const container = await new GenericContainer(IMAGES.kafka)
      .withEntrypoint(["sleep"])
      .withCommand(["infinity"])
      .withExposedPorts(9092)
      .withLabels(LABELS)
      // Nothing listens until the broker is started below.
      .withWaitStrategy(Wait.forSuccessfulCommand("true"))
      .start();
    const address = `${container.getHost()}:${container.getMappedPort(9092)}`;
    const broker =
      "rpk redpanda start --mode dev-container --smp 1 --memory 1G --overprovisioned " +
      "--node-id 0 --check=false --set redpanda.auto_create_topics_enabled=true " +
      "--kafka-addr 0.0.0.0:9092 " +
      `--advertise-kafka-addr ${address} >/tmp/redpanda.log 2>&1 &`;
    await container.exec(["sh", "-c", broker]);
    for (let attempt = 0; ; attempt++) {
      const { exitCode } = await container.exec([
        "rpk",
        "cluster",
        "info",
        "-X",
        "brokers=localhost:9092",
      ]);
      if (exitCode === 0) break;
      if (attempt >= 120) {
        const { output } = await container.exec(["tail", "-n", "40", "/tmp/redpanda.log"]);
        throw new Error(`redpanda did not become ready:\n${output}`);
      }
      await delay(500);
    }
    return { container, env: { KAFKA_BROKERS: address } };
  },

  async s3() {
    const container = await new GenericContainer(IMAGES.s3)
      .withEnvironment({
        RUSTFS_ACCESS_KEY: S3_TEST_CREDENTIALS.accessKeyId,
        RUSTFS_SECRET_KEY: S3_TEST_CREDENTIALS.secretAccessKey,
      })
      .withExposedPorts(9000)
      .withLabels(LABELS)
      // /health answers once the store serves the S3 API; the port opens a moment earlier.
      .withWaitStrategy(Wait.forHttp("/health", 9000))
      .start();
    return {
      container,
      env: { S3_ENDPOINT: `http://${container.getHost()}:${container.getMappedPort(9000)}` },
    };
  },

  async toxiproxy() {
    const ports = [PROXY_PORTS.postgres, PROXY_PORTS.valkey, PROXY_PORTS.s3, ...PROXY_PORTS.pool];
    const container = await new GenericContainer(IMAGES.toxiproxy)
      .withExposedPorts(TOXIPROXY_API, ...ports)
      // The proxies reach the dependencies (and the servers tests listen on)
      // through the ports published on the host.
      .withExtraHosts([{ host: "host.docker.internal", ipAddress: "host-gateway" }])
      .withLabels(LABELS)
      .withWaitStrategy(Wait.forHttp("/version", TOXIPROXY_API))
      .start();
    const published = Object.fromEntries(ports.map((p) => [p, container.getMappedPort(p)]));
    return {
      container,
      env: {
        TOXIPROXY_URL: `http://${container.getHost()}:${container.getMappedPort(TOXIPROXY_API)}`,
        TOXIPROXY_PORTS: JSON.stringify(published),
        TOXIPROXY_UPSTREAM_HOST: "host.docker.internal",
      },
    };
  },
};

export default async function setup(project: TestProject): Promise<(() => Promise<void>) | void> {
  const missing = [...(await needed(project))].filter((s) => !process.env[ENV[s]]);
  if (missing.length === 0) return;

  try {
    await getContainerRuntimeClient();
  } catch (err) {
    // Locally the suites skip (integration() says why); on CI they fail there.
    console.warn(
      `integration: no container runtime, not starting ${missing.join(", ")} — ` +
        (err instanceof Error ? err.message : "unknown error"),
    );
    return;
  }

  const started: StartedTestContainer[] = [];
  const ids: Partial<Record<Service, string>> = {};
  const stop = async (): Promise<void> => {
    await Promise.allSettled(started.map((c) => c.stop({ timeout: 0 })));
  };
  const results = await Promise.allSettled(
    missing.map(async (service) => {
      const { container, env } = await START[service]();
      started.push(container);
      ids[service] = container.getId();
      Object.assign(process.env, env);
    }),
  );
  // What pause() (chaos.ts) signals: only containers this run started can be frozen.
  process.env["INTEGRATION_CONTAINERS"] = JSON.stringify(ids);
  const failed = results.find((r) => r.status === "rejected");
  if (failed !== undefined) {
    await stop();
    throw new Error("integration: a service container did not start", { cause: failed.reason });
  }
  return stop;
}
