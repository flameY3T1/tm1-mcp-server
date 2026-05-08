# Architecture

This document describes the layering of `tm1-mcp-server` and the active
god-class refactor (review item #5). It is the source of truth for any
contributor adding TM1 calls or new tools.

## Layers

```
┌──────────────────────────────────────────────┐
│  src/tools/**            MCP tool surface    │  98 tools, one file each
│  (Zod schemas, MCP envelopes, validation)    │
└──────────────────────┬───────────────────────┘
                       │ uses
                       ▼
┌──────────────────────────────────────────────┐
│  src/tm1-client.ts       TM1Client facade    │  thin pass-through
│  - readonly cubes:     CubeService           │
│  - readonly dimensions:DimensionService …    │  (added incrementally)
│  - getCubes() etc.     @deprecated wrappers  │  removed in 2.0
└──────────────────────┬───────────────────────┘
                       │ delegates to
                       ▼
┌──────────────────────────────────────────────┐
│  src/tm1-client/services/                    │  domain-scoped REST wrappers
│  - cube-service.ts                           │  (TM1py-style — see below)
│  - dimension-service.ts                      │
│  - process-service.ts                        │
│  - cell-service.ts                           │
│  - …                                         │
└──────────────────────┬───────────────────────┘
                       │ uses
                       ▼
┌──────────────────────────────────────────────┐
│  src/tm1-client/http.ts     TM1HttpClient    │  transport
│  - request<T>() / requestRaw()               │  auth, retry, error mapping
│  - executeRequest() (private)                │
└──────────────────────┬───────────────────────┘
                       │ uses
                       ▼
┌──────────────────────────────────────────────┐
│  src/session-manager.ts                      │  cookie auth + keepalive
│  src/tm1-client/dispatcher.ts                │  undici TLS dispatcher
└──────────────────────────────────────────────┘
```

## Service-class pattern (TM1py-style)

Each domain owns one service class under `src/tm1-client/services/`. The
class holds a single `TM1HttpClient` reference and exposes domain methods
as plain async functions. Pattern is patterned on TM1py's `RestService` +
domain services (`CubeService`, `DimensionService`, `ProcessService`, …).

### Authoring a new service

```ts
// src/tm1-client/services/cube-service.ts
import type { TM1HttpClient } from "../http.js";

export class CubeService {
  constructor(private readonly http: TM1HttpClient) {}

  async list(opts?: { … }): Promise<Cube[]> {
    const response = await this.http.request<…>("GET", "/api/v1/Cubes?…");
    return response.value.map(…);
  }
}
```

Key conventions:

| Concern               | Convention                                                      |
|-----------------------|-----------------------------------------------------------------|
| Constructor           | `constructor(private readonly http: TM1HttpClient)`             |
| Method names          | Domain-scoped — `list()`, not `listCubes()`. Prefix is implicit |
| Long-running calls    | Accept `opts?: { timeoutMs?: number }` and pass to `request()`  |
| Logging               | Use `this.http.logger` for warnings only — keep services quiet  |
| Version branches      | `if (this.http.config.tm1Version.startsWith("11"))`             |
| Helpers               | Private methods on the service (e.g. `clearViaTI`)              |
| State                 | None. Services are stateless wrappers.                          |

### Wiring a service into TM1Client

```ts
// src/tm1-client.ts
export class TM1Client extends TM1HttpClient {
  readonly cubes: CubeService;

  constructor(config, sessionManager, logger) {
    super(config, sessionManager, logger);
    this.cubes = new CubeService(this);
  }
}
```

`new CubeService(this)` is safe because `this` is a `TM1HttpClient` —
TypeScript accepts the upcast since `TM1Client extends TM1HttpClient`.
The service does not see `TM1Client`-specific surface, only HTTP transport.

### Deprecated flat methods during migration

Until Phase 2–8 of the refactor are complete, the legacy flat methods on
`TM1Client` (`getCubes`, `executeProcess`, …) remain for backwards
compatibility with the 98 tool files. They are JSDoc-marked
`@deprecated`, with a one-line wrapper delegating to the service:

```ts
/** @deprecated Use `client.cubes.list(opts)` instead. Removed in 2.0. */
async getCubes(opts) {
  return this.cubes.list(opts);
}
```

## Migration roadmap

Tracked as backlog item #5 (see `docs/ROADMAP.md`).

| Phase | Scope                                                              | Status            |
|-------|--------------------------------------------------------------------|-------------------|
| 1     | Introduce `services/` directory + `CubeService` (exemplar pattern) | DONE 2026-05-08   |
| 1.1   | `DimensionService`, `HierarchyService`, `ElementService`           | DONE 2026-05-08   |
| 1.2   | `CellService`, `ViewService`, `SubsetService`                      | DONE 2026-05-08   |
| 1.3   | `ProcessService`, `ChoreService`                                   | DONE 2026-05-08   |
| 1.4   | `SecurityService`, `ServerService`, `MonitoringService`            | DONE 2026-05-08   |
| 1.5   | `FileService` (callgraph stays as `processes.fetchForCallgraph`)   | DONE 2026-05-08   |
| 2–8   | Migrate tool-files domain by domain to call services directly      | TODO (one PR each) |
| 9     | Mark flat methods `@deprecated`, add `lint:no-flat-api` CI gate    | DONE 2026-05-08   |
| 10    | Remove flat methods, release 2.0                                   | DONE 2026-05-08   |

Each Phase 1.x adds new service files; flat methods on `TM1Client` are
added/converted to wrappers in the same PR. Tool files do not change
during Phase 1 — that happens in Phase 2–8.

## Why service-composition instead of mixins or inheritance

| Pattern                  | Pro                              | Con                                      |
|--------------------------|----------------------------------|------------------------------------------|
| Inheritance chain        | Zero call-site diff              | 7-deep extends becomes opaque            |
| TS function-mixins       | Zero call-site diff              | Method-name collision risk, hard to mock |
| **Service-composition**  | TM1py-parity, sharp domain edges | One-time call-site migration cost        |

The service-composition path was chosen because:

1. The MCP server is targeted as an enterprise standard (multi-team,
   multi-year). Long-term DX wins beat short-term migration cost.
2. TM1py's API (`tm1.cubes.get()`, `tm1.processes.execute()`) is well
   known to TM1 developers — same mental model = lower onboarding cost.
3. Services are independently mockable (`vi.spyOn(client.cubes, …)`),
   isolating tests from unrelated domains.
4. Adding a new domain is a new file plus a constructor line; no
   existing file needs to be touched.
