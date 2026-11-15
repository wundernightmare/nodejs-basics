/**
 * A real OpenTelemetry Collector running the configuration the repository
 * ships (docker/otel-collector/config.yaml), in front of a real Jaeger — for
 * the suite that asserts the tail-sampling policies
 * (packages/observability/src/tail-sampling.integration.spec.ts). The file is
 * copied in as it is: what is tested is the pair "image + config" that
 * docker/observability.yml runs.
 *
 *   const jaeger = await startJaeger();
 *   const collector = await startCollector(jaeger, { baselinePercent: 0 });
 *   // export to collector.otlpGrpc, then ask jaeger.traces(service)
 *
 * A collector that exits instead of becoming healthy has refused the
 * configuration: startCollector throws with its log — a failure of the file
 * under test, never a reason to skip.
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import {
  GenericContainer,
  getContainerRuntimeClient,
  type StartedTestContainer,
  Wait,
} from "testcontainers";

const DOCKER_HUB = process.env["DOCKER_HUB"] ?? "docker.io";
const ROOT = fileURLToPath(new URL("../../../", import.meta.url));

/** The collector config the repository ships, and the compose file that runs it. */
export const COLLECTOR_CONFIG_PATH = `${ROOT}docker/otel-collector/config.yaml`;
export const OBSERVABILITY_COMPOSE_PATH = `${ROOT}docker/observability.yml`;

/** The images of this fixture — the ones docker/observability.yml runs. */
export const COLLECTOR_IMAGE = "otel/opentelemetry-collector-contrib:0.162.0";
export const JAEGER_IMAGE = "jaegertracing/jaeger:2.21.0";

const LABELS = { "nodejs-basics.role": "integration-test" };
const HOST_GATEWAY = [{ host: "host.docker.internal", ipAddress: "host-gateway" }];

/**
 * Whether a suite that starts its own containers can run. Locally a machine
 * without a container runtime skips such a suite; on CI (`CI` set) the answer
 * is always yes, so a missing runtime fails the suite instead of hiding it.
 */
export async function containerRuntimeAvailable(): Promise<boolean> {
  if (process.env["CI"]) return true;
  try {
    await getContainerRuntimeClient();
    return true;
  } catch {
    return false;
  }
}

export interface StoredSpan {
  /** The span's name. */
  operationName: string;
  /** Lowercase hex, as in a span context. */
  spanId: string;
  /** Lowercase hex; "" for a root. */
  parentSpanId: string;
  /** service.name of the resource that sent it. */
  service: string;
  /** Attributes by key; a value is whatever OTLP/JSON holds (stringValue, intValue, …) unwrapped. */
  attributes: Record<string, unknown>;
  /** Names of its events. */
  events: string[];
  /** W3C tracestate as it was exported; "" when there is none. */
  traceState: string;
}

export interface StoredTrace {
  /** Lowercase hex, as in a span context. */
  traceID: string;
  spans: StoredSpan[];
}

interface OtlpValue {
  stringValue?: string;
  intValue?: string | number;
  doubleValue?: number;
  boolValue?: boolean;
}

interface OtlpAttribute {
  key: string;
  value?: OtlpValue;
}

interface OtlpSpan {
  traceId: string;
  spanId?: string;
  parentSpanId?: string;
  name: string;
  traceState?: string;
  attributes?: OtlpAttribute[];
  events?: Array<{ name?: string }>;
}

/** One chunk of Jaeger's /api/v3/traces stream: OTLP/JSON. */
interface TracesChunk {
  result?: {
    resourceSpans?: Array<{
      resource?: { attributes?: OtlpAttribute[] };
      scopeSpans?: Array<{ spans?: OtlpSpan[] }>;
    }>;
  };
}

function unwrap(attributes: OtlpAttribute[] | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const { key, value } of attributes ?? []) {
    out[key] =
      value?.stringValue ??
      (value?.intValue === undefined ? undefined : Number(value.intValue)) ??
      value?.doubleValue ??
      value?.boolValue;
  }
  return out;
}

/** An id as a span context has it: Jaeger answers in hex, OTLP/JSON proper would be base64. */
function hexId(id: string | undefined): string {
  if (id === undefined || id === "") return "";
  return /^[0-9a-f]+$/iu.test(id) ? id.toLowerCase() : Buffer.from(id, "base64").toString("hex");
}

