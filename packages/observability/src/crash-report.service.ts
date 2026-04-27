/**
 * CrashReportService
 *
 * Registers a process-level `uncaughtException` + `unhandledRejection` handler that:
 *   1. Writes a Node.js diagnostic report (JSON) via `process.report.writeReport()`
 *   2. Writes a V8 heap snapshot via `v8.writeHeapSnapshot()`
 *   3. Uploads both files to S3 asynchronously (best-effort, 10 s timeout)
 *   4. Calls `process.exit(1)`
 *
 * Both writes are synchronous so they complete even if the event loop is
 * corrupted. The S3 upload is async with a hard deadline — if it does not
 * finish in time the process exits anyway.
 *
 * The service also exposes `writeDiagnosticReport(trigger)` for live / manual
 * diagnostics (e.g. via `POST /debug/report` on the admin server).
 *
 * Environment variables:
 *   HEAP_SNAPSHOT_S3_BUCKET   Target S3 bucket (shared with HeapSnapshotService).
 *                             If absent, files are written to /tmp only.
 *   CRASH_REPORT_S3_PREFIX    Key prefix inside the bucket. Default:
 *                             "crash-reports".
 *
 * S3 key pattern:
 *   <PREFIX>/<SERVICE>/<HOSTNAME>/<DATE>/crash-<ts>.<ext>
 */
import { createReadStream, unlink } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import v8 from "node:v8";

import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { Injectable, OnApplicationBootstrap, OnApplicationShutdown } from "@nestjs/common";

import { AppLogger, ecsError } from "@base/logger";

const S3_BUCKET = process.env["HEAP_SNAPSHOT_S3_BUCKET"];
const S3_PREFIX = process.env["CRASH_REPORT_S3_PREFIX"] ?? "crash-reports";
const SERVICE_NAME = process.env["OTEL_SERVICE_NAME"] ?? "app";
const UPLOAD_TIMEOUT_MS = 10_000;

/**
 * Synchronous ECS-formatted log line written directly to stderr.
 * Used exclusively inside the crash handler where the event loop may be
 * corrupted — pino's async transport cannot be trusted at that point.
 * JSON.stringify is synchronous and safe to call in degraded state.
 */
function crashLog(
  level: "error" | "warn" | "info",
  fields: Record<string, unknown>,
  message: string,
): void {
  process.stderr.write(
    JSON.stringify({
      "log.level": level,
      "@timestamp": new Date().toISOString(),
      "process.pid": process.pid,
      "service.name": SERVICE_NAME,
      "log.logger": "CrashReportService",
      ...fields,
      message,
    }) + "\n",
  );
}

export type CrashReportTrigger = "uncaught" | "manual";

export interface CrashReportResult {
  reportPath: string | null;
  snapshotPath: string | null;
  reportS3: string | null;
  snapshotS3: string | null;
}

