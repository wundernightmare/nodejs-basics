import type { ConfigService } from "@nestjs/config";
import type { ConnectionOptions } from "bullmq";

import { buildValkeyConfig, toBullMqOptions } from "@base/cache";

/**
 * Build BullMQ's ConnectionOptions from the shared VALKEY_* env surface.
 *
 * BullMQ builds its own ioredis connections internally (blocking commands
 * do not share with the regular ioredis pool), so we cannot reuse
 * VALKEY_CLIENT directly. The TLS / timeout / pool shape stays identical;
 * BullMQ only differs in the `maxRetriesPerRequest: null` +
 * `enableReadyCheck: false` pair its blocking-command semantics require.
 */
export function createBullMQConnection(config: ConfigService): ConnectionOptions {
  const built = buildValkeyConfig(config);
  return toBullMqOptions(built) as ConnectionOptions;
}
