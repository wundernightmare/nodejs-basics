import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

import { Ajv, type ErrorObject, type ValidateFunction } from "ajv";
import addFormats from "ajv-formats";
import { parse } from "yaml";

/**
 * Validate HTTP exchanges against an OpenAPI 3.0 document — the way a route
 * test proves it honours the contract (api/tsp), not just its own
 * expectations. The Node analogue of the Go sibling's testx/contracts.go.
 *
 *   const contract = loadOpenAPI("openapi3/tasks.openapi.yaml");
 *   const res = await app.inject({ method: "GET", url: "/tasks/abc" });
 *   contract.validate("GET", "/tasks/abc", res.statusCode, res.payload, res.headers);
 *
 * `validate` throws with the reason when the exchange is not in the contract:
 * the method + path do not match an operation (`/tasks/{id}` matches
 * `/tasks/abc`), the status is not declared for it, the content type is not
 * one the response declares, a declared required header is missing, or the
 * body does not conform to the response schema (ajv; OpenAPI 3.0 `nullable`
 * is translated to a null union, the OpenAPI-only keywords are tolerated).
 */
export interface OpenAPIContract {
  /** The parsed document. */
  readonly document: OpenAPIDocument;
  /** Throws unless the response conforms to the operation matched by method + path. */
  validate(
    method: string,
    path: string,
    status: number,
    body: unknown,
    headers?: ResponseHeaders,
  ): void;
  /** Throws unless `body` conforms to `components.schemas[name]`. */
  validateSchema(name: string, body: unknown): void;
  /** The operation a request would hit, or undefined when the contract has none. */
  resolve(method: string, path: string): ResolvedOperation | undefined;
}

export type ResponseHeaders = Record<string, string | number | string[] | undefined>;

export interface ResolvedOperation {
  /** The path template of the document ("/tasks/{id}"). */
  template: string;
  /** Lower-case method. */
  method: string;
  /** Values of the path parameters, by name. */
  params: Record<string, string>;
  operation: OperationObject;
}

/* The slice of OpenAPI 3.0 this module reads. */
export interface OpenAPIDocument {
  openapi: string;
  paths: Record<string, Record<string, unknown>>;
  components?: { schemas?: Record<string, JsonSchema> };
}
export interface OperationObject {
  operationId?: string;
  responses: Record<string, ResponseObject>;
}
export interface ResponseObject {
  description?: string;
  headers?: Record<string, { required?: boolean; schema?: JsonSchema }>;
  content?: Record<string, { schema?: JsonSchema }>;
}
export type JsonSchema = Record<string, unknown>;

const METHODS = new Set(["get", "put", "post", "delete", "options", "head", "patch", "trace"]);

/** The repository root: the directory holding pnpm-workspace.yaml above this file. */
export function workspaceRoot(): string {
  let dir = import.meta.dirname;
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
    dir = dirname(dir);
  }
  throw new Error("@base/testing: pnpm-workspace.yaml not found above " + import.meta.url);
}

/** Absolute path of a file under api/ — the TypeSpec-emitted contracts. */
export function contractPath(rel: string): string {
  return isAbsolute(rel) ? rel : resolve(workspaceRoot(), "api", rel);
}

/**
 * Load the OpenAPI 3.0 document at api/<rel> (an absolute path is used as is).
 * Schemas are compiled lazily, once per (operation, status, media type).
 */
export function loadOpenAPI(rel: string): OpenAPIContract {
  const file = contractPath(rel);
  const document = parse(readFileSync(file, "utf8")) as OpenAPIDocument;
  if (typeof document !== "object" || document === null || !document.openapi?.startsWith("3.")) {
    throw new Error(`${file}: not an OpenAPI 3.x document`);
  }
  if (typeof document.paths !== "object" || document.paths === null) {
    throw new Error(`${file}: no paths`);
  }

  // OpenAPI 3.0 schemas are close to draft-07 with `nullable` on top; ajv is
  // run non-strict so the OpenAPI-only keywords (example, xml, …) are ignored.
  const ajv = new Ajv({ strict: false, allErrors: true });
  addFormats.default(ajv);
  const components = toJsonSchema(document.components?.schemas ?? {}) as Record<string, JsonSchema>;
  const compiled = new Map<string, ValidateFunction>();

  const compile = (key: string, schema: JsonSchema): ValidateFunction => {
    let fn = compiled.get(key);
    if (!fn) {
      // `$ref: '#/components/schemas/X'` resolves against the root, so the
      // (translated) components ride along with every compiled schema.
      fn = ajv.compile({
        ...(toJsonSchema(schema) as JsonSchema),
        components: { schemas: components },
      });
      compiled.set(key, fn);
    }
    return fn;
  };

  const resolveOp = (method: string, path: string): ResolvedOperation | undefined => {
    const m = method.toLowerCase();
    const target = splitPath(path);
    let best: ResolvedOperation | undefined;
    let bestLiterals = -1;
    for (const [template, item] of Object.entries(document.paths)) {
      const params = matchTemplate(template, target);
      if (!params) continue;
      const op = item[m];
      if (op === undefined || op === null || !METHODS.has(m)) continue;
      // Prefer the template with the most literal segments ("/tasks/all" over "/tasks/{id}").
      const literals = splitPath(template).filter((s) => !isParam(s)).length;
      if (literals > bestLiterals) {
        best = { template, method: m, params, operation: op as OperationObject };
        bestLiterals = literals;
      }
    }
    return best;
  };

  const validateSchema = (name: string, body: unknown): void => {
    const schema = document.components?.schemas?.[name];
    if (!schema) throw new Error(`components.schemas.${name} is not in the contract`);
    const fn = compile(`schema:${name}`, { $ref: `#/components/schemas/${name}` });
    if (!fn(body)) {
      throw new Error(
        `body does not match components.schemas.${name}:\n${describe(fn.errors)}\n${show(body)}`,
      );
    }
  };

  const validate = (
    method: string,
    path: string,
    status: number,
    body: unknown,
    headers: ResponseHeaders = {},
  ): void => {
    const label = `${method.toUpperCase()} ${path}`;
    const hit = resolveOp(method, path);
    if (!hit) throw new Error(`${label} is not in the contract`);
    const responses = hit.operation.responses ?? {};
    const response = responses[String(status)] ?? responses["default"];
    if (!response) {
      throw new Error(
        `${label} → ${status} is not declared for ${hit.method.toUpperCase()} ${hit.template} (declared: ${Object.keys(responses).join(", ") || "none"})`,
      );
    }
    const lower = lowerHeaders(headers);
    for (const [name, spec] of Object.entries(response.headers ?? {})) {
      if (spec.required && lower[name.toLowerCase()] === undefined) {
        throw new Error(`${label} → ${status}: required response header ${name} is missing`);
      }
    }
    const contentType = firstValue(lower["content-type"]);
    if (!response.content || Object.keys(response.content).length === 0) {
      if (isNonEmpty(body)) {
        throw new Error(`${label} → ${status} declares no body, got:\n${show(body)}`);
      }
      return;
    }
    if (!contentType)
      throw new Error(`${label} → ${status}: no Content-Type header on the response`);
    const mediaType = contentType.split(";")[0]!.trim().toLowerCase();
    const media = response.content[mediaType];
    if (!media) {
      throw new Error(
        `${label} → ${status}: content type ${mediaType} is not declared (declared: ${Object.keys(response.content).join(", ")})`,
      );
    }
    if (!media.schema) return;
    const decoded = decodeBody(body, mediaType, label, status);
    const fn = compile(`${hit.method} ${hit.template} ${status} ${mediaType}`, media.schema);
    if (!fn(decoded)) {
      throw new Error(
        `${label} → ${status} does not match the contract (${hit.method.toUpperCase()} ${hit.template}):\n${describe(fn.errors)}\n${show(decoded)}`,
      );
    }
  };

  return { document, validate, validateSchema, resolve: resolveOp };
}

