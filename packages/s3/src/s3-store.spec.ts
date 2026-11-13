import { describe, expect, it } from "vitest";

import { Secret } from "@base/common";
import { captureMetrics, metricValue, testCase } from "@base/testing";

import { MIN_PART_BYTES } from "./s3-config.js";
import { S3Error, S3Store, S3TooLargeError, type S3Api } from "./s3-store.js";

interface Sent {
  name: string;
  input: Record<string, unknown>;
}

type Reply = (sent: Sent, signal: AbortSignal | undefined) => unknown;

/** The SDK client's stand-in: records what was sent, answers per command name. */
function fakeApi(
  replies: Record<string, Reply> = {},
): S3Api & { sent: Sent[]; destroyed: boolean } {
  const sent: Sent[] = [];
  return {
    sent,
    destroyed: false,
    async send(command, options) {
      const record = {
        name: (command as object).constructor.name.replace(/Command$/u, ""),
        input: (command as { input: Record<string, unknown> }).input,
      };
      sent.push(record);
      const reply = replies[record.name];
      return reply === undefined ? {} : await reply(record, options?.abortSignal);
    },
    destroy() {
      this.destroyed = true;
    },
  };
}

function awsError(name: string, status = 400): Error {
  return Object.assign(new Error(name), { name, $metadata: { httpStatusCode: status } });
}

async function* body(...chunks: string[]): AsyncGenerator<Uint8Array> {
  for (const chunk of chunks) yield await Promise.resolve(Buffer.from(chunk));
}

function store(api: S3Api, config: Record<string, unknown> = {}): S3Store {
  return new S3Store({ bucket: "b", ...config }, { api });
}

const pages: Reply = (sent) =>
  sent.input["ContinuationToken"] === undefined
    ? {
        Contents: [{ Key: "p/a", Size: 1 }],
        CommonPrefixes: [{ Prefix: "p/x/" }],
        IsTruncated: true,
        NextContinuationToken: "t1",
      }
    : { Contents: [{ Key: "p/b", Size: 2 }], CommonPrefixes: [{ Prefix: "p/y/" }, {}] };

