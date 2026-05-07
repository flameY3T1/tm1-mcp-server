import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TM1Client } from "../../tm1-client.js";
import { buildIndexFromTM1 } from "../../lib/callgraph/tm1-adapter.js";
import { buildCubeOrDimUsages } from "../../lib/callgraph/callGraph.js";

export function registerAnalyzeObjectUsage(server: McpServer, tm1Client: TM1Client) {
  server.tool(
    "tm1_analyze_object_usage",
    "Find every reference to a cube or dimension across all TI processes (CellGet/Put, ViewExtract, ZeroOut, …) and cube rules (DB(), [dim].[el]). Returns a flat list of {sourceKind, sourceName, section, line, funcName, snippet}, sorted by source. Excludes a cube's self-references inside its own rules.",
    {
      kind: z.enum(["cube", "dimension"]).describe("Object kind to look up"),
      name: z.string().describe("Cube or dimension name (case-insensitive)"),
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
    },
    async ({ kind, name, includeSystem, includeControl }) => {
      const index = await buildIndexFromTM1(tm1Client, { includeControl });
      const usages = buildCubeOrDimUsages(index, kind, name, { includeSystem });
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ kind, name, count: usages.length, usages }, null, 2),
          },
        ],
      };
    },
  );
}
