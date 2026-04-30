import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TM1Client } from "../../tm1-client.js";
import { TM1Error } from "../../types.js";

export function registerCreateSubset(server: McpServer, tm1Client: TM1Client) {
  server.tool(
    "tm1_create_subset",
    "Create a public TM1 subset. Provide either expression (MDX-based, dynamic) OR elements (static list) — not both. Optional alias attribute name controls the displayed alias.",
    {
      dimensionName: z.string().describe("Dimension name"),
      hierarchyName: z.string().describe("Hierarchy name"),
      subsetName: z.string().describe("New subset name"),
      expression: z.string().optional().describe("MDX expression (e.g. '{TM1FILTERBYLEVEL({TM1SUBSETALL([Dim])}, 0)}'). Mutually exclusive with elements."),
      elements: z.array(z.string()).optional().describe("Static element name list. Mutually exclusive with expression."),
      alias: z.string().optional().describe("Alias attribute used as display name in the subset"),
    },
    async ({ dimensionName, hierarchyName, subsetName, expression, elements, alias }) => {
      try {
        await tm1Client.createSubset(dimensionName, hierarchyName, {
          name: subsetName,
          expression,
          elements,
          alias,
        });
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ success: true, subsetName, kind: expression ? "mdx" : "static" }) }],
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
