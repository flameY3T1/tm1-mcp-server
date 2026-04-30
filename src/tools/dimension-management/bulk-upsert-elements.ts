import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { TM1Client } from "../../tm1-client.js";

const ElementSchema = z.object({
  name: z.string().describe("Element name"),
  type: z.enum(["Numeric", "String", "Consolidated"]).describe("N=numeric leaf, C=consolidated/parent, S=string"),
  components: z.array(z.object({
    name: z.string().describe("Child element name"),
    weight: z.number().default(1).describe("Consolidation weight (default: 1)"),
  })).optional().describe("Child elements for Consolidated type"),
});

export function registerBulkUpsertElements(server: McpServer, tm1Client: TM1Client): void {
  server.tool(
    "tm1_bulk_upsert_elements",
    [
      "Create or update multiple elements in a TM1 hierarchy in bulk (two-pass: leafs first, then consolidations).",
      "Existing elements are updated; new elements are created.",
      "IMPORTANT: List all Numeric/String leaf elements BEFORE Consolidated elements to avoid reference errors.",
    ].join(" "),
    {
      dimension: z.string().describe("Dimension name"),
      hierarchy: z.string().optional().describe("Hierarchy name (defaults to dimension name)"),
      elements: z.array(ElementSchema).min(1).describe("Elements to create or update"),
    },
    async ({ dimension, hierarchy, elements }) => {
      const hier = hierarchy ?? dimension;
      try {
        await tm1Client.bulkUpsertElements(dimension, hier, elements);
        const counts = {
          N: elements.filter((e) => e.type === "Numeric").length,
          C: elements.filter((e) => e.type === "Consolidated").length,
          S: elements.filter((e) => e.type === "String").length,
        };
        return {
          content: [{
            type: "text",
            text: [
              `Bulk upsert completed for ${dimension}/${hier}:`,
              `  ${elements.length} elements total (N:${counts.N} C:${counts.C} S:${counts.S})`,
            ].join("\n"),
          }],
        };
      } catch (err) {
        return { isError: true, content: [{ type: "text", text: `TM1 error: ${(err as Error).message}` }] };
      }
    },
  );
}