describe("S3Store", () => {
  it("needs a bucket and a usable config", async () => {
    await testCase("NB-1208", "s3 store: constructed without I/O, rejects what it cannot run with");
    expect(() => new S3Store({}, { api: fakeApi() })).toThrow("bucket is required");
    expect(() => store(fakeApi(), { maxAttempts: 0 })).toThrow("maxAttempts");
    expect(() => new S3Store({ bucket: "b", caFile: "/nonexistent/ca.pem" })).toThrow("ENOENT");
    const real = new S3Store({
      bucket: "b",
      endpoint: "https://store.example",
      accessKeyId: "id",
      secretAccessKey: Secret.of("secret"),
    });
    expect(real.bucket).toBe("b");
    real.close();
  });

  it("puts, gets, heads and deletes", async () => {
    await testCase("NB-1209", "s3 store: put / get / head / delete address the bucket");
    const api = fakeApi({
      GetObject: () => ({ ContentLength: 5, Body: body("he", "llo") }),
      HeadObject: () => ({ ContentLength: 5 }),
    });
    const s3 = store(api);
    await s3.put("k", "hello", "text/plain");
    await s3.put("raw", new Uint8Array([1, 2]));
    expect((await s3.get("k", 10))?.toString()).toBe("hello");
    expect(await s3.head("k")).toBe(5);
    await s3.delete(["k", "raw"]);
    s3.close();

    expect(api.sent.map((s) => s.name)).toEqual([
      "PutObject",
      "PutObject",
      "GetObject",
      "HeadObject",
      "DeleteObjects",
    ]);
    expect(api.sent[0]?.input).toMatchObject({
      Bucket: "b",
      Key: "k",
      ContentLength: 5,
      ContentType: "text/plain",
    });
    expect(api.sent[1]?.input).not.toHaveProperty("ContentType");
    expect(api.sent[4]?.input).toMatchObject({
      Delete: { Objects: [{ Key: "k" }, { Key: "raw" }], Quiet: true },
    });
    expect(api.destroyed).toBe(true);
  });

  it("treats a missing key as an answer on get and head, however it is spelt", async () => {
    await testCase("NB-1210", "s3 store: a missing key is an answer, not an error");
    const capture = captureMetrics();
    try {
      for (const failure of [
        awsError("NoSuchKey", 404),
        awsError("NotFound", 404),
        awsError("UnknownError", 404),
      ]) {
        const s3 = new S3Store(
          { bucket: "b" },
          {
            api: fakeApi({
              GetObject: () => Promise.reject(failure),
              HeadObject: () => Promise.reject(failure),
            }),
          },
        );
        expect(await s3.get("gone", 10)).toBeUndefined();
        expect(await s3.head("gone")).toBeUndefined();
      }
      const text = await capture.scrape();
      expect(metricValue(text, "s3_request_errors_total", { operation: "get" })).toBe(-1);
      expect(metricValue(text, "s3_request_duration_seconds_count", { operation: "get" })).toBe(3);
    } finally {
      await capture.stop();
    }
  });

  it("refuses an object over the limit, declared or not", async () => {
    await testCase("NB-1211", "s3 store: get is bounded by the caller's limit");
    let destroyed = 0;
    const stream = (...chunks: string[]): AsyncIterable<Uint8Array> & { destroy(): void } =>
      Object.assign(body(...chunks), {
        destroy: () => {
          destroyed += 1;
        },
      });
    const declared = store(
      fakeApi({ GetObject: () => ({ ContentLength: 11, Body: stream("x") }) }),
    );
    await expect(declared.get("k", 10)).rejects.toBeInstanceOf(S3TooLargeError);
    const undeclared = store(
      fakeApi({ GetObject: () => ({ Body: stream("12345", "67890", "1") }) }),
    );
    await expect(undeclared.get("k", 10)).rejects.toThrow("more than 10 bytes");
    const exact = store(fakeApi({ GetObject: () => ({ Body: stream("12345", "67890") }) }));
    expect((await exact.get("k", 10))?.byteLength).toBe(10);
    expect(destroyed).toBe(3);
    expect(await store(fakeApi()).get("empty", 10)).toEqual(Buffer.alloc(0));
  });

  it("wraps a failure with its operation and counts it", async () => {
    await testCase("NB-1212", "s3 store: failures carry the operation and are counted");
    const capture = captureMetrics();
    try {
      const s3 = new S3Store(
        { bucket: "b" },
        {
          api: fakeApi({
            PutObject: () => Promise.reject(awsError("SlowDown", 503)),
            HeadObject: () => Promise.reject(awsError("AccessDenied", 403)),
          }),
        },
      );
      const failure = await s3.put("k", "x").catch((err: unknown) => err);
      expect(failure).toBeInstanceOf(S3Error);
      expect(failure).toMatchObject({ operation: "put", key: "k" });
      expect((failure as Error).message).toBe('s3: put "k": SlowDown');
      await expect(s3.head("k")).rejects.toThrow('s3: head "k": AccessDenied');

      const text = await capture.scrape();
      expect(metricValue(text, "s3_request_errors_total", { operation: "put" })).toBe(1);
      expect(metricValue(text, "s3_request_errors_total", { operation: "head" })).toBe(1);
    } finally {
      await capture.stop();
    }
  });

  it("bounds a call the store never answers", async () => {
    await testCase("NB-1213", "s3 store: every call carries its own deadline");
    let aborted = false;
    const s3 = store(
      fakeApi({
        HeadBucket: (_sent, signal) =>
          new Promise(() => {
            signal?.addEventListener("abort", () => {
              aborted = true;
            });
          }),
      }),
      { opTimeoutMs: 30 },
    );
    const started = performance.now();
    await expect(s3.ready()).rejects.toThrow('s3: head_bucket "": timed out after 30 ms');
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(aborted).toBe(true);
  });

  it("lists page by page, objects and prefixes", async () => {
    await testCase("NB-1214", "s3 store: listings follow the continuation token");
    const api = fakeApi({ ListObjectsV2: pages });
    const s3 = store(api);

    const keys: string[] = [];
    for await (const object of s3.list("p/")) keys.push(`${object.key}:${object.size}`);
    expect(keys).toEqual(["p/a:1", "p/b:2"]);
    expect(await s3.listPrefixes("p/")).toEqual(["p/x/", "p/y/"]);
    expect(api.sent.map((s) => [s.input["ContinuationToken"], s.input["Delimiter"]])).toEqual([
      [undefined, undefined],
      ["t1", undefined],
      [undefined, "/"],
      ["t1", "/"],
    ]);
  });

  it("deletes a thousand at a time and reports every failed batch", async () => {
    await testCase("NB-1215", "s3 store: delete batches and keeps going past a failure");
    let call = 0;
    const api = fakeApi({
      DeleteObjects: () => {
        call += 1;
        if (call === 1) return { Errors: [{ Key: "k0", Code: "AccessDenied" }] };
        if (call === 3) throw awsError("InternalError", 500);
        return {};
      },
    });
    const keys = Array.from({ length: 2_500 }, (_, i) => `k${i}`);
    const failure = await store(api)
      .delete(keys)
      .catch((err: unknown) => err);
    expect(
      api.sent.map((s) => (s.input["Delete"] as { Objects: unknown[] }).Objects.length),
    ).toEqual([1_000, 1_000, 500]);
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors.map((e: Error) => e.message)).toEqual([
      's3: delete "k0": 1 of 1000 keys not deleted, first: k0 (AccessDenied)',
      's3: delete "k2000": InternalError',
    ]);
    await store(fakeApi()).delete([]);
  });

  it("ensure creates a missing bucket only when asked to", async () => {
    await testCase("NB-1216", "s3 store: ensure verifies the bucket and may create it");
    const missing = { HeadBucket: () => Promise.reject(awsError("NotFound", 404)) };
    await expect(store(fakeApi(missing)).ensure()).rejects.toThrow("head_bucket");

    const creating = fakeApi(missing);
    await store(creating, { autoCreateBucket: true }).ensure();
    expect(creating.sent.map((s) => s.name)).toEqual(["HeadBucket", "CreateBucket"]);

    // Lost the race to another instance: the bucket is there, which is what was asked for.
    const raced = fakeApi({
      ...missing,
      CreateBucket: () => Promise.reject(awsError("BucketAlreadyOwnedByYou", 409)),
    });
    await store(raced, { autoCreateBucket: true }).ensure();

    const denied = fakeApi({
      ...missing,
      CreateBucket: () => Promise.reject(awsError("AccessDenied", 403)),
    });
    await expect(store(denied, { autoCreateBucket: true }).ensure()).rejects.toThrow(
      "create_bucket",
    );
    // Not "missing": credentials are wrong, creating would not help.
    const forbidden = fakeApi({ HeadBucket: () => Promise.reject(awsError("Forbidden", 403)) });
    await expect(store(forbidden, { autoCreateBucket: true }).ensure()).rejects.toThrow(
      "Forbidden",
    );
    expect(forbidden.sent).toHaveLength(1);

    const present = fakeApi();
    await store(present, { autoCreateBucket: true }).ensure();
    expect(present.sent.map((s) => s.name)).toEqual(["HeadBucket"]);
  });

  it("uploads a small object as one put", async () => {
    await testCase("NB-1217", "s3 upload: parts of a fixed size, one put when it fits");
    const api = fakeApi();
    const upload = store(api).upload("small", "text/plain");
    await upload.write("hel");
    await upload.write(Buffer.from("lo"));
    await upload.close();
    await upload.close(); // idempotent
    expect(upload.size).toBe(5);
    expect(api.sent).toHaveLength(1);
    expect(api.sent[0]).toMatchObject({
      name: "PutObject",
      input: { Key: "small", ContentLength: 5, ContentType: "text/plain" },
    });
    await expect(upload.write("more")).rejects.toThrow("already finished");
  });

  it("streams a large object in parts and completes it", async () => {
    await testCase("NB-1217", "s3 upload: parts of a fixed size, one put when it fits");
    const api = fakeApi({
      CreateMultipartUpload: () => ({ UploadId: "u1" }),
      UploadPart: (sent) => ({ ETag: `etag-${String(sent.input["PartNumber"])}` }),
    });
    const upload = store(api, { uploadPartBytes: MIN_PART_BYTES }).upload("big");
    const chunk = Buffer.alloc(2 * 1024 * 1024, 7);
    for (let i = 0; i < 6; i += 1) await upload.write(chunk); // 12 MiB: 5 + 5 + 2
    await upload.close();

    expect(api.sent.map((s) => s.name)).toEqual([
      "CreateMultipartUpload",
      "UploadPart",
      "UploadPart",
      "UploadPart",
      "CompleteMultipartUpload",
    ]);
    expect(api.sent.slice(1, 4).map((s) => s.input["ContentLength"])).toEqual([
      MIN_PART_BYTES,
      MIN_PART_BYTES,
      2 * 1024 * 1024,
    ]);
    expect(api.sent[4]?.input["MultipartUpload"]).toEqual({
      Parts: [
        { PartNumber: 1, ETag: "etag-1" },
        { PartNumber: 2, ETag: "etag-2" },
        { PartNumber: 3, ETag: "etag-3" },
      ],
    });
  });

  it("aborts an upload that fails midway, and one the writer gives up", async () => {
    await testCase("NB-1218", "s3 upload: a failed or abandoned upload is aborted");
    const failing = fakeApi({
      CreateMultipartUpload: () => ({ UploadId: "u1" }),
      CompleteMultipartUpload: () => Promise.reject(awsError("InternalError", 500)),
    });
    const upload = store(failing, { uploadPartBytes: MIN_PART_BYTES }).upload("big");
    await upload.write(Buffer.alloc(MIN_PART_BYTES + 1));
    await expect(upload.close()).rejects.toThrow("complete_upload");
    expect(failing.sent.at(-1)).toMatchObject({
      name: "AbortMultipartUpload",
      input: { UploadId: "u1" },
    });

    const abandoned = fakeApi({
      CreateMultipartUpload: () => ({ UploadId: "u2" }),
      AbortMultipartUpload: () => Promise.reject(awsError("InternalError", 500)),
    });
    const given = store(abandoned, { uploadPartBytes: MIN_PART_BYTES }).upload("big");
    await given.write(Buffer.alloc(MIN_PART_BYTES));
    await given.abort(); // its own failure is counted, not thrown
    await given.abort();
    expect(abandoned.sent.filter((s) => s.name === "AbortMultipartUpload")).toHaveLength(1);

    const nothingSent = fakeApi();
    const early = store(nothingSent).upload("k");
    await early.write("x");
    await early.abort();
    expect(nothingSent.sent).toEqual([]);

    const noId = store(fakeApi(), { uploadPartBytes: MIN_PART_BYTES }).upload("k");
    await expect(noId.write(Buffer.alloc(MIN_PART_BYTES))).rejects.toThrow("no upload id");
  });
});
