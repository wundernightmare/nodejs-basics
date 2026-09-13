/**
 * YAML configuration loader for NestJS ConfigModule.
 *
 * Reads a YAML file (default: config.yaml in CWD, or APP_CONFIG_FILE path)
 * and back-fills any key that is not already present in process.env.
 * Environment variables always take precedence over file values.
 *
 *   Priority (highest → lowest):
 *     1. Environment variables (set before process start)
 *     2. Structured YAML key  (e.g. database.url → DATABASE_URL)
 *     3. Flat YAML key        (e.g. DATABASE_URL: value)
 *     4. Default values in the registry
 *
 * The loader also calls validateRequiredKeys() which checks that every
 * variable marked `required: true` in the registry is present after merging.
 * Missing required keys are collected and thrown as a single startup error so
 * the full list is visible at once.
 *
 * Usage in AppModule:
 *   ConfigModule.forRoot({ load: [yamlConfigLoader] })
 *
 * The loader also remembers where each registered key came from, so
 * configSnapshot() can show an operator the effective configuration with its
 * provenance (GET /admin/config on the admin server, secrets redacted there).
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { parse as parseYaml } from "yaml";

import { ENV_REGISTRY } from "./env.registry.js";

function serializeValue(value: unknown): string {
  if (Array.isArray(value)) {
    return value
      .map((v) => (v === null || typeof v !== "object" ? String(v) : JSON.stringify(v)))
      .join(",");
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return JSON.stringify(value);
}

function getNestedValue(obj: Record<string, unknown>, path: string): unknown {
  let current: unknown = obj;
  for (const key of path.split(".")) {
    if (current === null || typeof current !== "object" || Array.isArray(current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

/** Where the effective value of a registered key came from. */
export type ConfigSource = "env" | "yaml" | "default" | "unset";

export interface ConfigSnapshot {
  /** Effective value per ENV_REGISTRY key (null when unset). NOT redacted. */
  config: Record<string, string | null>;
  /** Provenance per key. */
  sources: Record<string, ConfigSource>;
}

const sources = new Map<string, ConfigSource>();

/**
 * The effective configuration: every ENV_REGISTRY key with the value the
 * process is actually running with (after env, YAML and defaults) and where
 * it came from. Raw values — pass through redact() (@base/logger) before
 * showing it to anyone; the admin server does.
 */
export function configSnapshot(): ConfigSnapshot {
  const config: Record<string, string | null> = {};
  const provenance: Record<string, ConfigSource> = {};
  for (const entry of ENV_REGISTRY) {
    const value = process.env[entry.key];
    config[entry.key] = value ?? null;
    provenance[entry.key] = sources.get(entry.key) ?? (value === undefined ? "unset" : "env");
  }
  return { config, sources: provenance };
}

function recordEnvSources(): void {
  for (const entry of ENV_REGISTRY) {
    if (process.env[entry.key] !== undefined) sources.set(entry.key, "env");
  }
}

export function yamlConfigLoader(): Record<string, unknown> {
  const configPath = resolve(process.env["APP_CONFIG_FILE"] ?? "config.yaml");
  recordEnvSources();

  if (!existsSync(configPath)) {
    // Not an error — running without a file is valid in container environments
    // where every value comes from environment variables.
    applyDefaults();
    validateRequiredKeys();
    return {};
  }

  const raw = readFileSync(configPath, "utf-8");
  const parsed = parseYaml(raw) as Record<string, unknown> | null;

  if (!parsed || typeof parsed !== "object") {
    applyDefaults();
    validateRequiredKeys();
    return {};
  }

  // Step 1: structured (nested) YAML paths from the registry.
  for (const entry of ENV_REGISTRY) {
    if (!entry.yaml) continue;
    if (process.env[entry.key] !== undefined) continue;
    const value = getNestedValue(parsed, entry.yaml);
    if (value !== null && value !== undefined) {
      process.env[entry.key] = serializeValue(value);
      sources.set(entry.key, "yaml");
    }
  }

  // Step 2: back-fill flat top-level scalar keys.
  for (const [key, value] of Object.entries(parsed)) {
    if (value === null || value === undefined) continue;
    if (typeof value === "object" && !Array.isArray(value)) continue;
    if (process.env[key] !== undefined) continue;
    process.env[key] = serializeValue(value);
    sources.set(key, "yaml");
  }

  applyDefaults();
  validateRequiredKeys();

  return parsed;
}

/**
 * Apply registry defaults for keys that are still unset after YAML + env merge.
 */
function applyDefaults(): void {
  for (const entry of ENV_REGISTRY) {
    if (process.env[entry.key] === undefined && entry.default !== undefined) {
      process.env[entry.key] = entry.default;
      sources.set(entry.key, "default");
    }
  }
}

function validateRequiredKeys(): void {
  const missing = ENV_REGISTRY.filter(
    (e) => e.required && (process.env[e.key] === undefined || process.env[e.key] === ""),
  ).map((e) => e.key);

  if (missing.length === 0) return;

  throw new Error(
    `Missing required configuration:\n` +
      missing.map((k) => `  - ${k}`).join("\n") +
      `\n\nSet them as environment variables or add them to config.yaml.`,
  );
}
