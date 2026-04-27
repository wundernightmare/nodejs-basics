export type OutboundErrorKind = "transient" | "fatal";

/**
 * Typed outbound error. `kind` drives routing in consumer workers:
 *   - transient → push Kafka message to the retry topic.
 *   - fatal     → move to DLQ or discard.
 */
export class OutboundError extends Error {
  constructor(
    public readonly kind: OutboundErrorKind,
    /** Short label for metric `error_type` attribute. */
    public readonly errorType: string,
    message: string,
    /** The original thrown value. */
    public override readonly cause?: unknown,
    /** Which target group produced this error. */
    public readonly target?: string,
    /** Last HTTP status code seen, if any. */
    public readonly statusCode?: number,
  ) {
    super(message);
    this.name = "OutboundError";
  }

  static circuitOpen(target: string): OutboundError {
    return new OutboundError(
      "transient",
      "circuit_open",
      `Circuit breaker open: ${target}`,
      undefined,
      target,
    );
  }

  static rateLimited(target: string): OutboundError {
    return new OutboundError(
      "transient",
      "rate_limited",
      `Rate limit exceeded: ${target}`,
      undefined,
      target,
    );
  }

  static network(cause: unknown, target?: string): OutboundError {
    return new OutboundError("transient", "network", "Network error", cause, target);
  }

  static timeout(target: string): OutboundError {
    return new OutboundError(
      "transient",
      "timeout",
      `Request timed out: ${target}`,
      undefined,
      target,
    );
  }

  static retriesExhausted(target: string, lastStatus: number): OutboundError {
    return new OutboundError(
      "transient",
      "retries_exhausted",
      `Retries exhausted (last status: ${lastStatus}): ${target}`,
      undefined,
      target,
      lastStatus,
    );
  }

  static clientError(status: number, target: string): OutboundError {
    return new OutboundError(
      "fatal",
      "client_error",
      `HTTP ${status}: ${target}`,
      undefined,
      target,
      status,
    );
  }

  static noMatchingTarget(url: string): OutboundError {
    return new OutboundError("fatal", "no_matching_target", `No configured target matches: ${url}`);
  }

  static shuttingDown(): OutboundError {
    return new OutboundError("fatal", "shutting_down", "Client is shutting down");
  }
}

/**
 * Semantic wrapper for Kafka worker context.
 * Convert an `OutboundError` to `PostbackError` to get explicit Kafka routing.
 */
export class PostbackError extends Error {
  constructor(
    public readonly routing: "retry_topic" | "dlq",
    public override readonly cause: OutboundError,
  ) {
    super(cause.message);
    this.name = "PostbackError";
  }

  static from(err: OutboundError): PostbackError {
    return new PostbackError(err.kind === "transient" ? "retry_topic" : "dlq", err);
  }
}
