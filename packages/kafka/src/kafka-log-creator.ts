import { KafkaJS } from "@confluentinc/kafka-javascript";

import { pinoLogger } from "@base/logger";

function makeKafkaLogger(namespace: string): KafkaJS.Logger {
  const log = pinoLogger.child({ "log.logger": `kafka:${namespace}` });
  return {
    info: (message, extra) => log.info(extra ?? {}, message),
    warn: (message, extra) => log.warn(extra ?? {}, message),
    error: (message, extra) => log.error(extra ?? {}, message),
    debug: (message, extra) => log.debug(extra ?? {}, message),
    namespace: (ns) => makeKafkaLogger(`${namespace}:${ns}`),
    setLogLevel: (_level) => {
      /* pino level is controlled globally */
    },
  };
}

/**
 * Routes all internal kafka-javascript / librdkafka logs through pino.
 * Pass as `logger` in every `new KafkaJS.Kafka()` constructor:
 *
 *   new KafkaJS.Kafka({ kafkaJS: { ..., logger: kafkaLogger } })
 */
export const kafkaLogger: KafkaJS.Logger = makeKafkaLogger("kafka-javascript");
