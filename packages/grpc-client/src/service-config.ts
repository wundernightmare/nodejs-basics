import { type ResolvedGrpcTarget, retries, splitMethod } from "./grpc-config.js";

/**
 * The gRPC service config
 * (https://github.com/grpc/grpc/blob/master/doc/service_config.md): the part
 * of a target's policy that @grpc/grpc-js implements itself.
 */
interface MethodConfig {
  name: Array<{ service?: string; method?: string }>;
  timeout?: string;
  waitForReady?: boolean;
  retryPolicy?: {
    maxAttempts: number;
    initialBackoff: string;
    maxBackoff: string;
    backoffMultiplier: number;
    retryableStatusCodes: string[];
  };
}

export interface ServiceConfig {
  loadBalancingConfig: Array<Record<string, Record<string, never>>>;
  methodConfig: MethodConfig[];
  retryThrottling?: { maxTokens: number; tokenRatio: number };
}

/** Doubles the backoff per retry, as the HTTP client does. */
const BACKOFF_MULTIPLIER = 2;

/** Milliseconds in protobuf's JSON duration form: decimal seconds, "0.1s". */
export function protoDuration(ms: number): string {
  return `${ms / 1000}s`;
}

/**
 * The service config of a validated target. The entry named `{}` is the
 * default for every method; with `retry.methods` a second entry, which gRPC
 * prefers for the methods it names, carries the retry policy.
 */
export function serviceConfigOf(target: ResolvedGrpcTarget): ServiceConfig {
  const base: MethodConfig = { name: [{}] };
  if (target.timeoutMs > 0) base.timeout = protoDuration(target.timeoutMs);
  if (target.waitForReady) base.waitForReady = true;

  const config: ServiceConfig = {
    loadBalancingConfig: [{ [target.loadBalancing]: {} }],
    methodConfig: [base],
  };
  if (!retries(target)) return config;

  const retryPolicy = {
    maxAttempts: target.retry.maxAttempts,
    initialBackoff: protoDuration(target.retry.baseDelayMs),
    maxBackoff: protoDuration(target.retry.maxDelayMs),
    backoffMultiplier: BACKOFF_MULTIPLIER,
    retryableStatusCodes: target.retry.codes,
  };
  if (target.retry.methods.length === 0) base.retryPolicy = retryPolicy;
  else {
    config.methodConfig.push({
      ...base,
      name: target.retry.methods.flatMap((method) => splitMethod(method) ?? []),
      retryPolicy,
    });
  }

  if (target.retry.throttle.maxTokens > 0) {
    config.retryThrottling = {
      maxTokens: target.retry.throttle.maxTokens,
      tokenRatio: target.retry.throttle.tokenRatio,
    };
  }
  return config;
}
