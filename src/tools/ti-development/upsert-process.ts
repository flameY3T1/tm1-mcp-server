import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TM1Client } from "../../tm1-client.js";
import { TM1Error, TM1ErrorCode } from "../../types.js";
import { invalidateCallgraphCache } from "../../lib/callgraph/tm1-adapter.js";

const dataSourceSchema = z
  .object({
    type: z.enum(["None", "TM1CubeView", "TM1DimensionSubset", "ASCII", "ODBC", "TM1Process"]),
    dataSourceNameForServer: z.string().optional(),
    dataSourceNameForClient: z.string().optional(),
    asciiDelimiterType: z.string().optional().describe("ASCII delimiter type (e.g. 'Character' or 'FixedWidth')"),
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
      autoCompile: z
        .boolean()
        .optional()
        .default(false)
        .describe(
          "After deploy, run tm1.Compile and include the result in the response (compile: {ok, errorCount, errors}). Off by default — compile holds a brief lock on the process and serializes badly under bulk-deploy.",
        ),
    },
    async ({ name, prolog, metadata, data, epilog, parameters, variables, dataSource, mode, autoCompile }) => {
      const trail: string[] = [];
      const exists = await tm1Client.processes.exists(name);
      if (mode === "create" && exists) {
        throw new TM1Error({
          code: TM1ErrorCode.CONFLICT,
          message: `Process '${name}' already exists; mode=create`,
        });
      }
      if (mode === "update" && !exists) {
        throw new TM1Error({
          code: TM1ErrorCode.NOT_FOUND,
          message: `Process '${name}' does not exist; mode=update`,
        });
      }

      if (!exists) {
        await tm1Client.processes.create(name);
        trail.push("createProcess");
      }

      if (prolog !== undefined || metadata !== undefined || data !== undefined || epilog !== undefined) {
        await tm1Client.processes.updateCode(name, {
          ...(prolog !== undefined ? { prolog } : {}),
          ...(metadata !== undefined ? { metadata } : {}),
          ...(data !== undefined ? { data } : {}),
          ...(epilog !== undefined ? { epilog } : {}),
        });
        trail.push("updateProcessCode");
      }
      if (parameters !== undefined) {
        await tm1Client.processes.updateParameters(name, parameters);
        trail.push("updateProcessParameters");
      }
      if (variables !== undefined && variables.length > 0) {
        await tm1Client.processes.updateVariables(name, variables);
        trail.push("updateProcessVariables");
      }
      if (dataSource !== undefined) {
        await tm1Client.processes.updateDataSource(name, dataSource);
        trail.push("updateProcessDataSource");
      }

      // Process body/parameters/datasource may have changed call sites — drop the
      // 60s callgraph TTL so the next analysis sees fresh references instead of stale graph.
      const { cleared: callgraphEntriesCleared } = invalidateCallgraphCache();

      let compile: { ok: boolean; errorCount: number; errors: unknown[] } | undefined;
      if (autoCompile) {
        const result = await tm1Client.processes.compile(name);
        compile = {
          ok: result.success,
          errorCount: result.errors.length,
          errors: result.errors,
        };
        trail.push("compileProcess");
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                processName: name,
                action: exists ? "updated" : "created",
                appliedSteps: trail,
                callgraphEntriesCleared,
                ...(compile !== undefined ? { compile } : {}),
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
