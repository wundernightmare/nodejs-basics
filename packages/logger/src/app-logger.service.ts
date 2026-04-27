/**
 * NestJS LoggerService backed by pino.
 *
 * Implements LoggerService so it can be passed to:
 *   app.useLogger(appLogger)             – replaces the NestJS bootstrap logger
 *   new Logger(ctx) from @nestjs/common  – all calls are delegated here
 *   @Inject(AppLogger)                   – direct injection into services
 *
 * NestJS Logger.error(message, stack?, context?) convention is handled
 * explicitly: if the second argument contains a newline it is treated as a
 * stack trace and mapped to ECS error.* fields.
 */
import { Injectable, type LogLevel, type LoggerService, Optional } from "@nestjs/common";
import type { Logger as PinoInstance } from "pino";

import { ecsError, pinoLogger } from "./pino.config.js";

function isStackTrace(value: unknown): value is string {
  return typeof value === "string" && value.includes("\n    at ");
}

@Injectable()
export class AppLogger implements LoggerService {
  private readonly _pino: PinoInstance;

  constructor(@Optional() pinoInstance?: PinoInstance) {
    this._pino = pinoInstance ?? pinoLogger;
  }

  /**
   * Returns a child logger pre-bound to the given context label.
   */
  child(context: string): PinoInstance {
    return this._pino.child({ "log.logger": context });
  }

  // ─── LoggerService interface ───────────────────────────────────────────────

  log(message: unknown, context?: string): void {
    this._pino.info({ "log.logger": context }, stringify(message));
  }

  warn(message: unknown, context?: string): void {
    this._pino.warn({ "log.logger": context }, stringify(message));
  }

  debug(message: unknown, context?: string): void {
    this._pino.debug({ "log.logger": context }, stringify(message));
  }

  verbose(message: unknown, context?: string): void {
    this._pino.trace({ "log.logger": context }, stringify(message));
  }

  fatal(message: unknown, context?: string): void {
    this._pino.fatal({ "log.logger": context }, stringify(message));
  }

  /**
   * NestJS calls error() with two different signatures:
   *   error(message, context?)
   *   error(message, stack, context?)     — stack detected by "\n    at " pattern
   *   error(message, error, context?)     — Error object spreads ECS error.* fields
   */
  error(message: unknown, stackOrContextOrError?: string | Error, context?: string): void {
    if (stackOrContextOrError instanceof Error) {
      this._pino.error(
        { "log.logger": context, ...ecsError(stackOrContextOrError) },
        stringify(message),
      );
    } else if (isStackTrace(stackOrContextOrError)) {
      this._pino.error(
        { "log.logger": context, ...ecsError(stackOrContextOrError) },
        stringify(message),
      );
    } else {
      this._pino.error({ "log.logger": stackOrContextOrError ?? context }, stringify(message));
    }
  }

  setLogLevels(levels: LogLevel[]): void {
    const order: LogLevel[] = ["verbose", "debug", "log", "warn", "error", "fatal"];
    const lowest = order.find((l) => levels.includes(l));
    const pinoLevel: Record<string, string> = {
      verbose: "trace",
      debug: "debug",
      log: "info",
      warn: "warn",
      error: "error",
      fatal: "fatal",
    };
    if (lowest) this._pino.level = pinoLevel[lowest] ?? "info";
  }
}

function stringify(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Error) return value.message;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
