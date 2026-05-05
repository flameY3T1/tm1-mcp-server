import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TM1Client } from "../../tm1-client.js";
import { TM1Error } from "../../types.js";

export function registerListProcessesGrouped(server: McpServer, tm1Client: TM1Client) {
  server.tool(
    "tm1_list_processes_grouped",
    [
      "Group TI processes by name prefix to give a structural overview without listing every process.",
      "Returns groups sorted by count descending. Use tm1_list_processes(nameContains=...) to drill into a group.",
      "prefixSegments controls how many '_'-delimited segments form the group key (default 1: '020_Parameter_...' → '020').",
      "Set includeNames=true to get the full process list per group for targeted follow-up.",
    ].join(" "),
    {
      includeControl: z.boolean().optional().default(false)
        .describe("Include control processes ('}'-prefixed). Default: false."),
      prefixSegments: z.number().int().min(1).max(5).optional().default(1)
        .describe("Number of '_'-delimited segments to use as group key. Default 1: '020_Param_Load' → '020'. Use 2 for '020_Param'."),
      includeNames: z.boolean().optional().default(false)
        .describe("Add processes[] array of names to each group. Default false — summary only."),
      minCount: z.number().int().min(1).optional()
        .describe("Only return groups with at least this many processes. Useful to hide one-off processes."),
      excludePattern: z.string().optional()
        .describe("JS-compatible regex (case-insensitive) — drop processes whose name matches before grouping. E.g. '^Bedrock\\.' to hide Bedrock utility processes."),
    },
    async ({ includeControl, prefixSegments, includeNames, minCount, excludePattern }) => {
      try {
        let processes = await tm1Client.getProcesses();
        if (!includeControl) processes = processes.filter((p) => !p.name.startsWith("}"));
        if (excludePattern) {
          let re: RegExp;
          try {
            re = new RegExp(excludePattern, "i");
          } catch (e) {
            return {
              content: [{ type: "text" as const, text: JSON.stringify({ error: `invalid excludePattern: ${(e as Error).message}` }) }],
              isError: true,
            };
          }
          processes = processes.filter((p) => !re.test(p.name));
        }

        const groupMap = new Map<string, string[]>();
        for (const p of processes) {
          const segments = p.name.split("_");
          const prefix = segments.slice(0, prefixSegments).join("_");
          const group = groupMap.get(prefix);
          if (group) group.push(p.name);
          else groupMap.set(prefix, [p.name]);
        }

        let groups = Array.from(groupMap.entries())
          .map(([prefix, names]) => ({
            prefix,
            count: names.length,
            ...(includeNames ? { processes: names.sort() } : {}),
          }))
          .sort((a, b) => b.count - a.count);

        if (minCount !== undefined) groups = groups.filter((g) => g.count >= minCount);

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              totalProcesses: processes.length,
              groupCount: groups.length,
              prefixSegments,
              groups,
            }, null, 2),
          }],
        };
      } catch (error) {
        const msg =
          error instanceof TM1Error
            ? { code: error.code, message: error.message, httpStatus: error.httpStatus, endpoint: error.endpoint }
            : { error: String(error) };
        return {
          content: [{ type: "text" as const, text: JSON.stringify(msg) }],
          isError: true,
        };
      }
    },
  );
}
