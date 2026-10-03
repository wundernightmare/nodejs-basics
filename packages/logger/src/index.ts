export { AppLogger } from "./app-logger.service.js";
export {
  DEFAULT_LOG_LEVEL_MAX_TTL_MS,
  formatDuration,
  LOG_LEVEL_NAMES,
  LOG_LEVEL_VALUES,
  LogLevel,
  type LogLevelChangeReason,
  type LogLevelName,
  type LogLevelOptions,
  type LogLevelState,
  parseDuration,
  parseLogLevelStrict,
} from "./log-level.js";
export { LoggerModule } from "./logger.module.js";
export {
  buildPinoOptions,
  ECS_VERSION,
  ecsError,
  logLevel,
  pinoLogger,
  serviceIdentity,
} from "./pino.config.js";
export { isSecretKey, REDACTED, redact, redactUrl } from "./redact.js";

// Request-context switches the logger honours, re-exported so packages that
// depend on @base/logger but not on @base/common (worker, observability) can
// mark one message / one request: see @base/common request-context.
export {
  DEBUG_LOGGING_HEADER,
  DEBUG_TOKEN_HEADER,
  generateRequestId,
  getRequestId,
  isDebugLogging,
  isValidRequestId,
  REQUEST_ID_HEADER,
  withDebugLogging,
  withRequestId,
} from "@base/common";
export { LOG_EVENTS, type LogEvent, logEventsReference } from "./log-events.js";
