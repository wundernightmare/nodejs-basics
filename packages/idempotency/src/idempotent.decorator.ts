import { UseInterceptors, applyDecorators } from "@nestjs/common";

import { IdempotencyInterceptor } from "./idempotency.interceptor.js";

/**
 * Enables idempotency for the decorated handler.
 *
 * Clients must send an `Idempotency-Key: <uuid>` header.
 * Repeated requests with the same key return the cached response without
 * re-executing the handler.  See IdempotencyInterceptor for full details.
 */
export function Idempotent(): MethodDecorator {
  return applyDecorators(UseInterceptors(IdempotencyInterceptor));
}
