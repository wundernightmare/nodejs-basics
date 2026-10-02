const BASE_MS = 1_000;
const MAX_MS = 30_000;

/**
 * Runs `attempt` until it resolves, waiting 1 s → 30 s (doubling) between
 * failures; `start()` again to reconnect after a later loss. The producer
 * and the consumer runner share it.
 *
 * `attempt` must make a fresh client each time — a kafkajs-compat client
 * whose connect() failed can never connect again — and must not be raced
 * against a timer: a connect in flight waits up to 30 s for metadata, and a
 * disconnect() under it makes the late "ready" throw from an event handler,
 * which takes the process down.
 */
export class Reconnect {
  #delay = BASE_MS;
  #timer: NodeJS.Timeout | undefined;
  #stopped = false;

  constructor(
    private readonly attempt: () => Promise<void>,
    private readonly onRetry: (err: unknown, delayMs: number) => void,
  ) {}

  get stopped(): boolean {
    return this.#stopped;
  }

  start(): void {
    void this.#run();
  }

  stop(): void {
    this.#stopped = true;
    clearTimeout(this.#timer);
  }

  async #run(): Promise<void> {
    if (this.#stopped) return;
    try {
      await this.attempt();
      this.#delay = BASE_MS;
    } catch (err) {
      if (this.#stopped) return;
      const delay = this.#delay;
      this.#delay = Math.min(delay * 2, MAX_MS);
      this.onRetry(err, delay);
      this.#timer = setTimeout(() => void this.#run(), delay);
    }
  }
}
