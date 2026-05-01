import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TM1Client } from "../../tm1-client.js";
import { TM1Error } from "../../types.js";

const dataSourceSchema = z
  .object({
    type: z.enum(["None", "TM1CubeView", "TM1DimensionSubset", "ASCII", "ODBC", "TM1Process"]),
    dataSourceNameForServer: z.string().optional(),
    dataSourceNameForClient: z.string().optional(),
    asciiDelimiterChar: z.string().optional(),
    asciiQuoteCharacter: z.string().optional(),
    asciiHeaderRecords: z.number().optional(),
    asciiDecimalSeparator: z.string().optional(),
    asciiThousandSeparator: z.string().optional(),
    userName: z.string().optional(),
    password: z.string().optional(),
    view: z.string().optional(),
    subset: z.string().optional(),
  })
  .strict();

const parameterSchema = z.object({
  name: z.string(),
  type: z.enum(["String", "Numeric"]),
  defaultValue: z.union([z.string(), z.number()]),
  prompt: z.string().optional(),
});

const variableSchema = z.object({
  name: z.string(),
  type: z.enum(["String", "Numeric"]),
  position: z.number().int().positive(),
  startByte: z.number().int().optional(),
  endByte: z.number().int().optional(),
});

export function registerUpsertProcess(server: McpServer, tm1Client: TM1Client) {
  server.tool(
    "tm1_upsert_process",
    "Atomic-style create-or-update for a TI process. Bundles createProcess (if missing) + updateProcessCode + updateProcessParameters + updateProcessVariables + updateProcessDataSource into a single MCP call. NOTE: TM1 itself does not support a real transaction — on partial failure, the steps that already succeeded are not rolled back. The tool reports which step failed.",
    {
      name: z.string(),
      prolog: z.string().optional(),
      metadata: z.string().optional(),
      data: z.string().optional(),
      epilog: z.string().optional(),
      parameters: z.array(parameterSchema).optional(),
      variables: z.array(variableSchema).optional(),
      dataSource: dataSourceSchema.optional(),
      mode: z.enum(["create", "update", "upsert"]).optional().default("upsert"),
    },
    async ({ name, prolog, metadata, data, epilog, parameters, variables, dataSource, mode }) => {
      const trail: string[] = [];
      try {
        const procs = await tm1Client.getProcesses();
        const exists = procs.some((p: { name: string }) => p.name === name);
        if (mode === "create" && exists) {
          return {
            content: [{ type: "text" as const, text: JSON.stringify({ error: `Process '${name}' already exists; mode=create` }) }],
            isError: true,
          };
        }
        if (mode === "update" && !exists) {
          return {
            content: [{ type: "text" as const, text: JSON.stringify({ error: `Process '${name}' does not exist; mode=update` }) }],
            isError: true,
          };
        }

        if (!exists) {
          await tm1Client.createProcess(name);
          trail.push("createProcess");
        }

        if (prolog !== undefined || metadata !== undefined || data !== undefined || epilog !== undefined) {
          await tm1Client.updateProcessCode(name, {
            ...(prolog !== undefined ? { prolog } : {}),
            ...(metadata !== undefined ? { metadata } : {}),
            ...(data !== undefined ? { data } : {}),
            ...(epilog !== undefined ? { epilog } : {}),
          });
          trail.push("updateProcessCode");
        }
        if (parameters !== undefined) {
          await tm1Client.updateProcessParameters(name, parameters);
          trail.push("updateProcessParameters");
        }
        if (variables !== undefined && variables.length > 0) {
          await tm1Client.updateProcessVariables(name, variables);
          trail.push("updateProcessVariables");
        }
        if (dataSource !== undefined) {
          await tm1Client.updateProcessDataSource(name, dataSource);
          trail.push("updateProcessDataSource");
        }

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                { processName: name, action: exists ? "updated" : "created", appliedSteps: trail },
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
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  processName: name,
                  partialApply: trail,
                  failedStep: trail.length === 0 ? "createProcess|listProcesses" : "(after-" + trail[trail.length - 1] + ")",
                  error: msg,
                },
                null,
                2,
              ),
            },
          ],
          isError: true,
        };
      }
    },
  );
}
