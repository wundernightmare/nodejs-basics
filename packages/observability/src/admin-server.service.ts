/**
 * AdminServerService
 *
 * Lightweight Node.js HTTP server on a dedicated admin/ops port (default: 9090,
 * controlled by ADMIN_PORT). Independent of the main HTTP application: no
 * Helmet, no CORS, none of the API middleware — probes and scrapes never show
 * up as traffic. NEVER expose this port to the public internet — restrict at
 * the firewall / network policy / k8s ingress layer.
 *
 *   GET    /metrics          Prometheus text format
 *   GET    /livez, /healthz  Liveness probe (200 OK)
 *   GET    /readyz           Readiness probe (200 ok|degraded / 503 not_ready)
 *   GET    /version          Build identity + start time / uptime (/admin/info is an alias)
 *   GET    /admin/config     Effective configuration, secrets redacted   (if configSnapshot is given)
 *   GET    /admin/log-level  {level, base, expires_at, max_ttl}
 *   PUT    /admin/log-level  ?level=debug&ttl=30m (or JSON {level, ttl}) — temporary; auth
 *   DELETE /admin/log-level  Revert to the base level now                        — auth
 *   POST   /debug/heapdump   Capture a V8 heap snapshot        (if HeapSnapshotService)  — auth
 *   POST   /debug/report     Diagnostic report + heap snapshot (if CrashReportService)   — auth
 *
 * auth: `Authorization: Bearer <ADMIN_TOKEN>` (constant-time compare) when
 * ADMIN_TOKEN is set; an empty token leaves the mutations open (local /
 * compose default) and the listening log line says `auth=off`.
 *
 * Errors are RFC 9457 application/problem+json — including 404 for unknown
 * routes and 405 (+ Allow) for known routes with the wrong method. Every
 * response echoes X-Request-Id (honoured from the client when sane) and every
 * problem body carries it as `request_id`.
 *
 * Mirrors libs/httpx/admin.go in golang-basics.
 */
import http from "node:http";

import {
  Inject,
  Injectable,
  OnApplicationBootstrap,
  OnApplicationShutdown,
  Optional,
} from "@nestjs/common";

import {
  AppLogger,
  ecsError,
  generateRequestId,
  isValidRequestId,
  logLevel,
  parseDuration,
  parseLogLevelStrict,
  redact,
  REQUEST_ID_HEADER,
  serviceIdentity,
  withDebugLogging,
  withRequestId,
} from "@base/logger";

import { type BearerGuard, requireBearer } from "./admin-auth.js";
import { writeProblem } from "./admin-problem.js";
import { CrashReportService } from "./crash-report.service.js";
import { HeapSnapshotService } from "./heap-snapshot.service.js";
import { ReadinessService } from "./readiness.service.js";
import { TELEMETRY_HANDLE, type TelemetryHandle } from "./setup-telemetry.tokens.js";

export const ADMIN_SERVER_OPTIONS = Symbol("ADMIN_SERVER_OPTIONS");

/** What GET /admin/config serves: `config` goes through redact(), `sources` (provenance) as is. */
export interface ConfigView {
  config: unknown;
  sources?: Record<string, string>;
}

export interface AdminServerOptions {
  /** Raw effective config for GET /admin/config (configSnapshot from @base/config). */
  configSnapshot?: () => ConfigView;
}

/** Process start, for /version. */
const STARTED_AT = new Date(Date.now() - process.uptime() * 1_000);

type Method = "GET" | "PUT" | "POST" | "DELETE";

interface AdminContext {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  url: URL;
  client: string;
}

interface RouteEntry {
  handler: (ctx: AdminContext) => void | Promise<void>;
  /** Requires the bearer token when one is configured. */
  auth?: boolean;
}

type RouteTable = Map<string, Partial<Record<Method, RouteEntry>>>;

