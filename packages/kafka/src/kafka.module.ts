import { Global, Module } from "@nestjs/common";

import { KafkaProducerService } from "./kafka.provider.js";

/**
 * The shared producer. Inject KafkaProducerService and call send(): the
 * underlying client is replaced on reconnect, so it is never handed out.
 */
@Global()
@Module({
  providers: [KafkaProducerService],
  exports: [KafkaProducerService],
})
export class KafkaModule {}
