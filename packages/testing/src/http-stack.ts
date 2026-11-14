/**
 * Real servers for the outbound HTTP suite (packages/resilient-client): the
 * counterpart of golang-basics' libs/resilient-http-client/integration stack.
 *
 *   Caddy     the edge — cleartext, TLS, TLS 1.3 only, a client certificate
 *             required, an expired certificate; routes that answer with a
 *             status, echo a body, serve a 4 MiB file, redirect;
 *   Redpanda  a real HTTP API behind it (its HTTP Proxy, under /panda): a
 *             long poll is a server that takes its time, a produced record is
 *             a write whose ground truth can be read back.
 */
import { createHash } from "node:crypto";

import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";

import type { Pki } from "./pki.js";

const DOCKER_HUB = process.env["DOCKER_HUB"] ?? "docker.io";
const LABELS = { "nodejs-basics.role": "integration-test" };
const HOST_GATEWAY = [{ host: "host.docker.internal", ipAddress: "host-gateway" }];

export const HTTP_EDGE_IMAGE = "caddy:2.10.2";
export const HTTP_API_IMAGE = "redpandadata/redpanda:v26.2.3";

/** The file the edge serves at /files/blob. */
export const BLOB_SIZE = 4 << 20;
const BLOB = Buffer.from("0123456789abcdef".repeat(BLOB_SIZE / 16));
export const BLOB_SHA256 = createHash("sha256").update(BLOB).digest("hex");

/** Content types of Redpanda's HTTP Proxy. */
export const KAFKA_JSON = "application/vnd.kafka.json.v2+json";
export const KAFKA_V2 = "application/vnd.kafka.v2+json";

const STATUSES = [200, 204, 400, 404, 409, 500, 501, 502, 503, 504];

function caddyfile(pandaUpstream: string): string {
  const routes = STATUSES.map(
    (code) => `\thandle /status/${code} {\n\t\trespond "status ${code}" ${code}\n\t}`,
  ).join("\n");
  return `{
	admin off
	auto_https off
	default_sni localhost
	servers :8080 {
		protocols h1 h2c
	}
}

(app) {
	request_body {
		max_size 32MB
	}
	handle /whoami {
		respond "proto={http.request.proto} tls={http.request.tls.version} port={http.request.remote.port}"
	}
${routes}
	handle /status/429 {
		header Retry-After 1
		respond "slow down" 429
	}
	handle /busy {
		header Retry-After 1
		respond "busy" 503
	}
	handle /echo {
		header X-Echo-Method {http.request.method}
		header X-Echo-Idempotency-Key {http.request.header.Idempotency-Key}
		respond "{http.request.body}"
	}
	handle_path /files/* {
		root * /srv
		file_server
	}
	handle /redirect/same {
		redir * /whoami 302
	}
	handle_path /panda/* {
		reverse_proxy ${pandaUpstream} {
			flush_interval -1
		}
	}
	handle {
		respond "no such route" 404
	}
}

:8080 {
	import app
}

:8443 {
	tls /certs/server.crt /certs/server.key
	import app
}

:8444 {
	tls /certs/server.crt /certs/server.key {
		protocols tls1.3
	}
	import app
}

:8445 {
	tls /certs/server.crt /certs/server.key {
		client_auth {
			mode require_and_verify
			trust_pool file /certs/ca.crt
		}
	}
	import app
}

:8446 {
	tls /certs/expired.crt /certs/expired.key
	import app
}
`;
}

export interface HttpStack {
  /** Host ports of the edge's listeners. */
  readonly ports: Record<"plain" | "tls" | "tls13" | "mtls" | "expired", number>;
  /** Host port of Redpanda's HTTP Proxy, apart from the edge (for a proxy in front of it). */
  readonly apiPort: number;
  /** A fresh topic with one partition. */
  createTopic(name: string): Promise<void>;
  /** The values of the records the topic holds — read from the broker directly. */
  stored(topic: string): Promise<string[]>;
  stop(): Promise<void>;
}

const file = (target: string, content: Buffer | string) => ({ content, target, mode: 0o644 });

export async function startHttpStack(pki: Pki): Promise<HttpStack> {
  const api = await new GenericContainer(`${DOCKER_HUB}/${HTTP_API_IMAGE}`)
    .withCommand(
      [
        ["redpanda", "start", "--mode", "dev-container", "--smp", "1", "--memory", "1G"],
        ["--overprovisioned", "--kafka-addr", "0.0.0.0:9092"],
        ["--advertise-kafka-addr", "127.0.0.1:9092", "--pandaproxy-addr", "0.0.0.0:8082"],
        ["--advertise-pandaproxy-addr", "127.0.0.1:8082", "--rpc-addr", "0.0.0.0:33145"],
        ["--advertise-rpc-addr", "127.0.0.1:33145"],
      ].flat(),
    )
    .withExposedPorts(8082, 9644)
    .withLabels(LABELS)
    .withWaitStrategy(
      Wait.forAll([Wait.forHttp("/v1/status/ready", 9644), Wait.forHttp("/brokers", 8082)]),
    )
    .withStartupTimeout(120_000)
    .start();
  const apiPort = api.getMappedPort(8082);

  let edge: StartedTestContainer;
  try {
    edge = await new GenericContainer(`${DOCKER_HUB}/library/${HTTP_EDGE_IMAGE}`)
      .withCopyContentToContainer([
        file("/etc/caddy/Caddyfile", caddyfile(`host.docker.internal:${apiPort}`)),
        file("/certs/ca.crt", pki.caPem),
        file("/certs/server.crt", pki.serverCert),
        file("/certs/server.key", pki.serverKey),
        file("/certs/expired.crt", pki.expiredCert),
        file("/certs/expired.key", pki.expiredKey),
        file("/srv/blob", BLOB),
      ])
      .withExtraHosts(HOST_GATEWAY)
      .withExposedPorts(8080, 8443, 8444, 8445, 8446)
      .withLabels(LABELS)
      .withWaitStrategy(Wait.forHttp("/whoami", 8080))
      .withStartupTimeout(60_000)
      .start();
  } catch (err) {
    await api.stop({ timeout: 0 });
    throw err;
  }

  const direct = `http://${api.getHost()}:${apiPort}`;
  return {
    ports: {
      plain: edge.getMappedPort(8080),
      tls: edge.getMappedPort(8443),
      tls13: edge.getMappedPort(8444),
      mtls: edge.getMappedPort(8445),
      expired: edge.getMappedPort(8446),
    },
    apiPort,
    async createTopic(name) {
      const { exitCode, output } = await api.exec(["rpk", "topic", "create", name]);
      if (exitCode !== 0) throw new Error(`rpk topic create ${name}: ${output}`);
    },
    async stored(topic) {
      const res = await fetch(
        `${direct}/topics/${topic}/partitions/0/records?offset=0&timeout=300&max_bytes=1048576`,
        { headers: { accept: KAFKA_JSON } },
      );
      if (!res.ok) throw new Error(`redpanda: ${res.status} ${await res.text()}`);
      return ((await res.json()) as Array<{ value: string }>).map((record) => record.value);
    },
    async stop() {
      await Promise.allSettled([edge.stop({ timeout: 0 }), api.stop({ timeout: 0 })]);
    },
  };
}
