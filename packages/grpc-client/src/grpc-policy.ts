import {
  type InterceptingCall,
  type Interceptor,
  type InterceptorOptions,
  type InterceptingListener,
  Metadata,
  type NextCall,
  status,
  type StatusObject,
} from "@grpc/grpc-js";
import {
  type Counter,
  context,
  type Histogram,
  type Meter,
  type ObservableResult,
  propagation,
  type Span,
  SpanKind,
  SpanStatusCode,
  type TextMapSetter,
  trace,
} from "@opentelemetry/api";
import CircuitBreaker from "opossum";

import type { ResolvedGrpcTarget } from "./grpc-config.js";

const TRACER = "@base/grpc-client";

/** Latency buckets (seconds) shared with the HTTP, db and Kafka histograms. */
const LATENCY_BUCKETS_SECONDS = [
  0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10,
];

/** What a finished call tells the breaker. */
export type BreakerOutcome = "success" | "failure" | "ignored";

export type BreakerState = "closed" | "open" | "halfOpen" | "disabled";

/** Trailer of the status this package makes for a call the breaker rejected. */
const CIRCUIT_OPEN_KEY = "x-circuit-open";
/** gRPC's count of the attempts before the one that answered (gRFC A6). */
const PREVIOUS_ATTEMPTS_KEY = "grpc-previous-rpc-attempts";

/** The outcome label of a call the breaker rejected. */
export const OUTCOME_CIRCUIT_OPEN = "circuit_open";

/**
 * The outcome labels of the status codes gRPC defines: the canonical names
 * in lower case — but for CANCELLED, spelt "canceled" like the HTTP client's
 * outcome (and golang-basics'), so one filter matches both.
 */
const CODE_OUTCOMES = [
  "ok",
  "canceled",
  "unknown",
  "invalid_argument",
  "deadline_exceeded",
  "not_found",
  "already_exists",
  "permission_denied",
  "resource_exhausted",
  "failed_precondition",
  "aborted",
  "out_of_range",
  "unimplemented",
  "internal",
  "unavailable",
  "data_loss",
  "unauthenticated",
] as const;

/** The outcome label of a status code; one gRPC does not define is "unknown" (bounded labels). */
export function outcomeOf(code: number): string {
  return CODE_OUTCOMES[code] ?? "unknown";
}

/**
 * What a status tells the breaker. The dependency failed or did not answer
 * in time — the caller's own deadline included: one shorter than the target's
 * timeout must not hide an outage. CANCELLED: the caller walked away. Every
 * other status is the dependency's verdict on the request (NOT_FOUND,
 * INVALID_ARGUMENT, RESOURCE_EXHAUSTED, …): it answered.
 */
export function classify(code: number): BreakerOutcome {
  if (code === CANCELLED) return "ignored";
  return FAILURE_CODES.has(code) ? "failure" : "success";
}

const CANCELLED: number = status.CANCELLED;
const FAILURE_CODES: ReadonlySet<number> = new Set([
  status.UNAVAILABLE,
  status.DEADLINE_EXCEEDED,
  status.INTERNAL,
  status.UNKNOWN,
  status.DATA_LOSS,
]);

/** Was the call rejected by this package's breaker (it reads as UNAVAILABLE otherwise)? */
export function isCircuitOpen(err: unknown): boolean {
  const metadata = (err as { metadata?: unknown } | null)?.metadata;
  return metadata instanceof Metadata && metadata.get(CIRCUIT_OPEN_KEY).length > 0;
}

export interface PolicyLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
}

export interface PolicyInstruments {
  requests: Counter;
  duration: Histogram;
  retries: Counter;
  /** Stops reporting the breaker states (the gauge's callback outlives its owner otherwise). */
  dispose(): void;
}

/**
 * The instruments of every target (the contract shared with golang-basics'
 * grpcx; `target` is the configured name, `method` the full gRPC method):
 *   grpc_client_requests_total{target,method,outcome}    one per call, not per attempt
 *   grpc_client_request_duration_seconds{target,method}  calls that reached gRPC, retries included
 *   grpc_client_retries_total{target}                    attempts before the one that answered
 *   grpc_client_circuit_breaker_state{target}            0 closed, 1 open, 2 half-open
 */
export function createInstruments(
  meter: Meter,
  states: () => Iterable<[string, BreakerState]>,
): PolicyInstruments {
  const requests = meter.createCounter("grpc_client_requests_total", {
    description: "Outbound gRPC calls by target, method and outcome (status code or circuit_open).",
  });
  const duration = meter.createHistogram("grpc_client_request_duration_seconds", {
    description:
      "Outbound gRPC call latency in seconds (retries included, a stream until it ends), by target and method.",
    unit: "s",
    advice: { explicitBucketBoundaries: LATENCY_BUCKETS_SECONDS },
  });
  const retries = meter.createCounter("grpc_client_retries_total", {
    description: "Retries sent (attempts before the one that answered), by target.",
  });
  const breakerState = meter.createObservableGauge("grpc_client_circuit_breaker_state", {
    description: "Circuit breaker state per target: 0 closed, 1 open, 2 half-open.",
  });
  const observe = (result: ObservableResult): void => {
    for (const [target, state] of states()) {
      if (state !== "disabled") result.observe(BREAKER_STATE[state], { target });
    }
  };
  breakerState.addCallback(observe);
  return {
    requests,
    duration,
    retries,
    dispose: () => {
      breakerState.removeCallback(observe);
    },
  };
}

