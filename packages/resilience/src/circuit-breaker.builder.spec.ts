import { ServiceUnavailableException } from "@nestjs/common";
import type { ConfigService } from "@nestjs/config";
import { afterEach, describe, expect, it } from "vitest";

import { meta, testCase } from "@base/testing";

import {
  buildCircuitBreaker,
  type CircuitBreakerConfig,
  DEFAULT_CIRCUIT_BREAKER,
  DependencyCircuitBreaker,
} from "./circuit-breaker.builder.js";

function stub(env: Record<string, string | undefined>): ConfigService {
  return { get: (key: string) => env[key] } as unknown as ConfigService;
}

const fail = (): Promise<never> => Promise.reject(new Error("x"));

describe("buildCircuitBreaker", () => {
  meta({
    epic: "nodejs-basics",
    feature: "resilience",
    owner: "@team-platform",
    tags: ["resilience", "unit"],
  });

  it("returns the library defaults when nothing is set — dev path", async () => {
    await testCase("NB-755", "no env → default breaker");
    expect(buildCircuitBreaker(stub({}), "DATABASE")).toEqual(DEFAULT_CIRCUIT_BREAKER);
  });

  it("honours per-prefix overrides for all five knobs", async () => {
    await testCase("NB-756", "<PREFIX>_CB_* overrides");
    const cfg = buildCircuitBreaker(
      stub({
        DATABASE_CB_ENABLED: "false",
        DATABASE_CB_TIMEOUT_MS: "10000",
        DATABASE_CB_ERROR_THRESHOLD_PCT: "25",
        DATABASE_CB_VOLUME_THRESHOLD: "5",
        DATABASE_CB_RESET_TIMEOUT_MS: "60000",
        // Another prefix's knobs are not read.
        VALKEY_CB_TIMEOUT_MS: "1",
      }),
      "DATABASE",
    );
    expect(cfg).toEqual({
      enabled: false,
      timeoutMs: 10_000,
      errorThresholdPct: 25,
      volumeThreshold: 5,
      resetTimeoutMs: 60_000,
    });
  });

  it("falls back to the default per knob on garbage — a single-field override survives", async () => {
    await testCase("NB-757", "garbage values fall back per knob");
    const cfg = buildCircuitBreaker(
      stub({
        VALKEY_CB_ENABLED: "",
        VALKEY_CB_TIMEOUT_MS: "not-a-number",
        VALKEY_CB_ERROR_THRESHOLD_PCT: "-5",
        VALKEY_CB_VOLUME_THRESHOLD: "",
        VALKEY_CB_RESET_TIMEOUT_MS: "90000",
      }),
      "VALKEY",
    );
    expect(cfg).toEqual({ ...DEFAULT_CIRCUIT_BREAKER, resetTimeoutMs: 90_000 });
  });

  it("treats only `true` / `1` as enabled", async () => {
    await testCase("NB-758", "CB_ENABLED parsing");
    expect(buildCircuitBreaker(stub({ X_CB_ENABLED: "1" }), "X").enabled).toBe(true);
    expect(buildCircuitBreaker(stub({ X_CB_ENABLED: "yes" }), "X").enabled).toBe(false);
  });
});

