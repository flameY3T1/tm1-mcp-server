import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TM1Client } from "../../tm1-client.js";
import {
  credentialFormatFor,
  isPlaintextCredential,
} from "../../lib/credential-format.js";
import { TM1Error, TM1ErrorCode } from "../../types.js";
import { resolveLocalPath } from "../local-file.js";
import { serializeProcessToGit } from "../../lib/git-process.js";
import {
  maskCode,
  maskDataSourceSecrets,
  resolveMaskSecrets,
} from "../../lib/mask-secrets.js";

export function registerExportProcessToGit(
  server: McpServer,
  tm1Client: TM1Client,
) {
  server.tool(
    "tm1_export_process_to_git",
    [
      "Serialize a TM1 process to the tm1-git two-file layout: a '{name}.json' (parameters, variables, datasource) plus a '{name}.ti' (Prolog/Metadata/Data/Epilog as plain code).",
      "The .ti holds the code in TM1's native `Code` representation (#region <Tab> / #endregion, CRLF, empty tabs omitted); the .json holds the structure. Code lives outside the JSON so Git diffs stay readable.",
      "Returns both file bodies (json + ti) inline by default. Pass writeToDir to persist them to disk instead: the code is then written to files and omitted from the response to avoid duplicating it into the context window; only metadata (filenames, counts, writtenTo paths) comes back. Round-trip safe with tm1_import_process_from_git.",
      "Security: the ODBC datasource password is stripped unless includeDataSourcePassword is set (which also requires writeToDir); conn-string credential pairs (PWD=, UID=) in oDBCConnection are masked when maskSecrets is on; credentialsOmitted=true flags when a password was stripped.",
      "On v12 the exported password is the plain password, and this layout exists to be committed — so that combination additionally requires allowPlaintextCredential. credentialFormat reports which of the two you got.",
    ].join(" "),
    {
      processName: z.string().describe("Name of the TI process to export"),
      writeToDir: z
        .string()
        .optional()
        .describe(
          "Optional absolute host directory to write '{name}.json' and '{name}.ti' into. Disabled unless TM1_LOCAL_FILE_ROOT is set; the path must resolve within that directory. If omitted, content is only returned inline.",
        ),
      maskSecrets: z
        .boolean()
        .optional()
        .default(true)
        .describe(
          "Redact credential literals in the exported .ti code (inline and written file) and credential pairs (PWD=, UID=) in the datasource's ODBC connection string in the .json. " +
            "Masks the password arg of ODBCOpen() and quoted values assigned to credential-named identifiers (pPwd, sToken, …). Default: true. Set false only when explicitly auditing credentials.",
        ),
      includeDataSourcePassword: z
        .boolean()
        .optional()
        .default(false)
        .describe(
          "Write the ODBC datasource password into the .json. Off by default. Requires writeToDir, so the credential never enters the inline response. " +
            "Measured: on v11 the value is a ciphertext bound to one RUN of that server — it round-trips on the same instance until the service restarts, after which it aborts the process at connect time, and it is useless on another instance either way; re-supply the password with tm1_import_process_from_git's dataSourcePassword in both cases. On v12 it is PLAIN TEXT and does not expire. Do not commit such a file.",
        ),
      allowPlaintextCredential: z
        .boolean()
        .optional()
        .default(false)
        .describe(
          "Acknowledge writing a plain-text password. Only consulted on v12, where the exported credential IS the password — this layout is meant to be committed, so the plain value is withheld until you say so explicitly. Ignored on v11, whose ciphertext is bound to the source server and worthless elsewhere.",
        ),
    },
    async ({
      processName,
      writeToDir,
      maskSecrets,
      includeDataSourcePassword,
      allowPlaintextCredential,
    }) => {
      if (includeDataSourcePassword && !writeToDir) {
        throw new TM1Error({
          code: TM1ErrorCode.VALIDATION_ERROR,
          message:
            "includeDataSourcePassword requires writeToDir — the credential must go to a file, not into the inline response.",
        });
      }
      // v12 hands out the password itself, and these files exist to be
      // committed. v11's ciphertext is instance-bound, so it does not get the
      // same gate — see src/lib/credential-format.ts for the measurements.
      if (
        includeDataSourcePassword &&
        isPlaintextCredential(tm1Client.version) &&
        allowPlaintextCredential !== true
      ) {
        throw new TM1Error({
          code: TM1ErrorCode.VALIDATION_ERROR,
          message:
            "includeDataSourcePassword on v12 would write the plain password into a file meant for version control. Pass allowPlaintextCredential=true to accept that, or export via tm1_export_process_to_pro and re-supply the password with tm1_import_pro_file's dataSourcePassword instead.",
        });
      }
      const [codeBlob, parameters, variables, dataSource, deployMeta] =
        await Promise.all([
          tm1Client.processes.getCodeBlob(processName),
          tm1Client.processes.getParameters(processName),
          tm1Client.processes.getVariables(processName),
          tm1Client.processes.getDataSource(processName, {
            includeSecrets: includeDataSourcePassword === true,
          }),
          tm1Client.processes.getDeployMeta(processName),
        ]);

      const doMask = resolveMaskSecrets(maskSecrets);
      const mask = doMask ? maskCode : (s: string) => s;
      const ti = mask(codeBlob);
      const { json, credentialsOmitted } = serializeProcessToGit(
        {
          name: processName,
          parameters,
          variables,
          dataSource: doMask ? maskDataSourceSecrets(dataSource) : dataSource,
          hasSecurityAccess: deployMeta.hasSecurityAccess,
        },
        { includePassword: includeDataSourcePassword === true },
      );
      const credentialWritten =
        includeDataSourcePassword === true &&
        !credentialsOmitted &&
        Boolean(dataSource.password);

      const jsonFileName = `${processName}.json`;
      const tiFileName = `${processName}.ti`;

      const writtenTo: { json: string | null; ti: string | null } = {
        json: null,
        ti: null,
      };
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
        const jsonPath = resolveLocalPath(
          path.join(dir, jsonFileName),
          "writeToDir",
        );
        const tiPath = resolveLocalPath(
          path.join(dir, tiFileName),
          "writeToDir",
        );
        // Create the target directory only AFTER confinement above, so the
        // symlink-aware realpath check ran against the pre-existing tree.
        await fs.mkdir(dir, { recursive: true });
        await fs.writeFile(jsonPath, json, "utf8");
        await fs.writeFile(tiPath, ti, "utf8");
        writtenTo.json = jsonPath;
        writtenTo.ti = tiPath;
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              processName,
              jsonFileName,
              tiFileName,
              parameterCount: parameters.length,
              variableCount: variables.length,
              dataSourceType: dataSource.type,
              credentialsOmitted,
              // Non-null only when a credential really landed in the file:
              // credentialsOmitted alone is also false for processes that never
              // had a password (non-ODBC, or ODBC without one).
              credentialFormat: credentialWritten
                ? credentialFormatFor(tm1Client.version)
                : null,
              hasSecurityAccess: deployMeta.hasSecurityAccess,
              writtenTo,
              // Echo the file bodies inline only when NOT persisting to disk. With
              // writeToDir the caller already has the files, so returning the code
              // would just duplicate thousands of tokens into the context window.
              ...(writeToDir ? {} : { json, ti }),
            }),
          },
        ],
      };
    },
  );
}
