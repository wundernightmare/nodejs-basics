import { createSecureContext } from "node:tls";

import {
  type CallOptions,
  connectivityState,
  type ChannelCredentials,
  Client,
  type ClientReadableStream,
  credentials,
  Metadata,
  type ServiceError,
  status,
} from "@grpc/grpc-js";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  captureMetrics,
  countSpans,
  createPki,
  EXPORT_METHOD,
  exportRequest,
  FIND_TRACES_METHOD,
  findTracesRequest,
  type GrpcServer,
  type HttpGateway,
  integration,
  meta,
  type MetricsCapture,
  metricValue,
  type Pki,
  type Proxy,
  proxiedPort,
  startGrpcServer,
  startHttpGateway,
  testCase,
  unique,
} from "@base/testing";

import { GrpcClients, type GrpcClientsOptions } from "./grpc-clients.js";
import type { GrpcTargetConfig } from "./grpc-config.js";
import { type BreakerState, isCircuitOpen } from "./grpc-policy.js";

/**
 * GrpcClients in front of real servers: Jaeger's OTLP receiver (a unary
 * call) and query API (a server stream) over every transport the wiring can
 * be configured for, an HTTP gateway answering instead of the service, a
 * database at a gRPC address — and, in the chaos part, Toxiproxy in between.
 *
 * The scenarios are golang-basics' libs/grpcx/integration, one for one. Where
 * grpc-js behaves differently from grpc-go, the test says so and pins what
 * the Node client does.
 */
const infra = integration("postgres", "toxiproxy");

/** The one target every test client declares. */
const API = "api";

const pass = (buffer: Buffer): Buffer => buffer;

interface Answer {
  err: ServiceError | null;
  code: status;
  /** How long the caller waited, ms. */
  took: number;
}

/** A unary call of `path` with a raw message. */
function unary(
  client: Client,
  path: string,
  body: Buffer,
  options: CallOptions = {},
): Promise<Answer> {
  const started = performance.now();
  return new Promise((resolve) => {
    client.makeUnaryRequest(path, pass, pass, body, new Metadata(), options, (err) => {
      resolve({ err, code: err?.code ?? status.OK, took: performance.now() - started });
    });
  });
}

/** Sends `spans` small spans of a fresh trace under `service`. */
function send(
  client: Client,
  spans: number,
  service: string,
  options?: CallOptions,
): Promise<Answer> {
  return unary(client, EXPORT_METHOD, exportRequest({ service, spans }), options);
}

/** Opens FindTraces for every trace of `service`: one message per trace. */
function findTraces(
  client: Client,
  service: string,
  options: CallOptions = {},
): ClientReadableStream<Buffer> {
  return client.makeServerStreamRequest(
    FIND_TRACES_METHOD,
    pass,
    pass,
    findTracesRequest(service),
    new Metadata(),
    options,
  );
}

interface Drained {
  messages: number;
  spans: number;
  /** The status the stream ended with; OK when the server finished it. */
  code: status;
  err: ServiceError | undefined;
}

/** Reads a stream to its end, `pauseMs` after each message. */
async function drain(
  stream: ClientReadableStream<Buffer>,
  pauseMs = 0,
  onMessage?: () => Promise<void>,
): Promise<Drained> {
  const result: Drained = { messages: 0, spans: 0, code: status.OK, err: undefined };
  try {
    for await (const message of stream) {
      result.messages += 1;
      result.spans += countSpans(message as Buffer);
      await onMessage?.();
      if (pauseMs > 0) await new Promise((resolve) => setTimeout(resolve, pauseMs));
    }
  } catch (err) {
    result.err = err as ServiceError;
    result.code = result.err.code;
  }
  return result;
}

const at = (port: number): string => `127.0.0.1:${port}`;

const breaker = (grpc: GrpcClients): BreakerState | undefined => grpc.circuitBreakerStates()[API];

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Retries a call until it succeeds: after a failed connection gRPC waits
 * out a reconnect backoff (a second at first) before it dials again, and
 * a call made in that window fails at once.
 */
async function eventually(call: () => Promise<Answer>): Promise<void> {
  await expect
    .poll(async () => (await call()).code, { timeout: 15_000, interval: 100 })
    .toBe(status.OK);
}