/** Breaker state as a gauge value — the scale golang-basics uses. */
const BREAKER_STATE = { closed: 0, open: 1, halfOpen: 2 } as const;

const metadataSetter: TextMapSetter<Metadata> = {
  set(carrier, key, value) {
    carrier.set(key, value);
  },
};

const noop = (): void => {};

export interface PolicyOptions {
  logger?: PolicyLogger | undefined;
  /** Milliseconds left of the caller's budget (`remainingMs` from @base/common). */
  getRemainingMs?: (() => number | undefined) | undefined;
}

/**
 * One target's circuit breaker, instruments and span, applied to every call
 * as an interceptor. gRPC's own retries run below it, so it sees a call once.
 */
export class TargetPolicy {
  readonly target: string;
  readonly #breaker: CircuitBreaker<[Promise<void>], void> | undefined;
  readonly #m: PolicyInstruments;
  readonly #getRemainingMs: (() => number | undefined) | undefined;

  constructor(target: ResolvedGrpcTarget, instruments: PolicyInstruments, opts: PolicyOptions) {
    this.target = target.name;
    this.#m = instruments;
    this.#getRemainingMs = opts.getRemainingMs;

    const cfg = target.circuitBreaker;
    if (cfg.failureRatio > 0) {
      // The action is the call's own settlement: the breaker only keeps score.
      this.#breaker = new CircuitBreaker((settled: Promise<void>) => settled, {
        name: target.name,
        timeout: false, // the deadline is gRPC's
        errorThresholdPercentage: cfg.failureRatio * 100,
        volumeThreshold: cfg.minRequests,
        rollingCountTimeout: cfg.windowMs,
        resetTimeout: cfg.openTimeoutMs,
      });
      const { logger } = opts;
      this.#breaker.on("open", () => {
        logger?.warn({ grpc_target: target.name }, "gRPC circuit breaker opened");
      });
      this.#breaker.on("close", () => {
        logger?.info({ grpc_target: target.name }, "gRPC circuit breaker closed");
      });
    }
  }

  get breakerState(): BreakerState {
    if (this.#breaker === undefined) return "disabled";
    if (this.#breaker.opened) return "open";
    return this.#breaker.halfOpen ? "halfOpen" : "closed";
  }

  readonly interceptor: Interceptor = (options, nextCall) =>
    // The cast: an interceptor is typed to return grpc-js's InterceptingCall
    // class, of which the client only uses the InterceptingCallInterface.
    new PolicyCall(this, options, nextCall) as unknown as InterceptingCall;

  shutdown(): void {
    this.#breaker?.shutdown();
  }

  /** The time the call may still take, from the caller's budget; undefined = no budget. */
  budgetMs(): number | undefined {
    return this.#getRemainingMs?.();
  }

  /** Counts a call that never reached gRPC. */
  countUnsent(method: string, outcome: string): void {
    this.#m.requests.add(1, { target: this.target, method, outcome });
  }

  rejection(): StatusObject {
    const metadata = new Metadata();
    metadata.set(CIRCUIT_OPEN_KEY, this.target);
    return {
      code: status.UNAVAILABLE,
      details: `circuit breaker open: ${this.target}`,
      metadata,
    };
  }

  /**
   * Admits a call — the returned function settles it (gRPC ends a call once) and runs `then`
   * when the breaker has taken the outcome in (opossum keeps score on a
   * promise: a caller told of a failure must already find the breaker open)
   * — or rejects it (undefined) while the breaker is open or its probe is out.
   */
  admit(
    method: string,
  ): ((result: StatusObject, previousAttempts: number, then: () => void) => void) | undefined {
    const breaker = this.#breaker;
    let settle: (outcome: BreakerOutcome) => void = noop;
    let scored: Promise<unknown> | undefined;
    if (breaker !== undefined) {
      // opossum's own admission rule, read before fire() so the verdict is synchronous.
      if (!breaker.closed && !breaker.pendingClose) return undefined;
      const probe = breaker.halfOpen;
      const settled = new Promise<void>((resolve, reject) => {
        settle = (outcome) => {
          // opossum has no neutral outcome: an abandoned call counts as answered,
          // but an abandoned probe proved nothing — the breaker opens again.
          if (outcome === "failure" || (outcome === "ignored" && probe)) reject(new Error(outcome));
          else resolve();
        };
      });
      scored = breaker.fire(settled).catch(noop); // the caller gets gRPC's status, not this promise
    }

    const start = performance.now();
    return (result, retried, then) => {
      const labels = { target: this.target, method };
      this.#m.requests.add(1, { ...labels, outcome: outcomeOf(result.code) });
      this.#m.duration.record((performance.now() - start) / 1000, labels);
      if (retried > 0) this.#m.retries.add(retried, { target: this.target });
      settle(classify(result.code));
      if (scored === undefined) then();
      else void scored.then(then);
    };
  }
}

function previousAttempts(metadata: Metadata): number {
  const n = Number(metadata.get(PREVIOUS_ATTEMPTS_KEY)[0]);
  return Number.isInteger(n) ? n : 0;
}

/** `/pkg.Service/Method` → the span's name and rpc.* attributes. */
function startSpan(path: string, target: string): Span {
  const [service = "", method = ""] = path.replace(/^\//u, "").split("/");
  return trace.getTracer(TRACER).startSpan(`${service}/${method}`, {
    kind: SpanKind.CLIENT,
    attributes: {
      "rpc.system": "grpc",
      "rpc.service": service,
      "rpc.method": method,
      "peer.service": target,
    },
  });
}

function endSpan(span: Span, result: StatusObject): void {
  span.setAttribute("rpc.grpc.status_code", result.code);
  if (classify(result.code) === "failure") {
    span.setStatus({ code: SpanStatusCode.ERROR, message: result.details });
  }
  span.end();
}

/**
 * One call under a target's policy. The call below is created only once the
 * policy has admitted it: a rejected call never reaches the channel.
 */
class PolicyCall {
  readonly #policy: TargetPolicy;
  readonly #options: InterceptorOptions;
  readonly #nextCall: NextCall;
  #next: ReturnType<NextCall> | undefined;

  constructor(policy: TargetPolicy, options: InterceptorOptions, nextCall: NextCall) {
    this.#policy = policy;
    this.#options = options;
    this.#nextCall = nextCall;
  }

  start(metadata: Metadata, listener?: Partial<InterceptingListener>): void {
    const method = this.#options.method_definition.path;
    const fail = (result: StatusObject, outcome: string): void => {
      this.#policy.countUnsent(method, outcome);
      // After start() returns: the client sends its message and half-closes first.
      process.nextTick(() => listener?.onReceiveStatus?.(result));
    };

    // A spent budget says nothing about the dependency: not the breaker's business.
    const budget = this.#policy.budgetMs();
    if (budget !== undefined && budget <= 0) {
      const result = {
        code: status.DEADLINE_EXCEEDED,
        details: "deadline exceeded before the call was sent",
        metadata: new Metadata(),
      };
      fail(result, outcomeOf(result.code));
      return;
    }

    const settle = this.#policy.admit(method);
    if (settle === undefined) {
      fail(this.#policy.rejection(), OUTCOME_CIRCUIT_OPEN);
      return;
    }

    const span = startSpan(method, this.#policy.target);
    propagation.inject(trace.setSpan(context.active(), span), metadata, metadataSetter);

    let attempts = 0;
    this.#next = this.#nextCall(withBudget(this.#options, budget));
    this.#next.start(metadata, {
      onReceiveMetadata: (received) => {
        attempts = previousAttempts(received);
        listener?.onReceiveMetadata?.(received);
      },
      onReceiveMessage: (message) => listener?.onReceiveMessage?.(message),
      onReceiveStatus: (result) => {
        endSpan(span, result);
        settle(result, attempts || previousAttempts(result.metadata), () => {
          listener?.onReceiveStatus?.(result);
        });
      },
    });
  }

  sendMessageWithContext(messageContext: object, message: unknown): void {
    this.#next?.sendMessageWithContext(messageContext, message);
  }

  sendMessage(message: unknown): void {
    this.#next?.sendMessage(message);
  }

  startRead(): void {
    this.#next?.startRead();
  }

  halfClose(): void {
    this.#next?.halfClose();
  }

  cancelWithStatus(code: status, details: string): void {
    this.#next?.cancelWithStatus(code, details);
  }

  getPeer(): string {
    return this.#next?.getPeer() ?? "";
  }

  getAuthContext(): ReturnType<ReturnType<NextCall>["getAuthContext"]> {
    return this.#next?.getAuthContext() ?? null;
  }
}

/** The call's options with the deadline brought in to the caller's budget. */
function withBudget(options: InterceptorOptions, budget: number | undefined): InterceptorOptions {
  if (budget === undefined) return options;
  const at = Date.now() + budget;
  const own = options.deadline instanceof Date ? options.deadline.getTime() : options.deadline;
  return own !== undefined && own <= at ? options : { ...options, deadline: at };
}
