import { describe, it, expect, vi } from "vitest";
import { ListResourcesRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import {
  installPaginatedListHandler,
  __testing,
  DEFAULT_PAGE_SIZE,
  type ResourceCatalog,
  type CatalogResource,
} from "../../src/resources/list-handler.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const mockLogger = {
  info: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
  fatal: vi.fn(),
  trace: vi.fn(),
  child: vi.fn().mockReturnThis(),
  level: "silent",
  flush: vi.fn(),
} as unknown as import("pino").Logger;

function staticEntry(uri: string, name: string): CatalogResource {
  return { uri, name, mimeType: "application/json" };
}

function makeCatalog(items: CatalogResource[]): ResourceCatalog {
  return {
    entries: items.map((r) => ({ kind: "static", resource: r })),
  };
}

describe("R2-07: cursor encode/decode round-trip", () => {
  it("encodes and decodes an offset symmetrically", () => {
    const cursor = __testing.encodeCursor(42);
    expect(__testing.decodeCursor(cursor)).toBe(42);
  });

  it("handles offset 0", () => {
    const cursor = __testing.encodeCursor(0);
    expect(__testing.decodeCursor(cursor)).toBe(0);
  });

  it("decodes undefined as 0", () => {
    expect(__testing.decodeCursor(undefined)).toBe(0);
  });

  it("decodes garbage cursor as 0 (degrade to fresh listing)", () => {
    expect(__testing.decodeCursor("not-base64-at-all!!!")).toBe(0);
    expect(__testing.decodeCursor(Buffer.from("not-json", "utf8").toString("base64url"))).toBe(0);
  });

  it("decodes negative offset as 0", () => {
    const cursor = __testing.encodeCursor(-5);
    expect(__testing.decodeCursor(cursor)).toBe(0);
  });
});

describe("R2-07: resolveAll", () => {
  it("merges statics and template results, sorted by URI", async () => {
    const catalog: ResourceCatalog = {
      entries: [
        { kind: "static", resource: staticEntry("tm1://server/state", "state") },
        {
          kind: "template",
          templateMetadata: { mimeType: "application/json" },
          list: async () => ({
            resources: [
              staticEntry("tm1://process/Alpha/code", "alpha"),
              staticEntry("tm1://process/Beta/code", "beta"),
            ],
          }),
        },
        { kind: "static", resource: staticEntry("tm1://server/info", "info") },
      ],
    };
    const all = await __testing.resolveAll(catalog);
    expect(all.map((r) => r.uri)).toEqual([
      "tm1://process/Alpha/code",
      "tm1://process/Beta/code",
      "tm1://server/info",
      "tm1://server/state",
    ]);
  });
});

describe("R2-07: installPaginatedListHandler", () => {
  function setupHandler(items: CatalogResource[], pageSize?: number) {
    let handler: ((req: unknown) => Promise<unknown>) | undefined;
    const fakeServer = {
      server: {
        setRequestHandler: (schema: unknown, h: (req: unknown) => Promise<unknown>) => {
          if (schema === ListResourcesRequestSchema) handler = h;
        },
      },
    } as unknown as McpServer;
    installPaginatedListHandler(fakeServer, makeCatalog(items), mockLogger, pageSize);
    if (!handler) throw new Error("handler not installed");
    return handler;
  }

  function items(n: number): CatalogResource[] {
    return Array.from({ length: n }, (_, i) =>
      staticEntry(`tm1://test/${String(i).padStart(4, "0")}`, `r${i}`),
    );
  }

  it("returns all results in one page when total <= pageSize", async () => {
    const handler = setupHandler(items(50), 200);
    const res = (await handler({ params: {} })) as { resources: CatalogResource[]; nextCursor?: string };
    expect(res.resources).toHaveLength(50);
    expect(res.nextCursor).toBeUndefined();
  });

  it("emits nextCursor when more results remain", async () => {
    const handler = setupHandler(items(500), 200);
    const res = (await handler({ params: {} })) as { resources: CatalogResource[]; nextCursor?: string };
    expect(res.resources).toHaveLength(200);
    expect(res.nextCursor).toBeTypeOf("string");
  });

  it("paginates correctly across multiple cursor follow-up calls", async () => {
    const handler = setupHandler(items(450), 200);
    const all: CatalogResource[] = [];
    let cursor: string | undefined;

    const p1 = (await handler({ params: {} })) as { resources: CatalogResource[]; nextCursor?: string };
    all.push(...p1.resources);
    cursor = p1.nextCursor;
    expect(cursor).toBeTypeOf("string");

    const p2 = (await handler({ params: { cursor } })) as { resources: CatalogResource[]; nextCursor?: string };
    all.push(...p2.resources);
    cursor = p2.nextCursor;
    expect(cursor).toBeTypeOf("string");

    const p3 = (await handler({ params: { cursor } })) as { resources: CatalogResource[]; nextCursor?: string };
    all.push(...p3.resources);
    expect(p3.nextCursor).toBeUndefined();

    expect(all).toHaveLength(450);
    const uris = all.map((r) => r.uri);
    expect(new Set(uris).size).toBe(450);
  });

  it("default page size is 200", () => {
    expect(DEFAULT_PAGE_SIZE).toBe(200);
  });

  it("treats malformed cursor as offset 0", async () => {
    const handler = setupHandler(items(10), 5);
    const res = (await handler({ params: { cursor: "garbage" } })) as {
      resources: CatalogResource[];
      nextCursor?: string;
    };
    expect(res.resources).toHaveLength(5);
    expect(res.resources[0].uri).toBe("tm1://test/0000");
  });
});
