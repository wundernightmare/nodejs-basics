/**
 * Service URLs the e2e tests target. The stack runs via `just stack-up`, which
 * publishes the api on :3000, its admin server on :9091 and the worker's admin
 * server on :9093 (see docker/stack.yml). Override via env to point at another
 * environment.
 */
export const API_URL = process.env["API_URL"] ?? "http://localhost:3000";
export const API_ADMIN_URL = process.env["API_ADMIN_URL"] ?? "http://localhost:9091";
export const WORKER_ADMIN_URL = process.env["WORKER_ADMIN_URL"] ?? "http://localhost:9093";
