/**
 * Real servers for the outbound gRPC suites (packages/grpc-client): the
 * counterpart of golang-basics' libs/grpcx/integration stack.
 *
 *   startGrpcServer(pki)   Jaeger v2 — a real gRPC server: its OTLP receiver
 *                          (TraceService/Export, unary) on six listeners
 *                          (cleartext, TLS, mutual TLS, TLS 1.3 only, an
 *                          expired certificate, a counted one) and its query
 *                          API (QueryService/FindTraces, server-streaming).
 *   startHttpGateway(pki)  Caddy — an HTTP server that is not a gRPC server:
 *                          what a call meets when an ingress, a mesh sidecar
 *                          or a misrouted address answers instead.
 *
 * The messages are written and read on the protobuf wire by hand (a few
 * fields each), so the suites need no generated code.
 */
import { randomBytes } from "node:crypto";

import { GenericContainer, Wait } from "testcontainers";

import type { Pki } from "./pki.js";

const DOCKER_HUB = process.env["DOCKER_HUB"] ?? "docker.io";
const LABELS = { "nodejs-basics.role": "integration-test" };

/** Full names of the methods the suites call. */
export const EXPORT_METHOD = "/opentelemetry.proto.collector.trace.v1.TraceService/Export";
export const FIND_TRACES_METHOD = "/jaeger.api_v3.QueryService/FindTraces";

// ─── Protobuf wire, the little of it that is needed ──────────────────────────

function varint(value: number | bigint): Buffer {
  const out: number[] = [];
  let rest = BigInt(value);
  while (rest >= 0x80n) {
    out.push(Number(rest & 0x7fn) | 0x80);
    rest >>= 7n;
  }
  out.push(Number(rest));
  return Buffer.from(out);
}

const LEN = 2;
const FIXED64 = 1;
const VARINT = 0;

function bytesField(field: number, payload: Buffer | string): Buffer {
  const body = typeof payload === "string" ? Buffer.from(payload) : payload;
  return Buffer.concat([varint((field << 3) | LEN), varint(body.length), body]);
}

function fixed64Field(field: number, value: bigint): Buffer {
  const body = Buffer.alloc(8);
  body.writeBigUInt64LE(value);
  return Buffer.concat([varint((field << 3) | FIXED64), body]);
}

function varintField(field: number, value: number | bigint): Buffer {
  return Buffer.concat([varint((field << 3) | VARINT), varint(value)]);
}

/** KeyValue{ key = 1, value = 2: AnyValue{ string_value = 1 } } */
function stringAttribute(key: string, value: string): Buffer {
  return Buffer.concat([bytesField(1, key), bytesField(2, bytesField(1, value))]);
}

export interface ExportOptions {
  /** `service.name` of the resource: what the spans are found by. */
  service: string;
  spans: number;
  /** Bytes of attribute on each span, so a batch has a size worth cutting. Default 16. */
  pad?: number;
}

/**
 * An OTLP ExportTraceServiceRequest: `spans` spans of one fresh trace.
 *
 *   ExportTraceServiceRequest{ resource_spans = 1: ResourceSpans{
 *     resource = 1: Resource{ attributes = 1 },
 *     scope_spans = 2: ScopeSpans{ spans = 2: Span{
 *       trace_id = 1, span_id = 2, name = 5, start = 7, end = 8, attributes = 9 } } } }
 */
export function exportRequest(options: ExportOptions): Buffer {
  const traceId = randomBytes(16);
  const now = BigInt(Date.now()) * 1_000_000n;
  const pad = stringAttribute("pad", "x".repeat(options.pad ?? 16));
  const spans = Array.from({ length: options.spans }, () =>
    bytesField(
      2,
      Buffer.concat([
        bytesField(1, traceId),
        bytesField(2, randomBytes(8)),
        bytesField(5, "work"),
        fixed64Field(7, now),
        fixed64Field(8, now + 1000n),
        bytesField(9, pad),
      ]),
    ),
  );
  const resource = bytesField(1, bytesField(1, stringAttribute("service.name", options.service)));
  const scopeSpans = bytesField(2, Buffer.concat(spans));
  return bytesField(1, Buffer.concat([resource, scopeSpans]));
}

/**
 * A FindTracesRequest for every trace of `service`:
 *
 *   FindTracesRequest{ query = 1: TraceQueryParameters{
 *     service_name = 1, start_time_min = 4, start_time_max = 5, search_depth = 8 } }
 */
export function findTracesRequest(service: string): Buffer {
  const seconds = (at: number): Buffer => varintField(1, Math.floor(at / 1000));
  const now = Date.now();
  return bytesField(
    1,
    Buffer.concat([
      bytesField(1, service),
      bytesField(4, seconds(now - 3_600_000)),
      bytesField(5, seconds(now + 3_600_000)),
      varintField(8, 10_000),
    ]),
  );
}

