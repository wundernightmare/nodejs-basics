import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { contractPath, loadOpenAPI, toJsonSchema, workspaceRoot } from "./contracts.js";
import { meta, testCase } from "./meta.js";

/**
 * A minimal OpenAPI 3.0 document with the shapes the validator has to
 * handle: a path template, a problem response, a nullable member (3.0
 * `nullable`), a required response header, a bodiless status.
 */
const DOC = `
openapi: 3.0.0
info: { title: t, version: "1" }
paths:
  /things:
    get:
      responses:
        '200':
          description: ok
          content:
            application/json:
              schema: { type: array, items: { $ref: '#/components/schemas/Thing' } }
  /things/{id}:
    get:
      responses:
        '200':
          description: ok
          headers:
            X-Cache: { required: true, schema: { type: string } }
          content:
            application/json:
              schema: { $ref: '#/components/schemas/Thing' }
        '404':
          description: nope
          content:
            application/problem+json:
              schema: { $ref: '#/components/schemas/Problem' }
    delete:
      responses:
        '204': { description: gone }
  /things/all:
    get:
      responses:
        '200':
          description: ok
          content:
            application/json:
              schema: { type: object, required: [all], properties: { all: { type: boolean } } }
components:
  schemas:
    Thing:
      type: object
      required: [id, note]
      properties:
        id: { type: string, pattern: '^[a-z]+$' }
        note: { type: string, nullable: true }
        kind: { type: string, enum: [a, b], nullable: true }
    Problem:
      type: object
      required: [type, title, status]
      properties:
        type: { type: string }
        title: { type: string }
        status: { type: integer, minimum: 100, maximum: 599 }
`;

const dir = mkdtempSync(join(tmpdir(), "contracts-"));
const file = join(dir, "things.openapi.yaml");
writeFileSync(file, DOC);
const contract = loadOpenAPI(file);
const json = { "content-type": "application/json; charset=utf-8" };
const problem = { "content-type": "application/problem+json" };

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("loadOpenAPI", () => {
  meta({
    epic: "nodejs-basics",
    feature: "test harness",
    owner: "@team-platform",
    tags: ["testing", "contracts", "unit"],
  });

  it("resolves paths under api/ of the workspace, or an absolute path", async () => {
    await testCase("NB-610", "contract files are addressed relative to api/");
    expect(contractPath("openapi3/x.yaml")).toBe(
      join(workspaceRoot(), "api", "openapi3", "x.yaml"),
    );
    expect(contractPath(file)).toBe(file);
  });

  it("matches a path template and accepts a conforming response", async () => {
    await testCase("NB-611", "a conforming exchange passes");
    const hit = contract.resolve("GET", "/things/abc?x=1");
    expect(hit?.template).toBe("/things/{id}");
    expect(hit?.params).toEqual({ id: "abc" });
    expect(() =>
      contract.validate("GET", "/things/abc", 200, JSON.stringify({ id: "abc", note: null }), {
        ...json,
        "x-cache": "hit",
      }),
    ).not.toThrow();
    // Buffers and already-parsed bodies are accepted too.
    expect(() =>
      contract.validate(
        "get",
        "/things/abc",
        200,
        { id: "abc", note: "n", kind: null },
        { ...json, "X-Cache": "miss" },
      ),
    ).not.toThrow();
  });

  it("prefers the literal path over the template", async () => {
    await testCase("NB-612", "/things/all is its own operation");
    expect(contract.resolve("GET", "/things/all")?.template).toBe("/things/all");
    expect(() => contract.validate("GET", "/things/all", 200, { all: true }, json)).not.toThrow();
  });

  it("rejects an exchange the contract does not describe", async () => {
    await testCase(
      "NB-613",
      "unknown route, status, content type, header and body shape are reported",
    );
    expect(() => contract.validate("GET", "/nope", 200, {}, json)).toThrow(/not in the contract/u);
    expect(() => contract.validate("POST", "/things", 201, {}, json)).toThrow(
      /not in the contract/u,
    );
    expect(() => contract.validate("GET", "/things/abc", 500, {}, problem)).toThrow(
      /500 is not declared/u,
    );
    expect(() =>
      contract.validate(
        "GET",
        "/things/abc",
        404,
        { type: "about:blank", title: "Not Found", status: 404 },
        json,
      ),
    ).toThrow(/content type application\/json is not declared/u);
    expect(() =>
      contract.validate("GET", "/things/abc", 200, { id: "abc", note: null }, json),
    ).toThrow(/required response header X-Cache is missing/u);
    expect(() =>
      contract.validate(
        "GET",
        "/things/abc",
        200,
        { id: "ABC", note: 1 },
        { ...json, "x-cache": "hit" },
      ),
    ).toThrow(/does not match the contract/u);
    expect(() =>
      contract.validate("GET", "/things/abc", 200, "{oops", { ...json, "x-cache": "hit" }),
    ).toThrow(/not JSON/u);
    expect(() => contract.validate("DELETE", "/things/abc", 204, "", {})).not.toThrow();
    expect(() => contract.validate("DELETE", "/things/abc", 204, "{}", {})).toThrow(
      /declares no body/u,
    );
  });

  it("validates a body against a named component schema", async () => {
    await testCase("NB-614", "an error body for an undeclared route is still a Problem");
    expect(() =>
      contract.validateSchema("Problem", { type: "about:blank", title: "x", status: 404 }),
    ).not.toThrow();
    expect(() => contract.validateSchema("Problem", { title: "x" })).toThrow(
      /components.schemas.Problem/u,
    );
    expect(() => contract.validateSchema("Nope", {})).toThrow(/not in the contract/u);
  });

  it("translates OpenAPI 3.0 nullable into a JSON Schema null union", async () => {
    await testCase("NB-615", "nullable becomes a type/enum union or an anyOf around a reference");
    expect(toJsonSchema({ type: "string", nullable: true })).toEqual({ type: ["string", "null"] });
    expect(toJsonSchema({ type: "string", enum: ["a"], nullable: true })).toEqual({
      type: ["string", "null"],
      enum: ["a", null],
    });
    expect(toJsonSchema({ allOf: [{ $ref: "#/x" }], nullable: true })).toEqual({
      anyOf: [{ allOf: [{ $ref: "#/x" }] }, { type: "null" }],
    });
    expect(toJsonSchema({ type: "string", nullable: false })).toEqual({ type: "string" });
  });

  it("loads the committed tasks contract", async () => {
    await testCase("NB-616", "api/openapi3/tasks.openapi.yaml is a usable OpenAPI 3.0 document");
    const tasks = loadOpenAPI("openapi3/tasks.openapi.yaml");
    expect(Object.keys(tasks.document.paths)).toEqual(
      expect.arrayContaining(["/health", "/tasks", "/tasks/{id}", "/tasks/{id}/archive"]),
    );
    expect(tasks.resolve("PATCH", "/tasks/abc")?.operation.operationId).toBe("TasksOps_update");
    expect(() =>
      tasks.validate(
        "GET",
        "/health",
        200,
        {
          status: "ok",
          service: "api",
          env: "test",
          uptimeSeconds: 1,
          timestamp: new Date().toISOString(),
        },
        json,
      ),
    ).not.toThrow();
  });
});
