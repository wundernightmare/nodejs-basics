import { ConfigService } from "@nestjs/config";
import { SpanKind, trace } from "@opentelemetry/api";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PgUnitOfWork } from "@base/database";
import { type KafkaProducerService, toKafkaSendError } from "@base/kafka";
import { AppLogger, pinoLogger } from "@base/logger";
import { captureSpans, integration, meta, testCase, unique } from "@base/testing";

import { OutboxRelay } from "./outbox.relay.js";
import { OutboxWriter } from "./outbox.writer.js";

/**
 * The outbox against a real Postgres (the table from migrations/, applied by
 * the integration globalSetup) with a recording stand-in for the producer.
 * Rows are told apart by a unique topic, so rows other suites leave behind
 * do not matter.
 */
const infra = integration("postgres");

type Sent = Parameters<KafkaProducerService["send"]>[0];

/** What the real client throws, run through the registry like send() does. */
const libError = (code: number, message: string): Error =>
  toKafkaSendError(Object.assign(new Error(message), { code }));

describe.skipIf(infra.skip)("outbox (integration)", () => {
  meta({
    epic: "nodejs-basics",
    feature: "outbox",
    owner: "@team-platform",
    tags: ["outbox", "kafka", "integration"],
  });

  const spans = captureSpans();
  const topic = unique("topic");
  const logger = new AppLogger(pinoLogger.child({}, { level: "silent" }));
  let pool: pg.Pool;
  let writer: OutboxWriter;
  let uow: PgUnitOfWork;
  const sent: Sent[] = [];
  let brokerDown = false;
  let poisonSends = 0;
  let queueFullKeys = new Set<string>();

  const kafka = {
    send: (record: Sent) => {
      const key = String(record.messages[0]?.key);
      if (key === "poison") {
        poisonSends++;
        return Promise.reject(libError(10, "Broker: Message size too large"));
      }
      if (queueFullKeys.has(key)) return Promise.reject(libError(-184, "Local: Queue full"));
      if (brokerDown) return Promise.reject(libError(-187, "broker down"));
      sent.push(record);
      return trace
        .getTracer("test")
        .startActiveSpan(`send ${record.topic}`, { kind: SpanKind.PRODUCER }, (span) => {
          span.end();
          return Promise.resolve([]);
        });
    },
  } as unknown as KafkaProducerService;

  const mine = async (): Promise<number> => {
    const { rows } = await pool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM outbox WHERE topic = $1",
      [topic],
    );
    return rows[0]?.n ?? 0;
  };
  const relay = (): OutboxRelay =>
    new OutboxRelay(pool, kafka, new ConfigService({ OUTBOX_BATCH_SIZE: "1000" }), logger);

  beforeAll(() => {
    pool = new pg.Pool({ connectionString: infra.url("postgres"), max: 3 });
    writer = new OutboxWriter(pool);
    uow = new PgUnitOfWork(pool);
  });
  afterAll(async () => {
    await pool.query("DELETE FROM outbox WHERE topic = $1", [topic]);
    await pool.end();
    spans.stop();
  });

  it("commits and rolls back with the caller's transaction", async () => {
    await testCase("NB-501", "an event exists exactly when its state change does");
    await uow.runInTransaction(() => writer.add({ topic, key: "k1", value: { n: 1 } }));
    await expect(
      uow.runInTransaction(async () => {
        await writer.add({ topic, key: "k2", value: { n: 2 } });
        throw new Error("rolled back");
      }),
    ).rejects.toThrow("rolled back");
    expect(await mine()).toBe(1);
  });

  it("publishes the rows with their headers, then deletes them; a failed send keeps them", async () => {
    await testCase("NB-502", "at least once: sent → deleted, broker down → still queued");
    brokerDown = true;
    await expect(relay().relayOnce()).rejects.toThrow("broker down");
    brokerDown = false;
    expect(await mine()).toBe(1);
    const { rows } = await pool.query<{ attempts: number }>(
      "SELECT attempts FROM outbox WHERE topic = $1",
      [topic],
    );
    expect(rows[0]?.attempts).toBe(0); // an outage is not the row's fault

    await relay().relayOnce();
    const record = sent.find((r) => r.topic === topic);
    expect(record?.messages[0]).toMatchObject({ key: "k1", value: '{"n":1}' });
    expect(await mine()).toBe(0);
  });

  it("a row that fails while others go out is retried OUTBOX_MAX_ATTEMPTS times, then left aside", async () => {
    await testCase("NB-908", "a poison row does not block the outbox");
    const poisonRelay = new OutboxRelay(
      pool,
      kafka,
      new ConfigService({ OUTBOX_BATCH_SIZE: "1000", OUTBOX_MAX_ATTEMPTS: "2" }),
      logger,
    );
    const attempts = async (): Promise<{ attempts: number; last_error: string | null }[]> =>
      (
        await pool.query<{ attempts: number; last_error: string | null }>(
          "SELECT attempts, last_error FROM outbox WHERE topic = $1 AND key = 'poison'",
          [topic],
        )
      ).rows;

    await uow.runInTransaction(async () => {
      await writer.add({ topic, key: "poison", value: {} });
      await writer.add({ topic, key: "good-1", value: {} });
    });
    await poisonRelay.relayOnce();
    expect(await attempts()).toEqual([
      {
        attempts: 1,
        last_error: "Kafka send failed (rejected): Broker: Message size too large",
      },
    ]);
    expect(await mine()).toBe(1);

    await writer.add({ topic, key: "good-2", value: {} });
    await poisonRelay.relayOnce();
    expect((await attempts())[0]?.attempts).toBe(2);

    // Dead: no longer selected, the rest of the outbox flows.
    poisonSends = 0;
    await writer.add({ topic, key: "good-3", value: {} });
    await poisonRelay.relayOnce();
    expect(poisonSends).toBe(0);
    expect(sent.filter((r) => r.topic === topic).map((r) => r.messages[0]?.key)).toEqual(
      expect.arrayContaining(["good-1", "good-2", "good-3"]),
    );
    expect(await mine()).toBe(1);
    await pool.query("DELETE FROM outbox WHERE topic = $1 AND key = 'poison'", [topic]);
  });

  it("a retryable failure of part of a batch (queue full) is kept, never counted", async () => {
    await testCase("NB-939", "back-pressure never dead-letters an event");
    const r = new OutboxRelay(
      pool,
      kafka,
      new ConfigService({ OUTBOX_BATCH_SIZE: "1000", OUTBOX_MAX_ATTEMPTS: "1" }),
      logger,
    );
    await uow.runInTransaction(async () => {
      await writer.add({ topic, key: "qf-ok", value: {} });
      await writer.add({ topic, key: "qf-full", value: {} });
    });
    queueFullKeys = new Set(["qf-full"]);
    // Pass 1: one row out, one kept. Later passes: only the kept row, failing
    // retryably — an outage-shaped pass, which leaves it untouched.
    await expect(r.relayOnce()).resolves.toBe(1);
    await expect(r.relayOnce()).rejects.toMatchObject({ kind: "queue_full" });
    await expect(r.relayOnce()).rejects.toMatchObject({ kind: "queue_full" });
    const { rows } = await pool.query<{ key: string; attempts: number }>(
      "SELECT key, attempts FROM outbox WHERE topic = $1",
      [topic],
    );
    expect(rows).toEqual([{ key: "qf-full", attempts: 0 }]);
    queueFullKeys = new Set();
    await r.relayOnce();
    expect(await mine()).toBe(0);
  });

  it("sends each record in the trace of the request that wrote it", async () => {
    await testCase("NB-503", "the relay's send span is a child of the writing request's span");
    spans.reset();
    await trace.getTracer("test").startActiveSpan("POST /tasks", async (span) => {
      await uow.runInTransaction(() => writer.add({ topic, key: "k3", value: {} }));
      span.end();
    });
    await relay().relayOnce();

    const request = spans.span("POST /tasks");
    const send = spans.span(`send ${topic}`);
    expect(send.spanContext().traceId).toBe(request.spanContext().traceId);
    expect(send.parentSpanContext?.spanId).toBe(request.spanContext().spanId);
  });
});
