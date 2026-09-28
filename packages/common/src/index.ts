// Utilities
export {
  actorStorage,
  DEBUG_LOGGING_HEADER,
  DEBUG_TOKEN_HEADER,
  debugLoggingStorage,
  getRequestId,
  isDebugLogging,
  isValidRequestId,
  REQUEST_ID_HEADER,
  requestIdStorage,
  tenantStorage,
  withActor,
  withDebugLogging,
  withRequestId,
  withTenant,
} from "./utils/request-context.js";
export {
  callBudgetMs,
  DeadlineExceededError,
  parseTimeoutMs,
  remainingMs,
  REQUEST_TIMEOUT_HEADER,
  withDeadline,
} from "./utils/deadline.js";
export {
  generateErrorId,
  generateId,
  generateRequestId,
  generateStateToken,
  generateToken,
} from "./utils/nanoid.js";
export {
  HTTP_STATUS_TITLES,
  PROBLEM_CONTENT_TYPE,
  PROBLEM_DETAIL_SCHEMA,
  type ProblemDetail,
  problemDetail,
} from "./utils/problem-detail.js";

// HTTP (Fastify) wiring
export {
  genRequestId,
  registerRequestContext,
  type RequestContextOptions,
  secretEquals,
} from "./http/request-context.hooks.js";

// Ports
export { UNIT_OF_WORK, type IUnitOfWork } from "./ports/unit-of-work.port.js";

// Errors
export { DomainError } from "./errors/domain-error.base.js";
export { OptimisticLockConflictError } from "./errors/optimistic-lock.error.js";

// Filters
export {
  createDomainExceptionFilter,
  type ErrorMap,
  type ErrorMapping,
  type FilterLogger,
} from "./filters/domain-exception.filter.js";
export { HttpExceptionFilter } from "./filters/http-exception.filter.js";
