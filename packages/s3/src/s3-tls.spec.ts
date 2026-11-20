import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { Secret } from "@base/common";
import { createPki, testCase } from "@base/testing";

import { S3Store } from "./s3-store.js";

describe("S3Store TLS", () => {
  it("trusts a private CA on a real HTTPS request", async () => {
    await testCase("NB-1377", "S3 TLS: the configured CA verifies a real server certificate");
    const pki = createPki();
    const server = createServer({ key: pki.serverKey, cert: pki.serverCert }, (_req, res) => {
      res.writeHead(200);
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "localhost", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("no HTTPS port");
    const dir = mkdtempSync(join(tmpdir(), "s3-ca-"));
    const caFile = join(dir, "ca.pem");
    writeFileSync(caFile, pki.caPem, { mode: 0o600 });
    const store = new S3Store({
      bucket: "test",
      endpoint: `https://localhost:${address.port}`,
      caFile,
      accessKeyId: "test",
      secretAccessKey: Secret.of("test-secret"),
    });
    try {
      await expect(store.ready()).resolves.toBeUndefined();
    } finally {
      store.close();
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err === undefined ? resolve() : reject(err))),
      );
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
