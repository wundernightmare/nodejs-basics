import { Global, Module } from "@nestjs/common";

import { AppLogger } from "./app-logger.service.js";

/**
 * Global module — import once in AppModule, AppLogger is available for
 * injection in every feature module without re-importing.
 */
@Global()
@Module({
  providers: [AppLogger],
  exports: [AppLogger],
})
export class LoggerModule {}
