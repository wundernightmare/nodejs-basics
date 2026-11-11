import {
  type CallOptions,
  type Client,
  type ClientReadableStream,
  type ClientUnaryCall,
  connectivityState,
  credentials,
  type InterceptingCall,
  type InterceptingListener,
  type InterceptorOptions,
  makeGenericClientConstructor,
  Metadata,
  Server,
  ServerCredentials,
  type ServerUnaryCall,
  type ServerWritableStream,
  type sendUnaryData,
  type ServiceError,
  status,
} from "@grpc/grpc-js";
import { type Meter, metrics as otelMetrics, SpanKind, SpanStatusCode } from "@opentelemetry/api";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  captureMetrics,
  captureSpans,
  meta,
  type MetricsCapture,
  metricValue,
  type SpanCapture,
  testCase,
} from "@base/testing";

import { type GrpcClientConstructor, GrpcClients } from "./grpc-clients.js";
import { type GrpcTargetConfig, resolveGrpcTarget } from "./grpc-config.js";
import { createInstruments, isCircuitOpen, TargetPolicy } from "./grpc-policy.js";

interface Msg {
  text: string;
}

const codec = {
  requestSerialize: (value: Msg) => Buffer.from(JSON.stringify(value)),
  requestDeserialize: (bytes: Buffer) => JSON.parse(bytes.toString()) as Msg,
  responseSerialize: (value: Msg) => Buffer.from(JSON.stringify(value)),
  responseDeserialize: (bytes: Buffer) => JSON.parse(bytes.toString()) as Msg,
};
const definition = {
  unary: { path: "/test.Echo/Unary", requestStream: false, responseStream: false, ...codec },
  list: { path: "/test.Echo/List", requestStream: false, responseStream: true, ...codec },
};

interface EchoClient extends Client {
  unary(
    request: Msg,
    metadata: Metadata,
    options: CallOptions,
    callback: (err: ServiceError | null, response?: Msg) => void,
  ): ClientUnaryCall;
  list(request: Msg): ClientReadableStream<Msg>;
}
const Echo = makeGenericClientConstructor(
  definition,
  "Echo",
) as unknown as GrpcClientConstructor<EchoClient>;

const UNARY = "/test.Echo/Unary";
const unavailable = { code: status.UNAVAILABLE, details: "down" };

function unary(
  client: EchoClient,
  options: CallOptions = {},
): Promise<{ err: ServiceError | null; response: Msg | undefined }> {
  return new Promise((resolve) => {
    client.unary({ text: "hi" }, new Metadata(), options, (err, response) => {
      resolve({ err, response });
    });
  });
}

