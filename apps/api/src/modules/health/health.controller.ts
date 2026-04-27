/**
 * HealthController — minimal example of a NestJS controller.
 *
 * Demonstrates:
 *   - @Controller(prefix) — declares a route group
 *   - @Get(path) — declares a route handler
 *   - constructor injection of a service from the same module
 *
 * NOTE: this is the public-side health. Kubernetes liveness/readiness probes
 * should target the *admin server* on ADMIN_PORT (default 9090) — see
 * @base/observability AdminServerService — not this controller.
 */
import { Controller, Get } from "@nestjs/common";

import { HealthService, type HealthStatus } from "./health.service.js";

@Controller("health")
export class HealthController {
  constructor(private readonly health: HealthService) {}

  @Get()
  get(): HealthStatus {
    return this.health.status();
  }
}
