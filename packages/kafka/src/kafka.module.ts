import { Global, Module } from "@nestjs/common";

import { KAFKA_PRODUCER, KafkaProducerService } from "./kafka.provider.js";

@Global()
@Module({
  providers: [
    KafkaProducerService,
    // Expose the raw producer under the KAFKA_PRODUCER token so consumers
    // can inject it without depending on the service class directly.
    {
      provide: KAFKA_PRODUCER,
      useFactory: (svc: KafkaProducerService) => svc.producer,
      inject: [KafkaProducerService],
    },
  ],
  exports: [KafkaProducerService, KAFKA_PRODUCER],
})
export class KafkaModule {}
