import { promises as fs } from "node:fs";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TM1Client } from "../../tm1-client.js";
import { resolveLocalPath } from "../local-file.js";
import { serializeToPro } from "../../lib/pro-serializer.js";

export function registerExportProcessToPro(server: McpServer, tm1Client: TM1Client) {
  server.tool(
    "tm1_export_process_to_pro",
    [
      "Reverse of tm1_import_pro_file: serialize a TM1 process back to a .pro file body.",
      "Fetches code (Prolog/Metadata/Data/Epilog), parameters, variables, and datasource in parallel.",
      "Returns the .pro content inline by default; pass writeToFile to also persist to an absolute path on the MCP host.",
      "Round-trip safe with tm1_import_pro_file — useful for syncing live server state into a Git repo.",
    ].join(" "),
    {
      processName: z.string().describe("Name of the TI process to export"),
      writeToFile: z
        .string()
        .optional()
        .describe("Optional absolute host path to write the .pro file to. Disabled unless TM1_LOCAL_FILE_ROOT is set; the path must resolve within that directory. If omitted, content is only returned inline."),
    },
    async ({ processName, writeToFile }) => {
      const [code, parameters, variables, dataSource] = await Promise.all([
        tm1Client.processes.getCode(processName),
        tm1Client.processes.getParameters(processName),
        tm1Client.processes.getVariables(processName),
        tm1Client.processes.getDataSource(processName),
      ]);

      const proContent = serializeToPro({
        name: processName,
        prolog: code.prolog,
        metadata: code.metadata,
        data: code.data,
        epilog: code.epilog,
        parameters,
        variables,
        dataSource,
      });

      let writtenTo: string | null = null;
      if (writeToFile) {
        const target = resolveLocalPath(writeToFile, "writeToFile");
        await fs.writeFile(target, proContent, "utf8");
        writtenTo = target;
      }

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            processName,
            byteLength: Buffer.byteLength(proContent, "utf8"),
            writtenTo,
            parameterCount: parameters.length,
            variableCount: variables.length,
            dataSourceType: dataSource.type,
            content: proContent,
          }, null, 2),
        }],
      };
    },
  );
}
