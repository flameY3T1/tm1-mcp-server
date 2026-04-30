import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TM1Client } from "../../tm1-client.js";
import { TM1Error } from "../../types.js";

export function registerListSubsets(server: McpServer, tm1Client: TM1Client) {
  server.tool(
    "tm1_list_subsets",
    "List public + private subsets of a TM1 hierarchy. Returns names, scope (public/private), MDX expression preview, and alias.",
    {
      dimensionName: z.string().describe("Dimension name"),
      hierarchyName: z.string().describe("Hierarchy name (commonly equal to the dimension name)"),
    },
    async ({ dimensionName, hierarchyName }) => {
      try {
        const subsets = await tm1Client.listSubsets(dimensionName, hierarchyName);
        if (subsets.length === 0) {
          return {
            content: [{ type: "text" as const, text: `No subsets defined on ${dimensionName}.${hierarchyName}.` }],
          };
        }
        const lines = subsets.map((s) => {
          const scope = s.private ? "private" : "public";
          const kind = s.expression ? `MDX: ${s.expression.slice(0, 80)}${s.expression.length > 80 ? "…" : ""}` : "static";
          const alias = s.alias ? ` alias=${s.alias}` : "";
          return `- ${s.name} [${scope}] ${kind}${alias}`;
        });
        return {
          content: [{
            type: "text" as const,
            text: `${subsets.length} subset(s) on ${dimensionName}.${hierarchyName}:\n${lines.join("\n")}`,
          }],
        };
      } catch (error) {
        const msg =
          error instanceof TM1Error
            ? { code: error.code, message: error.message, httpStatus: error.httpStatus, endpoint: error.endpoint }
            : { error: String(error) };
        return { content: [{ type: "text" as const, text: JSON.stringify(msg) }], isError: true };
      }
    },
  );
}
