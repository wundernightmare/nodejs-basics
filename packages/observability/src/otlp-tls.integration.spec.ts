import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-grpc";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";
import { BasicTracerProvider, BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { afterAll, describe, expect, it } from "vitest";

import {
  containerRuntimeAvailable,
  createPki,
  type GrpcServer,
  startGrpcServer,
  testCase,
  unique,
} from "@base/testing";

const runtime = await containerRuntimeAvailable();

describe.skipIf(!runtime)("OTLP over TLS (integration)", { timeout: 120_000 }, () => {
  let server: GrpcServer | undefined;

  afterAll(async () => {
    await server?.stop();
  });

  it("exports a span to a private-CA gRPC receiver", async () => {
    await testCase("NB-1379", "OTLP TLS: the standard CA variable drives a real export");
    const pki = createPki();
    server = await startGrpcServer(pki);
    const dir = mkdtempSync(join(tmpdir(), "otlp-ca-"));
    const caFile = join(dir, "ca.pem");
    writeFileSync(caFile, pki.caPem, { mode: 0o600 });
    const previous = process.env["OTEL_EXPORTER_OTLP_CERTIFICATE"];
    process.env["OTEL_EXPORTER_OTLP_CERTIFICATE"] = caFile;
    const service = unique("otlp-tls");
    const provider = new BasicTracerProvider({
      resource: resourceFromAttributes({ [ATTR_SERVICE_NAME]: service }),
      spanProcessors: [
        new BatchSpanProcessor(
          new OTLPTraceExporter({ url: `https://localhost:${server.ports.tls}` }),
        ),
      ],
    });
    try {
      provider.getTracer("test").startSpan("work").end();
      await provider.forceFlush();
      await expect.poll(() => server?.stored(service)).toBe(1);
    } finally {
      await provider.shutdown();
      if (previous === undefined) delete process.env["OTEL_EXPORTER_OTLP_CERTIFICATE"];
      else process.env["OTEL_EXPORTER_OTLP_CERTIFICATE"] = previous;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
