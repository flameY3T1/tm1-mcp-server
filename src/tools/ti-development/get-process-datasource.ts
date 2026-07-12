import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TM1Client } from "../../tm1-client.js";
import { FORMAT_SCHEMA, payloadResponse, renderKV } from "../format.js";
import { maskDataSourceSecrets } from "../../lib/mask-secrets.js";

export function registerGetProcessDatasource(server: McpServer, tm1Client: TM1Client) {
  server.tool(
    "tm1_get_process_datasource",
    "Get the data source configuration of a TurboIntegrator process. Credential pairs (PWD=, UID=) inside the ODBC connection string are masked by default (maskSecrets); the password field is always redacted.",
    {
      processName: z.string().describe("Name of the TI process"),
      maskSecrets: z
        .boolean()
        .optional()
        .default(true)
        .describe(
          "Mask credential pairs (PWD=, UID=) inside the ODBC connection string. " +
            "Default: true. Set false only when explicitly auditing credentials (the password field stays redacted either way).",
        ),
      ...FORMAT_SCHEMA,
    },
    async ({ processName, maskSecrets, format }) => {
      let ds = await tm1Client.processes.getDataSource(processName);
      if (maskSecrets) ds = maskDataSourceSecrets(ds);
      return payloadResponse(ds, format, (d) =>
        renderKV(d as unknown as Record<string, unknown>, `Datasource of ${processName}`),
      );
    },
  );
}
