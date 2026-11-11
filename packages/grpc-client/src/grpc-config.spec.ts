import { Channel, credentials, status } from "@grpc/grpc-js";
import { describe, expect, it } from "vitest";

import { meta, testCase } from "@base/testing";

import { channelOptionsOf } from "./grpc-clients.js";
import {
  type GrpcTargetConfig,
  grpcTargetProblems,
  resolveGrpcTarget,
  splitMethod,
} from "./grpc-config.js";
import { classify, isCircuitOpen, outcomeOf } from "./grpc-policy.js";
import { protoDuration, serviceConfigOf } from "./service-config.js";

const base = { name: "billing", address: "dns:///billing.internal:443" };
const problems = (target: Partial<GrpcTargetConfig>): string[] =>
  grpcTargetProblems([resolveGrpcTarget({ ...base, ...target })]);

describe("gRPC target config", () => {
  meta({
    epic: "nodejs-basics",
    feature: "grpc-client",
    owner: "@team-platform",
    tags: ["grpc", "client", "config", "unit"],
  });

  it("fills an omitted key with its default, and keeps an explicit zero", async () => {
    await testCase("NB-1092", "zero means disabled, never 'use the default'");
    expect(resolveGrpcTarget(base)).toEqual({
      ...base,
      insecure: false,
      timeoutMs: 5000,
      waitForReady: false,
      loadBalancing: "round_robin",
      keepalive: { timeMs: 0, timeoutMs: 20_000 },
      retry: {
        maxAttempts: 3,
        baseDelayMs: 100,
        maxDelayMs: 5000,
        codes: ["UNAVAILABLE"],
        methods: [],
        throttle: { maxTokens: 10, tokenRatio: 0.1 },
      },
      circuitBreaker: {
        failureRatio: 0.5,
        minRequests: 20,
        windowMs: 10_000,
        openTimeoutMs: 30_000,
      },
    });
    const off = resolveGrpcTarget({
      ...base,
      timeoutMs: 0,
      retry: { maxAttempts: 0, throttle: { maxTokens: 0 } },
      circuitBreaker: { failureRatio: 0 },
    });
    expect(off.timeoutMs).toBe(0);
    expect(off.retry.maxAttempts).toBe(0);
    expect(off.retry.throttle).toEqual({ maxTokens: 0, tokenRatio: 0.1 });
    expect(off.circuitBreaker.failureRatio).toBe(0);
    expect(problems({})).toEqual([]);
  });

  it("accepts the edges of every range", async () => {
    await testCase("NB-1093", "limits are inclusive where the message says so");
    expect(
      problems({
        timeoutMs: 0,
        loadBalancing: "pick_first",
        keepalive: { timeMs: 10_000, timeoutMs: 1 },
        retry: {
          maxAttempts: 5,
          baseDelayMs: 1,
          maxDelayMs: 1,
          codes: ["UNAVAILABLE", "RESOURCE_EXHAUSTED"],
          methods: ["billing.v1.Invoices", "billing.v1.Invoices/Get"],
          throttle: { maxTokens: 1000, tokenRatio: 0.001 },
        },
        circuitBreaker: { failureRatio: 0.999, minRequests: 1, windowMs: 1, openTimeoutMs: 1 },
      }),
    ).toEqual([]);
  });

  it.each<[string, Partial<GrpcTargetConfig>, string]>([
    ["no address", { address: "" }, "address is required"],
    ["negative timeout", { timeoutMs: -1 }, "timeoutMs must be a whole number ≥ 0"],
    ["fractional timeout", { timeoutMs: 1.5 }, "timeoutMs must be a whole number ≥ 0"],
    [
      "unknown balancer",
      { loadBalancing: "random" as "pick_first" },
      "loadBalancing must be round_robin or pick_first",
    ],
    [
      "keepalive a server would punish",
      { keepalive: { timeMs: 9999 } },
      "keepalive.timeMs must be 0 (off) or ≥ 10000",
    ],
    [
      "keepalive without a timeout",
      { keepalive: { timeMs: 10_000, timeoutMs: 0 } },
      "keepalive.timeoutMs must be a whole number > 0",
    ],
    [
      "more attempts than gRPC makes",
      { retry: { maxAttempts: 6 } },
      "retry.maxAttempts must be a whole number in [0, 5]",
    ],
    [
      "negative attempts",
      { retry: { maxAttempts: -1 } },
      "retry.maxAttempts must be a whole number in [0, 5]",
    ],
    [
      "no base delay",
      { retry: { baseDelayMs: 0 } },
      "retry.baseDelayMs must be a whole number > 0",
    ],
    [
      "max delay under the base",
      { retry: { baseDelayMs: 100, maxDelayMs: 99 } },
      "retry.maxDelayMs must be a whole number ≥ retry.baseDelayMs",
    ],
    ["no codes", { retry: { codes: [] } }, "retry.codes must not be empty"],
    [
      "retrying OK",
      { retry: { codes: ["OK"] } },
      'retry.codes: "OK" is not a retryable status name',
    ],
    [
      "a code gRPC does not have",
      { retry: { codes: ["unavailable"] } },
      'retry.codes: "unavailable" is not a retryable status name',
    ],
    [
      "a numeric key of the enum",
      { retry: { codes: ["14"] } },
      'retry.codes: "14" is not a retryable status name',
    ],
    [
      "a method path instead of a name",
      { retry: { methods: ["/billing.v1.Invoices/Get"] } },
      'retry.methods: "/billing.v1.Invoices/Get" is not pkg.Service or pkg.Service/Method',
    ],
    [
      "too many throttle tokens",
      { retry: { throttle: { maxTokens: 1001 } } },
      "retry.throttle.maxTokens must be a whole number in [0, 1000]",
    ],
    [
      "a throttle that never refills",
      { retry: { throttle: { tokenRatio: 0 } } },
      "retry.throttle.tokenRatio must be > 0",
    ],
    [
      "a ratio that can never be exceeded",
      { circuitBreaker: { failureRatio: 1 } },
      "circuitBreaker.failureRatio must be in [0, 1)",
    ],
    [
      "negative ratio",
      { circuitBreaker: { failureRatio: -0.1 } },
      "circuitBreaker.failureRatio must be in [0, 1)",
    ],
    [
      "no minimum",
      { circuitBreaker: { minRequests: 0 } },
      "circuitBreaker.minRequests must be a whole number > 0",
    ],
    [
      "no window",
      { circuitBreaker: { windowMs: 0 } },
      "circuitBreaker.windowMs must be a whole number > 0",
    ],
    [
      "no open timeout",
      { circuitBreaker: { openTimeoutMs: 0 } },
      "circuitBreaker.openTimeoutMs must be a whole number > 0",
    ],
  ])("rejects %s", async (_what, target, problem) => {
    await testCase("NB-1094", "one problem, named with its target and key");
    expect(problems(target)).toEqual([`target billing: ${problem}`]);
  });

  it("does not judge the knobs of a feature that is off", async () => {
    await testCase(
      "NB-1095",
      "no retries / no breaker / no keepalive: their other keys are unused",
    );
    expect(
      problems({
        keepalive: { timeMs: 0, timeoutMs: 0 },
        retry: { maxAttempts: 1, baseDelayMs: 0, codes: [], throttle: { maxTokens: 5000 } },
        circuitBreaker: { failureRatio: 0, minRequests: 0, windowMs: 0, openTimeoutMs: 0 },
      }),
    ).toEqual([]);
    expect(problems({ retry: { throttle: { maxTokens: 0, tokenRatio: 0 } } })).toEqual([]);
  });

  it("names a nameless target by its position and a second one by 'duplicate'", async () => {
    await testCase("NB-1096", "problems across the list");
    const targets = [base, { ...base }, { name: "", address: "x" }].map((target) =>
      resolveGrpcTarget(target),
    );
    expect(grpcTargetProblems(targets)).toEqual([
      "target billing: duplicate name",
      "targets[2]: name is required",
    ]);
  });

  it("splits a method name into the service config's parts", async () => {
    await testCase("NB-1097", "pkg.Service and pkg.Service/Method; nothing else");
    expect(splitMethod("billing.v1.Invoices")).toStrictEqual({ service: "billing.v1.Invoices" });
    expect(splitMethod("billing.v1.Invoices/Get")).toEqual({
      service: "billing.v1.Invoices",
      method: "Get",
    });
    for (const bad of ["", "/a.B/C", "a.B/", "a.B/C/D", "a b", "x a.B/C", "a.B/C y"]) {
      expect(splitMethod(bad)).toBeUndefined();
    }
  });
});

