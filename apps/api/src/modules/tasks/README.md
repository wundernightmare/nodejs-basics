# tasks module — hexagonal example

A worked example showing every layer pattern the template recommends.
Copy this folder, rename, replace business logic. The pieces:

```
domain/
  task.entity.ts             pure data, const enum for status, version field
  task.errors.ts             DomainError subclasses (TaskNotFoundError, ...)
  task.repository.port.ts    interface + Symbol DI token

application/
  task.use-case.ts           writes — IUnitOfWork sandwich, throws domain errors
  task.query.service.ts      reads — bypass entities, go straight to PG_POOL

infrastructure/
  sql-task.repository.ts     pg-based, withTx + db() helpers, optimistic lock
  tasks-schema.bootstrap.ts  CREATE TABLE IF NOT EXISTS — replace with migrations

http/
  tasks.dto.ts               createZodDto from nestjs-zod
  tasks.controller.ts        Idempotent on create, throws domain errors

tasks.tokens.ts              DI tokens that aren't repository ports
tasks.module.ts              wires everything (useClass + useFactory examples)
```

## Layer rules

```
http  →  application  →  domain  ↑  infrastructure
                                 (implements ports defined in domain)
```

- **domain** has no NestJS, no HTTP, no DB imports. Pure data + behaviour.
- **application** imports domain and ports. Throws domain errors, never HTTP.
- **infrastructure** imports domain (to satisfy ports) but never application.
- **http** imports application + DTOs. Never imports infrastructure directly.

## Provider patterns shown

| Pattern | Where | Why |
|---|---|---|
| `useClass` for port → impl | `tasks.module.ts` (TASK_REPOSITORY) | The use case knows the port; only the module decides which adapter |
| `useFactory` for config-derived values | `tasks.module.ts` (TASK_LIST_PAGE_SIZE) | Compute once at boot from ConfigService; consumers inject the value |
| Lifecycle hook (`OnApplicationBootstrap`) | `tasks-schema.bootstrap.ts` | One-shot side effect at startup |

## Transaction sandwich

```ts
async update(id, expectedVersion, patch) {
  return this.uow.runInTransaction(async () => {  // ← transactionStorage.run
    const existing = await this.repo.findById(id); // ← repo's db() picks up tx
    if (!existing) throw new TaskNotFoundError(id);
    return this.repo.update(id, expectedVersion, patch); // same tx
  });
}
```

Both the existence check and the update happen inside one transaction, so a
concurrent request cannot delete the row between them.

The repository's `update` adds `WHERE version = $expected` so a concurrent
update bumps the counter and our row count comes back zero — translated to
`OptimisticLockConflictError` (HTTP 409).

## Try it

```sh
just deps && just dev    # one terminal — boots :3000 + :9090

# Create — idempotent:
curl -i -X POST http://localhost:3000/tasks \
  -H 'Idempotency-Key: 11111111-1111-1111-1111-111111111111' \
  -H 'Content-Type: application/json' \
  -d '{"title":"first","description":"hello"}'

# List
curl http://localhost:3000/tasks

# Update (note expectedVersion comes from the prior response)
curl -X PATCH http://localhost:3000/tasks/<id> \
  -H 'Content-Type: application/json' \
  -d '{"title":"renamed","expectedVersion":0}'

# Archive
curl -X POST http://localhost:3000/tasks/<id>/archive \
  -H 'Content-Type: application/json' \
  -d '{"expectedVersion":1}'
```

Replay the create with the same Idempotency-Key — you get the cached response
plus `X-Idempotent-Replayed: true`.

Send a stale `expectedVersion` — you get `409 Conflict` as
`application/problem+json` with the OptimisticLockConflictError detail.

## What to delete when you adapt this

- `tasks-schema.bootstrap.ts` — replace with proper migrations.
- The `queryFindById` shortcut at the bottom of `tasks.controller.ts` —
  push that into TaskQueryService as a real `findById` method.
- The whole module — start over with your domain.
