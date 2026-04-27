# health module

Smallest possible NestJS module — a controller, a service, no DB, no DI tokens.

## What it shows

| Concept | Where |
|---|---|
| `@Module()` registers routes + providers | `health.module.ts` |
| `@Injectable()` service receives ConfigService via constructor | `health.service.ts` |
| `@Controller("health")` + `@Get()` route | `health.controller.ts` |

## Try it

```sh
just deps && just dev
curl http://localhost:3000/health
```

```json
{
  "status": "ok",
  "service": "app",
  "env": "development",
  "uptimeSeconds": 12,
  "timestamp": "2026-04-27T08:42:00.000Z"
}
```

## Why a separate `/health` instead of using `/livez`?

`/livez` and `/readyz` (on the admin server, port 9090) are infrastructure
probes — minimal, dependency-free, called by Kubernetes. This `/health` route
is on the public API port and is for app-side reporting.
