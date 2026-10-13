/**
 * Client-side Valkey metrics — the connection as this process sees it.
 * Server-side state (memory, keys, clients, ops/s) is valkey-exporter's job.
 *
 *   valkey_client_connected          gauge 1/0  the client is in the ready state
 *   valkey_client_errors_total       counter    errors the client emitted
 *   valkey_client_reconnects_total   counter    reconnect attempts
 *
 * No labels: the scrape adds the service and the instance. The module imports
 * cleanly without an OTel SDK (the no-op meter), so it is wired unconditionally.
 */
import { metrics, type ObservableResult } from "@opentelemetry/api";
import type { Redis as Valkey } from "iovalkey";

export interface ValkeyMetricsHandle {
  dispose(): void;
}

export function registerValkeyMetrics(client: Valkey): ValkeyMetricsHandle {
  // Tests sometimes substitute a plain-object mock without an EventEmitter
  // surface. Skip silently — metrics are an observability concern, not a
  // correctness one.
  const emitter = client as unknown as { on?: unknown };
  if (typeof emitter.on !== "function") {
    return { dispose: (): void => {} };
  }

  const meter = metrics.getMeter("valkey.client");
  let connected = 0;

  const connectedGauge = meter.createObservableGauge("valkey_client_connected", {
    description: "1 when the Valkey client is in the ready state, 0 otherwise.",
  });
  const errors = meter.createCounter("valkey_client_errors_total", {
    description: "Errors emitted by the Valkey client.",
  });
  const reconnects = meter.createCounter("valkey_client_reconnects_total", {
    description: "Reconnect attempts of the Valkey client.",
  });

  // Exported as 0 from the start, like a Prometheus counter without labels.
  errors.add(0);
  reconnects.add(0);

  const observe = (result: ObservableResult): void => {
    result.observe(connected);
  };
  connectedGauge.addCallback(observe);

  const onReady = (): void => {
    connected = 1;
  };
  const onClose = (): void => {
    connected = 0;
  };
  const onError = (): void => {
    errors.add(1);
  };
  const onReconnecting = (): void => {
    reconnects.add(1);
  };

  client.on("ready", onReady);
  client.on("end", onClose);
  client.on("close", onClose);
  client.on("error", onError);
  client.on("reconnecting", onReconnecting);

  return {
    dispose: (): void => {
      connectedGauge.removeCallback(observe);
      client.off("ready", onReady);
      client.off("end", onClose);
      client.off("close", onClose);
      client.off("error", onError);
      client.off("reconnecting", onReconnecting);
    },
  };
}
