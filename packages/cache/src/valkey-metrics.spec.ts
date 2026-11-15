import { EventEmitter } from "node:events";

import type { Redis as Valkey } from "iovalkey";
import { describe, expect, it } from "vitest";

import { captureMetrics, metricValue, testCase } from "@base/testing";

import { registerValkeyMetrics } from "./valkey-metrics.js";

describe("Valkey client metrics", () => {
  it("follows the connection: ready, errors, reconnects, closed", async () => {
    await testCase("NB-1348", "Valkey client metrics follow the connection's events");
    const capture = captureMetrics();
    try {
      const client = new EventEmitter();
      const handle = registerValkeyMetrics(client as unknown as Valkey);
      const read = async (name: string): Promise<number> =>
        metricValue(await capture.scrape(), name);

      // Exported from the start: a rate over a series that appears late misses its first step.
      expect(await capture.scrape()).toContain("valkey_client_errors_total 0");
      expect(await capture.scrape()).toContain("valkey_client_reconnects_total 0");
      expect(await read("valkey_client_connected")).toBe(0);

      client.emit("ready");
      expect(await read("valkey_client_connected")).toBe(1);
      client.emit("error", new Error("ECONNRESET"));
      client.emit("close");
      client.emit("reconnecting");
      client.emit("reconnecting");
      expect(await read("valkey_client_connected")).toBe(0);
      expect(await read("valkey_client_errors_total")).toBe(1);
      expect(await read("valkey_client_reconnects_total")).toBe(2);

      handle.dispose();
      for (const event of ["ready", "end", "close", "error", "reconnecting"]) {
        expect(client.listenerCount(event)).toBe(0);
      }
    } finally {
      await capture.stop();
    }
  });

  it("leaves a client without events alone", async () => {
    await testCase("NB-1348", "Valkey client metrics follow the connection's events");
    const handle = registerValkeyMetrics({} as unknown as Valkey);
    expect(() => {
      handle.dispose();
    }).not.toThrow();
  });
});
