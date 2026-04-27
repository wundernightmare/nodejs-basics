import { Global, Module } from "@nestjs/common";

import { ValkeyLifecycleService } from "./valkey.lifecycle.service.js";
import {
  VALKEY_BREAKER,
  VALKEY_CLIENT,
  VALKEY_METRICS,
  valkeyBreakerProvider,
  valkeyMetricsProvider,
  valkeyProvider,
} from "./valkey.provider.js";

@Global()
@Module({
  providers: [valkeyProvider, valkeyBreakerProvider, valkeyMetricsProvider, ValkeyLifecycleService],
  exports: [VALKEY_CLIENT, VALKEY_BREAKER, VALKEY_METRICS],
})
export class ValkeyModule {}