/** The length-delimited values of `field` in a message. */
function nested(message: Buffer, field: number): Buffer[] {
  const found: Buffer[] = [];
  let at = 0;
  const readVarint = (): number => {
    let value = 0n;
    let shift = 0n;
    for (;;) {
      const byte = message[at++];
      if (byte === undefined) throw new Error("protobuf: truncated varint");
      value |= BigInt(byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) return Number(value);
      shift += 7n;
    }
  };
  while (at < message.length) {
    const tag = readVarint();
    const wire = tag & 7;
    if (wire === VARINT) readVarint();
    else if (wire === FIXED64) at += 8;
    else if (wire === 5) at += 4;
    else if (wire === LEN) {
      const length = readVarint();
      if (tag >> 3 === field) found.push(message.subarray(at, at + length));
      at += length;
    } else throw new Error(`protobuf: wire type ${wire}`);
  }
  return found;
}

/** How many spans one FindTraces message (an OTLP TracesData) carries. */
export function countSpans(tracesData: Buffer): number {
  let count = 0;
  for (const resourceSpans of nested(tracesData, 1)) {
    for (const scopeSpans of nested(resourceSpans, 2)) count += nested(scopeSpans, 2).length;
  }
  return count;
}

// ─── Jaeger: the real gRPC server ────────────────────────────────────────────

export const GRPC_SERVER_IMAGE = "jaegertracing/jaeger:2.21.0";

const PORTS = {
  plain: 4317,
  tls: 4417,
  mtls: 4517,
  tls13: 4617,
  expired: 4717,
  counted: 4817,
  query: 16685,
  queryHttp: 16686,
  metrics: 8888,
  health: 13133,
} as const;

const listener = (name: string, port: number, tls = ""): string => `
  otlp/${name}:
    protocols:
      grpc:
        endpoint: 0.0.0.0:${port}${tls}`;

const serverTls = (cert: string, extra = ""): string => `
        tls:
          cert_file: /certs/${cert}.crt
          key_file: /certs/${cert}.key${extra}`;

const JAEGER_CONFIG = `
service:
  extensions: [jaeger_storage, jaeger_query, healthcheckv2]
  pipelines:
    traces:
      receivers: [otlp/plain, otlp/tls, otlp/mtls, otlp/tls13, otlp/expired, otlp/counted]
      exporters: [jaeger_storage_exporter]
  telemetry:
    metrics:
      level: detailed
      readers:
        - pull:
            exporter:
              prometheus:
                host: 0.0.0.0
                port: ${PORTS.metrics}
    logs:
      level: warn

extensions:
  jaeger_query:
    storage:
      traces: store
    grpc:
      endpoint: 0.0.0.0:${PORTS.query}
    http:
      endpoint: 0.0.0.0:${PORTS.queryHttp}
  jaeger_storage:
    backends:
      store:
        memory:
          max_traces: 100000
  healthcheckv2:
    use_v2: true
    http:
      endpoint: 0.0.0.0:${PORTS.health}

receivers:${listener("plain", PORTS.plain)}${listener("tls", PORTS.tls, serverTls("server"))}${listener(
  "mtls",
  PORTS.mtls,
  serverTls("server", "\n          client_ca_file: /certs/ca.crt"),
)}${listener("tls13", PORTS.tls13, serverTls("server", '\n          min_version: "1.3"'))}${listener(
  "counted",
  PORTS.counted,
)}${listener("expired", PORTS.expired, serverTls("expired"))}

exporters:
  jaeger_storage_exporter:
    trace_storage: store
`;

export interface GrpcServer {
  /** Host ports of the listeners (dial `localhost:<port>` or `127.0.0.1:<port>`). */
  readonly ports: Record<
    "plain" | "tls" | "mtls" | "tls13" | "expired" | "counted" | "query",
    number
  >;
  /** Spans the server holds for `service` — asked over HTTP, apart from the client under test. */
  stored(service: string): Promise<number>;
  /**
   * Spans that came in through the "counted" listener, by the server's own
   * metrics: how many times a request arrived, whatever the store made of it
   * (it folds byte-identical spans). Only one suite may rely on it.
   */
  arrived(): Promise<number>;
  stop(): Promise<void>;
}

interface TracesChunk {
  result?: { resourceSpans?: Array<{ scopeSpans?: Array<{ spans?: unknown[] }> }> };
}

const file = (target: string, content: Buffer | string) => ({ content, target, mode: 0o644 });

