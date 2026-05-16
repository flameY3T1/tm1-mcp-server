// R2-07: cursor-based pagination for resources/list.
//
// The high-level McpServer.registerResource registers a default
// ListResourcesRequestSchema handler that ignores `params.cursor` and strips
// `nextCursor` from the result (SDK 1.29.0). For TM1 servers with thousands
// of processes/cubes that single-shot response can overflow client buffers
// and is not spec-compliant.
//
// This module installs a replacement handler on the underlying Server,
// driven by a typed catalog populated by registerAllResources. The replaced
// handler still defers to template list callbacks for dynamic resources but
// adds opaque cursor pagination on top.
//
// Cursor format: base64url-encoded JSON `{ "o": <offset> }`. Opaque to the
// client by spec; we only need it to be self-contained and stable across
// requests so we don't need server-side state.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ListResourcesRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type pino from "pino";

export interface CatalogResource {
  uri: string;
  name: string;
  title?: string;
  description?: string;
  mimeType?: string;
}

export interface StaticCatalogEntry {
  kind: "static";
  resource: CatalogResource;
}

export interface TemplateCatalogEntry {
  kind: "template";
  templateMetadata: { title?: string; description?: string; mimeType?: string };
  list: () => Promise<{ resources: CatalogResource[] }>;
}

export type CatalogEntry = StaticCatalogEntry | TemplateCatalogEntry;

export interface ResourceCatalog {
  entries: CatalogEntry[];
}

export const DEFAULT_PAGE_SIZE = 200;

function encodeCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ o: offset }), "utf8").toString("base64url");
}

// Returns offset >= 0 or 0 when the cursor is malformed / out-of-range.
// Per spec malformed cursors → InvalidParams; we treat them as "start over"
// so a stale cursor degrades to a fresh listing rather than an error storm.
function decodeCursor(cursor: string | undefined): number {
  if (!cursor) return 0;
  try {
    const json = Buffer.from(cursor, "base64url").toString("utf8");
    const parsed = JSON.parse(json) as { o?: unknown };
    const offset = typeof parsed.o === "number" ? parsed.o : 0;
    return offset >= 0 ? offset : 0;
  } catch {
    return 0;
  }
}

// Resolve the full sorted resource list. Template list callbacks fire in
// parallel; static entries pass through. Sorting by URI gives stable paging
// across requests even if a template adds/removes entries between pages.
async function resolveAll(catalog: ResourceCatalog): Promise<CatalogResource[]> {
  const statics: CatalogResource[] = [];
  const templatePromises: Promise<CatalogResource[]>[] = [];

  for (const entry of catalog.entries) {
    if (entry.kind === "static") {
      statics.push(entry.resource);
    } else {
      templatePromises.push(
        entry.list().then((r) =>
          r.resources.map((res) => ({
            ...entry.templateMetadata,
            // resource-level metadata overrides template defaults per SDK convention
            ...res,
          })),
        ),
      );
    }
  }

  const templateResults = await Promise.all(templatePromises);
  const all: CatalogResource[] = [...statics, ...templateResults.flat()];
  all.sort((a, b) => a.uri.localeCompare(b.uri));
  return all;
}

export function installPaginatedListHandler(
  server: McpServer,
  catalog: ResourceCatalog,
  logger: pino.Logger,
  pageSize: number = DEFAULT_PAGE_SIZE,
): void {
  server.server.setRequestHandler(ListResourcesRequestSchema, async (request) => {
    const cursorParam = request.params?.cursor;
    const offset = decodeCursor(cursorParam ?? undefined);
    const all = await resolveAll(catalog);

    const slice = all.slice(offset, offset + pageSize);
    const next = offset + slice.length;
    const hasMore = next < all.length;

    logger.debug(
      { offset, returned: slice.length, total: all.length, hasMore },
      "resources/list paginated",
    );

    return {
      resources: slice,
      ...(hasMore ? { nextCursor: encodeCursor(next) } : {}),
    };
  });
}

// Test-only exports.
export const __testing = { encodeCursor, decodeCursor, resolveAll };
