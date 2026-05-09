import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TM1Client } from "../../tm1-client.js";
import { FORMAT_SCHEMA, payloadResponse, renderTable, type Column } from "../format.js";

export function registerGetElementAttributeValues(server: McpServer, tm1Client: TM1Client) {
  server.tool(
    "tm1_get_element_attribute_values",
    "Read all attribute values (Numeric/String/Alias) for a single element via MDX on the }ElementAttributes_{Dim} control cube. Use this to verify alias values, attribute lookups, or to debug rules referencing ATTRN/ATTRS.",
    {
      dimensionName: z.string().describe("Dimension name"),
      elementName: z.string().describe("Element whose attribute values should be read"),
      ...FORMAT_SCHEMA,
    },
    async ({ dimensionName, elementName, format }) => {
      const values = await tm1Client.elements.getAttributeValues(dimensionName, elementName);
      const payload = { dimensionName, elementName, attributes: values };
      type Row = (typeof values)[number];
      const columns: Column<Row>[] = [
        { header: "attribute", get: (a) => a.attributeName },
        { header: "value", get: (a) => a.value ?? "" },
      ];
      return payloadResponse(payload, format, (p) =>
        `## Attributes of ${p.dimensionName}/${p.elementName}\n\n${renderTable(p.attributes, columns)}`,
      );
    },
  );
}
