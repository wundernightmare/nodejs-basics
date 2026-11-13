import { describe, expect, it } from "vitest";

import { Secret } from "@base/common";
import { testCase } from "@base/testing";

import { S3_DEFAULTS, s3ConfigFromEnv, s3Configured, validateS3Config } from "./s3-config.js";

describe("s3 config", () => {
  it("has the defaults of the contract and is off without a bucket", async () => {
    await testCase("NB-1206", "s3 config: defaults, env prefix, secret in a type");
    const config = s3ConfigFromEnv({});
    expect(config).toEqual(S3_DEFAULTS);
    expect(s3Configured(config)).toBe(false);
    expect([config.opTimeoutMs, config.transferTimeoutMs, config.maxAttempts]).toEqual([
      10_000, 60_000, 3,
    ]);
  });

  it("reads the prefixed keys and keeps the secret out of a dump", async () => {
    await testCase("NB-1206", "s3 config: defaults, env prefix, secret in a type");
    const config = s3ConfigFromEnv(
      {
        INGEST_S3_BUCKET: "events",
        INGEST_S3_ENDPOINT: "http://store:9000",
        INGEST_S3_INSECURE: "true",
        INGEST_S3_ACCESS_KEY_ID: "id",
        INGEST_S3_SECRET_ACCESS_KEY: "very-secret",
        INGEST_S3_OP_TIMEOUT_MS: "250",
        INGEST_S3_REQUEST_CHECKSUM: "when_supported",
        S3_BUCKET: "not-this-one",
      },
      "INGEST_",
    );
    expect(config).toMatchObject({
      bucket: "events",
      endpoint: "http://store:9000",
      opTimeoutMs: 250,
      requestChecksum: "when_supported",
    });
    expect(s3Configured(config)).toBe(true);
    expect(config.secretAccessKey.expose()).toBe("very-secret");
    expect(JSON.stringify(config)).not.toContain("very-secret");
  });

  it("reports every problem at once", async () => {
    await testCase("NB-1207", "s3 config: an unusable config is rejected with every reason");
    expect(() =>
      validateS3Config({
        endpoint: "http://user:pw@store:9000",
        accessKeyId: "id",
        opTimeoutMs: 0,
        uploadPartBytes: 1024,
        requestChecksum: "never" as "when_required",
      }),
    ).toThrow(
      /opTimeoutMs must be at least 1; uploadPartBytes must be at least 5242880 .*; requestChecksum must be .*; accessKeyId and secretAccessKey must be set together; endpoint is http:\/\/ — set insecure to allow it; endpoint must not carry credentials/u,
    );
    expect(() => validateS3Config({ endpoint: "not a url" })).toThrow("endpoint must be a URL");
    expect(() => validateS3Config({ endpoint: "ftp://store" })).toThrow("endpoint must be http(s)");
    expect(() => validateS3Config({ secretAccessKey: Secret.of("only-the-secret") })).toThrow(
      "must be set together",
    );
    expect(() => s3ConfigFromEnv({ S3_INSECURE: "yes" })).toThrow(
      "S3_INSECURE must be true or false",
    );
    expect(() => s3ConfigFromEnv({ S3_MAX_ATTEMPTS: "three" })).toThrow(
      "S3_MAX_ATTEMPTS must be an integer",
    );
  });
});
