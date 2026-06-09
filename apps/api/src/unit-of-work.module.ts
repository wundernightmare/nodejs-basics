/**
 * Binds the IUnitOfWork port (from @base/common) to its pg implementation and
 * exposes it application-wide. It must be @Global: feature modules (e.g.
 * TasksModule) inject UNIT_OF_WORK in their use cases, and a provider declared
 * only in AppModule's `providers` is NOT visible to imported feature modules —
 * NestJS resolves provider tokens through the module graph, not by ambient
 * scope. Marking the module global (and exporting the token) makes it injectable
 * everywhere without each module re-importing it.
 */
import { Global, Module } from "@nestjs/common";

import { UNIT_OF_WORK } from "@base/common";
import { PgUnitOfWork } from "@base/database";

@Global()
@Module({
  providers: [{ provide: UNIT_OF_WORK, useClass: PgUnitOfWork }],
  exports: [UNIT_OF_WORK],
})
export class UnitOfWorkModule {}
