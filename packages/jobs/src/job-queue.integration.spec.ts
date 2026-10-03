import { ConfigService } from "@nestjs/config";
import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";

import { integration, meta, testCase, unique } from "@base/testing";

import { BullMQJobQueue } from "./bullmq-job-queue.js";
import { createBullMQConnection } from "./bullmq-connection.factory.js";
import { BullMQMetricsService } from "./bullmq-metrics.service.js";
import type { JobQueue } from "./job-queue.js";
import { createPgBoss, PgBossJobQueue } from "./pgboss-job-queue.js";

/** The same contract, both backends: what JobQueue promises its users. */
const postgres = integration("postgres");
const valkey = integration("valkey");

interface Backend {
  name: string;
  skip: boolean;
  open(queue: string): Promise<{ queue: JobQueue<{ n: number }>; close(): Promise<void> }>;
}

const backends: Backend[] = [
  {
    name: "pg-boss",
    skip: postgres.skip,
    open: async (name) => {
      const pool = new pg.Pool({ connectionString: postgres.url("postgres") });
      const boss = createPgBoss(pool);
      await boss.start();
      const queue = new PgBossJobQueue<{ n: number }>(name, boss);
      return {
        queue,
        close: async () => {
          await queue.close();
          await boss.stop({ graceful: true, close: false });
          await pool.end();
        },
      };
    },
  },
  {
    name: "BullMQ",
    skip: valkey.skip,
    open: (name) => {
      const connection = createBullMQConnection(
        new ConfigService({ VALKEY_URL: valkey.url("valkey") }),
      );
      const queue = new BullMQJobQueue<{ n: number }>(name, connection, new BullMQMetricsService());
      return Promise.resolve({ queue, close: () => queue.close() });
    },
  },
];

describe.each(backends)("JobQueue on $name (integration)", (backend) => {
  meta({ epic: "nodejs-basics", feature: "jobs", owner: "@team-platform", tags: ["integration"] });
  const closers: Array<() => Promise<void>> = [];
  afterAll(async () => {
    await Promise.all(closers.map((close) => close()));
  });

  it.skipIf(backend.skip)("runs a job once per key, and counts what waits", async () => {
    await testCase("NB-1012", "send is idempotent per key; work runs each job");
    const { queue, close } = await backend.open(unique("jobs-contract"));
    closers.push(close);

    await queue.send({ n: 1 }, "k1");
    await queue.send({ n: 1 }, "k1"); // a redelivery
    await queue.send({ n: 2 }, "k2");
    expect(await queue.waiting()).toBe(2);

    const seen: number[] = [];
    const done = new Promise<void>((resolve) => {
      void queue.work((data) => {
        seen.push(data.n);
        if (seen.length === 2) resolve();
        return Promise.resolve();
      });
    });
    await done;
    expect(seen.toSorted((a, b) => a - b)).toEqual([1, 2]);
    await queue.ping();
  });
});
