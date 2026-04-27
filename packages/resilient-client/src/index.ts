// Shared retry primitives — reused by non-HTTP clients (DB drivers) so the
// full-jitter curve is sourced from one place.
export { computeJitteredDelay, sleep } from "./backoff.js";
export type { BackoffSpec } from "./backoff.js";

// Errors
export { OutboundError, PostbackError } from "./resilient-client.errors.js";
export type { OutboundErrorKind } from "./resilient-client.errors.js";

// Cache adapters
export { MemoryCache, ValkeyCache, CachedBodyReadable } from "./resilient-client.cache.js";
export type {
  CachedEntry,
  CacheAdapter,
  CacheConfig,
  ValkeyLike,
} from "./resilient-client.cache.js";

// Single-target client
export { ResilientClient } from "./resilient-client.js";
export type {
  Logger,
  RetryConfig,
  RateLimitConfig,
  CircuitBreakerConfig,
  FallbackFn,
  AdaptiveConcurrencyConfig,
  ResilientClientConfig,
} from "./resilient-client.js";

// Multi-target pool
export {
  ResilientPool,
  StaticConfigAdapter,
  FunctionConfigAdapter,
  matchesSelector,
  extractBaseUrl,
} from "./resilient-client.pool.js";
export type { OutboundTargetConfig, ConfigAdapter } from "./resilient-client.pool.js";
