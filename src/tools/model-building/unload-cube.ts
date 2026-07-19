import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { TM1Client } from "../../tm1-client.js";
import { actionResponse } from "../format.js";

export function registerUnloadCube(server: McpServer, tm1Client: TM1Client): void {
  server.tool(
    "tm1_unload_cube",
    "Unload a cube from memory. TM1 discards the in-memory fed-cell index and reloads from disk on next access. Required after feeder corrections, since the fed-cell index is cumulative — changes to existing feeders only take effect after an unload. Safe to call: data is preserved (read from .cub on next access).",
    {
      cubeName: z.string().describe("Name of the cube to unload"),
    },
    async ({ cubeName }) => {
      await tm1Client.cubes.unload(cubeName);
      return actionResponse({ success: true, cubeName });
    },
  );
}
