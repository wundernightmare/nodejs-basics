/**
 * HealthService — minimal NestJS service.
 *
 * Demonstrates the most common DI pattern: a service injecting framework
 * services (here, ConfigService). Returned shape is the JSON the
 * HealthController serialises.
 */
import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

export interface HealthStatus {
  status: "ok";
  service: string;
  env: string;
  uptimeSeconds: number;
  timestamp: string;
}

@Injectable()
export class HealthService {
  constructor(private readonly config: ConfigService) {}

  status(): HealthStatus {
    return {
      status: "ok",
      service: this.config.get<string>("OTEL_SERVICE_NAME") ?? "app",
      env: this.config.get<string>("NODE_ENV") ?? "development",
      uptimeSeconds: Math.floor(process.uptime()),
      timestamp: new Date().toISOString(),
    };
  }
}
