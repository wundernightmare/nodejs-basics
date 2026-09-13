/**
 * LogLevel — the runtime-adjustable minimum level of the shared pino logger.
 *
 * The admin server drives it (PUT /admin/log-level) so an operator can turn
 * debug on for one pod without a redeploy. A change is always temporary: set()
 * takes a TTL after which the level reverts to the base level the service was
 * configured with — because a debug level left on by accident is how a disk
 * fills up at 3 a.m. A generation counter makes sure a stale timer never
 * reverts a newer change.
 *
 * pino itself stays pinned at "trace"; pino.config.ts enforces this object's
 * `value` in a `logMethod` hook (and lets a context marked by
 * withDebugLogging() through regardless). That is what lets one request be
 * debugged without touching the level at all — see @base/common.
 *
 * Mirrors libs/httpx/loglevel.go in golang-basics.
 */

export type LogLevelName = "trace" | "debug" | "info" | "warn" | "error" | "fatal" | "silent";

export const LOG_LEVEL_NAMES: readonly LogLevelName[] = [
  "trace",
  "debug",
  "info",
  "warn",
  "error",
  "fatal",
  "silent",
];

/** pino's numeric level values ("silent" disables everything). */
export const LOG_LEVEL_VALUES: Readonly<Record<LogLevelName, number>> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
  silent: Infinity,
};

/** Default cap for a runtime level change (LOG_LEVEL_MAX_TTL). */
export const DEFAULT_LOG_LEVEL_MAX_TTL_MS = 24 * 60 * 60 * 1_000;

/**
 * Strict level parsing: the admin endpoint must reject a typo, not silently
 * apply info. Accepts "warning" as an alias of "warn". Case-insensitive.
 */
export function parseLogLevelStrict(raw: unknown): LogLevelName {
  const value = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  const level = value === "warning" ? "warn" : value;
  if ((LOG_LEVEL_NAMES as readonly string[]).includes(level)) return level as LogLevelName;
  throw new Error(
    `unknown log level ${JSON.stringify(raw ?? "")} (want ${LOG_LEVEL_NAMES.join("|")})`,
  );
}

const DURATION_UNITS: Readonly<Record<string, number>> = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

/**
 * Parses a Go-style duration ("30m", "2h", "45s", "1500ms", "1h30m") into
 * milliseconds. A bare number is seconds. Throws on anything else, on a
 * result below 1ms and on a number too large for a double.
 */
export function parseDuration(raw: string): number {
  const input = raw.trim();
  if (/^\d+(\.\d+)?$/.test(input)) {
    const ms = Math.round(Number(input) * 1_000);
    if (!Number.isFinite(ms))
      throw new Error(`invalid duration ${JSON.stringify(raw)} (too large)`);
    if (ms > 0) return ms;
    throw new Error(`duration must be positive: ${JSON.stringify(raw)}`);
  }
  const re = /(\d+(?:\.\d+)?)(ms|s|m|h|d)/gy;
  let total = 0;
  let matched = 0;
  for (let m = re.exec(input); m !== null; m = re.exec(input)) {
    total += Number(m[1]) * DURATION_UNITS[m[2]!]!;
    matched = re.lastIndex;
  }
  // Rounded first: "0.0001ms" is not a positive duration, and a number too
  // long for a double is Infinity, not a duration.
  const ms = Math.round(total);
  if (matched !== input.length || matched === 0 || !Number.isFinite(ms) || !(ms > 0)) {
    throw new Error(`invalid duration ${JSON.stringify(raw)} (want e.g. 30m, 2h, 45s, 1500ms)`);
  }
  return ms;
}

/** Renders milliseconds the way parseDuration reads them ("1h30m", "45s", "500ms"). */
export function formatDuration(ms: number): string {
  if (ms <= 0) return "0s";
  const parts: string[] = [];
  let rest = ms;
  for (const [unit, size] of [
    ["h", DURATION_UNITS["h"]!],
    ["m", DURATION_UNITS["m"]!],
    ["s", DURATION_UNITS["s"]!],
  ] as const) {
    const n = Math.floor(rest / size);
    if (n > 0) {
      parts.push(`${n}${unit}`);
      rest -= n * size;
    }
  }
  if (rest > 0) parts.push(`${rest}ms`);
  return parts.join("");
}

