# Architecture

This document describes the layering of `tm1-mcp-server`. It is the source of
truth for any contributor adding TM1 calls or new tools.

## Layers

```
┌──────────────────────────────────────────────┐
│  src/index.ts            MCP server + wiring │  stdio + Streamable HTTP
│  - registers tools, prompts, resources        │  TM1_MODE gate (see below)
└──────────────────────┬───────────────────────┘
                       │ tools call
                       ▼
┌──────────────────────────────────────────────┐
│  src/tools/**            MCP tool surface     │  111 tools, one file each
│  (Zod schemas, MCP envelopes, validation)     │  (+ prompts, resources)
└──────────────────────┬───────────────────────┘
                       │ uses
                       ▼
┌──────────────────────────────────────────────┐
│  src/tm1-client.ts       TM1Client facade     │  connection lifecycle only
│  - readonly cubes:     CubeService            │  (connect / disconnect)
│  - readonly dimensions:DimensionService …     │  everything else delegated
│  - 13 domain services (see below)             │  to a service
└──────────────────────┬───────────────────────┘
                       │ delegates to
                       ▼
┌──────────────────────────────────────────────┐
│  src/tm1-client/services/                     │  domain-scoped REST wrappers
│  - cube-service.ts                            │  (TM1py-style — see below)
│  - dimension-service.ts                       │
│  - process-service.ts                         │
│  - cell-service.ts                            │
│  - …                                          │
└──────────────────────┬───────────────────────┘
                       │ uses
                       ▼
┌──────────────────────────────────────────────┐
│  src/tm1-client/http.ts     TM1HttpClient     │  transport
│  - request<T>() / requestRaw()                │  auth, retry, error mapping
│  - executeRequest() (private)                 │
└──────────────────────┬───────────────────────┘
                       │ uses
                       ▼
┌──────────────────────────────────────────────┐
│  src/session-manager.ts                       │  cookie auth + keepalive
│  src/tm1-client/dispatcher.ts                 │  undici TLS dispatcher
└──────────────────────────────────────────────┘
```

## Transports and the readonly/readwrite gate

`src/index.ts` is the entry point. It builds one `McpServer`, registers the
tools/prompts/resources, and connects it to a transport:

| Transport            | When                                  | Notes                                              |
|----------------------|---------------------------------------|----------------------------------------------------|
| **stdio** (default)  | local Claude Code / Claude Desktop    | `StdioServerTransport`                              |
| **Streamable HTTP**  | `TM1_MCP_TRANSPORT=http`             | stateless JSON, single `POST /mcp`, optional bearer token |

Tool registration is gated by `config.mode` (env `TM1_MODE`):

- **`readonly` (default)** — write and destructive tools are never registered,
  so the server cannot mutate or delete anything.
- **`readwrite`** — the full lifecycle (cell writes, cube/dimension/process
  deletion, TI execution) is registered. Opt in explicitly.

Each tool declares its mutating nature via `src/tools/with-annotations.ts`
(`readOnlyHint` / `destructiveHint`); the gate in `index.ts` uses that to decide
what to register.

## Service-class pattern (TM1py-style)

Each domain owns one service class under `src/tm1-client/services/`. The
class holds a single `TM1HttpClient` reference and exposes domain methods
as plain async functions. The pattern follows TM1py's `RestService` +
domain services (`CubeService`, `DimensionService`, `ProcessService`, …).

The 13 services wired into `TM1Client`: `cubes`, `dimensions`, `hierarchies`,
`cells`, `views`, `subsets`, `elements`, `processes`, `chores`, `security`,
`server`, `monitoring`, `files`.

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

**Init order is load-bearing where one service depends on another.**
`ElementService` takes `CellService` (`new ElementService(this, this.cells)`),
so `this.cells` must be assigned first. TypeScript types the field as defined
and will *not* catch a reorder that leaves it `undefined` at construction time,
so the constructor asserts `this.cells` before wiring `elements`. Keep
dependency-bearing services after the ones they consume, or the assert throws.

`TM1Client` holds **no** flat pass-through methods. Tools always reach TM1
through a service (`client.cubes.list()`, `client.processes.execute()`, …).
The `lint:no-flat-api` CI gate fails the build if a flat-client TM1 call is
reintroduced.

The same gate also forbids tools under `src/tools/**` from calling the raw
transport (`.request()` / `.requestRaw()` / `.requestBinary()`) directly.
Hand-rolling OData in a tool bypasses the service layer and reimplements
paging, OData-quote escaping, and version branches that belong in a service.
If a tool needs a call no service exposes yet, add the method to the relevant
service (e.g. `ElementService.scanElementNames`) and call that.

## Why service-composition instead of mixins or inheritance

| Pattern                  | Pro                              | Con                                      |
|--------------------------|----------------------------------|------------------------------------------|
| Inheritance chain        | Zero call-site diff              | 7-deep extends becomes opaque            |
| TS function-mixins       | Zero call-site diff              | Method-name collision risk, hard to mock |
| **Service-composition**  | TM1py-parity, sharp domain edges | One-time call-site migration cost        |

The service-composition path was chosen because:

1. The MCP server is targeted as a long-lived standard (multi-team,
   multi-year). Long-term DX wins beat short-term migration cost.
2. TM1py's API (`tm1.cubes.get()`, `tm1.processes.execute()`) is well
   known to TM1 developers — same mental model = lower onboarding cost.
3. Services are independently mockable (`vi.spyOn(client.cubes, …)`),
   isolating tests from unrelated domains.
4. Adding a new domain is a new file plus a constructor line; no
   existing file needs to be touched.