@Injectable()
export class AdminServerService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger: ReturnType<AppLogger["child"]>;
  private readonly guard: BearerGuard;
  private readonly authMode: "bearer" | "off";
  private readonly routes: RouteTable;
  private server: http.Server | null = null;

  constructor(
    private readonly readiness: ReadinessService,
    @Inject(TELEMETRY_HANDLE) private readonly telemetry: TelemetryHandle,
    appLogger: AppLogger,
    @Optional() @Inject(ADMIN_SERVER_OPTIONS) private readonly options: AdminServerOptions = {},
    @Optional() private readonly heapSnapshot?: HeapSnapshotService,
    @Optional() private readonly crashReport?: CrashReportService,
  ) {
    this.logger = appLogger.child(AdminServerService.name);
    const token = process.env["ADMIN_TOKEN"] ?? "";
    this.authMode = token === "" ? "off" : "bearer";
    this.guard = requireBearer(token, this.logger);
    this.routes = this.buildRoutes();
  }

  /** The bound port once listening (ADMIN_PORT=0 picks an ephemeral one — tests). */
  get port(): number | null {
    const address = this.server?.address();
    return typeof address === "object" && address !== null ? address.port : null;
  }

  async onApplicationBootstrap(): Promise<void> {
    const port = parseInt(process.env["ADMIN_PORT"] ?? "9090", 10);

    this.server = http.createServer((req, res) => {
      this.handleRequest(req, res);
    });

    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(port, "0.0.0.0", () => {
        const routes = [...this.routes.entries()].map(
          ([path, methods]) => `${Object.keys(methods).join("|")} ${path}`,
        );
        this.logger.info(
          {
            "event.action": "admin.started",
            "server.port": this.port,
            "admin.auth": this.authMode,
          },
          `Admin server listening — auth=${this.authMode} — ${routes.join(" · ")}`,
        );
        resolve();
      });
    });
  }

  /**
   * Runs in the last shutdown phase (after beforeApplicationShutdown closed
   * the readiness gate and Nest drained the API listener) so probes keep
   * answering "not_ready" while the API drains — see ReadinessService.
   */
  async onApplicationShutdown(signal?: string): Promise<void> {
    if (!this.server) return;
    this.logger.info({ "process.signal": signal ?? null }, "Admin server shutting down");
    await new Promise<void>((resolve, reject) => {
      this.server!.close((err) => (err ? reject(err) : resolve()));
    });
    this.server = null;
  }

  // ─── Routing ────────────────────────────────────────────────────────────────

  private buildRoutes(): RouteTable {
    const routes: RouteTable = new Map();
    routes.set("/metrics", {
      GET: {
        handler: ({ req, res }) => {
          this.telemetry.prometheusExporter.getMetricsRequestHandler(req, res);
        },
      },
    });
    const live: RouteEntry = { handler: ({ res }) => this.sendJson(res, 200, { status: "ok" }) };
    routes.set("/livez", { GET: live });
    routes.set("/healthz", { GET: live });
    routes.set("/readyz", { GET: { handler: (ctx) => this.readyz(ctx) } });
    const version: RouteEntry = { handler: ({ res }) => this.sendJson(res, 200, this.version()) };
    routes.set("/version", { GET: version });
    routes.set("/admin/info", { GET: version });
    if (this.options.configSnapshot !== undefined) {
      const snapshot = this.options.configSnapshot;
      routes.set("/admin/config", {
        GET: {
          handler: ({ res }) => {
            const view = snapshot();
            this.sendJson(res, 200, { config: redact(view.config), sources: view.sources });
          },
        },
      });
    }
    routes.set("/admin/log-level", {
      GET: { handler: ({ res }) => this.sendJson(res, 200, logLevel.snapshot()) },
      PUT: { handler: (ctx) => this.putLogLevel(ctx), auth: true },
      DELETE: { handler: (ctx) => this.deleteLogLevel(ctx), auth: true },
    });
    if (this.heapSnapshot) {
      routes.set("/debug/heapdump", { POST: { handler: (ctx) => this.heapdump(ctx), auth: true } });
    }
    if (this.crashReport) {
      routes.set("/debug/report", { POST: { handler: (ctx) => this.report(ctx), auth: true } });
    }
    return routes;
  }

  private handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = new URL(req.url ?? "/", "http://admin");
    const header = req.headers[REQUEST_ID_HEADER];
    const candidate = Array.isArray(header) ? header[0] : header;
    const requestId = isValidRequestId(candidate) ? candidate : generateRequestId();
    res.setHeader(REQUEST_ID_HEADER, requestId);

    withRequestId(requestId, () => {
      void this.dispatch({ req, res, url, client: req.socket.remoteAddress ?? "unknown" });
    });
  }

  private async dispatch(ctx: AdminContext): Promise<void> {
    const { req, res, url } = ctx;
    const methods = this.routes.get(url.pathname);
    if (methods === undefined) {
      writeProblem(res, { status: 404, detail: "no such route", instance: url.pathname });
      return;
    }
    const entry = methods[(req.method ?? "GET").toUpperCase() as Method];
    if (entry === undefined) {
      const allow = Object.keys(methods).join(", ");
      writeProblem(res, {
        status: 405,
        detail: `method ${req.method ?? "GET"} not allowed; allowed: ${allow}`,
        instance: url.pathname,
        headers: { Allow: allow },
      });
      return;
    }
    if (entry.auth === true && !this.guard(req, res)) return;

    try {
      await entry.handler(ctx);
    } catch (err) {
      this.logger.error({ ...ecsError(err), "url.path": url.pathname }, "Admin handler failed");
      if (!res.headersSent) {
        writeProblem(res, {
          status: 500,
          detail: err instanceof Error ? err.message : String(err),
          instance: url.pathname,
        });
      }
    }
  }

  // ─── Handlers ───────────────────────────────────────────────────────────────

  private async readyz({ res }: AdminContext): Promise<void> {
    try {
      const result = await this.readiness.check();
      this.sendJson(res, result.ok ? 200 : 503, { status: result.status, checks: result.checks });
    } catch (err) {
      this.logger.error({ ...ecsError(err) }, "Readiness check threw unexpectedly");
      this.sendJson(res, 503, {
        status: "not_ready",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private version(): Record<string, unknown> {
    return {
      service: serviceIdentity.name,
      version: serviceIdentity.version,
      revision: process.env["GIT_COMMIT"] ?? "unknown",
      node: process.version,
      started_at: STARTED_AT.toISOString(),
      uptime_seconds: Math.floor(process.uptime()),
      env: serviceIdentity.environment,
    };
  }

  /**
   * PUT /admin/log-level?level=debug&ttl=30m — also accepts a JSON body
   * {level, ttl}, a form body, or a bare level as the body. ttl is optional
   * and capped at LOG_LEVEL_MAX_TTL: a runtime change always expires, so
   * nobody has to remember to turn debug off.
   */
  private async putLogLevel({ req, res, url, client }: AdminContext): Promise<void> {
    const params = await this.logLevelParams(req, url);

    let level: ReturnType<typeof parseLogLevelStrict>;
    try {
      level = parseLogLevelStrict(params.level);
    } catch (err) {
      writeProblem(res, { status: 400, detail: (err as Error).message, instance: url.pathname });
      return;
    }

    let ttlMs = logLevel.maxTtlMs;
    if (params.ttl !== undefined && params.ttl !== "") {
      try {
        ttlMs = Math.min(parseDuration(params.ttl), logLevel.maxTtlMs);
      } catch {
        writeProblem(res, {
          status: 400,
          detail: "ttl must be a positive duration such as 30m or 2h",
          instance: url.pathname,
        });
        return;
      }
    }

    const previous = logLevel.set(level, ttlMs);
    const state = logLevel.snapshot();
    // Marked context: this record must land whatever the level was or is.
    withDebugLogging(() => {
      this.logger.warn(
        {
          "event.action": "log_level.changed",
          "log.level.from": previous,
          "log.level.to": state.level,
          "log.level.ttl_ms": ttlMs,
          "log.level.expires_at": state.expires_at,
          "client.address": client,
        },
        "Log level changed",
      );
    });
    this.sendJson(res, 200, { ...state, previous });
  }

  private deleteLogLevel({ res, client }: AdminContext): void {
    const previous = logLevel.reset();
    const state = logLevel.snapshot();
    withDebugLogging(() => {
      this.logger.warn(
        {
          "event.action": "log_level.reset",
          "log.level.from": previous,
          "log.level.to": state.level,
          "client.address": client,
        },
        "Log level reset",
      );
    });
    this.sendJson(res, 200, { ...state, previous });
  }

  private async logLevelParams(
    req: http.IncomingMessage,
    url: URL,
  ): Promise<{ level?: string; ttl?: string }> {
    const params: { level?: string; ttl?: string } = {};
    const q = url.searchParams;
    if (q.has("level")) params.level = q.get("level")!;
    if (q.has("ttl")) params.ttl = q.get("ttl")!;
    if (params.level !== undefined) return params;

    const body = (await this.readBody(req)).trim();
    if (body === "") return params;
    if (body.startsWith("{")) {
      const parsed = JSON.parse(body) as { level?: unknown; ttl?: unknown };
      if (typeof parsed.level === "string") params.level = parsed.level;
      if (typeof parsed.ttl === "string") params.ttl = parsed.ttl;
      return params;
    }
    if (body.includes("=")) {
      const form = new URLSearchParams(body);
      if (form.has("level")) params.level = form.get("level")!;
      if (form.has("ttl") && params.ttl === undefined) params.ttl = form.get("ttl")!;
      return params;
    }
    params.level = body; // bare level, e.g. `--data debug`
    return params;
  }

  private async heapdump({ res, url }: AdminContext): Promise<void> {
    try {
      const location = await this.heapSnapshot!.capture("manual");
      if (location === null) {
        writeProblem(res, {
          status: 409,
          detail: "another capture is already in progress",
          instance: url.pathname,
        });
        return;
      }
      this.sendJson(res, 200, { triggered: true, location });
    } catch (err) {
      this.logger.error({ ...ecsError(err) }, "Heapdump request failed");
      writeProblem(res, { status: 500, detail: (err as Error).message, instance: url.pathname });
    }
  }

  private async report({ res, url }: AdminContext): Promise<void> {
    try {
      const result = await this.crashReport!.writeDiagnosticReport("manual");
      this.sendJson(res, 200, { triggered: true, ...result });
    } catch (err) {
      this.logger.error({ ...ecsError(err) }, "Diagnostic report request failed");
      writeProblem(res, { status: 500, detail: (err as Error).message, instance: url.pathname });
    }
  }

  // ─── Helpers ────────────────────────────────────────────────────────────────

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
