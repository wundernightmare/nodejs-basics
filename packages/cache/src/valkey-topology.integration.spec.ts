import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ConfigService } from "@nestjs/config";
import { Redis as Valkey } from "iovalkey";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import { describe, expect, it } from "vitest";

import { containerRuntimeAvailable, createPki, testCase, unique } from "@base/testing";

import { CacheAside } from "./cache-aside.js";
import { ValkeyRemote } from "./tier-cache.valkey.js";
import { buildValkeyConfig } from "./valkey-config.builder.js";
import { createValkeyClient } from "./valkey.provider.js";

const runtime = await containerRuntimeAvailable();
const IMAGE = `${process.env["DOCKER_HUB"] ?? "docker.io"}/valkey/valkey:7.2-alpine`;
const LABELS = { "nodejs-basics.role": "integration-test" };

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

function server(command: string[]): Promise<StartedTestContainer> {
  return new GenericContainer(IMAGE)
    .withNetworkMode("host")
    .withCommand(command)
    .withLabels(LABELS)
    .withWaitStrategy(Wait.forLogMessage(/Ready to accept connections/u))
    .withStartupTimeout(30_000)
    .start();
}

function dataServer(port: number, cluster: boolean): Promise<StartedTestContainer> {
  return server([
    "valkey-server",
    "--port",
    String(port),
    "--save",
    "",
    "--appendonly",
    "no",
    "--protected-mode",
    "no",
    ...(cluster
      ? ["--cluster-enabled", "yes", "--cluster-config-file", `/tmp/cluster-${port}.conf`]
      : []),
  ]);
}

async function stop(
  containers: StartedTestContainer[],
  clients: Array<{ quit(): Promise<unknown>; disconnect(): void }>,
) {
  await Promise.allSettled(clients.map((client) => client.quit()));
  for (const client of clients) client.disconnect();
  await Promise.allSettled(containers.map((container) => container.stop({ timeout: 0 })));
}

async function verifyLua(client: Valkey): Promise<void> {
  if (client.status === "wait") await client.connect();
  if (client.status !== "ready") {
    await new Promise<void>((resolve) => client.once("ready", resolve));
  }
  const remote = new ValkeyRemote(client, { compareAndSet: "lua" });
  const key = unique("cas");
  expect(await remote.setNX(key, "one", 5_000)).toBe(true);
  expect(await remote.replace(key, "wrong", "ignored", 5_000)).toBe(false);
  expect(await remote.get(key)).toBe("one");
  expect(await remote.replace(key, "one", "two", 5_000)).toBe(true);
  expect(await remote.get(key)).toBe("two");
}

