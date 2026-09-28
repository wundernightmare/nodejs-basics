import { ConfigService } from "@nestjs/config";
import { SpanKind, trace } from "@opentelemetry/api";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PgUnitOfWork } from "@base/database";
import type { KafkaProducerService } from "@base/kafka";
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
  let failNext = false;

  const kafka = {
    send: (record: Sent) => {
      if (failNext) {
        failNext = false;
        return Promise.reject(new Error("broker down"));
      }
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
    failNext = true;
    await expect(relay().relayOnce()).rejects.toThrow("broker down");
    expect(await mine()).toBe(1);

    await relay().relayOnce();
    const record = sent.find((r) => r.topic === topic);
    expect(record?.messages[0]).toMatchObject({ key: "k1", value: '{"n":1}' });
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
