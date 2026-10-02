import { Inject, Injectable, type OnApplicationShutdown } from "@nestjs/common";
import { type Pool } from "pg";

import { type SecretFileWatcher } from "@base/config";
import { ecsError, pinoLogger } from "@base/logger";

import { PG_PASSWORD_WATCHER, PG_POOL, PG_POOL_READONLY } from "./pg-pool.provider.js";

/**
 * Closes what DatabaseModule opened: both pools (the read-only one only when
 * it is a separate pool, not an alias of the primary) and the password-file
 * watcher. Runs in onApplicationShutdown — the last hook, after every
 * beforeApplicationShutdown (e.g. the outbox relay's final drain) that may
 * still need a connection. Idempotent: a second call is a no-op.
 */
const logger = pinoLogger.child({ "log.logger": "DatabaseLifecycle" });

@Injectable()
export class DatabaseLifecycleService implements OnApplicationShutdown {
  private closed = false;

  constructor(
    @Inject(PG_POOL) private readonly primary: Pool,
    @Inject(PG_POOL_READONLY) private readonly readonly: Pool,
    @Inject(PG_PASSWORD_WATCHER) private readonly watcher: SecretFileWatcher | null,
  ) {}

  async onApplicationShutdown(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.watcher?.stop();
    const pools = this.readonly === this.primary ? [this.primary] : [this.primary, this.readonly];
    const results = await Promise.allSettled(pools.map((pool) => pool.end()));
    for (const r of results) {
      if (r.status === "rejected")
        logger.warn({ ...ecsError(r.reason as Error) }, "Postgres pool end failed");
    }
  }
}
