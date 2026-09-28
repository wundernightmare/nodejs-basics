import { Global, Module } from "@nestjs/common";

import { OutboxRelay } from "./outbox.relay.js";
import { OutboxWriter } from "./outbox.writer.js";

/**
 * The outbox: OutboxWriter for use cases, OutboxRelay running in the
 * background. Needs DatabaseModule (PG_POOL) and KafkaModule; the table comes
 * from migrations/0002_create_outbox.sql.
 */
@Global()
@Module({
  providers: [OutboxWriter, OutboxRelay],
  exports: [OutboxWriter],
})
export class OutboxModule {}
