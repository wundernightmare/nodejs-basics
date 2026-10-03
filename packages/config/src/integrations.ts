/**
 * Integrations an app can be started without — `DISABLED_INTEGRATIONS=valkey,kafka`
 * runs the api on Postgres alone. Everything not listed here is the core: a
 * service without it does not start.
 *
 * An app declares which of these it can do without (LoadOptions.integrations
 * in its boot.ts) and composes its module tree from integrationEnabled(): a
 * disabled integration is never connected to, and what depended on it runs
 * on a substitute (apps/api/src/app.module.ts) — never registered only to
 * throw when called. The loader rejects a name the app cannot do without, and
 * each process reports what it runs with at startup (`integrations.resolved`,
 * the `app.integration.enabled` gauge).
 *
 * On by default: production forgets to set something and fails at startup,
 * it never runs silently degraded.
 */
import { type ConfigGetter, processEnv, readString } from "./config.values.js";

export const INTEGRATIONS = ["valkey", "kafka"] as const;

export type Integration = (typeof INTEGRATIONS)[number];

/** The names in DISABLED_INTEGRATIONS, as written (validated by the loader). */
export function disabledIntegrations(config: ConfigGetter = processEnv): string[] {
  return (readString(config, "DISABLED_INTEGRATIONS") ?? "")
    .split(",")
    .map((name) => name.trim().toLowerCase())
    .filter((name) => name !== "");
}

export function integrationEnabled(name: Integration, config: ConfigGetter = processEnv): boolean {
  return !disabledIntegrations(config).includes(name);
}

/** DISABLED_INTEGRATIONS problems for an app that can do without `optional`. */
export function disabledIntegrationProblems(
  optional: readonly Integration[],
  config: ConfigGetter = processEnv,
): string[] {
  return disabledIntegrations(config)
    .filter((name) => !(optional as readonly string[]).includes(name))
    .map((name) =>
      (INTEGRATIONS as readonly string[]).includes(name)
        ? `DISABLED_INTEGRATIONS: this app cannot run without ${name} ` +
          `(it can without: ${optional.join(", ") || "none"})`
        : `DISABLED_INTEGRATIONS: unknown integration "${name}" (known: ${INTEGRATIONS.join(", ")})`,
    );
}
