import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TM1Client } from "../../tm1-client.js";
export function registerGetViewDefinition(server: McpServer, tm1Client: TM1Client) {
  server.tool(
    "tm1_get_view_definition",
    [
      "Return the structural definition of a cube view (MDX expression OR NativeView axes)",
      "WITHOUT executing it. Use tm1_get_view to execute and read cells.",
      "Auto-detects public vs private when isPrivate is omitted (public tried first).",
    ].join(" "),
    {
      cubeName: z.string().describe("Name of the TM1 cube"),
      viewName: z.string().describe("Name of the view"),
      isPrivate: z
        .boolean()
        .optional()
        .describe(
          "If true, look only in PrivateViews. If false, only in Views. If omitted, public is tried first then private.",
        ),
    },
    async ({ cubeName, viewName, isPrivate }) => {
      const result = await tm1Client.views.getDefinition(cubeName, viewName, isPrivate);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result) }],
      };
    },
  );
}