async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("condition not reached in 2 s");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("GrpcClients", () => {
  meta({
    epic: "nodejs-basics",
    feature: "grpc-client",
    owner: "@team-platform",
    tags: ["grpc", "client", "unit"],
  });

  /** What the server does with the next unary call; a test replaces it. */
  let onUnary: (call: ServerUnaryCall<Msg, Msg>, reply: sendUnaryData<Msg>) => void;
  let hits: number;
  let server: Server;
  let address: string;
  let metrics: MetricsCapture;
  let spans: SpanCapture;
  let grpc: GrpcClients | undefined;
  let seq = 0;

  beforeAll(async () => {
    metrics = captureMetrics();
    spans = captureSpans();
    server = new Server();
    server.addService(definition, {
      unary: (call: ServerUnaryCall<Msg, Msg>, reply: sendUnaryData<Msg>) => {
        hits++;
        onUnary(call, reply);
      },
      list: (call: ServerWritableStream<Msg, Msg>) => {
        for (const text of ["a", "b", "c"]) call.write({ text });
        call.end();
      },
    });
    const port = await new Promise<number>((resolve, reject) => {
      server.bindAsync("127.0.0.1:0", ServerCredentials.createInsecure(), (err, bound) => {
        if (err) reject(err);
        else resolve(bound);
      });
    });
    address = `127.0.0.1:${port}`;
  });

  afterEach(() => {
    grpc?.close();
    grpc = undefined;
  });

  afterAll(async () => {
    server.forceShutdown();
    spans.stop();
    await metrics.stop();
  });

  /** A client of a fresh target (its own metric label) with `overrides` on a no-retry, no-breaker base. */
  function connect(
    overrides: Partial<GrpcTargetConfig> = {},
    getRemainingMs?: () => number | undefined,
  ): { client: EchoClient; target: string } {
    const target = `echo-${++seq}`;
    hits = 0;
    onUnary = (call, reply) => {
      reply(null, { text: call.request.text });
    };
    grpc = new GrpcClients(
      [
        {
          name: target,
          address,
          insecure: true,
          retry: { maxAttempts: 1 },
          circuitBreaker: { failureRatio: 0 },
          ...overrides,
        },
      ],
      getRemainingMs === undefined ? {} : { getRemainingMs },
    );
    return { client: grpc.client(target, Echo), target };
  }

  const requests = async (target: string, outcome: string, method = UNARY): Promise<number> =>
    metricValue(await metrics.scrape(), "grpc_client_requests_total", { target, method, outcome });

  const breakerGauge = async (target: string): Promise<number> =>
    metricValue(await metrics.scrape(), "grpc_client_circuit_breaker_state", { target });

  it("makes the call and counts it once, with its duration", async () => {
    await testCase("NB-1075", "a call through the policy is the plain gRPC call, measured");
    const { client, target } = connect();
    const { err, response } = await unary(client);
    expect(err).toBeNull();
    expect(response).toEqual({ text: "hi" });
    expect(await requests(target, "ok")).toBe(1);
    const text = await metrics.scrape();
    const labels = { target, method: UNARY };
    expect(metricValue(text, "grpc_client_request_duration_seconds_count", labels)).toBe(1);
    const seconds = metricValue(text, "grpc_client_request_duration_seconds_sum", labels);
    expect(seconds).toBeGreaterThan(0);
    expect(seconds).toBeLessThan(2);
    expect(
      metricValue(text, "grpc_client_request_duration_seconds_bucket", { ...labels, le: "0.0025" }),
    ).toBeGreaterThanOrEqual(0); // the shared latency buckets
    expect(text).toContain(
      "# HELP grpc_client_requests_total Outbound gRPC calls by target, method and outcome (status code or circuit_open).",
    );
    expect(text).toContain("# UNIT grpc_client_request_duration_seconds s");
    expect(metricValue(text, "grpc_client_retries_total", { target })).toBe(-1);
    expect(await breakerGauge(target)).toBe(-1); // no breaker, no state
    expect(grpc?.circuitBreakerStates()).toEqual({ [target]: "disabled" });
  });

  it("retries the listed codes below the policy: one call, its retries counted", async () => {
    await testCase("NB-1076", "gRPC retries UNAVAILABLE; the call is counted once, as its end");
    const { client, target } = connect({
      retry: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 2 },
      circuitBreaker: { failureRatio: 0.5, minRequests: 1 },
    });
    onUnary = (call, reply) => {
      if (hits < 3) reply(unavailable);
      else reply(null, { text: call.request.text });
    };
    const { err } = await unary(client);
    expect(err).toBeNull();
    expect(hits).toBe(3);
    expect(await requests(target, "ok")).toBe(1);
    expect(await requests(target, "unavailable")).toBe(-1);
    expect(metricValue(await metrics.scrape(), "grpc_client_retries_total", { target })).toBe(2);
    expect(grpc?.circuitBreakerStates()).toEqual({ [target]: "closed" }); // the attempts are not calls
  });

  it("counts the retries of a call that failed in the end", async () => {
    await testCase("NB-1077", "exhausted retries: the last status, every retry counted");
    const { client, target } = connect({
      retry: { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 2 },
    });
    onUnary = (_call, reply) => {
      reply(unavailable);
    };
    const { err } = await unary(client);
    expect(err?.code).toBe(status.UNAVAILABLE);
    expect(isCircuitOpen(err)).toBe(false);
    expect(hits).toBe(2);
    expect(await requests(target, "unavailable")).toBe(1);
    expect(metricValue(await metrics.scrape(), "grpc_client_retries_total", { target })).toBe(1);
  });

  it("does not retry a code that is not listed", async () => {
    await testCase("NB-1078", "INTERNAL is not in retry.codes: one attempt");
    const { client } = connect({ retry: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 2 } });
    onUnary = (_call, reply) => {
      reply({ code: status.INTERNAL, details: "bug" });
    };
    expect((await unary(client)).err?.code).toBe(status.INTERNAL);
    expect(hits).toBe(1);
  });

  it("opens after failures, rejects without calling, probes and closes", async () => {
    await testCase("NB-1079", "closed → open → half-open → closed, with the gauge and the outcome");
    const { client, target } = connect({
      circuitBreaker: { failureRatio: 0.5, minRequests: 2, openTimeoutMs: 60 },
    });
    onUnary = (_call, reply) => {
      reply(unavailable);
    };
    await unary(client);
    expect(grpc?.circuitBreakerStates()).toEqual({ [target]: "closed" }); // below minRequests
    expect(await breakerGauge(target)).toBe(0);
    await unary(client);
    expect(grpc?.circuitBreakerStates()).toEqual({ [target]: "open" });
    expect(await breakerGauge(target)).toBe(1);

    const { err } = await unary(client);
    expect(err?.code).toBe(status.UNAVAILABLE);
    expect(isCircuitOpen(err)).toBe(true);
    expect(err?.details).toBe(`circuit breaker open: ${target}`);
    expect(hits).toBe(2); // the rejected call never reached the server
    expect(await requests(target, "circuit_open")).toBe(1);
    const text = await metrics.scrape();
    const labels = { target, method: UNARY };
    expect(metricValue(text, "grpc_client_request_duration_seconds_count", labels)).toBe(2);

    await until(() => grpc?.circuitBreakerStates()[target] === "halfOpen");
    expect(await breakerGauge(target)).toBe(2);
    onUnary = (call, reply) => {
      reply(null, { text: call.request.text });
    };
    expect((await unary(client)).err).toBeNull();
    expect(grpc?.circuitBreakerStates()).toEqual({ [target]: "closed" });
  });

  it("lets one probe through while half-open, and opens again when it fails", async () => {
    await testCase("NB-1080", "a second call during the probe is rejected; a failed probe reopens");
    const { client, target } = connect({
      circuitBreaker: { failureRatio: 0.5, minRequests: 1, openTimeoutMs: 40 },
    });
    let answer: sendUnaryData<Msg> | undefined;
    onUnary = (_call, reply) => {
      reply(unavailable);
    };
    await unary(client);
    await until(() => grpc?.circuitBreakerStates()[target] === "halfOpen");

    onUnary = (_call, reply) => {
      answer = reply;
    };
    const probe = unary(client);
    await until(() => answer !== undefined);
    expect(isCircuitOpen((await unary(client)).err)).toBe(true);
    answer?.(unavailable);
    await probe;
    expect(grpc?.circuitBreakerStates()).toEqual({ [target]: "open" });
  });

  it("takes an answer for an answer: NOT_FOUND never opens the breaker", async () => {
    await testCase("NB-1081", "a status that is the dependency's verdict is a success");
    const { client, target } = connect({ circuitBreaker: { failureRatio: 0.5, minRequests: 1 } });
    onUnary = (_call, reply) => {
      reply({ code: status.NOT_FOUND, details: "no such thing" });
    };
    for (let i = 0; i < 3; i++) expect((await unary(client)).err?.code).toBe(status.NOT_FOUND);
    expect(grpc?.circuitBreakerStates()).toEqual({ [target]: "closed" });
    expect(await requests(target, "not_found")).toBe(3);
  });

  it("applies the target's timeout, and counts the missed deadline as a failure", async () => {
    await testCase("NB-1082", "service-config timeout → DEADLINE_EXCEEDED → the breaker opens");
    const { client, target } = connect({
      timeoutMs: 40,
      circuitBreaker: { failureRatio: 0.5, minRequests: 1 },
    });
    onUnary = () => {}; // never answers
    expect((await unary(client)).err?.code).toBe(status.DEADLINE_EXCEEDED);
    expect(await requests(target, "deadline_exceeded")).toBe(1);
    expect(grpc?.circuitBreakerStates()).toEqual({ [target]: "open" });
  });

  it("does not hold a cancelled call against the dependency", async () => {
    await testCase("NB-1083", "CANCELLED: outcome canceled, the breaker stays closed");
    const { client, target } = connect({ circuitBreaker: { failureRatio: 0.5, minRequests: 1 } });
    onUnary = () => {};
    const done = new Promise<ServiceError | null>((resolve) => {
      const pending = client.unary({ text: "hi" }, new Metadata(), {}, resolve);
      void until(() => hits === 1).then(() => {
        pending.cancel();
      });
    });
    expect((await done)?.code).toBe(status.CANCELLED);
    expect(await requests(target, "canceled")).toBe(1);
    expect(grpc?.circuitBreakerStates()).toEqual({ [target]: "closed" });
  });

  it("opens again when the probe is abandoned: it proved nothing", async () => {
    await testCase("NB-1084", "a cancelled half-open probe does not close the breaker");
    const { client, target } = connect({
      circuitBreaker: { failureRatio: 0.5, minRequests: 1, openTimeoutMs: 40 },
    });
    onUnary = (_call, reply) => {
      reply(unavailable);
    };
    await unary(client);
    await until(() => grpc?.circuitBreakerStates()[target] === "halfOpen");
    onUnary = () => {};
    const done = new Promise<ServiceError | null>((resolve) => {
      const pending = client.unary({ text: "hi" }, new Metadata(), {}, resolve);
      void until(() => hits === 2).then(() => {
        pending.cancel();
      });
    });
    expect((await done)?.code).toBe(status.CANCELLED);
    expect(grpc?.circuitBreakerStates()).toEqual({ [target]: "open" });
  });

  it("fails a call whose budget is spent before sending it, breaker untouched", async () => {
    await testCase("NB-1085", "getRemainingMs ≤ 0 → DEADLINE_EXCEEDED locally");
    const { client, target } = connect(
      { circuitBreaker: { failureRatio: 0.5, minRequests: 1 } },
      () => 0,
    );
    const { err } = await unary(client);
    expect(err?.code).toBe(status.DEADLINE_EXCEEDED);
    expect(err?.details).toBe("deadline exceeded before the call was sent");
    expect(hits).toBe(0);
    expect(await requests(target, "deadline_exceeded")).toBe(1);
    expect(grpc?.circuitBreakerStates()).toEqual({ [target]: "closed" });
  });

  it("brings the deadline in to the caller's budget, never out", async () => {
    await testCase(
      "NB-1086",
      "deadline = min(the call's own, now + budget); sent on as grpc-timeout",
    );
    const { client } = connect({ timeoutMs: 0 }, () => 30_000);
    let left = 0;
    onUnary = (call, reply) => {
      const deadline = call.getDeadline();
      left = (deadline instanceof Date ? deadline.getTime() : deadline) - Date.now();
      reply(null, { text: "" });
    };
    await unary(client);
    expect(left).toBeGreaterThan(20_000);
    expect(left).toBeLessThanOrEqual(30_000);

    await unary(client, { deadline: Date.now() + 5000 }); // the caller's is sooner: kept
    expect(left).toBeGreaterThan(1000);
    expect(left).toBeLessThanOrEqual(5000);
    await unary(client, { deadline: new Date(Date.now() + 60_000) }); // later: brought in
    expect(left).toBeLessThanOrEqual(30_000);
  });

  it("counts a stream once, when it ends", async () => {
    await testCase("NB-1087", "a server stream is one call: every message, one count");
    const { client, target } = connect();
    const got: string[] = [];
    await new Promise<void>((resolve, reject) => {
      const stream = client.list({ text: "" });
      stream.on("data", (message: Msg) => got.push(message.text));
      stream.on("error", reject);
      stream.on("end", resolve);
    });
    expect(got).toEqual(["a", "b", "c"]);
    expect(await requests(target, "ok", "/test.Echo/List")).toBe(1);
  });

  it("rejects a stream while the breaker is open", async () => {
    await testCase("NB-1088", "the breaker is the target's: a stream is rejected like a call");
    const { client, target } = connect({ circuitBreaker: { failureRatio: 0.5, minRequests: 1 } });
    onUnary = (_call, reply) => {
      reply(unavailable);
    };
    await unary(client);
    const err = await new Promise<unknown>((resolve) => {
      client.list({ text: "" }).on("error", resolve).resume();
    });
    expect(isCircuitOpen(err)).toBe(true);
    expect(await requests(target, "circuit_open", "/test.Echo/List")).toBe(1);
  });

  it("traces the call: a CLIENT span whose context the server receives", async () => {
    await testCase("NB-1089", "span name, kind, rpc.* attributes; traceparent in the metadata");
    spans.reset();
    const { client, target } = connect();
    let traceparent = "";
    onUnary = (call, reply) => {
      traceparent = String(call.metadata.get("traceparent")[0]);
      reply({ code: status.INTERNAL, details: "bug" });
    };
    await unary(client);
    const span = spans.span("test.Echo/Unary");
    expect(span.kind).toBe(SpanKind.CLIENT);
    expect(span.instrumentationScope.name).toBe("@base/grpc-client");
    expect(traceparent).toContain(`${span.spanContext().traceId}-${span.spanContext().spanId}`);
    expect(span.attributes).toEqual({
      "rpc.system": "grpc",
      "rpc.service": "test.Echo",
      "rpc.method": "Unary",
      "peer.service": target,
      "rpc.grpc.status_code": status.INTERNAL,
    });
    expect(span.status.code).toBe(SpanStatusCode.ERROR);

    spans.reset();
    onUnary = (_call, reply) => {
      reply({ code: status.NOT_FOUND, details: "no such thing" });
    };
    await unary(client);
    expect(spans.span("test.Echo/Unary").status.code).toBe(SpanStatusCode.UNSET); // an answer
  });

  it("logs the breaker's transitions", async () => {
    await testCase("NB-1090", "open is a warning, close an info, each naming the target");
    const lines: string[] = [];
    const log = (level: string) => (obj: Record<string, unknown>, msg: string) => {
      lines.push(`${level} ${String(obj["grpc_target"])} ${msg}`);
    };
    grpc = new GrpcClients(
      [
        {
          name: "logged",
          address,
          insecure: true,
          retry: { maxAttempts: 1 },
          circuitBreaker: { failureRatio: 0.5, minRequests: 1, openTimeoutMs: 30 },
        },
      ],
      { logger: { info: log("info"), warn: log("warn") } },
    );
    const client = grpc.client("logged", Echo);
    onUnary = (_call, reply) => {
      reply(unavailable);
    };
    await unary(client);
    await until(() => grpc?.circuitBreakerStates()["logged"] === "halfOpen");
    onUnary = (call, reply) => {
      reply(null, { text: call.request.text });
    };
    await unary(client);
    expect(lines).toEqual([
      "warn logged gRPC circuit breaker opened",
      "info logged gRPC circuit breaker closed",
    ]);
  });

  it("refuses an invalid target list, an unknown target and use after close", async () => {
    await testCase("NB-1091", "misuse fails loudly, at construction or at lookup");
    expect(() => new GrpcClients([{ name: "", address: "" }])).toThrow(
      "invalid gRPC targets: targets[0]: name is required; targets[0]: address is required",
    );
    const { target } = connect();
    expect(() => grpc?.client("nope", Echo)).toThrow("unknown gRPC target: nope");
    grpc?.close();
    grpc?.close(); // idempotent
    expect(() => grpc?.client(target, Echo)).toThrow("GrpcClients is closed");
  });

  it("opens only when more than the ratio of the window's calls failed", async () => {
    await testCase("NB-1106", "failureRatio is a share of the calls, exceeded — not reached");
    const { client, target } = connect({ circuitBreaker: { failureRatio: 0.5, minRequests: 4 } });
    const answers = [unavailable, null, null, unavailable, unavailable]; // 1/1 … 2/4, then 3/5
    onUnary = (call, reply) => {
      const answer = answers[hits - 1];
      if (answer) reply(answer);
      else reply(null, { text: call.request.text });
    };
    for (let i = 0; i < 4; i++) await unary(client);
    expect(grpc?.circuitBreakerStates()).toEqual({ [target]: "closed" }); // 50 % is not more than 50 %
    await unary(client);
    expect(grpc?.circuitBreakerStates()).toEqual({ [target]: "open" });
  });

  it("uses TLS unless the target is insecure, with the given credentials", async () => {
    await testCase("NB-1107", "insecure is per target and explicit; credentials are the caller's");
    const own = credentials.createSsl();
    const targets = [
      { name: "tls", address: "dns:///billing.internal:443" },
      { name: "plain", address, insecure: true },
    ];
    grpc = new GrpcClients(targets);
    expect(grpc.clientOptions("tls").credentials._isSecure()).toBe(true);
    expect(grpc.clientOptions("plain").credentials._isSecure()).toBe(false);
    expect(grpc.clientOptions("tls").address).toBe("dns:///billing.internal:443");
    grpc.close();
    grpc = new GrpcClients(targets, { credentials: own });
    expect(grpc.clientOptions("tls").credentials).toBe(own);
    expect(grpc.clientOptions("plain").credentials._isSecure()).toBe(false);
  });

  it("closes its channels and stops observing its breakers when closed", async () => {
    await testCase("NB-1108", "close() takes the gauge callback off the meter");
    const callbacks = new Set<unknown>();
    const meter = {
      createCounter: () => ({ add: () => {} }),
      createHistogram: () => ({ record: () => {} }),
      createObservableGauge: () => ({
        addCallback: (callback: unknown) => callbacks.add(callback),
        removeCallback: (callback: unknown) => callbacks.delete(callback),
      }),
    } as unknown as Meter;
    grpc = new GrpcClients([{ name: "metered", address, insecure: true }], { meter });
    expect(callbacks.size).toBe(1);
    const channel = grpc.clientOptions("metered").options.channelOverride;
    expect(channel?.getConnectivityState(false)).toBe(connectivityState.IDLE);
    grpc.close();
    expect(callbacks.size).toBe(0);
    expect(channel?.getConnectivityState(false)).toBe(connectivityState.SHUTDOWN);
  });

  it("forwards to the call below once admitted, whatever the listener lacks", async () => {
    await testCase("NB-1109", "the interceptor is transparent; a partial listener is fine");
    const instruments = createInstruments(otelMetrics.getMeter("test"), () => []);
    const config = resolveGrpcTarget({
      name: "direct",
      address,
      circuitBreaker: { failureRatio: 0 },
    });
    const options = { method_definition: { path: UNARY } } as InterceptorOptions;
    const ok = { code: status.OK, details: "", metadata: new Metadata() };

    for (const listener of [undefined, {}]) {
      const seen: string[] = [];
      let below: Partial<InterceptingListener> = {};
      const next = {
        start: (_metadata: Metadata, given: Partial<InterceptingListener>) => {
          below = given;
          seen.push("start");
        },
        sendMessageWithContext: () => seen.push("sendMessageWithContext"),
        sendMessage: () => seen.push("sendMessage"),
        startRead: () => seen.push("startRead"),
        halfClose: () => seen.push("halfClose"),
        cancelWithStatus: () => seen.push("cancelWithStatus"),
        getPeer: () => "peer",
        getAuthContext: () => null,
      } as unknown as InterceptingCall;
      const policy = new TargetPolicy(config, instruments, {});
      const call = policy.interceptor(options, () => next);

      call.sendMessage({}); // before start there is no call below: dropped
      expect(call.getPeer()).toBe("");
      expect(call.getAuthContext()).toBeNull();
      call.start(new Metadata(), listener);
      call.sendMessageWithContext({}, {});
      call.sendMessage({});
      call.startRead();
      call.halfClose();
      call.cancelWithStatus(status.CANCELLED, "bye");
      expect(call.getPeer()).toBe("peer");
      expect(seen).toEqual([
        "start",
        "sendMessageWithContext",
        "sendMessage",
        "startRead",
        "halfClose",
        "cancelWithStatus",
      ]);
      below.onReceiveMetadata?.(new Metadata());
      below.onReceiveMessage?.({});
      below.onReceiveStatus?.(ok);

      // A call that is never sent ends the same way, on the next tick.
      const spent = new TargetPolicy(config, instruments, { getRemainingMs: () => 0 });
      const unsent = spent.interceptor(options, () => next);
      unsent.start(new Metadata(), listener);
      unsent.startRead();
      unsent.cancelWithStatus(status.CANCELLED, "bye");
      await new Promise((resolve) => process.nextTick(resolve));
      expect(seen).toHaveLength(6);
    }
    instruments.dispose();
  });
});
