/**
 * Chaos for integration suites: a dependency reached through Toxiproxy, so a
 * test can take it down, slow it, cut or freeze its connections — and put it
 * back. The counterpart of `containers.Proxied` in golang-basics' testx.
 *
 *   const infra = integration("postgres", "toxiproxy");
 *   const db = await proxied("postgres");          // db.url instead of DATABASE_URL
 *   await db.down();                               // connections refused
 *   await db.latency(500);                         // every byte back is 500 ms late
 *   await db.toxic("reset_peer", { timeout: 0 });  // any Toxiproxy toxic
 *   await db.reset();                              // in afterEach: healthy again
 *
 *   const api = await proxiedPort("billing", port); // a server this test listens on
 *
 * The Toxiproxy container and its address come from the integration project's
 * global setup (containers.global-setup.ts) as TOXIPROXY_URL / TOXIPROXY_PORTS;
 * this file only speaks its HTTP API, so the harness itself pulls no Docker
 * client into a test process. A code path written for a failing dependency
 * gets a test here before it is trusted.
 */
import type { Service } from "./services.js";

/** A service a proxy can stand in front of (Kafka is not: its clients dial advertised addresses). */
export type ProxiedService = Extract<Service, "postgres" | "valkey">;

const SERVICE_ENV: Record<ProxiedService, string> = {
  postgres: "DATABASE_URL",
  valkey: "VALKEY_URL",
};

/** Ports the proxies listen on inside the Toxiproxy container (all published by the global setup). */
export const PROXY_PORTS = {
  postgres: 8666,
  valkey: 8667,
  /** For proxiedPort(): servers the tests themselves listen on. */
  pool: [8670, 8671, 8672, 8673, 8674, 8675, 8676, 8677],
} as const;

export interface Proxy {
  readonly name: string;
  /** Where the test dials instead of the dependency: "127.0.0.1:<port>". */
  readonly address: string;
  /** Refuse connections (and drop the open ones) until up() or reset(). */
  down(): Promise<void>;
  up(): Promise<void>;
  /** Delay everything the dependency sends back by `ms` (± `jitterMs`). */
  latency(ms: number, jitterMs?: number): Promise<void>;
  /**
   * Any Toxiproxy toxic: `timeout` (data stops; the connection closes after
   * `timeout` ms, or never when 0), `reset_peer`, `limit_data`, `bandwidth`,
   * `slow_close`, `slicer`. Downstream is what the dependency sends back.
   */
  toxic(
    type: string,
    attributes: Record<string, number>,
    stream?: "downstream" | "upstream",
  ): Promise<void>;
  /** Enabled again, every toxic removed. Call it in afterEach. */
  reset(): Promise<void>;
  /** Removes the proxy (proxiedPort only needs it; a service proxy is shared). */
  close(): Promise<void>;
}

export interface ServiceProxy extends Proxy {
  /** The service's connection string, pointing at the proxy. */
  readonly url: string;
}

interface ProxyRecord {
  name: string;
  listen: string;
  upstream: string;
  enabled: boolean;
  toxics: Array<{ name: string }>;
}

function api(): string {
  const url = process.env["TOXIPROXY_URL"];
  if (url === undefined || url === "") {
    throw new Error("TOXIPROXY_URL is unset — gate the suite with integration(…, 'toxiproxy')");
  }
  return url;
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T | undefined> {
  const res = await fetch(`${api()}${path}`, {
    method,
    ...(body === undefined
      ? {}
      : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }),
  });
  if (res.status === 404 && method === "GET") return undefined;
  if (!res.ok) throw new Error(`toxiproxy ${method} ${path}: ${res.status} ${await res.text()}`);
  return res.status === 204 ? undefined : ((await res.json()) as T);
}

/** The host port a proxy's container port is published on. */
function hostPort(containerPort: number): number {
  const ports = JSON.parse(process.env["TOXIPROXY_PORTS"] ?? "{}") as Record<string, number>;
  const port = ports[String(containerPort)];
  if (port === undefined) throw new Error(`toxiproxy: port ${containerPort} is not published`);
  return port;
}

/** How the Toxiproxy container reaches a port on the machine the tests run on. */
function upstreamOf(host: string, port: number | string): string {
  const local = host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
  return `${local ? (process.env["TOXIPROXY_UPSTREAM_HOST"] ?? "host.docker.internal") : host}:${port}`;
}

function handle(name: string, containerPort: number): Proxy {
  const path = `/proxies/${encodeURIComponent(name)}`;
  const enable = async (enabled: boolean): Promise<void> => {
    await call("POST", path, { enabled });
  };
  return {
    name,
    address: `127.0.0.1:${hostPort(containerPort)}`,
    down: () => enable(false),
    up: () => enable(true),
    async latency(ms, jitterMs = 0) {
      await this.toxic("latency", { latency: ms, jitter: jitterMs });
    },
    async toxic(type, attributes, stream = "downstream") {
      await call("POST", `${path}/toxics`, { type, stream, toxicity: 1, attributes });
    },
    async reset() {
      const proxy = await call<ProxyRecord>("GET", path);
      if (proxy === undefined) return;
      for (const toxic of proxy.toxics) {
        await call("DELETE", `${path}/toxics/${encodeURIComponent(toxic.name)}`);
      }
      await enable(true);
    },
    async close() {
      await call("DELETE", path);
    },
  };
}

/**
 * The proxy in front of a service, created on first use and shared by every
 * suite (they run one file at a time). `url` is the service's connection
 * string with the proxy's address in it.
 */
export async function proxied(service: ProxiedService): Promise<ServiceProxy> {
  const raw = process.env[SERVICE_ENV[service]];
  if (raw === undefined || raw === "") throw new Error(`${SERVICE_ENV[service]} is unset`);
  const target = new URL(raw);
  const containerPort = PROXY_PORTS[service];
  const defaultPort = service === "postgres" ? 5432 : 6379;

  if ((await call<ProxyRecord>("GET", `/proxies/${service}`)) === undefined) {
    await call("POST", "/proxies", {
      name: service,
      listen: `0.0.0.0:${containerPort}`,
      upstream: upstreamOf(target.hostname, target.port === "" ? defaultPort : target.port),
      enabled: true,
    });
  }

  const proxy = handle(service, containerPort);
  const url = new URL(raw);
  url.hostname = "127.0.0.1";
  url.port = String(hostPort(containerPort));
  await proxy.reset();
  return { ...proxy, url: url.toString() };
}

/**
 * A proxy in front of a server the test itself listens on (bind it to
 * 0.0.0.0: the proxy reaches it from a container). Close it when done — the
 * pool has eight ports.
 */
export async function proxiedPort(name: string, port: number): Promise<Proxy> {
  const all = (await call<Record<string, ProxyRecord>>("GET", "/proxies")) ?? {};
  const taken = new Set(Object.values(all).map((p) => Number(p.listen.split(":").at(-1))));
  const containerPort = PROXY_PORTS.pool.find((p) => !taken.has(p));
  if (containerPort === undefined) {
    throw new Error("toxiproxy: no free proxy port — a suite did not close() its proxies");
  }
  await call("POST", "/proxies", {
    name,
    listen: `0.0.0.0:${containerPort}`,
    upstream: upstreamOf("127.0.0.1", port),
    enabled: true,
  });
  return handle(name, containerPort);
}
