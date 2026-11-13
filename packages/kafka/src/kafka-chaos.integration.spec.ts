import { ConfigService } from "@nestjs/config";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { AppLogger } from "@base/logger";
import { captureLogs, integration, meta, pausable, pause, testCase, unique } from "@base/testing";

import { KafkaSendError } from "./kafka-errors.js";
import { KafkaProducerService } from "./kafka.provider.js";

/**
 * A broker that stops answering — frozen, not gone: connections stay open and
 * nothing comes back (a wedged broker, a GC pause, a full disk). Kafka cannot
 * sit behind Toxiproxy (clients dial the advertised address), so the
 * container is frozen instead. The counterpart of containers.Pause in
 * golang-basics.
 *
 * Only a broker this run started can be frozen: against `just deps` or a CI
 * service the suite is skipped.
 */
const infra = integration("kafka");

const MESSAGE_TIMEOUT_MS = 3_000;

describe.skipIf(infra.skip || !pausable("kafka"))("kafka producer, frozen broker (chaos)", () => {
  meta({
    epic: "nodejs-basics",
    feature: "kafka",
    owner: "@team-platform",
    tags: ["kafka", "chaos", "integration"],
  });

  const topic = unique("chaos");
  let producer: KafkaProducerService;
  let resume: (() => Promise<void>) | undefined;

  const send = (signal?: AbortSignal): Promise<unknown> =>
    producer.send({ topic, messages: [{ value: "v" }] }, signal === undefined ? {} : { signal });

  /** Resolves once a send goes through; throws when none does within `ms`. */
  async function delivering(ms: number): Promise<void> {
    const until = Date.now() + ms;
    for (;;) {
      try {
        await send();
        return;
      } catch (err) {
        if (Date.now() > until) throw new Error("no send went through", { cause: err });
        await new Promise((resolve) => {
          setTimeout(resolve, 250);
        });
      }
    }
  }

  beforeAll(async () => {
    const config = new ConfigService({
      KAFKA_BROKERS: infra.url("kafka"),
      KAFKA_PRODUCER_MESSAGE_TIMEOUT_MS: String(MESSAGE_TIMEOUT_MS),
      KAFKA_REQUEST_TIMEOUT_MS: "1000",
    });
    producer = new KafkaProducerService(config, new AppLogger(captureLogs().logger));
    producer.onApplicationBootstrap();
    await delivering(30_000);
  }, 60_000);

  afterEach(async () => {
    await resume?.();
    resume = undefined;
  });

  afterAll(async () => {
    await producer.onApplicationShutdown("SIGTERM");
  }, 30_000);

  it("a send to a frozen broker fails as retryable within the message timeout", async () => {
    await testCase(
      "NB-1227",
      "Kafka frozen: a send is bounded by the message timeout and retryable",
    );
    resume = await pause("kafka");
    const started = Date.now();
    const failure = await send().catch((err: unknown) => err);
    expect(Date.now() - started).toBeLessThan(MESSAGE_TIMEOUT_MS + 5_000);
    expect(failure).toBeInstanceOf(KafkaSendError);
    expect((failure as KafkaSendError).retryable).toBe(true);
  }, 30_000);

  it("the caller's signal ends the wait at once", async () => {
    await testCase("NB-1228", "Kafka frozen: the caller's signal ends a send");
    resume = await pause("kafka");
    const started = Date.now();
    await expect(send(AbortSignal.timeout(300))).rejects.toBeDefined();
    expect(Date.now() - started).toBeLessThan(1_500);
  }, 30_000);

  it("the same producer delivers again once the broker is back", async () => {
    await testCase("NB-1229", "Kafka frozen: the producer recovers without a restart");
    resume = await pause("kafka");
    await send(AbortSignal.timeout(500)).catch(() => {});
    await resume();
    await delivering(30_000);
  }, 60_000);
});
