// Telemetry MUST be the first import so instrumentation registers before any
// application modules load.
import "./instrumentation.js";

import "reflect-metadata";

import { NestFactory } from "@nestjs/core";

import { AppLogger } from "@base/logger";

import { WorkerModule } from "./worker.module.js";

/**
 * The worker has no inbound HTTP application — it is a headless background
 * process (Kafka consumer + BullMQ worker) with the shared observability admin
 * server (metrics/livez/readyz) on ADMIN_PORT. createApplicationContext fires
 * the onApplicationBootstrap hooks (consumer.run, the BullMQ worker, the admin
 * server) and the open Kafka/Valkey handles keep the event loop alive.
 */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(WorkerModule, { bufferLogs: true });
  const logger = app.get(AppLogger);
  app.useLogger(logger);
  app.enableShutdownHooks();
  logger.log("Worker started — consuming tasks.events", "Bootstrap");
}

void bootstrap();