describe.skipIf(infra.skip)(
  "GrpcClients against real servers (integration)",
  { timeout: 60_000 },
  () => {
    meta({
      epic: "nodejs-basics",
      feature: "grpc-client",
      owner: "@team-platform",
      tags: ["grpc", "integration"],
    });

    let pki: Pki;
    let server: GrpcServer;
    let gateway: HttpGateway;
    let capture: MetricsCapture;
    const open: GrpcClients[] = [];

    /** TLS credentials over the suite's CA — the suite's stand-in for "the system roots". */
    const trusting = (): ChannelCredentials => credentials.createSsl(pki.caPem);
    /** The certificates name `localhost`; the suite dials 127.0.0.1 to stay on one address family. */
    const asLocalhost = { "grpc.ssl_target_name_override": "localhost" };

    /**
     * A client over one target: the defaults with short retry delays, then
     * `target`. TLS stays on unless the target says `insecure`.
     */
    function dial(
      target: Omit<GrpcTargetConfig, "name">,
      options: GrpcClientsOptions = {},
    ): { grpc: GrpcClients; client: Client } {
      const grpc = new GrpcClients(
        [
          {
            name: API,
            ...target,
            retry: { baseDelayMs: 10, maxDelayMs: 50, ...target.retry },
          },
        ],
        { credentials: trusting(), channelOptions: asLocalhost, ...options },
      );
      open.push(grpc);
      return { grpc, client: grpc.client(API, Client) };
    }
    /** A breaker that one failure opens. */
    const touchy = { circuitBreaker: { minRequests: 1 } };
    const noRetries = { retry: { maxAttempts: 1 } };

    async function metric(name: string, labels: Record<string, string> = {}): Promise<number> {
      // An absent series is zero.
      return Math.max(metricValue(await capture.scrape(), name, { target: API, ...labels }), 0);
    }
    const calls = (outcome: string): Promise<number> =>
      metric("grpc_client_requests_total", { outcome });
    const retries = (): Promise<number> => metric("grpc_client_retries_total");

    /** Stores `traces` traces of `spansEach` fat spans under a service of its own. */
    async function seed(traces: number, spansEach: number): Promise<string> {
      const { client } = dial({ address: at(server.ports.plain), insecure: true });
      const service = unique("svc");
      for (let i = 0; i < traces; i += 1) {
        const answer = await unary(
          client,
          EXPORT_METHOD,
          exportRequest({ service, spans: spansEach, pad: 200 }),
        );
        expect(answer.err).toBeNull();
      }
      return service;
    }

    beforeAll(async () => {
      pki = createPki();
      [server, gateway] = await Promise.all([startGrpcServer(pki), startHttpGateway(pki)]);
    }, 240_000);

    afterAll(async () => {
      await Promise.allSettled([server?.stop(), gateway?.stop()]);
    });

    beforeEach(() => {
      capture = captureMetrics();
    });

    afterEach(async () => {
      for (const grpc of open.splice(0)) grpc.close();
      await capture.stop();
    });

    // ─── The protocol, on a healthy network ────────────────────────────────────

    describe("protocol", () => {
      it.each([
        { name: "cleartext", port: () => server.ports.plain, target: { insecure: true } },
        { name: "TLS", port: () => server.ports.tls, target: {} },
        { name: "TLS 1.3 only server", port: () => server.ports.tls13, target: {} },
        {
          name: "mutual TLS",
          port: () => server.ports.mtls,
          target: {},
          creds: () => credentials.createSsl(pki.caPem, pki.clientKey, pki.clientCert),
        },
      ])("a unary call arrives over $name", async ({ port, target, creds }) => {
        await testCase("NB-1277", "gRPC: a unary call arrives over every transport");
        const { client } = dial(
          { address: at(port()), ...target },
          creds === undefined ? {} : { credentials: creds() },
        );
        const service = unique("transport");

        expect((await send(client, 7, service)).err).toBeNull();
        expect((await send(client, 5, service)).err).toBeNull();

        await expect.poll(() => server.stored(service)).toBe(12); // the server has both batches
        expect(await calls("ok")).toBe(2);
        expect(await retries()).toBe(0);
      });

      it("what the server says about a request is an answer: nothing is retried, the breaker stays closed", async () => {
        await testCase("NB-1278", "gRPC: the server's verdict is not a failure of the dependency");
        const { grpc, client } = dial({
          address: at(server.ports.plain),
          insecure: true,
          ...touchy,
        });

        // Eight megabytes against the server's four-megabyte limit.
        const tooBig = await unary(
          client,
          EXPORT_METHOD,
          exportRequest({ service: "too-big", spans: 30_000, pad: 200 }),
        );
        expect(tooBig.code).toBe(status.RESOURCE_EXHAUSTED);
        expect(tooBig.err?.details).toContain("larger than max");

        // A method this server does not have.
        const nothing = await unary(client, "/integration.Nothing/Here", Buffer.alloc(0));
        expect(nothing.code).toBe(status.UNIMPLEMENTED);

        expect(breaker(grpc)).toBe("closed"); // with minRequests 1 a single failure would have opened it
        expect(await retries()).toBe(0);
        expect(await calls("resource_exhausted")).toBe(1);
        expect(await calls("unimplemented")).toBe(1);
      });

      it("a server stream: every message arrives, and the stream is one call — counted when it ends", async () => {
        await testCase("NB-1279", "gRPC: a server stream is one call");
        const traces = 100;
        const each = 20;
        const service = await seed(traces, each);
        const { client } = dial({ address: at(server.ports.query), insecure: true });
        const method = { method: FIND_TRACES_METHOD };

        let countedMidStream = 0;
        const read = await drain(findTraces(client, service), 0, async () => {
          countedMidStream += await metric("grpc_client_requests_total", method);
        });

        expect(read.err).toBeUndefined();
        expect(read.messages).toBe(traces); // one message per trace
        expect(read.spans).toBe(traces * each);
        expect(countedMidStream).toBe(0); // not counted while it is still running
        expect(await metric("grpc_client_requests_total", { ...method, outcome: "ok" })).toBe(1);
      });

      it("the target's timeout covers the whole stream: a slow reader loses it mid-way", async () => {
        await testCase("NB-1280", "gRPC: the default deadline is the stream's, not a message's");
        const service = await seed(60, 20);
        const { grpc, client } = dial({
          address: at(server.ports.query),
          insecure: true,
          timeoutMs: 400,
          ...touchy,
        });

        // Sixty messages at this pace need three seconds.
        const read = await drain(findTraces(client, service), 50);

        expect(read.code).toBe(status.DEADLINE_EXCEEDED);
        expect(read.messages).toBeGreaterThan(0);
        expect(read.messages).toBeLessThan(60);
        expect(breaker(grpc)).toBe("open");
      });

      it("timeout 0 lets a stream take its time", async () => {
        await testCase("NB-1281", "gRPC: timeoutMs 0 leaves a stream open");
        const service = await seed(60, 20);
        const { client } = dial({ address: at(server.ports.query), insecure: true, timeoutMs: 0 });

        const read = await drain(findTraces(client, service), 10);

        expect(read.err).toBeUndefined();
        expect(read.messages).toBe(60);
      });

      it("the caller walks away from a stream: counted as canceled, ignored by the breaker, the connection lives", async () => {
        await testCase("NB-1282", "gRPC: a caller's cancel says nothing about the server");
        const service = await seed(100, 20);
        const { grpc, client } = dial({
          address: at(server.ports.query),
          insecure: true,
          ...touchy,
        });

        const stream = findTraces(client, service);
        stream.on("error", () => {}); // the cancel surfaces as an error event
        let seen = 0;
        await new Promise<void>((resolve) => {
          stream.on("data", () => {
            seen += 1;
            if (seen === 3) {
              stream.cancel();
              resolve();
            }
          });
        });

        await expect.poll(() => calls("canceled")).toBe(1);
        expect(breaker(grpc)).toBe("closed");

        // The same connection serves a new stream.
        const again = await drain(findTraces(client, service));
        expect(again.err).toBeUndefined();
        expect(again.messages).toBe(100);
      });
    });

    // ─── TLS: a real server's certificates and a real server's refusals ────────

    describe("TLS", () => {
      it.each([
        {
          name: "server certificate from an unknown authority",
          port: () => server.ports.tls,
          cause: /self.signed|unable to verify|unknown/iu,
          options: (): GrpcClientsOptions => ({ credentials: credentials.createSsl() }),
        },
        {
          name: "server certificate for another name",
          port: () => server.ports.tls,
          cause: /IP: 127\.0\.0\.1 is not in the cert|altnames|Hostname/iu,
          options: (): GrpcClientsOptions => ({ channelOptions: {} }),
        },
        {
          name: "server certificate expired",
          port: () => server.ports.expired,
          cause: /expired/iu,
          options: (): GrpcClientsOptions => ({}),
        },
        {
          name: "client too old for the server",
          port: () => server.ports.tls13,
          cause: /protocol version|alert/iu,
          options: (): GrpcClientsOptions => ({
            credentials: credentials.createFromSecureContext(
              createSecureContext({ ca: pki.caPem, maxVersion: "TLSv1.2" }),
            ),
          }),
        },
        {
          name: "client certificate required",
          port: () => server.ports.mtls,
          cause: /certificate required|alert|ECONNRESET|closed/iu,
          options: (): GrpcClientsOptions => ({}),
        },
        {
          name: "TLS to the cleartext port",
          port: () => server.ports.plain,
          cause: /wrong version number|packet length|ssl|tls/iu,
          options: (): GrpcClientsOptions => ({}),
        },
      ])(
        "a handshake that cannot succeed — $name — fails the call promptly and opens the breaker",
        async ({ port, cause, options }) => {
          await testCase("NB-1283", "gRPC: a TLS handshake that cannot succeed");
          const { grpc, client } = dial({ address: at(port()), ...touchy }, options());
          const service = unique("refused");

          const answer = await send(client, 3, service);

          expect(answer.code).toBe(status.UNAVAILABLE);
          expect(answer.err?.details).toMatch(cause); // the cause is in the message
          expect(answer.took).toBeLessThan(3000); // refused at the handshake, not at the deadline
          expect(breaker(grpc)).toBe("open");
          expect(await calls("unavailable")).toBe(1); // one call, however many attempts gRPC made below
          expect(await server.stored(service)).toBe(0); // no request reached the server
        },
      );

      it("cleartext to a TLS port: no silent downgrade", async () => {
        await testCase("NB-1284", "gRPC: cleartext to the TLS port fails, fast");
        const { grpc, client } = dial({ address: at(server.ports.tls), insecure: true, ...touchy });

        const answer = await send(client, 3, "tls");

        expect(answer.code).toBe(status.UNAVAILABLE);
        expect(answer.took).toBeLessThan(3000);
        expect(breaker(grpc)).toBe("open");
      });

      it("waitForReady on a handshake that can never succeed ends at the deadline", async () => {
        await testCase("NB-1285", "gRPC: waitForReady needs a deadline");
        const { grpc, client } = dial({
          address: at(server.ports.expired),
          timeoutMs: 700,
          waitForReady: true,
          ...touchy,
        });

        const answer = await send(client, 3, "tls");

        expect(answer.code).toBe(status.DEADLINE_EXCEEDED);
        expect(answer.took).toBeGreaterThan(300); // it waited for the target's timeout…
        expect(answer.took).toBeLessThan(1100); // …no longer
        // Unlike grpc-go, the message does not carry the last connection error:
        // "Deadline exceeded after 0.700s, wait_for_ready" is all the caller gets.
        // The cause is in the channel's own log, not in the status.
        expect(answer.err?.details).toMatch(/deadline exceeded/iu);
        expect(answer.err?.details).not.toMatch(/expired/iu);
        expect(breaker(grpc)).toBe("open");
      });
    });

    // ─── Peers that are not the gRPC service the call was meant for ────────────

    describe("peers", () => {
      const answers = [
        // Unlike grpc-go, grpc-js does not retry these: the HTTP response headers
        // have arrived, and to gRPC's retry logic received headers commit the call.
        // A gateway's 503 while the service restarts reaches the caller at once.
        { service: "http503", code: status.UNAVAILABLE, retried: false, failure: true },
        { service: "http502", code: status.UNAVAILABLE, retried: false, failure: true },
        { service: "http504", code: status.UNAVAILABLE, retried: false, failure: true },
        { service: "http429", code: status.UNAVAILABLE, retried: false, failure: true },
        { service: "http401", code: status.UNAUTHENTICATED, retried: false, failure: false },
        { service: "http403", code: status.PERMISSION_DENIED, retried: false, failure: false },
        { service: "http404", code: status.UNIMPLEMENTED, retried: false, failure: false },
        { service: "html200", code: status.UNKNOWN, retried: false, failure: true },
      ];
      const wires = [
        { wire: "h2c", port: () => gateway.ports.plain, target: { insecure: true } },
        { wire: "HTTP/2 over TLS", port: () => gateway.ports.tls, target: {} },
      ];

      it.each(wires.flatMap((wire) => answers.map((answer) => Object.assign({}, wire, answer))))(
        "an HTTP gateway answers $service over $wire",
        async ({ port, target, service, code, retried, failure }) => {
          await testCase("NB-1286", "gRPC: an HTTP answer to a gRPC call");
          const { grpc, client } = dial({ address: at(port()), ...target, ...touchy });

          const answer = await unary(client, `/${service}.Gateway/Call`, Buffer.alloc(0));

          expect(answer.code).toBe(code);
          expect(await retries()).toBe(retried ? 2 : 0); // maxAttempts 3: two retries
          expect(breaker(grpc)).toBe(failure ? "open" : "closed");
        },
      );

      it.each([
        { name: "cleartext", target: { insecure: true } },
        { name: "TLS", target: {} },
      ])(
        "PostgreSQL at a gRPC address ($name): unavailable at once, then the breaker answers",
        async ({ target }) => {
          await testCase("NB-1287", "gRPC: a peer that is not a gRPC server");
          const database = new URL(infra.url("postgres"));
          const host = database.hostname === "localhost" ? "127.0.0.1" : database.hostname;
          const { grpc, client } = dial({
            address: `${host}:${database.port || "5432"}`,
            ...target,
            ...touchy,
          });

          const first = await send(client, 1, "postgres");
          expect(first.code).toBe(status.UNAVAILABLE);
          expect(first.took).toBeLessThan(3000);
          expect(breaker(grpc)).toBe("open");

          const second = await send(client, 1, "postgres");
          expect(isCircuitOpen(second.err)).toBe(true);
        },
      );
    });

    // ─── The network: Toxiproxy between the client and the real server ─────────
    //
    // gRPC keeps one long-lived connection and reconnects on its own schedule,
    // so what a fault costs depends on when it hits and on waitForReady.

    describe("chaos", () => {
      let plain: Proxy;
      let tls: Proxy;
      let query: Proxy;
      let counted: Proxy;

      beforeAll(async () => {
        // One at a time: each takes the next free port of the proxy pool.
        plain = await proxiedPort("grpc-otlp-plain", server.ports.plain);
        tls = await proxiedPort("grpc-otlp-tls", server.ports.tls);
        query = await proxiedPort("grpc-query", server.ports.query);
        counted = await proxiedPort("grpc-otlp-counted", server.ports.counted);
      });

      afterEach(async () => {
        await Promise.all([plain.reset(), tls.reset(), query.reset(), counted.reset()]);
      });

      afterAll(async () => {
        await Promise.allSettled([plain?.close(), tls?.close(), query?.close(), counted?.close()]);
      });

      /** One call on a connection that has gone silent: packets dropped, no FIN. */
      const onASilentConnection = async (target: Partial<GrpcTargetConfig>): Promise<Answer> => {
        const { client } = dial({
          address: plain.address,
          insecure: true,
          ...noRetries,
          ...target,
        });
        expect((await send(client, 1, "keepalive")).err).toBeNull();
        await plain.toxic("timeout", { timeout: 0 }, "downstream");
        await plain.toxic("timeout", { timeout: 0 }, "upstream");
        try {
          return await send(client, 1, "keepalive");
        } finally {
          await plain.reset();
        }
      };

      it.each([
        {
          name: "ClientHello goes into a black hole",
          inject: () => tls.toxic("timeout", { timeout: 0 }, "upstream"),
          code: status.DEADLINE_EXCEEDED,
          within: 1500,
        },
        {
          name: "ServerHello never comes back",
          inject: () => tls.toxic("timeout", { timeout: 0 }, "downstream"),
          code: status.DEADLINE_EXCEEDED,
          within: 1500,
        },
        {
          name: "connection reset during the handshake",
          inject: () => tls.toxic("reset_peer", { timeout: 0 }, "downstream"),
          code: status.UNAVAILABLE,
          within: 1000,
        },
        {
          name: "connection cut 200 bytes into the server's flight",
          inject: () => tls.toxic("limit_data", { bytes: 200 }, "downstream"),
          code: status.UNAVAILABLE,
          within: 1000,
        },
      ])(
        "the TLS handshake fails under a live TCP connection — $name",
        async ({ inject, code, within }) => {
          await testCase("NB-1290", "gRPC chaos: faults during the TLS handshake");
          const { grpc, client } = dial({
            address: tls.address,
            timeoutMs: 700,
            ...noRetries,
            ...touchy,
          });
          const service = unique("handshake");
          await inject();

          const answer = await send(client, 2, service);

          expect(answer.code).toBe(code);
          expect(answer.took).toBeLessThan(within);
          expect(breaker(grpc)).toBe("open"); // either way the dependency did not answer
          expect(await server.stored(service)).toBe(0);

          await tls.reset();
          // A second client, so the breaker of the first (now open) is not in the way.
          const healthy = dial({ address: tls.address, ...noRetries });
          await eventually(() => send(healthy.client, 2, service));
          await expect.poll(() => server.stored(service)).toBe(2);
        },
      );

      it("an outage opens the breaker, an open breaker answers without the network, a probe closes it", async () => {
        await testCase("NB-1291", "gRPC chaos: outage → open → probe → closed");
        const { grpc, client } = dial({
          address: plain.address,
          insecure: true,
          ...noRetries,
          circuitBreaker: { minRequests: 4, openTimeoutMs: 500 },
        });
        expect((await send(client, 1, "breaker")).err).toBeNull();

        await plain.down();
        for (let i = 0; i < 10 && breaker(grpc) !== "open"; i += 1) {
          expect((await send(client, 1, "breaker")).code).toBe(status.UNAVAILABLE);
        }
        expect(breaker(grpc)).toBe("open");
        const reached = await calls("unavailable");

        const started = performance.now();
        for (let i = 0; i < 50; i += 1) {
          const rejected = await send(client, 1, "breaker");
          expect(isCircuitOpen(rejected.err)).toBe(true);
          expect(rejected.code).toBe(status.UNAVAILABLE); // to code that only looks at the status
        }
        expect(performance.now() - started).toBeLessThan(250); // fifty rejections, no network round trip
        expect(await calls("unavailable")).toBe(reached); // rejections have their own outcome
        expect(await calls("circuit_open")).toBe(50);

        await plain.up();
        // After openTimeoutMs, and gRPC's reconnect, a probe goes through.
        await eventually(() => send(client, 1, "breaker"));
        expect(breaker(grpc)).toBe("closed");
      });

      it("a short outage: retries alone are spent before the channel reconnects", async () => {
        await testCase("NB-1292", "gRPC chaos: retries do not bridge a reconnect");
        const { client } = dial({
          address: plain.address,
          insecure: true,
          timeoutMs: 10_000,
          retry: { maxAttempts: 5 },
        });
        expect((await send(client, 1, "outage")).err).toBeNull(); // connected

        await plain.down();
        const back = sleep(700).then(() => plain.up());
        const answer = await send(client, 1, "outage");
        await back;

        expect(answer.code).toBe(status.UNAVAILABLE);
        expect(answer.took).toBeLessThan(700); // it gave up while the server was still away
        expect(await retries()).toBeGreaterThanOrEqual(1); // it did retry — into a channel not dialling yet
      });

      it("a short outage: with waitForReady the call waits for the connection and succeeds", async () => {
        await testCase("NB-1293", "gRPC chaos: waitForReady bridges a reconnect");
        const { client } = dial({
          address: plain.address,
          insecure: true,
          timeoutMs: 10_000,
          waitForReady: true,
        });
        expect((await send(client, 1, "outage")).err).toBeNull();

        await plain.down();
        // The scenario is a call made while the connection is known to be down.
        // One written to the connection in the instant it dies is another:
        // it fails with "Connection dropped", wait-for-ready or not.
        await expect
          .poll(() => client.getChannel().getConnectivityState(false), {
            timeout: 5000,
            interval: 5,
          })
          .not.toBe(connectivityState.READY);
        const back = sleep(700).then(() => plain.up());
        const answer = await send(client, 1, "outage");
        await back;

        expect(answer.err).toBeNull();
        expect(answer.took).toBeGreaterThanOrEqual(600); // held until the connection came back
      });

      it("latency against the deadline: slow under it, DEADLINE_EXCEEDED over it, the caller's shorter deadline wins", async () => {
        await testCase("NB-1294", "gRPC chaos: latency against the target's timeout");
        const patient = dial({
          address: plain.address,
          insecure: true,
          timeoutMs: 5000,
          ...noRetries,
        });
        const hasty = dial({
          address: plain.address,
          insecure: true,
          timeoutMs: 250,
          ...noRetries,
        });
        // Both connected before the path slows down.
        expect((await send(patient.client, 1, "latency")).err).toBeNull();
        expect((await send(hasty.client, 1, "latency")).err).toBeNull();

        await plain.latency(600);

        const slow = await send(patient.client, 1, "latency");
        expect(slow.err).toBeNull();
        expect(slow.took).toBeGreaterThanOrEqual(590);

        const late = await send(hasty.client, 1, "latency");
        expect(late.code).toBe(status.DEADLINE_EXCEEDED);
        expect(late.took).toBeGreaterThan(200); // at the target's timeout
        expect(late.took).toBeLessThan(450);

        const own = await send(patient.client, 1, "latency", { deadline: Date.now() + 150 });
        expect(own.code).toBe(status.DEADLINE_EXCEEDED);
        expect(own.took).toBeLessThan(500); // not the target's five seconds
      });

      it("a server stream cut half-way is an error, counted by the breaker and never replayed", async () => {
        await testCase("NB-1295", "gRPC chaos: a truncated stream is never a short success");
        const service = await seed(150, 60); // a couple of megabytes over 150 messages
        // One success (the warm-up) and one failure are exactly half. This breaker
        // opens when MORE than failureRatio failed; golang-basics' opens when the
        // ratio is REACHED — the default 0.5 would open there and not here.
        const { grpc, client } = dial({
          address: query.address,
          insecure: true,
          circuitBreaker: { minRequests: 1, failureRatio: 0.4 },
        });
        // Connected, then the cut: the connection ends after another 600 kB.
        expect((await drain(findTraces(client, unique("nothing")))).err).toBeUndefined();
        await query.toxic("limit_data", { bytes: 600 << 10 }, "downstream");

        const read = await drain(findTraces(client, service));

        expect(read.code).toBe(status.UNAVAILABLE);
        expect(read.messages).toBeLessThan(150);
        expect(breaker(grpc)).toBe("open");
        expect(await retries()).toBe(0); // a stream that delivered messages is not replayed
        expect(
          await metric("grpc_client_requests_total", {
            method: FIND_TRACES_METHOD,
            outcome: "unavailable",
          }),
        ).toBe(1);
      });

      it("a stream that arrives too slowly ends at the target's timeout, in the middle of the data", async () => {
        await testCase("NB-1296", "gRPC chaos: a throttled stream runs into the deadline");
        const service = await seed(150, 60);
        const { client } = dial({ address: query.address, insecure: true, timeoutMs: 700 });
        await query.toxic("bandwidth", { rate: 256 }, "downstream"); // KB/s: the stream needs ten seconds

        const started = performance.now();
        const read = await drain(findTraces(client, service));

        expect(read.code).toBe(status.DEADLINE_EXCEEDED);
        expect(performance.now() - started).toBeGreaterThan(300);
        expect(performance.now() - started).toBeLessThan(1100);
        expect(read.messages).toBeLessThan(150);
      });

      it("an idle connection is killed: with waitForReady the next call never sees it", async () => {
        await testCase("NB-1297", "gRPC chaos: a connection killed while idle");
        const { client } = dial({
          address: plain.address,
          insecure: true,
          waitForReady: true,
          ...noRetries,
        });
        expect((await send(client, 1, "idle")).err).toBeNull();

        await plain.down(); // closes the connection
        await plain.up();
        await expect
          .poll(() => client.getChannel().getConnectivityState(false), {
            timeout: 5000,
            interval: 10,
          })
          .not.toBe(connectivityState.READY); // the channel noticed its connection is gone

        // One call, no retries: the caller never saw the dead connection.
        expect((await send(client, 1, "idle")).err).toBeNull();
        expect(await calls("unavailable")).toBe(0);
        expect(await calls("ok")).toBe(2);
      });

      it("a connection that went silent holds a call until its deadline; keepalive fails it in ping time", async () => {
        await testCase("NB-1298", "gRPC chaos: keepalive detects a silent connection");

        // Nothing tells gRPC the peer is gone.
        const held = await onASilentConnection({ timeoutMs: 3000 });
        expect(held.code).toBe(status.DEADLINE_EXCEEDED);
        expect(held.took).toBeGreaterThanOrEqual(2900);

        // keepalive.timeMs cannot be under ten seconds, so this takes that long.
        const pinged = await onASilentConnection({
          timeoutMs: 60_000,
          keepalive: { timeMs: 10_000, timeoutMs: 1000 },
        });
        expect(pinged.code).toBe(status.UNAVAILABLE);
        expect(pinged.took).toBeGreaterThan(9000);
        expect(pinged.took).toBeLessThan(20_000); // eleven seconds or so, not the sixty of the deadline
      });

      it.each(["round_robin", "pick_first"] as const)(
        "two addresses, one of them dead: %s sends every call to the live one",
        async (loadBalancing) => {
          await testCase("NB-1299", "gRPC chaos: load balancing with a dead address");
          const { client } = dial({
            address: `ipv4:${plain.address},${at(server.ports.plain)}`,
            insecure: true,
            loadBalancing,
            ...noRetries,
          });
          const service = unique("lb");
          // Both alive.
          for (let i = 0; i < 6; i += 1) expect((await send(client, 1, service)).err).toBeNull();

          await plain.down();
          // Calls in the first moments may still be on their way to the address
          // that just died; after that, none may fail.
          await eventually(() => send(client, 1, service));
          const failedBefore = await calls("unavailable");
          for (let i = 0; i < 20; i += 1) expect((await send(client, 1, service)).err).toBeNull();

          expect(await calls("unavailable")).toBe(failedBefore); // twenty calls, none to the dead address
          await expect.poll(() => server.stored(service)).toBeGreaterThanOrEqual(27);
        },
      );

      it("every address dead: the answer is immediate, and it is the network's, not the breaker's", async () => {
        await testCase("NB-1300", "gRPC chaos: nowhere to go");
        const { client } = dial({ address: plain.address, insecure: true, ...noRetries });
        await plain.down();

        const answer = await send(client, 1, "nowhere");

        expect(answer.code).toBe(status.UNAVAILABLE);
        expect(answer.took).toBeLessThan(1000);
        expect(isCircuitOpen(answer.err)).toBe(false);
      });

      // The request reaches the server and is stored; the connection dies before
      // the answer comes back. What the caller sees, and how many times the
      // request reaches the server, depends on the retry policy.
      describe("a lost acknowledgement", () => {
        const BATCH = 11;

        /** Sends one batch and kills the connection once the server has stored it, before any answer. */
        async function lose(target: Partial<GrpcTargetConfig>): Promise<{
          answer: Answer;
          arrivals: number;
          kept: number;
          retried: number;
        }> {
          const { client } = dial({
            address: counted.address,
            insecure: true,
            timeoutMs: 10_000,
            ...target,
          });
          const service = unique("lost-ack");
          // The connection is up before the fault: one whose first server frame
          // is lost never becomes ready, and nothing is sent.
          expect((await send(client, 1, unique("warm-up"))).err).toBeNull();
          const before = await server.arrived();

          await counted.toxic("timeout", { timeout: 0 }, "downstream"); // from here, answers are held back
          const pending = send(client, BATCH, service);
          await expect.poll(() => server.stored(service), { timeout: 10_000 }).toBe(BATCH); // the server has it
          // Close every connection while the answer is still held back — lifting
          // the toxic first would let it through — then restore the path.
          await counted.down();
          await counted.reset();

          const answer = await pending;
          return {
            answer,
            arrivals: (await server.arrived()) - before,
            kept: await server.stored(service),
            retried: await retries(),
          };
        }

        it("no retries: the caller gets an error for a write that happened", async () => {
          await testCase("NB-1301", "gRPC chaos: a lost acknowledgement without retries");
          const got = await lose(noRetries);
          expect(got.answer.code).toBe(status.UNAVAILABLE);
          expect(got.arrivals).toBe(BATCH);
          expect(got.kept).toBe(BATCH); // the caller was told it failed; the server has it
        });

        it("default retries: the caller gets OK, and the server received the write twice", async () => {
          await testCase("NB-1302", "gRPC chaos: a retry is a second delivery");
          const got = await lose({
            retry: { maxAttempts: 5, baseDelayMs: 300, maxDelayMs: 2000 },
          });
          expect(got.answer.err).toBeNull();
          expect(got.retried).toBeGreaterThanOrEqual(1);
          expect(got.arrivals).toBe(2 * BATCH); // gRPC cannot know that Export is not idempotent
          expect(got.kept).toBe(BATCH); // harmless here only because this server folds identical spans
        });

        it("retry.methods naming other methods only: this one is not retried", async () => {
          await testCase("NB-1303", "gRPC chaos: retry.methods limits what is replayed");
          const got = await lose({
            retry: { maxAttempts: 5, methods: ["jaeger.api_v3.QueryService"] },
          });
          expect(got.answer.code).toBe(status.UNAVAILABLE);
          expect(got.retried).toBe(0);
          expect(got.arrivals).toBe(BATCH);
        });
      });
    });
  },
);