@Injectable()
export class CrashReportService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger: ReturnType<AppLogger["child"]>;
  private readonly s3 = S3_BUCKET === undefined ? null : new S3Client({});
  private handlingCrash = false;

  private readonly uncaughtExceptionHandler = (err: Error): void => {
    void this.handleCrash(err);
  };

  private readonly unhandledRejectionHandler = (reason: unknown): void => {
    const err = reason instanceof Error ? reason : new Error(String(reason));
    void this.handleCrash(err);
  };

  constructor(appLogger: AppLogger) {
    this.logger = appLogger.child(CrashReportService.name);
  }

  onApplicationBootstrap(): void {
    process.on("uncaughtException", this.uncaughtExceptionHandler);
    process.on("unhandledRejection", this.unhandledRejectionHandler);

    this.logger.info(
      {
        "cloud.object_storage.bucket.name": S3_BUCKET ?? null,
        "cloud.object_storage.key_prefix": S3_BUCKET === undefined ? null : S3_PREFIX,
      },
      "CrashReportService ready — uncaughtException handler registered",
    );
  }

  onApplicationShutdown(): void {
    process.off("uncaughtException", this.uncaughtExceptionHandler);
    process.off("unhandledRejection", this.unhandledRejectionHandler);
  }

  /**
   * Capture a live diagnostic report without crashing the process.
   * Safe to call from the admin server on demand.
   */
  async writeDiagnosticReport(trigger: CrashReportTrigger = "manual"): Promise<CrashReportResult> {
    const ts = new Date().toISOString().replaceAll(/[:.]/g, "-");
    const base = `crash-${ts}-${trigger}`;

    const reportLocalPath = join(tmpdir(), `${base}.json`);
    const snapshotLocalPath = join(tmpdir(), `${base}.heapsnapshot`);

    process.report.writeReport(reportLocalPath);
    v8.writeHeapSnapshot(snapshotLocalPath);

    this.logger.info(
      { "file.path": reportLocalPath, "event.action": trigger },
      "Diagnostic report written",
    );
    this.logger.info(
      { "file.path": snapshotLocalPath, "event.action": trigger },
      "Heap snapshot written for crash report",
    );

    if (this.s3 === null || S3_BUCKET === undefined) {
      return {
        reportPath: reportLocalPath,
        snapshotPath: snapshotLocalPath,
        reportS3: null,
        snapshotS3: null,
      };
    }

    const [reportS3, snapshotS3] = await Promise.all([
      this.uploadToS3(reportLocalPath, base, "json", "application/json", trigger),
      this.uploadToS3(snapshotLocalPath, base, "heapsnapshot", "application/octet-stream", trigger),
    ]);

    return { reportPath: reportLocalPath, snapshotPath: snapshotLocalPath, reportS3, snapshotS3 };
  }

  private async handleCrash(err: Error): Promise<void> {
    if (this.handlingCrash) return;
    this.handlingCrash = true;

    // Synchronous logging first — the event loop may not drain after this.
    crashLog(
      "error",
      { "error.type": err.name, "error.message": err.message, "error.stack_trace": err.stack },
      "uncaughtException",
    );

    const ts = new Date().toISOString().replaceAll(/[:.]/g, "-");
    const base = `crash-${ts}-uncaught`;
    const reportLocalPath = join(tmpdir(), `${base}.json`);
    const snapshotLocalPath = join(tmpdir(), `${base}.heapsnapshot`);

    try {
      process.report.writeReport(reportLocalPath);
      crashLog("info", { "file.path": reportLocalPath }, "Diagnostic report written");
    } catch {
      crashLog("warn", {}, "Failed to write diagnostic report");
    }

    try {
      v8.writeHeapSnapshot(snapshotLocalPath);
      crashLog("info", { "file.path": snapshotLocalPath }, "Heap snapshot written");
    } catch {
      crashLog("warn", {}, "Failed to write heap snapshot");
    }

    if (this.s3 !== null && S3_BUCKET !== undefined) {
      const uploadPromise = Promise.all([
        this.uploadToS3(reportLocalPath, base, "json", "application/json", "uncaught").catch(
          () => null,
        ),
        this.uploadToS3(
          snapshotLocalPath,
          base,
          "heapsnapshot",
          "application/octet-stream",
          "uncaught",
        ).catch(() => null),
      ]);

      await Promise.race([
        uploadPromise,
        new Promise<void>((resolve) => setTimeout(resolve, UPLOAD_TIMEOUT_MS)),
      ]);
    }

    process.exit(1);
  }

  private async uploadToS3(
    localPath: string,
    base: string,
    ext: string,
    contentType: string,
    trigger: CrashReportTrigger,
  ): Promise<string | null> {
    if (this.s3 === null || S3_BUCKET === undefined) return null;

    const date = new Date().toISOString().slice(0, 10);
    const s3Key = `${S3_PREFIX}/${SERVICE_NAME}/${hostname()}/${date}/${base}.${ext}`;

    try {
      await this.s3.send(
        new PutObjectCommand({
          Bucket: S3_BUCKET,
          Key: s3Key,
          Body: createReadStream(localPath),
          ContentType: contentType,
          Metadata: {
            service: SERVICE_NAME,
            hostname: hostname(),
            trigger,
            timestamp: new Date().toISOString(),
          },
        }),
      );

      const s3Uri = `s3://${S3_BUCKET}/${s3Key}`;
      this.logger.info({ "url.full": s3Uri }, "Crash report file uploaded to S3");

      unlink(localPath, (err) => {
        if (err)
          this.logger.warn(
            { ...ecsError(err), "file.path": localPath },
            "Could not remove local crash report file",
          );
      });

      return s3Uri;
    } catch (err) {
      this.logger.error(
        { ...ecsError(err as Error), "file.path": localPath },
        "Failed to upload crash report file to S3",
      );
      return localPath;
    }
  }
}
