/**
 * The application, assembled: the Fastify adapter with its plugins and hooks,
 * the NestJS module tree, the global pipes and filters. `createApp` returns
 * the app *before* it listens, so main.ts (listen on PORT) and the contract
 * integration spec (fastify `inject`, no port) share the exact same wiring —
 * a test that passes here passes against the process, and vice versa.
 *
 * main.ts must import ./instrumentation.js before this file (telemetry first).
 */
import "reflect-metadata";

import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import { NestFactory } from "@nestjs/core";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { ZodValidationPipe } from "nestjs-zod";

import {
  createDomainExceptionFilter,
  DeadlineExceededError,
  genRequestId,
  HttpExceptionFilter,
  OptimisticLockConflictError,
  registerRequestContext,
  type ErrorMap,
} from "@base/common";
import { processEnv, readInt } from "@base/config";
import { AppLogger, pinoLogger } from "@base/logger";
import { registerHttpInstrumentation } from "@base/observability";

import { AppModule } from "./app.module.js";
import { registerMethodNotAllowed } from "./http/method-not-allowed.hook.js";
import { ProblemFallbackFilter } from "./http/problem-fallback.filter.js";
import { fastifyOtelInstrumentation } from "./instrumentation.js";
import { TaskAlreadyArchivedError, TaskNotFoundError } from "./modules/tasks/domain/task.errors.js";

/**
 * Wire the domain error → HTTP status map for your app here.
 * Subclass DomainError in your modules and add entries to this map.
 */
export const ERROR_MAP: ErrorMap = {
  OptimisticLockConflictError: { status: 409 },
  // The request budget ran out in a dependency (HTTP_REQUEST_TIMEOUT_MS).
  DeadlineExceededError: {
    status: 504,
    fallbackMessage: "The request ran out of time waiting for a dependency",
  },
  TaskNotFoundError: { status: 404 },
  TaskAlreadyArchivedError: { status: 409 },
};

/** Classes the NestJS @Catch decorator binds the filter to. Add new errors here. */
export const DOMAIN_ERRORS: Array<new (...args: never[]) => Error> = [
  OptimisticLockConflictError,
  DeadlineExceededError,
  TaskNotFoundError,
  TaskAlreadyArchivedError,
];

/** Build the app (not listening). Call `app.listen(...)` or `app.init()` on it. */
export async function createApp(): Promise<NestFastifyApplication> {
  // Limits of one request — see ENV_REGISTRY: a body over the limit is a 413
  // problem; the request budget bounds both receiving the request (slow
  // clients) and every Postgres / Valkey / HTTP call made while handling it
  // (the deadline, registerRequestContext below), after which the answer is 504.
  const bodyLimit = readInt(processEnv, "HTTP_BODY_LIMIT_BYTES");
  const requestTimeoutMs = readInt(processEnv, "HTTP_REQUEST_TIMEOUT_MS");
  const adapter = new FastifyAdapter({
    bodyLimit,
    requestTimeout: requestTimeoutMs,
    disableRequestLogging: true, // we register our own access logs in registerHttpInstrumentation
    // Fastify 5 takes a pre-built logger via `loggerInstance`; the `logger`
    // option only accepts a config object (passing an instance there throws
    // FST_ERR_LOG_INVALID_LOGGER_CONFIG).
    loggerInstance: pinoLogger,
    // X-Request-Id from the client when sane (1–128 printable ASCII), else generated.
    genReqId: genRequestId,
    // Fastify answers 414 for a path parameter over 100 chars by default; an
    // over-long id is just an id that names nothing — a 404 like any other
    // malformed one (the contract declares 200 | 404, not 414).
    maxParamLength: 1024,
  });

  // Fastify must register the OTel plugin before any other plugins so its
  // hooks fire on every request. Cast widens the plugin type — runtime is
  // compatible, the variance mismatch is purely in fastify's generic types.
  await adapter.register(fastifyOtelInstrumentation.plugin() as never);

  const app = await NestFactory.create<NestFastifyApplication>(AppModule, adapter, {
    bufferLogs: true,
  });
  const appLogger = app.get(AppLogger);
  app.useLogger(appLogger);

  // Per-request context: echoes X-Request-Id and puts it in ALS (every log
  // line, every outbound ResilientClient call and every problem+json body
  // carry it), starts the request's deadline, and turns on debug logging for one request when X-Debug-Token
  // matches DEBUG_TOKEN (response: X-Debug-Logging: on). DEBUG_TOKEN is read
  // here, after ConfigModule merged config.yaml into process.env.
  registerRequestContext(adapter.getInstance(), {
    debugToken: process.env["DEBUG_TOKEN"],
    requestTimeoutMs,
  });

  registerHttpInstrumentation(adapter.getInstance());

  // Known path, undeclared method → 405 + Allow (as a problem), not a 404.
  registerMethodNotAllowed(adapter.getInstance());

  // Security plugins
  await app.register(helmet, {
    contentSecurityPolicy: false, // adjust per app — enable for HTML responses
  });
  await app.register(cors, {
    origin: (process.env["ALLOWED_ORIGINS"] ?? "").split(",").filter(Boolean),
    credentials: true,
  });
  await app.register(cookie, {
    secret: process.env["COOKIE_SECRET"] ?? "dev-only-cookie-secret-change-me",
  });

  // Global zod validation — every controller method whose @Body() / @Query()
  // is a `createZodDto`-derived class gets runtime validation for free.
  app.useGlobalPipes(new ZodValidationPipe());

  // Global filters. NestJS tries them last-registered first, so the order is
  // broadest first: the problem fallback (anything), then domain errors, then
  // HttpException (validation, Fastify's own 4xx, 404/405 routing).
  app.useGlobalFilters(
    new ProblemFallbackFilter(),
    createDomainExceptionFilter(ERROR_MAP, DOMAIN_ERRORS, { logger: pinoLogger }),
    new HttpExceptionFilter({ logger: pinoLogger }),
  );

  // SIGTERM → app.close(): ReadinessService.beforeApplicationShutdown flips
  // /readyz to 503, Nest then drains this listener, and the admin server
  // closes last (onApplicationShutdown) — see @base/observability.
  app.enableShutdownHooks();

  return app;
}
