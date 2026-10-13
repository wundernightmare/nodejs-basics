import type { IncomingMessage, ServerResponse } from "node:http";

import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException } from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";

import { generateErrorId } from "../utils/nanoid.js";
import { PROBLEM_CONTENT_TYPE, problemDetail } from "../utils/problem-detail.js";

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

    // problemDetail() adds the request_id extension from the request context.
    const problem = problemDetail(status, detail, { instance: request.url, errorId });

    if (typeof (reply as FastifyReply).status === "function") {
      void (reply as FastifyReply)
        .status(status)
        .header("Content-Type", PROBLEM_CONTENT_TYPE)
        .send(problem);
    } else {
      const res = reply as ServerResponse;
      res.statusCode = status;
      res.setHeader("Content-Type", PROBLEM_CONTENT_TYPE);
      res.end(JSON.stringify(problem));
    }
  }
}
