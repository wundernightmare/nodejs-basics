/**
 * Integrations a service can be started without. Setting an integration's
 * connection variable turns it on — there is no second switch to get wrong:
 * the api with DATABASE_URL alone runs on Postgres. Everything not listed
 * here is the core: a service without it does not start.
 *
 * The app composes its module tree from integrationEnabled() (apps/api/src/
 * app.module.ts): an integration that is off is never connected to, and what
 * depended on it runs on a substitute — never registered only to throw when
 * called. Each process reports what it runs with at startup
 * (`integrations.resolved`, the `app.integration.enabled` gauge).
 *
 * The loader closes the gaps a missing variable could slip through: another
 * variable of the group set without the connection one (`VALKEY_PASSWORD`
 * without `VALKEY_URL` — a typo, a secret without its ConfigMap) fails the
 * start, and so does an integration the app declares it needs
 * (LoadOptions.requires — the worker).
 */
import { type ConfigGetter, processEnv, readString } from "./config.values.js";

export const INTEGRATIONS = {
  valkey: { key: "VALKEY_URL", prefix: "VALKEY_" },
  kafka: { key: "KAFKA_BROKERS", prefix: "KAFKA_" },
} as const;

export type Integration = keyof typeof INTEGRATIONS;

export const INTEGRATION_NAMES = Object.keys(INTEGRATIONS) as Integration[];

export function integrationEnabled(name: Integration, config: ConfigGetter = processEnv): boolean {
  return readString(config, INTEGRATIONS[name].key) !== undefined;
}

/**
 * What is wrong with the integrations' settings, for an app that needs
 * `requires`. `setExplicitly`: the key was set in the environment or the
 * YAML file — a registry default is not a sign of intent.
 */
export function integrationProblems(
  requires: readonly Integration[],
  setExplicitly: (key: string) => boolean,
  keys: readonly string[],
): string[] {
  return INTEGRATION_NAMES.flatMap((name) => {
    const { key, prefix } = INTEGRATIONS[name];
    if (integrationEnabled(name)) return [];
    if (requires.includes(name)) return [`${key} is required: this app needs ${name}`];
    const stray = keys.filter((k) => k.startsWith(prefix) && setExplicitly(k));
    return stray.length === 0
      ? []
      : [`${stray.join(", ")} set without ${key}: set ${key} to use ${name}, or remove them`];
  });
}
