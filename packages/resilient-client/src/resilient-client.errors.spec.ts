import { describe, expect, it } from "vitest";

import { OutboundError, PostbackError } from "./resilient-client.errors.js";

describe("OutboundError", () => {
  it("has name OutboundError", () => {
    const err = new OutboundError("transient", "network", "msg");
    expect(err.name).toBe("OutboundError");
    expect(err).toBeInstanceOf(Error);
  });

  describe("factory methods", () => {
    it("circuitOpen — transient, includes target", () => {
      const err = OutboundError.circuitOpen("svc");
      expect(err.kind).toBe("transient");
      expect(err.errorType).toBe("circuit_open");
      expect(err.target).toBe("svc");
      expect(err.message).toContain("svc");
    });

    it("rateLimited — transient", () => {
      const err = OutboundError.rateLimited("svc");
      expect(err.kind).toBe("transient");
      expect(err.errorType).toBe("rate_limited");
      expect(err.target).toBe("svc");
    });

    it("network — transient, preserves cause", () => {
      const cause = new Error("ECONNRESET");
      const err = OutboundError.network(cause, "svc");
      expect(err.kind).toBe("transient");
      expect(err.errorType).toBe("network");
      expect(err.cause).toBe(cause);
      expect(err.target).toBe("svc");
    });

    it("network — target is optional", () => {
      const err = OutboundError.network(new Error("x"));
      expect(err.target).toBeUndefined();
    });

    it("timeout — transient", () => {
      const err = OutboundError.timeout("svc");
      expect(err.kind).toBe("transient");
      expect(err.errorType).toBe("timeout");
    });

    it("retriesExhausted — transient, carries lastStatus", () => {
      const err = OutboundError.retriesExhausted("svc", 503);
      expect(err.kind).toBe("transient");
      expect(err.errorType).toBe("retries_exhausted");
      expect(err.statusCode).toBe(503);
      expect(err.message).toContain("503");
    });

    it("clientError — fatal, carries status", () => {
      const err = OutboundError.clientError(404, "svc");
      expect(err.kind).toBe("fatal");
      expect(err.errorType).toBe("client_error");
      expect(err.statusCode).toBe(404);
    });

    it("noMatchingTarget — fatal", () => {
      const err = OutboundError.noMatchingTarget("https://unknown.host/foo");
      expect(err.kind).toBe("fatal");
      expect(err.errorType).toBe("no_matching_target");
      expect(err.message).toContain("unknown.host");
    });

    it("shuttingDown — fatal", () => {
      const err = OutboundError.shuttingDown();
      expect(err.kind).toBe("fatal");
      expect(err.errorType).toBe("shutting_down");
    });
  });
});

describe("PostbackError", () => {
  it("has name PostbackError and wraps cause", () => {
    const cause = OutboundError.network(new Error("x"), "svc");
    const err = new PostbackError("retry_topic", cause);
    expect(err.name).toBe("PostbackError");
    expect(err.cause).toBe(cause);
    expect(err.message).toBe(cause.message);
  });

  describe("from()", () => {
    it("routes transient errors to retry_topic", () => {
      const err = PostbackError.from(OutboundError.network(new Error("x")));
      expect(err.routing).toBe("retry_topic");
    });

    it("routes fatal errors to dlq", () => {
      const err = PostbackError.from(OutboundError.clientError(400, "svc"));
      expect(err.routing).toBe("dlq");
    });
  });
});
