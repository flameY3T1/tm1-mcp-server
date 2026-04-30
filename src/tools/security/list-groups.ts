import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TM1Client } from "../../tm1-client.js";
import { TM1Error } from "../../types.js";

export function registerListGroups(server: McpServer, tm1Client: TM1Client) {
  server.tool(
    "tm1_list_groups",
    "List all TM1 groups with assigned client names.",
    {},
    async () => {
      try {
        const groups = await tm1Client.listGroups();
        if (groups.length === 0) {
          return { content: [{ type: "text" as const, text: "No groups defined." }] };
        }
        const lines = groups.map((g) => {
          const clients = g.Clients?.map((c) => c.Name).join(", ") ?? "";
          return `- ${g.Name} clients=[${clients}]`;
        });
        return {
          content: [{
            type: "text" as const,
            text: `${groups.length} group(s):\n${lines.join("\n")}`,
          }],
        };
      } catch (error) {
        const msg = error instanceof TM1Error
          ? { code: error.code, message: error.message, httpStatus: error.httpStatus, endpoint: error.endpoint }
          : { error: String(error) };
        return { content: [{ type: "text" as const, text: JSON.stringify(msg) }], isError: true };
      }
    },
  );
}
