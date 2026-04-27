/**
 * HeapSnapshotService
 *
 * Captures V8 heap snapshots, optionally uploads them to S3. Two triggers:
 *
 *   1. Signal (SIGUSR2) — `kill -USR2 <pid>` to capture on demand.
 *
 *   2. Near-OOM monitor — a periodic timer checks `heapUsed / heap_size_limit`
 *      against a configurable threshold. When the ratio is exceeded a
 *      snapshot is captured automatically.
 *
 *      For production OOM crashes Node's built-in flag is more reliable
 *      because it runs before the allocator gives up:
 *
 *        node --heapsnapshot-near-heap-limit=3 dist/main.js
 *
 *      Use both: the flag catches true OOM, this service catches "memory
 *      leak approaching the limit" before the crash.
 *
 * Environment variables:
 *   HEAP_SNAPSHOT_S3_BUCKET       Target S3 bucket. If absent, snapshots are
 *                                 written to /tmp only.
 *   HEAP_SNAPSHOT_S3_PREFIX       Key prefix inside the bucket. Default:
 *                                 "heap-snapshots".
 *   HEAP_OOM_THRESHOLD            Fraction of heap_size_limit that triggers
 *                                 a near-OOM snapshot. Default: 0.85.
 *   HEAP_OOM_POLL_INTERVAL_MS     How often to poll heap usage. Default:
 *                                 10000 (10 s).
 */
import { createReadStream, unlink } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import v8 from "node:v8";

import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { Injectable, OnApplicationBootstrap, OnApplicationShutdown } from "@nestjs/common";

import { AppLogger, ecsError } from "@base/logger";

type Trigger = "signal" | "oom" | "manual";

const S3_BUCKET = process.env["HEAP_SNAPSHOT_S3_BUCKET"];
const S3_PREFIX = process.env["HEAP_SNAPSHOT_S3_PREFIX"] ?? "heap-snapshots";
const OOM_THRESHOLD = parseFloat(process.env["HEAP_OOM_THRESHOLD"] ?? "0.85");
const OOM_POLL_MS = parseInt(process.env["HEAP_OOM_POLL_INTERVAL_MS"] ?? "10000", 10);

const SERVICE_NAME = process.env["OTEL_SERVICE_NAME"] ?? "app";

@Injectable()
export class HeapSnapshotService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger: ReturnType<AppLogger["child"]>;
  private readonly s3 = S3_BUCKET === undefined ? null : new S3Client({});
  private oomTimer: NodeJS.Timeout | null = null;
  private capturing = false;

  // Stable reference so we can remove exactly this listener on shutdown.
  private readonly signalHandler = (): void => {
    void this.capture("signal");
  };

  constructor(appLogger: AppLogger) {
    this.logger = appLogger.child(HeapSnapshotService.name);
  }

  onApplicationBootstrap(): void {
    process.on("SIGUSR2", this.signalHandler);

    this.oomTimer = setInterval(() => {
      if (this.capturing) return;

      const stats = v8.getHeapStatistics();
      const ratio = stats.used_heap_size / stats.heap_size_limit;

      if (ratio >= OOM_THRESHOLD) {
        this.logger.warn(
          {
            "process.heap.usage_ratio": ratio,
            "process.heap.used_mb": Math.round(stats.used_heap_size / 1_048_576),
            "process.heap.limit_mb": Math.round(stats.heap_size_limit / 1_048_576),
          },
          "Heap near OOM threshold — capturing snapshot",
        );
        void this.capture("oom");
      }
    }, OOM_POLL_MS);

    this.oomTimer.unref();

    this.logger.info(
      {
        "process.heap.oom_threshold": OOM_THRESHOLD,
        "cloud.object_storage.bucket.name": S3_BUCKET ?? null,
        "cloud.object_storage.key_prefix": S3_BUCKET === undefined ? null : S3_PREFIX,
      },
      "HeapSnapshotService ready",
    );
  }

  onApplicationShutdown(): void {
    process.off("SIGUSR2", this.signalHandler);
    if (this.oomTimer) {
      clearInterval(this.oomTimer);
      this.oomTimer = null;
    }
  }

  /**
   * Capture a heap snapshot and optionally upload it to S3. Safe to call
   * concurrently — subsequent calls while a capture is in progress are
   * silently ignored.
   *
   * Returns the S3 URI on a successful upload, the local file path if S3
   * is not configured or upload failed, or null if another capture was
   * already running.
   */
  async capture(trigger: Trigger = "manual"): Promise<string | null> {
    if (this.capturing) {
      this.logger.warn("Heap snapshot already in progress — skipping");
      return null;
    }
    this.capturing = true;
    try {
      return await this.captureAndUpload(trigger);
    } finally {
      this.capturing = false;
    }
  }

  private async captureAndUpload(trigger: Trigger): Promise<string> {
    const ts = new Date().toISOString().replaceAll(/[:.]/g, "-");
    const filename = `heap-${ts}-${trigger}.heapsnapshot`;
    const localPath = join(tmpdir(), filename);

    // v8.writeHeapSnapshot is synchronous — pauses the event loop briefly.
    const writtenPath = v8.writeHeapSnapshot(localPath);
    this.logger.info(
      { "file.path": writtenPath, "event.action": trigger },
      "Heap snapshot written",
    );

    if (this.s3 === null || S3_BUCKET === undefined) {
      return writtenPath;
    }

    const s3Key = `${S3_PREFIX}/${SERVICE_NAME}/${hostname()}/${filename}`;
    try {
      await this.s3.send(
        new PutObjectCommand({
          Bucket: S3_BUCKET,
          Key: s3Key,
          Body: createReadStream(writtenPath),
          ContentType: "application/octet-stream",
          Metadata: {
            service: SERVICE_NAME,
            hostname: hostname(),
            trigger,
            timestamp: new Date().toISOString(),
          },
        }),
      );

      const s3Uri = `s3://${S3_BUCKET}/${s3Key}`;
      this.logger.info({ "url.full": s3Uri }, "Heap snapshot uploaded to S3");

      // Remove the local file only after a confirmed upload.
      unlink(writtenPath, (err) => {
        if (err)
          this.logger.warn(
            { ...ecsError(err), "file.path": writtenPath },
            "Could not remove local snapshot",
          );
      });

      return s3Uri;
    } catch (err) {
      this.logger.error(
        { ...ecsError(err), "file.path": writtenPath },
        "Failed to upload heap snapshot to S3",
      );
      return writtenPath;
    }
  }
}
