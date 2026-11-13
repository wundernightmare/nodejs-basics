import { readFileSync } from "node:fs";

import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateBucketCommand,
  CreateMultipartUploadCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
  type CompletedPart,
} from "@aws-sdk/client-s3";
import { metrics, SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";
import type { Counter, Histogram, Meter, Tracer } from "@opentelemetry/api";

import { s3Configured, validateS3Config, type S3Config } from "./s3-config.js";

/** The object at a key is larger than the caller allowed. */
export class S3TooLargeError extends Error {
  constructor(key: string, detail: string) {
    super(`s3: get ${JSON.stringify(key)}: object too large: ${detail}`);
    this.name = "S3TooLargeError";
  }
}

/** A call that failed, with the operation and the key it was for. */
export class S3Error extends Error {
  constructor(
    public readonly operation: S3Operation,
    public readonly key: string,
    public override readonly cause: unknown,
  ) {
    super(
      `s3: ${operation} ${JSON.stringify(key)}: ${cause instanceof Error ? cause.message : "unknown error"}`,
    );
    this.name = "S3Error";
  }
}

/** The `operation` label of the metrics and the span names. */
export type S3Operation =
  | "put"
  | "get"
  | "head"
  | "list"
  | "delete"
  | "head_bucket"
  | "create_bucket"
  | "create_upload"
  | "upload_part"
  | "complete_upload"
  | "abort_upload";

export interface S3Object {
  key: string;
  size: number;
  lastModified: Date | undefined;
}

/** What the store needs from the SDK client: a stand-in in a unit test. */
export interface S3Api {
  send(command: unknown, options?: { abortSignal?: AbortSignal }): Promise<unknown>;
  destroy(): void;
}

export interface S3StoreOptions {
  /** Meter for the s3_* instruments. Default: the global one. */
  meter?: Meter;
  tracer?: Tracer;
  /** Replaces the SDK client. */
  api?: S3Api;
}

const LATENCY_BUCKETS_SECONDS = [
  0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60,
];

const DELETE_BATCH = 1_000;

interface ListPage {
  Contents?: Array<{ Key?: string; Size?: number; LastModified?: Date }>;
  CommonPrefixes?: Array<{ Prefix?: string }>;
  IsTruncated?: boolean;
  NextContinuationToken?: string;
}

const NOT_FOUND = new Set(["NoSuchKey", "NotFound", "NoSuchBucket"]);

/** A missing key or bucket: the modelled errors, or the bare 404 a HEAD answers with. */
function isNotFound(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const { name, $metadata } = err as { name?: string; $metadata?: { httpStatusCode?: number } };
  return (name !== undefined && NOT_FOUND.has(name)) || $metadata?.httpStatusCode === 404;
}

function buildClient(config: S3Config): S3Client {
  const checksum = config.requestChecksum === "when_supported" ? "WHEN_SUPPORTED" : "WHEN_REQUIRED";
  const agent = {
    maxSockets: config.maxConnsPerHost,
    keepAlive: true,
    ...(config.caFile === "" ? {} : { ca: readFileSync(config.caFile) }),
  };
  return new S3Client({
    region: config.region,
    forcePathStyle: config.usePathStyle,
    maxAttempts: config.maxAttempts,
    requestChecksumCalculation: checksum,
    responseChecksumValidation: checksum,
    ...(config.endpoint === "" ? {} : { endpoint: config.endpoint }),
    // Static credentials when given; otherwise the SDK's default chain
    // (IRSA / web identity, instance role, shared config).
    ...(config.accessKeyId === ""
      ? {}
      : {
          credentials: {
            accessKeyId: config.accessKeyId,
            secretAccessKey: config.secretAccessKey.expose(),
          },
        }),
    requestHandler: {
      connectionTimeout: config.dialTimeoutMs,
      httpAgent: agent,
      httpsAgent: agent,
    },
  });
}

/**
 * An object-storage client bound to one bucket — the counterpart of
 * golang-basics' libs/s3: AWS S3 or an S3-compatible store (S3_ENDPOINT).
 *
 *   const store = new S3Store(s3ConfigFromEnv(process.env, "INGEST_"));
 *   health.register("s3", () => store.ready(), { optional: true });
 *   await store.put(key, body, "application/zstd");
 *   // on shutdown:
 *   store.close();
 *
 * The constructor does no network I/O, so a store that is down does not stop
 * a service that can work without it from starting; `ensure()` verifies the
 * bucket when the service wants to know at boot.
 *
 * Every call runs under its own deadline (opTimeoutMs, or transferTimeoutMs
 * for a call that moves a large body) with the SDK's retries inside it, is a
 * CLIENT span and one observation of s3_request_duration_seconds — the whole
 * call, retries included: what the caller waited.
 */
export class S3Store {
  readonly #config: S3Config;
  readonly #api: S3Api;
  readonly #tracer: Tracer;
  readonly #duration: Histogram;
  readonly #errors: Counter;

  constructor(config: Partial<S3Config>, options: S3StoreOptions = {}) {
    this.#config = validateS3Config(config);
    if (!s3Configured(this.#config)) throw new Error("s3: bucket is required");
    this.#api = options.api ?? buildClient(this.#config);
    this.#tracer = options.tracer ?? trace.getTracer("s3");
    const meter = options.meter ?? metrics.getMeter("s3");
    this.#duration = meter.createHistogram("s3_request_duration_seconds", {
      description: "S3 call latency in seconds by operation, the client's retries included.",
      unit: "s",
      advice: { explicitBucketBoundaries: LATENCY_BUCKETS_SECONDS },
    });
    this.#errors = meter.createCounter("s3_request_errors_total", {
      description:
        "S3 calls that failed (timeouts included; a missing key on get/head is not a failure) by operation.",
    });
  }

  get bucket(): string {
    return this.#config.bucket;
  }

  /** Releases the connections. */
  close(): void {
    this.#api.destroy();
  }

  /**
   * Stores body at key, replacing what is there. Idempotent: a writer that
   * names its objects deterministically can repeat a put whose answer was
   * lost and still end with one object.
   */
  async put(key: string, body: Uint8Array | string, contentType?: string): Promise<void> {
    const bytes = typeof body === "string" ? Buffer.from(body) : body;
    await this.#call("put", key, this.#config.opTimeoutMs, false, (abortSignal) =>
      this.#api.send(
        new PutObjectCommand({
          Bucket: this.#config.bucket,
          Key: key,
          Body: bytes,
          ContentLength: bytes.byteLength,
          ...(contentType === undefined || contentType === "" ? {} : { ContentType: contentType }),
        }),
        { abortSignal },
      ),
    );
  }

  /**
   * The whole object at key, in memory — refusing one larger than limitBytes
   * with {@link S3TooLargeError}: the caller decides how much one object may
   * cost it. undefined when there is no such key.
   */
  async get(key: string, limitBytes: number): Promise<Buffer | undefined> {
    const found = await this.#call(
      "get",
      key,
      this.#config.transferTimeoutMs,
      true,
      async (abortSignal) => {
        const out = (await this.#api.send(
          new GetObjectCommand({ Bucket: this.#config.bucket, Key: key }),
          { abortSignal },
        )) as { ContentLength?: number; Body?: AsyncIterable<Uint8Array> & { destroy?(): void } };
        const stream = out.Body;
        if (stream === undefined) return Buffer.alloc(0);
        try {
          if (out.ContentLength !== undefined && out.ContentLength > limitBytes) {
            throw new S3TooLargeError(key, `${out.ContentLength} > ${limitBytes} bytes`);
          }
          const chunks: Uint8Array[] = [];
          let size = 0;
          for await (const chunk of stream) {
            size += chunk.byteLength;
            if (size > limitBytes) throw new S3TooLargeError(key, `more than ${limitBytes} bytes`);
            chunks.push(chunk);
          }
          return Buffer.concat(chunks, size);
        } finally {
          stream.destroy?.();
        }
      },
    );
    return found.found ? found.value : undefined;
  }

  /** The size of the object at key; undefined when there is no such key. */
  async head(key: string): Promise<number | undefined> {
    const found = await this.#call(
      "head",
      key,
      this.#config.opTimeoutMs,
      true,
      async (abortSignal) => {
        const out = (await this.#api.send(
          new HeadObjectCommand({ Bucket: this.#config.bucket, Key: key }),
          { abortSignal },
        )) as { ContentLength?: number };
        return out.ContentLength ?? 0;
      },
    );
    return found.found ? found.value : undefined;
  }

  /** The objects under prefix in key order, a page (one call under opTimeoutMs) at a time. */
  async *list(prefix: string): AsyncGenerator<S3Object, void, void> {
    for await (const page of this.#pages(prefix, undefined)) {
      for (const entry of page.Contents ?? []) {
        yield { key: entry.Key ?? "", size: entry.Size ?? 0, lastModified: entry.LastModified };
      }
    }
  }

  /**
   * The "directories" directly under prefix — the common prefixes up to the
   * next "/" — in key order. prefix should end in "/" (or be empty for the root).
   */
  async listPrefixes(prefix: string): Promise<string[]> {
    const prefixes: string[] = [];
    for await (const page of this.#pages(prefix, "/")) {
      for (const entry of page.CommonPrefixes ?? []) {
        if (entry.Prefix !== undefined) prefixes.push(entry.Prefix);
      }
    }
    return prefixes;
  }

  /**
   * Removes keys, a thousand per call; keys that do not exist are not an
   * error. It keeps going past a failed batch and reports every failure.
   */
  async delete(keys: readonly string[]): Promise<void> {
    const failures: unknown[] = [];
    for (let at = 0; at < keys.length; at += DELETE_BATCH) {
      const batch = keys.slice(at, at + DELETE_BATCH);
      try {
        await this.#call(
          "delete",
          batch[0] ?? "",
          this.#config.opTimeoutMs,
          false,
          async (abortSignal) => {
            const out = (await this.#api.send(
              new DeleteObjectsCommand({
                Bucket: this.#config.bucket,
                Delete: { Objects: batch.map((Key) => ({ Key })), Quiet: true },
              }),
              { abortSignal },
            )) as { Errors?: Array<{ Key?: string; Code?: string; Message?: string }> };
            const refused = out.Errors ?? [];
            if (refused.length > 0) {
              const first = refused[0];
              throw new Error(
                `${refused.length} of ${batch.length} keys not deleted, first: ${first?.Key ?? "?"} (${first?.Code ?? "?"})`,
              );
            }
          },
        );
      } catch (err) {
        failures.push(err);
      }
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "s3: delete failed");
  }

  /**
   * Verifies the bucket is reachable with these credentials and, with
   * autoCreateBucket, creates it when it is missing (local stacks and tests;
   * in a cluster the bucket is provisioned).
   */
  async ensure(): Promise<void> {
    try {
      await this.ready();
      return;
    } catch (err) {
      if (!this.#config.autoCreateBucket || !(err instanceof S3Error) || !isNotFound(err.cause)) {
        throw err;
      }
    }
    try {
      await this.#call("create_bucket", "", this.#config.opTimeoutMs, false, (abortSignal) =>
        this.#api.send(new CreateBucketCommand({ Bucket: this.#config.bucket }), { abortSignal }),
      );
    } catch (err) {
      // Somebody else created it meanwhile: that is what was asked for.
      const name = err instanceof S3Error ? (err.cause as { name?: string }).name : undefined;
      if (name !== "BucketAlreadyOwnedByYou" && name !== "BucketAlreadyExists") throw err;
    }
  }

  /** A readiness probe: the bucket answers a HEAD. */
  async ready(): Promise<void> {
    await this.#call("head_bucket", "", this.#config.opTimeoutMs, false, (abortSignal) =>
      this.#api.send(new HeadBucketCommand({ Bucket: this.#config.bucket }), { abortSignal }),
    );
  }

  /** Starts a streaming upload of an object of unknown size: see {@link S3Upload}. */
  upload(key: string, contentType?: string): S3Upload {
    const config = this.#config;
    const call = <V>(
      operation: S3Operation,
      timeoutMs: number,
      run: (abortSignal: AbortSignal) => Promise<V>,
    ): Promise<V> =>
      this.#call(operation, key, timeoutMs, false, run).then((result) => result.value as V);
    return new S3Upload(key, contentType, config, this.#api, call);
  }

  async *#pages(
    prefix: string,
    delimiter: string | undefined,
  ): AsyncGenerator<ListPage, void, void> {
    let token: string | undefined;
    for (;;) {
      const page = await this.#page(prefix, delimiter, token);
      yield page;
      if (page.IsTruncated !== true || page.NextContinuationToken === undefined) return;
      token = page.NextContinuationToken;
    }
  }

  async #page(
    prefix: string,
    delimiter: string | undefined,
    token: string | undefined,
  ): Promise<ListPage> {
    const result = await this.#call(
      "list",
      prefix,
      this.#config.opTimeoutMs,
      false,
      (abortSignal) =>
        this.#api.send(
          new ListObjectsV2Command({
            Bucket: this.#config.bucket,
            Prefix: prefix,
            ...(delimiter === undefined ? {} : { Delimiter: delimiter }),
            ...(token === undefined ? {} : { ContinuationToken: token }),
          }),
          { abortSignal },
        ),
    );
    return result.value as ListPage;
  }

  /**
   * One SDK call under `timeoutMs`, traced and measured. `notFoundOk` says a
   * missing key is an answer for this operation rather than a failure.
   */
  async #call<V>(
    operation: S3Operation,
    key: string,
    timeoutMs: number,
    notFoundOk: boolean,
    run: (abortSignal: AbortSignal) => Promise<V>,
  ): Promise<{ found: true; value: V } | { found: false; value: undefined }> {
    const span = this.#tracer.startSpan(`s3 ${operation}`, {
      kind: SpanKind.CLIENT,
      attributes: {
        "rpc.system": "aws-api",
        "rpc.service": "S3",
        "rpc.method": operation,
        "aws.s3.bucket": this.#config.bucket,
        "aws.s3.key": key,
      },
    });
    const started = performance.now();
    const deadline = AbortSignal.timeout(timeoutMs);
    try {
      // The race bounds a call whose transport ignores the signal, too.
      const value = await Promise.race([
        run(deadline),
        new Promise<never>((_resolve, reject) => {
          deadline.addEventListener(
            "abort",
            () => {
              reject(new Error(`timed out after ${timeoutMs} ms`));
            },
            { once: true },
          );
        }),
      ]);
      return { found: true, value };
    } catch (err) {
      if (notFoundOk && isNotFound(err)) return { found: false, value: undefined };
      this.#errors.add(1, { operation });
      const failure =
        err instanceof S3TooLargeError
          ? err
          : new S3Error(
              operation,
              key,
              deadline.aborted ? new Error(`timed out after ${timeoutMs} ms`, { cause: err }) : err,
            );
      span.recordException(failure);
      span.setStatus({ code: SpanStatusCode.ERROR, message: `${operation} failed` });
      throw failure;
    } finally {
      this.#duration.record((performance.now() - started) / 1_000, { operation });
      span.end();
    }
  }
}

