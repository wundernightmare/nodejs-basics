import { describe, expect, it } from "vitest";

import { meta, testCase } from "@base/testing";

import { createKafkaLogger, REPEAT_WINDOW_MS } from "./kafka-log-creator.js";

type Line = [string, Record<string, unknown>, string];

function setup(): {
  logger: ReturnType<typeof createKafkaLogger>;
  lines: Line[];
  tick: (ms: number) => void;
} {
  const lines: Line[] = [];
  let t = 0;
  const sink = {
    error: (f: Record<string, unknown>, m: string) => lines.push(["error", f, m]),
    warn: (f: Record<string, unknown>, m: string) => lines.push(["warn", f, m]),
    info: (f: Record<string, unknown>, m: string) => lines.push(["info", f, m]),
    debug: (f: Record<string, unknown>, m: string) => lines.push(["debug", f, m]),
  };
  const logger = createKafkaLogger(
    sink as unknown as Parameters<typeof createKafkaLogger>[0],
    "kafka-javascript",
    () => t,
  );
  return {
    logger,
    lines,
    tick: (ms) => {
      t += ms;
    },
  };
}

describe("kafkaLogger", () => {
  meta({
    epic: "nodejs-basics",
    feature: "kafka",
    owner: "@team-platform",
    tags: ["kafka", "logging"],
  });

  it("maps the library's extras to kafka.* fields and drops its timestamp", async () => {
    await testCase("NB-929", "librdkafka log lines are ECS-shaped");
    const { logger, lines } = setup();
    logger.warn("Configuration property x", {
      fac: "CONFWARN",
      name: "app#producer-1",
      timestamp: 1,
    });
    logger.error("Error: broker transport failure", { fac: "BINDING", name: "", timestamp: 2 });
    expect(lines).toEqual([
      [
        "warn",
        {
          "log.logger": "kafka:kafka-javascript",
          "kafka.log.facility": "CONFWARN",
          "kafka.client.name": "app#producer-1",
        },
        "Configuration property x",
      ],
      [
        "error",
        { "log.logger": "kafka:kafka-javascript", "kafka.log.facility": "BINDING" },
        "Error: broker transport failure",
      ],
    ]);
  });

  it("folds repeats within the window and reports how many on the next line", async () => {
    await testCase("NB-930", "a broker outage does not flood the logs");
    const { logger, lines, tick } = setup();
    const extra = { fac: "FAIL", name: "app#producer-1", timestamp: 0 };
    for (let i = 0; i < 200; i++) {
      logger.error(
        `Connect to ipv4#127.0.0.1:9092 failed (after ${i % 3}ms in state CONNECT)`,
        extra,
      );
      tick(50);
    }
    expect(lines).toHaveLength(1);
    tick(REPEAT_WINDOW_MS);
    logger.error("Connect to ipv4#127.0.0.1:9092 failed (after 7ms in state CONNECT)", extra);
    expect(lines).toHaveLength(2);
    expect(lines[1]?.[1]["kafka.log.suppressed"]).toBe(199);
  });

  it("does not fold different messages, levels or clients", async () => {
    await testCase("NB-931", "only identical lines are folded");
    const { logger, lines } = setup();
    logger.error("a", { fac: "FAIL", name: "p1" });
    logger.error("a", { fac: "FAIL", name: "p2" });
    logger.warn("a", { fac: "FAIL", name: "p1" });
    logger.error("b", { fac: "FAIL", name: "p1" });
    expect(lines).toHaveLength(4);
  });
});
