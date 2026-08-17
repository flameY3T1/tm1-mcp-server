import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TM1Client } from "../../tm1-client.js";
import { resolveLocalPath } from "../local-file.js";
import { serializeToPro } from "../../lib/pro-serializer.js";
import { maskCode, resolveMaskSecrets } from "../../lib/mask-secrets.js";
import { supportsCredentialExport } from "../../lib/credential-format.js";
import { TM1Error, TM1ErrorCode } from "../../types.js";

export function registerExportProcessToPro(
  server: McpServer,
  tm1Client: TM1Client,
) {
  server.tool(
    "tm1_export_process_to_pro",
    [
      "Reverse of tm1_import_pro_file: serialize a TM1 process back to a .pro file body.",
      "Fetches code (Prolog/Metadata/Data/Epilog), parameters, variables, and datasource in parallel.",
      "Returns the .pro content inline by default; pass writeToFile to also persist to an absolute path on the MCP host.",
      "Round-trip safe with tm1_import_pro_file — useful for syncing live server state into a Git repo.",
      "NOT a drop-in replacement for the .pro file in TM1's Datadir: the output omits TM1's BOM, its '601' version header and CRLF line endings. Measured on 11.8: TM1 does load such a file at startup and rewrites it in its own dialect, but it decodes slot 565 with its own scheme — a password written here becomes garbage that TM1 then persists, so the process looks configured and fails at runtime. Deploy via tm1_import_pro_file, not by copying into the Datadir.",
    ].join(" "),
    {
      processName: z.string().describe("Name of the TI process to export"),
      writeToFile: z
        .string()
        .optional()
        .describe(
          "Optional absolute host path to write the .pro file to. Disabled unless TM1_LOCAL_FILE_ROOT is set; the path must resolve within that directory. If omitted, content is only returned inline.",
        ),
      maskSecrets: z
        .boolean()
        .optional()
        .default(true)
        .describe(
          "Redact credential literals in the exported code (inline and written file). Masks the password arg of ODBCOpen() and quoted values " +
            "assigned to credential-named identifiers (pPwd, sToken, …). Default: true. Set false only when explicitly auditing credentials.",
        ),
      includeDataSourcePassword: z
        .boolean()
        .optional()
        .default(false)
        .describe(
          "Write the ODBC datasource password into the file (slot 565). Off by default, and v12 ONLY — on v11 it is refused, because the " +
            "credential v11 hands out expires with the server run and would leave a file that looks complete and fails at connect time; clone " +
            "with tm1_copy_process instead, or deploy with tm1_import_pro_file's dataSourcePassword. On v12 the value written is the PLAIN " +
            "password. Requires writeToFile, so it never enters the inline response. Do not commit such a file.",
        ),
    },
    async ({
      processName,
      writeToFile,
      maskSecrets,
      includeDataSourcePassword,
    }) => {
      if (includeDataSourcePassword && !writeToFile) {
        throw new TM1Error({
          code: TM1ErrorCode.VALIDATION_ERROR,
          message:
            "includeDataSourcePassword requires writeToFile — the credential must go to a file, not into the inline response.",
        });
      }
      // See src/lib/credential-format.ts: a v11 credential is scoped to one
      // server run, so an exported one rots without any visible sign.
      if (
        includeDataSourcePassword &&
        !supportsCredentialExport(tm1Client.version)
      ) {
        throw new TM1Error({
          code: TM1ErrorCode.VALIDATION_ERROR,
          message:
            "includeDataSourcePassword is v12-only. On v11 the exported credential stops working when the TM1 service restarts, and the file gives no sign of it. To clone a process with its password inside this instance use tm1_copy_process; to deploy elsewhere or later, export without the password and pass dataSourcePassword to tm1_import_pro_file.",
        });
      }
      const [code, parameters, variables, dataSource] = await Promise.all([
        tm1Client.processes.getCode(processName),
        tm1Client.processes.getParameters(processName),
        tm1Client.processes.getVariables(processName),
        tm1Client.processes.getDataSource(processName, {
          includeSecrets: includeDataSourcePassword === true,
        }),
      ]);

      // Without the opt-in the service hands back a "[redacted]" marker, which
      // must not be written into the file as if it were the credential.
      if (!includeDataSourcePassword) delete dataSource.password;

      const credentialsIncluded = Boolean(
        includeDataSourcePassword && dataSource.password,
      );

      const mask = resolveMaskSecrets(maskSecrets)
        ? maskCode
        : (s: string) => s;
      const proContent = serializeToPro({
        name: processName,
        prolog: mask(code.prolog),
        metadata: mask(code.metadata),
        data: mask(code.data),
        epilog: mask(code.epilog),
        parameters,
        variables,
        dataSource,
      });

      let writtenTo: string | null = null;
      if (writeToFile) {
        const target = resolveLocalPath(writeToFile, "writeToFile");
        // Create the parent directory only AFTER confinement above, so the
        // symlink-aware realpath check ran against the pre-existing tree.
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, proContent, "utf8");
        writtenTo = target;
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              processName,
              byteLength: Buffer.byteLength(proContent, "utf8"),
              writtenTo,
              parameterCount: parameters.length,
              variableCount: variables.length,
              dataSourceType: dataSource.type,
              credentialsIncluded,
              // Written to disk only when credentials are in play — otherwise
              // the caller already has the body and it stays out of the context.
              ...(includeDataSourcePassword ? {} : { content: proContent }),
            }),
          },
        ],
      };
    },
  );
}
