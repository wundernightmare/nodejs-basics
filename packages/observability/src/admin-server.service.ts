/**
 * AdminServerService
 *
 * Lightweight Node.js HTTP server on a dedicated admin/ops port (default: 9090,
 * controlled by ADMIN_PORT). Independent of the main HTTP application: no
 * Helmet, no CORS, no auth. NEVER expose this port to the public internet —
 * restrict at the firewall / network policy / k8s ingress layer.
 *
 *   GET  /metrics          Prometheus text format
 *   GET  /livez            Liveness probe (200 OK)
 *   GET  /readyz           Readiness probe (200 / 503)
 *   GET  /admin/info       Build info + uptime
 *   GET  /admin/log-level  Current pino root level
 *   PUT  /admin/log-level  Change pino root level at runtime
 */
import http from "node:http";

import { Inject, Injectable, OnApplicationBootstrap, OnApplicationShutdown } from "@nestjs/common";

import { AppLogger, ecsError, pinoLogger } from "@base/logger";

import { ReadinessService } from "./readiness.service.js";
import { TELEMETRY_HANDLE, type TelemetryHandle } from "./setup-telemetry.tokens.js";

@Injectable()
export class AdminServerService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger: ReturnType<AppLogger["child"]>;
  private server: http.Server | null = null;

  constructor(
    private readonly readiness: ReadinessService,
    @Inject(TELEMETRY_HANDLE) private readonly telemetry: TelemetryHandle,
    appLogger: AppLogger,
  ) {
    this.logger = appLogger.child(AdminServerService.name);
  }

  async onApplicationBootstrap(): Promise<void> {
    const port = parseInt(process.env["ADMIN_PORT"] ?? "9090", 10);

    this.server = http.createServer((req, res) => {
      this.handleRequest(req, res);
    });

    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(port, "0.0.0.0", () => {
        this.logger.info(
          { "server.port": port },
          "Admin server listening — GET /metrics · GET /livez · GET /readyz · GET /admin/info · GET|PUT /admin/log-level",
        );
        resolve();
      });
    });
  }

  async onApplicationShutdown(signal?: string): Promise<void> {
    if (!this.server) return;
    this.logger.info({ "process.signal": signal ?? null }, "Admin server shutting down");
    await new Promise<void>((resolve, reject) => {
      this.server!.close((err) => (err ? reject(err) : resolve()));
    });
  }

  private handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    const path = (req.url ?? "/").split("?")[0];
    const method = req.method?.toUpperCase() ?? "GET";

    if (method === "GET" && path === "/metrics") {
      this.telemetry.prometheusExporter.getMetricsRequestHandler(req, res);
      return;
    }

    if (method === "GET" && (path === "/livez" || path === "/healthz")) {
      this.sendJson(res, 200, { status: "ok" });
      return;
    }

    if (method === "GET" && path === "/readyz") {
      void this.readiness
        .check()
        .then((result) => {
          this.sendJson(res, result.ok ? 200 : 503, {
            status: result.ok ? "ok" : "degraded",
            checks: result.checks,
          });
        })
        .catch((err: Error) => {
          this.logger.error({ ...ecsError(err) }, "Readiness check threw unexpectedly");
          this.sendJson(res, 503, { status: "degraded", error: err.message });
        });
      return;
    }

    if (method === "GET" && path === "/admin/info") {
      this.sendJson(res, 200, {
        service: process.env["OTEL_SERVICE_NAME"] ?? "app",
        version: process.env["npm_package_version"] ?? "unknown",
        commit: process.env["GIT_COMMIT"] ?? "unknown",
        node: process.version,
        uptime_seconds: Math.floor(process.uptime()),
        env: process.env["NODE_ENV"] ?? "development",
      });
      return;
    }

    if (method === "GET" && path === "/admin/log-level") {
      this.sendJson(res, 200, { current: pinoLogger.level });
      return;
    }

    if (method === "PUT" && path === "/admin/log-level") {
      void this.readBody(req)
        .then((body) => {
          const requested = body.trim().toLowerCase();
          const valid = ["trace", "debug", "info", "warn", "error", "fatal", "silent"];
          if (!valid.includes(requested)) {
            this.sendJson(res, 400, {
              error: `Invalid log level "${requested}". Valid values: ${valid.join(", ")}`,
            });
            return;
          }
          const previous = pinoLogger.level;
          pinoLogger.level = requested;
          this.logger.info(
            { "log.level.previous": previous, "log.level.current": requested },
            "Log level changed",
          );
          this.sendJson(res, 200, { previous, current: requested });
        })
        .catch((err: Error) => {
          this.sendJson(res, 500, { error: err.message });
        });
      return;
    }

    res.writeHead(404);
    res.end();
  }

  private readBody(req: http.IncomingMessage): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        resolve(Buffer.concat(chunks).toString("utf8"));
      });
      req.on("error", reject);
    });
  }

  private sendJson(res: http.ServerResponse, status: number, body: unknown): void {
    const payload = JSON.stringify(body);
    res.writeHead(status, {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(payload),
    });
    res.end(payload);
  }
}
