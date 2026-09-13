# @base/contracts

TypeScript types of the HTTP contract, generated from the OpenAPI document:

```
api/tsp/*.tsp ─tsp compile─▶ api/openapi3/tasks.openapi.yaml ─openapi-typescript─▶ src/tasksapi.gen.ts
```

- `src/tasksapi.gen.ts` is **generated — never edit it**. Change the TypeSpec
  under `api/tsp`, run `just contracts`, commit the result; the `contracts` CI
  job fails when the committed file is stale. `.gen.ts` files are ignored by
  oxlint (`.oxlintrc.json` here) and formatted by the generator step, the way
  the Go sibling excludes `.gen.go`.
- `src/index.ts` re-exports `paths` / `components` / `operations` and names the
  schemas (`Task`, `TaskListPage`, `CreateTask`, `UpdateTask`, `ArchiveTask`,
  `Problem`, `HealthStatus`, …).

Types only: nothing is emitted at runtime, so it is safe to depend on from a
client, a test or an app. Runtime validation of the same contract lives in
`@base/testing` (`loadOpenAPI`) for tests and in the app's zod DTOs.
