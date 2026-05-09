import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TM1Client } from "../../tm1-client.js";
import { FORMAT_SCHEMA, payloadResponse, renderTable, type Column } from "../format.js";

export function registerGetAncestors(server: McpServer, tm1Client: TM1Client) {
  server.tool(
    "tm1_get_ancestors",
    [
      "Get all ancestors of an element via parent-walk. Multi-parent safe: returns the unique flat ancestor set AND every distinct root-to-element path.",
      "Use to find roll-up paths or detect that an element rolls up to multiple consolidations (alternate hierarchies).",
      "Output: { element, ancestors: [{ name, level }], paths: [[ root, ..., element ]] }.",
    ].join(" "),
    {
      dimensionName: z.string().describe("Name of the TM1 dimension"),
      hierarchyName: z.string().describe("Hierarchy within the dimension"),
      element: z.string().describe("Element whose ancestors are requested. Root elements return empty ancestors and a single self-only path."),
      ...FORMAT_SCHEMA,
    },
    async ({ dimensionName, hierarchyName, element, format }) => {
      const result = await tm1Client.hierarchies.getAncestors(dimensionName, hierarchyName, element);
      type Row = (typeof result.ancestors)[number];
      const columns: Column<Row>[] = [
        { header: "name", get: (a) => a.name },
        { header: "level", get: (a) => a.level },
      ];
      return payloadResponse(result, format, (r) => {
        const pathLines = r.paths.map((p, i) => `${i + 1}. ${p.join(" → ")}`).join("\n");
        return `## Ancestors of ${r.element}\n\n${renderTable(r.ancestors, columns)}\n\n### Paths\n\n${pathLines || "_(no paths)_"}`;
      });
    },
  );
}
