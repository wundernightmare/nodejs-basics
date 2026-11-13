/** How many slots the sliding window is cut into: it slides in steps of 1/SLOTS of its length. */
const SLOTS = 10;

export interface RetryBudgetConfig {
  /** Retries allowed per request seen in the window. Default: 0.2 */
  ratio?: number;
  /** Retries always allowed per window, so a quiet client can still retry. Default: 10 */
  minRetries?: number;
  /** Window length in ms; 0 disables the budget. Default: 10_000 */
  windowMs?: number;
}

/**
 * Bounds retries to `minRetries + ratio × requests` over a sliding window, so
 * an outage of the dependency cannot multiply the traffic sent to it by the
 * attempt count. The same rule (and defaults) as golang-basics'
 * resilience.RetryBudget.
 */
export class RetryBudget {
  readonly #ratio: number;
  readonly #minRetries: number;
  readonly #slotMs: number;
  readonly #now: () => number;
  readonly #slots: Array<{ idx: number; requests: number; retries: number }> = Array.from(
    { length: SLOTS },
    () => ({ idx: -1, requests: 0, retries: 0 }),
  );

  constructor(config: RetryBudgetConfig = {}, now: () => number = Date.now) {
    this.#ratio = config.ratio ?? 0.2;
    this.#minRetries = config.minRetries ?? 10;
    this.#slotMs = Math.max((config.windowMs ?? 10_000) / SLOTS, 1);
    this.#now = now;
  }

  /** Counts one logical request (not its retries). */
  request(): void {
    this.#slot().requests++;
  }

  /** Spends one retry if the window has one left. */
  tryRetry(): boolean {
    const current = this.#slot();
    let requests = 0;
    let retries = 0;
    for (const slot of this.#slots) {
      if (current.idx - slot.idx < SLOTS) {
        requests += slot.requests;
        retries += slot.retries;
      }
    }
    if (retries >= this.#minRetries + this.#ratio * requests) return false;
    current.retries++;
    return true;
  }

  #slot(): { idx: number; requests: number; retries: number } {
    const idx = Math.floor(this.#now() / this.#slotMs);
    const slot = this.#slots[idx % SLOTS]!;
    if (slot.idx !== idx) {
      slot.idx = idx;
      slot.requests = 0;
      slot.retries = 0;
    }
    return slot;
  }
}
