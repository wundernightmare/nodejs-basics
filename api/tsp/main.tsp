// The tasks service: the HTTP contract of apps/api. One OpenAPI document
// (api/openapi3/tasks.openapi.yaml) is emitted from this entry point;
// tasks.tsp and health.tsp contribute to the same `Tasks` namespace.
import "@typespec/http";
import "@typespec/openapi";

import "./health.tsp";
import "./tasks.tsp";

using TypeSpec.Http;

/**
 * Tasks — the HTTP contract of apps/api.
 *
 * This file tree is the source of truth: the OpenAPI document (api/openapi3),
 * the TypeScript types (packages/contracts) and the response validation in the
 * tests are generated from it. Change the contract here, run `just contracts`,
 * and the compiler tells you which handler no longer fits.
 *
 * Errors are RFC 9457 problem details (application/problem+json); every error
 * response is a `Problem`.
 */
@service(#{ title: "Tasks" })
@server("http://localhost:3000", "local")
@OpenAPI.info(#{ version: "1.0.0" })
namespace Tasks;
