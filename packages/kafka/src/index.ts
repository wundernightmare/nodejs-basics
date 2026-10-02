export {
  buildConsumerConfig,
  buildKafkaClientConfig,
  buildProducerConfig,
  type KafkaRdKafkaConfig,
} from "./kafka-config.builder.js";
export {
  KafkaBackpressureError,
  type KafkaConsumerOptions,
  KafkaConsumerRunner,
} from "./kafka-consumer.js";
export { kafkaLogger } from "./kafka-log-creator.js";
export { type KafkaClientMetrics, kafkaClientMetrics } from "./kafka-metrics.js";
export { KafkaModule } from "./kafka.module.js";
export { sendTraced, traceKafkaMessage, type KafkaMessageContext } from "./kafka-tracing.js";
export {
  KAFKA_SEND_ERRORS,
  KafkaSendError,
  type KafkaSendErrorKind,
  type KafkaSendErrorSpec,
  toKafkaSendError,
} from "./kafka-errors.js";
export { KafkaProducerService, type KafkaSendOptions } from "./kafka.provider.js";
