/**
 * Typed reads of configuration values — the one place that turns the strings
 * in process.env into numbers, booleans and objects.
 *
 * The loader runs parseConfigValue() over every set registry key at startup,
 * so a typo fails the boot with the full list. The readers below parse the
 * same way, with the same registry bounds and defaults, for code that builds
 * its clients from a ConfigService: an unset value is the registry default
 * (typed `T` for a key that has one, `T | undefined` otherwise — the key
 * itself is checked against the registry by the compiler), a bad one throws
 * — never a silent fallback that runs production on a value nobody chose.
 *
 *   linger: readInt(config, "KAFKA_PRODUCER_LINGER_MS"), // number
 */
import { readFileSync } from "node:fs";

import {
  type DefaultedEnvKey,
  ENV_REGISTRY,
  type EnvEntry,
  type EnvKey,
  type EnvType,
} from "./env.registry.js";

/** `T` for a key with a registry default, `T | undefined` for one without. */
export type ConfigValue<K extends EnvKey, T> = K extends DefaultedEnvKey ? T : T | undefined;

/** What a reader needs: ConfigService, or `{ get: (k) => process.env[k] }`. */
export interface ConfigGetter {
  get(key: string): unknown;
}

/** process.env as a ConfigGetter — for reads made before the Nest container exists. */
export const processEnv: ConfigGetter = { get: (key) => process.env[key] };

/** A configuration value that does not parse as its registry type. */
export class ConfigValueError extends Error {
  constructor(
    readonly key: string,
    readonly raw: string,
    expected: string,
  ) {
    super(`${key}=${JSON.stringify(raw)}: expected ${expected}`);
    this.name = "ConfigValueError";
  }
}

type Rule = Pick<EnvEntry, "key" | "min" | "max" | "values"> & { type: EnvType };

const DURATION = /^(?:\d+(?:\.\d+)?|(?:\d+(?:\.\d+)?(?:ms|s|m|h|d))+)$/u;

function bounded(rule: Rule, raw: string, n: number, what: string): number {
  const { min, max } = rule;
  if ((min === undefined || n >= min) && (max === undefined || n <= max)) return n;
  const range =
    min === undefined ? ` <= ${max}` : max === undefined ? ` >= ${min}` : ` in [${min}, ${max}]`;
  throw new ConfigValueError(rule.key, raw, `${what}${range}`);
}

type Parsed = string | number | boolean | object;

/** Per type: the parsed value of the trimmed `value`, or throws. */
const PARSERS: Record<EnvType, (rule: Rule, raw: string, value: string) => Parsed> = {
  string: (_rule, raw) => raw,
  int(rule, raw, value) {
    if (!/^[+-]?\d+$/u.test(value) || !Number.isSafeInteger(Number(value)))
      throw new ConfigValueError(rule.key, raw, "an integer");
    return bounded(rule, raw, Number(value), "an integer");
  },
  number(rule, raw, value) {
    const n = value === "" ? Number.NaN : Number(value);
    if (!Number.isFinite(n)) throw new ConfigValueError(rule.key, raw, "a number");
    return bounded(rule, raw, n, "a number");
  },
  bool(rule, raw, value) {
    if (/^(?:true|1)$/iu.test(value)) return true;
    if (/^(?:false|0)$/iu.test(value)) return false;
    throw new ConfigValueError(rule.key, raw, "true or false");
  },
  duration(rule, raw, value) {
    if (DURATION.test(value)) return value;
    throw new ConfigValueError(rule.key, raw, "a duration (e.g. 30m, 2h, 45s, 1500ms)");
  },
  json(rule, raw, value) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch {
      parsed = undefined;
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
      throw new ConfigValueError(rule.key, raw, "a JSON object");
    return parsed;
  },
  enum(rule, raw, value) {
    const values = rule.values ?? [];
    if (values.some((v) => v.toLowerCase() === value.toLowerCase())) return value;
    throw new ConfigValueError(rule.key, raw, `one of ${values.join("|")}`);
  },
};

/** Parses `raw` as `rule` says, or throws ConfigValueError. */
export function parseConfigValue(rule: Rule, raw: string): Parsed {
  const value = raw.trim();
  if (rule.type !== "enum" && rule.values?.includes(value) === true) return value;
  return PARSERS[rule.type](rule, raw, value);
}

const RULES = new Map<string, EnvEntry>(ENV_REGISTRY.map((e) => [e.key, e]));

function read(config: ConfigGetter, key: EnvKey, type: EnvType): unknown {
  const entry = RULES.get(key);
  let raw = config.get(key);
  if (raw === undefined || raw === null || raw === "") raw = entry?.default;
  if (raw === undefined) return undefined;
  // ConfigService hands back what a test put in it; process.env only strings.
  if (typeof raw !== "string") return raw;
  return parseConfigValue({ ...entry, key, type }, raw);
}

/** A non-empty string. */
export function readString<K extends EnvKey>(config: ConfigGetter, key: K): ConfigValue<K, string> {
  return read(config, key, "string") as ConfigValue<K, string>;
}

/** A whole number within the key's registry bounds. */
export function readInt<K extends EnvKey>(config: ConfigGetter, key: K): ConfigValue<K, number> {
  return read(config, key, "int") as ConfigValue<K, number>;
}

/** A number within the key's registry bounds. */
export function readNumber<K extends EnvKey>(config: ConfigGetter, key: K): ConfigValue<K, number> {
  return read(config, key, "number") as ConfigValue<K, number>;
}

/** true|false|1|0. */
export function readBool<K extends EnvKey>(config: ConfigGetter, key: K): ConfigValue<K, boolean> {
  return read(config, key, "bool") as ConfigValue<K, boolean>;
}

/** A JSON object (the escape-hatch `*_EXTRA_PROPERTIES` keys). */
export function readJson<K extends EnvKey>(
  config: ConfigGetter,
  key: K,
): ConfigValue<K, Record<string, unknown>> {
  return read(config, key, "json") as ConfigValue<K, Record<string, unknown>>;
}

/**
 * The content of the file a `*_FILE` key points at (a mounted Secret), read
 * once, trailing newline trimmed; undefined when the key is unset. A file
 * that cannot be read or is empty throws — a misconfigured secret must not
 * start the service with no password. Rotation is a rollout restart.
 */
export function readSecretFile(config: ConfigGetter, key: EnvKey): string | undefined {
  const path = readString(config, key);
  if (path === undefined) return undefined;
  let content = "";
  try {
    content = readFileSync(path, "utf8").replace(/\r?\n+$/u, "");
  } catch {
    content = "";
  }
  if (content === "") throw new ConfigValueError(key, path, "a readable, non-empty file");
  return content;
}
