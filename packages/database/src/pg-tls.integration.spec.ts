import { createServer } from "node:net";

import { ConfigService } from "@nestjs/config";
import type { Pool } from "pg";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { containerRuntimeAvailable, createPki, testCase } from "@base/testing";

import { pgPoolProvider } from "./pg-pool.provider.js";

const runtime = await containerRuntimeAvailable();
const IMAGE = `${process.env["DOCKER_HUB"] ?? "docker.io"}/library/postgres:18`;

async function freePort(): Promise<number> {
  const listener = createServer();
  await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const address = listener.address();
  if (address === null || typeof address === "string") throw new Error("no free TCP port");
  const port = address.port;
  await new Promise<void>((resolve, reject) =>
    listener.close((err) => (err === undefined ? resolve() : reject(err))),
  );
  return port;
}

describe.skipIf(!runtime)("Postgres TLS (integration)", { timeout: 120_000 }, () => {
  let container: StartedTestContainer;
  let url: string;
  let caPem: string;
  const pools: Pool[] = [];

  beforeAll(async () => {
    const pki = createPki();
    caPem = pki.caPem.toString("utf8");
    const port = await freePort();
    url = `postgresql://app:app@localhost:${port}/app?sslmode=verify-full`;
    container = await new GenericContainer(IMAGE)
      .withNetworkMode("host")
      .withEnvironment({ POSTGRES_DB: "app", POSTGRES_USER: "app", POSTGRES_PASSWORD: "app" })
      .withCopyContentToContainer([
        { target: "/certs/server.crt", content: pki.serverCert },
        { target: "/certs/server.key", content: pki.serverKey },
      ])
      .withEntrypoint(["/bin/sh", "-c"])
      .withCommand([
        `chown postgres:postgres /certs/server.* && chmod 600 /certs/server.key && exec docker-entrypoint.sh postgres -c port=${port} -c ssl=on -c ssl_cert_file=/certs/server.crt -c ssl_key_file=/certs/server.key`,
      ])
      .withLabels({ "nodejs-basics.role": "integration-test" })
      .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/u, 2))
      .withStartupTimeout(60_000)
      .start();
  });

  afterAll(async () => {
    await Promise.allSettled(pools.map((pool) => pool.end()));
    await container?.stop({ timeout: 0 });
  });

  function createPool(ca: string | undefined): Pool {
    const created = pgPoolProvider.useFactory(
      new ConfigService({
        DATABASE_URL: url,
        ...(ca === undefined ? {} : { DATABASE_SSL_CA_PEM: ca }),
      }),
    ) as Pool;
    pools.push(created);
    return created;
  }

  it("verifies the server with the configured CA and rejects it without that CA", async () => {
    await testCase("NB-1380", "Postgres TLS: pg.Pool uses the configured CA on a real query");
    await expect(createPool(caPem).query("SELECT 1 AS ok")).resolves.toMatchObject({
      rows: [{ ok: 1 }],
    });
    await expect(createPool(undefined).query("SELECT 1")).rejects.toThrow(/certificate/iu);
  });
});
