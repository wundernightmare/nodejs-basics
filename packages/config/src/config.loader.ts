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

export function yamlConfigLoader(): Record<string, unknown> {
  const configPath = resolve(process.env["APP_CONFIG_FILE"] ?? "config.yaml");

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
    }
  }

  // Step 2: back-fill flat top-level scalar keys.
  for (const [key, value] of Object.entries(parsed)) {
    if (value === null || value === undefined) continue;
    if (typeof value === "object" && !Array.isArray(value)) continue;
    if (process.env[key] !== undefined) continue;
    process.env[key] = serializeValue(value);
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
