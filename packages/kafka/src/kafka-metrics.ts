/**
 * OpenTelemetry client metrics for @confluentinc/kafka-javascript producers
 * and consumers.
 *
 * What we measure:
 *   kafka.client.connected            gauge 1/0    {client_id, role}
 *   kafka.client.errors_total         counter      {client_id, role, type}
 *
 * Cheap event-listener wiring; no per-message instrumentation.
 */
import type { KafkaJS } from "@confluentinc/kafka-javascript";
import { metrics, type Attributes, type Counter, type ObservableGauge } from "@opentelemetry/api";

type KafkaEventDispatcher = KafkaJS.Producer | KafkaJS.Consumer;

export interface KafkaMetricsHandle {
  dispose(): void;
}

export function registerKafkaMetrics(
  client: KafkaEventDispatcher,
  attrs: Attributes & { role: string },
): KafkaMetricsHandle {
  // kafkajs-compat clients in @confluentinc/kafka-javascript 1.x do NOT
  // extend EventEmitter — only the native rdkafka KafkaConsumer/Producer
  // do. Without `.on` there is no event surface to bind to.
  const emitter = client as unknown as {
    on?(event: string, handler: (...args: unknown[]) => void): unknown;
    off?(event: string, handler: (...args: unknown[]) => void): unknown;
    removeListener?(event: string, handler: (...args: unknown[]) => void): unknown;
  };
  if (typeof emitter.on !== "function") {
    return { dispose: (): void => {} };
  }

  const meter = metrics.getMeter("kafka.client");
  let connected = 0;

  const connectedGauge: ObservableGauge = meter.createObservableGauge("kafka.client.connected", {
    description: "1 when the Kafka client reports connected, 0 when disconnected / crashed.",
  });
  const errorsCounter: Counter = meter.createCounter("kafka.client.errors_total", {
    description: "Total client-side errors emitted by the Kafka client.",
  });

  const observer = (result: {
    observe: (g: ObservableGauge, v: number, a?: Attributes) => void;
  }): void => {
    result.observe(connectedGauge, connected, attrs);
  };
  meter.addBatchObservableCallback(observer, [connectedGauge]);

  const onConnect = (): void => {
    connected = 1;
  };
  const onDisconnect = (): void => {
    connected = 0;
  };
  const onError = (err: unknown): void => {
    connected = 0;
    const name = (err as Error | undefined)?.name ?? "Error";
    errorsCounter.add(1, { ...attrs, type: name });
  };

  // 1.x kafkajs-compat clients expose `.on` as a method that throws
  // ERR__NOT_IMPLEMENTED rather than missing it entirely. Try the
  // registration; back out on failure.
  try {
    emitter.on("producer.connect", onConnect);
    emitter.on("producer.disconnect", onDisconnect);
    emitter.on("consumer.connect", onConnect);
    emitter.on("consumer.disconnect", onDisconnect);
    emitter.on("producer.network.request_timeout", onError);
    emitter.on("consumer.crash", onError);
  } catch {
    meter.removeBatchObservableCallback(observer, [connectedGauge]);
    return { dispose: (): void => {} };
  }

  return {
    dispose: (): void => {
      meter.removeBatchObservableCallback(observer, [connectedGauge]);
      const unhook = (event: string, handler: (...args: unknown[]) => void): void => {
        if (emitter.off) emitter.off(event, handler);
        else if (emitter.removeListener) emitter.removeListener(event, handler);
      };
      unhook("producer.connect", onConnect);
      unhook("producer.disconnect", onDisconnect);
      unhook("consumer.connect", onConnect);
      unhook("consumer.disconnect", onDisconnect);
      unhook("producer.network.request_timeout", onError);
      unhook("consumer.crash", onError);
    },
  };
}
