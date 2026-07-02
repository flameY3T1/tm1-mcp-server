import { promises as fs } from "node:fs";
import { resolveLocalPath } from "../local-file.js";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TM1Client } from "../../tm1-client.js";
import { TM1Error, TM1ErrorCode } from "../../types.js";
import { parseProFile } from "../../lib/pro-parser.js";
import { withToolHint } from "../error-format.js";

export function registerImportProFile(server: McpServer, tm1Client: TM1Client) {
  server.tool(
    "tm1_import_pro_file",
    "Parse a TM1 .pro file (Tabs / Parameters / Variables / DataSource) and deploy the process in one call. Provide either filePath (absolute path on the MCP host) or content (the .pro file body as string). Modes: 'create' (fail if exists), 'update' (fail if missing), 'upsert' (default — create or update).",
    {
      filePath: z
        .string()
        .optional()
        .describe("Absolute path to the .pro file on the MCP server host. Disabled unless TM1_LOCAL_FILE_ROOT is set; the path must resolve within that directory. Otherwise pass 'content' inline."),
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
      if (!filePath && !content) {
        throw new TM1Error({
          code: TM1ErrorCode.VALIDATION_ERROR,
          message: "Provide filePath or content",
        });
      }

      let body = content ?? "";
      if (!body && filePath) {
        body = await fs.readFile(resolveLocalPath(filePath), "utf8");
      }

      const parsed = parseProFile(body);
      const processName = name ?? parsed.name;
      if (!processName) {
        throw new TM1Error({
          code: TM1ErrorCode.VALIDATION_ERROR,
          message: "Process name not found in .pro (602,'Name') and no name override provided",
        });
      }

      if (preflight) {
        const check = await tm1Client.processes.check({
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
            content: [{ type: "text" as const, text: JSON.stringify({ stage: "preflight", processName, errors: check.errors }) }],
            isError: true,
          };
        }
      }

      const allProcs = await tm1Client.processes.list();
      const exists = allProcs.some((p: { name: string }) => p.name === processName);

      if (mode === "create" && exists) {
        throw new TM1Error({
          code: TM1ErrorCode.CONFLICT,
          message: `Process '${processName}' already exists; mode=create`,
        });
      }
      if (mode === "update" && !exists) {
        throw new TM1Error({
          code: TM1ErrorCode.NOT_FOUND,
          message: `Process '${processName}' does not exist; mode=update`,
        });
      }

      const action = exists ? "updated" : "created";
      if (!exists) {
        await withToolHint(
          tm1Client.processes.create(processName),
          `Process create failed mid-import. Name '${processName}' may already exist (mode=create would have caught — likely race) or contain invalid characters. tm1_list_processes to verify state before retry.`,
        );
      }

      await withToolHint(
        tm1Client.processes.updateCode(processName, {
          prolog: parsed.prolog,
          metadata: parsed.metadata,
          data: parsed.data,
          epilog: parsed.epilog,
        }),
        `Code update failed after process '${processName}' was ${exists ? "located" : "created"}. PARTIAL APPLY: the process shell exists but tabs are stale/empty. Re-run tm1_import_pro_file with mode=update once root cause fixed, or tm1_delete_process to roll back.`,
      );

      if (parsed.parameters.length > 0) {
        await withToolHint(
          tm1Client.processes.updateParameters(processName, parsed.parameters),
          `Parameter update failed for '${processName}'. Code applied but parameters missing. Inspect parsed parameters and re-run tm1_upsert_process with mode=update + parameters=[...] to recover.`,
        );
      }
      if (parsed.variables.length > 0) {
        await withToolHint(
          tm1Client.processes.updateVariables(processName, parsed.variables),
          `Variable update failed for '${processName}'. Code+parameters applied but variables missing. tm1_upsert_process with mode=update + variables=[...] to recover.`,
        );
      }
      if (parsed.dataSource.type !== "None") {
        await withToolHint(
          tm1Client.processes.updateDataSource(processName, parsed.dataSource),
          `Datasource update failed for '${processName}' (type=${parsed.dataSource.type}). Code+params+vars applied. Verify datasource credentials/path (ASCII file existence, ODBC DSN, view name) and re-run tm1_upsert_process with mode=update + dataSource={...} to recover.`,
        );
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
    },
  );
}
