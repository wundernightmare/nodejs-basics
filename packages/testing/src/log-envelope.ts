import { readFileSync } from "node:fs";
import { join } from "node:path";

import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

import { workspaceRoot } from "./contracts.js";

let validate: ValidateFunction | undefined;

/**
 * The problems of one parsed log line against docs/log-envelope.schema.json —
 * the fields every line must carry; empty when the line conforms.
 */
export function logEnvelopeProblems(line: unknown): string[] {
  if (validate === undefined) {
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    addFormats.default(ajv);
    const schema = readFileSync(join(workspaceRoot(), "docs/log-envelope.schema.json"), "utf8");
    validate = ajv.compile(JSON.parse(schema) as object);
  }
  if (validate(line)) return [];
  return (validate.errors ?? []).map(
    (e) => `${e.instancePath === "" ? "/" : e.instancePath} ${e.message ?? ""}`,
  );
}
