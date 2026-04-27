import { type FactoryProvider, Global, Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

import { buildDbRateLimiter, DbRateLimiter } from "@base/resilience";

import {
  PG_BREAKER,
  PG_CONFIG,
  PG_PASSWORD_WATCHER,
  PG_POOL,
  PG_POOL_READONLY,
  pgBreakerProvider,
  pgConfigProvider,
  pgPasswordWatcherProvider,
  pgPoolProvider,
  pgReadonlyPoolProvider,
} from "./pg-pool.provider.js";

const dbRateLimiterProvider: FactoryProvider<DbRateLimiter> = {
  provide: DbRateLimiter,
  inject: [ConfigService],
  useFactory: (config: ConfigService): DbRateLimiter =>
    new DbRateLimiter(buildDbRateLimiter(config)),
};

/**
 * Global module exposing a tuned PG pool, optional read-only pool, secret-file
 * watcher (for K8s rotation), shared circuit breaker, and per-tenant rate limiter.
 *
 * NOT included: an ORM service — bring your own (Prisma, Drizzle, plain pg).
 * The pool exposed at PG_POOL is the same instance you'd hand to your ORM's
 * adapter (e.g. `new PrismaPg(pool.options)`).
 *
 * See README for the recommended UnitOfWork + transactionStorage pattern.
 */
@Global()
@Module({
  providers: [
    pgConfigProvider,
    pgPasswordWatcherProvider,
    pgPoolProvider,
    pgReadonlyPoolProvider,
    pgBreakerProvider,
    dbRateLimiterProvider,
  ],
  exports: [PG_POOL, PG_POOL_READONLY, PG_CONFIG, PG_BREAKER, PG_PASSWORD_WATCHER, DbRateLimiter],
})
export class DatabaseModule {}
