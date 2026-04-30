import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { TM1Client } from "../../tm1-client.js";

export function registerListViews(server: McpServer, tm1Client: TM1Client): void {
  server.tool(
    "tm1_list_views",
    "List all public and private views defined on a cube. Returns view name, visibility, and MDX (when available).",
    {
      cubeName: z.string().describe("Cube name"),
    },
    async ({ cubeName }) => {
      try {
        const views = await tm1Client.listViews(cubeName);
        if (views.length === 0) {
          return { content: [{ type: "text", text: `No views defined on cube "${cubeName}".` }] };
        }
        const lines = views.map((v) => {
          const scope = v.private ? "private" : "public";
          return `- ${v.name} [${scope}]${v.mdx ? ` — MDX: ${v.mdx.slice(0, 80)}${v.mdx.length > 80 ? "…" : ""}` : ""}`;
        });
        return {
          content: [{
            type: "text",
            text: `${views.length} view(s) on "${cubeName}":\n${lines.join("\n")}`,
          }],
        };
      } catch (err) {
        return { isError: true, content: [{ type: "text", text: `TM1 error: ${(err as Error).message}` }] };
      }
    },
  );
}
