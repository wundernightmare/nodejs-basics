import type { IncomingMessage, ServerResponse } from "node:http";

import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException } from "@nestjs/common";
import { metrics } from "@opentelemetry/api";
import type { FastifyReply, FastifyRequest } from "fastify";

import { generateErrorId } from "../utils/nanoid.js";
import { HTTP_STATUS_TITLES, PROBLEM_CONTENT_TYPE } from "../utils/problem-detail.js";

import type { FilterLogger } from "./domain-exception.filter.js";

const noopLogger: FilterLogger = {
  warn: () => {},
  error: () => {},
};

/**
 * Catches NestJS `HttpException` (built-in 4xx/5xx, validation pipe errors)
 * and serialises them as RFC 9457 problem+json.
 *
 * Handles two response object types:
 *  - FastifyReply (route handlers, guards)
 *  - Node ServerResponse (NestJS middleware via @fastify/middie)
 */
@Catch(HttpException)
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger: FilterLogger;
  private readonly errorsCounter = metrics.getMeter("http.server").createCounter("errors.total", {
    description: "Total HTTP errors by type and route",
    unit: "{error}",
  });

  constructor(options: { logger?: FilterLogger } = {}) {
    this.logger = options.logger ?? noopLogger;
  }

  catch(exception: HttpException, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const reply = ctx.getResponse<FastifyReply | ServerResponse>();
    const request = ctx.getRequest<FastifyRequest | IncomingMessage>();
    const status = exception.getStatus();
    const errorId = generateErrorId();

    // ZodValidationPipe sends { message: string[], error: "Bad Request" }.
    // Other exceptions send { message: string } or a plain string.
    const body = exception.getResponse();
    let detail: string | undefined;
    if (typeof body === "string") {
      detail = body;
    } else if (typeof body === "object" && body !== null) {
      const b = body as Record<string, unknown>;
      if (Array.isArray(b["message"])) {
        detail = (b["message"] as string[]).join("; ");
      } else if (typeof b["message"] === "string" && b["message"]) {
        detail = b["message"];
      }
    }

    const route =
      (request as FastifyRequest).routeOptions !== undefined
        ? ((request as FastifyRequest).routeOptions.url ?? "unknown")
        : "unknown";

    this.errorsCounter.add(1, {
      "error.type": exception.constructor.name,
      "http.route": route,
      "http.response.status_code": String(status),
    });

    if (status >= 500) {
      this.logger.error(
        {
          "error.type": exception.constructor.name,
          "error.message": exception.message,
          "error.stack_trace": exception.stack,
          "error.id": errorId,
        },
        "Unhandled HTTP exception",
      );
    }

    const url = request.url;
    const problemDetail = {
      type: "about:blank",
      title: HTTP_STATUS_TITLES[status] ?? "Error",
      status,
      ...(detail !== undefined ? { detail } : {}),
      instance: url,
      errorId,
    };

    if (typeof (reply as FastifyReply).status === "function") {
      void (reply as FastifyReply)
        .status(status)
        .header("Content-Type", PROBLEM_CONTENT_TYPE)
        .send(problemDetail);
    } else {
      const res = reply as ServerResponse;
      res.statusCode = status;
      res.setHeader("Content-Type", PROBLEM_CONTENT_TYPE);
      res.end(JSON.stringify(problemDetail));
    }
  }
}
