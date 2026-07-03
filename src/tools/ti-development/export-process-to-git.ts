import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TM1Client } from "../../tm1-client.js";
import { TM1Error, TM1ErrorCode } from "../../types.js";
import { resolveLocalPath } from "../local-file.js";
import { serializeProcessToGit } from "../../lib/git-process.js";
import { maskCode } from "../../lib/mask-secrets.js";

export function registerExportProcessToGit(server: McpServer, tm1Client: TM1Client) {
  server.tool(
    "tm1_export_process_to_git",
    [
      "Serialize a TM1 process to the tm1-git two-file layout: a '{name}.json' (parameters, variables, datasource) plus a '{name}.ti' (Prolog/Metadata/Data/Epilog as plain code).",
      "This is the diff-friendly format TM1's native Git integration and TM1py use — code lives outside the JSON so Git diffs stay readable.",
      "Returns both files inline by default; pass writeToDir to also persist them. Round-trip safe with tm1_import_process_from_git.",
      "Security: the ODBC datasource password is never written; credentialsOmitted=true flags when one was stripped.",
    ].join(" "),
    {
      processName: z.string().describe("Name of the TI process to export"),
      writeToDir: z
        .string()
        .optional()
        .describe("Optional absolute host directory to write '{name}.json' and '{name}.ti' into. Disabled unless TM1_LOCAL_FILE_ROOT is set; the path must resolve within that directory. If omitted, content is only returned inline."),
      maskSecrets: z
        .boolean()
        .optional()
        .default(true)
        .describe(
          "Redact credential literals in the exported .ti code (inline and written file). Masks the password arg of ODBCOpen() and quoted values " +
            "assigned to credential-named identifiers (pPwd, sToken, …). Default: true. Set false only when explicitly auditing credentials.",
        ),
    },
    async ({ processName, writeToDir, maskSecrets }) => {
      const [code, parameters, variables, dataSource, deployMeta] = await Promise.all([
        tm1Client.processes.getCode(processName),
        tm1Client.processes.getParameters(processName),
        tm1Client.processes.getVariables(processName),
        tm1Client.processes.getDataSource(processName),
        tm1Client.processes.getDeployMeta(processName),
      ]);

      const mask = maskSecrets ? maskCode : (s: string) => s;
      const { json, ti, credentialsOmitted } = serializeProcessToGit({
        name: processName,
        prolog: mask(code.prolog),
        metadata: mask(code.metadata),
        data: mask(code.data),
        epilog: mask(code.epilog),
        parameters,
        variables,
        dataSource,
        hasSecurityAccess: deployMeta.hasSecurityAccess,
      });

      const jsonFileName = `${processName}.json`;
      const tiFileName = `${processName}.ti`;

      const writtenTo: { json: string | null; ti: string | null } = { json: null, ti: null };
      if (writeToDir) {
        // Reject path separators in the process name so the join below cannot
        // climb out of the target directory (resolveLocalPath also confines it).
        if (/[\\/]|\.\./.test(processName)) {
          throw new TM1Error({
            code: TM1ErrorCode.VALIDATION_ERROR,
            message: `Process name '${processName}' contains path separators; cannot derive safe file names`,
          });
        }
        const dir = resolveLocalPath(writeToDir, "writeToDir");
        const jsonPath = resolveLocalPath(path.join(dir, jsonFileName), "writeToDir");
        const tiPath = resolveLocalPath(path.join(dir, tiFileName), "writeToDir");
        await fs.writeFile(jsonPath, json, "utf8");
        await fs.writeFile(tiPath, ti, "utf8");
        writtenTo.json = jsonPath;
        writtenTo.ti = tiPath;
      }

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            processName,
            jsonFileName,
            tiFileName,
            parameterCount: parameters.length,
            variableCount: variables.length,
            dataSourceType: dataSource.type,
            credentialsOmitted,
            hasSecurityAccess: deployMeta.hasSecurityAccess,
            writtenTo,
            json,
            ti,
          }),
        }],
      };
    },
  );
}
