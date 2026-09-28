/**
 * This app's OpenTelemetry service name, unless OTEL_SERVICE_NAME is set —
 * so the api and the worker never share one name in traces, logs and
 * metrics. Imported first by instrumentation.ts: @base/logger, the admin
 * server and the client metrics read the variable when their modules load.
 */
process.env["OTEL_SERVICE_NAME"] ??= "nodejs-basics-api";
