import { Writable } from "node:stream";

import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Secret, withDebugLogging, withRequestId } from "@base/common";

import { logEnvelopeProblems, testCase } from "@base/testing";

import { LogLevel } from "./log-level.js";
import { buildPinoOptions, ECS_VERSION, ecsError, logLevel, pinoLogger } from "./pino.config.js";

interface Line {
  "log.level": string;
  message: string;
  "http.request.id"?: string;
}

/** A pino logger writing JSON lines into an array, with the shared option set. */
function sinkLogger(level: LogLevel): { logger: pino.Logger; lines: Line[] } {
  const lines: Line[] = [];
  const sink = new Writable({
    write(chunk: Buffer, _enc, cb) {
      for (const raw of chunk.toString().split("\n")) {
        if (raw.trim() !== "") lines.push(JSON.parse(raw) as Line);
      }
      cb();
    },
  });
  return { logger: pino(buildPinoOptions(level), sink), lines };
}

describe("pino logMethod hook", () => {
  it("enforces the runtime LogLevel, not pino's pinned level", () => {
    const level = new LogLevel("info");
    const { logger, lines } = sinkLogger(level);
    logger.debug("hidden");
    logger.info("shown");
    level.set("debug", 0);
    logger.debug("now shown");
    expect(lines.map((l) => l.message)).toEqual(["shown", "now shown"]);
  });

  it("lets everything through under withDebugLogging(), on children too", () => {
    const level = new LogLevel("warn");
    const { logger, lines } = sinkLogger(level);
    const child = logger.child({ "log.logger": "Child" });
    child.debug("hidden");
    withDebugLogging(() => {
      child.trace("trace passes");
      logger.debug("debug passes");
    });
    child.debug("hidden again");
    expect(lines.map((l) => `${l["log.level"]}:${l.message}`)).toEqual([
      "trace:trace passes",
      "debug:debug passes",
    ]);
  });

  it("stamps http.request.id from the request context via the mixin", () => {
    const { logger, lines } = sinkLogger(new LogLevel("info"));
    withRequestId("REQ42", () => {
      logger.info("in request");
    });
    logger.info("outside");
    expect(lines[0]?.["http.request.id"]).toBe("REQ42");
    expect(lines[1]?.["http.request.id"]).toBeUndefined();
  });
});

/** What a real logger with the shared options writes for `fields`. */
function written(fields: Record<string, unknown>): string {
  const lines: string[] = [];
  const sink = new Writable({
    write(chunk: Buffer, _enc, cb) {
      lines.push(chunk.toString());
      cb();
    },
  });
  pino(buildPinoOptions(new LogLevel("info")), sink).info(fields, "msg");
  return lines.join("");
}

/** The single record a real logger with the shared options writes. */
function record(
  fields: Record<string, unknown>,
  extraKeys: string[] = [],
): Record<string, unknown> {
  const lines: string[] = [];
  const sink = new Writable({
    write(chunk: Buffer, _enc, cb) {
      lines.push(chunk.toString());
      cb();
    },
  });
  pino(buildPinoOptions(new LogLevel("info"), undefined, new Set(extraKeys)), sink).info(
    fields,
    "msg with postgres://app:in-the-message@db stays as written",
  );
  return JSON.parse(lines.join("")) as Record<string, unknown>;
}