type UploadCall = <V>(
  operation: S3Operation,
  timeoutMs: number,
  run: (abortSignal: AbortSignal) => Promise<V>,
) => Promise<V>;

/**
 * One object of unknown size, written as a stream: `write()` buffers and
 * sends a part each time uploadPartBytes are collected, so memory stays at
 * one part however large the object.
 *
 * The object appears at its key only when `close()` resolves — a multipart
 * upload is invisible until completed. If the writer gives up before close,
 * call `abort()` to discard the parts already sent; a process that dies in
 * between leaves them to the bucket's lifecycle rule (AbortIncompleteMultipartUpload).
 *
 * An object that fits one part is sent as a plain put. Not safe for
 * concurrent writes: await each one.
 */
export class S3Upload {
  readonly #key: string;
  readonly #contentType: string | undefined;
  readonly #config: S3Config;
  readonly #api: S3Api;
  readonly #call: UploadCall;
  #chunks: Uint8Array[] = [];
  #buffered = 0;
  #size = 0;
  #uploadId: string | undefined;
  readonly #parts: CompletedPart[] = [];
  #done = false;

  /** @internal — use S3Store.upload(). */
  constructor(
    key: string,
    contentType: string | undefined,
    config: S3Config,
    api: S3Api,
    call: UploadCall,
  ) {
    this.#key = key;
    this.#contentType = contentType === "" ? undefined : contentType;
    this.#config = config;
    this.#api = api;
    this.#call = call;
  }

