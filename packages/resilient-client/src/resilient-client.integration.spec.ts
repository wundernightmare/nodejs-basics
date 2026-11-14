import { createHash, randomBytes } from "node:crypto";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  BLOB_SHA256,
  BLOB_SIZE,
  createPki,
  type HttpStack,
  integration,
  KAFKA_JSON,
  KAFKA_V2,
  meta,
  type Pki,
  type Proxy,
  proxiedPort,
  startHttpStack,
  testCase,
  unique,
} from "@base/testing";

import { OutboundError } from "./resilient-client.errors.js";
import { ResilientClient, type ResilientClientConfig } from "./resilient-client.js";

/**
 * ResilientClient in front of real servers: Caddy as the edge (cleartext,
 * TLS, TLS 1.3 only, a client certificate required, an expired certificate),
 * Redpanda's HTTP API behind it, PostgreSQL at an HTTP address — and
 * Toxiproxy in between for the chaos part.
 *
 * The scenarios are golang-basics' libs/resilient-http-client/integration.
 * This client has two wires where the Go suite has five: HTTP/1.1 in
 * cleartext, and over TLS whatever ALPN agrees on — HTTP/2 with this edge.
 * (No h2c, no HTTP/3; a bulkhead does not exist here.) Where the Node client
 * behaves differently on the same scenario, the test says so and pins what
 * it does.
 */
const infra = integration("postgres", "toxiproxy");

interface Seen {
  proto: string;
  tls: string;
  /** The client's source port: the same port is the same connection. */
  port: string;
}

/** What the edge saw of a request: GET /whoami. */
async function whoami(client: ResilientClient): Promise<Seen> {
  const res = await client.request({ path: "/whoami", method: "GET" });
  const text = await res.body.text();
  // A placeholder the edge had no value for comes back as written: "{http.request.tls.version}".
  const field = (name: string): string =>
    (new RegExp(`${name}=(\\S*)`, "u").exec(text)?.[1] ?? "").replace(/^\{.*\}$/u, "");
  return { proto: field("proto"), tls: field("tls"), port: field("port") };
}

/** The OutboundError a request ends with; fails the test when it succeeds. */
async function failure(pending: Promise<unknown>): Promise<OutboundError> {
  const outcome = await pending.then(
    () => undefined,
    (err: unknown) => err,
  );
  expect(outcome).toBeInstanceOf(OutboundError);
  return outcome as OutboundError;
}

/** The deepest cause's message and code, for a network error. */
function rootCause(err: OutboundError): string {
  let cause: unknown = err.cause;
  const seen: string[] = [];
  while (cause instanceof Error) {
    seen.push(`${(cause as { code?: string }).code ?? ""} ${cause.message}`);
    cause = cause.cause;
  }
  return seen.join(" | ");
}

const elapsed = async <T>(work: () => Promise<T>): Promise<{ value: T; ms: number }> => {
  const started = performance.now();
  const value = await work();
  return { value, ms: performance.now() - started };
};

/** A long poll of an empty topic through the edge: the server holds it for `waitMs`. */
const poll = (into: string, waitMs: number) => ({
  path: `/panda/topics/${into}/partitions/0/records?offset=0&timeout=${waitMs}&max_bytes=1048576`,
  method: "GET" as const,
  headers: { accept: KAFKA_JSON },
});

const produce = (prefix: string, into: string, value: string, key?: string) => ({
  path: `${prefix}/topics/${into}`,
  method: "POST" as const,
  headers: {
    "content-type": KAFKA_JSON,
    accept: KAFKA_V2,
    ...(key === undefined ? {} : { "idempotency-key": key }),
  },
  body: JSON.stringify({ records: [{ value }] }),
});

const digest = (text: string | Buffer): string => createHash("sha256").update(text).digest("hex");

