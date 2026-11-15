import { Writable } from "node:stream";

import { context, ROOT_CONTEXT, trace, TraceFlags } from "@opentelemetry/api";
import pino from "pino";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { captureSpans, type SpanCapture, testCase } from "@base/testing";

import { DebugSubjects, runAsDebugSubject } from "./debug-subjects.js";
import { LogLevel } from "./log-level.js";
import { buildPinoOptions } from "./pino.config.js";
import { bindTraceTrigger, type TraceTrigger, triggerActiveTrace } from "./trace-trigger.js";

const TRACE = "0af7651916cd43dd8448eb211c80319c";
const SPAN = "b7ad6b7169203331";

type Line = Record<string, unknown>;

function sinkLogger(level = "info"): { logger: pino.Logger; lines: Line[] } {
  const lines: Line[] = [];
  const sink = new Writable({
    write(chunk: Buffer, _enc, cb) {
      for (const raw of chunk.toString().split("\n")) {
        if (raw.trim() !== "") lines.push(JSON.parse(raw) as Line);
      }
      cb();
    },
  });
  return { logger: pino(buildPinoOptions(new LogLevel(level as "info")), sink), lines };
}

/** The ids a line carries, by field. */
const ids = (line: Line | undefined) => ({
  trace: line?.["trace.id"],
  unsampled: line?.["trace.unsampled_id"],
  transaction: line?.["transaction.id"],
  span: line?.["span.id"],
});

function inSpan<T>(sampled: boolean, fn: () => T, traceId = TRACE): T {
  const spanContext = {
    traceId,
    spanId: SPAN,
    traceFlags: sampled ? TraceFlags.SAMPLED : TraceFlags.NONE,
  };
  return context.with(trace.setSpanContext(ROOT_CONTEXT, spanContext), fn);
}

/** A trigger that exports what it is asked for, up to `budget` traces. */
function fakeTrigger(budget = Number.POSITIVE_INFINITY) {
  const triggered = new Set<string>();
  const asked: string[] = [];
  const trigger: TraceTrigger = {
    triggerByLog(traceId) {
      asked.push(traceId);
      if (!triggered.has(traceId) && triggered.size >= budget) return false;
      triggered.add(traceId);
      return true;
    },
    isTriggered: (traceId) => triggered.has(traceId),
  };
  return { trigger, asked, triggered };
}

describe("trace ids in log lines", () => {
  let capture: SpanCapture;
  beforeAll(() => {
    capture = captureSpans();
  });
  afterAll(() => {
    capture.stop();
  });
  afterEach(() => {
    bindTraceTrigger(undefined);
  });

  it("links a line to its trace only when the trace is in the trace store", async () => {
    await testCase(
      "NB-1364",
      "Log lines: trace.id for a stored trace, trace.unsampled_id otherwise",
    );
    const { logger, lines } = sinkLogger();
    inSpan(true, () => {
      logger.info("sampled");
    });
    inSpan(false, () => {
      logger.info("unsampled");
      logger.error("unsampled error, no buffer");
    });
    logger.info("outside a span");
    context.with(
      trace.setSpanContext(ROOT_CONTEXT, { traceId: "0".repeat(32), spanId: SPAN, traceFlags: 1 }),
      () => {
        logger.info("invalid span context");
      },
    );
    expect(lines.map((l) => ids(l))).toEqual([
      { trace: TRACE, transaction: TRACE, span: SPAN, unsampled: undefined },
      // Still found together by the id, never a dead link.
      { unsampled: TRACE, span: SPAN, trace: undefined, transaction: undefined },
      { unsampled: TRACE, span: SPAN, trace: undefined, transaction: undefined },
      { trace: undefined, unsampled: undefined, transaction: undefined, span: undefined },
      { trace: undefined, unsampled: undefined, transaction: undefined, span: undefined },
    ]);
  });

  it("a warn or error line of an unsampled trace exports it, and links to it from then on", async () => {
    await testCase(
      "NB-1365",
      "A warn or error log line triggers the export of its unsampled trace",
    );
    const { trigger, asked } = fakeTrigger();
    bindTraceTrigger(trigger);
    const { logger, lines } = sinkLogger("debug");
    inSpan(false, () => {
      logger.debug("before");
      logger.info("still before");
      logger.warn("the trigger");
      logger.info("after");
      logger.error({ err: new Error("boom") }, "again");
    });
    expect(lines.map((l) => [l["message"], l["trace.id"], l["trace.unsampled_id"]])).toEqual([
      ["before", undefined, TRACE],
      ["still before", undefined, TRACE],
      ["the trigger", TRACE, undefined],
      ["after", TRACE, undefined],
      ["again", TRACE, undefined],
    ]);
    // Only warn and above ask for an export; fatal does as well.
    expect(asked).toEqual([TRACE, TRACE]);
    const other = "1".repeat(32);
    inSpan(
      false,
      () => {
        logger.fatal("fatal");
      },
      other,
    );
    expect(asked).toEqual([TRACE, TRACE, other]);
    // A sampled trace needs no trigger.
    inSpan(true, () => {
      logger.error("sampled error");
    });
    expect(asked).toHaveLength(3);
  });

  it("does not link the line of a trace the rate limit refused", () => {
    const { trigger } = fakeTrigger(1);
    bindTraceTrigger(trigger);
    const { logger, lines } = sinkLogger();
    const refused = "2".repeat(32);
    inSpan(false, () => {
      logger.warn("accepted");
    });
    inSpan(
      false,
      () => {
        logger.warn("refused");
        logger.info("after the refusal");
      },
      refused,
    );
    expect(lines.map((l) => ids(l)).map((l) => [l.trace, l.unsampled])).toEqual([
      [TRACE, undefined],
      [undefined, refused],
      [undefined, refused],
    ]);
  });

  it("a line the level or the sampler drops triggers nothing", () => {
    const { trigger, asked } = fakeTrigger();
    bindTraceTrigger(trigger);
    const { logger, lines } = sinkLogger("error");
    inSpan(false, () => {
      logger.warn("below the level");
    });
    expect(lines).toEqual([]);
    expect(asked).toEqual([]);
  });

  it("the trace of a debug subject is exported without a warn line", async () => {
    await testCase("NB-1366", "A debug subject's unsampled trace is exported");
    const { trigger, asked } = fakeTrigger();
    bindTraceTrigger(trigger);
    const subjects = new DebugSubjects(() => 3_600_000);
    subjects.put("tenant-42", 60_000);
    const { logger, lines } = sinkLogger();
    inSpan(false, () => {
      runAsDebugSubject(subjects, "someone else", () => {
        logger.info("not debugged");
      });
      runAsDebugSubject(subjects, "tenant-42", () => {
        logger.debug("debugged");
      });
    });
    expect(asked).toEqual([TRACE]);
    expect(lines.map((l) => [l["message"], l["trace.id"], l["trace.unsampled_id"]])).toEqual([
      ["not debugged", undefined, TRACE],
      ["debugged", TRACE, undefined],
    ]);
    // Sampled already, or no span at all: nothing to ask for.
    inSpan(true, () => {
      triggerActiveTrace();
    });
    triggerActiveTrace();
    expect(asked).toEqual([TRACE]);
    // Unbound: asking is safe and exports nothing.
    bindTraceTrigger(undefined);
    inSpan(false, () => {
      triggerActiveTrace();
    });
    expect(asked).toEqual([TRACE]);
  });
});
