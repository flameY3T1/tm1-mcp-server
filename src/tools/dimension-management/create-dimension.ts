import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { TM1Client } from "../../tm1-client.js";

export function registerCreateDimension(server: McpServer, tm1Client: TM1Client): void {
  server.tool(
    "tm1_create_dimension",
    [
      "Create a new TM1 dimension with a default hierarchy of the same name.",
      "Fails if the dimension already exists. After: tm1_create_element / tm1_bulk_upsert_elements to populate, tm1_create_hierarchy for alternate hierarchies.",
    ].join(" "),
    {
      dimensionName: z.string().describe("Dimension name"),
    },
    async ({ dimensionName }) => {
      await tm1Client.dimensions.create(dimensionName);
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ success: true, dimensionName }),
        }],
      };
    },
  );
}
