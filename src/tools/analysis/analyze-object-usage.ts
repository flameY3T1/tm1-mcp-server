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
      "Returns a flat list sorted by source; excludes a cube's self-references inside its own rules. accessMode picks read vs write (data-flow) analysis; mode='summary' collapses per-source and drops snippets.",
    ].join(" "),
    {
      kind: z.enum(["cube", "dimension"]).describe("Object kind to look up"),
      objectName: z.string().describe("Cube or dimension name (case-insensitive)"),
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
        .describe("Cap the number of returned usages (or sources in summary mode). Omit for full bulk load (audit use-case)."),
      mode: z
        .enum(["full", "summary"])
        .optional()
        .default("full")
        .describe(
          "'full' (default): individual usage lines with snippets. 'summary': aggregate per source " +
          "({sourceKind, sourceName, accessTypes[], sections[], funcNames[], count}), sorted by count desc, " +
          "snippets dropped. Use summary for compact data-flow overviews on heavily-referenced objects.",
        ),
    },
    async ({ kind, objectName, accessMode, includeSystem, includeControl, limit, mode }) => {
      const index = await buildIndexFromTM1(tm1Client, { includeControl });
      const all = buildCubeOrDimUsages(index, kind, objectName, { includeSystem, accessMode });

      if (mode === "summary") {
        // Aggregate per source (process or rule). Key by kind+name so a process
        // and a cube-rule sharing a name don't collapse into one row.
        const bySource = new Map<
          string,
          {
            sourceKind: "process" | "rule";
            sourceName: string;
            accessTypes: Set<string>;
            sections: Set<string>;
            funcNames: Set<string>;
            count: number;
          }
        >();
        for (const u of all) {
          const key = `${u.sourceKind}\x00${u.sourceName}`;
          let s = bySource.get(key);
          if (!s) {
            s = {
              sourceKind: u.sourceKind,
              sourceName: u.sourceName,
              accessTypes: new Set(),
              sections: new Set(),
              funcNames: new Set(),
              count: 0,
            };
            bySource.set(key, s);
          }
          s.accessTypes.add(u.accessType);
          s.sections.add(u.section);
          if (u.funcName) s.funcNames.add(u.funcName);
          s.count++;
        }
        const allSources = [...bySource.values()]
          .map((s) => ({
            sourceKind: s.sourceKind,
            sourceName: s.sourceName,
            accessTypes: [...s.accessTypes].sort(),
            sections: [...s.sections].sort(),
            funcNames: [...s.funcNames].sort(),
            count: s.count,
          }))
          .sort((a, b) => b.count - a.count || a.sourceName.localeCompare(b.sourceName));
        const sumTruncated = limit !== undefined && allSources.length > limit;
        const sources = sumTruncated ? allSources.slice(0, limit) : allSources;
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                kind,
                name: objectName,
                accessMode,
                mode,
                count: all.length,
                sourceCount: allSources.length,
                returned: sources.length,
                truncated: sumTruncated,
                sources,
              }),
            },
          ],
        };
      }
      const truncated = limit !== undefined && all.length > limit;
      const usages = truncated ? all.slice(0, limit) : all;
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ kind, name: objectName, accessMode, count: all.length, returned: usages.length, truncated, usages }),
          },
        ],
      };
    },
  );
}
