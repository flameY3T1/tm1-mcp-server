import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TM1Client } from "../../tm1-client.js";
import { TM1Error } from "../../types.js";
import { parseProFile } from "../../lib/pro-parser.js";

export function registerImportProFile(server: McpServer, tm1Client: TM1Client) {
  server.tool(
    "tm1_import_pro_file",
    "Parse a TM1 .pro file (Tabs / Parameters / Variables / DataSource) and deploy the process in one call. Provide either filePath (absolute path on the MCP host) or content (the .pro file body as string). Modes: 'create' (fail if exists), 'update' (fail if missing), 'upsert' (default — create or update).",
    {
      filePath: z
        .string()
        .optional()
        .describe("Absolute path to the .pro file on the MCP server host"),
      content: z
        .string()
        .optional()
        .describe("Raw .pro file content as string (alternative to filePath)"),
      name: z
        .string()
        .optional()
        .describe("Override process name. Default: name parsed from .pro (602,'Name')."),
      mode: z
        .enum(["create", "update", "upsert"])
        .optional()
        .default("upsert")
        .describe("Deployment mode (default: upsert)"),
      preflight: z
        .boolean()
        .optional()
        .default(true)
        .describe("Run tm1_check_process_code before applying. Abort on syntax errors. Default true."),
    },
    async ({ filePath, content, name, mode, preflight }) => {
      try {
        if (!filePath && !content) {
          return {
            content: [{ type: "text" as const, text: JSON.stringify({ error: "Provide filePath or content" }) }],
            isError: true,
          };
        }

        let body = content ?? "";
        if (!body && filePath) {
          if (!path.isAbsolute(filePath)) {
            return {
              content: [{ type: "text" as const, text: JSON.stringify({ error: `filePath must be absolute: ${filePath}` }) }],
              isError: true,
            };
          }
          body = await fs.readFile(filePath, "utf8");
        }

        const parsed = parseProFile(body);
        const processName = name ?? parsed.name;
        if (!processName) {
          return {
            content: [{ type: "text" as const, text: JSON.stringify({ error: "Process name not found in .pro (602,'Name') and no name override provided" }) }],
            isError: true,
          };
        }

        if (preflight) {
          const check = await tm1Client.checkProcessCode({
            name: processName,
            prolog: parsed.prolog,
            metadata: parsed.metadata,
            data: parsed.data,
            epilog: parsed.epilog,
            parameters: parsed.parameters,
            variables: parsed.variables,
            dataSource: parsed.dataSource,
          });
          if (!check.success) {
            return {
              content: [{ type: "text" as const, text: JSON.stringify({ stage: "preflight", processName, errors: check.errors }, null, 2) }],
              isError: true,
            };
          }
        }

        const allProcs = await tm1Client.getProcesses();
        const exists = allProcs.some((p: { name: string }) => p.name === processName);

        if (mode === "create" && exists) {
          return {
            content: [{ type: "text" as const, text: JSON.stringify({ error: `Process '${processName}' already exists; mode=create` }) }],
            isError: true,
          };
        }
        if (mode === "update" && !exists) {
          return {
            content: [{ type: "text" as const, text: JSON.stringify({ error: `Process '${processName}' does not exist; mode=update` }) }],
            isError: true,
          };
        }

        const action = exists ? "updated" : "created";
        if (!exists) await tm1Client.createProcess(processName);

        await tm1Client.updateProcessCode(processName, {
          prolog: parsed.prolog,
          metadata: parsed.metadata,
          data: parsed.data,
          epilog: parsed.epilog,
        });

        if (parsed.parameters.length > 0) {
          await tm1Client.updateProcessParameters(processName, parsed.parameters);
        }
        if (parsed.variables.length > 0) {
          await tm1Client.updateProcessVariables(processName, parsed.variables);
        }
        if (parsed.dataSource.type !== "None") {
          await tm1Client.updateProcessDataSource(processName, parsed.dataSource);
        }

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  action,
                  processName,
                  parsed: {
                    prologLines: parsed.prolog.split("\n").length,
                    metadataLines: parsed.metadata.split("\n").length,
                    dataLines: parsed.data.split("\n").length,
                    epilogLines: parsed.epilog.split("\n").length,
                    parameterCount: parsed.parameters.length,
                    variableCount: parsed.variables.length,
                    dataSourceType: parsed.dataSource.type,
                  },
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (error) {
        const msg =
          error instanceof TM1Error
            ? { code: error.code, message: error.message, httpStatus: error.httpStatus, endpoint: error.endpoint }
            : { error: (error as Error).message ?? String(error) };
        return {
          content: [{ type: "text" as const, text: JSON.stringify(msg) }],
          isError: true,
        };
      }
    },
  );
}
