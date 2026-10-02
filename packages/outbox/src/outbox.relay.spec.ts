import { ConfigService } from "@nestjs/config";
import type { Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { KafkaProducerService } from "@base/kafka";
import { AppLogger, pinoLogger } from "@base/logger";
import { meta, testCase } from "@base/testing";

import { OutboxRelay } from "./outbox.relay.js";

const logger = new AppLogger(pinoLogger.child({}, { level: "silent" }));

/** A relay over a fake pool; `query` decides what each statement does. */
function relay(query: (sql: string) => Promise<unknown>): {
  relay: OutboxRelay;
  release: ReturnType<typeof vi.fn>;
} {
  const release = vi.fn();
  const pool = {
    connect: () => Promise.resolve({ query: vi.fn(query), release }),
    query: () => Promise.resolve({ rows: [{ pending: 0, dead: 0 }] }),
  } as unknown as Pool;
  const kafka = { send: vi.fn(() => Promise.resolve([])) } as unknown as KafkaProducerService;
  return { relay: new OutboxRelay(pool, kafka, new ConfigService({}), logger), release };
}

type Internals = {
  tick: () => Promise<void>;
  failures: number;
  running: Promise<void>;
  relayOnce: () => Promise<number>;
  partial: boolean;
};
const internals = (r: OutboxRelay): Internals => r as unknown as Internals;

describe("OutboxRelay (unit)", () => {
  meta({ epic: "nodejs-basics", feature: "outbox", owner: "@team-platform", tags: ["outbox"] });
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("destroys the client when ROLLBACK fails instead of pooling it", async () => {
    await testCase("NB-946", "a broken connection never goes back to the pool");
    const dead = new Error("connection terminated");
    const h = relay((sql) => {
      if (sql === "BEGIN") return Promise.resolve({});
      if (sql === "ROLLBACK") return Promise.reject(dead);
      return Promise.reject(new Error("select failed"));
    });
    await expect(h.relay.relayOnce()).rejects.toThrow("select failed");
    expect(h.release).toHaveBeenCalledWith(dead);
  });

  it("shutdown waits for a batch in flight at most 5 s", async () => {
    await testCase("NB-947", "bounded outbox drain");
    const h = relay(() => Promise.resolve({ rows: [] }));
    internals(h.relay).running = new Promise(() => {});
    let done = false;
    void h.relay.beforeApplicationShutdown().then(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(4_999);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(done).toBe(true);
  });

  it("backs off after a pass with failed rows, and after a failed pass", async () => {
    await testCase("NB-948", "outbox relay backoff");
    const h = relay(() => Promise.resolve({ rows: [] }));
    const r = internals(h.relay);
    r.relayOnce = () => {
      r.partial = true;
      return Promise.resolve(1);
    };
    await r.tick();
    expect(r.failures).toBe(1);
    r.relayOnce = () => Promise.reject(new Error("broker down"));
    await r.tick();
    expect(r.failures).toBe(2);
    await h.relay.beforeApplicationShutdown();
  });
});