describe("gRPC service config", () => {
  meta({
    epic: "nodejs-basics",
    feature: "grpc-client",
    owner: "@team-platform",
    tags: ["grpc", "client", "config", "unit"],
  });

  it("renders the defaults: deadline, retry policy, throttling, balancing", async () => {
    await testCase("NB-1098", "the service config of a default target");
    expect(serviceConfigOf(resolveGrpcTarget(base))).toEqual({
      loadBalancingConfig: [{ round_robin: {} }],
      methodConfig: [
        {
          name: [{}],
          timeout: "5s",
          retryPolicy: {
            maxAttempts: 3,
            initialBackoff: "0.1s",
            maxBackoff: "5s",
            backoffMultiplier: 2,
            retryableStatusCodes: ["UNAVAILABLE"],
          },
        },
      ],
      retryThrottling: { maxTokens: 10, tokenRatio: 0.1 },
    });
  });

  it("leaves out what is off", async () => {
    await testCase("NB-1099", "no timeout, no retries → no retry policy and no throttling");
    const target = resolveGrpcTarget({
      ...base,
      timeoutMs: 0,
      waitForReady: true,
      loadBalancing: "pick_first",
      retry: { maxAttempts: 1 },
    });
    expect(serviceConfigOf(target)).toEqual({
      loadBalancingConfig: [{ pick_first: {} }],
      methodConfig: [{ name: [{}], waitForReady: true }],
    });
    const unthrottled = resolveGrpcTarget({ ...base, retry: { throttle: { maxTokens: 0 } } });
    expect(serviceConfigOf(unthrottled).retryThrottling).toBeUndefined();
    expect(serviceConfigOf(unthrottled).methodConfig[0]?.retryPolicy?.maxAttempts).toBe(3);
  });

  it("retries only the named methods, which keep the default deadline", async () => {
    await testCase("NB-1100", "retry.methods → a second method config with the policy");
    const target = resolveGrpcTarget({
      ...base,
      waitForReady: true,
      retry: { maxAttempts: 2, methods: ["billing.v1.Invoices/Get", "billing.v1.Ledger"] },
    });
    const { methodConfig } = serviceConfigOf(target);
    expect(methodConfig).toHaveLength(2);
    expect(methodConfig[0]).toEqual({ name: [{}], timeout: "5s", waitForReady: true });
    expect(methodConfig[1]).toMatchObject({
      name: [{ service: "billing.v1.Invoices", method: "Get" }, { service: "billing.v1.Ledger" }],
      timeout: "5s",
      waitForReady: true,
      retryPolicy: { maxAttempts: 2 },
    });
  });

  it("writes durations as protobuf JSON", async () => {
    await testCase("NB-1101", "decimal seconds");
    expect([1, 100, 1500, 60_000].map((ms) => protoDuration(ms))).toEqual([
      "0.001s",
      "0.1s",
      "1.5s",
      "60s",
    ]);
  });

  it("is a config grpc-js accepts, with keepalive only when asked for", async () => {
    await testCase("NB-1102", "the channel options of a target; a channel takes them");
    const plain = channelOptionsOf(resolveGrpcTarget(base));
    expect(Object.keys(plain)).toEqual([
      "grpc.service_config",
      "grpc.service_config_disable_resolution",
    ]);
    expect(plain["grpc.service_config_disable_resolution"]).toBe(1);

    const full = resolveGrpcTarget({
      ...base,
      keepalive: { timeMs: 30_000, timeoutMs: 7000 },
      retry: { methods: ["billing.v1.Invoices/Get"], codes: ["UNAVAILABLE", "ABORTED"] },
    });
    const options = channelOptionsOf(full);
    expect(options["grpc.keepalive_time_ms"]).toBe(30_000);
    expect(options["grpc.keepalive_timeout_ms"]).toBe(7000);
    expect(JSON.parse(options["grpc.service_config"] ?? "")).toEqual(serviceConfigOf(full));
    // grpc-js validates the service config when the channel is made.
    new Channel("127.0.0.1:1", credentials.createInsecure(), options).close();
    new Channel("127.0.0.1:1", credentials.createInsecure(), plain).close();
  });
});