export interface LogLevelState {
  /** Level in effect now. */
  level: LogLevelName;
  /** Configured level; what runtime changes revert to. */
  base: LogLevelName;
  /** When the runtime change reverts (ISO 8601), null when the base level is in effect. */
  expires_at: string | null;
  /** Cap applied to every TTL. */
  max_ttl: string;
}

/** Why the level changed: an explicit set()/reset(), or a TTL that ran out. */
export type LogLevelChangeReason = "set" | "reset" | "expired";

export interface LogLevelOptions {
  /** Cap (and default) for how long a runtime change lasts. Default: 24h. */
  maxTtlMs?: number;
  /** Called after every change, including TTL reverts. */
  onChange?: (level: LogLevelName, previous: LogLevelName, reason: LogLevelChangeReason) => void;
}

export class LogLevel {
  readonly base: LogLevelName;
  readonly maxTtlMs: number;
  private current: LogLevelName;
  private generation = 0;
  private expires: Date | null = null;
  private timer: NodeJS.Timeout | null = null;
  private readonly onChange: LogLevelOptions["onChange"];

  constructor(base: LogLevelName, options: LogLevelOptions = {}) {
    this.base = base;
    this.current = base;
    this.maxTtlMs = options.maxTtlMs ?? DEFAULT_LOG_LEVEL_MAX_TTL_MS;
    this.onChange = options.onChange;
  }

  /** Level in effect now. */
  get level(): LogLevelName {
    return this.current;
  }

  /** Numeric value of the level in effect (pino scale). */
  get value(): number {
    return LOG_LEVEL_VALUES[this.current];
  }

  /** When the runtime change reverts, or null while the base level (or a permanent change) is in effect. */
  get expiresAt(): Date | null {
    return this.expires;
  }

  /** Whether a record at `levelValue` (pino scale) passes the level in effect. */
  enabled(levelValue: number): boolean {
    return levelValue >= this.value;
  }

  /**
   * Switches to `level`. `ttlMs` is capped at maxTtlMs and defaults to it, so
   * a change made through the admin server always expires; ttlMs <= 0 keeps
   * the level until the next set()/reset() (for services that want that).
   * Returns the level that was in effect before.
   */
  set(level: LogLevelName, ttlMs: number = this.maxTtlMs): LogLevelName {
    return this.change(level, ttlMs, "set");
  }

  /** Reverts to the base level now, cancelling any pending TTL. Returns the previous level. */
  reset(): LogLevelName {
    return this.change(this.base, 0, "reset");
  }

  private change(level: LogLevelName, ttlMs: number, reason: LogLevelChangeReason): LogLevelName {
    const previous = this.current;
    this.generation += 1;
    const generation = this.generation;
    this.clearTimer();
    this.expires = null;
    this.current = level;
    if (ttlMs > 0) {
      const ttl = Math.min(ttlMs, this.maxTtlMs);
      this.expires = new Date(Date.now() + ttl);
      this.timer = setTimeout(() => {
        this.revert(generation);
      }, ttl);
      this.timer.unref?.();
    }
    this.onChange?.(level, previous, reason);
    return previous;
  }

  /** What GET /admin/log-level serves. */
  snapshot(): LogLevelState {
    return {
      level: this.current,
      base: this.base,
      expires_at: this.expires?.toISOString() ?? null,
      max_ttl: formatDuration(this.maxTtlMs),
    };
  }

  /** Timer callback: acts only if no newer set()/reset() happened since it was armed. */
  private revert(generation: number): void {
    if (generation !== this.generation) return;
    const previous = this.current;
    this.timer = null;
    this.expires = null;
    this.current = this.base;
    this.onChange?.(this.base, previous, "expired");
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