/** The traces in the chunks of one answer of /api/v3/traces. */
function parseTraces(body: string): StoredTrace[] {
  const byTrace = new Map<string, StoredSpan[]>();
  for (const line of body.split("\n")) {
    if (line.trim() === "") continue;
    const chunk = JSON.parse(line) as TracesChunk;
    for (const resource of chunk.result?.resourceSpans ?? []) {
      const serviceName = unwrap(resource.resource?.attributes)["service.name"];
      const service = typeof serviceName === "string" ? serviceName : "";
      for (const scope of resource.scopeSpans ?? []) {
        for (const span of scope.spans ?? []) {
          const traceID = hexId(span.traceId);
          const spans = byTrace.get(traceID) ?? [];
          spans.push({
            operationName: span.name,
            spanId: hexId(span.spanId),
            parentSpanId: hexId(span.parentSpanId),
            service,
            attributes: unwrap(span.attributes),
            events: (span.events ?? []).map((e) => e.name ?? ""),
            traceState: span.traceState ?? "",
          });
          byTrace.set(traceID, spans);
        }
      }
    }
  }
  return [...byTrace].map(([traceID, spans]) => ({ traceID, spans }));
}

export interface Jaeger {
  /** The host port of its OTLP/gRPC receiver — where a collector exports to. */
  readonly otlpPort: number;
  /** Every trace of `service` it has stored. */
  traces(service: string): Promise<StoredTrace[]>;
  /** The spans it has stored of one trace (of every service); none when it has none. */
  trace(traceId: string): Promise<StoredSpan[]>;
  stop(): Promise<void>;
}

export async function startJaeger(): Promise<Jaeger> {
  const container = await new GenericContainer(`${DOCKER_HUB}/${JAEGER_IMAGE}`)
    .withExposedPorts(4317, 16686)
    .withLabels(LABELS)
    .withWaitStrategy(Wait.forHttp("/", 16686))
    .withStartupTimeout(90_000)
    .start();
  const query = `http://${container.getHost()}:${container.getMappedPort(16686)}`;
  return {
    otlpPort: container.getMappedPort(4317),
    async traces(service) {
      const now = Date.now();
      const params = new URLSearchParams({
        "query.service_name": service,
        "query.start_time_min": new Date(now - 3_600_000).toISOString(),
        "query.start_time_max": new Date(now + 60_000).toISOString(),
        "query.search_depth": "10000",
      });
      // A stream of OTLP/JSON chunks; 404 when it holds nothing for the service.
      const res = await fetch(`${query}/api/v3/traces?${params.toString()}`);
      if (res.status === 404) return [];
      if (!res.ok) throw new Error(`jaeger: ${res.status} ${await res.text()}`);
      return parseTraces(await res.text());
    },
    async trace(traceId) {
      const res = await fetch(`${query}/api/v3/traces/${traceId}`);
      if (res.status === 404) return [];
      if (!res.ok) throw new Error(`jaeger: ${res.status} ${await res.text()}`);
      return parseTraces(await res.text()).flatMap((t) => t.spans);
    },
    async stop() {
      await container.stop({ timeout: 0 });
    },
  };
}

export interface Collector {
  /** `http://host:port` of its OTLP/gRPC receiver — OTEL_EXPORTER_OTLP_ENDPOINT for a service. */
  readonly otlpGrpc: string;
  stop(): Promise<void>;
}

export interface CollectorOptions {
  /** OTEL_TAIL_SAMPLING_PERCENTAGE: the share of otherwise uninteresting traces kept. */
  baselinePercent: number;
  /** OTEL_TAIL_DECISION_WAIT; the shipped default (10s) is sized for real traces. */
  decisionWait?: string;
}

export async function startCollector(
  jaeger: Jaeger,
  options: CollectorOptions,
): Promise<Collector> {
  const config = await readFile(COLLECTOR_CONFIG_PATH, "utf8");
  let container: StartedTestContainer;
  const logs: string[] = [];
  try {
    container = await new GenericContainer(`${DOCKER_HUB}/${COLLECTOR_IMAGE}`)
      .withCommand(["--config=/etc/otelcol/config.yaml"])
      .withCopyContentToContainer([
        { content: config, target: "/etc/otelcol/config.yaml", mode: 0o644 },
      ])
      .withEnvironment({
        OTEL_TAIL_DECISION_WAIT: options.decisionWait ?? "1s",
        OTEL_TAIL_SAMPLING_PERCENTAGE: String(options.baselinePercent),
        // Through the host: no container network needed.
        OTEL_COLLECTOR_TRACES_ENDPOINT: `host.docker.internal:${jaeger.otlpPort}`,
      })
      .withExtraHosts(HOST_GATEWAY)
      .withExposedPorts(4317, 13133)
      .withLabels(LABELS)
      .withLogConsumer((stream) => {
        stream.on("data", (line: string) => {
          logs.push(line);
        });
      })
      // The image has no shell: health is asked from the host.
      .withWaitStrategy(Wait.forHttp("/", 13133))
      .withStartupTimeout(60_000)
      .start();
  } catch (err) {
    throw new Error(
      `the collector did not accept ${COLLECTOR_CONFIG_PATH}:\n${logs.join("").slice(-4000)}`,
      { cause: err },
    );
  }
  return {
    otlpGrpc: `http://${container.getHost()}:${container.getMappedPort(4317)}`,
    async stop() {
      await container.stop({ timeout: 0 });
    },
  };
}
