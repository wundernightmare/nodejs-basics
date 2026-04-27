import { type ArgumentsHost, Catch, type ExceptionFilter, HttpStatus } from "@nestjs/common";
import { metrics } from "@opentelemetry/api";
import type { FastifyReply, FastifyRequest } from "fastify";

import { generateErrorId } from "../utils/nanoid.js";
import { HTTP_STATUS_TITLES, PROBLEM_CONTENT_TYPE } from "../utils/problem-detail.js";

export interface ErrorMapping {
  status: number;
  /** Replacement detail message. Required for 5xx mappings (raw message may leak internals). */
  fallbackMessage?: string;
}

export type ErrorMap = Record<string, ErrorMapping>;

/**
 * Logger contract — pass any object that exposes `warn` and `error`.
 * Compatible with pino, NestJS Logger, console (with bound methods), etc.
 */
export interface FilterLogger {
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}

const noopLogger: FilterLogger = {
  warn: () => {},
  error: () => {},
};

/**
 * Catches domain errors thrown by use cases and maps them to RFC 9457
 * `application/problem+json` responses.
 *
 * Configure at bootstrap:
 *
 *   const ERROR_MAP: ErrorMap = {
 *     TenantNotFoundError: { status: 404 },
 *     OptimisticLockConflictError: { status: 409 },
 *   };
 *   const DOMAIN_ERRORS = [TenantNotFoundError, OptimisticLockConflictError];
 *
 *   app.useGlobalFilters(
 *     new DomainExceptionFilter(ERROR_MAP, DOMAIN_ERRORS, { logger: pinoLogger }),
 *   );
 *
 * NestJS's @Catch decorator requires the error classes at decoration time. We
 * use a factory so callers can pass their own list.
 */
export function createDomainExceptionFilter(
  errorMap: ErrorMap,
  domainErrors: ReadonlyArray<new (...args: never[]) => Error>,
  options: { logger?: FilterLogger } = {},
): ExceptionFilter {
  const logger = options.logger ?? noopLogger;
  const errorsCounter = metrics.getMeter("http.server").createCounter("errors.total", {
    description: "Total HTTP errors by type and route",
    unit: "{error}",
  });

  @Catch(...domainErrors)
  class DomainExceptionFilter implements ExceptionFilter {
    catch(exception: Error, host: ArgumentsHost): void {
      const ctx = host.switchToHttp();
      const reply = ctx.getResponse<FastifyReply>();
      const request = ctx.getRequest<FastifyRequest>();
      const mapping = errorMap[exception.name] ?? { status: HttpStatus.INTERNAL_SERVER_ERROR };
      const errorId = generateErrorId();

      logger.warn(
        { "error.type": exception.name, "error.message": exception.message, "error.id": errorId },
        "Domain error",
      );

      errorsCounter.add(1, {
        "error.type": exception.name,
        "http.route": request.routeOptions?.url ?? "unknown",
        "http.response.status_code": String(mapping.status),
      });

      // Never leak the raw message for 5xx — use the explicit `fallbackMessage`
      // when present, otherwise emit a generic title.
      const detail =
        mapping.status >= 500
          ? (mapping.fallbackMessage ?? "Internal server error")
          : exception.message;

      void reply
        .status(mapping.status)
        .header("Content-Type", PROBLEM_CONTENT_TYPE)
        .send({
          type: "about:blank",
          title: HTTP_STATUS_TITLES[mapping.status] ?? "Error",
          status: mapping.status,
          detail,
          instance: request.url,
          errorId,
        });
    }
  }

  return new DomainExceptionFilter();
}
