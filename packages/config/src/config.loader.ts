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
 * Then it validates, and throws ONE startup error listing every problem: a
 * YAML key no registry entry has (a typo would otherwise be silently
 * ignored), a value that does not parse as the entry's `type` (an int, a
 * bool, an enum, …, within its bounds), a missing `required` key.
 *
 * There are no profiles / layered files and no hot reload, on purpose: one
 * file per deployment (a ConfigMap) plus env overrides is all a container
 * needs, and a value that changes under a running process is a restart,
 * mounted secrets included.
 *
 * Usage: the apps call yamlConfigLoader() from their first import
 * (src/boot.ts), before any other module loads, and wire it into
 *   ConfigModule.forRoot({ load: [yamlConfigLoader] })
 *
 * The loader also remembers where each registered key came from, so
 * configSnapshot() can show an operator the effective configuration with its
 * provenance (GET /admin/config on the admin server, secrets redacted there).
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { parse as parseYaml } from "yaml";

import { ConfigValueError, parseConfigValue } from "./config.values.js";
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

/**
 * An empty value is no value. `KEY=` is what an unset knob renders to (a
 * compose `${KEY:-}`, a helm `| quote` of ""), and left in place it would
 * shadow config.yaml and the registry default, and reach code that falls
 * back with `??` — `parseInt("")` is NaN, `setInterval(NaN)` is a busy loop.
 */
function dropEmptyValues(): void {
  for (const entry of ENV_REGISTRY) {
    if (process.env[entry.key] === "") delete process.env[entry.key];
  }
}

function recordEnvSources(): void {
  for (const entry of ENV_REGISTRY) {
    if (process.env[entry.key] !== undefined) sources.set(entry.key, "env");
  }
}

let loaded: Record<string, unknown> | undefined;

/**
 * Loads the configuration into process.env once per process and returns the
 * parsed file; later calls return that result. The apps call it from their
 * first import (src/boot.ts), so every module — including ones that read
 * process.env when they load — sees the merged values; ConfigModule's
 * `load: [yamlConfigLoader]` then reuses the result.
 *
 * Throws one error listing every problem: an unknown YAML key (with the
 * nearest known one), a value that does not parse as its registry type, a
 * missing required key.
 */
export function yamlConfigLoader(options: LoadOptions = {}): Record<string, unknown> {
  loaded ??= load(options.defaults ?? {});
  return loaded;
}

export interface LoadOptions {
  /**
   * This app's defaults, over the registry's — e.g. its own
   * OTEL_SERVICE_NAME, so the api and the worker never share one name.
   */
  defaults?: Readonly<Record<string, string>>;
}

/**
 * yamlConfigLoader() for a process entry point: a bad configuration ends the
 * process with one ECS line on stderr (no logger yet — it is configured by
 * what failed) and exit code 78 (EX_CONFIG, sysexits.h).
 */
export function loadConfigOrExit(options: LoadOptions = {}): void {
  try {
    yamlConfigLoader(options);
  } catch (err) {
    process.stderr.write(
      `${JSON.stringify({
        "@timestamp": new Date().toISOString(),
        "log.level": "fatal",
        "service.name": process.env["OTEL_SERVICE_NAME"] ?? options.defaults?.["OTEL_SERVICE_NAME"],
        message: (err as Error).message,
      })}\n`,
    );
    process.exit(78);
  }
}

function load(appDefaults: Readonly<Record<string, string>>): Record<string, unknown> {
  dropEmptyValues();
  const configPath = resolve(process.env["APP_CONFIG_FILE"] ?? "config.yaml");
  recordEnvSources();

  // No file is not an error — in a container every value may come from the environment.
  const parsed = existsSync(configPath)
    ? (parseYaml(readFileSync(configPath, "utf-8")) as unknown)
    : undefined;
  const file =
    parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  const problems = unknownKeys(file);

  // Structured (nested) YAML paths from the registry.
  for (const entry of ENV_REGISTRY) {
    if (entry.yaml === undefined) continue;
    if (process.env[entry.key] !== undefined) continue;
    const value = getNestedValue(file, entry.yaml);
    if (value === null || value === undefined) continue;
    const serialized = serializeValue(value);
    if (serialized === "") continue;
    process.env[entry.key] = serialized;
    sources.set(entry.key, "yaml");
  }

  // Flat top-level keys (DATABASE_URL: ...).
  for (const [key, value] of Object.entries(file)) {
    if (value === null || value === undefined || !REGISTERED.has(key)) continue;
    if (process.env[key] !== undefined || serializeValue(value) === "") continue;
    process.env[key] = serializeValue(value);
    sources.set(key, "yaml");
  }

  applyDefaults(appDefaults);
  problems.push(...invalidValues(), ...missingRequiredKeys());
  if (problems.length > 0) {
    throw new Error(
      `Invalid configuration (${configPath}):\n` +
        problems.map((p) => `  - ${p}`).join("\n") +
        `\n\nEvery key, its YAML path, type and default: ENV_REGISTRY in @base/config.`,
    );
  }
  return file;
}

