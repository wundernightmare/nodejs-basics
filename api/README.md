# api — the HTTP contract

[TypeSpec](https://typespec.io) sources under `tsp/` are the source of truth
for the HTTP API of `apps/api`; everything else is generated:

```
api/tsp/*.tsp ─tsp compile─▶ api/openapi3/tasks.openapi.yaml ─openapi-typescript─▶ packages/contracts/src/tasksapi.gen.ts
```

- `just contracts` regenerates both outputs (commit them);
- `just contracts-check` fails when they are stale or when `oasdiff` finds a
  breaking change against master (waivers: `oasdiff-breaking.ignore`);
- `apps/api/src/app.contract.integration.spec.ts` validates every response of
  the running app against the document (`loadOpenAPI` in `@base/testing`);
- `just schemathesis` drives the built app with requests generated from it.

Never edit `openapi3/` or the `.gen.ts` by hand — see README "Contracts".
