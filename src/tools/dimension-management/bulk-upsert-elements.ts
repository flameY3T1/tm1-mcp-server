import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { TM1Client } from "../../tm1-client.js";
import { withToolHint } from "../error-format.js";
import { actionResponse } from "../format.js";

const ElementSchema = z.object({
  name: z.string().describe("Element name"),
  type: z.enum(["Numeric", "String", "Consolidated"]).describe("N=numeric leaf, C=consolidated/parent, S=string"),
  components: z.array(z.object({
    name: z.string().describe("Child element name"),
    weight: z.number().default(1).describe("Consolidation weight (default: 1)"),
  })).optional().describe("Child elements for a Consolidated element. REPLACES the full existing child set (verified live: passing [X,Y] drops any current children not in the list — it does not append). Omit or pass an empty array to leave existing children unchanged. To add one child, list the complete intended set."),
});

export function registerBulkUpsertElements(server: McpServer, tm1Client: TM1Client): void {
  server.tool(
    "tm1_bulk_upsert_elements",
    [
      "Create or update multiple elements in a TM1 hierarchy in bulk (two-pass: leafs first, then consolidations).",
      "Existing elements are updated; new elements are created.",
      "IMPORTANT: List all Numeric/String leaf elements BEFORE Consolidated elements to avoid reference errors.",
      "For a Consolidated element, a non-empty components list REPLACES its full child set (existing children not listed are dropped); omit components to leave children unchanged.",
    ].join(" "),
    {
      dimensionName: z.string().describe("Dimension name"),
      hierarchyName: z.string().optional().describe("Hierarchy name (defaults to dimension name)"),
      elements: z.array(ElementSchema).min(1).describe("Elements to create or update"),
    },
    async ({ dimensionName, hierarchyName, elements }) => {
      const hier = hierarchyName ?? dimensionName;
      const { typeChanges } = await withToolHint(
        tm1Client.elements.bulkUpsert(dimensionName, hier, elements),
        "Bulk upsert failed. Common causes: Consolidated element references a child that is not in this batch and does not exist yet (list leafs first), dimension/hierarchy name mismatch (tm1_list_dimensions to verify), or attempt to change an element's type (delete + recreate instead).",
      );
      const counts = {
        N: elements.filter((e) => e.type === "Numeric").length,
        C: elements.filter((e) => e.type === "Consolidated").length,
        S: elements.filter((e) => e.type === "String").length,
      };
      return actionResponse({
        success: true,
        dimensionName,
        hierarchyName: hier,
        total: elements.length,
        counts,
        // Existing elements whose Type was changed in place. A
        // Numeric->Consolidated/String conversion discards the element's
        // leaf cell values, so surface it instead of letting it happen
        // silently.
        typeChanges,
        ...(typeChanges.length > 0 && {
          warning: `${typeChanges.length} element(s) had their type changed in place; any existing leaf cell values for those elements were discarded.`,
        }),
      });
    },
  );
}
