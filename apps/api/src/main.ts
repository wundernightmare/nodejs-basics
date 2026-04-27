// Telemetry MUST be the first import — instrumentation hooks register here
// before NestJS or any user code is loaded.
import "./instrumentation.js";

import "reflect-metadata";

import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import { NestFactory } from "@nestjs/core";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";

import {
  createDomainExceptionFilter,
  generateRequestId,
  HttpExceptionFilter,
  requestIdStorage,
  type ErrorMap,
} from "@base/common";
import { AppLogger, pinoLogger } from "@base/logger";
import { registerHttpInstrumentation } from "@base/observability";

import { AppModule } from "./app.module.js";
import { fastifyOtelInstrumentation } from "./instrumentation.js";

/**
 * Wire the domain error → HTTP status map for your app here.
 * Subclass DomainError in your modules and add entries to this map.
 */
const ERROR_MAP: ErrorMap = {
  OptimisticLockConflictError: { status: 409 },
};
const DOMAIN_ERRORS: Array<new (...args: never[]) => Error> = [
  // Add your DomainError subclasses here.
];

async function bootstrap(): Promise<void> {
  const adapter = new FastifyAdapter({
    disableRequestLogging: true, // we register our own access logs in registerHttpInstrumentation
    logger: pinoLogger,
    genReqId: (): string => generateRequestId(),
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

  // Per-request ALS for x-request-id — read by ResilientClient downstream so
  // outbound calls echo the same id and traces correlate.
  adapter.getInstance().addHook("onRequest", (req, _reply, done) => {
    requestIdStorage.run(req.id as string, () => done());
  });

  registerHttpInstrumentation(adapter.getInstance());

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

  // Global filters: domain errors first, then NestJS HttpException catch-all.
  app.useGlobalFilters(
    createDomainExceptionFilter(ERROR_MAP, DOMAIN_ERRORS, { logger: pinoLogger }),
    new HttpExceptionFilter({ logger: pinoLogger }),
  );

  app.enableShutdownHooks();

  const port = parseInt(process.env["PORT"] ?? "3000", 10);
  await app.listen(port, "0.0.0.0");
  appLogger.log(`Listening on http://0.0.0.0:${port}`, "Bootstrap");
}

bootstrap().catch((err) => {
  pinoLogger.fatal({ err }, "Bootstrap failed");
  process.exit(1);
});
