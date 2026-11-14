/**
 * Drops repetitive trace/debug/info records the way golang-basics' httpx
 * logger (and zap's sampler) does: per (level, message) and per tick it passes
 * the first `initial` records, then every `thereafter`-th. Warn and above
 * always pass; so does anything logged under withDebugLogging().
 *
 * The point is cost control: an access log at 20k req/s or a tight loop
 * logging every item would otherwise spend more CPU on JSON encoding than on
 * the work itself. What survives is enough to see the shape of traffic;
 * metrics carry the exact counts.
 *
 * Counters live in a fixed table indexed by a hash of the message, so memory
 * is bounded. Two messages sharing a slot share a budget — an acceptable
 * imprecision for a rate limiter.
 */
const SLOTS = 4096;
const WARN = 40;
const INFO = 30;

export interface LogSamplerOptions {
  /** Per tick, per message: pass the first N. 0 disables sampling. Default: 100 */
  initial?: number;
  /** … then every M-th. Default: 100 */
  thereafter?: number;
  /** Window length in ms. Default: 1000 */
  tickMs?: number;
  now?: () => number;
}

export class LogSampler {
  readonly #initial: number;
  readonly #thereafter: number;
  readonly #tickMs: number;
  readonly #now: () => number;
  readonly #resetAt = new Float64Array(SLOTS);
  readonly #count = new Uint32Array(SLOTS);
  #droppedDebug = 0;
  #droppedInfo = 0;

  constructor(options: LogSamplerOptions = {}) {
    this.#initial = options.initial ?? 100;
    this.#thereafter = Math.max(options.thereafter ?? 100, 1);
    this.#tickMs = options.tickMs ?? 1_000;
    this.#now = options.now ?? Date.now;
  }

  /** May a record of this pino level (10 trace … 60 fatal) and message be written? */
  allow(levelValue: number, message: string): boolean {
    if (this.#initial <= 0 || levelValue >= WARN) return true;

    const slot = slotOf(levelValue, message);
    const now = this.#now();
    if (now >= this.#resetAt[slot]!) {
      this.#resetAt[slot] = now + this.#tickMs;
      this.#count[slot] = 0;
    }
    // (Not `++this.#count[slot]!`: Stryker's instrumenter cannot parse an
    // update of a non-null assertion.)
    const n = (this.#count[slot] ?? 0) + 1;
    this.#count[slot] = n;
    // Stryker disable next-line EqualityOperator: at n === initial the second half is true as well
    if (n <= this.#initial || (n - this.#initial) % this.#thereafter === 0) return true;

    if (levelValue >= INFO) this.#droppedInfo++;
    else this.#droppedDebug++;
    return false;
  }

  /** Records dropped so far — log_dropped_total{level}. Trace counts as debug. */
  dropped(): { debug: number; info: number } {
    return { debug: this.#droppedDebug, info: this.#droppedInfo };
  }
}

/** FNV-1a over the message, mixed with the level. */
function slotOf(levelValue: number, message: string): number {
  let hash = 0x811c9dc5;
  // Stryker disable next-line EqualityOperator: one more step changes every hash alike
  for (let i = 0; i < message.length; i++) {
    hash ^= message.codePointAt(i) ?? 0;
    hash = Math.imul(hash, 0x01000193);
  }
  return ((hash ^ levelValue) >>> 0) % SLOTS;
}

/** The message of a pino log call: `log.info(msg)` or `log.info(obj, msg)`. */
export function messageOf(args: readonly unknown[]): string {
  if (typeof args[0] === "string") return args[0];
  return typeof args[1] === "string" ? args[1] : "";
}

/** A non-negative integer from the environment; anything else is the default. */
export function sampleSetting(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : fallback;
}