describe("gRPC call outcome", () => {
  meta({
    epic: "nodejs-basics",
    feature: "grpc-client",
    owner: "@team-platform",
    tags: ["grpc", "client", "unit"],
  });

  it("labels every status code, CANCELLED spelt like the HTTP client's", async () => {
    await testCase("NB-1103", "the outcome label set is the status names, bounded");
    const names = Object.entries(status).filter(([, code]) => typeof code === "number");
    expect(names).toHaveLength(17);
    for (const [name, code] of names) {
      const want = name === "CANCELLED" ? "canceled" : name.toLowerCase();
      expect(outcomeOf(code as number)).toBe(want);
    }
    expect(outcomeOf(17)).toBe("unknown");
    expect(outcomeOf(-1)).toBe("unknown");
  });

  it("tells the breaker failure from answer from walking away", async () => {
    await testCase("NB-1104", "which statuses count against the dependency");
    const failures = new Set([
      "UNAVAILABLE",
      "DEADLINE_EXCEEDED",
      "INTERNAL",
      "UNKNOWN",
      "DATA_LOSS",
    ]);
    for (const [name, code] of Object.entries(status)) {
      if (typeof code !== "number") continue;
      const want = name === "CANCELLED" ? "ignored" : failures.has(name) ? "failure" : "success";
      expect(`${name}: ${classify(code)}`).toBe(`${name}: ${want}`);
    }
  });

  it("recognises only its own rejection as an open circuit", async () => {
    await testCase("NB-1105", "isCircuitOpen is false for anything gRPC or the server made");
    for (const other of [
      null,
      undefined,
      new Error("x"),
      { code: status.UNAVAILABLE },
      { metadata: {} },
    ]) {
      expect(isCircuitOpen(other)).toBe(false);
    }
  });
});
