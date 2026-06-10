import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TM1Client } from "../../tm1-client.js";
import { buildIndexFromTM1 } from "../../lib/callgraph/tm1-adapter.js";
import { buildCubeOrDimUsages } from "../../lib/callgraph/callGraph.js";

export function registerAnalyzeObjectUsage(server: McpServer, tm1Client: TM1Client) {
  server.tool(
    "tm1_analyze_object_usage",
    [
      "Find every reference to a cube or dimension across all TI processes (CellGet/Put, ViewExtract, ZeroOut, …) and cube rules (DB(), [dim].[el]).",
      "Returns a flat list of {sourceKind, sourceName, section, line, funcName, accessType, snippet}, sorted by source.",
      "Excludes a cube's self-references inside its own rules.",
      "Use accessMode='write' for data-flow analysis (what writes into this cube) or 'read' for consumption analysis.",
    ].join(" "),
    {
      kind: z.enum(["cube", "dimension"]).describe("Object kind to look up"),
      name: z.string().describe("Cube or dimension name (case-insensitive)"),
      accessMode: z
        .enum(["all", "read", "write"])
        .optional()
        .default("all")
        .describe(
          "Filter by access type. 'write': CellPut*/ViewZeroOut/CubeClearData/… (data-flow analysis). " +
          "'read': CellGet*/DB()-rules (consumption analysis). 'all' (default): every reference.",
        ),
      includeSystem: z
        .boolean()
        .optional()
        .default(false)
        .describe("Include sources whose names start with '}' (control objects). Default: false."),
      includeControl: z
        .boolean()
        .optional()
        .default(false)
        .describe("Index control processes/cubes when building the index. Default: false."),
      limit: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Cap the number of returned usages. Omit for full bulk load (audit use-case)."),
    },
    async ({ kind, name, accessMode, includeSystem, includeControl, limit }) => {
      const index = await buildIndexFromTM1(tm1Client, { includeControl });
      const all = buildCubeOrDimUsages(index, kind, name, { includeSystem, accessMode });
      const truncated = limit !== undefined && all.length > limit;
      const usages = truncated ? all.slice(0, limit) : all;
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ kind, name, accessMode, count: all.length, returned: usages.length, truncated, usages }),
          },
        ],
      };
    },
  );
}
