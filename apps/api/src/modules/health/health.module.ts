/**
 * HealthModule — minimal NestJS module.
 *
 * Demonstrates:
 *   - controllers — registered with this module's HTTP routes
 *   - providers — services available for injection inside this module
 *   - exports omitted — no other module needs HealthService
 */
import { Module } from "@nestjs/common";

import { HealthController } from "./health.controller.js";
import { HealthService } from "./health.service.js";

@Module({
  controllers: [HealthController],
  providers: [HealthService],
})
export class HealthModule {}