/**
 * Apply registry defaults for keys that are still unset after YAML + env merge.
 */
function applyDefaults(appDefaults: Readonly<Record<string, string>>): void {
  for (const entry of ENV_REGISTRY) {
    const value = appDefaults[entry.key] ?? entry.default;
    if (process.env[entry.key] === undefined && value !== undefined) {
      process.env[entry.key] = value;
      sources.set(entry.key, "default");
    }
  }
}

function missingRequiredKeys(): string[] {
  return ENV_REGISTRY.filter((e) => e.required && process.env[e.key] === undefined).map(
    (e) => `${e.key} is required (set it in the environment or in the YAML file)`,
  );
}

function invalidValues(): string[] {
  const problems: string[] = [];
  for (const entry of ENV_REGISTRY) {
    const raw = process.env[entry.key];
    if (raw === undefined || raw === "" || entry.type === undefined) continue;
    try {
      parseConfigValue({ ...entry, type: entry.type }, raw);
    } catch (err) {
      if (!(err instanceof ConfigValueError)) throw err;
      const from =
        sources.get(entry.key) === "yaml" && entry.yaml !== undefined
          ? ` (yaml: ${entry.yaml})`
          : "";
      problems.push(`${err.message}${from}`);
    }
  }
  return problems;
}

const REGISTERED = new Set(ENV_REGISTRY.map((e) => e.key));
const YAML_PATHS = new Set(ENV_REGISTRY.flatMap((e) => (e.yaml === undefined ? [] : [e.yaml])));

/**
 * YAML keys nothing reads. Without this check a typo (`databse.url`) leaves
 * the setting at its default and the service starts as if the line were not
 * there. Reported per leaf, so the hint can name the intended path. A
 * registered path is a leaf even when its value is a mapping (the
 * `*_EXTRA_PROPERTIES` objects); a top-level key may also be a registry key.
 */
function unknownKeys(file: Record<string, unknown>): string[] {
  const unknown: string[] = [];
  const walk = (node: Record<string, unknown>, prefix: string): void => {
    for (const [key, value] of Object.entries(node)) {
      const path = prefix === "" ? key : `${prefix}.${key}`;
      if (YAML_PATHS.has(path) || (prefix === "" && REGISTERED.has(key))) continue;
      if (value !== null && typeof value === "object" && !Array.isArray(value)) {
        walk(value as Record<string, unknown>, path);
        continue;
      }
      const hint = nearest(path, prefix === "" ? [...YAML_PATHS, ...REGISTERED] : [...YAML_PATHS]);
      unknown.push(`unknown key ${path}${hint === undefined ? "" : ` — did you mean ${hint}?`}`);
    }
  };
  walk(file, "");
  return unknown;
}

/** The candidate closest to `word` by edit distance, if it is close enough to be the intended one. */
function nearest(word: string, candidates: string[]): string | undefined {
  let best: string | undefined;
  let bestDistance = Math.max(2, Math.floor(word.length / 4)) + 1;
  for (const candidate of candidates) {
    const d = editDistance(word.toLowerCase(), candidate.toLowerCase());
    if (d < bestDistance) [best, bestDistance] = [candidate, d];
  }
  return best;
}

function editDistance(a: string, b: string): number {
  let row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) {
      next[j] = Math.min(
        row[j]! + 1,
        next[j - 1]! + 1,
        row[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    row = next;
  }
  return row[b.length]!;
}
