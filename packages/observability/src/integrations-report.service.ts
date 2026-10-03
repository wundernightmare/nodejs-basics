/**
 * What this process runs with (@base/config integrations.ts), said once at
 * startup and kept as a gauge — a replica with an integration switched off is
 * seen on a dashboard, not found out when its events are missing.
 */
import { Injectable, type OnModuleInit } from "@nestjs/common";
import { metrics } from "@opentelemetry/api";

import { INTEGRATION_NAMES, integrationEnabled } from "@base/config";
import { AppLogger } from "@base/logger";

@Injectable()
export class IntegrationsReportService implements OnModuleInit {
  constructor(private readonly logger: AppLogger) {}

  onModuleInit(): void {
    const enabled = INTEGRATION_NAMES.filter((name) => integrationEnabled(name));
    const disabled = INTEGRATION_NAMES.filter((name) => !integrationEnabled(name));
    this.logger.child(IntegrationsReportService.name).info(
      {
        "event.action": "integrations.resolved",
        "integrations.enabled": enabled,
        "integrations.disabled": disabled,
      },
      `Integrations: on ${enabled.join(", ") || "none"}; off ${disabled.join(", ") || "none"}`,
    );
    metrics
      .getMeter("app")
      .createObservableGauge("app.integration.enabled", {
        description:
          "1 when the integration is on in this process, 0 when its connection variable is unset.",
      })
      .addCallback((result) => {
        for (const name of INTEGRATION_NAMES) {
          result.observe(integrationEnabled(name) ? 1 : 0, { integration: name });
        }
      });
  }
}