export async function startGrpcServer(pki: Pki): Promise<GrpcServer> {
  const container = await new GenericContainer(`${DOCKER_HUB}/${GRPC_SERVER_IMAGE}`)
    .withCommand(["--config", "/etc/jaeger/config.yaml"])
    .withCopyContentToContainer([
      file("/etc/jaeger/config.yaml", JAEGER_CONFIG),
      file("/certs/ca.crt", pki.caPem),
      file("/certs/server.crt", pki.serverCert),
      file("/certs/server.key", pki.serverKey),
      file("/certs/expired.crt", pki.expiredCert),
      file("/certs/expired.key", pki.expiredKey),
    ])
    .withExposedPorts(...Object.values(PORTS))
    .withLabels(LABELS)
    .withWaitStrategy(Wait.forHttp("/status", PORTS.health))
    .withStartupTimeout(90_000)
    .start();
  const host = container.getHost();
  const at = (port: number): number => container.getMappedPort(port);
  const query = `http://${host}:${at(PORTS.queryHttp)}`;
  const metrics = `http://${host}:${at(PORTS.metrics)}/metrics`;
  return {
    ports: {
      plain: at(PORTS.plain),
      tls: at(PORTS.tls),
      mtls: at(PORTS.mtls),
      tls13: at(PORTS.tls13),
      expired: at(PORTS.expired),
      counted: at(PORTS.counted),
      query: at(PORTS.query),
    },
    async stored(service) {
      const now = Date.now();
      const params = new URLSearchParams({
        "query.service_name": service,
        "query.start_time_min": new Date(now - 3_600_000).toISOString(),
        "query.start_time_max": new Date(now + 3_600_000).toISOString(),
        "query.search_depth": "10000",
      });
      const res = await fetch(`${query}/api/v3/traces?${params.toString()}`);
      if (res.status === 404) return 0; // nothing for the service
      if (!res.ok) throw new Error(`jaeger: ${res.status} ${await res.text()}`);
      let total = 0;
      for (const line of (await res.text()).split("\n")) {
        if (line.trim() === "") continue;
        for (const resource of (JSON.parse(line) as TracesChunk).result?.resourceSpans ?? []) {
          for (const scope of resource.scopeSpans ?? []) total += scope.spans?.length ?? 0;
        }
      }
      return total;
    },
    async arrived() {
      const text = await (await fetch(metrics)).text();
      const line =
        /^otelcol_receiver_accepted_spans\{receiver="otlp\/counted"[^}]*\} (\d+)$/mu.exec(text);
      return line === null ? 0 : Number(line[1]); // the series appears with the first span
    },
    async stop() {
      await container.stop({ timeout: 0 });
    },
  };
}

// ─── Caddy: an HTTP server where a gRPC service was expected ─────────────────

export const HTTP_GATEWAY_IMAGE = "caddy:2.10.2";

/** `/http503.Gateway/Call` is answered with a 503, and so on. */
export const GATEWAY_ANSWERS = {
  http401: 'respond "who are you" 401',
  http403: 'respond "not you" 403',
  http404: 'respond "no such route" 404',
  http429: 'respond "slow down" 429',
  http502: 'respond "bad gateway" 502',
  http503: 'respond "no healthy upstream" 503',
  http504: 'respond "upstream timed out" 504',
  html200: 'header Content-Type text/html\n\t\trespond "<html>maintenance</html>" 200',
} as const;

const GATEWAY_CONFIG = `{
	admin off
	auto_https off
	default_sni localhost
	servers :8080 {
		protocols h1 h2c
	}
}

(outcomes) {
${Object.entries(GATEWAY_ANSWERS)
  .map(([service, answer]) => `\thandle /${service}.Gateway/* {\n\t\t${answer}\n\t}`)
  .join("\n")}
	handle {
		respond "unrouted" 404
	}
}

:8080 {
	import outcomes
}

:8443 {
	tls /certs/server.crt /certs/server.key
	import outcomes
}
`;

export interface HttpGateway {
  /** Host ports: h2c and HTTP/2 over TLS. */
  readonly ports: { plain: number; tls: number };
  stop(): Promise<void>;
}

export async function startHttpGateway(pki: Pki): Promise<HttpGateway> {
  const container = await new GenericContainer(`${DOCKER_HUB}/library/${HTTP_GATEWAY_IMAGE}`)
    .withCopyContentToContainer([
      { content: GATEWAY_CONFIG, target: "/etc/caddy/Caddyfile", mode: 0o644 },
      { content: pki.serverCert, target: "/certs/server.crt", mode: 0o644 },
      { content: pki.serverKey, target: "/certs/server.key", mode: 0o644 },
    ])
    .withExposedPorts(8080, 8443)
    .withLabels(LABELS)
    .withWaitStrategy(Wait.forListeningPorts())
    .withStartupTimeout(60_000)
    .start();
  return {
    ports: { plain: container.getMappedPort(8080), tls: container.getMappedPort(8443) },
    async stop() {
      await container.stop({ timeout: 0 });
    },
  };
}