  /** Bytes written so far. */
  get size(): number {
    return this.#size;
  }

  /** Buffers chunk, sending a part each time the buffer fills. */
  async write(chunk: Uint8Array | string): Promise<void> {
    if (this.#done) throw new Error(`s3: upload ${JSON.stringify(this.#key)}: already finished`);
    let rest: Uint8Array = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    this.#size += rest.byteLength;
    while (rest.byteLength > 0) {
      const room = this.#config.uploadPartBytes - this.#buffered;
      const take = rest.subarray(0, room);
      this.#chunks.push(take);
      this.#buffered += take.byteLength;
      rest = rest.subarray(take.byteLength);
      if (this.#buffered === this.#config.uploadPartBytes) await this.#flushPart();
    }
  }

  /** Sends what is buffered and makes the object visible. On a failure the upload is aborted. */
  async close(): Promise<void> {
    if (this.#done) return;
    try {
      if (this.#uploadId === undefined) {
        // Never filled a part: a single put, no multipart round-trips.
        const body = this.#take();
        await this.#call("put", this.#config.opTimeoutMs, (abortSignal) =>
          this.#api.send(
            new PutObjectCommand({
              Bucket: this.#config.bucket,
              Key: this.#key,
              Body: body,
              ContentLength: body.byteLength,
              ...(this.#contentType === undefined ? {} : { ContentType: this.#contentType }),
            }),
            { abortSignal },
          ),
        );
      } else {
        if (this.#buffered > 0) await this.#flushPart();
        const uploadId = this.#uploadId;
        await this.#call("complete_upload", this.#config.opTimeoutMs, (abortSignal) =>
          this.#api.send(
            new CompleteMultipartUploadCommand({
              Bucket: this.#config.bucket,
              Key: this.#key,
              UploadId: uploadId,
              MultipartUpload: { Parts: this.#parts },
            }),
            { abortSignal },
          ),
        );
      }
      this.#done = true;
    } catch (err) {
      await this.abort();
      throw err;
    }
  }

  /** Discards an upload that will not be completed. A no-op after close(), safe to call twice. */
  async abort(): Promise<void> {
    if (this.#done) return;
    this.#done = true;
    this.#chunks = [];
    this.#buffered = 0;
    const uploadId = this.#uploadId;
    if (uploadId === undefined) return;
    try {
      await this.#call("abort_upload", this.#config.opTimeoutMs, (abortSignal) =>
        this.#api.send(
          new AbortMultipartUploadCommand({
            Bucket: this.#config.bucket,
            Key: this.#key,
            UploadId: uploadId,
          }),
          { abortSignal },
        ),
      );
    } catch {
      // Counted and traced by the call; the lifecycle rule collects the parts.
    }
  }

  #take(): Buffer {
    const body = Buffer.concat(this.#chunks, this.#buffered);
    this.#chunks = [];
    this.#buffered = 0;
    return body;
  }

  async #flushPart(): Promise<void> {
    if (this.#uploadId === undefined) {
      const created = (await this.#call("create_upload", this.#config.opTimeoutMs, (abortSignal) =>
        this.#api.send(
          new CreateMultipartUploadCommand({
            Bucket: this.#config.bucket,
            Key: this.#key,
            ...(this.#contentType === undefined ? {} : { ContentType: this.#contentType }),
          }),
          { abortSignal },
        ),
      )) as { UploadId?: string };
      if (created.UploadId === undefined) throw new Error("s3: the store returned no upload id");
      this.#uploadId = created.UploadId;
    }
    const uploadId = this.#uploadId;
    const partNumber = this.#parts.length + 1;
    const body = this.#take();
    const sent = (await this.#call("upload_part", this.#config.transferTimeoutMs, (abortSignal) =>
      this.#api.send(
        new UploadPartCommand({
          Bucket: this.#config.bucket,
          Key: this.#key,
          UploadId: uploadId,
          PartNumber: partNumber,
          Body: body,
          ContentLength: body.byteLength,
        }),
        { abortSignal },
      ),
    )) as { ETag?: string };
    this.#parts.push({
      PartNumber: partNumber,
      ...(sent.ETag === undefined ? {} : { ETag: sent.ETag }),
    });
  }
}
