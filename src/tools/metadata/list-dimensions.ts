import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TM1Client } from "../../tm1-client.js";
import {
  decodeTm1Timestamp,
  normalizeChangedSince,
} from "../../tm1-client/services/dimension-service.js";
import { PAGINATION_SCHEMA, paginate } from "../pagination.js";
import { FORMAT_SCHEMA, pageResponse, type Column } from "../format.js";

export function registerListDimensions(server: McpServer, tm1Client: TM1Client) {
  server.tool(
    "tm1_list_dimensions",
    [
      "List dimensions in the TM1 server with their hierarchy names.",
      "Control dimensions (names starting with '}') are excluded by default — set includeControl=true to include them.",
      "Set includeElementCount=true to size each dimension's hierarchies in one round-trip — avoids per-dimension tm1_get_hierarchy calls during audits.",
      "Set includeElementStats=true to get per-Type breakdown {total, numeric, consolidated, string, maxLevel} per hierarchy — drives double-hierarchy / orphan detection without cube/MDX dependency. Heavier payload (scans all elements server-side). Overrides includeElementCount when both set.",
      "Set includeLastUpdated=true to attach `lastUpdated` (server-local ISO) per dimension from }DimensionProperties.LAST_TIME_UPDATED — a schema-change stamp (bumped on element/hierarchy/attribute edits, NOT on data writes). One extra MDX round-trip.",
      "Set changedSince (date or datetime, e.g. '2026-04-01' or '2026-04-01T08:30') to return only dimensions modified at/after it — implies includeLastUpdated. Compared in server-local time.",
      "Paginated (default 50/page). Returns {total, count, offset, has_more, next_offset, items}.",
    ].join(" "),
    {
      ...PAGINATION_SCHEMA,
      ...FORMAT_SCHEMA,
      includeControl: z
        .boolean()
        .optional()
        .default(false)
        .describe("Include TM1 control dimensions whose names start with '}' (default: false)"),
      includeElementCount: z
        .boolean()
        .optional()
        .default(false)
        .describe("Attach `elementCounts: { hierarchyName: number }` per dimension via OData $count. Single extra server-side aggregation, no N+1. Default false."),
      includeElementStats: z
        .boolean()
        .optional()
        .default(false)
        .describe("Attach `elementStats: { hierarchyName: { total, numeric, consolidated, string, maxLevel } }` per dimension. Single round-trip, payload scales with total element count. Use for double-hierarchy audits and orphan detection. Overrides includeElementCount when set. Default false."),
      includeLastUpdated: z
        .boolean()
        .optional()
        .default(false)
        .describe("Attach `lastUpdated` (server-local ISO, no Z) per dimension from }DimensionProperties.LAST_TIME_UPDATED — a schema-change stamp. One extra MDX round-trip. Default false."),
      changedSince: z
        .string()
        .optional()
        .describe("Return only dimensions modified at/after this date or datetime (server-local, e.g. '2026-04-01' or '2026-04-01T08:30:00'). Implies includeLastUpdated. Needs at least a full date."),
    },
    async ({ limit, offset, fetchAll, format, includeControl, includeElementCount, includeElementStats, includeLastUpdated, changedSince }) => {
      let dimensions = await tm1Client.dimensions.list({ includeElementCount, includeElementStats });
      if (!includeControl) dimensions = dimensions.filter((d) => !d.name.startsWith("}"));

      const wantLastUpdated = includeLastUpdated || changedSince !== undefined;
      if (wantLastUpdated) {
        // Invalid changedSince throws TM1Error(VALIDATION_ERROR); the index.ts
        // proxy formats it into the uniform error envelope.
        const since = changedSince !== undefined ? normalizeChangedSince(changedSince) : undefined;
        // }DimensionProperties is a control cube — a caller without read rights
        // gets a security error. When changedSince was requested the filter
        // can't be honoured, so surface it; when only includeLastUpdated was
        // asked, degrade to lastUpdated:null so the base dimension list survives.
        let stamps: Map<string, string>;
        try {
          stamps = await tm1Client.dimensions.getLastUpdatedMap();
        } catch (err) {
          if (since !== undefined) throw err;
          stamps = new Map();
        }
        dimensions = dimensions.map((d) => ({
          ...d,
          lastUpdated: decodeTm1Timestamp(stamps.get(d.name) ?? null),
        }));
        if (since !== undefined) {
          dimensions = dimensions.filter((d) => {
            const raw = stamps.get(d.name);
            return raw !== undefined && raw >= since;
          });
        }
      }

      const page = paginate(dimensions, limit, offset, fetchAll);
      type Row = (typeof dimensions)[number];
      const columns: Column<Row>[] = [
        { header: "name", get: (d) => d.name },
        { header: "hierarchies", get: (d) => d.hierarchies },
        ...(includeElementStats
          ? [{ header: "elementStats", get: (d: Row) => d.elementStats ?? {} } as Column<Row>]
          : includeElementCount
            ? [{ header: "elementCounts", get: (d: Row) => d.elementCounts ?? {} } as Column<Row>]
            : []),
        ...(wantLastUpdated
          ? [{ header: "lastUpdated", get: (d: Row) => d.lastUpdated ?? null } as Column<Row>]
          : []),
      ];
      return pageResponse(page, format, { title: "Dimensions", columns });
    },
  );
}
