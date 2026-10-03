import { type DynamicModule, Global, Module } from "@nestjs/common";

import { OutboxRelay } from "./outbox.relay.js";
import { OutboxWriter } from "./outbox.writer.js";

/**
 * The outbox: OutboxWriter for use cases, OutboxRelay running in the
 * background. Needs DatabaseModule (PG_POOL), and KafkaModule for the relay;
 * the table comes from migrations/0001_init.sql.
 */
@Global()
@Module({})
export class OutboxModule {
  /**
   * `relay: false` — the writer alone, no Kafka: events stay in the table
   * until a process with the relay runs.
   */
  static forRoot(options: { relay: boolean }): DynamicModule {
    return {
      module: OutboxModule,
      providers: [OutboxWriter, ...(options.relay ? [OutboxRelay] : [])],
      exports: [OutboxWriter],
    };
  }
}