describe("DependencyCircuitBreaker", () => {
  meta({
    epic: "nodejs-basics",
    feature: "resilience",
    owner: "@team-platform",
    tags: ["resilience", "unit"],
  });

  const breakers: DependencyCircuitBreaker[] = [];
  afterEach(() => {
    // opossum keeps internal timers alive; release them between tests.
    for (const b of breakers) b.shutdown();
    breakers.length = 0;
  });

  function make(
    overrides: Partial<CircuitBreakerConfig> = {},
    opts: { errorFilter?: (err: unknown) => boolean } = {},
  ): DependencyCircuitBreaker {
    const b = new DependencyCircuitBreaker(
      "test",
      {
        ...DEFAULT_CIRCUIT_BREAKER,
        // Tight timings so the tests don't wait 30 s for a reset.
        resetTimeoutMs: 100,
        volumeThreshold: 3,
        errorThresholdPct: 50,
        timeoutMs: 5_000,
        ...overrides,
      },
      opts,
    );
    breakers.push(b);
    return b;
  }

  async function trip(b: DependencyCircuitBreaker, times: number): Promise<void> {
    for (let i = 0; i < times; i += 1) {
      // oxlint-disable-next-line no-await-in-loop -- breaker state accumulates per call
      await expect(b.execute(fail)).rejects.toThrow("x");
    }
  }

  it("is a pass-through when disabled — runs the action, no bookkeeping", async () => {
    await testCase("NB-759", "enabled=false → passthrough");
    const b = make({ enabled: false });
    let calls = 0;
    const val = await b.execute(() => {
      calls += 1;
      return Promise.resolve("ok");
    });
    expect(val).toBe("ok");
    expect(calls).toBe(1);
    expect(b.state()).toBe("disabled");
    // shutdown() on a disabled breaker is a no-op.
    expect(() => {
      b.shutdown();
    }).not.toThrow();
  });

  it("returns the action's resolved value on success", async () => {
    await testCase("NB-760", "success passes the value through");
    const b = make();
    await expect(b.execute(() => Promise.resolve(42))).resolves.toBe(42);
    expect(b.state()).toBe("closed");
  });

  it("propagates the action's error unchanged", async () => {
    await testCase("NB-761", "action errors are not wrapped");
    const b = make();
    const err = new Error("query failed");
    await expect(b.execute(() => Promise.reject(err))).rejects.toBe(err);
  });

  it("opens after volumeThreshold + errorThresholdPct and fast-fails with 503", async () => {
    await testCase("NB-762", "open breaker → ServiceUnavailable, action not run");
    const b = make({ volumeThreshold: 3, errorThresholdPct: 50 });
    await trip(b, 3);
    let ran = 0;
    const rejected = b.execute(() => {
      ran += 1;
      return Promise.resolve("never");
    });
    await expect(rejected).rejects.toBeInstanceOf(ServiceUnavailableException);
    await expect(rejected).rejects.toThrow("test circuit breaker open");
    expect(ran).toBe(0);
    expect(b.state()).toBe("open");
  });

  it("does not open before volumeThreshold even at 100% errors", async () => {
    await testCase("NB-763", "below volume threshold stays closed");
    const b = make({ volumeThreshold: 5, errorThresholdPct: 50 });
    await trip(b, 4);
    expect(b.state()).toBe("closed");
    let ran = 0;
    await expect(
      b.execute(() => {
        ran += 1;
        return fail();
      }),
    ).rejects.toThrow("x");
    expect(ran).toBe(1);
  });

  it("half-opens after resetTimeoutMs and closes on a successful probe", async () => {
    await testCase("NB-764", "half-open probe recovers the breaker");
    const b = make({ resetTimeoutMs: 40 });
    await trip(b, 3);
    expect(b.state()).toBe("open");

    await new Promise((r) => setTimeout(r, 80));
    expect(b.state()).toBe("halfOpen");
    await expect(b.execute(() => Promise.resolve("recovered"))).resolves.toBe("recovered");
    expect(b.state()).toBe("closed");
  });

  it("errorFilter keeps whitelisted errors out of the error budget", async () => {
    await testCase("NB-765", "filtered errors never trip the breaker");
    const b = make({}, { errorFilter: (err) => (err as { code?: string }).code === "ENOENT" });
    const expected = Object.assign(new Error("expected"), { code: "ENOENT" });
    for (let i = 0; i < 5; i += 1) {
      // oxlint-disable-next-line no-await-in-loop -- breaker state accumulates per call
      await expect(b.execute(() => Promise.reject(expected))).rejects.toBe(expected);
    }
    expect(b.state()).toBe("closed");
  });

  it("counts a hung action as a failure once timeoutMs elapses", async () => {
    await testCase("NB-766", "per-action watchdog timeout");
    const b = make({ timeoutMs: 20 });
    await expect(b.execute(() => new Promise((r) => setTimeout(r, 200)))).rejects.toThrow(
      /timed out/iu,
    );
  });
});
