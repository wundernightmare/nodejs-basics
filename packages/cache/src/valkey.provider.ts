import type { FactoryProvider } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Redis as Valkey, type RedisOptions } from "iovalkey";

import { DependencyCircuitBreaker } from "@base/resilience";

import { buildValkeyConfig, toClientOptions } from "./valkey-config.builder.js";
import { registerValkeyMetrics, type ValkeyMetricsHandle } from "./valkey-metrics.js";

export const VALKEY_CLIENT = Symbol("VALKEY_CLIENT");

/** DI token for the shared Valkey circuit breaker. */
export const VALKEY_BREAKER = Symbol("VALKEY_BREAKER");

/** DI token for the Valkey OTel metrics handle (disposable). */
export const VALKEY_METRICS = Symbol("VALKEY_METRICS");

/**
 * Nest `FactoryProvider` for the shared Valkey client.
 *
 * Wires the full VALKEY_* env surface (TLS CA, timeouts, pool, reconnect,
 * retry) through `buildValkeyConfig` so every knob is driven by a single
 * registered env key — see infra/valkey/valkey-config.builder.ts.
 * Local / dev defaults are preserved: plaintext `redis://localhost:6379`
 * with `maxRetriesPerRequest=3` + `lazyConnect` + `enableOfflineQueue=false`.
 */
export const valkeyProvider: FactoryProvider<Valkey> = {
  provide: VALKEY_CLIENT,
  inject: [ConfigService],
  useFactory: (config: ConfigService): Valkey => {
    const built = buildValkeyConfig(config);
    const opts = toClientOptions(built) as RedisOptions;
    return new Valkey(opts);
  },
};

/**
 * OTel `valkey.client.*` metrics bound to the shared client. Registered as
 * a separate provider so the lifecycle service can dispose the batch-
 * observable callback on shutdown — otherwise OTel SDK keeps the gauge
 * callback registered and tests leak cross-suite.
 */
export const valkeyMetricsProvider: FactoryProvider<ValkeyMetricsHandle> = {
  provide: VALKEY_METRICS,
  inject: [VALKEY_CLIENT],
  useFactory: (client: Valkey): ValkeyMetricsHandle =>
    registerValkeyMetrics(client, { client_id: process.env["OTEL_SERVICE_NAME"] ?? "app" }),
};

/**
 * Singleton Valkey circuit breaker for call sites that want fast-fail on
 * a persistently-down cache / idempotency store. Off by default — flip
 * via VALKEY_CB_ENABLED=true per deployment.
 *
 * Intended call shape: `breaker.execute(() => valkey.get(key))`.
 * iovalkey's internal `maxRetriesPerRequest` handles transient socket
 * hiccups; the breaker sits above that to short-circuit when the
 * cluster is genuinely gone.
 */
export const valkeyBreakerProvider: FactoryProvider<DependencyCircuitBreaker> = {
  provide: VALKEY_BREAKER,
  inject: [ConfigService],
  useFactory: (config: ConfigService): DependencyCircuitBreaker => {
    const built = buildValkeyConfig(config);
    return new DependencyCircuitBreaker("valkey", built.circuitBreaker, {
      errorFilter: (err) => {
        // Exclude user-logic errors (WRONGTYPE, etc.) from breaker budget.
        const msg = (err as Error | undefined)?.message ?? "";
        return /WRONGTYPE|NOSCRIPT|NOGROUP|BUSYGROUP/.test(msg);
      },
    });
  },
};
