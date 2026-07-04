import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TM1Client } from "../../tm1-client.js";
import { CONFIRM_SCHEMA, requireConfirm } from "../confirm.js";
export function registerDeleteSubset(server: McpServer, tm1Client: TM1Client) {
  server.tool(
    "tm1_delete_subset",
    "Delete a public TM1 subset. Fails if the subset is referenced by views/processes (404 if not found). Irreversible — pass confirm=<subset name verbatim>.",
    {
      dimensionName: z.string().describe("Dimension name"),
      hierarchyName: z.string().describe("Hierarchy name"),
      subsetName: z.string().describe("Subset to delete"),
      ...CONFIRM_SCHEMA,
    },
    async ({ dimensionName, hierarchyName, subsetName, confirm }) => {
      requireConfirm(confirm, subsetName, "subset");
      await tm1Client.subsets.delete(dimensionName, hierarchyName, subsetName);
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ success: true, subsetName }) }],
      };
    },
  );
}
