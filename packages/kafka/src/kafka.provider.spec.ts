import { type KafkaJS } from "@confluentinc/kafka-javascript";
import { ConfigService } from "@nestjs/config";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AppLogger, pinoLogger } from "@base/logger";
import { meta, testCase } from "@base/testing";

import { KafkaSendError } from "./kafka-errors.js";
import { KafkaProducerService } from "./kafka.provider.js";

const appLogger = new AppLogger(pinoLogger.child({}, { level: "silent" }));

interface FakeProducer {
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
}

/** The service with a queue of scripted producers instead of real clients. */
class TestService extends KafkaProducerService {
  readonly made: FakeProducer[] = [];
  constructor(private readonly script: (() => FakeProducer)[]) {
    super(new ConfigService({}), appLogger);
  }
  protected override createProducer(): KafkaJS.Producer {
    const next = (this.script.shift() ?? fake)();
    this.made.push(next);
    return next as unknown as KafkaJS.Producer;
  }
}

function fake(connect: () => Promise<void> = () => Promise.resolve()): FakeProducer {
  return {
    connect: vi.fn(connect),
    disconnect: vi.fn(() => Promise.resolve()),
    send: vi.fn(() => Promise.resolve([])),
  };
}
const refused = (): FakeProducer => fake(() => Promise.reject(new Error("broker down")));
const record = { topic: "t", messages: [{ value: "v" }] };

describe("KafkaProducerService", () => {
  meta({ epic: "nodejs-basics", feature: "kafka", owner: "@team-platform", tags: ["kafka"] });
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps reconnecting with a fresh producer until the broker is back; send fails fast meanwhile", async () => {
    await testCase("NB-924", "producer reconnects after a broker outage at boot");
    const svc = new TestService([refused, refused, () => fake()]);
    svc.onApplicationBootstrap();
    await vi.advanceTimersByTimeAsync(0);
    await expect(svc.send(record, { waitMs: 0 })).rejects.toMatchObject({
      kind: "not_connected",
      retryable: true,
    });

    await vi.advanceTimersByTimeAsync(1_000); // 2nd attempt after 1 s
    expect(svc.made).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(2_000); // 3rd after 2 s more
    expect(svc.made).toHaveLength(3);
    await svc.send(record, { waitMs: 0 });
    expect(svc.made[2]?.send).toHaveBeenCalledOnce();
  });

  it("replaces a producer that hit a fatal error", async () => {
    await testCase("NB-925", "fatal producer errors recreate the client");
    const broken = fake();
    broken.send.mockRejectedValueOnce(Object.assign(new Error("fenced"), { fatal: true }));
    const svc = new TestService([() => broken, () => fake()]);
    svc.onApplicationBootstrap();
    await vi.advanceTimersByTimeAsync(0);

    await expect(svc.send(record, { waitMs: 0 })).rejects.toMatchObject({ kind: "fatal" });
    await vi.advanceTimersByTimeAsync(0);
    expect(broken.disconnect).toHaveBeenCalled();
    expect(svc.made).toHaveLength(2);
    await expect(svc.send(record, { waitMs: 0 })).resolves.toEqual([]);
  });

  it("a non-fatal send error keeps the producer", async () => {
    await testCase("NB-926", "retriable send errors do not recreate the client");
    const p = fake();
    p.send.mockRejectedValueOnce(new Error("timed out"));
    const svc = new TestService([() => p]);
    svc.onApplicationBootstrap();
    await vi.advanceTimersByTimeAsync(0);
    await expect(svc.send(record)).rejects.toMatchObject({ kind: "unknown", retryable: true });
    expect(svc.made).toHaveLength(1);
  });

  it("shutdown does not wait for a connect in flight, and stops retrying", async () => {
    await testCase("NB-927", "producer shutdown never hangs on a pending connect");
    const hanging = fake(() => new Promise(() => {}));
    const svc = new TestService([() => hanging]);
    svc.onApplicationBootstrap();
    await vi.advanceTimersByTimeAsync(0);
    await svc.onApplicationShutdown("SIGTERM"); // resolves although connect never does
    expect(hanging.disconnect).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(svc.made).toHaveLength(1);
  });

  it("shutdown disconnects a connected producer", async () => {
    await testCase("NB-928", "producer disconnects on shutdown");
    const p = fake();
    const svc = new TestService([() => p]);
    svc.onApplicationBootstrap();
    await vi.advanceTimersByTimeAsync(0);
    await svc.onApplicationShutdown();
    expect(p.disconnect).toHaveBeenCalledOnce();
    await expect(svc.send(record, { waitMs: 0 })).rejects.toBeInstanceOf(KafkaSendError);
  });

  it("waits out a connect within waitMs instead of failing", async () => {
    await testCase("NB-933", "send waits for the producer to connect");
    const svc = new TestService([refused, () => fake()]);
    svc.onApplicationBootstrap();
    await vi.advanceTimersByTimeAsync(0);
    const sent = svc.send(record); // default waitMs 5 s; reconnect lands after 1 s
    await vi.advanceTimersByTimeAsync(2_000); // backoff steps 50+100+200+400+800 ms
    await expect(sent).resolves.toEqual([]);
  });

  it("waits out queue_full for a single message, fails a batch at once", async () => {
    await testCase("NB-934", "queue_full back-pressure policy");
    const p = fake();
    const full = Object.assign(new Error("Local: Queue full"), { code: -184 });
    p.send.mockRejectedValueOnce(full).mockRejectedValueOnce(full);
    const svc = new TestService([() => p]);
    svc.onApplicationBootstrap();
    await vi.advanceTimersByTimeAsync(0);

    const single = svc.send(record);
    await vi.advanceTimersByTimeAsync(500);
    await expect(single).resolves.toEqual([]);
    expect(p.send).toHaveBeenCalledTimes(3);

    p.send.mockRejectedValueOnce(full);
    const batch = { topic: "t", messages: [{ value: "a" }, { value: "b" }] };
    await expect(svc.send(batch)).rejects.toMatchObject({ kind: "queue_full", retryable: true });
  });

  it("gives up on queue_full after waitMs", async () => {
    await testCase("NB-935", "send waits no longer than waitMs");
    const p = fake();
    p.send.mockRejectedValue(Object.assign(new Error("Local: Queue full"), { code: -184 }));
    const svc = new TestService([() => p]);
    svc.onApplicationBootstrap();
    await vi.advanceTimersByTimeAsync(0);
    const sent = svc.send(record, { waitMs: 300 });
    const outcome = expect(sent).rejects.toMatchObject({ kind: "queue_full" });
    await vi.advanceTimersByTimeAsync(400);
    await outcome;
  });
});
