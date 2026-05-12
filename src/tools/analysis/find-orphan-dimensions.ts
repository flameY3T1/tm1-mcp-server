import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TM1Client } from "../../tm1-client.js";

export function registerFindOrphanDimensions(server: McpServer, tm1Client: TM1Client) {
  server.tool(
    "tm1_find_orphan_dimensions",
    [
      "Identify dimensions that are not referenced by any cube — a model hygiene check.",
      "Computes the set of dimensions used across all cubes (one $expand OData call) and",
      "diffs against the full dimension list. Replaces the agent-side join over",
      "tm1_list_cubes × tm1_list_dimensions which is token-heavy on large models.",
      "Control dimensions ('}'-prefix) are excluded by default — set includeControl=true to include them.",
    ].join(" "),
    {
      includeControl: z
        .boolean()
        .optional()
        .default(false)
        .describe("Include control dimensions whose names start with '}' (default: false)."),
    },
    async ({ includeControl }) => {
      const [cubes, dimensions] = await Promise.all([
        tm1Client.cubes.list(),
        tm1Client.dimensions.list(),
      ]);

      const usedDims = new Set<string>();
      for (const c of cubes) {
        for (const d of c.dimensions ?? []) usedDims.add(d);
      }

      const candidates = includeControl
        ? dimensions
        : dimensions.filter((d) => !d.name.startsWith("}"));

      const orphans = candidates
        .filter((d) => !usedDims.has(d.name))
        .map((d) => ({ name: d.name, hierarchies: d.hierarchies }));

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                totalDimensions: candidates.length,
                totalCubes: cubes.length,
                orphanCount: orphans.length,
                includeControl,
                orphans,
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );
}
