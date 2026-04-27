import { type DynamicModule, Global, Module, type Provider } from "@nestjs/common";

import { IdempotencyInterceptor } from "./idempotency.interceptor.js";
import { valkeyIdempotencyStoreProvider } from "./idempotency.store.js";

/**
 * Use the default Valkey-backed store:
 *   imports: [IdempotencyModule.forRoot()]
 *
 * Provide a custom store implementation:
 *   imports: [IdempotencyModule.forRoot({
 *     storeProvider: { provide: IDEMPOTENCY_STORE, useClass: MyMemoryStore }
 *   })]
 */
@Global()
@Module({})
export class IdempotencyModule {
  static forRoot(options: { storeProvider?: Provider } = {}): DynamicModule {
    const storeProvider = options.storeProvider ?? valkeyIdempotencyStoreProvider;
    return {
      module: IdempotencyModule,
      providers: [storeProvider, IdempotencyInterceptor],
      exports: [IdempotencyInterceptor, storeProvider],
    };
  }
}
