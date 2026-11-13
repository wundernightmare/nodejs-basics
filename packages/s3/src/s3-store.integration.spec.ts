import { randomBytes } from "node:crypto";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { Secret } from "@base/common";
import { integration, meta, proxied, S3_TEST_CREDENTIALS, testCase, unique } from "@base/testing";
import type { ServiceProxy } from "@base/testing";

import { MIN_PART_BYTES, type S3Config } from "./s3-config.js";
import { S3Error, S3Store, S3TooLargeError } from "./s3-store.js";

/**
 * S3Store against a real S3-compatible store (RustFS) — signatures, paging,
 * multipart and 404s are the server's — and against one that is down or
 * silent (through Toxiproxy): every call ends within its own deadline. The
 * counterpart of golang-basics' libs/s3 s3_test.go.
 */
const infra = integration("s3", "toxiproxy");

describe.skipIf(infra.skip)("S3Store (integration, chaos)", () => {
  meta({
    epic: "nodejs-basics",
    feature: "s3",
    owner: "@team-platform",
    tags: ["s3", "chaos", "integration"],
  });

  const bucket = unique("s3").replaceAll("_", "-");
  let proxy: ServiceProxy;
  let store: S3Store;
  const stores: S3Store[] = [];

  function connect(overrides: Partial<S3Config> = {}): S3Store {
    const created = new S3Store({
      bucket,
      endpoint: infra.url("s3"),
      insecure: true,
      region: S3_TEST_CREDENTIALS.region,
      accessKeyId: S3_TEST_CREDENTIALS.accessKeyId,
      secretAccessKey: Secret.of(S3_TEST_CREDENTIALS.secretAccessKey),
      ...overrides,
    });
    stores.push(created);
    return created;
  }

  beforeAll(async () => {
    proxy = await proxied("s3");
    store = connect({ autoCreateBucket: true });
    await store.ensure();
  });

  afterEach(async () => {
    await proxy.reset();
  });

  afterAll(async () => {
    const keys: string[] = [];
    for await (const object of store.list("")) keys.push(object.key);
    await store.delete(keys);
    for (const s of stores) s.close();
  });

  it("puts, gets, heads and deletes an object", async () => {
    await testCase("NB-1219", "s3 against a store: put / get / head / delete round-trip");
    const key = "round/trip.bin";
    const body = randomBytes(64 * 1024);
    await store.put(key, body, "application/octet-stream");
    expect(await store.head(key)).toBe(body.byteLength);
    expect((await store.get(key, body.byteLength))?.equals(body)).toBe(true);
    await expect(store.get(key, body.byteLength - 1)).rejects.toBeInstanceOf(S3TooLargeError);

    await store.put(key, "replaced"); // idempotent overwrite
    expect((await store.get(key, 100))?.toString()).toBe("replaced");

    await store.delete([key, "round/never-existed"]);
    expect(await store.get(key, 100)).toBeUndefined();
    expect(await store.head(key)).toBeUndefined();
  });

  it("lists pages and prefixes", async () => {
    await testCase("NB-1220", "s3 against a store: listings in key order, by prefix");
    const keys = ["list/a/1", "list/a/2", "list/b/1", "list/top"];
    for (const key of keys) await store.put(key, key);
    const listed: string[] = [];
    for await (const object of store.list("list/")) listed.push(`${object.key}:${object.size}`);
    expect(listed).toEqual(keys.map((key) => `${key}:${key.length}`));
    expect(await store.listPrefixes("list/")).toEqual(["list/a/", "list/b/"]);
    expect(await store.listPrefixes("list/none/")).toEqual([]);
  });

  it("streams an upload in parts; the object appears on close only", async () => {
    await testCase("NB-1221", "s3 against a store: multipart upload is invisible until completed");
    const key = "upload/big.bin";
    const upload = connect({ uploadPartBytes: MIN_PART_BYTES }).upload(key, "application/zstd");
    const chunk = randomBytes(1024 * 1024);
    for (let i = 0; i < 11; i += 1) await upload.write(chunk); // 11 MiB: three parts
    expect(await store.head(key)).toBeUndefined();
    await upload.close();
    expect(await store.head(key)).toBe(11 * 1024 * 1024);
    const stored = await store.get(key, 12 * 1024 * 1024);
    expect(stored?.subarray(0, chunk.byteLength).equals(chunk)).toBe(true);
    expect(stored?.subarray(10 * chunk.byteLength).equals(chunk)).toBe(true);
  });

  it("an aborted upload leaves no object", async () => {
    await testCase("NB-1222", "s3 against a store: an aborted upload leaves nothing");
    const key = "upload/aborted.bin";
    const upload = connect({ uploadPartBytes: MIN_PART_BYTES }).upload(key);
    await upload.write(randomBytes(MIN_PART_BYTES + 1));
    await upload.abort();
    expect(await store.head(key)).toBeUndefined();
  });

  it("ensure reports a missing bucket", async () => {
    await testCase(
      "NB-1223",
      "s3 against a store: ensure tells a missing bucket from a present one",
    );
    const missing = connect({ bucket: `${bucket}-missing` });
    await expect(missing.ensure()).rejects.toBeInstanceOf(S3Error);
    await expect(connect().ensure()).resolves.toBeUndefined();
  });

  it("the store is down: a call fails within its deadline", async () => {
    await testCase("NB-1224", "S3 unreachable: every call is bounded");
    const down = connect({ endpoint: proxy.url, opTimeoutMs: 1_000, maxAttempts: 2 });
    await proxy.down();
    const started = Date.now();
    await expect(down.put("chaos/down", "x")).rejects.toMatchObject({ operation: "put" });
    await expect(down.ready()).rejects.toBeInstanceOf(S3Error);
    expect(Date.now() - started).toBeLessThan(2_500);
  });

  it("the store stops answering: a call ends at its deadline", async () => {
    await testCase("NB-1225", "S3 silent: a call ends at its own deadline");
    const silent = connect({ endpoint: proxy.url, opTimeoutMs: 400, transferTimeoutMs: 400 });
    await silent.put("chaos/silent", "x");
    await proxy.toxic("timeout", { timeout: 0 });
    for (const call of [
      (): Promise<unknown> => silent.put("chaos/silent", "y"),
      (): Promise<unknown> => silent.get("chaos/silent", 10),
      (): Promise<unknown> => silent.head("chaos/silent"),
    ]) {
      const started = Date.now();
      await expect(call()).rejects.toThrow("timed out after 400 ms");
      expect(Date.now() - started).toBeLessThan(1_500);
    }
    await proxy.reset();
    // The same client works again once the store answers. The put whose
    // answer was lost did reach the store: a timeout is not "not applied",
    // which is why a put has to be repeatable.
    await expect
      .poll(async () => (await silent.get("chaos/silent", 10).catch(() => undefined))?.toString(), {
        timeout: 10_000,
      })
      .toBe("y");
  });

  it("a reply cut short is an error, not a short object", async () => {
    await testCase("NB-1226", "S3 reply truncated: get fails instead of returning a short body");
    const key = "chaos/cut.bin";
    await store.put(key, randomBytes(256 * 1024));
    const cut = connect({ endpoint: proxy.url, transferTimeoutMs: 2_000, maxAttempts: 1 });
    await proxy.toxic("limit_data", { bytes: 4_096 });
    await expect(cut.get(key, 1024 * 1024)).rejects.toBeInstanceOf(S3Error);
  });
});
