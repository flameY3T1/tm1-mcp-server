import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { TM1Client } from "../../tm1-client.js";

export function registerUnloadCube(server: McpServer, tm1Client: TM1Client): void {
  server.tool(
    "tm1_unload_cube",
    "Unload a cube from memory. TM1 discards the in-memory fed-cell index and reloads from disk on next access. Required after feeder corrections, since the fed-cell index is cumulative — changes to existing feeders only take effect after an unload. Safe to call: data is preserved (read from .cub on next access).",
    {
      cubeName: z.string().describe("Name of the cube to unload"),
    },
    async ({ cubeName }) => {
      try {
        await tm1Client.unloadCube(cubeName);
        return { content: [{ type: "text", text: `Cube "${cubeName}" unloaded. Next query will reload it and rebuild the fed-cell index.` }] };
      } catch (err) {
        return { isError: true, content: [{ type: "text", text: `TM1 error: ${(err as Error).message}` }] };
      }
    },
  );
}
