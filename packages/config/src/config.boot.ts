/**
 * The entry point of an app's configuration: command-line flags for whoever
 * runs or supports the service, then the load. Flags only inspect — every
 * value still comes from the environment or config.yaml.
 *
 *   node dist/main.js --help
 *   node dist/main.js --check-config       # validate env + config.yaml, exit 0 or 78
 *   node dist/main.js --config-reference   # every setting with its default
 */
import { parseArgs } from "node:util";

import { loadConfigOrExit, type LoadOptions } from "./config.loader.js";
import { ENV_REGISTRY, type EnvEntry } from "./env.registry.js";

export interface BootOptions extends LoadOptions {
  /** The program name shown by --help. */
  name: string;
}

const USAGE = (name: string): string => `Usage: ${name} [option]

Configuration comes from the environment, then config.yaml (APP_CONFIG_FILE),
then the defaults (see --config-reference); an option only inspects it.

Options:
  -h, --help            this text
      --check-config    load and validate the configuration, then exit:
                        0 when valid, 78 with every problem listed otherwise
      --config-reference
                        every setting: environment variable, YAML path,
                        type, default, description
`;

/** One setting, as --config-reference prints it. */
export function describeEntry(entry: EnvEntry, defaults: LoadOptions["defaults"] = {}): string {
  const type =
    entry.type === "enum"
      ? (entry.values ?? []).join("|")
      : [
          entry.type ?? "string",
          entry.min !== undefined || entry.max !== undefined
            ? `${entry.min ?? ""}..${entry.max ?? ""}`
            : "",
          entry.values === undefined ? "" : `or ${entry.values.join("|")}`,
        ]
          .filter((part) => part !== "")
          .join(" ");
  const fallback = defaults[entry.key] ?? entry.default;
  const head = [
    entry.key,
    entry.yaml === undefined ? "(env only)" : `(yaml: ${entry.yaml})`,
    type,
    entry.required ? "required" : fallback === undefined ? "no default" : `default ${fallback}`,
  ].join("  ");
  return `${head}\n    ${entry.description}`;
}

/**
 * Handles the flags, or loads the configuration (exiting 78 on a bad one).
 * Returns only when the app should start.
 */
export function bootConfig(options: BootOptions, argv = process.argv.slice(2)): void {
  let flags: { help?: boolean; "check-config"?: boolean; "config-reference"?: boolean };
  try {
    ({ values: flags } = parseArgs({
      args: argv,
      options: {
        help: { type: "boolean", short: "h" },
        "check-config": { type: "boolean" },
        "config-reference": { type: "boolean" },
      },
    }));
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n\n${USAGE(options.name)}`);
    // 64 = EX_USAGE (sysexits.h).
    process.exit(64);
  }

  if (flags.help === true) {
    process.stdout.write(USAGE(options.name));
    process.exit(0);
  }
  if (flags["config-reference"] === true) {
    const all = ENV_REGISTRY.map((entry) => describeEntry(entry, options.defaults));
    process.stdout.write(`${all.join("\n\n")}\n`);
    process.exit(0);
  }
  if (flags["check-config"] === true) {
    loadConfigOrExit(options);
    process.stdout.write("configuration is valid\n");
    process.exit(0);
  }
  loadConfigOrExit(options);
}