describe.skipIf(!runtime)(
  "Valkey topologies and Lua CAS (integration)",
  { timeout: 120_000 },
  () => {
    it("runs Lua CAS and repairs a corrupt entry on Valkey 7.2", async () => {
      await testCase("NB-1373", "Valkey 7.2: Lua compare-and-set replaces corrupt data");
      const port = await freePort();
      const container = await dataServer(port, false);
      const client = new Valkey(`redis://127.0.0.1:${port}`);
      try {
        await verifyLua(client);
        const key = unique("corrupt");
        await client.set(key, "{broken");
        const aside = new CacheAside(client, { compareAndSet: "lua" });
        expect((await aside.get(key, 5_000, () => Promise.resolve("fresh"))).value).toBe("fresh");
        expect(await client.get(key)).toBe('"fresh"');
      } finally {
        await stop([container], [client]);
      }
    });

    it("verifies a server certificate with the configured private CA", async () => {
      await testCase("NB-1378", "Valkey TLS: a private CA works on a real handshake");
      const pki = createPki();
      const port = await freePort();
      const container = await new GenericContainer(IMAGE)
        .withNetworkMode("host")
        .withCopyContentToContainer([
          { target: "/certs/server.crt", content: pki.serverCert },
          { target: "/certs/server.key", content: pki.serverKey },
        ])
        .withCommand([
          "valkey-server",
          "--port",
          "0",
          "--tls-port",
          String(port),
          "--tls-cert-file",
          "/certs/server.crt",
          "--tls-key-file",
          "/certs/server.key",
          "--tls-auth-clients",
          "no",
          "--save",
          "",
          "--appendonly",
          "no",
          "--protected-mode",
          "no",
        ])
        .withLabels(LABELS)
        .withWaitStrategy(Wait.forLogMessage(/Ready to accept connections/u))
        .start();
      const dir = mkdtempSync(join(tmpdir(), "valkey-ca-"));
      const caFile = join(dir, "ca.pem");
      writeFileSync(caFile, pki.caPem, { mode: 0o600 });
      const client = createValkeyClient(
        buildValkeyConfig(
          new ConfigService({
            VALKEY_URL: `rediss://localhost:${port}`,
            VALKEY_CA_LOCATION: caFile,
          }),
        ),
      );
      try {
        await client.connect();
        await client.set(unique("tls"), "ok");
        expect(await client.get("missing")).toBeNull();
      } finally {
        await stop([container], [client]);
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("uses cluster seeds, Lua CAS and a cluster Pub/Sub subscription", async () => {
      await testCase("NB-1374", "Valkey cluster: seed discovery, Lua CAS and Pub/Sub invalidation");
      const ports = await Promise.all([freePort(), freePort(), freePort()]);
      const nodes = await Promise.all(ports.map((port) => dataServer(port, true)));
      let client: Valkey | undefined;
      let setup: StartedTestContainer | undefined;
      try {
        setup = await new GenericContainer(IMAGE)
          .withNetworkMode("host")
          .withCommand([
            "valkey-cli",
            "--cluster",
            "create",
            ...ports.map((port) => `127.0.0.1:${port}`),
            "--cluster-yes",
          ])
          .withLabels(LABELS)
          .withWaitStrategy(Wait.forOneShotStartup())
          .withStartupTimeout(30_000)
          .start();
        client = createValkeyClient(
          buildValkeyConfig(
            new ConfigService({
              VALKEY_URL: `redis://127.0.0.1:${ports[0]}?addr=127.0.0.1:${ports[1]}&addr=127.0.0.1:${ports[2]}`,
              VALKEY_COMPARE_AND_SET: "lua",
            }),
          ),
        );
        await verifyLua(client);

        const remote = new ValkeyRemote(client, { compareAndSet: "lua" });
        const channel = unique("invalidation");
        const messages: string[] = [];
        let subscribed = 0;
        const unsubscribe = await remote.subscribe(
          channel,
          (message) => messages.push(message),
          () => {
            subscribed += 1;
          },
        );
        await expect.poll(() => subscribed).toBe(1);
        await remote.publish(channel, "k");
        await expect.poll(() => messages).toEqual(["k"]);
        await unsubscribe();
      } finally {
        await stop(
          [...(setup === undefined ? [] : [setup]), ...nodes],
          client === undefined ? [] : [client],
        );
      }
    });

    it("discovers the primary through Sentinel and uses Lua CAS", async () => {
      await testCase("NB-1375", "Valkey Sentinel: master discovery and Lua compare-and-set");
      const primaryPort = await freePort();
      const primary = await dataServer(primaryPort, false);
      const sentinelPorts = await Promise.all([freePort(), freePort()]);
      const sentinels: StartedTestContainer[] = [];
      let client: Valkey | undefined;
      try {
        for (const port of sentinelPorts) {
          sentinels.push(
            await new GenericContainer(IMAGE)
              .withNetworkMode("host")
              .withCopyContentToContainer([
                {
                  target: "/etc/sentinel.conf",
                  content: `port ${port}\ndir /tmp\nsentinel monitor primary 127.0.0.1 ${primaryPort} 1\n`,
                  mode: 0o666,
                },
              ])
              .withCommand(["valkey-server", "/etc/sentinel.conf", "--sentinel"])
              .withLabels(LABELS)
              .withWaitStrategy(Wait.forLogMessage(/Sentinel ID is/u))
              .withStartupTimeout(30_000)
              .start(),
          );
        }
        client = createValkeyClient(
          buildValkeyConfig(
            new ConfigService({
              VALKEY_URL: `redis://127.0.0.1:${sentinelPorts[0]}?addr=127.0.0.1:${sentinelPorts[1]}&master_set=primary`,
              VALKEY_COMPARE_AND_SET: "lua",
            }),
          ),
        );
        await verifyLua(client);
      } finally {
        await stop([...sentinels, primary], client === undefined ? [] : [client]);
      }
    });
  },
);