/* ── helpers ────────────────────────────────────────────────────────────── */

function splitPath(path: string): string[] {
  const clean = path.split("?")[0]!.split("#")[0]!;
  return clean.split("/").filter((s) => s.length > 0);
}

function isParam(segment: string): boolean {
  return segment.startsWith("{") && segment.endsWith("}");
}

/** Path parameter values when `template` matches `target`, else undefined. */
function matchTemplate(template: string, target: string[]): Record<string, string> | undefined {
  const parts = splitPath(template);
  if (parts.length !== target.length) return undefined;
  const params: Record<string, string> = {};
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]!;
    const t = target[i]!;
    if (isParam(p)) {
      if (t.length === 0) return undefined;
      params[p.slice(1, -1)] = safeDecode(t);
    } else if (p !== t) {
      return undefined;
    }
  }
  return params;
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/**
 * OpenAPI 3.0 → JSON Schema (draft-07 as ajv 8 reads it): `nullable: true`
 * becomes a null union (`anyOf` around the schema, which also covers a
 * nullable `allOf`/`$ref`); everything else passes through, recursively.
 */
export function toJsonSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map((item) => toJsonSchema(item));
  if (typeof schema !== "object" || schema === null) return schema;
  const out: Record<string, unknown> = {};
  let nullable = false;
  for (const [k, v] of Object.entries(schema as Record<string, unknown>)) {
    if (k === "nullable") {
      nullable = v === true;
      continue;
    }
    out[k] = toJsonSchema(v);
  }
  if (!nullable) return out;
  if (typeof out["type"] === "string" && !("allOf" in out) && !("$ref" in out)) {
    out["type"] = [out["type"], "null"];
    if (Array.isArray(out["enum"]) && !out["enum"].includes(null))
      out["enum"] = [...(out["enum"] as unknown[]), null];
    return out;
  }
  return { anyOf: [out, { type: "null" }] };
}

function lowerHeaders(
  headers: ResponseHeaders,
): Record<string, string | number | string[] | undefined> {
  const out: Record<string, string | number | string[] | undefined> = {};
  for (const [k, v] of Object.entries(headers)) out[k.toLowerCase()] = v;
  return out;
}

function firstValue(v: string | number | string[] | undefined): string | undefined {
  if (v === undefined) return undefined;
  if (Array.isArray(v)) return v[0];
  return String(v);
}

function isNonEmpty(body: unknown): boolean {
  if (body === undefined || body === null) return false;
  if (typeof body === "string" || Buffer.isBuffer(body)) return body.length > 0;
  return true;
}

function decodeBody(body: unknown, mediaType: string, label: string, status: number): unknown {
  if (Buffer.isBuffer(body)) body = body.toString("utf8");
  if (typeof body !== "string") return body;
  if (!/[/+]json$/u.test(mediaType)) return body;
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new Error(`${label} → ${status}: body is not JSON (${mediaType}):\n${body}`);
  }
}

function describe(errors: ErrorObject[] | null | undefined): string {
  return (errors ?? [])
    .map((e) => `  ${e.instancePath || "/"} ${e.message ?? ""} ${JSON.stringify(e.params)}`)
    .join("\n");
}

function show(body: unknown): string {
  const s = typeof body === "string" ? body : JSON.stringify(body, null, 2);
  return s === undefined ? String(body) : s.length > 2000 ? s.slice(0, 2000) + "…" : s;
}
