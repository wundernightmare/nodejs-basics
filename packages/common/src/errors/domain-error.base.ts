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
 */
export abstract class DomainError extends Error {
  abstract readonly _tag: string;

  constructor(message: string) {
    super(message);
    this.name = this.constructor.name;
  }
}
