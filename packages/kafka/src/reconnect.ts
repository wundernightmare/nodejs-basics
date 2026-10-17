import type { KafkaJS } from "@confluentinc/kafka-javascript";

import { kafkaLogger } from "./kafka-log-creator.js";

const BASE_MS = 1_000;
const MAX_MS = 30_000;

/**
 * The `kafkaJS` block of every client this package creates: our logger, and
 * a connect() that makes ONE attempt. Since kafka-javascript 1.11 the compat
 * connect() retries transient failures by itself (`retry.retries`, default
 * 5, backoff 300 ms → 30 s): against a dead broker it rejects after ~80 s
 * instead of one attempt, so Reconnect's first warning and its own backoff
 * would start that late, and the hidden retry loop would outlive shutdown.
 * Reconnect owns the retrying; `retries: 0` keeps it that way.
 *
 * The same `retry.retries` also feeds the producer's librdkafka `retries`
 * (message re-sends) — buildProducerConfig sets that back. `kafkaJS.brokers`
 * is typed as required, but the flat librdkafka config already carries
 * `metadata.broker.list`; the cast covers that.
 */
export function kafkaJsConfig(): KafkaJS.KafkaConfig {
  return { logger: kafkaLogger, retry: { retries: 0 } } as KafkaJS.KafkaConfig;
}

/**
 * Runs `attempt` until it resolves, waiting 1 s → 30 s (doubling) between
 * failures; `start()` again to reconnect after a later loss. The producer
 * and the consumer runner share it. Clients get {@link kafkaJsConfig}, so
 * one attempt is one connect: bounded by the connection-setup timeout
 * (`socket.connection.setup.timeout.ms`, 11 s, + 1 s) while it waits for
 * the first metadata.
 *
 * `attempt` must make a fresh client each time — a kafkajs-compat client
 * whose connect() failed can never connect again — and must not be raced
 * against a timer: disconnect() under a connect in flight waits for that
 * attempt to finish anyway (and before 1.11 crashed the process), so
 * shutdown leaves a connecting client alone.
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
