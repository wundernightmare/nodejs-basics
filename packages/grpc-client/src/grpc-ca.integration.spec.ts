import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client, Metadata } from "@grpc/grpc-js";
import { afterAll, describe, expect, it } from "vitest";

import {
  containerRuntimeAvailable,
  createPki,
  EXPORT_METHOD,
  exportRequest,
  type GrpcServer,
  startGrpcServer,
  testCase,
  unique,
} from "@base/testing";

import { GrpcClients } from "./grpc-clients.js";

const runtime = await containerRuntimeAvailable();
const pass = (buffer: Buffer): Buffer => buffer;

describe.skipIf(!runtime)("gRPC target CA (integration)", { timeout: 120_000 }, () => {
  let server: GrpcServer | undefined;

  afterAll(async () => {
    await server?.stop();
  });

  it("uses caFile instead of the system roots on a real call", async () => {
    await testCase("NB-1376", "gRPC: a target CA file works without shared credentials");
    const pki = createPki();
    server = await startGrpcServer(pki);
    const dir = mkdtempSync(join(tmpdir(), "grpc-ca-"));
    const caFile = join(dir, "ca.pem");
    writeFileSync(caFile, pki.caPem, { mode: 0o600 });
    const grpc = new GrpcClients([
      { name: "api", address: `localhost:${server.ports.tls}`, caFile },
    ]);
    try {
      const client = grpc.client("api", Client);
      const service = unique("target-ca");
      const answer = await new Promise<Error | null>((resolve) => {
        client.makeUnaryRequest(
          EXPORT_METHOD,
          pass,
          pass,
          exportRequest({ service, spans: 1 }),
          new Metadata(),
          (err) => resolve(err),
        );
      });
      expect(answer).toBeNull();
      await expect.poll(() => server?.stored(service)).toBe(1);
    } finally {
      grpc.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
