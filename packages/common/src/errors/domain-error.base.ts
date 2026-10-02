/**
 * Base class for domain errors. Use cases throw subclasses; the global
 * DomainExceptionFilter maps them to HTTP responses via an ERROR_MAP.
 *
 * Pattern:
 *   export class TenantNotFoundError extends DomainError {
 *     readonly _tag = "TenantNotFoundError" as const;
 *     constructor() { super("Tenant not found"); }
 *   }
 *
 * Map in your app:
 *   const ERROR_MAP: Record<string, ErrorMapping> = {
 *     TenantNotFoundError:    { status: 404 },
 *     TenantSlugConflictError: { status: 409 },
 *   };
 *   app.useGlobalFilters(new DomainExceptionFilter(ERROR_MAP, [TenantNotFoundError, ...]));
 *
 * An error that is worth retrying later (mapped to 429 or 503) sets
 * `retryAfterSeconds`; the filter sends it as `Retry-After`.
 */
export abstract class DomainError extends Error {
  abstract readonly _tag: string;
  readonly retryAfterSeconds?: number;

  constructor(message: string) {
    super(message);
    this.name = this.constructor.name;
  }
}