describe.skipIf(infra.skip)(
  "ResilientClient against real servers (integration)",
  { timeout: 60_000 },
  () => {
    meta({
      epic: "nodejs-basics",
      feature: "resilient-client",
      owner: "@team-platform",
      tags: ["http-client", "integration"],
    });

    let pki: Pki;
    let stack: HttpStack;
    const open: ResilientClient[] = [];

    /** The certificates name `localhost`; the suite dials 127.0.0.1 to stay on one address family. */
    const trusting = (): NonNullable<ResilientClientConfig["tls"]> => ({
      ca: pki.caPem,
      servername: "localhost",
    });

    /** A client of `base`: one connection, short retry delays, the suite's CA — then `overrides`. */
    function client(base: string, overrides: ResilientClientConfig = {}): ResilientClient {
      const made = new ResilientClient(base, {
        connections: 1,
        retry: { maxRetries: 2, minTimeout: 5, maxTimeout: 50 },
        circuitBreaker: { volumeThreshold: 100 },
        tls: trusting(),
        ...overrides,
      });
      open.push(made);
      return made;
    }

    const wires = [
      {
        wire: "HTTP/1.1 cleartext",
        base: () => `http://127.0.0.1:${stack.ports.plain}`,
        proto: "HTTP/1.1",
        tls: "",
        multiplexed: false,
      },
      {
        wire: "HTTP/2 over TLS",
        base: () => `https://127.0.0.1:${stack.ports.tls}`,
        proto: "HTTP/2.0",
        tls: "tls1.3",
        multiplexed: true, // concurrent requests share the one connection
      },
    ];

    async function topic(): Promise<string> {
      const name = unique("it");
      await stack.createTopic(name);
      return name;
    }

    beforeAll(async () => {
      pki = createPki();
      stack = await startHttpStack(pki);
    }, 300_000);

    afterAll(async () => {
      await stack?.stop();
    });

    afterEach(async () => {
      await Promise.all(open.splice(0).map((made) => made.close().catch(() => {})));
    });

    // ─── The protocol, on a healthy network ────────────────────────────────────

    describe.each(wires)("protocol — $wire", ({ base, proto, tls, multiplexed }) => {
      it("the server sees the protocol, and the connection is kept between requests", async () => {
        await testCase("NB-1304", "HTTP: the wire is what it claims to be, one connection reused");
        const api = client(base());
        const first = await whoami(api);
        expect(first.proto).toBe(proto); // not a silent fallback to another protocol
        expect(first.tls).toBe(tls);
        for (let i = 0; i < 3; i += 1) expect((await whoami(api)).port).toBe(first.port);
      });

      it("a second request while one is in flight is answered at once: multiplexed, or on a second connection", async () => {
        await testCase("NB-1305", "HTTP: a second request while one is in flight");
        const api = client(base(), { connections: 2 });
        const empty = await topic();
        const first = await whoami(api);

        const started = performance.now();
        const held = api.request(poll(empty, 1000)).then(async (res) => {
          expect(await res.body.text()).toBe("[]");
          return performance.now() - started;
        });
        await new Promise((resolve) => setTimeout(resolve, 250)); // the poll is with the server now
        const during = await whoami(api);

        expect(performance.now() - started).toBeLessThan(900); // answered while the slow one was held
        if (multiplexed) expect(during.port).toBe(first.port); // a second stream on the same connection
        else expect(during.port).not.toBe(first.port); // the kept connection is busy: a second one was opened
        expect(await held).toBeGreaterThanOrEqual(1000); // the server held it for the poll timeout
      });

      it("a megabyte up and four down arrive intact", async () => {
        await testCase("NB-1306", "HTTP: bodies arrive intact");
        const api = client(base());
        const payload = randomBytes(512 << 10).toString("hex"); // 1 MiB of text: the echo route is a template
        const echoed = await api.request({
          path: "/echo",
          method: "POST",
          headers: { "idempotency-key": "integration-1" },
          body: payload,
        });
        expect(echoed.headers["x-echo-method"]).toBe("POST");
        expect(echoed.headers["x-echo-idempotency-key"]).toBe("integration-1");
        expect(digest(await echoed.body.text())).toBe(digest(payload));

        const blob = await api.request({ path: "/files/blob", method: "GET" });
        const bytes = Buffer.from(await blob.body.arrayBuffer());
        expect(bytes.length).toBe(BLOB_SIZE);
        expect(digest(bytes)).toBe(BLOB_SHA256);
      });

      it("a status ≥ 400 is a typed error; the retryable ones are retried as often as configured", async () => {
        await testCase("NB-1307", "HTTP: status errors and retries against a real server");
        // Room for the server's Retry-After of one second.
        const api = client(base(), { retry: { maxRetries: 2, minTimeout: 5, maxTimeout: 2000 } });

        const notFound = await failure(api.request({ path: "/status/404", method: "GET" }));
        expect(notFound).toMatchObject({
          errorType: "client_error",
          statusCode: 404,
          kind: "fatal",
        });
        expect(api.retries).toBe(0); // a 404 is an answer: not retried

        const badGateway = await failure(api.request({ path: "/status/502", method: "GET" }));
        expect(badGateway).toMatchObject({ errorType: "retries_exhausted", statusCode: 502 });
        expect(api.retries).toBe(2); // retried up to maxRetries

        // The server names its own delay; the client waits it out, once per retry.
        const busy = await elapsed(() => failure(api.request({ path: "/busy", method: "GET" })));
        expect(busy.value).toMatchObject({ statusCode: 503, retryAfterMs: 1000 });
        expect(busy.ms).toBeGreaterThanOrEqual(2000); // two retries, a Retry-After before each
        expect(api.retries).toBe(4); // two for the 502, two for /busy
      });

      it("a 501 will not get better: an error, sent once, and a failure for the breaker", async () => {
        await testCase("NB-1308", "HTTP: a final 5xx is an error, not a response");
        const api = client(base(), { circuitBreaker: { volumeThreshold: 1 } });
        const err = await failure(api.request({ path: "/status/501", method: "GET" }));
        expect(err).toMatchObject({ errorType: "server_error", statusCode: 501, kind: "fatal" });
        expect(api.retries).toBe(0);
        expect(api.breakerState).toBe("open");
      });

      it("a server slower than the attempt timeout is cut off at the timeout", async () => {
        await testCase("NB-1309", "HTTP: the attempt timeout on a slow server");
        const api = client(base(), { attemptTimeoutMs: 300, retry: { maxRetries: 0 } });
        const empty = await topic();
        const before = await whoami(api);

        const cut = await elapsed(() => failure(api.request(poll(empty, 1000))));

        expect(cut.value).toMatchObject({ errorType: "timeout", kind: "transient" });
        expect(cut.ms).toBeGreaterThan(250); // at the client's timeout…
        expect(cut.ms).toBeLessThan(600); // …not at the server's pace
        const after = await whoami(api);
        // What happens to the connection is the protocol's business: HTTP/2
        // resets the one stream, HTTP/1.1 has nothing to reset and drops it.
        if (multiplexed) expect(after.port).toBe(before.port);
        else expect(after.port).not.toBe(before.port);
      });

      it("a response the caller never reads does not hold the connection past the attempt timeout", async () => {
        await testCase("NB-1310", "HTTP: a forgotten body gives the connection back");
        const api = client(base(), {
          attemptTimeoutMs: 400,
          circuitBreaker: { volumeThreshold: 1 },
        });

        const forgotten = await api.request({ path: "/files/blob", method: "GET" });
        forgotten.body.on("error", () => {}); // megabytes unread, on purpose

        // One connection, and it is stuck on the unread body until the attempt ends.
        const next = await elapsed(() => whoami(api));
        expect(next.value.proto).toBe(proto);
        expect(next.ms).toBeLessThan(2000);
        expect(api.breakerState).toBe("closed"); // the caller's negligence is not the server's failure
      });

      it("closing a large body after the first kilobyte is the caller's choice, not a failure", async () => {
        await testCase("NB-1311", "HTTP: closing a body early");
        const api = client(base(), { circuitBreaker: { volumeThreshold: 1 } });
        const before = await whoami(api);

        const res = await api.request({ path: "/files/blob", method: "GET" });
        const head = await new Promise<Buffer>((resolve) => {
          res.body.once("data", (chunk: Buffer) => {
            resolve(chunk);
          });
        });
        expect(head.subarray(0, 32).toString()).toBe("0123456789abcdef".repeat(2));
        res.body.on("error", () => {});
        res.body.destroy();

        expect(api.breakerState).toBe("closed"); // with volumeThreshold 1 a failure would have opened it
        const after = await whoami(api);
        // HTTP/2 resets the stream and keeps the connection; over HTTP/1.1
        // megabytes are unread and the connection cannot be reused.
        if (multiplexed) expect(after.port).toBe(before.port);
        else expect(after.port).not.toBe(before.port);
      });

      it("a record produced through the edge is in the broker", async () => {
        await testCase("NB-1312", "HTTP: a real API understood the request");
        const api = client(base(), { attemptTimeoutMs: 30_000 });
        const into = await topic();
        const value = unique("record");

        const res = await api.request(produce("/panda", into, value));
        expect(res.statusCode).toBe(200);
        await res.body.dump();

        await expect.poll(() => stack.stored(into)).toEqual([value]);
      });
    });

    // ─── TLS: real handshakes against the edge ─────────────────────────────────

    describe("TLS", () => {
      it.each([
        {
          name: "issued by an authority the client does not know",
          port: () => stack.ports.tls,
          tls: (): NonNullable<ResilientClientConfig["tls"]> => ({ servername: "localhost" }),
          cause: /SELF_SIGNED|UNABLE_TO_VERIFY|unable to verify|self.signed/iu,
        },
        {
          name: "issued for another name",
          port: () => stack.ports.tls,
          tls: (): NonNullable<ResilientClientConfig["tls"]> => ({ ca: pki.caPem }),
          cause: /ALTNAME|IP: 127\.0\.0\.1 is not in the cert/iu,
        },
        {
          name: "expired",
          port: () => stack.ports.expired,
          tls: (): NonNullable<ResilientClientConfig["tls"]> => ({
            ca: pki.caPem,
            servername: "localhost",
          }),
          cause: /CERT_HAS_EXPIRED|expired/iu,
        },
      ])(
        "a certificate the client must not accept — $name — is refused once and counts against the breaker",
        async ({ port, tls, cause }) => {
          await testCase("NB-1313", "HTTP TLS: a certificate the client rejects");
          const api = client(`https://127.0.0.1:${port()}`, {
            tls: tls(),
            circuitBreaker: { volumeThreshold: 1 },
          });

          const err = await failure(whoami(api));

          expect(err.errorType).toBe("network");
          expect(rootCause(err)).toMatch(cause);
          expect(api.retries).toBe(0); // one handshake: retrying would meet the same certificate
          expect(api.breakerState).toBe("open");
        },
      );

      it("the server refuses a client too old for it: a connection error, not retried", async () => {
        await testCase("NB-1314", "HTTP TLS: TLS 1.2 client, TLS 1.3 server");
        const old = client(`https://127.0.0.1:${stack.ports.tls13}`, {
          tls: { ...trusting(), maxVersion: "TLSv1.2" },
        });

        const err = await failure(whoami(old));

        expect(err.errorType).toBe("network");
        expect(rootCause(err)).toMatch(/protocol version|alert/iu);
        // golang-basics' client retries a TLS alert (it may be the server having a
        // bad moment). This one retries the connection errors it lists by code,
        // and a TLS alert is not among them: one handshake.
        expect(old.retries).toBe(0);

        // The same listener accepts a current client.
        const current = client(`https://127.0.0.1:${stack.ports.tls13}`);
        expect((await whoami(current)).tls).toBe("tls1.3");
      });

      it("the server requires a client certificate: refused without one, served with one", async () => {
        await testCase("NB-1315", "HTTP TLS: a client certificate required");
        const anonymous = client(`https://127.0.0.1:${stack.ports.mtls}`);
        const err = await failure(whoami(anonymous));
        // With TLS 1.3 the server's verdict comes after the client's own
        // handshake is done: the message varies, the kind must not.
        expect(err.errorType).toBe("network");
        expect(anonymous.retries).toBe(0); // see above: a TLS alert is not retried here

        // By name this time: with client certificates on, the edge insists that
        // the Host header and the certificate's name agree (421 otherwise).
        const identified = client(`https://localhost:${stack.ports.mtls}`, {
          tls: { ...trusting(), cert: pki.clientCert, key: pki.clientKey },
        });
        expect((await whoami(identified)).proto).toBe("HTTP/2.0");
      });

      it("the right host, the wrong protocol for the port", async () => {
        await testCase("NB-1316", "HTTP TLS: scheme and port disagree");
        // HTTP to the TLS port: the server answers, in cleartext, that this is
        // the wrong door. An answer is an answer — a 400, and a live dependency.
        const plainToTls = client(`http://127.0.0.1:${stack.ports.tls}`, {
          circuitBreaker: { volumeThreshold: 1 },
        });
        const wrongDoor = await failure(whoami(plainToTls));
        expect(wrongDoor).toMatchObject({ errorType: "client_error", statusCode: 400 });
        expect(plainToTls.breakerState).toBe("closed");

        // HTTPS to the cleartext port: there is no handshake to be had.
        const tlsToPlain = client(`https://127.0.0.1:${stack.ports.plain}`, {
          circuitBreaker: { volumeThreshold: 1 },
        });
        const noHandshake = await failure(whoami(tlsToPlain));
        expect(noHandshake.errorType).toBe("network");
        expect(tlsToPlain.breakerState).toBe("open");
      });

      it("a redirect is returned to the caller, never followed", async () => {
        await testCase("NB-1317", "HTTP: this client does not follow redirects");
        // golang-basics' client follows a same-host redirect and refuses a
        // cross-host or https→http one. This client follows none: where a
        // response sends the caller is the caller's decision.
        const api = client(`https://127.0.0.1:${stack.ports.tls}`);
        const res = await api.request({ path: "/redirect/same", method: "GET" });
        await res.body.dump();
        expect(res.statusCode).toBe(302);
        expect(res.headers["location"]).toBe("/whoami");
      });
    });

    // ─── Peers that are not a well-behaved HTTP server ─────────────────────────

    describe("peers", () => {
      it.each(["http", "https"])(
        "PostgreSQL behind an %s:// URL: a connection error at once, then the breaker",
        async (scheme) => {
          await testCase("NB-1318", "HTTP: a peer that is not an HTTP server");
          const database = new URL(infra.url("postgres"));
          const host = database.hostname === "localhost" ? "127.0.0.1" : database.hostname;
          const api = client(`${scheme}://${host}:${database.port || "5432"}`, {
            attemptTimeoutMs: 2000,
            circuitBreaker: { volumeThreshold: 1 },
          });

          const first = await elapsed(() => failure(api.request({ path: "/", method: "GET" })));

          expect(first.value.errorType).toBe("network");
          expect(first.ms).toBeLessThan(1000); // the database hangs up at once; nothing waits for the timeout
          expect(api.retries).toBe(2); // retried as a connection error
          expect(api.breakerState).toBe("open");

          const second = await failure(api.request({ path: "/", method: "GET" }));
          expect(second.errorType).toBe("circuit_open"); // and then left alone
        },
      );
    });

    // ─── The network: Toxiproxy between the client and the real servers ────────

    describe("chaos", () => {
      let viaTls: Proxy;
      let viaPlain: Proxy;
      let viaApi: Proxy;

      beforeAll(async () => {
        // One at a time: each takes the next free port of the proxy pool.
        viaTls = await proxiedPort("http-edge-tls", stack.ports.tls);
        viaPlain = await proxiedPort("http-edge-plain", stack.ports.plain);
        viaApi = await proxiedPort("http-api", stack.apiPort);
      });

      afterEach(async () => {
        await Promise.all([viaTls.reset(), viaPlain.reset(), viaApi.reset()]);
      });

      afterAll(async () => {
        await Promise.allSettled([viaTls?.close(), viaPlain?.close(), viaApi?.close()]);
      });

      it.each([
        {
          name: "ClientHello goes into a black hole",
          inject: () => viaTls.toxic("timeout", { timeout: 0 }, "upstream"),
          errorType: "timeout",
          within: 900,
        },
        {
          name: "ServerHello never comes back",
          inject: () => viaTls.toxic("timeout", { timeout: 0 }, "downstream"),
          errorType: "timeout",
          within: 900,
        },
        {
          name: "connection reset during the handshake",
          inject: () => viaTls.toxic("reset_peer", { timeout: 0 }, "downstream"),
          errorType: "network",
          within: 400,
        },
        {
          name: "connection cut 200 bytes into the server's flight",
          inject: () => viaTls.toxic("limit_data", { bytes: 200 }, "downstream"),
          errorType: "network",
          within: 400,
        },
      ])(
        "the TLS handshake fails under a live TCP connection — $name",
        async ({ inject, errorType, within }) => {
          await testCase("NB-1319", "HTTP chaos: faults during the TLS handshake");
          const api = client(`https://${viaTls.address}`, {
            attemptTimeoutMs: 500,
            retry: { maxRetries: 0 },
          });
          await inject();

          const broken = await elapsed(() => failure(whoami(api)));

          expect(broken.value.errorType).toBe(errorType);
          expect(broken.value.kind).toBe("transient"); // a broken handshake may succeed next time
          expect(broken.ms).toBeLessThan(within);

          await viaTls.reset();
          // No half-open connection was left in the pool.
          expect((await whoami(api)).tls).toBe("tls1.3");
        },
      );

      it("a handshake delivered in 16-byte pieces is still a handshake", async () => {
        await testCase("NB-1320", "HTTP chaos: a slow, fragmented handshake");
        const api = client(`https://${viaTls.address}`);
        const slices = { average_size: 16, size_variation: 4, delay: 300 };
        await viaTls.toxic("slicer", slices, "downstream");
        await viaTls.toxic("slicer", slices, "upstream");

        expect(await whoami(api)).toMatchObject({ proto: "HTTP/2.0", tls: "tls1.3" });
      });

      it("an outage that ends while the client is still retrying ends in a success", async () => {
        await testCase("NB-1321", "HTTP chaos: an outage heals during the retries");
        const api = client(`https://${viaTls.address}`, {
          retry: { maxRetries: 11, minTimeout: 100, maxTimeout: 300, budget: false },
        });
        await viaTls.down();
        const healed = (async () => {
          while (api.retries < 2) await new Promise((resolve) => setTimeout(resolve, 2));
          await viaTls.up();
        })();

        const seen = await whoami(api);
        await healed;

        expect(seen.proto).toBe("HTTP/2.0");
        expect(api.retries).toBeGreaterThanOrEqual(2);
      });

      it("a body that arrives too slowly runs into the attempt timeout, in the middle of the data", async () => {
        await testCase("NB-1322", "HTTP chaos: a throttled body");
        const api = client(`https://${viaTls.address}`, {
          attemptTimeoutMs: 600,
          retry: { maxRetries: 0 },
        });
        await viaTls.toxic("bandwidth", { rate: 256 }, "downstream"); // KB/s: the blob needs sixteen seconds

        const started = performance.now();
        const res = await api.request({ path: "/files/blob", method: "GET" });
        let received = 0;
        const ended = await new Promise<Error | undefined>((resolve) => {
          res.body.on("data", (chunk: Buffer) => {
            received += chunk.length;
          });
          res.body.on("error", resolve);
          res.body.on("end", () => {
            resolve(undefined);
          });
        });

        expect(ended).toBeInstanceOf(Error); // a truncated body is an error, never a short success
        expect(performance.now() - started).toBeGreaterThan(300);
        expect(performance.now() - started).toBeLessThan(900);
        expect(received).toBeLessThan(BLOB_SIZE);
      });

      it.each([
        {
          name: "HTTP/1.1 cleartext",
          base: () => `http://${viaPlain.address}`,
          proxy: () => viaPlain,
        },
        { name: "HTTP/2 over TLS", base: () => `https://${viaTls.address}`, proxy: () => viaTls },
      ])(
        "idle connections killed behind the client's back ($name): an idempotent request never surfaces it",
        async ({ base, proxy }) => {
          await testCase("NB-1323", "HTTP chaos: idle connections killed");
          const api = client(base()); // the suite's policy: two retries
          const before = await whoami(api);

          await proxy().down(); // closes every connection through the proxy
          await proxy().up();

          // golang-basics' client leans on net/http, which replays a request
          // written to a connection the peer had already closed. undici does
          // not: a request that races the FIN fails with UND_ERR_SOCKET. What
          // covers it here is the retry policy — so it holds for requests that
          // may be sent twice (this GET), and a POST without an
          // Idempotency-Key that loses the race surfaces the error.
          const after = await whoami(api);
          expect(after.port).not.toBe(before.port); // a new connection
          expect(api.retries).toBeLessThanOrEqual(1); // at most the one lost race
        },
      );

      // The request reaches Redpanda and is stored; the acknowledgement never
      // comes back. The client reports a timeout — and what it does next decides
      // how many records the topic ends up with.
      it("a lost acknowledgement: a POST is sent once; with an Idempotency-Key it is retried, and this server stores every attempt", async () => {
        await testCase("NB-1324", "HTTP chaos: a lost acknowledgement");
        const [once, keyed] = [await topic(), await topic()];
        const base = `http://${viaApi.address}`;
        // Warm up through the proxy, with a client that can wait: the broker's
        // first fetch of a new topic can take longer than the short timeout.
        const patient = client(base, { attemptTimeoutMs: 30_000 });
        const empty = await patient.request({
          path: `/topics/${once}/partitions/0/records?offset=0&timeout=0&max_bytes=1048576`,
          method: "GET",
          headers: { accept: KAFKA_JSON },
        });
        expect(await empty.body.text()).toBe("[]");

        const api = client(base, {
          attemptTimeoutMs: 700,
          retry: { maxRetries: 2, minTimeout: 5, maxTimeout: 50 },
        });
        await viaApi.toxic("timeout", { timeout: 0 }, "downstream"); // answers are dropped

        const unkeyed = await failure(api.request(produce("", once, "sent-once")));
        expect(unkeyed.errorType).toBe("timeout");
        expect(api.retries).toBe(0); // a POST without a key is never sent twice

        const withKey = await failure(api.request(produce("", keyed, "with-key", "order-42")));
        expect(withKey.errorType).toBe("timeout");
        expect(api.retries).toBe(2); // only the keyed request was retried

        await viaApi.reset();
        // Ground truth, read from the broker on a direct connection.
        // The write happened although the client saw a timeout.
        await expect.poll(() => stack.stored(once)).toEqual(["sent-once"]);
        // Three attempts, three records: this server does not honour Idempotency-Key.
        // The header is the caller's promise that the server deduplicates.
        await expect.poll(() => stack.stored(keyed)).toEqual(["with-key", "with-key", "with-key"]);
      });
    });
  },
);
