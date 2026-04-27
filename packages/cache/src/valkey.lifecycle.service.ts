import { Inject, Injectable, OnApplicationShutdown } from "@nestjs/common";
import type { Redis as Valkey } from "iovalkey";

import type { ValkeyMetricsHandle } from "./valkey-metrics.js";

import { VALKEY_CLIENT, VALKEY_METRICS } from "./valkey.provider.js";

/**
 * Ensures the Valkey client is gracefully disconnected on application shutdown.
 * client.quit() sends QUIT to the server and closes the TCP socket cleanly,
 * allowing any in-flight commands to complete before the connection drops.
 *
 * Also disposes the OTel metrics handle so the observable-gauge callback is
 * removed from the meter; otherwise the SDK keeps polling a dead client.
 */
@Injectable()
export class ValkeyLifecycleService implements OnApplicationShutdown {
  constructor(
    @Inject(VALKEY_CLIENT) private readonly valkey: Valkey,
    @Inject(VALKEY_METRICS) private readonly metrics: ValkeyMetricsHandle,
  ) {}

  async onApplicationShutdown(): Promise<void> {
    this.metrics.dispose();
    await this.valkey.quit();
  }
}
