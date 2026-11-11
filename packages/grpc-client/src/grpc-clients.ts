import {
  Channel,
  type ChannelCredentials,
  type ChannelOptions,
  type ClientOptions,
  credentials,
} from "@grpc/grpc-js";
import { type Meter, metrics } from "@opentelemetry/api";

import {
  type GrpcTargetConfig,
  grpcTargetProblems,
  type ResolvedGrpcTarget,
  resolveGrpcTarget,
} from "./grpc-config.js";
import {
  type BreakerState,
  createInstruments,
  type PolicyLogger,
  TargetPolicy,
} from "./grpc-policy.js";
import { serviceConfigOf } from "./service-config.js";

export interface GrpcClientsOptions {
  /** Breaker transitions are logged here; silent without one. */
  logger?: PolicyLogger;
  /** Default: the global meter provider's `grpc.client` meter. */
  meter?: Meter;
  /**
   * Milliseconds left of the caller's budget (`remainingMs` from
   * @base/common): a call's deadline never outlives it — gRPC sends the
   * deadline on as `grpc-timeout` — and a spent budget fails the call with
   * DEADLINE_EXCEEDED before it is sent. Default: no budget.
   */
  getRemainingMs?: () => number | undefined;
  /** Credentials for the targets that are not `insecure`. Default: TLS with the system roots. */
  credentials?: ChannelCredentials;
  /** Extra channel options for every target (message sizes, authority, …); the policy's own keys win. */
  channelOptions?: ChannelOptions;
}

/** A generated (or `makeGenericClientConstructor`) client class. */
export type GrpcClientConstructor<C> = new (
  address: string,
  creds: ChannelCredentials,
  options?: ClientOptions,
) => C;

interface Target {
  config: ResolvedGrpcTarget;
  channel: Channel;
  credentials: ChannelCredentials;
  policy: TargetPolicy;
}

/** The channel options that carry a target's policy into grpc-js. */
export function channelOptionsOf(target: ResolvedGrpcTarget): ChannelOptions {
  return {
    "grpc.service_config": JSON.stringify(serviceConfigOf(target)),
    // This config only: one a resolver would supply (a DNS TXT record) is ignored.
    "grpc.service_config_disable_resolution": 1,
    ...(target.keepalive.timeMs > 0
      ? {
          "grpc.keepalive_time_ms": target.keepalive.timeMs,
          "grpc.keepalive_timeout_ms": target.keepalive.timeoutMs,
        }
      : {}),
  };
}

/**
 * Outbound gRPC, one channel and one resilience policy per configured target
 * — wiring, not a client of its own: grpc-js implements the deadline, the
 * retries, their throttling and the balancing (service config); this adds
 * the circuit breaker, the metrics and the span, as an interceptor.
 *
 *   const grpc = new GrpcClients(targets, { logger, getRemainingMs: remainingMs });
 *   const invoices = grpc.client("billing", InvoicesClient);
 *   …
 *   grpc.close();
 */
export class GrpcClients {
  readonly #targets = new Map<string, Target>();
  readonly #dispose: () => void;
  #closed = false;

  constructor(targets: GrpcTargetConfig[], opts: GrpcClientsOptions = {}) {
    const resolved = targets.map((target) => resolveGrpcTarget(target));
    const problems = grpcTargetProblems(resolved);
    if (problems.length > 0) throw new Error(`invalid gRPC targets: ${problems.join("; ")}`);

    const instruments = createInstruments(opts.meter ?? metrics.getMeter("grpc.client"), () =>
      [...this.#targets].map(([name, { policy }]) => [name, policy.breakerState]),
    );
    this.#dispose = () => {
      instruments.dispose();
    };
    for (const config of resolved) {
      const creds = config.insecure
        ? credentials.createInsecure()
        : (opts.credentials ?? credentials.createSsl());
      this.#targets.set(config.name, {
        config,
        credentials: creds,
        channel: new Channel(config.address, creds, {
          ...opts.channelOptions,
          ...channelOptionsOf(config),
        }),
        policy: new TargetPolicy(config, instruments, {
          logger: opts.logger,
          getRemainingMs: opts.getRemainingMs,
        }),
      });
    }
  }

  /**
   * A client of the target, on its shared channel and under its policy.
   * Cheap: make one per service the target serves. Never close it yourself.
   */
  client<C>(name: string, Client: GrpcClientConstructor<C>): C {
    const { address, credentials: creds, options } = this.clientOptions(name);
    return new Client(address, creds, options);
  }

  /** The constructor arguments `client()` passes — for a client built another way. */
  clientOptions(name: string): {
    address: string;
    credentials: ChannelCredentials;
    options: ClientOptions;
  } {
    if (this.#closed) throw new Error("GrpcClients is closed");
    const target = this.#targets.get(name);
    if (target === undefined) throw new Error(`unknown gRPC target: ${name}`);
    return {
      address: target.config.address,
      credentials: target.credentials,
      options: { channelOverride: target.channel, interceptors: [target.policy.interceptor] },
    };
  }

  /** Breaker state per target (for a health endpoint); "disabled" without a breaker. */
  circuitBreakerStates(): Record<string, BreakerState> {
    return Object.fromEntries(
      [...this.#targets].map(([name, { policy }]) => [name, policy.breakerState]),
    );
  }

  /**
   * Closes every channel: calls in flight fail with CANCELLED (gRPC has no
   * client-side drain) — close after whatever makes the calls has stopped.
   */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#dispose();
    for (const { channel, policy } of this.#targets.values()) {
      channel.close();
      policy.shutdown();
    }
  }
}
