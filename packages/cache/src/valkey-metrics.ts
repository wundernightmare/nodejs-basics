/**
 * OpenTelemetry client metrics for Valkey/iovalkey.
 *
 * What we measure:
 *   valkey.client.connected             gauge 1/0   {client_id}
 *   valkey.client.errors_total          counter     {client_id, type}
 *   valkey.client.reconnects_total      counter     {client_id}
 *
 * The metrics module imports cleanly without an active OTel SDK — when no SDK
 * is configured, the no-op meter provider is returned and all calls become
 * cheap no-ops. So you can wire this in unconditionally.
 */
import { metrics, type Attributes, type Counter, type ObservableGauge } from "@opentelemetry/api";
import type { Redis as Valkey } from "iovalkey";

export interface ValkeyMetricsHandle {
  dispose(): void;
}

export function registerValkeyMetrics(client: Valkey, attrs: Attributes = {}): ValkeyMetricsHandle {
  // Tests sometimes substitute a plain-object mock without an EventEmitter
  // surface. Skip silently — metrics are an observability concern, not a
  // correctness one.
  const emitter = client as unknown as { on?: unknown };
  if (typeof emitter.on !== "function") {
    return { dispose: (): void => {} };
  }

  const meter = metrics.getMeter("valkey.client");
  let connected = 0;

  const connectedGauge: ObservableGauge = meter.createObservableGauge("valkey.client.connected", {
    description: "1 when the Valkey client is in the ready state, 0 otherwise.",
  });
  const errorsCounter: Counter = meter.createCounter("valkey.client.errors_total", {
    description: "Total number of errors emitted by the Valkey client.",
  });
  const reconnectsCounter: Counter = meter.createCounter("valkey.client.reconnects_total", {
    description: "Total reconnect attempts triggered by iovalkey's retryStrategy.",
  });

  const observer = (result: {
    observe: (g: ObservableGauge, v: number, a?: Attributes) => void;
  }): void => {
    result.observe(connectedGauge, connected, attrs);
  };
  meter.addBatchObservableCallback(observer, [connectedGauge]);

  const onReady = (): void => {
    connected = 1;
  };
  const onClose = (): void => {
    connected = 0;
  };
  const onError = (err: Error): void => {
    errorsCounter.add(1, { ...attrs, type: err.name || "Error" });
  };
  const onReconnecting = (): void => {
    reconnectsCounter.add(1, attrs);
  };

  client.on("ready", onReady);
  client.on("end", onClose);
  client.on("close", onClose);
  client.on("error", onError);
  client.on("reconnecting", onReconnecting);

  return {
    dispose: (): void => {
      meter.removeBatchObservableCallback(observer, [connectedGauge]);
      client.off("ready", onReady);
      client.off("end", onClose);
      client.off("close", onClose);
      client.off("error", onError);
      client.off("reconnecting", onReconnecting);
    },
  };
}
