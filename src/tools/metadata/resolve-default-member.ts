import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TM1Client } from "../../tm1-client.js";

export function registerResolveDefaultMember(server: McpServer, tm1Client: TM1Client) {
  server.tool(
    "tm1_resolve_default_member",
    [
      "Resolve a hierarchy's effective default member in one call — avoids the 3-8 round-trip iterative level-scan when constructing view slicers.",
      "Tiered cascade: (1) DefaultMember attribute (source=defined, high confidence); (2) parentless roots — unique root = single_root/high, multiple = first_root/medium with alternatives.roots populated; (3) insertion-order index 1 fallback (index_1, low) for flat or cyclic hierarchies.",
      "Inspect `source` and `confidence` before trusting the value. `alternatives.roots` lets callers disambiguate multi-root cases without a second call.",
    ].join(" "),
    {
      dimensionName: z.string().describe("TM1 dimension name."),
      hierarchyName: z.string().optional()
        .describe("Hierarchy name within the dimension. Defaults to dimensionName (TM1 default hierarchy)."),
    },
    async ({ dimensionName, hierarchyName }) => {
      const result = await tm1Client.dimensions.resolveDefaultMember(
        dimensionName,
        hierarchyName,
      );
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result) }],
      };
    },
  );
}
