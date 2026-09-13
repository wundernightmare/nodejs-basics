import { type ArgumentsHost, Catch, type ExceptionFilter } from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";

import { generateErrorId, PROBLEM_CONTENT_TYPE, problemDetail } from "@base/common";
import { ecsError, pinoLogger } from "@base/logger";

/**
 * The last line of defence: an error that is neither a domain error (mapped
 * by ERROR_MAP) nor an HttpException (validation, Fastify's own 4xx, routing)
 * — a driver error, a bug — is still answered as an RFC 9457 problem, never
 * as NestJS's bare `{"statusCode":500,"message":"Internal server error"}`.
 * The contract (api/tsp) says every error body is a Problem; this filter
 * keeps that true for the 500 nobody planned. The message never leaks: the
 * body carries the errorId, the log line carries the stack.
 */
@Catch()
export class ProblemFallbackFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const reply = ctx.getResponse<FastifyReply>();
    const request = ctx.getRequest<FastifyRequest>();
    const errorId = generateErrorId();
    const err = exception instanceof Error ? exception : new Error(String(exception));

    pinoLogger.error(
      {
        ...ecsError(err),
        "error.id": errorId,
        "http.route": request.routeOptions?.url ?? "unknown",
      },
      "Unhandled error",
    );

    void reply
      .status(500)
      .header("Content-Type", PROBLEM_CONTENT_TYPE)
      .send(problemDetail(500, "Internal server error", { instance: request.url, errorId }));
  }
}