describe("masking of private data in log records", () => {
  // Flat ECS keys, root-level and nested secrets: none may reach the stream.
  const sensitive: Record<string, unknown>[] = [
    { "user.password": "p1-plaintext" },
    { "user.token": "p2-plaintext" },
    { "auth.token": "p3-plaintext" },
    { "auth.secret": "p4-plaintext" },
    { "sasl.password": "p5-plaintext" },
    { password: "p6-plaintext" },
    { secret: "p7-plaintext" },
    { token: "p8-plaintext" },
    { db: { password: "p9-plaintext" } },
    { api_key: "p10-plaintext" },
    { "client.credential": "p11-plaintext" },
    { deep: { er: { client_secret: "p12-plaintext" } } },
    { headers: { Authorization: "Bearer p13-plaintext", "Set-Cookie": ["s=p14-plaintext"] } },
    { credentials: { user: "p15-plaintext", list: ["p16-plaintext"] } },
    { "db.url": "postgres://app:p17-plaintext@db:5432/app" },
    { "url.full": "https://api.example/x?page=2&access_token=p18-plaintext" },
    { "error.message": "connect failed: dial postgresql://app:p19-plaintext@db/app" },
    { dsn_like: "host=db user=app password=p20-plaintext sslmode=require" },
    { "db.options": "host=db user=app password='p21 plaintext' sslmode=require" },
    { targets: ["redis://:p22-plaintext@valkey:6379/0"] },
    { "url.query": "token=p23-plaintext" },
  ];

  it.each(sensitive)("masks %o", async (fields) => {
    await testCase("NB-1236", "Logs: a secret never reaches the stream, by key or by shape");
    const out = written(fields);
    expect(out).not.toMatch(/plaintext/u);
    expect(out).toMatch(/\[redacted\]|xxxxx/u);
  });

  it("masks by shape without losing the rest of the value", async () => {
    await testCase("NB-1237", "Logs: masking by shape keeps the rest of the value");
    const out = record({
      "db.url": "postgres://app:s3cret@db:5432/app?sslmode=require",
      "url.full": "https://api.example/x?page=2&api_key=abc&sort=asc",
      "error.message": "dial tcp: postgres://app:s3cret@db refused (attempt=2)",
    });
    expect(out["db.url"]).toBe("postgres://app:xxxxx@db:5432/app?sslmode=require");
    expect(out["url.full"]).toBe("https://api.example/x?page=2&api_key=[redacted]&sort=asc");
    expect(out["error.message"]).toBe("dial tcp: postgres://app:xxxxx@db refused (attempt=2)");
  });

  it("leaves what is not a secret: numbers, booleans, the empty string, the message", async () => {
    await testCase("NB-1238", "Logs: what is not a secret is left alone");
    const when = new Date("2026-01-01T00:00:00Z");
    const out = record({
      max_tokens: 4096,
      debug_token: true,
      password: "",
      "http.response.status_code": 200,
      "url.path": "/tasks/1",
      when,
      nothing: null,
      "event.action": "admin.auth.rejected",
    });
    expect(out).toMatchObject({
      max_tokens: 4096,
      debug_token: true,
      password: "",
      "http.response.status_code": 200,
      "url.path": "/tasks/1",
      when: when.toISOString(),
      nothing: null,
      "event.action": "admin.auth.rejected",
      message: "msg with postgres://app:in-the-message@db stays as written",
    });
  });

  it("LOG_REDACT_KEYS adds exact key names, case-insensitive, at any depth", async () => {
    await testCase("NB-1239", "Logs: LOG_REDACT_KEYS adds exact key names");
    const out = record(
      { Email: "a@example.com", user: { iban: "DE00" }, email_domain: "example.com" },
      ["email", "iban"],
    );
    expect(out).toMatchObject({
      Email: "[redacted]",
      user: { iban: "[redacted]" },
      email_domain: "example.com", // exact names only — not a substring rule
    });
  });

  it("a Secret prints its fingerprint, an Error under `err` is masked in message and stack", async () => {
    await testCase("NB-1240", "Logs: a Secret prints its fingerprint, an error is masked");
    const secret = Secret.of("p-plaintext");
    const out = record({
      holder: secret,
      api_token: secret,
      err: new Error("connect to postgres://app:p-plaintext@db failed"),
    });
    expect(JSON.stringify(out)).not.toMatch(/p-plaintext/u);
    expect(out["holder"]).toBe(`[redacted:${secret.fingerprint()}]`);
    expect(out["api_token"]).toBe(`[redacted:${secret.fingerprint()}]`);
    expect((out["err"] as { message: string }).message).toBe(
      "connect to postgres://app:xxxxx@db failed",
    );
  });

  it("survives a cycle and a record deeper than it walks", async () => {
    await testCase("NB-1241", "Logs: masking survives cycles and deep records");
    const cyclic: Record<string, unknown> = { name: "a" };
    cyclic["self"] = cyclic;
    expect(() => record({ cyclic })).not.toThrow();

    let deep: Record<string, unknown> = { password: "p-plaintext" };
    for (let i = 0; i < 20; i += 1) deep = { next: deep };
    expect(() => record({ deep })).not.toThrow();
  });

  it("never writes request headers (the req serializer keeps none)", () => {
    const out = written({
      req: {
        url: "/x?token=plaintext",
        headers: { authorization: "Bearer plaintext", cookie: "s=plaintext" },
      },
    });
    expect(out).not.toMatch(/plaintext/u);
  });
});

describe("log envelope", () => {
  it("every line carries the contracted envelope (docs/log-envelope.schema.json)", () => {
    const { logger, lines } = sinkLogger(new LogLevel("info"));
    logger.info({ "event.action": "admin.started" }, "plain");
    logger.child({ "log.logger": "Child" }).error({ ...ecsError(new Error("boom")) }, "failed");
    withRequestId("req-1", () => {
      logger.warn("in a request");
    });
    expect(lines).toHaveLength(3);
    expect(lines.map((line) => logEnvelopeProblems(line))).toEqual([[], [], []]);
    expect((lines[0] as unknown as Record<string, unknown>)["ecs.version"]).toBe(ECS_VERSION);
  });
});

describe("logLevel (the process-wide level)", () => {
  afterEach(() => {
    logLevel.reset();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("logs log_level.expired when a runtime change runs out — the revert has no caller", async () => {
    await testCase("NB-1027", "an expired debug window leaves a trace in the log");
    vi.useFakeTimers();
    const warn = vi.spyOn(pinoLogger, "warn").mockImplementation(() => undefined);
    const base = logLevel.base;
    logLevel.set("trace", 1_000);
    expect(warn).not.toHaveBeenCalled(); // an explicit set() is logged by its caller
    vi.advanceTimersByTime(1_000);
    expect(logLevel.level).toBe(base);
    expect(warn).toHaveBeenCalledWith(
      { "event.action": "log_level.expired", "log.level.from": "trace", "log.level.to": base },
      "Log level reverted to base",
    );
  });
});
