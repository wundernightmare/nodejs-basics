/**
 * Typed reads of configuration values — the one place that turns the strings
 * in process.env into numbers, booleans and objects.
 *
 * The loader runs parseConfigValue() over every set registry key at startup,
 * so a typo fails the boot with the full list. The readers below parse the
 * same way, with the same registry bounds, for code that builds its clients
 * from a ConfigService: an unset value is `undefined` (the caller supplies
 * its default), a bad one throws — never a silent fallback that runs
 * production on a value nobody chose.
 *
 *   linger: readInt(config, "KAFKA_PRODUCER_LINGER_MS") ?? 10,
 */
import { ENV_REGISTRY, type EnvEntry, type EnvType } from "./env.registry.js";

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

const RULES = new Map(ENV_REGISTRY.map((e) => [e.key, e]));

function read(config: ConfigGetter, key: string, type: EnvType): unknown {
  const raw = config.get(key);
  if (raw === undefined || raw === null || raw === "") return undefined;
  // ConfigService hands back what a test put in it; process.env only strings.
  if (typeof raw !== "string") return raw;
  return parseConfigValue({ ...RULES.get(key), key, type }, raw);
}

/** A non-empty string, or undefined. */
export function readString(config: ConfigGetter, key: string): string | undefined {
  return read(config, key, "string") as string | undefined;
}

/** A whole number within the key's registry bounds. */
export function readInt(config: ConfigGetter, key: string): number | undefined {
  return read(config, key, "int") as number | undefined;
}

/** A number within the key's registry bounds. */
export function readNumber(config: ConfigGetter, key: string): number | undefined {
  return read(config, key, "number") as number | undefined;
}

/** true|false|1|0. */
export function readBool(config: ConfigGetter, key: string): boolean | undefined {
  return read(config, key, "bool") as boolean | undefined;
}

/** A JSON object (the escape-hatch `*_EXTRA_PROPERTIES` keys). */
export function readJson(config: ConfigGetter, key: string): Record<string, unknown> | undefined {
  return read(config, key, "json") as Record<string, unknown> | undefined;
}
